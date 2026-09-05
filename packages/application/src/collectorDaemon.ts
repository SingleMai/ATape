import type {
  ClientConfig,
  CollectorJobRunStatus,
  CollectorRunFailure,
  CollectorRunState
} from "@atape/domain"
import { Clock, Context, Effect, Schema } from "effect"
import { inspectClient } from "./clientManagement.ts"
import {
  CollectorConfigurationError,
  runCollectionCycle,
  type CollectionCycleReport
} from "./collector.ts"

export class CollectorDaemonProcessError extends Schema.TaggedError<CollectorDaemonProcessError>()(
  "CollectorDaemonProcessError",
  {
    reason: Schema.Literals(["io", "identity", "start", "stop"]),
    message: Schema.String
  }
) {}

export class CollectorRunStatusError extends Schema.TaggedError<CollectorRunStatusError>()(
  "CollectorRunStatusError",
  {
    reason: Schema.Literals(["io", "decode"]),
    message: Schema.String
  }
) {}

export type CollectorDaemonOptions = {
  readonly intervalMs?: number
  readonly concurrency?: number
}

export type ResolvedCollectorDaemonOptions = {
  readonly intervalMs: number
  readonly concurrency: number
}

export type CollectorDaemonProcessSnapshot = ResolvedCollectorDaemonOptions & {
  readonly pid: number
  readonly startedAt: string
  readonly logFile: string
  readonly created: boolean
}

export class CollectorDaemonProcess extends Context.Service<CollectorDaemonProcess, {
  start(options: ResolvedCollectorDaemonOptions): Effect.Effect<CollectorDaemonProcessSnapshot, CollectorDaemonProcessError>
  stop(): Effect.Effect<boolean, CollectorDaemonProcessError>
  inspect(): Effect.Effect<Omit<CollectorDaemonProcessSnapshot, "created"> | undefined, CollectorDaemonProcessError>
}>()("atape/application/CollectorDaemonProcess") {}

export class CollectorRunStatusStore extends Context.Service<CollectorRunStatusStore, {
  read(): Effect.Effect<CollectorRunState, CollectorRunStatusError>
  recordCycle(report: CollectionCycleReport): Effect.Effect<void, CollectorRunStatusError>
  recordCollectorFailure(failure: CollectorRunFailure): Effect.Effect<void, CollectorRunStatusError>
}>()("atape/application/CollectorRunStatusStore") {}

export type ManagedCollectorJobStatus = {
  readonly projectId: string
  readonly adapterId: string
  readonly state: "pending" | "healthy" | "failed"
  readonly lastAttemptAt?: string
  readonly lastSuccessAt?: string
  readonly lastFailureAt?: string
  readonly failureMessage?: string
  readonly retryable?: boolean
  readonly pages?: number
  readonly observations?: number
  readonly canonicalBatches?: number
  readonly rawChunks?: number
  readonly redactions?: number
  readonly hasMore?: boolean
}

export type ManagedCollectorStatus = {
  readonly running: boolean
  readonly pid?: number
  readonly startedAt?: string
  readonly intervalMs?: number
  readonly concurrency?: number
  readonly logFile?: string
  readonly lastCycleStartedAt?: string
  readonly lastCycleCompletedAt?: string
  readonly collectorFailure?: CollectorRunFailure
  readonly jobs: ReadonlyArray<ManagedCollectorJobStatus>
}

export const startManagedCollector = Effect.fn("CollectorDaemon.start")(function*(
  requested: CollectorDaemonOptions = {}
) {
  const options = yield* resolveDaemonOptions(requested)
  const config = yield* inspectClient()
  yield* validateManagedConfig(config)
  const process = yield* CollectorDaemonProcess
  return yield* process.start(options)
})

export const stopManagedCollector = Effect.fn("CollectorDaemon.stop")(function*() {
  const process = yield* CollectorDaemonProcess
  return yield* process.stop()
})

export const inspectManagedCollector = Effect.fn("CollectorDaemon.inspect")(function*() {
  const process = yield* CollectorDaemonProcess
  const statuses = yield* CollectorRunStatusStore
  const [running, recorded, config] = yield* Effect.all([
    process.inspect(),
    statuses.read(),
    inspectClient()
  ])
  const byJob = new Map(recorded.jobs.map((job) => [jobKey(job.projectId, job.adapterId), job]))
  const jobs = configuredJobs(config).map(({ projectId, adapterId }) =>
    presentJob(projectId, adapterId, byJob.get(jobKey(projectId, adapterId))))
  return {
    running: running !== undefined,
    ...(running === undefined ? {} : running),
    ...(recorded.lastCycleStartedAt === undefined ? {} : { lastCycleStartedAt: recorded.lastCycleStartedAt }),
    ...(recorded.lastCycleCompletedAt === undefined ? {} : { lastCycleCompletedAt: recorded.lastCycleCompletedAt }),
    ...(recorded.collectorFailure === undefined ? {} : { collectorFailure: recorded.collectorFailure }),
    jobs
  } satisfies ManagedCollectorStatus
})

export const runManagedCollector = Effect.fn("CollectorDaemon.run")(function*(
  requested: CollectorDaemonOptions = {}
) {
  const options = yield* resolveDaemonOptions(requested)
  const statuses = yield* CollectorRunStatusStore
  while (true) {
    yield* runCollectionCycle({ concurrency: options.concurrency }).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.gen(function*() {
          const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString()
          yield* statuses.recordCollectorFailure({
            occurredAt,
            message: error instanceof Error ? error.message : String(error)
          })
          yield* Effect.logError("ATape collection cycle could not start", { error: String(error) })
        }),
        onSuccess: (report) => statuses.recordCycle(report).pipe(
          Effect.tap(() => Effect.logInfo("ATape collection cycle completed", {
            jobs: report.jobs.length,
            failures: report.failures.length,
            observations: report.jobs.reduce((sum, job) => sum + job.observations, 0),
            rawChunks: report.jobs.reduce((sum, job) => sum + job.rawChunks, 0)
          }))
        )
      })
    )
    yield* Effect.sleep(options.intervalMs)
  }
})

const resolveDaemonOptions = (
  requested: CollectorDaemonOptions
): Effect.Effect<ResolvedCollectorDaemonOptions, CollectorConfigurationError> => {
  const intervalMs = requested.intervalMs ?? 30_000
  const concurrency = requested.concurrency ?? 4
  if (!Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 3_600_000) {
    return Effect.fail(new CollectorConfigurationError({
      reason: "limits", message: "Collector interval must be between 10 seconds and 1 hour."
    }))
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    return Effect.fail(new CollectorConfigurationError({
      reason: "limits", message: "Collector concurrency must be between 1 and 8."
    }))
  }
  return Effect.succeed({ intervalMs, concurrency })
}

const validateManagedConfig = (config: ClientConfig): Effect.Effect<void, CollectorConfigurationError> => {
  if (!config.userId) {
    return Effect.fail(new CollectorConfigurationError({
      reason: "identity", message: "This client has no Team user ID. Run `atape setup --user-id <id>` first."
    }))
  }
  const jobs = configuredJobs(config)
  if (jobs.length === 0) {
    return Effect.fail(new CollectorConfigurationError({
      reason: "project", message: "No Project has an enabled Adapter. Configure one before starting the Collector."
    }))
  }
  for (const job of jobs) {
    if (!config.adapters.some((adapter) => adapter.adapterId === job.adapterId)) {
      return Effect.fail(new CollectorConfigurationError({
        reason: "project", message: `Project ${job.projectId} references missing Adapter ${job.adapterId}.`
      }))
    }
  }
  return Effect.void
}

const configuredJobs = (config: ClientConfig) => config.projects.flatMap((project) =>
  project.adapterIds.map((adapterId) => ({ projectId: project.id, adapterId })))
  .sort((left, right) => jobKey(left.projectId, left.adapterId).localeCompare(jobKey(right.projectId, right.adapterId)))

const presentJob = (
  projectId: string,
  adapterId: string,
  recorded: CollectorJobRunStatus | undefined
): ManagedCollectorJobStatus => recorded === undefined
  ? { projectId, adapterId, state: "pending" }
  : {
      projectId,
      adapterId,
      state: recorded.failureMessage === undefined ? "healthy" : "failed",
      lastAttemptAt: recorded.lastAttemptAt,
      ...(recorded.lastSuccessAt === undefined ? {} : { lastSuccessAt: recorded.lastSuccessAt }),
      ...(recorded.lastFailureAt === undefined ? {} : { lastFailureAt: recorded.lastFailureAt }),
      ...(recorded.failureMessage === undefined ? {} : { failureMessage: recorded.failureMessage }),
      ...(recorded.retryable === undefined ? {} : { retryable: recorded.retryable }),
      ...(recorded.pages === undefined ? {} : { pages: recorded.pages }),
      ...(recorded.observations === undefined ? {} : { observations: recorded.observations }),
      ...(recorded.canonicalBatches === undefined ? {} : { canonicalBatches: recorded.canonicalBatches }),
      ...(recorded.rawChunks === undefined ? {} : { rawChunks: recorded.rawChunks }),
      ...(recorded.redactions === undefined ? {} : { redactions: recorded.redactions }),
      ...(recorded.hasMore === undefined ? {} : { hasMore: recorded.hasMore })
    }

const jobKey = (projectId: string, adapterId: string) => `${projectId}\0${adapterId}`
