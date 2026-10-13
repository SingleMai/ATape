import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { SessionAnalytics, SessionAnalyticsActivity, SessionAnalyticsTokenActivity } from "./sessionAnalytics.ts"

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
const fileActivity = { callsWithActivity: 0, callsWithoutActivity: 1, uniquePaths: 0, readCalls: 0, editCalls: 0, searchCalls: 0, paths: [] }
const counter = { knownSubtotal: null, reportedSamples: 0, missingSamples: 1, overflowed: false }
const tokens = { total: counter, input: counter, output: counter, cacheRead: counter, cacheWrite: counter }
const emptyCounter = { ...counter, missingSamples: 0 }
const emptyTokens = { total: emptyCounter, input: emptyCounter, output: emptyCounter, cacheRead: emptyCounter, cacheWrite: emptyCounter }
const cache = { eligibleSamples: 0, missingSamples: 1, inputTokens: null, readTokens: null, writeTokens: null,
  uncachedTokens: null, readShare: null, writeShare: null, uncachedShare: null }
const modelKey = `model:${"b".repeat(64)}`
const tokenActivity = { scopeThreadId: null, scopeModelKey: null, samples: 1, timedSamples: 1, untimedSamples: 0,
  firstRecordedAt: "2026-10-13T00:00:00Z", lastRecordedAt: "2026-10-13T00:00:00Z", tokens, untimedTokens: emptyTokens, cache,
  models: [{ key: modelKey, model: null, samples: 1, tokens, cache }], threads: [{ id: "root", samples: 1, tokens, cache }],
  buckets: [{ from: "2026-10-13T00:00:00Z", to: "2026-10-13T00:00:00Z", includesEnd: true,
    samples: 1, tokens, records: 0, range: "opaque-token-point" }] }
const decode = Schema.decodeUnknownSync(SessionAnalytics)

describe("Session Analytics versioned representation", () => {
  it("retains old versions without inventing activity or clock quality", () => {
    const v1 = decode({ ...common, analyticsVersion: 1 })
    const v2 = decode({ ...common, analyticsVersion: 2, capabilities })
    for (const value of [v1, v2]) {
      expect("activity" in value).toBe(false)
      expect("tokenActivity" in value).toBe(false)
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
  it("requires stable v4 row keys, nullable closed identities and explicit coverage", () => {
    const tool = { key: `tool:${"a".repeat(64)}`, identity: { type: "tool", name: "exec_command" },
      name: "exec_command", kind: "execute", calls: 1, completed: 0, failed: 0, pending: 0, inProgress: 0, unknown: 1 }
    const v4 = { ...common, analyticsVersion: 4, capabilities, activity, fileActivity,
      summary: { ...common.summary, toolCalls: 1, identifiedToolCalls: 1, unidentifiedToolCalls: 0 }, tools: [tool],
      evidence: { items: common.evidence.items.map(item => ({ ...item, clockQuality: "unknown" })) } }
    expect(decode(v4)).toEqual(v4)
    expect(decode({ ...v4, tools: [{ ...tool, identity: null, name: "unknown" }] })).toMatchObject({ tools: [{ identity: null }] })
    const { key: _key, ...missingKey } = tool
    const { identity: _identity, ...missingIdentity } = tool
    const { unidentifiedToolCalls: _count, ...missingCoverage } = v4.summary
    const { fileActivity: _fileActivity, ...missingFiles } = v4
    for (const malformed of [
      { ...v4, tools: [missingKey] }, { ...v4, tools: [missingIdentity] }, { ...v4, summary: missingCoverage },
      { ...v4, tools: [{ ...tool, key: "exec_command" }] },
      { ...v4, tools: [{ ...tool, identity: { ...tool.identity, command: "pnpm check" } }] },
      { ...v4, evidence: common.evidence }, missingFiles,
      { ...v4, fileActivity: { ...fileActivity, paths: [{ key: "raw-path", path: "src/a.ts", calls: 1, readCalls: 1, editCalls: 0, searchCalls: 0 }] } },
      { ...v4, fileActivity: { ...fileActivity, callsWithoutActivity: -1 } }
    ]) expect(() => decode(malformed)).toThrow()
  })
  it("requires the complete v5 token report while keeping missing counters and empty original intervals explicit", () => {
    const v5 = { ...common, analyticsVersion: 5, capabilities, activity, fileActivity, tokenActivity,
      summary: { ...common.summary, identifiedToolCalls: 0, unidentifiedToolCalls: 0 },
      evidence: { items: common.evidence.items.map(item => ({ ...item, clockQuality: "unknown" })) } }
    expect(decode(v5)).toEqual(v5)
    const { tokenActivity: _tokens, ...missing } = v5
    expect(() => decode(missing)).toThrow()
    expect(() => decode({ ...v5, tokenActivity: { samples: 0 } })).toThrow()
    const v4 = decode({ ...missing, analyticsVersion: 4 })
    expect("tokenActivity" in v4).toBe(false)
    expect(Schema.decodeUnknownSync(SessionAnalyticsTokenActivity)({ ...tokenActivity, scopeModelKey: modelKey,
      tokens: { ...tokens, input: { knownSubtotal: 0, reportedSamples: 1, missingSamples: 0, overflowed: false } },
      cache: { ...cache, eligibleSamples: 1, missingSamples: 0, inputTokens: 0, readTokens: 0, writeTokens: 0, uncachedTokens: 0 }
    })).toMatchObject({ scopeModelKey: modelKey, tokens: { input: { knownSubtotal: 0 } }, cache: { readShare: null } })
  })
  it.each([
    { samples: -1 }, { timedSamples: 1.5 }, { untimedSamples: Infinity }, { scopeModelKey: "raw-model" },
    { tokens: { ...tokens, input: { ...counter, knownSubtotal: Number.MAX_SAFE_INTEGER + 1 } } },
    { tokens: { ...tokens, total: { ...counter, missingSamples: -1 } } },
    { tokens: { ...tokens, cacheWrite: { ...counter, overflowed: "false" } } },
    { cache: { ...cache, eligibleSamples: -1 } }, { cache: { ...cache, inputTokens: -1 } },
    { cache: { ...cache, readShare: 1.01 } }, { cache: { ...cache, writeShare: -0.01 } },
    { cache: { ...cache, uncachedShare: Infinity } },
    { models: [{ ...tokenActivity.models[0], key: `model:${"B".repeat(64)}` }] },
    { models: Array.from({ length: 1001 }, () => tokenActivity.models[0]) },
    { threads: Array.from({ length: 5001 }, () => tokenActivity.threads[0]) },
    { buckets: Array.from({ length: 61 }, () => tokenActivity.buckets[0]) },
    { buckets: [{ ...tokenActivity.buckets[0], range: "界".repeat(171) }] },
    { buckets: [{ ...tokenActivity.buckets[0], records: -1 }] }
  ])("rejects token activity beyond its transport bounds case %#", invalid => {
    expect(() => Schema.decodeUnknownSync(SessionAnalyticsTokenActivity)({ ...tokenActivity, ...invalid })).toThrow()
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
