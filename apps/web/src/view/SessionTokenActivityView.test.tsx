import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { stableToolsFixture } from "../../test/sessionAnalyticsFixture"
import { tokenActivityFixture, tokenActivityReport, tokenBucketLabel, tokenModelKey } from "../../test/sessionTokenActivityFixture"
import { initializeWebI18n } from "../i18n"
import { SessionAnalyticsView } from "./SessionAnalyticsView"
import { SessionTokenActivityView } from "./SessionTokenActivityView"

const props = { threads: tokenActivityFixture.threads, refreshing: false, onScope: () => undefined, onRange: () => undefined }
const render = (report = tokenActivityReport()) => renderToStaticMarkup(<SessionTokenActivityView {...props} report={report} />)

describe("Session Token distribution", () => {
  afterEach(() => initializeWebI18n("en"))
  it("displays recorded subtotals with per-counter coverage and the Server's common cache cohort", () => {
    const html = render()
    expect(html).toContain("Known Token subtotals")
    expect(html).toContain("<dt>Total</dt><dd>670</dd>")
    expect(html).toContain("3 reported · 1 missing")
    expect(html).toContain("<dt>Cache read share</dt><dd>20%</dd>")
    expect(html).toContain("<dt>Cache write share</dt><dd>10%</dd>")
    expect(html).toContain("<dt>Uncached input share</dt><dd>70%</dd>")
    expect(html).toContain("Eligible input: 100 · cache read: 20 · cache write: 10 · uncached: 70")
    expect(html).toContain("3 samples are excluded")
    expect(html).toContain("No cost is estimated.")
    expect(html).not.toContain("Estimated cost")
  })
  it("keeps missing, overflowed and explicitly zero counters distinct", () => {
    const report = tokenActivityReport()
    const html = render({ ...report, tokens: { ...report.tokens,
      total: { knownSubtotal: null, reportedSamples: 1, missingSamples: 3, overflowed: true },
      cacheRead: { knownSubtotal: 0, reportedSamples: 4, missingSamples: 0, overflowed: false } },
      cache: { ...report.cache, readShare: null, writeShare: null, uncachedShare: null } })
    expect(html).toContain("<dt>Total</dt><dd>Unknown</dd>")
    expect(html).toContain("Subtotal exceeds the supported numeric range.")
    expect(html).toContain("<dt>Cache read</dt><dd>0</dd>")
    expect(html).toContain("<dt>Cache read share</dt><dd>Unknown</dd>")
    expect(html).not.toContain("<dt>Cache read share</dt><dd>0%</dd>")
  })
  it("uses exact returned intervals and clearly describes contextual original text", () => {
    const html = render()
    expect(html).toContain(tokenBucketLabel())
    expect(html).toContain("not exact Token attribution to a response or model")
    expect(html).toContain("Highest recorded consumption intervals")
    const hotspots = html.slice(html.indexOf('class="analytics-token-hotspots"'))
    expect(hotspots.indexOf("<strong>500</strong>")).toBeLessThan(hotspots.indexOf("<strong>100</strong>"))
    expect(hotspots).not.toContain("<strong>Unknown</strong>")
    expect(html).toContain('disabled="" aria-label="Read interval records: Unknown recorded Tokens · 0 records')
    expect(html).toContain("Known subtotals without a usage time (1 samples)")
  })
  it("does not invent dated intervals when every sample lacks a time", () => {
    const report = tokenActivityReport()
    const html = render({ ...report, timedSamples: 0, untimedSamples: 4, firstRecordedAt: null, lastRecordedAt: null, buckets: [], untimedTokens: report.tokens })
    expect(html).toContain("No dated usage samples are available for intervals.")
    expect(html).not.toContain('class="analytics-activity-bar')
    expect(html).toContain("Known subtotals without a usage time (4 samples)")
    expect(html).toContain("<dt>Total</dt><dd>670</dd>")
  })
  it("disables original-text navigation until the report matches the requested scope", () => {
    const html = renderToStaticMarkup(<SessionTokenActivityView {...props} report={tokenActivityReport()} model={tokenModelKey} />)
    expect(html).toContain('disabled="" aria-label="Read interval records: 500 recorded Tokens')
    expect(html).not.toContain('class="analytics-link" aria-pressed="false" aria-label="Read interval records')
  })
  it("shows v4 Token distribution as unavailable while retaining its original reports", () => {
    const html = renderToStaticMarkup(<SessionAnalyticsView state={{ _tag: "Ready", value: stableToolsFixture, refreshing: false }}
      query={{ metric: "tools" }} onReload={() => undefined} onFilter={() => undefined} onNext={() => undefined}
      onFirst={() => undefined} onBack={() => undefined} onOpenEvidence={() => undefined} evidenceHref={() => "/reader"} />)
    expect(html).toContain("This Server does not provide Token distribution or cache shares yet.")
    expect(html).not.toContain("Cache read share</dt>")
    expect(html).toContain("Recorded tools")
    expect(html).toContain("Recorded file activity")
  })
  it("keeps v5 stable tool, file and activity presentation alongside Token consumption", () => {
    const html = renderToStaticMarkup(<SessionAnalyticsView state={{ _tag: "Ready", value: tokenActivityFixture, refreshing: false }}
      query={{ metric: "tools" }} onReload={() => undefined} onFilter={() => undefined} onNext={() => undefined}
      onFirst={() => undefined} onBack={() => undefined} onOpenEvidence={() => undefined} evidenceHref={() => "/reader"} />)
    expect(html).toContain("Recorded tools")
    expect(html).toContain("Calls with tool identity</dt><dd>2</dd>")
    expect(html).toContain("Calls with usable file activity</dt><dd>0</dd>")
    expect(html).toContain("Record span</dt><dd>2 min</dd>")
    expect(html).toContain("Token consumption")
  })
  it("localizes labels while preserving a literal unknown model name beside a missing model", () => {
    initializeWebI18n("zh-CN")
    const html = render()
    expect(html).toContain("Token 消耗")
    expect(html).toContain("缓存读取占比</dt><dd>20%</dd>")
    expect(html).toContain(`value="${tokenModelKey}">unknown</option>`)
    expect(html).toContain("模型未知</option>")
    expect(html).toContain("不能把 Tokens 精确归属到某条响应或模型")
  })
  it("discloses that an empty usage report cannot establish zero consumption", () => {
    const report = tokenActivityReport()
    const empty = Object.fromEntries(Object.entries(report.tokens).map(([key]) => [key,
      { knownSubtotal: null, reportedSamples: 0, missingSamples: 0, overflowed: false }])) as typeof report.tokens
    const html = render({ ...report, samples: 0, timedSamples: 0, untimedSamples: 0, tokens: empty, untimedTokens: empty,
      cache: { eligibleSamples: 0, missingSamples: 0, inputTokens: null, readTokens: null, writeTokens: null,
        uncachedTokens: null, readShare: null, writeShare: null, uncachedShare: null },
      firstRecordedAt: null, lastRecordedAt: null, buckets: [], models: [], threads: [] })
    expect(html).toContain("No recorded usage is available to analyze. This does not mean zero consumption.")
    expect(html).toContain("<dt>Total</dt><dd>Unknown</dd>")
    expect(html).not.toContain("<dt>Total</dt><dd>0</dd>")
  })
})
