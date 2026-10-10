import { CollectorDaemonProcess, CollectorDaemonProcessError } from "./collectorDaemonProcess.ts"
import {
  AdapterProtocolVersion,
  emptyClientConfig,
  type ClientConfig
} from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { CLISetupPlatform } from "./cliSetupPlatform.ts"
import {
  AdapterPackages,
  ClientConfigStore,
  ProjectLocator,
  inspectClient,
  installAdapter,
  removeProject,
  setupProject,
  automaticUpdatesEnabled,
  setAutomaticUpdates,
  upgradeAdapters
} from "./clientManagement"

const setupInput = (overrides: Partial<Parameters<typeof setupProject>[0]> = {}): Parameters<typeof setupProject>[0] => ({
  path: "/work/payments/src",
  repositoryIdentity: "github.com/acme/payments",
  instanceOrigin: "https://atape.net",
  userId: "user-1",
  teamId: "team-1",
  teamSlug: "acme",
  teamName: "Acme",
  projectId: "project-1",
  name: "Payments",
  createdAt: "2026-09-05T00:00:00Z",
  ...overrides
})

const fixture = (fixedUpgradeSpec?: string, runtimeReleaseVersion = "1.0.0", packageName = "@atape/adapter-codex") => {
  let config: ClientConfig = emptyClientConfig()
  let version = "1.0.0"
  let failRefresh = false, refreshes = 0
  let duringInstall: ((current: ClientConfig) => ClientConfig) | undefined
  const packageRequests: Array<string> = []
  const layer = Layer.mergeAll(
    Layer.succeed(CLISetupPlatform, CLISetupPlatform.of({ runtimeReleaseVersion,
      detectSources: () => Effect.die("Unexpected detection"), suggestDirectories: () => Effect.die("Unexpected browsing"),
      supportsGit: () => Effect.die("Unexpected Git inspection"), creationKey: () => Effect.die("Unexpected setup key") })),
    Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      observe: () => Effect.die("Unexpected pure process observation"),
      resume: () => Effect.die("Unexpected resume"),
      pause: () => Effect.die("Unexpected pause"),
      refresh: () => Effect.suspend(() => { refreshes++; return failRefresh
        ? Effect.fail(new CollectorDaemonProcessError({ reason: "start", message: "Could not refresh Host" }))
        : Effect.succeed(false) }), inspect: () => Effect.succeed(undefined),
      start: () => Effect.die("Unexpected start"), stop: () => Effect.die("Unexpected stop")
    })),
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({
      transact: (change) => change(structuredClone(config)).pipe(
        Effect.tap((result) => Effect.sync(() => {
          if (result.config !== undefined) config = structuredClone(result.config)
        })),
        Effect.map((result) => result.value)
      )
    })),
    Layer.succeed(ProjectLocator, ProjectLocator.of({
      locate: (path, preference) => Effect.succeed({
        requestedCwd: path,
        path: preference === "directory" ? "/work/payments/src" : path.startsWith("/work/clone") ? path : "/work/payments",
        ...(preference === "directory" ? {} : { repositoryRemote: "git@github.com:acme/payments.git" }),
        name: preference === "directory" ? "src" : "payments",
        type: preference === "directory" ? "directory" : "git"
      })
    })),
    Layer.succeed(AdapterPackages, AdapterPackages.of({ prune: () => Effect.die("Unexpected package maintenance"),
      install: (packageSpec) => Effect.sync(() => {
        packageRequests.push(packageSpec)
        if (duringInstall) { const change = duringInstall; duringInstall = undefined; config = change(config) }
        return {
          packageName,
          upgradeSpec: fixedUpgradeSpec ?? packageName,
          version,
          manifest: {
            protocolVersion: AdapterProtocolVersion,
            adapterId: "codex",
            displayName: "Codex CLI",
            entry: "./dist/index.js",
            harnesses: ["codex"]
          }
        }
      }).pipe(Effect.tap(() => Effect.sync(() => {
        if (packageSpec.endsWith("@latest")) version = "1.1.0"
      })), Effect.map((installed) => ({ ...installed, version })))
    }))
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { run, read: () => config, packageRequests, refreshes: () => refreshes,
    resolveVersion: (value: string) => { version = value },
    edit: (change: (value: ClientConfig) => ClientConfig) => { config = change(config) },
    failRefresh: () => { failRefresh = true },
    duringInstall: (change: (current: ClientConfig) => ClientConfig) => { duringInstall = change } }
}

describe("Client management Module", () => {
  it.each(["1.0.1", "0.9.9", "development"])("rejects resolved official release %s before Host refresh or configuration activation", async version => {
    const client = fixture()
    client.resolveVersion(version)
    await expect(client.run(installAdapter("@atape/adapter-codex@1.0.0"))).rejects.toMatchObject({ reason: "conflict", resource: "adapter" })
    expect(client.refreshes()).toBe(0)
    expect(client.read()).toEqual(emptyClientConfig())
  })

  it("refuses to downgrade an official integration ahead of the actual runtime", async () => {
    const client = fixture()
    await client.run(installAdapter("@atape/adapter-codex@1.0.0"))
    client.edit(config => ({ ...config, adapters: config.adapters.map(adapter => ({ ...adapter, version: "1.1.0" })) }))
    const before = structuredClone(client.read())
    await expect(client.run(upgradeAdapters("codex"))).rejects.toMatchObject({ reason: "conflict" })
    expect(client.packageRequests).toEqual(["@atape/adapter-codex@1.0.0"])
    await expect(client.run(installAdapter("@atape/adapter-codex@1.0.0"))).rejects.toMatchObject({ reason: "conflict" })
    expect(client.refreshes()).toBe(1)
    expect(client.read()).toEqual(before)
  })

  it("retains custom npm and local source refresh semantics in a development runtime", async () => {
    const custom = fixture(undefined, "development", "@custom/tool")
    await custom.run(installAdapter("@custom/tool"))
    expect((await custom.run(upgradeAdapters("all")))[0]?.version).toBe("1.1.0")
    expect(custom.packageRequests).toEqual(["@custom/tool", "@custom/tool@latest"])
    const local = fixture("file:/local/adapter", "development")
    await local.run(installAdapter("file:/local/adapter"))
    await local.run(upgradeAdapters("all"))
    expect(local.packageRequests).toEqual(["file:/local/adapter", "file:/local/adapter"])
    const official = fixture(undefined, "development")
    await expect(official.run(installAdapter("@atape/adapter-codex@1.0.0"))).rejects.toMatchObject({ reason: "conflict" })
    expect(official.refreshes()).toBe(0)
    expect(official.read()).toEqual(emptyClientConfig())
  })
  it("defaults automatic updates on and preserves tools and Projects when toggled", async () => {
    const client = fixture()
    await client.run(installAdapter("@atape/adapter-codex"))
    await client.run(setupProject(setupInput()))
    const original = structuredClone(client.read())
    expect(original.autoUpdateEnabled).toBeUndefined()
    expect(automaticUpdatesEnabled(await client.run(inspectClient()))).toBe(true)
    expect(await client.run(setAutomaticUpdates(false))).toBe(false)
    expect(automaticUpdatesEnabled(await client.run(inspectClient()))).toBe(false)
    expect(client.read()).toEqual({ ...original, autoUpdateEnabled: false })
    expect(await client.run(setAutomaticUpdates(true))).toBe(true)
    expect(client.read()).toEqual({ ...original, autoUpdateEnabled: true })
  })
  it("requires the current Host before activating an installation and preserves config when refresh fails", async () => {
    const client = fixture()
    await client.run(installAdapter("@atape/adapter-codex"))
    expect(client.refreshes()).toBe(1)
    const before = structuredClone(client.read())
    client.failRefresh()
    await expect(client.run(upgradeAdapters("all"))).rejects.toMatchObject({ reason: "start" })
    expect(client.read()).toEqual(before)
  })
  it("preserves unrelated changes during package preparation and rejects a competing installation", async () => {
    const client = fixture()
    const first = (await client.run(installAdapter("@atape/adapter-codex"))).adapter
    client.duringInstall(config => ({ ...config, locale: "zh-CN", toolsConfigured: true, enabledAdapterIds: ["codex"] }))
    const second = (await client.run(installAdapter("@atape/adapter-codex@1.0.0", { installation: first }))).adapter
    expect(client.read()).toMatchObject({ locale: "zh-CN", enabledAdapterIds: ["codex"] })
    client.duringInstall(config => ({ ...config, adapters: config.adapters.map(adapter => ({ ...adapter, version: "3.0.0", updatedAt: "newer" })) }))
    await expect(client.run(installAdapter("@atape/adapter-codex@1.0.0", { installation: second })))
      .rejects.toMatchObject({ reason: "conflict", resource: "adapter" })
    expect(client.read().adapters[0]).toMatchObject({ version: "3.0.0", updatedAt: "newer" })
  })
  it("sets up an auto-detected Git Project idempotently", async () => {
    const client = fixture()
    const input = setupInput()
    const created = await client.run(setupProject(input))
    const replayed = await client.run(setupProject(input))

    expect(created.created).toBe(true)
    expect(created.project).toMatchObject({ id: "project-1", type: "git", path: "/work/payments" })
    expect(replayed.created).toBe(false)
    expect(client.read().projects).toHaveLength(1)
  })

  it("reattaches a clone without replacing sources or the registration epoch", async () => {
    const client = fixture()
    await client.run(installAdapter("@atape/adapter-codex"))
    await client.run(Effect.flatMap(ClientConfigStore, store => store.transact(config => Effect.succeed({ value: undefined,
      config: { ...config, toolsConfigured: true, enabledAdapterIds: ["codex"] } }))))
    const first = await client.run(setupProject(setupInput()))
    const second = await client.run(setupProject(setupInput({
      path: "/work/clone", createdAt: "2026-09-08T00:00:00Z", name: "Renamed Project"
    })))
    expect(second).toMatchObject({ created: false, updated: true,
      project: { path: "/work/clone", adapterIds: ["codex"], createdAt: first.project.createdAt, name: "Renamed Project" } })
    expect(client.read().projects).toHaveLength(1)
  })

  it("preserves an explicitly selected ordinary directory", async () => {
    const client = fixture()
    const result = await client.run(setupProject(setupInput({ type: "directory" })))
    expect(result.project).toMatchObject({ id: "project-1", type: "directory", path: "/work/payments/src" })
  })

  it("persists only server-verified Instance, User, Team, and Project identity", async () => {
    const client = fixture()
    const input = setupInput()
    const created = await client.run(setupProject(input))
    const replayed = await client.run(setupProject(input))

    expect(created.project).toMatchObject({
      instanceOrigin: "https://atape.net",
      userId: "user-1",
      teamId: "team-1",
      teamSlug: "acme"
    })
    expect(replayed.created).toBe(false)
    expect(client.read().activeInstanceOrigin).toBe("https://atape.net")
    await expect(client.run(setupProject({ ...input, userId: "someone-else" })))
      .rejects.toMatchObject({ reason: "conflict", resource: "project" })
  })

  it("installs and upgrades an Adapter without enabling tools without starting a sidecar", async () => {
    const client = fixture()
    await client.run(setupProject(setupInput()))
    const installed = await client.run(installAdapter("@atape/adapter-codex@1.0.0"))
    const upgraded = await client.run(upgradeAdapters("all"))

    expect(installed.adapter.version).toBe("1.0.0")
    expect(upgraded[0]?.version).toBe("1.0.0")
    expect(client.packageRequests).toEqual(["@atape/adapter-codex@1.0.0", "@atape/adapter-codex@1.0.0"])
    expect((await client.run(inspectClient())).projects[0]?.adapterIds).toEqual([])
  })

  it("reuses an HTTPS package source during an explicit Adapter upgrade", async () => {
    const packageURL = "https://github.example/releases/atape-adapter-codex-1.0.0.tgz"
    const client = fixture(packageURL)
    await client.run(installAdapter(packageURL))

    await client.run(upgradeAdapters("codex"))

    expect(client.packageRequests).toEqual([packageURL, packageURL])
  })

  it("removes only local Project configuration", async () => {
    const client = fixture()
    await client.run(setupProject(setupInput()))
    await client.run(removeProject("project-1"))
    expect(client.read().projects).toEqual([])
  })
})
