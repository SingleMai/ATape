import { ClientConfig, emptyClientConfig } from "@atape/domain"
import { Effect, Schema } from "effect"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { NodeClientPaths } from "./clientPaths.ts"
import { withClientConfigFileLock } from "./clientConfig.ts"
import { acquireProcessLock } from "./processLock.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { assertRuntimeDataAdmission, runtimeContext } from "./runtimeAdmission.ts"
import { createUpdateControl, updateControlProtocol } from "./updateControl.ts"
import { applyRuntimeSelection, atomicJSON, decodeLegacyRuntimeSelection, decodeRuntimeSelection,
  legacyBridgeCaptureContract, missing, readBoundedJSON, resolveRuntimeEntry, runtimeSelectionFile, updateDirectory } from "./runtimeSelection.ts"

export class ManualStateUpgradeError extends Schema.TaggedError<ManualStateUpgradeError>()("ManualStateUpgradeError", {
  reason: Schema.Literals(["busy", "pending", "running", "metadata"]), message: Schema.String
}) {}

const guidance = "Stop sync and close old ATape consoles, then retry in the new CLI. Restore the old npm CLI only to finish old update recovery before v2 capture migration; afterward, recover with v2 and do not downgrade."
const refused = (reason: ManualStateUpgradeError["reason"], message: string) =>
  new ManualStateUpgradeError({ reason, message: `${message} ${guidance}` })
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run,
  catch: cause => cause instanceof ManualStateUpgradeError ? cause : refused("metadata", "ATape could not safely complete its manual state upgrade.") })
const LedgerBytes = 1024 * 1024
const ledgerFile = (home: string) => join(updateDirectory(home), "manual-state-upgrade.json")
const admissionFile = (home: string) => join(updateDirectory(home), "v2-collector-admission.json")
const retainedFile = (home: string) => join(updateDirectory(home), "retained.json")
const Ledger = Schema.Union([
  Schema.Struct({ protocol: Schema.Literal("atape.manual-state-upgrade.v1"), contract: Schema.Literal(legacyBridgeCaptureContract),
    home: Schema.String, phase: Schema.Literal("completed"), configFile: Schema.String, processFile: Schema.String }),
  Schema.Struct({ protocol: Schema.Literal("atape.manual-state-upgrade.v1"), contract: Schema.Literal(legacyBridgeCaptureContract),
    home: Schema.String, phase: Schema.Literal("pending"), configFile: Schema.String, processFile: Schema.String,
    current: Schema.optionalKey(Schema.Unknown), retained: Schema.optionalKey(Schema.Unknown) })
])
type LegacySelection = ReturnType<typeof decodeLegacyRuntimeSelection>
const decodeLedger = (value: unknown) => {
  const ledger = Schema.decodeUnknownSync(Ledger)(value)
  if (ledger.phase === "completed") return ledger
  return { ...ledger,
    current: ledger.current === undefined ? undefined : decodeLegacyRuntimeSelection(ledger.current),
    retained: ledger.retained === undefined ? undefined : decodeLegacyRuntimeSelection(ledger.retained) }
}
const optional = async <A>(read: () => Promise<A>): Promise<A | undefined> => {
  try { return await read() } catch (cause) { if (missing(cause)) return undefined; throw cause }
}
const privateJSON = async (path: string): Promise<unknown> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > LedgerBytes || process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid!())) throw new Error("Invalid private upgrade ledger.")
    const bytes = Buffer.alloc(LedgerBytes + 1)
    const read = await file.read(bytes, 0, bytes.length, 0)
    if (read.bytesRead > LedgerBytes) throw new Error("Upgrade ledger exceeds its bound.")
    return JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")) as unknown
  } finally { await file.close() }
}
const selection = async (path: string) => optional(async () => {
  const value = await readBoundedJSON(path)
  if (typeof value === "object" && value !== null && "stateContract" in value && value.stateContract === "atape.client.v3-capture.v1")
    return decodeLegacyRuntimeSelection(value)
  return decodeRuntimeSelection(value)
})
const Admission = Schema.Struct({ protocol: Schema.Literal("atape.v2-collector-admission.v1"), contract: Schema.Literal(legacyBridgeCaptureContract),
  home: Schema.String, configFile: Schema.String, processFile: Schema.String,
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)), token: Schema.String })
const readLedger = async (paths: NodeClientPaths) => {
  const home = await optional(() => realpath(paths.atapeHome)) ?? resolve(paths.atapeHome)
  const ledger = await optional(async () => decodeLedger(await privateJSON(ledgerFile(home))))
  if (ledger && (ledger.home !== home || ledger.configFile !== resolve(paths.configFile) || ledger.processFile !== resolve(paths.collectorProcessFile)))
    throw refused("metadata", "The manual state upgrade belongs to a different local context. Keep ATAPE_CONFIG_FILE and ATAPE_COLLECTOR_PROCESS_FILE consistent for this ATAPE_HOME.")
  return { home, ledger }
}
const inspect = async (paths: NodeClientPaths) => {
  const { home, ledger } = await readLedger(paths)
  const current = await selection(runtimeSelectionFile(home)), retained = await selection(retainedFile(home))
  const legacy = current?.stateContract === "atape.client.v3-capture.v1" || retained?.stateContract === "atape.client.v3-capture.v1"
  if (ledger?.phase === "completed" && legacy) throw refused("metadata", "An old runtime modified state after the completed manual upgrade.")
  let ready = ledger?.phase === "completed" || ledger === undefined && !legacy && (current !== undefined || retained !== undefined)
  if (!ready && ledger === undefined && !legacy) {
    const proof = await optional(async () => Schema.decodeUnknownSync(Admission)(await privateJSON(admissionFile(home))))
    if (proof) {
      const record = await optional(async () => Schema.decodeUnknownSync(ProcessRecord)(await readBoundedJSON(paths.collectorProcessFile)))
      ready = proof.home === home && proof.configFile === resolve(paths.configFile) && proof.processFile === resolve(paths.collectorProcessFile) &&
        proof.pid === record?.pid && proof.token === record.token
    }
  }
  return { home, ledger, current, retained, legacy, ready }
}

/** Read-only admission guard. Internal mutating entries call it after acquiring
 * their owning update lifetime; public help/version intentionally do not. */
export const assertNoPendingManualStateUpgrade = async (paths: NodeClientPaths): Promise<void> => {
  try {
    const { ledger } = await readLedger(paths)
    if (ledger?.phase === "pending") throw refused("pending", "An interrupted manual state upgrade must finish in the new interactive console before background work can continue.")
  } catch (cause) {
    throw cause instanceof ManualStateUpgradeError ? cause : refused("metadata", "ATape could not validate its manual state upgrade admission.")
  }
}
// The async form is the native recovery Adapter's existing Promise boundary;
// Effect callers retain typed failures and their owning resource lifetime.
export const assertManualStateUpgradeReady = Effect.fn("ManualStateUpgrade.assertReady")((paths: NodeClientPaths) =>
  io(() => assertNoPendingManualStateUpgrade(paths)))
const exists = async (path: string) => (await optional(() => lstat(path))) !== undefined
const ProcessRecord = Schema.Struct({ version: Schema.Literal(1), token: Schema.String,
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)), startedAt: Schema.String,
  runtimeKey: Schema.optionalKey(Schema.String),
  intervalMs: Schema.Number, concurrency: Schema.Number, logFile: Schema.String })
const StartingMaintenance = Schema.Struct({ version: Schema.Literal(1), token: Schema.String,
  ownerPid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)), phase: Schema.Literal("starting"),
  resume: Schema.Struct({ intervalMs: Schema.Number, concurrency: Schema.Number }) })
const validateControlHandoff = async (paths: NodeClientPaths, record: typeof ProcessRecord.Type) => {
  const maintenance = Schema.decodeUnknownSync(StartingMaintenance)(await readBoundedJSON(`${paths.collectorProcessFile}.maintenance.json`))
  if (!maintenance.token) throw refused("metadata", "This Collector does not have an owned update handoff.")
  // A PID is diagnostic only. The OS-held updater lifetime must still exclude
  // a fresh owner while this child establishes its new admission proof.
  const release = await acquireUpdateWorker(paths.atapeHome)
  if (release) {
    release()
    throw refused("metadata", "The update handoff no longer has an owning updater.")
  }
  const control = createUpdateControl(paths.atapeHome)
  if (!(await control.recoveryPending())) throw refused("metadata", "No independent update handoff admits this Collector.")
  const runtime = await control.handoffRuntime()
  if (!runtime || runtime.captureStateContract !== legacyBridgeCaptureContract) {
    throw refused("metadata", "The update handoff does not preserve this Collector's capture contract.")
  }
  await control.assertRuntimeAdmission({ version: runtime.version, captureStateContract: legacyBridgeCaptureContract })
  const entry = await realpath(await resolveRuntimeEntry(paths.atapeHome, runtime.bootstrapEntry))
  const manifest = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.Literal("@atape/cli"), version: Schema.String,
    atapeRuntime: Schema.Struct({ updateControlProtocol: Schema.Literal(updateControlProtocol),
      stateContract: Schema.Literal(legacyBridgeCaptureContract) })
  }))(await readBoundedJSON(join(dirname(dirname(entry)), "package.json")))
  if (manifest.version !== runtime.version) throw refused("metadata", "The update handoff selected a different Collector generation.")
  const key = createHash("sha256").update(JSON.stringify([process.execPath, entry])).update(await readFile(entry)).digest("hex")
  if (record.runtimeKey !== key) throw refused("metadata", "This Collector does not own the admitted update runtime.")
}
const requireStopped = async (paths: NodeClientPaths) => {
  if (await exists(join(updateDirectory(paths.atapeHome), "pending.json")) || await exists(`${paths.collectorProcessFile}.maintenance.json`))
    throw refused("pending", "An unfinished update or Collector maintenance prevents the manual state upgrade.")
  const record = await optional(async () => Schema.decodeUnknownSync(ProcessRecord)(await readBoundedJSON(paths.collectorProcessFile)))
  if (record) {
    try { process.kill(record.pid, 0) } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH") return
      throw refused("running", "Collector ownership could not be proved stopped.")
    }
    throw refused("running", "A Collector process is still running.")
  }
}
const syncDirectory = async (path: string) => {
  const directory = await open(path, "r")
  try { await directory.sync() } finally { await directory.close() }
}
const retire = async (path: string, expected?: LegacySelection) => {
  const current = await selection(path)
  if (current === undefined) return
  if (expected === undefined || !isDeepStrictEqual(current, expected)) throw refused("metadata", "Managed runtime metadata changed during the manual state upgrade.")
  await rm(path)
  await syncDirectory(dirname(path))
}
const privateDirectory = async (home: string) => {
  const directory = updateDirectory(home)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== "win32" &&
    ((info.mode & 0o077) !== 0 || info.uid !== process.getuid!())) throw new Error("Manual upgrade storage must be private.")
}

/** Called only after the token/PID Collector admission in the capable v2 entry.
 * It certifies a real new headless owner without granting an old daemon a
 * migration exemption or contending with its parent's lifecycle lock. */
export const recordV2CollectorAdmission = Effect.fn("ManualStateUpgrade.recordCollectorAdmission")(function*(paths: NodeClientPaths, token: string) {
  yield* io(async () => {
    const state = await inspect(paths)
    if (state.legacy || state.ledger?.phase === "pending") throw refused("metadata", "Complete the explicit manual state upgrade before starting this Collector.")
    const record = Schema.decodeUnknownSync(ProcessRecord)(await readBoundedJSON(paths.collectorProcessFile))
    if (record.pid !== process.pid || record.token !== token || !token) throw refused("running", "This Collector admission does not own the current process record.")
    const controlPending = await createUpdateControl(paths.atapeHome).recoveryPending()
    if (!state.ready && (controlPending || await exists(join(updateDirectory(paths.atapeHome), "pending.json")) || await exists(`${paths.collectorProcessFile}.maintenance.json`))) {
      const value = await optional(() => readBoundedJSON(join(updateDirectory(paths.atapeHome), "pending.json")))
      if (value !== undefined) {
        const pending = Schema.decodeUnknownSync(Schema.Struct({ next: Schema.Unknown, previous: Schema.optionalKey(Schema.Unknown) }))(value)
        decodeRuntimeSelection(pending.next)
        if (pending.previous !== undefined) decodeRuntimeSelection(pending.previous)
      } else await validateControlHandoff(paths, record)
    }
    await privateDirectory(state.home)
    await atomicJSON(admissionFile(state.home), { protocol: "atape.v2-collector-admission.v1", contract: legacyBridgeCaptureContract,
      home: state.home, configFile: resolve(paths.configFile), processFile: resolve(paths.collectorProcessFile), pid: record.pid, token })
  }).pipe(Effect.uninterruptible)
})

/** Explicit interactive npm cutover only. The durable receipt admits later
 * consoles while sync runs; a pending ledger replays before any v2 delegation.
 * No journal, checkpoint, credential or Collector intent is changed here. */
export const prepareManualStateUpgrade = Effect.fn("ManualStateUpgrade.prepare")(function*(paths: NodeClientPaths) {
  if ((yield* io(() => inspect(paths))).ready) return
  yield* Effect.scoped(Effect.gen(function*() {
    yield* Effect.acquireRelease(io(async () => {
      const release = await acquireUpdateWorker(paths.atapeHome)
      if (!release) throw refused("busy", "Another updater owns this ATape installation.")
      return release
    }), release => Effect.sync(release))
    // Entry admission may have preceded another updater's completed handoff.
    // Recheck after owning updates, before any legacy materialization writes.
    yield* io(() => assertRuntimeDataAdmission(runtimeContext(paths.atapeHome)))
    yield* Effect.acquireRelease(io(async () => {
      const release = await acquireProcessLock(`${paths.collectorProcessFile}.lock.sqlite`)
      if (!release) throw refused("busy", "Another process owns the Collector lifecycle.")
      return release
    }), release => Effect.sync(release))
    // All local writes finish before releasing either ownership, including when
    // the caller is interrupted. SIGKILL recovery uses the durable ledger.
    yield* io(async () => {
      const state = await inspect(paths)
      if (state.ready) return
      await requireStopped(paths)
      await privateDirectory(state.home)
      await withClientConfigFileLock(paths.configFile, async () => {
        const raw = await optional(() => readBoundedJSON(paths.configFile, 4 * 1024 * 1024))
        const config = raw === undefined ? emptyClientConfig() : Schema.decodeUnknownSync(ClientConfig)(raw)
        const ledger = state.ledger ?? { protocol: "atape.manual-state-upgrade.v1" as const, contract: legacyBridgeCaptureContract,
          home: state.home, phase: "pending" as const, configFile: resolve(paths.configFile), processFile: resolve(paths.collectorProcessFile),
          current: state.current?.stateContract === "atape.client.v3-capture.v1" ? state.current : undefined,
          retained: state.retained?.stateContract === "atape.client.v3-capture.v1" ? state.retained : undefined }
        if (ledger.phase !== "pending") return
        // Validate both pointer snapshots before making any replay progress.
        for (const [actual, expected] of [[state.current, ledger.current], [state.retained, ledger.retained]])
          if (actual !== undefined && !isDeepStrictEqual(actual, expected)) throw refused("metadata", "Managed runtime metadata no longer matches the unfinished manual upgrade.")
        if (raw === undefined && ledger.current?.adapters.length) throw refused("metadata", "The selected Adapter configuration is missing.")
        if (Buffer.byteLength(JSON.stringify(ledger)) > LedgerBytes) throw new Error("Manual state upgrade exceeds its ledger bound.")
        if (state.ledger === undefined) await atomicJSON(ledgerFile(state.home), ledger)
        // Matching the original before record also makes replay respect a later
        // deliberate Adapter/source replacement, rather than restoring old data.
        const effective = applyRuntimeSelection(config, ledger.current)
        if (!isDeepStrictEqual(effective.adapters, config.adapters)) await atomicJSON(paths.configFile, { ...raw as object, adapters: effective.adapters })
        await retire(runtimeSelectionFile(state.home), ledger.current)
        await retire(retainedFile(state.home), ledger.retained)
        await atomicJSON(ledgerFile(state.home), { protocol: "atape.manual-state-upgrade.v1", contract: legacyBridgeCaptureContract, home: state.home,
          phase: "completed", configFile: resolve(paths.configFile), processFile: resolve(paths.collectorProcessFile) })
      })
    }).pipe(Effect.uninterruptible)
  }))
})
