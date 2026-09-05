import type {
  CLICredential,
  CLIDeviceGrantView,
  ExternalIdentity,
  InstanceMetadata,
  JoinCodeGrant,
  JoinCodeStatus,
  ProviderRegistration,
  AuthenticatedSession,
  SignInOptions,
  Team,
  TeamMember,
  TeamRole,
  WebSession
} from "@atape/domain"
import {
  normalizeDeviceUserCode,
  normalizeTeamJoinCode,
  safeAuthorizationURI,
  safeLocalReturnTo,
  validTeamSlug
} from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export const AccessFailureReason = Schema.Literals([
  "invalid_input",
  "transport",
  "decode",
  "unauthenticated",
  "fresh_authentication_required",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "provider_unavailable",
  "unavailable",
  "unknown"
])
export type AccessFailureReason = typeof AccessFailureReason.Type

export class AccessError extends Schema.TaggedError<AccessError>()("AccessError", {
  reason: AccessFailureReason,
  code: Schema.String,
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  retryAfter: Schema.optionalKey(Schema.Number),
  incident: Schema.optionalKey(Schema.String)
}) {}

export type BeginFederatedInput = {
  readonly providerRegistrationId: string
  readonly returnTo: string
}

export class AuthenticationGateway extends Context.Service<AuthenticationGateway, {
  restoreSession(): Effect.Effect<AuthenticatedSession, AccessError>
  loadInstance(): Effect.Effect<InstanceMetadata, AccessError>
  listProviderRegistrations(): Effect.Effect<ReadonlyArray<ProviderRegistration>, AccessError>
  beginSignIn(input: BeginFederatedInput): Effect.Effect<string, AccessError>
  beginReauthentication(input: BeginFederatedInput): Effect.Effect<string, AccessError>
  logout(): Effect.Effect<void, AccessError>
  listExternalIdentities(): Effect.Effect<ReadonlyArray<ExternalIdentity>, AccessError>
  listWebSessions(): Effect.Effect<ReadonlyArray<WebSession>, AccessError>
  revokeWebSession(sessionId: string): Effect.Effect<void, AccessError>
  revokeAllWebSessions(): Effect.Effect<void, AccessError>
  listCLICredentials(): Effect.Effect<ReadonlyArray<CLICredential>, AccessError>
  revokeCLICredential(credentialId: string): Effect.Effect<void, AccessError>
  revokeAllCLICredentials(): Effect.Effect<void, AccessError>
  resolveCLIDeviceGrant(userCode: string): Effect.Effect<CLIDeviceGrantView, AccessError>
  decideCLIDeviceGrant(grantViewId: string, decision: "approve" | "deny"): Effect.Effect<void, AccessError>
}>()("atape/application/AuthenticationGateway") {}

export type SettledSection<A> =
  | { readonly _tag: "Ready"; readonly value: A }
  | { readonly _tag: "Failed"; readonly error: AccessError }

export type AccountSecurity = {
  readonly providers: SettledSection<ReadonlyArray<ProviderRegistration>>
  readonly identities: SettledSection<ReadonlyArray<ExternalIdentity>>
  readonly webSessions: SettledSection<ReadonlyArray<WebSession>>
  readonly cliCredentials: SettledSection<ReadonlyArray<CLICredential>>
}

const invalidInput = (message: string) => new AccessError({
  reason: "invalid_input",
  code: "invalid_input",
  message
})

const settle = <A>(effect: Effect.Effect<A, AccessError>): Effect.Effect<SettledSection<A>> => effect.pipe(
  Effect.match({
    onFailure: (error) => ({ _tag: "Failed" as const, error }),
    onSuccess: (value) => ({ _tag: "Ready" as const, value })
  })
)

export const restoreWebSession = Effect.fn("Authentication.restoreWebSession")(function*() {
  const gateway = yield* AuthenticationGateway
  return yield* gateway.restoreSession().pipe(Effect.withSpan("Authentication.restoreWebSession"))
})

export const loadSignInOptions = Effect.fn("Authentication.loadSignInOptions")(function*() {
  const gateway = yield* AuthenticationGateway
  return yield* Effect.all({
    instance: gateway.loadInstance(),
    providers: gateway.listProviderRegistrations()
  }, { concurrency: "unbounded" }).pipe(
    Effect.map((options): SignInOptions => options),
    Effect.withSpan("Authentication.loadSignInOptions")
  )
})

const beginFederated = (
  input: BeginFederatedInput,
  operation: (
    gateway: AuthenticationGateway["Service"],
    normalized: BeginFederatedInput
  ) => Effect.Effect<string, AccessError>
) => Effect.gen(function*() {
  const returnTo = safeLocalReturnTo(input.returnTo, "")
  if (returnTo === "") return yield* invalidInput("The return destination is not a safe local path.")
  if (input.providerRegistrationId.trim() === "") {
    return yield* invalidInput("Choose a sign-in method.")
  }
  const gateway = yield* AuthenticationGateway
  const authorizationURI = yield* operation(gateway, {
    providerRegistrationId: input.providerRegistrationId,
    returnTo
  })
  const safeURI = safeAuthorizationURI(authorizationURI)
  if (safeURI === undefined) {
    return yield* new AccessError({
      reason: "decode",
      code: "unsafe_authorization_uri",
      message: "The sign-in method returned an unsafe authorization destination."
    })
  }
  return safeURI
})

export const beginFederatedSignIn = Effect.fn("Authentication.beginSignIn")((input: BeginFederatedInput) =>
  beginFederated(input, (gateway, normalized) => gateway.beginSignIn(normalized))
)

export const beginDefaultReauthentication = Effect.fn("Authentication.beginReauthentication")(
  (returnTo: string) => Effect.gen(function*() {
    const gateway = yield* AuthenticationGateway
    const providers = yield* gateway.listProviderRegistrations()
    const provider = providers[0]
    if (provider === undefined) {
      return yield* new AccessError({
        reason: "unavailable",
        code: "no_provider_registration",
        message: "This ATape instance has no enabled sign-in method."
      })
    }
    return yield* beginFederated(
      { providerRegistrationId: provider.id, returnTo },
      (selected, normalized) => selected.beginReauthentication(normalized)
    ).pipe(Effect.provideService(AuthenticationGateway, gateway))
  })
)

export const logoutWebSession = Effect.fn("Authentication.logout")(function*() {
  const gateway = yield* AuthenticationGateway
  return yield* gateway.logout().pipe(Effect.withSpan("Authentication.logout"))
})

export const loadAccountSecurity = Effect.fn("Authentication.loadAccountSecurity")(function*() {
  const gateway = yield* AuthenticationGateway
  return yield* Effect.all({
    providers: settle(gateway.listProviderRegistrations()),
    identities: settle(gateway.listExternalIdentities()),
    webSessions: settle(gateway.listWebSessions()),
    cliCredentials: settle(gateway.listCLICredentials())
  }, { concurrency: "unbounded" }).pipe(
    Effect.map((snapshot): AccountSecurity => snapshot),
    Effect.withSpan("Authentication.loadAccountSecurity")
  )
})

export const revokeWebSession = Effect.fn("Authentication.revokeWebSession")(function*(sessionId: string) {
  if (sessionId.trim() === "") return yield* invalidInput("The browser session is missing.")
  const gateway = yield* AuthenticationGateway
  return yield* gateway.revokeWebSession(sessionId)
})

export const revokeAllWebSessions = Effect.fn("Authentication.revokeAllWebSessions")(function*() {
  const gateway = yield* AuthenticationGateway
  return yield* gateway.revokeAllWebSessions()
})

export const revokeCLICredential = Effect.fn("Authentication.revokeCLICredential")(function*(credentialId: string) {
  if (credentialId.trim() === "") return yield* invalidInput("The CLI credential is missing.")
  const gateway = yield* AuthenticationGateway
  return yield* gateway.revokeCLICredential(credentialId)
})

export const revokeAllCLICredentials = Effect.fn("Authentication.revokeAllCLICredentials")(function*() {
  const gateway = yield* AuthenticationGateway
  return yield* gateway.revokeAllCLICredentials()
})

export const resolveCLIDeviceGrant = Effect.fn("Authentication.resolveCLIDeviceGrant")(function*(input: string) {
  const userCode = normalizeDeviceUserCode(input)
  if (userCode === undefined) {
    return yield* invalidInput("Enter the six-character code shown by the CLI.")
  }
  const gateway = yield* AuthenticationGateway
  return yield* gateway.resolveCLIDeviceGrant(userCode)
})

export const decideCLIDeviceGrant = Effect.fn("Authentication.decideCLIDeviceGrant")(function*(input: {
  readonly grantViewId: string
  readonly decision: "approve" | "deny"
}) {
  if (input.grantViewId.trim() === "") return yield* invalidInput("The CLI request is missing.")
  const gateway = yield* AuthenticationGateway
  yield* gateway.decideCLIDeviceGrant(input.grantViewId, input.decision)
  return input.decision
})

export class TeamAccessGateway extends Context.Service<TeamAccessGateway, {
  createTeam(input: { readonly slug: string; readonly displayName: string }): Effect.Effect<Team, AccessError>
  joinTeam(joinCode: string): Effect.Effect<Team, AccessError>
  openTeam(teamSlug: string): Effect.Effect<Team, AccessError>
  listMembers(teamSlug: string): Effect.Effect<ReadonlyArray<TeamMember>, AccessError>
  readJoinCodeStatus(teamSlug: string): Effect.Effect<JoinCodeStatus, AccessError>
  rotateJoinCode(teamSlug: string): Effect.Effect<JoinCodeGrant, AccessError>
  disableJoinCode(teamSlug: string): Effect.Effect<void, AccessError>
  setMemberRole(teamSlug: string, userId: string, role: TeamRole): Effect.Effect<void, AccessError>
  removeMember(teamSlug: string, userId: string): Effect.Effect<void, AccessError>
  leaveTeam(teamSlug: string): Effect.Effect<void, AccessError>
}>()("atape/application/TeamAccessGateway") {}

export type TeamAccess = {
  readonly team: Team
  readonly members: ReadonlyArray<TeamMember>
  readonly joinCode?: JoinCodeStatus
}

const normalizedDisplayName = (input: string): string | undefined => {
  const value = input.trim()
  return value.length >= 1 && value.length <= 200 && !/[\r\n\0]/.test(value) ? value : undefined
}

const checkedTeamSlug = (teamSlug: string): Effect.Effect<string, AccessError> => validTeamSlug(teamSlug)
  ? Effect.succeed(teamSlug)
  : Effect.fail(invalidInput("The Team address is invalid."))

const checkedUserId = (userId: string): Effect.Effect<string, AccessError> =>
  userId.length >= 1 && userId.length <= 200 && !/[\u0000-\u001f\u007f]/.test(userId)
    ? Effect.succeed(userId)
    : Effect.fail(invalidInput("The Team member is invalid."))

export const createTeam = Effect.fn("TeamAccess.createTeam")(function*(input: {
  readonly slug: string
  readonly displayName: string
}) {
  const displayName = normalizedDisplayName(input.displayName)
  if (displayName === undefined) return yield* invalidInput("Enter a Team name.")
  if (!validTeamSlug(input.slug)) {
    return yield* invalidInput("Use 2–63 lowercase letters, numbers, and single hyphens for the Team address.")
  }
  const gateway = yield* TeamAccessGateway
  return yield* gateway.createTeam({ slug: input.slug, displayName })
})

export const joinTeam = Effect.fn("TeamAccess.joinTeam")(function*(input: string) {
  const joinCode = normalizeTeamJoinCode(input)
  if (joinCode === undefined) return yield* invalidInput("Enter the six-character Team join code.")
  const gateway = yield* TeamAccessGateway
  return yield* gateway.joinTeam(joinCode)
})

export const loadTeamAccess = Effect.fn("TeamAccess.load")(function*(teamSlug: string) {
  teamSlug = yield* checkedTeamSlug(teamSlug)
  const gateway = yield* TeamAccessGateway
  const team = yield* gateway.openTeam(teamSlug)
  const [members, joinCode] = yield* Effect.all([
    gateway.listMembers(teamSlug),
    team.membership.role === "owner"
      ? gateway.readJoinCodeStatus(teamSlug).pipe(Effect.map((status) => status as JoinCodeStatus | undefined))
      : Effect.succeed(undefined)
  ], { concurrency: "unbounded" })
  return {
    team,
    members,
    ...(joinCode === undefined ? {} : { joinCode })
  } satisfies TeamAccess
})

export const rotateTeamJoinCode = Effect.fn("TeamAccess.rotateJoinCode")(function*(teamSlug: string) {
  teamSlug = yield* checkedTeamSlug(teamSlug)
  const gateway = yield* TeamAccessGateway
  return yield* gateway.rotateJoinCode(teamSlug)
})

export const disableTeamJoinCode = Effect.fn("TeamAccess.disableJoinCode")(function*(teamSlug: string) {
  teamSlug = yield* checkedTeamSlug(teamSlug)
  const gateway = yield* TeamAccessGateway
  return yield* gateway.disableJoinCode(teamSlug)
})

export const setTeamMemberRole = Effect.fn("TeamAccess.setMemberRole")(function*(input: {
  readonly teamSlug: string
  readonly userId: string
  readonly role: TeamRole
}) {
  input = {
    ...input,
    teamSlug: yield* checkedTeamSlug(input.teamSlug),
    userId: yield* checkedUserId(input.userId)
  }
  const gateway = yield* TeamAccessGateway
  return yield* gateway.setMemberRole(input.teamSlug, input.userId, input.role)
})

export const removeTeamMember = Effect.fn("TeamAccess.removeMember")(function*(input: {
  readonly teamSlug: string
  readonly userId: string
}) {
  input = {
    ...input,
    teamSlug: yield* checkedTeamSlug(input.teamSlug),
    userId: yield* checkedUserId(input.userId)
  }
  const gateway = yield* TeamAccessGateway
  return yield* gateway.removeMember(input.teamSlug, input.userId)
})

export const leaveTeam = Effect.fn("TeamAccess.leaveTeam")(function*(teamSlug: string) {
  teamSlug = yield* checkedTeamSlug(teamSlug)
  const gateway = yield* TeamAccessGateway
  return yield* gateway.leaveTeam(teamSlug)
})
