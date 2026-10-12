import { canFilterSessionAnalyticsTool, sessionAnalyticsToolSelections, type SessionAnalyticsFilter } from "@atape/application"
import type { SessionAnalytics, SessionAnalyticsMetric, SessionAnalyticsQuery, SessionAnalyticsTokens } from "@atape/domain"
import { Button } from "@atape/ui"
import { useEffect, useId, useRef } from "react"
import type { LoadableView } from "../presenters/memoryPresenter"
import { useSessionAnalyticsPresenter } from "../presenters/sessionAnalyticsPresenter"
import { formatNumber, t, type WebMessageKey } from "../i18n"
import { ConversationTime } from "./ConversationTime"
import { SessionActivityView } from "./SessionActivityView"

export type AnalyticsEvidenceTarget = {
  readonly snapshot: string
  readonly head?: string
  readonly threadId: string
  readonly eventId: string
}
type Navigation = {
  readonly onBack: () => void
  readonly evidenceHref: (target: AnalyticsEvidenceTarget) => string
  readonly onOpenEvidence: (target: AnalyticsEvidenceTarget) => void
}
type Props = Navigation & {
  readonly state: LoadableView<SessionAnalytics>
  readonly query: SessionAnalyticsQuery
  readonly onReload: () => void
  readonly onFilter: (filter: SessionAnalyticsFilter) => void
  readonly onNext: () => void
  readonly onFirst: () => void
}
const metrics: ReadonlyArray<readonly [SessionAnalyticsMetric, WebMessageKey]> = [
  ["tools", "analytics.metric.tools"], ["failed_tools", "analytics.metric.failed_tools"],
  ["unknown_tools", "analytics.metric.unknown_tools"], ["user_inputs", "analytics.metric.user_inputs"],
  ["thoughts", "analytics.metric.thoughts"], ["threads", "analytics.metric.threads"],
  ["mcp_tools", "analytics.metric.mcp_tools"], ["skills", "analytics.metric.skills"], ["records", "analytics.metric.records"]
]
const token = (value: number | null) => value === null ? t("analytics.unknown", "Unknown") : formatNumber(value)
const capture = (value: string) => value === "healthy" ? t("analytics.capture.healthy", "Capture healthy") : value === "complete" ? t("analytics.capture.complete", "Complete") :
  value === "partial" ? t("analytics.capture.partial", "Partial") :
  value === "degraded" ? t("analytics.capture.degraded", "Degraded") : t("analytics.unknown", "Unknown")
const toolName = (tool: SessionAnalytics["tools"][number]) =>
  "identity" in tool ? tool.identity === null ? t("analytics.unknown", "Unknown") : tool.name :
    tool.name === "unknown" ? t("analytics.unknown", "Unknown") : tool.name
const toolIdentityType = (tool: SessionAnalytics["tools"][number]) =>
  "identity" in tool && tool.identity !== null ? tool.identity.type === "mcp" ? "MCP" :
    tool.identity.type === "skill" ? t("analytics.identity.skill", "Skill") : t("analytics.identity.tool", "Tool") :
    t("analytics.unknown", "Unknown")

type CapabilityReport = Extract<SessionAnalytics, { analyticsVersion: 2 }>["capabilities"]
function CapabilityReports({ report, thread, onFilter }: {
  readonly report: CapabilityReport | undefined
  readonly thread?: string
  readonly onFilter: (filter: SessionAnalyticsFilter) => void
}) {
  const id = useId()
  if (report === undefined) return <section aria-labelledby={`${id}-capabilities`}>
    <h2 id={`${id}-capabilities`}>{t("analytics.capabilities", "MCP and Skills")}</h2>
    <p>{t("analytics.capabilitiesUnavailable", "This Server does not provide MCP or Skills reports yet.")}</p>
  </section>
  const headers = ["analytics.calls", "analytics.completed", "analytics.failed", "analytics.pending", "analytics.inProgress", "analytics.statusUnknown"] as const
  const counts = (item: CapabilityReport["skills"][number]) => [item.calls, item.completed, item.failed, item.pending, item.inProgress, item.unknown]
  return <section aria-labelledby={`${id}-capabilities`}>
    <h2 id={`${id}-capabilities`}>{t("analytics.capabilities", "MCP and Skills")}</h2>
    <dl className="analytics-summary">
      <div><dt>{t("analytics.mcpCalls", "Recorded MCP calls")}</dt><dd>{formatNumber(report.mcpCalls)}</dd></div>
      <div><dt>{t("analytics.skillCalls", "Recorded Skill calls")}</dt><dd>{formatNumber(report.skillCalls)}</dd></div>
      <div><dt>{t("analytics.unclassifiedCalls", "Calls without capability identity")}</dt><dd>{formatNumber(report.unclassifiedCalls)}</dd></div>
    </dl>
    <p className="analytics-note">{t("analytics.capabilityCoverage", "Calls without capability identity include ordinary tools and calls from older or unsupported Adapters. Their presence does not prove that MCP or Skills were unused.")}</p>
    <p className="analytics-note">{t("analytics.skillOutcome", "These are recorded invocations. Completed means the tool finished, not that a Skill task succeeded. Installed or loaded capabilities are not counted.")}</p>
    <h3>{t("analytics.mcp", "MCP tools")}</h3>
    {report.mcp.length === 0 ? <p>{t("analytics.noMcp", "No MCP calls with structured identity were recorded.")}</p> :
      <div className="analytics-table-scroll"><table><thead><tr>
        <th scope="col">{t("analytics.mcpServer", "MCP server")}</th><th scope="col">{t("analytics.capabilityName", "Name")}</th>
        {headers.map(label => <th key={label} scope="col">{t(label)}</th>)}
      </tr></thead><tbody>{report.mcp.map(item => <tr key={JSON.stringify([item.server, item.name])}>
        <td>{item.server}</td><th scope="row"><button type="button" className="analytics-link"
          disabled={!canFilterSessionAnalyticsTool(item.server) || !canFilterSessionAnalyticsTool(item.name)}
          aria-label={t("analytics.mcpEvidence", "MCP evidence: {server} / {name}", { server: item.server, name: item.name })}
          onClick={() => onFilter({ metric: "mcp_tools", capability: item.name, server: item.server, ...(thread ? { thread } : {}) })}>{item.name}</button></th>
        {counts(item).map((count, index) => <td key={headers[index]}>{formatNumber(count)}</td>)}
      </tr>)}</tbody></table></div>}
    <h3>{t("analytics.skills", "Skills")}</h3>
    {report.skills.length === 0 ? <p>{t("analytics.noSkills", "No Skill calls with structured identity were recorded.")}</p> :
      <div className="analytics-table-scroll"><table><thead><tr>
        <th scope="col">{t("analytics.capabilityName", "Name")}</th>{headers.map(label => <th key={label} scope="col">{t(label)}</th>)}
      </tr></thead><tbody>{report.skills.map(item => <tr key={item.name}>
        <th scope="row"><button type="button" className="analytics-link" disabled={!canFilterSessionAnalyticsTool(item.name)}
          aria-label={t("analytics.skillEvidence", "Skill evidence: {name}", { name: item.name })}
          onClick={() => onFilter({ metric: "skills", capability: item.name, ...(thread ? { thread } : {}) })}>{item.name}</button></th>
        {counts(item).map((count, index) => <td key={headers[index]}>{formatNumber(count)}</td>)}
      </tr>)}</tbody></table></div>}
  </section>
}

function Tokens({ value }: { readonly value: SessionAnalyticsTokens }) {
  return <dl className="analytics-token-grid">
    {([
      ["analytics.tokens.total", value.total], ["analytics.tokens.input", value.input],
      ["analytics.tokens.output", value.output], ["analytics.tokens.cacheRead", value.cacheRead],
      ["analytics.tokens.cacheWrite", value.cacheWrite]
    ] as const).map(([label, count]) => <div key={label}><dt>{t(label)}</dt><dd>{token(count)}</dd></div>)}
  </dl>
}

export function SessionAnalyticsView({ state, query, onReload, onFilter, onNext, onFirst, onBack, evidenceHref, onOpenEvidence }: Props) {
  const id = useId()
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => { title.current?.focus({ preventScroll: true }) }, [])
  const selections = state._tag === "Ready" ? sessionAnalyticsToolSelections(state.value) : []
  const stableTools = state._tag === "Ready" && state.value.analyticsVersion === 4
  const toolFilterLabel = stableTools ? t("analytics.toolName", "Tool name") : t("analytics.toolLabel", "Tool label")
  return <section className="session-analytics" aria-labelledby={`${id}-title`}>
    <header className="analytics-heading">
      <div><Button variant="ghost" onClick={onBack}>{t("analytics.back", "Back to conversation")}</Button>
        <h1 id={`${id}-title`} ref={title} tabIndex={-1}>{t("analytics.title", "Session analysis")}</h1></div>
      <Button variant="ghost" onClick={onReload}>{t("analytics.reload", "Reload analysis")}</Button>
    </header>
    {state._tag === "Loading" && <p className="state-card" role="status">{t("analytics.loading", "Reading session analysis…")}</p>}
    {state._tag === "Failed" && <div className="state-card error-card" role="alert">
      <h2>{state.refreshRequired ? t("session.changed", "Conversation has changed") : t("analytics.unavailable", "Analysis is unavailable")}</h2>
      <p>{t(state.messageKey)}</p>
      {state.retryable && <Button onClick={onReload}>{state.refreshRequired ? t("analytics.reload", "Reload analysis") : t("common.tryAgain", "Try again")}</Button>}
    </div>}
    {state._tag === "Ready" && <>
      <p className="analytics-note">{t("analytics.scope", "Statistics describe the captured Canonical conversation. Filters only change the evidence list.")}</p>
      <p className="analytics-capture">{t("analytics.capture", "Capture: {status}", { status: capture(state.value.captureStatus) })}</p>
      {!["complete", "healthy"].includes(state.value.captureStatus) && <p className="partial-notice">{t("analytics.partial", "Capture is incomplete. These counts cover only the events available in this snapshot.")}</p>}
      <dl className="analytics-summary" aria-label={t("analytics.summary", "Session counts")}>
        {([
          ["analytics.rootUserInputs", state.value.summary.rootUserInputs],
          ["analytics.messageFragments", state.value.summary.messageFragments],
          ["analytics.thoughtFragments", state.value.summary.thoughtFragments],
          ["analytics.toolCalls", state.value.summary.toolCalls],
          ["analytics.childThreads", state.value.summary.childThreads],
          ["analytics.knownTimeEvents", state.value.summary.knownTimeEvents],
          ["analytics.unknownTimeEvents", state.value.summary.unknownTimeEvents],
          ["analytics.unlinkedToolEvents", state.value.summary.unlinkedToolEvents]
        ] as const).map(([label, count]) => <div key={label}><dt>{t(label)}</dt><dd>{formatNumber(count)}</dd></div>)}
      </dl>
      <p className="analytics-note">{t("analytics.countMeaning", "Message fragments are stored pieces, not original message counts or conversation turns. Tool calls are linked by their recorded call ID within each thread.")}</p>
      <SessionActivityView activity={state.value.analyticsVersion === 3 || state.value.analyticsVersion === 4 ? state.value.activity : undefined}
        threads={state.value.threads} {...(query.thread ? { thread: query.thread } : {})}
        {...(query.range ? { range: query.range } : {})} refreshing={state.refreshing}
        onThread={thread => onFilter({ ...query, thread })}
        onRange={range => onFilter({ metric: "records", range, ...(query.thread ? { thread: query.thread } : {}) })} />
      <section aria-labelledby={`${id}-tools`}>
        <h2 id={`${id}-tools`}>{stableTools ? t("analytics.stableTools", "Recorded tools") : t("analytics.tools", "Tool call labels")}</h2>
        {state.value.analyticsVersion === 4 ? <>
          <dl className="analytics-summary">
            <div><dt>{t("analytics.identifiedToolCalls", "Calls with tool identity")}</dt><dd>{formatNumber(state.value.summary.identifiedToolCalls)}</dd></div>
            <div><dt>{t("analytics.unidentifiedToolCalls", "Calls without tool identity")}</dt><dd>{formatNumber(state.value.summary.unidentifiedToolCalls)}</dd></div>
          </dl>
          <p className="analytics-note">{t("analytics.stableToolMeaning", "Tools are grouped by their recorded native identity and kind. Different command titles can belong to the same tool; evidence retains each call's last title and explicit outcome.")}</p>
          <p className="analytics-note">{t("analytics.toolIdentityCoverage", "Unknown means no usable identity was captured, including older records, unsupported source signals or redaction. Command titles are never used to guess a tool name.")}</p>
        </> : <p className="analytics-note">{t("analytics.toolMeaning", "Labels and kinds come from captured tool updates. A label may describe a command rather than a stable tool name.")}</p>}
        {selections.some(selection => selection.filter === null) && <p className="analytics-note">{t("analytics.longLabels", "Some labels exceed the filter length limit. Use evidence type or thread filters for those calls.")}</p>}
        {state.value.tools.length === 0 ? <p>{t("analytics.noTools", "No linked tool calls were captured.")}</p> :
          <div className="analytics-table-scroll"><table><thead><tr>
            {[stableTools ? "analytics.toolName" : "analytics.label", ...(stableTools ? ["analytics.identityType"] : []), "analytics.kind", "analytics.calls", "analytics.completed", "analytics.failed", "analytics.pending", "analytics.inProgress", "analytics.statusUnknown"].map(key => <th key={key} scope="col">{t(key as WebMessageKey)}</th>)}
          </tr></thead><tbody>{selections.map(({ tool, filter }) => <tr key={"key" in tool ? tool.key : JSON.stringify([tool.name, tool.kind])}>
            <th scope="row"><button type="button" className="analytics-link" disabled={filter === null} onClick={() => filter !== null && onFilter({ metric: "tools", tool: filter, ...(query.thread ? { thread: query.thread } : {}) })}>{toolName(tool)}</button></th>
            {stableTools && <td>{toolIdentityType(tool)}</td>}
            <td>{tool.kind === "unknown" ? t("analytics.unknown", "Unknown") : tool.kind}</td><td>{formatNumber(tool.calls)}</td><td>{formatNumber(tool.completed)}</td>
            <td><button type="button" className="analytics-link" disabled={filter === null} onClick={() => filter !== null && onFilter({ metric: "failed_tools", tool: filter, ...(query.thread ? { thread: query.thread } : {}) })} aria-label={t("analytics.failedFor", "Failed calls: {label}", { label: toolName(tool) })}>{formatNumber(tool.failed)}</button></td>
            <td>{formatNumber(tool.pending)}</td><td>{formatNumber(tool.inProgress)}</td>
            <td><button type="button" className="analytics-link" disabled={filter === null} onClick={() => filter !== null && onFilter({ metric: "unknown_tools", tool: filter, ...(query.thread ? { thread: query.thread } : {}) })} aria-label={t("analytics.unknownFor", "Calls with unknown status: {label}", { label: toolName(tool) })}>{formatNumber(tool.unknown)}</button></td>
          </tr>)}</tbody></table></div>}
      </section>
      <CapabilityReports report={state.value.analyticsVersion !== 1 ? state.value.capabilities : undefined} {...(query.thread ? { thread: query.thread } : {})} onFilter={onFilter} />
      <section aria-labelledby={`${id}-usage`}>
        <h2 id={`${id}-usage`}>{t("analytics.recordedTokens", "Recorded tokens")}</h2>
        <p>{t("analytics.samples", "{recorded} recorded samples · {incomplete} incomplete samples · {samples} usage events", {
          recorded: state.value.usage.tokens.recordedSamples, incomplete: state.value.usage.tokens.incompleteSamples, samples: state.value.usage.samples })}</p>
        <Tokens value={state.value.usage.tokens} />
        <p className="analytics-note">{t("analytics.tokenMeaning", "Unknown means a counter was not reported for every usage sample. Zero is a reported value. Cache counters may overlap input tokens; no cost is estimated.")}</p>
        {state.value.usage.models.length > 0 && <div className="analytics-models">{state.value.usage.models.map(model => <section key={model.model}>
          <h3>{model.model === "unknown" ? t("analytics.unknownModel", "Model unknown") : model.model}</h3>
          <p>{t("analytics.modelSamples", "{count} usage samples", { count: model.samples })}</p><Tokens value={model.tokens} />
        </section>)}</div>}
      </section>
      <section aria-labelledby={`${id}-threads`}>
        <h2 id={`${id}-threads`}>{t("analytics.threads", "Captured threads")}</h2>
        <div className="analytics-table-scroll"><table><thead><tr>
          {["analytics.thread", "analytics.parent", "analytics.captureColumn", "analytics.events", "analytics.toolCalls", "analytics.recordedTokens"].map(key => <th key={key} scope="col">{t(key as WebMessageKey)}</th>)}
        </tr></thead><tbody>{state.value.threads.map(thread => <tr key={thread.id}>
          <th scope="row"><button type="button" className="analytics-link" onClick={() => onFilter({ metric: "threads", thread: thread.id })}>{thread.label}</button></th>
          <td>{thread.parentThreadId ? state.value.threads.find(parent => parent.id === thread.parentThreadId)?.label ?? thread.parentThreadId : "—"}</td>
          <td>{capture(thread.captureStatus)}</td><td>{formatNumber(thread.eventCount)}</td><td>{formatNumber(thread.toolCalls)}</td><td>{token(thread.tokens.total)}</td>
        </tr>)}</tbody></table></div>
      </section>
      <section aria-labelledby={`${id}-evidence`} className="analytics-evidence">
        <h2 id={`${id}-evidence`}>{t("analytics.evidence", "Evidence")}</h2>
        <div className="analytics-filters">
          <label>{t("analytics.evidenceType", "Evidence type")}<select aria-label={t("analytics.evidenceType", "Evidence type")} value={query.metric ?? "tools"} onChange={event => onFilter({ metric: event.currentTarget.value as SessionAnalyticsMetric, ...(query.thread ? { thread: query.thread } : {}) })}>
            {metrics.filter(([metric]) => (state.value.analyticsVersion !== 1 || !["mcp_tools", "skills"].includes(metric)) &&
              (metric !== "records" || state.value.analyticsVersion === 3 || state.value.analyticsVersion === 4)).map(([metric, label]) => <option key={metric} value={metric}>{t(label)}</option>)}
          </select></label>
          <label>{t("analytics.thread", "Thread")}<select aria-label={t("analytics.thread", "Thread")} value={query.thread ?? ""} onChange={event => onFilter({ ...query, thread: event.currentTarget.value })}>
            <option value="">{t("analytics.allThreads", "All threads")}</option>{state.value.threads.map(thread => <option key={thread.id} value={thread.id}>{thread.label}</option>)}
          </select></label>
          {!["mcp_tools", "skills"].includes(query.metric ?? "tools") && <label>{toolFilterLabel}<select aria-label={toolFilterLabel} value={query.tool ?? ""} disabled={!["tools", "failed_tools", "unknown_tools"].includes(query.metric ?? "tools")} onChange={event => onFilter({ ...query, tool: event.currentTarget.value })}>
            <option value="">{stableTools ? t("analytics.allToolNames", "All tools") : t("analytics.allTools", "All labels")}</option>{selections.filter(({ filter }, index, all) => filter !== null && all.findIndex(item => item.filter === filter) === index).map(({ tool, filter }) => <option key={filter} value={filter!}>{stableTools ? `${toolName(tool)} · ${tool.kind} · ${toolIdentityType(tool)}` : toolName(tool)}</option>)}
          </select></label>}
          {state.value.analyticsVersion !== 1 && ["mcp_tools", "skills"].includes(query.metric ?? "tools") && <>
            {query.metric === "mcp_tools" && <label>{t("analytics.mcpServer", "MCP server")}<select aria-label={t("analytics.mcpServer", "MCP server")} value={query.server ?? ""}
              onChange={event => { const { capability: _capability, ...selection } = query; onFilter({ ...selection, server: event.currentTarget.value }) }}>
              <option value="">{t("analytics.allServers", "All servers")}</option>
              {[...new Set(state.value.capabilities.mcp.map(item => item.server))].filter(canFilterSessionAnalyticsTool).map(server => <option key={server} value={server}>{server}</option>)}
            </select></label>}
            <label>{t("analytics.capabilityName", "Name")}<select aria-label={t("analytics.capabilityName", "Name")} value={query.capability ?? ""}
              onChange={event => onFilter({ ...query, capability: event.currentTarget.value })}>
              <option value="">{t("analytics.allCapabilities", "All names")}</option>
              {[...new Set((query.metric === "mcp_tools" ? state.value.capabilities.mcp.filter(item => !query.server || item.server === query.server) : state.value.capabilities.skills).map(item => item.name))]
                .filter(canFilterSessionAnalyticsTool).map(name => <option key={name} value={name}>{name}</option>)}
            </select></label>
          </>}
        </div>
        {state.value.evidence.items.length === 0 ? <p>{t("analytics.noEvidence", "No evidence matches these filters.")}</p> :
          <ol className="analytics-evidence-list">{state.value.evidence.items.map(item => {
            const target = { snapshot: state.value.snapshot, ...(state.value.head ? { head: state.value.head } : {}), threadId: item.threadId, eventId: item.eventId }
            return <li key={JSON.stringify([item.threadId, item.eventId])}><a href={evidenceHref(target)} onClick={event => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault(); onOpenEvidence(target)
            }}>{item.label || t("analytics.openEvent", "Open event")}</a>
              <span>{state.value.threads.find(thread => thread.id === item.threadId)?.label ?? item.threadId} · <ConversationTime value={item.occurredAt} options={{ dateStyle: "medium", timeStyle: "short" }} /></span>
              {"clockQuality" in item && <span className="analytics-clock-quality">{t(`analytics.clockQuality.${item.clockQuality}`)}</span>}
            </li>
          })}</ol>}
        <nav className="analytics-pages" aria-label={t("analytics.evidencePages", "Evidence pages")}>
          <Button variant="ghost" disabled={!query.cursor} onClick={onFirst}>{t("analytics.firstEvidence", "First evidence page")}</Button>
          <Button disabled={!state.value.evidence.nextCursor} onClick={onNext}>{t("analytics.nextEvidence", "Next evidence page")}</Button>
        </nav>
      </section>
    </>}
  </section>
}

export function SessionAnalyticsPanel({ sessionId, ...navigation }: Navigation & { readonly sessionId: string }) {
  const presenter = useSessionAnalyticsPresenter(sessionId)
  return <SessionAnalyticsView {...navigation} state={presenter.state} query={presenter.query}
    onReload={presenter.reload} onFilter={presenter.filter} onNext={presenter.next} onFirst={presenter.first} />
}
