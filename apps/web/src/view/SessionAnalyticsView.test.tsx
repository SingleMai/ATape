import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { activityFixture, analyticsFixture, capabilitiesFixture } from "../../test/sessionAnalyticsFixture"
import { initializeWebI18n } from "../i18n"
import { SessionAnalyticsView } from "./SessionAnalyticsView"

const props = {
  query: { metric: "tools" as const }, onReload: () => undefined, onFilter: () => undefined,
  onNext: () => undefined, onFirst: () => undefined, onBack: () => undefined,
  onOpenEvidence: () => undefined,
  evidenceHref: () => "/reader?snapshot=snapshot-one&thread=root&event=tool-1&head=head-one"
}

describe("Session analysis view", () => {
  it("shows recorded values, unknowns and incomplete capture with precise count labels", () => {
    initializeWebI18n("en")
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value: analyticsFixture, refreshing: false }} />)
    expect(html).toContain("Message fragments")
    expect(html).toContain("Captured child threads")
    expect(html).toContain("Capture: Partial")
    expect(html).toContain("1 recorded samples · 1 incomplete samples · 1 usage events")
    expect(html).toContain("<dt>Total</dt><dd>Unknown</dd>")
    expect(html).toContain("<dt>Cache read</dt><dd>0</dd>")
    expect(html).toContain("Time unknown")
    expect(html).not.toContain('dateTime=""')
    expect(html).toContain('href="/reader?snapshot=snapshot-one&amp;thread=root&amp;event=tool-1&amp;head=head-one"')
    expect(html).not.toContain("Estimated cost")
  })
  it("discloses an old Server without showing fabricated MCP or Skill zeros", () => {
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value: analyticsFixture, refreshing: false }} />)
    expect(html).toContain("This Server does not provide MCP or Skills reports yet.")
    expect(html).not.toContain("Recorded MCP calls")
    expect(html).not.toContain('value="mcp_tools"')
    expect(html).not.toContain('value="skills"')
    expect(html).toContain("This Server does not provide recorded activity yet.")
    expect(html).not.toContain("Record span")
    expect(html).not.toContain('value="records"')
  })
  it("displays the Server's span, exact ranges and clock quality while retaining v2 capability reports", () => {
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} query={{ metric: "records", range: "opaque-first-bucket" }}
      state={{ _tag: "Ready", value: activityFixture, refreshing: false }} />)
    expect(html).toContain("Record span</dt><dd>2 min")
    expect(html).toContain("Show 4 records from 2026-10-12T00:00:00Z to 2026-10-12T00:01:00Z")
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain("Show unplaced records")
    expect(html).toContain("4 unknown time · 2 legacy time")
    expect(html).toContain("Recorded time")
    expect(html).toContain("Legacy time")
    expect(html).toContain("1970")
    expect(html).toContain("Recorded MCP calls")
    expect(html).toContain("<dt>Recorded Skill calls</dt><dd>1</dd>")
    expect(html).toContain('value="records"')
    expect(html).toContain("not work time")
  })
  it("displays all-unknown activity without a false zero span or dated bucket", () => {
    const value = { ...activityFixture, activity: { ...activityFixture.activity, recordedTimeEvents: 0,
      unknownTimeEvents: 12, legacyTimeEvents: 0, firstRecordedAt: null, lastRecordedAt: null, recordSpanMilliseconds: null, buckets: [] } }
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value, refreshing: false }} />)
    expect(html).toContain("Record span</dt><dd>Unknown</dd>")
    expect(html).toContain("No recorded source clocks are available for dated buckets.")
    expect(html).not.toContain("analytics-activity-bar\"")
    expect(html).toContain("Show unplaced records")
  })
  it("keeps a same-instant record span at zero and exposes its inclusive point bucket", () => {
    const bucket = activityFixture.activity.buckets[0]!
    const value = { ...activityFixture, activity: { ...activityFixture.activity, recordSpanMilliseconds: 0,
      lastRecordedAt: activityFixture.activity.firstRecordedAt, buckets: [{ ...bucket, to: bucket.from, includesEnd: true }] } }
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value, refreshing: false }} />)
    expect(html).toContain("Record span</dt><dd>0 ms</dd>")
    expect(html).toContain("Show 4 records from 2026-10-12T00:00:00Z to 2026-10-12T00:00:00Z")
  })
  it("retains an empty Server interval as a selectable exact range", () => {
    const value = { ...activityFixture, activity: { ...activityFixture.activity,
      buckets: activityFixture.activity.buckets.map(bucket => ({ ...bucket, records: 0, messages: 0, thoughts: 0, toolCalls: 0 })) } }
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value, refreshing: false }} />)
    expect(html).toContain("Show 0 records from 2026-10-12T00:00:00Z to 2026-10-12T00:01:00Z")
    expect(html).toContain("height:0%")
    expect(html).not.toContain("No recorded source clocks are available")
  })
  it("formats the supplied span into days and subsecond units without rebuilding buckets", () => {
    const value = { ...activityFixture, activity: { ...activityFixture.activity, recordSpanMilliseconds: 90_061_000.000001 } }
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value, refreshing: false }} />)
    expect(html).toContain("Record span</dt><dd>1 d 1 h 1 min 1 s 0.000001 ms")
    expect(html).toContain("Show 4 records from 2026-10-12T00:00:00Z to 2026-10-12T00:01:00Z")
  })
  it("shows zero recorded capability calls separately from unclassified calls", () => {
    const value = { ...analyticsFixture, analyticsVersion: 2 as const,
      capabilities: { mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 2, mcp: [], skills: [] } }
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value, refreshing: false }} />)
    expect(html).toContain("<dt>Recorded MCP calls</dt><dd>0</dd>")
    expect(html).toContain("<dt>Recorded Skill calls</dt><dd>0</dd>")
    expect(html).toContain("<dt>Calls without capability identity</dt><dd>2</dd>")
    expect(html).toContain("Their presence does not prove that MCP or Skills were unused.")
    expect(html).toContain("No MCP calls with structured identity were recorded.")
    expect(html).not.toContain("This Server does not provide MCP or Skills")
  })
  it("shows explicit outcomes and names while excluding tool input/output bodies", () => {
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value: capabilitiesFixture, refreshing: false }} />)
    expect(html).toContain("MCP evidence: docs / lookup")
    expect(html).toContain("MCP evidence: repo / lookup")
    expect(html).toContain("Skill evidence: review-code")
    expect(html).toContain("Completed means the tool finished, not that a Skill task succeeded.")
    expect(html).not.toContain("rawInput")
    expect(html).not.toContain("rawOutput")
  })
  it("offers explicit refresh after replacement and does not render prior statistics", () => {
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Failed", messageKey: "problems.refresh_required", retryable: true, refreshRequired: true }} />)
    expect(html).toContain("Conversation has changed")
    expect(html).toContain("Reload analysis")
    expect(html).not.toContain("Read file")
    expect(html).not.toContain("Session counts")
  })
  it("labels healthy capture without claiming complete capture", () => {
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value: { ...analyticsFixture, captureStatus: "healthy" }, refreshing: false }} />)
    expect(html).toContain("Capture: Capture healthy")
    expect(html).not.toContain("Capture is incomplete")
  })
  it("translates evidence controls and unknown counters in Chinese", () => {
    initializeWebI18n("zh-CN")
    const html = renderToStaticMarkup(<SessionAnalyticsView {...props} state={{ _tag: "Ready", value: analyticsFixture, refreshing: false }} />)
    expect(html).toContain("已记录 Tokens")
    expect(html).toContain("时间未知")
    expect(html).toContain("<dt>总计</dt><dd>未知</dd>")
    initializeWebI18n("en")
  })
})
