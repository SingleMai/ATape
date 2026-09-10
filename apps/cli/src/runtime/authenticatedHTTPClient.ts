import {
  CLIAuthenticationGateway,
  CLICredentialStore
} from "@atape/application"
import { normalizeInstanceTopology, type StoredCLICredential } from "@atape/domain"
import { hostname, platform, arch } from "node:os"
import { cliVersion } from "../version.ts"
import type { CLIDeviceMetadata } from "@atape/domain"
import { Clock, Context, Effect, Layer, Schema } from "effect"

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
    networkKind: Schema.optionalKey(Schema.Literals(["timeout", "dns", "connection", "tls", "redirect", "unknown"])),
    networkCode: Schema.optionalKey(Schema.String),
    retryAfterSeconds: Schema.optionalKey(Schema.Number)
  }
) {}

export type AuthenticatedHTTPRequest = {
  readonly instanceOrigin: string
  readonly expectedUserId?: string
  readonly path: `/${string}`
  readonly method: "GET" | "POST" | "PUT" | "DELETE"
  readonly idempotencyKey?: string
  readonly deviceReport?: CLIDeviceMetadata & { readonly sync: import("@atape/domain").CLISyncReport }
} & ({ readonly body?: unknown; readonly encodedJson?: never } | { readonly encodedJson: Uint8Array; readonly body?: never })

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
  allowLoopbackHttp = false,
  deviceReport: Effect.Effect<CLIDeviceMetadata> = Effect.sync(() => ({ name: hostname(), platform: `${platform()} ${arch()}`, version: cliVersion }))
) => Layer.effect(AuthenticatedHTTPClient, Effect.gen(function*() {
  const cachedDeviceReport = yield* Effect.cachedWithTTL(deviceReport, "30 seconds")
  const credentials = yield* CLICredentialStore
  const authentication = yield* CLIAuthenticationGateway
  const verified = new Map<string, { readonly apiOrigin: string; readonly checkedAt: number }>()

  return AuthenticatedHTTPClient.of({
    request: (input) => Effect.gen(function*() {
      const startedAt = yield* Clock.currentTimeMillis
      const operation = requestOperation(input.path)
      return yield* Effect.gen(function*() {
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
        const device = input.deviceReport ?? (yield* cachedDeviceReport)
        return yield* credentialedRequest(fetchImplementation, credential, input, device)
      }).pipe(
        Effect.tapError(error => Effect.gen(function*() {
          // Never log exception messages, request URLs, bodies or credentials.
          yield* Effect.logWarning("ATape API request failed", {
            operation,
            method: input.method,
            reason: error.reason,
            networkKind: error.networkKind,
            networkCode: error.networkCode,
            elapsedMs: (yield* Clock.currentTimeMillis) - startedAt
          })
        })),
        Effect.tap(response => response.status >= 400
          ? Effect.logWarning("ATape API request rejected", {
              operation, method: input.method, status: response.status,
              retryAfterSeconds: response.retryAfterSeconds
            }) : Effect.void)
      )
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
  input: AuthenticatedHTTPRequest,
  device: CLIDeviceMetadata
): Effect.Effect<AuthenticatedHTTPResponse, AuthenticatedHTTPError> => Effect.tryPromise({
  try: async (signal) => {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${credential.credential}`
    })
    const report = Buffer.from(JSON.stringify(device)).toString("base64url")
    if (report.length <= 8192) headers.set("X-Atape-Device", report)
    let body: string | Uint8Array<ArrayBuffer> | undefined
    if (input.encodedJson !== undefined) {
      const maximum = input.method === "POST" && input.path === "/api/v1/ingestion/raw/chunks" ? 5 * 1024 * 1024 :
        input.method === "PUT" && /^\/api\/v1\/publications\/attempts\/[^/]+\/parts\/\d+\?sha256=[a-f0-9]{64}$/.test(input.path) ? 4 * 1024 * 1024 : 0
      if (input.body !== undefined || input.encodedJson.byteLength < 1 || input.encodedJson.byteLength > maximum) throw new InvalidHTTPRequest()
      headers.set("Content-Type", "application/json")
      body = new Uint8Array(input.encodedJson)
    }
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(
        input.path === "/api/v1/ingestion/canonical/batches" || input.path === "/api/v1/ingestion/raw/chunks" || input.path.startsWith("/api/v1/publications/") ? 60_000 : 10_000
      )])
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
  catch: (cause) => cause instanceof InvalidHTTPRequest
    ? failure("rejected", "The prepared publication request exceeds its transport contract.")
    : cause instanceof InvalidHTTPResponse
    ? failure("invalid_response", "The ATape API returned an invalid response.")
    : networkFailure(cause, input.path)
})

const requestOperation = (path: string) => {
  switch (path) {
    case "/api/v1/project-matches": return "project_match"
    case "/api/v1/ingestion/canonical/batches": return "canonical_upload"
    case "/api/v1/ingestion/raw/chunks": return "raw_upload"
    default: return "control"
  }
}

const networkCodes = new Map<string, NonNullable<AuthenticatedHTTPError["networkKind"]>>([
  ["TimeoutError", "timeout"], ["ETIMEDOUT", "timeout"],
  ["UND_ERR_CONNECT_TIMEOUT", "timeout"], ["UND_ERR_HEADERS_TIMEOUT", "timeout"], ["UND_ERR_BODY_TIMEOUT", "timeout"],
  ["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"],
  ["ECONNRESET", "connection"], ["ECONNREFUSED", "connection"], ["EPIPE", "connection"],
  ["ENETUNREACH", "connection"], ["EHOSTUNREACH", "connection"], ["UND_ERR_SOCKET", "connection"],
  ["CERT_HAS_EXPIRED", "tls"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"], ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
  ["UND_ERR_REDIRECT", "redirect"]
])

const networkFailure = (cause: unknown, path: string): AuthenticatedHTTPError => {
  // Node fetch may wrap a system error in TypeError.cause or AggregateError.
  // Inspect bounded nodes and only emit known codes; arbitrary messages can
  // contain destinations, query strings, credentials or source content.
  const pending: unknown[] = [cause]
  for (let inspected = 0; pending.length > 0 && inspected < 16; inspected++) {
    const current = pending.shift()
    if (typeof current !== "object" || current === null) continue
    const error = current as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown }
    for (const code of [error.code, error.name]) {
      const kind = typeof code === "string" ? networkCodes.get(code) : undefined
      if (kind) return new AuthenticatedHTTPError({
        reason: "network", networkKind: kind, networkCode: code as string,
        message: `ATape ${requestOperation(path)} request failed: ${kind} (${code}).`
      })
    }
    pending.push(error.cause)
    if (Array.isArray(error.errors)) pending.push(...error.errors.slice(0, 4))
  }
  return new AuthenticatedHTTPError({ reason: "network", networkKind: "unknown",
    message: `ATape ${requestOperation(path)} request failed: unknown network error.` })
}

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
class InvalidHTTPRequest extends Error {}

const failure = (
  reason: AuthenticatedHTTPError["reason"],
  message: string,
  options: { readonly status?: number; readonly retryAfterSeconds?: number } = {}
) => new AuthenticatedHTTPError({ reason, message, ...options })
