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
export class SearchGateway extends Context.Service<
  SearchGateway,
  {
    search(request: SearchRequest): Effect.Effect<SearchPage, SearchGatewayError>
  }
>()("atape/application/SearchGateway") {}

export const searchProject = Effect.fn("Search.searchProject")(function* (request: SearchRequest) {
  const gateway = yield* SearchGateway
  return yield* gateway.search(request).pipe(
    Effect.withSpan("Search.searchProject", {
      attributes: { projectId: request.projectId, query: request.query }
    })
  )
})

export type SearchProjectScope = {
  readonly teamId: string
  readonly teamName: string
  readonly projectId: string
  readonly projectName: string
}

export type WorkspaceSearchRequest = {
  readonly projects: ReadonlyArray<SearchProjectScope>
  readonly query: string
  // Absent means the first page; present means only these Projects continue.
  readonly cursors?: Readonly<Record<string, string>>
}

export type WorkspaceSearchResult = SearchPage["results"][number] & SearchProjectScope
export type WorkspaceSearchPage = {
  readonly query: string
  readonly results: ReadonlyArray<WorkspaceSearchResult>
  readonly nextCursors: Readonly<Record<string, string>>
}

export const searchWorkspace = Effect.fn("Search.searchWorkspace")(function* (
  request: WorkspaceSearchRequest
) {
  const query = request.query.trim()
  if (!query) return { query, results: [], nextCursors: {} } satisfies WorkspaceSearchPage
  const projects = request.projects.filter(
    (project) => request.cursors === undefined || Object.hasOwn(request.cursors, project.projectId)
  )
  const pages = yield* Effect.forEach(
    projects,
    (project) =>
      searchProject({
        projectId: project.projectId,
        query,
        ...(request.cursors?.[project.projectId] ? { cursor: request.cursors[project.projectId] } : {})
      }).pipe(Effect.map((page) => ({ project, page }))),
    { concurrency: 4 }
  )
  return {
    query,
    results: pages.flatMap(({ project, page }) => page.results.map((result) => ({ ...result, ...project }))),
    nextCursors: Object.fromEntries(
      pages.flatMap(({ project, page }) => (page.nextCursor ? [[project.projectId, page.nextCursor]] : []))
    )
  } satisfies WorkspaceSearchPage
})
