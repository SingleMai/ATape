import type { OverviewDetail, OverviewSelection, OverviewSession, OverviewTokens, TeamOverview } from "@atape/domain"
import { Button } from "@atape/ui"
import { useState } from "react"
import type { useOverviewPresenter } from "../presenters/overviewPresenter"

type Props = { readonly presenter: ReturnType<typeof useOverviewPresenter>; readonly selection: OverviewSelection;
  readonly onChange: (patch: Partial<OverviewSelection>) => void; readonly onOpenSession: (session: OverviewSession) => void }
const number = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value)
const exact = (value: number | null) => value === null ? "Not provided" : value.toLocaleString("en")
const agentClass = (agent: string) => /claude/i.test(agent) ? "claude" : /codex/i.test(agent) ? "codex" : "other"
const Arrow = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
const Tape = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="5" /><circle cx="9" cy="11" r="2" /><circle cx="15" cy="11" r="2" /><path d="M8 16h8" /></svg>
function TokenBreakdown({ tokens }: { readonly tokens: OverviewTokens }) {
  return <dl className="overview-token-breakdown">{([
    ["Input", tokens.input], ["Output", tokens.output], ["Cache read", tokens.cacheRead], ["Cache write", tokens.cacheWrite]
  ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={exact(value)}>{number(value)}</dd></div>)}</dl>
}
function Comparison({ current, previous }: { readonly current: number | null; readonly previous: number | null }) {
  if (current === null || previous === null) return <small>Reported usage</small>
  if (previous === 0) return <small>{current === 0 ? "No change" : "No prior baseline"}</small>
  const change = (current - previous) / previous * 100
  return <small>{change > 0 ? "+" : ""}{change.toFixed(0)}% <span>vs previous period</span></small>
}
export function TeamOverviewView({ presenter: p, selection: s, onChange, onOpenSession }: Props) {
  const [custom, setCustom] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [dates, setDates] = useState({ from: s.from, to: s.to })
  if (p.state._tag === "Loading") return <section className="team-overview" aria-busy="true"><h1>Team overview</h1><p role="status">Loading team activity…</p></section>
  if (p.state._tag === "Failed") return <section className="state-card" role="alert"><h1>Team overview is unavailable</h1><p>{p.state.message}</p><Button onClick={p.reload}>Try again</Button><Button variant="secondary" onClick={() => onChange({ days: 7, from: "", to: "", page: 0 })}>Use last 7 days</Button></section>
  const data = p.state.value
  const metrics = [
    { label: "Team members", value: data.metrics.members, previous: null, view: "members" },
    { label: "Active members", value: data.metrics.activeMembers, previous: data.previous.activeMembers, view: "activeMembers" },
    { label: "Active projects", value: data.metrics.projects, previous: data.previous.projects, view: "projects" },
    { label: "Sessions", value: data.metrics.sessions, previous: data.previous.sessions, view: "sessions" },
    { label: "User messages", value: data.metrics.messages, previous: data.previous.messages, view: "sessions" },
    { label: "Tokens", value: data.metrics.tokens.total, previous: data.previous.tokens.total, view: "usage" }
  ] as const
  const update = (patch: Partial<OverviewSelection>) => onChange({ ...patch, page: 0 })
  const filters = [
    ["Project", "project", data.options.projects.map(v => [v.id, `${v.name}${v.current ? "" : " · Archived"}`])],
    ["Member", "member", data.options.members.map(v => [v.id, `${v.name}${v.current ? "" : " · Left team"}`])],
    ["Agent", "agent", data.options.agents.map(v => [v, v])],
    ["Model", "model", data.options.models.map(v => [v, v === "__unknown__" ? "Unknown model" : v])]
  ] as const
  const activeFilters = filters.filter(([, key]) => s[key])
  return <section className="team-overview" aria-labelledby="team-overview-title">
    <header className="overview-heading"><div><p className="overview-team-name">{data.teamName}</p><h1 id="team-overview-title">Overview</h1></div>
      <div className="overview-period"><label><span className="sr-only">Time range</span><select aria-label="Time range" value={custom || s.from ? "custom" : s.days} onChange={event => {
        if (event.target.value === "custom") { setDates({ from: s.from || data.from, to: s.to || data.to }); setCustom(true) }
        else { setCustom(false); update({ days: Number(event.target.value), from: "", to: "" }) }
      }}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></label>
        <button type="button" className="overview-filter-toggle" aria-expanded={filtersOpen} aria-controls="overview-filter-panel" onClick={() => setFiltersOpen(!filtersOpen)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></svg>
          Filters{activeFilters.length > 0 && <span className="overview-filter-count">{activeFilters.length}</span>}
        </button>
        <button type="button" className="overview-refresh" aria-label="Refresh" disabled={p.state.refreshing} title={`Updated ${new Date(data.updatedAt).toLocaleTimeString("en", { timeZone: data.timezone, hour: "2-digit", minute: "2-digit" })} · Refresh`} onClick={p.reload}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.4 7a8 8 0 0 1 13-1L20 8M4 16l1.6 2a8 8 0 0 0 13-1" /></svg>
        </button>
      </div>
    </header>
    <div className="overview-context"><span>{data.from} — {data.to} · {data.timezone}</span></div>
    {custom && <form className="overview-custom-range" onSubmit={event => { event.preventDefault(); update({ from: dates.from, to: dates.to }); setCustom(false) }}>
      <label>From<input required type="date" value={dates.from} onChange={event => setDates({ ...dates, from: event.target.value })} /></label>
      <label>To<input required type="date" min={dates.from} value={dates.to} onChange={event => setDates({ ...dates, to: event.target.value })} /></label><Button type="submit">Apply dates</Button>
    </form>}
    {filtersOpen && <div id="overview-filter-panel" className="overview-filters" role="region" aria-label="Overview filters">{filters.map(([label, key, choices]) => <label key={key}><span>{label}</span><select aria-label={label} value={s[key]} onChange={event => update({ [key]: event.target.value })}><option value="">All {label.toLowerCase()}s</option>{choices.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>)}</div>}
    {activeFilters.length > 0 && <div className="overview-active-filters" aria-label="Applied filters">
      {activeFilters.map(([label, key, choices]) => {
        const name = choices.find(([id]) => id === s[key])?.[1] ?? s[key]
        return <button type="button" key={key} aria-label={`Remove ${label.toLowerCase()} filter: ${name}`} title={`${label}: ${name}`} onClick={() => update({ [key]: "" })}><span>{label}: {name}</span><span aria-hidden="true">×</span></button>
      })}
      <button type="button" className="overview-clear-filters" onClick={() => update({ project: "", member: "", agent: "", model: "" })}>Clear all</button>
    </div>}
    {p.state.refreshFailure && <p className="overview-notice" role="alert">{p.state.refreshFailure} Showing the last successful update.</p>}
    <div className="overview-metrics">{metrics.map(metric => <div className="overview-metric" key={metric.label}>
      <button type="button" onClick={() => update({ view: metric.view })}><span>{metric.label}</span><Arrow /><strong title={exact(metric.value)}>{number(metric.value)}</strong></button>
      {metric.label === "Team members" ? <small>Current membership</small> : <Comparison current={metric.value} previous={metric.previous} />}
    </div>)}<div className="overview-usage-summary"><span>Token breakdown</span><TokenBreakdown tokens={data.metrics.tokens} /></div></div>
    <p className="overview-coverage">Based on captured conversations. Token records available in {data.metrics.tokens.sessions} of {data.metrics.sessions} sessions; this does not guarantee complete usage.
      {data.unknownTimeSessions > 0 && ` ${data.unknownTimeSessions} sessions contain unknown activity times.`}</p>
    {s.view === "overview" ? <>
      <section className="overview-chart-section" aria-labelledby="overview-usage-title"><header className="overview-section-heading"><h2 id="overview-usage-title">Usage</h2><select aria-label="Chart metric" value={s.metric} onChange={event => onChange({ metric: event.target.value as OverviewSelection["metric"] })}><option value="sessions">Sessions</option><option value="tokens">Tokens</option><option value="members">Active members</option></select></header>
        {s.metric === "tokens" && <TokenBreakdown tokens={data.metrics.tokens} />}
        <UsageChart data={data} metric={s.metric} onSelect={(date, agent) => update({ from: date, to: date, agent, view: "sessions" })} />
      </section>
      <section className="overview-recent" aria-labelledby="overview-recent-title"><header className="overview-section-heading"><h2 id="overview-recent-title">Recent sessions</h2><button type="button" onClick={() => update({ view: "sessions" })}>Open sessions <span aria-hidden="true">→</span></button></header>
        {p.hasNewConversations && <Button variant="secondary" onClick={p.acceptConversations}>Show updated conversations</Button>}
        <SessionGrid rows={p.rows} onOpen={onOpenSession} />
      </section>
    </> : <section className="overview-detail"><header className="overview-section-heading"><div><button type="button" className="overview-back" onClick={() => update({ view: "overview" })}>← Overview</button><h2>{({ members: "Team members", activeMembers: "Active members", projects: "Project activity", sessions: "Sessions", usage: "Token usage" } as const)[s.view]}</h2></div></header>
      {s.view === "sessions" ? <><SessionGrid rows={data.sessions} onOpen={onOpenSession} showUsage /><div className="overview-pagination"><span>{data.totalSessions} sessions · Page {data.page + 1}</span><Button variant="secondary" disabled={data.page === 0} onClick={() => onChange({ page: data.page - 1 })}>Previous</Button><Button variant="secondary" disabled={(data.page + 1) * data.limit >= data.totalSessions} onClick={() => onChange({ page: data.page + 1 })}>Next</Button></div></>
        : <DetailTable page={s.page} onPage={page => onChange({ page })} rows={s.view === "members" ? data.options.members.filter(m => m.current).map(m => data.members.find(v => v.id === m.id) ?? m) : s.view === "activeMembers" ? data.members : s.view === "projects" ? data.projects : data.models}
          onSelect={row => update({ ...(s.view === "members" || s.view === "activeMembers" ? { member: row.id } : s.view === "projects" ? { project: row.id } : { model: row.id }), view: "sessions" })} />}
      {s.view === "usage" && <p className="overview-coverage">Cache is included in input. Session counts across models overlap. Model names reflect the source-reported or configured model.</p>}
    </section>}
    {data.options.projects.length === 0 && <aside className="overview-empty"><h2>Bring in the first conversation</h2><p>Connect a local project to start building this Team’s shared history.</p><pre><code>npm install --global @atape/cli{"\n"}atape</code></pre></aside>}
  </section>
}

function UsageChart({ data, metric, onSelect }: { readonly data: TeamOverview; readonly metric: OverviewSelection["metric"]; readonly onSelect: (date: string, agent: string) => void }) {
  const agents = [...new Set(data.trend.map(v => v.agent))]
  const days: string[] = []
  for (let at = Date.parse(data.from + "T00:00:00Z"), end = Date.parse(data.to + "T00:00:00Z"); at <= end; at += 86400000) days.push(new Date(at).toISOString().slice(0, 10))
  const value = (row: TeamOverview["trend"][number]) => metric === "tokens" ? row.tokens.total : metric === "members" ? row.members : row.sessions
  const rows = new Map(data.trend.map(v => [`${v.date}:${v.agent}`, v]))
  const maximum = Math.max(1, ...data.trend.map(v => value(v) ?? 0))
  const unknown = metric === "tokens" && data.metrics.tokens.total === null
  return <>
    <div className="overview-legend">{agents.map(agent => <span key={agent}><i className={agentClass(agent)} />{agent}</span>)}</div>
    {data.trend.length === 0 || unknown && data.metrics.tokens.records === 0 ? <div className="overview-chart-empty">{unknown ? "Token usage has not been reported for this selection." : "No captured activity in this period."}</div> : <div className="overview-chart-scroll"><div className="overview-chart" style={{ minWidth: days.length > 35 ? days.length * 24 : undefined }}>
      <div className="overview-chart-axis"><span>{number(maximum)}</span><span>{number(Math.floor(maximum / 2))}</span><span>0</span></div>
      <div className="overview-chart-bars">{days.map((day, index) => <div className="overview-chart-day" key={day}><div className="overview-day-bars">{agents.map(agent => {
        const row = rows.get(`${day}:${agent}`), amount = row ? value(row) : 0
        if (amount === 0) return <span key={agent} className="overview-chart-zero" />
        return <button type="button" key={agent} className={`overview-chart-bar ${agentClass(agent)}${amount === null ? " overview-chart-unknown" : ""}`} style={{ height: amount === null ? "18px" : `${amount / maximum * 100}%` }}
          aria-label={`${day}, ${agent}: ${exact(amount)} ${metric}. Open sessions.`} title={`${day} · ${agent}: ${exact(amount)}`} onClick={() => onSelect(day, agent)} />
      })}</div><span className="overview-date-label">{index === 0 || index === days.length - 1 || index % Math.max(1, Math.ceil(days.length / 7)) === 0 ? day.slice(5) : ""}</span></div>)}</div>
    </div></div>}
    <details className="overview-chart-data"><summary>View exact chart values</summary><div className="overview-table-scroll"><table><thead><tr><th>Date</th><th>Agent</th><th>Sessions</th><th>Members</th><th>Tokens</th></tr></thead><tbody>{data.trend.map(row => <tr key={`${row.date}:${row.agent}`}><td><button type="button" onClick={() => onSelect(row.date, row.agent)}>{row.date}</button></td><td>{row.agent}</td><td>{exact(row.sessions)}</td><td>{exact(row.members)}</td><td>{exact(row.tokens.total)}</td></tr>)}</tbody></table></div></details>
  </>
}
function SessionGrid({ rows, onOpen, showUsage = false }: { readonly rows: ReadonlyArray<OverviewSession>; readonly onOpen: (row: OverviewSession) => void; readonly showUsage?: boolean }) {
  if (rows.length === 0) return <p className="overview-empty">No conversations match this selection.</p>
  return <div className="overview-session-grid">{rows.map(row => <article className="overview-session" key={row.id}><header><span className={`overview-agent-mark ${agentClass(row.agent)}`} title={row.agent}><Tape /></span><button type="button" onClick={() => onOpen(row)}>{row.title || "Untitled conversation"}</button></header>
    <p className="overview-session-meta">{row.memberName} · {row.projectName} · {row.agent} <time dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "Asia/Singapore" })}</time></p>
    <p className="overview-preview"><span aria-label="Input">→</span><span>{row.input || "No user input preview"}</span></p><p className="overview-preview overview-output"><span aria-label="Output">←</span><span>{row.output || "Awaiting a reply"}</span></p>
    {showUsage && <TokenBreakdown tokens={row.tokens} />}
  </article>)}</div>
}
function DetailTable({ rows, onSelect, page, onPage }: { readonly rows: ReadonlyArray<typeof OverviewDetail.Type>; readonly onSelect: (row: typeof OverviewDetail.Type) => void; readonly page: number; readonly onPage: (page: number) => void }) {
  const visible = rows.slice(page * 25, (page + 1) * 25)
  return <><div className="overview-table-scroll"><table><thead><tr><th>Name</th><th>Sessions</th><th>Projects</th><th>Tokens</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr></thead><tbody>{visible.map(row => <tr key={row.id}><td><button type="button" onClick={() => onSelect(row)}>{row.name}</button>{!row.current && <small> · Left team</small>}</td><td>{exact(row.sessions)}</td><td>{exact(row.projects)}</td><td>{exact(row.tokens.total)}</td><td>{exact(row.tokens.input)}</td><td>{exact(row.tokens.output)}</td><td>{exact(row.tokens.cacheRead)}</td><td>{exact(row.tokens.cacheWrite)}</td></tr>)}</tbody></table>{rows.length === 0 && <p className="overview-empty">No activity matches this selection.</p>}</div>
    {(rows.length > 25 || page > 0) && <div className="overview-pagination"><span>{rows.length} results · Page {page + 1}</span><Button variant="secondary" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</Button><Button variant="secondary" disabled={(page + 1) * 25 >= rows.length} onClick={() => onPage(page + 1)}>Next</Button></div>}</>
}
