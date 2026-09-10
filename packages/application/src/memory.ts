import type { Conversation, ProjectMemory } from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export class MemoryGatewayError extends Schema.TaggedError<MemoryGatewayError>()("MemoryGatewayError", {
  reason: Schema.Literals(["transport", "http", "decode"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  code: Schema.optionalKey(Schema.String)
}) {}

// MemoryGateway is the remote-owned Seam between the browser application and
// the ATape server. Production HTTP and deterministic test Adapters make this
// a real Seam.
export type ConversationPageRequest = {
  readonly head?: string
  readonly after?: string
  readonly at?: string
}

export class MemoryGateway extends Context.Service<MemoryGateway, {
  openProject(projectId: string): Effect.Effect<ProjectMemory, MemoryGatewayError>
  openConversation(sessionId: string, threadId: string, page?: ConversationPageRequest): Effect.Effect<Conversation, MemoryGatewayError>
}>()("atape/application/MemoryGateway") {}

export const openProjectMemory = Effect.fn("Memory.openProject")(function*(projectId: string) {
  const gateway = yield* MemoryGateway
  return yield* gateway.openProject(projectId).pipe(
    Effect.withSpan("Memory.openProject", { attributes: { projectId } })
  )
})

export const openConversation = Effect.fn("Memory.openConversation")(function*(
  sessionId: string,
  threadId: string,
  page: ConversationPageRequest = {}
) {
  const gateway = yield* MemoryGateway
  const value = yield* gateway.openConversation(sessionId, threadId, page).pipe(
    Effect.withSpan("Memory.openConversation", { attributes: { sessionId, threadId } })
  )
  // Never accept a continuation from a different head, even from an older or
  // misconfigured server. Pages replace each other; they are never accumulated.
  if ((page.head !== undefined && value.head !== page.head) ||
      (value.nextEventId !== undefined && value.head === undefined)) {
    return yield* Effect.fail(new MemoryGatewayError({ reason: "http", status: 409,
      code: "refresh_required", message: "The conversation changed. Reload it before continuing." }))
  }
  return value
})
