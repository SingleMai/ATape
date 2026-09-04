import {
  inspectClient,
  installAdapter,
  setProjectAdapter,
  setupProject,
  type AdapterPackages,
  type ClientConfigStore,
  type ProjectLocator
} from "@atape/application"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeNodeClientLayer } from "./clientLayers.ts"

const exec = promisify(execFile)
const temporaryDirectories: Array<string> = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-cli-test-"))
  temporaryDirectories.push(root)
  const paths = {
    configFile: join(root, "config", "config.json"),
    collectorStateFile: join(root, "state", "collector.json"),
    adapterDirectory: join(root, "data", "adapters")
  }
  const layer = makeNodeClientLayer(paths)
  const run = <A, E>(effect: Effect.Effect<
    A,
    E,
    ClientConfigStore | ProjectLocator | AdapterPackages
  >) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { root, paths, run }
}

describe("Node client Layers", () => {
  it("detects the Git root and persists owner-only atomic configuration", async () => {
    const client = await fixture()
    const repository = join(client.root, "payments")
    const nested = join(repository, "services", "api")
    await mkdir(nested, { recursive: true })
    await exec("git", ["init", "-q", repository])
    const canonicalRepository = await realpath(repository)

    const result = await client.run(setupProject({
      path: nested,
      teamId: "acme",
      teamName: "Acme Engineering"
    }))
    const persisted = JSON.parse(await readFile(client.paths.configFile, "utf8")) as {
      projects: ReadonlyArray<{ path: string; type: string }>
    }
    const metadata = await stat(client.paths.configFile)

    expect(result.project).toMatchObject({ id: "payments", path: canonicalRepository, type: "git" })
    expect(persisted.projects).toEqual([expect.objectContaining({ path: canonicalRepository, type: "git" })])
    expect(metadata.mode & 0o777).toBe(0o600)
  })

  it("serializes concurrent setup commands without losing a Project", async () => {
    const client = await fixture()
    const first = join(client.root, "first")
    const second = join(client.root, "second")
    await Promise.all([mkdir(first), mkdir(second)])

    await Promise.all([
      client.run(setupProject({ path: first, teamId: "acme", teamName: "Acme", type: "directory" })),
      client.run(setupProject({ path: second, teamId: "acme", teamName: "Acme", type: "directory" }))
    ])

    const config = await client.run(inspectClient())
    expect(config.projects.map((project) => project.id)).toEqual(["first", "second"])
  })

  it("recovers a configuration lock left by a dead process", async () => {
    const client = await fixture()
    const project = join(client.root, "project")
    await Promise.all([
      mkdir(project),
      mkdir(join(client.root, "config"), { recursive: true })
    ])
    await writeFile(`${client.paths.configFile}.lock`, JSON.stringify({
      pid: 2_147_483_647,
      createdAt: new Date().toISOString()
    }))

    const result = await client.run(setupProject({
      path: project,
      teamId: "acme",
      teamName: "Acme",
      type: "directory"
    }))

    expect(result.project.id).toBe("project")
    await expect(stat(`${client.paths.configFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("installs a local Adapter without running lifecycle scripts", async () => {
    const client = await fixture()
    const project = join(client.root, "project")
    const adapter = join(client.root, "adapter")
    await Promise.all([mkdir(project), mkdir(adapter)])
    const canonicalAdapter = await realpath(adapter)
    await writeFile(join(adapter, "index.js"), "export const adapter = {}\n")
    await writeFile(join(adapter, "package.json"), JSON.stringify({
      name: "@atape/adapter-fixture",
      version: "1.0.0",
      type: "module",
      scripts: { install: "node -e \"require('fs').writeFileSync('lifecycle-ran', 'yes')\"" },
      atapeAdapter: {
        protocolVersion: "atape.adapter.v1alpha1",
        adapterId: "fixture",
        displayName: "Fixture Harness",
        entry: "./index.js",
        harnesses: ["fixture"]
      }
    }))

    await client.run(setupProject({ path: project, teamId: "acme", teamName: "Acme", type: "directory" }))
    const installed = await client.run(installAdapter(adapter))
    const enabled = await client.run(setProjectAdapter({
      projectId: "project", adapterId: "fixture", enabled: true
    }))

    expect(installed.adapter).toMatchObject({
      adapterId: "fixture",
      packageName: "@atape/adapter-fixture",
      version: "1.0.0",
      upgradeSpec: `file:${canonicalAdapter}`
    })
    expect(enabled.adapterIds).toEqual(["fixture"])
    await expect(stat(join(adapter, "lifecycle-ran"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(join(
      client.paths.adapterDirectory,
      "node_modules",
      "@atape",
      "adapter-fixture",
      "lifecycle-ran"
    ))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
