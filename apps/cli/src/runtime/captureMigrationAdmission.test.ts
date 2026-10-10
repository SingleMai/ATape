import { spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { connect } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { Effect } from "effect"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { createCaptureMigrationCoordinator } from "./captureMigration.ts"
import { acquireCaptureMigrationWriteAuthority, captureMigrationFiles, guardCaptureMigrationWrite, guardCaptureRuntimeWrite,
  migrationError, readCaptureMigrationPair, type CaptureMigrationAttempt } from "./captureMigrationAdmission.ts"
import { migrateCaptureJournalV7ToV8 } from "./captureJournal.ts"
import { createUpdateControl } from "./updateControl.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { atomicJSON } from "./runtimeFiles.ts"
import { runtimeEntry } from "./runtimeFiles.ts"
import { createHistoricalCaptureMigrationState } from "./fixtures/capture-migration-state.ts"
import { compileCaptureFixtureEntry, prepareManagedCaptureFixture, journalVersion, captureV2 } from "./fixtures/managed-capture-update.ts"

const roots: string[] = []
let builds: string, targetPackage: string, sourceEntry: string, orphanEntry: string, targetVersion: string
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, any>
beforeAll(async () => {
  builds = await mkdtemp(join(tmpdir(), "atape-migration-authority-built-"))
  targetPackage = join(builds, "target"); sourceEntry = join(builds, "source", "coordinator.mjs"); orphanEntry = join(builds, "orphan.mjs")
  const manifest = await json(fileURLToPath(new URL("../../package.json", import.meta.url)))
  targetVersion = manifest.version
  await mkdir(targetPackage); await atomicJSON(join(targetPackage, "package.json"), manifest)
  await Promise.all([compileCaptureFixtureEntry(join(targetPackage, "dist", "atape.js"), "target", targetVersion),
    compileCaptureFixtureEntry(sourceEntry, "coordinator", "0.0.1"),
    build({ entryPoints: [fileURLToPath(new URL("./fixtures/capture-migration-orphan.ts", import.meta.url))], outfile: orphanEntry,
      bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
      define: { __ATAPE_CLI_VERSION__: JSON.stringify(targetVersion), __ATAPE_CAPTURE_STATE_CONTRACT__: JSON.stringify(captureV2) } })])
}, 30_000)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
afterAll(async () => { await rm(builds, { recursive: true, force: true }) })
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-migration-authority-")); roots.push(root)
  return prepareManagedCaptureFixture(root, targetPackage, sourceEntry)
}
const owned = async <A>(home: string, work: () => Promise<A>) => {
  const release = await acquireUpdateWorker(home)
  if (!release) throw new Error("Fixture update ownership is busy")
  try { return await work() } finally { release() }
}
const pending = async (f: Awaited<ReturnType<typeof fixture>>) => {
  await f.invoke("interrupt-after-fence")
  const migration = createCaptureMigrationCoordinator(f.paths, f.environment), outer = await migration.pendingOuter()
  if (!outer) throw new Error("Expected a real authorized pending migration")
  return { migration, outer, runtime: { home: await realpath(f.paths.atapeHome), identity: { version: f.target.version, captureStateContract: captureV2 } } }
}

it("replays real v7 SQL committed without Module progress and preserves genuine 0.5.3 Canonical/Raw obligations", async () => {
  const f = await fixture()
  await rm(`${f.paths.collectorStateFile}.captures`, { recursive: true }); await rm(`${f.paths.collectorStateFile}.capture-installation.json`)
  const historical = await createHistoricalCaptureMigrationState(f.paths)
  try {
    expect(historical.proof.tag).toBe("v0.5.3")
    const { migration, outer, runtime } = await pending(f)
    const first = await owned(f.paths.atapeHome, () => migration.nextAttempt(outer))
    const requirement = (await readCaptureMigrationPair(f.paths.atapeHome)).known!.requirement, account = requirement.inventory[0]!
    // A crash-state fixture through the same narrow caller Interface: commit the
    // actual DDL, then end Scope before Module progress. No SIGKILL claim here.
    expect(await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const authority = yield* acquireCaptureMigrationWriteAuthority(runtime, first)
      return yield* migrateCaptureJournalV7ToV8({ path: account.path, binding: historical.binding, runtime }, authority)
    })))).toMatchObject({ before: 7, after: 8 })
    expect(journalVersion(historical.path)).toBe(8)
    expect((await readCaptureMigrationPair(f.paths.atapeHome)).ledger?.progress).toEqual([])
    await owned(f.paths.atapeHome, async () => {
      const fresh = createCaptureMigrationCoordinator(f.paths, f.environment), second = await fresh.nextAttempt(outer)
      expect(second.attemptId).not.toBe(first.attemptId)
      await fresh.executeApply(second, AbortSignal.timeout(20_000))
      await createUpdateControl(f.paths.atapeHome).complete({ key: outer.key })
    })
    expect(await historical.snapshotCurrent(runtime)).toEqual(historical.before)
    expect(await migration.recoveryPending()).toBe(false)
  } finally { await historical.cleanup() }
}, 30_000)

it("binds a scoped authority to its exact journal and rejects a forged or revoked authority before writes", async () => {
  const f = await fixture(), { migration, outer, runtime } = await pending(f), attempt = await owned(f.paths.atapeHome, () => migration.nextAttempt(outer))
  const untouched = join(f.root, "untouched.sqlite"); await cp(f.journalPath, untouched)
  const before = await readFile(untouched)
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const authority = yield* acquireCaptureMigrationWriteAuthority(runtime, attempt)
    const account = (yield* Effect.promise(() => readCaptureMigrationPair(runtime.home))).known!.requirement.inventory[0]!
    expect(yield* migrateCaptureJournalV7ToV8({ path: untouched, binding: account.binding!, runtime }, authority).pipe(Effect.flip)).toMatchObject({ reason: "binding" })
    yield* Effect.promise(() => owned(runtime.home, () => migration.nextAttempt(outer)))
    expect(yield* guardCaptureMigrationWrite(authority, Effect.tryPromise({ try: () => writeFile(untouched, "changed"), catch: migrationError }), migrationError).pipe(Effect.flip))
      .toMatchObject({ reason: "stale-attempt" })
  })))
  expect(await readFile(untouched)).toEqual(before)
  await expect(Effect.runPromise(guardCaptureMigrationWrite({} as any, Effect.void, migrationError))).rejects.toMatchObject({ reason: "stale-attempt" })
})

it.each(["required", "ledger"] as const)("recovers a missing %s peer only through its known fenced plan", async peer => {
  const f = await fixture(), { migration, outer, runtime } = await pending(f), files = captureMigrationFiles(f.paths.atapeHome)
  await rm(files[peer])
  let wrote = false
  await expect(Effect.runPromise(guardCaptureRuntimeWrite(runtime, Effect.sync(() => { wrote = true }), migrationError))).rejects.toMatchObject({ reason: "conflict" })
  expect(wrote).toBe(false); expect(await migration.recoveryPending()).toBe(true)
  await owned(runtime.home, async () => {
    const attempt = await migration.nextAttempt(outer)
    await migration.executeApply(attempt, AbortSignal.timeout(20_000))
    await createUpdateControl(runtime.home).complete({ key: outer.key })
  })
  expect(await migration.recoveryPending()).toBe(false)
  expect(journalVersion(f.journalPath)).toBe(8)
})

it("fails closed on unknown metadata without changing an already opened journal's data", async () => {
  const f = await fixture(), { runtime } = await pending(f), files = captureMigrationFiles(runtime.home)
  const before = await readFile(f.journalPath), ledger = await json(files.ledger)
  await atomicJSON(files.ledger, { ...ledger, protocol: "atape.capture-migration.v999" })
  let wrote = false
  await expect(Effect.runPromise(guardCaptureRuntimeWrite(runtime, Effect.sync(() => { wrote = true }), migrationError))).rejects.toMatchObject({ reason: "metadata" })
  expect(wrote).toBe(false); expect(await readFile(f.journalPath)).toEqual(before)
})

it("keeps capture gated when a marker-unaware worker completes only the outer transaction", async () => {
  const f = await fixture(), { migration, outer, runtime } = await pending(f)
  await owned(runtime.home, () => createUpdateControl(runtime.home).complete({ key: outer.key }))
  expect(await createUpdateControl(runtime.home).recoveryPending()).toBe(false)
  expect(await migration.recoveryPending()).toBe(true)
  let wrote = false
  await expect(Effect.runPromise(guardCaptureRuntimeWrite(runtime, Effect.sync(() => { wrote = true }), migrationError))).rejects.toMatchObject({ reason: "conflict" })
  expect(wrote).toBe(false); expect(journalVersion(f.journalPath)).toBe(7)
  await owned(runtime.home, async () => { const attempt = await migration.nextAttempt(outer); await migration.executeApply(attempt, AbortSignal.timeout(20_000)) })
  expect(await migration.recoveryPending()).toBe(false); expect(journalVersion(f.journalPath)).toBe(8)
})

it("recognizes the marker-first successor crash state and restores its prior completed receipt before fence", async () => {
  const f = await fixture(); await f.invoke("activate")
  const files = captureMigrationFiles(f.paths.atapeHome), priorLedger = await readFile(files.ledger), priorRequirement = await json(files.required)
  const manifest = await json(join(targetPackage, "package.json")), parts = targetVersion.split(".").map(Number)
  const newer = `${parts[0]}.${parts[1]}.${parts[2]! + 1}`, entry = runtimeEntry(f.paths.atapeHome, newer), coordinator = join(f.root, "same-contract-coordinator.mjs")
  await atomicJSON(join(dirname(dirname(entry)), "package.json"), { ...manifest, version: newer })
  await Promise.all([compileCaptureFixtureEntry(entry, "target", newer), compileCaptureFixtureEntry(coordinator, "coordinator", targetVersion, captureV2)])
  const payload = await json(f.payloadFile), target = { ...f.target, version: newer }
  await atomicJSON(f.payloadFile, { ...payload, source: f.target, candidate: { ...payload.candidate,
    selection: target, baselineSelection: f.target, bundle: { ...payload.candidate.bundle, version: newer,
      packages: payload.candidate.bundle.packages.map((item: { name: string; tarball: string }) => ({ ...item,
        tarball: `https://registry.npmjs.org/${item.name}/-/${item.name.slice("@atape/".length)}-${newer}.tgz` })) } } })
  await f.invoke("interrupt-before-fence", coordinator)
  // Explicit crash-state fixture: the successor marker persisted but its ledger
  // replacement did not. Both bytes come from completed public operations.
  await writeFile(files.ledger, priorLedger)
  expect(await createCaptureMigrationCoordinator(f.paths, f.environment).recoveryPending()).toBe(true)
  expect(await f.invoke("recover", coordinator)).toEqual({ recovered: true })
  expect((await json(files.required)).requirement).toEqual(priorRequirement.requirement)
  expect((await json(files.ledger)).phase).toBe("completed")
  expect(journalVersion(f.journalPath)).toBe(8)
  expect(await createCaptureMigrationCoordinator(f.paths).recoveryPending()).toBe(false)
}, 30_000)

it("defers never-exposed initialization without creating a missing account marker or database", async () => {
  const f = await fixture(), root = `${f.paths.collectorStateFile}.captures`, installationFile = `${f.paths.collectorStateFile}.capture-installation.json`
  const installation = await json(installationFile), account = installation.accounts[0]
  await atomicJSON(installationFile, { ...installation, accounts: [{ ...account, phase: "initializing" }] })
  await Promise.all([rm(join(root, `${account.key}.binding.json`)), ...[f.journalPath, `${f.journalPath}-wal`, `${f.journalPath}-shm`].map(path => rm(path, { force: true }))])
  await f.invoke("activate")
  expect((await json(captureMigrationFiles(f.paths.atapeHome).ledger)).receipt.accounts).toMatchObject([{ result: "deferred-initialization" }])
  await expect(readFile(f.journalPath)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(join(root, `${account.key}.binding.json`))).rejects.toMatchObject({ code: "ENOENT" })
  const writer = join(f.root, "initialized-by-target.mjs")
  await compileCaptureFixtureEntry(writer, "coordinator", targetVersion, captureV2)
  expect(await f.invoke("write", writer)).toMatchObject({ checkpoint: null, epoch: 1 })
  expect(journalVersion(f.journalPath)).toBe(8)
}, 30_000)

it("keeps a completed receipt usable after a real same-contract manual bootstrap rebind", async () => {
  const f = await fixture(); await f.invoke("activate")
  const files = captureMigrationFiles(f.paths.atapeHome), oldReceipt = await readFile(files.ledger), manifest = await json(join(targetPackage, "package.json"))
  const parts = targetVersion.split(".").map(Number), newer = `${parts[0]}.${parts[1]}.${parts[2]! + 1}`
  await compileCaptureFixtureEntry(f.bootstrap, "target", newer)
  await atomicJSON(join(dirname(dirname(f.bootstrap)), "package.json"), { ...manifest, version: newer })
  const rebound = await owned(f.paths.atapeHome, () => createUpdateControl(f.paths.atapeHome).rebindBootstrap())
  expect(rebound.version).toBe(newer); expect(rebound.bootstrapIdentity).not.toBe(f.target.bootstrapIdentity)
  const runtime = { home: await realpath(f.paths.atapeHome), identity: { version: newer, captureStateContract: captureV2 } }
  await expect(Effect.runPromise(guardCaptureRuntimeWrite(runtime, Effect.succeed("written"), migrationError))).resolves.toBe("written")
  expect(await readFile(files.ledger)).toEqual(oldReceipt)
  await rm(files.required)
  const migration = createCaptureMigrationCoordinator(f.paths, f.environment)
  expect(await migration.pendingOuter()).toMatchObject({ completed: true })
  expect(await owned(runtime.home, () => migration.repairCompletedRequirement())).toBe(true)
  await expect(Effect.runPromise(guardCaptureRuntimeWrite(runtime, Effect.succeed("again"), migrationError))).resolves.toBe("again")
  await expect(Effect.runPromise(guardCaptureRuntimeWrite({ ...runtime, identity: { version: targetVersion, captureStateContract: captureV2 } }, Effect.void, migrationError))).rejects.toBeDefined()
})

it("excludes a real orphan apply process, revokes its next commit, and resumes after its lock closes", async () => {
  const f = await fixture(), { migration, outer, runtime } = await pending(f)
  const first = await owned(runtime.home, () => migration.nextAttempt(outer)), socketPath = join(tmpdir(), `atape-mig-${first.attemptId}.sock`)
  const payload = join(f.root, "orphan.json"), proofFile = join(f.root, "old-child-commit")
  await atomicJSON(payload, { home: runtime.home, attempt: first, socket: socketPath, proofFile })
  const parent = spawn(process.execPath, [orphanEntry, "parent", payload], { env: f.environment, stdio: ["ignore", "pipe", "pipe"] })
  let childPid: number | undefined
  const errors: Buffer[] = []; parent.stderr.on("data", chunk => errors.push(chunk))
  try {
    const ready = await new Promise<{ childPid: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Orphan fixture readiness timed out: ${Buffer.concat(errors)}`)), 10_000)
      parent.stdout.once("data", bytes => { clearTimeout(timeout); resolve(JSON.parse(String(bytes))) })
      parent.once("exit", () => { clearTimeout(timeout); reject(new Error(`Orphan parent exited early: ${Buffer.concat(errors)}`)) })
    })
    childPid = ready.childPid
    const socket = connect(socketPath); await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject) })
    const exited = new Promise<void>(resolve => parent.once("exit", () => resolve())); parent.kill("SIGKILL"); await exited
    const second: CaptureMigrationAttempt = await owned(runtime.home, () => migration.nextAttempt(outer))
    await expect(Effect.runPromise(Effect.scoped(acquireCaptureMigrationWriteAuthority(runtime, second)))).rejects.toMatchObject({ reason: "busy" })
    const rejected = new Promise<Record<string, string>>((resolve, reject) => { socket.once("data", bytes => resolve(JSON.parse(String(bytes)))); socket.once("error", reject) })
    socket.write("commit\n")
    expect(await rejected).toEqual({ reason: "stale-attempt" })
    await owned(runtime.home, async () => { await migration.executeApply(second, AbortSignal.timeout(20_000)); await createUpdateControl(runtime.home).complete({ key: outer.key }) })
    await expect(readFile(proofFile)).rejects.toMatchObject({ code: "ENOENT" })
    expect(journalVersion(f.journalPath)).toBe(8)
  } finally {
    parent.kill("SIGKILL")
    if (childPid) { try { process.kill(childPid, "SIGKILL") } catch { /* already closed */ } }
    await rm(socketPath, { force: true })
  }
}, 30_000)
