import type { SessionAnalytics, SessionAnalyticsQuery } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { canFilterSessionAnalyticsTool, readSessionAnalytics, SessionAnalyticsGateway } from "./sessionAnalytics"

const value: SessionAnalytics = {
  snapshot: "one", analyticsVersion: 1, sessionId: "session", captureStatus: "complete",
  summary: { rootUserInputs: 0, messageFragments: 0, thoughtFragments: 0, toolCalls: 0, childThreads: 0,
    knownTimeEvents: 0, unknownTimeEvents: 0, unlinkedToolEvents: 0 }, tools: [], threads: [],
  usage: { samples: 0, tokens: { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, recordedSamples: 0, incompleteSamples: 0 }, models: [] },
  evidence: { items: [], nextCursor: "next" }
}
const provide = (result = value) => Layer.succeed(SessionAnalyticsGateway, SessionAnalyticsGateway.of({ read: () => Effect.succeed(result) }))

describe("SessionAnalytics Module", () => {
  it("offers tool filters only within the wire UTF-8 byte bound", () => {
    expect(canFilterSessionAnalyticsTool("a".repeat(500))).toBe(true)
    expect(canFilterSessionAnalyticsTool("a".repeat(501))).toBe(false)
    expect(canFilterSessionAnalyticsTool("界".repeat(166))).toBe(true)
    expect(canFilterSessionAnalyticsTool("界".repeat(167))).toBe(false)
  })
  it("reads through the remote Interface with a snapshot-bound evidence query", async () => {
    const query: SessionAnalyticsQuery = { snapshot: "one", metric: "failed_tools", thread: "root", tool: "Read", cursor: "next", limit: 20 }
    const layer = Layer.succeed(SessionAnalyticsGateway, SessionAnalyticsGateway.of({ read: (id, request) => {
      expect(id).toBe("session"); expect(request).toEqual(query); return Effect.succeed(value)
    } }))
    expect(await Effect.runPromise(readSessionAnalytics("session", query).pipe(Effect.provide(layer)))).toEqual(value)
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
})
