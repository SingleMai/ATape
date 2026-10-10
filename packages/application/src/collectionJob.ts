import type { AdapterInstallation, LocalProject } from "@atape/domain"
import { Clock, Effect, Exit } from "effect"
import { AdapterRuntimes, CollectorStateStore, SecretRedactor, AdapterRuntimeError, CollectionTransportError,
  CollectionContractError, CollectorStateError, CollectorConfigurationError, type CollectionJobError, type SecretRedactorService } from "./collectorContracts.ts"
import { CollectorRedactionPolicies } from "./collectorRedactionPolicy.ts"
import { collectLegacyAdapter } from "./legacyCollector.ts"
import { SourceCaptureCollector } from "./sourceCollector.ts"
import { CollectorRunStatusStore, type CollectorRedactionJobEvent } from "./collectorRunStatus.ts"

type JobObservation = {
  [Kind in CollectorRedactionJobEvent["kind"]]: Omit<Extract<CollectorRedactionJobEvent, { kind: Kind }>,
    "projectId" | "adapterId" | "attemptId" | "at">
}[CollectorRedactionJobEvent["kind"]]

/** Own the runtime lifetime and protocol selection for a single scheduled job. */
export const collectAdapter = (project: LocalProject, adapter: AdapterInstallation) => Effect.gen(function*() {
  const policies = yield* Effect.serviceOption(CollectorRedactionPolicies)
  const statuses = yield* Effect.serviceOption(CollectorRunStatusStore)
  const attemptId = yield* Effect.sync(() => globalThis.crypto.randomUUID())
  const record = (event: JobObservation) => Effect.gen(function*() {
    if (statuses._tag === "None") return
    yield* statuses.value.recordRedactionJob({ ...event, projectId: project.id, adapterId: adapter.adapterId, attemptId,
      at: new Date(yield* Clock.currentTimeMillis).toISOString() }).pipe(
      Effect.catch(() => Effect.logWarning("Could not record the local redaction job observation.")))
  })
  let loadingPolicy = false
  return yield* Effect.scoped(Effect.gen(function*() {
    yield* record({ kind: "loading" })
    loadingPolicy = policies._tag === "Some"
    const loaded = policies._tag === "Some" ? yield* policies.value.snapshot() : undefined
    loadingPolicy = false
    const redactor = loaded?.redactor ?? (yield* SecretRedactor)
    if (loaded !== undefined) yield* record({ kind: "loaded", snapshot: loaded.descriptor })
    return yield* Effect.gen(function*() {
      const states = yield* CollectorStateStore
      const runtimes = yield* AdapterRuntimes
      const snapshot = yield* states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId)
      const runtime = yield* runtimes.open(project, adapter)
      if ("sourceCapture" in runtime) {
        const collector = yield* SourceCaptureCollector
        return yield* collector.collect(project, adapter, runtime, snapshot)
      }
      return yield* collectLegacyAdapter(project, adapter, runtime, snapshot)
    }).pipe(Effect.mapError(error => maskJobError(error, redactor)), Effect.provideService(SecretRedactor, redactor))
  })).pipe(Effect.onExit(exit => record({ kind: "finished", outcome: Exit.isSuccess(exit) ? "completed"
    : Exit.hasInterrupts(exit) ? "interrupted" : loadingPolicy ? "load_failed" : "failed" })))
})

const maskJobError = (error: CollectionJobError, redactor: SecretRedactorService): CollectionJobError => {
  const message = (redactor.redactDiagnostic?.(error.message) ?? redactor.redact(error.message)).value
  if (error instanceof AdapterRuntimeError) return new AdapterRuntimeError({ ...error, message })
  if (error instanceof CollectionTransportError) return new CollectionTransportError({ ...error, message })
  if (error instanceof CollectionContractError) return new CollectionContractError({ ...error, message })
  if (error instanceof CollectorStateError) return new CollectorStateError({ ...error, message })
  return new CollectorConfigurationError({ ...error, message })
}
