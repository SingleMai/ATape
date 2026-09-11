import { emptyClientConfig, type ClientConfig } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { AdapterPackages, AdapterPackageError, ClientConfigStore } from "./clientManagement.ts"
import { CLIUpgradePlatform } from "./cliUpgrade.ts"
import { AdapterReleases, ToolUpdateError, inspectToolUpdates, updateToolRelease } from "./toolUpdates.ts"

const fixture = () => {
  let config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: ["codex"], adapters: [{
    adapterId: "codex", packageName: "@atape/adapter-codex", displayName: "Codex", upgradeSpec: "file:/old/codex",
    version: "0.2.0", installedAt: "before", updatedAt: "before"
  }] }
  let offline = false, installFailed = false
  const installs: string[] = [], checks: Array<{ name: string; cached: boolean }> = []
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => change(structuredClone(config)).pipe(
      Effect.tap(result => Effect.sync(() => { if (result.config) config = result.config })), Effect.map(result => result.value)
    ) })),
    Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({ latest: cached => Effect.sync(() => {
      checks.push({ name: "cli", cached }); return "0.4.4"
    }), install: () => Effect.die("No CLI installation during tool inspection") })),
    Layer.succeed(AdapterReleases, AdapterReleases.of({ latest: (name, cached) => Effect.suspend(() => {
      checks.push({ name, cached })
      return offline ? Effect.fail(new ToolUpdateError({ message: "offline" })) : Effect.succeed("0.4.4")
    }) })),
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
    expect(client.checks.map(check => check.cached)).toEqual([true, true, false, false])
  })
  it("keeps installed versions visible when offline and never redirects a custom publisher", async () => {
    const client = fixture()
    client.offline()
    expect((await client.run(inspectToolUpdates("0.4.4")))[1]).toMatchObject({ version: "0.2.0", status: "unavailable" })
    const config = client.config()
    client.edit({ ...config, adapters: [{ ...config.adapters[0]!, packageName: "other-publisher" }] })
    const custom = (await client.run(inspectToolUpdates("0.4.4")))[1]!
    expect(custom).toMatchObject({ source: "custom", status: "manual" })
    expect(client.checks.filter(check => check.name !== "cli")).toHaveLength(1)
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
