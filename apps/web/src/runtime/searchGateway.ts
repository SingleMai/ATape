import { SearchGateway, SearchGatewayError } from "@atape/application"
import { SearchPage as SearchPageSchema } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"

class HttpFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const requestJSON = (path: string): Effect.Effect<unknown, SearchGatewayError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(path, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) {
        throw new HttpFailure(response.status, `ATape Search returned ${response.status}.`)
      }
      return response.json() as Promise<unknown>
    },
    catch: (cause) => cause instanceof HttpFailure
      ? new SearchGatewayError({ reason: "http", message: cause.message, status: cause.status })
      : new SearchGatewayError({
        reason: "transport",
        message: cause instanceof Error ? cause.message : "ATape Search is unavailable."
      })
  })

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
