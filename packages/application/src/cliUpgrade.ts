import { Context, Effect, Schema } from "effect"
import { CollectorDaemonProcess } from "./collectorDaemon.ts"
import { stableVersion, newer } from "./releaseVersion.ts"

const CLIUpgradeRecovery = Schema.Struct({ version: Schema.String, intervalMs: Schema.Number, concurrency: Schema.Number })

export class CLIUpgradeError extends Schema.TaggedError<CLIUpgradeError>()("CLIUpgradeError", {
  reason: Schema.Literals(["check", "installation", "install", "resume"]),
  message: Schema.String,
  recovery: Schema.optional(CLIUpgradeRecovery)
}) {}

// npm distribution and local installation ownership form the external Seam.
export class CLIUpgradePlatform extends Context.Service<CLIUpgradePlatform, {
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
  if (!newer(version, current)) return { version: current, updated: false, resumed: false }
  const process = yield* CollectorDaemonProcess
  const running = yield* process.inspect()
  // Install and verify first: failed acquisition must not stop existing sync.
  yield* platform.install(version)
  if (running) {
    // Once installation succeeds, finish the bounded stop/start handoff even if
    // Ctrl+C arrives, so cancellation cannot strand a previously running sync.
    return yield* resumeCLIUpgrade({ version, intervalMs: running.intervalMs, concurrency: running.concurrency })
  }
  return { version, updated: true, resumed: Boolean(running) }
})

// The recovery receipt retains the pre-upgrade intent across failed stop/start
// attempts. Retrying it never queries npm or reinstalls the CLI.
export const resumeCLIUpgrade = Effect.fn("CLIUpgrade.resume")(function*(recovery: typeof CLIUpgradeRecovery.Type) {
  const process = yield* CollectorDaemonProcess
  yield* process.stop().pipe(
    Effect.andThen(process.start({ intervalMs: recovery.intervalMs, concurrency: recovery.concurrency })),
    Effect.uninterruptible,
    Effect.mapError(() => new CLIUpgradeError({ reason: "resume", recovery,
      message: `ATape ${recovery.version} is installed, but sync could not resume. Retry resuming sync or open ATape with the same ATAPE_HOME and select Start sync.` }))
  )
  return { version: recovery.version, updated: true, resumed: true }
})
