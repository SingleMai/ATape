import type { AdapterInstallation } from "@atape/domain"
import { AdapterPackageError, ClientConfigStore, type AdapterPruneSlot } from "@atape/application"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Effect, Schema } from "effect"

// Legacy records remain readable; only an explicit install selects a new slot.
export const adapterPackageRoot = (directory: string, adapter: Pick<AdapterInstallation, "packageName" | "packageSlot">) =>
  join(directory, ...(adapter.packageSlot === undefined ? [] : ["slots", adapter.packageSlot]),
    "node_modules", ...adapter.packageName.split("/"))

const metadataFile = ".atape-installation.json"
const leaseDirectory = ".atape-leases"
// Keep admission closure outside the tree being removed. Recursive deletion
// must never erase the marker while package files can still be imported.
const retirementPath = (root: string) => join(dirname(dirname(root)), "retired-slots", basename(root))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const Metadata = Schema.Struct({
  protocol: Schema.Literal("atape.adapter-slot.v1"),
  packageSlot: Schema.String,
  packageName: Schema.String,
  version: Schema.String,
  createdAt: Schema.Number
})
type Metadata = typeof Metadata.Type
const decodeMetadata = Schema.decodeUnknownSync(Metadata)
const io = <A>(packageSpec: string, run: () => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: cause => new AdapterPackageError({ reason: "io", packageSpec, message: `Adapter installation: ${cause instanceof Error ? cause.message : String(cause)}` })
})
const absent = (cause: unknown) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
const exists = async (path: string) => lstat(path).then(() => true, cause => { if (absent(cause)) return false; throw cause })
const realDirectory = async (path: string) => (await lstat(path)).isDirectory()

// Create the lease before publishing tracking metadata. An unselected prepared
// installation is protected until the caller's configuration transaction ends.
export const prepareAdapterSlot = (directory: string, packageSpec: string) => Effect.acquireRelease(
  io(packageSpec, async () => {
    const packageSlot = randomUUID(), root = join(directory, "slots", packageSlot)
    await mkdir(join(root, leaseDirectory), { recursive: true, mode: 0o700 })
    try {
      const release = await acquireLease(root)
      return { root, packageSlot, release, retained: false }
    } catch (cause) { await rm(root, { recursive: true, force: true }); throw cause }
  }),
  slot => Effect.promise(async () => {
    if (!slot.retained) await rm(slot.root, { recursive: true, force: true })
    else await slot.release()
  })
)

export const trackAdapterSlot = (root: string, metadata: Omit<Metadata, "protocol" | "createdAt">) =>
  writeFile(join(root, metadataFile), JSON.stringify({ ...metadata, protocol: "atape.adapter-slot.v1", createdAt: Date.now() }), { flag: "wx", mode: 0o600 })

export const leaseAdapterInstallation = (directory: string, adapter: Pick<AdapterInstallation, "packageName" | "packageSlot">) =>
  Effect.acquireRelease(io(adapter.packageName, async () => {
    if (adapter.packageSlot === undefined) return async () => {}
    const root = join(directory, "slots", adapter.packageSlot)
    const metadata = await readMetadata(root, adapter.packageSlot)
    if (metadata === undefined) return async () => {} // Pre-protocol slots are never pruned.
    if (metadata.packageName !== adapter.packageName) throw new Error("Slot metadata does not match its configured package.")
    return acquireLease(root)
  }), release => Effect.promise(release))

const acquireLease = async (root: string) => {
  if (!await realDirectory(root) || !await realDirectory(join(root, leaseDirectory))) throw new Error("Slot lease directory is invalid.")
  const lease = join(root, leaseDirectory, `${process.pid}-${randomUUID()}`)
  // Non-recursive mkdir must not resurrect a slot deleted by another process.
  await mkdir(lease, { mode: 0o700 })
  const release = async () => { await rm(lease, { recursive: true, force: true }) }
  try {
    if (await exists(retirementPath(root))) throw new Error("This Adapter installation was retired. Retry with the current configured version.")
    return release
  } catch (cause) { await release(); throw cause }
}

const readMetadata = async (root: string, slot: string): Promise<Metadata | undefined> => {
  if (!uuid.test(slot) || !await realDirectory(root)) throw new Error("Invalid installation slot.")
  const path = join(root, metadataFile)
  if (!await exists(path)) return undefined
  const file = await lstat(path)
  if (!file.isFile() || file.size > 16_384) throw new Error("Invalid slot metadata file.")
  const metadata = decodeMetadata(JSON.parse(await readFile(path, "utf8")))
  if (metadata.packageSlot !== slot || !Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0 ||
    !/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(metadata.packageName)) throw new Error("Invalid slot metadata.")
  return metadata
}

const inUse = async (root: string) => {
  if (!await realDirectory(join(root, leaseDirectory))) return true
  for (const entry of await readdir(join(root, leaseDirectory))) {
    const match = /^([1-9][0-9]*)-([0-9a-f-]+)$/.exec(entry)
    if (!match || !uuid.test(match[2]!)) return true
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) return true
    try { process.kill(pid, 0); return true } catch (cause) {
      if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH")) return true
    }
  }
  return false
}

// Permanent retirement plus a second lease check closes concurrent admission.
// Never remove the marker: a later invocation resumes interrupted deletion.
export const pruneAdapterSlots = (directory: string, input: { readonly apply: boolean; readonly keep: number }) => Effect.gen(function*() {
  const store = yield* ClientConfigStore
  const slotsDirectory = join(directory, "slots")
  const entries = yield* io("slots", async () => {
    const names = await readdir(slotsDirectory).catch(cause => { if (absent(cause)) return []; throw cause })
    const entries: Array<{ slot: string; metadata?: Metadata }> = []
    for (const slot of names.sort()) {
      // Unknown metadata, symlinks and incomplete installs are not deletion authority.
      const metadata = await readMetadata(join(slotsDirectory, slot), slot).catch(() => undefined)
      entries.push({ slot, ...(metadata === undefined ? {} : { metadata }) })
    }
    return entries.sort((a, b) => (b.metadata?.createdAt ?? 0) - (a.metadata?.createdAt ?? 0) || a.slot.localeCompare(b.slot))
  })
  const selected = yield* store.transact(config => io("slots", async () => {
    const current = new Set(config.adapters.flatMap(adapter => adapter.packageSlot === undefined ? [] : [adapter.packageSlot]))
    const retained = new Map<string, number>()
    const slots: Array<AdapterPruneSlot> = [], deletions: Array<string> = []
    let more = false
    for (const { slot, metadata } of entries) {
      try {
        const root = join(slotsDirectory, slot)
        let state: AdapterPruneSlot["state"]
        if (current.has(slot)) state = "current"
        else if (metadata === undefined) state = "unmanaged"
        else if (!await exists(root)) continue // Another sweep finished it.
        else if (await inUse(root)) state = "in_use"
        else {
          const retired = await exists(retirementPath(root))
          const count = retained.get(metadata.packageName) ?? 0
          if (!retired && count < input.keep) { retained.set(metadata.packageName, count + 1); state = "retained" }
          else {
            state = "eligible"
            if (deletions.length >= 32) more = true
            else if (input.apply) {
              // Revalidate before granting deletion authority; imports never mutate metadata.
              const verified = await readMetadata(root, slot)
              if (!verified) continue // Another sweep removed the metadata.
              if (verified.packageName !== metadata.packageName) throw new Error("Slot metadata changed during maintenance.")
              await mkdir(dirname(retirementPath(root)), { recursive: true, mode: 0o700 })
              await mkdir(retirementPath(root), { mode: 0o700 }).catch(cause => {
                if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) throw cause
              })
              if (await inUse(root)) state = "in_use"
              else deletions.push(slot)
            } else deletions.push(slot)
          }
        }
        slots.push({ slot, state, ...(metadata === undefined ? {} : { packageName: metadata.packageName, version: metadata.version }) })
      } catch (cause) {
        // Another sweep may remove the retired tree after releasing its lock.
        if (!absent(cause)) throw cause
      }
    }
    return { value: { slots, deletions, more } }
  }))
  let removed = 0
  if (input.apply) for (const slot of selected.deletions) {
    yield* io(slot, () => rm(join(slotsDirectory, slot), { recursive: true, force: true }))
    removed++
  }
  const deleted = new Set(input.apply ? selected.deletions : [])
  return { applied: input.apply, removed, more: selected.more,
    slots: selected.slots.map(slot => deleted.has(slot.slot) ? { ...slot, state: "removed" as const } : slot) }
})
