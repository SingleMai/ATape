import { CLIUpgradePlatform } from "@atape/application"
import { Effect } from "effect"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeCLIUpgradePlatformLayer } from "./cliUpgradePlatform.ts"

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
  fs.writeFileSync(process.env.UPGRADE_TEST_ENTRY, 'console.log("ATape 0.4.2")');
} else process.exit(1);
`)
  await chmod(join(bin, "npm"), 0o755)
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UPGRADE_TEST_PREFIX: prefix,
    UPGRADE_TEST_FAIL: String(failInstall),
    UPGRADE_TEST_IGNORE_TERMINATION: String(ignoreTermination),
    UPGRADE_TEST_MODULES: modules, UPGRADE_TEST_CALLS: join(root, "calls.json"), UPGRADE_TEST_ENTRY: entry }
  const run = <A, E>(effect: Effect.Effect<A, E, CLIUpgradePlatform>, path = entry, signal?: AbortSignal) => Effect.runPromise(effect.pipe(
    Effect.provide(makeCLIUpgradePlatformLayer(root, path, environment, fetchMetadata))), signal ? { signal } : undefined)
  return { root, entry, modules, prefix, run }
}
const latest = (cached = true) => Effect.gen(function*() { return yield* (yield* CLIUpgradePlatform).latest(cached) })
const install = (version: string) => Effect.gen(function*() { yield* (yield* CLIUpgradePlatform).install(version) })

describe("Node CLI upgrade Adapter", () => {
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
    expect(args[args.indexOf("--prefix") + 1]).toBe(client.prefix)
    await expect(readFile(join(client.modules, ".atape-upgrade.lock"))).rejects.toMatchObject({ code: "ENOENT" })
    const foreign = join(client.root, "other.js"); await writeFile(foreign, "")
    await expect(client.run(install("0.4.2"), foreign)).rejects.toMatchObject({ reason: "installation" })
    await expect(client.run(install("latest;echo bad"))).rejects.toMatchObject({ reason: "install" })
  })
  it("does not overwrite an existing installation lock and releases its own lock after npm fails", async () => {
    const client = await fixture(async () => Response.json({ name: "@atape/cli", version: "0.4.2" }), true)
    const lock = join(client.modules, ".atape-upgrade.lock")
    await writeFile(lock, "another installer")
    await expect(client.run(install("0.4.2"))).rejects.toMatchObject({ reason: "installation" })
    expect(await readFile(lock, "utf8")).toBe("another installer")
    await expect(readFile(join(client.root, "calls.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await rm(lock)
    await expect(client.run(install("0.4.2"))).rejects.toMatchObject({ reason: "install" })
    await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(client.entry, "utf8")).toContain("0.4.1")
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
      await expect(readFile(join(client.modules, ".atape-upgrade.lock"))).resolves.toBeDefined()
      await expect(client.run(install("0.4.2"))).rejects.toMatchObject({ reason: "installation" })
      expect(await pending).toBe("cancelled")
      expect(() => process.kill(pid!, 0)).toThrow()
      await expect(readFile(join(client.modules, ".atape-upgrade.lock"))).rejects.toMatchObject({ code: "ENOENT" })
      expect(await readFile(client.entry, "utf8")).toContain("0.4.1")
    } finally {
      cancellation.abort()
      if (pid) { try { process.kill(pid, "SIGKILL") } catch {} }
      await pending
    }
  })
})
