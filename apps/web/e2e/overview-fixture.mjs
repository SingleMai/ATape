// Controlled Web protocol Adapter. Production metrics are exercised separately
// against both Canonical memory and real PostgreSQL stores.
export function overviewFixture(team, params, { revision = 0, empty = false } = {}) {
  const tokens = { input: 12480000, output: 1640000, cacheRead: 9820000, cacheWrite: 720000, total: 14120000, records: 540, sessions: 112 }
  const noTokens = { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, records: 0, sessions: 0 }
  const current = new Date("2026-09-10T00:00:00Z")
  const end = params.get("to") || current.toISOString().slice(0, 10)
  const start = params.get("from") || new Date(Date.parse(end) - (Number(params.get("days") || 30) - 1) * 86400000).toISOString().slice(0, 10)
  const summary = { members: empty ? 1 : 12, activeMembers: empty ? 0 : 8, projects: empty ? 0 : 6, sessions: empty ? 0 : 126, messages: empty ? 0 : 842, tokens: empty ? noTokens : tokens }
  const detail = (id, name, sessions, current = true) => ({ id, name, current, sessions, projects: 2, tokens: sessions ? tokens : noTokens })
  const members = [detail("user-1", "Mai", 48), detail("user-2", "Rin", 32), detail("former", "Alex", 12, false)]
  const projects = [detail(team.id === "created-team" ? "created-project" : "project-1", team.id === "created-team" ? "Captured Project" : "ATape", 68), detail("project-2", "Website", 35), detail("project-3", "SDK", 23)]
  const trend = []
  for (let at = Date.parse(start), i = 0; at <= Date.parse(end); at += 86400000, i++) {
    if (empty) break
    for (const [j, agent] of ["Codex", "Claude Code"].entries()) {
      const sessions = Math.round((Math.sin(i * 1.7 + j) + 1.5) * 3 + i / 3)
      trend.push({ date: new Date(at).toISOString().slice(0, 10), agent, sessions, members: Math.min(8, Math.ceil(sessions / 3)), tokens: { ...tokens, input: sessions * 10000, output: sessions * 1000, cacheRead: sessions * 7000, cacheWrite: sessions * 500, total: sessions * 11000 } })
    }
  }
  const page = Number(params.get("page") || 0), totalSessions = empty ? 0 : 24
  const titles = ["Conversation hierarchy", "排查通知中心关闭延迟", "完善项目搜索与会话定位", "Review authentication boundaries", "修复后台采集重试", "Improve the conversation reader"]
  const sessions = Array.from({ length: Math.min(10, Math.max(0, totalSessions - page * 10)) }, (_, i) => {
    const index = page * 10 + i
    return { id: index === 0 ? "session-reader" : `overview-${index}`, projectId: "project-1", projectName: "ATape", memberId: "user-1", memberName: index % 2 ? "Rin" : "Mai", agent: index % 2 ? "Claude Code" : "Codex", title: revision && index === 0 ? "New conversation arrived" : titles[index % titles.length], updatedAt: new Date(Date.parse(end) + 3600000 - index * 360000 + revision * 1000).toISOString(), input: index % 2 ? "帮我检查关闭流程，并确认退出动画的执行顺序。" : "Review the latest implementation and verify the behavior through its public interface.", output: index % 2 ? "已修复关闭延迟，相关验证通过。" : "The change is verified and ready for review.", tokens }
  })
  return { teamId: team.id, teamName: team.displayName, timezone: "Asia/Singapore", from: start, to: end, updatedAt: new Date(Date.parse(end) + 3600000 + revision * 1000).toISOString(), metrics: summary, previous: { ...summary, activeMembers: 6, sessions: 107, messages: 752 }, trend: params.get("agent") ? trend.filter(row => row.agent === params.get("agent")) : trend,
    options: { projects: empty ? [] : projects, members, agents: ["Codex", "Claude Code"], models: ["model-a", "model-b"] }, members: empty ? [] : members, projects: empty ? [] : projects, models: empty ? [] : [detail("model-a", "model-a", 80), detail("model-b", "model-b", 62)], sessions, totalSessions, page, limit: 10, unknownTimeSessions: 0 }
}
