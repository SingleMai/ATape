import { ClientConfigStore, ClientConfigStoreError, officialSources, type ClientConfigChange } from "@atape/application"
import { AdapterInstallation, ClientConfig as ClientConfigSchema, type ClientConfig } from "@atape/domain"
import { createHash } from "node:crypto"
import { lstat, open, readFile, realpath, rm } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { makeConfigStoreLayer, withClientConfigFileLock } from "./clientConfig.ts"
import type { NodeClientPaths } from "./clientPaths.ts"
import { atomicJSON, missing, readBoundedJSON, runtimeSelectionFile } from "./runtimeFiles.ts"
import { createUpdateControl, type UpdateRuntimeSelection } from "./updateControl.ts"

export { atomicJSON, missing, readBoundedJSON, runtimeEntry, runtimeSelectionFile, updateDirectory } from "./runtimeFiles.ts"

// The legacy bridge remains a genuine v2 generation. Independent update control
// carries its capture contract separately and never relabels this bridge.
export const managedStateContract = "atape.client.v3-capture.v2"
const StableVersion = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/))
export const RuntimeSelection = Schema.Struct({
  protocol: Schema.Literal("atape.runtime.v1"),
  stateContract: Schema.Literal(managedStateContract),
  version: StableVersion,
  bootstrapEntry: Schema.String,
  bootstrapIdentity: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  adapters: Schema.Array(Schema.Struct({ before: AdapterInstallation, after: AdapterInstallation }))
})
export type RuntimeSelection = typeof RuntimeSelection.Type
const LegacyRuntimeSelection = Schema.Struct({ ...RuntimeSelection.fields, stateContract: Schema.Literal("atape.client.v3-capture.v1") })
const validateSelection = <A extends Omit<RuntimeSelection, "stateContract"> & { readonly stateContract: string }>(selected: A): A => {
  if (selected.version.length >= 40 || !selected.version.split(".").every(part => Number.isSafeInteger(Number(part))) || !isAbsolute(selected.bootstrapEntry)) {
    throw new Error("Invalid managed runtime identity.")
  }
  const ids = new Set<string>()
  for (const { before, after } of selected.adapters) {
    if (ids.has(after.adapterId) || !officialSources.some(source => source.id === after.adapterId && source.packageName === after.packageName) ||
      before.adapterId !== after.adapterId || before.packageName !== after.packageName || before.upgradeSpec !== before.packageName ||
      after.upgradeSpec !== after.packageName || after.version !== selected.version || after.packageSlot === undefined || before.installedAt !== after.installedAt) {
      throw new Error("Invalid managed Adapter generation.")
    }
    ids.add(after.adapterId)
  }
  return selected
}
export const decodeRuntimeSelection = (value: unknown): RuntimeSelection =>
  validateSelection(Schema.decodeUnknownSync(RuntimeSelection)(value))

// Only the explicit manual transition and read-only public launcher may decode
// this historical shape. Runtime resolution still requires the current contract.
export const decodeLegacyRuntimeSelection = (value: unknown) =>
  validateSelection(Schema.decodeUnknownSync(LegacyRuntimeSelection)(value))

export const readRuntimeSelection = async (home: string): Promise<RuntimeSelection | undefined> => {
  try {
    const selected = decodeRuntimeSelection(await readBoundedJSON(runtimeSelectionFile(home)))
    if (selected.bootstrapIdentity !== undefined) {
      const identity = createHash("sha256").update(await readFile(selected.bootstrapEntry)).digest("hex")
      if (identity !== selected.bootstrapIdentity) return undefined
    }
    return selected
  }
  catch (cause) { if (missing(cause)) return undefined; throw cause }
}

export type EffectiveRuntimeSelection = RuntimeSelection | UpdateRuntimeSelection

// Legacy writers retain current.json as their bridge. Once independent control
// exists, historical writers cannot replace its authority through their pointer
// or pending journal. Actual capture waits for transaction recovery separately.
export const readEffectiveRuntimeSelection = async (home: string): Promise<EffectiveRuntimeSelection | undefined> => {
  const control = createUpdateControl(home)
  const selected = await control.readSelection()
  if (selected) {
    await control.resolveSelectionEntry(selected, true)
    return selected
  }
  return readRuntimeSelection(home)
}

export const selectRuntime = async (home: string, selection: RuntimeSelection | undefined) => {
  if (selection) await atomicJSON(runtimeSelectionFile(home), decodeRuntimeSelection(selection))
  else {
    await rm(runtimeSelectionFile(home), { force: true })
    const directory = await open(join(home, "releases"), "r")
    try { await directory.sync() } finally { await directory.close() }
  }
}

export const resolveRuntimeEntry = async (home: string, bootstrap: string): Promise<string> => {
  const selected = await readEffectiveRuntimeSelection(home)
  if (!selected) return bootstrap
  if (selected.protocol === "atape.update-control.v1") return createUpdateControl(home).resolveSelectionEntry(selected, true)
  return resolveLegacySelectionEntry(home, selected)
}

// An admitted recovery coordinator may enter through a historical bootstrap's
// genuine bridge while the independent candidate is broken. This resolver
// selects no independent target and grants no permission to capture.
export const resolveLegacyRuntimeEntry = async (home: string, bootstrap: string): Promise<string> => {
  const selected = await readRuntimeSelection(home)
  return selected ? resolveLegacySelectionEntry(home, selected) : bootstrap
}

const resolveLegacySelectionEntry = async (home: string, selected: RuntimeSelection): Promise<string> => {
  const canonicalHome = await realpath(home)
  const releases = join(canonicalHome, "releases")
  if (await realpath(releases) !== releases) throw new Error("Managed CLI releases must remain inside ATAPE_HOME.")
  const generation = join(releases, selected.version)
  const info = await lstat(generation)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The selected CLI generation must be a real directory.")
  const root = await realpath(generation)
  if (root !== generation) throw new Error("The selected CLI generation is outside its managed release directory.")
  let path = root
  let entry = root
  for (const component of ["node_modules", "@atape", "cli", "dist", "atape.js"]) {
    path = join(path, component)
    entry = await realpath(path)
    const within = relative(root, entry)
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new Error("The selected CLI entry is outside its managed release.")
    }
  }
  if (!(await lstat(entry)).isFile()) throw new Error("The selected CLI entry must be a regular file.")
  return entry
}

const sameAdapter = (left: AdapterInstallation, right: AdapterInstallation) =>
  left.adapterId === right.adapterId && left.packageName === right.packageName && left.packageSlot === right.packageSlot &&
  left.upgradeSpec === right.upgradeSpec && left.displayName === right.displayName && left.version === right.version &&
  left.installedAt === right.installedAt && left.updatedAt === right.updatedAt

// The pointer selects package metadata, not user settings. A deliberate local
// package/source replacement invalidates the corresponding overlay immediately.
export const applyRuntimeSelection = (config: ClientConfig, selected?: Pick<RuntimeSelection, "adapters">): ClientConfig => selected === undefined ? config : ({
  ...config,
  adapters: config.adapters.map(adapter => {
    const replacement = selected.adapters.find(item => sameAdapter(item.before, adapter))
    return replacement?.after ?? adapter
  })
})

const configIO = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run,
  catch: () => new ClientConfigStoreError({ reason: "decode", message: "The selected ATape runtime is invalid. Inspect local update state before resuming." }) })

export const readSelectedClientConfig = (paths: NodeClientPaths) => ClientConfigStore.use(store =>
  store.transact(config => Effect.succeed({ value: config }))
).pipe(Effect.provide(makeSelectedConfigStoreLayer(paths)))

// A manual npm replacement invalidates bootstrap ownership. Preserve the actual
// selected installations first so that operation cannot revive raw older slots.
export const preserveSelectedInstallations = (paths: NodeClientPaths): Promise<void> =>
  withClientConfigFileLock(paths.configFile, async () => {
    let raw: ClientConfig
    try { raw = Schema.decodeUnknownSync(ClientConfigSchema)(JSON.parse(await readFile(paths.configFile, "utf8")) as unknown) }
    catch (cause) { if (missing(cause)) return; throw cause }
    const effective = applyRuntimeSelection(raw, await readEffectiveRuntimeSelection(paths.atapeHome))
    if (effective.adapters.some((adapter, index) => !sameAdapter(adapter, raw.adapters[index]!))) {
      await atomicJSON(paths.configFile, { ...raw, adapters: effective.adapters })
    }
  })

export const makeSelectedConfigStoreLayer = (paths: NodeClientPaths) => Layer.effect(ClientConfigStore,
  Effect.gen(function*() {
    const store = yield* ClientConfigStore
    return ClientConfigStore.of({
      transact: <A, E, R>(change: (config: ClientConfig) => Effect.Effect<ClientConfigChange<A>, E, R>) => store.transact(raw =>
        configIO(() => readEffectiveRuntimeSelection(paths.atapeHome)).pipe(Effect.flatMap(selected => {
          const effective = applyRuntimeSelection(raw, selected)
          return change(effective).pipe(Effect.map(result => result.config === undefined ? result : ({ ...result,
            config: { ...result.config, adapters: result.config.adapters.map(adapter => {
              const original = effective.adapters.find(item => sameAdapter(item, adapter))
              return original === undefined ? adapter : raw.adapters.find(item => item.adapterId === original.adapterId) ?? adapter
            }) }
          })))
        })))
    })
  }).pipe(Effect.provide(makeConfigStoreLayer(paths.configFile))))

export const selectedBootstrap = async (home: string, entry: string) => {
  const control = createUpdateControl(home)
  // Recovery needs bootstrap ownership before it can repair an unavailable
  // target. Decode its binding without requiring that target to be executable.
  if (await control.recoveryPending()) return (await control.readSelection())?.bootstrapEntry ??
    (await readRuntimeSelection(home))?.bootstrapEntry ?? resolve(entry)
  return (await readEffectiveRuntimeSelection(home))?.bootstrapEntry ?? resolve(entry)
}
