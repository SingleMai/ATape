import { AdapterPackageError, AdapterPackages, AutomaticUpdatePlatform, ClientConfigStore, CollectorDaemonProcess, runAutomaticUpdates,
  type PreparedAutomaticUpdate } from "@atape/application"
import { AdapterProtocolVersion, emptyClientConfig, GitAttributionVersion, type AdapterInstallation, type ClientConfig } from "@atape/domain"
import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { adapterPackageRoot } from "./adapterInstallation.ts"
import { isCollectorMaintenancePending, makeNodeCollectorDaemonLayer } from "./collectorDaemonLayers.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { acquireUpdateWorker, makeAutomaticUpdatePlatformLayer, needsUpdateRecovery, recoverPendingUpdate } from "./managedUpdates.ts"
import { atomicJSON, managedStateContract, readRuntimeSelection, readSelectedClientConfig, resolveRuntimeEntry, runtimeEntry } from "./runtimeSelection.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const cliSource = (version: string) => `import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("ATape ${version}");
else {
  if (process.env.MANAGED_TEST_FAIL_READY === "${version}" || process.env.MANAGED_TEST_FAIL_READY === "all") process.exit(1);
  writeFileSync(process.env.MANAGED_TEST_STARTED, JSON.stringify({version:"${version}",pid:process.pid}));
  if (process.env.ATAPE_COLLECTOR_READY_FILE) writeFileSync(process.env.ATAPE_COLLECTOR_READY_FILE,
    JSON.stringify({token:process.env.ATAPE_COLLECTOR_READY_TOKEN,pid:process.pid}));
  setInterval(() => {}, 1000);
}
`

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-managed-update-")); roots.push(root)
  const paths = defaultNodeClientPaths({ ATAPE_HOME: join(root, "home") })
  const modules = join(root, "npm-global", "node_modules"), entry = join(modules, "@atape", "cli", "dist", "atape.js")
  await mkdir(dirname(entry), { recursive: true })
  await atomicJSON(join(dirname(dirname(entry)), "package.json"), { name: "@atape/cli", version: "0.5.2", type: "module",
    atapeRuntime: { protocol: "atape.runtime.v1", stateContract: managedStateContract } })
  await writeFile(entry, cliSource("0.5.2"))
  const bin = join(root, "bin"), calls = join(root, "npm-calls.jsonl")
  await mkdir(bin)
  await writeFile(join(bin, "npm"), `#!${process.execPath}
const fs=require("node:fs"), path=require("node:path"), args=process.argv.slice(2);
fs.appendFileSync(process.env.MANAGED_TEST_CALLS, JSON.stringify(args)+"\\n");
if (args[0]==="root") {
  if (process.env.MANAGED_TEST_FAIL_ROOT==="true") process.exit(1);
  console.log(process.env.MANAGED_TEST_MODULES);
}
else if (args[0]==="install") {
  if (process.env.MANAGED_TEST_FAIL_NPM==="true") process.exit(1);
  const spec=args.find(arg=>arg.startsWith("@atape/cli@")), version=spec.slice("@atape/cli@".length);
  const destination=path.join(args[args.indexOf("--prefix")+1],"node_modules","@atape","cli");
  fs.mkdirSync(path.join(destination,"dist"),{recursive:true});
  fs.writeFileSync(path.join(destination,"package.json"),JSON.stringify({name:"@atape/cli",version,type:"module",
    atapeRuntime:{protocol:"atape.runtime.v1",stateContract:process.env.MANAGED_TEST_CONTRACT}}));
  const reported=process.env.MANAGED_TEST_WRONG_VERSION || version;
  fs.writeFileSync(path.join(destination,"dist","atape.js"), (${cliSource.toString()})(reported));
} else process.exit(2);
`)
  await chmod(join(bin, "npm"), 0o700)
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ATAPE_HOME: paths.atapeHome,
    MANAGED_TEST_CALLS: calls, MANAGED_TEST_MODULES: modules, MANAGED_TEST_CONTRACT: managedStateContract,
    MANAGED_TEST_STARTED: join(root, "started.json") }
  const adapterSpecs: string[] = [], fetches: string[] = []
  const adapters: AdapterInstallation[] = ["codex", "claude"].map(id => ({ adapterId: id, packageName: `@atape/adapter-${id}`,
    version: "0.5.2", upgradeSpec: `@atape/adapter-${id}`, displayName: id,
    installedAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" }))
  const config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: true,
    enabledAdapterIds: ["codex"], adapters, projects: [{ id: "project", instanceOrigin: "https://example.invalid", userId: "user",
      teamId: "team", teamSlug: "team", teamName: "Team", name: "Project", type: "directory", path: root,
      createdAt: "2026-10-09T00:00:00.000Z" }] }
  const behavior = { missingPackage: "", invalidFactory: false }
  const writeAdapter = async (adapter: AdapterInstallation, invalid = false) => {
    const packageRoot = adapterPackageRoot(paths.adapterDirectory, adapter)
    await mkdir(packageRoot, { recursive: true })
    const manifest = { protocolVersion: AdapterProtocolVersion, adapterId: adapter.adapterId, displayName: adapter.displayName,
      entry: "./index.mjs", harnesses: [adapter.adapterId], gitAttribution: GitAttributionVersion }
    await atomicJSON(join(packageRoot, "package.json"), { name: adapter.packageName, version: adapter.version, type: "module", atapeAdapter: manifest })
    await writeFile(join(packageRoot, "index.mjs"), invalid ? "export const invalid = true;\n" : "export function createAtapeAdapter() { throw new Error('No collection during update preparation'); }\n")
    return manifest
  }
  for (const adapter of adapters) await writeAdapter(adapter)
  await atomicJSON(paths.configFile, config)
  const packages = Layer.succeed(AdapterPackages, AdapterPackages.of({
    install: spec => Effect.tryPromise({ try: async () => {
      adapterSpecs.push(spec)
      const split = spec.lastIndexOf("@"), packageName = spec.slice(0, split), version = spec.slice(split + 1)
      const original = adapters.find(adapter => adapter.packageName === packageName)
      if (!original) throw new Error("Unexpected package spec")
      const adapter = { ...original, packageSlot: randomUUID(), version }
      const manifest = await writeAdapter(adapter, behavior.invalidFactory && adapter.adapterId === "codex")
      return { packageName, packageSlot: adapter.packageSlot, upgradeSpec: packageName, version, manifest }
    }, catch: () => new AdapterPackageError({ reason: "install", packageSpec: spec, message: "Fixture install failed" }) }),
    prune: () => Effect.succeed({ applied: false, removed: 0, more: false, slots: [] })
  }))
  const fetchMetadata: typeof fetch = async url => {
    const address = String(url); fetches.push(address)
    if (address.startsWith("https://api.github.com/")) return Response.json({ tag_name: "v0.5.3", draft: false, prerelease: false,
      published_at: "2026-10-01T00:00:00.000Z" })
    const parts = new URL(address).pathname.slice(1).split("/"), name = decodeURIComponent(parts[0]!), version = parts[1]!
    return name === behavior.missingPackage ? new Response("Not published", { status: 404 }) : Response.json({ name, version })
  }
  const layer = (path = entry, version = "0.5.2") => makeAutomaticUpdatePlatformLayer(paths, path, version, environment, fetchMetadata).pipe(Layer.provide(packages))
  const run = <A, E>(effect: Effect.Effect<A, E, AutomaticUpdatePlatform>, path = entry, version = "0.5.2") =>
    Effect.runPromise(effect.pipe(Effect.provide(layer(path, version))))
  const prepare = (version = "0.5.3", selected: ReadonlyArray<AdapterInstallation> = adapters) => run(Effect.scoped(
    AutomaticUpdatePlatform.use(platform => platform.prepare(version, selected))))
  const activate = (prepared: PreparedAutomaticUpdate, automatic = true) => run(AutomaticUpdatePlatform.use(platform => platform.activate(prepared, automatic)))
  const daemonLayer = makeNodeCollectorDaemonLayer(paths, () => resolveRuntimeEntry(paths.atapeHome, entry), environment)
  const daemonRun = <A, E>(effect: Effect.Effect<A, E, CollectorDaemonProcess>) => Effect.runPromise(effect.pipe(Effect.provide(daemonLayer)))
  const daemon = await daemonRun(CollectorDaemonProcess)
  return { root, paths, entry, calls, environment, adapters, adapterSpecs, config, behavior, fetches, run, prepare, activate, daemon, daemonRun,
    raw: async () => JSON.parse(await readFile(paths.configFile, "utf8")) as ClientConfig,
    selected: () => Effect.runPromise(readSelectedClientConfig(paths)),
    save: (next: ClientConfig) => atomicJSON(paths.configFile, next),
    npmCalls: async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) }
}

describe.skipIf(process.platform === "win32")("managed update Node Adapter", () => {
  it("recognizes only the owning npm installation and does not inspect npm for development builds", async () => {
    const f = await fixture()
    expect(await f.run(AutomaticUpdatePlatform.use(platform => platform.supported()), f.entry, "0.5.2-dev")).toBe(false)
    expect(await f.npmCalls()).toEqual([])
    const other = join(f.root, "other.mjs"); await writeFile(other, "")
    expect(await f.run(AutomaticUpdatePlatform.use(platform => platform.supported()), other)).toBe(false)
    expect(await f.run(AutomaticUpdatePlatform.use(platform => platform.supported()))).toBe(true)
    expect(f.fetches).toEqual([])
    expect(f.adapterSpecs).toEqual([])
  })

  it("retries a transient npm ownership failure in the same long-running runtime", async () => {
    const f = await fixture(), platform = await f.run(AutomaticUpdatePlatform)
    f.environment.MANAGED_TEST_FAIL_ROOT = "true"
    await expect(Effect.runPromise(platform.supported())).rejects.toMatchObject({ reason: "unsupported" })
    delete f.environment.MANAGED_TEST_FAIL_ROOT
    expect(await Effect.runPromise(platform.supported())).toBe(true)
    expect((await f.npmCalls()).filter(args => args[0] === "root")).toHaveLength(2)
  })

  it("rechecks global npm ownership after a previous negative probe", async () => {
    const f = await fixture(), modules = f.environment.MANAGED_TEST_MODULES!
    const other = join(f.root, "other-global", "@atape", "cli", "dist", "atape.js")
    await mkdir(dirname(other), { recursive: true }); await writeFile(other, cliSource("0.5.2"))
    f.environment.MANAGED_TEST_MODULES = join(f.root, "other-global")
    const platform = await f.run(AutomaticUpdatePlatform)
    expect(await Effect.runPromise(platform.supported())).toBe(false)
    f.environment.MANAGED_TEST_MODULES = modules
    expect(await Effect.runPromise(platform.supported())).toBe(true)
    expect((await f.npmCalls()).filter(args => args[0] === "root")).toHaveLength(2)
  })

  it("does not probe npm or launch a worker before the local check schedule is due", async () => {
    const f = await fixture()
    await atomicJSON(join(f.paths.atapeHome, "updates", "state.json"), { nextCheckAt: Date.now() + 86_400_000, failures: 0 })
    f.environment.MANAGED_TEST_FAIL_ROOT = "true"
    await f.run(AutomaticUpdatePlatform.use(platform => platform.launch()))
    expect(await f.npmCalls()).toEqual([])
  })

  it("rejects a stale worker's target below the actual npm bootstrap through the update Interface", async () => {
    const f = await fixture()
    await atomicJSON(join(dirname(dirname(f.entry)), "package.json"), { name: "@atape/cli", version: "0.5.4", type: "module",
      atapeRuntime: { protocol: "atape.runtime.v1", stateContract: managedStateContract } })
    await writeFile(f.entry, cliSource("0.5.4"))
    const store = Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => change(f.config).pipe(Effect.map(result => result.value)) }))
    await expect(f.run(runAutomaticUpdates("0.5.2").pipe(Effect.provide(store)))).rejects.toMatchObject({ reason: "prepare" })
    expect((await f.npmCalls()).some(args => args[0] === "install")).toBe(false)
    expect(f.adapterSpecs).toEqual([])
    expect(f.fetches).toHaveLength(1)
    expect(await readRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
    expect(await f.raw()).toEqual(f.config)
  })

  it("rejects activation when the bootstrap manifest advances even if its bundle bytes are unchanged", async () => {
    const f = await fixture(), prepared = await f.prepare()
    await atomicJSON(join(dirname(dirname(f.entry)), "package.json"), { name: "@atape/cli", version: "0.5.4", type: "module",
      atapeRuntime: { protocol: "atape.runtime.v1", stateContract: managedStateContract } })
    await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
    expect(await readRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
    expect(await f.raw()).toEqual(f.config)
  })

  it.each(["0.5.4-dev", "invalid"])("rejects unknown bootstrap version %s before preparing a release", async version => {
    const f = await fixture()
    await atomicJSON(join(dirname(dirname(f.entry)), "package.json"), { name: "@atape/cli", version, type: "module",
      atapeRuntime: { protocol: "atape.runtime.v1", stateContract: managedStateContract } })
    await expect(f.prepare()).rejects.toMatchObject({ reason: "prepare" })
    expect(f.fetches).toEqual([])
    expect(f.adapterSpecs).toEqual([])
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  })

  it("rejects a prepared target below the current managed selection", async () => {
    const f = await fixture()
    await f.activate(await f.prepare("0.5.4"))
    await expect(f.prepare("0.5.3", (await f.selected()).adapters)).rejects.toMatchObject({ reason: "prepare" })
    expect((await readRuntimeSelection(f.paths.atapeHome))?.version).toBe("0.5.4")
    expect((await f.selected()).adapters.map(adapter => adapter.version)).toEqual(["0.5.4", "0.5.4"])
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  })

  it("pins the complete release and every prepared official package to one version with lifecycle scripts disabled", async () => {
    const f = await fixture(), prepared = await f.prepare()
    expect(prepared.version).toBe("0.5.3")
    expect(f.adapterSpecs).toEqual(["@atape/adapter-codex@0.5.3", "@atape/adapter-claude@0.5.3"])
    expect(f.fetches).toHaveLength(7)
    expect(f.fetches.every(url => url.endsWith("/0.5.3") && !url.endsWith("/latest"))).toBe(true)
    const installation = (await f.npmCalls()).find(args => args[0] === "install")!
    expect(installation).toContain("@atape/cli@0.5.3")
    expect(installation).toContain("--save-exact")
    expect(installation).toContain("--ignore-scripts")
    expect(installation).toContain("--engine-strict")
    expect(await readRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(await f.raw()).toEqual(f.config)
  })

  it("rejects a half-published release before installation even if the missing Adapter is not enabled", async () => {
    const f = await fixture(); f.behavior.missingPackage = "@atape/adapter-grok"
    await expect(f.prepare()).rejects.toMatchObject({ reason: "release" })
    expect((await f.npmCalls()).some(args => args[0] === "install")).toBe(false)
    expect(f.adapterSpecs).toEqual([])
    expect(await readRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
  })

  it.each(["npm", "contract", "version", "factory"] as const)("keeps the old selection and running Collector when preparation fails at %s", async kind => {
    const f = await fixture()
    if (kind === "npm") f.environment.MANAGED_TEST_FAIL_NPM = "true"
    if (kind === "contract") f.environment.MANAGED_TEST_CONTRACT = "unsupported-state"
    if (kind === "version") f.environment.MANAGED_TEST_WRONG_VERSION = "0.5.4"
    if (kind === "factory") f.behavior.invalidFactory = true
    try {
      const original = await f.daemonRun(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      await expect(f.prepare()).rejects.toMatchObject({ reason: "prepare" })
      expect((await f.daemonRun(f.daemon.inspect()))!.pid).toBe(original.pid)
      expect(await readRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
      expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(false)
      expect(await f.raw()).toEqual(f.config)
    } finally { await f.daemonRun(f.daemon.stop()) }
  })

  it("activates while stopped without starting sync or rewriting user configuration", async () => {
    const f = await fixture(), prepared = await f.prepare()
    const bytes = await readFile(f.paths.configFile, "utf8")
    await f.activate(prepared)
    expect((await readRuntimeSelection(f.paths.atapeHome))?.version).toBe("0.5.3")
    expect((await f.selected()).adapters.map(adapter => adapter.version)).toEqual(["0.5.3", "0.5.3"])
    expect(await readFile(f.paths.configFile, "utf8")).toBe(bytes)
    expect(await f.daemonRun(f.daemon.inspect())).toBeUndefined()
    expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(false)
  })

  it("keeps an already managed generation running when the next CLI installation fails", async () => {
    const f = await fixture()
    await f.activate(await f.prepare("0.5.3"))
    try {
      const original = await f.daemonRun(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      const selected = await readRuntimeSelection(f.paths.atapeHome)
      f.environment.MANAGED_TEST_FAIL_NPM = "true"
      await expect(f.prepare("0.5.4", (await f.selected()).adapters)).rejects.toMatchObject({ reason: "prepare" })
      expect(await readRuntimeSelection(f.paths.atapeHome)).toEqual(selected)
      expect((await f.daemonRun(f.daemon.inspect()))!.pid).toBe(original.pid)
      expect((await f.selected()).adapters.map(adapter => adapter.version)).toEqual(["0.5.3", "0.5.3"])
      expect(await f.raw()).toEqual(f.config)
    } finally { await f.daemonRun(f.daemon.stop()) }
  })

  // Multiple generations each launch npm and Adapter preflight processes.
  it("selects the latest generation after repeated updates while retaining the original raw baseline", async () => {
    const f = await fixture()
    await f.activate(await f.prepare("0.5.3"))
    await f.activate(await f.prepare("0.5.4", (await f.selected()).adapters))
    expect((await readRuntimeSelection(f.paths.atapeHome))?.version).toBe("0.5.4")
    expect((await f.selected()).adapters.map(adapter => adapter.version)).toEqual(["0.5.4", "0.5.4"])
    expect(await f.raw()).toEqual(f.config)
  }, 30_000)

  it("rejects an older prepared selection after another generation activates against the same raw baseline", async () => {
    const f = await fixture()
    await f.activate(await f.prepare("0.5.3"))
    const adapters = (await f.selected()).adapters
    const stale = await f.prepare("0.5.4", adapters)
    await f.activate(await f.prepare("0.5.5", adapters))
    const selected = await readRuntimeSelection(f.paths.atapeHome)
    await expect(f.activate(stale)).rejects.toMatchObject({ reason: "handoff" })
    expect(await readRuntimeSelection(f.paths.atapeHome)).toEqual(selected)
    expect((await f.selected()).adapters.map(adapter => adapter.version)).toEqual(["0.5.5", "0.5.5"])
    expect(await f.raw()).toEqual(f.config)
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  }, 30_000)

  it("rechecks automatic-update policy after preparation", async () => {
    const f = await fixture(), prepared = await f.prepare()
    await f.save({ ...f.config, autoUpdateEnabled: false })
    await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
    expect((await readRuntimeSelection(f.paths.atapeHome))?.version).not.toBe("0.5.3")
    expect((await f.raw()).autoUpdateEnabled).toBe(false)
    expect(await f.daemonRun(f.daemon.inspect())).toBeUndefined()
  })

  it("rechecks configured tools before a forced activation", async () => {
    const f = await fixture(), prepared = await f.prepare()
    await f.save({ ...f.config, toolsConfigured: false })
    await expect(f.activate(prepared, false)).rejects.toMatchObject({ reason: "handoff" })
    expect(await readRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
    expect(await f.daemonRun(f.daemon.inspect())).toBeUndefined()
  })

  it("rejects a stale prepared update after a concurrent Adapter installation", async () => {
    const f = await fixture(), prepared = await f.prepare()
    const changed = { ...f.config, adapters: f.config.adapters.map(adapter => adapter.adapterId === "codex"
      ? { ...adapter, version: "0.5.8", updatedAt: "2026-10-09T00:00:02.000Z" } : adapter) }
    await f.save(changed)
    await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
    expect(await f.raw()).toEqual(changed)
    expect((await readRuntimeSelection(f.paths.atapeHome))?.version).not.toBe("0.5.3")
  })

  it.each(["enabled", "git"] as const)("rejects a prepared candidate after the collection %s scope changes", async field => {
    const f = await fixture(), prepared = await f.prepare()
    const changed: ClientConfig = { ...f.config, ...(field === "enabled" ? { enabledAdapterIds: [] } : {
      projects: f.config.projects.map(project => ({ ...project, type: "git" as const }))
    }) }
    await f.save(changed)
    await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
    expect(await f.raw()).toEqual(changed)
    expect((await readRuntimeSelection(f.paths.atapeHome))?.version).not.toBe("0.5.3")
    expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(false)
  })

  it("rejects a stale caller snapshot when an explicit higher-version installation preceded preparation", async () => {
    const f = await fixture()
    const changed = { ...f.config, adapters: f.config.adapters.map(adapter => adapter.adapterId === "codex"
      ? { ...adapter, version: "0.5.8", updatedAt: "2026-10-09T00:00:02.000Z" } : adapter) }
    await f.save(changed)
    await expect(f.prepare("0.5.3", f.adapters)).rejects.toMatchObject({ reason: "state" })
    expect(await f.raw()).toEqual(changed)
    expect(await readRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(false)
  })

  it("keeps installed official packages on one version with all tools disabled", async () => {
    const f = await fixture()
    await f.save({ ...f.config, enabledAdapterIds: [], projects: [] })
    const prepared = await f.prepare()
    expect(f.adapterSpecs).toEqual(["@atape/adapter-codex@0.5.3", "@atape/adapter-claude@0.5.3"])
    await f.activate(prepared)
    const selected = await f.selected()
    expect(selected.enabledAdapterIds).toEqual([])
    expect(selected.projects).toEqual([])
    expect(selected.adapters.map(adapter => adapter.version)).toEqual(["0.5.3", "0.5.3"])
    expect(await f.daemonRun(f.daemon.inspect())).toBeUndefined()
  })

  it("validates every prepared official Adapter import even with no enabled tools", async () => {
    const f = await fixture()
    await f.save({ ...f.config, enabledAdapterIds: [], projects: [] })
    f.behavior.invalidFactory = true
    await expect(f.prepare()).rejects.toMatchObject({ reason: "prepare" })
    expect(f.adapterSpecs).toEqual(["@atape/adapter-codex@0.5.3", "@atape/adapter-claude@0.5.3"])
    expect(await readRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
  })

  it("restores an independently retained original runtime when the replacement cannot become ready", async () => {
    const f = await fixture(), prepared = await f.prepare()
    f.environment.MANAGED_TEST_FAIL_READY = "0.5.3"
    try {
      await f.daemonRun(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
      const selected = await readRuntimeSelection(f.paths.atapeHome)
      expect(selected?.version).toBe("0.5.2")
      expect(await resolveRuntimeEntry(f.paths.atapeHome, f.entry)).toBe(await realpath(runtimeEntry(f.paths.atapeHome, "0.5.2")))
      expect(await readFile(runtimeEntry(f.paths.atapeHome, "0.5.2"), "utf8")).toBe(await readFile(f.entry, "utf8"))
      const current = await f.daemonRun(f.daemon.inspect())
      expect(current).toMatchObject({ intervalMs: 45000, concurrency: 2 })
      await expect.poll(async () => JSON.parse(await readFile(f.environment.MANAGED_TEST_STARTED!, "utf8")))
        .toEqual({ version: "0.5.2", pid: current!.pid })
      expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(false)
      expect(await needsUpdateRecovery(f.paths)).toBe(false)
      await recoverPendingUpdate(f.paths, f.entry, f.environment)
      expect((await f.daemonRun(f.daemon.inspect()))!.pid).toBe(current!.pid)
    } finally { await f.daemonRun(f.daemon.stop()) }
  }, 15_000)

  it("retains the recovery journal and gate when both the replacement and fallback cannot become ready", async () => {
    const f = await fixture(), prepared = await f.prepare()
    try {
      await f.daemonRun(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      f.environment.MANAGED_TEST_FAIL_READY = "all"
      await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
      expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(true)
      expect(await needsUpdateRecovery(f.paths)).toBe(true)
      expect(JSON.parse(await readFile(join(f.paths.atapeHome, "updates", "pending.json"), "utf8")))
        .toMatchObject({ next: { version: "0.5.3" }, previous: { version: "0.5.2" } })
      await f.save({ ...f.config, autoUpdateEnabled: false })
      // Recovery dispatch ignores the policy/schedule for new installations.
      // Hold worker ownership to exercise dispatch without spawning a fake CLI.
      await writeFile(join(f.paths.atapeHome, "updates", "state.json"), "incomplete schedule")
      const release = await acquireUpdateWorker(f.paths.atapeHome)
      try { await f.run(AutomaticUpdatePlatform.use(platform => platform.launch())) } finally { release!() }
      delete f.environment.MANAGED_TEST_FAIL_READY
      await recoverPendingUpdate(f.paths, f.entry, f.environment)
      expect(await needsUpdateRecovery(f.paths)).toBe(false)
      expect(await f.daemonRun(f.daemon.inspect())).toMatchObject({ intervalMs: 45000, concurrency: 2 })
      expect((await f.raw()).autoUpdateEnabled).toBe(false)
    } finally { await f.daemonRun(f.daemon.stop()) }
  }, 20_000)

  it("excludes two worker acquisitions in the same process and releases ownership", async () => {
    const f = await fixture()
    const release = await acquireUpdateWorker(f.paths.atapeHome)
    expect(release).toBeTypeOf("function")
    try { expect(await acquireUpdateWorker(f.paths.atapeHome)).toBeUndefined() } finally { release!() }
    const next = await acquireUpdateWorker(f.paths.atapeHome)
    expect(next).toBeTypeOf("function")
    next!()
  })
})
