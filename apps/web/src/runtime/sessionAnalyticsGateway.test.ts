import { readSessionAnalytics } from "@atape/application"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { analyticsFixture, capabilitiesFixture } from "../../test/sessionAnalyticsFixture"
import { BrowserSessionAnalyticsGatewayLayer } from "./sessionAnalyticsGateway"

const run = <A, E>(effect: Effect.Effect<A, E, import("@atape/application").SessionAnalyticsGateway>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BrowserSessionAnalyticsGatewayLayer)))

describe("Session analytics browser Adapter", () => {
  afterEach(() => vi.unstubAllGlobals())
  it("encodes the complete evidence query and decodes nullable counters without replacing zero", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(analyticsFixture)))
    vi.stubGlobal("fetch", fetchMock)
    const result = await run(readSessionAnalytics("session-reader", { snapshot: "snapshot-one", metric: "failed_tools", thread: "child/one", tool: "read & write", cursor: "opaque+=", limit: 20 }))
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://localhost")
    expect(url.pathname).toBe("/api/v1/sessions/session-reader/analytics")
    expect(Object.fromEntries(url.searchParams)).toEqual({ snapshot: "snapshot-one", metric: "failed_tools", thread: "child/one", tool: "read & write", cursor: "opaque+=", limit: "20" })
    expect(result.usage.tokens).toMatchObject({ total: null, cacheRead: 0 })
  })
  it("reads v1 without inventing a capability report, and v2 with a required report", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(analyticsFixture)))
      .mockResolvedValueOnce(new Response(JSON.stringify(capabilitiesFixture)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...analyticsFixture, analyticsVersion: 2 }))))
    const legacy = await run(readSessionAnalytics("session-reader"))
    expect(legacy.analyticsVersion).toBe(1)
    expect("capabilities" in legacy).toBe(false)
    const report = await run(readSessionAnalytics("session-reader", { metric: "mcp_tools", capability: "lookup", server: "docs" }))
    expect(report.analyticsVersion).toBe(2)
    if (report.analyticsVersion === 2) expect(report.capabilities.mcpCalls).toBe(2)
    expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ reason: "decode" })
  })
  it("encodes capability identity without fetching tool inputs or outputs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(capabilitiesFixture)))
    vi.stubGlobal("fetch", fetchMock)
    await run(readSessionAnalytics("session-reader", { snapshot: "snapshot-one", metric: "mcp_tools", capability: "read & write", server: "repo/docs", thread: "root", cursor: "next+=", limit: 20 }))
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://localhost")
    expect(Object.fromEntries(url.searchParams)).toEqual({ snapshot: "snapshot-one", metric: "mcp_tools", capability: "read & write", server: "repo/docs", thread: "root", cursor: "next+=", limit: "20" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it("keeps refresh-required and unavailable problems typed", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "refresh_required", detail: "Changed" }), { status: 409 })))
    expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ status: 409, code: "refresh_required" })
  })
  it("rejects malformed analytics at the remote boundary", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...analyticsFixture, usage: { samples: 1 } }))))
    expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ reason: "decode" })
  })
  it("cancels the in-flight browser request when the caller scope ends", async () => {
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined
      return new Promise((_resolve, reject) => requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }))
    }))
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* Effect.forkScoped(readSessionAnalytics("session-reader").pipe(Effect.provide(BrowserSessionAnalyticsGatewayLayer)))
      yield* Effect.yieldNow
    })))
    expect(requestSignal?.aborted).toBe(true)
  })
})
