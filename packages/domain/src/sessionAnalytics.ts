import { Schema } from "effect"

export const SessionAnalyticsMetric = Schema.Literals(["tools", "failed_tools", "unknown_tools", "user_inputs", "thoughts", "threads", "mcp_tools", "skills", "records"])
export type SessionAnalyticsMetric = typeof SessionAnalyticsMetric.Type

const Count = Schema.Number
const NullableCount = Schema.NullOr(Count)
const ActivityCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const ActivityRange = Schema.String.check(Schema.isMinLength(1),
  Schema.makeFilter(value => new TextEncoder().encode(value).byteLength <= 512))
export const SessionAnalyticsClockQuality = Schema.Literals(["recorded", "unknown", "legacy"])
export type SessionAnalyticsClockQuality = typeof SessionAnalyticsClockQuality.Type
export const SessionAnalyticsActivity = Schema.Struct({
  scopeThreadId: Schema.NullOr(Schema.String),
  eventCount: ActivityCount, recordedTimeEvents: ActivityCount, unknownTimeEvents: ActivityCount, legacyTimeEvents: ActivityCount,
  firstRecordedAt: Schema.NullOr(Schema.String), lastRecordedAt: Schema.NullOr(Schema.String),
  recordSpanMilliseconds: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))),
  backwardClockTransitions: ActivityCount,
  buckets: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String, includesEnd: Schema.Boolean,
    records: ActivityCount, messages: ActivityCount, thoughts: ActivityCount, toolCalls: ActivityCount, range: ActivityRange
  })).check(Schema.isMaxLength(60)),
  unplacedRange: Schema.NullOr(ActivityRange)
})
export type SessionAnalyticsActivity = typeof SessionAnalyticsActivity.Type
export const SessionAnalyticsTokens = Schema.Struct({
  total: NullableCount, input: NullableCount, output: NullableCount,
  cacheRead: NullableCount, cacheWrite: NullableCount,
  recordedSamples: Count, incompleteSamples: Count
})
export type SessionAnalyticsTokens = typeof SessionAnalyticsTokens.Type

const AnalyticsFields = {
  snapshot: Schema.String,
  head: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  captureStatus: Schema.String,
  summary: Schema.Struct({
    rootUserInputs: Count, messageFragments: Count, thoughtFragments: Count,
    toolCalls: Count, childThreads: Count, knownTimeEvents: Count,
    unknownTimeEvents: Count, unlinkedToolEvents: Count
  }),
  tools: Schema.Array(Schema.Struct({
    name: Schema.String, kind: Schema.String, calls: Count,
    completed: Count, failed: Count, pending: Count, inProgress: Count, unknown: Count
  })),
  threads: Schema.Array(Schema.Struct({
    id: Schema.String, label: Schema.String, parentThreadId: Schema.optionalKey(Schema.String),
    captureStatus: Schema.String, eventCount: Count, toolCalls: Count, tokens: SessionAnalyticsTokens
  })),
  usage: Schema.Struct({
    samples: Count, tokens: SessionAnalyticsTokens,
    models: Schema.Array(Schema.Struct({ model: Schema.String, samples: Count, tokens: SessionAnalyticsTokens }))
  }),
  evidence: Schema.Struct({
    items: Schema.Array(Schema.Struct({
      eventId: Schema.String, threadId: Schema.String, kind: Schema.String,
      label: Schema.String, occurredAt: Schema.NullOr(Schema.String)
    })),
    nextCursor: Schema.optionalKey(Schema.String)
  })
}
const Outcomes = {
  calls: Count, completed: Count, failed: Count, pending: Count, inProgress: Count, unknown: Count
}
export const SessionAnalyticsCapabilities = Schema.Struct({
  mcpCalls: Count,
  skillCalls: Count,
  unclassifiedCalls: Count,
  mcp: Schema.Array(Schema.Struct({ server: Schema.String, name: Schema.String, ...Outcomes })),
  skills: Schema.Array(Schema.Struct({ name: Schema.String, ...Outcomes }))
})
export type SessionAnalyticsCapabilities = typeof SessionAnalyticsCapabilities.Type

// A v1 Server cannot supply this report. A v2 Server must supply it, including
// explicit empty arrays and zero counts; omission must not become invented zero.
export const SessionAnalytics = Schema.Union([
  Schema.Struct({ analyticsVersion: Schema.Literal(1), ...AnalyticsFields }),
  Schema.Struct({ analyticsVersion: Schema.Literal(2), ...AnalyticsFields, capabilities: SessionAnalyticsCapabilities }),
  Schema.Struct({ analyticsVersion: Schema.Literal(3), ...AnalyticsFields, capabilities: SessionAnalyticsCapabilities,
    activity: SessionAnalyticsActivity,
    evidence: Schema.Struct({
      items: Schema.Array(Schema.Struct({ ...AnalyticsFields.evidence.fields.items.value.fields,
        clockQuality: SessionAnalyticsClockQuality })),
      nextCursor: Schema.optionalKey(Schema.String)
    })
  })
])
export type SessionAnalytics = typeof SessionAnalytics.Type

export type SessionAnalyticsQuery = {
  readonly snapshot?: string
  readonly metric?: SessionAnalyticsMetric
  readonly thread?: string
  readonly tool?: string
  readonly capability?: string
  readonly server?: string
  readonly range?: string
  readonly cursor?: string
  readonly limit?: number
}
