import { AdapterPackages } from "@atape/application"
import { releaseBundleSection, releasePackageNames, type ReleaseBundle } from "@atape/domain"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { adapterPackageRoot } from "./adapterInstallation.ts"
import { makeAdapterPackagesLayer } from "./adapterPackages.ts"
import { createReleaseDiscovery, type ReleaseDiscovery } from "./releaseDiscovery.ts"

const exec = promisify(execFile), roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const root = async () => { const path = await mkdtemp(join(tmpdir(), "atape-official-adapter-")); roots.push(path); return path }
const packed = async (home: string, version = "1.2.3", adapterId = "codex", packageName = "@atape/adapter-codex") => {
  const source = join(home, "source"), destination = join(home, "archives")
  await mkdir(source); await mkdir(destination)
  await writeFile(join(source, "index.js"), "export const adapter = { version: 'verified' }\n")
  await writeFile(join(source, "package.json"), JSON.stringify({ name: packageName, version, type: "module",
    scripts: { install: "node -e \"require('fs').writeFileSync('lifecycle-ran','true')\"" },
    atapeAdapter: { protocolVersion: "atape.adapter.v1alpha1", adapterId, displayName: "Fixture Codex",
      entry: "./index.js", harnesses: [adapterId] } }))
  const result = JSON.parse((await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: source })).stdout)
  return { source, archive: join(destination, result[0].filename as string) }
}
const releaseFixture = async (home: string, archive: string) => {
  const bytes = await readFile(archive), requested: string[] = []
  const bundle: ReleaseBundle = { protocol: "atape.release-bundle.v1", version: "1.2.3",
    captureStateContract: "capture.v2", updateControlProtocol: "atape.update-control.v1",
    packages: releasePackageNames.map(name => ({ name, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-1.2.3.tgz` })) }
  const fetchMetadata: typeof fetch = async url => {
    requested.push(String(url))
    if (String(url).startsWith("https://api.github.com/")) return Response.json({ tag_name: "v1.2.3",
      body: releaseBundleSection(bundle), prerelease: false, draft: false, published_at: "2026-01-01T00:00:00Z" })
    return new Response(bytes)
  }
  return { bundle, requested, discovery: createReleaseDiscovery({ home, runtimeVersion: "1.2.3", captureStateContract: "capture.v2",
    updateControlProtocol: "atape.update-control.v1", fetchMetadata }) }
}
const install = (directory: string, spec: string, discovery?: ReleaseDiscovery, active?: AbortSignal) => Effect.runPromise(
  Effect.scoped(AdapterPackages.use(packages => packages.install(spec))).pipe(
    Effect.provide(makeAdapterPackagesLayer(directory, globalThis.fetch, async () => [], discovery))
  ), active ? { signal: active } : undefined)

describe("official Adapter release installation", () => {
  it("installs a real verified archive, preserves canonical upgradeSpec and disables lifecycle scripts", async () => {
    const home = await root(), source = await packed(home), release = await releaseFixture(home, source.archive), directory = join(home, "adapters")
    const installed = await install(directory, "@atape/adapter-codex@1.2.3", release.discovery)
    expect(installed).toMatchObject({ packageName: "@atape/adapter-codex", version: "1.2.3", upgradeSpec: "@atape/adapter-codex",
      manifest: { adapterId: "codex" } })
    expect(release.requested).toEqual([
      "https://api.github.com/repos/SingleMai/ATape/releases/tags/v1.2.3",
      "https://registry.npmjs.org/@atape/adapter-codex/-/adapter-codex-1.2.3.tgz"
    ])
    const installedRoot = adapterPackageRoot(directory, installed)
    expect(await readFile(join(installedRoot, "index.js"), "utf8")).toBe("export const adapter = { version: 'verified' }\n")
    await expect(stat(join(installedRoot, "lifecycle-ran"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(join(home, "cache", "release-discovery", "artifacts"))).toEqual([])
  }, 20_000)

  it("rejects official registry installation without discovery or an exact stable version before npm", async () => {
    const home = await root(), directory = join(home, "adapters")
    const never = vi.fn(), discovery: ReleaseDiscovery = { latest: never, exact: never, acquireArtifact: never }
    await expect(install(directory, "@atape/adapter-codex@1.2.3")).rejects.toMatchObject({ reason: "invalid_spec" })
    for (const spec of ["@atape/adapter-codex", "@atape/adapter-codex@latest", "@atape/adapter-codex@^1.2.3",
      "@atape/adapter-codex@1.2.3-beta", "@atape/adapter-codex@01.2.3", "@atape/adapter-codex@9007199254740992.0.0"])
      await expect(install(directory, spec, discovery)).rejects.toMatchObject({ reason: "invalid_spec" })
    expect(never).not.toHaveBeenCalled()
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([
    { version: "1.2.2", id: "codex", name: "@atape/adapter-codex" },
    { version: "1.2.3", id: "different", name: "@atape/adapter-codex" },
    { version: "1.2.3", id: "codex", name: "@other/adapter-codex" }
  ])("rejects a verified archive with mismatched internal identity before creating an installation slot: %j", async value => {
    const home = await root(), source = await packed(home, value.version, value.id, value.name)
    const release = await releaseFixture(home, source.archive), directory = join(home, "adapters")
    await expect(install(directory, "@atape/adapter-codex@1.2.3", release.discovery)).rejects.toMatchObject({ reason: "manifest" })
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(join(home, "cache", "release-discovery", "artifacts"))).toEqual([])
  }, 20_000)

  it("keeps local packages with official names on their original source without requiring discovery", async () => {
    const home = await root(), source = await packed(home), directory = join(home, "adapters")
    const installed = await install(directory, source.archive)
    expect(installed).toMatchObject({ packageName: "@atape/adapter-codex", version: "1.2.3", upgradeSpec: `file:${await realpath(source.archive)}` })
    await expect(stat(join(home, "cache"))).rejects.toMatchObject({ code: "ENOENT" })
  }, 20_000)

  it("waits for cancelled npm to exit before releasing the verified archive and installation slot", async () => {
    const home = await root(), source = await packed(home), release = await releaseFixture(home, source.archive), directory = join(home, "adapters")
    const bin = join(home, "bin"); await mkdir(bin)
    await writeFile(join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
const home = ${JSON.stringify(home)};
const archive = process.argv.at(-1).slice("file:".length);
process.on("SIGTERM", () => fs.writeFileSync(home + "/terminated", JSON.stringify({ archive, exists: fs.existsSync(archive) })));
fs.writeFileSync(home + "/started", JSON.stringify({ pid: process.pid, archive }));
setInterval(() => {}, 1000);
`)
    await chmod(join(bin, "npm"), 0o755); vi.stubEnv("PATH", `${bin}:${process.env.PATH}`)
    const active = new AbortController()
    let settled = false, child: { pid: number; archive: string } | undefined
    const pending = install(directory, "@atape/adapter-codex@1.2.3", release.discovery, active.signal)
      .then(() => "success", () => "cancelled").finally(() => { settled = true })
    try {
      await expect.poll(() => readFile(join(home, "started"), "utf8").catch(() => ""), { timeout: 5_000 }).not.toBe("")
      child = JSON.parse(await readFile(join(home, "started"), "utf8"))
      active.abort()
      await expect.poll(() => readFile(join(home, "terminated"), "utf8").catch(() => "")).not.toBe("")
      expect(JSON.parse(await readFile(join(home, "terminated"), "utf8"))).toMatchObject({ exists: true })
      expect(settled).toBe(false)
      expect(await readFile(child!.archive)).toEqual(await readFile(source.archive))
      expect(await pending).toBe("cancelled")
      expect(() => process.kill(child!.pid, 0)).toThrow()
      await expect(stat(child!.archive)).rejects.toMatchObject({ code: "ENOENT" })
      expect(await readdir(join(directory, "slots"))).toEqual([])
    } finally {
      active.abort()
      if (child) { try { process.kill(child.pid, "SIGKILL") } catch {} }
      await pending
    }
  }, 15_000)
})
