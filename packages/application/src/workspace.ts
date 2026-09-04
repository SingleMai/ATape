import type { Workspace } from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export class WorkspaceGatewayError extends Schema.TaggedError<WorkspaceGatewayError>()("WorkspaceGatewayError", {
  reason: Schema.Literals(["transport", "http", "decode"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number)
}) {}

export class WorkspaceGateway extends Context.Service<WorkspaceGateway, {
  open(): Effect.Effect<Workspace, WorkspaceGatewayError>
}>()("atape/application/WorkspaceGateway") {}

export const openWorkspace = Effect.fn("Workspace.open")(function*() {
  const gateway = yield* WorkspaceGateway
  return yield* gateway.open().pipe(Effect.withSpan("Workspace.open"))
})
