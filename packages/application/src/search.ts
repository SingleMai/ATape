import type { SearchPage } from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export class SearchGatewayError extends Schema.TaggedError<SearchGatewayError>()("SearchGatewayError", {
  reason: Schema.Literals(["transport", "http", "decode"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number)
}) {}

export type SearchRequest = {
  readonly projectId: string
  readonly query: string
  readonly cursor?: string
}

// SearchGateway is the remote-owned Seam. Search ranking, pagination, and
// index choice stay behind the server's Search Module.
export class SearchGateway extends Context.Service<SearchGateway, {
  search(request: SearchRequest): Effect.Effect<SearchPage, SearchGatewayError>
}>()("atape/application/SearchGateway") {}

export const searchProject = Effect.fn("Search.searchProject")(function*(request: SearchRequest) {
  const gateway = yield* SearchGateway
  return yield* gateway.search(request).pipe(
    Effect.withSpan("Search.searchProject", {
      attributes: { projectId: request.projectId, query: request.query }
    })
  )
})
