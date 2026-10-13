import type { SessionAnalytics } from "@atape/domain"
import { stableToolsFixture } from "./sessionAnalyticsFixture"

export type TokenAnalytics = Extract<SessionAnalytics, { analyticsVersion: 5 }>
type Accounting = TokenAnalytics["tokenActivity"]["tokens"]
type Counter = Accounting["total"]
export const tokenModelKey = `model:${"e".repeat(64)}`
export const tokenUnknownModelKey = `model:${"f".repeat(64)}`
export const tokenSnapshot = "token-snapshot-one"
export const tokenHead = "token-head-one"
const counter = (knownSubtotal: number | null, reportedSamples = 1, missingSamples = 0): Counter =>
  ({ knownSubtotal, reportedSamples, missingSamples, overflowed: false })
export const tokenAccounting = (total: number | null, input: number | null, output: number | null,
  reportedSamples = 1, missingSamples = 0): Accounting => ({ total: counter(total, reportedSamples, missingSamples),
  input: counter(input, reportedSamples, missingSamples), output: counter(output, reportedSamples, missingSamples),
  cacheRead: counter(input === null ? null : 20, reportedSamples, missingSamples),
  cacheWrite: counter(input === null ? null : 10, reportedSamples, missingSamples) })
const cache: TokenAnalytics["tokenActivity"]["cache"] = { eligibleSamples: 1, missingSamples: 3,
  inputTokens: 100, readTokens: 20, writeTokens: 10, uncachedTokens: 70, readShare: .2, writeShare: .1, uncachedShare: .7 }
const tokens = tokenAccounting(670, 500, 170, 3, 1)
const range = (thread: string | null, model: string | null, interval: string) => `token-${thread ?? "all"}-${model ?? "all"}-${interval}`
export const tokenActivityReport = (thread: string | null = null, model: string | null = null): TokenAnalytics["tokenActivity"] => ({
  scopeThreadId: thread, scopeModelKey: model, samples: 4, timedSamples: 3, untimedSamples: 1,
  firstRecordedAt: "2026-10-13T08:00:00Z", lastRecordedAt: "2026-10-13T08:03:00Z",
  tokens, untimedTokens: tokenAccounting(70, 50, 20), cache,
  models: [{ key: tokenModelKey, model: "unknown", samples: 3, tokens, cache },
    { key: tokenUnknownModelKey, model: null, samples: 1, tokens: tokenAccounting(null, null, null, 0, 1), cache }],
  threads: [{ id: "root", samples: 2, tokens, cache }, { id: "child", samples: 2, tokens, cache }],
  buckets: [
    { from: "2026-10-13T08:00:00Z", to: "2026-10-13T08:01:00Z", includesEnd: false,
      samples: 1, tokens: tokenAccounting(100, 80, 20), records: 2, range: range(thread, model, "first") },
    { from: "2026-10-13T08:01:00Z", to: "2026-10-13T08:02:00Z", includesEnd: false,
      samples: 2, tokens: tokenAccounting(500, 370, 130, 1, 1), records: 24, range: range(thread, model, "hot") },
    { from: "2026-10-13T08:02:00Z", to: "2026-10-13T08:03:00Z", includesEnd: true,
      samples: 0, tokens: tokenAccounting(null, null, null, 0, 0), records: 0, range: range(thread, model, "empty") }
  ]
})
export const tokenActivityFixture: TokenAnalytics = { ...stableToolsFixture, analyticsVersion: 5,
  snapshot: tokenSnapshot, head: tokenHead, tokenActivity: tokenActivityReport() }
export const tokenBucketLabel = (thread: string | null = null, model: string | null = null, index = 1) => {
  const bucket = tokenActivityReport(thread, model).buckets[index]!
  return `Read interval records: ${bucket.tokens.total.knownSubtotal ?? "Unknown"} recorded Tokens · ${bucket.records} records · ${bucket.from} → ${bucket.to}`
}

/** Fixed HTTP Test Adapter. It validates caller selections and returns canned
 * pages; Server derivation is exercised by Go and PostgreSQL checks. */
export const tokenActivityResponse = (query: URLSearchParams): { readonly status: number; readonly body: unknown; readonly violation?: string } => {
  const invalid = (violation: string) => ({ status: 422, body: { code: "validation_failed", detail: violation }, violation })
  const allowed = new Set(["metric", "snapshot", "thread", "model", "tokenRange", "cursor", "limit", "tool"])
  for (const [key, value] of query) if (!allowed.has(key) || value === "" || query.getAll(key).length !== 1) return invalid(`Invalid query ${key}.`)
  const thread = query.get("thread"), model = query.get("model"), metric = query.get("metric") ?? "tools"
  if (thread !== null && !["root", "child"].includes(thread)) return invalid("Unknown Thread.")
  if (model !== null && ![tokenModelKey, tokenUnknownModelKey].includes(model)) return invalid("Model must be a returned key.")
  if (query.has("snapshot") && query.get("snapshot") !== tokenSnapshot) return invalid("Snapshot changed.")
  const report = tokenActivityReport(thread, model), selectedRange = query.get("tokenRange")
  if (metric === "token_records" && (query.get("snapshot") !== tokenSnapshot || selectedRange === null)) return invalid("Token records require snapshot and range.")
  if (metric !== "token_records" && selectedRange !== null) return invalid("Token range requires Token records.")
  if (selectedRange !== null && !report.buckets.some(bucket => bucket.range === selectedRange)) return invalid("Range changed scope.")
  const pageCursor = `next-${selectedRange ?? metric}`
  if (query.has("cursor") && query.get("cursor") !== pageCursor) return invalid("Cursor changed selection.")
  const items = metric === "token_records" ? Array.from({ length: selectedRange === report.buckets[1]!.range ? 24 : 2 }, (_, index) => ({
    eventId: `token-context-${String(index + 1).padStart(2, "0")}`, threadId: thread ?? "child", kind: index === 20 ? "tool_result" : "message",
    label: index === 20 ? "Token interval context" : `Contemporaneous record ${index + 1}`,
    occurredAt: "2026-10-13T08:01:30Z", clockQuality: "recorded" as const
  })) : []
  const page = query.has("cursor") ? items.slice(20) : items.slice(0, 20)
  return { status: 200, body: { ...tokenActivityFixture, activity: { ...tokenActivityFixture.activity, scopeThreadId: thread }, tokenActivity: report,
    evidence: { items: page, ...(!query.has("cursor") && items.length > 20 ? { nextCursor: pageCursor } : {}) } } satisfies TokenAnalytics }
}
