import type { AdapterInstallation, LocalProject } from "@atape/domain"
import { Clock, Effect } from "effect"
import { recordCollectorProgress, withCollectorMonitoring } from "./collectorMonitoring.ts"
import { ClientConfigStore, inspectClient } from "./clientManagement.ts"
import { collectAdapter } from "./collectionJob.ts"
import { CollectorConfigurationError, CollectionTransportError, AdapterRuntimeError, CollectorStateError,
  type AdapterCollectionReport, type AdapterCollectionFailure, type CollectionCycleReport,
  type CollectionJobError } from "./collectorContracts.ts"

// Preserve the existing caller Interface while implementations depend directly on contracts.
export * from "./collectorContracts.ts"
export { makeSecretRedactorLayer, prepareCanonicalSlice } from "./collectorPreparation.ts"

export type CollectionCycleOptions = {
  readonly projectId?: string
  readonly concurrency?: number
}

export type RunCollectorOptions = CollectionCycleOptions & {
  readonly once?: boolean
  readonly intervalMs?: number
}

export const runCollectionCycle = Effect.fn("Collector.runCycle")(function*(options: CollectionCycleOptions = {}) {
  yield* recordCollectorProgress("started")
  return yield* Effect.gen(function*() {
    const input = yield* prepareCycle(options)
    return yield* collectPreparedCycle(input)
  }).pipe(Effect.tap(recordCollectorProgress), Effect.tapError(() => recordCollectorProgress("failed")))
})

export const runCollector = Effect.fn("Collector.run")((options: RunCollectorOptions = {}) => withCollectorMonitoring(Effect.gen(function*() {
  const intervalMs = options.intervalMs ?? 30_000
  if (!Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 3_600_000) {
    return yield* new CollectorConfigurationError({
      reason: "limits", message: "Collector interval must be between 10 seconds and 1 hour."
    })
  }
  const continueImmediately = makeCollectionContinuation()
  while (true) {
    const report = yield* runCollectionCycle(options)
    if (options.once === true) return report
    if (hasUnauthenticatedFailure(report)) {
      return yield* new CollectorConfigurationError({
        reason: "unauthenticated",
        message: "The ATape Collector stopped because a CLI credential is missing, invalid, or expired. Run `atape login`."
      })
    }
    yield* Effect.logInfo("ATape collection cycle completed", {
      jobs: report.jobs.length,
      failures: report.failures.length,
      partialJobs: report.jobs.filter(job => job.sourceFailures?.length || job.sourceFailuresTruncated).length,
      observations: report.jobs.reduce((sum, job) => sum + job.observations, 0),
      rawChunks: report.jobs.reduce((sum, job) => sum + job.rawChunks, 0)
    })
    yield* continueImmediately(report) ? Effect.yieldNow : Effect.sleep(intervalMs)
  }
})))

/** Bound catch-up across all jobs: independently restarting scans need not
 * reach their end in the same cycle. Durable cursors survive each interval. */
export const makeCollectionContinuation = () => {
  let cycles = 0
  return (report: CollectionCycleReport): boolean => {
    cycles++
    if (report.failures.length === 0 && report.jobs.some(job => job.hasMore) && cycles < 16) return true
    cycles = 0
    return false
  }
}

type PreparedCycle = {
  readonly startedAt: string
  readonly concurrency: number
  readonly jobs: ReadonlyArray<{ readonly project: LocalProject; readonly adapter: AdapterInstallation }>
}

const prepareCycle = (options: CollectionCycleOptions): Effect.Effect<
  PreparedCycle,
  CollectorConfigurationError | import("./clientManagement.ts").ClientConfigStoreError,
  ClientConfigStore
> => Effect.gen(function*() {
  const concurrency = options.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    return yield* new CollectorConfigurationError({
      reason: "limits", message: "Collector concurrency must be between 1 and 8."
    })
  }
  const config = yield* inspectClient()
  const projects = options.projectId === undefined
    ? config.projects
    : config.projects.filter((project) => project.id === options.projectId)
  if (options.projectId !== undefined && projects.length === 0) {
    return yield* new CollectorConfigurationError({
      reason: "project", message: `Project ${options.projectId} is not configured locally.`
    })
  }
  const jobs: Array<{ project: LocalProject; adapter: AdapterInstallation }> = []
  for (const project of projects) {
    for (const adapterId of project.adapterIds) {
      const adapter = config.adapters.find((item) => item.adapterId === adapterId)
      if (!adapter) {
        return yield* new CollectorConfigurationError({
          reason: "project", message: `Project ${project.id} references missing Adapter ${adapterId}.`
        })
      }
      jobs.push({ project, adapter })
    }
  }
  return {
    startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    concurrency,
    jobs
  }
})

const collectPreparedCycle = (input: PreparedCycle) => Effect.gen(function*() {
  const results = yield* Effect.forEach(input.jobs, ({ project, adapter }) =>
    collectAdapter(project, adapter).pipe(
      Effect.match({
        onFailure: (error): AdapterCollectionFailure => ({
          projectId: project.id,
          adapterId: adapter.adapterId,
          reason: collectionFailureReason(error),
          retryable: isRetryable(error),
          message: error.message
        }),
        onSuccess: (report) => report
      })
    ), { concurrency: input.concurrency })
  const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  return {
    startedAt: input.startedAt,
    completedAt,
    jobs: results.filter((item): item is AdapterCollectionReport => "pages" in item),
    failures: results.filter((item): item is AdapterCollectionFailure => !("pages" in item))
  } satisfies CollectionCycleReport
})

const isRetryable = (error: CollectionJobError) =>
  error instanceof CollectionTransportError ? error.retryable
    : error instanceof AdapterRuntimeError ? error.retryable
      : error instanceof CollectorStateError ? error.reason === "io" || error.reason === "conflict"
        : false

const collectionFailureReason = (error: CollectionJobError): AdapterCollectionFailure["reason"] =>
  error instanceof CollectionTransportError
    ? error.reason === "unauthenticated" ? "unauthenticated" : "transport"
    : error instanceof AdapterRuntimeError
      ? error.reason === "unauthenticated" ? "unauthenticated" : error.reason === "transport" ? "transport" : "adapter"
      : error instanceof CollectorStateError
        ? "state"
        : "contract"

export const hasUnauthenticatedFailure = (report: CollectionCycleReport): boolean =>
  report.failures.some((failure) => failure.reason === "unauthenticated")
