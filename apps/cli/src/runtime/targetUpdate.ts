import { TargetReleaseBundle, decodeTargetReleaseBundle, targetReleaseBundleFingerprint, updateTargetProtocol,
  type TargetReleaseBundle as Bundle } from "@atape/domain"
import { createHash, randomUUID } from "node:crypto"
import { lstat, open, realpath, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { Schema } from "effect"
import type { NodeClientPaths } from "./clientPaths.ts"
import { acquireProcessLock } from "./processLock.ts"
import { executeOwnedProcess } from "./ownedProcess.ts"
import { createUpdateControl, type UpdateRuntimeAdmission } from "./updateControl.ts"
import { atomicJSON, missing, readBoundedJSON, runtimeEntry, runtimeSelectionFile, updateDirectory } from "./runtimeFiles.ts"

const UUID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Paths = Schema.Struct({ atapeHome: Schema.String, credentialDirectory: Schema.String, configFile: Schema.String,
  collectorStateFile: Schema.String, collectorProcessFile: Schema.String, collectorStatusFile: Schema.String,
  collectorLogFile: Schema.String, adapterDirectory: Schema.String })
const Baseline = Schema.Struct({ config: Schema.NullOr(Hash), selection: Hash, bootstrap: Hash })
const Handoff = Schema.Struct({ protocol: Schema.Literal(updateTargetProtocol), id: UUID, token: UUID,
  paths: Paths, bundle: TargetReleaseBundle, bootstrapEntry: Schema.String, entrySha256: Hash, baseline: Baseline,
  automatic: Schema.Boolean, phase: Schema.Literals(["preparing", "prepared", "activating"]), preparedKey: Schema.optionalKey(UUID) })
export type TargetUpdateHandoff = typeof Handoff.Type
export type TargetUpdateAction = "prepare" | "activate" | "recover"
export type TargetOwnerAction = "owner-recover" | "owner-protected"
const Owner = Schema.Struct({ protocol: Schema.Literal(updateTargetProtocol), id: UUID, token: UUID, paths: Paths,
  bundle: TargetReleaseBundle, bootstrapEntry: Schema.String, entrySha256: Hash, selection: Hash })
export type TargetUpdateOwner = typeof Owner.Type
const Slot = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,191}$/))
const OwnerReceipt = Schema.Struct({ protocol: Schema.Literal(updateTargetProtocol), id: UUID, requestHash: Hash,
  nonce: UUID, entrySha256: Hash, action: Schema.Literals(["owner-recover", "owner-protected"]), internalPending: Schema.Boolean,
  slots: Schema.Array(Slot).check(Schema.isMaxLength(4096)) })
export type TargetOwnerReceipt = typeof OwnerReceipt.Type
const OwnerRequest = Schema.Struct({ id: UUID, ownerHash: Hash, nonce: UUID, action: Schema.Literals(["owner-recover", "owner-protected"]) })
export type TargetOwnerRequest = typeof OwnerRequest.Type
const Receipt = Schema.Struct({ protocol: Schema.Literal(updateTargetProtocol), id: UUID, requestHash: Hash,
  action: Schema.Literals(["prepare", "activate", "recover"]), entrySha256: Hash,
  status: Schema.Literals(["prepared", "completed", "deferred"]), preparedKey: Schema.optionalKey(UUID), internalPending: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,95}$/))) })
export type TargetUpdateReceipt = typeof Receipt.Type
export class TargetUpdateError extends Error {}
const limit = 256 * 1024
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const strict = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)
const handoffFile = (home: string) => join(updateDirectory(home), "target-update.json")
const receiptFile = (home: string, id: string) => join(updateDirectory(home), "target-update-receipts", `${strict(UUID, id)}.json`)
const ownerFile = (home: string) => join(updateDirectory(home), "target-owner.json")
const ownerRequestFile = (home: string, nonce: string) => join(updateDirectory(home), "target-owner-calls", `${strict(UUID, nonce)}.request.json`)
const ownerReceiptFile = (home: string, nonce: string) => join(updateDirectory(home), "target-owner-calls", `${strict(UUID, nonce)}.receipt.json`)
const executionLock = (home: string) => join(updateDirectory(home), "target.execution.lock.sqlite")
const failure = (message: string): never => { throw new TargetUpdateError(message) }
const boundedBytes = async (path: string, maximum: number): Promise<Buffer> => {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) return failure("Target update files must be bounded regular files.")
  const file = await open(path, "r")
  try {
    const bytes = Buffer.alloc(maximum + 1), result = await file.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead > maximum) return failure("Target update file exceeds its bound.")
    return bytes.subarray(0, result.bytesRead)
  } finally { await file.close() }
}
const optionalHash = async (path: string, maximum: number) => boundedBytes(path, maximum).then(digest).catch(cause => {
  if (missing(cause)) return null
  throw cause
})
const selectionHash = async (home: string) => digest(JSON.stringify(await Promise.all([join(updateDirectory(home), "runtime.json"),
  runtimeSelectionFile(home)].map(path => optionalHash(path, limit)))))
const baseline = async (paths: NodeClientPaths, bootstrapEntry: string) => ({
  config: await optionalHash(paths.configFile, 4 * 1024 * 1024),
  selection: await selectionHash(paths.atapeHome),
  bootstrap: digest(await boundedBytes(bootstrapEntry, 16 * 1024 * 1024))
})
const validate = (value: unknown): TargetUpdateHandoff => {
  const job = strict(Handoff, value)
  decodeTargetReleaseBundle(job.bundle)
  if (job.phase !== "preparing" && job.preparedKey === undefined) return failure("Target update lost its opaque preparation receipt.")
  return job
}
const checkedJSON = async (path: string, value: unknown) => {
  if (Buffer.byteLength(JSON.stringify(value)) > limit) return failure("Target update metadata exceeds its bound.")
  await atomicJSON(path, value)
}
export const readTargetUpdateHandoff = async (home: string): Promise<TargetUpdateHandoff | undefined> => {
  try { return validate(await readBoundedJSON(handoffFile(home), limit)) }
  catch (cause) { if (missing(cause)) return undefined; throw cause }
}
export const targetUpdatePending = async (home: string) => (await readTargetUpdateHandoff(home)) !== undefined
export const assertNoTargetUpdate = async (home: string) => {
  if (await targetUpdatePending(home)) failure("A target-owned update is pending. Finish its recovery before changing or pruning installations.")
}
export const targetUpdateRequestHash = (job: TargetUpdateHandoff) => digest(JSON.stringify(job))
export const targetUpdateIdentityHash = (job: TargetUpdateHandoff) => {
  const { phase: _phase, preparedKey: _preparedKey, ...identity } = job
  return digest(JSON.stringify(identity))
}
export const assertTargetUpdateBaseline = async (job: TargetUpdateHandoff) => {
  if (JSON.stringify(await baseline(job.paths as NodeClientPaths, job.bootstrapEntry)) !== JSON.stringify(job.baseline))
    failure("The update baseline changed. Collection remains under its existing selection.")
}
export const validateTargetUpdateExecutable = async (job: Pick<TargetUpdateHandoff, "paths" | "bundle" | "entrySha256">): Promise<string> => {
  const home = await realpath(job.paths.atapeHome), entry = runtimeEntry(home, job.bundle.version)
  if (home !== job.paths.atapeHome) return failure("Target update home changed.")
  const generation = join(home, "releases", job.bundle.version)
  for (const path of [join(home, "releases"), generation, dirname(dirname(entry)), dirname(entry), entry]) {
    if (await realpath(path) !== path || (await lstat(path)).isSymbolicLink()) return failure("Target update executable leaves its immutable generation.")
  }
  const manifest = await readBoundedJSON(join(dirname(dirname(entry)), "package.json"), limit) as {
    name?: unknown; version?: unknown; atapeRuntime?: { stateContract?: unknown; captureStateContract?: unknown;
      updateControlProtocol?: unknown; updateTargetProtocol?: unknown }
  }
  if (manifest.name !== "@atape/cli" || manifest.version !== job.bundle.version ||
    (manifest.atapeRuntime?.captureStateContract ?? manifest.atapeRuntime?.stateContract) !== job.bundle.captureStateContract ||
    manifest.atapeRuntime?.updateControlProtocol !== job.bundle.updateControlProtocol ||
    manifest.atapeRuntime?.updateTargetProtocol !== updateTargetProtocol ||
    digest(await boundedBytes(entry, 16 * 1024 * 1024)) !== job.entrySha256)
    return failure("The recorded target executable identity changed.")
  return entry
}
export const acquireTargetUpdateExecution = (home: string, waitMs = 0) => acquireProcessLock(executionLock(home), waitMs)
export const beginTargetUpdate = async (paths: NodeClientPaths, input: { readonly bundle: Bundle;
  readonly bootstrapEntry: string; readonly automatic: boolean }): Promise<TargetUpdateHandoff> => {
  const release = await acquireTargetUpdateExecution(paths.atapeHome)
  if (!release) return failure("Target update preparation is already owned. Recovery will retry.")
  try {
  await assertNoTargetUpdate(paths.atapeHome)
  const canonicalHome = await realpath(paths.atapeHome), originalHome = resolve(paths.atapeHome)
  const canonicalPath = (path: string) => {
    const absolute = resolve(path)
    return absolute === originalHome ? canonicalHome : absolute.startsWith(`${originalHome}${sep}`)
      ? join(canonicalHome, absolute.slice(originalHome.length + 1)) : absolute
  }
  if (!Object.values(paths).every(isAbsolute)) return failure("Target update requires absolute local paths.")
  const selectedPaths = { atapeHome: canonicalHome, credentialDirectory: canonicalPath(paths.credentialDirectory),
    configFile: canonicalPath(paths.configFile), collectorStateFile: canonicalPath(paths.collectorStateFile), collectorProcessFile: canonicalPath(paths.collectorProcessFile),
    collectorStatusFile: canonicalPath(paths.collectorStatusFile), collectorLogFile: canonicalPath(paths.collectorLogFile), adapterDirectory: canonicalPath(paths.adapterDirectory) }
  if (!Object.values(selectedPaths).every(isAbsolute)) return failure("Target update requires absolute local paths.")
  const job = validate({ protocol: updateTargetProtocol, id: randomUUID(), token: randomUUID(), paths: selectedPaths,
    bundle: decodeTargetReleaseBundle(input.bundle), bootstrapEntry: await realpath(input.bootstrapEntry), automatic: input.automatic,
    entrySha256: digest(await boundedBytes(runtimeEntry(selectedPaths.atapeHome, input.bundle.version), 16 * 1024 * 1024)),
    baseline: await baseline(selectedPaths, input.bootstrapEntry), phase: "preparing" })
  await validateTargetUpdateExecutable(job)
  await checkedJSON(handoffFile(paths.atapeHome), job)
  return job
  } finally { release() }
}
export const writeTargetUpdateReceipt = async (job: TargetUpdateHandoff, action: TargetUpdateAction,
  input: Pick<TargetUpdateReceipt, "status" | "internalPending" | "preparedKey" | "reason">): Promise<TargetUpdateReceipt> => {
  const receipt = strict(Receipt, { protocol: updateTargetProtocol, id: job.id, requestHash: targetUpdateRequestHash(job),
    entrySha256: job.entrySha256, action, ...input })
  await checkedJSON(receiptFile(job.paths.atapeHome, job.id), receipt)
  return receipt
}
export const readTargetUpdateReceipt = async (job: TargetUpdateHandoff, action?: TargetUpdateAction): Promise<TargetUpdateReceipt> => {
  const receipt = strict(Receipt, await readBoundedJSON(receiptFile(job.paths.atapeHome, job.id), limit))
  if (receipt.id !== job.id || action !== undefined && receipt.action !== action || receipt.requestHash !== targetUpdateRequestHash(job) ||
    receipt.entrySha256 !== job.entrySha256) return failure("Target update receipt does not match its immutable request.")
  return receipt
}
export const invokeTargetUpdate = async (job: TargetUpdateHandoff, action: TargetUpdateAction,
  environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<TargetUpdateReceipt> => {
  const entry = await validateTargetUpdateExecutable(job)
  await executeOwnedProcess(process.execPath, [entry, "__update-target", job.id, job.token, action], {
    ...environment, ATAPE_RUNTIME_DIRECT: "1", ATAPE_BOOTSTRAP_ENTRY: job.bootstrapEntry,
    ATAPE_HOME: job.paths.atapeHome, ATAPE_CONFIG_FILE: job.paths.configFile, ATAPE_COLLECTOR_STATE_FILE: job.paths.collectorStateFile,
    ATAPE_COLLECTOR_PROCESS_FILE: job.paths.collectorProcessFile, ATAPE_COLLECTOR_STATUS_FILE: job.paths.collectorStatusFile,
    ATAPE_COLLECTOR_LOG_FILE: job.paths.collectorLogFile, ATAPE_ADAPTER_DIRECTORY: job.paths.adapterDirectory
  }, signal, 600_000)
  return readTargetUpdateReceipt(job, action)
}
const owned = async <A>(job: TargetUpdateHandoff, run: () => Promise<A>) => {
  const release = await acquireTargetUpdateExecution(job.paths.atapeHome)
  if (!release) return failure("The recorded target update still owns its execution lock. Recovery will retry.")
  try {
    const current = await readTargetUpdateHandoff(job.paths.atapeHome)
    if (!current || targetUpdateRequestHash(current) !== targetUpdateRequestHash(job)) return failure("The target update handoff changed.")
    return await run()
  } finally { release() }
}
export const advanceTargetUpdate = (job: TargetUpdateHandoff, phase: "prepared" | "activating", preparedKey: string) => owned(job, async () => {
  const next = validate({ ...job, phase, preparedKey: strict(UUID, preparedKey) })
  // Removing the obsolete receipt first leaves a recoverable older phase if a
  // crash interrupts the phase CAS; it never accepts a receipt from a prior phase.
  await rm(receiptFile(job.paths.atapeHome, job.id), { force: true })
  await checkedJSON(handoffFile(job.paths.atapeHome), next)
  return next
})
export const finishTargetUpdate = (job: TargetUpdateHandoff, receipt: TargetUpdateReceipt) => owned(job, async () => {
  if (receipt.id !== job.id || receipt.requestHash !== targetUpdateRequestHash(job) || receipt.entrySha256 !== job.entrySha256 ||
    receipt.internalPending || !["completed", "deferred"].includes(receipt.status)) return failure("The target update has not durably settled.")
  if (receipt.status === "completed") {
    const selected = await readBoundedJSON(join(updateDirectory(job.paths.atapeHome), "runtime.json")) as { version?: unknown }
    if (selected.version !== job.bundle.version) return failure("The completed target is not the selected runtime.")
    const owner = strict(Owner, { protocol: updateTargetProtocol, id: randomUUID(), token: randomUUID(), paths: job.paths,
      bundle: job.bundle, bootstrapEntry: job.bootstrapEntry, entrySha256: job.entrySha256,
      selection: await selectionHash(job.paths.atapeHome) })
    await checkedJSON(ownerFile(job.paths.atapeHome), owner)
  }
  await rm(handoffFile(job.paths.atapeHome))
  await rm(receiptFile(job.paths.atapeHome, job.id), { force: true })
  const directory = await open(updateDirectory(job.paths.atapeHome), "r")
  try { await directory.sync() } finally { await directory.close() }
})
export const recoverTargetUpdate = async (home: string, environment: NodeJS.ProcessEnv, signal = AbortSignal.timeout(600_000)) => {
  const job = await readTargetUpdateHandoff(home)
  if (!job) return false
  const receipt = await invokeTargetUpdate(job, "recover", environment, signal)
  await finishTargetUpdate(job, receipt)
  return true
}
export const targetUpdateMatches = (job: TargetUpdateHandoff, bundle: Bundle, key: string) =>
  job.id === key && targetReleaseBundleFingerprint(job.bundle) === targetReleaseBundleFingerprint(bundle)

// Completed ownership retains executable routing, never activation authority.
// A mismatched selection fails closed rather than routing recovery backwards.
const selectedVersion = async (home: string) => (await readBoundedJSON(join(updateDirectory(home), "runtime.json")) as { version?: unknown }).version
export const readTargetUpdateOwner = async (home: string, runtime?: UpdateRuntimeAdmission): Promise<TargetUpdateOwner | undefined> => {
  try {
    const owner = strict(Owner, await readBoundedJSON(ownerFile(home), limit))
    if (owner.paths.atapeHome !== await realpath(home)) return failure("Target owner belongs to a different home.")
    if (owner.selection !== await selectionHash(home)) {
      // A supported npm rebind may have selected this exact new executable.
      // Its actual compiled admission, never an arbitrary replaced manifest,
      // permits that implementation to retire the obsolete routing anchor.
      if (runtime && /^\d+\.\d+\.\d+$/.test(runtime.version) && await selectedVersion(home) === runtime.version) {
        await createUpdateControl(home).assertRuntimeAdmission(runtime)
        return undefined
      }
      return failure("Target ownership does not match the current runtime selection. Recovery cannot use an older target.")
    }
    return owner
  } catch (cause) { if (missing(cause)) return undefined; throw cause }
}
export const targetOwnerRetirementPending = async (home: string, runtime: UpdateRuntimeAdmission) => {
  try {
    strict(Owner, await readBoundedJSON(ownerFile(home), limit))
    return await readTargetUpdateOwner(home, runtime) === undefined
  } catch (cause) { if (missing(cause)) return false; throw cause }
}
export const retireObsoleteTargetOwner = async (home: string, runtime: UpdateRuntimeAdmission) => {
  if (!await targetOwnerRetirementPending(home, runtime)) return
  const release = await acquireTargetUpdateExecution(home)
  if (!release) return failure("Target execution still owns obsolete routing. Recovery will retry.")
  try {
    await assertNoTargetUpdate(home)
    if (await targetOwnerRetirementPending(home, runtime)) await rm(ownerFile(home))
  } finally { release() }
}
export const targetOwnerRequestHash = (owner: TargetUpdateOwner) => digest(JSON.stringify(owner))
export const readTargetOwnerRequest = async (owner: TargetUpdateOwner, nonce: string, action: TargetOwnerAction) => {
  const request = strict(OwnerRequest, await readBoundedJSON(ownerRequestFile(owner.paths.atapeHome, nonce), limit))
  if (request.nonce !== nonce || request.id !== owner.id || request.ownerHash !== targetOwnerRequestHash(owner) || request.action !== action)
    return failure("Target owner invocation does not match its durable request.")
  return request
}
export const writeTargetOwnerReceipt = async (owner: TargetUpdateOwner, request: TargetOwnerRequest,
  input: Pick<TargetOwnerReceipt, "internalPending" | "slots">) => {
  const receipt = strict(OwnerReceipt, { protocol: updateTargetProtocol, id: owner.id, requestHash: targetOwnerRequestHash(owner),
    nonce: request.nonce, entrySha256: owner.entrySha256, action: request.action, ...input })
  await checkedJSON(ownerReceiptFile(owner.paths.atapeHome, request.nonce), receipt)
  return receipt
}
export const invokeTargetOwner = async (owner: TargetUpdateOwner, action: TargetOwnerAction,
  environment: NodeJS.ProcessEnv, signal = AbortSignal.timeout(600_000)): Promise<TargetOwnerReceipt> => {
  const entry = await validateTargetUpdateExecutable(owner)
  const request = strict(OwnerRequest, { id: owner.id, ownerHash: targetOwnerRequestHash(owner), nonce: randomUUID(), action })
  await checkedJSON(ownerRequestFile(owner.paths.atapeHome, request.nonce), request)
  let release: (() => void) | undefined
  try {
  await executeOwnedProcess(process.execPath, [entry, "__update-target", owner.id, owner.token, action, request.nonce], {
    ...environment, ATAPE_RUNTIME_DIRECT: "1", ATAPE_BOOTSTRAP_ENTRY: owner.bootstrapEntry, ATAPE_HOME: owner.paths.atapeHome,
    ATAPE_CONFIG_FILE: owner.paths.configFile, ATAPE_COLLECTOR_STATE_FILE: owner.paths.collectorStateFile,
    ATAPE_COLLECTOR_PROCESS_FILE: owner.paths.collectorProcessFile, ATAPE_COLLECTOR_STATUS_FILE: owner.paths.collectorStatusFile,
    ATAPE_COLLECTOR_LOG_FILE: owner.paths.collectorLogFile, ATAPE_ADAPTER_DIRECTORY: owner.paths.adapterDirectory
  }, signal, 600_000)
  const receipt = strict(OwnerReceipt, await readBoundedJSON(ownerReceiptFile(owner.paths.atapeHome, request.nonce), limit))
  if (receipt.id !== owner.id || receipt.requestHash !== targetOwnerRequestHash(owner) || receipt.action !== action ||
    receipt.nonce !== request.nonce || receipt.entrySha256 !== owner.entrySha256) return failure("Target owner receipt does not match its immutable request.")
  release = await acquireTargetUpdateExecution(owner.paths.atapeHome, 10_000)
  if (!release) return failure("The target still owns execution. Recovery will retry.")
    if (targetOwnerRequestHash((await readTargetUpdateOwner(owner.paths.atapeHome))!) !== targetOwnerRequestHash(owner))
      return failure("Target ownership changed during inspection.")
    return receipt
  } finally {
    // Cancellation joins the executable before this point. An orphan that still
    // owns exclusion keeps only its own bounded invocation for a later retry.
    release ??= await acquireTargetUpdateExecution(owner.paths.atapeHome, 10_000)
    if (release) {
      try {
        await rm(ownerRequestFile(owner.paths.atapeHome, request.nonce), { force: true })
        await rm(ownerReceiptFile(owner.paths.atapeHome, request.nonce), { force: true })
      } finally { release() }
    }
  }
}
