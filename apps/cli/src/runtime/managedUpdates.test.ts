import { AdapterPackageError, AdapterPackages, AutomaticUpdatePlatform, ClientConfigStore, CollectorDaemonProcess, runAutomaticUpdates,
  type PreparedAutomaticUpdate } from "@atape/application"
import { AdapterProtocolVersion, emptyClientConfig, GitAttributionVersion, releasePackageNames, releaseBundleSection,
  type ReleaseBundle, type AdapterInstallation, type ClientConfig } from "@atape/domain"
import { Effect, Layer } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { adapterPackageRoot } from "./adapterInstallation.ts"
import { isCollectorMaintenancePending, makeNodeCollectorDaemonLayer } from "./collectorDaemonLayers.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { acquireUpdateWorker, makeAutomaticUpdatePlatformLayer, needsUpdateRecovery, protectedRuntimeSlots, recoverPendingUpdate } from "./managedUpdates.ts"
import { atomicJSON, managedStateContract, readEffectiveRuntimeSelection, readRuntimeSelection, readSelectedClientConfig, resolveRuntimeEntry, runtimeEntry } from "./runtimeSelection.ts"
import { createUpdateControl, updateControlProtocol } from "./updateControl.ts"

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

const fixture = async (options: { readonly control?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "atape-managed-update-")); roots.push(root)
  const paths = defaultNodeClientPaths({ ATAPE_HOME: join(root, "home") })
  const modules = join(root, "npm-global", "node_modules"), entry = join(modules, "@atape", "cli", "dist", "atape.js")
  await mkdir(dirname(entry), { recursive: true })
  await atomicJSON(join(dirname(dirname(entry)), "package.json"), { name: "@atape/cli", version: "0.5.2", type: "module",
    atapeRuntime: { protocol: "atape.runtime.v1", stateContract: managedStateContract,
      ...(options.control ? { updateControlProtocol } : {}) } })
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
  const artifact=args.at(-1), version=JSON.parse(fs.readFileSync(artifact,"utf8")).version;
  if (process.env.MANAGED_TEST_HANG_NPM==="true") {
    fs.writeFileSync(process.env.MANAGED_TEST_NPM_STARTED, artifact);
    process.on("SIGTERM",()=>{fs.writeFileSync(process.env.MANAGED_TEST_NPM_EXITED,JSON.stringify({artifactExists:fs.existsSync(artifact)}));process.exit(0)});
    setInterval(()=>{},1000);
  } else {
  const destination=path.join(args[args.indexOf("--prefix")+1],"node_modules","@atape","cli");
  fs.mkdirSync(path.join(destination,"dist"),{recursive:true});
  fs.writeFileSync(path.join(destination,"package.json"),JSON.stringify({name:"@atape/cli",version,type:"module",
    atapeRuntime:{protocol:"atape.runtime.v1",stateContract:process.env.MANAGED_TEST_CONTRACT,
      updateControlProtocol:process.env.MANAGED_TEST_CONTROL,releaseCatalogProtocol:process.env.MANAGED_TEST_CATALOG}}));
  const reported=process.env.MANAGED_TEST_WRONG_VERSION || version;
  fs.writeFileSync(path.join(destination,"dist","atape.js"), (${cliSource.toString()})(reported));
  }
} else process.exit(2);
`)
  await chmod(join(bin, "npm"), 0o700)
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ATAPE_HOME: paths.atapeHome,
    MANAGED_TEST_CALLS: calls, MANAGED_TEST_MODULES: modules, MANAGED_TEST_CONTRACT: managedStateContract,
    MANAGED_TEST_CONTROL: updateControlProtocol, MANAGED_TEST_CATALOG: "atape.update-catalog.v1",
    MANAGED_TEST_STARTED: join(root, "started.json"), MANAGED_TEST_NPM_STARTED: join(root, "npm-started"), MANAGED_TEST_NPM_EXITED: join(root, "npm-exited.json") }
  const adapterSpecs: string[] = [], fetches: string[] = []
  const adapters: AdapterInstallation[] = ["codex", "claude"].map(id => ({ adapterId: id, packageName: `@atape/adapter-${id}`,
    version: "0.5.2", upgradeSpec: `@atape/adapter-${id}`, displayName: id,
    installedAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" }))
  const config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: true,
    enabledAdapterIds: ["codex"], adapters, projects: [{ id: "project", instanceOrigin: "https://example.invalid", userId: "user",
      teamId: "team", teamSlug: "team", teamName: "Team", name: "Project", type: "directory", path: root,
      createdAt: "2026-10-09T00:00:00.000Z" }] }
  const behavior = { missingPackage: "", invalidFactory: false, targetVersion: "0.5.3", corruptArtifact: false,
    changedDescriptor: false }
  const artifactBytes = (name: string, version: string) => Buffer.from(JSON.stringify({ name, version }))
  const bundle = (version: string): ReleaseBundle => ({ protocol: "atape.release-bundle.v1", version,
    captureStateContract: managedStateContract, updateControlProtocol,
    packages: releasePackageNames.map(name => ({ name,
      integrity: `sha512-${createHash("sha512").update(artifactBytes(name, version)).digest("base64")}`,
      tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` })) })
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
    if (address.startsWith("https://api.github.com/")) {
      const tag = decodeURIComponent(new URL(address).pathname.split("/").at(-1)!)
      if (tag === "atape-update-catalog-v1") {
        const advertised = bundle(behavior.targetVersion)
        const incomplete = { ...advertised, packages: advertised.packages.filter(item => item.name !== behavior.missingPackage) }
        return Response.json({ tag_name: tag, draft: false, prerelease: true, published_at: "2026-10-01T00:00:00.000Z",
          body: JSON.stringify({ protocol: "atape.update-catalog.v1", revision: Number(behavior.targetVersion.split(".").at(-1)) + 1, bundles: [incomplete] }) })
      }
      const descriptor = bundle(tag.slice(1))
      const changed = behavior.changedDescriptor ? { ...descriptor, packages: descriptor.packages.map((item, index) => index === 0
        ? { ...item, integrity: bundle("0.5.99").packages[0]!.integrity } : item) } : descriptor
      return Response.json({ tag_name: tag, draft: false, prerelease: false, published_at: "2026-10-01T00:00:00.000Z", body: releaseBundleSection(changed) })
    }
    const name = releasePackageNames.find(name => address.startsWith(`https://registry.npmjs.org/${name}/-/`))
    if (!name) throw new Error(`Unexpected fixture URL ${address}`)
    const version = /-(\d+\.\d+\.\d+)\.tgz$/.exec(address)?.[1]
    if (!version) throw new Error("Missing artifact version")
    return new Response(behavior.corruptArtifact ? Buffer.from("corrupt archive") : artifactBytes(name, version))
  }
  const layer = (path = entry, version = "0.5.2") => makeAutomaticUpdatePlatformLayer(paths, path, version, environment, fetchMetadata).pipe(Layer.provide(packages))
  const run = <A, E>(effect: Effect.Effect<A, E, AutomaticUpdatePlatform>, path = entry, version = "0.5.2", signal?: AbortSignal) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer(path, version))), signal ? { signal } : undefined)
  const prepare = (version = "0.5.3", selected: ReadonlyArray<AdapterInstallation> = adapters, signal?: AbortSignal) => {
    behavior.targetVersion = version
    return run(Effect.scoped(AutomaticUpdatePlatform.use(platform => platform.prepare(bundle(version), selected))), entry, "0.5.2", signal)
  }
  const activate = (prepared: PreparedAutomaticUpdate, automatic = true) => run(AutomaticUpdatePlatform.use(platform => platform.activate(prepared, automatic)))
  const daemonLayer = makeNodeCollectorDaemonLayer(paths, () => resolveRuntimeEntry(paths.atapeHome, entry), environment)
  const daemonRun = <A, E>(effect: Effect.Effect<A, E, CollectorDaemonProcess>) => Effect.runPromise(effect.pipe(Effect.provide(daemonLayer)))
  const daemon = await daemonRun(CollectorDaemonProcess)
  return { root, paths, entry, calls, environment, adapters, adapterSpecs, config, behavior, bundle, fetches, run, prepare, activate, daemon, daemonRun,
    raw: async () => JSON.parse(await readFile(paths.configFile, "utf8")) as ClientConfig,
    selected: () => Effect.runPromise(readSelectedClientConfig(paths)),
    save: (next: ClientConfig) => atomicJSON(paths.configFile, next),
    npmCalls: async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) }
}

describe.skipIf(process.platform === "win32")("managed update Node Adapter", () => {
  it("discovers a complete catalog bundle and refreshes automatic targets without legacy Latest", async () => {
    const f = await fixture()
    const target = () => f.run(AutomaticUpdatePlatform.use(platform => platform.target()))
    expect(await target()).toEqual(f.bundle("0.5.3"))
    expect(await target()).toEqual(f.bundle("0.5.3"))
    expect(f.fetches).toHaveLength(2)
    expect(f.fetches.every(address => address.endsWith("/tags/atape-update-catalog-v1"))).toBe(true)
    expect(await f.npmCalls()).toEqual([])
  })

  it("rejects a same-version descriptor rewrite before installing any candidate", async () => {
    const f = await fixture()
    f.behavior.changedDescriptor = true
    await expect(f.prepare()).rejects.toMatchObject({ reason: "release" })
    expect((await f.npmCalls()).some(args => args[0] === "install")).toBe(false)
    expect(f.adapterSpecs).toEqual([])
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  })

  it("rejects corrupted downloaded CLI bytes and cleans its lease while the original Collector stays running", async () => {
    const f = await fixture()
    try {
      const original = await f.daemonRun(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      f.behavior.corruptArtifact = true
      await expect(f.prepare()).rejects.toMatchObject({ reason: "prepare" })
      expect((await f.npmCalls()).some(args => args[0] === "install")).toBe(false)
      expect(await readdir(join(f.paths.atapeHome, "cache", "release-discovery", "artifacts"))).toEqual([])
      expect((await f.daemonRun(f.daemon.inspect()))?.pid).toBe(original.pid)
      expect(await needsUpdateRecovery(f.paths)).toBe(false)
    } finally { await f.daemonRun(f.daemon.stop()) }
  })

  it.each(["MANAGED_TEST_CONTROL", "MANAGED_TEST_CATALOG"])("requires actual candidate capability %s even over a historical bootstrap", async capability => {
    const f = await fixture()
    delete f.environment[capability]
    await expect(f.prepare()).rejects.toMatchObject({ reason: "prepare" })
    expect(await readEffectiveRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  })

  it("matches the entire durable bundle rather than only its version before maintenance", async () => {
    const f = await fixture(), prepared = await f.prepare()
    const changed = { ...prepared.bundle, packages: prepared.bundle.packages.map((item, index) => index === 3
      ? { ...item, integrity: f.bundle("0.5.99").packages[index]!.integrity } : item) }
    await expect(f.activate({ ...prepared, bundle: changed })).rejects.toMatchObject({ reason: "handoff" })
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
    expect(await readEffectiveRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(false)
  })

  it("refuses an existing same-version generation with different runnable bytes without overwriting it", async () => {
    const f = await fixture(), prepared = await f.prepare()
    const entry = runtimeEntry(f.paths.atapeHome, prepared.bundle.version)
    const different = `${await readFile(entry, "utf8")}\n// A different same-version build.\n`
    await writeFile(entry, different)
    await expect(f.prepare()).rejects.toMatchObject({ reason: "prepare" })
    expect(await readFile(entry, "utf8")).toBe(different)
    expect(await readEffectiveRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(false)
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  })

  it("reuses a byte-identical immutable generation only after comparison with the verified archive install", async () => {
    const f = await fixture(), first = await f.prepare(), again = await f.prepare()
    expect(again.bundle).toEqual(first.bundle)
    expect(again.key).not.toBe(first.key)
    expect((await f.npmCalls()).filter(args => args[0] === "install")).toHaveLength(2)
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  })

  it("requires the retained bootstrap generation to match the actual installed bootstrap bytes", async () => {
    const f = await fixture()
    await f.prepare()
    const retained = runtimeEntry(f.paths.atapeHome, "0.5.2")
    const different = `${await readFile(retained, "utf8")}\n// A different retained build.\n`
    await writeFile(retained, different)
    await expect(f.prepare()).rejects.toMatchObject({ reason: "prepare" })
    expect(await readFile(retained, "utf8")).toBe(different)
    expect(await readFile(f.entry, "utf8")).not.toBe(different)
    expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(false)
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  })

  it("keeps the verified archive until cancelled npm terminates, then removes the lease", async () => {
    const f = await fixture(), cancellation = new AbortController()
    f.environment.MANAGED_TEST_HANG_NPM = "true"
    const task = f.prepare("0.5.3", f.adapters, cancellation.signal)
    const rejected = expect(task).rejects.toBeDefined()
    let artifact: string | undefined
    try {
      await expect.poll(async () => readFile(f.environment.MANAGED_TEST_NPM_STARTED!, "utf8").catch(() => undefined)).toBeDefined()
      artifact = await readFile(f.environment.MANAGED_TEST_NPM_STARTED!, "utf8")
      expect(JSON.parse(await readFile(artifact, "utf8")).version).toBe("0.5.3")
    } finally { cancellation.abort(); await rejected }
    expect(JSON.parse(await readFile(f.environment.MANAGED_TEST_NPM_EXITED!, "utf8"))).toEqual({ artifactExists: true })
    await expect(readFile(artifact!)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(join(f.paths.atapeHome, "cache", "release-discovery", "artifacts"))).toEqual([])
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  })

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
    expect((await readEffectiveRuntimeSelection(f.paths.atapeHome))?.version).toBe("0.5.4")
    expect((await f.selected()).adapters.map(adapter => adapter.version)).toEqual(["0.5.4", "0.5.4"])
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  })

  it("pins the complete release and every prepared official package to one version with lifecycle scripts disabled", async () => {
    const f = await fixture(), prepared = await f.prepare()
    expect(prepared.bundle.version).toBe("0.5.3")
    expect(f.adapterSpecs).toEqual(["@atape/adapter-codex@0.5.3", "@atape/adapter-claude@0.5.3"])
    expect(f.fetches).toHaveLength(3)
    expect(f.fetches[0]).toContain("atape-update-catalog-v1")
    expect(f.fetches[1]).toContain("/tags/v0.5.3")
    expect(f.fetches[2]).toBe(f.bundle("0.5.3").packages.find(item => item.name === "@atape/cli")!.tarball)
    const installation = (await f.npmCalls()).find(args => args[0] === "install")!
    expect(installation).not.toContain("@atape/cli@0.5.3")
    const archive = installation.at(-1)!
    expect(archive).toContain("release-discovery/artifacts/.lease-")
    await expect(readFile(archive)).rejects.toMatchObject({ code: "ENOENT" })
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
    expect((await readEffectiveRuntimeSelection(f.paths.atapeHome))?.version).toBe("0.5.4")
    expect((await f.selected()).adapters.map(adapter => adapter.version)).toEqual(["0.5.4", "0.5.4"])
    expect(await f.raw()).toEqual(f.config)
  }, 30_000)

  it("installs one genuine capable legacy bridge before independent updates preserve that bridge", async () => {
    const f = await fixture()
    f.environment.MANAGED_TEST_CONTROL = updateControlProtocol
    await f.activate(await f.prepare("0.5.3"))
    const bridge = await readRuntimeSelection(f.paths.atapeHome)
    expect(bridge?.version).toBe("0.5.3")
    expect(await createUpdateControl(f.paths.atapeHome).readSelection()).toBeUndefined()
    await f.activate(await f.prepare("0.5.4", (await f.selected()).adapters))
    expect(await readRuntimeSelection(f.paths.atapeHome)).toEqual(bridge)
    expect(await createUpdateControl(f.paths.atapeHome).readSelection()).toMatchObject({
      protocol: updateControlProtocol, captureStateContract: managedStateContract, version: "0.5.4"
    })
    expect((await readEffectiveRuntimeSelection(f.paths.atapeHome))?.version).toBe("0.5.4")
    expect((await f.selected()).adapters.map(adapter => adapter.version)).toEqual(["0.5.4", "0.5.4"])
    expect(await f.raw()).toEqual(f.config)
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
    await expect(readFile(join(f.paths.atapeHome, "updates", "pending.json"))).rejects.toMatchObject({ code: "ENOENT" })
  }, 30_000)

  it("keeps the complete independent generation and its previous Adapter slots protected across repeated updates", async () => {
    const f = await fixture({ control: true })
    await f.activate(await f.prepare("0.5.3"))
    const previous = (await f.selected()).adapters
    await f.activate(await f.prepare("0.5.4", previous))
    const current = (await f.selected()).adapters
    expect((await readEffectiveRuntimeSelection(f.paths.atapeHome))?.version).toBe("0.5.4")
    expect(await readRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(new Set(await protectedRuntimeSlots(f.paths.atapeHome))).toEqual(new Set([
      ...previous.map(adapter => adapter.packageSlot!), ...current.map(adapter => adapter.packageSlot!)
    ]))
    expect(await f.raw()).toEqual(f.config)
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  }, 30_000)

  it("recovers a replaced bootstrap without losing its selected Adapter slots or reviving Stop", async () => {
    const f = await fixture({ control: true })
    await f.activate(await f.prepare("0.5.3"))
    const selectedAdapters = (await f.selected()).adapters
    const saved = { ...f.config, autoUpdateEnabled: false, autoStartEnabled: false }
    await f.save(saved)
    // A real external replacement changes the original npm executable before
    // a coordinator can bind it. Recovery must materialize the old overlay.
    await writeFile(f.entry, cliSource("0.5.4"))
    await atomicJSON(join(dirname(dirname(f.entry)), "package.json"), { name: "@atape/cli", version: "0.5.4", type: "module",
      atapeRuntime: { protocol: "atape.runtime.v1", stateContract: managedStateContract, updateControlProtocol } })
    expect(await needsUpdateRecovery(f.paths)).toBe(true)
    const release = await acquireUpdateWorker(f.paths.atapeHome)
    expect(release).toBeDefined()
    try { await recoverPendingUpdate(f.paths, f.entry, f.environment) } finally { release!() }
    expect((await readEffectiveRuntimeSelection(f.paths.atapeHome))?.version).toBe("0.5.4")
    expect((await f.raw()).adapters).toEqual(selectedAdapters)
    expect((await f.selected()).adapters).toEqual(selectedAdapters)
    expect(await f.raw()).toEqual({ ...saved, adapters: selectedAdapters })
    expect(await f.daemonRun(f.daemon.inspect())).toBeUndefined()
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  }, 15_000)

  it("keeps independent preflight outside durable recovery and rechecks auto-off without reviving Stop", async () => {
    const f = await fixture({ control: true })
    const prepared = await f.prepare("0.5.3")
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
    expect(f.adapterSpecs).toHaveLength(2)
    await f.save({ ...f.config, autoUpdateEnabled: false })
    await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
    expect(await createUpdateControl(f.paths.atapeHome).readSelection()).toBeUndefined()
    expect(await f.daemonRun(f.daemon.inspect())).toBeUndefined()
    expect((await f.raw()).autoUpdateEnabled).toBe(false)
  })

  it("recovers an interrupted independent selection before preparing again even after auto-off", async () => {
    const f = await fixture({ control: true }), prepared = await f.prepare()
    const candidate = JSON.parse(await readFile(join(f.paths.atapeHome, "updates", `${prepared.key}.prepared.json`), "utf8")).selection
    const next = { protocol: updateControlProtocol, captureStateContract: candidate.stateContract,
      version: candidate.version, bootstrapEntry: candidate.bootstrapEntry, bootstrapIdentity: candidate.bootstrapIdentity,
      adapters: candidate.adapters }
    const control = createUpdateControl(f.paths.atapeHome)
    // Simulate loss of the coordinator after quiescent begin while sync is Stop.
    const ticket = await control.prepare({ next, previous: { ...next, version: "0.5.2", adapters: [] } })
    await control.begin(ticket)
    expect(await needsUpdateRecovery(f.paths)).toBe(true)
    await expect(f.prepare("0.5.4", (await f.selected()).adapters)).rejects.toMatchObject({ reason: "state" })
    await f.save({ ...f.config, autoUpdateEnabled: false })
    await recoverPendingUpdate(f.paths, f.entry, f.environment)
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
    expect(await control.readSelection()).toBeUndefined()
    expect(await f.daemonRun(f.daemon.inspect())).toBeUndefined()
    expect((await f.raw()).autoUpdateEnabled).toBe(false)
  })

  it("rolls back a failed independent readiness check while keeping its compatible legacy bridge selected", async () => {
    const f = await fixture()
    f.environment.MANAGED_TEST_CONTROL = updateControlProtocol
    await f.activate(await f.prepare("0.5.3"))
    const bridge = await readRuntimeSelection(f.paths.atapeHome)
    const prepared = await f.prepare("0.5.4", (await f.selected()).adapters)
    f.environment.MANAGED_TEST_FAIL_READY = "0.5.4"
    try {
      await f.daemonRun(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
      expect(await readRuntimeSelection(f.paths.atapeHome)).toEqual(bridge)
      expect(await createUpdateControl(f.paths.atapeHome).readSelection()).toBeUndefined()
      expect((await readEffectiveRuntimeSelection(f.paths.atapeHome))?.version).toBe("0.5.3")
      expect(await f.daemonRun(f.daemon.inspect())).toMatchObject({ intervalMs: 45000, concurrency: 2 })
      expect(await needsUpdateRecovery(f.paths)).toBe(false)
    } finally { await f.daemonRun(f.daemon.stop()) }
  }, 30_000)

  it("retains independent recovery and maintenance until a failed fallback becomes locally ready", async () => {
    const f = await fixture({ control: true }), prepared = await f.prepare()
    try {
      await f.daemonRun(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      f.environment.MANAGED_TEST_FAIL_READY = "all"
      await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
      expect(await isCollectorMaintenancePending(f.paths.collectorProcessFile)).toBe(true)
      expect(await createUpdateControl(f.paths.atapeHome).recoveryPending()).toBe(true)
      await f.save({ ...f.config, autoUpdateEnabled: false })
      delete f.environment.MANAGED_TEST_FAIL_READY
      await recoverPendingUpdate(f.paths, f.entry, f.environment)
      expect(await needsUpdateRecovery(f.paths)).toBe(false)
      expect(await f.daemonRun(f.daemon.inspect())).toMatchObject({ intervalMs: 45000, concurrency: 2 })
      expect((await f.raw()).autoUpdateEnabled).toBe(false)
    } finally { await f.daemonRun(f.daemon.stop()) }
  }, 30_000)

  it("rejects returning an independent installation to an incapable package without replacing its generation", async () => {
    const f = await fixture({ control: true })
    await f.activate(await f.prepare("0.5.3"))
    const selected = await readEffectiveRuntimeSelection(f.paths.atapeHome)
    delete f.environment.MANAGED_TEST_CONTROL
    await expect(f.prepare("0.5.4", (await f.selected()).adapters)).rejects.toMatchObject({ reason: "prepare" })
    expect(await readEffectiveRuntimeSelection(f.paths.atapeHome)).toEqual(selected)
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
  }, 15_000)

  it.each(["updateControlProtocol", "releaseCatalogProtocol"])("rechecks target capability %s after preflight without starting a durable transaction", async capability => {
    const f = await fixture({ control: true }), prepared = await f.prepare()
    const path = join(dirname(dirname(runtimeEntry(f.paths.atapeHome, prepared.bundle.version))), "package.json")
    const manifest = JSON.parse(await readFile(path, "utf8"))
    delete manifest.atapeRuntime[capability]
    await atomicJSON(path, manifest)
    await expect(f.activate(prepared)).rejects.toMatchObject({ reason: "handoff" })
    expect(await readEffectiveRuntimeSelection(f.paths.atapeHome)).toBeUndefined()
    expect(await createUpdateControl(f.paths.atapeHome).recoveryPending()).toBe(false)
    expect(await needsUpdateRecovery(f.paths)).toBe(false)
    expect(await f.raw()).toEqual(f.config)
  })

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
