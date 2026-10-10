import { AutomaticUpdatePlatform, ClientConfigStore, CLIUpgradePlatform, CollectorDaemonProcess, resumeCLIUpgrade, upgradeCLI } from "@atape/application"
import { emptyClientConfig, releaseBundleSection, releasePackageNames, updateCatalogTag, type ReleaseBundle, type AdapterInstallation, type ClientConfig } from "@atape/domain"
import { Effect, Layer } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { gzipSync } from "node:zlib"
import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeCLIUpgradePlatformLayer } from "./cliUpgradePlatform.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { atomicJSON, managedStateContract, readRuntimeSelection, readSelectedClientConfig, runtimeEntry, selectRuntime, type RuntimeSelection } from "./runtimeSelection.ts"
import { createUpdateControl, updateControlProtocol } from "./updateControl.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { acquireProcessLock } from "./processLock.ts"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const bytes = (version: string) => {
  const payload = Buffer.from(JSON.stringify({ name: "@atape/cli", version, atapeRuntime: { protocol: "atape.runtime.v1",
    stateContract: managedStateContract, updateControlProtocol, releaseCatalogProtocol: "atape.update-catalog.v1" } }))
  const header = Buffer.alloc(512)
  header.write("package/package.json"); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116)
  header.write(payload.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136)
  header.fill(32, 148, 156); header[156] = 48
  header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148)
  return gzipSync(Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512 + 1024)]))
}
const bundle = (version: string): ReleaseBundle => ({ protocol: "atape.release-bundle.v1", version,
  captureStateContract: managedStateContract, updateControlProtocol,
  packages: releasePackageNames.map(name => ({ name, integrity: `sha512-${createHash("sha512").update(bytes(version)).digest("base64")}`,
    tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` })) })
const catalog = (version: string) => ({ tag_name: updateCatalogTag, prerelease: true, draft: false, published_at: "2026-01-01T00:00:00Z",
  body: JSON.stringify({ protocol: "atape.update-catalog.v1", revision: 1, bundles: [bundle(version)] }) })
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const fixture = async (fetchMetadata: typeof fetch, failInstall = false, ignoreTermination = false, partialFailure = false, invalidVerification = false) => {
  const root = await mkdtemp(join(tmpdir(), "atape-upgrade-")); roots.push(root)
  const prefix = join(root, "prefix"), modules = join(prefix, "lib/node_modules")
  const entry = join(modules, "@atape/cli/dist/atape.js")
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(join(dirname(dirname(entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version: "0.4.1" }))
  await writeFile(entry, 'console.log("ATape 0.4.1")')
  const bin = join(root, "bin"); await mkdir(bin)
  // Controlled external npm Adapter: all filesystem and executable verification
  // use disposable real paths. Never invoke the user's global npm installation.
  await writeFile(join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "prefix") console.log(process.env.UPGRADE_TEST_PREFIX);
else if (args[0] === "root") console.log(process.env.UPGRADE_TEST_MODULES);
else if (args[0] === "install") {
  fs.writeFileSync(process.env.UPGRADE_TEST_CALLS, JSON.stringify(args));
  if (process.env.UPGRADE_TEST_IGNORE_TERMINATION === "true") {
    process.on("SIGTERM", () => fs.writeFileSync(process.env.UPGRADE_TEST_ENTRY + ".terminated", "true"));
    fs.writeFileSync(process.env.UPGRADE_TEST_ENTRY + ".pid", String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.UPGRADE_TEST_FAIL === "true") process.exit(1);
  if (process.env.UPGRADE_TEST_PARTIAL_FAILURE === "true" && !fs.existsSync(process.env.UPGRADE_TEST_CALLS + ".failed")) {
    fs.rmSync(process.env.UPGRADE_TEST_ENTRY);
    fs.rmSync(process.env.UPGRADE_TEST_MANIFEST);
    fs.rmSync(process.env.UPGRADE_TEST_BIN, { force: true });
    fs.writeFileSync(process.env.UPGRADE_TEST_CALLS + ".failed", "true");
    process.exit(1);
  }
  const archive = args.find(arg => arg.endsWith(".tgz"));
  const tar = require("node:zlib").gunzipSync(fs.readFileSync(archive));
  const size = parseInt(tar.subarray(124, 136).toString().replace(/\\0/g, "").trim(), 8);
  const candidate = JSON.parse(tar.subarray(512, 512 + size).toString());
  const version = candidate.version;
  fs.writeFileSync(process.env.UPGRADE_TEST_CALLS + ".archive", fs.readFileSync(archive));
  const manifest = JSON.parse(fs.readFileSync(process.env.UPGRADE_TEST_MANIFEST, "utf8"));
  fs.writeFileSync(process.env.UPGRADE_TEST_MANIFEST, JSON.stringify(candidate));
  if (process.env.UPGRADE_TEST_INVALID_VERIFICATION === "true") {
    fs.writeFileSync(process.env.UPGRADE_TEST_ENTRY, 'console.log("ATape incorrect")');
  } else if (manifest.atapeRuntime) {
    fs.writeFileSync(process.env.UPGRADE_TEST_ENTRY, 'if (process.env.ATAPE_RUNTIME_DIRECT !== "1") throw new Error("Generic verification would read the stale control identity"); console.log("ATape ' + version + '")');
  } else fs.writeFileSync(process.env.UPGRADE_TEST_ENTRY, 'console.log("ATape ' + version + '")');
} else process.exit(1);
`)
  await chmod(join(bin, "npm"), 0o755)
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UPGRADE_TEST_PREFIX: prefix,
    ATAPE_CONFIG_FILE: join(root, "override-config", "client.json"),
    UPGRADE_TEST_FAIL: String(failInstall),
    UPGRADE_TEST_PARTIAL_FAILURE: String(partialFailure),
    UPGRADE_TEST_INVALID_VERIFICATION: String(invalidVerification),
    UPGRADE_TEST_BIN: join(prefix, "bin", "atape"),
    UPGRADE_TEST_IGNORE_TERMINATION: String(ignoreTermination),
    UPGRADE_TEST_MANIFEST: join(dirname(dirname(entry)), "package.json"),
    UPGRADE_TEST_MODULES: modules, UPGRADE_TEST_CALLS: join(root, "calls.json"), UPGRADE_TEST_ENTRY: entry }
  const transport: typeof fetch = async (url, init) => {
    const address = String(url), match = address.match(/\/v(\d+\.\d+\.\d+)$/)
    if (match) return Response.json({ tag_name: `v${match[1]}`, body: releaseBundleSection(bundle(match[1]!)), prerelease: false, draft: false, published_at: "2026-01-01T00:00:00Z" })
    const archive = address.match(/-(\d+\.\d+\.\d+)\.tgz$/)
    if (archive) return new Response(bytes(archive[1]!))
    return fetchMetadata(url, init)
  }
  const supporting = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => change(emptyClientConfig()).pipe(Effect.map(result => result.value)) })),
    Layer.succeed(AutomaticUpdatePlatform, AutomaticUpdatePlatform.of({
      recoveryPending: () => Effect.die("Unconfigured fixture cannot recover"), supported: () => Effect.die("Unexpected probe"), schedule: () => Effect.die("Unexpected schedule"),
      target: () => Effect.die("Unexpected target"), prepare: () => Effect.die("Unconfigured fixture cannot prepare"), activate: () => Effect.die("Unconfigured fixture cannot activate"), record: () => Effect.die("Unexpected record"), launch: () => Effect.die("Unexpected launch")
    })))
  const run = <A, E>(effect: Effect.Effect<A, E, CLIUpgradePlatform | ClientConfigStore | AutomaticUpdatePlatform>, path = entry, signal?: AbortSignal) => Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(supporting, makeCLIUpgradePlatformLayer(root, path, environment, transport, "0.4.1")))), signal ? { signal } : undefined)
  return { root, entry, modules, prefix, run, environment, paths: defaultNodeClientPaths({ ...environment, ATAPE_HOME: root }) }
}
const latest = (cached = true) => Effect.gen(function*() { return yield* (yield* CLIUpgradePlatform).latest(cached) })
const install = (version: string) => Effect.scoped(Effect.gen(function*() {
  const platform = yield* CLIUpgradePlatform
  yield* platform.acquireOwnership()
  yield* platform.install(bundle(version))
}))
const managedFixture = async (failInstall = false, floor = false, partialFailure = false, invalidVerification = false) => {
  const client = await fixture(async () => Response.json(catalog("0.5.6")), failInstall, false, partialFailure, invalidVerification)
  const manifest = { name: "@atape/cli", version: "0.5.4", atapeRuntime: {
    protocol: "atape.runtime.v1", stateContract: managedStateContract, updateControlProtocol
  } }
  await atomicJSON(client.environment.UPGRADE_TEST_MANIFEST, manifest)
  await writeFile(client.entry, 'console.log("ATape 0.5.4")')
  const original: AdapterInstallation = { adapterId: "codex", packageName: "@atape/adapter-codex", version: "0.5.4",
    packageSlot: randomUUID(), upgradeSpec: "@atape/adapter-codex", displayName: "Codex",
    installedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }
  const selected = { ...original, version: "0.5.5", packageSlot: randomUUID(), updatedAt: "2026-10-10T00:00:00Z" }
  const config = { ...emptyClientConfig(), locale: "zh-CN" as const, autoUpdateEnabled: false, autoStartEnabled: false,
    toolsConfigured: true, enabledAdapterIds: ["codex"], adapters: [original] }
  await atomicJSON(client.paths.configFile, config)
  const entry = runtimeEntry(client.root, selected.version)
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, 'console.log("ATape 0.5.5")')
  await atomicJSON(join(dirname(dirname(entry)), "package.json"), { ...manifest, version: selected.version })
  const control = createUpdateControl(client.root)
  const ticket = await control.prepare({ next: { protocol: updateControlProtocol, version: selected.version,
    captureStateContract: managedStateContract, bootstrapEntry: client.entry,
    bootstrapIdentity: createHash("sha256").update(await readFile(client.entry)).digest("hex"),
    adapters: [{ before: original, after: selected }] } })
  await control.begin(ticket)
  if (floor) await control.fence(ticket)
  await control.complete(ticket)
  return { ...client, control, original, selected, config,
    pointer: join(client.root, "updates", "runtime.json"), ledger: join(client.root, "updates", "control.json") }
}

describe("Node CLI upgrade Adapter", () => {
  it.each(["partial npm failure", "direct verification failure"])("restores the runnable global identity and original bin link after %s, retaining managed runtime and Stop intent for retry", async failure => {
    const client = await managedFixture(false, true, failure === "partial npm failure", failure === "direct verification failure")
    await mkdir(dirname(client.environment.UPGRADE_TEST_BIN), { recursive: true })
    const linkTarget = "../lib/node_modules/@atape/cli/dist/atape.js"
    await symlink(linkTarget, client.environment.UPGRADE_TEST_BIN)
    const intentFile = `${client.paths.collectorProcessFile}.desired.json`
    await atomicJSON(intentFile, { version: 1, wanted: false })
    const originalEntry = await readFile(client.entry), originalManifest = await readFile(client.environment.UPGRADE_TEST_MANIFEST)
    const pointer = await readFile(client.pointer), ledger = await readFile(client.ledger), stop = await readFile(intentFile)
    await expect(client.run(install("0.5.6"))).rejects.toMatchObject({ reason: "install" })
    expect(await readFile(client.entry)).toEqual(originalEntry)
    expect(await readFile(client.environment.UPGRADE_TEST_MANIFEST)).toEqual(originalManifest)
    expect(await readlink(client.environment.UPGRADE_TEST_BIN)).toBe(linkTarget)
    expect(await readFile(client.pointer)).toEqual(pointer)
    expect(await readFile(client.ledger)).toEqual(ledger)
    expect(await readFile(intentFile)).toEqual(stop)
    expect((await Effect.runPromise(readSelectedClientConfig(client.paths))).adapters).toEqual([client.selected])
    expect(await client.control.recoveryPending()).toBe(false)
    expect(await readdir(join(client.root, "cache", "release-discovery", "artifacts"))).toEqual([])
    expect(await client.run(CLIUpgradePlatform.use(platform => platform.installedVersion()))).toBe("0.5.4")
    client.environment.UPGRADE_TEST_INVALID_VERIFICATION = "false"
    await client.run(install("0.5.6"))
    expect(await client.run(CLIUpgradePlatform.use(platform => platform.installedVersion()))).toBe("0.5.6")
    expect((await client.control.readSelection())?.version).toBe("0.5.6")
    expect((await Effect.runPromise(readSelectedClientConfig(client.paths))).adapters).toEqual([client.selected])
    expect(await readFile(intentFile)).toEqual(stop)
    expect(await readdir(join(client.root, "cache", "release-discovery", "artifacts"))).toEqual([])
  })

  it("restores the old command entry when rebind rejects an immutable generation before changing durable control", async () => {
    const client = await managedFixture(), conflicting = runtimeEntry(client.root, "0.5.6")
    await mkdir(dirname(conflicting), { recursive: true })
    await writeFile(conflicting, 'console.log("ATape 0.5.6"); // different immutable bytes')
    await atomicJSON(join(dirname(dirname(conflicting)), "package.json"), { name: "@atape/cli", version: "0.5.6",
      atapeRuntime: { protocol: "atape.runtime.v1", stateContract: managedStateContract, updateControlProtocol } })
    const originalEntry = await readFile(client.entry), originalManifest = await readFile(client.environment.UPGRADE_TEST_MANIFEST)
    const pointer = await readFile(client.pointer), ledger = await readFile(client.ledger)
    await expect(client.run(install("0.5.6"))).rejects.toMatchObject({ reason: "install" })
    expect(await readFile(client.entry)).toEqual(originalEntry)
    expect(await readFile(client.environment.UPGRADE_TEST_MANIFEST)).toEqual(originalManifest)
    expect(await readFile(client.pointer)).toEqual(pointer)
    expect(await readFile(client.ledger)).toEqual(ledger)
    expect(await client.control.recoveryPending()).toBe(false)
    expect((await Effect.runPromise(readSelectedClientConfig(client.paths))).adapters).toEqual([client.selected])
    expect(await readdir(join(client.root, "cache", "release-discovery", "artifacts"))).toEqual([])
  })

  it.each([false, true])("preserves independent slots and control compatibility across manual npm replacement (failure=%s)", async failure => {
    const client = await managedFixture(failure, true)
    const pointer = await readFile(client.pointer, "utf8"), ledger = await readFile(client.ledger, "utf8")
    if (failure) await expect(client.run(install("0.5.6"))).rejects.toMatchObject({ reason: "install" })
    else await client.run(install("0.5.6"))
    expect(JSON.parse(await readFile(client.paths.configFile, "utf8"))).toEqual({ ...client.config, adapters: [client.selected] })
    expect((await Effect.runPromise(readSelectedClientConfig(client.paths))).adapters).toEqual([client.selected])
    expect(await client.control.recoveryPending()).toBe(false)
    if (failure) {
      expect(await readFile(client.pointer, "utf8")).toBe(pointer)
      expect(await readFile(client.ledger, "utf8")).toBe(ledger)
      expect(await readFile(client.entry, "utf8")).toContain("0.5.4")
    } else {
      const selection = await client.control.readSelection()
      expect(selection).toMatchObject({ version: "0.5.6", captureStateContract: managedStateContract, adapters: [] })
      expect(selection?.bootstrapIdentity).toBe(createHash("sha256").update(await readFile(client.entry)).digest("hex"))
      expect(await readFile(runtimeEntry(client.root, "0.5.6"), "utf8")).toBe(await readFile(client.entry, "utf8"))
      expect(JSON.parse(await readFile(client.ledger, "utf8"))).toMatchObject({ phase: "completed", forwardOnly: true,
        floor: { minimumRuntimeVersion: "0.5.6", captureStateContract: managedStateContract } })
      await expect(client.control.assertRuntimeAdmission({ version: "0.5.5", captureStateContract: managedStateContract }))
        .rejects.toMatchObject({ reason: "admission" })
    }
  })

  it("refuses npm replacement before mutation when independent recovery is pending or the selected version is newer", async () => {
    const client = await managedFixture()
    const selected = (await client.control.readSelection())!
    await expect(client.run(install("0.5.4"))).rejects.toMatchObject({ reason: "installation", message: expect.stringContaining("already selected") })
    await client.control.prepare({ next: selected })
    const pointer = await readFile(client.pointer, "utf8"), ledger = await readFile(client.ledger, "utf8")
    await expect(client.run(install("0.5.6"))).rejects.toMatchObject({ reason: "installation", message: expect.stringContaining("must recover") })
    await expect(readFile(join(client.root, "calls.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(client.pointer, "utf8")).toBe(pointer)
    expect(await readFile(client.ledger, "utf8")).toBe(ledger)
    expect(JSON.parse(await readFile(client.paths.configFile, "utf8"))).toEqual(client.config)
    expect(await readFile(client.entry, "utf8")).toContain("0.5.4")
  })

  it("excludes manual replacement while automatic maintenance owns this home", async () => {
    const client = await fixture(async () => Response.json(catalog("0.4.2")))
    const release = await acquireUpdateWorker(client.root)
    expect(release).toBeDefined()
    try {
      await expect(client.run(install("0.4.2"))).rejects.toMatchObject({ reason: "installation", message: expect.stringContaining("Another ATape update") })
      await expect(readFile(join(client.root, "calls.json"))).rejects.toMatchObject({ code: "ENOENT" })
      expect(await readFile(client.entry, "utf8")).toContain("0.4.1")
    } finally { release?.() }
    await client.run(install("0.4.2"))
    expect(await readFile(client.entry, "utf8")).toContain("0.4.2")
  })
  it.each([false, true])("retains shared ownership through Collector handoff (recovery=%s)", async recovery => {
    const client = await fixture(async () => Response.json(catalog("0.4.2")))
    let finish!: () => void, starting = false
    const wait = new Promise<void>(resolve => { finish = resolve })
    const process = Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      refresh: () => Effect.succeed(false),
      observe: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed({ pid: 1, startedAt: "now", logFile: "log", intervalMs: 45_000, concurrency: 2 }),
      pause: () => Effect.succeed(true),
      stop: () => Effect.die("Maintenance must not change user intent"),
      start: () => Effect.die("Maintenance must not issue Start"),
      resume: () => Effect.sync(() => { starting = true }).pipe(Effect.andThen(Effect.promise(() => wait)),
        Effect.as({ intervalMs: 45_000, concurrency: 2, pid: 2, startedAt: "later", logFile: "log", created: true }))
    }))
    const effect = recovery ? resumeCLIUpgrade({ version: "0.4.2", intervalMs: 45_000, concurrency: 2 }) : upgradeCLI("0.4.1")
    const pending = client.run(effect.pipe(Effect.provide(process)))
    try {
      await expect.poll(() => starting, { timeout: 3000 }).toBe(true)
      expect(await acquireUpdateWorker(client.root)).toBeUndefined()
      await expect(client.run(install("0.4.2"))).rejects.toMatchObject({ reason: "installation" })
    } finally { finish() }
    await expect(pending).resolves.toMatchObject({ updated: true, resumed: true })
    const released = await acquireUpdateWorker(client.root)
    expect(released).toBeDefined(); released?.()
  })
  it("shares complete cached bundle discovery and fails closed on corrupt reader-floor state", async () => {
    let calls = 0
    const client = await fixture(async (url, options) => {
      calls++; expect(String(url)).toBe(`https://api.github.com/repos/SingleMai/ATape/releases/tags/${updateCatalogTag}`)
      expect(options?.signal).toBeDefined()
      return Response.json(catalog("0.4.2"))
    })
    expect(await client.run(latest())).toEqual(bundle("0.4.2"))
    expect(await client.run(latest())).toEqual(bundle("0.4.2"))
    expect(calls).toBe(1)
    await client.run(latest(false)); expect(calls).toBe(2)
    await writeFile(join(client.root, "cache/release-discovery/catalog.json"), "corrupt")
    await expect(client.run(latest())).rejects.toMatchObject({ reason: "check" })
    expect(calls).toBe(2)
  })
  it("rejects registry failures and oversized or foreign metadata", async () => {
    for (const response of [new Response("offline", { status: 503 }), Response.json({ name: "other", version: "0.4.2" }), new Response("x".repeat(262145))]) {
      const client = await fixture(async () => response)
      await expect(client.run(latest())).rejects.toMatchObject({ reason: "check" })
    }
  })
  it("updates only the active npm global installation, pins the release, verifies it and releases its lock", async () => {
    const client = await fixture(async () => Response.json(catalog("0.4.2")))
    await client.run(install("0.4.2"))
    const args = JSON.parse(await readFile(join(client.root, "calls.json"), "utf8"))
    expect(args.find((arg: string) => arg.endsWith(".tgz"))).toContain("/cache/release-discovery/artifacts/.lease-")
    expect(await readFile(join(client.root, "calls.json.archive"))).toEqual(bytes("0.4.2"))
    expect(args).toContain("--ignore-scripts")
    expect(args).toContain("--@atape:registry=https://registry.npmjs.org/")
    expect(args[args.indexOf("--prefix") + 1]).toBe(client.prefix)
    const released = await acquireProcessLock(join(client.modules, ".atape-upgrade.lock.sqlite"))
    expect(released).toBeDefined(); released?.()
    const foreign = join(client.root, "other.js"); await writeFile(foreign, "")
    await expect(client.run(install("0.4.2"), foreign)).rejects.toMatchObject({ reason: "installation" })
    await expect(client.run(install("latest;echo bad"))).rejects.toMatchObject({ reason: "install" })
  })
  it.each([false, true])("preserves selected Adapter slots and user settings before manual npm replacement (failure=%s)", async failInstall => {
    const client = await fixture(async () => Response.json(catalog("0.4.3")), failInstall)
    const original: AdapterInstallation = { adapterId: "codex", packageName: "@atape/adapter-codex",
      packageSlot: randomUUID(), version: "0.4.1", upgradeSpec: "@atape/adapter-codex", displayName: "Codex",
      installedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }
    const selected = { ...original, packageSlot: randomUUID(), version: "0.4.2", updatedAt: "2026-10-09T00:00:00Z" }
    const custom: AdapterInstallation = { ...original, adapterId: "custom", packageName: "@custom/reader", upgradeSpec: "file:/custom/reader" }
    const raw: ClientConfig = { ...emptyClientConfig(), locale: "zh-CN", autoUpdateEnabled: false,
      toolsConfigured: true, enabledAdapterIds: ["codex", "custom"], adapters: [original, custom],
      projects: [{ id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team",
        teamName: "Team", name: "Project", path: client.root, type: "directory", createdAt: "2026-10-01T00:00:00Z" }] }
    await atomicJSON(client.paths.configFile, raw)
    const pointer: RuntimeSelection = { protocol: "atape.runtime.v1", stateContract: managedStateContract, version: "0.4.2",
      bootstrapEntry: client.entry, bootstrapIdentity: createHash("sha256").update(await readFile(client.entry)).digest("hex"),
      adapters: [{ before: original, after: selected }] }
    await selectRuntime(client.root, pointer)
    expect((await Effect.runPromise(readSelectedClientConfig(client.paths))).adapters).toEqual([selected, custom])
    if (failInstall) await expect(client.run(install("0.4.3"))).rejects.toMatchObject({ reason: "install" })
    else await client.run(install("0.4.3"))
    expect(JSON.parse(await readFile(client.paths.configFile, "utf8"))).toEqual({ ...raw, adapters: [selected, custom] })
    expect((await Effect.runPromise(readSelectedClientConfig(client.paths))).adapters).toEqual([selected, custom])
    expect(await readRuntimeSelection(client.root)).toEqual(failInstall ? pointer : undefined)
    await expect(readFile(join(client.root, "config", "client.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("excludes an npm-root owner and ignores legacy markers, then releases ownership after npm fails", async () => {
    const client = await fixture(async () => Response.json(catalog("0.4.2")), true)
    const lock = join(client.modules, ".atape-upgrade.lock.sqlite"), legacy = join(client.modules, ".atape-upgrade.lock")
    await writeFile(legacy, "interrupted old installer")
    const owner = await acquireProcessLock(lock)
    expect(owner).toBeDefined()
    try {
      await expect(client.run(install("0.4.2"))).rejects.toMatchObject({ reason: "installation" })
      await expect(readFile(join(client.root, "calls.json"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally { owner?.() }
    await expect(client.run(install("0.4.2"))).rejects.toMatchObject({ reason: "install" })
    expect(await readFile(legacy, "utf8")).toBe("interrupted old installer")
    const npmReleased = await acquireProcessLock(lock)
    expect(npmReleased).toBeDefined(); npmReleased?.()
    expect(await readFile(client.entry, "utf8")).toContain("0.4.1")
    const released = await acquireUpdateWorker(client.root)
    expect(released).toBeDefined(); released?.()
  })
  it("retries after the npm-root owner is killed without removing its coordination file", async () => {
    const client = await fixture(async () => Response.json(catalog("0.4.2")))
    const lock = join(client.modules, ".atape-upgrade.lock.sqlite"), marker = join(client.root, "owner-ready")
    const module = fileURLToPath(new URL("./processLock.ts", import.meta.url))
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import { acquireProcessLock } from ${JSON.stringify(module)};
import { writeFile } from "node:fs/promises";
const release = await acquireProcessLock(${JSON.stringify(lock)});
if (!release) process.exit(2);
await writeFile(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);
`], { stdio: "ignore" })
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 3000 }).toBe("ready")
      await expect(client.run(install("0.4.2"))).rejects.toMatchObject({ reason: "installation" })
      await expect(readFile(join(client.root, "calls.json"))).rejects.toMatchObject({ code: "ENOENT" })
      child.kill("SIGKILL")
      await exited
      await client.run(install("0.4.2"))
      expect(await readFile(client.entry, "utf8")).toContain("0.4.2")
      await expect(readFile(lock)).resolves.toBeDefined()
    } finally { child.kill("SIGKILL"); await exited }
  })
  it.each(["0.4.3", "unknown", "0.4.3-beta.1"])("rejects a stale manual plan against actual installed version %s", async actual => {
    const client = await fixture(async () => Response.json(catalog("0.4.2")))
    await writeFile(join(dirname(dirname(client.entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version: actual }))
    await writeFile(client.entry, `console.log("ATape ${actual}")`)
    const process = Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      resume: () => Effect.die("Unexpected login resume"),
      pause: () => Effect.die("Stale update cannot pause collection"),
      refresh: () => Effect.die("Stale update cannot refresh collection"), inspect: () => Effect.succeed(undefined),
      observe: () => Effect.succeed(undefined),
      stop: () => Effect.die("Stale update cannot stop collection"), start: () => Effect.die("Stale update cannot start collection")
    }))
    await expect(client.run(upgradeCLI("0.4.1").pipe(Effect.provide(process)))).rejects.toMatchObject({ reason: "installation" })
    await expect(readFile(join(client.root, "calls.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(client.entry, "utf8")).toContain(actual)
    const released = await acquireProcessLock(join(client.modules, ".atape-upgrade.lock.sqlite"))
    expect(released).toBeDefined(); released?.()
  })
  it("bounds a slow startup registry request", async () => {
    const client = await fixture((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true })
    }))
    await expect(client.run(latest())).rejects.toMatchObject({ reason: "check" })
  })
  it("holds the lock until a cancelled installer exits, forcibly terminates it, and awaits cleanup", async () => {
    const client = await fixture(async () => Response.json(catalog("0.4.2")), false, true)
    const cancellation = new AbortController()
    let settled = false, pid: number | undefined
    const pending = client.run(install("0.4.2"), client.entry, cancellation.signal)
      .then(() => "success", () => "cancelled").finally(() => { settled = true })
    try {
      // Startup includes the owning npm probes before the controlled installer runs.
      await expect.poll(() => readFile(`${client.entry}.pid`, "utf8").catch(() => ""), { timeout: 10_000 }).not.toBe("")
      pid = Number(await readFile(`${client.entry}.pid`, "utf8"))
      cancellation.abort()
      await expect.poll(() => readFile(`${client.entry}.terminated`, "utf8").catch(() => "")).toBe("true")
      expect(settled).toBe(false)
      expect(await acquireProcessLock(join(client.modules, ".atape-upgrade.lock.sqlite"))).toBeUndefined()
      expect(await acquireUpdateWorker(client.root)).toBeUndefined()
      await expect(client.run(install("0.4.2"))).rejects.toMatchObject({ reason: "installation" })
      const otherHome = join(client.root, "other-home")
      await expect(Effect.runPromise(install("0.4.2").pipe(Effect.provide(makeCLIUpgradePlatformLayer(
        otherHome, client.entry, { ...client.environment, ATAPE_CONFIG_FILE: join(otherHome, "client.json") }
      ))))).rejects.toMatchObject({ reason: "installation", message: expect.stringContaining("owns this npm installation") })
      expect(await pending).toBe("cancelled")
      expect(() => process.kill(pid!, 0)).toThrow()
      const npmReleased = await acquireProcessLock(join(client.modules, ".atape-upgrade.lock.sqlite"))
      expect(npmReleased).toBeDefined(); npmReleased?.()
      expect(await readFile(client.entry, "utf8")).toContain("0.4.1")
      const released = await acquireUpdateWorker(client.root)
      expect(released).toBeDefined(); released?.()
    } finally {
      cancellation.abort()
      if (pid) { try { process.kill(pid, "SIGKILL") } catch {} }
      await pending
    }
  }, 30_000)
})
