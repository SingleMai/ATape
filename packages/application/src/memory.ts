import type { Conversation, ProjectMemory } from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export class MemoryGatewayError extends Schema.TaggedError<MemoryGatewayError>()("MemoryGatewayError", {
  reason: Schema.Literals(["transport", "http", "decode"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number)
}) {}

// MemoryGateway is the remote-owned Seam between the browser application and
// the ATape server. Production HTTP and deterministic test Adapters make this
// a real Seam.
export class MemoryGateway extends Context.Service<MemoryGateway, {
  openProject(projectId: string): Effect.Effect<ProjectMemory, MemoryGatewayError>
  openConversation(sessionId: string, threadId: string): Effect.Effect<Conversation, MemoryGatewayError>
}>()("atape/application/MemoryGateway") {}

export const openProjectMemory = Effect.fn("Memory.openProject")(function*(projectId: string) {
  const gateway = yield* MemoryGateway
  return yield* gateway.openProject(projectId).pipe(
    Effect.withSpan("Memory.openProject", { attributes: { projectId } })
  )
})

export const openConversation = Effect.fn("Memory.openConversation")(function*(
  sessionId: string,
  threadId: string
) {
  const gateway = yield* MemoryGateway
  return yield* gateway.openConversation(sessionId, threadId).pipe(
    Effect.withSpan("Memory.openConversation", { attributes: { sessionId, threadId } })
  )
})
