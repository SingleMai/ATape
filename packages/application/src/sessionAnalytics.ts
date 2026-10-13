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

// The opaque v4/v5 row key selects identity and kind together. Older Servers
// select displayed labels and retain the original UTF-8 query bound.
export const sessionAnalyticsToolSelections = (report: SessionAnalytics): ReadonlyArray<{
  readonly tool: SessionAnalytics["tools"][number]
  readonly filter: string | null
}> => report.analyticsVersion === 4 || report.analyticsVersion === 5
  ? report.tools.map(tool => ({ tool, filter: tool.key }))
  : report.tools.map(tool => ({ tool, filter: canFilterSessionAnalyticsTool(tool.name) ? tool.name : null }))

export type SessionAnalyticsFilter = Pick<SessionAnalyticsQuery, "metric" | "thread" | "tool" | "capability" | "server" | "range" | "file" | "operation" | "tokenRange"> & {
  // Model is an independent report scope: omitted intents retain it, while
  // explicit null clears it. Null never enters the transport query.
  readonly model?: string | null
}

// Changing evidence selection clears incompatible filters and old ranges.
// Thread selection scopes activity, token activity and evidence. Model selection
// scopes token activity only. Summary, tools and legacy usage stay Session-wide.
export const selectSessionAnalyticsEvidence = (filter: SessionAnalyticsFilter, snapshot?: string,
  previous?: SessionAnalyticsQuery): SessionAnalyticsQuery => {
  const model = filter.model === undefined ? previous?.model : filter.model ?? undefined
  const sameScope = previous === undefined || (previous.thread ?? "") === (filter.thread ?? "") &&
    (previous.model ?? "") === (model ?? "") &&
    (previous.snapshot === undefined || previous.snapshot === snapshot)
  const tokenRange = filter.tokenRange && filter.metric === "token_records" && snapshot && sameScope
    ? filter.tokenRange : undefined
  const metric = filter.metric === "token_records" && tokenRange === undefined ? "records" : filter.metric ?? "tools"
  return {
    metric,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(filter.thread ? { thread: filter.thread } : {}),
    ...(model === undefined ? {} : { model }),
    ...(filter.tool && ["tools", "failed_tools", "unknown_tools"].includes(metric) ? { tool: filter.tool } : {}),
    ...(filter.capability && ["mcp_tools", "skills"].includes(metric) ? { capability: filter.capability } : {}),
    ...(filter.server && metric === "mcp_tools" ? { server: filter.server } : {}),
    ...(filter.file && metric === "files" ? { file: filter.file } : {}),
    ...(filter.operation && metric === "files" ? { operation: filter.operation } : {}),
    ...(filter.range && filter.metric === "records" && snapshot && sameScope ? { range: filter.range } : {}),
    ...(tokenRange === undefined ? {} : { tokenRange })
  }
}

export const readSessionAnalytics = Effect.fn("SessionAnalytics.read")(function*(sessionId: string, query: SessionAnalyticsQuery = {}) {
  if ((query.cursor !== undefined && !query.snapshot) ||
    (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100))) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 422,
      message: "Analytics pagination requires a snapshot and a valid page size." }))
  }
  if (query.model !== undefined && !/^model:[0-9a-f]{64}$/.test(query.model)) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 422,
      message: "Token activity requires a returned model key." }))
  }
  if ((query.tokenRange !== undefined || query.metric === "token_records") &&
    (!query.snapshot || query.metric !== "token_records" || query.tokenRange === undefined ||
      query.tokenRange.trim() === "" || new TextEncoder().encode(query.tokenRange).byteLength > 512 ||
      query.range !== undefined || query.tool !== undefined || query.capability !== undefined || query.server !== undefined ||
      query.file !== undefined || query.operation !== undefined)) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 422,
      message: "Token ranges require a snapshot and token records evidence without other evidence filters." }))
  }
  if (query.range !== undefined && (!query.snapshot || query.metric !== "records" || query.tool !== undefined ||
    query.capability !== undefined || query.server !== undefined || query.file !== undefined || query.operation !== undefined || query.range.trim() === "" ||
    new TextEncoder().encode(query.range).byteLength > 512)) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 422,
      message: "Activity ranges require a snapshot and records evidence without tool or capability filters." }))
  }
  if (((query.file !== undefined || query.operation !== undefined) && query.metric !== "files") ||
    (query.file !== undefined && !/^file:[0-9a-f]{64}$/.test(query.file)) ||
    (query.operation !== undefined && !["read", "edit", "search"].includes(query.operation)) ||
    (query.metric === "files" && (query.tool !== undefined || query.capability !== undefined || query.server !== undefined || query.range !== undefined))) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 422,
      message: "File evidence requires a returned file key and supported operation, without tool, capability or activity range filters." }))
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
  if (query.metric === "records" && result.analyticsVersion !== 3 && result.analyticsVersion !== 4 && result.analyticsVersion !== 5) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 422,
      message: "This Server does not provide records evidence. Reload its supported analysis." }))
  }
  if (query.metric === "files" && result.analyticsVersion !== 4 && result.analyticsVersion !== 5) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 422,
      message: "This Server does not provide file activity evidence. Reload its supported analysis." }))
  }
  if ((query.model !== undefined || query.metric === "token_records") && result.analyticsVersion !== 5) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "http", status: 422,
      message: "This Server does not provide token activity. Reload its supported analysis." }))
  }
  if ((result.analyticsVersion === 3 || result.analyticsVersion === 4 || result.analyticsVersion === 5) && result.activity.scopeThreadId !== (query.thread ?? null)) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "decode",
      message: "The activity response belongs to a different Thread scope." }))
  }
  if (result.analyticsVersion === 5 && (result.tokenActivity.scopeThreadId !== (query.thread ?? null) ||
    result.tokenActivity.scopeModelKey !== (query.model ?? null))) {
    return yield* Effect.fail(new SessionAnalyticsGatewayError({ reason: "decode",
      message: "The token activity response belongs to a different Thread or model scope." }))
  }
  return result
})
