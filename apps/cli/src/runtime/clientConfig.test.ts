import { ClientConfigStore, automaticUpdatesEnabled, inspectClient, setAutomaticUpdates, setClientLocale } from "@atape/application"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeConfigStoreLayer, readClientConfig, withClientConfigFileLock } from "./clientConfig.ts"
import { runtimeWriterFixture } from "./fixtures/runtime-writer-admission.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { makeSelectedConfigStoreLayer } from "./runtimeSelection.ts"

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("automatic update configuration compatibility", () => {
  it("refuses an already-open old console through its selected configuration Interface after the reader floor advances", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-old-console-config-"))
    temporaryDirectories.push(root)
    const f = await runtimeWriterFixture(root), paths = defaultNodeClientPaths({ ATAPE_HOME: root })
    const layer = makeSelectedConfigStoreLayer(paths, f.runtime)
    await Effect.runPromise(setClientLocale("en").pipe(Effect.provide(layer)))
    const before = await readFile(paths.configFile)
    await f.raiseFloor()
    await expect(Effect.runPromise(setClientLocale("zh-CN").pipe(Effect.provide(layer)))).rejects.toThrow(/reopen ATape/)
    expect(await readFile(paths.configFile)).toEqual(before)
    await Effect.runPromise(setClientLocale("zh-CN").pipe(Effect.provide(makeSelectedConfigStoreLayer(paths, f.nextRuntime))))
    expect((await Effect.runPromise(readClientConfig(paths.configFile))).locale).toBe("zh-CN")
  })

  it("rechecks admission at commit when the floor changes during a configuration transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-inflight-config-"))
    temporaryDirectories.push(root)
    const f = await runtimeWriterFixture(root), path = join(root, "client.json")
    const layer = makeConfigStoreLayer(path, f.runtime)
    await Effect.runPromise(setClientLocale("en").pipe(Effect.provide(layer)))
    const before = await readFile(path)
    let entered!: () => void, finish!: () => void
    const started = new Promise<void>(done => { entered = done })
    const held = new Promise<void>(done => { finish = done })
    const transaction = Effect.runPromise(ClientConfigStore.use(store => store.transact(config =>
      Effect.promise(async () => { entered(); await held; return { value: undefined, config: { ...config, locale: "zh-CN" } } })
    )).pipe(Effect.provide(layer))).then(() => undefined, error => error)
    await started
    try { await f.raiseFloor() } finally { finish() }
    expect(await transaction).toMatchObject({ _tag: "ClientConfigStoreError" })
    expect(await readFile(path)).toEqual(before)
    // Rejection releases both the native config lock and the admission barrier.
    await Effect.runPromise(setClientLocale("zh-CN").pipe(Effect.provide(makeConfigStoreLayer(path, f.nextRuntime))))
    expect((await Effect.runPromise(readClientConfig(path))).locale).toBe("zh-CN")
  })

  it("reads existing version 3 configuration with updates enabled and round trips an explicit opt out", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-update-config-"))
    temporaryDirectories.push(root)
    const path = join(root, "client.json")
    const original = { version: 3, projects: [], adapters: [], toolsConfigured: true, enabledAdapterIds: [], locale: "zh-CN" }
    const encoded = JSON.stringify(original)
    await writeFile(path, encoded)
    expect(automaticUpdatesEnabled(await Effect.runPromise(readClientConfig(path)))).toBe(true)
    expect(await readFile(path, "utf8")).toBe(encoded)

    await Effect.runPromise(setAutomaticUpdates(false).pipe(Effect.provide(makeConfigStoreLayer(path))))
    expect(await Effect.runPromise(readClientConfig(path))).toEqual({ ...original, autoUpdateEnabled: false })
    const reopened = await Effect.runPromise(inspectClient().pipe(Effect.provide(makeConfigStoreLayer(path))))
    expect(automaticUpdatesEnabled(reopened)).toBe(false)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...original, autoUpdateEnabled: false })
  })

  it("serializes native runtime selection with the same lock as Effect config transactions", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-update-config-lock-"))
    temporaryDirectories.push(root)
    const path = join(root, "client.json")
    const events: string[] = []
    let transaction: Promise<void> | undefined
    await withClientConfigFileLock(path, async () => {
      events.push("native selection")
      transaction = Effect.runPromise(Effect.gen(function*() {
        const store = yield* ClientConfigStore
        yield* store.transact(config => Effect.sync(() => {
          events.push("config transaction")
          return { value: undefined, config: { ...config, autoUpdateEnabled: false } }
        }))
      }).pipe(Effect.provide(makeConfigStoreLayer(path))))
      await new Promise(done => setTimeout(done, 75))
      events.push("selection completed")
    })
    await transaction
    expect(events).toEqual(["native selection", "selection completed", "config transaction"])
    expect((await Effect.runPromise(readClientConfig(path))).autoUpdateEnabled).toBe(false)
  })

  it("releases the native config lock when selection work fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-update-config-lock-"))
    temporaryDirectories.push(root)
    const path = join(root, "client.json")
    const cause = new Error("selection failed")
    await expect(withClientConfigFileLock(path, async () => { throw cause })).rejects.toBe(cause)
    await expect(withClientConfigFileLock(path, async () => "recovered")).resolves.toBe("recovered")
  })

  it("bounds native lock admission by the supplied wait even if the wall clock moves backwards", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-update-config-lock-"))
    temporaryDirectories.push(root)
    const path = join(root, "client.json")
    await withClientConfigFileLock(path, async () => {
      let clock = Date.now()
      const wallClock = vi.spyOn(Date, "now").mockImplementation(() => { clock -= 60_000; return clock })
      try {
        await expect(withClientConfigFileLock(path, async () => "must not enter", 25)).rejects.toMatchObject({ code: "EEXIST" })
      } finally { wallClock.mockRestore() }
    })
    await expect(withClientConfigFileLock(path, async () => "released", 0)).resolves.toBe("released")
  })
})
