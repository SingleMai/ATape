import {
  AdapterProtocolVersion,
  emptyClientConfig,
  type ClientConfig
} from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  AdapterPackages,
  ClientConfigStore,
  ProjectLocator,
  inspectClient,
  installAdapter,
  removeProject,
  setProjectAdapter,
  setupProject,
  upgradeAdapters
} from "./clientManagement"

const setupInput = (overrides: Partial<Parameters<typeof setupProject>[0]> = {}): Parameters<typeof setupProject>[0] => ({
  path: "/work/payments/src",
  instanceOrigin: "https://atape.dev",
  userId: "user-1",
  teamId: "team-1",
  teamSlug: "acme",
  teamName: "Acme",
  projectId: "project-1",
  name: "Payments",
  createdAt: "2026-09-05T00:00:00Z",
  ...overrides
})

const fixture = (fixedUpgradeSpec?: string) => {
  let config: ClientConfig = emptyClientConfig()
  let version = "1.0.0"
  const packageRequests: Array<string> = []
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({
      transact: (change) => change(structuredClone(config)).pipe(
        Effect.tap((result) => Effect.sync(() => {
          if (result.config !== undefined) config = structuredClone(result.config)
        })),
        Effect.map((result) => result.value)
      )
    })),
    Layer.succeed(ProjectLocator, ProjectLocator.of({
      locate: (_path, preference) => Effect.succeed({
        path: preference === "directory" ? "/work/payments/src" : "/work/payments",
        name: preference === "directory" ? "src" : "payments",
        type: preference === "directory" ? "directory" : "git"
      })
    })),
    Layer.succeed(AdapterPackages, AdapterPackages.of({
      install: (packageSpec) => Effect.sync(() => {
        packageRequests.push(packageSpec)
        return {
          packageName: "@atape/adapter-codex",
          upgradeSpec: fixedUpgradeSpec ?? "@atape/adapter-codex",
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
  const run = <A, E>(effect: Effect.Effect<A, E, ClientConfigStore | ProjectLocator | AdapterPackages>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { run, read: () => config, packageRequests }
}

describe("Client management Module", () => {
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
      instanceOrigin: "https://atape.dev",
      userId: "user-1",
      teamId: "team-1",
      teamSlug: "acme"
    })
    expect(replayed.created).toBe(false)
    expect(client.read().activeInstanceOrigin).toBe("https://atape.dev")
    await expect(client.run(setupProject({ ...input, userId: "someone-else" })))
      .rejects.toMatchObject({ reason: "conflict", resource: "project" })
  })

  it("installs, enables, and upgrades an Adapter without starting a sidecar", async () => {
    const client = fixture()
    await client.run(setupProject(setupInput()))
    const installed = await client.run(installAdapter("@atape/adapter-codex@1.0.0"))
    const enabled = await client.run(setProjectAdapter({ projectId: "project-1", adapterId: "codex", enabled: true }))
    const upgraded = await client.run(upgradeAdapters("all"))

    expect(installed.adapter.version).toBe("1.0.0")
    expect(enabled.adapterIds).toEqual(["codex"])
    expect(upgraded[0]?.version).toBe("1.1.0")
    expect((await client.run(inspectClient())).projects[0]?.adapterIds).toEqual(["codex"])
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
