import { CollectorDaemonProcess } from "./collectorDaemonProcess.ts"
import { emptyClientConfig, releasePackageNames, type ClientConfig, type ReleaseBundle } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { AdapterPackages, AdapterPackageError, ClientConfigStore } from "./clientManagement.ts"
import { CLIUpgradeError, CLIUpgradePlatform } from "./cliUpgrade.ts"
import { CLISetupPlatform } from "./cliSetupPlatform.ts"
import { inspectToolUpdates, updateToolRelease } from "./toolUpdates.ts"

const bundle = (version: string): ReleaseBundle => ({ protocol: "atape.release-bundle.v1", version,
  captureStateContract: "atape.client.v3-capture.v2", updateControlProtocol: "atape.update-control.v1",
  packages: releasePackageNames.map(name => ({ name, integrity: `sha512-${"A".repeat(86)}==`,
    tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` })) })

const fixture = (runtimeReleaseVersion = "0.4.4", commandEntryVersion = "0.4.4") => {
  let config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: ["codex"], adapters: [{
    adapterId: "codex", packageName: "@atape/adapter-codex", displayName: "Codex", upgradeSpec: "file:/old/codex",
    version: "0.2.0", installedAt: "before", updatedAt: "before"
  }] }
  let offline = false, installFailed = false
  const installs: string[] = [], checks: Array<{ name: string; cached: boolean }> = []
  const layer = Layer.mergeAll(
    Layer.succeed(CLISetupPlatform, CLISetupPlatform.of({ runtimeReleaseVersion,
      detectSources: () => Effect.die("Unexpected detection"), suggestDirectories: () => Effect.die("Unexpected browsing"),
      supportsGit: () => Effect.die("Unexpected Git inspection"), creationKey: () => Effect.die("Unexpected setup key") })),
    Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      resume: () => Effect.die("Unexpected resume"),
      pause: () => Effect.die("Unexpected pause"),
      refresh: () => Effect.succeed(false), inspect: () => Effect.succeed(undefined),
      start: () => Effect.die("Unexpected start"), stop: () => Effect.die("Unexpected stop")
    })),
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => change(structuredClone(config)).pipe(
      Effect.tap(result => Effect.sync(() => { if (result.config) config = result.config })), Effect.map(result => result.value)
    ) })),
    Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({ acquireOwnership: () => Effect.die("No CLI update ownership during tool inspection"), latest: cached => Effect.suspend(() => {
      checks.push({ name: "cli", cached })
      return offline ? Effect.fail(new CLIUpgradeError({ reason: "check", message: "offline" })) : Effect.succeed(bundle("0.4.4"))
    }), installedVersion: () => Effect.succeed(commandEntryVersion),
      install: () => Effect.die("No CLI installation during tool inspection") })),
    Layer.succeed(AdapterPackages, AdapterPackages.of({ prune: () => Effect.die("Unexpected package maintenance"), install: spec => Effect.sleep(1).pipe(Effect.andThen(Effect.suspend(() => {
      installs.push(spec)
      return installFailed ? Effect.fail(new AdapterPackageError({ reason: "install", packageSpec: spec, message: "offline" })) :
        Effect.succeed({ packageName: "@atape/adapter-codex", version: "0.4.4", upgradeSpec: "@atape/adapter-codex",
          manifest: { protocolVersion: "atape.adapter.v1alpha1" as const, adapterId: "codex", displayName: "Codex", harnesses: ["codex"], entry: "./index.js" } })
    }))) }))
  )
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>, signal?: AbortSignal) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)), signal ? { signal } : undefined),
    config: () => structuredClone(config), edit: (value: ClientConfig) => { config = value }, installs, checks,
    offline: () => { offline = true }, failInstall: () => { installFailed = true }
  }
}

describe("tool releases through the application Interface", () => {
  it("keeps command-entry refresh available after the managed runtime has already advanced", async () => {
    const rows = await fixture("0.4.4", "0.4.3").run(inspectToolUpdates("0.4.4"))
    expect(rows[0]).toMatchObject({ version: "0.4.4", latest: "0.4.4", status: "available", commandEntryVersion: "0.4.3" })
  })
  it("limits standalone official actions to the actual runtime even when the CLI bundle is newer", async () => {
    const client = fixture("0.4.3")
    const rows = await client.run(inspectToolUpdates("0.4.3"))
    expect(rows[0]).toMatchObject({ latest: "0.4.4", status: "available" })
    expect(rows[1]).toMatchObject({ latest: "0.4.3", status: "available" })
    await expect(client.run(updateToolRelease({ ...rows[1]!, latest: "0.4.4" }))).rejects.toMatchObject({ _tag: "ToolUpdateError" })
    expect(client.installs).toEqual([])
    expect(client.checks).toEqual([{ name: "cli", cached: true }])
  })

  it("does not offer an implicit official registry replacement from a development runtime", async () => {
    const client = fixture("development")
    const rows = await client.run(inspectToolUpdates("development"))
    expect(rows.map(row => row.status)).toEqual(["development", "development"])
    expect(rows[1]).not.toHaveProperty("latest")
    await expect(client.run(updateToolRelease({ ...rows[1]!, latest: "0.4.4", status: "available" }))).rejects.toMatchObject({ _tag: "ToolUpdateError" })
    expect(client.checks).toEqual([])
    expect(client.installs).toEqual([])
  })
  it("checks versions without mutations and replaces the selected local source with a pinned official release", async () => {
    const client = fixture(), before = client.config()
    const rows = await client.run(inspectToolUpdates("0.4.4"))
    expect(rows.map(row => [row.id, row.status])).toEqual([["cli", "current"], ["codex", "available"]])
    expect(rows[1]?.source).toBe("local")
    expect(client.config()).toEqual(before)
    expect(client.installs).toEqual([])
    await client.run(updateToolRelease(rows[1]!))
    expect(client.installs).toEqual(["@atape/adapter-codex@0.4.4"])
    expect(client.config()).toEqual({ ...before, adapters: [{ ...before.adapters[0]!,
      version: "0.4.4", upgradeSpec: "@atape/adapter-codex", updatedAt: expect.any(String) }] })
    await client.run(inspectToolUpdates("0.4.4", true))
    expect(client.checks).toEqual([{ name: "cli", cached: true }, { name: "cli", cached: false }])
  })
  it("keeps installed versions visible when offline and never redirects a custom publisher", async () => {
    const client = fixture()
    client.offline()
    const rows = await client.run(inspectToolUpdates("0.4.4"))
    expect(rows[0]).toMatchObject({ status: "unavailable" })
    expect(rows[1]).toMatchObject({ version: "0.2.0", latest: "0.4.4", status: "available" })
    const config = client.config()
    client.edit({ ...config, adapters: [{ ...config.adapters[0]!, packageName: "other-publisher" }] })
    const custom = (await client.run(inspectToolUpdates("0.4.4")))[1]!
    expect(custom).toMatchObject({ source: "custom", status: "manual" })
    expect(client.checks.filter(check => check.name !== "cli")).toHaveLength(0)
    await expect(client.run(updateToolRelease({ ...custom, latest: "0.4.4", status: "available" }))).rejects.toMatchObject({ _tag: "ToolUpdateError" })
    expect(client.installs).toEqual([])
  })
  it("rejects stale selections, downgrades, failed installs and cancellation without changing configuration", async () => {
    const client = fixture()
    const row = (await client.run(inspectToolUpdates("0.4.4")))[1]!
    const before = client.config()
    client.edit({ ...before, adapters: [{ ...before.adapters[0]!, version: "0.5.0" }] })
    await expect(client.run(updateToolRelease(row))).rejects.toMatchObject({ reason: "conflict" })
    const newer = (await client.run(inspectToolUpdates("0.4.4")))[1]!
    expect(newer.status).toBe("ahead")
    await expect(client.run(updateToolRelease(newer))).rejects.toMatchObject({ _tag: "ToolUpdateError" })
    expect(client.installs).toEqual([])
    client.edit(before)
    client.failInstall()
    await expect(client.run(updateToolRelease(row))).rejects.toMatchObject({ reason: "install" })
    expect(client.config()).toEqual(before)
    const cancellation = new AbortController(); cancellation.abort()
    await expect(client.run(updateToolRelease(row), cancellation.signal)).rejects.toBeDefined()
    expect(client.installs).toHaveLength(1)
    expect(client.config()).toEqual(before)
  })
})
