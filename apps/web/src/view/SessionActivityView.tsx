import type { SessionAnalyticsActivity } from "@atape/domain"
import { useId } from "react"
import { formatNumber, t } from "../i18n"
import { ConversationTime } from "./ConversationTime"

type Props = {
  readonly activity: SessionAnalyticsActivity | undefined
  readonly threads: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly thread?: string
  readonly range?: string
  readonly refreshing: boolean
  readonly onThread: (thread: string) => void
  readonly onRange: (range: string) => void
}

const formatRecordSpan = (milliseconds: number): string => {
  let remaining = milliseconds
  const parts: string[] = []
  for (const [unit, size] of [
    ["analytics.spanDays", 86_400_000], ["analytics.spanHours", 3_600_000],
    ["analytics.spanMinutes", 60_000], ["analytics.spanSeconds", 1_000]
  ] as const) {
    const count = Math.floor(remaining / size)
    if (count > 0) { parts.push(t(unit, undefined, { count: formatNumber(count) })); remaining -= count * size }
  }
  if (remaining > 0 || parts.length === 0) parts.push(t("analytics.spanMilliseconds", undefined, {
    count: formatNumber(remaining, { maximumFractionDigits: 6 }) }))
  return parts.join(" ")
}

/** Display the Server's admitted clocks and exact ranges; do not rebuild bins
 * or infer work time from the Reader's current page. */
export function SessionActivityView({ activity, threads, thread, range, refreshing, onThread, onRange }: Props) {
  const id = useId()
  if (activity === undefined) return <section aria-labelledby={`${id}-activity`}>
    <h2 id={`${id}-activity`}>{t("analytics.activity", "Recorded activity")}</h2>
    <p>{t("analytics.activityUnavailable", "This Server does not provide recorded activity yet.")}</p>
  </section>
  const maximum = Math.max(1, ...activity.buckets.map(bucket => bucket.records))
  const waiting = refreshing || activity.scopeThreadId !== (thread ?? null)
  return <section className="analytics-activity" aria-labelledby={`${id}-activity`}>
    <div className="analytics-activity-heading">
      <h2 id={`${id}-activity`}>{t("analytics.activity", "Recorded activity")}</h2>
      <label>{t("analytics.activityThread", "Activity thread")}<select aria-label={t("analytics.activityThread", "Activity thread")}
        value={thread ?? ""} onChange={event => onThread(event.currentTarget.value)}>
        <option value="">{t("analytics.allThreads", "All threads")}</option>
        {threads.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
    </div>
    <p className="analytics-note">{t("analytics.activityMeaning", "Recorded source clocks describe captured events, not work time, coding time or tool duration. Counts include message fragments and tool updates. Parallel thread spans are not added.")}</p>
    <dl className="analytics-summary" aria-label={t("analytics.activityCoverage", "Activity clock coverage")}>
      {([
        ["analytics.activityRecords", activity.eventCount], ["analytics.recordedTimeEvents", activity.recordedTimeEvents],
        ["analytics.activityUnknownTime", activity.unknownTimeEvents], ["analytics.legacyTimeEvents", activity.legacyTimeEvents]
      ] as const).map(([label, count]) => <div key={label}><dt>{t(label)}</dt><dd>{formatNumber(count)}</dd></div>)}
      <div><dt>{t("analytics.recordSpan", "Record span")}</dt><dd>{activity.recordSpanMilliseconds === null
        ? t("analytics.unknown", "Unknown") : formatRecordSpan(activity.recordSpanMilliseconds)}</dd></div>
      <div><dt>{t("analytics.backwardClocks", "Backward clock transitions")}</dt><dd>{formatNumber(activity.backwardClockTransitions)}</dd></div>
    </dl>
    <p className="analytics-note">{t("analytics.activityClockCoverage", "These times come from source records and have not been independently verified. Older formats cannot distinguish source times from substituted values, so their dates remain outside the span and dated buckets. Recapturing available source history with an updated Adapter can correct this. Unknown and legacy records remain selectable below.")}</p>
    <p className="analytics-note">{t("analytics.backwardClockMeaning", "Backward transitions compare consecutive recorded clocks in each thread's source order. They do not compare parallel threads or prove that a clock is wrong.")}</p>
    {activity.firstRecordedAt !== null && activity.lastRecordedAt !== null && <p className="analytics-activity-endpoints">
      <ConversationTime value={activity.firstRecordedAt} options={{ dateStyle: "medium", timeStyle: "medium" }} />
      <span aria-hidden="true"> → </span>
      <ConversationTime value={activity.lastRecordedAt} options={{ dateStyle: "medium", timeStyle: "medium" }} />
    </p>}
    {activity.buckets.length === 0 ? <p>{t("analytics.noRecordedClocks", "No recorded source clocks are available for dated buckets.")}</p> : <>
      <p className="analytics-note">{t("analytics.bucketMeaning", "Select an interval to read its records. Empty intervals are retained. The final interval includes its ending clock; other intervals exclude it. Tool calls count their final linked update, while records count every event.")}</p>
      <div className="analytics-activity-bars" aria-label={t("analytics.activityIntervals", "Recorded activity intervals")}>
        {activity.buckets.map(bucket => <button type="button" key={bucket.range} aria-pressed={range === bucket.range}
          className="analytics-activity-bar" disabled={waiting}
          aria-label={t("analytics.bucketRecords", "Show {records} records from {from} to {to}", { records: bucket.records, from: bucket.from, to: bucket.to })}
          title={t("analytics.bucketDetails", "{records} records · {messages} message fragments · {thoughts} thought fragments · {tools} linked tool calls\n{from} → {to}", {
            records: bucket.records, messages: bucket.messages, thoughts: bucket.thoughts, tools: bucket.toolCalls, from: bucket.from, to: bucket.to })}
          onClick={() => onRange(bucket.range)}>
          <span className="analytics-activity-bar-fill" style={{ height: `${bucket.records / maximum * 100}%` }} />
          <span className="analytics-activity-bar-count">{formatNumber(bucket.records)}</span>
        </button>)}
      </div>
    </>}
    {activity.unplacedRange !== null && <button type="button" className="analytics-unplaced" disabled={waiting}
      aria-pressed={range === activity.unplacedRange} onClick={() => onRange(activity.unplacedRange!)}>
      {t("analytics.showUnplaced", "Show unplaced records")}
      <span> · {t("analytics.unplacedCounts", "{unknown} unknown time · {legacy} legacy time", {
        unknown: activity.unknownTimeEvents, legacy: activity.legacyTimeEvents })}</span>
    </button>}
  </section>
}
