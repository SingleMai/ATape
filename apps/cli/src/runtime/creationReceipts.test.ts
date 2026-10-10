import { Effect } from "effect"
import { mkdtemp, realpath, mkdir, rm, readdir, readFile, chmod, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { atomicJSON, runtimeEntry } from "./runtimeFiles.ts"
import { createUpdateControl, updateControlProtocol, type UpdateRuntimeSelection } from "./updateControl.ts"
import { afterEach, describe, expect, it } from "vitest"
import { makeCreationReceiptStore } from "./creationReceipts.ts"
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const fixture = async (adapterId = "../unsafe/name") => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-creation-receipts-"))); homes.push(home)
  const root = join(home, "native"); await mkdir(root, { mode: 0o700 })
  const store = makeCreationReceiptStore(home, adapterId), controller = new AbortController()
  const origin = { cwd: home, repositoryRemote: "git@github.com:example/repo.git" }
  const scope = store.scope(origin, Effect.void, controller.signal)
  const input = { sourceId: "fresh-id", stateDirectory: root, sourcePath: join(root, "projects", "fresh-id.jsonl"), profile: "synthetic.v1" }
  const prefix = { bytes: 10, rows: 1, sha256: "a".repeat(64) }
  return { home, root, store, controller, scope, origin, input, prefix, signal: controller.signal }
}
describe("Host creation receipts through the caller Interface", () => {
  it("stores immutable confirmation independent of Project, with hashed namespaces and private permissions", async () => {
    const f = await fixture(), attempt = await f.scope.creation.recordAttempt(f.input, f.signal)
    expect(await f.store.reader.readConfirmed(f.input, f.signal)).toBeUndefined()
    expect(Object.isFrozen(attempt)).toBe(true); expect(Object.isFrozen(attempt.origin)).toBe(true)
    const confirmed = await f.scope.creation.confirm({ prefix: f.prefix }, f.signal)
    await f.scope.creation.abandon(f.signal); await f.scope.finish()
    const restarted = makeCreationReceiptStore(f.home, "../unsafe/name")
    expect(await restarted.reader.readConfirmed(f.input, f.signal)).toEqual(confirmed)
    expect(f.scope.result({ sourceId: f.input.sourceId, creation: "confirmed", exitCode: 7 })).toEqual({ sourceId: "fresh-id", creation: "confirmed", exitCode: 7 })
    const directories = await readdir(join(f.home, "state", "creation-receipts")); expect(directories).toHaveLength(1); expect(directories[0]).toMatch(/^[0-9a-f]{64}$/)
  })
  it("does not create native paths and does not confirm crash-pending attempts on restart", async () => {
    const f = await fixture(); await f.scope.creation.recordAttempt(f.input, f.signal)
    expect(await readdir(f.root)).toEqual([])
    expect(await makeCreationReceiptStore(f.home, "../unsafe/name").reader.readConfirmed(f.input, f.signal)).toBeUndefined()
    await f.scope.finish()
    const next = f.store.scope(f.origin, Effect.void, f.signal)
    await expect(next.creation.recordAttempt(f.input, f.signal)).rejects.toThrow("reused")
  })
  it("claims a scope before awaiting and serializes confirm/abandon CAS", async () => {
    const f = await fixture()
    const first = f.scope.creation.recordAttempt(f.input, f.signal)
    await expect(f.scope.creation.recordAttempt({ ...f.input, sourceId: "other" }, f.signal)).rejects.toThrow("one creation")
    await first
    await f.scope.creation.abandon(f.signal)
    await expect(f.scope.creation.confirm({ prefix: f.prefix }, f.signal)).rejects.toThrow("pending")
    expect(await f.store.reader.readConfirmed(f.input, f.signal)).toBeUndefined()
  })
  it("joins already-started callbacks and refuses callbacks after Scope exit/cancellation", async () => {
    const f = await fixture(); await f.scope.creation.recordAttempt(f.input, f.signal)
    f.controller.abort(); await f.scope.finish()
    await expect(f.scope.creation.confirm({ prefix: f.prefix }, new AbortController().signal)).rejects.toThrow("active start scope")
    expect(await f.store.reader.readConfirmed(f.input, new AbortController().signal)).toBeUndefined()
  })
  it("revalidates selection before any persistent attempt and freezes origin against provider mutation", async () => {
    const f = await fixture(); const scope = f.store.scope(f.origin, Effect.fail(new Error("permission changed")) as never, f.signal)
    await expect(scope.creation.recordAttempt(f.input, f.signal)).rejects.toThrow("permission changed")
    expect(await f.store.reader.readConfirmed(f.input, f.signal)).toBeUndefined()
    f.origin.cwd = "/attacker"; await f.scope.creation.recordAttempt(f.input, f.signal)
    const confirmed = await f.scope.creation.confirm({ prefix: f.prefix }, f.signal)
    expect(confirmed.origin.cwd).toBe(f.home)
    expect(() => f.scope.result({ sourceId: "wrong", creation: "confirmed", exitCode: 0 })).toThrow("Host creation facts")
    expect(() => f.scope.result({ sourceId: f.input.sourceId, creation: "unconfirmed", exitCode: 0 })).toThrow("Host creation facts")
  })
  it.each(["../outside", "root", "noncanonical"])("rejects %s source path before persistence", async mode => {
    const f = await fixture(), sourcePath = mode === "../outside" ? join(f.home, "outside") : mode === "root" ? f.root : `${f.root}/projects/../file`
    await expect(f.scope.creation.recordAttempt({ ...f.input, sourcePath }, f.signal)).rejects.toThrow()
    expect(await f.store.reader.readConfirmed(f.input, f.signal)).toBeUndefined()
  })
  it("rejects symlink state roots and receipt files, corrupt UTF-8/JSON and exposed permissions", async () => {
    const f = await fixture(); await symlink(f.root, join(f.home, "link"))
    await expect(f.scope.creation.recordAttempt({ ...f.input, stateDirectory: join(f.home, "link") }, f.signal)).rejects.toThrow("canonical")
    const good = f.store.scope(f.origin, Effect.void, f.signal); await good.creation.recordAttempt(f.input, f.signal)
    const namespace = join(f.home, "state", "creation-receipts", (await readdir(join(f.home, "state", "creation-receipts")))[0]!)
    const file = join(namespace, (await readdir(namespace))[0]!)
    await chmod(file, 0o644); await expect(f.store.reader.readConfirmed(f.input, f.signal)).rejects.toThrow("Unsafe")
    await chmod(file, 0o600); await writeFile(file, Buffer.from([0xff])); await expect(f.store.reader.readConfirmed(f.input, f.signal)).rejects.toThrow()
    await rm(file); await symlink(join(f.home, "missing"), file); await expect(f.store.reader.readConfirmed(f.input, f.signal)).rejects.toThrow()
  })
})

it("checks runtime admission for directory creation and again for confirmation, without holding it during the session", async () => {
  const f = await fixture("test"), bootstrap = join(f.home, "bootstrap.mjs")
  await writeFile(bootstrap, "immutable bootstrap")
  const generation = async (version: string): Promise<UpdateRuntimeSelection> => {
    const entry = runtimeEntry(f.home, version); await mkdir(dirname(entry), { recursive: true }); await writeFile(entry, "// never executed")
    await atomicJSON(join(dirname(dirname(entry)), "package.json"), { name: "@atape/cli", version, atapeRuntime: { stateContract: "capture.v2", updateControlProtocol } })
    return { protocol: updateControlProtocol, version, captureStateContract: "capture.v2", bootstrapEntry: bootstrap,
      bootstrapIdentity: createHash("sha256").update(await readFile(bootstrap)).digest("hex"), adapters: [] }
  }
  const previous = await generation("0.5.5"), next = await generation("0.5.6"), control = createUpdateControl(f.home)
  const ticket = await control.prepare({ previous, next }); await control.begin(ticket)
  const store = makeCreationReceiptStore(f.home, "test", { home: f.home, identity: previous })
  const scope = store.scope(f.origin, Effect.void, f.signal)
  await scope.creation.recordAttempt(f.input, f.signal)
  // The whole live session holds no writer lease: the floor can advance now.
  await control.fence(ticket)
  await expect(scope.creation.confirm({ prefix: f.prefix }, f.signal)).rejects.toThrow("Runtime cannot")
  expect(await store.reader.readConfirmed(f.input, f.signal)).toBeUndefined()
  const fresh = makeCreationReceiptStore(f.home, "different", { home: f.home, identity: previous }).scope(f.origin, Effect.void, f.signal)
  const before = await readdir(join(f.home, "state", "creation-receipts"))
  await expect(fresh.creation.recordAttempt({ ...f.input, sourceId: "another" }, f.signal)).rejects.toThrow("Runtime cannot")
  expect(await readdir(join(f.home, "state", "creation-receipts"))).toEqual(before)
})

it("reads coherent immutable published receipts while concurrent scopes confirm their pending records", async () => {
  const f = await fixture("test")
  for (let n = 0; n < 24; n++) {
    const input = { ...f.input, sourceId: `source-${n}` }, scope = f.store.scope(f.origin, Effect.void, f.signal)
    const attempt = await scope.creation.recordAttempt(input, f.signal)
    const confirmation = scope.creation.confirm({ prefix: f.prefix }, f.signal)
    const reads = await Promise.all(Array.from({ length: 12 }, () => f.store.reader.readConfirmed(input, f.signal)))
    const confirmed = await confirmation
    for (const receipt of reads) if (receipt) { expect(receipt).toEqual(confirmed); expect(receipt.attemptId).toBe(attempt.attemptId) }
    expect(await f.store.reader.readConfirmed(input, f.signal)).toEqual(confirmed)
  }
})
it("rejects altered immutable attempt fields even when an on-disk attempt ID was retained", async () => {
  const f = await fixture(); await f.scope.creation.recordAttempt(f.input, f.signal)
  const base = join(f.home, "state", "creation-receipts"), namespace = join(base, (await readdir(base))[0]!), file = join(namespace, (await readdir(namespace))[0]!)
  const value = JSON.parse(await readFile(file, "utf8")); value.receipt.origin.cwd = "/changed"; await writeFile(file, JSON.stringify(value))
  await expect(f.scope.creation.confirm({ prefix: f.prefix }, f.signal)).rejects.toThrow("compare-and-set")
  expect(await f.store.reader.readConfirmed(f.input, f.signal)).toBeUndefined()
})

it("settles in-flight confirmation before reporting the Host's terminal creation fact", async () => {
  const f = await fixture(); await f.scope.creation.recordAttempt(f.input, f.signal)
  const confirming = f.scope.creation.confirm({ prefix: f.prefix }, f.signal)
  // Start the public confirmation work, then close the callback scope while it is in flight.
  await new Promise(resolve => setImmediate(resolve))
  await f.scope.finish(); await confirming
  expect(() => f.scope.result({ sourceId: f.input.sourceId, creation: "unconfirmed", exitCode: 0 })).toThrow("Host creation facts")
  expect(f.scope.result({ sourceId: f.input.sourceId, creation: "confirmed", exitCode: 0 }).creation).toBe("confirmed")
})
