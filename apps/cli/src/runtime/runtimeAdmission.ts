import { Effect } from "effect"
import { captureStateContract, cliVersion } from "../version.ts"
import { createUpdateControl, type UpdateRuntimeAdmission } from "./updateControl.ts"

export type RuntimeContext = {
  readonly home: string
  readonly identity: UpdateRuntimeAdmission
}

// These values describe this executable, never a replaced npm manifest or the
// selected target. An already-open console keeps its original reader identity.
export const actualRuntimeIdentity: UpdateRuntimeAdmission = Object.freeze({ version: cliVersion, captureStateContract })
export const runtimeContext = (home: string): RuntimeContext => ({ home, identity: actualRuntimeIdentity })

// Source executions have no published reader version. This literal is the only
// bypass; installed executables always carry the identity compiled at release.
export const assertRuntimeDataAdmission = async (context: RuntimeContext): Promise<void> => {
  if (context.identity.version !== "development") await createUpdateControl(context.home).assertRuntimeAdmission(context.identity)
}

const guarded = <A, E, R, F>(context: RuntimeContext, program: Effect.Effect<A, E, R>, mapError: (cause: unknown) => F,
  cleanup: boolean): Effect.Effect<A, E | F, R> => {
  if (context.identity.version === "development") return program
  const control = createUpdateControl(context.home)
  return Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => cleanup ? control.acquireRuntimeWriteBarrier() : control.acquireRuntimeWrite(context.identity), catch: mapError }),
    () => program,
    release => Effect.sync(release)
  ).pipe(Effect.uninterruptible)
}

/** The caller already holds its existing store lock. Keep this lease around
 * only the actual atomic write/SQLite transaction, with no nested Module locks,
 * network, subprocesses or whole resource Scope. Acquisition and settled writes
 * are joined on cancellation so neither a write nor its lease can escape. */
export const guardRuntimeWrite = <A, E, R, F>(context: RuntimeContext, program: Effect.Effect<A, E, R>, mapError: (cause: unknown) => F):
  Effect.Effect<A, E | F, R> => guarded(context, program, mapError, false)

/** Cleanup only: closing a SQLite handle may materialize already-committed WAL
 * bytes after this executable loses admission. This grants no logical writes.
 * The caller still guarantees physical handle closure if acquiring the barrier fails. */
export const withRuntimeWriteBarrier = <A, E, R, F>(context: RuntimeContext, program: Effect.Effect<A, E, R>, mapError: (cause: unknown) => F):
  Effect.Effect<A, E | F, R> => guarded(context, program, mapError, true)
