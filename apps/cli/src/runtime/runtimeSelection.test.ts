import { ClientConfigStore, inspectClient, setAutomaticUpdates } from "@atape/application"
import { emptyClientConfig, type AdapterInstallation, type ClientConfig, type ProjectRegistration } from "@atape/domain"
import { Effect } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readClientConfig, withClientConfigFileLock } from "./clientConfig.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import {
  makeSelectedConfigStoreLayer, legacyBridgeCaptureContract, preserveSelectedInstallations, readEffectiveRuntimeSelection,
  readRuntimeSelection, readSelectedClientConfig, resolveLegacyRuntimeEntry, resolveRuntimeEntry, runtimeEntry, runtimeSelectionFile,
  selectedBootstrap, selectRuntime, type RuntimeSelection
} from "./runtimeSelection.ts"
import { createUpdateControl, updateControlProtocol, type UpdateRuntimeSelection } from "./updateControl.ts"

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const project: ProjectRegistration = {
  id: "project-1", instanceOrigin: "https://atape.test", userId: "user-1", teamId: "team-1",
  teamSlug: "team", teamName: "Team", name: "Original project", type: "directory",
  path: "/workspace/project", createdAt: "2026-10-09T00:00:00Z"
}
const installed = (version: string): AdapterInstallation => ({
  adapterId: "codex", packageName: "@atape/adapter-codex", version, packageSlot: randomUUID(),
  upgradeSpec: "@atape/adapter-codex", displayName: "Codex",
  installedAt: "2026-10-01T00:00:00Z", updatedAt: `2026-10-09T00:00:00.${version.endsWith("2") ? "002" : "003"}Z`
})

const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-runtime-selection-")))
  temporaryDirectories.push(home)
  const paths = defaultNodeClientPaths({ ATAPE_HOME: home })
  const bootstrap = join(home, "bootstrap", "atape.js")
  await mkdir(dirname(bootstrap), { recursive: true })
  await writeFile(bootstrap, 'console.log("ATape 1.2.1")')
  const original = installed("1.2.1")
  const custom: AdapterInstallation = {
    ...installed("8.0.0"), adapterId: "custom", packageName: "@custom/reader", upgradeSpec: "file:/workspace/custom"
  }
  const raw: ClientConfig = {
    ...emptyClientConfig(), toolsConfigured: true, locale: "zh-CN", projects: [project],
    adapters: [original, custom], enabledAdapterIds: ["codex", "custom"]
  }
  await mkdir(dirname(paths.configFile), { recursive: true })
  await writeFile(paths.configFile, JSON.stringify(raw))

  const generation = async (version: string): Promise<RuntimeSelection> => {
    const after = installed(version)
    const packageRoot = join(paths.adapterDirectory, "slots", after.packageSlot!, "node_modules", "@atape", "adapter-codex")
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: after.packageName, version }))
    const entry = runtimeEntry(home, version)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, `console.log("ATape ${version}")`)
    await writeFile(join(dirname(dirname(entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version,
      atapeRuntime: { stateContract: legacyBridgeCaptureContract } }))
    return { protocol: "atape.runtime.v1", stateContract: legacyBridgeCaptureContract, version,
      bootstrapEntry: bootstrap, adapters: [{ before: original, after }] }
  }
  const controlGeneration = async (version: string, captureStateContract = legacyBridgeCaptureContract): Promise<UpdateRuntimeSelection> => {
    const selected = await generation(version)
    await writeFile(join(dirname(dirname(runtimeEntry(home, version))), "package.json"), JSON.stringify({ name: "@atape/cli", version,
      atapeRuntime: { stateContract: captureStateContract, updateControlProtocol } }))
    return { protocol: updateControlProtocol, captureStateContract, version, bootstrapEntry: bootstrap,
      bootstrapIdentity: createHash("sha256").update(await readFile(bootstrap)).digest("hex"), adapters: selected.adapters }
  }
  const run = <A, E>(effect: Effect.Effect<A, E, ClientConfigStore>) => Effect.runPromise(
    effect.pipe(Effect.provide(makeSelectedConfigStoreLayer(paths))))
  return {
    home, paths, bootstrap, raw, original, custom, generation, controlGeneration, run,
    effective: () => Effect.runPromise(readSelectedClientConfig(paths)),
    persisted: () => Effect.runPromise(readClientConfig(paths.configFile)),
    pointer: (value: unknown) => writeFile(runtimeSelectionFile(home), typeof value === "string" ? value : JSON.stringify(value))
  }
}

describe("managed runtime selection through persisted configuration Interfaces", () => {
  it("uses the bootstrap and original configuration when no managed generation exists", async () => {
    const client = await fixture()
    expect(await client.effective()).toEqual(client.raw)
    expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(client.bootstrap)
    expect(await readRuntimeSelection(client.home)).toBeUndefined()
  })

  it("keeps consecutive B and C generations anchored to raw A while selecting one CLI/Adapter version", async () => {
    const client = await fixture()
    const second = await client.generation("1.2.2")
    const third = await client.generation("1.2.3")
    for (const selected of [second, third]) {
      await selectRuntime(client.home, selected)
      const effective = await client.effective()
      expect(effective.adapters).toEqual([selected.adapters[0]!.after, client.custom])
      expect((await client.run(inspectClient())).adapters).toEqual(effective.adapters)
      expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(runtimeEntry(client.home, selected.version))
      expect(await client.persisted()).toEqual(client.raw)
      expect((await readRuntimeSelection(client.home))!.adapters[0]!.before).toEqual(client.original)
    }
  })

  it("reads raw configuration and its selected generation under the same config lock", async () => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    let pending: Promise<ClientConfig> | undefined
    let completed = false
    await withClientConfigFileLock(client.paths.configFile, async () => {
      pending = client.effective().then(config => { completed = true; return config })
      await new Promise(done => setTimeout(done, 75))
      expect(completed).toBe(false)
      await writeFile(client.paths.configFile, JSON.stringify({ ...client.raw, locale: "en" }))
      await selectRuntime(client.home, selected)
    })
    expect(await pending).toEqual({ ...client.raw, locale: "en", adapters: [selected.adapters[0]!.after, client.custom] })
  })

  it("persists settings and Project edits without materializing the selected Adapter over raw A", async () => {
    const client = await fixture()
    const second = await client.generation("1.2.2")
    await selectRuntime(client.home, second)
    await client.run(setAutomaticUpdates(false))
    await client.run(Effect.gen(function*() {
      const store = yield* ClientConfigStore
      yield* store.transact(config => Effect.succeed({ value: undefined,
        config: { ...config, locale: "en", projects: config.projects.map(item => ({ ...item, name: "Renamed project" })) } }))
    }))
    const persisted = await client.persisted()
    expect(persisted).toEqual({ ...client.raw, autoUpdateEnabled: false, locale: "en", projects: [{ ...project, name: "Renamed project" }] })
    expect((await client.effective()).adapters[0]).toEqual(second.adapters[0]!.after)
    const third = await client.generation("1.2.3")
    await selectRuntime(client.home, third)
    expect((await client.effective()).adapters[0]).toEqual(third.adapters[0]!.after)
    expect((await client.effective()).autoUpdateEnabled).toBe(false)
    expect((await client.persisted()).adapters[0]).toEqual(client.original)
  })

  it.each(["slot", "source"] as const)("lets an explicit %s replacement invalidate its managed overlay", async kind => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    await selectRuntime(client.home, selected)
    const manual: AdapterInstallation = { ...selected.adapters[0]!.after,
      ...(kind === "slot" ? { packageSlot: randomUUID(), version: "1.2.4" } : { upgradeSpec: "file:/workspace/codex" }),
      updatedAt: "2026-10-09T00:01:00Z" }
    await client.run(Effect.gen(function*() {
      const store = yield* ClientConfigStore
      yield* store.transact(config => Effect.succeed({ value: undefined,
        config: { ...config, adapters: config.adapters.map(item => item.adapterId === manual.adapterId ? manual : item) } }))
    }))
    expect((await client.persisted()).adapters[0]).toEqual(manual)
    expect((await client.effective()).adapters).toEqual([manual, client.custom])
    expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(runtimeEntry(client.home, selected.version))
  })

  it("preserves an explicit Adapter metadata change instead of silently restoring the raw record", async () => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    await selectRuntime(client.home, selected)
    const changed = { ...selected.adapters[0]!.after, displayName: "Updated integration name" }
    await client.run(ClientConfigStore.use(store => store.transact(config => Effect.succeed({ value: undefined,
      config: { ...config, adapters: config.adapters.map(adapter => adapter.adapterId === changed.adapterId ? changed : adapter) }
    }))))
    expect((await client.persisted()).adapters[0]).toEqual(changed)
    expect((await client.effective()).adapters[0]).toEqual(changed)
  })

  it("rolls the current pointer from C back to B and can remove it to restore bootstrap A", async () => {
    const client = await fixture()
    const second = await client.generation("1.2.2")
    const third = await client.generation("1.2.3")
    await selectRuntime(client.home, second)
    await selectRuntime(client.home, third)
    await client.run(setAutomaticUpdates(false))
    await selectRuntime(client.home, second)
    expect((await readRuntimeSelection(client.home))!.version).toBe("1.2.2")
    expect((await client.effective()).adapters[0]).toEqual(second.adapters[0]!.after)
    expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(runtimeEntry(client.home, "1.2.2"))
    await selectRuntime(client.home, undefined)
    expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(client.bootstrap)
    expect((await client.effective()).adapters[0]).toEqual(client.original)
    expect((await client.effective()).autoUpdateEnabled).toBe(false)
  })

  it.each([
    { version: "../../outside" }, { version: "1.2" }, { version: "01.2.3" }, { version: "9007199254740992.2.3" },
    { bootstrapEntry: "relative/bootstrap.js" }, { protocol: "atape.runtime.v2" },
    { stateContract: "incompatible-state" }, { stateContract: "atape.client.v3-capture.v1" }, { bootstrapIdentity: "invalid" }
  ])("refuses invalid persisted selection metadata without silently using bootstrap: %j", async change => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    await selectRuntime(client.home, selected)
    const invalid = { ...selected, ...change }
    await client.pointer(invalid)
    await expect(client.effective()).rejects.toMatchObject({ reason: "decode" })
    await expect(client.run(inspectClient())).rejects.toMatchObject({ reason: "decode" })
    await expect(resolveRuntimeEntry(client.home, client.bootstrap)).rejects.toThrow()
    expect(await client.persisted()).toEqual(client.raw)
    expect(JSON.parse(await readFile(runtimeSelectionFile(client.home), "utf8"))).toEqual(invalid)
  })

  it("rejects malformed, oversized and symlinked current metadata", async () => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    await selectRuntime(client.home, selected)
    for (const contents of ["invalid json", " ".repeat(256 * 1024 + 1)]) {
      await client.pointer(contents)
      await expect(client.effective()).rejects.toMatchObject({ reason: "decode" })
    }
    await rm(runtimeSelectionFile(client.home))
    const elsewhere = join(client.home, "elsewhere.json")
    await writeFile(elsewhere, JSON.stringify(selected))
    await symlink(elsewhere, runtimeSelectionFile(client.home))
    await expect(client.effective()).rejects.toMatchObject({ reason: "decode" })
  })

  it("rejects an incomplete or mismatched official Adapter generation", async () => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    const pair = selected.adapters[0]!
    const { packageSlot: _, ...withoutSlot } = pair.after
    for (const adapters of [
      [pair, pair],
      [{ ...pair, after: { ...pair.after, version: "1.2.3" } }],
      [{ ...pair, after: withoutSlot }],
      [{ ...pair, after: { ...pair.after, packageName: "@custom/reader" } }],
      [{ ...pair, before: { ...pair.before, upgradeSpec: "file:/workspace/codex" } }]
    ]) {
      await expect(selectRuntime(client.home, { ...selected, adapters })).rejects.toThrow()
      expect(await readRuntimeSelection(client.home)).toBeUndefined()
    }
  })

  it("rejects a selected CLI entry outside the release or an entry that is not a file", async () => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    await selectRuntime(client.home, selected)
    const entry = runtimeEntry(client.home, selected.version)
    await rm(entry)
    await symlink(client.bootstrap, entry)
    await expect(resolveRuntimeEntry(client.home, client.bootstrap)).rejects.toThrow("outside")
    await rm(entry)
    await mkdir(entry)
    await expect(resolveRuntimeEntry(client.home, client.bootstrap)).rejects.toThrow()
  })

  it.each(["generation", "package"] as const)("rejects a %s directory symlink escaping the managed release", async kind => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    await selectRuntime(client.home, selected)
    const external = join(client.home, "external-package")
    await mkdir(join(external, "dist"), { recursive: true })
    await writeFile(join(external, "dist", "atape.js"), 'console.log("unmanaged")')
    if (kind === "generation") {
      const externalEntry = join(external, "node_modules", "@atape", "cli", "dist", "atape.js")
      await mkdir(dirname(externalEntry), { recursive: true })
      await writeFile(externalEntry, 'console.log("unmanaged")')
      const generationRoot = join(client.home, "releases", selected.version)
      await rm(generationRoot, { recursive: true })
      await symlink(external, generationRoot)
    } else {
      const packageRoot = dirname(dirname(runtimeEntry(client.home, selected.version)))
      await rm(packageRoot, { recursive: true })
      await symlink(external, packageRoot)
    }
    await expect(resolveRuntimeEntry(client.home, client.bootstrap)).rejects.toThrow()
  })

  it("allows ATAPE_HOME itself to be a symlink while preserving release containment", async () => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    await selectRuntime(client.home, selected)
    const alias = `${client.home}-alias`
    temporaryDirectories.push(alias)
    await symlink(client.home, alias)
    expect(await resolveRuntimeEntry(alias, client.bootstrap)).toBe(runtimeEntry(client.home, selected.version))
  })

  it.each(["replace", "remove"] as const)("invalidates a managed selection when manual npm maintenance would %s bootstrap", async action => {
    const client = await fixture()
    const selected = await client.generation("1.2.2")
    const bootstrapIdentity = createHash("sha256").update(await readFile(client.bootstrap)).digest("hex")
    const bound = { ...selected, bootstrapIdentity }
    await selectRuntime(client.home, bound)
    expect(await readRuntimeSelection(client.home)).toEqual(bound)
    expect((await client.effective()).adapters[0]).toEqual(selected.adapters[0]!.after)
    if (action === "replace") await writeFile(client.bootstrap, 'console.log("same-version reinstall with different bytes")')
    else await rm(client.bootstrap)
    expect(await readRuntimeSelection(client.home)).toBeUndefined()
    expect((await client.effective()).adapters[0]).toEqual(client.original)
    expect(JSON.parse(await readFile(runtimeSelectionFile(client.home), "utf8"))).toEqual(bound)
    expect(await client.persisted()).toEqual(client.raw)
  })
})

describe("independent update selection through the runtime and configuration Interfaces", () => {
  const activate = async (home: string, next: UpdateRuntimeSelection) => {
    const control = createUpdateControl(home)
    const ticket = await control.prepare({ next })
    await control.begin(ticket)
    await control.complete(ticket)
  }

  it("keeps the legacy bridge while advancing the complete effective CLI and Adapter generation", async () => {
    const client = await fixture()
    const bridge = await client.generation("1.2.2")
    await selectRuntime(client.home, bridge)
    const anchor = await readFile(runtimeSelectionFile(client.home), "utf8")
    for (const version of ["1.2.3", "1.2.4"]) {
      const selected = await client.controlGeneration(version)
      await activate(client.home, selected)
      expect(await readEffectiveRuntimeSelection(client.home)).toEqual(selected)
      expect(await readRuntimeSelection(client.home)).toEqual(bridge)
      expect(await readFile(runtimeSelectionFile(client.home), "utf8")).toBe(anchor)
      expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(runtimeEntry(client.home, version))
      expect(await selectedBootstrap(client.home, runtimeEntry(client.home, version))).toBe(client.bootstrap)
      expect((await client.run(inspectClient())).adapters).toEqual([selected.adapters[0]!.after, client.custom])
      await client.run(setAutomaticUpdates(false))
      expect(await client.persisted()).toEqual({ ...client.raw, autoUpdateEnabled: false })
    }
    // A historical writer can alter its own pointer, but cannot replace control.
    await selectRuntime(client.home, bridge)
    expect((await readEffectiveRuntimeSelection(client.home))!.version).toBe("1.2.4")
    await preserveSelectedInstallations(client.paths)
    expect((await client.persisted()).adapters).toEqual((await client.effective()).adapters)
  })

  it("treats the independent capture contract as opaque and checks the actual package declaration", async () => {
    const client = await fixture()
    const selected = await client.controlGeneration("2.0.0", "atape.client.future-capture.v3")
    await activate(client.home, selected)
    expect(await readEffectiveRuntimeSelection(client.home)).toEqual(selected)
    expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(runtimeEntry(client.home, "2.0.0"))
  })

  it("retains the historical v2 bridge decoder after an independent capture contract advances", async () => {
    const client = await fixture()
    const bridge = await client.generation("1.2.2")
    await selectRuntime(client.home, bridge)
    const anchor = await readFile(runtimeSelectionFile(client.home))
    const config = await readFile(client.paths.configFile)
    const next = await client.controlGeneration("2.0.0", "atape.client.future-capture.v3")
    const control = createUpdateControl(client.home)
    const ticket = await control.prepare({ next, previous: {
      protocol: updateControlProtocol, captureStateContract: legacyBridgeCaptureContract,
      version: bridge.version, bootstrapEntry: bridge.bootstrapEntry,
      bootstrapIdentity: next.bootstrapIdentity, adapters: bridge.adapters
    } })
    await control.begin(ticket)
    await control.fence(ticket)
    await control.complete(ticket)

    expect(await readRuntimeSelection(client.home)).toEqual({ ...bridge, stateContract: "atape.client.v3-capture.v2" })
    expect(await readEffectiveRuntimeSelection(client.home)).toEqual(next)
    expect(await resolveLegacyRuntimeEntry(client.home, client.bootstrap)).toBe(runtimeEntry(client.home, bridge.version))
    expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(runtimeEntry(client.home, next.version))
    expect(await readFile(runtimeSelectionFile(client.home))).toEqual(anchor)
    expect(await readFile(client.paths.configFile)).toEqual(config)
  })

  it("keeps independent selection authoritative when a historical writer leaves pending recovery", async () => {
    const client = await fixture()
    const bridge = await client.generation("1.2.2")
    const selected = await client.controlGeneration("1.2.3")
    await selectRuntime(client.home, bridge)
    await activate(client.home, selected)
    const pending = join(client.home, "updates", "pending.json")
    await writeFile(pending, "{}")
    expect(await readEffectiveRuntimeSelection(client.home)).toEqual(selected)
    expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(runtimeEntry(client.home, selected.version))
    expect((await client.effective()).adapters[0]).toEqual(selected.adapters[0]!.after)
    await rm(pending)
    expect(await readEffectiveRuntimeSelection(client.home)).toEqual(selected)
    expect((await client.effective()).adapters[0]).toEqual(selected.adapters[0]!.after)
  })

  it("lets the first historical transaction reach its bridge before independent control exists", async () => {
    const client = await fixture()
    const bridge = await client.generation("1.2.2")
    await selectRuntime(client.home, bridge)
    await mkdir(join(client.home, "updates"), { recursive: true })
    await writeFile(join(client.home, "updates", "pending.json"), "{}")
    expect(await readEffectiveRuntimeSelection(client.home)).toEqual(bridge)
    expect(await resolveRuntimeEntry(client.home, client.bootstrap)).toBe(runtimeEntry(client.home, bridge.version))
    expect((await client.effective()).adapters[0]).toEqual(bridge.adapters[0]!.after)
  })

  it.each(["invalid json", { protocol: "unknown" }, { version: "../../outside" }, { bootstrapIdentity: "invalid" },
    { captureStateContract: "" }, { adapters: [] }])("fails closed for invalid independent metadata: %j", async change => {
    const client = await fixture()
    const bridge = await client.generation("1.2.2")
    const selected = await client.controlGeneration("1.2.3")
    await selectRuntime(client.home, bridge)
    await activate(client.home, selected)
    const invalid = typeof change === "string" ? change : JSON.stringify({ ...selected, ...change,
      ...("adapters" in change ? { adapters: [selected.adapters[0], selected.adapters[0]] } : {}) })
    await writeFile(join(client.home, "updates", "runtime.json"), invalid)
    await writeFile(join(client.home, "updates", "pending.json"), "{}")
    await expect(readEffectiveRuntimeSelection(client.home)).rejects.toThrow()
    await expect(client.effective()).rejects.toMatchObject({ reason: "decode" })
    expect(await client.persisted()).toEqual(client.raw)
  })

  it.each(["capability", "contract", "version", "name"] as const)("refuses an independent package whose %s no longer matches", async changed => {
    const client = await fixture()
    const selected = await client.controlGeneration("1.2.3")
    await activate(client.home, selected)
    const manifest = { name: changed === "name" ? "@other/cli" : "@atape/cli", version: changed === "version" ? "1.2.4" : selected.version,
      atapeRuntime: { stateContract: changed === "contract" ? "atape.other.v2" : selected.captureStateContract,
        ...(changed === "capability" ? {} : { updateControlProtocol }) } }
    await writeFile(join(dirname(dirname(runtimeEntry(client.home, selected.version))), "package.json"), JSON.stringify(manifest))
    await expect(resolveRuntimeEntry(client.home, client.bootstrap)).rejects.toThrow()
    await expect(client.effective()).rejects.toMatchObject({ reason: "decode" })
  })

  it("refuses an escaping control executable instead of falling back to the legacy bridge", async () => {
    const client = await fixture()
    await selectRuntime(client.home, await client.generation("1.2.2"))
    const selected = await client.controlGeneration("1.2.3")
    await activate(client.home, selected)
    const entry = runtimeEntry(client.home, selected.version)
    await rm(entry)
    await symlink(client.bootstrap, entry)
    await expect(resolveRuntimeEntry(client.home, client.bootstrap)).rejects.toThrow()
    await expect(client.effective()).rejects.toMatchObject({ reason: "decode" })
  })

  it.each(["replace", "remove"] as const)("fails closed when manual npm maintenance would %s the control bootstrap", async changed => {
    const client = await fixture()
    await selectRuntime(client.home, await client.generation("1.2.2"))
    const selected = await client.controlGeneration("1.2.3")
    await activate(client.home, selected)
    if (changed === "replace") await writeFile(client.bootstrap, "manually installed CLI")
    else await rm(client.bootstrap)
    await expect(readEffectiveRuntimeSelection(client.home)).rejects.toThrow()
    await expect(resolveRuntimeEntry(client.home, client.bootstrap)).rejects.toThrow()
    expect(await createUpdateControl(client.home).readSelection()).toEqual(selected)
    expect(await client.persisted()).toEqual(client.raw)
  })

  it("resolves the durable bootstrap binding for pending recovery without requiring the broken candidate", async () => {
    const client = await fixture()
    const bridge = await client.generation("1.2.2")
    await selectRuntime(client.home, bridge)
    const next = await client.controlGeneration("1.2.3")
    const control = createUpdateControl(client.home)
    const ticket = await control.prepare({ next })
    await control.begin(ticket)
    await rm(runtimeEntry(client.home, next.version))
    expect(await selectedBootstrap(client.home, "/workers/copied-update.mjs")).toBe(client.bootstrap)
    await expect(resolveRuntimeEntry(client.home, client.bootstrap)).rejects.toThrow()
    expect(await control.recoveryPending()).toBe(true)
  })
})
