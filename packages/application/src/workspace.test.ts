import type { Workspace } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { WorkspaceGateway, openWorkspace } from "./workspace"

const workspace: Workspace = {
  teams: [{
    id: "acme",
    slug: "acme",
    name: "Acme Engineering",
    role: "owner",
    projects: [{
      id: "payments-api",
      name: "payments-api",
      type: "git",
      repositoryLinkState: "linked",
      sessionCount: 3,
      activeSessionCount: 2
    }]
  }]
}

describe("Workspace Module", () => {
  it("opens the directory through its Gateway Seam", async () => {
    const layer = Layer.succeed(
      WorkspaceGateway,
      WorkspaceGateway.of({ open: () => Effect.succeed(workspace) })
    )
    const result = await openWorkspace().pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.teams[0]?.projects[0]?.type).toBe("git")
  })
})
