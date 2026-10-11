import type { SessionAnalytics, SessionAnalyticsActivity } from "@atape/domain"
import { analyticsFixture } from "./sessionAnalyticsFixture"

export type ActivityAnalytics = Extract<SessionAnalytics, { readonly analyticsVersion: 3 }>
export type ActivityEvidence = ActivityAnalytics["evidence"]["items"][number]
export type ActivityScope = "all" | "root" | "child"
export const activitySnapshot = "activity-snapshot-one"
export const activityHead = "activity-head-one"

const recorded = (eventId: string, threadId: string, label: string, occurredAt: string, kind = "message"): ActivityEvidence =>
  ({ eventId, threadId, kind, label, occurredAt, clockQuality: "recorded" })
const childRecords: ActivityEvidence[] = Array.from({ length: 24 }, (_, index) => recorded(
  `child-${String(index + 1).padStart(2, "0")}`, "child", index === 20 ? "Child tool evidence" : `Child record ${String(index + 1).padStart(2, "0")}`,
  "2026-10-12T08:30:00Z", index === 0 ? "tool_call" : index === 20 ? "tool_result" : "message"))
export const unplacedRecords: ActivityEvidence[] = [
  { eventId: "root-unknown", threadId: "root", kind: "message", label: "Root unknown-clock record", occurredAt: null, clockQuality: "unknown" },
  { eventId: "root-legacy", threadId: "root", kind: "message", label: "Root legacy-clock record", occurredAt: "1970-01-01T00:00:00Z", clockQuality: "legacy" },
  { eventId: "child-unknown", threadId: "child", kind: "message", label: "Child unknown-clock record", occurredAt: null, clockQuality: "unknown" },
  { eventId: "child-legacy", threadId: "child", kind: "message", label: "Child legacy-clock record", occurredAt: "1970-01-01T00:00:00Z", clockQuality: "legacy" }
]
const rootFirst = [
  recorded("root-01", "root", "Root recorded input one", "2026-10-12T08:00:00Z"),
  recorded("root-02", "root", "Root recorded input two", "2026-10-12T08:00:00Z")
]
const childLast = recorded("child-last", "child", "Child final-instant record", "2026-10-12T08:40:00Z", "thought")
const rootLast = [
  recorded("root-thought", "root", "Root recorded thought", "2026-10-12T08:59:00Z", "thought"),
  recorded("root-tool", "root", "Root recorded tool", "2026-10-12T09:00:00Z", "tool_call")
]
export const activityRecords: ActivityEvidence[] = [
  ...rootFirst, ...unplacedRecords.slice(0, 2), ...childRecords, childLast,
  ...unplacedRecords.slice(2), ...rootLast
]
const rangeToken = (scope: ActivityScope, index: number | "unplaced") => `fixture-${scope}-range-${index}`
export const childBucketRange = rangeToken("child", 0)
export const childPageCursor = `fixture-child-page-two-${childBucketRange}`

// These are fixed expected HTTP reports, not an implementation of analytics.
// Each dated fixture interval is exactly one minute (all/root) or ten seconds
// (child). The frozen reports explicitly admit 29 clocks and leave four records
// unplaced; the UI must display these values without deriving them from a page.
const fixedBuckets = (scope: ActivityScope): SessionAnalyticsActivity["buckets"] => {
  const origin = Date.parse(scope === "child" ? "2026-10-12T08:30:00Z" : "2026-10-12T08:00:00Z")
  const width = scope === "child" ? 10000 : 60000
  return Array.from({ length: 60 }, (_, index) => {
    const count = scope === "child" ? index === 0 ? { records: 24, messages: 22, thoughts: 0, toolCalls: 1 }
      : index === 59 ? { records: 1, messages: 0, thoughts: 1, toolCalls: 0 } : undefined
      : index === 0 ? { records: 2, messages: 2, thoughts: 0, toolCalls: 0 }
      : index === 59 ? { records: 2, messages: 0, thoughts: 1, toolCalls: 1 }
      : scope === "all" && index === 30 ? { records: 24, messages: 22, thoughts: 0, toolCalls: 1 }
      : scope === "all" && index === 40 ? { records: 1, messages: 0, thoughts: 1, toolCalls: 0 } : undefined
    return { from: new Date(origin + index * width).toISOString(), to: new Date(origin + (index + 1) * width).toISOString(),
      includesEnd: index === 59, range: rangeToken(scope, index), ...(count ?? { records: 0, messages: 0, thoughts: 0, toolCalls: 0 }) }
  })
}
export const activityReport = (scope: ActivityScope = "all"): SessionAnalyticsActivity => ({
  scopeThreadId: scope === "all" ? null : scope,
  eventCount: scope === "all" ? 33 : scope === "root" ? 6 : 27,
  recordedTimeEvents: scope === "all" ? 29 : scope === "root" ? 4 : 25,
  unknownTimeEvents: scope === "all" ? 2 : 1, legacyTimeEvents: scope === "all" ? 2 : 1,
  firstRecordedAt: scope === "child" ? "2026-10-12T08:30:00Z" : "2026-10-12T08:00:00Z",
  lastRecordedAt: scope === "child" ? "2026-10-12T08:40:00Z" : "2026-10-12T09:00:00Z",
  recordSpanMilliseconds: scope === "child" ? 600000 : 3600000,
  backwardClockTransitions: 0, buckets: fixedBuckets(scope), unplacedRange: rangeToken(scope, "unplaced")
})
export const activityFixture: ActivityAnalytics = {
  ...analyticsFixture, analyticsVersion: 3, snapshot: activitySnapshot, head: activityHead,
  summary: { rootUserInputs: 2, messageFragments: 28, thoughtFragments: 2, toolCalls: 2, childThreads: 1,
    knownTimeEvents: 31, unknownTimeEvents: 2, unlinkedToolEvents: 0 },
  capabilities: { mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 2, mcp: [], skills: [] },
  threads: analyticsFixture.threads.map(thread => ({ ...thread, eventCount: thread.id === "root" ? 6 : 27, toolCalls: 1 })),
  activity: activityReport(), evidence: { items: [rootLast[1]!, childRecords[20]!] }
}
export const activityReplacement: ActivityAnalytics = {
  ...activityFixture, snapshot: "activity-snapshot-two", head: "activity-head-two", tools: [],
  summary: { rootUserInputs: 0, messageFragments: 0, thoughtFragments: 0, toolCalls: 0, childThreads: 0,
    knownTimeEvents: 0, unknownTimeEvents: 0, unlinkedToolEvents: 0 },
  capabilities: { mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 0, mcp: [], skills: [] },
  threads: activityFixture.threads.filter(thread => thread.id === "root").map(thread => ({ ...thread, eventCount: 0, toolCalls: 0 })),
  activity: { scopeThreadId: null, eventCount: 0, recordedTimeEvents: 0, unknownTimeEvents: 0, legacyTimeEvents: 0,
    firstRecordedAt: null, lastRecordedAt: null, recordSpanMilliseconds: null, backwardClockTransitions: 0, buckets: [], unplacedRange: null },
  evidence: { items: [] }
}
export const bucketName = (scope: ActivityScope, index: number) => {
  const bucket = fixedBuckets(scope)[index]!
  return `Show ${bucket.records} records from ${bucket.from} to ${bucket.to}`
}

const rangePages: ReadonlyMap<string, ReadonlyArray<ActivityEvidence>> = new Map([
  [rangeToken("all", 0), rootFirst], [rangeToken("all", 30), childRecords], [rangeToken("all", 40), [childLast]],
  [rangeToken("all", 59), rootLast], [rangeToken("all", "unplaced"), unplacedRecords],
  [rangeToken("root", 0), rootFirst], [rangeToken("root", 59), rootLast], [rangeToken("root", "unplaced"), unplacedRecords.slice(0, 2)],
  [rangeToken("child", 0), childRecords], [rangeToken("child", 59), [childLast]], [rangeToken("child", "unplaced"), unplacedRecords.slice(2)]
])
export type ActivityFixtureResponse = { readonly status: number; readonly body: unknown; readonly violation?: string }
const invalid = (message: string): ActivityFixtureResponse => ({ status: 422,
  body: { code: "validation_failed", detail: message }, violation: message })

/** Strict HTTP Test Adapter: reject cross-snapshot/scope/range/cursor requests.
 * Its predefined metadata pages exercise UI callers, not Server derivation. */
export const activityResponse = (query: URLSearchParams): ActivityFixtureResponse => {
  const allowed = new Set(["snapshot", "metric", "thread", "tool", "capability", "server", "range", "cursor", "limit"])
  for (const [key, value] of query) if (!allowed.has(key) || value === "" || query.getAll(key).length !== 1)
    return invalid(`Unexpected activity query ${key}.`)
  const scope: ActivityScope = query.get("thread") === "child" ? "child" : query.get("thread") === "root" ? "root" : "all"
  if (query.has("thread") && !["root", "child"].includes(query.get("thread")!)) return invalid("Unknown Thread scope.")
  const snapshot = query.get("snapshot"), metric = query.get("metric") ?? "tools", range = query.get("range")
  if (snapshot !== null && snapshot !== activitySnapshot) return invalid("The activity snapshot changed.")
  if ((range !== null || query.has("cursor")) && snapshot !== activitySnapshot) return invalid("A range/page requires the selected snapshot.")
  if (range !== null && metric !== "records") return invalid("An activity range requires records.")
  if (query.has("limit") && query.get("limit") !== "20") return invalid("This fixture has a fixed twenty-record page.")
  if (metric === "records" && ["tool", "capability", "server"].some(key => query.has(key))) return invalid("Records cannot reuse tool/capability filters.")
  if (range !== null && !activityReport(scope).buckets.some(bucket => bucket.range === range) && activityReport(scope).unplacedRange !== range)
    return invalid("A range cannot move between Thread scopes.")
  const selected = activityRecords.filter(item => scope === "all" || item.threadId === scope)
  let items: ReadonlyArray<ActivityEvidence>
  if (metric === "records") items = range === null ? selected : rangePages.get(range) ?? []
  else if (["tools", "failed_tools", "unknown_tools"].includes(metric)) {
    if (query.has("tool") && query.get("tool") !== "Read file") return invalid("Unsupported tool label.")
    items = metric === "unknown_tools" ? [] : [rootLast[1]!, ...(metric === "tools" ? [childRecords[20]!] : [])]
      .filter(item => scope === "all" || item.threadId === scope)
  } else if (metric === "thoughts") items = selected.filter(item => item.kind === "thought")
  else if (metric === "user_inputs") items = scope === "child" ? [] : rootFirst
  else if (["threads", "mcp_tools", "skills"].includes(metric)) items = []
  else return invalid("Unsupported evidence metric.")
  const cursor = `fixture-${scope}-page-two-${range ?? metric}`
  if (query.has("cursor") && query.get("cursor") !== cursor) return invalid("The page cursor cannot move between selections.")
  const page = query.has("cursor") ? items.slice(20) : items.slice(0, 20)
  return { status: 200, body: { ...activityFixture, activity: activityReport(scope), evidence: { items: page,
    ...(!query.has("cursor") && items.length > 20 ? { nextCursor: cursor } : {}) } } satisfies ActivityAnalytics }
}
