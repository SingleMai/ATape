import {
  CollectorDaemonProcess,
  inspectClient,
  installAdapter,
  upgradeAdapters,
  setupProject,
  AdapterPackages,
  pruneAdapterPackages,
  type ClientConfigStore,
  type ProjectLocator
} from "@atape/application"
import { emptyClientConfig } from "@atape/domain"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeNodeClientLayer } from "./clientLayers.ts"
import { adapterPackageRoot } from "./adapterInstallation.ts"

const exec = promisify(execFile)
const temporaryDirectories: Array<string> = []

afterEach(async () => {
  vi.unstubAllEnvs()
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
    adapterDirectory: join(root, "data", "adapters")
  }
  const layer = makeNodeClientLayer(paths, process.env, fetchAdapterPackage)
  const run = <A, E>(effect: Effect.Effect<
    A,
    E,
    CollectorDaemonProcess | ClientConfigStore | ProjectLocator | AdapterPackages
  >, signal?: AbortSignal) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)), signal ? { signal } : undefined)
  return { root, paths, run }
}

const setupInput = (path: string, type: "auto" | "git" | "directory" = "auto") => ({
  path,
  instanceOrigin: "https://atape.net",
  userId: "user-1",
  teamId: "team-1",
  teamSlug: "acme",
  teamName: "Acme Engineering",
  projectId: type === "directory" ? path.split("/").at(-1) ?? "project" : "payments",
  name: type === "directory" ? path.split("/").at(-1) ?? "Project" : "Payments",
  createdAt: "2026-09-06T00:00:00Z",
  repositoryIdentity: "github.com/acme/payments",
  type
} as const)

describe("Node client Layers", () => {
  it("keeps configuration responsive during installation and waits for cancelled npm before cleaning its slot", async () => {
    const client = await fixture()
    const bin = join(client.root, "bin")
    await mkdir(bin)
    await writeFile(join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const root = ${JSON.stringify(client.root)};
process.on("SIGTERM", () => fs.writeFileSync(root + "/terminated", "true"));
fs.writeFileSync(root + "/pid", String(process.pid));
setInterval(() => {}, 1000);
`)
    await chmod(join(bin, "npm"), 0o755)
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`)
    const cancellation = new AbortController()
    let settled = false, pid: number | undefined
    const pending = client.run(installAdapter("@atape/adapter-codex@0.4.4"), cancellation.signal)
      .then(() => "success", () => "cancelled").finally(() => { settled = true })
    try {
      const marker = join(client.root, "pid")
      // Child startup competes with the full suite; the cancellation assertions below
      // begin only after the child has installed its signal handler.
      await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 5_000 }).not.toBe("")
      pid = Number(await readFile(marker, "utf8"))
      expect(await client.run(inspectClient())).toEqual(emptyClientConfig())
      await client.run(setupProject(setupInput(client.root, "directory")))
      cancellation.abort()
      await expect.poll(() => readFile(join(client.root, "terminated"), "utf8").catch(() => "")).toBe("true")
      expect(settled).toBe(false)
      await expect(readFile(`${client.paths.configFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" })
      expect(await pending).toBe("cancelled")
      expect(() => process.kill(pid!, 0)).toThrow()
      await expect(readFile(`${client.paths.configFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" })
      expect((await client.run(inspectClient())).adapters).toEqual([])
      expect((await client.run(inspectClient())).projects).toHaveLength(1)
      expect(await readdir(join(client.paths.adapterDirectory, "slots"))).toEqual([])
    } finally {
      cancellation.abort()
      if (pid) { try { process.kill(pid, "SIGKILL") } catch {} }
      await pending
    }
  }, 10_000)
  it("protects prepared packages until their activation scope closes, and preserves unknown slots", async () => {
    const client = await fixture(), source = await packedAdapterFixture(client.root, "pending-slot")
    const slot = await client.run(Effect.scoped(Effect.gen(function*() {
      const prepared = yield* (yield* AdapterPackages).install(source.source)
      expect((yield* inspectClient()).adapters).toEqual([])
      const report = yield* pruneAdapterPackages({ apply: true, keep: 0 })
      expect(report.removed).toBe(0)
      expect(report.slots).toContainEqual(expect.objectContaining({ slot: prepared.packageSlot, state: "in_use" }))
      return prepared.packageSlot!
    })))
    const slots = join(client.paths.adapterDirectory, "slots"), root = join(slots, slot)
    const child = await exec(process.execPath, ["-e", "console.log(process.pid)"])
    expect(() => process.kill(Number(child.stdout.trim()), 0)).toThrow()
    await mkdir(join(root, ".atape-leases", `${child.stdout.trim()}-${randomUUID()}`))
    const legacy = randomUUID(), malformed = randomUUID(), linked = randomUUID()
    await mkdir(join(slots, legacy))
    await mkdir(join(slots, malformed))
    await writeFile(join(slots, malformed, ".atape-installation.json"), "invalid")
    await symlink(source.source, join(slots, linked))
    // A crashed sweep may have permanently retired the slot before removing files.
    await mkdir(join(client.paths.adapterDirectory, "retired-slots", slot), { recursive: true })
    const applied = await client.run(pruneAdapterPackages({ apply: true }))
    expect(applied.removed).toBe(1)
    expect((await stat(join(client.paths.adapterDirectory, "retired-slots", slot))).isDirectory()).toBe(true)
    expect(applied.slots.filter(item => item.state === "unmanaged").map(item => item.slot).sort()).toEqual([legacy, malformed, linked].sort())
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await stat(source.source)).isDirectory()).toBe(true)
    for (const keep of [-1, 1.5, 21]) await expect(client.run(pruneAdapterPackages({ keep }))).rejects.toMatchObject({ reason: "invalid" })
  }, 20_000)

  it("allows concurrent cleanup calls to finish the same retired installation", async () => {
    const client = await fixture(), source = await packedAdapterFixture(client.root, "concurrent-prune")
    const prepared = await client.run(Effect.scoped(AdapterPackages.use(packages => packages.install(source.source))))
    const results = await Promise.allSettled([
      client.run(pruneAdapterPackages({ apply: true, keep: 0 })),
      client.run(pruneAdapterPackages({ apply: true, keep: 0 }))
    ])
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"])
    await expect(stat(join(client.paths.adapterDirectory, "slots", prepared.packageSlot!))).rejects.toMatchObject({ code: "ENOENT" })
  }, 20_000)

  it("reads only current configuration without rewriting unsupported data", async () => {
    const client = await fixture()
    expect(await client.run(inspectClient())).toEqual(emptyClientConfig())
    const unsupported = JSON.stringify({ version: 2, projects: [], adapters: [] })
    await writeFile(client.paths.configFile, unsupported)
    await expect(client.run(inspectClient())).rejects.toMatchObject({ reason: "decode" })
    expect(await readFile(client.paths.configFile, "utf8")).toBe(unsupported)
  })

  it("detects the Git root and persists owner-only atomic configuration", async () => {
    const client = await fixture()
    const repository = join(client.root, "payments")
    const nested = join(repository, "services", "api")
    await mkdir(nested, { recursive: true })
    await exec("git", ["init", "-q", repository])
    await exec("git", ["-C", repository, "remote", "add", "origin", "git@github.com:acme/payments.git"])
    const canonicalRepository = await realpath(repository)

    const result = await client.run(setupProject(setupInput(nested)))
    const persisted = JSON.parse(await readFile(client.paths.configFile, "utf8")) as {
      projects: ReadonlyArray<{ path: string; type: string }>
    }
    const metadata = await stat(client.paths.configFile)

    expect(result.project).toMatchObject({ id: "payments", path: canonicalRepository, type: "git" })
    expect(persisted.projects).toEqual([expect.objectContaining({ path: canonicalRepository, type: "git" })])
    expect(persisted.projects[0]).not.toHaveProperty("adapterIds")
    expect(metadata.mode & 0o777).toBe(0o600)
  })

  it("rejects directory mode inside Git, including a nested path", async () => {
    const client = await fixture()
    const repository = join(client.root, "repo"), nested = join(repository, "src")
    await mkdir(nested, { recursive: true })
    await exec("git", ["init", "-q", repository])
    await expect(client.run(setupProject(setupInput(nested, "directory"))))
      .rejects.toThrow("without --type directory")
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

    expect(installed.adapter).toMatchObject({
      adapterId: "fixture",
      packageName: "@atape/adapter-fixture",
      version: "1.0.0",
      upgradeSpec: `file:${canonicalAdapter}`
    })
    expect((await client.run(inspectClient())).enabledAdapterIds).toEqual([])
    await expect(stat(join(adapter, "lifecycle-ran"))).rejects.toMatchObject({ code: "ENOENT" })
    const installedRoot = adapterPackageRoot(client.paths.adapterDirectory, installed.adapter)
    await expect(stat(join(installedRoot, "lifecycle-ran"))).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(join(adapter, "index.js"), "throw new Error('mutable source changed')\n")
    expect(await readFile(join(installedRoot, "index.js"), "utf8")).toBe("export const adapter = {}\n")
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
    await expect(stat(join(adapterPackageRoot(client.paths.adapterDirectory, installed.adapter), "lifecycle-ran")))
      .rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves a working installation after invalid upgrades and selects a valid replacement without changing its old files", async () => {
    const client = await fixture(), packageFiles = await packedAdapterFixture(client.root, "upgrade-fixture")
    const first = (await client.run(installAdapter(packageFiles.source))).adapter
    const before = await client.run(inspectClient())
    const oldRoot = adapterPackageRoot(client.paths.adapterDirectory, first)
    const manifestPath = join(packageFiles.source, "package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "2.0.0", atapeAdapter: { ...manifest.atapeAdapter, entry: "./missing.js" } }))
    await expect(client.run(upgradeAdapters("upgrade-fixture"))).rejects.toMatchObject({ reason: "manifest" })
    expect(await client.run(inspectClient())).toEqual(before)
    expect(JSON.parse(await readFile(join(oldRoot, "package.json"), "utf8")).version).toBe("1.0.0")
    expect(await readdir(join(client.paths.adapterDirectory, "slots"))).toEqual([first.packageSlot])

    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "2.0.0", atapeAdapter: { ...manifest.atapeAdapter, adapterId: "different" } }))
    await expect(client.run(upgradeAdapters("upgrade-fixture"))).rejects.toMatchObject({ reason: "conflict" })
    expect(await client.run(inspectClient())).toEqual(before)

    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "2.0.0" }))
    const replacement = (await client.run(upgradeAdapters("upgrade-fixture")))[0]!
    expect(replacement).toMatchObject({ version: "2.0.0", installedAt: first.installedAt, upgradeSpec: first.upgradeSpec })
    expect(replacement.packageSlot).not.toBe(first.packageSlot)
    expect(JSON.parse(await readFile(join(adapterPackageRoot(client.paths.adapterDirectory, replacement), "package.json"), "utf8")).version).toBe("2.0.0")
    expect(JSON.parse(await readFile(join(oldRoot, "package.json"), "utf8")).version).toBe("1.0.0")
  }, 20_000)

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
