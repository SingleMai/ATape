import { AdapterPackages, AutomaticUpdateError, AutomaticUpdatePlatform, automaticUpdatesEnabled,
  isNewerReleaseVersion, isStableReleaseVersion, officialSources } from "@atape/application"
import { AdapterInstallation, ClientConfig, emptyClientConfig, ReleaseBundle, decodeReleaseBundle, releaseBundleFingerprint, updateCatalogProtocol } from "@atape/domain"
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { isDeepStrictEqual } from "node:util"
import { performance } from "node:perf_hooks"
import { Effect, Layer, Schema } from "effect"
import type { NodeClientPaths } from "./clientPaths.ts"
import { createReleaseDiscovery } from "./releaseDiscovery.ts"
import { executeOwnedProcess } from "./ownedProcess.ts"
import { withCollectorMaintenance, isCollectorMaintenancePending } from "./collectorDaemonLayers.ts"
import { syncPackageTree } from "./adapterPackages.ts"
import { withClientConfigFileLock } from "./clientConfig.ts"
import { validateCollectorAdapters } from "./collectorReadiness.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { assertNoPendingManualStateUpgrade } from "./manualStateUpgrade.ts"
import { createUpdateControl, UpdateRuntimeSelection, updateControlProtocol,
  type UpdateControlTicket, type UpdateRuntimeSelection as ControlSelection } from "./updateControl.ts"
export { acquireUpdateWorker } from "./updateOwnership.ts"
import { RuntimeSelection, atomicJSON, decodeRuntimeSelection, managedStateContract, missing, readBoundedJSON,
  applyRuntimeSelection, readEffectiveRuntimeSelection, readRuntimeSelection, resolveRuntimeEntry, runtimeEntry, selectRuntime, selectedBootstrap, updateDirectory,
  type RuntimeSelection as Selection } from "./runtimeSelection.ts"

const Schedule = Schema.Struct({ nextCheckAt: Schema.Number, failures: Schema.Number,
  version: Schema.optionalKey(Schema.String), failure: Schema.optionalKey(Schema.String) })
const Pending = Schema.Struct({ next: RuntimeSelection, previous: Schema.optionalKey(RuntimeSelection) })
const Prepared = Schema.Struct({ bundle: ReleaseBundle, selection: RuntimeSelection, baseline: Schema.Array(AdapterInstallation),
  baselineSelection: Schema.optionalKey(Schema.Union([RuntimeSelection, UpdateRuntimeSelection])),
  controlEligible: Schema.optionalKey(Schema.Boolean), enabledAdapterIds: Schema.Array(Schema.String), hasGit: Schema.Boolean })
const pendingFile = (home: string) => join(updateDirectory(home), "pending.json")
const scheduleFile = (home: string) => join(updateDirectory(home), "state.json")
const retainedFile = (home: string) => join(updateDirectory(home), "retained.json")
const checkHandoffDeadline = (deadline: number) => {
  if (performance.now() >= deadline) throw new Error("Collector maintenance deadline expired before runtime selection.")
}

const updateError = (reason: AutomaticUpdateError["reason"], message: string) => new AutomaticUpdateError({ reason, message })
const nodeEffect = <A>(reason: AutomaticUpdateError["reason"], run: (signal: AbortSignal) => Promise<A>) =>
  Effect.callback<A, AutomaticUpdateError>(resume => {
    const cancellation = new AbortController()
    const task = Promise.resolve().then(() => run(cancellation.signal))
    task.then(value => resume(Effect.succeed(value)), cause => resume(Effect.fail(cause instanceof AutomaticUpdateError ? cause : updateError(reason,
      `ATape automatic update ${reason} failed. Inspect local update state and retry from ATape.`))))
    // Hold the worker/installation lifetime until owned subprocesses really exit.
    return Effect.promise(async () => { cancellation.abort(); await task.catch(() => {}) })
  })
const rawConfig = async (paths: NodeClientPaths): Promise<ClientConfig> => {
  try { return Schema.decodeUnknownSync(ClientConfig)(await readBoundedJSON(paths.configFile, 4 * 1024 * 1024)) }
  catch (cause) { if (missing(cause)) return emptyClientConfig(); throw cause }
}
const readOptional = async <A>(file: string, decode: (value: unknown) => A): Promise<A | undefined> => {
  try { return decode(await readBoundedJSON(file)) } catch (cause) { if (missing(cause)) return undefined; throw cause }
}
const sameInstallations = (a: ReadonlyArray<AdapterInstallation>, b: ReadonlyArray<AdapterInstallation>) => {
  const canonical = (items: ReadonlyArray<AdapterInstallation>) => [...items].sort((l, r) => l.adapterId.localeCompare(r.adapterId)).map(item =>
    [item.adapterId, item.packageName, item.packageSlot ?? null, item.upgradeSpec, item.displayName, item.version, item.installedAt, item.updatedAt])
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
const controlSelection = (selection: Selection | ControlSelection): ControlSelection => {
  if (selection.protocol === updateControlProtocol) return selection
  if (!selection.bootstrapIdentity) throw new Error("Independent update control requires a durable bootstrap identity.")
  return { protocol: updateControlProtocol, version: selection.version, captureStateContract: selection.stateContract,
    bootstrapEntry: selection.bootstrapEntry, bootstrapIdentity: selection.bootstrapIdentity, adapters: selection.adapters }
}
const controlCapable = async (entry: string) => {
  const manifest = await readBoundedJSON(join(dirname(dirname(entry)), "package.json")) as {
    atapeRuntime?: { updateControlProtocol?: unknown }
  }
  return manifest.atapeRuntime?.updateControlProtocol === updateControlProtocol
}

export const recoverPendingUpdate = async (paths: NodeClientPaths, bootstrap: string, environment: NodeJS.ProcessEnv) => {
  await assertNoPendingManualStateUpgrade(paths)
  const control = createUpdateControl(paths.atapeHome)
  const pending = await readOptional(pendingFile(paths.atapeHome), Schema.decodeUnknownSync(Pending))
  const controlPending = await control.recoveryPending()
  if (!pending && !controlPending && !(await isCollectorMaintenancePending(paths.collectorProcessFile))) return
  const restore = (deadline: number) => withClientConfigFileLock(paths.configFile, async () => {
    checkHandoffDeadline(deadline)
    // A later explicit selection wins over an interrupted older transaction.
    if (pending && isDeepStrictEqual(await readRuntimeSelection(paths.atapeHome), pending.next)) {
      checkHandoffDeadline(deadline)
      await selectRuntime(paths.atapeHome, pending.previous)
    }
    // Resolve the historical namespace before independent selection/readiness.
    // The durable maintenance gate still owns recovery if readiness later fails.
    if (pending) await rm(pendingFile(paths.atapeHome), { force: true })
    checkHandoffDeadline(deadline)
    if (controlPending) {
      const replacement = await control.bootstrapReplacementSelection()
      if (replacement) {
        // A supported manual replacement materializes this overlay before npm.
        // Repeat conditionally for an external replacement or interrupted call,
        // before the rebound bootstrap selects its own Adapter-free descriptor.
        const raw = await rawConfig(paths), effective = applyRuntimeSelection(raw, replacement)
        if (!sameInstallations(raw.adapters, effective.adapters)) await atomicJSON(paths.configFile, { ...raw, adapters: effective.adapters })
      }
      checkHandoffDeadline(deadline)
      await control.recoverSelection()
    }
  }, Math.max(0, Math.min(5_000, deadline - performance.now())))
  await withCollectorMaintenance(paths, () => resolveRuntimeEntry(paths.atapeHome, bootstrap), environment, restore,
    { recover: (_, deadline) => restore(deadline) })
  if (controlPending) await control.completeRecovery()
  await rm(pendingFile(paths.atapeHome), { force: true })
}

export const needsUpdateRecovery = async (paths: NodeClientPaths) =>
  (await readOptional(pendingFile(paths.atapeHome), Schema.decodeUnknownSync(Pending))) !== undefined ||
  await createUpdateControl(paths.atapeHome).recoveryPending() || isCollectorMaintenancePending(paths.collectorProcessFile)

export const protectedRuntimeSlots = async (home: string): Promise<ReadonlyArray<string>> => {
  const selections: (Selection | ControlSelection)[] = []
  const current = await readEffectiveRuntimeSelection(home)
  if (current) selections.push(current)
  const retained = await readOptional(retainedFile(home), decodeRuntimeSelection)
  if (retained) selections.push(retained)
  const pending = await readOptional(pendingFile(home), Schema.decodeUnknownSync(Pending))
  if (pending) selections.push(pending.next, ...(pending.previous ? [pending.previous] : []))
  selections.push(...await createUpdateControl(home).protectedSelections())
  return [...new Set(selections.flatMap(selection => selection.adapters.flatMap(pair =>
    [pair.before.packageSlot, pair.after.packageSlot].filter((slot): slot is string => slot !== undefined))))]
}

export const makeAutomaticUpdatePlatformLayer = (paths: NodeClientPaths, entryFile: string, currentVersion: string,
  environment: NodeJS.ProcessEnv = process.env, fetchMetadata: typeof fetch = globalThis.fetch) => {
  const discovery = createReleaseDiscovery({ home: paths.atapeHome, runtimeVersion: currentVersion,
    captureStateContract: managedStateContract, updateControlProtocol, fetchMetadata })
  let ownership: Promise<string | undefined> | undefined
  const bootstrap = () => {
    // Deduplicate concurrent probes only. npm/path failures and changes in
    // global ownership must be observed again by the next Collector tick.
    if (ownership) return ownership
    const probe = (async () => {
      if (process.platform === "win32" || !isStableReleaseVersion(currentVersion)) return undefined
      const original = await selectedBootstrap(paths.atapeHome, environment.ATAPE_BOOTSTRAP_ENTRY ?? entryFile)
      const root = (await executeOwnedProcess("npm", ["root", "--global"], environment, AbortSignal.timeout(10_000), 10_000)).trim()
      const installed = await realpath(join(root, "@atape", "cli", "dist", "atape.js"))
      if (await realpath(original) !== installed) return undefined
      return installed
    })()
    ownership = probe
    void probe.finally(() => { if (ownership === probe) ownership = undefined }).catch(() => {})
    return probe
  }

  return Layer.effect(AutomaticUpdatePlatform, Effect.gen(function*() {
    const packages = yield* AdapterPackages
    return AutomaticUpdatePlatform.of({
      recoveryPending: () => nodeEffect("state", () => needsUpdateRecovery(paths)),
      supported: () => nodeEffect("unsupported", async () => (await bootstrap()) !== undefined),
      schedule: () => nodeEffect("state", async () => (await readOptional(scheduleFile(paths.atapeHome), Schema.decodeUnknownSync(Schedule))) ?? { nextCheckAt: 0, failures: 0 }),
      target: () => nodeEffect("release", signal => discovery.latest({ cached: false, signal })),
      record: input => nodeEffect("state", () => atomicJSON(scheduleFile(paths.atapeHome), input)),
      prepare: (bundle, adapters) => Effect.gen(function*() {
        const requested = yield* nodeEffect("release", async () => decodeReleaseBundle(bundle))
        const version = requested.version
        yield* nodeEffect("state", async () => {
          await assertNoPendingManualStateUpgrade(paths)
          if (await needsUpdateRecovery(paths)) throw new Error("Interrupted update work must recover before preparing another release.")
        })
        const original = yield* nodeEffect("unsupported", async () => {
          const original = await bootstrap()
          if (!original) throw new Error("This CLI installation is not managed by npm global.")
          return original
        })
        const installedBootstrap = yield* nodeEffect("prepare", async () => {
          const installed = await bootstrapSelection(original)
          requireForwardUpdate(version, installed.version, "prepare")
          return installed
        })
        const snapshot = yield* nodeEffect("state", () => withClientConfigFileLock(paths.configFile, async () => {
          const raw = await rawConfig(paths)
          const selection = await readEffectiveRuntimeSelection(paths.atapeHome)
          if (selection) requireForwardUpdate(version, selection.version, "prepare")
          const effective = applyRuntimeSelection(raw, selection)
          const eligible = effective.adapters.filter(adapter => adapter.upgradeSpec === adapter.packageName &&
            officialSources.some(source => source.id === adapter.adapterId && source.packageName === adapter.packageName))
          if (!sameInstallations(eligible, adapters)) throw new Error("Adapter installations changed after update planning.")
          return { config: raw, selection }
        }))
        const selectedBundle = yield* nodeEffect("release", async signal => {
          const advertised = await discovery.exact({ version, signal })
          if (releaseBundleFingerprint(requested) !== releaseBundleFingerprint(advertised)) {
            throw new Error("The selected immutable release bundle changed before preparation.")
          }
          return advertised
        })
        const baseline = snapshot.config
        yield* nodeEffect("prepare", signal => prepareBootstrapSnapshot(paths, original, environment, signal))
        yield* nodeEffect("prepare", async signal => {
          const artifact = await discovery.acquireArtifact(selectedBundle, "@atape/cli", signal)
          try { await prepareCLI(paths, selectedBundle, artifact.path, environment, signal) }
          finally { await artifact.release() }
        })
        const replacements: Selection["adapters"][number][] = []
        for (const adapter of adapters) {
          const installed = yield* packages.install(`${adapter.packageName}@${version}`).pipe(
            Effect.mapError(() => updateError("prepare", "Could not prepare an official Adapter for the selected release.")))
          if (installed.version !== version || installed.packageName !== adapter.packageName || installed.manifest.adapterId !== adapter.adapterId || installed.packageSlot === undefined) {
            return yield* updateError("prepare", "An official Adapter does not match the selected release.")
          }
          const before = baseline.adapters.find(item => item.adapterId === adapter.adapterId)
          if (!before || before.packageName !== adapter.packageName || before.upgradeSpec !== adapter.packageName) {
            return yield* updateError("prepare", "Adapter source changed while preparing the update.")
          }
          replacements.push({ before, after: { ...adapter, packageSlot: installed.packageSlot,
            version, updatedAt: new Date().toISOString() } })
        }
        const key = randomUUID()
        const selection: Selection = { protocol: "atape.runtime.v1", stateContract: managedStateContract,
          version, bootstrapEntry: original, adapters: replacements,
          bootstrapIdentity: installedBootstrap.bootstrapIdentity }
        const candidateConfig = { ...baseline, adapters: baseline.adapters.map(adapter =>
          replacements.find(pair => pair.before.adapterId === adapter.adapterId)?.after ?? adapter),
          enabledAdapterIds: [...new Set([...baseline.enabledAdapterIds, ...replacements.map(pair => pair.after.adapterId)])] }
        yield* validateCollectorAdapters(paths, candidateConfig).pipe(
          Effect.mapError(() => updateError("prepare", "The prepared Adapter runtime could not be loaded locally.")))
        const controlEligible = yield* nodeEffect("prepare", async () => {
          const targetCapable = await controlCapable(runtimeEntry(paths.atapeHome, version))
          if (snapshot.selection?.protocol === updateControlProtocol && !targetCapable) {
            throw new Error("An independent update cannot return to a legacy-only package.")
          }
          const bridge = snapshot.selection ? runtimeEntry(paths.atapeHome, snapshot.selection.version) : original
          return targetCapable && await controlCapable(bridge)
        })
        yield* nodeEffect("prepare", () => atomicJSON(join(updateDirectory(paths.atapeHome), `${key}.prepared.json`), {
          bundle: selectedBundle, selection: decodeRuntimeSelection(selection), baseline: baseline.adapters,
          ...(snapshot.selection ? { baselineSelection: snapshot.selection } : {}),
          ...(controlEligible ? { controlEligible: true } : {}),
          enabledAdapterIds: baseline.enabledAdapterIds, hasGit: baseline.projects.some(project => project.type === "git")
        }))
        return { bundle: selectedBundle, key }
      }),
      activate: (prepared, automatic) => nodeEffect("handoff", async signal => {
        await assertNoPendingManualStateUpgrade(paths)
        if (!/^[0-9a-f-]{36}$/.test(prepared.key)) throw new Error("Invalid prepared update key.")
        const candidate = Schema.decodeUnknownSync(Prepared)(await readBoundedJSON(join(updateDirectory(paths.atapeHome), `${prepared.key}.prepared.json`)))
        const requested = decodeReleaseBundle(prepared.bundle)
        if (candidate.selection.version !== requested.version ||
          releaseBundleFingerprint(candidate.bundle) !== releaseBundleFingerprint(requested)) {
          throw new Error("Prepared immutable release bundle changed.")
        }
        await validateCLI(join(paths.atapeHome, "releases", requested.version), requested.version, environment, signal, requested)
        const original = await bootstrap()
        if (!original) throw new Error("The bootstrap installation changed.")
        const installedBootstrap = await bootstrapSelection(original)
        requireForwardUpdate(prepared.bundle.version, installedBootstrap.version, "handoff")
        if (installedBootstrap.bootstrapIdentity !== candidate.selection.bootstrapIdentity) {
          throw new Error("The npm bootstrap was replaced while preparing the update.")
        }
        const control = candidate.controlEligible ? createUpdateControl(paths.atapeHome) : undefined
        let ticket: UpdateControlTicket | undefined
        if (control && await readOptional(pendingFile(paths.atapeHome), Schema.decodeUnknownSync(Pending))) {
          throw new Error("A historical update must recover before independent activation.")
        }
        if (control && await control.recoveryPending()) throw new Error("An interrupted independent update must recover before activation.")
        const previous = await readRuntimeSelection(paths.atapeHome) ?? installedBootstrap
        if (!control) await atomicJSON(pendingFile(paths.atapeHome), { next: candidate.selection, previous })
        const restore = (deadline: number) => withClientConfigFileLock(paths.configFile, async () => {
          checkHandoffDeadline(deadline)
          if (control) {
            if (await control.recoveryPending()) await control.recoverSelection()
            return
          }
          if (isDeepStrictEqual(await readRuntimeSelection(paths.atapeHome), candidate.selection)) {
            checkHandoffDeadline(deadline)
            await selectRuntime(paths.atapeHome, previous)
          }
        }, Math.max(0, Math.min(5_000, deadline - performance.now())))
        try { await withCollectorMaintenance(paths, () => resolveRuntimeEntry(paths.atapeHome, original), environment, async deadline => {
          await withClientConfigFileLock(paths.configFile, async () => {
            checkHandoffDeadline(deadline)
            const config = await rawConfig(paths)
            if (!config.toolsConfigured) throw new Error("Tools were disconnected before activation.")
            if (!isDeepStrictEqual(await readEffectiveRuntimeSelection(paths.atapeHome), candidate.baselineSelection)) {
              throw new Error("The managed runtime changed before activation.")
            }
            if (automatic && !automaticUpdatesEnabled(config)) throw new Error("Automatic updates were disabled before activation.")
            if (!sameInstallations(config.adapters, candidate.baseline)) throw new Error("Adapter installations changed before activation.")
            if (JSON.stringify([...config.enabledAdapterIds].sort()) !== JSON.stringify([...candidate.enabledAdapterIds].sort()) ||
              config.projects.some(project => project.type === "git") !== candidate.hasGit) throw new Error("Collection scope changed before activation.")
            const installed = await bootstrapSelection(original)
            requireForwardUpdate(prepared.bundle.version, installed.version, "handoff")
            if (installed.bootstrapIdentity !== candidate.selection.bootstrapIdentity) {
              throw new Error("The npm bootstrap was replaced while preparing the update.")
            }
            const targetCapable = await controlCapable(runtimeEntry(paths.atapeHome, prepared.bundle.version))
            const bridgeCapable = await controlCapable(await resolveRuntimeEntry(paths.atapeHome, original))
            if (Boolean(control) !== (targetCapable && bridgeCapable) ||
              candidate.baselineSelection?.protocol === updateControlProtocol && !control) {
              throw new Error("The update-control capability changed before activation.")
            }
            checkHandoffDeadline(deadline)
            if (control) {
              // The durable transaction begins only after quiescence and the
              // last policy, configuration and ownership checks. Preparation
              // outside this handoff never closes collection admission.
              ticket = await control.prepare({ next: controlSelection(candidate.selection),
                previous: controlSelection(candidate.baselineSelection ?? installedBootstrap) })
              checkHandoffDeadline(deadline)
              await control.begin(ticket)
            } else {
              await atomicJSON(retainedFile(paths.atapeHome), previous)
              checkHandoffDeadline(deadline)
              await selectRuntime(paths.atapeHome, decodeRuntimeSelection(candidate.selection))
            }
          }, Math.max(0, Math.min(5_000, deadline - performance.now())))
        }, { recover: (_, deadline) => restore(deadline) }) } catch (cause) {
          // A completed rollback (or rejection before commit) must not trigger
          // another handoff. Preserve uncertain or still-gated recovery state.
          await withClientConfigFileLock(paths.configFile, async () => {
            if (await isCollectorMaintenancePending(paths.collectorProcessFile)) return
            if (control) { await control.completeRecovery(); return }
            const pending = await readOptional(pendingFile(paths.atapeHome), Schema.decodeUnknownSync(Pending))
            if (isDeepStrictEqual(pending?.next, candidate.selection) &&
              !isDeepStrictEqual(await readRuntimeSelection(paths.atapeHome), candidate.selection)) {
              await rm(pendingFile(paths.atapeHome), { force: true })
            }
          }).catch(() => {})
          throw cause
        }
        if (control) {
          if (!ticket) throw new Error("The independent update did not begin its durable transaction.")
          await control.complete(ticket)
        } else await rm(pendingFile(paths.atapeHome), { force: true })
        await rm(join(updateDirectory(paths.atapeHome), `${prepared.key}.prepared.json`), { force: true })
      }),
      launch: () => nodeEffect("state", async () => {
        if (!(await needsUpdateRecovery(paths))) {
          const schedule = await readOptional(scheduleFile(paths.atapeHome), Schema.decodeUnknownSync(Schedule))
          if (schedule && Date.now() < schedule.nextCheckAt) return
        }
        const original = await bootstrap()
        if (!original) return
        const release = await acquireUpdateWorker(paths.atapeHome)
        if (!release) return
        // Release before spawning: the child owns its lifetime independently.
        // Simultaneous dispatches are harmless; only one child acquires the lock.
        release()
        const token = randomUUID()
        const worker = join(updateDirectory(paths.atapeHome), "workers", `${token}.mjs`)
        await mkdir(dirname(worker), { recursive: true, mode: 0o700 })
        await copyFile(await resolveRuntimeEntry(paths.atapeHome, original), worker)
        const handle = await open(worker, "r")
        try { await handle.sync() } finally { await handle.close() }
        await mkdir(dirname(paths.collectorLogFile), { recursive: true, mode: 0o700 })
        const log = await open(paths.collectorLogFile, "a", 0o600)
        try {
          const child = spawn(process.execPath, [worker, "__automatic-update", "--update-token", token], {
            detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...environment,
              ATAPE_BOOTSTRAP_ENTRY: original, ATAPE_UPDATE_WORKER_TOKEN: token, ATAPE_RUNTIME_DIRECT: "1" }
          })
          await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
          child.unref()
        } finally { await log.close() }
      })
    })
  }))
}

const bootstrapSelection = async (original: string): Promise<Selection & { readonly bootstrapIdentity: string }> => {
  const manifest = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.Literal("@atape/cli"), version: Schema.String,
    atapeRuntime: Schema.Struct({ protocol: Schema.Literal("atape.runtime.v1"), stateContract: Schema.Literal(managedStateContract) })
  }))(await readBoundedJSON(join(dirname(dirname(original)), "package.json")))
  if (!isStableReleaseVersion(manifest.version)) throw new Error("The installed npm bootstrap must have a stable release version.")
  return { protocol: "atape.runtime.v1", stateContract: managedStateContract, version: manifest.version,
    bootstrapEntry: original, bootstrapIdentity: createHash("sha256").update(await readFile(original)).digest("hex"), adapters: [] }
}

const requireForwardUpdate = (target: string, installed: string, reason: "prepare" | "handoff") => {
  if (!isStableReleaseVersion(target) || isNewerReleaseVersion(installed, target)) {
    throw updateError(reason, "The selected release would downgrade the installed CLI. Retry from the current installation.")
  }
}

// The first fallback is a separately durable copy too. The npm entry remains
// launch ownership, never the sole surviving copy of a runnable old generation.
const prepareBootstrapSnapshot = async (paths: NodeClientPaths, original: string, environment: NodeJS.ProcessEnv, signal: AbortSignal) => {
  const selection = await bootstrapSelection(original)
  const destination = join(paths.atapeHome, "releases", selection.version)
  if (await lstat(destination).then(() => true, cause => { if (missing(cause)) return false; throw cause })) {
    await validateCLI(destination, selection.version, environment, signal)
    const retained = join(destination, "node_modules", "@atape", "cli")
    if (!(await readFile(join(retained, "dist", "atape.js"))).equals(await readFile(original)) ||
      !(await readFile(join(retained, "package.json"))).equals(await readFile(join(dirname(dirname(original)), "package.json")))) {
      throw new Error("The retained bootstrap generation conflicts with the actual npm bootstrap bytes.")
    }
    return
  }
  const staging = join(paths.atapeHome, "releases", `.bootstrap-${randomUUID()}`)
  const root = join(staging, "node_modules", "@atape", "cli")
  await mkdir(join(root, "dist"), { recursive: true, mode: 0o700 })
  try {
    await copyFile(original, join(root, "dist", "atape.js"))
    await copyFile(join(dirname(dirname(original)), "package.json"), join(root, "package.json"))
    await validateCLI(staging, selection.version, environment, signal)
    await syncPackageTree(staging)
    await rename(staging, destination)
    const directory = await open(dirname(destination), "r")
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

const prepareCLI = async (paths: NodeClientPaths, bundle: ReleaseBundle, artifact: string, environment: NodeJS.ProcessEnv, signal: AbortSignal) => {
  const version = bundle.version
  const destination = join(paths.atapeHome, "releases", version)
  const staging = join(paths.atapeHome, "releases", `.${version}-${randomUUID()}`)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  try {
    await writeFile(join(staging, "package.json"), JSON.stringify({ private: true }), { mode: 0o600, flag: "wx" })
    await executeOwnedProcess("npm", ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--engine-strict",
      "--registry=https://registry.npmjs.org/", "--@atape:registry=https://registry.npmjs.org/", "--prefix", staging, artifact], environment, signal, 180_000)
    await validateCLI(staging, version, environment, signal, bundle)
    if (await lstat(destination).then(() => true, cause => { if (missing(cause)) return false; throw cause })) {
      await validateCLI(destination, version, environment, signal, bundle)
      const root = (directory: string) => join(directory, "node_modules", "@atape", "cli")
      for (const file of ["package.json", join("dist", "atape.js")]) {
        if (!(await readFile(join(root(staging), file))).equals(await readFile(join(root(destination), file)))) {
          throw new Error("The existing immutable generation conflicts with the verified release archive.")
        }
      }
      return
    }
    await syncPackageTree(staging)
    await rename(staging, destination)
    const directory = await open(dirname(destination), "r")
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

const validateCLI = async (directory: string, version: string, environment: NodeJS.ProcessEnv, signal: AbortSignal, bundle?: ReleaseBundle) => {
  const root = join(directory, "node_modules", "@atape", "cli")
  const manifest = await readBoundedJSON(join(root, "package.json")) as Record<string, unknown>
  const contract = manifest.atapeRuntime as { protocol?: unknown; stateContract?: unknown; updateControlProtocol?: unknown; releaseCatalogProtocol?: unknown } | undefined
  if (manifest.name !== "@atape/cli" || manifest.version !== version ||
    contract?.protocol !== "atape.runtime.v1" || contract.stateContract !== managedStateContract ||
    bundle && (contract.updateControlProtocol !== bundle.updateControlProtocol || contract.releaseCatalogProtocol !== updateCatalogProtocol)) {
    throw new Error("The selected CLI does not support compatible managed state.")
  }
  const output = await executeOwnedProcess(process.execPath, [join(root, "dist", "atape.js"), "--version"],
    { ...environment, ATAPE_RUNTIME_DIRECT: "1" }, signal, 15_000)
  if (output.trim() !== `ATape ${version}`) throw new Error("Prepared CLI version verification failed.")
}
