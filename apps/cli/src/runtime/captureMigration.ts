import { ClientConfig, CollectorState, MigrationReleaseBundle, decodeMigrationReleaseBundle, type MigrationReleaseBundle as Bundle } from "@atape/domain"
import { randomUUID } from "node:crypto"
import { lstat, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import { type NodeClientPaths, defaultNodeClientPaths } from "./clientPaths.ts"
import { CaptureInstallation } from "./captureBinding.ts"
import { inspectCaptureJournalV7ToV8, migrateCaptureJournalV7ToV8 } from "./captureJournal.ts"
import { inspectCaptureMigrationPrerequisitesScope, preflightCaptureMigrationPrerequisites } from "./captureMigrationPrerequisites.ts"
import { runtimeContext, type RuntimeContext } from "./runtimeAdmission.ts"
import { atomicJSON, missing, readBoundedJSON, updateDirectory } from "./runtimeFiles.ts"
import { executeOwnedProcess } from "./ownedProcess.ts"
import { createUpdateControl, UpdateRuntimeSelection, type UpdateRuntimeSelection as Selection } from "./updateControl.ts"
import { acquireCaptureMigrationWriteAuthority, assertMigrationMetadataBound, canonicalMigrationPaths, captureMigrationAuthorityRequirement, CaptureMigrationAttempt,
  CaptureMigrationReceipt, captureMigrationPlan, captureMigrationProtocol, guardCaptureMigrationWrite, migrationBundleHash, migrationError, migrationFailure,
  migrationHash, readCaptureMigrationPair, readMigrationJSON, RegisteredJournalObservation, removeCaptureMigrationPair, requirementHash,
  withCaptureMigrationBarrier, writeCaptureMigrationLedger, writeCaptureMigrationRequired,
  type CaptureMigrationLedger, type CaptureMigrationRequirement, type CaptureMigrationRequired } from "./captureMigrationAdmission.ts"

export { CaptureMigrationError, captureMigrationProtocol, captureMigrationPlan, type CaptureMigrationAttempt, type CaptureMigrationReceipt } from "./captureMigrationAdmission.ts"
const UUID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const Identity = Schema.Struct({ version: Schema.String, captureStateContract: Schema.String })
const AccountBinding = Schema.Struct({ protocol: Schema.Literal("atape.capture-account.v1"), instanceOrigin: Schema.String,
  userId: Schema.String, installationId: Schema.String, phase: Schema.Literals(["initializing", "ready"]) })
const Paths = Schema.Struct({ atapeHome: Schema.String, credentialDirectory: Schema.String, configFile: Schema.String, collectorStateFile: Schema.String,
  collectorProcessFile: Schema.String, collectorStatusFile: Schema.String, collectorLogFile: Schema.String, adapterDirectory: Schema.String })
const Request = Schema.Struct({ protocol: Schema.Literal("atape.capture-migration-request.v1"), requestId: UUID, token: UUID,
  paths: Paths, bundle: MigrationReleaseBundle, source: Identity, target: UpdateRuntimeSelection, candidateConfig: ClientConfig, wanted: Schema.Boolean,
  inventory: Schema.Array(RegisteredJournalObservation), prerequisiteScopeFingerprint: Hash })
type Request = typeof Request.Type
const Report = Schema.Struct({ protocol: Schema.Literal("atape.capture-migration-preflight.v1"), requestId: UUID, requestHash: Hash,
  bundleFingerprint: Hash, migrationProtocol: Schema.Literal(captureMigrationProtocol), planId: Schema.Literal(captureMigrationPlan), source: Identity,
  actualTarget: Identity, inventoryFingerprint: Hash, prerequisiteScopeFingerprint: Hash, inventory: Schema.Array(RegisteredJournalObservation) })
export type CaptureMigrationPreflightReport = typeof Report.Type
export type CaptureMigrationPrivateRequest = { readonly requestId: string; readonly token: string }
export type MigrationOuter = { readonly key: string; readonly target: Selection }
type Scope = { readonly candidateConfig: ClientConfig; readonly wanted: boolean }
declare const proofBrand: unique symbol
export type ValidatedCaptureMigration = { readonly [proofBrand]: true; readonly bundleFingerprint: string; readonly source: RuntimeContext["identity"];
  readonly target: RuntimeContext["identity"]; readonly prerequisiteScopeFingerprint: string }
const strict = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)
function fail(reason: Parameters<typeof migrationFailure>[0], message: string): never { throw migrationFailure(reason, message) }
const requestFile = (home: string, id: string) => join(updateDirectory(home), "capture-migration-requests", `${strict(UUID, id)}.json`)
const childEnvironment = (environment: NodeJS.ProcessEnv, paths: NodeClientPaths): NodeJS.ProcessEnv => ({ ...environment,
  ATAPE_HOME: paths.atapeHome, ATAPE_CONFIG_FILE: paths.configFile, ATAPE_COLLECTOR_STATE_FILE: paths.collectorStateFile,
  ATAPE_COLLECTOR_PROCESS_FILE: paths.collectorProcessFile, ATAPE_COLLECTOR_STATUS_FILE: paths.collectorStatusFile,
  ATAPE_COLLECTOR_LOG_FILE: paths.collectorLogFile, ATAPE_ADAPTER_DIRECTORY: paths.adapterDirectory })
const exists = (path: string) => lstat(path).catch(cause => { if (missing(cause)) return undefined; throw cause })
const regular = async (path: string, directory = false) => {
  const stat = await exists(path)
  if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail("binding", "Capture migration requires existing contained regular storage.")
}
const localInventory = async (paths: NodeClientPaths): Promise<ReadonlyArray<RegisteredJournalObservation>> => {
  const statePath = paths.collectorStateFile, root = `${statePath}.captures`, installationPath = `${statePath}.capture-installation.json`
  const installationStat = await exists(installationPath), stateStat = await exists(statePath)
  if (!installationStat) {
    if (await exists(root)) fail("binding", "Capture storage exists without its installation registry.")
    if (stateStat) strict(CollectorState, await readBoundedJSON(statePath, 4 * 1024 * 1024))
    return []
  }
  const installation = strict(CaptureInstallation, await readBoundedJSON(installationPath, 4096))
  if (!stateStat) fail("binding", "Collector state is missing while registered capture data exists.")
  const state = strict(CollectorState, await readBoundedJSON(statePath, 4 * 1024 * 1024))
  if (installation.installationId !== state.installationId || installation.accounts.length > 32 ||
    new Set(installation.accounts.map(account => account.key)).size !== installation.accounts.length) fail("binding", "Capture installation registry is inconsistent.")
  if (!await exists(root) && installation.phase === "initializing" && installation.accounts.length === 0) return []
  await regular(root, true)
  const inventory: RegisteredJournalObservation[] = []
  for (const account of [...installation.accounts].sort((a, b) => a.key.localeCompare(b.key))) {
    if (!/^[a-f0-9]{64}$/.test(account.key)) fail("binding", "Capture account registry key is invalid.")
    const path = join(root, `${account.key}.sqlite`), markerPath = join(root, `${account.key}.binding.json`)
    if (!await exists(markerPath)) {
      if (account.phase !== "initializing" || await exists(path) || await exists(`${path}-wal`) || await exists(`${path}-shm`))
        fail("binding", "Established capture account binding is missing.")
      inventory.push({ key: account.key, path, binding: null, installationId: installation.installationId,
        bindingHash: migrationHash({ key: account.key, installationId: installation.installationId }), format: 0, deferred: true })
      continue
    }
    const marker = strict(AccountBinding, await readBoundedJSON(markerPath, 4096))
    const binding = { instanceOrigin: marker.instanceOrigin, userId: marker.userId, installationId: marker.installationId }
    if (marker.installationId !== installation.installationId || account.key !== migrationHash([marker.instanceOrigin, marker.userId]) ||
      account.phase === "ready" && marker.phase !== "ready") fail("binding", "Capture account binding is inconsistent.")
    const db = await exists(path)
    if (!db && account.phase === "initializing" && marker.phase === "initializing") {
      if (await exists(`${path}-wal`) || await exists(`${path}-shm`)) fail("binding", "Initializing capture has orphaned SQLite storage.")
      inventory.push({ key: account.key, path, binding, installationId: installation.installationId, bindingHash: migrationHash(binding), format: 0, deferred: true })
    } else {
      await regular(path)
      inventory.push({ key: account.key, path, binding, installationId: installation.installationId, bindingHash: migrationHash(binding), format: await inspectCaptureJournalV7ToV8({ path, binding }), deferred: false })
    }
  }
  return inventory
}
const targetEntry = async (home: string, target: Selection) => {
  const entry = await createUpdateControl(home).resolveSelectionEntry(target, true)
  const manifest = await readBoundedJSON(join(dirname(dirname(entry)), "package.json")) as { atapeRuntime?: { captureMigrationProtocol?: unknown } }
  if (manifest.atapeRuntime?.captureMigrationProtocol !== captureMigrationProtocol) fail("unsupported", "The actual target does not implement the capture migration protocol.")
  return entry
}
const validatePlan = (bundle: Bundle, source: RuntimeContext["identity"], target: Selection) => {
  decodeMigrationReleaseBundle(bundle)
  if (bundle.migration.protocol !== captureMigrationProtocol || bundle.migration.id !== captureMigrationPlan ||
    !["atape.client.v3-capture.v1", "atape.client.v3-capture.v2"].includes(source.captureStateContract) ||
    !bundle.migration.fromCaptureStateContracts.includes(source.captureStateContract) || bundle.captureStateContract !== "atape.client.v3-capture.v2" ||
    bundle.version !== target.version || bundle.captureStateContract !== target.captureStateContract)
    fail("unsupported", "No compiled explicit capture migration plan supports this release path.")
}
const reportFor = (request: Request): CaptureMigrationPreflightReport => ({ protocol: "atape.capture-migration-preflight.v1", requestId: request.requestId,
  requestHash: migrationHash(request), bundleFingerprint: migrationBundleHash(request.bundle), migrationProtocol: captureMigrationProtocol,
  planId: captureMigrationPlan, source: request.source, actualTarget: { version: request.target.version, captureStateContract: request.target.captureStateContract },
  inventoryFingerprint: migrationHash(request.inventory), prerequisiteScopeFingerprint: request.prerequisiteScopeFingerprint, inventory: request.inventory })
const baseLedger = (required: CaptureMigrationRequired): CaptureMigrationLedger => ({ protocol: captureMigrationProtocol, required, phase: "authorized", progress: [] })
const receiptFor = (requirement: CaptureMigrationRequirement): CaptureMigrationReceipt => ({ protocol: "atape.capture-migration-receipt.v1",
  outerKey: requirement.outerKey, requirementHash: requirement.hash, bundleFingerprint: requirement.bundleFingerprint, planId: captureMigrationPlan,
  target: { version: requirement.target.version, captureStateContract: requirement.target.captureStateContract },
  accounts: requirement.inventory.map(account => ({ key: account.key, bindingHash: account.bindingHash, result: account.deferred ? "deferred-initialization" : "v8" })) })
const repairPair = async (home: string) => {
  const pair = await readCaptureMigrationPair(home)
  if (!pair.known) fail("conflict", "No capture migration requirement is pending.")
  if (!pair.required) await writeCaptureMigrationRequired(home, pair.known)
  if (!pair.ledger) await writeCaptureMigrationLedger(home, baseLedger(pair.known))
  return (await readCaptureMigrationPair(home)).ledger!
}

/** Promise Node Adapter at the actual process/filesystem boundary. Application
 * callers wrap it in their existing joined nodeEffect; no nested Effect runtime. */
export const createCaptureMigrationCoordinator = (paths: NodeClientPaths, environment: NodeJS.ProcessEnv = process.env) => {
  const actualSource = runtimeContext(paths.atapeHome)
  const proofs = new WeakMap<ValidatedCaptureMigration, Request>()
  const home = paths.atapeHome
  const pendingOuter = async () => {
    const pair = await readCaptureMigrationPair(home)
    if (!pair.known || pair.required && pair.ledger?.phase === "completed") return undefined
    return { key: pair.known.requirement.outerKey, target: pair.known.requirement.target, completed: pair.ledger?.phase === "completed" }
  }
  const receipt = async (outer: MigrationOuter): Promise<CaptureMigrationReceipt> => withCaptureMigrationBarrier(home, async () => {
    const pair = await readCaptureMigrationPair(home), boundary = await createUpdateControl(home).migrationBoundary(outer.key)
    if (!pair.known || pair.known.requirement.outerKey !== outer.key || !isDeepStrictEqual(pair.known.requirement.target, outer.target) ||
      pair.ledger?.phase !== "completed" || !pair.ledger.receipt || !boundary.forwardOnly || !isDeepStrictEqual(boundary.target, outer.target) ||
      !isDeepStrictEqual(boundary.selection, outer.target)) fail("conflict", "Capture migration has no exact completed receipt.")
    if (!pair.required) await writeCaptureMigrationRequired(home, pair.known)
    return pair.ledger.receipt
  })
  return {
    async preflight(input: { readonly bundle: Bundle; readonly target: Selection } & Scope, signal: AbortSignal): Promise<ValidatedCaptureMigration> {
      validatePlan(input.bundle, actualSource.identity, input.target)
      const canonical = await canonicalMigrationPaths(paths), entry = await targetEntry(canonical.atapeHome, input.target)
      const inventory = await localInventory(canonical), scope = await inspectCaptureMigrationPrerequisitesScope(canonical, input)
      const request: Request = { protocol: "atape.capture-migration-request.v1", requestId: randomUUID(), token: randomUUID(), paths: canonical,
        bundle: input.bundle, source: actualSource.identity, target: input.target, candidateConfig: input.candidateConfig, wanted: input.wanted,
        inventory, prerequisiteScopeFingerprint: scope.prerequisiteScopeFingerprint }
      const file = requestFile(home, request.requestId)
      assertMigrationMetadataBound(request, 4 * 1024 * 1024)
      await atomicJSON(file, request)
      try {
        const output = await executeOwnedProcess(process.execPath, [entry, "__capture-migration-preflight", request.requestId, request.token],
          childEnvironment(environment, canonical), signal, 20_000)
        const report = strict(Report, JSON.parse(output)), expected = reportFor(request)
        if (!isDeepStrictEqual(report, expected) || !isDeepStrictEqual(strict(Request, await readMigrationJSON(file, 4 * 1024 * 1024)), request))
          fail("conflict", "Target migration preflight response does not match its private request.")
        const proof = Object.freeze({ bundleFingerprint: expected.bundleFingerprint, source: request.source, target: expected.actualTarget,
          prerequisiteScopeFingerprint: scope.prerequisiteScopeFingerprint }) as ValidatedCaptureMigration
        proofs.set(proof, request)
        return proof
      } finally { await rm(file, { force: true }) }
    },
    async authorize(proof: ValidatedCaptureMigration, outer: MigrationOuter, current: Scope, signal: AbortSignal): Promise<void> {
      const validated = proofs.get(proof)
      if (!validated || signal.aborted || !isDeepStrictEqual(validated.target, outer.target)) fail("conflict", "Capture migration proof does not authorize this target.")
      const canonical = await canonicalMigrationPaths(paths), inventory = await localInventory(canonical)
      const scope = await inspectCaptureMigrationPrerequisitesScope(canonical, current)
      if (!isDeepStrictEqual(canonical, validated.paths) || !isDeepStrictEqual(inventory, validated.inventory) ||
        scope.prerequisiteScopeFingerprint !== validated.prerequisiteScopeFingerprint) fail("conflict", "Capture migration scope or inventory changed after preflight.")
      await withCaptureMigrationBarrier(home, async () => {
        const control = createUpdateControl(home), boundary = await control.migrationBoundary(outer.key), prior = await readCaptureMigrationPair(home)
        if (boundary.phase !== "prepared" || boundary.forwardOnly || !isDeepStrictEqual(boundary.target, outer.target)) fail("conflict", "Capture migration authorization requires its unfenced prepared runtime.")
        await control.assertRuntimeAdmission(validated.source)
        if (prior.known && (!prior.required || prior.ledger?.phase !== "completed" || !prior.ledger.receipt)) fail("conflict", "An earlier capture migration must recover first.")
        const body = { outerKey: outer.key, home: canonical.atapeHome, paths: canonical, bundle: validated.bundle, bundleFingerprint: proof.bundleFingerprint,
          source: validated.source, target: outer.target, inventory, prerequisiteScopeFingerprint: scope.prerequisiteScopeFingerprint }
        const requirement: CaptureMigrationRequirement = { ...body, hash: requirementHash(body) }
        const required: CaptureMigrationRequired = { protocol: "atape.capture-migration-required.v1", requirement,
          ...(prior.ledger?.receipt ? { priorCompleted: { requirement: prior.ledger.required.requirement, receipt: prior.ledger.receipt } } : {}) }
        // Reject before the first durable marker if any legitimate future phase
        // could exceed the reader's bound. Progress and final receipts are finite
        // and derivable from the admitted inventory, not unbounded child output.
        const plannedReceipt = receiptFor(requirement), base = baseLedger(required), plannedAttempt = {
          outerKey: outer.key, attemptId: randomUUID(), token: randomUUID(), bundleFingerprint: proof.bundleFingerprint, expiresAt: Number.MAX_SAFE_INTEGER }
        for (const shape of [required, base, { ...base, phase: "applying", attempt: plannedAttempt, progress: plannedReceipt.accounts },
          { ...base, phase: "completed", progress: plannedReceipt.accounts, receipt: plannedReceipt }]) assertMigrationMetadataBound(shape)
        await writeCaptureMigrationRequired(home, required)
        await writeCaptureMigrationLedger(home, baseLedger(required))
      })
    },
    async nextAttempt(outer: MigrationOuter): Promise<CaptureMigrationAttempt> {
      return withCaptureMigrationBarrier(home, async () => {
        const pair = await readCaptureMigrationPair(home), boundary = await createUpdateControl(home).migrationBoundary(outer.key)
        if (!pair.known || pair.known.requirement.outerKey !== outer.key || !boundary.forwardOnly || !isDeepStrictEqual(boundary.target, outer.target) ||
          !isDeepStrictEqual(boundary.selection, outer.target) || !isDeepStrictEqual(pair.known.requirement.target, outer.target))
          fail("conflict", "Capture migration recovery does not own its fenced target.")
        const ledger = await repairPair(home)
        if (ledger.phase === "completed") fail("conflict", "Capture migration already completed.")
        const attempt: CaptureMigrationAttempt = { outerKey: outer.key, attemptId: randomUUID(), token: randomUUID(), bundleFingerprint: ledger.required.requirement.bundleFingerprint }
        await writeCaptureMigrationLedger(home, { ...ledger, phase: "applying", attempt: { ...attempt, expiresAt: Date.now() + 20_000 } })
        return attempt
      })
    },
    async executeApply(attempt: CaptureMigrationAttempt, signal: AbortSignal): Promise<CaptureMigrationReceipt> {
      const pair = await readCaptureMigrationPair(home), requirement = pair.known?.requirement
      if (!requirement || requirement.outerKey !== attempt.outerKey || requirement.bundleFingerprint !== attempt.bundleFingerprint) fail("conflict", "Capture migration apply request changed.")
      const entry = await targetEntry(home, requirement.target), output = await executeOwnedProcess(process.execPath,
        [entry, "__capture-migration-apply", attempt.outerKey, attempt.attemptId, attempt.token, attempt.bundleFingerprint],
        childEnvironment(environment, requirement.paths), signal, 20_000)
      const reported = strict(CaptureMigrationReceipt, JSON.parse(output)), saved = await receipt({ key: attempt.outerKey, target: requirement.target })
      if (!isDeepStrictEqual(reported, saved)) fail("metadata", "Target migration response differs from its durable completed receipt.")
      return saved
    },
    receipt,
    async abandon(outer: MigrationOuter): Promise<void> {
      await withCaptureMigrationBarrier(home, async () => {
        const pair = await readCaptureMigrationPair(home)
        if (!pair.known || pair.known.requirement.outerKey !== outer.key && pair.required && pair.ledger?.phase === "completed") return
        const boundary = await createUpdateControl(home).migrationBoundary(outer.key)
        if (boundary.forwardOnly || !["recovering", "recovered"].includes(boundary.phase) || !isDeepStrictEqual(boundary.selection, boundary.baseline) ||
          !pair.known || pair.known.requirement.outerKey !== outer.key || !isDeepStrictEqual(pair.known.requirement.target, outer.target))
          fail("conflict", "Only a verified restored pre-fence migration may be abandoned.")
        const prior = pair.known.priorCompleted
        if (!prior) await removeCaptureMigrationPair(home)
        else {
          const required: CaptureMigrationRequired = { protocol: "atape.capture-migration-required.v1", requirement: prior.requirement }
          await writeCaptureMigrationLedger(home, { protocol: captureMigrationProtocol, required, phase: "completed", progress: prior.receipt.accounts, receipt: prior.receipt })
          await writeCaptureMigrationRequired(home, required)
        }
      })
    },
    pendingOuter,
    async repairCompletedRequirement(): Promise<boolean> {
      return withCaptureMigrationBarrier(home, async () => {
        const pair = await readCaptureMigrationPair(home)
        if (!pair.required && pair.ledger?.phase === "completed") { await writeCaptureMigrationRequired(home, pair.ledger.required); return true }
        return false
      })
    },
    async recoveryPending() { return (await pendingOuter()) !== undefined },
    async protectedSelections(): Promise<ReadonlyArray<Selection>> {
      const pair = await readCaptureMigrationPair(home)
      if (!pair.known || pair.required && pair.ledger?.phase === "completed") return []
      return [pair.known.requirement.target, ...(pair.known.priorCompleted ? [pair.known.priorCompleted.requirement.target] : [])]
    }
  }
}

export const preflightCaptureMigrationEntry = (context: RuntimeContext, input: CaptureMigrationPrivateRequest) => Effect.gen(function*() {
  const request = yield* Effect.tryPromise({ try: async () => strict(Request, await readMigrationJSON(requestFile(context.home, input.requestId), 4 * 1024 * 1024)), catch: migrationError })
  if (request.token !== input.token || request.requestId !== input.requestId || !isDeepStrictEqual(context.identity,
    { version: request.target.version, captureStateContract: request.target.captureStateContract })) return yield* migrationFailure("binding", "Migration preflight is not executing its exact requested target.")
  yield* Effect.tryPromise({ try: async () => {
    validatePlan(request.bundle, request.source, request.target)
    if (!isDeepStrictEqual(await canonicalMigrationPaths(defaultNodeClientPaths({ ...process.env, ATAPE_HOME: context.home })), request.paths))
      fail("binding", "Target migration paths do not match the private canonical request.")
    await targetEntry(context.home, request.target)
    if (!isDeepStrictEqual(await localInventory(request.paths), request.inventory)) fail("conflict", "Capture journal inventory changed during preflight.")
  }, catch: migrationError })
  const scope = yield* preflightCaptureMigrationPrerequisites(request.paths, request).pipe(Effect.mapError(() => migrationFailure("prerequisite", "Capture migration prerequisites are not satisfied.")))
  if (scope.prerequisiteScopeFingerprint !== request.prerequisiteScopeFingerprint) return yield* migrationFailure("conflict", "Capture migration prerequisites changed during preflight.")
  return reportFor(request)
})

export const applyCaptureMigrationEntry = (context: RuntimeContext, attempt: CaptureMigrationAttempt) => Effect.scoped(Effect.gen(function*() {
  const authority = yield* acquireCaptureMigrationWriteAuthority(context, attempt), requirement = yield* captureMigrationAuthorityRequirement(authority)
  yield* Effect.tryPromise({ try: async () => {
    if (!isDeepStrictEqual(await canonicalMigrationPaths(defaultNodeClientPaths({ ...process.env, ATAPE_HOME: context.home })), requirement.paths))
      fail("binding", "Migration apply paths changed from the authorized canonical home.")
    const inventory = await localInventory(requirement.paths)
    const immutable = (items: ReadonlyArray<RegisteredJournalObservation>) => items.map(({ format: _format, ...item }) => item)
    if (!isDeepStrictEqual(immutable(inventory), immutable(requirement.inventory))) fail("binding", "Migration apply inventory changed after authorization.")
  }, catch: migrationError })
  for (const account of requirement.inventory) {
    if (!account.deferred) {
      if (!account.binding) return yield* migrationFailure("binding", "Established migration journal has no bound account.")
      yield* Effect.scoped(migrateCaptureJournalV7ToV8({ path: account.path, binding: account.binding, runtime: context }, authority))
    }
    yield* guardCaptureMigrationWrite(authority, Effect.tryPromise({ try: async () => {
      const pair = await readCaptureMigrationPair(context.home), ledger = pair.ledger!
      const progress = { key: account.key, bindingHash: account.bindingHash, result: account.deferred ? "deferred-initialization" as const : "v8" as const }
      if (!ledger.progress.some(item => item.key === account.key)) await writeCaptureMigrationLedger(context.home, { ...ledger, progress: [...ledger.progress, progress] })
    }, catch: migrationError }), migrationError)
  }
  return yield* guardCaptureMigrationWrite(authority, Effect.tryPromise({ try: async () => {
    const ledger = (await readCaptureMigrationPair(context.home)).ledger!, receipt = receiptFor(requirement)
    await writeCaptureMigrationLedger(context.home, { protocol: captureMigrationProtocol, required: ledger.required, phase: "completed", progress: receipt.accounts, receipt })
    return receipt
  }, catch: migrationError }), migrationError)
}))
