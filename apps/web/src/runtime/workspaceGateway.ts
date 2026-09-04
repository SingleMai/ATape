import { WorkspaceGateway, WorkspaceGatewayError } from "@atape/application"
import { Workspace as WorkspaceSchema } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"

class HttpFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const open = Effect.tryPromise({
  try: async () => {
    const response = await fetch("/api/v1/workspace", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) {
      throw new HttpFailure(response.status, `ATape server returned ${response.status}.`)
    }
    return response.json() as Promise<unknown>
  },
  catch: (cause) => cause instanceof HttpFailure
    ? new WorkspaceGatewayError({ reason: "http", message: cause.message, status: cause.status })
    : new WorkspaceGatewayError({
      reason: "transport",
      message: cause instanceof Error ? cause.message : "The Workspace directory is unavailable."
    })
}).pipe(
  Effect.flatMap((payload) => Schema.decodeUnknownEffect(WorkspaceSchema)(payload)),
  Effect.mapError((error) => error instanceof WorkspaceGatewayError
    ? error
    : new WorkspaceGatewayError({
      reason: "decode",
      message: "The Workspace response did not match the ATape protocol."
    }))
)

export const BrowserWorkspaceGatewayLayer = Layer.succeed(
  WorkspaceGateway,
  WorkspaceGateway.of({ open: () => open })
)
