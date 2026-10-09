import { Context, Effect, Schema, type Scope } from "effect"
import { decodeReleaseBundle, releaseBundleFingerprint, type ReleaseBundle } from "@atape/domain"
import { officialSources } from "@atape/adapter-catalog"
import { AutomaticUpdatePlatform } from "./automaticUpdates.ts"
import { inspectClient } from "./clientManagement.ts"
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
  latest(cached: boolean): Effect.Effect<ReleaseBundle, CLIUpgradeError>
  installedVersion(): Effect.Effect<string, CLIUpgradeError>
  install(bundle: ReleaseBundle): Effect.Effect<void, CLIUpgradeError>
}>()("atape/application/CLIUpgradePlatform") {}

// Startup checking is optional. Neither an offline registry nor a corrupt cache
// may prevent the user from opening ATape. Development builds never check npm.
export const checkCLIUpgrade = Effect.fn("CLIUpgrade.check")(function*(current: string) {
  if (!stableVersion(current)) return undefined
  const platform = yield* CLIUpgradePlatform
  return yield* platform.latest(true).pipe(
    Effect.flatMap(decodeBundle),
    Effect.flatMap(bundle => newer(current, bundle.version) ? Effect.succeed(undefined) :
      newer(bundle.version, current) ? Effect.succeed(bundle.version) : platform.installedVersion().pipe(
        Effect.map(installed => stableVersion(installed) && newer(bundle.version, installed) ? bundle.version : undefined))),
    Effect.catch(() => Effect.succeed(undefined))
  )
})

export const upgradeCLI = Effect.fn("CLIUpgrade.upgrade")(function*(current: string) {
  if (!stableVersion(current)) return yield* new CLIUpgradeError({ reason: "installation",
    message: "Run upgrade from an installed ATape release. Development builds cannot upgrade themselves." })
  const platform = yield* CLIUpgradePlatform
  const bundle = yield* platform.latest(false).pipe(Effect.flatMap(decodeBundle))
  const version = bundle.version, fingerprint = releaseBundleFingerprint(bundle)
  yield* platform.acquireOwnership()
  if (newer(current, version)) return { version: current, updated: false, resumed: yield* refreshManagedCollector() }
  const installed = yield* platform.installedVersion()
  if (!stableVersion(installed)) return yield* new CLIUpgradeError({ reason: "installation", message: "The installed command entry has an invalid release version." })
  if (newer(installed, version)) return yield* new CLIUpgradeError({ reason: "installation", message: `ATape ${installed} is already installed. Reopen ATape and check versions again.` })
  const config = yield* inspectClient().pipe(Effect.mapError(() => new CLIUpgradeError({ reason: "installation", message: "Could not read the installed Adapter configuration." })))
  const adapters = config.adapters.filter(adapter => adapter.upgradeSpec === adapter.packageName &&
    officialSources.some(source => source.id === adapter.adapterId && source.packageName === adapter.packageName))
  if (adapters.some(adapter => !stableVersion(adapter.version) || newer(adapter.version, version))) {
    return yield* new CLIUpgradeError({ reason: "installation", message: "An official Adapter is ahead of this release. Reopen ATape and check versions again." })
  }
  const updateRuntime = config.toolsConfigured && (newer(version, current) || adapters.some(adapter => adapter.version !== version))
  const updateEntry = newer(version, installed)
  if (!updateRuntime && !updateEntry) return { version: current, updated: false, resumed: yield* refreshManagedCollector() }
  const process = yield* CollectorDaemonProcess
  const running = yield* process.inspect()
  if (updateRuntime) {
    const updates = yield* AutomaticUpdatePlatform
    const prepared = yield* updates.prepare(bundle, adapters).pipe(Effect.mapError(error => new CLIUpgradeError({
      reason: "install", message: `The complete ATape release could not be prepared. ${error.message}`
    })))
    const matches = yield* Effect.try({ try: () => releaseBundleFingerprint(decodeReleaseBundle(prepared.bundle)) === fingerprint && prepared.key.length > 0,
      catch: () => new CLIUpgradeError({ reason: "install", message: "The prepared release bundle is invalid." }) })
    if (!matches) return yield* new CLIUpgradeError({ reason: "install", message: "The prepared release differs from the selected bundle." })
    yield* updates.activate(prepared, false).pipe(Effect.mapError(error => new CLIUpgradeError({
      reason: "install", message: `The complete ATape release could not be activated. ${error.message}`
    })))
  }
  if (updateEntry) yield* platform.install(bundle).pipe(Effect.mapError(error => updateRuntime ? new CLIUpgradeError({
    reason: error.reason,
    message: `ATape ${version} runtime is selected, but the global command entry could not be refreshed. Retry the CLI update. ${error.message}`
  }) : error))
  if (running && updateEntry) {
    // Once installation succeeds, finish the bounded pause/resume handoff even if
    // Ctrl+C arrives, so cancellation cannot strand a previously running sync.
    return yield* resumeOwnedCLIUpgrade({ version, intervalMs: running.intervalMs, concurrency: running.concurrency })
  }
  return { version, updated: true, resumed: Boolean(running && (yield* process.inspect())) }
}, Effect.scoped)

const decodeBundle = (value: ReleaseBundle) => Effect.try({
  try: () => decodeReleaseBundle(value),
  catch: () => new CLIUpgradeError({ reason: "check", message: "The complete ATape release descriptor is invalid. Try again later." })
})

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
