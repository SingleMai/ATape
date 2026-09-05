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

const fixture = async (fetchAdapterPackage: typeof fetch = globalThis.fetch) => {
  const root = await mkdtemp(join(tmpdir(), "atape-cli-test-"))
  temporaryDirectories.push(root)
  const paths = {
    atapeHome: root,
    credentialDirectory: join(root, "credentials"),
    configFile: join(root, "config", "config.json"),
    collectorStateFile: join(root, "state", "collector.json"),
    collectorProcessFile: join(root, "state", "collector-process.json"),
    collectorStatusFile: join(root, "state", "collector-status.json"),
    collectorLogFile: join(root, "state", "collector.log"),
    adapterDirectory: join(root, "data", "adapters"),
    legacy: {
      configFile: join(root, "legacy", "config.json"),
      collectorStateFile: join(root, "legacy", "collector.json"),
      collectorProcessFile: join(root, "legacy", "collector-process.json"),
      collectorStatusFile: join(root, "legacy", "collector-status.json"),
      collectorLogFile: join(root, "legacy", "collector.log"),
      adapterDirectory: join(root, "legacy", "adapters")
    }
  }
  const layer = makeNodeClientLayer(paths, process.env, fetchAdapterPackage)
  const run = <A, E>(effect: Effect.Effect<
    A,
    E,
    ClientConfigStore | ProjectLocator | AdapterPackages
  >) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { root, paths, run }
}

const setupInput = (path: string, type: "auto" | "git" | "directory" = "auto") => ({
  path,
  instanceOrigin: "https://atape.dev",
  userId: "user-1",
  teamId: "team-1",
  teamSlug: "acme",
  teamName: "Acme Engineering",
  projectId: type === "directory" ? path.split("/").at(-1) ?? "project" : "payments",
  name: type === "directory" ? path.split("/").at(-1) ?? "Project" : "Payments",
  createdAt: "2026-09-06T00:00:00Z",
  type
} as const)

describe("Node client Layers", () => {
  it("detects the Git root and persists owner-only atomic configuration", async () => {
    const client = await fixture()
    const repository = join(client.root, "payments")
    const nested = join(repository, "services", "api")
    await mkdir(nested, { recursive: true })
    await exec("git", ["init", "-q", repository])
    const canonicalRepository = await realpath(repository)

    const result = await client.run(setupProject(setupInput(nested)))
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
      client.run(setupProject(setupInput(first, "directory"))),
      client.run(setupProject(setupInput(second, "directory")))
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

    const result = await client.run(setupProject(setupInput(project, "directory")))

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

    await client.run(setupProject(setupInput(project, "directory")))
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

  it("preflights and installs an npm Adapter archive without running lifecycle scripts", async () => {
    const client = await fixture()
    const adapter = await packedAdapterFixture(client.root, "archive-fixture")

    const installed = await client.run(installAdapter(adapter.tarball))

    expect(installed.adapter).toMatchObject({
      adapterId: "archive-fixture",
      packageName: "@atape/adapter-archive-fixture",
      version: "1.0.0",
      upgradeSpec: `file:${await realpath(adapter.tarball)}`
    })
    await expect(stat(join(adapter.source, "lifecycle-ran"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(join(
      client.paths.adapterDirectory,
      "node_modules",
      "@atape",
      "adapter-archive-fixture",
      "lifecycle-ran"
    ))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects a malformed Adapter archive before creating the npm installation tree", async () => {
    const client = await fixture()
    const archive = join(client.root, "malformed-adapter.tgz")
    await writeFile(archive, "this is not a gzip stream")

    await expect(client.run(installAdapter(archive))).rejects.toMatchObject({ reason: "invalid_spec" })
    await expect(stat(client.paths.adapterDirectory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("downloads an HTTPS Adapter archive into bounded staging and preserves its upgrade URL", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "atape-adapter-source-"))
    temporaryDirectories.push(packageRoot)
    const adapter = await packedAdapterFixture(packageRoot, "remote-fixture")
    const archive = await readFile(adapter.tarball)
    const requested: Array<string> = []
    const fetchAdapterPackage = (async (input: string | URL | Request) => {
      requested.push(String(input))
      return new Response(new Uint8Array(archive), {
        status: 200,
        headers: { "content-length": String(archive.byteLength) }
      })
    }) as typeof fetch
    const client = await fixture(fetchAdapterPackage)
    const packageURL = "https://github.example/releases/download/v1/atape-adapter-remote-fixture-1.0.0.tgz"

    const installed = await client.run(installAdapter(packageURL))

    expect(requested).toEqual([packageURL])
    expect(installed.adapter).toMatchObject({
      adapterId: "remote-fixture",
      packageName: "@atape/adapter-remote-fixture",
      upgradeSpec: packageURL
    })
    const adapterDirectory = await stat(client.paths.adapterDirectory)
    expect(adapterDirectory.isDirectory()).toBe(true)
    const stagingEntries = await import("node:fs/promises").then(({ readdir }) => readdir(client.paths.adapterDirectory))
    expect(stagingEntries.some((name) => name.startsWith(".download-"))).toBe(false)
  })
})

const packedAdapterFixture = async (root: string, adapterId: string) => {
  const source = join(root, `${adapterId}-source`)
  const artifacts = join(root, `${adapterId}-artifacts`)
  await Promise.all([mkdir(source, { recursive: true }), mkdir(artifacts, { recursive: true })])
  await writeFile(join(source, "index.js"), "export const adapter = {}\n")
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: `@atape/adapter-${adapterId}`,
    version: "1.0.0",
    type: "module",
    scripts: { install: "node -e \"require('fs').writeFileSync('lifecycle-ran', 'yes')\"" },
    atapeAdapter: {
      protocolVersion: "atape.adapter.v1alpha1",
      adapterId,
      displayName: `${adapterId} Harness`,
      entry: "./index.js",
      harnesses: [adapterId]
    }
  }))
  const packed = JSON.parse((await exec("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", artifacts
  ], { cwd: source })).stdout) as ReadonlyArray<{ filename: string }>
  const filename = packed[0]?.filename
  if (filename === undefined) throw new Error("npm pack did not produce an Adapter archive")
  return { source, tarball: join(artifacts, filename) }
}
