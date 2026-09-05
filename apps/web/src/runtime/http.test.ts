import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  browserRequest,
  clearBrowserAuthentication,
  newIdempotencyKey,
  setBrowserCSRFToken,
  subscribeAuthenticationInvalidation
} from "./http.ts"

const problem = (status: number, code: string) => new Response(JSON.stringify({
  type: `https://atape.dev/problems/v1/${code}`,
  title: code,
  status,
  code,
  detail: code,
  instance: "urn:atape:request:test",
  requestId: "request-test"
}), {
  status,
  headers: { "Content-Type": "application/problem+json" }
})

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)

describe("browser HTTP Adapter", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    clearBrowserAuthentication()
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("applies the browser credential, redirect, CSRF, and idempotency contract", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    setBrowserCSRFToken("csrf-secret")

    await run(browserRequest("/api/v1/teams", {
      method: "POST",
      body: { slug: "team-a" },
      csrf: true,
      idempotencyKey: "AAAAAAAAAAAAAAAAAAAAAA"
    }))

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(url).toBe("/api/v1/teams")
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      body: JSON.stringify({ slug: "team-a" })
    })
    expect(headers.get("X-ATape-CSRF")).toBe("csrf-secret")
    expect(headers.get("Idempotency-Key")).toBe("AAAAAAAAAAAAAAAAAAAAAA")
  })

  it("treats initial 401 as signed out without creating a reload loop", async () => {
    let invalidations = 0
    const unsubscribe = subscribeAuthenticationInvalidation(() => invalidations++)
    fetchMock.mockImplementation(async () => problem(401, "unauthenticated"))

    await expect(run(browserRequest("/api/v1/auth/session")))
      .rejects.toMatchObject({ code: "unauthenticated" })
    await expect(run(browserRequest("/api/v1/auth/session")))
      .rejects.toMatchObject({ code: "unauthenticated" })

    expect(invalidations).toBe(0)
    unsubscribe()
  })

  it("invalidates established authentication once when a session ends", async () => {
    let invalidations = 0
    const unsubscribe = subscribeAuthenticationInvalidation(() => invalidations++)
    setBrowserCSRFToken("csrf-secret")
    fetchMock.mockImplementation(async () => problem(401, "session_revoked"))

    await expect(run(browserRequest("/api/v1/workspace")))
      .rejects.toMatchObject({ code: "session_revoked" })
    await expect(run(browserRequest("/api/v1/workspace")))
      .rejects.toMatchObject({ code: "session_revoked" })

    expect(invalidations).toBe(1)
    unsubscribe()
  })

  it("keeps the session proof for a fresh-authentication challenge", async () => {
    let invalidations = 0
    const unsubscribe = subscribeAuthenticationInvalidation(() => invalidations++)
    setBrowserCSRFToken("csrf-secret")
    fetchMock
      .mockResolvedValueOnce(problem(401, "fresh_authentication_required"))
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))

    await expect(run(browserRequest("/api/v1/teams/team-a/join-code/rotations", {
      method: "POST",
      body: {},
      csrf: true
    }))).rejects.toMatchObject({ code: "fresh_authentication_required" })
    await run(browserRequest("/api/v1/auth/federated/reauthentications", {
      method: "POST",
      body: {},
      csrf: true
    }))

    expect(invalidations).toBe(0)
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers)
    expect(headers.get("X-ATape-CSRF")).toBe("csrf-secret")
    unsubscribe()
  })

  it("refreshes an established session after a stale CSRF proof", async () => {
    let invalidations = 0
    const unsubscribe = subscribeAuthenticationInvalidation(() => invalidations++)
    setBrowserCSRFToken("csrf-secret")
    fetchMock.mockResolvedValue(problem(403, "csrf_rejected"))

    await expect(run(browserRequest("/api/v1/teams/team-a/leave", {
      method: "POST",
      body: {},
      csrf: true
    }))).rejects.toMatchObject({ code: "csrf_rejected" })

    expect(invalidations).toBe(1)
    unsubscribe()
  })

  it("enforces the response limit while streaming and rejects malformed UTF-8", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }))
    await expect(run(browserRequest("/api/v1/oversized")))
      .rejects.toMatchObject({ reason: "decode" })

    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28]), { status: 200 }))
    await expect(run(browserRequest("/api/v1/malformed")))
      .rejects.toMatchObject({ reason: "decode" })
  })

  it("generates server-compatible 128-bit replay keys", () => {
    const first = newIdempotencyKey()
    const second = newIdempotencyKey()
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(second).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(second).not.toBe(first)
  })
})
