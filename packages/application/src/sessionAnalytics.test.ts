import type { SessionAnalytics, SessionAnalyticsQuery } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { canFilterSessionAnalyticsTool, sessionAnalyticsToolSelections, selectSessionAnalyticsEvidence, readSessionAnalytics, SessionAnalyticsGateway } from "./sessionAnalytics"

const value: SessionAnalytics = {
  snapshot: "one", analyticsVersion: 1, sessionId: "session", captureStatus: "complete",
  summary: { rootUserInputs: 0, messageFragments: 0, thoughtFragments: 0, toolCalls: 0, childThreads: 0,
    knownTimeEvents: 0, unknownTimeEvents: 0, unlinkedToolEvents: 0 }, tools: [], threads: [],
  usage: { samples: 0, tokens: { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, recordedSamples: 0, incompleteSamples: 0 }, models: [] },
  evidence: { items: [], nextCursor: "next" }
}
const provide = (result: SessionAnalytics = value) => Layer.succeed(SessionAnalyticsGateway, SessionAnalyticsGateway.of({ read: () => Effect.succeed(result) }))
const activityValue: Extract<SessionAnalytics, { analyticsVersion: 3 }> = { ...value, analyticsVersion: 3,
  capabilities: { mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 0, mcp: [], skills: [] },
  activity: { scopeThreadId: null, eventCount: 1, recordedTimeEvents: 0, unknownTimeEvents: 1, legacyTimeEvents: 0,
    firstRecordedAt: null, lastRecordedAt: null, recordSpanMilliseconds: null, backwardClockTransitions: 0,
    buckets: [], unplacedRange: "opaque-unplaced" }, evidence: { items: [], nextCursor: "next" } }
const emptyFileActivity = { callsWithActivity: 0, callsWithoutActivity: 0, uniquePaths: 0, readCalls: 0, editCalls: 0, searchCalls: 0, paths: [] }
const fileKey = `file:${"a".repeat(64)}`
const fileValue: Extract<SessionAnalytics, { analyticsVersion: 4 }> = { ...activityValue, analyticsVersion: 4,
  summary: { ...value.summary, identifiedToolCalls: 0, unidentifiedToolCalls: 0 }, tools: [], fileActivity: emptyFileActivity }

describe("SessionAnalytics Module", () => {
  it("offers tool filters only within the wire UTF-8 byte bound", () => {
    expect(canFilterSessionAnalyticsTool("a".repeat(500))).toBe(true)
    expect(canFilterSessionAnalyticsTool("a".repeat(501))).toBe(false)
    expect(canFilterSessionAnalyticsTool("界".repeat(166))).toBe(true)
    expect(canFilterSessionAnalyticsTool("界".repeat(167))).toBe(false)
  })
  it("selects v4 identity-and-kind rows by key while retaining legacy label filtering", () => {
    const oldRow = { name: "界".repeat(167), kind: "execute", calls: 1, completed: 0, failed: 0, pending: 0, inProgress: 0, unknown: 1 }
    expect(sessionAnalyticsToolSelections({ ...value, tools: [oldRow] })[0]!.filter).toBeNull()
    const key = `tool:${"a".repeat(64)}`
    const report: SessionAnalytics = { ...activityValue, analyticsVersion: 4,
      fileActivity: { ...emptyFileActivity, callsWithoutActivity: 1 },
      summary: { ...value.summary, toolCalls: 1, identifiedToolCalls: 1, unidentifiedToolCalls: 0 },
      tools: [{ ...oldRow, key, identity: { type: "mcp", server: "界".repeat(166), name: "界".repeat(166) },
        name: `${"界".repeat(166)}/${"界".repeat(166)}` }] }
    expect(sessionAnalyticsToolSelections(report)[0]!.filter).toBe(key)
    expect(selectSessionAnalyticsEvidence({ metric: "unknown_tools", tool: key, thread: "root" }, "one"))
      .toEqual({ metric: "unknown_tools", tool: key, thread: "root", snapshot: "one" })
  })
  it("reads through the remote Interface with a snapshot-bound evidence query", async () => {
    const query: SessionAnalyticsQuery = { snapshot: "one", metric: "failed_tools", thread: "root", tool: "Read", cursor: "next", limit: 20 }
    const layer = Layer.succeed(SessionAnalyticsGateway, SessionAnalyticsGateway.of({ read: (id, request) => {
      expect(id).toBe("session"); expect(request).toEqual(query); return Effect.succeed(value)
    } }))
    expect(await Effect.runPromise(readSessionAnalytics("session", query).pipe(Effect.provide(layer)))).toEqual(value)
  })
  it("reads a snapshot-bound MCP selection through the same remote Interface", async () => {
    const query = selectSessionAnalyticsEvidence({ metric: "mcp_tools", capability: "lookup", server: "docs", thread: "child" }, "one")
    const report: SessionAnalytics = { ...value, analyticsVersion: 2,
      capabilities: { mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 0, mcp: [], skills: [] } }
    const layer = Layer.succeed(SessionAnalyticsGateway, SessionAnalyticsGateway.of({ read: (_id, request) => {
      expect(request).toEqual({ metric: "mcp_tools", snapshot: "one", capability: "lookup", server: "docs", thread: "child" })
      return Effect.succeed(report)
    } }))
    expect(await Effect.runPromise(readSessionAnalytics("session", query).pipe(Effect.provide(layer)))).toEqual(report)
  })
  it("removes incompatible evidence filters while retaining the selected snapshot and thread", () => {
    expect(selectSessionAnalyticsEvidence({ metric: "skills", capability: "review", server: "docs", tool: "Skill", thread: "root" }, "one"))
      .toEqual({ metric: "skills", capability: "review", thread: "root", snapshot: "one" })
    expect(selectSessionAnalyticsEvidence({ metric: "thoughts", capability: "review", server: "docs", tool: "Skill", thread: "root" }, "one"))
      .toEqual({ metric: "thoughts", thread: "root", snapshot: "one" })
  })
  it("keeps an opaque records range only for its unchanged Thread scope and snapshot", () => {
    const selected = selectSessionAnalyticsEvidence({ metric: "records", thread: "child", range: "opaque-child", tool: "Read", capability: "lookup", server: "docs" }, "one")
    expect(selected).toEqual({ metric: "records", thread: "child", range: "opaque-child", snapshot: "one" })
    expect(selectSessionAnalyticsEvidence({ ...selected, thread: "root" }, "one", selected))
      .toEqual({ metric: "records", thread: "root", snapshot: "one" })
    expect(selectSessionAnalyticsEvidence({ ...selected, metric: "tools" }, "one", selected))
      .toEqual({ metric: "tools", thread: "child", snapshot: "one" })
    expect(selectSessionAnalyticsEvidence(selected, "replacement", selected))
      .toEqual({ metric: "records", thread: "child", snapshot: "replacement" })
    expect(selectSessionAnalyticsEvidence({ metric: "records", range: "opaque-unplaced" }))
      .toEqual({ metric: "records" })
  })
  it("reads a range page without changing its opaque binding, page size or whole-Session report", async () => {
    const query: SessionAnalyticsQuery = { metric: "records", range: "opaque-child", thread: "child", snapshot: "one", cursor: "next", limit: 4 }
    const scoped = { ...activityValue, activity: { ...activityValue.activity, scopeThreadId: "child" } }
    const layer = Layer.succeed(SessionAnalyticsGateway, { read: (id, request) => {
      expect(id).toBe("session"); expect(request).toEqual(query); return Effect.succeed(scoped)
    } })
    expect(await Effect.runPromise(readSessionAnalytics("session", query).pipe(Effect.provide(layer)))).toEqual(scoped)
  })
  it.each([3, 4] as const)("rejects a v%s response for a different activity Thread scope", async analyticsVersion => {
    const result: SessionAnalytics = analyticsVersion === 3 ? activityValue : { ...activityValue, analyticsVersion,
      fileActivity: emptyFileActivity,
      summary: { ...value.summary, identifiedToolCalls: 0, unidentifiedToolCalls: 0 }, tools: [] }
    const error = await Effect.runPromise(readSessionAnalytics("session", { thread: "child" }).pipe(Effect.provide(provide(result)), Effect.flip))
    expect(error.reason).toBe("decode")
  })
  it("reads v4 records without losing required activity or opaque range selection", async () => {
    const report: SessionAnalytics = { ...activityValue, analyticsVersion: 4,
      fileActivity: emptyFileActivity,
      summary: { ...value.summary, identifiedToolCalls: 0, unidentifiedToolCalls: 0 }, tools: [] }
    expect(await Effect.runPromise(readSessionAnalytics("session", { metric: "records", snapshot: "one", range: "opaque-unplaced" })
      .pipe(Effect.provide(provide(report))))).toEqual(report)
  })
  it("keeps old reports available without interpreting absent activity as zero", async () => {
    const report = await Effect.runPromise(readSessionAnalytics("session").pipe(Effect.provide(provide())))
    expect(report.analyticsVersion).toBe(1); expect("activity" in report).toBe(false)
    const unsupported = await Effect.runPromise(readSessionAnalytics("session", { metric: "records" }).pipe(Effect.provide(provide()), Effect.flip))
    expect(unsupported.status).toBe(422)
  })
  it("keeps file key and operation together while dropping incompatible filters and continuation", async () => {
    const query = selectSessionAnalyticsEvidence({ metric: "files", file: fileKey, operation: "edit", thread: "child",
      tool: "Read", capability: "lookup", server: "docs", range: "old-range" }, "one")
    expect(query).toEqual({ metric: "files", file: fileKey, operation: "edit", thread: "child", snapshot: "one" })
    expect(selectSessionAnalyticsEvidence({ ...query, metric: "records" }, "one", query))
      .toEqual({ metric: "records", thread: "child", snapshot: "one" })
    expect(selectSessionAnalyticsEvidence({ ...query, metric: "tools" }, "one", query))
      .toEqual({ metric: "tools", thread: "child", snapshot: "one" })
    const scoped = { ...fileValue, activity: { ...fileValue.activity, scopeThreadId: "child" } }
    const page = { ...query, cursor: "file-page", limit: 4 }
    const layer = Layer.succeed(SessionAnalyticsGateway, { read: (_id, request) => {
      expect(request).toEqual(page); return Effect.succeed(scoped)
    } })
    expect(await Effect.runPromise(readSessionAnalytics("session", page).pipe(Effect.provide(layer)))).toEqual(scoped)
  })
  it.each([1, 2, 3] as const)("marks file activity unavailable on a v%s Server instead of inventing an empty report", async analyticsVersion => {
    const report: SessionAnalytics = analyticsVersion === 3 ? activityValue : analyticsVersion === 2 ? { ...value, analyticsVersion,
      capabilities: activityValue.capabilities } : value
    expect(await Effect.runPromise(readSessionAnalytics("session").pipe(Effect.provide(provide(report))))).toEqual(report)
    expect(await Effect.runPromise(readSessionAnalytics("session", { metric: "files", file: fileKey, operation: "read", snapshot: "one" })
      .pipe(Effect.provide(provide(report)), Effect.flip))).toMatchObject({ reason: "http", status: 422 })
  })
  it.each([
    { metric: "tools" as const, file: fileKey }, { metric: "records" as const, operation: "read" as const },
    { metric: "files" as const, file: "/work/src/app.ts" }, { metric: "files" as const, file: `file:${"A".repeat(64)}` },
    { metric: "files" as const, tool: "Read" }, { metric: "files" as const, capability: "lookup" },
    { metric: "files" as const, server: "docs" }, { metric: "files" as const, snapshot: "one", range: "old-range" },
    { metric: "records" as const, snapshot: "one", range: "range", file: fileKey }
  ])("rejects incompatible file selections before remote IO: %j", async query => {
    const layer = Layer.succeed(SessionAnalyticsGateway, { read: () => Effect.die("must not read") })
    expect(await Effect.runPromise(readSessionAnalytics("session", query).pipe(Effect.provide(layer), Effect.flip))).toMatchObject({ status: 422 })
  })
  it.each([1, 2] as const)("refuses v%s evidence as the result of an opaque records range", async analyticsVersion => {
    const report: SessionAnalytics = analyticsVersion === 1 ? value : { ...value, analyticsVersion: 2,
      capabilities: { mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 0, mcp: [], skills: [] } }
    const error = await Effect.runPromise(readSessionAnalytics("session", { metric: "records", range: "opaque-unplaced", snapshot: "one" })
      .pipe(Effect.provide(provide(report)), Effect.flip))
    expect(error).toMatchObject({ reason: "http", status: 422 })
  })
  it("rejects a different session response", async () => {
    const error = await Effect.runPromise(readSessionAnalytics("other").pipe(Effect.provide(provide()), Effect.flip))
    expect(error.reason).toBe("decode")
  })
  it("requires an explicit refresh when the selected snapshot changes", async () => {
    const error = await Effect.runPromise(readSessionAnalytics("session", { snapshot: "older" }).pipe(Effect.provide(provide()), Effect.flip))
    expect(error).toMatchObject({ status: 409, code: "refresh_required" })
  })
  it.each([{ cursor: "next" }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }])("rejects invalid pagination before remote IO: %j", async query => {
    const layer = Layer.succeed(SessionAnalyticsGateway, SessionAnalyticsGateway.of({ read: () => Effect.die("must not read") }))
    const error = await Effect.runPromise(readSessionAnalytics("session", query).pipe(Effect.provide(layer), Effect.flip))
    expect(error.status).toBe(422)
  })
  it.each([
    { metric: "records" as const, range: "opaque" }, { metric: "tools" as const, snapshot: "one", range: "opaque" },
    { metric: "records" as const, snapshot: "one", range: "opaque", tool: "Read" },
    { metric: "records" as const, snapshot: "one", range: "opaque", capability: "lookup" },
    { metric: "records" as const, snapshot: "one", range: "opaque", server: "docs" },
    { metric: "records" as const, snapshot: "one", range: "" }, { metric: "records" as const, snapshot: "one", range: "界".repeat(171) }
  ])("rejects invalid range selection before remote IO: %j", async query => {
    const layer = Layer.succeed(SessionAnalyticsGateway, { read: () => Effect.die("must not read") })
    expect(await Effect.runPromise(readSessionAnalytics("session", query).pipe(Effect.provide(layer), Effect.flip))).toMatchObject({ status: 422 })
  })
})
