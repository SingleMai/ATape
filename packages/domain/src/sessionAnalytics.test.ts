import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { SessionAnalytics, SessionAnalyticsActivity } from "./sessionAnalytics.ts"

const activity = { scopeThreadId: null, eventCount: 2, recordedTimeEvents: 1, unknownTimeEvents: 1, legacyTimeEvents: 0,
  firstRecordedAt: "2026-10-12T00:00:00Z", lastRecordedAt: "2026-10-12T00:00:00Z", recordSpanMilliseconds: 0,
  backwardClockTransitions: 0, buckets: [{ from: "2026-10-12T00:00:00Z", to: "2026-10-12T00:00:00Z", includesEnd: true,
    records: 1, messages: 1, thoughts: 0, toolCalls: 0, range: "opaque-point" }], unplacedRange: "opaque-unplaced" }
const common = { snapshot: "snapshot", sessionId: "session", captureStatus: "healthy",
  summary: { rootUserInputs: 1, messageFragments: 2, thoughtFragments: 0, toolCalls: 0, childThreads: 0,
    knownTimeEvents: 1, unknownTimeEvents: 1, unlinkedToolEvents: 0 }, tools: [], threads: [],
  usage: { samples: 0, models: [], tokens: { total: null, input: null, output: null, cacheRead: null, cacheWrite: null,
    recordedSamples: 0, incompleteSamples: 0 } }, evidence: { items: [{ eventId: "event", threadId: "root", kind: "message",
      label: "Record", occurredAt: null }] } }
const capabilities = { mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 0, mcp: [], skills: [] }
const decode = Schema.decodeUnknownSync(SessionAnalytics)

describe("Session Analytics versioned representation", () => {
  it("retains old versions without inventing activity or clock quality", () => {
    const v1 = decode({ ...common, analyticsVersion: 1 })
    const v2 = decode({ ...common, analyticsVersion: 2, capabilities })
    for (const value of [v1, v2]) {
      expect("activity" in value).toBe(false)
      expect("clockQuality" in value.evidence.items[0]!).toBe(false)
    }
  })
  it("requires explicit activity and clock quality in v3", () => {
    const v3 = { ...common, analyticsVersion: 3, capabilities, activity,
      evidence: { items: common.evidence.items.map(item => ({ ...item, clockQuality: "unknown" })) } }
    expect(decode(v3)).toEqual(v3)
    const { activity: _activity, ...missing } = v3
    expect(() => decode(missing)).toThrow()
    expect(() => decode({ ...v3, evidence: common.evidence })).toThrow()
    expect(() => decode({ ...v3, evidence: { items: [{ ...v3.evidence.items[0], clockQuality: "verified" }] } })).toThrow()
  })
  it("preserves zero point spans and null all-unplaced spans", () => {
    expect(Schema.decodeUnknownSync(SessionAnalyticsActivity)(activity).recordSpanMilliseconds).toBe(0)
    const unplaced = { ...activity, recordedTimeEvents: 0, unknownTimeEvents: 2,
      firstRecordedAt: null, lastRecordedAt: null, recordSpanMilliseconds: null, buckets: [] }
    expect(Schema.decodeUnknownSync(SessionAnalyticsActivity)(unplaced)).toEqual(unplaced)
  })
  it.each([
    { recordSpanMilliseconds: -1 }, { recordSpanMilliseconds: Infinity }, { unknownTimeEvents: -1 },
    { eventCount: 1.5 }, { buckets: Array.from({ length: 61 }, () => activity.buckets[0]) },
    { unplacedRange: "界".repeat(171) }
  ])("rejects activity beyond its transport bounds %j", invalid => {
    expect(() => Schema.decodeUnknownSync(SessionAnalyticsActivity)({ ...activity, ...invalid })).toThrow()
  })
})
