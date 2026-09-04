import { RawGateway, RawGatewayError } from "@atape/application"
import {
  RawContentPage as RawContentPageSchema,
  SessionRawArchive as SessionRawArchiveSchema
} from "@atape/domain"
import { Effect, Layer, Schema } from "effect"

class HttpFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const requestJSON = (path: string): Effect.Effect<unknown, RawGatewayError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(path, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) {
        throw new HttpFailure(response.status, `ATape Raw Archive returned ${response.status}.`)
      }
      return response.json() as Promise<unknown>
    },
    catch: (cause) => cause instanceof HttpFailure
      ? new RawGatewayError({ reason: "http", message: cause.message, status: cause.status })
      : new RawGatewayError({
        reason: "transport",
        message: cause instanceof Error ? cause.message : "The Raw Archive is unavailable."
      })
  })

const decodeArchive = (payload: unknown) =>
  Schema.decodeUnknownEffect(SessionRawArchiveSchema)(payload).pipe(
    Effect.mapError(() => new RawGatewayError({
      reason: "decode",
      message: "The Raw manifest response did not match the ATape protocol."
    }))
  )

const decodeContent = (payload: unknown) =>
  Schema.decodeUnknownEffect(RawContentPageSchema)(payload).pipe(
    Effect.mapError(() => new RawGatewayError({
      reason: "decode",
      message: "The Raw content response did not match the ATape protocol."
    }))
  )

export const BrowserRawGatewayLayer = Layer.succeed(RawGateway, RawGateway.of({
  listSession: (sessionId) =>
    requestJSON(`/api/v1/sessions/${encodeURIComponent(sessionId)}/raw`).pipe(
      Effect.flatMap(decodeArchive)
    ),
  readContent: ({ objectId, generation, cursor }) => {
    const query = new URLSearchParams({ generation: String(generation), limit: "4" })
    if (cursor) query.set("cursor", cursor)
    return requestJSON(`/api/v1/raw-objects/${encodeURIComponent(objectId)}/content?${query}`).pipe(
      Effect.flatMap(decodeContent)
    )
  }
}))
