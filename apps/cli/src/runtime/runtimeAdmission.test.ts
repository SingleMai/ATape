import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { atomicJSON, runtimeEntry } from "./runtimeFiles.ts"
import { createUpdateControl, updateControlProtocol, type UpdateRuntimeSelection } from "./updateControl.ts"
import { actualRuntimeIdentity, assertRuntimeDataAdmission, guardRuntimeWrite, runtimeContext,
  withRuntimeWriteBarrier, type RuntimeContext } from "./runtimeAdmission.ts"

const homes: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const mapped = (cause: unknown) => new Error(`Runtime write rejected: ${cause instanceof Error ? cause.message : String(cause)}`)
const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-runtime-admission-")))
  homes.push(home)
  const bootstrap = join(home, "bootstrap.js")
  await writeFile(bootstrap, "immutable fixture bootstrap\n")
  const bootstrapIdentity = createHash("sha256").update(await readFile(bootstrap)).digest("hex")
  const generation = async (version: string): Promise<UpdateRuntimeSelection> => {
    const entry = runtimeEntry(home, version)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "// immutable fixture; never executed\n")
    await atomicJSON(join(dirname(dirname(entry)), "package.json"), { name: "@atape/cli", version,
      atapeRuntime: { stateContract: "capture.v2", updateControlProtocol } })
    return { protocol: updateControlProtocol, version, captureStateContract: "capture.v2",
      bootstrapEntry: bootstrap, bootstrapIdentity, adapters: [] }
  }
  const previous = await generation("0.5.5"), next = await generation("0.5.6"), control = createUpdateControl(home)
  const ticket = await control.prepare({ next, previous })
  await control.begin(ticket)
  const old: RuntimeContext = { home, identity: previous }, current: RuntimeContext = { home, identity: next }
  return { home, old, current, control, fence: () => control.fence(ticket) }
}

describe("runtime write admission through the Effect caller Interface", () => {
  it("uses the executable identity and rejects a stale same-contract reader despite direct-entry environment flags", async () => {
    const f = await fixture()
    expect(runtimeContext(f.home)).toEqual({ home: f.home, identity: actualRuntimeIdentity })
    expect(Object.isFrozen(actualRuntimeIdentity)).toBe(true)
    await assertRuntimeDataAdmission(f.old)
    await f.fence()
    vi.stubEnv("ATAPE_RUNTIME_DIRECT", "1")
    vi.stubEnv("ATAPE_CLI_VERSION", f.current.identity.version)
    await expect(assertRuntimeDataAdmission(f.old)).rejects.toMatchObject({ reason: "admission" })
    await assertRuntimeDataAdmission(f.current)
    for (const version of ["latest", "development-preview", "0.5.6-beta"]) {
      await expect(assertRuntimeDataAdmission({ ...f.current, identity: { ...f.current.identity, version } })).rejects.toBeDefined()
    }
  })

  it("does not begin a refused write and maps only the admission acquisition failure", async () => {
    const f = await fixture(), path = join(f.home, "configuration.json"), called = vi.fn()
    await writeFile(path, "unchanged\n")
    await f.fence()
    const write = Effect.promise(async () => { called(); await writeFile(path, "stale overwrite\n") })
    await expect(Effect.runPromise(guardRuntimeWrite(f.old, write, mapped))).rejects.toThrow("Runtime write rejected")
    expect(called).not.toHaveBeenCalled()
    expect(await readFile(path, "utf8")).toBe("unchanged\n")
    await Effect.runPromise(guardRuntimeWrite(f.current, Effect.promise(() => writeFile(path, "new reader\n")), mapped))
    expect(await readFile(path, "utf8")).toBe("new reader\n")
  })

  it("releases the barrier when the admitted operation fails without remapping its failure", async () => {
    const f = await fixture(), operation = new Error("actual storage failed"), mapError = vi.fn(mapped)
    await expect(Effect.runPromise(guardRuntimeWrite(f.old, Effect.fail(operation), mapError))).rejects.toThrow("actual storage failed")
    expect(mapError).not.toHaveBeenCalled()
    const release = await f.control.acquireRuntimeWrite(f.old.identity, 0)
    release()
    await f.fence()
  })

  it("joins an in-flight write on interruption before releasing the floor-changing barrier", async () => {
    const f = await fixture(), active = new AbortController(), order: string[] = []
    let started = false, finish!: () => void
    const ready = new Promise<void>(resolve => { finish = resolve })
    const program = guardRuntimeWrite(f.old, Effect.promise(async () => {
      started = true
      await ready
      await writeFile(join(f.home, "checkpoint.json"), "settled before floor\n")
      order.push("write")
    }), mapped)
    const pending = Effect.runPromise(program, { signal: active.signal })
    const settled = pending.then(() => "done", () => "interrupted")
    await vi.waitFor(() => expect(started).toBe(true))
    active.abort()
    const floor = f.fence().then(() => { order.push("floor") })
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(order).toEqual([])
    } finally { finish() }
    await settled
    await floor
    expect(order).toEqual(["write", "floor"])
    expect(await readFile(join(f.home, "checkpoint.json"), "utf8")).toBe("settled before floor\n")
  })

  it("closes an existing SQLite resource under the barrier even after logical writes lose admission", async () => {
    const f = await fixture(), db = new DatabaseSync(join(f.home, "journal.sqlite"))
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT); INSERT INTO records VALUES('admitted')")
    await f.fence()
    try {
      await expect(Effect.runPromise(guardRuntimeWrite(f.old, Effect.sync(() => db.exec("INSERT INTO records VALUES('stale')")), mapped)))
        .rejects.toThrow("Runtime write rejected")
      expect(db.prepare("SELECT value FROM records").all()).toEqual([{ value: "admitted" }])
    } finally {
      await Effect.runPromise(withRuntimeWriteBarrier(f.old, Effect.sync(() => db.close()), mapped))
    }
    expect(() => db.prepare("SELECT value FROM records")).toThrow()
    const release = await f.control.acquireRuntimeWrite(f.current.identity, 0)
    release()
  })

  it("retains source-fixture behavior only for the literal development identity", async () => {
    const f = await fixture(), development = { ...f.old, identity: { ...f.old.identity, version: "development" } }
    await f.fence()
    await assertRuntimeDataAdmission(development)
    expect(await Effect.runPromise(guardRuntimeWrite(development, Effect.succeed("source fixture"), mapped))).toBe("source fixture")
    await expect(Effect.runPromise(guardRuntimeWrite({ ...development, identity: { ...development.identity, version: "Development" } },
      Effect.succeed("must not run"), mapped))).rejects.toThrow("Runtime write rejected")
  })
})
