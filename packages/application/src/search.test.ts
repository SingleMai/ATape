import type { SearchPage } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { SearchGateway, SearchGatewayError, searchProject, searchWorkspace } from "./search"

const page: SearchPage = {
  projectId: "payments-api",
  query: "durable key",
  indexedThrough: "2026-09-04T10:59:30+08:00",
  results: []
}

describe("Search Module", () => {
  it("queries the Search Gateway through the application operation", async () => {
    const layer = Layer.succeed(SearchGateway, SearchGateway.of({ search: () => Effect.succeed(page) }))
    const result = await searchProject({ projectId: "payments-api", query: "durable key" }).pipe(
      Effect.provide(layer),
      Effect.runPromise
    )

    expect(result.query).toBe("durable key")
  })
})

const scopes = ["alpha", "beta"].map((id) => ({
  teamId: "team",
  teamName: "Team",
  projectId: id,
  projectName: id
}))

const hit = (eventId: string) => ({
  eventId,
  sessionId: "session",
  sessionTitle: "Fix startup",
  threadId: "root",
  threadPath: [],
  author: "User",
  harness: "Codex",
  occurredAt: "2026-09-08T00:00:00Z",
  text: "startup"
})

describe("Workspace Search", () => {
  it("preserves result provenance and continues only projects with remaining results", async () => {
    const requests: Array<{ projectId: string; cursor?: string }> = []
    const layer = Layer.succeed(
      SearchGateway,
      SearchGateway.of({
        search: (request) => {
          requests.push(request)
          return Effect.succeed({
            projectId: request.projectId,
            query: request.query,
            results: [hit(`${request.projectId}-${request.cursor ?? "first"}`)],
            ...(request.projectId === "beta" && !request.cursor ? { nextCursor: "second" } : {})
          })
        }
      })
    )
    const first = await searchWorkspace({ projects: scopes, query: "startup" }).pipe(
      Effect.provide(layer),
      Effect.runPromise
    )
    expect(first.results.map((result) => [result.projectId, result.eventId, result.teamId])).toEqual([
      ["alpha", "alpha-first", "team"],
      ["beta", "beta-first", "team"]
    ])
    expect(first.nextCursors).toEqual({ beta: "second" })
    const next = await searchWorkspace({
      projects: scopes,
      query: "startup",
      cursors: first.nextCursors
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(next.results.map((result) => result.eventId)).toEqual(["beta-second"])
    expect(next.nextCursors).toEqual({})
    expect(requests).toHaveLength(3)
  })

  it("does not turn an inaccessible project's failure into apparently complete results", async () => {
    const layer = Layer.succeed(
      SearchGateway,
      SearchGateway.of({
        search: ({ projectId, query }) =>
          projectId === "beta"
            ? Effect.fail(new SearchGatewayError({ reason: "http", message: "Not found", status: 404 }))
            : Effect.succeed({ projectId, query, results: [hit("a")] })
      })
    )
    const result = await searchWorkspace({ projects: scopes, query: "startup" }).pipe(
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise
    )
    expect(result._tag).toBe("Failure")
  })

  it("bounds concurrent requests for a large project directory", async () => {
    let running = 0,
      peak = 0
    const layer = Layer.succeed(
      SearchGateway,
      SearchGateway.of({
        search: ({ projectId, query }) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              running++
              peak = Math.max(peak, running)
            }),
            () => Effect.sleep("5 millis").pipe(Effect.as({ projectId, query, results: [] })),
            () =>
              Effect.sync(() => {
                running--
              })
          )
      })
    )
    await searchWorkspace({
      projects: Array.from({ length: 15 }, (_, i) => ({ ...scopes[0]!, projectId: String(i) })),
      query: "startup"
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
    expect(running).toBe(0)
  })
})
