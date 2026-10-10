import type { CollectorRedactionJobStatus, CollectorRunFailure, CollectorRunState, RedactionConfigurationDescriptor } from "@atape/domain"
import { Clock, Context, Effect, Schema } from "effect"
import type { CollectionCycleReport } from "./collectorContracts.ts"
import { CollectorDaemonProcess, type CollectorDaemonObservation } from "./collectorDaemonProcess.ts"

export class CollectorRunStatusError extends Schema.TaggedError<CollectorRunStatusError>()("CollectorRunStatusError", {
  reason: Schema.Literals(["io", "decode"]), message: Schema.String
}) {}

type RedactionJobIdentity = {
  readonly projectId: string
  readonly adapterId: string
  readonly attemptId: string
  readonly at: string
}
export type CollectorRedactionJobEvent = RedactionJobIdentity & (
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly snapshot: RedactionConfigurationDescriptor }
  | { readonly kind: "finished"; readonly outcome: "completed" | "failed" | "interrupted" | "load_failed" }
)

export class CollectorRunStatusStore extends Context.Service<CollectorRunStatusStore, {
  read(): Effect.Effect<CollectorRunState, CollectorRunStatusError>
  recordCycle(report: CollectionCycleReport): Effect.Effect<void, CollectorRunStatusError>
  recordCollectorFailure(failure: CollectorRunFailure): Effect.Effect<void, CollectorRunStatusError>
  /** The Node Adapter records only for its explicitly admitted daemon generation. */
  recordRedactionJob(event: CollectorRedactionJobEvent): Effect.Effect<void, CollectorRunStatusError>
}>()("atape/application/CollectorRunStatusStore") {}

export type CollectorRedactionView = {
  readonly state: "running" | "stopped" | "unknown"
  readonly checkedAt: string
  readonly configFile?: string
  readonly origin?: "default" | "environment"
  readonly jobs: ReadonlyArray<CollectorRedactionJobStatus & {
    readonly scope: "current" | "historical"
    readonly comparison: "matches" | "different_revision" | "different_file" | "unknown"
  }>
}

const sameProcess = (before: CollectorDaemonObservation | undefined, after: CollectorDaemonObservation | undefined) =>
  before === undefined ? after === undefined : after !== undefined && before.generation === after.generation &&
    before.pid === after.pid && before.startedAt === after.startedAt

/** Pure observation: a file revision describes a loaded file, never console/daemon environment equality. */
export const inspectCollectorRedaction = (target?: { readonly configFile: string; readonly revision: string }): Effect.Effect<
  CollectorRedactionView, never, CollectorDaemonProcess | CollectorRunStatusStore
> => Effect.gen(function*() {
  const process = yield* CollectorDaemonProcess
  const statuses = yield* CollectorRunStatusStore
  const result = yield* Effect.gen(function*() {
    const before = yield* process.observe()
    const recorded = yield* statuses.read()
    const after = yield* process.observe()
    return { before, recorded, after }
  }).pipe(Effect.option)
  const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  const unknown: CollectorRedactionView = { state: "unknown", checkedAt, jobs: [] }
  if (result._tag === "None") return unknown
  const { before, recorded, after } = result.value
  if (!sameProcess(before, after)) return unknown
  const redaction = recorded.redaction
  if (after !== undefined && (redaction === undefined || redaction.generation !== after.generation)) return unknown
  const scope = after === undefined ? "historical" as const : "current" as const
  return {
    state: after === undefined ? "stopped" : "running", checkedAt,
    ...(redaction === undefined ? {} : { configFile: redaction.configFile, origin: redaction.origin }),
    jobs: (redaction?.jobs ?? []).map(job => ({ ...job, scope,
      comparison: target === undefined || job.snapshot === undefined ? "unknown" as const
        : job.snapshot.configFile !== target.configFile ? "different_file" as const
        : job.snapshot.revision !== target.revision ? "different_revision" as const : "matches" as const }))
  }
})
