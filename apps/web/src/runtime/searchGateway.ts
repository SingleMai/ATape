import { SearchGateway, SearchGatewayError } from "@atape/application"
import { SearchPage as SearchPageSchema } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { BrowserHTTPError, browserRequest } from "./http"

const requestJSON = (path: string): Effect.Effect<unknown, SearchGatewayError> =>
  browserRequest(path).pipe(Effect.mapError((cause: BrowserHTTPError) => new SearchGatewayError({
    reason: cause.reason === "transport" ? "transport" : cause.reason === "decode" ? "decode" : "http",
    message: cause.message,
    ...(cause.status === undefined ? {} : { status: cause.status })
  })))

const decodeSearchPage = (payload: unknown) =>
  Schema.decodeUnknownEffect(SearchPageSchema)(payload).pipe(
    Effect.mapError(() => new SearchGatewayError({
      reason: "decode",
      message: "The Search response did not match the ATape protocol."
    }))
  )

export const BrowserSearchGatewayLayer = Layer.succeed(
  SearchGateway,
  SearchGateway.of({
    search: ({ projectId, query, cursor }) => {
      const params = new URLSearchParams({ q: query })
      if (cursor) params.set("cursor", cursor)
      return requestJSON(`/api/v1/projects/${encodeURIComponent(projectId)}/search?${params}`).pipe(
        Effect.flatMap(decodeSearchPage)
      )
    }
  })
)
