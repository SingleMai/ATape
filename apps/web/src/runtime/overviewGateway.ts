import { OverviewError, OverviewGateway } from "@atape/application"
import type { OverviewQuery } from "@atape/domain"
import { TeamOverview, TeamOverviewSessionPage } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { browserRequest } from "./http"

const request = (teamId: string, query: OverviewQuery, sessionsOnly: boolean) => {
  const params = new URLSearchParams({ options: "compact" })
  for (const [key, value] of Object.entries(query)) if (value !== "") params.set(key, String(value))
  return browserRequest(`/api/v1/teams/${encodeURIComponent(teamId)}/overview${sessionsOnly ? "/sessions" : ""}?${params}`).pipe(
    Effect.mapError(error => new OverviewError({ reason: error.reason === "transport" ? "transport" : error.reason === "decode" ? "decode" : "http",
      message: error.status === 422 ? "This range is invalid or too large. Choose a shorter date range." : error.message,
      ...(error.status === undefined ? {} : { status: error.status }) }))
  )
}
const decodeError = () => new OverviewError({ reason: "decode", message: "The Team overview response could not be read safely." })
export const BrowserOverviewGatewayLayer = Layer.succeed(OverviewGateway, OverviewGateway.of({
  open: (teamId, query) => request(teamId, query, false).pipe(
    Effect.flatMap(value => Schema.decodeUnknownEffect(TeamOverview)(value).pipe(Effect.mapError(decodeError)))
  ),
  openSessions: (teamId, query) => request(teamId, query, true).pipe(
    Effect.flatMap(value => Schema.decodeUnknownEffect(TeamOverviewSessionPage)(value).pipe(Effect.mapError(decodeError)))
  )
}))
