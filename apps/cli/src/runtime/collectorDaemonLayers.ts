import {
  CollectorDaemonProcess,
  CollectorDaemonProcessError,
  CollectorRunStatusError,
  CollectorRunStatusStore,
  type CollectionCycleReport,
  type ResolvedCollectorDaemonOptions
} from "@atape/application"
import {
  CollectorRunState as CollectorRunStateSchema,
  emptyCollectorRunState,
  type CollectorJobRunStatus,
  type CollectorRunState
} from "@atape/domain"
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { Effect, Layer, Option, Schema } from "effect"
import { acquireProcessLock } from "./processLock.ts"

export type NodeCollectorDaemonPaths = {
  readonly collectorProcessFile: string
  readonly collectorStatusFile: string
  readonly collectorLogFile: string
}
type CollectorEntry = string | (() => Promise<string>)
const resolveCollectorEntry = (entry: CollectorEntry) => typeof entry === "string" ? Promise.resolve(entry) : entry()

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
    const resume = previous === undefined
      ? running && (running.restartPending || await isOwnedProcess(running, deadline))
        ? { intervalMs: running.intervalMs, concurrency: running.concurrency } : undefined
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
  const resume = async () => {
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
        while (performance.now() < readyDeadline) {
          const gate = await ownedMaintenance(paths.collectorProcessFile, token)
          // User Stop wins even while the new runtime is preparing readiness.
          if (gate.generation !== claim.gate.generation || !gate.resume) return
          const ready = await readFile(readyFile, "utf8").then(value => JSON.parse(value) as unknown).catch(() => undefined)
          let owned: boolean
          try { owned = await isOwnedProcess(launched, readyDeadline) } catch (cause) {
            if (performance.now() >= readyDeadline) break
            throw cause
          }
          if (!owned) break
          if (typeof ready === "object" && ready !== null && "token" in ready && "pid" in ready &&
            ready.token === readyToken && ready.pid === launched.pid) return
          await delay(Math.min(50, Math.max(0, readyDeadline - performance.now())))
        }
        throw new CollectorDaemonProcessError({ reason: "start", message: "The updated Collector did not become locally ready." })
      }
    } finally { await rm(readyFile, { force: true }) }
  }
  const release = () => lock(async () => {
    await ownedMaintenance(paths.collectorProcessFile, token)
    await rm(maintenanceFile(paths.collectorProcessFile), { force: true })
    await syncDirectory(dirname(paths.collectorProcessFile))
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
    try {
      if (stopped) await stopCurrent()
      remaining()
      if (stopped && options.recover) {
        await options.recover(cause, deadline)
        remaining()
        await resume()
        remaining()
        await release()
      } else await markFailed()
    } catch (recoveryCause) {
      await markFailed().catch(() => {})
      throw new CollectorDaemonProcessError({ reason: "start",
        message: `Collector maintenance needs recovery: ${recoveryCause instanceof Error ? recoveryCause.message : String(recoveryCause)}` })
    }
    throw cause
  }
}

export const makeNodeCollectorDaemonLayer = (
  paths: NodeCollectorDaemonPaths,
  entryFile: CollectorEntry,
  environment: NodeJS.ProcessEnv = process.env
) => Layer.merge(
  makeCollectorDaemonProcessLayer(paths, entryFile, environment),
  makeCollectorRunStatusLayer(paths.collectorStatusFile)
)

export const makeCollectorRunStatusLayer = (statusFile: string) => Layer.succeed(
  CollectorRunStatusStore,
  CollectorRunStatusStore.of({
    read: () => readRunState(statusFile),
    recordCycle: (report) => readRunState(statusFile).pipe(
      Effect.map((current) => applyCycle(current, report)),
      Effect.flatMap((next) => writeRunState(statusFile, next))
    ),
    recordCollectorFailure: (failure) => readRunState(statusFile).pipe(
      Effect.map((current): CollectorRunState => ({ ...current, collectorFailure: failure })),
      Effect.flatMap((next) => writeRunState(statusFile, next))
    )
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
    refresh: () => processRefresh(paths, entryFile, environment),
    stop: () => processStop(paths.collectorProcessFile),
    inspect: () => processInspect(paths.collectorProcessFile)
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
    const entry = await resolveCollectorEntry(entryFile)
    const runtimeKey = await executableKey(entry)
    if (existing !== undefined && await isOwnedProcess(existing)) {
      if (!existing.restartPending && existing.runtimeKey === runtimeKey) return { ...presentProcess(existing), created: false }
      return restartProcess(paths, entry, environment, existing, runtimeKey)
    }
    if (existing?.restartPending) return restartProcess(paths, entry, environment, existing, runtimeKey)
    if (existing !== undefined) await rm(paths.collectorProcessFile, { force: true })
    return launchProcess(paths, entry, environment, options, runtimeKey)
  }).pipe(Effect.uninterruptible)
}

const processRefresh = (paths: NodeCollectorDaemonPaths, entryFile: CollectorEntry, environment: NodeJS.ProcessEnv) => {
  // No managed daemon exists on Windows; Adapter maintenance remains available.
  if (process.platform === "win32") return Effect.succeed(false)
  return withProcessLock(paths.collectorProcessFile, async () => {
    await rejectMaintenance(paths.collectorProcessFile)
    const existing = await readProcessRecord(paths.collectorProcessFile)
    if (existing === undefined) return false
    if (!existing.restartPending && !(await isOwnedProcess(existing))) {
      await rm(paths.collectorProcessFile, { force: true })
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
  while (performance.now() < deadline) {
    if (await isOwnedProcess(record, deadline)) return { ...presentProcess(record), created: true }
    await delay(Math.min(50, Math.max(0, deadline - performance.now())))
  }
  // An unconfirmed startup may still own a process. Preserve its identity so
  // recovery must terminate it before launching a replacement.
  throw new CollectorDaemonProcessError({
    reason: "start",
    message: `The Collector process exited during startup. Inspect ${paths.collectorLogFile}.`
  })
}

const processStop = (processFile: string) => {
  if (process.platform === "win32") return Effect.fail(unsupportedManagedProcessPlatform())
  return withProcessLock(processFile, async () => {
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
    if (record === undefined) return undefined
    if (await isOwnedProcess(record)) return presentProcess(record)
    if (!record.restartPending) await rm(processFile, { force: true })
    return undefined
  })
}

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
    value = JSON.parse(await readFile(processFile, "utf8")) as unknown
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined
    throw new CollectorDaemonProcessError({
      reason: "io", message: errorMessage("Could not read Collector process metadata", cause)
    })
  }
  const decoded = Schema.decodeUnknownOption(CollectorProcessRecord)(value)
  if (Option.isNone(decoded) || !Number.isSafeInteger(decoded.value.pid) || decoded.value.pid <= 0) {
    throw new CollectorDaemonProcessError({
      reason: "identity", message: `Collector process metadata at ${processFile} is invalid.`
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
    if (remaining <= 0) throw new Error("Process confirmation deadline expired")
    const command = await execFileText("ps", ["-p", String(record.pid), "-o", "command="], remaining)
    return command.includes("__collector-daemon") && command.includes(record.token)
  } catch {
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
  const file = maintenanceFile(processFile), temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(`${JSON.stringify(gate)}\n`); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
    await syncDirectory(dirname(file))
  } finally { await rm(temporary, { force: true }) }
}

const syncDirectory = async (path: string) => {
  const directory = await open(path, "r")
  try { await directory.sync() } finally { await directory.close() }
}

const readRunState = (statusFile: string): Effect.Effect<CollectorRunState, CollectorRunStatusError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return JSON.parse(await readFile(statusFile, "utf8")) as unknown
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) return emptyCollectorRunState() as unknown
        throw cause
      }
    },
    catch: (cause) => new CollectorRunStatusError({
      reason: "io", message: errorMessage("Could not read Collector run status", cause)
    })
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(CollectorRunStateSchema)(value)),
    Effect.mapError((error) => error instanceof CollectorRunStatusError
      ? error
      : new CollectorRunStatusError({
          reason: "decode", message: `The ATape Collector run status is invalid: ${String(error)}`
        }))
  )

const writeRunState = (
  statusFile: string,
  state: CollectorRunState
): Effect.Effect<void, CollectorRunStatusError> => Schema.decodeUnknownEffect(CollectorRunStateSchema)(state).pipe(
  Effect.mapError((error) => new CollectorRunStatusError({
    reason: "decode", message: `ATape refused to persist invalid Collector run status: ${String(error)}`
  })),
  Effect.flatMap((validated) => Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(statusFile), { recursive: true, mode: 0o700 })
      const temporary = `${statusFile}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: "wx" })
        await rename(temporary, statusFile)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    },
    catch: (cause) => new CollectorRunStatusError({
      reason: "io", message: errorMessage("Could not write Collector run status", cause)
    })
  }))
)

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
