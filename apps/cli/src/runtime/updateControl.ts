import { officialSources } from "@atape/application"
import { AdapterInstallation } from "@atape/domain"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { atomicJSON, missing, readBoundedJSON, runtimeEntry, updateDirectory } from "./runtimeFiles.ts"
import { executeOwnedProcess } from "./ownedProcess.ts"
import { syncPackageTree } from "./adapterPackages.ts"
import { acquireProcessLock } from "./processLock.ts"

export const updateControlProtocol = "atape.update-control.v1" as const
const StableVersion = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/))
const Contract = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/))
const Identity = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export const UpdateRuntimeSelection = Schema.Struct({
  protocol: Schema.Literal(updateControlProtocol),
  version: StableVersion,
  captureStateContract: Contract,
  bootstrapEntry: Schema.String,
  bootstrapIdentity: Identity,
  adapters: Schema.Array(Schema.Struct({ before: AdapterInstallation, after: AdapterInstallation }))
})
export type UpdateRuntimeSelection = typeof UpdateRuntimeSelection.Type
export class UpdateControlError extends Schema.TaggedError<UpdateControlError>()("UpdateControlError", {
  reason: Schema.Literals(["metadata", "conflict", "admission", "generation"]),
  message: Schema.String
}) {}
export type UpdateControlTicket = { readonly key: string }
export type UpdateRuntimeAdmission = { readonly version: string; readonly captureStateContract: string }
const Floor = Schema.Struct({ minimumRuntimeVersion: StableVersion, captureStateContract: Contract })
const Control = Schema.Struct({
  protocol: Schema.Literal(updateControlProtocol),
  key: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
  phase: Schema.Literals(["prepared", "begun", "fenced", "recovering", "completed", "recovered"]),
  baseline: Schema.optionalKey(UpdateRuntimeSelection),
  previous: Schema.optionalKey(UpdateRuntimeSelection),
  target: UpdateRuntimeSelection,
  floor: Schema.optionalKey(Floor),
  forwardOnly: Schema.Boolean
})
type Control = typeof Control.Type
const fail = (reason: UpdateControlError["reason"], message: string): never => { throw new UpdateControlError({ reason, message }) }
const version = (value: string) => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || value.length >= 40 ||
    !value.split(".").every(part => Number.isSafeInteger(Number(part)))) fail("metadata", "Invalid update runtime version.")
  return value.split(".").map(Number)
}
const older = (left: string, right: string) => {
  const a = version(left), b = version(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
  return false
}
export const decodeUpdateRuntimeSelection = (value: unknown): UpdateRuntimeSelection => {
  try {
    const selected = Schema.decodeUnknownSync(UpdateRuntimeSelection)(value)
    version(selected.version)
    if (!isAbsolute(selected.bootstrapEntry)) fail("metadata", "The update bootstrap must be absolute.")
    const ids = new Set<string>()
    for (const { before, after } of selected.adapters) {
      if (ids.has(after.adapterId) || !officialSources.some(source => source.id === after.adapterId && source.packageName === after.packageName) ||
        before.adapterId !== after.adapterId || before.packageName !== after.packageName || before.upgradeSpec !== before.packageName ||
        after.upgradeSpec !== after.packageName || after.version !== selected.version || after.packageSlot === undefined || before.installedAt !== after.installedAt)
        fail("metadata", "Invalid update Adapter generation.")
      ids.add(after.adapterId)
    }
    return selected
  } catch (cause) {
    if (cause instanceof UpdateControlError) throw cause
    return fail("metadata", "Invalid update runtime selection.")
  }
}
const decodeControl = (value: unknown): Control => {
  try {
    const control = Schema.decodeUnknownSync(Control)(value)
    decodeUpdateRuntimeSelection(control.target)
    if (control.baseline) decodeUpdateRuntimeSelection(control.baseline)
    if (control.previous) decodeUpdateRuntimeSelection(control.previous)
    if (control.baseline && !isDeepStrictEqual(control.baseline, control.previous))
      fail("metadata", "The recorded fallback differs from the original runtime selection.")
    if (control.floor) {
      version(control.floor.minimumRuntimeVersion)
      if (older(control.target.version, control.floor.minimumRuntimeVersion)) fail("metadata", "Update recovery target is below its reader floor.")
    }
    if (control.forwardOnly && (!control.floor || control.floor.captureStateContract !== control.target.captureStateContract ||
      control.floor.minimumRuntimeVersion !== control.target.version || control.phase === "prepared" || control.phase === "begun"))
      fail("metadata", "Invalid forward-only update boundary.")
    if (control.phase === "fenced" && !control.forwardOnly) fail("metadata", "Missing forward-only update boundary.")
    if (control.phase === "completed" && !control.forwardOnly && control.previous &&
      control.previous.captureStateContract !== control.target.captureStateContract)
      fail("metadata", "An incompatible update completed without a recovery boundary.")
    return control
  } catch (cause) {
    if (cause instanceof UpdateControlError) throw cause
    return fail("metadata", "Invalid durable update control state.")
  }
}
const optionalJSON = async <A>(path: string, decode: (value: unknown) => A): Promise<A | undefined> => {
  try { return decode(await readBoundedJSON(path)) } catch (cause) {
    if (missing(cause)) return undefined
    if (cause instanceof UpdateControlError) throw cause
    return fail("metadata", "Could not read durable update metadata.")
  }
}
const accepts = (floor: typeof Floor.Type | undefined, runtime: UpdateRuntimeAdmission) =>
  !floor || !older(runtime.version, floor.minimumRuntimeVersion) && runtime.captureStateContract === floor.captureStateContract

/** Node update-control Interface. The caller holds ATape's update ownership for
 * every control-ledger/selection mutation, including recovery, and quiesces the Collector before begin.
 * This Module never starts a Collector or interprets capture data. Its only
 * subprocess is a bounded direct version probe when rebinding npm. A fence must
 * finish before any incompatible target executable or migration is admitted.
 * Atomic file and directory syncs are joined; failed writes leave durable work
 * for recoverSelection rather than allowing the caller to infer completion. */
export const createUpdateControl = (home: string) => {
  const pointerFile = join(updateDirectory(home), "runtime.json")
  const controlFile = join(updateDirectory(home), "control.json")
  const readSelection = () => optionalJSON(pointerFile, decodeUpdateRuntimeSelection)
  const readControl = () => optionalJSON(controlFile, decodeControl)
  const writeControl = (control: Control) => atomicJSON(controlFile, decodeControl(control))
  const acquireRuntimeWriteBarrier = async (waitMs = 5_000): Promise<() => void> => {
    const release = await acquireProcessLock(join(updateDirectory(home), "admission.lock.sqlite"), waitMs)
    return release ?? fail("conflict", "Another local runtime write or reader-floor change is in progress.")
  }
  const assertRuntimeAdmission = async (runtime: UpdateRuntimeAdmission): Promise<void> => {
    version(runtime.version)
    try { Schema.decodeUnknownSync(Contract)(runtime.captureStateContract) } catch { fail("admission", "Invalid runtime capture contract.") }
    const control = await readControl()
    if (!control) return
    if (!accepts(control.floor, runtime)) fail("admission", "This runtime is below the durable recovery boundary.")
    const previous = !control.forwardOnly && control.phase !== "completed" ? control.previous : undefined
    const contract = previous?.captureStateContract ?? control.target.captureStateContract
    if (runtime.captureStateContract !== contract)
      fail("admission", "This runtime does not support the admitted capture contract.")
  }
  const writeSelection = async (selection: UpdateRuntimeSelection | undefined) => {
    if (selection) await atomicJSON(pointerFile, decodeUpdateRuntimeSelection(selection))
    else {
      await rm(pointerFile, { force: true })
      const directory = await open(updateDirectory(home), "r")
      try { await directory.sync() } finally { await directory.close() }
    }
  }
  const transaction = async (ticket: UpdateControlTicket) => {
    const control = await readControl()
    if (!control || control.key !== ticket.key) fail("conflict", "The prepared update no longer owns this transaction.")
    return control!
  }
  const unchanged = async (allowed: ReadonlyArray<UpdateRuntimeSelection | undefined>) => {
    const current = await readSelection()
    if (!allowed.some(selection => isDeepStrictEqual(selection, current)))
      fail("conflict", "A later runtime selection superseded this update.")
    return current
  }
  const validateGeneration = async (selected: UpdateRuntimeSelection, capable = false): Promise<string> => {
    try {
      const canonicalHome = await realpath(home), releases = join(canonicalHome, "releases")
      if (await realpath(releases) !== releases) fail("generation", "Update releases must remain inside ATAPE_HOME.")
      const generation = join(releases, selected.version)
      if ((await lstat(generation)).isSymbolicLink() || await realpath(generation) !== generation)
        fail("generation", "The recovery generation must be a real directory.")
      let path = generation
      for (const component of ["node_modules", "@atape", "cli", "dist", "atape.js"]) {
        path = join(path, component)
        const entry = await realpath(path), within = relative(generation, entry)
        if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) fail("generation", "The recovery executable escapes its generation.")
      }
      if (!(await lstat(runtimeEntry(canonicalHome, selected.version))).isFile()) fail("generation", "The recovery executable is not a regular file.")
      const manifest = await readBoundedJSON(join(dirname(dirname(runtimeEntry(canonicalHome, selected.version))), "package.json")) as {
        name?: unknown; version?: unknown; atapeRuntime?: { stateContract?: unknown; captureStateContract?: unknown; updateControlProtocol?: unknown }
      }
      if (manifest.name !== "@atape/cli" || manifest.version !== selected.version ||
        (manifest.atapeRuntime?.captureStateContract ?? manifest.atapeRuntime?.stateContract) !== selected.captureStateContract)
        fail("generation", "The recovery package does not declare its selected capture contract.")
      if (capable && manifest.atapeRuntime?.updateControlProtocol !== updateControlProtocol)
        fail("generation", "The target package does not support independent update control.")
      const identity = createHash("sha256").update(await readFile(selected.bootstrapEntry)).digest("hex")
      if (identity !== selected.bootstrapIdentity) fail("generation", "The update bootstrap identity changed.")
      return runtimeEntry(canonicalHome, selected.version)
    } catch (cause) {
      if (cause instanceof UpdateControlError) throw cause
      return fail("generation", "The recovery runtime is unavailable or invalid.")
    }
  }
  const bootstrapChanged = async (selected: UpdateRuntimeSelection): Promise<boolean> => {
    try { return createHash("sha256").update(await readFile(selected.bootstrapEntry)).digest("hex") !== selected.bootstrapIdentity }
    catch (cause) {
      if (missing(cause)) return true
      return fail("generation", "Could not inspect the selected npm bootstrap identity.")
    }
  }
  const replacementSelection = async (previous: UpdateRuntimeSelection, floor: typeof Floor.Type | undefined): Promise<UpdateRuntimeSelection> => {
    const bootstrap = previous.bootstrapEntry, manifestFile = join(dirname(dirname(bootstrap)), "package.json")
    const manifest = await readBoundedJSON(manifestFile) as { name?: unknown; version?: unknown; atapeRuntime?: {
      stateContract?: unknown; captureStateContract?: unknown; updateControlProtocol?: unknown
    } }
    if (manifest.name !== "@atape/cli" || typeof manifest.version !== "string" ||
      manifest.atapeRuntime?.updateControlProtocol !== updateControlProtocol ||
      (manifest.atapeRuntime.captureStateContract ?? manifest.atapeRuntime.stateContract) !== previous.captureStateContract)
      fail("admission", "The replacement npm package does not support the selected capture contract and update protocol.")
    const target = decodeUpdateRuntimeSelection({ ...previous, version: manifest.version, adapters: [],
      bootstrapIdentity: createHash("sha256").update(await readFile(bootstrap)).digest("hex") })
    if (older(target.version, previous.version) || !accepts(floor, target))
      fail("admission", "Manual bootstrap replacement cannot downgrade the selected runtime or its reader floor.")
    const output = await executeOwnedProcess(process.execPath, [bootstrap, "--version"],
      { ...process.env, ATAPE_HOME: home, ATAPE_RUNTIME_DIRECT: "1" }, AbortSignal.timeout(15_000), 15_000)
    if (output.trim() !== `ATape ${target.version}`) fail("generation", "The replacement npm bootstrap failed direct version verification.")
    const releases = join(await realpath(home), "releases"), destination = join(releases, target.version)
    await mkdir(releases, { recursive: true, mode: 0o700 })
    if (await realpath(releases) !== releases) fail("generation", "Update releases must remain inside ATAPE_HOME.")
    const exists = await lstat(destination).then(() => true, cause => { if (missing(cause)) return false; throw cause })
    if (!exists) {
      const staging = join(releases, `.replacement-${randomUUID()}`), root = join(staging, "node_modules", "@atape", "cli")
      try {
        await mkdir(join(root, "dist"), { recursive: true, mode: 0o700 })
        await copyFile(bootstrap, join(root, "dist", "atape.js"))
        await copyFile(manifestFile, join(root, "package.json"))
        await syncPackageTree(staging)
        await rename(staging, destination)
        const directory = await open(releases, "r")
        try { await directory.sync() } finally { await directory.close() }
      } finally { await rm(staging, { recursive: true, force: true }) }
    }
    const entry = await validateGeneration(target, true)
    if (createHash("sha256").update(await readFile(entry)).digest("hex") !== target.bootstrapIdentity)
      fail("generation", "The immutable recovery generation differs from the replacement npm bundle.")
    return target
  }
  const bindReplacement = async (recovering: boolean): Promise<UpdateRuntimeSelection> => {
    const prior = await readControl()
    if (prior && prior.phase !== "completed" && prior.phase !== "recovered")
      fail("conflict", "An unfinished update must recover before replacing its bootstrap.")
    const previous = await readSelection() ?? fail("conflict", "Bootstrap replacement requires an existing independent runtime selection.")
    const target = await replacementSelection(previous, prior?.floor)
    // Verification, subprocesses and the immutable generation copy precede the
    // short barrier. The caller's update ownership protects their lifetime.
    const release = await acquireRuntimeWriteBarrier()
    try {
      if (!isDeepStrictEqual(await readControl(), prior)) fail("conflict", "The update reader floor changed before bootstrap replacement committed.")
      await unchanged([previous])
      const control: Control = { protocol: updateControlProtocol, key: randomUUID(), phase: "fenced", forwardOnly: true,
        baseline: previous, previous, target,
        floor: { minimumRuntimeVersion: target.version, captureStateContract: target.captureStateContract } }
      // The npm executable is already replaced: every subsequent crash must
      // recover forward to its verified immutable copy, never the old identity.
      await writeControl(control)
      await writeSelection(target)
      await unchanged([target])
      await writeControl({ ...control, phase: recovering ? "recovering" : "completed" })
    } finally { release() }
    return target
  }
  const bootstrapReplacementSelection = async (): Promise<UpdateRuntimeSelection | undefined> => {
    const control = await readControl()
    if (control && control.phase !== "completed" && control.phase !== "recovered") return undefined
    const selected = await readSelection()
    return selected && await bootstrapChanged(selected) ? selected : undefined
  }
  return {
    readSelection,
    assertRuntimeAdmission,
    // Resource cleanup may checkpoint already-admitted SQLite bytes after the
    // reader floor moves. It uses exclusion without gaining logical admission.
    acquireRuntimeWriteBarrier,
    acquireRuntimeWrite: async (runtime: UpdateRuntimeAdmission, waitMs = 5_000): Promise<() => void> => {
      const release = await acquireRuntimeWriteBarrier(waitMs)
      try { await assertRuntimeAdmission(runtime); return release }
      catch (cause) { release(); throw cause }
    },
    // Replacement context only, not admission to execute the old selection.
    // The recovery coordinator materializes this Adapter overlay under its
    // configuration lock before recoverSelection creates a new snapshot.
    bootstrapReplacementSelection,
    recoveryPending: async (): Promise<boolean> => {
      const control = await readControl()
      if (control !== undefined && control.phase !== "completed" && control.phase !== "recovered") return true
      return (await bootstrapReplacementSelection()) !== undefined
    },
    protectedSelections: async (): Promise<ReadonlyArray<UpdateRuntimeSelection>> => {
      const current = await readSelection(), control = await readControl()
      const selections = [current, control?.target, control?.previous, control?.baseline]
        .filter((item): item is UpdateRuntimeSelection => item !== undefined)
      return selections.filter((selection, index) => !selections.slice(0, index).some(previous => isDeepStrictEqual(previous, selection)))
    },
    resolveSelectionEntry: (selection: UpdateRuntimeSelection, requireControl = false): Promise<string> =>
      validateGeneration(decodeUpdateRuntimeSelection(selection), requireControl),
    // Deliberate same-contract npm replacement only. The caller holds both
    // update and npm-installation ownership and has already replaced/verified
    // the bootstrap. Unlike automatic begin, the old same-contract Collector
    // may remain active until the application's bounded pause/resume handoff.
    rebindBootstrap: (): Promise<UpdateRuntimeSelection> => bindReplacement(false),
    handoffRuntime: async (): Promise<UpdateRuntimeSelection | undefined> => {
      const control = await readControl()
      if (!control || control.phase === "completed" || control.phase === "recovered") return undefined
      await unchanged([control.baseline, control.target, control.previous])
      const selection = control.phase === "prepared" || control.phase === "recovering" && !control.forwardOnly
        ? control.previous : control.target
      if (!selection) return undefined
      if (!accepts(control.floor, selection)) fail("admission", "The handoff runtime does not satisfy the durable reader floor.")
      const historical = !control.baseline && selection === control.previous
      await validateGeneration(selection, !historical)
      return selection
    },
    prepare: async (input: { readonly next: UpdateRuntimeSelection; readonly previous?: UpdateRuntimeSelection }): Promise<UpdateControlTicket> => {
      const target = decodeUpdateRuntimeSelection(input.next), prior = await readControl()
      if (prior && prior.phase !== "completed" && prior.phase !== "recovered") fail("conflict", "An unfinished update must recover before preparing another.")
      const baseline = await readSelection(), previous = input.previous === undefined ? baseline : decodeUpdateRuntimeSelection(input.previous)
      if (baseline && previous && !isDeepStrictEqual(baseline, previous)) fail("conflict", "The previous runtime differs from the selected runtime.")
      if (previous && older(target.version, previous.version)) fail("admission", "Automatic updates cannot downgrade the selected runtime.")
      if (prior?.floor && older(target.version, prior.floor.minimumRuntimeVersion)) fail("admission", "The update is below the durable runtime reader floor.")
      if (previous && !accepts(prior?.floor, previous)) fail("admission", "The previous runtime does not satisfy the durable reader floor.")
      await validateGeneration(target, true)
      if (previous) await validateGeneration(previous)
      const key = randomUUID()
      await writeControl({ protocol: updateControlProtocol, key, phase: "prepared", target,
        ...(baseline ? { baseline } : {}), ...(previous ? { previous } : {}), ...(prior?.floor ? { floor: prior.floor } : {}), forwardOnly: false })
      return { key }
    },
    begin: async (ticket: UpdateControlTicket): Promise<void> => {
      const control = await transaction(ticket)
      if (control.phase !== "prepared" && control.phase !== "begun") fail("conflict", "This update cannot begin in its current phase.")
      await unchanged(control.phase === "prepared" ? [control.baseline] : [control.baseline, control.target])
      await validateGeneration(control.target, true)
      await writeControl({ ...control, phase: "begun" })
      await writeSelection(control.target)
    },
    fence: async (ticket: UpdateControlTicket): Promise<void> => {
      const control = await transaction(ticket)
      if (control.phase !== "begun" && control.phase !== "fenced") fail("conflict", "This update cannot cross its recovery boundary.")
      await validateGeneration(control.target, true)
      const release = await acquireRuntimeWriteBarrier()
      try {
        if (!isDeepStrictEqual(await transaction(ticket), control)) fail("conflict", "The update changed before its reader-floor boundary committed.")
        await unchanged([control.baseline, control.target])
        // This fsynced record, including the target recovery selection, precedes
        // pointer repair and every caller-owned incompatible operation. A writer
        // already holding the barrier finishes before this floor can advance.
        await writeControl({ ...control, phase: "fenced", forwardOnly: true,
          floor: { minimumRuntimeVersion: control.target.version, captureStateContract: control.target.captureStateContract } })
        await writeSelection(control.target)
      } finally { release() }
    },
    complete: async (ticket: UpdateControlTicket): Promise<void> => {
      const control = await transaction(ticket)
      if (control.phase !== "begun" && control.phase !== "fenced" && control.phase !== "completed") fail("conflict", "This update cannot complete in its current phase.")
      if (!control.forwardOnly && control.previous && control.previous.captureStateContract !== control.target.captureStateContract)
        fail("admission", "A capture contract transition requires a durable forward-only boundary.")
      if (!accepts(control.floor, control.target)) fail("admission", "The target runtime does not satisfy the durable reader floor.")
      await unchanged([control.target])
      await validateGeneration(control.target, true)
      await writeControl({ ...control, phase: "completed" })
    },
    recoverSelection: async (): Promise<UpdateRuntimeSelection | undefined> => {
      const control = await readControl()
      if (!control || control.phase === "completed" || control.phase === "recovered") {
        const selected = await readSelection()
        return selected && await bootstrapChanged(selected) ? bindReplacement(true) : selected
      }
      const restore = control.forwardOnly ? control.target : control.previous
      await unchanged([control.baseline, control.target, control.previous])
      if (!control.forwardOnly && control.floor && !control.baseline)
        fail("admission", "A fenced installation cannot recover to an unselected bootstrap.")
      if (restore) {
        if (!accepts(control.floor, restore)) fail("admission", "The recovery runtime does not satisfy the durable reader floor.")
        await validateGeneration(restore, control.forwardOnly)
      } else if (control.floor) fail("admission", "A fenced installation cannot recover to an unselected bootstrap.")
      // The first compatible fallback may be a historical bridge without the
      // control capability. Restore its original absent independent pointer so
      // legacy delegation remains authoritative; never label it as capable.
      await writeSelection(control.forwardOnly ? control.target : control.baseline)
      await writeControl({ ...control, phase: "recovering" })
      return restore
    },
    completeRecovery: async (): Promise<void> => {
      const control = await readControl()
      if (!control || control.phase === "recovered") return
      if (control.phase !== "recovering") fail("conflict", "Runtime recovery has not selected a generation.")
      const restore = control.forwardOnly ? control.target : control.previous
      await unchanged([control.forwardOnly ? control.target : control.baseline])
      if (!control.forwardOnly && control.floor && !control.baseline)
        fail("admission", "A fenced installation cannot recover to an unselected bootstrap.")
      if (restore) {
        if (!accepts(control.floor, restore)) fail("admission", "The recovered runtime does not satisfy the durable reader floor.")
        await validateGeneration(restore, control.forwardOnly)
      }
      await writeControl({ ...control, phase: "recovered" })
    },
  }
}
