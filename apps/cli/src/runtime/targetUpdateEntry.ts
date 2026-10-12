import { AutomaticUpdatePlatform, automaticUpdatesEnabled, officialSources, type PreparedAutomaticUpdate } from "@atape/application"
import { MigrationReleaseBundle, decodeMigrationReleaseBundle, type TargetReleaseBundle } from "@atape/domain"
import { realpath, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect, Logger, Schema } from "effect"
import { cliVersion, captureStateContract } from "../version.ts"
import { makeNodeClientLayer } from "./clientLayers.ts"
import { type NodeClientPaths } from "./clientPaths.ts"
import { captureMigrationPlan, captureMigrationProtocol } from "./captureMigrationAdmission.ts"
import { needsTargetExecutionRecovery, protectedRuntimeSlots, recoverTargetExecutionUpdate,
  retireTargetPreparedUpdate, targetPreparedUpdateSelection } from "./managedUpdates.ts"
import { readEffectiveRuntimeSelection, readSelectedClientConfig } from "./runtimeSelection.ts"
import { atomicJSON, missing, readBoundedJSON, updateDirectory } from "./runtimeFiles.ts"
import { UpdateRuntimeSelection } from "./updateControl.ts"
import { acquireTargetUpdateExecution, assertTargetUpdateBaseline, readTargetUpdateHandoff, readTargetUpdateOwner, readTargetUpdateReceipt,
  readTargetOwnerRequest, targetUpdateIdentityHash, validateTargetUpdateExecutable, writeTargetOwnerReceipt, writeTargetUpdateReceipt,
  type TargetUpdateAction, type TargetOwnerAction, type TargetOwnerReceipt, type TargetUpdateReceipt } from "./targetUpdate.ts"

const UUID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const PrivatePreparation = Schema.Struct({ identity: Schema.String, key: UUID, bundle: MigrationReleaseBundle, selection: UpdateRuntimeSelection })
type PrivatePreparation = typeof PrivatePreparation.Type
const privateFile = (home: string, id: string) => join(updateDirectory(home), "target-update-private", `${id}.json`)
const strict = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown) => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)

// Only the executing target interprets its compiled migration declaration. V3
// discovery deliberately carries no migration plan for an older parent to read.
const compiledBundle = async (bundle: TargetReleaseBundle, entry: string) => {
  const manifest = await readBoundedJSON(join(dirname(dirname(entry)), "package.json")) as {
    atapeRuntime?: { captureMigrationProtocol?: unknown; captureMigration?: { protocol?: unknown; id?: unknown } }
  }
  if (manifest.atapeRuntime?.captureMigrationProtocol !== captureMigrationProtocol ||
    manifest.atapeRuntime.captureMigration?.protocol !== captureMigrationProtocol ||
    manifest.atapeRuntime.captureMigration.id !== captureMigrationPlan) throw new Error("The target's compiled migration plan is unavailable.")
  return decodeMigrationReleaseBundle({ protocol: "atape.release-bundle.v2", version: bundle.version,
    captureStateContract: bundle.captureStateContract, updateControlProtocol: bundle.updateControlProtocol,
    packages: bundle.packages, migration: manifest.atapeRuntime.captureMigration })
}

/** Private executable Seam. No worker lock is acquired here: its older parent
 * owns that lock while waiting. SQLite execution exclusion survives parent death
 * and the existing migration apply lock protects any surviving fenced child. */
export const executeTargetUpdateEntry = async (paths: NodeClientPaths, input: {
  readonly id: string; readonly token: string; readonly action: TargetUpdateAction | TargetOwnerAction; readonly nonce?: string
}, environment: NodeJS.ProcessEnv = process.env, signal = AbortSignal.timeout(600_000)): Promise<TargetUpdateReceipt | TargetOwnerReceipt> => {
  const release = await acquireTargetUpdateExecution(paths.atapeHome, input.action.startsWith("owner-") ? 10_000 : 0)
  if (!release) throw new Error("Target update execution is already owned. Recovery will retry.")
  try {
    if (input.action === "owner-recover" || input.action === "owner-protected") {
      if (await readTargetUpdateHandoff(paths.atapeHome)) throw new Error("A pending target request has priority over completed ownership.")
      const owner = await readTargetUpdateOwner(paths.atapeHome)
      if (!owner || owner.id !== input.id || owner.token !== input.token || !isDeepStrictEqual(paths, owner.paths) ||
        owner.bundle.version !== cliVersion || owner.bundle.captureStateContract !== captureStateContract)
        throw new Error("This target owner has no matching runtime selection.")
      if (!input.nonce) throw new Error("Target owner invocation requires a durable call identity.")
      const request = await readTargetOwnerRequest(owner, input.nonce, input.action)
      const entry = await validateTargetUpdateExecutable(owner)
      if (await realpath(process.argv[1]!) !== entry) throw new Error("The target owner is not its immutable executable.")
      if (input.action === "owner-recover") await recoverTargetExecutionUpdate(paths, owner.bootstrapEntry, environment)
      return writeTargetOwnerReceipt(owner, request, { internalPending: await needsTargetExecutionRecovery(paths),
        slots: await protectedRuntimeSlots(paths.atapeHome, true) })
    }
    const action = input.action
    const job = await readTargetUpdateHandoff(paths.atapeHome)
    if (!job || job.id !== input.id || job.token !== input.token || !isDeepStrictEqual(paths, job.paths) ||
      job.bundle.version !== cliVersion || job.bundle.captureStateContract !== captureStateContract)
      throw new Error("This target update entry has no matching durable request.")
    const entry = await validateTargetUpdateExecutable(job)
    if (await realpath(process.argv[1]!) !== entry) throw new Error("The target entry is not its recorded immutable executable.")
    const finish = async (status: "completed" | "deferred", reason?: string) => {
      if (await needsTargetExecutionRecovery(paths)) throw new Error("Target-owned recovery remains pending.")
      let retained: PrivatePreparation | undefined
      try { retained = strict(PrivatePreparation, await readBoundedJSON(privateFile(paths.atapeHome, job.id))) }
      catch (cause) { if (!missing(cause)) throw cause }
      if (retained) await retireTargetPreparedUpdate(paths, retained.key)
      const receipt = await writeTargetUpdateReceipt(job, action, { status, internalPending: false, ...(reason ? { reason } : {}) })
      await rm(privateFile(paths.atapeHome, job.id), { force: true })
      return receipt
    }
    if (input.action === "recover") {
      const terminal = await readTargetUpdateReceipt(job).catch(cause => { if (missing(cause)) return undefined; throw cause })
      if (terminal && !terminal.internalPending && terminal.status !== "prepared") return finish(terminal.status)
    }
    let prepared: PrivatePreparation | undefined
    try { prepared = strict(PrivatePreparation, await readBoundedJSON(privateFile(paths.atapeHome, job.id))) }
    catch (cause) { if (!missing(cause)) throw cause }
    if (prepared && (prepared.identity !== targetUpdateIdentityHash(job) ||
      job.preparedKey !== undefined && prepared.key !== job.preparedKey)) throw new Error("Target preparation no longer belongs to this request.")
    if (input.action === "recover" && job.phase !== "activating") {
      // Preparation alone is no authority to initiate a new activation after
      // its caller disappeared. Retire it; ordinary scheduling may retry later.
      return finish("deferred", "interrupted-preparation")
    }
    if (input.action === "prepare" && job.phase !== "preparing" || input.action === "activate" && job.phase !== "activating")
      throw new Error("Target update action does not match its durable phase.")
    if (input.action === "recover") {
      await recoverTargetExecutionUpdate(paths, job.bootstrapEntry, environment, job)
      if (prepared && !await needsTargetExecutionRecovery(paths) &&
        isDeepStrictEqual(await readEffectiveRuntimeSelection(paths.atapeHome), prepared.selection)) return finish("completed")
    }
    const internalBundle = await compiledBundle(job.bundle, entry)
    const layer = makeNodeClientLayer(paths, environment, globalThis.fetch, globalThis.fetch,
      { targetUpdateExecution: { bundle: job.bundle, internalBundle, handoff: job } })
    const run = <A, E>(effect: Effect.Effect<A, E, AutomaticUpdatePlatform>) => Effect.runPromise(
      effect.pipe(Effect.provide(layer), Effect.provide(Logger.layer([]))), { signal })
    try {
      await assertTargetUpdateBaseline(job)
      if (input.action === "prepare") {
        const config = await Effect.runPromise(readSelectedClientConfig(paths))
        if (job.automatic && (!config.toolsConfigured || !automaticUpdatesEnabled(config))) return finish("deferred", "automatic-updates-disabled")
        const adapters = config.adapters.filter(adapter => adapter.upgradeSpec === adapter.packageName &&
          officialSources.some(source => source.id === adapter.adapterId && source.packageName === adapter.packageName))
        const result = await run(Effect.scoped(AutomaticUpdatePlatform.use(platform => platform.prepare(internalBundle, adapters, job.automatic))))
        prepared = { identity: targetUpdateIdentityHash(job), key: result.key, bundle: internalBundle,
          selection: await targetPreparedUpdateSelection(paths, result.key) }
        await atomicJSON(privateFile(paths.atapeHome, job.id), prepared)
        return writeTargetUpdateReceipt(job, action, { status: "prepared", preparedKey: result.key, internalPending: false })
      }
      if (!prepared || prepared.key !== job.preparedKey) throw new Error("Target activation lost its private preparation.")
      const request: PreparedAutomaticUpdate = { bundle: prepared.bundle, key: prepared.key }
      await run(AutomaticUpdatePlatform.use(platform => platform.activate(request, job.automatic)))
      return finish("completed")
    } catch (cause) {
      if (signal.aborted || await needsTargetExecutionRecovery(paths)) throw cause
      if (prepared && isDeepStrictEqual(await readEffectiveRuntimeSelection(paths.atapeHome), prepared.selection))
        return finish("completed")
      return finish("deferred", action === "prepare" ? "target-preparation-failed" : "target-activation-deferred")
    }
  } finally { release() }
}
