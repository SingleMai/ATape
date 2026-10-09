import type { ClientConfig } from "@atape/domain"
import { isAbsolute } from "node:path"
import { Effect } from "effect"
import { resolveAdapterReadinessEntry } from "./adapterHost.ts"
import { validateAdapterImports } from "./adapterPreflight.ts"
import { leaseAdapterInstallation } from "./adapterInstallation.ts"
import { isCollectorMaintenancePending } from "./collectorDaemonLayers.ts"
import type { NodeClientPaths } from "./clientPaths.ts"
import { atomicJSON, readSelectedClientConfig } from "./runtimeSelection.ts"

const failure = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause))
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure })

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
  // Ordinary launches retain the Collector's established validation behavior.
  // Both ordinary and maintenance launches wait here before any collection.
  while (yield* io(() => isCollectorMaintenancePending(paths.collectorProcessFile))) {
    yield* Effect.sleep(50)
  }
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

