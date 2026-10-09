import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { CollectorDaemonProcess, CollectorDaemonProcessError } from "./collectorDaemon.ts"
import { checkCLIUpgrade, CLIUpgradeError, CLIUpgradePlatform, upgradeCLI, resumeCLIUpgrade } from "./cliUpgrade.ts"

const fixture = (version = "0.4.2", running = true, wanted = running) => {
  let failInstall = false, failResume = false, installs = 0, pauses = 0, stale = false
  let owned = false, acquisitions = 0, releases = 0
  let installWait: Promise<void> | undefined, startWait: Promise<void> | undefined
  const starts: Array<{ intervalMs: number; concurrency: number }> = []
  const layer = Layer.mergeAll(
    Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({
      acquireOwnership: () => Effect.acquireRelease(Effect.suspend(() => {
        if (owned) return Effect.fail(new CLIUpgradeError({ reason: "installation", message: "Another update owns maintenance" }))
        return Effect.sync(() => { owned = true; acquisitions++ })
      }), () => Effect.sync(() => { owned = false; releases++ })),
      latest: () => Effect.succeed(version),
      install: () => Effect.suspend(() => {
        installs++
        return failInstall ? Effect.fail(new CLIUpgradeError({ reason: "install", message: "offline" }))
          : installWait ? Effect.promise(() => installWait!) : Effect.void
      })
    })),
    Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
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
    stale: () => { stale = true }, installs: () => installs, pauses: () => pauses, starts, running: () => running, failInstall: () => { failInstall = true }, failResume: (value = true) => { failResume = value } }
}

describe("CLI upgrade Module", () => {
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
    const client = fixture("0.4.2")
    client.stale()
    expect(await client.run(upgradeCLI("0.4.2"))).toEqual({ version: "0.4.2", updated: false, resumed: true })
    expect(client.installs()).toBe(0)
    expect(await client.run(upgradeCLI("0.4.2"))).toEqual({ version: "0.4.2", updated: false, resumed: false })
    const stopped = fixture("0.4.2", false)
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
      latest: () => Effect.fail(new CLIUpgradeError({ reason: "check", message: "offline" })), install: () => Effect.void
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
