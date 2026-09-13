import type { OverviewQuery, TeamOverview, TeamOverviewSessionPage } from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export class OverviewError extends Schema.TaggedError<OverviewError>()("OverviewError", {
  reason: Schema.Literals(["transport", "http", "decode"]), message: Schema.String, status: Schema.optionalKey(Schema.Number)
}) {}
export class OverviewGateway extends Context.Service<OverviewGateway, {
  open(teamId: string, query: OverviewQuery): Effect.Effect<TeamOverview, OverviewError>
  openSessions(teamId: string, query: OverviewQuery): Effect.Effect<TeamOverviewSessionPage, OverviewError>
}>()("atape/application/OverviewGateway") {}
export const openTeamOverview = Effect.fn("TeamOverview.open")(function*(teamId: string, query: OverviewQuery) {
  const gateway = yield* OverviewGateway
  return yield* gateway.open(teamId, query)
})

export const openTeamOverviewSessions = Effect.fn("TeamOverview.openSessions")(function*(teamId: string, query: OverviewQuery) {
  const gateway = yield* OverviewGateway
  return yield* gateway.openSessions(teamId, query).pipe(
    // Older Servers do not expose the additive page route. The fallback still
    // performs an authorized read; revoked Teams cannot reuse cached data.
    Effect.catch(error => error.status === 404
      ? gateway.open(teamId, query).pipe(Effect.map(({ trend: _trend, members: _members, projects: _projects, models: _models, ...page }) => page))
      : Effect.fail(error))
  )
})
