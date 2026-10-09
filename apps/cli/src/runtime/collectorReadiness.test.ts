import { AdapterProtocolVersion, emptyClientConfig, GitAttributionVersion, type ClientConfig } from "@atape/domain"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { adapterPackageRoot, prepareAdapterSlot, trackAdapterSlot } from "./adapterInstallation.ts"
import { isCollectorMaintenancePending, withCollectorMaintenance } from "./collectorDaemonLayers.ts"
import { prepareCollectorReadiness, validateCollectorAdapters } from "./collectorReadiness.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { atomicJSON, managedStateContract, runtimeSelectionFile } from "./runtimeSelection.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-collector-readiness-"))
  roots.push(root)
  const paths = defaultNodeClientPaths({ ATAPE_HOME: root })
  const adapter = { adapterId: "codex", packageName: "@atape/adapter-codex", version: "0.5.2", upgradeSpec: "@atape/adapter-codex",
    displayName: "Codex", installedAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" }
  const config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: [adapter.adapterId], adapters: [adapter], projects: [{
    id: "project", instanceOrigin: "https://example.invalid", userId: "user", teamId: "team", teamSlug: "team", teamName: "Team",
    name: "Project", type: "directory", path: root, createdAt: "2026-10-09T00:00:00.000Z"
  }] }
  const packageRoot = adapterPackageRoot(paths.adapterDirectory, adapter)
  const manifest = { name: adapter.packageName, version: adapter.version, type: "module", atapeAdapter: {
    protocolVersion: AdapterProtocolVersion, adapterId: adapter.adapterId, displayName: "Codex", entry: "./index.mjs", harnesses: ["codex"],
    gitAttribution: GitAttributionVersion
  } }
  await mkdir(packageRoot, { recursive: true })
  await atomicJSON(join(packageRoot, "package.json"), manifest)
  await writeFile(join(packageRoot, "index.mjs"), 'export function createAtapeAdapter() { throw new Error("Readiness must not invoke the provider factory"); }\n')
  await atomicJSON(paths.configFile, config)
  const readyFile = join(root, "readiness.json"), token = "ready-token"
  const environment = { ATAPE_COLLECTOR_READY_FILE: readyFile, ATAPE_COLLECTOR_READY_TOKEN: token }
  return { paths, config, adapter, manifest, packageRoot, readyFile, token, environment,
    saveConfig: (value: ClientConfig) => atomicJSON(paths.configFile, value),
    saveManifest: (value: unknown) => atomicJSON(join(packageRoot, "package.json"), value),
    run: () => Effect.runPromise(prepareCollectorReadiness(paths, environment)) }
}

describe("local Collector readiness", () => {
  it("validates installed packages and writes the identity without opening a provider or contacting the Instance", async () => {
    const f = await fixture()
    await f.run()
    expect(JSON.parse(await readFile(f.readyFile, "utf8"))).toEqual({ token: f.token, pid: process.pid })
  })

  it("requires completed tool initialization for maintenance readiness", async () => {
    const f = await fixture()
    await f.saveConfig({ ...f.config, toolsConfigured: false })
    await expect(f.run()).rejects.toThrow("requires configured tools")
    await expect(readFile(f.readyFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["projects", "enabled", "both"] as const)("reports local readiness for an initialized idle scheduler without %s", async field => {
    const f = await fixture()
    await f.saveConfig({ ...f.config,
      ...(field === "projects" || field === "both" ? { projects: [] } : {}),
      ...(field === "enabled" || field === "both" ? { enabledAdapterIds: [] } : {}) })
    await f.run()
    expect(JSON.parse(await readFile(f.readyFile, "utf8"))).toEqual({ token: f.token, pid: process.pid })
  })

  it("retains ordinary launch behavior when no readiness marker is requested", async () => {
    const f = await fixture()
    await f.saveConfig({ ...f.config, toolsConfigured: false, projects: [], enabledAdapterIds: [] })
    await Effect.runPromise(prepareCollectorReadiness(f.paths, {}))
    await expect(readFile(f.readyFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects incomplete marker configuration", async () => {
    const f = await fixture()
    await expect(Effect.runPromise(prepareCollectorReadiness(f.paths, { ATAPE_COLLECTOR_READY_FILE: f.readyFile })))
      .rejects.toThrow("marker path and token")
  })

  it.each(["protocol", "name", "version", "missing-installed"] as const)("rejects invalid %s before reporting ready", async field => {
    const f = await fixture()
    if (field === "missing-installed") await f.saveConfig({ ...f.config, adapters: [] })
    else await f.saveManifest({ ...f.manifest, ...(field === "name" ? { name: "@other/adapter" } : field === "version" ? { version: "0.5.1" } : {
      atapeAdapter: { ...f.manifest.atapeAdapter, protocolVersion: "unsupported" }
    }) })
    await expect(f.run()).rejects.toThrow()
    await expect(readFile(f.readyFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("requires Git capability whenever an enabled Adapter can collect a Git Project", async () => {
    const f = await fixture()
    await f.saveConfig({ ...f.config, projects: f.config.projects.map(project => ({ ...project, type: "git" })) })
    const { gitAttribution: _, ...manifest } = f.manifest.atapeAdapter
    await f.saveManifest({ ...f.manifest, atapeAdapter: manifest })
    await expect(f.run()).rejects.toThrow("does not support Git attribution")
  })

  it.each(["relative", "symlink"] as const)("rejects an entry escaping the installed package through %s", async kind => {
    const f = await fixture(), outside = join(dirname(f.packageRoot), "outside.mjs")
    await writeFile(outside, "export function createAtapeAdapter() {}\n")
    if (kind === "relative") await f.saveManifest({ ...f.manifest, atapeAdapter: { ...f.manifest.atapeAdapter, entry: "./../outside.mjs" } })
    else { await rm(join(f.packageRoot, "index.mjs")); await symlink(outside, join(f.packageRoot, "index.mjs")) }
    await expect(f.run()).rejects.toThrow("entry leaves its package")
  })

  it("rejects a missing factory export without reporting ready", async () => {
    const f = await fixture()
    await writeFile(join(f.packageRoot, "index.mjs"), "export const unrelated = true;\n")
    await expect(f.run()).rejects.toThrow("does not export createAtapeAdapter")
    await expect(readFile(f.readyFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("isolates a successful import and exits even when it opens a timer", async () => {
    const f = await fixture(), pidFile = join(f.paths.atapeHome, "import-pid.json")
    await writeFile(join(f.packageRoot, "index.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid));
globalThis.atapePreflightLeak = true;
setInterval(() => {}, 60000);
export function createAtapeAdapter() { throw new Error("Do not create a provider runtime"); }
`)
    await f.run()
    const pid = JSON.parse(await readFile(pidFile, "utf8")) as number
    expect(pid).not.toBe(process.pid)
    expect(() => process.kill(pid, 0)).toThrow()
    expect("atapePreflightLeak" in globalThis).toBe(false)
    expect(JSON.parse(await readFile(f.readyFile, "utf8"))).toEqual({ token: f.token, pid: process.pid })
  })

  it.each(["throw new Error('broken import');", "process.exit(0);"])("rejects incomplete preflight: %s", async source => {
    const f = await fixture()
    await writeFile(join(f.packageRoot, "index.mjs"), `${source}\nexport function createAtapeAdapter() {}\n`)
    await expect(f.run()).rejects.toThrow(/preflight/)
    await expect(readFile(f.readyFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["while (true) {}", "await new Promise(() => {});"])("bounds a nonterminating import: %s", async source => {
    const f = await fixture(), pidFile = join(f.paths.atapeHome, "import-pid.json")
    await writeFile(join(f.packageRoot, "index.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid));
${source}
export function createAtapeAdapter() {}
`)
    await expect(f.run()).rejects.toThrow(/preflight/)
    const pid = JSON.parse(await readFile(pidFile, "utf8")) as number
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(readFile(f.readyFile)).rejects.toMatchObject({ code: "ENOENT" })
  }, 15_000)

  it("joins cancelled import termination before releasing its tracked installation lease", async () => {
    const f = await fixture()
    const tracked = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const slot = yield* prepareAdapterSlot(f.paths.adapterDirectory, f.adapter.packageName)
      yield* Effect.promise(() => trackAdapterSlot(slot.root, { packageSlot: slot.packageSlot,
        packageName: f.adapter.packageName, version: f.adapter.version }))
      slot.retained = true
      return { ...f.adapter, packageSlot: slot.packageSlot }
    })))
    const packageRoot = adapterPackageRoot(f.paths.adapterDirectory, tracked)
    const leases = join(f.paths.adapterDirectory, "slots", tracked.packageSlot, ".atape-leases")
    const pidFile = join(f.paths.atapeHome, "import-pid.json")
    await mkdir(packageRoot, { recursive: true })
    await atomicJSON(join(packageRoot, "package.json"), f.manifest)
    await writeFile(join(packageRoot, "index.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid));
while (true) {}
export function createAtapeAdapter() {}
`)
    await f.saveConfig({ ...f.config, adapters: [tracked] })
    const cancellation = new AbortController()
    const ready = Effect.runPromise(prepareCollectorReadiness(f.paths, f.environment), { signal: cancellation.signal })
    void ready.catch(() => {})
    try {
      await expect.poll(() => readFile(pidFile, "utf8")).toBeDefined()
      const pid = JSON.parse(await readFile(pidFile, "utf8")) as number
      expect(await readdir(leases)).toHaveLength(1)
      expect(() => process.kill(pid, 0)).not.toThrow()
      cancellation.abort()
      await expect(ready).rejects.toThrow()
      expect(() => process.kill(pid, 0)).toThrow()
      expect(await readdir(leases)).toEqual([])
      await expect(readFile(f.readyFile)).rejects.toMatchObject({ code: "ENOENT" })
    } finally { cancellation.abort(); await ready.catch(() => {}) }
  })

  it("validates candidate Adapters even when capture is stopped without imposing setup requirements", async () => {
    const f = await fixture()
    await Effect.runPromise(validateCollectorAdapters(f.paths, { ...f.config, toolsConfigured: false, projects: [] }))
    await writeFile(join(f.packageRoot, "broken.mjs"), "export const unrelated = true;\n")
    await f.saveManifest({ ...f.manifest, atapeAdapter: { ...f.manifest.atapeAdapter, entry: "./broken.mjs" } })
    await expect(Effect.runPromise(validateCollectorAdapters(f.paths, f.config))).rejects.toThrow("does not export")
  })

  it("validates the selected Adapter generation rather than the older base configuration", async () => {
    const f = await fixture()
    const after = { ...f.adapter, version: "0.5.3", packageSlot: "166c6db7-28f0-4d2c-84ed-af1d6dd657e6", updatedAt: "2026-10-09T00:00:01.000Z" }
    const selectedRoot = adapterPackageRoot(f.paths.adapterDirectory, after)
    await mkdir(selectedRoot, { recursive: true })
    await atomicJSON(join(selectedRoot, "package.json"), { ...f.manifest, version: after.version })
    await writeFile(join(selectedRoot, "index.mjs"), "export const wrong = true;\n")
    await atomicJSON(runtimeSelectionFile(f.paths.atapeHome), { protocol: "atape.runtime.v1", stateContract: managedStateContract,
      version: after.version, bootstrapEntry: join(f.paths.atapeHome, "bootstrap.mjs"), adapters: [{ before: f.adapter, after }] })
    await expect(f.run()).rejects.toThrow("does not export createAtapeAdapter")
  })

  it.each([false, true])("writes ready before waiting at the gate, with cancellation=%s", async cancel => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const activated = new Promise<void>(resolve => { entered = resolve })
    const maintenance = withCollectorMaintenance(f.paths, async () => "unused", {}, async () => { entered(); await waiting })
    await activated
    const cancellation = new AbortController()
    let completed = false
    const ready = Effect.runPromise(prepareCollectorReadiness(f.paths, f.environment), { signal: cancellation.signal })
      .then(() => { completed = true })
    try {
      await expect.poll(async () => JSON.parse(await readFile(f.readyFile, "utf8"))).toEqual({ token: f.token, pid: process.pid })
      expect(completed).toBe(false)
      expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(true)
      if (cancel) {
        cancellation.abort()
        await expect(ready).rejects.toThrow()
        expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(true)
      }
      release()
      await maintenance
      if (!cancel) { await ready; expect(completed).toBe(true) }
    } finally { cancellation.abort(); release(); await maintenance; await ready.catch(() => {}) }
  })
})
