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
