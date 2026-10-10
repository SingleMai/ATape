import {
  CollectorDaemonProcess,
  CollectorDaemonProcessError,
  CollectorRunStatusError,
  CollectorRunStatusStore,
  type CollectorRedactionJobEvent,
  type CollectionCycleReport,
  type ResolvedCollectorDaemonOptions
} from "@atape/application"
import {
  CollectorRunState as CollectorRunStateSchema,
  emptyCollectorRunState,
  type CollectorJobRunStatus,
  type CollectorRedactionJobStatus,
  type CollectorRunState
} from "@atape/domain"
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { Effect, Layer, Option, Schema } from "effect"
import { acquireProcessLock } from "./processLock.ts"
import { readBoundedRedactionFile, selectRedactionConfigurationFile } from "./redactionConfigurationFile.ts"

export type NodeCollectorDaemonPaths = {
  readonly atapeHome?: string
  readonly collectorProcessFile: string
  readonly collectorStatusFile: string
  readonly collectorLogFile: string
}
type CollectorEntry = string | (() => Promise<string>)
const resolveCollectorEntry = (entry: CollectorEntry) => typeof entry === "string" ? Promise.resolve(entry) : entry()

// This is evidence for a finite retry cooldown, never a verdict that the
// candidate is permanently broken. It is emitted only after fallback readiness
// and maintenance release; callers still validate their restored selection.
export class CollectorMaintenanceFailure extends CollectorDaemonProcessError {
  readonly stage = "candidate-readiness" as const
  readonly recovery = "ready" as const
  constructor(failure: CollectorDaemonProcessError) {
    super({ reason: "start", message: failure.message })
  }
}
class LocalCollectorReadinessFailure extends CollectorDaemonProcessError {
  constructor(message: string) { super({ reason: "start", message }) }
}
class CollectorIdentityProbeBudgetExpired extends CollectorDaemonProcessError {
  constructor() { super({ reason: "identity", message: "Could not confirm ownership of the Collector process." }) }
}

const ProcessFileVersion = 1 as const
const CollectorProcessRecord = Schema.Struct({
  version: Schema.Literal(ProcessFileVersion),
  token: Schema.String,
  runtimeKey: Schema.optionalKey(Schema.String),
  restartPending: Schema.optionalKey(Schema.Boolean),
  pid: Schema.Number,
  startedAt: Schema.String,
  intervalMs: Schema.Number,
  concurrency: Schema.Number,
  logFile: Schema.String
})
type CollectorProcessRecord = typeof CollectorProcessRecord.Type

const CollectorMaintenance = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String,
  ownerPid: Schema.optionalKey(Schema.Number),
  generation: Schema.Number,
  phase: Schema.Literals(["pausing", "activating", "starting", "failed"]),
  resume: Schema.optionalKey(Schema.Struct({ intervalMs: Schema.Number, concurrency: Schema.Number }))
})
type CollectorMaintenance = typeof CollectorMaintenance.Type
const maintenanceFile = (processFile: string) => `${processFile}.maintenance.json`
const ReadyMarker = Schema.Struct({ token: Schema.String, pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)) })
const readReadyMarker = async (path: string): Promise<typeof ReadyMarker.Type | undefined> => {
  let bytes: string
  try { bytes = await readFile(path, "utf8") }
  catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined
    throw new CollectorDaemonProcessError({ reason: "io", message: errorMessage("Could not read Collector readiness metadata", cause) })
  }
  try { return Schema.decodeUnknownSync(ReadyMarker)(JSON.parse(bytes)) }
  catch { throw new CollectorDaemonProcessError({ reason: "identity", message: "Collector readiness metadata is invalid." }) }
}
const CollectorDesiredState = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), wanted: Schema.Literal(false) }),
  Schema.Struct({ version: Schema.Literal(1), wanted: Schema.Literal(true), intervalMs: Schema.Number, concurrency: Schema.Number,
    established: Schema.optionalKey(Schema.Literal(true)) })
])
type CollectorDesiredState = typeof CollectorDesiredState.Type
const desiredStateFile = (processFile: string) => `${processFile}.desired.json`

// The worker and collection admission use this Interface rather than interpreting
// the durable gate. A failed or crashed maintenance remains closed until recovery.
export const isCollectorMaintenancePending = async (processFile: string): Promise<boolean> =>
  (await readMaintenance(processFile)) !== undefined

// A spawned child can run before its parent publishes the process record. Wait
// briefly without taking the parent's launch lock, then admit only that child.
export const admitCollectorProcess = (processFile: string, token: string): Effect.Effect<void, CollectorDaemonProcessError> =>
  Effect.gen(function*() {
    const rejected = () => new CollectorDaemonProcessError({ reason: "identity",
      message: "This Collector entry is reserved for the owning ATape process." })
    if (!token) return yield* Effect.fail(rejected())
    const deadline = performance.now() + 2_000
    while (performance.now() < deadline) {
      const record = yield* Effect.tryPromise({ try: () => readProcessRecord(processFile),
        catch: cause => cause instanceof CollectorDaemonProcessError ? cause : rejected() })
      if (record?.token === token && record.pid === process.pid) return
      yield* Effect.sleep(Math.min(25, Math.max(0, deadline - performance.now())))
    }
    return yield* Effect.fail(rejected())
  })

export const withCollectorMaintenance = async <A>(
  paths: NodeCollectorDaemonPaths,
  resolveEntry: () => Promise<string>,
  environment: NodeJS.ProcessEnv,
  activate: (deadline: number) => Promise<A>,
  options: { readonly recover?: (cause: unknown, deadline: number) => Promise<void>; readonly readyTimeoutMs?: number;
    readonly activationTimeoutMs?: number; readonly recoveryTimeoutMs?: number } = {}
): Promise<A> => {
  if (process.platform === "win32") throw unsupportedManagedProcessPlatform()
  const deadline = performance.now() + (options.activationTimeoutMs ?? 45_000)
  // Ownership spans the whole handoff, while the short process lock remains
  // available between transitions so an explicit user Stop can cancel restart.
  const release = await acquireProcessLock(`${paths.collectorProcessFile}.maintenance.lock.sqlite`)
  if (!release) throw new CollectorDaemonProcessError({ reason: "identity", message: "Another ATape updater owns Collector maintenance." })
  try { return await performCollectorMaintenance(paths, resolveEntry, environment, activate, options, deadline) }
  finally { release() }
}

const performCollectorMaintenance = async <A>(
  paths: NodeCollectorDaemonPaths,
  resolveEntry: () => Promise<string>,
  environment: NodeJS.ProcessEnv,
  activate: (deadline: number) => Promise<A>,
  options: { readonly recover?: (cause: unknown, deadline: number) => Promise<void>; readonly readyTimeoutMs?: number;
    readonly activationTimeoutMs?: number; readonly recoveryTimeoutMs?: number },
  activationDeadline: number
): Promise<A> => {
  let deadline = activationDeadline
  const remaining = () => {
    const milliseconds = deadline - performance.now()
    if (milliseconds <= 0) throw new CollectorDaemonProcessError({ reason: "start", message: "Collector maintenance deadline expired." })
    return milliseconds
  }
  const lock = <B>(work: () => Promise<B>) => withProcessLockPromise(paths.collectorProcessFile, async () => {
    remaining()
    return work()
  }, Math.min(10_000, remaining()))
  const token = randomUUID()
  const claim = await lock(async () => {
    const previous = await readMaintenance(paths.collectorProcessFile)
    const running = await readProcessRecord(paths.collectorProcessFile)
    const desired = await desiredState(paths.collectorProcessFile, running, previous, deadline)
    const resume = !desired.wanted ? undefined : previous === undefined
      ? { intervalMs: desired.intervalMs, concurrency: desired.concurrency }
      : previous.resume
    const gate: CollectorMaintenance = { version: 1, token, ownerPid: process.pid,
      generation: previous?.generation ?? 0, phase: "pausing", ...(resume ? { resume } : {}) }
    await writeMaintenance(paths.collectorProcessFile, gate)
    return { gate }
  })

  const mutateGate = (change: (gate: CollectorMaintenance) => CollectorMaintenance) =>
    lock(async () => {
      const gate = await ownedMaintenance(paths.collectorProcessFile, token)
      await writeMaintenance(paths.collectorProcessFile, change(gate))
      remaining()
    })
  const stopCurrent = () => lock(async () => {
    await ownedMaintenance(paths.collectorProcessFile, token)
    const record = await readProcessRecord(paths.collectorProcessFile)
    if (record) await stopOwnedProcess(paths.collectorProcessFile, record, true, deadline)
    else await rm(paths.collectorProcessFile, { force: true })
  })
  const resume = async (): Promise<"ready" | "stopped"> => {
    const readyFile = `${maintenanceFile(paths.collectorProcessFile)}.${token}.ready`
    const readyToken = randomUUID()
    const readyDeadline = Math.min(deadline, performance.now() + (options.readyTimeoutMs ?? 10_000))
    const checkReadinessDeadline = () => {
      remaining()
      if (performance.now() >= readyDeadline) throw new CollectorDaemonProcessError({ reason: "start",
        message: "The updated Collector did not become locally ready." })
    }
    let launched: CollectorProcessRecord | undefined
    try {
      await lock(async () => {
        const gate = await ownedMaintenance(paths.collectorProcessFile, token)
        if (gate.generation !== claim.gate.generation || !gate.resume) return
        if (!(await desiredState(paths.collectorProcessFile, undefined, gate, deadline)).wanted) return
        const entry = await resolveEntry()
        checkReadinessDeadline()
        const runtimeKey = await executableKey(entry)
        checkReadinessDeadline()
        await writeMaintenance(paths.collectorProcessFile, { ...gate, phase: "starting" })
        checkReadinessDeadline()
        await launchProcess(paths, entry, { ...environment,
          ATAPE_COLLECTOR_READY_FILE: readyFile, ATAPE_COLLECTOR_READY_TOKEN: readyToken
        }, gate.resume, runtimeKey, readyDeadline)
        launched = await readProcessRecord(paths.collectorProcessFile)
      })
      if (launched) {
        let identityUncertain = false
        while (performance.now() < readyDeadline) {
          const gate = await ownedMaintenance(paths.collectorProcessFile, token)
          // User Stop wins even while the new runtime is preparing readiness.
          if (gate.generation !== claim.gate.generation || !gate.resume ||
            !(await readDesiredState(paths.collectorProcessFile))?.wanted) {
            await stopCurrent()
            return "stopped"
          }
          const ready = await readReadyMarker(readyFile)
          if (ready !== undefined && (ready.token !== readyToken || ready.pid !== launched.pid)) throw new CollectorDaemonProcessError({ reason: "identity",
            message: "Collector readiness marker does not match its launched process." })
          if (performance.now() >= readyDeadline) break
          // Identity uncertainty must survive even when its probe consumed the
          // readiness budget. It is not a local-readiness failure verdict.
          let owned: boolean
          try { owned = await isOwnedProcess(launched, readyDeadline) }
          catch (cause) {
            // No ownership observation was attempted. The existing readiness
            // evidence decides expiry; errors from a real ps probe still fail.
            if (cause instanceof CollectorIdentityProbeBudgetExpired) break
            throw cause
          }
          if (!owned) {
            if (!processExists(launched.pid)) throw new LocalCollectorReadinessFailure("The updated Collector did not become locally ready.")
            // ps can stop reporting an exiting child before kill(pid, 0)
            // observes its reap. Confirm within the existing readiness budget;
            // a still-live mismatch at its end remains identity uncertainty.
            identityUncertain = true
            await delay(Math.min(50, Math.max(0, readyDeadline - performance.now())))
            continue
          }
          identityUncertain = false
          if (ready !== undefined) return "ready"
          await delay(Math.min(50, Math.max(0, readyDeadline - performance.now())))
        }
        if (identityUncertain && processExists(launched.pid)) throw new CollectorDaemonProcessError({ reason: "identity",
          message: "Could not confirm ownership of the updated Collector process." })
        throw new LocalCollectorReadinessFailure("The updated Collector did not become locally ready.")
      }
      return "stopped"
    } finally {
      await rm(readyFile, { force: true }).catch(cause => { throw new CollectorDaemonProcessError({ reason: "io",
        message: errorMessage("Could not remove Collector readiness metadata", cause) }) })
    }
  }
  const release = () => lock(async () => {
    const gate = await ownedMaintenance(paths.collectorProcessFile, token)
    const stillWanted = gate.generation === claim.gate.generation && gate.resume !== undefined &&
      (await readDesiredState(paths.collectorProcessFile))?.wanted === true
    await rm(maintenanceFile(paths.collectorProcessFile), { force: true })
    await syncDirectory(dirname(paths.collectorProcessFile))
    return stillWanted
  })
  const markFailed = () => withProcessLockPromise(paths.collectorProcessFile, async () => {
    const { ownerPid: _, ...gate } = await ownedMaintenance(paths.collectorProcessFile, token)
    await writeMaintenance(paths.collectorProcessFile, { ...gate, phase: "failed" })
  })
  let stopped = false
  try {
    await stopCurrent()
    stopped = true
    remaining()
    await mutateGate(gate => ({ ...gate, phase: "activating" }))
    const result = await activate(deadline)
    remaining()
    await resume()
    remaining()
    await release()
    return result
  } catch (cause) {
    deadline = performance.now() + (options.recoveryTimeoutMs ?? 30_000)
    let recoveredReady = false
    try {
      if (stopped) await stopCurrent()
      remaining()
      if (stopped && options.recover) {
        await options.recover(cause, deadline)
        remaining()
        const resumed = await resume()
        remaining()
        recoveredReady = await release() && resumed === "ready"
      } else await markFailed()
    } catch (recoveryCause) {
      await markFailed().catch(() => {})
      throw new CollectorDaemonProcessError({ reason: "start",
        message: `Collector maintenance needs recovery: ${recoveryCause instanceof Error ? recoveryCause.message : String(recoveryCause)}` })
    }
    if (cause instanceof LocalCollectorReadinessFailure && recoveredReady) throw new CollectorMaintenanceFailure(cause)
    throw cause
  }
}

export const makeNodeCollectorDaemonLayer = (
  paths: NodeCollectorDaemonPaths,
  entryFile: CollectorEntry,
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly collectorToken?: string } = {}
) => Layer.merge(
  makeCollectorDaemonProcessLayer(paths, entryFile, environment),
  makeCollectorRunStatusLayer(paths.collectorStatusFile, options.collectorToken === undefined ? undefined : {
    processFile: paths.collectorProcessFile, collectorToken: options.collectorToken,
    ...selectRedactionConfigurationFile({ ...(paths.atapeHome === undefined ? {} : { atapeHome: paths.atapeHome }), environment })
  })
)

type CollectorRedactionWriter = {
  readonly processFile: string
  readonly collectorToken: string
  readonly configFile: string
  readonly origin: "default" | "environment"
}
export const makeCollectorRunStatusLayer = (statusFile: string, writer?: CollectorRedactionWriter) => Layer.succeed(
  CollectorRunStatusStore,
  CollectorRunStatusStore.of({
    read: () => readRunState(statusFile),
    recordCycle: report => transactRunState(statusFile, current => Effect.succeed(applyCycle(current, report))),
    recordCollectorFailure: failure => transactRunState(statusFile, current => Effect.succeed({ ...current, collectorFailure: failure })),
    recordRedactionJob: event => writer === undefined ? Effect.void : transactRunState(statusFile, current => Effect.gen(function*() {
      const record = yield* Effect.tryPromise({ try: () => readProcessRecord(writer.processFile),
        catch: () => new CollectorRunStatusError({ reason: "io", message: "Could not confirm Collector status ownership." }) })
      if (record?.pid !== process.pid || record.token !== writer.collectorToken) return undefined
      return applyRedactionJob(current, event, writer)
    }))
  })
)

const makeCollectorDaemonProcessLayer = (
  paths: NodeCollectorDaemonPaths,
  entryFile: CollectorEntry,
  environment: NodeJS.ProcessEnv
) => Layer.succeed(
  CollectorDaemonProcess,
  CollectorDaemonProcess.of({
    start: (options) => processStart(paths, entryFile, environment, options),
    resume: () => processResume(paths, entryFile, environment),
    pause: () => processPause(paths.collectorProcessFile),
    refresh: () => processRefresh(paths, entryFile, environment),
    stop: () => processStop(paths.collectorProcessFile),
    inspect: () => processInspect(paths.collectorProcessFile),
    observe: () => processObserve(paths.collectorProcessFile)
  })
)

const processStart = (
  paths: NodeCollectorDaemonPaths,
  entryFile: CollectorEntry,
  environment: NodeJS.ProcessEnv,
  options: ResolvedCollectorDaemonOptions
) => {
  if (process.platform === "win32") return Effect.fail(unsupportedManagedProcessPlatform())
  return withProcessLock(paths.collectorProcessFile, async () => {
    await rejectMaintenance(paths.collectorProcessFile)
    const existing = await readProcessRecord(paths.collectorProcessFile)
    const owned = existing !== undefined && await isOwnedProcess(existing)
    const schedule = existing && (owned || existing.restartPending) ? existing : options
    await writeDesiredState(paths.collectorProcessFile, { version: 1, wanted: true,
      intervalMs: schedule.intervalMs, concurrency: schedule.concurrency,
      ...(owned || existing?.restartPending ? { established: true } : {}) })
    return startProcess(paths, entryFile, environment, options, existing, owned)
  }).pipe(Effect.uninterruptible)
}

const processResume = (paths: NodeCollectorDaemonPaths, entryFile: CollectorEntry, environment: NodeJS.ProcessEnv) => {
  if (process.platform === "win32") return Effect.fail(unsupportedManagedProcessPlatform())
  return withProcessLock(paths.collectorProcessFile, async () => {
    const existing = await readProcessRecord(paths.collectorProcessFile)
    const gate = await readMaintenance(paths.collectorProcessFile)
    const desired = await desiredState(paths.collectorProcessFile, existing, gate)
    if (!desired.wanted) return undefined
    await rejectMaintenance(paths.collectorProcessFile)
    return startProcess(paths, entryFile, environment, desired, existing,
      existing !== undefined && await isOwnedProcess(existing))
  }, 10_000).pipe(Effect.uninterruptible)
}

// Callers already hold the transition lock and have established user intent.
const startProcess = async (
  paths: NodeCollectorDaemonPaths, entryFile: CollectorEntry, environment: NodeJS.ProcessEnv,
  options: ResolvedCollectorDaemonOptions, existing: CollectorProcessRecord | undefined, owned: boolean
) => {
  const entry = await resolveCollectorEntry(entryFile)
  const runtimeKey = await executableKey(entry)
  if (existing !== undefined && owned) {
    if (!existing.restartPending && existing.runtimeKey === runtimeKey) {
      await establishDesiredState(paths.collectorProcessFile)
      return { ...presentProcess(existing), created: false }
    }
    return restartProcess(paths, entry, environment, existing, runtimeKey)
  }
  if (existing !== undefined) return restartProcess(paths, entry, environment,
    existing.restartPending ? existing : { ...existing, intervalMs: options.intervalMs, concurrency: options.concurrency }, runtimeKey)
  return launchProcess(paths, entry, environment, options, runtimeKey)
}

const processRefresh = (paths: NodeCollectorDaemonPaths, entryFile: CollectorEntry, environment: NodeJS.ProcessEnv) => {
  // No managed daemon exists on Windows; Adapter maintenance remains available.
  if (process.platform === "win32") return Effect.succeed(false)
  return withProcessLock(paths.collectorProcessFile, async () => {
    await rejectMaintenance(paths.collectorProcessFile)
    const existing = await readProcessRecord(paths.collectorProcessFile)
    if (!(await desiredState(paths.collectorProcessFile, existing)).wanted) return false
    if (existing === undefined) return false
    if (!existing.restartPending && !(await isOwnedProcess(existing))) {
      await writeProcessRecord(paths.collectorProcessFile, { ...existing, restartPending: true })
      return false
    }
    // Read the replacement before stopping; an unreadable installation must
    // not terminate a working Collector. Legacy metadata requires one restart.
    const entry = await resolveCollectorEntry(entryFile)
    const runtimeKey = await executableKey(entry)
    if (!existing.restartPending && existing.runtimeKey === runtimeKey) return false
    await restartProcess(paths, entry, environment, existing, runtimeKey)
    return true
  }).pipe(Effect.uninterruptible)
}

// Persist restart intent before terminating the old Host. A failed spawn or a
// crashed maintenance command can resume without treating sync as user-stopped.
const restartProcess = async (
  paths: NodeCollectorDaemonPaths, entryFile: string, environment: NodeJS.ProcessEnv,
  existing: CollectorProcessRecord, runtimeKey: string
) => {
  const pending = { ...existing, restartPending: true }
  await writeProcessRecord(paths.collectorProcessFile, pending)
  await establishDesiredState(paths.collectorProcessFile)
  try {
    await stopOwnedProcess(paths.collectorProcessFile, existing, false)
    return await launchProcess(paths, entryFile, environment, existing, runtimeKey)
  } catch (cause) {
    // launchProcess publishes the replacement before confirming ownership. Do
    // not overwrite an unconfirmed child's identity with the exited old PID.
    const current = await readProcessRecord(paths.collectorProcessFile)
    await writeProcessRecord(paths.collectorProcessFile,
      current && current.token !== existing.token ? { ...current, restartPending: true } : pending)
    throw cause
  }
}

const executableKey = async (entryFile: string) => {
  const entry = await realpath(resolve(entryFile))
  return createHash("sha256").update(JSON.stringify([process.execPath, entry]))
    .update(await readFile(entry)).digest("hex")
}

const launchProcess = async (
  paths: NodeCollectorDaemonPaths, entryFile: string, environment: NodeJS.ProcessEnv,
  options: ResolvedCollectorDaemonOptions, runtimeKey: string,
  deadline = performance.now() + 2_000
) => {
  await mkdir(dirname(paths.collectorProcessFile), { recursive: true, mode: 0o700 })
  await mkdir(dirname(paths.collectorLogFile), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const log = await open(paths.collectorLogFile, "a", 0o600)
  let child
  try {
    if (performance.now() >= deadline) throw new CollectorDaemonProcessError({ reason: "start",
      message: "The Collector startup deadline expired before launch." })
    child = spawn(process.execPath, [
      resolve(entryFile),
      "__collector-daemon",
      "--interval", String(options.intervalMs / 1_000),
      "--concurrency", String(options.concurrency),
      "--daemon-token", token
    ], {
      detached: true,
      env: environment,
      stdio: ["ignore", log.fd, log.fd]
    })
  } finally {
    await log.close()
  }
  if (child.pid === undefined) {
    throw new CollectorDaemonProcessError({ reason: "start", message: "Node did not return a Collector process ID." })
  }
  child.unref()
  const record: CollectorProcessRecord = {
    version: ProcessFileVersion,
    token,
    runtimeKey,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    intervalMs: options.intervalMs,
    concurrency: options.concurrency,
    logFile: paths.collectorLogFile
  }
  try { await writeProcessRecord(paths.collectorProcessFile, record) } catch (cause) {
    // Before metadata exists, only the spawning ChildProcess owns this PID.
    // Do not leave a child running which later Stop cannot discover.
    child.kill("SIGKILL")
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); child.removeListener("error", finish); resolve() }
      const timer = setTimeout(finish, Math.max(0, Math.min(2_000, deadline - performance.now())))
      child.once("exit", finish)
      child.once("error", finish)
    })
    throw cause
  }
  // Once a PID record exists, its removal by a retained pre-intent CLI means
  // Stop. Preserve that distinction even if ownership confirmation then fails.
  await establishDesiredState(paths.collectorProcessFile)
  while (performance.now() < deadline) {
    if (await isOwnedProcess(record, deadline)) return { ...presentProcess(record), created: true }
    if (!processExists(record.pid)) throw new LocalCollectorReadinessFailure(
      `The Collector process exited during startup. Inspect ${paths.collectorLogFile}.`)
    await delay(Math.min(50, Math.max(0, deadline - performance.now())))
  }
  // An unconfirmed startup may still own a process. Preserve its identity so
  // recovery must terminate it before launching a replacement.
  if (processExists(record.pid)) throw new CollectorDaemonProcessError({ reason: "identity",
    message: "Could not confirm ownership of the Collector process." })
  throw new LocalCollectorReadinessFailure(`The Collector process exited during startup. Inspect ${paths.collectorLogFile}.`)
}

const processPause = (processFile: string) => {
  if (process.platform === "win32") return Effect.fail(unsupportedManagedProcessPlatform())
  return withProcessLock(processFile, async () => {
    const record = await readProcessRecord(processFile)
    await desiredState(processFile, record, await readMaintenance(processFile))
    if (record === undefined) return false
    await writeProcessRecord(processFile, { ...record, restartPending: true })
    return stopOwnedProcess(processFile, record, false)
  }, 10_000).pipe(Effect.uninterruptible)
}

const processStop = (processFile: string) => {
  if (process.platform === "win32") return Effect.fail(unsupportedManagedProcessPlatform())
  return withProcessLock(processFile, async () => {
    // Persist even when no PID exists: a login trigger or interrupted updater
    // must not reinterpret the absent process as permission to resume.
    await writeDesiredState(processFile, { version: 1, wanted: false })
    const gate = await readMaintenance(processFile)
    if (gate) {
      const { resume: _, ...stopped } = gate
      await writeMaintenance(processFile, { ...stopped, generation: gate.generation + 1 })
    }
    const record = await readProcessRecord(processFile)
    if (record === undefined) return false
    return stopOwnedProcess(processFile, record)
  }, 10_000).pipe(Effect.uninterruptible)
}

const stopOwnedProcess = async (processFile: string, record: CollectorProcessRecord, clear = true, maintenanceDeadline = Infinity) => {
  const started = performance.now(), gracefulDeadline = Math.min(started + 5_000, maintenanceDeadline),
    deadline = Math.min(started + 7_000, maintenanceDeadline)
  if (!await signalOwnedProcess(record, "SIGTERM", gracefulDeadline)) {
    if (clear) await rm(processFile, { force: true })
    return false
  }
  if (!await waitForExit(record, gracefulDeadline)) {
    await signalOwnedProcess(record, "SIGKILL", deadline)
  }
  if (!await waitForExit(record, deadline)) {
    throw new CollectorDaemonProcessError({ reason: "stop", message: "The managed Collector did not stop." })
  }
  if (clear) await rm(processFile, { force: true })
  return true
}

const processInspect = (processFile: string) => {
  if (process.platform === "win32") return Effect.fail(unsupportedManagedProcessPlatform())
  return withProcessLock(processFile, async () => {
    const record = await readProcessRecord(processFile)
    const desired = await desiredState(processFile, record, await readMaintenance(processFile))
    if (record === undefined) return undefined
    if (await isOwnedProcess(record)) {
      await establishDesiredState(processFile)
      return presentProcess(record)
    }
    if (!record.restartPending) {
      if (desired.wanted) await writeProcessRecord(processFile, { ...record, restartPending: true })
      else await rm(processFile, { force: true })
    }
    return undefined
  })
}

const processGeneration = (token: string) => createHash("sha256").update(token).digest("hex")

// Privacy inspection is deliberately read-only: unlike inspect, it never
// repairs desired state or acquires a lock that would create local files.
const processObserve = (processFile: string) => Effect.tryPromise({
  try: async () => {
    if (process.platform === "win32") throw unsupportedManagedProcessPlatform()
    const record = await readProcessRecord(processFile)
    if (record === undefined) return undefined
    try { process.kill(record.pid, 0) } catch (cause) {
      if (hasCode(cause, "ESRCH")) return undefined
      if (!hasCode(cause, "EPERM")) throw cause
    }
    if (!(await isOwnedProcess(record))) {
      if (!processExists(record.pid)) return undefined
      throw new Error("Collector ownership could not be confirmed")
    }
    return { generation: processGeneration(record.token), pid: record.pid, startedAt: record.startedAt }
  },
  catch: () => new CollectorDaemonProcessError({ reason: "identity", message: "Could not confirm the current Collector process." })
})

const presentProcess = (record: CollectorProcessRecord) => ({
  pid: record.pid,
  startedAt: record.startedAt,
  intervalMs: record.intervalMs,
  concurrency: record.concurrency,
  logFile: record.logFile
})

const readProcessRecord = async (processFile: string): Promise<CollectorProcessRecord | undefined> => {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode((await readBoundedRedactionFile(processFile, 16 * 1024)).bytes)) as unknown
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined
    throw new CollectorDaemonProcessError({
      reason: "io", message: "Could not read Collector process metadata."
    })
  }
  const decoded = Schema.decodeUnknownOption(CollectorProcessRecord)(value)
  if (Option.isNone(decoded) || !Number.isSafeInteger(decoded.value.pid) || decoded.value.pid <= 0 ||
    decoded.value.token.length === 0 || decoded.value.token.length > 1024 || /[\s\x00-\x1f\x7f]/.test(decoded.value.token)) {
    throw new CollectorDaemonProcessError({
      reason: "identity", message: "Collector process metadata is invalid."
    })
  }
  return decoded.value
}

const writeProcessRecord = async (processFile: string, record: CollectorProcessRecord) => {
  const temporary = `${processFile}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await rename(temporary, processFile)
  } catch (cause) {
    throw new CollectorDaemonProcessError({
      reason: "io", message: errorMessage("Could not write Collector process metadata", cause)
    })
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

const withProcessLock = <A>(
  processFile: string,
  use: () => Promise<A>,
  waitMs = 0
): Effect.Effect<A, CollectorDaemonProcessError> => Effect.tryPromise({
  try: () => withProcessLockPromise(processFile, use, waitMs),
  catch: (cause) => cause instanceof CollectorDaemonProcessError ? cause : new CollectorDaemonProcessError({
    reason: "io", message: errorMessage("Could not manage the Collector process", cause)
  })
})

const withProcessLockPromise = async <A>(processFile: string, use: () => Promise<A>, waitMs = 0): Promise<A> => {
  try {
    // Legacy .lock metadata may be empty or name a reused PID after a crash.
    // It is deliberately not read, reclaimed, or removed by the OS-lock protocol.
    const release = await acquireProcessLock(`${processFile}.lock.sqlite`, waitMs)
    if (!release) throw new CollectorDaemonProcessError({ reason: "io", message: "Another ATape command is changing the Collector process." })
    try { return await use() } finally { release() }
  } catch (cause) {
    throw cause instanceof CollectorDaemonProcessError ? cause : new CollectorDaemonProcessError({
        reason: "io",
        message: errorMessage("Could not manage the Collector process", cause)
      })
  }
}

const isOwnedProcess = async (record: CollectorProcessRecord, deadline?: number) => {
  try {
    process.kill(record.pid, 0)
  } catch (cause) {
    if (hasCode(cause, "ESRCH")) return false
    if (!hasCode(cause, "EPERM")) throw cause
  }
  try {
    const remaining = deadline === undefined ? 2_000 : Math.min(2_000, Math.ceil(deadline - performance.now()))
    if (remaining <= 0) throw new CollectorIdentityProbeBudgetExpired()
    const command = await execFileText("ps", ["-p", String(record.pid), "-o", "command="], remaining)
    const token = record.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return /(?:^|\s)__collector-daemon(?:\s|$)/.test(command) &&
      new RegExp(`(?:^|\\s)--daemon-token\\s+${token}(?:\\s|$)`).test(command)
  } catch (cause) {
    if (cause instanceof CollectorIdentityProbeBudgetExpired) throw cause
    if (!processExists(record.pid)) return false
    throw new CollectorDaemonProcessError({ reason: "identity", message: "Could not confirm ownership of the Collector process." })
  }
}

const processExists = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (cause) { return !hasCode(cause, "ESRCH") }
}

const signalOwnedProcess = async (record: CollectorProcessRecord, signal: NodeJS.Signals, deadline: number) => {
  if (!await isOwnedProcess(record, deadline)) return false
  if (performance.now() >= deadline) throw new CollectorDaemonProcessError({ reason: "stop",
    message: "The Collector signal deadline expired before ownership was confirmed." })
  try { process.kill(record.pid, signal) } catch (cause) { if (!hasCode(cause, "ESRCH")) throw cause }
  return true
}

const waitForExit = async (record: CollectorProcessRecord, deadline: number) => {
  while (performance.now() < deadline) {
    try { if (!await isOwnedProcess(record, deadline)) return true } catch (cause) {
      if (performance.now() >= deadline) return !processExists(record.pid)
      throw cause
    }
    await delay(Math.min(50, Math.max(0, deadline - performance.now())))
  }
  return !processExists(record.pid)
}

const readMaintenance = async (processFile: string): Promise<CollectorMaintenance | undefined> => {
  try {
    const gate = Schema.decodeUnknownSync(CollectorMaintenance)(JSON.parse(await readFile(maintenanceFile(processFile), "utf8")))
    if (!Number.isSafeInteger(gate.generation) || gate.generation < 0 || gate.ownerPid !== undefined &&
      (!Number.isSafeInteger(gate.ownerPid) || gate.ownerPid <= 0)) throw new Error("Invalid maintenance identity")
    return gate
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined
    throw new CollectorDaemonProcessError({ reason: "identity", message: "Collector maintenance state is invalid; recovery is required." })
  }
}

const readDesiredState = async (processFile: string): Promise<CollectorDesiredState | undefined> => {
  try {
    const desired = Schema.decodeUnknownSync(CollectorDesiredState)(JSON.parse(await readFile(desiredStateFile(processFile), "utf8")))
    if (desired.wanted && (!Number.isInteger(desired.intervalMs) || desired.intervalMs < 10_000 || desired.intervalMs > 3_600_000 ||
      !Number.isInteger(desired.concurrency) || desired.concurrency < 1 || desired.concurrency > 8)) {
      throw new Error("Invalid Collector schedule")
    }
    return desired
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined
    throw new CollectorDaemonProcessError({ reason: "identity", message: "The saved Collector sync intent is invalid. Open ATape and choose Start or Stop." })
  }
}

// Migration happens under the same transition lock as Start, Stop and updates.
// A stale PID or restart marker alone is not evidence that the user wants sync.
// Once established, metadata survives crashes and pauses. A retained older CLI
// can still Stop without knowing this file: it removes the PID and gate.resume.
const desiredState = async (
  processFile: string, running?: CollectorProcessRecord, gate?: CollectorMaintenance, deadline?: number
): Promise<CollectorDesiredState> => {
  const saved = await readDesiredState(processFile)
  if (saved) {
    if (saved.wanted && saved.established && !running && !gate?.resume) {
      const stopped = { version: 1, wanted: false } as const
      await writeDesiredState(processFile, stopped)
      return stopped
    }
    return saved
  }
  const resume = gate?.resume ?? (running && await isOwnedProcess(running, deadline) ? running : undefined)
  const desired: CollectorDesiredState = resume
    ? { version: 1, wanted: true, intervalMs: resume.intervalMs, concurrency: resume.concurrency, established: true }
    : { version: 1, wanted: false }
  await writeDesiredState(processFile, desired)
  return desired
}

const writeDesiredState = (processFile: string, desired: CollectorDesiredState) =>
  writeControlState(desiredStateFile(processFile), desired)

const establishDesiredState = async (processFile: string) => {
  const desired = await readDesiredState(processFile)
  if (desired?.wanted && !desired.established) await writeDesiredState(processFile, { ...desired, established: true })
}

const ownedMaintenance = async (processFile: string, token: string) => {
  const gate = await readMaintenance(processFile)
  if (!gate || gate.token !== token) throw new CollectorDaemonProcessError({ reason: "identity", message: "Collector maintenance ownership changed." })
  return gate
}

const rejectMaintenance = async (processFile: string) => {
  if (await isCollectorMaintenancePending(processFile)) throw new CollectorDaemonProcessError({
    reason: "start", message: "Collector maintenance is pending. Finish or recover the update before starting sync."
  })
}

const writeMaintenance = async (processFile: string, gate: CollectorMaintenance) => {
  await writeControlState(maintenanceFile(processFile), gate)
}

const writeControlState = async (file: string, value: unknown) => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(file), `.collector-control-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
    await syncDirectory(dirname(file))
  } finally { await rm(temporary, { force: true }) }
}

const syncDirectory = async (path: string) => {
  const directory = await open(path, "r")
  try { await directory.sync() } finally { await directory.close() }
}

const maximumRunStatusBytes = 8 * 1024 * 1024
// Writers publish immutable snapshots with rename. A reader may retain the
// previous inode after that rename unlinks it; its bytes remain a valid snapshot.
const readPublishedRunState = async (statusFile: string) => {
  const handle = await open(statusFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximumRunStatusBytes) throw new Error("Invalid Collector status file")
    // Admit one extra byte to detect growth without allocating the full bound
    // for each foreground poll or background status transaction.
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size <= before.size) {
      const result = await handle.read(buffer, size, buffer.length - size, size)
      if (result.bytesRead === 0) break
      size += result.bytesRead
    }
    const after = await handle.stat()
    const unlinkedSnapshot = before.nlink === 1 && after.nlink === 0
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino || after.dev !== before.dev || after.mode !== before.mode ||
      after.uid !== before.uid || after.gid !== before.gid ||
      after.nlink !== before.nlink && !unlinkedSnapshot ||
      after.ctimeMs !== before.ctimeMs && !unlinkedSnapshot) throw new Error("Collector status changed during read")
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))) as unknown
  } finally { await handle.close() }
}

const readRunState = (statusFile: string): Effect.Effect<CollectorRunState, CollectorRunStatusError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await readPublishedRunState(statusFile)
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) return emptyCollectorRunState() as unknown
        throw cause
      }
    },
    catch: () => new CollectorRunStatusError({
      reason: "io", message: "Could not read Collector run status."
    })
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(CollectorRunStateSchema)(value)),
    Effect.mapError((error) => error instanceof CollectorRunStatusError
      ? error
      : new CollectorRunStatusError({
          reason: "decode", message: "The ATape Collector run status is invalid."
        }))
  )

const writeRunState = (
  statusFile: string,
  state: CollectorRunState
): Effect.Effect<void, CollectorRunStatusError> => Schema.decodeUnknownEffect(CollectorRunStateSchema)(state).pipe(
  Effect.mapError(() => new CollectorRunStatusError({
    reason: "decode", message: "ATape refused to persist invalid Collector run status."
  })),
  Effect.flatMap((validated) => Effect.tryPromise({
    try: async () => {
      const content = `${JSON.stringify(validated, null, 2)}\n`
      if (Buffer.byteLength(content) > maximumRunStatusBytes) throw new Error("Collector status exceeds its admitted size")
      await mkdir(dirname(statusFile), { recursive: true, mode: 0o700 })
      const temporary = `${statusFile}.${process.pid}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, "wx", 0o600)
        try { await handle.writeFile(content); await handle.sync() }
        finally { await handle.close() }
        await rename(temporary, statusFile)
        await syncDirectory(dirname(statusFile))
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    },
    catch: () => new CollectorRunStatusError({
      reason: "io", message: "Could not write Collector run status."
    })
  }))
)

const transactRunState = (statusFile: string, change: (current: CollectorRunState) =>
  Effect.Effect<CollectorRunState | undefined, CollectorRunStatusError>) => Effect.acquireUseRelease(
  Effect.tryPromise({ try: async () => {
    const release = await acquireProcessLock(`${statusFile}.lock.sqlite`, 10_000)
    if (!release) throw new Error("Collector status is busy")
    return release
  }, catch: () => new CollectorRunStatusError({ reason: "io", message: "Could not lock Collector run status." }) }),
  () => readRunState(statusFile).pipe(Effect.flatMap(change),
    Effect.flatMap(next => next === undefined ? Effect.void : writeRunState(statusFile, next))),
  release => Effect.sync(release)
// Node filesystem promises do not stop when an Effect is interrupted. Retain
// exclusion until every read/rename/fsync has settled, including cancellation.
).pipe(Effect.uninterruptible)

const applyRedactionJob = (current: CollectorRunState, event: CollectorRedactionJobEvent,
  writer: CollectorRedactionWriter): CollectorRunState | undefined => {
  const generation = processGeneration(writer.collectorToken)
  const retained = current.redaction?.generation === generation ? current.redaction : undefined
  const jobs = new Map((retained?.jobs ?? []).map(job => [jobKey(job.projectId, job.adapterId), job]))
  const key = jobKey(event.projectId, event.adapterId), previous = jobs.get(key)
  let next: CollectorRedactionJobStatus
  if (event.kind === "loading") {
    // The application awaits each scope's starts in order. Wall-clock values
    // are informational; a clock correction must not reject a new attempt.
    if (previous?.attemptId === event.attemptId) return undefined
    next = { projectId: event.projectId, adapterId: event.adapterId, attemptId: event.attemptId,
      startedAt: event.at, updatedAt: event.at, phase: "loading" }
  } else {
    if (!previous || previous.attemptId !== event.attemptId ||
      !["loading", "active"].includes(previous.phase)) return undefined
    if (event.kind === "loaded") {
      if (previous.phase !== "loading") return undefined
      next = { ...previous, phase: "active", updatedAt: event.at, snapshot: event.snapshot }
    } else {
      if (event.outcome === "load_failed" && previous.phase !== "loading" ||
        event.outcome === "completed" && previous.phase !== "active") return undefined
      const { snapshot, ...withoutSnapshot } = previous
      next = { ...withoutSnapshot, phase: event.outcome, updatedAt: event.at,
        ...(event.outcome === "load_failed" || snapshot === undefined ? {} : { snapshot }) }
    }
  }
  jobs.set(key, next)
  return { ...current, redaction: { generation, configFile: writer.configFile, origin: writer.origin,
    jobs: [...jobs.values()].sort((left, right) => jobKey(left.projectId, left.adapterId).localeCompare(jobKey(right.projectId, right.adapterId))) } }
}

const applyCycle = (current: CollectorRunState, report: CollectionCycleReport): CollectorRunState => {
  const jobs = new Map(current.jobs.map((job) => [jobKey(job.projectId, job.adapterId), job]))
  for (const success of report.jobs) {
    jobs.set(jobKey(success.projectId, success.adapterId), {
      projectId: success.projectId,
      adapterId: success.adapterId,
      lastAttemptAt: report.completedAt,
      lastSuccessAt: report.completedAt,
      ...(success.progress === undefined ? {} : { progress: success.progress }),
      ...(success.canonicalEvents === undefined ? {} : { canonicalEvents: success.canonicalEvents }),
      ...(success.rawBytes === undefined ? {} : { rawBytes: success.rawBytes }),
      ...(success.durationMs === undefined ? {} : { durationMs: success.durationMs }),
      pages: success.pages,
      observations: success.observations,
      canonicalBatches: success.canonicalBatches,
      rawChunks: success.rawChunks,
      redactions: success.redactions,
      hasMore: success.hasMore,
      ...(success.sourceFailures ? { sourceFailures: success.sourceFailures } : {}),
      ...(success.sourceFailuresTruncated ? { sourceFailuresTruncated: true } : {})
    })
  }
  for (const failure of report.failures) {
    const previous = jobs.get(jobKey(failure.projectId, failure.adapterId))
    const next: CollectorJobRunStatus = {
      projectId: failure.projectId,
      adapterId: failure.adapterId,
      lastAttemptAt: report.completedAt,
      lastFailureAt: report.completedAt,
      failureMessage: failure.message,
      retryable: failure.retryable,
      failureReason: failure.reason,
      ...(previous?.lastSuccessAt === undefined ? {} : { lastSuccessAt: previous.lastSuccessAt })
    }
    jobs.set(jobKey(failure.projectId, failure.adapterId), next)
  }
  return {
    version: current.version,
    ...(current.redaction === undefined ? {} : { redaction: current.redaction }),
    lastCycleStartedAt: report.startedAt,
    lastCycleCompletedAt: report.completedAt,
    jobs: [...jobs.values()].sort((left, right) =>
      jobKey(left.projectId, left.adapterId).localeCompare(jobKey(right.projectId, right.adapterId)))
  }
}

const execFileText = (file: string, args: ReadonlyArray<string>, timeout = 2_000) => new Promise<string>((resolveText, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error)
    else resolveText(stdout)
  })
})

const delay = (milliseconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
const unsupportedManagedProcessPlatform = () => new CollectorDaemonProcessError({
  reason: "identity",
  message: "Managed background collection currently supports macOS and Linux. Windows is not supported."
})
const jobKey = (projectId: string, adapterId: string) => `${projectId}\0${adapterId}`
const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code
const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
