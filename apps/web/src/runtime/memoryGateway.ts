import { MemoryGateway, MemoryGatewayError } from "@atape/application"
import {
  Conversation as ConversationSchema,
  ProjectMemory as ProjectMemorySchema
} from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { BrowserHTTPError, browserRequest } from "./http"

const requestJSON = (path: string): Effect.Effect<unknown, MemoryGatewayError> =>
  browserRequest(path).pipe(Effect.mapError((cause: BrowserHTTPError) => new MemoryGatewayError({
    reason: cause.reason === "transport" ? "transport" : cause.reason === "decode" ? "decode" : "http",
    message: cause.message,
    ...(cause.status === undefined ? {} : { status: cause.status })
  })))

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
