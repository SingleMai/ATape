import { CLIUpgradePlatform, CollectorDaemonProcess, resumeCLIUpgrade, upgradeCLI } from "@atape/application"
import { emptyClientConfig, type AdapterInstallation, type ClientConfig } from "@atape/domain"
import { Effect, Layer } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeCLIUpgradePlatformLayer } from "./cliUpgradePlatform.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { atomicJSON, managedStateContract, readRuntimeSelection, readSelectedClientConfig, selectRuntime, type RuntimeSelection } from "./runtimeSelection.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { acquireProcessLock } from "./processLock.ts"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const fixture = async (fetchMetadata: typeof fetch, failInstall = false, ignoreTermination = false) => {
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
  const version = args.find(arg => arg.startsWith("@atape/cli@")).slice("@atape/cli@".length);
  fs.writeFileSync(process.env.UPGRADE_TEST_ENTRY, 'console.log("ATape ' + version + '")');
} else process.exit(1);
`)
  await chmod(join(bin, "npm"), 0o755)
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UPGRADE_TEST_PREFIX: prefix,
    ATAPE_CONFIG_FILE: join(root, "override-config", "client.json"),
    UPGRADE_TEST_FAIL: String(failInstall),
    UPGRADE_TEST_IGNORE_TERMINATION: String(ignoreTermination),
    UPGRADE_TEST_MODULES: modules, UPGRADE_TEST_CALLS: join(root, "calls.json"), UPGRADE_TEST_ENTRY: entry }
  const run = <A, E>(effect: Effect.Effect<A, E, CLIUpgradePlatform>, path = entry, signal?: AbortSignal) => Effect.runPromise(effect.pipe(
    Effect.provide(makeCLIUpgradePlatformLayer(root, path, environment, fetchMetadata))), signal ? { signal } : undefined)
  return { root, entry, modules, prefix, run, environment, paths: defaultNodeClientPaths({ ...environment, ATAPE_HOME: root }) }
}
const latest = (cached = true) => Effect.gen(function*() { return yield* (yield* CLIUpgradePlatform).latest(cached) })
const install = (version: string) => Effect.scoped(Effect.gen(function*() {
  const platform = yield* CLIUpgradePlatform
  yield* platform.acquireOwnership()
  yield* platform.install(version)
}))

describe("Node CLI upgrade Adapter", () => {
  it("excludes manual replacement while automatic maintenance owns this home", async () => {
    const client = await fixture(async () => Response.json({ name: "@atape/cli", version: "0.4.2" }))
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
    const client = await fixture(async () => Response.json({ name: "@atape/cli", version: "0.4.2" }))
    let finish!: () => void, starting = false
    const wait = new Promise<void>(resolve => { finish = resolve })
    const process = Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      refresh: () => Effect.succeed(false),
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
  it("caches successful checks, bypasses cache for explicit upgrade and recovers from corrupt cache", async () => {
    let calls = 0
    const client = await fixture(async (url, options) => {
      calls++; expect(String(url)).toBe("https://registry.npmjs.org/@atape%2fcli/latest")
      expect(options?.signal).toBeDefined()
      return Response.json({ name: "@atape/cli", version: "0.4.2" })
    })
    expect(await client.run(latest())).toBe("0.4.2")
    expect(await client.run(latest())).toBe("0.4.2")
    expect(calls).toBe(1)
    await client.run(latest(false)); expect(calls).toBe(2)
    await writeFile(join(client.root, "cache/cli-update.json"), JSON.stringify({ version: "0.4.1", checkedAt: Date.now() - 11 * 60 * 60 * 1000 }))
    expect(await client.run(latest())).toBe("0.4.1"); expect(calls).toBe(2)
    await writeFile(join(client.root, "cache/cli-update.json"), "corrupt")
    await client.run(latest()); expect(calls).toBe(3)
    await writeFile(join(client.root, "cache/cli-update.json"), JSON.stringify({ version: "0.4.1", checkedAt: Date.now() - 12 * 60 * 60 * 1000 - 1 }))
    await client.run(latest()); expect(calls).toBe(4)
  })
  it("rejects registry failures and oversized or foreign metadata", async () => {
    for (const response of [new Response("offline", { status: 503 }), Response.json({ name: "other", version: "0.4.2" }), new Response("x".repeat(262145))]) {
      const client = await fixture(async () => response)
      await expect(client.run(latest())).rejects.toMatchObject({ reason: "check" })
    }
  })
  it("updates only the active npm global installation, pins the release, verifies it and releases its lock", async () => {
    const client = await fixture(async () => Response.json({ name: "@atape/cli", version: "0.4.2" }))
    await client.run(install("0.4.2"))
    const args = JSON.parse(await readFile(join(client.root, "calls.json"), "utf8"))
    expect(args).toContain("@atape/cli@0.4.2")
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
    const client = await fixture(async () => Response.json({ name: "@atape/cli", version: "0.4.3" }), failInstall)
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
    const client = await fixture(async () => Response.json({ name: "@atape/cli", version: "0.4.2" }), true)
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
    const client = await fixture(async () => Response.json({ name: "@atape/cli", version: "0.4.2" }))
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
    const client = await fixture(async () => Response.json({ name: "@atape/cli", version: "0.4.2" }))
    await writeFile(join(dirname(dirname(client.entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version: actual }))
    await writeFile(client.entry, `console.log("ATape ${actual}")`)
    const process = Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      resume: () => Effect.die("Unexpected login resume"),
      pause: () => Effect.die("Stale update cannot pause collection"),
      refresh: () => Effect.die("Stale update cannot refresh collection"), inspect: () => Effect.succeed(undefined),
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
    const client = await fixture(async () => Response.json({ name: "@atape/cli", version: "0.4.2" }), false, true)
    const cancellation = new AbortController()
    let settled = false, pid: number | undefined
    const pending = client.run(install("0.4.2"), client.entry, cancellation.signal)
      .then(() => "success", () => "cancelled").finally(() => { settled = true })
    try {
      await expect.poll(() => readFile(`${client.entry}.pid`, "utf8").catch(() => "")).not.toBe("")
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
  })
})
