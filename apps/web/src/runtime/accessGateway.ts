import {
  AccessError,
  AuthenticationGateway,
  TeamAccessGateway
} from "@atape/application"
import {
  CLICredential,
  CLIDeviceGrantView,
  ExternalIdentity,
  InstanceMetadata,
  JoinCodeGrant,
  JoinCodeStatus,
  ProviderRegistration,
  AuthenticatedSession,
  Team,
  TeamMember,
  WebSession,
  type TeamRole
} from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import {
  BrowserHTTPError,
  browserRequest,
  clearBrowserAuthentication,
  newIdempotencyKey,
  setBrowserCSRFToken
} from "./http"

const Items = <S extends Schema.Top>(item: S) => Schema.Struct({ items: Schema.Array(item) })
const BeginFederatedResponse = Schema.Struct({
  loginTransactionId: Schema.String,
  authorizationUri: Schema.String,
  expiresAt: Schema.String
})
const WireInstanceMetadata = Schema.Struct({
  protocol: Schema.Literal("atape.instance.v1"),
  instance_origin: Schema.String,
  web_origin: Schema.String,
  api_origin: Schema.String,
  protocols: Schema.Array(Schema.String),
  release_version: Schema.String,
  auth_epoch: Schema.Literal("auth-v1"),
  minimum_cli_version: Schema.String
})
const WireSessionBootstrap = Schema.Struct({
  user: AuthenticatedSession.fields.user,
  webSession: AuthenticatedSession.fields.webSession,
  csrfToken: Schema.String
})

const accessReason = (error: BrowserHTTPError): AccessError["reason"] => {
  if (error.reason === "transport") return "transport"
  if (error.reason === "decode") return "decode"
  switch (error.code) {
    case "unauthenticated":
    case "session_expired":
    case "session_revoked":
      return "unauthenticated"
    case "fresh_authentication_required":
      return "fresh_authentication_required"
    case "access_denied":
    case "membership_role_denied":
    case "credential_capability_denied":
      return "forbidden"
    case "not_found":
      return "not_found"
    case "invalid_request":
    case "invalid_user_code":
    case "invalid_join_code":
    case "validation_failed":
      return "invalid_input"
    case "idempotency_conflict":
    case "idempotency_in_progress":
    case "last_owner_required":
    case "grant_already_decided":
    case "resource_state_conflict":
      return "conflict"
    case "slow_down":
    case "too_many_code_attempts":
      return "rate_limited"
    case "provider_unavailable":
      return "provider_unavailable"
    case "service_unavailable":
      return "unavailable"
    default:
      return "unknown"
  }
}

const toAccessError = (error: BrowserHTTPError): AccessError => new AccessError({
  reason: accessReason(error),
  code: error.code ?? error.reason,
  message: error.message,
  ...(error.status === undefined ? {} : { status: error.status }),
  ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
  ...(error.incident === undefined ? {} : { incident: error.incident })
})

const decode = <S extends Schema.Top>(schema: S, payload: unknown) =>
  Schema.decodeUnknownEffect(schema)(payload).pipe(
    Effect.mapError(() => new AccessError({
      reason: "decode",
      code: "invalid_response",
      message: "The ATape response did not match the expected protocol."
    }))
  )

const requestDecoded = <S extends Schema.Top>(
  path: string,
  schema: S,
  options?: Parameters<typeof browserRequest>[1]
) => browserRequest(path, options).pipe(
  Effect.mapError(toAccessError),
  Effect.flatMap((payload) => decode(schema, payload))
)

const requestVoid = (
  path: string,
  options: Parameters<typeof browserRequest>[1]
): Effect.Effect<void, AccessError> => browserRequest(path, options).pipe(
  Effect.mapError(toAccessError),
  Effect.asVoid
)

const encoded = (value: string) => encodeURIComponent(value)

const retryableIdempotentCreation = (error: AccessError): boolean =>
  error.reason === "transport" || error.reason === "unavailable" || error.code === "idempotency_in_progress"

const createTeamWithReplay = (
  input: { readonly slug: string; readonly displayName: string },
  idempotencyKey: string,
  retry = 0
): Effect.Effect<Team, AccessError> => requestDecoded("/api/v1/teams", Team, {
  method: "POST",
  body: input,
  csrf: true,
  idempotencyKey
}).pipe(
  Effect.catchIf((error) => retry < 2 && retryableIdempotentCreation(error), (error) => {
    const delayMilliseconds = error.retryAfter === undefined
      ? 250 * (2 ** retry)
      : Math.min(Math.max(error.retryAfter, 1), 5) * 1_000
    return Effect.sleep(`${delayMilliseconds} millis`).pipe(
      Effect.flatMap(() => createTeamWithReplay(input, idempotencyKey, retry + 1))
    )
  })
)

const beginFederated = (path: string, input: {
  readonly providerRegistrationId: string
  readonly returnTo: string
}) => requestDecoded(path, BeginFederatedResponse, {
  method: "POST",
  body: input,
  ...(path.endsWith("sign-ins") ? {} : { csrf: true })
}).pipe(Effect.map((response) => response.authorizationUri))

const authenticationGateway = AuthenticationGateway.of({
  restoreSession: () => requestDecoded("/api/v1/auth/session", WireSessionBootstrap).pipe(
    Effect.tap((session) => Effect.sync(() => setBrowserCSRFToken(session.csrfToken))),
    Effect.tapError(() => Effect.sync(clearBrowserAuthentication)),
    Effect.map(({ user, webSession }) => ({ user, webSession }))
  ),
  loadInstance: () => requestDecoded("/api/v1/instance", WireInstanceMetadata).pipe(
    Effect.map((metadata) => ({
      protocol: metadata.protocol,
      instanceOrigin: metadata.instance_origin,
      webOrigin: metadata.web_origin,
      apiOrigin: metadata.api_origin,
      protocols: metadata.protocols,
      releaseVersion: metadata.release_version,
      authEpoch: metadata.auth_epoch,
      minimumCliVersion: metadata.minimum_cli_version
    })),
    Effect.flatMap((metadata) => decode(InstanceMetadata, metadata))
  ),
  listProviderRegistrations: () => requestDecoded(
    "/api/v1/auth/provider-registrations",
    Items(ProviderRegistration)
  ).pipe(Effect.map((response) => response.items)),
  beginSignIn: (input) => beginFederated("/api/v1/auth/federated/sign-ins", input),
  beginReauthentication: (input) => beginFederated("/api/v1/auth/federated/reauthentications", input),
  logout: () => requestVoid("/api/v1/auth/logout", { method: "POST", body: {}, csrf: true }).pipe(
    Effect.tap(() => Effect.sync(clearBrowserAuthentication))
  ),
  listExternalIdentities: () => requestDecoded(
    "/api/v1/users/me/external-identities",
    Items(ExternalIdentity)
  ).pipe(Effect.map((response) => response.items)),
  listWebSessions: () => requestDecoded(
    "/api/v1/users/me/web-sessions",
    Items(WebSession)
  ).pipe(Effect.map((response) => response.items)),
  revokeWebSession: (sessionId) => requestVoid(
    `/api/v1/users/me/web-sessions/${encoded(sessionId)}`,
    { method: "DELETE", csrf: true }
  ),
  revokeAllWebSessions: () => requestVoid(
    "/api/v1/users/me/web-sessions/revoke-all",
    { method: "POST", body: {}, csrf: true }
  ),
  listCLICredentials: () => requestDecoded(
    "/api/v1/users/me/cli-credentials",
    Items(CLICredential)
  ).pipe(Effect.map((response) => response.items)),
  revokeCLICredential: (credentialId) => requestVoid(
    `/api/v1/users/me/cli-credentials/${encoded(credentialId)}`,
    { method: "DELETE", csrf: true }
  ),
  revokeAllCLICredentials: () => requestVoid(
    "/api/v1/users/me/cli-credentials/revoke-all",
    { method: "POST", body: {}, csrf: true }
  ),
  resolveCLIDeviceGrant: (userCode) => requestDecoded(
    "/api/v1/auth/cli/device-grants/resolve",
    CLIDeviceGrantView,
    { method: "POST", body: { user_code: userCode }, csrf: true }
  ),
  decideCLIDeviceGrant: (grantViewId, decision) => requestVoid(
    `/api/v1/auth/cli/device-grants/${encoded(grantViewId)}/${decision}`,
    { method: "POST", body: {}, csrf: true }
  )
})

const teamGateway = TeamAccessGateway.of({
  // The Adapter owns ambiguity recovery. Every retry of one logical create
  // replays the same opaque key, so callers never need HTTP knowledge.
  createTeam: (input) => createTeamWithReplay(input, newIdempotencyKey()),
  joinTeam: (joinCode) => requestDecoded("/api/v1/team-memberships", Team, {
    method: "POST",
    body: { joinCode },
    csrf: true
  }),
  openTeam: (teamSlug) => requestDecoded(`/api/v1/teams/${encoded(teamSlug)}`, Team),
  listMembers: (teamSlug) => requestDecoded(
    `/api/v1/teams/${encoded(teamSlug)}/members`,
    Items(TeamMember)
  ).pipe(Effect.map((response) => response.items)),
  readJoinCodeStatus: (teamSlug) => requestDecoded(
    `/api/v1/teams/${encoded(teamSlug)}/join-code`,
    JoinCodeStatus
  ),
  rotateJoinCode: (teamSlug) => requestDecoded(
    `/api/v1/teams/${encoded(teamSlug)}/join-code/rotations`,
    JoinCodeGrant,
    { method: "POST", body: {}, csrf: true }
  ),
  disableJoinCode: (teamSlug) => requestVoid(
    `/api/v1/teams/${encoded(teamSlug)}/join-code`,
    { method: "DELETE", csrf: true }
  ),
  setMemberRole: (teamSlug, userId, role: TeamRole) => requestVoid(
    `/api/v1/teams/${encoded(teamSlug)}/members/${encoded(userId)}/role`,
    { method: "PUT", body: { role }, csrf: true }
  ),
  removeMember: (teamSlug, userId) => requestVoid(
    `/api/v1/teams/${encoded(teamSlug)}/members/${encoded(userId)}`,
    { method: "DELETE", csrf: true }
  ),
  leaveTeam: (teamSlug) => requestVoid(
    `/api/v1/teams/${encoded(teamSlug)}/leave`,
    { method: "POST", body: {}, csrf: true }
  )
})

export const BrowserAccessLayer = Layer.mergeAll(
  Layer.succeed(AuthenticationGateway, authenticationGateway),
  Layer.succeed(TeamAccessGateway, teamGateway)
)
