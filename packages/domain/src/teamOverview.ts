import { Schema } from "effect"

const Count = Schema.NullOr(Schema.Number)
export const OverviewTokens = Schema.Struct({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count, total: Count, records: Schema.Number, sessions: Schema.Number })
export const OverviewMetrics = Schema.Struct({ members: Schema.Number, activeMembers: Schema.Number, projects: Schema.Number, sessions: Schema.Number, messages: Schema.Number, tokens: OverviewTokens })
export const OverviewOption = Schema.Struct({ id: Schema.String, name: Schema.String, current: Schema.Boolean })
export const OverviewDetail = Schema.Struct({ id: Schema.String, name: Schema.String, current: Schema.Boolean, sessions: Schema.Number, projects: Schema.Number, tokens: OverviewTokens })
export const OverviewSession = Schema.Struct({ id: Schema.String, projectId: Schema.String, projectName: Schema.String, memberId: Schema.String, memberName: Schema.String, agent: Schema.String, title: Schema.String, updatedAt: Schema.String, input: Schema.String, output: Schema.String, tokens: OverviewTokens })
const OverviewPageFields = {
  teamId: Schema.String, teamName: Schema.String, timezone: Schema.String, from: Schema.String, to: Schema.String, updatedAt: Schema.String,
  metrics: OverviewMetrics, previous: OverviewMetrics,
  options: Schema.Struct({ projects: Schema.Array(OverviewOption), members: Schema.Array(OverviewOption), agents: Schema.Array(Schema.String), models: Schema.Array(Schema.String) }),
  sessions: Schema.Array(OverviewSession), totalSessions: Schema.Number, page: Schema.Number, limit: Schema.Number, unknownTimeSessions: Schema.Number
}
export const TeamOverviewSessionPage = Schema.Struct(OverviewPageFields)
export type TeamOverviewSessionPage = typeof TeamOverviewSessionPage.Type
export const TeamOverview = Schema.Struct({
  ...OverviewPageFields,
  trend: Schema.Array(Schema.Struct({ date: Schema.String, agent: Schema.String, sessions: Schema.Number, members: Schema.Number, tokens: OverviewTokens })),
  members: Schema.Array(OverviewDetail), projects: Schema.Array(OverviewDetail), models: Schema.Array(OverviewDetail)
})
export type TeamOverview = typeof TeamOverview.Type
export type OverviewTokens = typeof OverviewTokens.Type
export type OverviewSession = typeof OverviewSession.Type
export type OverviewQuery = { readonly days: number; readonly from: string; readonly to: string; readonly project: string; readonly member: string; readonly agent: string; readonly model: string; readonly page: number }
export type OverviewSelection = OverviewQuery & { readonly view: "overview" | "members" | "activeMembers" | "projects" | "sessions" | "usage"; readonly metric: "sessions" | "tokens" | "members" }
export const overviewSelection = (search: Record<string, unknown>): OverviewSelection => ({
  days: [7, 30, 90].includes(Number(search.days)) ? Number(search.days) : 30,
  from: typeof search.from === "string" ? search.from.slice(0, 10) : "",
  to: typeof search.to === "string" ? search.to.slice(0, 10) : "",
  project: typeof search.project === "string" ? search.project.slice(0, 500) : "",
  member: typeof search.member === "string" ? search.member.slice(0, 500) : "",
  agent: typeof search.agent === "string" ? search.agent.slice(0, 200) : "",
  model: typeof search.model === "string" ? search.model.slice(0, 200) : "",
  page: Math.max(0, Math.min(100000, Math.floor(Number(search.page) || 0))),
  view: ["members", "activeMembers", "projects", "sessions", "usage"].includes(String(search.view)) ? search.view as OverviewSelection["view"] : "overview",
  metric: search.metric === "tokens" || search.metric === "members" ? search.metric : "sessions"
})

// Current members with no activity still appear, with unknown recorded usage.
export const overviewMemberDetails = (data: Pick<TeamOverview, "options" | "members">): ReadonlyArray<typeof OverviewDetail.Type> => {
  const activity = new Map(data.members.map(row => [row.id, row]))
  return data.options.members.filter(member => member.current).map(member => activity.get(member.id) ?? {
    ...member, sessions: 0, projects: 0,
    tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, records: 0, sessions: 0 }
  })
}
