import type { SessionAnalytics } from "@atape/domain"

export const analyticsFixture: SessionAnalytics = {
  snapshot: "snapshot-one", head: "head-one", analyticsVersion: 1, sessionId: "session-reader", captureStatus: "partial",
  summary: { rootUserInputs: 2, messageFragments: 6, thoughtFragments: 3, toolCalls: 2, childThreads: 1,
    knownTimeEvents: 4, unknownTimeEvents: 8, unlinkedToolEvents: 1 },
  tools: [{ name: "Read file", kind: "read", calls: 2, completed: 1, failed: 1, pending: 0, inProgress: 0, unknown: 0 }],
  threads: [
    { id: "root", label: "Root", captureStatus: "partial", eventCount: 10, toolCalls: 2,
      tokens: { total: null, input: 10, output: null, cacheRead: 0, cacheWrite: null, recordedSamples: 1, incompleteSamples: 1 } },
    { id: "child", label: "Captured child", parentThreadId: "root", captureStatus: "complete", eventCount: 2, toolCalls: 0,
      tokens: { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, recordedSamples: 0, incompleteSamples: 0 } }
  ],
  usage: { samples: 1,
    tokens: { total: null, input: 10, output: null, cacheRead: 0, cacheWrite: null, recordedSamples: 1, incompleteSamples: 1 },
    models: [{ model: "test-model", samples: 1,
      tokens: { total: null, input: 10, output: null, cacheRead: 0, cacheWrite: null, recordedSamples: 1, incompleteSamples: 1 } }] },
  evidence: { items: [{ eventId: "tool-1", threadId: "root", kind: "tool_call", label: "Read failing file", occurredAt: null }], nextCursor: "page-two" }
}


export const capabilitiesFixture: SessionAnalytics = {
  ...analyticsFixture, analyticsVersion: 2,
  summary: { ...analyticsFixture.summary, toolCalls: 5 },
  capabilities: {
    mcpCalls: 2, skillCalls: 1, unclassifiedCalls: 2,
    mcp: [
      { server: "docs", name: "lookup", calls: 1, completed: 1, failed: 0, pending: 0, inProgress: 0, unknown: 0 },
      { server: "repo", name: "lookup", calls: 1, completed: 0, failed: 1, pending: 0, inProgress: 0, unknown: 0 }
    ],
    skills: [{ name: "review-code", calls: 1, completed: 1, failed: 0, pending: 0, inProgress: 0, unknown: 0 }]
  }
}

export const activityFixture: Extract<SessionAnalytics, { analyticsVersion: 3 }> = {
  ...capabilitiesFixture, analyticsVersion: 3,
  activity: { scopeThreadId: null, eventCount: 12, recordedTimeEvents: 6, unknownTimeEvents: 4, legacyTimeEvents: 2,
    firstRecordedAt: "2026-10-12T00:00:00Z", lastRecordedAt: "2026-10-12T00:02:00Z", recordSpanMilliseconds: 120_000,
    backwardClockTransitions: 1,
    buckets: [
      { from: "2026-10-12T00:00:00Z", to: "2026-10-12T00:01:00Z", includesEnd: false,
        records: 4, messages: 2, thoughts: 1, toolCalls: 1, range: "opaque-first-bucket" },
      { from: "2026-10-12T00:01:00Z", to: "2026-10-12T00:02:00Z", includesEnd: true,
        records: 2, messages: 1, thoughts: 1, toolCalls: 0, range: "opaque-final-bucket" }
    ], unplacedRange: "opaque-unplaced" },
  evidence: { items: [
    { eventId: "recorded-event", threadId: "root", kind: "message", label: "Recorded event",
      occurredAt: "2026-10-12T00:00:00Z", clockQuality: "recorded" },
    { eventId: "unknown-event", threadId: "child", kind: "message", label: "Unknown event", occurredAt: null, clockQuality: "unknown" },
    { eventId: "legacy-event", threadId: "root", kind: "message", label: "Legacy event", occurredAt: "1970-01-01T00:00:00Z", clockQuality: "legacy" }
  ], nextCursor: "opaque-record-page" }
}

export const executeToolKey = `tool:${"a".repeat(64)}`
export const unknownToolKey = `tool:${"b".repeat(64)}`
export const stableToolsFixture: Extract<SessionAnalytics, { analyticsVersion: 4 }> = {
  ...activityFixture, analyticsVersion: 4,
  summary: { ...activityFixture.summary, toolCalls: 3, identifiedToolCalls: 2, unidentifiedToolCalls: 1 },
  fileActivity: { callsWithActivity: 0, callsWithoutActivity: 3, uniquePaths: 0, readCalls: 0, editCalls: 0, searchCalls: 0, paths: [] },
  capabilities: { mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 3, mcp: [], skills: [] },
  threads: activityFixture.threads.map(thread => ({ ...thread, toolCalls: thread.id === "root" ? 2 : 1 })),
  tools: [
    { key: executeToolKey, identity: { type: "tool", name: "exec_command" }, name: "exec_command", kind: "execute",
      calls: 2, completed: 0, failed: 1, pending: 0, inProgress: 0, unknown: 1 },
    { key: unknownToolKey, identity: null, name: "unknown", kind: "read", calls: 1,
      completed: 0, failed: 0, pending: 1, inProgress: 0, unknown: 0 }
  ],
  evidence: { items: [
    { eventId: "tool-1", threadId: "root", kind: "tool_call", label: "Run pnpm check", occurredAt: null, clockQuality: "unknown" },
    { eventId: "tool-2", threadId: "child", kind: "tool_result", label: "Run rg --files", occurredAt: "2026-10-12T00:00:00Z", clockQuality: "recorded" }
  ], nextCursor: "stable-tools-next" }
}

export const literalUnknownToolFixture = (identityType: "tool" | "skill"): Extract<SessionAnalytics, { analyticsVersion: 4 }> => ({
  ...stableToolsFixture,
  summary: { ...stableToolsFixture.summary, toolCalls: 2, identifiedToolCalls: 1, unidentifiedToolCalls: 1 },
  fileActivity: { ...stableToolsFixture.fileActivity, callsWithoutActivity: 2 },
  threads: stableToolsFixture.threads.map(thread => ({ ...thread, toolCalls: thread.id === "root" ? 2 : 0 })),
  capabilities: { mcpCalls: 0, skillCalls: identityType === "skill" ? 1 : 0, unclassifiedCalls: identityType === "skill" ? 1 : 2, mcp: [],
    skills: identityType === "skill" ? [{ name: "unknown", calls: 1, completed: 0, failed: 0, pending: 0, inProgress: 0, unknown: 1 }] : [] },
  tools: [
    { ...stableToolsFixture.tools[0]!, name: "unknown", identity: { type: identityType, name: "unknown" },
      calls: 1, completed: 0, failed: 0, pending: 0, inProgress: 0, unknown: 1 },
    { ...stableToolsFixture.tools[1]!, kind: "execute" }
  ],
  evidence: { items: [
    { eventId: "literal-unknown", threadId: "root", kind: "tool_call", label: "Literal unknown native call", occurredAt: null, clockQuality: "unknown" },
    { eventId: "missing-identity", threadId: "root", kind: "tool_call", label: "Call without identity", occurredAt: null, clockQuality: "unknown" }
  ] }
})

export const sourceFileKey = `file:${"c".repeat(64)}`
export const searchScopeKey = `file:${"d".repeat(64)}`
export const fileActivityFixture: Extract<SessionAnalytics, { analyticsVersion: 4 }> = {
  ...stableToolsFixture,
  summary: { ...stableToolsFixture.summary, toolCalls: 5, identifiedToolCalls: 4, unidentifiedToolCalls: 1 },
  threads: stableToolsFixture.threads.map(thread => ({ ...thread, toolCalls: thread.id === "child" ? 2 : 3 })),
  capabilities: { mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 5, mcp: [], skills: [] },
  tools: [{ ...stableToolsFixture.tools[0]!, calls: 4, unknown: 3 }, stableToolsFixture.tools[1]!],
  fileActivity: { callsWithActivity: 3, callsWithoutActivity: 2, uniquePaths: 2, readCalls: 2, editCalls: 1, searchCalls: 1,
    paths: [
      { key: sourceFileKey, path: "/work/src/app.ts", calls: 2, readCalls: 2, editCalls: 1, searchCalls: 0 },
      { key: searchScopeKey, path: "src", calls: 1, readCalls: 0, editCalls: 0, searchCalls: 1 }
    ] },
  evidence: { items: [
    { eventId: "file-read", threadId: "child", kind: "tool_call", label: "Read source file", occurredAt: null, clockQuality: "unknown" },
    { eventId: "file-edit", threadId: "child", kind: "tool_result", label: "Failed file modification", occurredAt: null, clockQuality: "unknown" },
    { eventId: "file-search", threadId: "root", kind: "tool_call", label: "Search source scope", occurredAt: null, clockQuality: "unknown" }
  ], nextCursor: "file-evidence-next" }
}
