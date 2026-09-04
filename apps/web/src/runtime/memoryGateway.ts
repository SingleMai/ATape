import { MemoryGateway, MemoryGatewayError } from "@atape/application"
import {
  Conversation as ConversationSchema,
  ProjectMemory as ProjectMemorySchema
} from "@atape/domain"
import { Effect, Layer, Schema } from "effect"

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const requestJSON = (path: string): Effect.Effect<unknown, MemoryGatewayError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(path, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) {
        throw new HttpFailure(response.status, `ATape server returned ${response.status}.`)
      }
      return response.json() as Promise<unknown>
    },
    catch: (cause) => {
      if (cause instanceof HttpFailure) {
        return new MemoryGatewayError({
          reason: "http",
          message: cause.message,
          status: cause.status
        })
      }
      return new MemoryGatewayError({
        reason: "transport",
        message: cause instanceof Error ? cause.message : "The ATape server is unavailable."
      })
    }
  })

const decodeProjectMemory = (payload: unknown) =>
  Schema.decodeUnknownEffect(ProjectMemorySchema)(payload).pipe(
    Effect.mapError(() => new MemoryGatewayError({
      reason: "decode",
      message: "The project memory response did not match the ATape protocol."
    }))
  )

const decodeConversation = (payload: unknown) =>
  Schema.decodeUnknownEffect(ConversationSchema)(payload).pipe(
    Effect.mapError(() => new MemoryGatewayError({
      reason: "decode",
      message: "The conversation response did not match the ATape protocol."
    }))
  )

export const BrowserMemoryGatewayLayer = Layer.succeed(
  MemoryGateway,
  MemoryGateway.of({
    openProject: (projectId) =>
      requestJSON(`/api/v1/projects/${encodeURIComponent(projectId)}/memory`).pipe(
        Effect.flatMap(decodeProjectMemory)
      ),
    openConversation: (sessionId, threadId) => {
      const query = new URLSearchParams({ thread: threadId })
      return requestJSON(`/api/v1/sessions/${encodeURIComponent(sessionId)}?${query}`).pipe(
        Effect.flatMap(decodeConversation)
      )
    }
  })
)
