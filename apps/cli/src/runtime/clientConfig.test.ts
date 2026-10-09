import { ClientConfigStore, automaticUpdatesEnabled, inspectClient, setAutomaticUpdates } from "@atape/application"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeConfigStoreLayer, readClientConfig, withClientConfigFileLock } from "./clientConfig.ts"

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("automatic update configuration compatibility", () => {
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
