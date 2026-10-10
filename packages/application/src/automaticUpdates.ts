import { officialSources } from "@atape/adapter-catalog"
import { decodeReleaseBundle, releaseBundleFingerprint, type AdapterInstallation, type ReleaseBundle } from "@atape/domain"
import { Clock, Context, Effect, Random, Schema, type Scope } from "effect"
import { automaticUpdatesEnabled, inspectClient } from "./clientManagement.ts"
import { newer, stableVersion } from "./releaseVersion.ts"

export class AutomaticUpdateError extends Schema.TaggedError<AutomaticUpdateError>()("AutomaticUpdateError", {
  reason: Schema.Literals(["unsupported", "release", "prepare", "handoff", "state", "cooldown"]),
  message: Schema.String
}) {}

export type PreparedAutomaticUpdate = {
  readonly bundle: ReleaseBundle
  readonly key: string
}

// The Node Adapter owns installation slots and process handoff; the Module
// owns eligibility, release selection, scheduling and policy revalidation.
export class AutomaticUpdatePlatform extends Context.Service<AutomaticUpdatePlatform, {
  recoveryPending(): Effect.Effect<boolean, AutomaticUpdateError>
  supported(): Effect.Effect<boolean, AutomaticUpdateError>
  schedule(): Effect.Effect<{ readonly nextCheckAt: number; readonly failures: number }, AutomaticUpdateError>
  target(): Effect.Effect<ReleaseBundle, AutomaticUpdateError>
  prepare(bundle: ReleaseBundle, adapters: ReadonlyArray<AdapterInstallation>, automatic: boolean): Effect.Effect<PreparedAutomaticUpdate, AutomaticUpdateError, Scope.Scope>
  activate(prepared: PreparedAutomaticUpdate, automatic: boolean): Effect.Effect<void, AutomaticUpdateError>
  record(input: { readonly nextCheckAt: number; readonly failures: number; readonly version?: string; readonly failure?: string }): Effect.Effect<void, AutomaticUpdateError>
  launch(): Effect.Effect<void, AutomaticUpdateError>
}>()("atape/application/AutomaticUpdatePlatform") {}

export type AutomaticUpdateResult = { readonly updated: boolean; readonly version?: string }

const Hour = 60 * 60 * 1_000
const validSchedule = (schedule: { readonly nextCheckAt: number; readonly failures: number }) =>
  Number.isFinite(schedule.nextCheckAt) && schedule.nextCheckAt >= 0 &&
  Number.isSafeInteger(schedule.failures) && schedule.failures >= 0
const readSettings = inspectClient().pipe(Effect.mapError(() => new AutomaticUpdateError({
  reason: "state", message: "Could not read automatic update settings."
})))

// Opening ATape dispatches a separately owned maintenance process. A failed
// dispatch is observable in the log and cannot prevent ordinary CLI use.
export const kickAutomaticUpdates = Effect.fn("AutomaticUpdates.kick")(() => Effect.gen(function*() {
  const platform = yield* AutomaticUpdatePlatform
  // Finishing an interrupted handoff restores local state; disabling future
  // updates must not leave collection admission closed by that earlier work.
  if (!(yield* platform.recoveryPending())) {
    const config = yield* readSettings
    if (!config.toolsConfigured || !automaticUpdatesEnabled(config)) return
    const schedule = yield* platform.schedule()
    if (!validSchedule(schedule)) return yield* new AutomaticUpdateError({ reason: "state", message: "The automatic update schedule is invalid." })
    if ((yield* Clock.currentTimeMillis) < schedule.nextCheckAt) return
  }
  if (yield* platform.supported()) yield* platform.launch()
}).pipe(Effect.catchCause(() => Effect.logWarning("Automatic update launch unavailable; collection continues"))))

export const runAutomaticUpdates = Effect.fn("AutomaticUpdates.run")((current: string, force = false) => Effect.scoped(Effect.gen(function*() {
  const platform = yield* AutomaticUpdatePlatform
  let failures = 0
  const attempt = Effect.gen(function*() {
    if (!stableVersion(current) || !(yield* platform.supported())) return { updated: false }
    const config = yield* readSettings
    if (!config.toolsConfigured || !force && !automaticUpdatesEnabled(config)) return { updated: false }
    const now = yield* Clock.currentTimeMillis
    const schedule = yield* platform.schedule()
    if (!validSchedule(schedule)) {
      return yield* new AutomaticUpdateError({ reason: "state", message: "The automatic update schedule is invalid." })
    }
    failures = schedule.failures
    if (!force && now < schedule.nextCheckAt) return { updated: false }
    const bundle = yield* platform.target().pipe(Effect.flatMap(value => Effect.try({
      try: () => decodeReleaseBundle(value),
      catch: () => new AutomaticUpdateError({ reason: "release", message: "The automatic update release bundle is invalid." })
    })))
    const version = bundle.version, fingerprint = releaseBundleFingerprint(bundle)
    const adapters = config.adapters.filter(adapter => adapter.upgradeSpec === adapter.packageName &&
      officialSources.some(source => source.id === adapter.adapterId && source.packageName === adapter.packageName))
    let updated = false
    // A release is one bundle. An installation ahead of it makes the whole
    // attempt ineligible rather than silently producing a mixed bundle.
    if (!newer(current, version) && !adapters.some(adapter => !stableVersion(adapter.version) || newer(adapter.version, version)) &&
      (newer(version, current) || adapters.some(adapter => adapter.version !== version))) {
      const prepared = yield* platform.prepare(bundle, adapters, !force).pipe(Effect.catch(error =>
        !force && error.reason === "cooldown" ? Effect.succeed(undefined) : Effect.fail(error)))
      if (prepared) {
        const matches = yield* Effect.try({ try: () => releaseBundleFingerprint(decodeReleaseBundle(prepared.bundle)) === fingerprint,
          catch: () => new AutomaticUpdateError({ reason: "prepare", message: "The prepared update bundle is invalid." }) })
        if (!matches || prepared.key.length === 0) {
          return yield* new AutomaticUpdateError({ reason: "prepare", message: "The prepared update differs from the selected release." })
        }
        const latest = yield* readSettings
        if (!latest.toolsConfigured || !force && !automaticUpdatesEnabled(latest)) return { updated: false }
        updated = yield* platform.activate(prepared, !force).pipe(Effect.as(true), Effect.catch(error =>
          !force && error.reason === "cooldown" ? Effect.succeed(false) : Effect.fail(error)))
      }
    }
    const installed = updated ? version : current
    yield* platform.record({ nextCheckAt: (yield* Clock.currentTimeMillis) + 24 * Hour + (yield* Random.next) * 6 * Hour,
      failures: 0, version: installed })
    return { updated, version: installed }
  })
  return yield* attempt.pipe(Effect.tapError(error => Effect.gen(function*() {
    const count = Math.min(failures + 1, Number.MAX_SAFE_INTEGER)
    const delay = Math.min(24 * Hour, Hour * 2 ** Math.min(count - 1, 5))
    yield* platform.record({ nextCheckAt: (yield* Clock.currentTimeMillis) + delay + (yield* Random.next) * Math.min(6 * Hour, delay / 4),
      failures: count, failure: error.reason }).pipe(
      Effect.catch(() => Effect.logWarning("Could not save automatic update retry schedule")))
    yield* Effect.logWarning("Automatic update deferred; collection continues", { reason: error.reason })
  })))
})))
