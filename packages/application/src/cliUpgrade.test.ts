import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { CollectorDaemonProcess, CollectorDaemonProcessError } from "./collectorDaemon.ts"
import { checkCLIUpgrade, CLIUpgradeError, CLIUpgradePlatform, upgradeCLI, resumeCLIUpgrade } from "./cliUpgrade.ts"
import { emptyClientConfig, releasePackageNames, type ClientConfig, type ManagedReleaseBundle as ReleaseBundle } from "@atape/domain"
import { AutomaticUpdateError, AutomaticUpdatePlatform } from "./automaticUpdates.ts"
import { ClientConfigStore } from "./clientManagement.ts"

const bundle = (version: string, integrity = `sha512-${"A".repeat(86)}==`): ReleaseBundle => ({
  protocol: "atape.release-bundle.v1", version, captureStateContract: "atape.client.v3-capture.v2", updateControlProtocol: "atape.update-control.v1",
  packages: releasePackageNames.map(name => ({ name, integrity,
    tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` }))
})
const fixture = (version = "0.4.2", running = true, wanted = running, installed = "0.4.1", selected = bundle(version)) => {
  let failInstall = false, failResume = false, installs = 0, pauses = 0, stale = false
  let stopDuringActivation = false
  let failPrepare = false, changedIntegrity = false, runtimeVersion = "0.4.1"
  let cooldownAt: "prepare" | "activate" | undefined, leases = 0, preparationReleases = 0
  let owned = false, acquisitions = 0, releases = 0
  let installWait: Promise<void> | undefined, startWait: Promise<void> | undefined
  const starts: Array<{ intervalMs: number; concurrency: number }> = []
  let config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: false, enabledAdapterIds: ["codex"], adapters: [{
    adapterId: "codex", packageName: "@atape/adapter-codex", upgradeSpec: "@atape/adapter-codex", version: "0.4.1",
    displayName: "Codex", installedAt: "before", updatedAt: "before"
  }] }
  const prepared: Array<{ bundle: ReleaseBundle; adapters: ClientConfig["adapters"]; automatic: boolean }> = []
  const activations: Array<{ bundle: ReleaseBundle; automatic: boolean }> = [], entryBundles: ReleaseBundle[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => change(structuredClone(config)).pipe(
      Effect.tap(result => Effect.sync(() => { if (result.config) config = result.config })), Effect.map(result => result.value)
    ) })),
    Layer.succeed(AutomaticUpdatePlatform, AutomaticUpdatePlatform.of({
      supported: () => Effect.die("Manual upgrade already owns supported installation"),
      recoveryPending: () => Effect.die("Unexpected automatic schedule check"), schedule: () => Effect.die("Unexpected schedule check"),
      target: () => Effect.die("Manual upgrade keeps its selected bundle"), record: () => Effect.die("Unexpected schedule mutation"), launch: () => Effect.die("Unexpected worker launch"),
      prepare: (bundle, adapters, automatic) => Effect.suspend(() => {
        prepared.push({ bundle, adapters, automatic })
        if (cooldownAt === "prepare") return Effect.fail(new AutomaticUpdateError({ reason: "cooldown", message: "unexpected manual cooldown" }))
        return failPrepare ? Effect.fail(new AutomaticUpdateError({ reason: "prepare", message: "unavailable archive" })) :
          Effect.succeed({ key: "prepared-release", bundle: changedIntegrity ? { ...bundle, packages: bundle.packages.map(item =>
            ({ ...item, integrity: `sha512-${"A".repeat(85)}Q==` })) } : bundle })
      }).pipe(Effect.flatMap(value => Effect.acquireRelease(Effect.sync(() => { leases++; return value }),
        () => Effect.sync(() => { leases--; preparationReleases++ })))),
      activate: (value, automatic) => Effect.suspend(() => {
        if (cooldownAt === "activate") return Effect.fail(new AutomaticUpdateError({ reason: "cooldown", message: "unexpected manual cooldown" }))
        return Effect.sync(() => {
          activations.push({ bundle: value.bundle, automatic })
          if (stopDuringActivation) { wanted = false; running = false }
          runtimeVersion = value.bundle.version
          config = { ...config, adapters: config.adapters.map(adapter => prepared.at(-1)?.adapters.some(selected => selected.adapterId === adapter.adapterId)
            ? { ...adapter, version: value.bundle.version } : adapter) }
        })
      })
    })),
    Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({
      acquireOwnership: () => Effect.acquireRelease(Effect.suspend(() => {
        if (owned) return Effect.fail(new CLIUpgradeError({ reason: "installation", message: "Another update owns maintenance" }))
        return Effect.sync(() => { owned = true; acquisitions++ })
      }), () => Effect.sync(() => { owned = false; releases++ })),
      latest: () => Effect.succeed(selected), installedVersion: () => Effect.succeed(installed),
      install: bundle => Effect.suspend(() => {
        installs++
        entryBundles.push(bundle)
        return failInstall ? Effect.fail(new CLIUpgradeError({ reason: "install", message: "offline" }))
          : (installWait ? Effect.promise(() => installWait!) : Effect.void).pipe(Effect.tap(() => Effect.sync(() => { installed = bundle.version })))
      })
    })),
    Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      observe: () => Effect.die("Unexpected pure process observation"),
      refresh: () => Effect.sync(() => { const changed = running && stale; stale = false; return changed }),
      inspect: () => Effect.sync(() => running ? { pid: 1, startedAt: "now", logFile: "log", intervalMs: 45_000, concurrency: 2 } : undefined),
      stop: () => Effect.sync(() => { const stopped = running; wanted = false; running = false; return stopped }),
      pause: () => Effect.sync(() => { pauses++; const stopped = running; running = false; return stopped }),
      start: () => Effect.die("Upgrade must preserve intent instead of issuing Start"),
      resume: () => Effect.suspend(() => {
        if (!wanted) return Effect.succeed(undefined)
        const options = { intervalMs: 45_000, concurrency: 2 }
        starts.push(options)
        return (startWait ? Effect.promise(() => startWait!) : Effect.void).pipe(Effect.flatMap(() => {
          if (!wanted) return Effect.succeed(undefined)
          if (!failResume) running = true
          return failResume ? Effect.fail(new CollectorDaemonProcessError({ reason: "start", message: "failed" }))
            : Effect.succeed({ ...options, pid: 2, startedAt: "later", logFile: "log", created: true })
        }))
      })
    }))
  )
  const hold = (kind: "install" | "start") => {
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    if (kind === "install") installWait = wait
    else startWait = wait
    return release
  }
  return { run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>, signal?: AbortSignal) => Effect.runPromise(effect.pipe(Effect.provide(layer)), signal ? { signal } : undefined),
    ownership: () => ({ owned, acquisitions, releases }), hold,
    prepared, activations, entryBundles, runtimeVersion: () => runtimeVersion, config: () => structuredClone(config),
    leases: () => leases, preparationReleases: () => preparationReleases,
    edit: (change: (config: ClientConfig) => ClientConfig) => { config = change(config) },
    configure: (value: boolean) => { config = { ...config, toolsConfigured: value, ...(value ? {} : { adapters: [] }) } },
    stopDuringActivation: () => { stopDuringActivation = true },
    failPrepare: () => { failPrepare = true }, changePreparedIntegrity: () => { changedIntegrity = true },
    cooldown: (point: "prepare" | "activate") => { cooldownAt = point },
    stale: () => { stale = true }, installs: () => installs, pauses: () => pauses, starts, running: () => running, failInstall: (value = true) => { failInstall = value }, failResume: (value = true) => { failResume = value } }
}

describe("CLI upgrade Module", () => {
  it("passes one complete immutable bundle to preparation, manual activation and command entry refresh", async () => {
    const client = fixture()
    client.edit(config => ({ ...config, autoStartEnabled: false, adapters: [...config.adapters,
      { ...config.adapters[0]!, adapterId: "claude", packageName: "@atape/adapter-claude", upgradeSpec: "@atape/adapter-claude" },
      { ...config.adapters[0]!, adapterId: "opencode", packageName: "@atape/adapter-opencode", upgradeSpec: "file:/local/opencode" },
      { ...config.adapters[0]!, adapterId: "custom", packageName: "@custom/tool", upgradeSpec: "@custom/tool" }
    ] }))
    const before = client.config(), selected = bundle("0.4.2")
    await client.run(upgradeCLI("0.4.1"))
    expect(client.prepared).toEqual([{ bundle: selected, adapters: before.adapters.slice(0, 2), automatic: false }])
    expect(client.activations).toEqual([{ bundle: selected, automatic: false }])
    expect(client.entryBundles).toEqual([selected])
    expect(client.runtimeVersion()).toBe("0.4.2")
    expect(client.config()).toEqual({ ...before, adapters: before.adapters.map((adapter, index) => index < 2 ? { ...adapter, version: "0.4.2" } : adapter) })
  })

  it("rejects changed integrity at the same prepared version before activation or global installation", async () => {
    const client = fixture()
    client.changePreparedIntegrity()
    const before = client.config()
    await expect(client.run(upgradeCLI("0.4.1"))).rejects.toMatchObject({ reason: "install", message: expect.stringContaining("differs") })
    expect(client.activations).toEqual([])
    expect(client.entryBundles).toEqual([])
    expect(client.pauses()).toBe(0)
    expect(client.config()).toEqual(before)
    expect(client.ownership()).toEqual({ owned: false, acquisitions: 1, releases: 1 })
  })

  it("retains an activated runtime after command entry failure and retries the older entry at the same runtime version", async () => {
    const client = fixture()
    client.failInstall()
    await expect(client.run(upgradeCLI("0.4.1"))).rejects.toMatchObject({ reason: "install",
      message: expect.stringContaining("0.4.2 runtime is selected, but the global command entry could not be refreshed") })
    expect(client.runtimeVersion()).toBe("0.4.2")
    expect(client.activations).toHaveLength(1)
    expect(await client.run(checkCLIUpgrade("0.4.2"))).toBe("0.4.2")
    client.failInstall(false)
    expect(await client.run(upgradeCLI("0.4.2"))).toMatchObject({ version: "0.4.2", updated: true, resumed: true })
    expect(client.prepared).toHaveLength(1)
    expect(client.activations).toHaveLength(1)
    expect(client.entryBundles).toEqual([bundle("0.4.2"), bundle("0.4.2")])
    expect(await client.run(checkCLIUpgrade("0.4.2"))).toBeUndefined()
  })

  it("reports stopped sync when Stop wins during a runtime-only alignment", async () => {
    const client = fixture("0.4.2", true, true, "0.4.2")
    client.stopDuringActivation()
    expect(await client.run(upgradeCLI("0.4.2"))).toEqual({ version: "0.4.2", updated: true, resumed: false })
    expect(client.activations).toHaveLength(1)
    expect(client.installs()).toBe(0)
    expect(client.running()).toBe(false)
    expect(client.starts).toEqual([])
  })

  it("keeps the old runtime and command entry usable if full preparation fails", async () => {
    const client = fixture()
    const before = client.config()
    client.failPrepare()
    await expect(client.run(upgradeCLI("0.4.1"))).rejects.toMatchObject({ reason: "install", message: expect.stringContaining("could not be prepared") })
    expect(client.runtimeVersion()).toBe("0.4.1")
    expect(client.config()).toEqual(before)
    expect(client.activations).toEqual([])
    expect(client.entryBundles).toEqual([])
    expect(client.pauses()).toBe(0)
    expect(client.running()).toBe(true)
  })

  it.each(["prepare", "activate"] as const)("surfaces unexpected manual %s cooldown without changing collection or command entry", async point => {
    const client = fixture(), before = client.config()
    client.cooldown(point)
    await expect(client.run(upgradeCLI("0.4.1"))).rejects.toMatchObject({
      reason: "install", message: expect.stringContaining("unexpected manual cooldown")
    })
    expect(client.prepared).toEqual([{ bundle: bundle("0.4.2"), adapters: before.adapters, automatic: false }])
    expect(client.runtimeVersion()).toBe("0.4.1")
    expect(client.config()).toEqual(before)
    expect(client.activations).toEqual([])
    expect(client.entryBundles).toEqual([])
    expect(client.pauses()).toBe(0)
    expect(client.running()).toBe(true)
    expect(client.leases()).toBe(0)
    expect(client.preparationReleases()).toBe(point === "activate" ? 1 : 0)
    expect(client.ownership()).toEqual({ owned: false, acquisitions: 1, releases: 1 })
  })

  it("refreshes only the verified command entry before tools are configured", async () => {
    const client = fixture("0.4.2", false)
    client.configure(false)
    const before = client.config()
    expect(await client.run(upgradeCLI("0.4.1"))).toEqual({ version: "0.4.2", updated: true, resumed: false })
    expect(client.prepared).toEqual([])
    expect(client.activations).toEqual([])
    expect(client.entryBundles).toEqual([bundle("0.4.2")])
    expect(client.config()).toEqual(before)
  })

  it.each(["0.4.1", "0.4.2"])("settles a migration release before refreshing an unconfigured command entry from %s", async current => {
    const selected: ReleaseBundle = { ...bundle("0.4.2"), protocol: "atape.release-bundle.v2",
      migration: { protocol: "atape.capture-migration.v1", id: "journal-v7-to-v8",
        fromCaptureStateContracts: ["atape.client.v3-capture.v1", "atape.client.v3-capture.v2"] } }
    const client = fixture("0.4.2", false, false, "0.4.1", selected)
    client.configure(false)
    const before = client.config()
    expect(await client.run(upgradeCLI(current))).toEqual({ version: "0.4.2", updated: true, resumed: false })
    expect(client.prepared).toEqual([{ bundle: selected, adapters: [], automatic: false }])
    expect(client.activations).toEqual([{ bundle: selected, automatic: false }])
    expect(client.entryBundles).toEqual([selected])
    expect(client.config()).toEqual(before)
    expect(client.starts).toEqual([])
  })

  it("upgrades and resumes only previously running sync with its original settings", async () => {
    const client = fixture()
    expect(await client.run(upgradeCLI("0.4.1"))).toEqual({ version: "0.4.2", updated: true, resumed: true })
    expect(client.installs()).toBe(1)
    expect(client.pauses()).toBe(1)
    expect(client.starts).toEqual([{ intervalMs: 45_000, concurrency: 2 }])
    expect(client.ownership()).toEqual({ owned: false, acquisitions: 1, releases: 1 })
    const stopped = fixture("0.4.2", false)
    expect((await stopped.run(upgradeCLI("0.4.1"))).resumed).toBe(false)
    expect(stopped.pauses()).toBe(0)
    expect(stopped.starts).toEqual([])
  })
  it("finishes an external package update even when npm already reports the current version", async () => {
    const client = fixture("0.4.2", true, true, "0.4.2")
    client.configure(false)
    client.stale()
    expect(await client.run(upgradeCLI("0.4.2"))).toEqual({ version: "0.4.2", updated: false, resumed: true })
    expect(client.installs()).toBe(0)
    expect(await client.run(upgradeCLI("0.4.2"))).toEqual({ version: "0.4.2", updated: false, resumed: false })
    const stopped = fixture("0.4.2", false, false, "0.4.2")
    stopped.configure(false)
    stopped.stale()
    expect((await stopped.run(upgradeCLI("0.4.2"))).resumed).toBe(false)
  })
  it("does not downgrade, reinstall the current version, or upgrade development builds", async () => {
    for (const version of ["0.4.1", "0.4.0"]) {
      const client = fixture(version)
      expect((await client.run(upgradeCLI("0.4.1"))).updated).toBe(false)
      expect(client.installs()).toBe(0)
      expect(client.pauses()).toBe(0)
    }
    await expect(fixture().run(upgradeCLI("development"))).rejects.toMatchObject({ reason: "installation" })
  })
  it("keeps existing sync running on installation failure and distinguishes failed resumption after installation", async () => {
    const client = fixture()
    client.failInstall()
    await expect(client.run(upgradeCLI("0.4.1"))).rejects.toMatchObject({ reason: "install" })
    expect(client.pauses()).toBe(0)
    expect(client.ownership()).toEqual({ owned: false, acquisitions: 1, releases: 1 })
    const resume = fixture()
    resume.failResume()
    await expect(resume.run(upgradeCLI("0.4.1"))).rejects.toMatchObject({ reason: "resume", message: expect.stringContaining("0.4.2 is installed") })
  })
  it("compares numeric versions and keeps startup offline/invalid checks silent", async () => {
    expect(await fixture("0.10.0").run(checkCLIUpgrade("0.9.9"))).toBe("0.10.0")
    expect(await fixture("0.9.9").run(checkCLIUpgrade("0.10.0"))).toBeUndefined()
    expect(await fixture("0.5.0-beta.1").run(checkCLIUpgrade("0.4.1"))).toBeUndefined()
    expect(await fixture().run(checkCLIUpgrade("development"))).toBeUndefined()
    const offline = Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({
      acquireOwnership: () => Effect.die("Startup lookup cannot acquire update ownership"),
      latest: () => Effect.fail(new CLIUpgradeError({ reason: "check", message: "offline" })),
      installedVersion: () => Effect.die("Offline lookup cannot inspect the command entry"), install: () => Effect.void
    }))
    expect(await Effect.runPromise(checkCLIUpgrade("0.4.1").pipe(Effect.provide(offline)))).toBeUndefined()
  })
  it("retries failed sync recovery with the original settings without reinstalling, including repeated failures", async () => {
    const client = fixture()
    client.failResume()
    const failed = await client.run(upgradeCLI("0.4.1").pipe(Effect.match({ onFailure: error => error, onSuccess: () => undefined })))
    expect(failed).toBeInstanceOf(CLIUpgradeError)
    if (!(failed instanceof CLIUpgradeError) || !failed.recovery) throw new Error("Missing recovery receipt")
    expect(client.running()).toBe(false)
    await expect(client.run(resumeCLIUpgrade(failed.recovery))).rejects.toMatchObject({ reason: "resume", recovery: failed.recovery })
    client.failResume(false)
    expect(await client.run(resumeCLIUpgrade(failed.recovery))).toEqual({ version: "0.4.2", updated: true, resumed: true })
    expect(client.installs()).toBe(1)
    expect(client.running()).toBe(true)
    expect(client.starts).toEqual(Array(3).fill({ intervalMs: 45_000, concurrency: 2 }))
    expect(client.ownership()).toEqual({ owned: false, acquisitions: 3, releases: 3 })
  })
  it("releases update ownership when installation is cancelled before handoff", async () => {
    const client = fixture(), finish = client.hold("install"), cancellation = new AbortController()
    const pending = client.run(upgradeCLI("0.4.1"), cancellation.signal)
    try {
      await expect.poll(client.installs).toBe(1)
      await expect(client.run(upgradeCLI("0.4.1"))).rejects.toMatchObject({ reason: "installation" })
      cancellation.abort()
      await expect(pending).rejects.toBeDefined()
      expect(client.pauses()).toBe(0)
      expect(client.ownership()).toEqual({ owned: false, acquisitions: 1, releases: 1 })
    } finally { finish(); cancellation.abort(); await pending.catch(() => {}) }
  })
  it("keeps ownership until an installed update finishes handoff after cancellation", async () => {
    const client = fixture(), finish = client.hold("start"), cancellation = new AbortController()
    let settled = false
    const pending = client.run(upgradeCLI("0.4.1"), cancellation.signal).finally(() => { settled = true })
    try {
      await expect.poll(() => client.starts.length).toBe(1)
      cancellation.abort()
      await expect(client.run(upgradeCLI("0.4.1"))).rejects.toMatchObject({ reason: "installation" })
      expect(settled).toBe(false)
      expect(client.ownership().owned).toBe(true)
      finish()
      await pending.catch(() => {})
      expect(client.running()).toBe(true)
      expect(client.ownership()).toEqual({ owned: false, acquisitions: 1, releases: 1 })
    } finally { finish(); cancellation.abort(); await pending.catch(() => {}) }
  })
  it("retains a recovery receipt when another update prevents resumption", async () => {
    const client = fixture("0.4.2", false, true), finish = client.hold("start")
    const recovery = { version: "0.4.2", intervalMs: 45_000, concurrency: 2 }
    const pending = client.run(resumeCLIUpgrade(recovery))
    try {
      await expect.poll(() => client.starts.length).toBe(1)
      await expect(client.run(resumeCLIUpgrade(recovery))).rejects.toMatchObject({ reason: "resume", recovery })
    } finally { finish() }
    await expect(pending).resolves.toMatchObject({ updated: true, resumed: true })
    expect(client.installs()).toBe(0)
    expect(client.ownership()).toEqual({ owned: false, acquisitions: 1, releases: 1 })
  })

  it("honors Stop during installation and never revives it from the upgrade receipt", async () => {
    const client = fixture(), finish = client.hold("install")
    const pending = client.run(upgradeCLI("0.4.1"))
    try {
      await expect.poll(client.installs).toBe(1)
      await client.run(CollectorDaemonProcess.use(process => process.stop()))
      finish()
      await expect(pending).resolves.toMatchObject({ version: "0.4.2", updated: true, resumed: false })
      expect(client.running()).toBe(false)
      expect(client.starts).toEqual([])
      await expect(client.run(resumeCLIUpgrade({ version: "0.4.2", intervalMs: 45000, concurrency: 2 })))
        .resolves.toMatchObject({ resumed: false })
      expect(client.running()).toBe(false)
    } finally { finish(); await pending.catch(() => {}) }
  })

  it("honors Stop after a failed resumption before retrying the retained receipt", async () => {
    const client = fixture()
    client.failResume()
    const failed = await client.run(upgradeCLI("0.4.1").pipe(Effect.match({ onFailure: error => error, onSuccess: () => undefined })))
    if (!(failed instanceof CLIUpgradeError) || !failed.recovery) throw new Error("Missing recovery receipt")
    await client.run(CollectorDaemonProcess.use(process => process.stop()))
    client.failResume(false)
    await expect(client.run(resumeCLIUpgrade(failed.recovery))).resolves.toMatchObject({ resumed: false })
    expect(client.running()).toBe(false)
    expect(client.starts).toHaveLength(1)
    expect(client.installs()).toBe(1)
  })
})
