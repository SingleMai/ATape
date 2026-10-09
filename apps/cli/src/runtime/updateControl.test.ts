import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { atomicJSON, runtimeEntry } from "./runtimeFiles.ts"
import { createUpdateControl, updateControlProtocol, type UpdateRuntimeSelection } from "./updateControl.ts"

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-update-control-")))
  homes.push(home)
  const bootstrap = join(home, "bootstrap", "atape.js")
  await mkdir(dirname(bootstrap), { recursive: true })
  await writeFile(bootstrap, "bootstrap fixture")
  const bootstrapIdentity = createHash("sha256").update(await readFile(bootstrap)).digest("hex")
  const generation = async (version: string, captureStateContract = "capture.v2", capable = true): Promise<UpdateRuntimeSelection> => {
    const entry = runtimeEntry(home, version)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "// A fixture executable; never executed by these filesystem tests.\n")
    await atomicJSON(join(dirname(dirname(entry)), "package.json"), { name: "@atape/cli", version,
      atapeRuntime: { stateContract: captureStateContract, ...(capable ? { updateControlProtocol } : {}) } })
    return { protocol: updateControlProtocol, version, captureStateContract, bootstrapEntry: bootstrap, bootstrapIdentity, adapters: [] }
  }
  const previous = await generation("0.5.4", "capture.v2", false)
  const next = await generation("0.5.5")
  const pointer = join(home, "updates", "runtime.json"), ledger = join(home, "updates", "control.json")
  const replaceBootstrap = async (version: string, captureStateContract = "capture.v2", capable = true, reportedVersion = version) => {
    await atomicJSON(join(dirname(dirname(bootstrap)), "package.json"), { name: "@atape/cli", version,
      atapeRuntime: { stateContract: captureStateContract, ...(capable ? { updateControlProtocol } : {}) } })
    await writeFile(bootstrap, `if (process.env.ATAPE_RUNTIME_DIRECT !== "1") throw new Error("Version verification must bypass generic dispatch");\nconsole.log("ATape ${reportedVersion}");\n`)
  }
  return { home, bootstrap, previous, next, pointer, ledger, generation,
    replaceBootstrap,
    control: () => createUpdateControl(home), readLedger: () => readFile(ledger, "utf8").then(JSON.parse) }
}

describe("independent update control through its durable caller Interface", () => {
  it("starts without a selection and preparation does not select or reject the historical compatible fallback", async () => {
    const f = await fixture(), control = f.control()
    expect(await control.readSelection()).toBeUndefined()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    expect(ticket.key).toMatch(/^[0-9a-f-]{36}$/)
    expect(await control.readSelection()).toBeUndefined()
    expect(await f.control().recoverSelection()).toEqual(f.previous)
    expect(await f.control().readSelection()).toBeUndefined()
    expect(await f.control().recoveryPending()).toBe(true)
    await f.control().completeRecovery()
    expect(await f.control().recoveryPending()).toBe(false)
  })

  it("recovers the previous compatible runtime after a process restart during trial activation", async () => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    await control.begin(ticket)
    expect(await control.readSelection()).toEqual(f.next)
    expect(await f.control().recoverSelection()).toEqual(f.previous)
    expect(await f.control().recoverSelection()).toEqual(f.previous)
    expect(await f.control().readSelection()).toBeUndefined()
    await f.control().completeRecovery()
    await f.control().completeRecovery()
  })

  it("commits a compatible runtime without inventing an irreversible migration or losing the Adapter generation", async () => {
    const f = await fixture(), control = f.control(), installedAt = "2026-10-10T00:00:00Z"
    const before = { adapterId: "codex", packageName: "@atape/adapter-codex", version: "0.5.4", packageSlot: randomUUID(),
      displayName: "Codex", upgradeSpec: "@atape/adapter-codex", installedAt, updatedAt: installedAt }
    const next = { ...f.next, adapters: [{ before, after: { ...before, version: "0.5.5", packageSlot: randomUUID() } }] }
    const ticket = await control.prepare({ next, previous: f.previous })
    await control.begin(ticket)
    await control.complete(ticket)
    await control.complete(ticket)
    expect(await f.control().recoverSelection()).toEqual(next)
    expect(await f.control().recoveryPending()).toBe(false)
    expect(await f.control().protectedSelections()).toEqual([next, f.previous])
    expect(await f.readLedger()).toMatchObject({ phase: "completed", forwardOnly: false })
    expect((await f.readLedger()).floor).toBeUndefined()
  })

  it("refuses incompatible admission and completion until the caller persists a forward-only boundary", async () => {
    const f = await fixture(), control = f.control(), next = await f.generation("0.6.0", "capture.v3")
    const ticket = await control.prepare({ next, previous: f.previous })
    await control.begin(ticket)
    await expect(control.assertRuntimeAdmission(next)).rejects.toMatchObject({ reason: "admission" })
    await expect(control.assertRuntimeAdmission({ version: "9.0.0", captureStateContract: "unknown" })).rejects.toMatchObject({ reason: "admission" })
    await control.assertRuntimeAdmission(f.previous)
    await expect(control.complete(ticket)).rejects.toMatchObject({ reason: "admission" })
    expect(await f.control().recoverSelection()).toEqual(f.previous)
  })

  it("persists an exact contract and minimum reader version before forward recovery, and rejects older or differently capable code", async () => {
    const f = await fixture(), control = f.control(), next = await f.generation("0.6.0", "capture.v3")
    const ticket = await control.prepare({ next, previous: f.previous })
    await control.begin(ticket)
    await control.fence(ticket)
    await control.fence(ticket)
    expect(await f.readLedger()).toMatchObject({ phase: "fenced", target: next,
      floor: { minimumRuntimeVersion: "0.6.0", captureStateContract: "capture.v3" } })
    await expect(f.control().assertRuntimeAdmission(f.previous)).rejects.toMatchObject({ reason: "admission" })
    await expect(f.control().assertRuntimeAdmission({ version: "0.5.9", captureStateContract: "capture.v3" })).rejects.toMatchObject({ reason: "admission" })
    await expect(f.control().assertRuntimeAdmission({ version: "99.0.0", captureStateContract: "capture.v2" })).rejects.toMatchObject({ reason: "admission" })
    await f.control().assertRuntimeAdmission(next)
    expect(await f.control().recoverSelection()).toEqual(next)
    await f.control().completeRecovery()
    await expect(f.control().assertRuntimeAdmission(f.previous)).rejects.toMatchObject({ reason: "admission" })
  })

  it("repairs an interrupted pointer replacement using the durable fence, rather than rolling back", async () => {
    const f = await fixture(), control = f.control(), next = await f.generation("0.6.0", "capture.v3")
    const ticket = await control.prepare({ next, previous: f.previous })
    await control.begin(ticket)
    await control.fence(ticket)
    // Recreate the observable crash state after the fenced ledger synced but
    // before its pointer repair. No executable or capture data is simulated.
    await atomicJSON(f.pointer, f.previous)
    expect(await f.control().recoverSelection()).toEqual(next)
    await f.control().completeRecovery()
    expect(await f.control().readSelection()).toEqual(next)
  })

  it("never revives the old runtime when the fenced recovery package is temporarily unavailable", async () => {
    const f = await fixture(), control = f.control(), next = await f.generation("0.6.0", "capture.v3")
    const ticket = await control.prepare({ next, previous: f.previous })
    await control.begin(ticket)
    await control.fence(ticket)
    const path = join(f.home, "releases", next.version), held = `${path}.held`
    await rename(path, held)
    await expect(f.control().recoverSelection()).rejects.toMatchObject({ reason: "generation" })
    expect(await f.control().readSelection()).toEqual(next)
    expect(await f.readLedger()).toMatchObject({ phase: "fenced", forwardOnly: true })
    await rename(held, path)
    expect(await f.control().recoverSelection()).toEqual(next)
    await f.control().completeRecovery()
  })

  it("retains a previously established floor through a later compatible update and pre-fence rollback", async () => {
    const f = await fixture(), control = f.control(), next = await f.generation("0.6.0", "capture.v3")
    const first = await control.prepare({ next, previous: f.previous })
    await control.begin(first)
    await control.fence(first)
    await control.complete(first)
    const later = await f.generation("0.6.1", "capture.v3")
    const second = await control.prepare({ next: later })
    await control.begin(second)
    expect(await f.control().recoverSelection()).toEqual(next)
    await f.control().completeRecovery()
    expect(await f.readLedger()).toMatchObject({ floor: { minimumRuntimeVersion: "0.6.0", captureStateContract: "capture.v3" } })
    await expect(control.prepare({ next: f.next, previous: next })).rejects.toMatchObject({ reason: "admission" })
    await expect(control.assertRuntimeAdmission(f.previous)).rejects.toMatchObject({ reason: "admission" })
  })

  it("repeats recovery after a crash between restoring the pointer and recording the recovery phase", async () => {
    const f = await fixture(), control = f.control()
    const first = await control.prepare({ next: f.next, previous: f.previous })
    await control.begin(first)
    await control.complete(first)
    const later = await f.generation("0.5.6")
    const second = await control.prepare({ next: later })
    await control.begin(second)
    // The pointer restore synced, but the coordinator died before writing the
    // recovering phase. Recovery must accept the still-begun ledger on restart.
    await atomicJSON(f.pointer, f.next)
    expect(await f.readLedger()).toMatchObject({ phase: "begun" })
    expect(await f.control().recoverSelection()).toEqual(f.next)
    expect(await f.control().recoverSelection()).toEqual(f.next)
    expect(await f.control().readSelection()).toEqual(f.next)
    await f.control().completeRecovery()
    expect(await f.control().recoveryPending()).toBe(false)
  })

  it.each(["prepared", "begun", "fenced"])("does not overwrite a later deliberate selection while recovering %s", async phase => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    if (phase !== "prepared") await control.begin(ticket)
    if (phase === "fenced") await control.fence(ticket)
    const later = await f.generation("0.5.6")
    await atomicJSON(f.pointer, later)
    await expect(f.control().recoverSelection()).rejects.toMatchObject({ reason: "conflict" })
    expect(await f.control().readSelection()).toEqual(later)
  })

  it("rejects stale transaction tickets and a second preparation while work is pending", async () => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    await expect(control.begin({ key: randomUUID() })).rejects.toMatchObject({ reason: "conflict" })
    await expect(control.prepare({ next: f.next })).rejects.toMatchObject({ reason: "conflict" })
    await control.begin(ticket)
    await control.complete(ticket)
    const next = await f.generation("0.5.6")
    await control.prepare({ next })
    await expect(control.fence(ticket)).rejects.toMatchObject({ reason: "conflict" })
  })

  it.each(["{", JSON.stringify({ protocol: "unknown" }), JSON.stringify({ protocol: updateControlProtocol, phase: "fenced" })])(
    "fails closed on malformed or unknown persisted control metadata %s", async bytes => {
      const f = await fixture(), control = f.control()
      await mkdir(dirname(f.ledger), { recursive: true })
      await writeFile(f.ledger, bytes)
      await expect(control.recoverSelection()).rejects.toMatchObject({ reason: "metadata" })
      await expect(control.assertRuntimeAdmission(f.previous)).rejects.toMatchObject({ reason: "metadata" })
      await expect(control.prepare({ next: f.next })).rejects.toMatchObject({ reason: "metadata" })
      expect(await readFile(f.ledger, "utf8")).toBe(bytes)
    })

  it("rejects a malformed pointer instead of treating it as an absent selection", async () => {
    const f = await fixture(), control = f.control()
    await atomicJSON(f.pointer, { ...f.next, captureStateContract: "" })
    await expect(control.readSelection()).rejects.toMatchObject({ reason: "metadata" })
    await expect(control.prepare({ next: f.next })).rejects.toMatchObject({ reason: "metadata" })
  })

  it.each(["early-forward", "missing-boundary", "wrong-floor-contract", "wrong-floor-version", "incompatible-commit", "different-baseline"])(
    "refuses semantically malformed %s metadata before admitting any runtime", async corruption => {
      const f = await fixture(), control = f.control(), next = await f.generation("0.6.0", "capture.v3")
      const ticket = await control.prepare({ next, previous: f.previous })
      await control.begin(ticket)
      await control.fence(ticket)
      const durable = await f.readLedger()
      const malformed = { ...durable,
        ...(corruption === "early-forward" ? { phase: "begun" } : {}),
        ...(corruption === "missing-boundary" ? { forwardOnly: false } : {}),
        ...(corruption === "wrong-floor-contract" ? { floor: { ...durable.floor, captureStateContract: "capture.v2" } } : {}),
        ...(corruption === "wrong-floor-version" ? { floor: { ...durable.floor, minimumRuntimeVersion: "0.5.9" } } : {}),
        ...(corruption === "incompatible-commit" ? { phase: "completed", forwardOnly: false } : {}),
        ...(corruption === "different-baseline" ? { baseline: next } : {}) }
      await atomicJSON(f.ledger, malformed)
      await expect(f.control().assertRuntimeAdmission(next)).rejects.toMatchObject({ reason: "metadata" })
      await expect(f.control().assertRuntimeAdmission(f.previous)).rejects.toMatchObject({ reason: "metadata" })
      await expect(f.control().recoveryPending()).rejects.toMatchObject({ reason: "metadata" })
      await expect(f.control().recoverSelection()).rejects.toMatchObject({ reason: "metadata" })
      expect(await f.control().readSelection()).toEqual(next)
    })

  it("verifies capability and the package's actual capture declaration rather than relabeling it", async () => {
    const f = await fixture(), control = f.control()
    expect(await control.resolveSelectionEntry(f.previous)).toBe(runtimeEntry(f.home, f.previous.version))
    await expect(control.resolveSelectionEntry(f.previous, true)).rejects.toMatchObject({ reason: "generation" })
    expect(await control.resolveSelectionEntry(f.next, true)).toBe(runtimeEntry(f.home, f.next.version))
    await expect(control.prepare({ next: f.previous })).rejects.toMatchObject({ reason: "generation" })
    await expect(control.prepare({ next: { ...f.next, captureStateContract: "capture.v3" } })).rejects.toMatchObject({ reason: "generation" })
    const manifestPath = join(dirname(dirname(runtimeEntry(f.home, f.next.version))), "package.json")
    await atomicJSON(manifestPath, { name: "@atape/cli", version: f.next.version,
      atapeRuntime: { stateContract: "legacy.dispatch", captureStateContract: "capture.v2", updateControlProtocol } })
    await control.prepare({ next: f.next, previous: f.previous })
  })

  it("keeps recovery pending until readiness confirmation and refuses to finalize a superseded recovery", async () => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    await control.begin(ticket)
    await f.control().recoverSelection()
    expect(await f.control().recoveryPending()).toBe(true)
    const later = await f.generation("0.5.6")
    await atomicJSON(f.pointer, later)
    await expect(f.control().completeRecovery()).rejects.toMatchObject({ reason: "conflict" })
    expect(await f.control().readSelection()).toEqual(later)
    expect(await f.control().recoveryPending()).toBe(true)
  })

  it("fails closed when a retained reader floor has no original independent selection to restore", async () => {
    const f = await fixture(), control = f.control(), next = await f.generation("0.6.0", "capture.v3")
    const first = await control.prepare({ next, previous: f.previous })
    await control.begin(first)
    await control.fence(first)
    await control.complete(first)
    await rm(f.pointer)
    const later = await f.generation("0.6.1", "capture.v3")
    const second = await control.prepare({ next: later, previous: next })
    await control.begin(second)
    await expect(f.control().recoverSelection()).rejects.toMatchObject({ reason: "admission" })
    expect(await f.control().readSelection()).toEqual(later)
    expect(await f.control().recoveryPending()).toBe(true)
  })

  it("rebinds a deliberate same-contract npm replacement to its verified immutable bytes and a retained reader floor", async () => {
    const f = await fixture(), control = f.control(), first = await f.generation("0.6.0", "capture.v3")
    const ticket = await control.prepare({ next: first, previous: f.previous })
    await control.begin(ticket)
    await control.fence(ticket)
    await control.complete(ticket)
    await f.replaceBootstrap("0.6.1", "capture.v3")
    expect(await f.control().recoveryPending()).toBe(true)
    expect(await f.control().bootstrapReplacementSelection()).toEqual(first)
    const rebound = await f.control().rebindBootstrap()
    expect(rebound).toMatchObject({ version: "0.6.1", captureStateContract: "capture.v3", adapters: [] })
    expect(await readFile(runtimeEntry(f.home, rebound.version), "utf8")).toBe(await readFile(f.bootstrap, "utf8"))
    expect(await f.control().readSelection()).toEqual(rebound)
    expect(await f.readLedger()).toMatchObject({ phase: "completed", forwardOnly: true,
      floor: { minimumRuntimeVersion: "0.6.1", captureStateContract: "capture.v3" } })
    expect(await f.control().recoveryPending()).toBe(false)
    await expect(f.control().assertRuntimeAdmission(first)).rejects.toMatchObject({ reason: "admission" })
  })

  it("repairs a completed installation after npm replacement but before the first rebound ledger write", async () => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    await control.begin(ticket)
    await control.complete(ticket)
    const ledger = await readFile(f.ledger, "utf8")
    await f.replaceBootstrap("0.5.6")
    expect(await readFile(f.ledger, "utf8")).toBe(ledger)
    expect(await f.control().recoveryPending()).toBe(true)
    const rebound = await f.control().recoverSelection()
    expect(rebound).toMatchObject({ version: "0.5.6" })
    expect(await f.control().readSelection()).toEqual(rebound)
    expect(await f.control().recoveryPending()).toBe(true)
    expect(await f.readLedger()).toMatchObject({ phase: "recovering", forwardOnly: true })
    expect(await f.control().recoverSelection()).toEqual(rebound)
    await f.control().completeRecovery()
    expect(await f.control().recoveryPending()).toBe(false)
    expect(await f.control().bootstrapReplacementSelection()).toBeUndefined()
  })

  it("recovers the new npm snapshot when replacement was fenced but its pointer switch was interrupted", async () => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    await control.begin(ticket)
    await control.complete(ticket)
    const oldSelection = await control.readSelection()
    await f.replaceBootstrap("0.5.6")
    const rebound = await control.rebindBootstrap()
    // Recreate the durable point after replacement intent synced but before
    // the independent pointer switched to the already-copied new npm bundle.
    await atomicJSON(f.ledger, { ...await f.readLedger(), phase: "fenced" })
    await atomicJSON(f.pointer, oldSelection)
    expect(await f.control().recoverSelection()).toEqual(rebound)
    expect(await f.control().readSelection()).toEqual(rebound)
    await f.control().completeRecovery()
    await expect(f.control().assertRuntimeAdmission(f.next)).rejects.toMatchObject({ reason: "admission" })
  })

  it("does not replace an immutable generation with different npm bytes under the same release version", async () => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    await control.begin(ticket)
    await control.complete(ticket)
    await f.generation("0.5.6")
    const bytes = await readFile(runtimeEntry(f.home, "0.5.6"), "utf8"), ledger = await readFile(f.ledger, "utf8")
    await f.replaceBootstrap("0.5.6")
    await expect(f.control().rebindBootstrap()).rejects.toMatchObject({ reason: "generation" })
    expect(await readFile(runtimeEntry(f.home, "0.5.6"), "utf8")).toBe(bytes)
    expect(await readFile(f.ledger, "utf8")).toBe(ledger)
    expect(await f.control().recoveryPending()).toBe(true)
  })

  it.each([
    ["0.5.4", "capture.v2", true, "0.5.4"],
    ["0.5.6", "capture.v3", true, "0.5.6"],
    ["0.5.6", "capture.v2", false, "0.5.6"],
    ["0.5.6", "capture.v2", true, "0.5.7"]
  ] as const)("rejects an unverified or unsafe replacement %s/%s/%s/%s without changing control metadata", async (version, contract, capable, reported) => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    await control.begin(ticket)
    await control.complete(ticket)
    const pointer = await readFile(f.pointer, "utf8"), ledger = await readFile(f.ledger, "utf8")
    await f.replaceBootstrap(version, contract, capable, reported)
    await expect(f.control().rebindBootstrap()).rejects.toBeDefined()
    await expect(f.control().recoverSelection()).rejects.toBeDefined()
    expect(await readFile(f.pointer, "utf8")).toBe(pointer)
    expect(await readFile(f.ledger, "utf8")).toBe(ledger)
    expect(await f.control().recoveryPending()).toBe(true)
  })

  it("refuses manual rebinding while the independent transaction is unfinished", async () => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    await control.begin(ticket)
    const pointer = await readFile(f.pointer, "utf8"), ledger = await readFile(f.ledger, "utf8")
    await f.replaceBootstrap("0.5.6")
    await expect(f.control().rebindBootstrap()).rejects.toMatchObject({ reason: "conflict" })
    expect(await f.control().bootstrapReplacementSelection()).toBeUndefined()
    expect(await readFile(f.pointer, "utf8")).toBe(pointer)
    expect(await readFile(f.ledger, "utf8")).toBe(ledger)
  })

  it("provides a validated pending handoff selection without exposing the transaction ledger", async () => {
    const f = await fixture(), control = f.control()
    expect(await control.handoffRuntime()).toBeUndefined()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    expect(await control.handoffRuntime()).toEqual(f.previous)
    await control.begin(ticket)
    expect(await control.handoffRuntime()).toEqual(f.next)
    await control.recoverSelection()
    expect(await control.handoffRuntime()).toEqual(f.previous)
    await control.completeRecovery()
    expect(await control.handoffRuntime()).toBeUndefined()
  })

  it("rechecks package validity and bootstrap ownership at activation, leaving the old selection usable on failure", async () => {
    const f = await fixture(), control = f.control()
    const ticket = await control.prepare({ next: f.next, previous: f.previous })
    await writeFile(f.bootstrap, "a replacement npm installation")
    await expect(control.begin(ticket)).rejects.toMatchObject({ reason: "generation" })
    expect(await control.readSelection()).toBeUndefined()
  })

  it("rejects generations that escape through a symlink", async () => {
    const f = await fixture(), control = f.control(), directory = join(f.home, "releases", f.next.version)
    await rename(directory, `${directory}.real`)
    await symlink(`${directory}.real`, directory)
    await expect(control.prepare({ next: f.next })).rejects.toMatchObject({ reason: "generation" })
  })

  it("validates complete official Adapter generations and stable identities before persisting a transaction", async () => {
    const f = await fixture(), control = f.control()
    await expect(control.prepare({ next: { ...f.next, version: "0.5.6-beta" } })).rejects.toMatchObject({ reason: "metadata" })
    await expect(control.prepare({ next: { ...f.next, bootstrapEntry: "relative" } })).rejects.toMatchObject({ reason: "metadata" })
    await expect(control.prepare({ next: { ...f.next, bootstrapIdentity: "unknown" } })).rejects.toMatchObject({ reason: "metadata" })
    expect(await control.readSelection()).toBeUndefined()
  })
})
