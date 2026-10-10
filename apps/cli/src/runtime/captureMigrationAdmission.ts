import { MigrationReleaseBundle, decodeMigrationReleaseBundle, migrationReleaseBundleFingerprint } from "@atape/domain"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, rm } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { Effect, Schema } from "effect"
import type { RuntimeContext } from "./runtimeAdmission.ts"
import type { NodeClientPaths } from "./clientPaths.ts"
import { acquireProcessLock } from "./processLock.ts"
import { atomicJSON, missing, readBoundedJSON, updateDirectory } from "./runtimeFiles.ts"
import { createUpdateControl, UpdateRuntimeSelection, decodeUpdateRuntimeSelection, type UpdateRuntimeSelection as Selection } from "./updateControl.ts"

export const captureMigrationProtocol = "atape.capture-migration.v1" as const
export const captureMigrationPlan = "journal-v7-to-v8" as const
export const migrationTargetContract = "atape.client.v3-capture.v2"
const sourceContracts = ["atape.client.v3-capture.v1", migrationTargetContract]
const UUID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048), Schema.isPattern(/^[^\u0000]+$/))
const Version = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/))
const Identity = Schema.Struct({ version: Version, captureStateContract: Text })
const Binding = Schema.Struct({ instanceOrigin: Text, userId: Text, installationId: Text })
const Paths = Schema.Struct({ atapeHome: Text, credentialDirectory: Text, configFile: Text, collectorStateFile: Text,
  collectorProcessFile: Text, collectorStatusFile: Text, collectorLogFile: Text, adapterDirectory: Text })
export const RegisteredJournalObservation = Schema.Struct({ key: Hash, path: Text, binding: Schema.NullOr(Binding), installationId: Text, bindingHash: Hash,
  format: Schema.Literals([0, 7, 8]), deferred: Schema.Boolean })
export type RegisteredJournalObservation = typeof RegisteredJournalObservation.Type
const Requirement = Schema.Struct({ outerKey: UUID, home: Text, paths: Paths, bundle: MigrationReleaseBundle,
  bundleFingerprint: Hash, source: Identity, target: UpdateRuntimeSelection, inventory: Schema.Array(RegisteredJournalObservation),
  prerequisiteScopeFingerprint: Hash, hash: Hash })
export type CaptureMigrationRequirement = typeof Requirement.Type
const AccountResult = Schema.Struct({ key: Hash, bindingHash: Hash, result: Schema.Literals(["v8", "deferred-initialization"]) })
export const CaptureMigrationReceipt = Schema.Struct({ protocol: Schema.Literal("atape.capture-migration-receipt.v1"), outerKey: UUID,
  requirementHash: Hash, bundleFingerprint: Hash, planId: Schema.Literal(captureMigrationPlan), target: Identity, accounts: Schema.Array(AccountResult) })
export type CaptureMigrationReceipt = typeof CaptureMigrationReceipt.Type
const PriorCompleted = Schema.Struct({ requirement: Requirement, receipt: CaptureMigrationReceipt })
const Required = Schema.Struct({ protocol: Schema.Literal("atape.capture-migration-required.v1"), requirement: Requirement,
  priorCompleted: Schema.optionalKey(PriorCompleted) })
export type CaptureMigrationRequired = typeof Required.Type
export const CaptureMigrationAttempt = Schema.Struct({ outerKey: UUID, attemptId: UUID, token: UUID, bundleFingerprint: Hash })
export type CaptureMigrationAttempt = typeof CaptureMigrationAttempt.Type
const Attempt = Schema.Struct({ ...CaptureMigrationAttempt.fields, expiresAt: Schema.Number })
const Ledger = Schema.Struct({ protocol: Schema.Literal(captureMigrationProtocol), required: Required,
  phase: Schema.Literals(["authorized", "applying", "completed"]), attempt: Schema.optionalKey(Attempt), progress: Schema.Array(AccountResult),
  receipt: Schema.optionalKey(CaptureMigrationReceipt) })
export type CaptureMigrationLedger = typeof Ledger.Type
export class CaptureMigrationError extends Schema.TaggedError<CaptureMigrationError>()("CaptureMigrationError", {
  reason: Schema.Literals(["unsupported", "metadata", "binding", "prerequisite", "conflict", "busy", "stale-attempt", "deadline", "storage"]), message: Schema.String
}) {}
export const migrationFailure = (reason: CaptureMigrationError["reason"], message: string): CaptureMigrationError => new CaptureMigrationError({ reason, message })
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value
export const migrationHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
export const migrationBundleHash = (bundle: typeof MigrationReleaseBundle.Type) => createHash("sha256").update(migrationReleaseBundleFingerprint(bundle)).digest("hex")
const strict = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)
function fail(reason: CaptureMigrationError["reason"], message: string): never { throw migrationFailure(reason, message) }
export const migrationError = (cause: unknown) => cause instanceof CaptureMigrationError ? cause : migrationFailure("storage", "Capture migration storage operation failed.")
const stable = (version: string) => Version.pipe(schema => strict(schema, version)) && version.length < 40 && version.split(".").every(part => Number.isSafeInteger(Number(part)))
const older = (left: string, right: string) => {
  if (!stable(left) || !stable(right)) fail("metadata", "Capture migration release version is invalid.")
  const a = left.split(".").map(Number), b = right.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
  return false
}
export const requirementHash = (value: Omit<CaptureMigrationRequirement, "hash">) => migrationHash(value)
const validateRequirement = (value: CaptureMigrationRequirement) => {
  const { hash, ...body } = value, bundle = decodeMigrationReleaseBundle(value.bundle)
  decodeUpdateRuntimeSelection(value.target)
  if (hash !== requirementHash(body) || value.bundleFingerprint !== migrationBundleHash(bundle) ||
    bundle.migration.protocol !== captureMigrationProtocol || bundle.migration.id !== captureMigrationPlan ||
    !sourceContracts.includes(value.source.captureStateContract) || !bundle.migration.fromCaptureStateContracts.includes(value.source.captureStateContract) ||
    bundle.captureStateContract !== migrationTargetContract || value.target.captureStateContract !== bundle.captureStateContract ||
    value.target.version !== bundle.version || older(value.target.version, value.source.version) || value.home !== value.paths.atapeHome ||
    value.inventory.length > 32 || new Set(value.inventory.map(account => account.key)).size !== value.inventory.length)
    fail("metadata", "Capture migration requirement failed its immutable identity checks.")
  for (const account of value.inventory) if ((account.binding ? account.bindingHash !== migrationHash(account.binding) ||
    account.binding.installationId !== account.installationId || account.key !== migrationHash([account.binding.instanceOrigin, account.binding.userId]) :
    !account.deferred || account.bindingHash !== migrationHash({ key: account.key, installationId: account.installationId })) ||
    account.path !== join(`${value.paths.collectorStateFile}.captures`, `${account.key}.sqlite`) || account.deferred !== (account.format === 0))
    fail("binding", "Capture migration account inventory is inconsistent.")
  return value
}
const validateReceipt = (requirement: CaptureMigrationRequirement, receipt: CaptureMigrationReceipt) => {
  if (receipt.outerKey !== requirement.outerKey || receipt.requirementHash !== requirement.hash || receipt.bundleFingerprint !== requirement.bundleFingerprint ||
    receipt.target.version !== requirement.target.version || receipt.target.captureStateContract !== requirement.target.captureStateContract ||
    !isDeepStrictEqual(receipt.accounts, requirement.inventory.map(account => ({ key: account.key, bindingHash: account.bindingHash,
      result: account.deferred ? "deferred-initialization" : "v8" })))) fail("metadata", "Capture migration receipt does not match its requirement.")
}
const validateRequired = (required: CaptureMigrationRequired) => {
  validateRequirement(required.requirement)
  if (required.priorCompleted) {
    validateRequirement(required.priorCompleted.requirement); validateReceipt(required.priorCompleted.requirement, required.priorCompleted.receipt)
    if (required.priorCompleted.requirement.home !== required.requirement.home ||
      required.priorCompleted.receipt.target.captureStateContract !== required.requirement.source.captureStateContract ||
      older(required.requirement.source.version, required.priorCompleted.receipt.target.version))
      fail("binding", "The preceding completed migration does not admit this source runtime and canonical home.")
  }
  return required
}
const validateLedger = (ledger: CaptureMigrationLedger) => {
  validateRequired(ledger.required)
  const requirement = ledger.required.requirement, seen = new Set<string>()
  for (const progress of ledger.progress) {
    const account = requirement.inventory.find(account => account.key === progress.key)
    if (!account || seen.has(progress.key) || progress.bindingHash !== account.bindingHash || progress.result !== (account.deferred ? "deferred-initialization" : "v8"))
      fail("metadata", "Capture migration progress is invalid.")
    seen.add(progress.key)
  }
  if (ledger.attempt && (ledger.attempt.outerKey !== requirement.outerKey || ledger.attempt.bundleFingerprint !== requirement.bundleFingerprint ||
    !Number.isSafeInteger(ledger.attempt.expiresAt) || ledger.attempt.expiresAt < 0)) fail("metadata", "Capture migration attempt is invalid.")
  if ((ledger.phase === "authorized" && ledger.attempt !== undefined) || (ledger.phase === "applying" && !ledger.attempt) ||
    (ledger.phase === "completed" && (!ledger.receipt || ledger.attempt !== undefined)) || (ledger.phase !== "completed" && ledger.receipt !== undefined))
    fail("metadata", "Capture migration phase is inconsistent.")
  if (ledger.receipt) { validateReceipt(requirement, ledger.receipt); if (!isDeepStrictEqual(ledger.progress, ledger.receipt.accounts)) fail("metadata", "Completed migration progress is inconsistent.") }
  return ledger
}

/** Private, bounded metadata. Opening no-follow and comparing the opened inode
 * avoids following a replaced symlink between the initial inspection and read. */
export const readMigrationJSON = async (path: string, limit = 128 * 1024): Promise<unknown> => {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())) fail("metadata", "Capture migration metadata is not bounded private regular storage.")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) fail("metadata", "Capture migration metadata changed while opening.")
    const bytes = Buffer.alloc(limit + 1), read = await file.read(bytes, 0, bytes.length, 0)
    if (read.bytesRead > limit) fail("metadata", "Capture migration metadata exceeds its bound.")
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read.bytesRead))) as unknown
  } finally { await file.close() }
}
const optional = async <A>(path: string, schema: Schema.ConstraintDecoder<A>, validate: (value: A) => A) => {
  try { return validate(strict(schema, await readMigrationJSON(path))) } catch (cause) {
    if (missing(cause)) return undefined
    if (cause instanceof CaptureMigrationError) throw cause
    fail("metadata", "Capture migration metadata is malformed or unavailable.")
  }
}
export const captureMigrationFiles = (home: string) => ({ required: join(updateDirectory(home), "capture-migration.required.json"),
  ledger: join(updateDirectory(home), "capture-migration.json"), applyLock: join(updateDirectory(home), "capture-migration.apply.lock.sqlite") })
export const readCaptureMigrationPair = async (home: string) => {
  const files = captureMigrationFiles(home), required = await optional(files.required, Required, validateRequired)
  let ledger = await optional(files.ledger, Ledger, validateLedger)
  if (required && ledger && !isDeepStrictEqual(required, ledger.required)) {
    // Marker-first authorization (or ledger-first abandonment) may leave the
    // preceding completed pair beside its explicit immutable successor marker.
    const prior = required.priorCompleted
    if (!prior || ledger.phase !== "completed" || !isDeepStrictEqual(prior.requirement, ledger.required.requirement) || !isDeepStrictEqual(prior.receipt, ledger.receipt))
      fail("metadata", "Capture migration requirement and ledger disagree.")
    ledger = undefined
  }
  const known = required ?? ledger?.required
  if (known && known.requirement.home !== await realpath(home)) fail("binding", "Capture migration belongs to another canonical home.")
  return { required, ledger, known }
}
export const writeCaptureMigrationRequired = async (home: string, required: CaptureMigrationRequired) => {
  validateRequired(strict(Required, required)); assertMigrationMetadataBound(required); await atomicJSON(captureMigrationFiles(home).required, required)
}
export const writeCaptureMigrationLedger = async (home: string, ledger: CaptureMigrationLedger) => {
  validateLedger(strict(Ledger, ledger)); assertMigrationMetadataBound(ledger); await atomicJSON(captureMigrationFiles(home).ledger, ledger)
}
export const assertMigrationMetadataBound = (value: unknown, maximum = 128 * 1024) => {
  if (Buffer.byteLength(JSON.stringify(value)) + 1 > maximum) fail("metadata", "Capture migration metadata exceeds its bounded size.")
}
export const withCaptureMigrationBarrier = async <A>(home: string, work: () => Promise<A>): Promise<A> => {
  const release = await createUpdateControl(home).acquireRuntimeWriteBarrier()
  try { return await work() } finally { release() }
}
export const removeCaptureMigrationPair = async (home: string) => {
  const files = captureMigrationFiles(home)
  await rm(files.ledger, { force: true }); await rm(files.required, { force: true })
  const directory = await open(updateDirectory(home), "r")
  try { await directory.sync() } finally { await directory.close() }
}
export const assertCompletedCaptureMigration = async (context: RuntimeContext): Promise<void> => {
  const pair = await readCaptureMigrationPair(context.home)
  if (!pair.known) return
  if (!pair.required || !pair.ledger || pair.ledger.phase !== "completed" || !pair.ledger.receipt)
    fail("conflict", "Capture is paused until its explicit state migration completes.")
  const target = pair.ledger.receipt.target
  if (context.identity.captureStateContract !== target.captureStateContract || older(context.identity.version, target.version))
    fail("conflict", "This runtime does not satisfy the completed capture migration contract and reader version.")
}
const assertFloor = (context: RuntimeContext) => context.identity.version === "development" ? Promise.resolve() : createUpdateControl(context.home).assertRuntimeAdmission(context.identity)
export const assertCaptureMigrationAdmission = (context: RuntimeContext): Effect.Effect<void, CaptureMigrationError> => Effect.tryPromise({
  try: async () => { await assertFloor(context); await assertCompletedCaptureMigration(context) }, catch: migrationError
})
export const guardCaptureRuntimeWrite = <A, E, R, F>(context: RuntimeContext, program: Effect.Effect<A, E, R>, mapError: (cause: unknown) => F): Effect.Effect<A, E | F, R> =>
  Effect.acquireUseRelease(Effect.tryPromise({ try: async () => {
    const release = await createUpdateControl(context.home).acquireRuntimeWriteBarrier()
    try { await assertFloor(context); await assertCompletedCaptureMigration(context); return release } catch (cause) { release(); throw cause }
  }, catch: mapError }), () => program, release => Effect.sync(release)).pipe(Effect.uninterruptible)

declare const authorityBrand: unique symbol
export type CaptureMigrationWriteAuthority = { readonly [authorityBrand]: true }
const authorities = new WeakMap<CaptureMigrationWriteAuthority, { context: RuntimeContext; attempt: CaptureMigrationAttempt; deadline: number; active: boolean }>()
const attemptMatches = (expected: CaptureMigrationAttempt, actual: CaptureMigrationAttempt) => expected.outerKey === actual.outerKey && expected.attemptId === actual.attemptId &&
  expected.token === actual.token && expected.bundleFingerprint === actual.bundleFingerprint
const validateAuthority = async (record: { context: RuntimeContext; attempt: CaptureMigrationAttempt; deadline: number; active: boolean }) => {
  if (!record.active || performance.now() >= record.deadline) fail("deadline", "The capture migration apply budget expired.")
  const pair = await readCaptureMigrationPair(record.context.home), ledger = pair.ledger, required = pair.required
  if (!ledger || !required || ledger.phase !== "applying" || !ledger.attempt || !attemptMatches(record.attempt, ledger.attempt))
    fail("stale-attempt", "The capture migration attempt was revoked or superseded.")
  const requirement = required.requirement, actual = record.context.identity
  if (actual.version !== requirement.target.version || actual.captureStateContract !== requirement.target.captureStateContract)
    fail("binding", "Only the exact executing target runtime can apply this migration.")
  const control = createUpdateControl(record.context.home), boundary = await control.migrationBoundary(record.attempt.outerKey)
  if (!boundary.forwardOnly || !isDeepStrictEqual(boundary.target, requirement.target) || !isDeepStrictEqual(boundary.selection, requirement.target))
    fail("conflict", "Capture migration has no matching forward-only runtime selection.")
  await control.assertRuntimeAdmission(actual)
  const entry = await control.resolveSelectionEntry(requirement.target, true)
  const manifest = await readBoundedJSON(join(dirname(dirname(entry)), "package.json")) as { atapeRuntime?: { captureMigrationProtocol?: unknown } }
  if (manifest.atapeRuntime?.captureMigrationProtocol !== captureMigrationProtocol) fail("unsupported", "The actual target lacks migration execution capability.")
  return { ledger, requirement }
}
export const acquireCaptureMigrationWriteAuthority = (context: RuntimeContext, input: CaptureMigrationAttempt) => Effect.acquireRelease(
  Effect.tryPromise({ try: async () => {
    const attempt = strict(CaptureMigrationAttempt, input), pair = await readCaptureMigrationPair(context.home)
    if (!pair.ledger?.attempt || !attemptMatches(attempt, pair.ledger.attempt)) fail("stale-attempt", "Capture migration attempt is no longer current.")
    const remaining = Math.min(20_000, pair.ledger.attempt.expiresAt - Date.now())
    if (remaining <= 0) fail("deadline", "Capture migration attempt expired before apply.")
    const deadline = performance.now() + remaining, release = await acquireProcessLock(captureMigrationFiles(context.home).applyLock, Math.min(5_000, remaining))
    if (!release) fail("busy", "Another capture migration apply process still holds exclusion.")
    const authority = Object.freeze({}) as CaptureMigrationWriteAuthority, record = { context, attempt, deadline, active: true }
    try { await withCaptureMigrationBarrier(context.home, () => validateAuthority(record)); authorities.set(authority, record); return { authority, release } }
    catch (cause) { release(); throw cause }
  }, catch: migrationError }), owned => Effect.sync(() => { const record = authorities.get(owned.authority); if (record) record.active = false; owned.release() })
).pipe(Effect.map(owned => owned.authority))
export const guardCaptureMigrationWrite = <A, E, R, F>(authority: CaptureMigrationWriteAuthority, program: Effect.Effect<A, E, R>, mapError: (cause: unknown) => F): Effect.Effect<A, E | F, R> =>
  Effect.acquireUseRelease(Effect.tryPromise({ try: async () => {
    const record = authorities.get(authority)
    if (!record) fail("stale-attempt", "Capture migration authority is not an active owned resource.")
    const release = await createUpdateControl(record.context.home).acquireRuntimeWriteBarrier()
    try { await validateAuthority(record); return release } catch (cause) { release(); throw cause }
  }, catch: mapError }), () => program, release => Effect.sync(release)).pipe(Effect.uninterruptible)

/** The runner may inspect its validated immutable request while the authority
 * Scope owns apply exclusion; every mutation must still use its write guard. */
export const captureMigrationAuthorityRequirement = (authority: CaptureMigrationWriteAuthority) => Effect.tryPromise({ try: async () => {
  const record = authorities.get(authority)
  if (!record) fail("stale-attempt", "Capture migration authority is not active.")
  return (await withCaptureMigrationBarrier(record.context.home, () => validateAuthority(record))).requirement
}, catch: migrationError })

export const canonicalMigrationPaths = async (paths: NodeClientPaths): Promise<NodeClientPaths> => {
  const home = await realpath(paths.atapeHome)
  const canonical = async (path: string): Promise<string> => {
    const absolute = resolve(path)
    try { return await realpath(absolute) } catch (cause) {
      if (!missing(cause)) throw cause
      const parent = resolve(absolute, "..")
      if (parent === absolute) throw cause
      return join(await canonical(parent), absolute.slice(parent.length + 1))
    }
  }
  const result = { ...paths, atapeHome: home }
  for (const key of Object.keys(paths) as Array<keyof NodeClientPaths>) result[key] = await canonical(paths[key])
  return result
}
