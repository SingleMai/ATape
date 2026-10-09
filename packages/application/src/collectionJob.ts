import type { AdapterInstallation, LocalProject } from "@atape/domain"
import { Effect } from "effect"
import { AdapterRuntimes, CollectorStateStore, SecretRedactor, AdapterRuntimeError, CollectionTransportError,
  CollectionContractError, CollectorStateError, CollectorConfigurationError, type CollectionJobError, type SecretRedactorService } from "./collectorContracts.ts"
import { CollectorRedactionPolicies } from "./collectorRedactionPolicy.ts"
import { collectLegacyAdapter } from "./legacyCollector.ts"
import { SourceCaptureCollector } from "./sourceCollector.ts"

/** Own the runtime lifetime and protocol selection for a single scheduled job. */
export const collectAdapter = (project: LocalProject, adapter: AdapterInstallation) => Effect.scoped(Effect.gen(function*() {
  const states = yield* CollectorStateStore
  const runtimes = yield* AdapterRuntimes
  const policies = yield* Effect.serviceOption(CollectorRedactionPolicies)
  const redactor = policies._tag === "Some" ? yield* policies.value.snapshot() : yield* SecretRedactor
  return yield* Effect.gen(function*() {
    const snapshot = yield* states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId)
    const runtime = yield* runtimes.open(project, adapter)
    if ("sourceCapture" in runtime) {
      const collector = yield* SourceCaptureCollector
      return yield* collector.collect(project, adapter, runtime, snapshot)
    }
    return yield* collectLegacyAdapter(project, adapter, runtime, snapshot)
  }).pipe(Effect.mapError(error => maskJobError(error, redactor)), Effect.provideService(SecretRedactor, redactor))
}))

const maskJobError = (error: CollectionJobError, redactor: SecretRedactorService): CollectionJobError => {
  const message = (redactor.redactDiagnostic?.(error.message) ?? redactor.redact(error.message)).value
  if (error instanceof AdapterRuntimeError) return new AdapterRuntimeError({ ...error, message })
  if (error instanceof CollectionTransportError) return new CollectionTransportError({ ...error, message })
  if (error instanceof CollectionContractError) return new CollectionContractError({ ...error, message })
  if (error instanceof CollectorStateError) return new CollectorStateError({ ...error, message })
  return new CollectorConfigurationError({ ...error, message })
}
