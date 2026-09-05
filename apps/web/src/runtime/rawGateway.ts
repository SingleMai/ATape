import { RawGateway, RawGatewayError } from "@atape/application"
import {
  RawContentPage as RawContentPageSchema,
  SessionRawArchive as SessionRawArchiveSchema
} from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { BrowserHTTPError, browserRequest } from "./http"

const requestJSON = (path: string): Effect.Effect<unknown, RawGatewayError> =>
  browserRequest(path).pipe(Effect.mapError((cause: BrowserHTTPError) => new RawGatewayError({
    reason: cause.reason === "transport" ? "transport" : cause.reason === "decode" ? "decode" : "http",
    message: cause.message,
    ...(cause.status === undefined ? {} : { status: cause.status })
  })))

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
