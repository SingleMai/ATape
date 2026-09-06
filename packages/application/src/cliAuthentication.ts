import type {
  CLIDeviceAuthorization,
  CLIIdentity,
  InstanceMetadata,
  IssuedCLICredential,
  StoredCLICredential
} from "@atape/domain"
import {
  CLIAuthorizationProtocol,
  CLICredentialFileVersion,
  normalizeInstanceOrigin,
  normalizeInstanceTopology
} from "@atape/domain"
import { Clock, Context, Effect, Random, Schema } from "effect"

export const CLIAuthenticationFailureReason = Schema.Literals([
  "invalid_instance",
  "incompatible_instance",
  "transport",
  "decode",
  "authorization_denied",
  "authorization_expired",
  "authorization_consumed",
  "slow_down",
  "unavailable",
  "credential_store",
  "credential_conflict",
  "interaction"
])
export type CLIAuthenticationFailureReason = typeof CLIAuthenticationFailureReason.Type

export class CLIAuthenticationError extends Schema.TaggedError<CLIAuthenticationError>()("CLIAuthenticationError", {
  reason: CLIAuthenticationFailureReason,
  message: Schema.String,
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  orphanedCredential: Schema.optionalKey(Schema.Boolean)
}) {}

export class CLICredentialStoreError extends Schema.TaggedError<CLICredentialStoreError>()("CLICredentialStoreError", {
  reason: Schema.Literals(["io", "decode", "unsafe", "conflict"]),
  message: Schema.String
}) {}

export class CLIInteractionError extends Schema.TaggedError<CLIInteractionError>()("CLIInteractionError", {
  message: Schema.String
}) {}

export type CLIPollResult =
  | { readonly _tag: "Pending"; readonly retryAfterSeconds: number }
  | { readonly _tag: "Authorized"; readonly credential: IssuedCLICredential }

// The Gateway is the only HTTP-aware Seam. Device and bearer secrets cross it
// only into this Module and never reach command presenters or Harness Adapters.
export class CLIAuthenticationGateway extends Context.Service<CLIAuthenticationGateway, {
  discover(instanceOrigin: string): Effect.Effect<InstanceMetadata, CLIAuthenticationError>
  createDeviceAuthorization(metadata: InstanceMetadata): Effect.Effect<CLIDeviceAuthorization, CLIAuthenticationError>
  pollDeviceAuthorization(
    metadata: InstanceMetadata,
    deviceCode: string
  ): Effect.Effect<CLIPollResult, CLIAuthenticationError>
  revokeCredential(credential: StoredCLICredential): Effect.Effect<void, CLIAuthenticationError>
}>()("atape/application/CLIAuthenticationGateway") {}

// Replacement and removal are compare-and-swap operations so concurrent
// login/logout processes cannot silently overwrite one another's authority.
export class CLICredentialStore extends Context.Service<CLICredentialStore, {
  read(instanceOrigin: string): Effect.Effect<StoredCLICredential | undefined, CLICredentialStoreError>
  replace(input: {
    readonly expectedCredentialId?: string
    readonly credential: StoredCLICredential
  }): Effect.Effect<void, CLICredentialStoreError>
  remove(input: {
    readonly instanceOrigin: string
    readonly expectedCredentialId: string
  }): Effect.Effect<boolean, CLICredentialStoreError>
}>()("atape/application/CLICredentialStore") {}

export type CLIChallenge = {
  readonly instanceOrigin: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string
  readonly expiresInSeconds: number
}

export class CLIAuthenticationInteraction extends Context.Service<CLIAuthenticationInteraction, {
  presentChallenge(challenge: CLIChallenge): Effect.Effect<void, CLIInteractionError>
  openBrowser(uri: string): Effect.Effect<boolean>
}>()("atape/application/CLIAuthenticationInteraction") {}

export type LoginCLIInput = {
  readonly instanceOrigin: string
  readonly allowLoopbackHttp?: boolean
  readonly openBrowser?: boolean
}

export type LoginCLIResult = {
  readonly instanceOrigin: string
  readonly apiOrigin: string
  readonly user: CLIIdentity
  readonly credentialId: string
  readonly createdAt: string
  readonly browserOpened: boolean
  readonly replacedCredentialId?: string
  readonly warnings: ReadonlyArray<string>
}

export type LogoutCLIResult = {
  readonly instanceOrigin: string
  readonly signedOut: boolean
  readonly warnings: ReadonlyArray<string>
}

export type InstanceSelection = {
  readonly commandLine?: string
  readonly environment?: string
  readonly savedActive?: string
  readonly allowLoopbackHttp?: boolean
}

export const selectInstanceOrigin = (selection: InstanceSelection): Effect.Effect<string, CLIAuthenticationError> => {
  const candidate = selection.commandLine ?? selection.environment ?? selection.savedActive ?? "https://atape.net"
  const normalized = normalizeInstanceOrigin(candidate, {
    allowLoopbackHttp: selection.allowLoopbackHttp === true
  })
  return normalized === undefined
    ? Effect.fail(authError("invalid_instance", "The ATape Instance must be a canonical HTTPS origin."))
    : Effect.succeed(normalized)
}

export const loginCLI = Effect.fn("CLIAuthentication.login")(function*(input: LoginCLIInput) {
  const gateway = yield* CLIAuthenticationGateway
  const credentials = yield* CLICredentialStore
  const interaction = yield* CLIAuthenticationInteraction
  const policy = { allowLoopbackHttp: input.allowLoopbackHttp === true }
  const instanceOrigin = yield* selectInstanceOrigin({
    commandLine: input.instanceOrigin,
    allowLoopbackHttp: policy.allowLoopbackHttp
  })
  // Validate and snapshot the existing local authority before asking the
  // server to mint anything. A locally unsafe/unreadable store must not leave
  // a newly issued Credential that the client cannot durably adopt or revoke.
  const previous = yield* credentials.read(instanceOrigin).pipe(
    Effect.mapError(credentialStoreFailure)
  )
  const discovered = yield* gateway.discover(instanceOrigin)
  const topology = normalizeInstanceTopology(discovered, policy)
  if (topology === undefined || topology.instanceOrigin !== instanceOrigin) {
    return yield* authError(
      "incompatible_instance",
      "The Instance returned an invalid or mismatched public topology."
    )
  }
  if (!discovered.protocols.includes(CLIAuthorizationProtocol)) {
    return yield* authError(
      "incompatible_instance",
      `The Instance does not support ${CLIAuthorizationProtocol}.`
    )
  }
  const metadata: InstanceMetadata = { ...discovered, ...topology }
  const authorizationStartedAt = yield* Clock.currentTimeMillis
  const authorization = yield* gateway.createDeviceAuthorization(metadata)
  if (authorization.protocol !== CLIAuthorizationProtocol ||
    !safeVerificationURI(authorization.verificationUri, topology.webOrigin, policy.allowLoopbackHttp) ||
    !safeVerificationURI(authorization.verificationUriComplete, topology.webOrigin, policy.allowLoopbackHttp)) {
    return yield* authError("decode", "The Instance returned an unsafe CLI authorization destination.")
  }

  yield* interaction.presentChallenge({
    instanceOrigin,
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUri,
    verificationUriComplete: authorization.verificationUriComplete,
    expiresInSeconds: authorization.expiresInSeconds
  }).pipe(Effect.mapError((error) => authError("interaction", error.message)))
  const browserOpened = input.openBrowser === false
    ? false
    : yield* interaction.openBrowser(authorization.verificationUriComplete)

  const deadline = authorizationStartedAt + authorization.expiresInSeconds * 1_000
  let pollDelaySeconds = authorization.intervalSeconds
  let transportDelaySeconds = authorization.intervalSeconds
  let issued: IssuedCLICredential | undefined
  while (issued === undefined) {
    const now = yield* Clock.currentTimeMillis
    const remainingMillis = deadline - now
    if (remainingMillis <= pollDelaySeconds * 1_000) {
      return yield* authError("authorization_expired", "The CLI authorization expired before approval.")
    }
    yield* Effect.sleep(pollDelaySeconds * 1_000)
    const attempt = yield* gateway.pollDeviceAuthorization(metadata, authorization.deviceCode).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: (result) => ({ _tag: "Success" as const, result })
      })
    )
    if (attempt._tag === "Success") {
      transportDelaySeconds = authorization.intervalSeconds
      if (attempt.result._tag === "Authorized") {
        issued = attempt.result.credential
      } else {
        pollDelaySeconds = Math.max(authorization.intervalSeconds, attempt.result.retryAfterSeconds)
      }
      continue
    }
    const error = attempt.error
    if (error.reason === "slow_down") {
      pollDelaySeconds = Math.max(
        authorization.intervalSeconds,
        pollDelaySeconds + 5,
        error.retryAfterSeconds ?? 0
      )
      continue
    }
    if (error.reason === "transport" || error.reason === "unavailable") {
      const random = yield* Random.next
      transportDelaySeconds = nextTransportRetryDelay({
        previousSeconds: transportDelaySeconds,
        minimumSeconds: authorization.intervalSeconds,
        ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
        random
      })
      pollDelaySeconds = transportDelaySeconds
      continue
    }
    return yield* error
  }

  const nextCredential: StoredCLICredential = {
    version: CLICredentialFileVersion,
    instanceOrigin: topology.instanceOrigin,
    apiOrigin: topology.apiOrigin,
    credential: issued.credential,
    credentialId: issued.credentialId,
    capabilityVersion: issued.capabilityVersion,
    createdAt: issued.createdAt,
    user: issued.user
  }
  const saved = yield* credentials.replace({
    ...(previous === undefined ? {} : { expectedCredentialId: previous.credentialId }),
    credential: nextCredential
  }).pipe(Effect.match({
    onFailure: (error) => ({ _tag: "Failure" as const, error }),
    onSuccess: () => ({ _tag: "Success" as const })
  }))
  if (saved._tag === "Failure") {
    const revoked = yield* gateway.revokeCredential(nextCredential).pipe(Effect.match({
      onFailure: () => false,
      onSuccess: () => true
    }))
    return yield* new CLIAuthenticationError({
      reason: saved.error.reason === "conflict" ? "credential_conflict" : "credential_store",
      message: revoked
        ? "The new CLI credential could not be saved and was revoked."
        : "The new CLI credential could not be saved; it may require manual revocation.",
      ...(!revoked ? { orphanedCredential: true } : {})
    })
  }

  const warnings: Array<string> = []
  if (previous !== undefined) {
    const oldRevoked = yield* gateway.revokeCredential(previous).pipe(Effect.match({
      onFailure: () => false,
      onSuccess: () => true
    }))
    if (!oldRevoked) warnings.push("The previous CLI credential could not be revoked automatically.")
  }
  return {
    instanceOrigin,
    apiOrigin: topology.apiOrigin,
    user: issued.user,
    credentialId: issued.credentialId,
    createdAt: issued.createdAt,
    browserOpened,
    ...(previous === undefined ? {} : { replacedCredentialId: previous.credentialId }),
    warnings
  } satisfies LoginCLIResult
})

export const logoutCLI = Effect.fn("CLIAuthentication.logout")(function*(input: {
  readonly instanceOrigin: string
  readonly allowLoopbackHttp?: boolean
}) {
  const instanceOrigin = yield* selectInstanceOrigin({
    commandLine: input.instanceOrigin,
    allowLoopbackHttp: input.allowLoopbackHttp === true
  })
  const gateway = yield* CLIAuthenticationGateway
  const credentials = yield* CLICredentialStore
  const current = yield* credentials.read(instanceOrigin).pipe(Effect.mapError(credentialStoreFailure))
  if (current === undefined) {
    return { instanceOrigin, signedOut: false, warnings: [] } satisfies LogoutCLIResult
  }
  const removed = yield* credentials.remove({
    instanceOrigin,
    expectedCredentialId: current.credentialId
  }).pipe(Effect.mapError(credentialStoreFailure))
  if (!removed) {
    return yield* authError(
      "credential_conflict",
      "The local credential changed while logout was in progress; no newer credential was removed."
    )
  }
  // Local authority is removed before the network call so cancellation or an
  // offline Instance cannot leave this process signed in on disk.
  const remoteRevoked = yield* gateway.revokeCredential(current).pipe(Effect.match({
    onFailure: () => false,
    onSuccess: () => true
  }))
  const replacement = yield* credentials.read(instanceOrigin).pipe(Effect.mapError(credentialStoreFailure))
  if (replacement !== undefined) {
    return yield* authError(
      "credential_conflict",
      "A newer local credential was created while logout was in progress; it was not removed."
    )
  }
  return {
    instanceOrigin,
    signedOut: true,
    warnings: remoteRevoked ? [] : ["The local credential was removed, but remote revocation could not be confirmed."]
  } satisfies LogoutCLIResult
})

export const nextTransportRetryDelay = (input: {
  readonly previousSeconds: number
  readonly minimumSeconds: number
  readonly retryAfterSeconds?: number
  readonly random: number
}): number => {
  const minimum = Math.max(1, input.minimumSeconds)
  const base = Math.min(30, Math.max(minimum, input.previousSeconds * 2))
  const jitter = 0.8 + Math.min(1, Math.max(0, input.random)) * 0.4
  const jittered = Math.max(minimum, Math.min(30, Math.round(base * jitter)))
  return Math.max(jittered, input.retryAfterSeconds ?? 0)
}

const safeVerificationURI = (input: string, webOrigin: string, allowLoopbackHttp: boolean): boolean => {
  try {
    const parsed = new URL(input)
    if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || parsed.origin !== webOrigin) {
      return false
    }
    return normalizeInstanceOrigin(parsed.origin, { allowLoopbackHttp }) !== undefined
  } catch {
    return false
  }
}

const authError = (reason: CLIAuthenticationFailureReason, message: string) =>
  new CLIAuthenticationError({ reason, message })

const credentialStoreFailure = (error: CLICredentialStoreError) => new CLIAuthenticationError({
  reason: error.reason === "conflict" ? "credential_conflict" : "credential_store",
  message: error.message
})
