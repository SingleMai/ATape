import type { OverviewQuery, TeamOverview } from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export class OverviewError extends Schema.TaggedError<OverviewError>()("OverviewError", {
  reason: Schema.Literals(["transport", "http", "decode"]), message: Schema.String, status: Schema.optionalKey(Schema.Number)
}) {}
export class OverviewGateway extends Context.Service<OverviewGateway, {
  open(teamId: string, query: OverviewQuery): Effect.Effect<TeamOverview, OverviewError>
}>()("atape/application/OverviewGateway") {}
export const openTeamOverview = Effect.fn("TeamOverview.open")(function*(teamId: string, query: OverviewQuery) {
  const gateway = yield* OverviewGateway
  return yield* gateway.open(teamId, query)
})
