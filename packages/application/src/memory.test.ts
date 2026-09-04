import type { ProjectMemory } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { MemoryGateway, openProjectMemory } from "./memory"

const project: ProjectMemory = {
  project: { id: "payments-api", teamId: "acme", name: "payments-api", type: "git" },
  capturedThrough: "2026-09-04T10:52:18+08:00",
  active: [],
  trail: []
}

const testLayer = Layer.succeed(
  MemoryGateway,
  MemoryGateway.of({
    openProject: () => Effect.succeed(project),
    openConversation: () => Effect.die("not used by this test")
  })
)

describe("Memory Module", () => {
  it("opens project memory through the Gateway Seam", async () => {
    const result = await openProjectMemory("payments-api").pipe(
      Effect.provide(testLayer),
      Effect.runPromise
    )

    expect(result.project.id).toBe("payments-api")
  })
})
