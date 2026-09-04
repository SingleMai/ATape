import type { SearchPage } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { SearchGateway, searchProject } from "./search"

const page: SearchPage = {
  projectId: "payments-api",
  query: "durable key",
  indexedThrough: "2026-09-04T10:59:30+08:00",
  results: [],
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
