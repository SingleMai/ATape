import { Context, Effect, Schema, type Scope } from "effect"
import { CollectorDaemonProcess, refreshManagedCollector } from "./collectorDaemonProcess.ts"
import { stableVersion, newer } from "./releaseVersion.ts"

const CLIUpgradeRecovery = Schema.Struct({ version: Schema.String, intervalMs: Schema.Number, concurrency: Schema.Number })

export class CLIUpgradeError extends Schema.TaggedError<CLIUpgradeError>()("CLIUpgradeError", {
  reason: Schema.Literals(["check", "installation", "install", "resume"]),
  message: Schema.String,
  recovery: Schema.optional(CLIUpgradeRecovery)
}) {}

// npm distribution and local installation ownership form the external Seam.
export class CLIUpgradePlatform extends Context.Service<CLIUpgradePlatform, {
  // Hold this resource across installation and Collector handoff. Version
  // lookups are read-only and need no ownership.
  acquireOwnership(): Effect.Effect<void, CLIUpgradeError, Scope.Scope>
  latest(cached: boolean): Effect.Effect<string, CLIUpgradeError>
  install(version: string): Effect.Effect<void, CLIUpgradeError>
}>()("atape/application/CLIUpgradePlatform") {}

// Startup checking is optional. Neither an offline registry nor a corrupt cache
// may prevent the user from opening ATape. Development builds never check npm.
export const checkCLIUpgrade = Effect.fn("CLIUpgrade.check")(function*(current: string) {
  if (!stableVersion(current)) return undefined
  return yield* (yield* CLIUpgradePlatform).latest(true).pipe(
    Effect.map(latest => newer(latest, current) ? latest : undefined),
    Effect.catch(() => Effect.succeed(undefined))
  )
})

export const upgradeCLI = Effect.fn("CLIUpgrade.upgrade")(function*(current: string) {
  if (!stableVersion(current)) return yield* new CLIUpgradeError({ reason: "installation",
    message: "Run upgrade from an installed ATape release. Development builds cannot upgrade themselves." })
  const platform = yield* CLIUpgradePlatform
  const version = yield* platform.latest(false)
  if (!stableVersion(version)) return yield* new CLIUpgradeError({ reason: "check", message: "npm returned an invalid ATape version. Try again later." })
  yield* platform.acquireOwnership()
  if (!newer(version, current)) return { version: current, updated: false, resumed: yield* refreshManagedCollector() }
  const process = yield* CollectorDaemonProcess
  const running = yield* process.inspect()
  // Install and verify first: failed acquisition must not stop existing sync.
  yield* platform.install(version)
  if (running) {
    // Once installation succeeds, finish the bounded pause/resume handoff even if
    // Ctrl+C arrives, so cancellation cannot strand a previously running sync.
    return yield* resumeOwnedCLIUpgrade({ version, intervalMs: running.intervalMs, concurrency: running.concurrency })
  }
  return { version, updated: true, resumed: Boolean(running) }
}, Effect.scoped)

// The receipt identifies the installed upgrade, not permission to start sync.
// Durable Collector intent wins on every retry, including a later user Stop.
export const resumeCLIUpgrade = Effect.fn("CLIUpgrade.resume")(function*(recovery: typeof CLIUpgradeRecovery.Type) {
  yield* (yield* CLIUpgradePlatform).acquireOwnership().pipe(Effect.mapError(error => new CLIUpgradeError({
    reason: "resume", recovery, message: `ATape ${recovery.version} is installed, but sync could not resume. ${error.message}`
  })))
  return yield* resumeOwnedCLIUpgrade(recovery)
}, Effect.scoped)

const resumeOwnedCLIUpgrade = (recovery: typeof CLIUpgradeRecovery.Type) => Effect.gen(function*() {
  const process = yield* CollectorDaemonProcess
  const resumed = yield* process.pause().pipe(
    Effect.andThen(process.resume()),
    Effect.uninterruptible,
    Effect.mapError(() => new CLIUpgradeError({ reason: "resume", recovery,
      message: `ATape ${recovery.version} is installed, but sync could not resume. Retry resuming sync or open ATape with the same ATAPE_HOME and select Start sync.` }))
  )
  return { version: recovery.version, updated: true, resumed: Boolean(resumed) }
})
