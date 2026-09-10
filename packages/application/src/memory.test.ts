import type { Conversation, ProjectMemory } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { MemoryGateway, openProjectMemory, openConversation } from "./memory"

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

const page: Conversation = {
 session: { id:"session",projectId:"project",title:"Title",actor:{name:"User",harness:"OpenCode"},branch:"main",status:"ended",captureStatus:"complete",updatedAt:"2026-09-04T00:00:00Z" },
 thread: { id:"root",label:"Root",captureStatus:"complete" },threadPath:[],events:[],head:"head-a",nextEventId:"event-99"
}

describe("versioned conversation reads", () => {
 it("passes the continuation through the remote Seam and returns a single page", async () => {
  const layer = Layer.succeed(MemoryGateway, MemoryGateway.of({
   openProject: () => Effect.succeed(project),
   openConversation: (_session,_thread,request) => {
    expect(request).toEqual({head:"head-a",after:"event-98"})
    return Effect.succeed(page)
   }
  }))
  expect(await Effect.runPromise(openConversation("session","root",{head:"head-a",after:"event-98"}).pipe(Effect.provide(layer)))).toEqual(page)
 })
 it("rejects a continuation response from a different selected head", async () => {
  const layer = Layer.succeed(MemoryGateway,MemoryGateway.of({openProject:()=>Effect.succeed(project),openConversation:()=>Effect.succeed(page)}))
  const error = await Effect.runPromise(openConversation("session","root",{head:"head-old",after:"event-98"}).pipe(Effect.provide(layer),Effect.flip))
  expect(error.code).toBe("refresh_required")
 })
})
