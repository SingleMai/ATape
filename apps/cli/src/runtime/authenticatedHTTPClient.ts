import {
  CLIAuthenticationGateway,
  CLICredentialStore
} from "@atape/application"
import { normalizeInstanceTopology, type StoredCLICredential } from "@atape/domain"
import { Context, Effect, Layer, Schema } from "effect"

const MaximumBodyBytes = 1024 * 1024
const MetadataCacheMillis = 5 * 60 * 1_000

export class AuthenticatedHTTPError extends Schema.TaggedError<AuthenticatedHTTPError>()(
  "AuthenticatedHTTPError",
  {
    reason: Schema.Literals([
      "unauthenticated",
      "identity_changed",
      "metadata_drift",
      "network",
      "rejected",
      "invalid_response",
      "local_store"
    ]),
    message: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    retryAfterSeconds: Schema.optionalKey(Schema.Number)
  }
) {}

export type AuthenticatedHTTPRequest = {
  readonly instanceOrigin: string
  readonly expectedUserId?: string
  readonly path: `/${string}`
  readonly method: "GET" | "POST" | "DELETE"
  readonly body?: unknown
  readonly idempotencyKey?: string
}

export type AuthenticatedHTTPResponse = {
  readonly status: number
  readonly body?: unknown
  readonly retryAfterSeconds?: number
}

// This runtime-private client is the sole bearer-aware HTTP boundary used by
// setup and collection. Application Modules and untrusted Adapter packages see
// neither the Credential nor its API destination.
export class AuthenticatedHTTPClient extends Context.Service<AuthenticatedHTTPClient, {
  request(input: AuthenticatedHTTPRequest): Effect.Effect<AuthenticatedHTTPResponse, AuthenticatedHTTPError>
}>()("atape/cli/AuthenticatedHTTPClient") {}

export const makeAuthenticatedHTTPClientLayer = (
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  allowLoopbackHttp = false
) => Layer.effect(AuthenticatedHTTPClient, Effect.gen(function*() {
  const credentials = yield* CLICredentialStore
  const authentication = yield* CLIAuthenticationGateway
  const verified = new Map<string, { readonly apiOrigin: string; readonly checkedAt: number }>()

  return AuthenticatedHTTPClient.of({
    request: (input) => Effect.gen(function*() {
      const credential = yield* credentials.read(input.instanceOrigin).pipe(
        Effect.mapError(() => failure("local_store", "Could not read the local CLI credential."))
      )
      if (credential === undefined) {
        return yield* failure("unauthenticated", `Sign in to ${input.instanceOrigin} with \`atape login\` first.`)
      }
      if (input.expectedUserId !== undefined && credential.user.id !== input.expectedUserId) {
        return yield* failure(
          "identity_changed",
          "The active CLI account differs from this local Project; run setup again for the current account."
        )
      }
      yield* verifyPinnedTopology(authentication, credential, verified, allowLoopbackHttp)
      return yield* credentialedRequest(fetchImplementation, credential, input)
    })
  })
}))

const verifyPinnedTopology = (
  authentication: CLIAuthenticationGateway["Service"],
  credential: StoredCLICredential,
  cache: Map<string, { readonly apiOrigin: string; readonly checkedAt: number }>,
  allowLoopbackHttp: boolean
): Effect.Effect<void, AuthenticatedHTTPError> => Effect.gen(function*() {
  const cached = cache.get(credential.instanceOrigin)
  if (cached !== undefined && cached.apiOrigin === credential.apiOrigin &&
    Date.now() - cached.checkedAt < MetadataCacheMillis) return

  const discovered = yield* authentication.discover(credential.instanceOrigin).pipe(
    Effect.mapError((error) => failure(
      error.reason === "transport" || error.reason === "unavailable" ? "network" : "invalid_response",
      "Could not verify the ATape Instance before sending a credential."
    ))
  )
  const topology = normalizeInstanceTopology(discovered, { allowLoopbackHttp })
  if (topology === undefined || topology.instanceOrigin !== credential.instanceOrigin ||
    topology.apiOrigin !== credential.apiOrigin) {
    return yield* failure(
      "metadata_drift",
      "The ATape Instance API destination changed; sign in again before sending data."
    )
  }
  cache.set(credential.instanceOrigin, { apiOrigin: credential.apiOrigin, checkedAt: Date.now() })
})

const credentialedRequest = (
  fetchImplementation: typeof globalThis.fetch,
  credential: StoredCLICredential,
  input: AuthenticatedHTTPRequest
): Effect.Effect<AuthenticatedHTTPResponse, AuthenticatedHTTPError> => Effect.tryPromise({
  try: async (signal) => {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${credential.credential}`
    })
    let body: string | undefined
    if (input.body !== undefined) {
      headers.set("Content-Type", "application/json")
      body = JSON.stringify(input.body)
    }
    if (input.idempotencyKey !== undefined) headers.set("Idempotency-Key", input.idempotencyKey)
    const response = await fetchImplementation(`${credential.apiOrigin}${input.path}`, {
      method: input.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    })
    const bytes = response.status === 204 ? new Uint8Array() : await readBounded(response)
    let responseBody: unknown = undefined
    if (bytes.byteLength > 0) {
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
      if (!contentType.includes("application/json") && !contentType.includes("application/problem+json")) {
        throw new InvalidHTTPResponse()
      }
      try {
        responseBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
      } catch {
        throw new InvalidHTTPResponse()
      }
    }
    const retryAfterSeconds = retryAfter(response.headers.get("retry-after"))
    return {
      status: response.status,
      ...(responseBody === undefined ? {} : { body: responseBody }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
    }
  },
  catch: (cause) => cause instanceof InvalidHTTPResponse
    ? failure("invalid_response", "The ATape API returned an invalid response.")
    : failure("network", "Could not reach the authenticated ATape API.")
})

const readBounded = async (response: Response): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MaximumBodyBytes)) {
    await response.body?.cancel().catch(() => undefined)
    throw new InvalidHTTPResponse()
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MaximumBodyBytes) {
        await reader.cancel().catch(() => undefined)
        throw new InvalidHTTPResponse()
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

const retryAfter = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

class InvalidHTTPResponse extends Error {}

const failure = (
  reason: AuthenticatedHTTPError["reason"],
  message: string,
  options: { readonly status?: number; readonly retryAfterSeconds?: number } = {}
) => new AuthenticatedHTTPError({ reason, message, ...options })
