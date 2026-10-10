import { automaticUpdatesEnabled } from "@atape/application"
import { ClientConfig, emptyClientConfig, type AdapterInstallation, type MigrationReleaseBundle } from "@atape/domain"
import { isDeepStrictEqual } from "node:util"
import { performance } from "node:perf_hooks"
import { Schema } from "effect"
import type { NodeClientPaths } from "./clientPaths.ts"
import { withClientConfigFileLock } from "./clientConfig.ts"
import { withCollectorStateLockPromise } from "./collectorStateLock.ts"
import { readCollectorSyncWanted, withCollectorMaintenance } from "./collectorDaemonLayers.ts"
import { createCaptureMigrationCoordinator } from "./captureMigration.ts"
import { inspectCaptureMigrationPrerequisitesScope } from "./captureMigrationPrerequisites.ts"
import { createUpdateControl, updateControlProtocol, type UpdateRuntimeSelection } from "./updateControl.ts"
import { applyRuntimeSelection, missing, readBoundedJSON, readEffectiveRuntimeSelection, resolveRuntimeEntry,
  type RuntimeSelection } from "./runtimeSelection.ts"

export type PreparedCaptureUpdate = {
  readonly bundle: MigrationReleaseBundle
  readonly selection: UpdateRuntimeSelection
  readonly baseline: ReadonlyArray<AdapterInstallation>
  readonly baselineSelection?: RuntimeSelection | UpdateRuntimeSelection
  readonly enabledAdapterIds: ReadonlyArray<string>
  readonly hasGit: boolean
}
const config = async (paths: NodeClientPaths): Promise<ClientConfig> => {
  try { return Schema.decodeUnknownSync(ClientConfig)(await readBoundedJSON(paths.configFile, 4 * 1024 * 1024)) }
  catch (cause) { if (missing(cause)) return emptyClientConfig(); throw cause }
}
const admittedSelection = (selection: RuntimeSelection | UpdateRuntimeSelection): UpdateRuntimeSelection => {
  if (selection.protocol === updateControlProtocol) return selection
  if (!selection.bootstrapIdentity) throw new Error("The prior runtime has no durable bootstrap identity.")
  return { protocol: updateControlProtocol, version: selection.version, captureStateContract: selection.stateContract,
    bootstrapEntry: selection.bootstrapEntry, bootstrapIdentity: selection.bootstrapIdentity, adapters: selection.adapters }
}
const checkDeadline = (deadline: number) => {
  if (performance.now() >= deadline) throw new Error("Capture migration maintenance deadline expired.")
}
const lockBudget = (deadline: number) => Math.max(0, Math.min(5_000, deadline - performance.now()))
const applyBudget = (deadline: number) => {
  checkDeadline(deadline)
  return Math.max(1, Math.ceil(deadline - performance.now()))
}

/** Executable selection and capture transformation share one bounded handoff.
 * Network and target preflight finish before maintenance; no child is joined
 * while configuration, Collector state or admission barriers are held. */
export const activateManagedCaptureUpdate = async (paths: NodeClientPaths, bootstrap: string,
  installedBootstrap: RuntimeSelection | UpdateRuntimeSelection, candidate: PreparedCaptureUpdate,
  automatic: boolean, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> => {
  const control = createUpdateControl(paths.atapeHome), migration = createCaptureMigrationCoordinator(paths, environment)
  const baseline = await config(paths), wanted = await readCollectorSyncWanted(paths.collectorProcessFile)
  const proof = await migration.preflight({ bundle: candidate.bundle, target: candidate.selection,
    candidateConfig: applyRuntimeSelection(baseline, candidate.selection), wanted }, signal)
  let outer: { readonly key: string; readonly target: UpdateRuntimeSelection } | undefined
  const apply = async (deadline: number) => {
    checkDeadline(deadline)
    if (!outer) throw new Error("The migration has no owned executable boundary.")
    await migration.repairCompletedRequirement()
    if (await migration.recoveryPending()) {
      const attempt = await migration.nextAttempt(outer)
      await migration.executeApply(attempt, AbortSignal.any([signal, AbortSignal.timeout(applyBudget(deadline))]))
    }
    await migration.receipt(outer)
  }
  const restore = async (deadline: number) => {
    await withClientConfigFileLock(paths.configFile, async () => {
      checkDeadline(deadline)
      if (await control.recoveryPending()) await control.recoverSelection()
    }, lockBudget(deadline))
    if (!outer) return
    const boundary = await control.migrationBoundary(outer.key)
    if (boundary.forwardOnly) await apply(deadline)
    else await migration.abandon(outer)
  }
  await withCollectorMaintenance(paths, () => resolveRuntimeEntry(paths.atapeHome, bootstrap), environment, async deadline => {
    await withClientConfigFileLock(paths.configFile, () => withCollectorStateLockPromise(paths.collectorStateFile, async () => {
      checkDeadline(deadline)
      const raw = await config(paths)
      if (automatic && (!raw.toolsConfigured || !automaticUpdatesEnabled(raw))) throw new Error("Update preferences changed before migration.")
      if (!isDeepStrictEqual(raw.adapters, candidate.baseline) ||
        !isDeepStrictEqual([...raw.enabledAdapterIds].sort(), [...candidate.enabledAdapterIds].sort()) ||
        raw.projects.some(project => project.type === "git") !== candidate.hasGit ||
        !isDeepStrictEqual(await readEffectiveRuntimeSelection(paths.atapeHome), candidate.baselineSelection))
        throw new Error("The capture update baseline changed before activation.")
      const ticket = await control.prepare({ next: candidate.selection,
        previous: admittedSelection(candidate.baselineSelection ?? installedBootstrap) })
      outer = { key: ticket.key, target: candidate.selection }
      await migration.authorize(proof, outer, { candidateConfig: applyRuntimeSelection(raw, candidate.selection),
        wanted: await readCollectorSyncWanted(paths.collectorProcessFile) }, signal)
      checkDeadline(deadline)
      await control.begin(ticket)
      await control.fence(ticket)
    }), lockBudget(deadline))
    await apply(deadline)
  }, {
    beforePause: async currentWanted => {
      const raw = await config(paths)
      if (automatic && (!raw.toolsConfigured || !automaticUpdatesEnabled(raw))) throw new Error("Update preferences changed before pause.")
      const current = await inspectCaptureMigrationPrerequisitesScope(paths, {
        candidateConfig: applyRuntimeSelection(raw, candidate.selection), wanted: currentWanted })
      if (current.prerequisiteScopeFingerprint !== proof.prerequisiteScopeFingerprint)
        throw new Error("Capture prerequisites changed after preflight.")
    },
    recover: (_, deadline) => restore(deadline)
  })
  if (!outer) throw new Error("Capture migration did not establish its transaction.")
  await migration.receipt(outer)
  await control.complete({ key: outer.key })
}

/** Recovery remains eligible after preference-off and Stop. It restores the
 * baseline only before the fence; every fenced retry executes the same target. */
export const recoverManagedCaptureUpdate = async (paths: NodeClientPaths, bootstrap: string,
  environment: NodeJS.ProcessEnv): Promise<boolean> => {
  const migration = createCaptureMigrationCoordinator(paths, environment)
  const outer = await migration.pendingOuter()
  if (!outer) return false
  if (outer.completed) { await migration.repairCompletedRequirement(); return false }
  const control = createUpdateControl(paths.atapeHome)
  const restore = async (deadline: number) => {
    await withClientConfigFileLock(paths.configFile, async () => {
      checkDeadline(deadline)
      await control.recoverSelection()
    }, lockBudget(deadline))
    const boundary = await control.migrationBoundary(outer.key)
    if (!boundary.forwardOnly) { await migration.abandon(outer); return }
    await migration.repairCompletedRequirement()
    if (await migration.recoveryPending()) {
      const attempt = await migration.nextAttempt(outer)
      await migration.executeApply(attempt, AbortSignal.timeout(applyBudget(deadline)))
    }
    await migration.receipt(outer)
  }
  await withCollectorMaintenance(paths, () => resolveRuntimeEntry(paths.atapeHome, bootstrap), environment,
    restore, { recover: (_, deadline) => restore(deadline) })
  const boundary = await control.migrationBoundary(outer.key)
  if (boundary.phase === "recovering") await control.completeRecovery()
  return true
}
