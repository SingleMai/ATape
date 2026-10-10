import { emptyClientConfig, type ClientConfig } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ClientConfigStore, ClientConfigStoreError } from "./clientManagement.ts"
import { configureAutomaticUpdates, inspectUpdateWake, reconcileUpdateWake, UpdateWakeError, UpdateWakePlatform } from "./updateWake.ts"

const fixture = (initial: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, autoStartEnabled: false }) => {
  let config = structuredClone(initial), failSave = false, failNative = false
  const reconciliations: Array<{ enabled: boolean; saved: boolean | undefined }> = []
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => failSave
      ? Effect.fail(new ClientConfigStoreError({ reason: "io", message: "State unavailable" }))
      : change(structuredClone(config)).pipe(Effect.tap(result => Effect.sync(() => {
        if (result.config) config = structuredClone(result.config)
      })), Effect.map(result => result.value)) })),
    Layer.succeed(UpdateWakePlatform, UpdateWakePlatform.of({
      inspect: () => failNative ? Effect.fail(new UpdateWakeError({ reason: "manager", message: "Manager unavailable" }))
        : Effect.succeed({ state: "missing" }),
      reconcile: enabled => Effect.suspend(() => {
        reconciliations.push({ enabled, saved: config.autoUpdateEnabled })
        return failNative ? Effect.fail(new UpdateWakeError({ reason: "registration", message: "Registration unavailable" }))
          : Effect.succeed({ state: enabled ? "registered" : "missing" })
      })
    }))
  )
  return { run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
    config: () => config, reconciliations, failSave: () => { failSave = true }, failNative: () => { failNative = true } }
}

describe("periodic update wakeup through the Application Interface", () => {
  it("defaults on independently of login startup, projects and stopped collection", async () => {
    const client = fixture()
    expect(await client.run(inspectUpdateWake())).toEqual({ enabled: true, state: "missing" })
    expect(await client.run(reconcileUpdateWake())).toEqual({ state: "registered" })
    expect(client.reconciliations).toEqual([{ enabled: true, saved: undefined }])
    expect(client.config().autoStartEnabled).toBe(false)
  })

  it("does not enroll before initialization", async () => {
    const client = fixture(emptyClientConfig())
    expect(await client.run(reconcileUpdateWake())).toEqual({ state: "missing" })
    expect(client.reconciliations).toEqual([{ enabled: false, saved: undefined }])
  })

  it("persists disabled before a failed unregister and reports observed manager failure", async () => {
    const client = fixture()
    client.failNative()
    await expect(client.run(configureAutomaticUpdates(false))).rejects.toMatchObject({ reason: "registration" })
    expect(client.config().autoUpdateEnabled).toBe(false)
    expect(client.reconciliations).toEqual([{ enabled: false, saved: false }])
    expect(await client.run(inspectUpdateWake())).toEqual({ enabled: false, state: "unavailable", message: "Manager unavailable" })
  })

  it("does not alter native scheduling when saving preference fails", async () => {
    const client = fixture()
    client.failSave()
    await expect(client.run(configureAutomaticUpdates(false))).rejects.toMatchObject({ _tag: "ClientConfigStoreError" })
    expect(client.reconciliations).toEqual([])
  })

  it("retries registration even when the requested preference already matches", async () => {
    const client = fixture({ ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: true })
    await client.run(configureAutomaticUpdates(true))
    await client.run(configureAutomaticUpdates(true))
    expect(client.reconciliations).toEqual([{ enabled: true, saved: true }, { enabled: true, saved: true }])
  })
})
