import { CollectorStateError, CollectorStateStore, type CollectorStateSnapshot } from "@atape/application"
import { CollectorState as CollectorStateSchema, emptyCollectorState, type CollectorCheckpoint, type CollectorState } from "@atape/domain"
import { randomUUID } from "node:crypto"
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { withCollectorStateLock } from "./collectorStateLock.ts"
import { captureInstallationPath, capturePathState, captureRoot, readCaptureInstallation } from "./captureBinding.ts"

export const makeCollectorStateLayer = (stateFile: string) => Layer.succeed(
  CollectorStateStore,
  CollectorStateStore.of({
    capturedScopes: () => withCollectorState(stateFile, state => ({
      value: state.checkpoints.filter(checkpoint => checkpoint.canonicalPublished === true || checkpoint.rawObjects.length > 0)
        .map(({ instanceOrigin, userId, projectId, projectCreatedAt, adapterId }) =>
          ({ instanceOrigin, userId, projectId, projectCreatedAt, adapterId }))
    })),
    snapshot: (instanceOrigin, userId, projectId, adapterId) => withCollectorState(stateFile, (state) => ({
      value: (() => {
        const checkpoint = state.checkpoints.find((item) =>
          item.instanceOrigin === instanceOrigin && item.userId === userId &&
          item.projectId === projectId && item.adapterId === adapterId)
        return {
          installationId: state.installationId,
          ...(checkpoint === undefined ? {} : { checkpoint })
        } satisfies CollectorStateSnapshot
      })()
    })),
    commit: ({ instanceOrigin, userId, projectId, adapterId, expectedRevision, checkpoint }) =>
      withCollectorState(stateFile, (state) => {
        const current = state.checkpoints.find((item) =>
          item.instanceOrigin === instanceOrigin && item.userId === userId &&
          item.projectId === projectId && item.adapterId === adapterId)
        const currentRevision = current?.revision ?? 0
        if (currentRevision !== expectedRevision || checkpoint.revision !== expectedRevision + 1 ||
          checkpoint.instanceOrigin !== instanceOrigin || checkpoint.userId !== userId ||
          checkpoint.projectId !== projectId || checkpoint.adapterId !== adapterId) {
          throw new CollectorStateError({
            reason: "conflict",
            message: `Collector checkpoint ${projectId}/${adapterId} advanced concurrently.`
          })
        }
        return {
          value: undefined,
          state: {
            ...state,
            checkpoints: [
              ...state.checkpoints.filter((item) =>
                item.instanceOrigin !== instanceOrigin || item.userId !== userId ||
                item.projectId !== projectId || item.adapterId !== adapterId),
              checkpoint
            ].sort((left, right) =>
              checkpointKey(left).localeCompare(checkpointKey(right)))
          }
        }
      })
  })
)

type CollectorStateChange<A> = {
  readonly value: A
  readonly state?: CollectorState
}

const withCollectorState = <A>(
  stateFile: string,
  change: (state: CollectorState) => CollectorStateChange<A>
): Effect.Effect<A, CollectorStateError> => withCollectorStateLock(stateFile,
  readCollectorState(stateFile).pipe(
    Effect.flatMap((loaded) => Effect.try({
      try: () => ({ loaded, result: change(loaded.state) }),
      catch: (cause) => cause instanceof CollectorStateError ? cause : new CollectorStateError({
        reason: "io", message: errorMessage("Could not update the collector state", cause)
      })
    })),
    Effect.flatMap(({ loaded, result }) => result.state === undefined && !loaded.created
      ? Effect.succeed(result.value)
      : writeCollectorState(stateFile, result.state ?? loaded.state, loaded.created).pipe(Effect.as(result.value)))
  )
)

/** Bootstrap uses the same installation and lock as legacy checkpoint writes.
 * The callback's resources stay in its caller Scope; only the metadata lock ends. */
export const withCollectorInstallation = <A, E, R>(stateFile: string, use: (installationId: string) => Effect.Effect<A, E, R>) =>
  withCollectorStateLock(stateFile, Effect.gen(function*() {
    const loaded = yield* readCollectorState(stateFile)
    if (loaded.created) yield* writeCollectorState(stateFile, loaded.state, true)
    return yield* use(loaded.state.installationId)
  }))

const readCollectorState = (
  stateFile: string
): Effect.Effect<{ readonly state: CollectorState; readonly created: boolean }, CollectorStateError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return { value: JSON.parse(await readFile(stateFile, "utf8")) as unknown, created: false }
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) {
          return { value: undefined as unknown, created: true }
        }
        throw cause
      }
    },
    catch: (cause) => cause instanceof CollectorStateError ? cause : new CollectorStateError({
      reason: "io", message: errorMessage("Could not read the collector state", cause)
    })
  }).pipe(
    Effect.flatMap(loaded => !loaded.created ? Effect.succeed(loaded) : Effect.gen(function*() {
      const bound = yield* capturePathState(captureInstallationPath(stateFile)), root = yield* capturePathState(captureRoot(stateFile))
      if (bound !== null || root !== null) return yield* new CollectorStateError({ reason: "decode",
        message: "Collector state is missing while bound captures exist; restore the original installation state." })
      return { value: emptyCollectorState(`i_${randomUUID()}`) as unknown, created: true }
    })),
    Effect.flatMap(({ value, created }) => Schema.decodeUnknownEffect(CollectorStateSchema)(value).pipe(
      Effect.map((state) => ({ state, created }))
    )),
    Effect.tap(({ state }) => readCaptureInstallation(stateFile).pipe(Effect.flatMap(binding =>
      binding === null || binding.installationId === state.installationId ? Effect.void :
        Effect.fail(new CollectorStateError({ reason: "conflict", message: "Collector installation identity differs from its established capture binding." }))))),
    Effect.mapError((error) => error instanceof CollectorStateError
      ? error
      : new CollectorStateError({
        reason: "decode", message: `The ATape collector state is invalid: ${String(error)}`
      }))
  )

const writeCollectorState = (stateFile: string, state: CollectorState, initialize = false): Effect.Effect<void, CollectorStateError> =>
  Schema.decodeUnknownEffect(CollectorStateSchema)(state).pipe(
    Effect.mapError((error) => new CollectorStateError({
      reason: "decode", message: `ATape refused to persist invalid collector state: ${String(error)}`
    })),
    Effect.flatMap((validated) => Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
        const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`
        try {
          const file = await open(temporary, "wx", 0o600)
          try { await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`); await file.sync() } finally { await file.close() }
          if (initialize) await link(temporary, stateFile)
          else await rename(temporary, stateFile)
          const directory = await open(dirname(stateFile), "r")
          try { await directory.sync() } finally { await directory.close() }
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
      },
      catch: (cause) => new CollectorStateError({
        reason: "io", message: errorMessage("Could not write the collector state", cause)
      })
    }))
  )

const checkpointKey = (checkpoint: CollectorCheckpoint) =>
  `${checkpoint.instanceOrigin}\0${checkpoint.userId}\0${checkpoint.projectId}\0${checkpoint.adapterId}`

const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code
const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
