import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { Effect, Layer } from "effect"
import { CaptureJournals, CollectorStateStore } from "@atape/application"
import { afterEach, describe, expect, it } from "vitest"
import { makeCaptureJournalsLayer } from "./captureBootstrap.ts"
import { makeCollectorStateLayer } from "./collectorLayers.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const account = { instanceOrigin: "https://atape.test", userId: "user" }
const limits = { unitBytes: 1024, targetBytes: 8192, pendingBytes: 16384, metadataEntries: 100_000, unitsPerTarget: 16, recordsPerTarget: 100 }
const scope = { projectId: "project", adapterId: "opencode", sourceSessionId: "root", originKey: "origin" }
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-bootstrap-")); directories.push(root)
  const stateFile = join(root, "collector.json")
  const run = <A, E>(work: Effect.Effect<A, E, CaptureJournals | CollectorStateStore>) => Effect.runPromise(work.pipe(Effect.provide(
    Layer.merge(makeCaptureJournalsLayer(stateFile), makeCollectorStateLayer(stateFile)))))
  const open = (selected = account) => CaptureJournals.use(factory => factory.open(selected, limits))
  const initialize = () => run(Effect.scoped(open().pipe(Effect.map(journal => journal.binding))))
  const files = async () => (await readdir(`${stateFile}.captures`)).map(name => join(`${stateFile}.captures`, name))
  return { root, stateFile, run, open, initialize, files }
}

const runChild = (fixture: string, stateFile: string) => new Promise<{ installationId: string; epoch: number; preserved?: boolean }>((resolve, reject) => {
  const child = spawn(process.execPath, [new URL(`./fixtures/${fixture}`, import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  child.stdout.on("data", data => { stdout += data })
  child.stderr.on("data", data => { stderr += data })
  child.on("error", reject)
  child.on("close", code => {
    if (code !== 0) reject(new Error(`bootstrap child failed: ${stderr}`))
    else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } }
  })
  child.stdin.end(JSON.stringify({ stateFile, account, limits, scope }))
})

describe("Collector capture bootstrap", () => {
  it("waits for a competing exclusive lock during connection initialization without replacing installation identity", async () => {
    const f = await fixture(), initial = await f.initialize()
    const blocker = new DatabaseSync(`${f.stateFile}.lock.sqlite`)
    blocker.exec("BEGIN EXCLUSIVE")
    let released = false
    const release = () => { if (!released) { released = true; blocker.exec("COMMIT"); blocker.close() } }
    const timer = setTimeout(release, 100)
    try {
      expect(await f.initialize()).toEqual(initial)
      expect(released).toBe(true)
    } finally { clearTimeout(timer); release() }
  })
  it("preserves existing installation and legacy checkpoints while reopening immutable pending bytes", async () => {
    const f = await fixture()
    const initial = await f.run(CollectorStateStore.use(store => store.snapshot(account.instanceOrigin, account.userId, "legacy-project", "codex")))
    await f.run(CollectorStateStore.use(store => store.commit({ ...account, projectId: "legacy-project", adapterId: "codex", expectedRevision: 0,
      checkpoint: { ...account, projectId: "legacy-project", projectCreatedAt: "2026-09-10T00:00:00Z", adapterId: "codex", adapterVersion: "0.1.0",
        revision: 1, cursor: "legacy-cursor", rawObjects: [], updatedAt: "2026-09-10T00:00:00Z" } })))
    const before = await readFile(f.stateFile, "utf8")
    await f.run(Effect.scoped(Effect.gen(function*() {
      const journal = yield* f.open(), owner = yield* journal.claim(scope)
      expect(journal.binding.installationId).toBe(initial.installationId)
      yield* journal.reserve(owner, { id: "pending", expectedCheckpoint: null, rawEnabled: false, beginJson: "{}" })
      yield* journal.append(owner, "pending", { kind: "canonical", ordinal: 0, bytes: new TextEncoder().encode("frozen bytes") })
      yield* journal.seal(owner, "pending", { canonicalUnits: 1, rawUnits: 0, nextCheckpoint: "covered", manifestJson: "{}" })
    })))
    expect(await readFile(f.stateFile, "utf8")).toBe(before)
    await f.run(Effect.scoped(Effect.gen(function*() {
      const journal = yield* f.open(), owner = yield* journal.claim(scope)
      expect(new TextDecoder().decode(yield* journal.read(owner, "pending", "canonical", 0))).toBe("frozen bytes")
      expect(owner.checkpoint).toBeNull()
    })))
    for (const file of [f.stateFile, `${f.stateFile}.capture-installation.json`, ...await f.files()]) expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(`${f.stateFile}.captures`)).mode & 0o777).toBe(0o700)
  })
  it("isolates accounts and preserves journal resource lifetime and owner fencing", async () => {
    const f = await fixture()
    const escaped = await f.run(Effect.scoped(Effect.gen(function*() {
      const first = yield* f.open(), owner = yield* first.claim(scope)
      const second = yield* f.open()
      yield* second.claim(scope)
      expect((yield* first.coverage(owner).pipe(Effect.flip)).reason).toBe("conflict")
      const other = yield* f.open({ ...account, userId: "other-user" }), otherOwner = yield* other.claim(scope)
      expect(other.binding.installationId).toBe(first.binding.installationId)
      expect(otherOwner.epoch).toBe(1)
      return { journal: other, owner: otherOwner }
    })))
    await expect(Effect.runPromise(escaped.journal.coverage(escaped.owner))).rejects.toMatchObject({ reason: "io" })
    expect((await f.files()).filter(path => path.endsWith(".sqlite"))).toHaveLength(2)
  })
  it("does not create a new installation after Collector state disappears", async () => {
    const f = await fixture(); await f.initialize(); await rm(f.stateFile)
    await expect(f.initialize()).rejects.toMatchObject({ reason: "corrupt" })
    await expect(f.run(CollectorStateStore.use(store => store.snapshot(account.instanceOrigin, account.userId, "project", "codex")))).rejects.toMatchObject({ reason: "decode" })
    await expect(stat(f.stateFile)).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("rejects changed installation, account binding and unsupported metadata without rewriting them", async () => {
    for (const change of ["installation", "account", "format"] as const) {
      const f = await fixture(); await f.initialize()
      const file = change === "installation" ? f.stateFile : change === "account" ? (await f.files()).find(path => path.endsWith(".binding.json"))! : `${f.stateFile}.capture-installation.json`
      const data = JSON.parse(await readFile(file, "utf8"))
      if (change === "installation") data.installationId = "different-installation"
      else if (change === "account") data.userId = "wrong-user"
      else data.protocol = "unknown-version"
      const bytes = JSON.stringify(data)
      await writeFile(file, bytes)
      await expect(f.initialize()).rejects.toMatchObject({ reason: change === "format" ? "corrupt" : "binding" })
      expect(await readFile(file, "utf8")).toBe(bytes)
    }
  })
  it("never recreates an established missing journal, root or binding", async () => {
    for (const target of ["database", "root", "account-marker", "installation-marker"] as const) {
      const f = await fixture(); await f.initialize()
      const path = target === "database" ? (await f.files()).find(path => path.endsWith(".sqlite"))! :
        target === "root" ? `${f.stateFile}.captures` : target === "installation-marker" ? `${f.stateFile}.capture-installation.json` :
          (await f.files()).find(path => path.endsWith(".binding.json"))!
      await rm(path, { recursive: true })
      await expect(f.initialize()).rejects.toMatchObject({ reason: target === "installation-marker" ? "corrupt" : "missing" })
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
    }
  })
  it("preserves lost-account evidence even when both its database and marker disappear", async () => {
    const f = await fixture()
    await f.run(Effect.scoped(Effect.gen(function*() {
      const journal = yield* f.open(), owner = yield* journal.claim(scope)
      yield* journal.reserve(owner, { id: "pending", expectedCheckpoint: null, rawEnabled: false, beginJson: "{}" })
      yield* journal.append(owner, "pending", { kind: "canonical", ordinal: 0, bytes: new TextEncoder().encode("pending") })
    })))
    const registry = await readFile(`${f.stateFile}.capture-installation.json`, "utf8")
    for (const file of await f.files()) await rm(file)
    await expect(f.initialize()).rejects.toMatchObject({ reason: "missing" })
    expect(await f.files()).toEqual([])
    expect(await readFile(`${f.stateFile}.capture-installation.json`, "utf8")).toBe(registry)
  })
  it("rejects missing or unsupported coordination storage without recreating it", async () => {
    for (const missing of [true, false]) {
      const f = await fixture(); await f.initialize()
      const path = `${f.stateFile}.lock.sqlite`
      if (missing) await rm(path)
      else {
        const { DatabaseSync } = await import("node:sqlite")
        const database = new DatabaseSync(path)
        try { database.exec("PRAGMA user_version=99") } finally { database.close() }
      }
      await expect(f.initialize()).rejects.toMatchObject({ reason: "io" })
      if (missing) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
    }
  })
  it("resumes only never-exposed initialization and rejects corrupt partial SQLite", async () => {
    for (const point of ["before-marker", "before-database", "after-database", "after-marker", "corrupt-database"] as const) {
      const f = await fixture(); await f.initialize()
      const paths = await f.files(), database = paths.find(path => path.endsWith(".sqlite"))!, marker = paths.find(path => path.endsWith(".binding.json"))!
      const metadata = JSON.parse(await readFile(marker, "utf8")); metadata.phase = point === "after-marker" ? "ready" : "initializing"
      await writeFile(marker, JSON.stringify(metadata))
      const installationPath = `${f.stateFile}.capture-installation.json`
      const installation = JSON.parse(await readFile(installationPath, "utf8"))
      installation.accounts[0].phase = "initializing"
      await writeFile(installationPath, JSON.stringify(installation))
      if (point === "before-database" || point === "before-marker") await rm(database)
      if (point === "before-marker") await rm(marker)
      if (point === "corrupt-database") await writeFile(database, "incomplete sqlite")
      if (point === "corrupt-database") {
        await expect(f.initialize()).rejects.toMatchObject({ reason: "corrupt" })
        expect(await readFile(database, "utf8")).toBe("incomplete sqlite")
      } else {
        await f.initialize()
        expect(JSON.parse(await readFile(marker, "utf8")).phase).toBe("ready")
      }
    }
  })
  it("rechecks coordinator absence after another process completes first initialization", async () => {
    const f = await fixture()
    expect(await runChild("capture-bootstrap-race.ts", f.stateFile)).toMatchObject({ preserved: true })
  })
  it("holds identity writes through cancellation before allowing another caller to reopen", async () => {
    const f = await fixture()
    expect(await runChild("capture-bootstrap-cancellation.ts", f.stateFile)).toMatchObject({ preserved: true })
  })
  it.each([false, true])("serializes concurrent first opens with stale legacy lock %s", async (staleLock) => {
    const f = await fixture()
    if (staleLock) await writeFile(`${f.stateFile}.lock`, JSON.stringify({ pid: 2147483647 }))
    const opened = await Promise.all(Array.from({ length: 4 }, () => runChild("capture-bootstrap-contract.ts", f.stateFile)))
    expect(new Set(opened.map(binding => binding.installationId)).size).toBe(1)
    expect(opened.map(binding => binding.epoch).sort()).toEqual([1, 2, 3, 4])
    expect((await f.files()).filter(path => path.endsWith(".sqlite"))).toHaveLength(1)
  })
})
