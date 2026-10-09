import { Context, Effect, Schema } from "effect"
import { ClientConfigStore, inspectClient, loginStartupEnabled } from "./clientManagement.ts"
import { resumeManagedCollector } from "./collectorDaemon.ts"

export class LoginStartupError extends Schema.TaggedError<LoginStartupError>()("LoginStartupError", {
  reason: Schema.Literals(["unsupported", "manager", "registration", "identity", "state"]),
  message: Schema.String
}) {}

export type LoginStartupRegistration = {
  readonly state: "registered" | "missing" | "unsupported" | "unavailable"
  readonly message?: string
}

// Native user managers are the external Seam. Callers never construct service
// files, inspect PIDs or infer installation success from the saved preference.
export class LoginStartupPlatform extends Context.Service<LoginStartupPlatform, {
  inspect(): Effect.Effect<LoginStartupRegistration, LoginStartupError>
  reconcile(enabled: boolean): Effect.Effect<LoginStartupRegistration, LoginStartupError>
}>()("atape/application/LoginStartupPlatform") {}

export const inspectLoginStartup = Effect.fn("LoginStartup.inspect")(function*() {
  const config = yield* inspectClient()
  const registration = yield* (yield* LoginStartupPlatform).inspect().pipe(
    Effect.catch(error => Effect.succeed({ state: "unavailable" as const, message: error.message }))
  )
  return { enabled: loginStartupEnabled(config), ...registration }
})

export const reconcileLoginStartup = Effect.fn("LoginStartup.reconcile")(function*() {
  const config = yield* inspectClient()
  return yield* (yield* LoginStartupPlatform).reconcile(config.toolsConfigured && loginStartupEnabled(config))
})

export const setLoginStartup = Effect.fn("LoginStartup.set")(function*(enabled: boolean) {
  const store = yield* ClientConfigStore
  // Persist off before unregistering so an already queued OS entry is inert.
  // Failed native work retains the preference and an observable repair state.
  yield* store.transact(config => Effect.succeed(config.autoStartEnabled === enabled
    ? { value: enabled }
    : { value: enabled, config: { ...config, autoStartEnabled: enabled } }))
  return yield* reconcileLoginStartup()
})

// Registration identity and pending-handoff recovery are admitted at the Node
// executable boundary before this local, noninteractive Application operation.
export const runLoginStartup = Effect.fn("LoginStartup.run")(function*() {
  const config = yield* inspectClient()
  if (!config.toolsConfigured || !loginStartupEnabled(config)) return { resumed: false }
  const running = yield* resumeManagedCollector()
  return { resumed: running !== undefined }
})
