import type { RawContentPage, SessionRawArchive } from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export class RawGatewayError extends Schema.TaggedError<RawGatewayError>()("RawGatewayError", {
  reason: Schema.Literals(["transport", "http", "decode"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number)
}) {}

// RawGateway is deliberately separate from MemoryGateway: opening a Canonical
// conversation never fetches Raw manifests or bytes.
export class RawGateway extends Context.Service<RawGateway, {
  listSession(sessionId: string): Effect.Effect<SessionRawArchive, RawGatewayError>
  readContent(input: {
    readonly objectId: string
    readonly generation: number
    readonly cursor: string
  }): Effect.Effect<RawContentPage, RawGatewayError>
}>()("atape/application/RawGateway") {}

export const listSessionRaw = Effect.fn("Raw.listSession")(function*(sessionId: string) {
  const gateway = yield* RawGateway
  return yield* gateway.listSession(sessionId).pipe(
    Effect.withSpan("Raw.listSession", { attributes: { sessionId } })
  )
})

export const readRawContent = Effect.fn("Raw.readContent")(function*(input: {
  readonly objectId: string
  readonly generation: number
  readonly cursor?: string
}) {
  const gateway = yield* RawGateway
  return yield* gateway.readContent({
    objectId: input.objectId,
    generation: input.generation,
    cursor: input.cursor ?? ""
  }).pipe(
    Effect.withSpan("Raw.readContent", {
      attributes: { objectId: input.objectId, generation: input.generation }
    })
  )
})
