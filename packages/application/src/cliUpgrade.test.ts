import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { CollectorDaemonProcess, CollectorDaemonProcessError } from "./collectorDaemon.ts"
import { checkCLIUpgrade, CLIUpgradeError, CLIUpgradePlatform, upgradeCLI, resumeCLIUpgrade } from "./cliUpgrade.ts"

const fixture = (version = "0.4.2", running = true) => {
  let failInstall = false, failResume = false, installs = 0, stops = 0
  const starts: Array<{ intervalMs: number; concurrency: number }> = []
  const layer = Layer.mergeAll(
    Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({
      latest: () => Effect.succeed(version),
      install: () => Effect.suspend(() => {
        installs++
        return failInstall ? Effect.fail(new CLIUpgradeError({ reason: "install", message: "offline" })) : Effect.void
      })
    })),
    Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      inspect: () => Effect.sync(() => running ? { pid: 1, startedAt: "now", logFile: "log", intervalMs: 45_000, concurrency: 2 } : undefined),
      stop: () => Effect.sync(() => { stops++; running = false; return true }),
      start: options => Effect.suspend(() => {
        starts.push(options)
        if (!failResume) running = true
        return failResume ? Effect.fail(new CollectorDaemonProcessError({ reason: "start", message: "failed" }))
          : Effect.succeed({ ...options, pid: 2, startedAt: "later", logFile: "log", created: true })
      })
    }))
  )
  return { run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
    installs: () => installs, stops: () => stops, starts, running: () => running, failInstall: () => { failInstall = true }, failResume: (value = true) => { failResume = value } }
}

describe("CLI upgrade Module", () => {
  it("upgrades and resumes only previously running sync with its original settings", async () => {
    const client = fixture()
    expect(await client.run(upgradeCLI("0.4.1"))).toEqual({ version: "0.4.2", updated: true, resumed: true })
    expect(client.installs()).toBe(1)
    expect(client.stops()).toBe(1)
    expect(client.starts).toEqual([{ intervalMs: 45_000, concurrency: 2 }])
    const stopped = fixture("0.4.2", false)
    expect((await stopped.run(upgradeCLI("0.4.1"))).resumed).toBe(false)
    expect(stopped.stops()).toBe(0)
    expect(stopped.starts).toEqual([])
  })
  it("does not downgrade, reinstall the current version, or upgrade development builds", async () => {
    for (const version of ["0.4.1", "0.4.0"]) {
      const client = fixture(version)
      expect((await client.run(upgradeCLI("0.4.1"))).updated).toBe(false)
      expect(client.installs()).toBe(0)
      expect(client.stops()).toBe(0)
    }
    await expect(fixture().run(upgradeCLI("development"))).rejects.toMatchObject({ reason: "installation" })
  })
  it("keeps existing sync running on installation failure and distinguishes failed resumption after installation", async () => {
    const client = fixture()
    client.failInstall()
    await expect(client.run(upgradeCLI("0.4.1"))).rejects.toMatchObject({ reason: "install" })
    expect(client.stops()).toBe(0)
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
  })
})
