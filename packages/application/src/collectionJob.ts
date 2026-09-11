import type { AdapterInstallation, LocalProject } from "@atape/domain"
import { Effect } from "effect"
import { AdapterRuntimes, CollectorStateStore } from "./collectorContracts.ts"
import { collectLegacyAdapter } from "./legacyCollector.ts"
import { SourceCaptureCollector } from "./sourceCollector.ts"

/** Own the runtime lifetime and protocol selection for a single scheduled job. */
export const collectAdapter = (project: LocalProject, adapter: AdapterInstallation) => Effect.scoped(Effect.gen(function*() {
  const states = yield* CollectorStateStore
  const runtimes = yield* AdapterRuntimes
  const snapshot = yield* states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId)
  const runtime = yield* runtimes.open(project, adapter)
  if ("sourceCapture" in runtime) {
    const collector = yield* SourceCaptureCollector
    return yield* collector.collect(project, adapter, runtime, snapshot)
  }
  return yield* collectLegacyAdapter(project, adapter, runtime, snapshot)
}))
