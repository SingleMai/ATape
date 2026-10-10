import { Context, Effect, Schema } from "effect"
import { automaticUpdatesEnabled, inspectClient, setAutomaticUpdates } from "./clientManagement.ts"

export class UpdateWakeError extends Schema.TaggedError<UpdateWakeError>()("UpdateWakeError", {
  reason: Schema.Literals(["unsupported", "manager", "registration", "identity", "state"]),
  message: Schema.String
}) {}

export type UpdateWakeRegistration = {
  readonly state: "registered" | "missing" | "unsupported" | "unavailable"
  readonly message?: string
}

// Native scheduling is independent of collection and login-startup permission.
// The existing AutomaticUpdates Module remains the only owner of due policy.
export class UpdateWakePlatform extends Context.Service<UpdateWakePlatform, {
  inspect(): Effect.Effect<UpdateWakeRegistration, UpdateWakeError>
  reconcile(enabled: boolean): Effect.Effect<UpdateWakeRegistration, UpdateWakeError>
}>()("atape/application/UpdateWakePlatform") {}

export const inspectUpdateWake = Effect.fn("UpdateWake.inspect")(function*() {
  const config = yield* inspectClient()
  const registration = yield* (yield* UpdateWakePlatform).inspect().pipe(
    Effect.catch(error => Effect.succeed({ state: "unavailable" as const, message: error.message })))
  return { enabled: automaticUpdatesEnabled(config), ...registration }
})

export const reconcileUpdateWake = Effect.fn("UpdateWake.reconcile")(function*() {
  const config = yield* inspectClient()
  return yield* (yield* UpdateWakePlatform).reconcile(config.toolsConfigured && automaticUpdatesEnabled(config))
})

// Persist off before native unregister so a queued invocation cannot begin a
// new update even if the OS manager is temporarily unavailable.
export const configureAutomaticUpdates = Effect.fn("UpdateWake.configure")(function*(enabled: boolean) {
  yield* setAutomaticUpdates(enabled)
  return yield* reconcileUpdateWake()
})
