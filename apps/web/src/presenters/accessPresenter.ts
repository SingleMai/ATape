import {
  loadTeamRawCapture, setTeamRawCapture, loadUserRawCapture, setUserRawCapture,
  type RawCapturePolicy,
  presentCLIDevice,
  beginDefaultReauthentication,
  beginFederatedSignIn,
  createTeam,
  decideCLIDeviceGrant,
  disableTeamJoinCode,
  joinTeam,
  leaveTeam,
  loadAccountSecurity,
  loadSignInOptions,
  loadTeamAccess,
  logoutWebSession,
  removeTeamMember,
  resolveCLIDeviceGrant,
  restoreWebSession,
  revokeAllCLICredentials,
  revokeCLICredential,
  rotateTeamJoinCode,
  setTeamMemberRole,
  type AccessError,
  type TeamAccess
} from "@atape/application"
import type {
  CLIDeviceGrantView,
  JoinCodeGrant,
  AuthenticatedSession,
  Team,
  TeamRole
} from "@atape/domain"
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Effect, Fiber } from "effect"
import { useCallback, useEffect, useRef } from "react"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { BrowserAccessLayer } from "../runtime/accessGateway"
import { subscribeAuthenticationInvalidation } from "../runtime/http"
import { hasWebMessage, type WebMessageKey } from "../i18n"

const runtime = Atom.runtime(BrowserAccessLayer)

export type FailureView = {
  readonly messageKey: WebMessageKey
  readonly code: string
  readonly reason: AccessError["reason"]
  readonly retryable: boolean
  readonly incident?: string
}

export type LoadView<A> =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly value: A; readonly refreshing: boolean }
  | { readonly _tag: "Failed"; readonly failure: FailureView }

export type ActionView<A> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Succeeded"; readonly value: A }
  | { readonly _tag: "Failed"; readonly failure: FailureView }

export type SessionView =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Authenticated"; readonly value: AuthenticatedSession; readonly refreshing: boolean }
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "Failed"; readonly failure: FailureView }

export type SectionView<A> =
  | { readonly _tag: "Ready"; readonly value: A }
  | { readonly _tag: "Failed"; readonly failure: FailureView }

export type AccountSecurityViewModel = {
  readonly providers: SectionView<import("@atape/domain").ProviderRegistration[] | ReadonlyArray<import("@atape/domain").ProviderRegistration>>
  readonly identities: SectionView<ReadonlyArray<import("@atape/domain").ExternalIdentity>>
  readonly cliCredentials: SectionView<ReadonlyArray<import("@atape/application").CLIDeviceView>>
}

const problemMessageKey = (code: string): WebMessageKey | undefined => {
  const key = `problems.${code}`
  return hasWebMessage(key) ? key : undefined
}

const reasonMessageKey = (reason: AccessError["reason"]): WebMessageKey => {
  switch (reason) {
    case "unauthenticated": return "errors.unauthenticated"
    case "fresh_authentication_required": return "errors.freshAuthenticationRequired"
    case "forbidden": return "errors.forbidden"
    case "not_found": return "errors.notFound"
    case "provider_unavailable": return "errors.providerUnavailable"
    case "rate_limited": return "errors.rateLimited"
    case "transport": return "errors.transport"
    case "decode": return "errors.decode"
    case "invalid_input": return "errors.invalidInput"
    case "conflict": return "errors.conflict"
    case "unavailable": return "errors.unavailable"
    default: return "errors.unknown"
  }
}

const friendlyFailure = (error: AccessError): FailureView => ({
  messageKey: problemMessageKey(error.code) ?? reasonMessageKey(error.reason),
  code: error.code,
  reason: error.reason,
  retryable: error.reason === "transport" || error.reason === "unavailable" ||
    error.reason === "fresh_authentication_required" ||
    error.reason === "provider_unavailable" || error.reason === "rate_limited",
  ...(error.incident === undefined ? {} : { incident: error.incident })
})

const defectFailure = (messageKey: WebMessageKey): FailureView => ({
  messageKey,
  code: "client_failure",
  reason: "unknown",
  retryable: false
})

const toLoadView = <A>(
  result: AsyncResult.AsyncResult<A, AccessError>,
  defectMessage: WebMessageKey
): LoadView<A> => AsyncResult.matchWithError(result, {
  onInitial: () => ({ _tag: "Loading" as const }),
  onError: (error) => ({ _tag: "Failed" as const, failure: friendlyFailure(error) }),
  onDefect: () => ({ _tag: "Failed" as const, failure: defectFailure(defectMessage) }),
  onSuccess: (success) => ({
    _tag: "Ready" as const,
    value: success.value,
    refreshing: success.waiting
  })
})

const toActionView = <A>(
  result: AsyncResult.AsyncResult<A, AccessError>,
  defectMessage: WebMessageKey
): ActionView<A> => {
  if (result.waiting) return { _tag: "Pending" }
  return AsyncResult.matchWithError(result, {
    onInitial: () => ({ _tag: "Idle" as const }),
    onError: (error) => ({ _tag: "Failed" as const, failure: friendlyFailure(error) }),
    onDefect: () => ({ _tag: "Failed" as const, failure: defectFailure(defectMessage) }),
    onSuccess: (success) => ({ _tag: "Succeeded" as const, value: success.value })
  })
}

const sessionAtom = runtime.atom(restoreWebSession()).pipe(Atom.withRefresh("5 minutes"))
const signInOptionsAtom = runtime.atom(loadSignInOptions()).pipe(Atom.withRefresh("5 minutes"))
const signInAtom = runtime.fn(beginFederatedSignIn)
const reauthenticationAtom = runtime.fn(beginDefaultReauthentication)
const logoutAtom = runtime.fn(logoutWebSession)
const accountAtom = runtime.atom(loadAccountSecurity())
const accountActionAtom = runtime.fn((input: {
  readonly kind: "revoke-cli" | "revoke-all-cli"
  readonly id?: string
}) => {
  switch (input.kind) {
    case "revoke-cli": return revokeCLICredential(input.id ?? "")
    case "revoke-all-cli": return revokeAllCLICredentials()
  }
})
const createTeamAtom = runtime.fn(createTeam)
const joinTeamAtom = runtime.fn(joinTeam)
const resolveCLIAtom = runtime.fn(resolveCLIDeviceGrant)
const decideCLIAtom = runtime.fn(decideCLIDeviceGrant)
const teamAtoms = Atom.family((teamSlug: string) => runtime.atom(loadTeamAccess(teamSlug)))
export type TeamAccessAction =
  | { readonly kind: "rotate-code" | "disable-code" | "leave" }
  | { readonly kind: "set-role"; readonly userId: string; readonly role: TeamRole }
  | { readonly kind: "remove-member"; readonly userId: string }

const teamActionAtoms = Atom.family((teamSlug: string) => runtime.fn((input: TeamAccessAction) => {
  switch (input.kind) {
    case "rotate-code": return rotateTeamJoinCode(teamSlug)
    case "disable-code": return disableTeamJoinCode(teamSlug)
    case "leave": return leaveTeam(teamSlug)
    case "set-role": return setTeamMemberRole({ ...input, teamSlug })
    case "remove-member": return removeTeamMember({ ...input, teamSlug })
  }
}))

export const useSessionPresenter = (): {
  readonly state: SessionView
  readonly reload: () => void
} => {
  const result = useAtomValue(sessionAtom)
  const reload = useAtomRefresh(sessionAtom)
  useEffect(() => subscribeAuthenticationInvalidation(reload), [reload])

  if (result.waiting && result._tag === "Initial") return { state: { _tag: "Loading" }, reload }
  const state = AsyncResult.matchWithError(result, {
    onInitial: () => ({ _tag: "Loading" as const }),
    onError: (error): SessionView => error.reason === "unauthenticated"
      ? { _tag: "Unauthenticated" }
      : { _tag: "Failed", failure: friendlyFailure(error) },
    onDefect: (): SessionView => ({
      _tag: "Failed",
      failure: defectFailure("errors.defect.session")
    }),
    onSuccess: (success): SessionView => ({
      _tag: "Authenticated",
      value: success.value,
      refreshing: success.waiting
    })
  })
  return { state, reload }
}

export const useSignInPresenter = () => {
  const options = useAtomValue(signInOptionsAtom)
  const reloadOptions = useAtomRefresh(signInOptionsAtom)
  const [action, signIn] = useAtom(signInAtom)
  return {
    options: toLoadView(options, "errors.defect.signInOptions"),
    action: toActionView(action, "errors.defect.signIn"),
    reloadOptions,
    signIn
  }
}

export const useReauthenticationPresenter = () => {
  const [action, reauthenticate] = useAtom(reauthenticationAtom)
  return {
    action: toActionView(action, "errors.defect.reauthenticate"),
    reauthenticate
  }
}

export const useLogoutPresenter = () => {
  const [action, logout] = useAtom(logoutAtom)
  return { action: toActionView(action, "errors.defect.logout"), logout }
}

export const useAccountSecurityPresenter = () => {
  const result = useAtomValue(accountAtom)
  const reload = useAtomRefresh(accountAtom)
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    const fiber = Effect.runFork(Effect.sleep(30_000).pipe(
      Effect.andThen(Effect.sync(() => reloadRef.current())), Effect.forever
    ))
    return () => { Effect.runFork(Fiber.interrupt(fiber)) }
  }, [])
  const [action, run] = useAtom(accountActionAtom)
  const resetAction = useCallback(() => run(Atom.Reset), [run])
  return {
    state: (() => {
      const loaded = toLoadView(result, "errors.defect.accountSecurity")
      if (loaded._tag !== "Ready") return loaded
      const section = <A>(value: import("@atape/application").SettledSection<A>): SectionView<A> =>
        value._tag === "Ready"
          ? value
          : { _tag: "Failed", failure: friendlyFailure(value.error) }
      return {
        ...loaded,
        value: {
          providers: section(loaded.value.providers),
          identities: section(loaded.value.identities),
          cliCredentials: section(loaded.value.cliCredentials._tag === "Ready" ? { _tag: "Ready", value: loaded.value.cliCredentials.value.map(credential => presentCLIDevice(credential, Date.now())) } : loaded.value.cliCredentials)
        } satisfies AccountSecurityViewModel
      }
    })(),
    action: toActionView<void>(action, "errors.defect.accountAction"),
    reload,
    run,
    resetAction
  }
}

export const useCreateTeamPresenter = () => {
  const [action, submit] = useAtom(createTeamAtom)
  const reset = useCallback(() => submit(Atom.Reset), [submit])
  return {
    action: toActionView<Team>(action, "errors.defect.createTeam"),
    submit,
    reset
  }
}

export const useJoinTeamPresenter = () => {
  const [action, submit] = useAtom(joinTeamAtom)
  const reset = useCallback(() => submit(Atom.Reset), [submit])
  return {
    action: toActionView<Team>(action, "errors.defect.joinTeam"),
    submit,
    reset
  }
}

export const useCLIAuthorizationPresenter = () => {
  const [resolveResult, resolve] = useAtom(resolveCLIAtom)
  const [decisionResult, decide] = useAtom(decideCLIAtom)
  const reset = useCallback(() => {
    resolve(Atom.Reset)
    decide(Atom.Reset)
  }, [decide, resolve])
  const open = useCallback((userCode: string) => {
    resolve(Atom.Reset)
    decide(Atom.Reset)
    resolve(userCode)
  }, [decide, resolve])
  return {
    resolution: toActionView<CLIDeviceGrantView>(resolveResult, "errors.defect.cliResolve"),
    decision: toActionView<"approve" | "deny">(decisionResult, "errors.defect.cliDecide"),
    open,
    decide,
    reset
  }
}

export const useTeamAccessPresenter = (teamSlug: string) => {
  const atom = teamAtoms(teamSlug)
  const actionAtom = teamActionAtoms(teamSlug)
  const result = useAtomValue(atom)
  const reload = useAtomRefresh(atom)
  const [action, run] = useAtom(actionAtom)
  const resetAction = useCallback(() => run(Atom.Reset), [run])
  return {
    state: toLoadView<TeamAccess>(result, "errors.defect.teamAccess"),
    action: toActionView<void | JoinCodeGrant>(action, "errors.defect.teamAction"),
    reload,
    run,
    resetAction
  }
}

export type { TeamAccess }


const userRawAtom = runtime.atom(loadUserRawCapture())
const userRawActionAtom = runtime.fn(setUserRawCapture)
const teamRawAtoms = Atom.family((slug: string) => runtime.atom(loadTeamRawCapture(slug)))
const teamRawActionAtoms = Atom.family((slug: string) => runtime.fn((policy: RawCapturePolicy) => setTeamRawCapture(slug, policy)))

export const useUserRawCapturePresenter = () => {
  const result = useAtomValue(userRawAtom)
  const reload = useAtomRefresh(userRawAtom)
  const [action, save] = useAtom(userRawActionAtom)
  useEffect(() => { reload(); return () => save(Atom.Reset) }, [reload, save])
  useEffect(() => { if (action._tag === "Success" && !action.waiting) reload() }, [action, reload])
  return { state: toLoadView(result, "errors.defect.userRawLoad"),
    action: toActionView(action, "errors.defect.userRawSave"), save, reload }
}

export const useTeamRawCapturePresenter = (slug: string) => {
  const result = useAtomValue(teamRawAtoms(slug))
  const reload = useAtomRefresh(teamRawAtoms(slug))
  const [action, save] = useAtom(teamRawActionAtoms(slug))
  useEffect(() => { reload(); return () => save(Atom.Reset) }, [reload, save])
  useEffect(() => { if (action._tag === "Success" && !action.waiting) reload() }, [action, reload])
  return { state: toLoadView(result, "errors.defect.teamRawLoad"),
    action: toActionView(action, "errors.defect.teamRawSave"), save, reload }
}
