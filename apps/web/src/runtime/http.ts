import { Effect } from "effect"

export type BrowserHTTPFailureReason = "transport" | "http" | "decode"

export class BrowserHTTPError extends Error {
  readonly reason: BrowserHTTPFailureReason
  readonly status?: number
  readonly code?: string
  readonly retryAfter?: number
  readonly incident?: string

  constructor(input: {
    readonly reason: BrowserHTTPFailureReason
    readonly message: string
    readonly status?: number
    readonly code?: string
    readonly retryAfter?: number
    readonly incident?: string
  }) {
    super(input.message)
    this.name = "BrowserHTTPError"
    this.reason = input.reason
    if (input.status !== undefined) this.status = input.status
    if (input.code !== undefined) this.code = input.code
    if (input.retryAfter !== undefined) this.retryAfter = input.retryAfter
    if (input.incident !== undefined) this.incident = input.incident
  }
}

type RequestOptions = {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  readonly body?: unknown
  readonly csrf?: boolean
  readonly idempotencyKey?: string
}

const responseBodyLimit = 2 * 1024 * 1024
const requestTimeout = 15_000
let csrfToken: string | undefined
const authenticationListeners = new Set<() => void>()

const configuredAPIOrigin = (): string => {
  const configured = import.meta.env.VITE_ATAPE_API_ORIGIN
  if (configured === undefined || configured.trim() === "") return ""
  const parsed = new URL(configured)
  if ((parsed.protocol !== "https:" && !(import.meta.env.DEV && parsed.protocol === "http:")) ||
    parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" ||
    parsed.search !== "" || parsed.hash !== "") {
    throw new Error("VITE_ATAPE_API_ORIGIN must be an HTTPS origin (HTTP loopback is development-only).")
  }
  if (parsed.protocol === "http:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "[::1]") {
    throw new Error("VITE_ATAPE_API_ORIGIN HTTP is restricted to loopback development.")
  }
  return parsed.origin
}

const apiOrigin = configuredAPIOrigin()

export const apiURL = (path: string): string => {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("ATape API paths must be absolute local paths.")
  }
  return apiOrigin === "" ? path : apiOrigin + path
}

export const setBrowserCSRFToken = (token: string | undefined): void => {
  csrfToken = token
}

export const clearBrowserAuthentication = (): void => {
  csrfToken = undefined
}

export const subscribeAuthenticationInvalidation = (listener: () => void): (() => void) => {
  authenticationListeners.add(listener)
  return () => authenticationListeners.delete(listener)
}

const invalidateAuthentication = (): void => {
  // A missing session during initial bootstrap is a normal signed-out state.
  // Only fan out an invalidation when this tab previously held authenticated
  // session state; this also prevents a 401 bootstrap/reload loop.
  if (csrfToken === undefined) return
  clearBrowserAuthentication()
  for (const listener of authenticationListeners) listener()
}

const readResponseBody = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get("Content-Length"))
  if (Number.isFinite(declared) && declared > responseBodyLimit) {
    throw new BrowserHTTPError({ reason: "decode", message: "The ATape response was unexpectedly large." })
  }
  const chunks: Uint8Array[] = []
  let byteLength = 0
  if (response.body !== null) {
    const reader = response.body.getReader()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        byteLength += next.value.byteLength
        if (byteLength > responseBodyLimit) {
          await reader.cancel()
          throw new BrowserHTTPError({ reason: "decode", message: "The ATape response was unexpectedly large." })
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new BrowserHTTPError({ reason: "decode", message: "ATape returned malformed UTF-8." })
  }
  if (text === "") return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BrowserHTTPError({ reason: "decode", message: "ATape returned malformed JSON." })
  }
}

const positiveIntegerHeader = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

const problemFrom = (response: Response, payload: unknown): BrowserHTTPError => {
  const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {}
  const code = typeof record.code === "string" && record.code.length <= 100 ? record.code : undefined
  const detail = typeof record.detail === "string" && record.detail.length <= 1_000
    ? record.detail
    : `ATape returned ${response.status}.`
  const bodyRequestId = typeof record.requestId === "string" && record.requestId.length <= 200
    ? record.requestId
    : undefined
  const headerRequestId = response.headers.get("X-Request-ID")
  const requestId = bodyRequestId ?? (headerRequestId !== null && headerRequestId.length <= 200
    ? headerRequestId
    : undefined)
  const retryAfter = positiveIntegerHeader(response.headers.get("Retry-After"))
  return new BrowserHTTPError({
    reason: "http",
    message: detail,
    status: response.status,
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined ? {} : { incident: requestId }),
    ...(retryAfter === undefined ? {} : { retryAfter })
  })
}

export const browserRequest = (path: string, options: RequestOptions = {}): Effect.Effect<unknown, BrowserHTTPError> =>
  Effect.tryPromise({
    try: async (interruption) => {
      const method = options.method ?? "GET"
      const headers = new Headers({ Accept: "application/json" })
      if (options.body !== undefined) headers.set("Content-Type", "application/json")
      if (options.csrf) {
        if (csrfToken === undefined) {
          throw new BrowserHTTPError({
            reason: "http",
            status: 401,
            code: "unauthenticated",
            message: "Your browser session needs to be restored."
          })
        }
        headers.set("X-ATape-CSRF", csrfToken)
      }
      if (options.idempotencyKey !== undefined) headers.set("Idempotency-Key", options.idempotencyKey)

      const response = await fetch(apiURL(path), {
        method,
        headers,
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([interruption, AbortSignal.timeout(requestTimeout)]),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
      })
      let payload: unknown
      try {
        payload = await readResponseBody(response)
      } catch (error) {
        // An unreadable 401 cannot be proven to be the recoverable
        // fresh-authentication case, so fail closed and restore the Session.
        if (response.status === 401) invalidateAuthentication()
        throw error
      }
      if (!response.ok) {
        const problem = problemFrom(response, payload)
        if ((response.status === 401 && problem.code !== "fresh_authentication_required") ||
          problem.code === "csrf_rejected") {
          invalidateAuthentication()
        }
        throw problem
      }
      return payload
    },
    catch: (cause) => cause instanceof BrowserHTTPError
      ? cause
      : new BrowserHTTPError({
        reason: "transport",
        message: cause instanceof Error && cause.name === "TimeoutError"
          ? "The ATape server did not respond in time."
          : "The ATape server is unavailable."
      })
  })

export const newIdempotencyKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}
