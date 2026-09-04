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

const fixture = () => {
  let config: ClientConfig = emptyClientConfig()
  let version = "1.0.0"
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
      install: (packageSpec) => Effect.sync(() => ({
        packageName: "@atape/adapter-codex",
        upgradeSpec: "@atape/adapter-codex",
        version,
        manifest: {
          protocolVersion: AdapterProtocolVersion,
          adapterId: "codex",
          displayName: "Codex CLI",
          entry: "./dist/index.js",
          harnesses: ["codex"]
        }
      })).pipe(Effect.tap(() => Effect.sync(() => {
        if (packageSpec.endsWith("@latest")) version = "1.1.0"
      })), Effect.map((installed) => ({ ...installed, version })))
    }))
  )
  const run = <A, E>(effect: Effect.Effect<A, E, ClientConfigStore | ProjectLocator | AdapterPackages>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { run, read: () => config }
}

describe("Client management Module", () => {
  it("sets up an auto-detected Git Project idempotently", async () => {
    const client = fixture()
    const input = { path: "/work/payments/src", teamId: "acme", teamName: "Acme" }
    const created = await client.run(setupProject(input))
    const replayed = await client.run(setupProject(input))

    expect(created.created).toBe(true)
    expect(created.project).toMatchObject({ id: "payments", type: "git", path: "/work/payments" })
    expect(replayed.created).toBe(false)
    expect(client.read().projects).toHaveLength(1)
  })

  it("preserves an explicitly selected ordinary directory", async () => {
    const client = fixture()
    const result = await client.run(setupProject({
      path: "/work/payments/src",
      teamId: "acme",
      teamName: "Acme",
      type: "directory"
    }))
    expect(result.project).toMatchObject({ id: "src", type: "directory", path: "/work/payments/src" })
  })

  it("persists one immutable Team user identity across local Projects", async () => {
    const client = fixture()
    const input = {
      path: "/work/payments",
      userId: "liying",
      teamId: "acme",
      teamName: "Acme"
    }
    const created = await client.run(setupProject(input))
    const replayed = await client.run(setupProject(input))

    expect(created.userId).toBe("liying")
    expect(replayed.created).toBe(false)
    expect(client.read().userId).toBe("liying")
    await expect(client.run(setupProject({ ...input, userId: "someone-else" })))
      .rejects.toMatchObject({ reason: "conflict", resource: "user" })
  })

  it("installs, enables, and upgrades an Adapter without starting a sidecar", async () => {
    const client = fixture()
    await client.run(setupProject({ path: "/work/payments", teamId: "acme", teamName: "Acme" }))
    const installed = await client.run(installAdapter("@atape/adapter-codex@1.0.0"))
    const enabled = await client.run(setProjectAdapter({ projectId: "payments", adapterId: "codex", enabled: true }))
    const upgraded = await client.run(upgradeAdapters("all"))

    expect(installed.adapter.version).toBe("1.0.0")
    expect(enabled.adapterIds).toEqual(["codex"])
    expect(upgraded[0]?.version).toBe("1.1.0")
    expect((await client.run(inspectClient())).projects[0]?.adapterIds).toEqual(["codex"])
  })

  it("removes only local Project configuration", async () => {
    const client = fixture()
    await client.run(setupProject({ path: "/work/payments", teamId: "acme", teamName: "Acme" }))
    await client.run(removeProject("payments"))
    expect(client.read().projects).toEqual([])
  })
})
