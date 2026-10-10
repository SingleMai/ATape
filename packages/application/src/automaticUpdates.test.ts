import { emptyClientConfig, releasePackageNames, type ReleaseBundle, type AdapterInstallation, type ClientConfig } from "@atape/domain"
import { Effect, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { AutomaticUpdateError, AutomaticUpdatePlatform, kickAutomaticUpdates, runAutomaticUpdates,
  type PreparedAutomaticUpdate } from "./automaticUpdates.ts"
import { ClientConfigStore, ClientConfigStoreError } from "./clientManagement.ts"

const bundle = (version = "0.5.2"): ReleaseBundle => ({
  protocol: "atape.release-bundle.v1", version, captureStateContract: "atape.client.v3-capture.v2", updateControlProtocol: "atape.update-control.v1",
  packages: releasePackageNames.map(name => ({ name, integrity: `sha512-${"A".repeat(86) + "=="}`,
    tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` }))
})
const Hour = 60 * 60 * 1_000
const adapter = (id: string, version = "0.5.1", upgradeSpec = `@atape/adapter-${id}`): AdapterInstallation => ({
  adapterId: id, packageName: `@atape/adapter-${id}`, version, upgradeSpec, displayName: id,
  installedAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z"
})
type FailurePoint = "recoveryPending" | "supported" | "schedule" | "target" | "prepare" | "activate" | "record" | "launch"
type ScheduleRecord = Parameters<AutomaticUpdatePlatform["Service"]["record"]>[0]

const fixture = (options: {
  readonly config?: Partial<ClientConfig>
  readonly supported?: boolean
  readonly recoveryPending?: boolean
  readonly version?: string
  readonly schedule?: { readonly nextCheckAt: number; readonly failures: number }
} = {}) => {
  let config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, ...options.config }
  let schedule = options.schedule ?? { nextCheckAt: 0, failures: 0 }
  let onPrepare: (() => void) | undefined
  let badPrepared: "version" | "integrity" | undefined, badConfig = false, leases = 0, released = 0, targets = 0, launches = 0, supportChecks = 0, scheduleChecks = 0
  const errors = new Map<FailurePoint, AutomaticUpdateError>()
  const preparations: Array<{ bundle: ReleaseBundle; adapters: ReadonlyArray<AdapterInstallation>; automatic: boolean }> = []
  const preparationModes: boolean[] = []
  const activations: Array<{ prepared: PreparedAutomaticUpdate; automatic: boolean }> = []
  const records: ScheduleRecord[] = []
  const logs: unknown[] = []
  const perform = <A>(point: FailurePoint, work: () => A) => Effect.suspend(() => {
    const error = errors.get(point)
    return error ? Effect.fail(error) : Effect.sync(work)
  })
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => badConfig
      ? Effect.fail(new ClientConfigStoreError({ reason: "decode", message: "private config data" }))
      : change(structuredClone(config)).pipe(
        Effect.tap(result => Effect.sync(() => { if (result.config) config = structuredClone(result.config) })),
        Effect.map(result => result.value)) })),
    Layer.succeed(AutomaticUpdatePlatform, AutomaticUpdatePlatform.of({
      recoveryPending: () => perform("recoveryPending", () => options.recoveryPending === true),
      supported: () => perform("supported", () => { supportChecks++; return options.supported !== false }),
      schedule: () => perform("schedule", () => { scheduleChecks++; return schedule }),
      target: () => perform("target", () => { targets++; return bundle(options.version ?? "0.5.2") }),
      prepare: (selected, adapters, automatic) => Effect.suspend(() => {
        preparationModes.push(automatic)
        return perform("prepare", () => {
          preparations.push({ bundle: selected, adapters, automatic })
          onPrepare?.()
          return { bundle: badPrepared === "version" ? bundle("0.5.9") : badPrepared === "integrity" ? {
            ...selected, packages: selected.packages.map(item => ({ ...item, integrity: `sha512-${"B".repeat(84) + "AQ=="}` }))
          } : selected, key: "prepared-slot" }
        }).pipe(Effect.flatMap(prepared => Effect.acquireRelease(
          Effect.sync(() => { leases++; return prepared }), () => Effect.sync(() => { leases--; released++ }))))
      }),
      activate: (prepared, automatic) => perform("activate", () => {
        expect(leases).toBe(1)
        activations.push({ prepared, automatic })
      }),
      record: input => perform("record", () => { records.push(input); schedule = input }),
      launch: () => perform("launch", () => { launches++ })
    })),
    Logger.layer([Logger.make(options => { logs.push(options.message) })])
  )
  return {
    run: <A, E>(work: Effect.Effect<A, E, AutomaticUpdatePlatform | ClientConfigStore>) =>
      Effect.runPromise(work.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))),
    preparations, preparationModes, activations, records, logs,
    targets: () => targets, launches: () => launches, released: () => released, leases: () => leases,
    supportChecks: () => supportChecks, scheduleChecks: () => scheduleChecks,
    duringPreparation: (work: () => void) => { onPrepare = work },
    edit: (update: Partial<ClientConfig>) => { config = { ...config, ...update } },
    fail: (point: FailurePoint, reason: AutomaticUpdateError["reason"]) => {
      const error = new AutomaticUpdateError({ reason, message: "private token and source path" })
      errors.set(point, error)
      return error
    },
    corruptPrepared: (kind: "version" | "integrity" = "version") => { badPrepared = kind },
    corruptConfig: () => { badConfig = true }
  }
}

describe("automatic updates through the application Interface", () => {
  it.each([
    { config: { autoUpdateEnabled: false } },
    { config: { toolsConfigured: false } },
    { supported: false }
  ])("skips disabled, uninitialized and unsupported installations: %j", async options => {
    const client = fixture(options)
    expect(await client.run(runAutomaticUpdates("0.5.1"))).toEqual({ updated: false })
    await client.run(kickAutomaticUpdates())
    expect(client.targets()).toBe(0)
    expect(client.preparations).toEqual([])
    expect(client.records).toEqual([])
    expect(client.launches()).toBe(0)
  })

  it("dispatches startup maintenance without running a registry check or preparing a package", async () => {
    const client = fixture()
    await client.run(kickAutomaticUpdates())
    expect(client.launches()).toBe(1)
    expect(client.targets()).toBe(0)
    expect(client.preparations).toEqual([])
    expect(client.records).toEqual([])
  })

  it("does not probe npm ownership or dispatch an updater before the durable schedule is due", async () => {
    const client = fixture({ schedule: { nextCheckAt: Hour, failures: 0 } })
    await client.run(kickAutomaticUpdates())
    expect(client.scheduleChecks()).toBe(1)
    expect(client.supportChecks()).toBe(0)
    expect(client.launches()).toBe(0)
    expect(client.targets()).toBe(0)
    expect(client.preparations).toEqual([])
    expect(client.records).toEqual([])
  })

  it("dispatches interrupted recovery even when the ordinary update schedule cannot be read", async () => {
    const client = fixture({ recoveryPending: true, config: { autoUpdateEnabled: false } })
    client.fail("schedule", "state")
    await client.run(kickAutomaticUpdates())
    expect(client.supportChecks()).toBe(1)
    expect(client.launches()).toBe(1)
    expect(client.targets()).toBe(0)
    expect(client.preparations).toEqual([])
    expect(client.records).toEqual([])
    expect(client.logs).toEqual([])
  })

  it.each([{ autoUpdateEnabled: false }, { toolsConfigured: false }])("dispatches interrupted recovery without authorizing a new update: %j", async config => {
    const client = fixture({ config, recoveryPending: true })
    await client.run(kickAutomaticUpdates())
    expect(client.launches()).toBe(1)
    expect(await client.run(runAutomaticUpdates("0.5.1"))).toEqual({ updated: false })
    expect(client.targets()).toBe(0)
    expect(client.preparations).toEqual([])
    expect(client.activations).toEqual([])
    expect(client.records).toEqual([])
  })

  it("can dispatch interrupted recovery when configuration cannot be decoded", async () => {
    const client = fixture({ recoveryPending: true })
    client.corruptConfig()
    await expect(client.run(kickAutomaticUpdates())).resolves.toBeUndefined()
    expect(client.launches()).toBe(1)
    expect(client.targets()).toBe(0)
    expect(client.preparations).toEqual([])
    expect(client.activations).toEqual([])
    expect(client.records).toEqual([])
    expect(client.logs).toEqual([])
  })

  it("does not dispatch recovery to an unsupported installation", async () => {
    const client = fixture({ config: { autoUpdateEnabled: false }, recoveryPending: true, supported: false })
    await client.run(kickAutomaticUpdates())
    expect(client.launches()).toBe(0)
    expect(client.targets()).toBe(0)
    expect(client.preparations).toEqual([])
  })

  it("does not infer recovery permission when pending state cannot be read", async () => {
    const client = fixture({ config: { autoUpdateEnabled: false } })
    client.fail("recoveryPending", "state")
    await expect(client.run(kickAutomaticUpdates())).resolves.toBeUndefined()
    expect(client.launches()).toBe(0)
    expect(client.targets()).toBe(0)
    expect(client.preparations).toEqual([])
    expect(JSON.stringify(client.logs)).not.toMatch(/private|token|source path/)
  })

  it("keeps startup usable when dispatch or configuration fails without logging private errors", async () => {
    const client = fixture()
    client.fail("launch", "handoff")
    await expect(client.run(kickAutomaticUpdates())).resolves.toBeUndefined()
    client.corruptConfig()
    await expect(client.run(kickAutomaticUpdates())).resolves.toBeUndefined()
    expect(JSON.stringify(client.logs)).toContain("Automatic update launch unavailable")
    expect(JSON.stringify(client.logs)).not.toMatch(/private|token|source path/)
  })

  it("respects the durable schedule and never attempts development or lower CLI versions", async () => {
    const waiting = fixture({ schedule: { nextCheckAt: Hour, failures: 0 } })
    expect(await waiting.run(runAutomaticUpdates("0.5.1"))).toEqual({ updated: false })
    expect(waiting.targets()).toBe(0)
    const development = fixture()
    expect(await development.run(runAutomaticUpdates("development", true))).toEqual({ updated: false })
    expect(development.targets()).toBe(0)
    const ahead = fixture({ version: "0.5.1", config: { adapters: [adapter("codex", "0.4.0")] } })
    expect(await ahead.run(runAutomaticUpdates("0.5.2"))).toEqual({ updated: false, version: "0.5.2" })
    expect(ahead.preparations).toEqual([])
  })

  it("aligns a same-version bundle when an official Adapter lags, including disabled official packages", async () => {
    const installed = [adapter("codex", "0.5.1"), adapter("claude", "0.5.2")]
    const client = fixture({ config: { adapters: installed, enabledAdapterIds: ["codex"] } })
    expect(await client.run(runAutomaticUpdates("0.5.2"))).toEqual({ updated: true, version: "0.5.2" })
    expect(client.preparations).toEqual([{ bundle: bundle(), adapters: installed, automatic: true }])
    expect(client.activations).toEqual([{ prepared: { bundle: bundle(), key: "prepared-slot" }, automatic: true }])
    expect(client.leases()).toBe(0)
    expect(client.released()).toBe(1)
    expect(client.records[0]).toMatchObject({ failures: 0, version: "0.5.2" })
    expect(client.records[0]!.nextCheckAt).toBeGreaterThanOrEqual(24 * Hour)
    expect(client.records[0]!.nextCheckAt).toBeLessThanOrEqual(30 * Hour)
  })

  it("does not reinstall a complete current bundle and resets prior failures after a successful check", async () => {
    const client = fixture({ config: { adapters: [adapter("codex", "0.5.2")] },
      schedule: { nextCheckAt: 0, failures: 3 } })
    expect(await client.run(runAutomaticUpdates("0.5.2"))).toEqual({ updated: false, version: "0.5.2" })
    expect(client.preparations).toEqual([])
    expect(client.records[0]).toMatchObject({ failures: 0, version: "0.5.2" })
    expect(await client.run(runAutomaticUpdates("0.5.2"))).toEqual({ updated: false })
    expect(client.targets()).toBe(1)
  })

  it("leaves custom, pinned and local sources out of the release bundle", async () => {
    const official = adapter("codex")
    const client = fixture({ config: { adapters: [official, adapter("custom"),
      adapter("claude", "0.5.1", "file:/work/claude"), adapter("kimi", "0.5.1", "@atape/adapter-kimi@0.5.1"),
      adapter("grok", "0.5.1", "https://example.test/grok.tgz"),
      { ...adapter("opencode"), packageName: "@custom/opencode", upgradeSpec: "@custom/opencode" }] } })
    expect((await client.run(runAutomaticUpdates("0.5.1"))).updated).toBe(true)
    expect(client.preparations[0]!.adapters).toEqual([official])
  })

  it("skips the whole bundle if any managed official Adapter is ahead", async () => {
    const client = fixture({ config: { adapters: [adapter("codex", "0.5.3"), adapter("claude", "0.5.1")] } })
    expect(await client.run(runAutomaticUpdates("0.5.1"))).toEqual({ updated: false, version: "0.5.1" })
    expect(client.preparations).toEqual([])
    expect(client.activations).toEqual([])
  })

  it.each(["9.0.0-beta.1", "unknown", "01.2.3"])("preserves an incomparable managed Adapter version %s instead of risking a downgrade", async version => {
    const client = fixture({ config: { adapters: [adapter("codex", version), adapter("claude", "0.5.1")] } })
    expect(await client.run(runAutomaticUpdates("0.5.1", true))).toEqual({ updated: false, version: "0.5.1" })
    expect(client.preparations).toEqual([])
    expect(client.activations).toEqual([])
  })

  it.each([{ autoUpdateEnabled: false }, { toolsConfigured: false }])("rechecks policy after preparation: %j", async update => {
    const client = fixture()
    client.duringPreparation(() => client.edit(update))
    expect(await client.run(runAutomaticUpdates("0.5.1"))).toEqual({ updated: false })
    expect(client.preparations).toHaveLength(1)
    expect(client.activations).toEqual([])
    expect(client.records).toEqual([])
    expect(client.leases()).toBe(0)
    expect(client.released()).toBe(1)
  })

  it("allows a manual forced update with automatic updates off while still requiring initialization", async () => {
    const client = fixture({ config: { autoUpdateEnabled: false }, schedule: { nextCheckAt: Hour, failures: 0 } })
    expect((await client.run(runAutomaticUpdates("0.5.1", true))).updated).toBe(true)
    expect(client.preparationModes).toEqual([false])
    expect(client.activations[0]!.automatic).toBe(false)
    const uninitialized = fixture({ config: { toolsConfigured: false } })
    expect(await uninitialized.run(runAutomaticUpdates("0.5.1", true))).toEqual({ updated: false })
    expect(uninitialized.preparations).toEqual([])
  })

  it.each(["prepare", "activate"] as const)("treats an automatic %s cooldown as a normal check and closes prepared resources", async point => {
    const client = fixture({ schedule: { nextCheckAt: 0, failures: 3 } })
    client.fail(point, "cooldown")
    expect(await client.run(runAutomaticUpdates("0.5.1"))).toEqual({ updated: false, version: "0.5.1" })
    expect(client.preparationModes).toEqual([true])
    expect(client.activations).toEqual([])
    expect(client.records).toHaveLength(1)
    expect(client.records[0]).toEqual({ nextCheckAt: expect.any(Number), failures: 0, version: "0.5.1" })
    expect(client.records[0]!.nextCheckAt).toBeGreaterThanOrEqual(24 * Hour)
    expect(client.records[0]!.nextCheckAt).toBeLessThanOrEqual(30 * Hour)
    expect(client.leases()).toBe(0)
    expect(client.released()).toBe(point === "activate" ? 1 : 0)
    expect(client.logs).toEqual([])
    expect(await client.run(runAutomaticUpdates("0.5.1"))).toEqual({ updated: false })
    expect(client.targets()).toBe(1)
  })

  it.each(["prepare", "activate"] as const)("propagates an unexpected %s cooldown from a forced attempt", async point => {
    const client = fixture({ config: { autoUpdateEnabled: false }, schedule: { nextCheckAt: Hour, failures: 3 } })
    const error = client.fail(point, "cooldown")
    await expect(client.run(runAutomaticUpdates("0.5.1", true))).rejects.toBe(error)
    expect(client.preparationModes).toEqual([false])
    expect(client.records).toHaveLength(1)
    expect(client.records[0]).toMatchObject({ failures: 4, failure: "cooldown" })
    expect(client.records[0]).not.toHaveProperty("version")
    expect(client.leases()).toBe(0)
    expect(client.released()).toBe(point === "activate" ? 1 : 0)
  })

  it("does not treat a cooldown from release discovery as a successful automatic check", async () => {
    const client = fixture()
    const error = client.fail("target", "cooldown")
    await expect(client.run(runAutomaticUpdates("0.5.1"))).rejects.toBe(error)
    expect(client.preparations).toEqual([])
    expect(client.records[0]).toMatchObject({ failures: 1, failure: "cooldown" })
  })

  it.each(["0.5.3-beta.1", "latest", "garbage", "00.5.3"])("rejects an invalid stable release %s with a sanitized retry record", async version => {
    const client = fixture({ version })
    await expect(client.run(runAutomaticUpdates("0.5.1"))).rejects.toMatchObject({ reason: "release" })
    expect(client.preparations).toEqual([])
    expect(client.records[0]).toMatchObject({ failures: 1, failure: "release" })
  })

  it("defers failed work with exponential bounded backoff and preserves the original typed error", async () => {
    const client = fixture()
    const error = client.fail("prepare", "prepare")
    for (let attempt = 1; attempt <= 7; attempt++) {
      await expect(client.run(runAutomaticUpdates("0.5.1", true))).rejects.toBe(error)
      const record = client.records.at(-1)!
      const base = Math.min(24, 2 ** (attempt - 1)) * Hour
      expect(record).toMatchObject({ failures: attempt, failure: "prepare" })
      expect(record.nextCheckAt).toBeGreaterThanOrEqual(base)
      expect(record.nextCheckAt).toBeLessThanOrEqual(base + Math.min(6 * Hour, base / 4))
    }
    expect(client.activations).toEqual([])
    expect(JSON.stringify(client.records)).not.toContain("private")
    expect(JSON.stringify(client.logs)).not.toMatch(/private|token|source path/)
  })

  it("releases prepared resources after handoff failure even when retry persistence fails", async () => {
    const client = fixture()
    const error = client.fail("activate", "handoff")
    client.fail("record", "state")
    await expect(client.run(runAutomaticUpdates("0.5.1"))).rejects.toBe(error)
    expect(client.leases()).toBe(0)
    expect(client.released()).toBe(1)
    expect(JSON.stringify(client.logs)).toContain("Could not save automatic update retry schedule")
  })

  it.each(["version", "integrity"] as const)("refuses a prepared slot with changed %s and closes its scope", async kind => {
    const client = fixture()
    client.corruptPrepared(kind)
    await expect(client.run(runAutomaticUpdates("0.5.1"))).rejects.toMatchObject({ reason: "prepare" })
    expect(client.activations).toEqual([])
    expect(client.released()).toBe(1)
  })
})
