import { Context, Effect, Schema } from "effect"

export class CollectorDaemonProcessError extends Schema.TaggedError<CollectorDaemonProcessError>()(
  "CollectorDaemonProcessError",
  {
    reason: Schema.Literals(["io", "identity", "start", "stop"]),
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
  // Restart only a running Host whose executable changed; preserve its schedule.
  refresh(): Effect.Effect<boolean, CollectorDaemonProcessError>
  stop(): Effect.Effect<boolean, CollectorDaemonProcessError>
  inspect(): Effect.Effect<Omit<CollectorDaemonProcessSnapshot, "created"> | undefined, CollectorDaemonProcessError>
}>()("atape/application/CollectorDaemonProcess") {}

export const refreshManagedCollector = Effect.fn("CollectorDaemon.refresh")(function*() {
  return yield* (yield* CollectorDaemonProcess).refresh()
})
