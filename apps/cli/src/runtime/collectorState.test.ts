import { CollectorStateStore } from "@atape/application"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { makeCollectorStateLayer } from "./collectorState.ts"
import { runtimeWriterFixture } from "./fixtures/runtime-writer-admission.ts"

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const account = { instanceOrigin: "https://atape.test", userId: "user", projectId: "project", adapterId: "claude" }
const checkpoint = { ...account, projectCreatedAt: "2026-10-10T00:00:00Z", adapterVersion: "0.5.5", revision: 1,
  cursor: "covered", rawObjects: [], updatedAt: "2026-10-10T00:00:00Z" }
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "atape-state-admission-")); homes.push(home)
  const f = await runtimeWriterFixture(home), stateFile = join(f.runtime.home, "state", "collector.json")
  const run = <A, E>(work: Effect.Effect<A, E, CollectorStateStore>, runtime = f.runtime) =>
    Effect.runPromise(work.pipe(Effect.provide(makeCollectorStateLayer(stateFile, runtime))))
  const snapshot = CollectorStateStore.use(store => store.snapshot(account.instanceOrigin, account.userId, account.projectId, account.adapterId))
  const commit = CollectorStateStore.use(store => store.commit({ ...account, expectedRevision: 0, checkpoint }))
  return { ...f, stateFile, run, snapshot, commit }
}

describe("Collector state runtime admission through its caller Interface", () => {
  it("refuses first initialization below the floor before creating Collector coordination or identity", async () => {
    const f = await fixture(); await f.raiseFloor()
    await expect(f.run(f.snapshot)).rejects.toMatchObject({ reason: "io" })
    for (const path of [f.stateFile, `${f.stateFile}.lock.sqlite`]) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves state bytes after the floor changes and admits the current same-contract writer", async () => {
    const f = await fixture(), initial = await f.run(f.snapshot), before = await readFile(f.stateFile)
    await f.raiseFloor()
    await expect(f.run(f.commit)).rejects.toMatchObject({ reason: "io" })
    expect(await readFile(f.stateFile)).toEqual(before)
    await f.run(f.commit, f.nextRuntime)
    expect(await f.run(f.snapshot, f.nextRuntime)).toEqual({ ...initial, checkpoint })
  })

  it("rechecks a commit after waiting for its existing Collector lock while the floor advances", async () => {
    const f = await fixture(); await f.run(f.snapshot)
    const before = await readFile(f.stateFile), blocker = new DatabaseSync(`${f.stateFile}.lock.sqlite`)
    blocker.exec("BEGIN EXCLUSIVE")
    let release = () => { blocker.exec("COMMIT"); blocker.close(); release = () => undefined }
    const pending = f.run(f.commit)
    // Exercise the actual existing coordination-lock wait, rather than a test
    // persistence Adapter that could miss the final guarded commit.
    await new Promise(resolve => setTimeout(resolve, 75))
    try { await f.raiseFloor() } finally { release() }
    await expect(pending).rejects.toMatchObject({ reason: "io" })
    expect(await readFile(f.stateFile)).toEqual(before)
  })
})
