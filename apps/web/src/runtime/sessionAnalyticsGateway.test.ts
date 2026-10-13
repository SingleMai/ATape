import { readSessionAnalytics } from "@atape/application"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { activityFixture, analyticsFixture, capabilitiesFixture, executeToolKey, fileActivityFixture, sourceFileKey, stableToolsFixture } from "../../test/sessionAnalyticsFixture"
import { BrowserSessionAnalyticsGatewayLayer } from "./sessionAnalyticsGateway"
import { tokenActivityFixture, tokenModelKey, tokenUnknownModelKey } from "../../test/sessionTokenActivityFixture"

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
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers)
    expect(headers.get("Accept")).toBe("application/vnd.atape.session-analytics.v5+json, application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json")
    expect(headers.has("ATape-Accept-Analytics-Version")).toBe(false)
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
  it("reads v3 opaque range evidence with required activity and clock qualities", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(activityFixture)))
    vi.stubGlobal("fetch", fetchMock)
    const query = { metric: "records" as const, range: "opaque+=range", snapshot: "snapshot-one", cursor: "record-page", limit: 4 }
    const report = await run(readSessionAnalytics("session-reader", query))
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://localhost")
    expect(Object.fromEntries(url.searchParams)).toEqual({ metric: "records", range: "opaque+=range", snapshot: "snapshot-one", cursor: "record-page", limit: "4" })
    expect(report).toEqual(activityFixture)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it("decodes v4 identity groups and sends the opaque row key rather than a command title", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(stableToolsFixture)))
    vi.stubGlobal("fetch", fetchMock)
    const result = await run(readSessionAnalytics("session-reader", { snapshot: "snapshot-one", metric: "tools", tool: executeToolKey }))
    expect(result).toEqual(stableToolsFixture)
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://localhost")
    expect(url.searchParams.get("tool")).toBe(executeToolKey)
    expect(url.searchParams.get("tool")).not.toBe("Run pnpm check")
  })
  it("encodes the AND-bound file key and operation with snapshot, Thread and continuation", async () => {
    const report = { ...fileActivityFixture, activity: { ...fileActivityFixture.activity, scopeThreadId: "child/one" } }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(report)))
    vi.stubGlobal("fetch", fetchMock)
    const query = { metric: "files" as const, file: sourceFileKey, operation: "edit" as const,
      snapshot: "snapshot-one", thread: "child/one", cursor: "next+=", limit: 4 }
    expect(await run(readSessionAnalytics("session-reader", query))).toEqual(report)
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://localhost")
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...query, limit: "4" })
    expect(url.searchParams.get("file")).not.toBe("/work/src/app.ts")
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("Accept"))
      .toBe("application/vnd.atape.session-analytics.v5+json, application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json")
  })
  it("negotiates v5 and transports model and Token interval keys without converting them into Event identity", async () => {
    const report = { ...tokenActivityFixture, snapshot: "snapshot-one", activity: { ...tokenActivityFixture.activity, scopeThreadId: "child/one" }, tokenActivity: { ...tokenActivityFixture.tokenActivity,
      scopeThreadId: "child/one", scopeModelKey: tokenModelKey } }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(report)))
    vi.stubGlobal("fetch", fetchMock)
    const query = { metric: "token_records" as const, tokenRange: "opaque+=token-range", model: tokenModelKey,
      snapshot: "snapshot-one", thread: "child/one", cursor: "next+=", limit: 4 }
    expect(await run(readSessionAnalytics("session-reader", query))).toEqual(report)
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://localhost")
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...query, limit: "4" })
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("Accept"))
      .toBe("application/vnd.atape.session-analytics.v5+json, application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json")
    expect(url.searchParams.has("at")).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it("requires v5 Token coverage and accepts null counters and an explicitly missing model", async () => {
    const { tokenActivity: _activity, ...missing } = tokenActivityFixture
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...tokenActivityFixture, tokenActivity: { ...tokenActivityFixture.tokenActivity, scopeModelKey: tokenUnknownModelKey } })))
      .mockResolvedValueOnce(new Response(JSON.stringify(missing)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...tokenActivityFixture, tokenActivity: {
        ...tokenActivityFixture.tokenActivity, cache: { ...tokenActivityFixture.tokenActivity.cache, readShare: 2 } } })))
    vi.stubGlobal("fetch", fetchMock)
    const result = await run(readSessionAnalytics("session-reader", { model: tokenUnknownModelKey }))
    if (result.analyticsVersion === 5) {
      expect(result.tokenActivity.models[1]).toMatchObject({ model: null, tokens: { total: { knownSubtotal: null, reportedSamples: 0, missingSamples: 1 } } })
    }
    expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ reason: "decode" })
    expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ reason: "decode" })
  })
  it("requires the v4 file report, including explicit empty coverage and returned path keys", async () => {
    const { fileActivity: _fileActivity, ...missingReport } = fileActivityFixture
    const { key: _key, ...missingKey } = fileActivityFixture.fileActivity.paths[0]!
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(missingReport)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...fileActivityFixture,
        fileActivity: { ...fileActivityFixture.fileActivity, paths: [missingKey] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...fileActivityFixture,
        fileActivity: { ...fileActivityFixture.fileActivity, paths: [{ ...fileActivityFixture.fileActivity.paths[0], key: "/work/src/app.ts" }] } }))))
    for (let index = 0; index < 3; index++) {
      expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ reason: "decode" })
    }
  })
  it("rejects v4 rows or coverage that omit required identity facts", async () => {
    const { identity: _identity, ...missingIdentity } = stableToolsFixture.tools[0]!
    const { identifiedToolCalls: _identified, ...missingCoverage } = stableToolsFixture.summary
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...stableToolsFixture, tools: [missingIdentity] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...stableToolsFixture, summary: missingCoverage }))))
    expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ reason: "decode" })
    expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ reason: "decode" })
  })
  it("rejects a v3 representation missing its required activity or clock quality", async () => {
    const { activity: _activity, ...missing } = activityFixture
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(missing)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...activityFixture, evidence: analyticsFixture.evidence }))))
    expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ reason: "decode" })
    expect(await run(readSessionAnalytics("session-reader").pipe(Effect.flip))).toMatchObject({ reason: "decode" })
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
