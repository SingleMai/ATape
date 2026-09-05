import {
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
  revokeAllWebSessions,
  revokeCLICredential,
  revokeWebSession,
  rotateTeamJoinCode,
  setTeamMemberRole,
  type AccessError,
  type TeamAccess
} from "@atape/application"
import type {
  CLIDeviceGrantView,
  JoinCodeGrant,
  AuthenticatedSession,
  SignInOptions,
  Team,
  TeamRole
} from "@atape/domain"
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useCallback, useEffect } from "react"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { BrowserAccessLayer } from "../runtime/accessGateway"
import { subscribeAuthenticationInvalidation } from "../runtime/http"

const runtime = Atom.runtime(BrowserAccessLayer)

export type FailureView = {
  readonly message: string
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
  readonly webSessions: SectionView<ReadonlyArray<import("@atape/domain").WebSession>>
  readonly cliCredentials: SectionView<ReadonlyArray<import("@atape/domain").CLICredential>>
}

const friendlyFailure = (error: AccessError): FailureView => {
  const message = (() => {
    switch (error.reason) {
      case "unauthenticated": return "Your browser session ended. Sign in again to continue."
      case "fresh_authentication_required": return "Confirm your sign-in before making this security change."
      case "forbidden": return "Your current Team role does not allow this action."
      case "not_found": return "This item is unavailable or you no longer have access to it."
      case "provider_unavailable": return "The sign-in method is temporarily unavailable."
      case "rate_limited": return "Too many attempts were made. Wait briefly and try again."
      case "transport": return "ATape could not reach the server. Check your connection and try again."
      case "decode": return "ATape received a response it could not safely read."
      default: return error.message
    }
  })()
  return {
    message,
    code: error.code,
    reason: error.reason,
    retryable: error.reason === "transport" || error.reason === "unavailable" ||
      error.reason === "fresh_authentication_required" ||
      error.reason === "provider_unavailable" || error.reason === "rate_limited",
    ...(error.incident === undefined ? {} : { incident: error.incident })
  }
}

const defectFailure = (message: string): FailureView => ({
  message,
  code: "client_failure",
  reason: "unknown",
  retryable: false
})

const toLoadView = <A>(
  result: AsyncResult.AsyncResult<A, AccessError>,
  defectMessage: string
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
  defectMessage: string
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
  readonly kind: "revoke-web" | "revoke-all-web" | "revoke-cli" | "revoke-all-cli"
  readonly id?: string
}) => {
  switch (input.kind) {
    case "revoke-web": return revokeWebSession(input.id ?? "")
    case "revoke-all-web": return revokeAllWebSessions()
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
      failure: defectFailure("ATape could not restore this browser session safely.")
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
    options: toLoadView(options, "ATape could not load the enabled sign-in methods."),
    action: toActionView(action, "ATape could not begin sign-in safely."),
    reloadOptions,
    signIn
  }
}

export const useReauthenticationPresenter = () => {
  const [action, reauthenticate] = useAtom(reauthenticationAtom)
  return {
    action: toActionView(action, "ATape could not begin confirmation safely."),
    reauthenticate
  }
}

export const useLogoutPresenter = () => {
  const [action, logout] = useAtom(logoutAtom)
  return { action: toActionView(action, "ATape could not sign out safely."), logout }
}

export const useAccountSecurityPresenter = () => {
  const result = useAtomValue(accountAtom)
  const reload = useAtomRefresh(accountAtom)
  const [action, run] = useAtom(accountActionAtom)
  const resetAction = useCallback(() => run(Atom.Reset), [run])
  return {
    state: (() => {
      const loaded = toLoadView(result, "ATape could not load account security safely.")
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
          webSessions: section(loaded.value.webSessions),
          cliCredentials: section(loaded.value.cliCredentials)
        } satisfies AccountSecurityViewModel
      }
    })(),
    action: toActionView<void>(action, "ATape could not complete the security change safely."),
    reload,
    run,
    resetAction
  }
}

export const useCreateTeamPresenter = () => {
  const [action, submit] = useAtom(createTeamAtom)
  const reset = useCallback(() => submit(Atom.Reset), [submit])
  return {
    action: toActionView<Team>(action, "ATape could not create the Team safely."),
    submit,
    reset
  }
}

export const useJoinTeamPresenter = () => {
  const [action, submit] = useAtom(joinTeamAtom)
  const reset = useCallback(() => submit(Atom.Reset), [submit])
  return {
    action: toActionView<Team>(action, "ATape could not join the Team safely."),
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
    resolution: toActionView<CLIDeviceGrantView>(resolveResult, "ATape could not open the CLI request safely."),
    decision: toActionView<"approve" | "deny">(decisionResult, "ATape could not decide the CLI request safely."),
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
    state: toLoadView<TeamAccess>(result, "ATape could not load Team access safely."),
    action: toActionView<void | JoinCodeGrant>(action, "ATape could not complete the Team change safely."),
    reload,
    run,
    resetAction
  }
}

export type { TeamAccess }
