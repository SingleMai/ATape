import type { ClientConfig } from "@atape/domain"
import { lstat, open } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Effect } from "effect"
import { resolveAdapterReadinessEntry } from "./adapterHost.ts"
import { validateAdapterImports } from "./adapterPreflight.ts"
import { leaseAdapterInstallation } from "./adapterInstallation.ts"
import { isCollectorMaintenancePending } from "./collectorDaemonLayers.ts"
import type { NodeClientPaths } from "./clientPaths.ts"
import { atomicJSON, missing, readSelectedClientConfig, updateDirectory } from "./runtimeSelection.ts"
import { createUpdateControl } from "./updateControl.ts"

const failure = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause))
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure })
const updateTransactionPending = async (home: string): Promise<boolean> => {
  try { await lstat(join(updateDirectory(home), "pending.json")); return true }
  catch (cause) {
    if (missing(cause)) return false
    throw new Error("Could not inspect the ATape update transaction. Collection remains paused.")
  }
}
const syncExistingUpdateDirectory = async (home: string): Promise<void> => {
  try {
    const directory = await open(updateDirectory(home), "r").catch(cause => {
      if (missing(cause)) return undefined
      throw cause
    })
    if (directory === undefined) return
    try { await directory.sync() } finally { await directory.close() }
  } catch {
    throw new Error("Could not make the ATape update transaction durable. Collection remains paused.")
  }
}

// Readiness proves local executable/configuration compatibility before admission.
// It never opens a provider runtime, collects history, or requires the Instance.
export const prepareCollectorReadiness = (
  paths: NodeClientPaths,
  environment: NodeJS.ProcessEnv
): Effect.Effect<void, Error> => Effect.scoped(Effect.gen(function*() {
  const readyFile = environment.ATAPE_COLLECTOR_READY_FILE
  const token = environment.ATAPE_COLLECTOR_READY_TOKEN
  if (readyFile !== undefined || token !== undefined) {
    if (!readyFile || !token || !isAbsolute(readyFile)) {
      return yield* Effect.fail(new Error("Collector readiness requires an absolute marker path and token."))
    }
    const config = yield* readSelectedClientConfig(paths)
    if (!config.toolsConfigured) {
      return yield* Effect.fail(new Error("Collector readiness requires configured tools."))
    }
    yield* validateCollectorAdapters(paths, config)
    yield* io(() => atomicJSON(readyFile, { token, pid: process.pid }))
  }
  // Report readiness before waiting so an older updater can complete handoff.
  // Its pending journal outlives the maintenance gate: no job may write newer
  // state while that transaction can still restore the previous executable.
  while (yield* io(async () => await isCollectorMaintenancePending(paths.collectorProcessFile) ||
    await updateTransactionPending(paths.atapeHome) ||
    await createUpdateControl(paths.atapeHome).recoveryPending())) {
    yield* Effect.sleep(50)
  }
  // Older updaters remove pending.json without syncing its directory. Make
  // that absence durable before newer jobs write policy-bound state, including
  // when removal preceded this process's first check. Never create the directory.
  yield* io(() => syncExistingUpdateDirectory(paths.atapeHome))
}))

export const validateCollectorAdapters = (paths: NodeClientPaths, config: ClientConfig): Effect.Effect<void, Error> =>
  Effect.scoped(Effect.gen(function*() {
    const git = config.projects.some(project => project.type === "git")
    const entries: { adapterId: string; entry: string }[] = []
    for (const id of config.enabledAdapterIds) {
      const installation = config.adapters.find(adapter => adapter.adapterId === id)
      if (!installation) return yield* Effect.fail(new Error(`Enabled Adapter ${id} is not installed.`))
      yield* leaseAdapterInstallation(paths.adapterDirectory, installation)
      entries.push({ adapterId: id, entry: yield* resolveAdapterReadinessEntry(paths.adapterDirectory, installation, git) })
    }
    yield* validateAdapterImports(entries)
  }))

