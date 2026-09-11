import type { CLISyncReport, CLISyncJob, ClientConfig, CollectorRunState } from "@atape/domain"
import { Context, Effect, Option, Ref } from "effect"
import type { CollectionCycleReport } from "./collectorContracts.ts"

// Optional remote Seam for callers running a Collector without a device dashboard.
export class CollectorDeviceGateway extends Context.Service<CollectorDeviceGateway, {
  publish(report: CLISyncReport): Effect.Effect<void>
}>()("atape/application/CollectorDeviceGateway") {}

class CollectorProgress extends Context.Service<CollectorProgress, {
  record(event: "started" | "failed" | CollectionCycleReport): Effect.Effect<void>
}>()("atape/application/CollectorProgress") {}

export const recordCollectorProgress = (event: "started" | "failed" | CollectionCycleReport) =>
  Effect.serviceOption(CollectorProgress).pipe(Effect.flatMap((progress) =>
    Option.isSome(progress) ? progress.value.record(event) : Effect.void))

export const withCollectorMonitoring = <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function*() {
    const gateway = yield* Effect.serviceOption(CollectorDeviceGateway)
    if (Option.isNone(gateway)) return yield* work
    const current = yield* Ref.make<CLISyncReport>({ phase: "starting", jobs: [], jobsTruncated: false })
    const publish = Ref.get(current).pipe(Effect.flatMap(gateway.value.publish))
    return yield* Effect.scoped(Effect.gen(function*() {
      yield* publish.pipe(Effect.andThen(Effect.sleep(30_000)), Effect.forever, Effect.forkScoped)
      return yield* work.pipe(Effect.provideService(CollectorProgress, {
        record: (event) => Ref.update(current, (previous): CLISyncReport => {
          if (typeof event === "string") return { ...previous, phase: event === "started" ? "syncing" : "error" }
          const prior = new Map(previous.jobs.map(job => [`${job.projectId}\0${job.adapterId}`, job]))
          return { phase: "waiting", jobsTruncated: false, jobs: [
            ...event.jobs.map(job => ({ projectId: job.projectId, projectName: job.projectId, adapterId: job.adapterId,
              state: job.sourceFailures?.length || job.sourceFailuresTruncated ? "partial" as const : "synced" as const,
              ...(job.sourceFailures?.length || job.sourceFailuresTruncated ? { reason: "partial" as const } : {}),
              ...(job.sourceFailures?.length || job.sourceFailuresTruncated
                ? (prior.get(`${job.projectId}\0${job.adapterId}`)?.lastSuccessAt ? { lastSuccessAt: prior.get(`${job.projectId}\0${job.adapterId}`)!.lastSuccessAt! } : {})
                : { lastSuccessAt: event.completedAt }),
              lastAttemptAt: event.completedAt, hasMore: job.hasMore })),
            ...event.failures.map(job => ({ projectId: job.projectId, projectName: job.projectId, adapterId: job.adapterId,
              state: "failed" as const, reason: job.reason, hasMore: false, lastAttemptAt: event.completedAt,
              ...(prior.get(`${job.projectId}\0${job.adapterId}`)?.lastSuccessAt ? { lastSuccessAt: prior.get(`${job.projectId}\0${job.adapterId}`)!.lastSuccessAt! } : {}) }))
          ] }
        })
      }))
    })).pipe(Effect.ensuring(
      Ref.update(current, report => ({ ...report, phase: report.phase === "error" ? "error" as const : "stopped" as const })).pipe(
        Effect.andThen(publish.pipe(Effect.interruptible)), Effect.timeoutOption(5_000), Effect.asVoid
      )
    ))
  })

// Privacy boundary: a report contains only jobs for this authenticated account/instance.
// Retained local diagnostics are projected to categories, never copied into the report.
export const scopeCollectorReport = (snapshot: CLISyncReport, config: ClientConfig,
  account: { readonly instanceOrigin: string; readonly userId: string }, persisted?: CollectorRunState): CLISyncReport => {
  const projects = config.projects.filter(project => project.instanceOrigin === account.instanceOrigin && project.userId === account.userId)
  const recorded = new Map(snapshot.jobs.map(job => [`${job.projectId}\0${job.adapterId}`, job]))
  const previous = new Map(persisted?.jobs.map(job => [`${job.projectId}\0${job.adapterId}`, job]) ?? [])
  const jobs = projects.flatMap(project => config.enabledAdapterIds.map((adapterId): CLISyncJob => {
    const key = `${project.id}\0${adapterId}`
    const live = recorded.get(key)
    const old = previous.get(key)
    const partial = !!(old?.sourceFailures?.length || old?.sourceFailuresTruncated)
    const priorSuccess = old?.lastSuccessAt && !partial ? old.lastSuccessAt : undefined
    return {
      ...(priorSuccess ? { lastSuccessAt: priorSuccess } : {}),
      ...(live ?? { projectId: project.id, adapterId, hasMore: old?.hasMore ?? false,
        state: old?.failureMessage ? "failed" : partial ? "partial" : old ? "synced" : "pending",
        ...(old?.failureReason ? { reason: old.failureReason } : partial ? { reason: "partial" as const } : {}),
        ...(old?.lastAttemptAt ? { lastAttemptAt: old.lastAttemptAt } : {}) }),
      projectName: Array.from(project.name).slice(0, 50).join("")
    }
  }))
  const priority = (job: CLISyncJob) => job.state === "failed" || job.state === "partial" ? 0 : job.hasMore ? 1 : job.state === "pending" ? 2 : 3
  jobs.sort((a, b) => priority(a) - priority(b))
  return { ...snapshot, jobs: jobs.slice(0, 20), jobsTruncated: jobs.length > 20 }
}
