import type { SessionAnalytics, SessionAnalyticsQuery } from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export class SessionAnalyticsGatewayError extends Schema.TaggedError<SessionAnalyticsGatewayError>()("SessionAnalyticsGatewayError", {
  reason: Schema.Literals(["transport", "http", "decode"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  code: Schema.optionalKey(Schema.String)
}) {}

// Analytics is a separate Canonical read model. Reading it never opens Raw data
// or derives whole-session statistics from a paginated Reader response.
export class SessionAnalyticsGateway extends Context.Service<SessionAnalyticsGateway, {
  read(sessionId: string, query: SessionAnalyticsQuery): Effect.Effect<SessionAnalytics, SessionAnalyticsGatewayError>
}>()("atape/application/SessionAnalyticsGateway") {}

// The wire query has a smaller bound than captured display labels. Keep the
// complete label visible, but only offer a per-label filter that the API accepts.
export const canFilterSessionAnalyticsTool = (label: string): boolean =>
  new TextEncoder().encode(label).byteLength <= 500

export const readSessionAnalytics = Effect.fn("SessionAnalytics.read")(function*(sessionId: string, query: SessionAnalyticsQuery = {}) {
  if ((query.cursor !== undefined && !query.snapshot) ||
    (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100))) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 422,
      message: "Analytics pagination requires a snapshot and a valid page size." }))
  }
  const gateway = yield* SessionAnalyticsGateway
  const result = yield* gateway.read(sessionId, query)
  if (result.sessionId !== sessionId) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "decode",
      message: "The analytics response belongs to a different session." }))
  }
  if (query.snapshot !== undefined && result.snapshot !== query.snapshot) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 409, code: "refresh_required",
      message: "The conversation changed. Reload its analytics." }))
  }
  return result
})
