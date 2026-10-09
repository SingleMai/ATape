import { AdapterProtocolVersion, emptyClientConfig, type AdapterInstallation } from "@atape/domain"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { adapterPackageRoot, trackAdapterSlot } from "./adapterInstallation.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { atomicJSON } from "./runtimeSelection.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const running = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH") return false
    throw cause
  }
}

const fixture = async (behavior: "cpu" | "tla") => {
  const root = await mkdtemp(join(tmpdir(), "atape-preflight-owner-"))
  temporaryDirectories.push(root)
  const paths = defaultNodeClientPaths({ ATAPE_HOME: root })
  const adapter: AdapterInstallation = {
    adapterId: "codex", packageName: "@atape/adapter-codex", packageSlot: randomUUID(), version: "0.5.3",
    upgradeSpec: "@atape/adapter-codex", displayName: "Codex",
    installedAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z"
  }
  const slotRoot = join(paths.adapterDirectory, "slots", adapter.packageSlot!)
  const packageRoot = adapterPackageRoot(paths.adapterDirectory, adapter)
  await mkdir(join(slotRoot, ".atape-leases"), { recursive: true })
  await mkdir(packageRoot, { recursive: true })
  await trackAdapterSlot(slotRoot, {
    packageSlot: adapter.packageSlot!, packageName: adapter.packageName, version: adapter.version
  })
  await atomicJSON(join(packageRoot, "package.json"), {
    name: adapter.packageName, version: adapter.version, type: "module", atapeAdapter: {
      protocolVersion: AdapterProtocolVersion, adapterId: adapter.adapterId, displayName: adapter.displayName,
      entry: "./index.mjs", harnesses: ["codex"]
    }
  })
  const marker = join(root, "importing.json")
  await writeFile(join(packageRoot, "index.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, ownerPid: process.ppid }));
${behavior === "cpu" ? "while (true) {}" : "await new Promise(() => {});"}
export function createAtapeAdapter() { throw new Error("Preflight must not create a provider runtime"); }
`)
  await atomicJSON(paths.configFile, {
    ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: [adapter.adapterId], adapters: [adapter]
  })
  return { paths, slotRoot, marker }
}

describe.skipIf(process.platform === "win32")("preflight owner process death", () => {
  it.each(["cpu", "tla"] as const)("terminates a %s import after SIGKILL and releases shared update ownership", async behavior => {
    const f = await fixture(behavior)
    const entry = fileURLToPath(new URL("./fixtures/adapter-preflight-owner.ts", import.meta.url))
    const owner = spawn(process.execPath, [entry], {
      env: { ...process.env, ATAPE_HOME: f.paths.atapeHome,
        ATAPE_CONFIG_FILE: f.paths.configFile, ATAPE_ADAPTER_DIRECTORY: f.paths.adapterDirectory },
      stdio: ["ignore", "ignore", "pipe"]
    })
    let stderr = ""
    owner.stderr.on("data", chunk => { stderr += String(chunk) })
    const exited = new Promise<void>(resolve => owner.once("exit", () => resolve()))
    let importerPid: number | undefined
    try {
      await expect.poll(async () => {
        if (owner.exitCode !== null || owner.signalCode !== null) throw new Error(`Preflight owner exited before import: ${stderr}`)
        return readFile(f.marker, "utf8").then(value => JSON.parse(value) as { pid: number; ownerPid: number }, () => undefined)
      }, { timeout: 5_000 }).toEqual({ pid: expect.any(Number), ownerPid: owner.pid })
      importerPid = (JSON.parse(await readFile(f.marker, "utf8")) as { pid: number }).pid
      expect(importerPid).not.toBe(owner.pid)
      expect(running(importerPid)).toBe(true)
      expect(await acquireUpdateWorker(f.paths.atapeHome)).toBeUndefined()
      expect((await readdir(join(f.slotRoot, ".atape-leases"))).some(lease => lease.startsWith(`${owner.pid}-`))).toBe(true)

      owner.kill("SIGKILL")
      await exited

      const release = await acquireUpdateWorker(f.paths.atapeHome)
      try { expect(release).toBeTypeOf("function") } finally { release?.() }
      await expect.poll(() => running(importerPid!), { timeout: 3_000, interval: 25 }).toBe(false)
    } finally {
      owner.kill("SIGKILL")
      await exited
      if (importerPid !== undefined && running(importerPid)) process.kill(importerPid, "SIGKILL")
    }
  }, 10_000)
})
