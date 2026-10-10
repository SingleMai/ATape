import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { atomicJSON, readEffectiveRuntimeSelection, runtimeEntry } from "./runtimeSelection.ts"
import { createUpdateControl } from "./updateControl.ts"
import { acquireUpdateWorker } from "./managedUpdates.ts"
import { compileCaptureFixtureEntry, prepareManagedCaptureFixture, journalVersion, captureV2 } from "./fixtures/managed-capture-update.ts"

const roots: string[] = []
let builds: string, targetPackage: string, sourceEntry: string, newerWriter: string, targetVersion: string
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, any>
const absent = (path: string) => expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
beforeAll(async () => {
  builds = await mkdtemp(join(tmpdir(), "atape-capture-built-"))
  targetPackage = join(builds, "target")
  const manifest = await json(fileURLToPath(new URL("../../package.json", import.meta.url)))
  targetVersion = manifest.version
  await mkdir(targetPackage)
  await atomicJSON(join(targetPackage, "package.json"), manifest)
  sourceEntry = join(builds, "controlled-v1", "coordinator.mjs")
  await Promise.all([compileCaptureFixtureEntry(join(targetPackage, "dist", "atape.js"), "target", targetVersion),
    compileCaptureFixtureEntry(sourceEntry, "coordinator", "0.0.1")])
}, 30_000)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
afterAll(async () => { if (builds) await rm(builds, { recursive: true, force: true }) })
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-managed-capture-")); roots.push(root)
  return prepareManagedCaptureFixture(root, targetPackage, sourceEntry)
}

describe("actual target capture migration through the managed coordinator", () => {
  it("fences a controlled capable v1 bridge, runs actual SQL7→8, and preserves Stop and settings", async () => {
    const f = await fixture(), stopped = await readFile(`${f.paths.collectorProcessFile}.desired.json`, "utf8")
    const configuration = await readFile(f.paths.configFile, "utf8")
    expect(journalVersion(f.journalPath)).toBe(7)
    expect(await f.invoke("activate")).toEqual({ activated: true })
    expect(journalVersion(f.journalPath)).toBe(8)
    expect(await readEffectiveRuntimeSelection(f.paths.atapeHome)).toEqual(f.target)
    expect(await readFile(`${f.paths.collectorProcessFile}.desired.json`, "utf8")).toBe(stopped)
    expect(await readFile(f.paths.configFile, "utf8")).toBe(configuration)
    expect(await json(join(f.paths.atapeHome, "updates", "control.json"))).toMatchObject({ phase: "completed", forwardOnly: true,
      floor: { captureStateContract: captureV2, minimumRuntimeVersion: targetVersion } })
    expect(await json(join(f.paths.atapeHome, "updates", "capture-migration.json"))).toMatchObject({ phase: "completed" })
    await absent(f.paths.collectorProcessFile); await absent(f.networkFile)
  }, 30_000)

  it("recovers the exact fenced target after process exit even when automatic updates are turned off", async () => {
    const f = await fixture(), stopped = await readFile(`${f.paths.collectorProcessFile}.desired.json`, "utf8")
    expect(await f.invoke("interrupt-after-fence")).toMatchObject({ interrupted: "interrupt-after-fence" })
    expect(journalVersion(f.journalPath)).toBe(7)
    await expect(f.invoke("write")).rejects.toMatchObject({ code: 1 })
    await atomicJSON(f.paths.configFile, { ...await json(f.paths.configFile), autoUpdateEnabled: false })
    expect(await f.invoke("recover")).toEqual({ recovered: true })
    expect(journalVersion(f.journalPath)).toBe(8)
    expect(await readEffectiveRuntimeSelection(f.paths.atapeHome)).toEqual(f.target)
    expect(await readFile(`${f.paths.collectorProcessFile}.desired.json`, "utf8")).toBe(stopped)
    expect((await json(f.paths.configFile)).autoUpdateEnabled).toBe(false)
    expect(await createUpdateControl(f.paths.atapeHome).recoveryPending()).toBe(false)
    expect(await f.invoke("recover")).toEqual({ recovered: false })
    await absent(f.paths.collectorProcessFile); await absent(f.networkFile)
  }, 30_000)

  it("restores the exact pre-fence baseline without transforming the journal or creating candidate cooldown", async () => {
    const f = await fixture()
    expect(await f.invoke("interrupt-before-fence")).toMatchObject({ interrupted: "interrupt-before-fence" })
    expect(await f.invoke("recover")).toEqual({ recovered: true })
    expect(journalVersion(f.journalPath)).toBe(7)
    expect(await readEffectiveRuntimeSelection(f.paths.atapeHome)).toEqual(f.source)
    expect(await json(join(f.paths.atapeHome, "updates", "control.json"))).toMatchObject({ phase: "recovered", forwardOnly: false })
    await absent(join(f.paths.atapeHome, "updates", "capture-migration.required.json"))
    await absent(join(f.paths.atapeHome, "updates", "capture-migration.json"))
    await absent(join(f.paths.atapeHome, "updates", "candidate-cooldowns.json"))
    expect(await f.invoke("activate")).toEqual({ activated: true })
    expect(journalVersion(f.journalPath)).toBe(8)
  }, 30_000)

  it("migrates a retained v7 journal during a manual upgrade before tools are configured", async () => {
    const f = await fixture(), stopped = await readFile(`${f.paths.collectorProcessFile}.desired.json`, "utf8")
    await atomicJSON(f.paths.configFile, { ...await json(f.paths.configFile), toolsConfigured: false, autoUpdateEnabled: false })
    expect(await f.invoke("activate-manual")).toEqual({ activated: true })
    expect(journalVersion(f.journalPath)).toBe(8)
    expect(await readEffectiveRuntimeSelection(f.paths.atapeHome)).toEqual(f.target)
    expect(await json(f.paths.configFile)).toMatchObject({ toolsConfigured: false, autoUpdateEnabled: false })
    expect(await readFile(`${f.paths.collectorProcessFile}.desired.json`, "utf8")).toBe(stopped)
    await absent(f.paths.collectorProcessFile); await absent(f.networkFile)
  }, 30_000)

  it("admits a newer actual same-contract writer after the migration receipt and selection change", async () => {
    const f = await fixture()
    await f.invoke("activate")
    const parts = targetVersion.split(".").map(Number), newerVersion = `${parts[0]}.${parts[1]}.${parts[2]! + 1}`
    const newerEntry = runtimeEntry(f.paths.atapeHome, newerVersion)
    const manifest = { ...await json(join(targetPackage, "package.json")), version: newerVersion }
    await atomicJSON(join(dirname(dirname(newerEntry)), "package.json"), manifest)
    newerWriter = join(f.root, "newer-writer.mjs")
    await Promise.all([compileCaptureFixtureEntry(newerEntry, "target", newerVersion),
      compileCaptureFixtureEntry(newerWriter, "coordinator", newerVersion, captureV2)])
    const release = await acquireUpdateWorker(f.paths.atapeHome)
    expect(release).toBeDefined()
    try {
      const control = createUpdateControl(f.paths.atapeHome), target = { ...f.target, version: newerVersion }
      const ticket = await control.prepare({ previous: f.target, next: target })
      await control.begin(ticket); await control.complete(ticket)
    } finally { release?.() }
    expect(await f.invoke("write", newerWriter)).toMatchObject({ checkpoint: null, epoch: 2 })
    expect(journalVersion(f.journalPath)).toBe(8)
    await absent(f.networkFile)
  }, 30_000)
})
