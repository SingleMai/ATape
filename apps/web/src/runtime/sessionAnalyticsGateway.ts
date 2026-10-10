import { SessionAnalyticsGateway, SessionAnalyticsGatewayError } from "@atape/application"
import { SessionAnalytics } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { browserRequest } from "./http"

export const BrowserSessionAnalyticsGatewayLayer = Layer.succeed(SessionAnalyticsGateway, SessionAnalyticsGateway.of({
  read: (sessionId, input) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) query.set(key, String(value))
    }
    const suffix = query.size ? `?${query}` : ""
    return browserRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}/analytics${suffix}`).pipe(
      Effect.mapError(cause => new SessionAnalyticsGatewayError({
        reason: cause.reason, message: cause.message,
        ...(cause.status === undefined ? {} : { status: cause.status }),
        ...(cause.code === undefined ? {} : { code: cause.code })
      })),
      Effect.flatMap(payload => Schema.decodeUnknownEffect(SessionAnalytics)(payload).pipe(
        Effect.mapError(() => new SessionAnalyticsGatewayError({ reason: "decode",
          message: "The analytics response did not match the ATape protocol." }))
      ))
    )
  }
}))
