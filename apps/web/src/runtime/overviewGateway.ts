import { OverviewError, OverviewGateway } from "@atape/application"
import { TeamOverview } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { browserRequest } from "./http"

export const BrowserOverviewGatewayLayer = Layer.succeed(OverviewGateway, OverviewGateway.of({
  open: (teamId, query) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== "") params.set(key, String(value))
    return browserRequest(`/api/v1/teams/${encodeURIComponent(teamId)}/overview?${params}`).pipe(
      Effect.mapError(error => new OverviewError({ reason: error.reason === "transport" ? "transport" : error.reason === "decode" ? "decode" : "http",
        message: error.status === 422 ? "This range is invalid or too large. Choose a shorter date range." : error.message,
        ...(error.status === undefined ? {} : { status: error.status }) })),
      Effect.flatMap(value => Schema.decodeUnknownEffect(TeamOverview)(value).pipe(
        Effect.mapError(() => new OverviewError({ reason: "decode", message: "The Team overview response could not be read safely." }))
      ))
    )
  }
}))
