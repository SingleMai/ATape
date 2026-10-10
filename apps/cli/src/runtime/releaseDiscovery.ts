import { ReleaseCatalog, decodeReleaseBundle, decodeReleaseCatalog, releaseBundleFingerprint, releaseBundleFromBody,
  releasePackageNames, selectReleaseBundle, updateCatalogTag, MigrationReleaseCatalog, decodeMigrationReleaseBundle,
  decodeMigrationReleaseCatalog, managedReleaseBundleFingerprint, migrationReleaseBundleFromBody,
  migrationReleaseCatalogTag, selectMigrationReleaseBundle, type ManagedReleaseBundle,
  type MigrationReleaseBundle, type ReleaseBundle } from "@atape/domain"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, open, rm } from "node:fs/promises"
import { join } from "node:path"
import { acquireProcessLock } from "./processLock.ts"
import { atomicJSON, missing, readBoundedJSON } from "./runtimeFiles.ts"

const github = "https://api.github.com/repos/SingleMai/ATape/releases/tags/"
const registry = "https://registry.npmjs.org/"
const metadataLimit = 256 * 1024
const artifactLimit = 16 * 1024 * 1024
const cacheLifetime = 12 * 60 * 60 * 1_000
const GithubRelease = Schema.Struct({ tag_name: Schema.String, body: Schema.String,
  prerelease: Schema.Boolean, draft: Schema.Boolean, published_at: Schema.String })
const CachedCatalog = Schema.Struct({ checkedAt: Schema.Number, catalog: ReleaseCatalog })
const CachedMigrationCatalog = Schema.Struct({ checkedAt: Schema.Number, catalog: MigrationReleaseCatalog })
const MigrationAdoption = Schema.Struct({ protocol: Schema.Literal("atape.update-catalog.v2") })
const NpmPackage = Schema.Struct({ name: Schema.String, version: Schema.String,
  dist: Schema.Struct({ integrity: Schema.String, tarball: Schema.String }),
  atapeRuntime: Schema.optionalKey(Schema.Struct({ protocol: Schema.String, stateContract: Schema.String,
    updateControlProtocol: Schema.optionalKey(Schema.String) })) })

export class ReleaseDiscoveryError extends Error {
  readonly reason: "transport" | "metadata" | "state" | "integrity"
  constructor(reason: ReleaseDiscoveryError["reason"], message: string) { super(message); this.reason = reason }
}
class MissingRelease extends ReleaseDiscoveryError {
  constructor() { super("transport", "The versioned GitHub Release is not publicly available.") }
}
const stableVersion = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
  value.length < 40 && value.split(".").every(part => Number.isSafeInteger(Number(part)))
const compare = (left: string, right: string) => {
  const a = left.split(".").map(Number), b = right.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  return 0
}
const family = (bundle: Pick<ReleaseBundle, "captureStateContract" | "updateControlProtocol">) =>
  JSON.stringify([bundle.captureStateContract, bundle.updateControlProtocol])
const canonicalCatalog = (catalog: typeof ReleaseCatalog.Type) => JSON.stringify({ ...catalog,
  bundles: [...catalog.bundles].sort((a, b) => family(a).localeCompare(family(b))).map(releaseBundleFingerprint) })
const migrationRouteKey = (route: MigrationReleaseCatalog["routes"][number]) => JSON.stringify([
  route.fromCaptureStateContract, route.updateControlProtocol, route.migrationProtocol, route.migrationId])
const canonicalMigrationCatalog = (catalog: MigrationReleaseCatalog) => JSON.stringify({ ...catalog,
  bundles: [...catalog.bundles].sort((a, b) => compare(a.version, b.version)).map(managedReleaseBundleFingerprint),
  routes: [...catalog.routes].sort((a, b) => migrationRouteKey(a).localeCompare(migrationRouteKey(b))) })

const abortable = <A>(pending: Promise<A>, signal: AbortSignal): Promise<A> => {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason) }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => { cleanup(); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    pending.then(value => { cleanup(); resolve(value) }, cause => { cleanup(); reject(cause) })
  })
}

// The deadline covers headers and the complete body, including uncooperative
// test transports. A rejected stream cannot keep cancellation cleanup alive.
const stream = async <A>(url: string, signal: AbortSignal, fetchMetadata: typeof fetch, limit: number,
  timeoutMs: number, consume: (chunk: Uint8Array) => Promise<void>, finish: () => Promise<A>): Promise<A> => {
  signal.throwIfAborted()
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(
    new ReleaseDiscoveryError("transport", "Release request timed out.")), timeoutMs)
  timer.unref()
  const requestSignal = AbortSignal.any([signal, timeout.signal])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    let response: Response
    try {
      response = await abortable(fetchMetadata(url, { signal: requestSignal, redirect: "error",
        headers: { accept: limit === metadataLimit ? "application/json" : "application/octet-stream", "user-agent": "ATape release discovery" } }), requestSignal)
    } catch (cause) {
      requestSignal.throwIfAborted()
      throw new ReleaseDiscoveryError("transport", "Release transport is unavailable.")
    }
    reader = response.body?.getReader()
    if (response.status === 404) throw new MissingRelease()
    if (!response.ok) throw new ReleaseDiscoveryError("transport", `Release request returned HTTP ${response.status}.`)
    if (!reader) throw new ReleaseDiscoveryError("metadata", "Release response has no body.")
    const length = response.headers.get("content-length")
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
      throw new ReleaseDiscoveryError("metadata", "Release response exceeds its size limit.")
    }
    let bytes = 0
    while (true) {
      let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>
      try { chunk = await abortable(reader.read(), requestSignal) }
      catch {
        requestSignal.throwIfAborted()
        throw new ReleaseDiscoveryError("transport", "Release body transport is unavailable.")
      }
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) throw new ReleaseDiscoveryError("metadata", "Release response exceeds its size limit.")
      await consume(chunk.value)
      requestSignal.throwIfAborted()
    }
    if (bytes === 0) throw new ReleaseDiscoveryError("metadata", "Release response is empty.")
    requestSignal.throwIfAborted()
    return await finish()
  } finally {
    clearTimeout(timer)
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}

const metadata = async (url: string, signal: AbortSignal, fetchMetadata: typeof fetch): Promise<unknown> => {
  const chunks: Uint8Array[] = []
  return stream(url, signal, fetchMetadata, metadataLimit, 10_000, async chunk => { chunks.push(chunk) }, async () => {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown }
    catch { throw new ReleaseDiscoveryError("metadata", "Release response is not valid JSON.") }
  })
}

export type ReleaseDiscoveryOptions = {
  readonly home: string
  readonly captureStateContract: string
  readonly runtimeVersion: string
  readonly updateControlProtocol: string
  readonly supportedMigrationPlans?: ReadonlyArray<{ readonly protocol: string; readonly id: string }>
  readonly fetchMetadata?: typeof fetch
}
export type AcquiredReleaseArtifact = { readonly path: string; readonly release: () => Promise<void> }
export type ReleaseDiscovery = {
  readonly latest: (input: { readonly cached: boolean; readonly signal: AbortSignal }) => Promise<ManagedReleaseBundle>
  readonly exact: (input: { readonly version: string; readonly signal: AbortSignal }) => Promise<ManagedReleaseBundle>
  readonly acquireArtifact: (bundle: ManagedReleaseBundle, name: string, signal: AbortSignal) => Promise<AcquiredReleaseArtifact>
}

// Promise operations are the Node Adapter boundary. Effect callers own this
// Module's lifetime and keep each acquired archive through npm termination.
export const createReleaseDiscovery = (options: ReleaseDiscoveryOptions): ReleaseDiscovery => {
  const fetchMetadata = options.fetchMetadata ?? globalThis.fetch
  const directory = join(options.home, "cache", "release-discovery")
  const migrationDirectory = join(options.home, "cache", "release-discovery-v2")
  const cacheFile = join(directory, "catalog.json")
  const migrationCacheFile = join(migrationDirectory, "catalog.json")
  const adoptionFile = join(migrationDirectory, "adopted.json")
  const receiptFile = (version: string, migration = false) => join(migration ? migrationDirectory : directory, "bundles", `${version}.json`)
  const compatible = (value: ManagedReleaseBundle): ManagedReleaseBundle => {
    const bundle = value.protocol === "atape.release-bundle.v2" ? decodeMigrationReleaseBundle(value) : decodeReleaseBundle(value)
    const captureCompatible = bundle.protocol === "atape.release-bundle.v2" ?
      options.supportedMigrationPlans !== undefined && bundle.migration.fromCaptureStateContracts.includes(options.captureStateContract) &&
      options.supportedMigrationPlans.some(plan => plan.protocol === bundle.migration.protocol && plan.id === bundle.migration.id) :
      bundle.captureStateContract === options.captureStateContract
    if (!captureCompatible || bundle.updateControlProtocol !== options.updateControlProtocol) {
      throw new ReleaseDiscoveryError("metadata", "The release does not support this capture/control pair.")
    }
    return bundle
  }
  const optional = async <A>(file: string, decode: (value: unknown) => A): Promise<A | undefined> => {
    try { return decode(await readBoundedJSON(file)) }
    catch (cause) {
      if (missing(cause)) return undefined
      throw new ReleaseDiscoveryError("state", "Saved release discovery state is invalid.")
    }
  }
  const cachedCatalog = async () => optional(cacheFile, value => {
    const cached = Schema.decodeUnknownSync(CachedCatalog, { onExcessProperty: "error" })(value)
    if (!Number.isFinite(cached.checkedAt) || cached.checkedAt < 0 || cached.checkedAt > Date.now()) throw new Error("Invalid catalog timestamp")
    return cached
  })
  const cachedMigrationCatalog = async () => optional(migrationCacheFile, value => {
    const cached = Schema.decodeUnknownSync(CachedMigrationCatalog, { onExcessProperty: "error" })(value)
    if (!Number.isFinite(cached.checkedAt) || cached.checkedAt < 0 || cached.checkedAt > Date.now()) throw new Error("Invalid catalog timestamp")
    return cached
  })
  const adoptedMigration = async () => {
    const [marker, catalog] = await Promise.all([optional(adoptionFile, value =>
      Schema.decodeUnknownSync(MigrationAdoption, { onExcessProperty: "error" })(value)), cachedMigrationCatalog()])
    return marker !== undefined || catalog !== undefined
  }
  const receipt = (version: string, migration = false) => optional(receiptFile(version, migration), value => {
    const bundle = migration ? decodeMigrationReleaseBundle(value) : decodeReleaseBundle(value)
    if (bundle.version !== version) throw new Error("Mismatched bundle receipt")
    return bundle
  })
  const locked = async <A>(signal: AbortSignal, run: () => Promise<A>): Promise<A> => {
    signal.throwIfAborted()
    const release = await acquireProcessLock(join(directory, "ownership.sqlite"), 5_000)
    if (!release) throw new ReleaseDiscoveryError("state", "Release discovery state is busy.")
    try { signal.throwIfAborted(); return await run() } finally { release() }
  }
  const remember = async (bundle: ManagedReleaseBundle) => {
    const migration = bundle.protocol === "atape.release-bundle.v2"
    const saved = await receipt(bundle.version, migration)
    if (saved && managedReleaseBundleFingerprint(saved) !== managedReleaseBundleFingerprint(bundle)) {
      throw new ReleaseDiscoveryError("integrity", "A known release version changed its immutable bundle.")
    }
    const other = await receipt(bundle.version, !migration)
    const baseFingerprint = (value: ManagedReleaseBundle) => releaseBundleFingerprint({ protocol: "atape.release-bundle.v1",
      version: value.version, captureStateContract: value.captureStateContract, updateControlProtocol: value.updateControlProtocol,
      packages: value.packages })
    if (other && baseFingerprint(other) !== baseFingerprint(bundle)) {
      throw new ReleaseDiscoveryError("integrity", "A known release version changed its immutable package bytes across catalog protocols.")
    }
    if (migration) await atomicJSON(adoptionFile, { protocol: "atape.update-catalog.v2" })
    if (!saved) await atomicJSON(receiptFile(bundle.version, migration), bundle)
    return bundle
  }
  const versionRelease = async (version: string, signal: AbortSignal) => {
    const release = Schema.decodeUnknownSync(GithubRelease)(await metadata(`${github}v${version}`, signal, fetchMetadata))
    if (release.tag_name !== `v${version}` || release.prerelease || release.draft || !published(release.published_at)) {
      throw new ReleaseDiscoveryError("metadata", "The versioned Release is not a published stable release.")
    }
    const bundle = (options.supportedMigrationPlans === undefined ? undefined : migrationReleaseBundleFromBody(release.body)) ?? releaseBundleFromBody(release.body)
    if (bundle && bundle.version !== version) throw new ReleaseDiscoveryError("metadata", "The Release descriptor has a different version.")
    return bundle
  }
  const deriveRunningBundle = async (version: string, signal: AbortSignal) => {
    const packages = []
    for (const name of releasePackageNames) {
      const value = Schema.decodeUnknownSync(NpmPackage)(await metadata(`${registry}${name.replace("/", "%2f")}/${version}`, signal, fetchMetadata))
      if (value.name !== name || value.version !== version) throw new ReleaseDiscoveryError("metadata", "An exact npm package has a different identity.")
      if (name === "@atape/cli" && (value.atapeRuntime?.protocol !== "atape.runtime.v1" ||
        value.atapeRuntime.stateContract !== options.captureStateContract || value.atapeRuntime.updateControlProtocol !== options.updateControlProtocol)) {
        throw new ReleaseDiscoveryError("metadata", "The running-version npm package has incompatible runtime capabilities.")
      }
      packages.push({ name, integrity: value.dist.integrity, tarball: value.dist.tarball })
    }
    return decodeReleaseBundle({ protocol: "atape.release-bundle.v1", version, captureStateContract: options.captureStateContract,
      updateControlProtocol: options.updateControlProtocol, packages })
  }

  const latestLegacy = async ({ cached, signal }: { readonly cached: boolean; readonly signal: AbortSignal }): Promise<ManagedReleaseBundle> => {
      signal.throwIfAborted()
      const saved = await cachedCatalog()
      if (cached && saved && Date.now() - saved.checkedAt < cacheLifetime) {
        return compatible(selectReleaseBundle(saved.catalog, options))
      }
      let catalog: typeof ReleaseCatalog.Type
      try {
        const release = Schema.decodeUnknownSync(GithubRelease)(await metadata(`${github}${updateCatalogTag}`, signal, fetchMetadata))
        if (release.tag_name !== updateCatalogTag || !release.prerelease || release.draft || !published(release.published_at)) {
          throw new ReleaseDiscoveryError("metadata", "The fixed catalog Release is not a published prerelease.")
        }
        catalog = decodeReleaseCatalog(JSON.parse(release.body))
      } catch (cause) {
        if (!signal.aborted && cached && saved && cause instanceof ReleaseDiscoveryError && cause.reason === "transport") {
          return compatible(selectReleaseBundle(saved.catalog, options))
        }
        throw cause
      }
      const selected = compatible(selectReleaseBundle(catalog, options))
      return locked(signal, async () => {
        const previous = await cachedCatalog()
        if (previous) {
          if (catalog.revision < previous.catalog.revision || catalog.revision === previous.catalog.revision &&
            canonicalCatalog(catalog) !== canonicalCatalog(previous.catalog)) throw new ReleaseDiscoveryError("integrity", "The release catalog regressed or rewrote its revision.")
          for (const before of previous.catalog.bundles) {
            const after = catalog.bundles.find(item => family(item) === family(before))
            if (!after || compare(after.version, before.version) < 0 || after.version === before.version &&
              releaseBundleFingerprint(after) !== releaseBundleFingerprint(before)) throw new ReleaseDiscoveryError("integrity", "The release catalog removed or rewrote a known family target.")
          }
        }
        for (const bundle of catalog.bundles) await remember(bundle)
        await atomicJSON(cacheFile, { checkedAt: Date.now(), catalog })
        return selected
      })
    }
  const latestMigration = async ({ cached, signal }: { readonly cached: boolean; readonly signal: AbortSignal }): Promise<ManagedReleaseBundle> => {
    signal.throwIfAborted()
    const saved = await cachedMigrationCatalog(), adopted = await adoptedMigration()
    if (cached && saved && Date.now() - saved.checkedAt < cacheLifetime) {
      return compatible(selectMigrationReleaseBundle(saved.catalog, { ...options, supportedMigrationPlans: options.supportedMigrationPlans! }))
    }
    let catalog: MigrationReleaseCatalog
    try {
      const release = Schema.decodeUnknownSync(GithubRelease)(await metadata(`${github}${migrationReleaseCatalogTag}`, signal, fetchMetadata))
      if (release.tag_name !== migrationReleaseCatalogTag || !release.prerelease || release.draft || !published(release.published_at)) {
        throw new ReleaseDiscoveryError("metadata", "The fixed migration catalog Release is not a published prerelease.")
      }
      catalog = decodeMigrationReleaseCatalog(JSON.parse(release.body))
    } catch (cause) {
      if (signal.aborted) throw cause
      if (!adopted && cause instanceof MissingRelease) {
        const fallback = await latestLegacy({ cached, signal })
        return locked(signal, async () => {
          if (await adoptedMigration()) throw new ReleaseDiscoveryError("integrity", "The migration catalog was adopted while a legacy fallback was in flight.")
          return fallback
        })
      }
      if (cached && saved && cause instanceof ReleaseDiscoveryError && cause.reason === "transport") {
        return compatible(selectMigrationReleaseBundle(saved.catalog, { ...options, supportedMigrationPlans: options.supportedMigrationPlans! }))
      }
      throw cause
    }
    const selected = compatible(selectMigrationReleaseBundle(catalog, { ...options, supportedMigrationPlans: options.supportedMigrationPlans! }))
    return locked(signal, async () => {
      const previous = await cachedMigrationCatalog()
      if (previous) {
        if (catalog.revision < previous.catalog.revision || catalog.revision === previous.catalog.revision &&
          canonicalMigrationCatalog(catalog) !== canonicalMigrationCatalog(previous.catalog)) {
          throw new ReleaseDiscoveryError("integrity", "The migration catalog regressed or rewrote its revision.")
        }
        for (const before of previous.catalog.routes) {
          const after = catalog.routes.find(item => migrationRouteKey(item) === migrationRouteKey(before))
          if (!after || compare(after.version, before.version) < 0) {
            throw new ReleaseDiscoveryError("integrity", "The migration catalog removed or regressed a known route.")
          }
        }
      }
      // Receipts include every advertised target, including routes this runtime
      // does not know. A later compatible runtime must see the same bytes.
      await atomicJSON(adoptionFile, { protocol: "atape.update-catalog.v2" })
      for (const bundle of catalog.bundles) await remember(bundle)
      await atomicJSON(migrationCacheFile, { checkedAt: Date.now(), catalog })
      return selected
    })
  }

  const discovery: ReleaseDiscovery = {
    latest: input => options.supportedMigrationPlans === undefined ? latestLegacy(input) : latestMigration(input),
    exact: async ({ version, signal }: { readonly version: string; readonly signal: AbortSignal }): Promise<ManagedReleaseBundle> => {
      signal.throwIfAborted()
      if (!stableVersion(version)) throw new ReleaseDiscoveryError("metadata", "An exact release requires a stable version.")
      if (options.supportedMigrationPlans !== undefined) await adoptedMigration()
      const migrationSaved = options.supportedMigrationPlans === undefined ? undefined : await receipt(version, true)
      const saved = migrationSaved ?? await receipt(version)
      if (version !== options.runtimeVersion && !saved) {
        const advertised = await discovery.latest({ cached: false, signal })
        if (advertised.version !== version) throw new ReleaseDiscoveryError("metadata", "The requested version is not an advertised compatible release.")
      }
      let bundle: ManagedReleaseBundle | undefined
      try { bundle = await versionRelease(version, signal) }
      catch (cause) {
        if (signal.aborted) throw cause
        if (!(cause instanceof MissingRelease)) {
          if (saved && cause instanceof ReleaseDiscoveryError && cause.reason === "transport") return compatible(saved)
          throw cause
        }
      }
      if (!bundle) {
        if (migrationSaved) throw new ReleaseDiscoveryError("metadata", "A known migration release no longer has its immutable public descriptor.")
        if (version !== options.runtimeVersion) {
          throw new ReleaseDiscoveryError("metadata", "The requested release has no immutable public descriptor.")
        }
        bundle = await deriveRunningBundle(version, signal)
      }
      const selected = compatible(bundle)
      if (selected.protocol === "atape.release-bundle.v2" && version !== options.runtimeVersion && !await receipt(version, true)) {
        const advertised = await discovery.latest({ cached: false, signal })
        if (advertised.protocol !== "atape.release-bundle.v2" || managedReleaseBundleFingerprint(advertised) !== managedReleaseBundleFingerprint(selected)) {
          throw new ReleaseDiscoveryError("metadata", "The requested migration version is not an advertised compatible release.")
        }
      }
      return locked(signal, async () => {
        if (options.supportedMigrationPlans !== undefined && selected.protocol !== "atape.release-bundle.v2" && await receipt(version, true)) {
          throw new ReleaseDiscoveryError("integrity", "A known migration release changed its immutable descriptor protocol.")
        }
        return remember(selected)
      })
    },
    acquireArtifact: async (value: ManagedReleaseBundle, name: string, signal: AbortSignal): Promise<AcquiredReleaseArtifact> => {
      signal.throwIfAborted()
      const bundle = compatible(value), package_ = bundle.packages.find(item => item.name === name)
      if (!package_) throw new ReleaseDiscoveryError("metadata", "The package is not part of this official release.")
      await locked(signal, async () => {
        if (bundle.protocol === "atape.release-bundle.v2") await adoptedMigration()
        const saved = await receipt(bundle.version, bundle.protocol === "atape.release-bundle.v2")
        if (!saved || managedReleaseBundleFingerprint(saved) !== managedReleaseBundleFingerprint(bundle)) {
          throw new ReleaseDiscoveryError("integrity", "Artifact acquisition requires a previously discovered immutable bundle.")
        }
      })
      const artifacts = join(bundle.protocol === "atape.release-bundle.v2" ? migrationDirectory : directory, "artifacts")
      await mkdir(artifacts, { recursive: true, mode: 0o700 })
      const staging = await mkdtemp(join(artifacts, ".lease-")), path = join(staging, "package.tgz")
      const release = () => rm(staging, { recursive: true, force: true })
      try {
        const file = await open(path, "wx", 0o600), hash = createHash("sha512")
        try {
          await stream(package_.tarball, signal, fetchMetadata, artifactLimit, 30_000, async chunk => {
            hash.update(chunk); await file.writeFile(chunk)
          }, async () => {
            if (`sha512-${hash.digest("base64")}` !== package_.integrity) throw new ReleaseDiscoveryError("integrity", "The downloaded artifact does not match the immutable release bundle.")
            await file.sync()
          })
        } finally { await file.close() }
        signal.throwIfAborted()
        return { path, release }
      } catch (cause) { await release().catch(() => {}); throw cause }
    }
  }
  return discovery
}

const published = (value: string) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now()
