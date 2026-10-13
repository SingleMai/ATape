import type { SessionAnalytics } from "@atape/domain"
import { useId } from "react"
import { formatNumber, t } from "../i18n"
import { ConversationTime } from "./ConversationTime"

type TokenActivity = Extract<SessionAnalytics, { analyticsVersion: 5 }>["tokenActivity"]
type Accounting = TokenActivity["tokens"]
type Cache = TokenActivity["cache"]
const counters = ["total", "input", "output", "cacheRead", "cacheWrite"] as const
const subtotal = (value: Accounting["total"]) => value.knownSubtotal === null
  ? t("analytics.unknown", "Unknown") : formatNumber(value.knownSubtotal)
const share = (value: number | null) => value === null ? t("analytics.unknown", "Unknown")
  : formatNumber(value, { style: "percent", maximumFractionDigits: 1 })

function TokenAccounting({ value }: { readonly value: Accounting }) {
  return <dl className="analytics-token-grid analytics-token-coverage">
    {counters.map(counter => <div key={counter}>
      <dt>{t(`analytics.tokens.${counter}`)}</dt><dd>{subtotal(value[counter])}</dd>
      <p>{t("analytics.tokenCounterCoverage", "{reported} reported · {missing} missing", {
        reported: formatNumber(value[counter].reportedSamples), missing: formatNumber(value[counter].missingSamples) })}</p>
      {value[counter].overflowed && <p>{t("analytics.tokenCounterOverflow", "Subtotal exceeds the supported numeric range.")}</p>}
    </div>)}
  </dl>
}

function CacheShares({ value }: { readonly value: Cache }) {
  return <>
    <dl className="analytics-summary" aria-label={t("analytics.cacheShares", "Recorded input cache shares")}>
      <div><dt>{t("analytics.cacheReadShare", "Cache read share")}</dt><dd>{share(value.readShare)}</dd></div>
      <div><dt>{t("analytics.cacheWriteShare", "Cache write share")}</dt><dd>{share(value.writeShare)}</dd></div>
      <div><dt>{t("analytics.uncachedShare", "Uncached input share")}</dt><dd>{share(value.uncachedShare)}</dd></div>
      <div><dt>{t("analytics.cacheCohort", "Eligible cache samples")}</dt><dd>{formatNumber(value.eligibleSamples)}</dd></div>
    </dl>
    <p className="analytics-note">{t("analytics.cacheShareMeaning", "Shares use samples with all three valid counters. Cache is already included in input. {missing} samples are excluded; insufficient data, zero input or overflow means Unknown.", { missing: formatNumber(value.missingSamples) })}</p>
    <p className="analytics-note">{t("analytics.cacheCohortTokens", "Eligible input: {input} · cache read: {read} · cache write: {write} · uncached: {uncached}", {
      input: value.inputTokens === null ? t("analytics.unknown") : formatNumber(value.inputTokens),
      read: value.readTokens === null ? t("analytics.unknown") : formatNumber(value.readTokens),
      write: value.writeTokens === null ? t("analytics.unknown") : formatNumber(value.writeTokens),
      uncached: value.uncachedTokens === null ? t("analytics.unknown") : formatNumber(value.uncachedTokens) })}</p>
  </>
}

export function SessionTokenActivityView({ report, threads, thread, model, tokenRange, refreshing, onScope, onRange }: {
  readonly report: TokenActivity | undefined
  readonly threads: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly thread?: string
  readonly model?: string
  readonly tokenRange?: string
  readonly refreshing: boolean
  readonly onScope: (scope: { readonly thread?: string; readonly model: string | null }) => void
  readonly onRange: (range: string) => void
}) {
  const id = useId()
  if (report === undefined) return <section aria-labelledby={`${id}-tokens`}>
    <h2 id={`${id}-tokens`}>{t("analytics.tokenActivity", "Token consumption")}</h2>
    <p>{t("analytics.tokenActivityUnavailable", "This Server does not provide Token distribution or cache shares yet.")}</p>
  </section>
  const waiting = refreshing || report.scopeThreadId !== (thread ?? null) || report.scopeModelKey !== (model ?? null)
  const maximum = Math.max(1, ...report.buckets.map(bucket => bucket.tokens.total.knownSubtotal ?? 0))
  const hotspots = report.buckets.filter(bucket => bucket.tokens.total.knownSubtotal !== null && !bucket.tokens.total.overflowed)
    .toSorted((left, right) => right.tokens.total.knownSubtotal! - left.tokens.total.knownSubtotal!)
    .slice(0, 5)
  const rangeLabel = (bucket: TokenActivity["buckets"][number]) => t("analytics.tokenBucketEvidence", "Read interval records: {tokens} recorded Tokens · {records} records · {from} → {to}", {
    tokens: subtotal(bucket.tokens.total), records: formatNumber(bucket.records), from: bucket.from, to: bucket.to })
  return <section className="analytics-token-activity" aria-labelledby={`${id}-tokens`}>
    <div className="analytics-activity-heading">
      <h2 id={`${id}-tokens`}>{t("analytics.tokenActivity", "Token consumption")}</h2>
      <div className="analytics-token-scope">
        <label>{t("analytics.tokenThread", "Token thread")}<select aria-label={t("analytics.tokenThread", "Token thread")} value={thread ?? ""}
          disabled={refreshing} onChange={event => onScope({ model: model ?? null, ...(event.currentTarget.value ? { thread: event.currentTarget.value } : {}) })}>
          <option value="">{t("analytics.allThreads", "All threads")}</option>{threads.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        <label>{t("analytics.tokenModel", "Token model")}<select aria-label={t("analytics.tokenModel", "Token model")} value={model ?? ""}
          disabled={refreshing} onChange={event => onScope({ ...(thread ? { thread } : {}), model: event.currentTarget.value || null })}>
          <option value="">{t("analytics.allModels", "All models")}</option>
          {model && !report.models.some(item => item.key === model) && <option value={model}>{t("analytics.selectedModelWithoutSamples", "Selected model (no samples in this Thread)")}</option>}
          {report.models.map(item => <option key={item.key} value={item.key}>
            {item.model === null ? t("analytics.unknownModel", "Model unknown") : item.model}
          </option>)}
        </select></label>
      </div>
    </div>
    <p className="analytics-note">{t("analytics.tokenActivityMeaning", "Follows the selected Thread and model. Subtotals include known counters only; missing usage stays unknown. No cost is estimated.")}</p>
    {report.samples === 0 && <p className="partial-notice">{t("analytics.noRecordedUsage", "No recorded usage is available to analyze. This does not mean zero consumption.")}</p>}
    <dl className="analytics-summary" aria-label={t("analytics.tokenTimeCoverage", "Usage time coverage")}>
      <div><dt>{t("analytics.usageSamples", "Usage samples")}</dt><dd>{formatNumber(report.samples)}</dd></div>
      <div><dt>{t("analytics.timedUsageSamples", "Dated usage samples")}</dt><dd>{formatNumber(report.timedSamples)}</dd></div>
      <div><dt>{t("analytics.untimedUsageSamples", "Usage samples without time")}</dt><dd>{formatNumber(report.untimedSamples)}</dd></div>
    </dl>
    <h3>{t("analytics.knownTokenSubtotals", "Known Token subtotals")}</h3>
    <TokenAccounting value={report.tokens} />
    <h3>{t("analytics.cacheShares", "Recorded input cache shares")}</h3>
    <CacheShares value={report.cache} />
    <h3>{t("analytics.tokenDistribution", "Token distribution over recorded usage time")}</h3>
    <p className="analytics-note">{t("analytics.usageClockMeaning", "Times are recorded usage values and have not been independently verified.")}</p>
    <p className="analytics-note">{t("analytics.tokenRangeMeaning", "Read records from the same interval and selected Thread. They provide context, not exact Token attribution to a response or model. Records with unknown or legacy times are excluded.")}</p>
    <p className="analytics-note">{t("analytics.tokenBarMeaning", "Bars and hotspots use known total subtotals. Unknown values have no bar. Intervals without records cannot be opened.")}</p>
    {report.firstRecordedAt !== null && report.lastRecordedAt !== null && <p className="analytics-activity-endpoints">
      <ConversationTime value={report.firstRecordedAt} options={{ dateStyle: "medium", timeStyle: "medium" }} /><span aria-hidden="true"> → </span>
      <ConversationTime value={report.lastRecordedAt} options={{ dateStyle: "medium", timeStyle: "medium" }} />
    </p>}
    {report.buckets.length === 0 ? <p>{t("analytics.noDatedUsage", "No dated usage samples are available for intervals.")}</p> : <div className="analytics-activity-bars analytics-token-bars" aria-label={t("analytics.tokenIntervals", "Token consumption intervals")}>
      {report.buckets.map(bucket => <button type="button" key={bucket.range} className={`analytics-activity-bar${bucket.tokens.total.knownSubtotal === null ? " analytics-token-unknown" : ""}`}
        aria-pressed={tokenRange === bucket.range} disabled={waiting || bucket.records === 0} aria-label={rangeLabel(bucket)} title={bucket.records === 0 ? t("analytics.noTokenIntervalRecords", "No contemporaneous records are available in this interval.") : rangeLabel(bucket)} onClick={() => onRange(bucket.range)}>
        {bucket.tokens.total.knownSubtotal !== null && <span className="analytics-activity-bar-fill" style={{ height: `${bucket.tokens.total.knownSubtotal / maximum * 100}%` }} />}
        <span className="analytics-activity-bar-count">{subtotal(bucket.tokens.total)}</span>
      </button>)}
    </div>}
    {hotspots.length > 0 && <>
      <h3>{t("analytics.tokenHotspots", "Highest recorded consumption intervals")}</h3>
      <ol className="analytics-token-hotspots">{hotspots.map(bucket => <li key={bucket.range}>
        <button type="button" className="analytics-link" disabled={waiting || bucket.records === 0} aria-pressed={tokenRange === bucket.range}
          aria-label={rangeLabel(bucket)} onClick={() => onRange(bucket.range)}>
          <strong>{subtotal(bucket.tokens.total)}</strong><span> · <ConversationTime value={bucket.from} options={{ dateStyle: "short", timeStyle: "medium" }} /> → <ConversationTime value={bucket.to} options={{ timeStyle: "medium" }} /></span>
        </button>
        {bucket.records === 0 && <span>{t("analytics.noTokenIntervalRecords", "No contemporaneous records are available in this interval.")}</span>}
        <span>{t("analytics.tokenIntervalCoverage", "{samples} usage samples · {reported} total counters reported · {missing} total counters missing · {records} interval records", {
          samples: formatNumber(bucket.samples), reported: formatNumber(bucket.tokens.total.reportedSamples), missing: formatNumber(bucket.tokens.total.missingSamples), records: formatNumber(bucket.records) })}</span>
      </li>)}</ol>
    </>}
    {report.untimedSamples > 0 && <details className="analytics-untimed-tokens"><summary>{t("analytics.untimedTokenSubtotals", "Known subtotals without a usage time ({count} samples)", { count: formatNumber(report.untimedSamples) })}</summary>
      <p className="analytics-note">{t("analytics.untimedTokenMeaning", "Included in subtotals; no interval can be selected without a time.")}</p>
      <TokenAccounting value={report.untimedTokens} />
    </details>}
  </section>
}
