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
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"

type NodeCollectorDaemonPaths = {
  readonly collectorProcessFile: string
  readonly collectorStatusFile: string
  readonly collectorLogFile: string
}

const ProcessFileVersion = 1 as const
const CollectorProcessRecord = Schema.Struct({
  version: Schema.Literal(ProcessFileVersion),
  token: Schema.String,
  pid: Schema.Number,
  startedAt: Schema.String,
  intervalMs: Schema.Number,
  concurrency: Schema.Number,
  logFile: Schema.String
})
type CollectorProcessRecord = typeof CollectorProcessRecord.Type

export const makeNodeCollectorDaemonLayer = (
  paths: NodeCollectorDaemonPaths,
  entryFile: string,
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
  entryFile: string,
  environment: NodeJS.ProcessEnv
) => Layer.succeed(
  CollectorDaemonProcess,
  CollectorDaemonProcess.of({
    start: (options) => processStart(paths, entryFile, environment, options),
    stop: () => processStop(paths.collectorProcessFile),
    inspect: () => processInspect(paths.collectorProcessFile)
  })
)

const processStart = (
  paths: NodeCollectorDaemonPaths,
  entryFile: string,
  environment: NodeJS.ProcessEnv,
  options: ResolvedCollectorDaemonOptions
) => {
  if (process.platform === "win32") return Effect.fail(unsupportedManagedProcessPlatform())
  return withProcessLock(paths.collectorProcessFile, async () => {
    const existing = await readProcessRecord(paths.collectorProcessFile)
    if (existing !== undefined && await isOwnedProcess(existing)) {
      return { ...presentProcess(existing), created: false }
    }
    if (existing !== undefined) await rm(paths.collectorProcessFile, { force: true })

    await mkdir(dirname(paths.collectorProcessFile), { recursive: true, mode: 0o700 })
    await mkdir(dirname(paths.collectorLogFile), { recursive: true, mode: 0o700 })
    const token = randomUUID()
    const log = await open(paths.collectorLogFile, "a", 0o600)
    let child
    try {
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
      pid: child.pid,
      startedAt: new Date().toISOString(),
      intervalMs: options.intervalMs,
      concurrency: options.concurrency,
      logFile: paths.collectorLogFile
    }
    await writeProcessRecord(paths.collectorProcessFile, record)
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await isOwnedProcess(record)) return { ...presentProcess(record), created: true }
      await delay(50)
    }
    await rm(paths.collectorProcessFile, { force: true })
    throw new CollectorDaemonProcessError({
      reason: "start",
      message: `The Collector process exited during startup. Inspect ${paths.collectorLogFile}.`
    })
  })
}

const processStop = (processFile: string) => {
  if (process.platform === "win32") return Effect.fail(unsupportedManagedProcessPlatform())
  return withProcessLock(processFile, async () => {
    const record = await readProcessRecord(processFile)
    if (record === undefined) return false
    if (!(await isOwnedProcess(record))) {
      await rm(processFile, { force: true })
      return false
    }
    process.kill(record.pid, "SIGTERM")
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await isOwnedProcess(record))) {
        await rm(processFile, { force: true })
        return true
      }
      await delay(50)
    }
    if (await isOwnedProcess(record)) process.kill(record.pid, "SIGKILL")
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await isOwnedProcess(record))) break
      await delay(50)
    }
    if (await isOwnedProcess(record)) {
      throw new CollectorDaemonProcessError({ reason: "stop", message: "The managed Collector did not stop." })
    }
    await rm(processFile, { force: true })
    return true
  })
}

const processInspect = (processFile: string) => {
  if (process.platform === "win32") return Effect.fail(unsupportedManagedProcessPlatform())
  return withProcessLock(processFile, async () => {
    const record = await readProcessRecord(processFile)
    if (record === undefined) return undefined
    if (await isOwnedProcess(record)) return presentProcess(record)
    await rm(processFile, { force: true })
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
  use: () => Promise<A>
): Effect.Effect<A, CollectorDaemonProcessError> => Effect.tryPromise({
  try: async () => {
    await mkdir(dirname(processFile), { recursive: true, mode: 0o700 })
    const lockPath = `${processFile}.lock`
    let lock
    try {
      lock = await open(lockPath, "wx", 0o600)
    } catch (cause) {
      if (hasCode(cause, "EEXIST") && await staleProcessLock(lockPath)) {
        await rm(lockPath, { force: true })
        lock = await open(lockPath, "wx", 0o600)
      } else {
        throw cause
      }
    }
    try {
      await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
      return await use()
    } finally {
      await lock.close().catch(() => undefined)
      await rm(lockPath, { force: true }).catch(() => undefined)
    }
  },
  catch: (cause) => cause instanceof CollectorDaemonProcessError
    ? cause
    : new CollectorDaemonProcessError({
        reason: "io",
        message: hasCode(cause, "EEXIST")
          ? "Another ATape command is changing the Collector process."
          : errorMessage("Could not manage the Collector process", cause)
      })
})

const isOwnedProcess = async (record: CollectorProcessRecord) => {
  try {
    process.kill(record.pid, 0)
  } catch (cause) {
    if (hasCode(cause, "ESRCH")) return false
    if (!hasCode(cause, "EPERM")) throw cause
  }
  try {
    const command = await execFileText("ps", ["-p", String(record.pid), "-o", "command="])
    return command.includes("__collector-daemon") && command.includes(record.token)
  } catch {
    return false
  }
}

const staleProcessLock = async (lockPath: string) => {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > 30_000
  } catch (cause) {
    return hasCode(cause, "ENOENT")
  }
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
      pages: success.pages,
      observations: success.observations,
      canonicalBatches: success.canonicalBatches,
      rawChunks: success.rawChunks,
      redactions: success.redactions,
      hasMore: success.hasMore
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

const execFileText = (file: string, args: ReadonlyArray<string>) => new Promise<string>((resolveText, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error)
    else resolveText(stdout)
  })
})

const delay = (milliseconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
const unsupportedManagedProcessPlatform = () => new CollectorDaemonProcessError({
  reason: "identity",
  message: "Managed background collection currently supports macOS and Linux. Use `atape collect` on Windows."
})
const jobKey = (projectId: string, adapterId: string) => `${projectId}\0${adapterId}`
const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code
const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
