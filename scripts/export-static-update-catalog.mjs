import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { decodeReleaseCatalog, decodeMigrationReleaseCatalog, decodeReleaseBundle, decodeMigrationReleaseBundle,
  releaseBundleFingerprint, migrationReleaseBundleFingerprint, releaseBundleFromBody, migrationReleaseBundleFromBody,
  releaseBundleProtocol, migrationReleaseBundleProtocol, updateCatalogProtocol, migrationReleaseCatalogProtocol,
  releaseMetadataBaseURL, releaseCatalogURL, releaseBundleURL, decodeTargetReleaseBundle, decodeTargetReleaseCatalog,
  targetReleaseBundleFingerprint, targetReleaseBundleFromBody, targetReleaseBundleProtocol, targetReleaseCatalogProtocol } from "../packages/domain/src/releaseCatalog.ts"
import { createGitHubPublication, compareReleaseVersions, readPublicationTargets } from "./publish-update-catalog.mjs"
import { createPublicReleaseRegistry } from "./public-release-visibility.mjs"

const indexProtocol = "atape.static-release-index.v2"
const metadataLimit = 256 * 1024
const artifactLimit = 16 * 1024 * 1024
const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const bundleBytes = bundle => Buffer.from(`${bundle.protocol === releaseBundleProtocol
  ? releaseBundleFingerprint(bundle) : bundle.protocol === migrationReleaseBundleProtocol ? migrationReleaseBundleFingerprint(bundle) : targetReleaseBundleFingerprint(bundle)}\n`)
const pathOf = url => new URL(url).pathname.slice(1)
const catalogPath = protocol => pathOf(releaseCatalogURL(protocol))
const bundlePath = (version, protocol) => pathOf(releaseBundleURL(version, protocol))
const v1Path = catalogPath(updateCatalogProtocol)
const v2Path = catalogPath(migrationReleaseCatalogProtocol)
const v3Path = catalogPath(targetReleaseCatalogProtocol)
const ownKeys = (value, required, optional = []) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key))
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const stableVersion = value => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
  value.length < 40 && value.split(".").every(part => Number.isSafeInteger(Number(part)))

function decodeIndex(value) {
  if (!ownKeys(value, ["protocol", "catalogs", "bundles"]) || ![indexProtocol, "atape.static-release-index.v1"].includes(value.protocol) ||
    !ownKeys(value.catalogs, ["v1"], value.protocol === indexProtocol ? ["v2", "v3"] : ["v2"]) || !validDigest(value.catalogs.v1) ||
    (Object.hasOwn(value.catalogs, "v2") && !validDigest(value.catalogs.v2)) ||
    (Object.hasOwn(value.catalogs, "v3") && !validDigest(value.catalogs.v3)) ||
    !Array.isArray(value.bundles) || value.bundles.length > 1_024 ||
    value.bundles.some(item => !ownKeys(item, value.protocol === indexProtocol ? ["version"] : ["version", "v1"],
      value.protocol === indexProtocol ? ["v1", "v2", "v3"] : ["v2"]) || !stableVersion(item.version) ||
      !["v1", "v2", "v3"].some(key => Object.hasOwn(item, key)) ||
      ["v1", "v2", "v3"].some(key => Object.hasOwn(item, key) && !validDigest(item[key])) || item.v2 && !item.v1) ||
    new Set(value.bundles.map(item => item.version)).size !== value.bundles.length) {
    throw new Error("Static release index is malformed or exceeds its bounded history.")
  }
  return value
}

async function boundedBytes(response, limit) {
  const length = response.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel()
    throw new Error("Static publication response exceeds its byte limit.")
  }
  const chunks = []
  let size = 0
  if (response.body) {
    const reader = response.body.getReader()
    try {
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.length
        if (size > limit) throw new Error("Static publication response exceeds its byte limit.")
        chunks.push(item.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
  }
  return Buffer.concat(chunks, size)
}

// This anonymous HTTPS Adapter is shared by publication preflight and public
// confirmation. Only an actual 404 means missing; transport failures never do.
export function createStaticUpdateSite({ fetch: transport = globalThis.fetch } = {}) {
  return {
    async read(path, signal) {
      if (path !== "manifest.json" && path !== v1Path && path !== v2Path && path !== v3Path &&
        !/^releases\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/bundle\.v[123]\.json$/.test(path)) {
        throw new Error("Unexpected static publication path.")
      }
      signal?.throwIfAborted()
      const response = await transport(`${releaseMetadataBaseURL}/${path}`, { redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { accept: "application/json", "cache-control": "no-cache" } })
      if (response.status === 404) { await response.body?.cancel(); return undefined }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Static publication GET ${path} failed with HTTP ${response.status}.`) }
      return boundedBytes(response, path === "manifest.json" ? 1024 * 1024 : metadataLimit)
    }
  }
}

function abortable(pending, signal) {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason) }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => { cleanup(); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    pending.then(value => { cleanup(); resolve(value) }, cause => { cleanup(); reject(cause) })
  })
}

function waitForRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort) }
    const abort = () => { cleanup(); reject(signal.reason) }
    const timer = setTimeout(() => { cleanup(); resolve() }, milliseconds)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

function legacyOf(bundle) {
  return decodeReleaseBundle({ protocol: releaseBundleProtocol, version: bundle.version,
    captureStateContract: bundle.captureStateContract, updateControlProtocol: bundle.updateControlProtocol, packages: bundle.packages })
}

async function readPrevious(site, bootstrap) {
  const bytes = await site.read("manifest.json")
  if (!bytes) {
    if (!bootstrap) throw new Error("Static release index is missing; first publication requires explicit --bootstrap.")
    const [legacy, migration, target] = await Promise.all([site.read(v1Path), site.read(v2Path), site.read(v3Path)])
    if (legacy || migration || target) throw new Error("A missing static index cannot replace an existing catalog.")
    return { files: new Map(), index: undefined, catalog: undefined, migrationCatalog: undefined, targetCatalog: undefined }
  }
  const index = decodeIndex(JSON.parse(bytes.toString("utf8"))), files = new Map()
  const read = async (path, expected) => {
    const value = await site.read(path)
    if (!value || digest(value) !== expected) throw new Error(`Static publication ${path} differs from its index.`)
    files.set(path, value)
    return JSON.parse(value.toString("utf8"))
  }
  const catalog = decodeReleaseCatalog(await read(v1Path, index.catalogs.v1))
  const migrationCatalog = index.catalogs.v2 ? decodeMigrationReleaseCatalog(await read(v2Path, index.catalogs.v2)) : undefined
  const targetCatalog = index.catalogs.v3 ? decodeTargetReleaseCatalog(await read(v3Path, index.catalogs.v3)) : undefined
  if (!index.catalogs.v2 && await site.read(v2Path)) throw new Error("An unindexed migration catalog cannot be silently replaced.")
  if (!index.catalogs.v3 && await site.read(v3Path)) throw new Error("An unindexed target catalog cannot be silently replaced.")
  for (const item of index.bundles) {
    const legacy = item.v1 ? decodeReleaseBundle(await read(bundlePath(item.version, releaseBundleProtocol), item.v1)) : undefined
    if (legacy && (legacy.version !== item.version || !files.get(bundlePath(item.version, releaseBundleProtocol)).equals(bundleBytes(legacy))))
      throw new Error("Historical static descriptor is not the canonical immutable version.")
    if (item.v2) {
      const migration = decodeMigrationReleaseBundle(await read(bundlePath(item.version, migrationReleaseBundleProtocol), item.v2))
      if (migration.version !== item.version || !files.get(bundlePath(item.version, migrationReleaseBundleProtocol)).equals(bundleBytes(migration)) ||
        releaseBundleFingerprint(legacy) !== releaseBundleFingerprint(legacyOf(migration))) {
        throw new Error("Historical static migration descriptor differs from its immutable bridge.")
      }
    }
    if (item.v3) {
      const target = decodeTargetReleaseBundle(await read(bundlePath(item.version, targetReleaseBundleProtocol), item.v3))
      if (target.version !== item.version || !files.get(bundlePath(item.version, targetReleaseBundleProtocol)).equals(bundleBytes(target)) ||
        legacy && releaseBundleFingerprint(legacy) !== releaseBundleFingerprint(legacyOf(target)))
        throw new Error("Historical static target descriptor differs from its immutable version.")
    }
  }
  for (const bundle of catalog.bundles) {
    if (!files.get(bundlePath(bundle.version, releaseBundleProtocol))?.equals(bundleBytes(bundle)))
      throw new Error("Existing static catalog is missing its exact immutable descriptor.")
  }
  for (const bundle of migrationCatalog?.bundles ?? []) {
    if (!files.get(bundlePath(bundle.version, migrationReleaseBundleProtocol))?.equals(bundleBytes(bundle)))
      throw new Error("Existing static migration catalog is missing its exact immutable descriptor.")
  }
  for (const bundle of targetCatalog?.bundles ?? []) if (!files.get(bundlePath(bundle.version, targetReleaseBundleProtocol))?.equals(bundleBytes(bundle)))
    throw new Error("Existing static target catalog is missing its exact immutable descriptor.")
  return { files, index, catalog, migrationCatalog, targetCatalog }
}

function assertCatalogAdvance(previous, next, migration = false) {
  if (!previous) return
  if (!next || next.revision < previous.revision) throw new Error("Static catalog revision cannot regress or disappear.")
  const entries = migration ? "routes" : "bundles"
  const key = migration === "target" ? item => JSON.stringify([item.fromCaptureStateContract, item.updateControlProtocol, item.updateTargetProtocol]) :
    migration ? item => JSON.stringify([item.fromCaptureStateContract, item.updateControlProtocol,
    item.migrationProtocol, item.migrationId]) : item => JSON.stringify([item.captureStateContract, item.updateControlProtocol])
  for (const old of previous[entries]) {
    const target = next[entries].find(item => key(item) === key(old))
    if (!target || compareReleaseVersions(target.version, old.version) < 0) throw new Error("Static catalog routes cannot be removed or downgraded.")
  }
  const fingerprint = migration === "target" ? targetReleaseBundleFingerprint : migration ? migrationReleaseBundleFingerprint : releaseBundleFingerprint
  for (const old of previous.bundles) {
    const sameVersion = next.bundles.find(item => item.version === old.version)
    if (sameVersion && fingerprint(sameVersion) !== fingerprint(old)) throw new Error("An immutable static bundle cannot change.")
  }
  if (next.revision === previous.revision && !jsonBytes(next).equals(jsonBytes(previous)))
    throw new Error("Static catalog changed without advancing its revision.")
}

async function publicArtifacts(github, release, bundle) {
  const expected = new Map(bundle.packages.map(item => [`${item.name.replace(/^@/, "").replace("/", "-")}-${bundle.version}.tgz`, item]))
  const assets = release.assets
  if (!Array.isArray(assets) || assets.length !== expected.size + 1 || new Set(assets.map(item => item.name)).size !== assets.length ||
    assets.some(item => !expected.has(item.name) && item.name !== "SHA256SUMS")) throw new Error("Public version Release assets do not match its complete bundle.")
  const files = []
  for (const asset of assets) {
    const limit = asset.name === "SHA256SUMS" ? 8192 : artifactLimit
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > limit) throw new Error("Invalid public version Release asset size.")
    const bytes = await github.download(asset, limit)
    if (!Buffer.isBuffer(bytes) || bytes.length !== asset.size) throw new Error("Public version Release asset bytes are incomplete.")
    const item = expected.get(asset.name)
    if (item && integrity(bytes) !== item.integrity) throw new Error("Public version Release asset integrity differs from its descriptor.")
    files.push({ ...(item ? { name: item.name } : {}), filename: asset.name, bytes, sha256: digest(bytes) })
  }
  const checksums = files.find(item => item.filename === "SHA256SUMS")
  const expectedChecksums = files.filter(item => item.name).sort((a, b) => a.filename < b.filename ? -1 : 1)
    .map(item => `${item.sha256}  ${item.filename}\n`).join("")
  if (checksums.bytes.toString("utf8") !== expectedChecksums) throw new Error("Public version Release SHA256SUMS differs from its complete bundle.")
  return { bundle, files }
}

const headers = `/catalog/*\n  Cache-Control: no-cache, must-revalidate\n  Content-Type: application/json; charset=utf-8\n\n/manifest.json\n  Cache-Control: no-cache, must-revalidate\n  Content-Type: application/json; charset=utf-8\n\n/releases/*\n  Cache-Control: public, max-age=31536000, immutable\n  Content-Type: application/json; charset=utf-8\n\n/*\n  X-Content-Type-Options: nosniff\n`

// One publication Interface owns the complete static snapshot. It never writes
// GitHub/npm and creates its output only after all advertised bytes are public.
// Cloudflare uploads this directory as one atomic asset deployment; serialized
// workflow writers and these monotonic checks prevent stale reruns from rollback.
export async function exportStaticUpdateCatalog({ github, staticSite, registry, outputDirectory, bootstrap = false }) {
  const previous = await readPrevious(staticSite, bootstrap)
  const { catalog, migrationCatalog, targetCatalog } = await readPublicationTargets(github)
  if (!catalog) throw new Error("A complete public legacy catalog is required for static distribution.")
  assertCatalogAdvance(previous.catalog, catalog)
  assertCatalogAdvance(previous.migrationCatalog, migrationCatalog, true)
  assertCatalogAdvance(previous.targetCatalog, targetCatalog, "target")
  const catalogBytes = jsonBytes(catalog), migrationCatalogBytes = migrationCatalog ? jsonBytes(migrationCatalog) : undefined
  const targetCatalogBytes = targetCatalog ? jsonBytes(targetCatalog) : undefined
  if (catalogBytes.length > metadataLimit || migrationCatalogBytes?.length > metadataLimit || targetCatalogBytes?.length > metadataLimit)
    throw new Error("Static output metadata exceeds its reader byte limit.")
  const files = new Map(previous.files), versions = new Map()
  for (const bundle of catalog.bundles) versions.set(bundle.version, { legacy: bundle })
  for (const bundle of migrationCatalog?.bundles ?? []) {
    const entry = versions.get(bundle.version) ?? { legacy: legacyOf(bundle) }
    if (releaseBundleFingerprint(entry.legacy) !== releaseBundleFingerprint(legacyOf(bundle)))
      throw new Error("Public catalogs disagree on the same version's bundle.")
    versions.set(bundle.version, { ...entry, migration: bundle })
  }
  for (const bundle of targetCatalog?.bundles ?? []) {
    const entry = versions.get(bundle.version) ?? {}
    if (entry.legacy && releaseBundleFingerprint(entry.legacy) !== releaseBundleFingerprint(legacyOf(bundle)))
      throw new Error("Public target catalog disagrees on the same version's package bytes.")
    versions.set(bundle.version, { ...entry, target: bundle })
  }
  const verifiedBundles = []
  for (const [version, expected] of [...versions].sort(([a], [b]) => compareReleaseVersions(a, b))) {
    const release = await github.readRelease(`v${version}`)
    if (!release || release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false ||
      typeof release.body !== "string" || Buffer.byteLength(JSON.stringify(release.body)) > 128 * 1024)
      throw new Error("Static distribution requires an exact complete public stable version Release.")
    const legacy = releaseBundleFromBody(release.body), migration = migrationReleaseBundleFromBody(release.body), target = targetReleaseBundleFromBody(release.body)
    if (expected.legacy && (!legacy || releaseBundleFingerprint(legacy) !== releaseBundleFingerprint(expected.legacy)) ||
      expected.migration && (!migration || migrationReleaseBundleFingerprint(migration) !== migrationReleaseBundleFingerprint(expected.migration)) ||
      expected.target && (!target || targetReleaseBundleFingerprint(target) !== targetReleaseBundleFingerprint(expected.target)) ||
      expected.target && !expected.legacy && (legacy || migration))
      throw new Error("Public catalog and immutable version descriptors disagree.")
    const bundle = target ?? migration ?? legacy
    const artifacts = await publicArtifacts(github, release, bundle)
    await registry.verify(artifacts)
    for (const descriptor of [legacy, migration, target].filter(Boolean)) {
      const path = bundlePath(version, descriptor.protocol), bytes = bundleBytes(descriptor), existing = files.get(path)
      if (existing && !existing.equals(bytes)) throw new Error("An immutable static version descriptor cannot be replaced.")
      files.set(path, bytes)
    }
    // Once added, even an unreferenced migration descriptor remains immutable.
    if (!migration && files.has(bundlePath(version, migrationReleaseBundleProtocol)))
      throw new Error("An existing immutable migration descriptor disappeared from its version Release.")
    if (!target && files.has(bundlePath(version, targetReleaseBundleProtocol)))
      throw new Error("An existing immutable target descriptor disappeared from its version Release.")
    verifiedBundles.push({ version, packages: bundle.packages.length })
  }
  files.set(v1Path, catalogBytes)
  if (migrationCatalog) files.set(v2Path, migrationCatalogBytes)
  if (targetCatalog) files.set(v3Path, targetCatalogBytes)
  const history = new Map()
  for (const [path, bytes] of files) {
    const match = /^releases\/([^/]+)\/bundle\.(v[123])\.json$/.exec(path)
    if (match) {
      const item = history.get(match[1]) ?? { version: match[1] }
      item[match[2]] = digest(bytes); history.set(match[1], item)
    }
  }
  const index = decodeIndex({ protocol: indexProtocol, catalogs: { v1: digest(files.get(v1Path)),
    ...(migrationCatalog ? { v2: digest(files.get(v2Path)) } : {}), ...(targetCatalog ? { v3: digest(files.get(v3Path)) } : {}) },
  bundles: [...history.values()].sort((a, b) => compareReleaseVersions(a.version, b.version)) })
  files.set("manifest.json", jsonBytes(index))
  for (const [path, bytes] of files) {
    if (bytes.length > (path === "manifest.json" ? 1024 * 1024 : metadataLimit))
      throw new Error("Static output metadata exceeds its reader byte limit.")
  }
  const destination = resolve(outputDirectory)
  try { await lstat(destination); throw new Error("Static output directory must not already exist.") }
  catch (cause) { if (cause.code !== "ENOENT") throw cause }
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(join(dirname(destination), ".atape-update-site-"))
  try {
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(staging, path)), { recursive: true })
      await writeFile(join(staging, path), bytes, { flag: "wx", mode: 0o644 })
    }
    await writeFile(join(staging, "_headers"), headers, { flag: "wx", mode: 0o644 })
    await rename(staging, destination)
  } finally { await rm(staging, { recursive: true, force: true }) }
  return { protocol: "atape.static-publication.v1", baseURL: releaseMetadataBaseURL,
    catalogRevision: catalog.revision, ...(migrationCatalog ? { migrationCatalogRevision: migrationCatalog.revision } : {}),
    ...(targetCatalog ? { targetCatalogRevision: targetCatalog.revision } : {}),
    verifiedBundles, files: [...files].sort(([a], [b]) => a < b ? -1 : 1)
      .map(([path, bytes]) => ({ path, sha256: digest(bytes), bytes: bytes.length })) }
}

export async function verifyStaticUpdateCatalog({ staticSite, publication, now = Date.now,
  sleep = waitForRetry, budgetMs = 120_000 }) {
  if (publication?.protocol !== "atape.static-publication.v1" || publication.baseURL !== releaseMetadataBaseURL ||
    !Array.isArray(publication.files) || publication.files.length < 3 || publication.files.length > 3_076 ||
    new Set(publication.files.map(item => item.path)).size !== publication.files.length ||
    !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 120_000) throw new Error("Invalid static publication confirmation input.")
  for (const item of publication.files) {
    if (!validDigest(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 1) throw new Error("Invalid static publication confirmation identity.")
  }
  const deadline = now() + budgetMs
  const cancellation = new AbortController()
  const timer = setTimeout(() => cancellation.abort(new Error("Public static confirmation deadline expired.")), budgetMs)
  let attempt = 0
  try {
    for (;;) {
      try {
        for (const item of publication.files) {
          if (now() >= deadline) throw new Error("Public static confirmation deadline expired.")
          // The same deadline reaches native fetch headers and body, while the
          // caller boundary also stops an uncooperative transport Adapter.
          const bytes = await abortable(Promise.resolve().then(() => staticSite.read(item.path, cancellation.signal)), cancellation.signal)
          if (now() >= deadline) throw new Error("Public static confirmation deadline expired.")
          if (!bytes || bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error(`Public static publication ${item.path} was not confirmed.`)
        }
        if (now() >= deadline) throw new Error("Public static confirmation deadline expired.")
        return { ...publication, publiclyVerifiedAt: new Date(now()).toISOString() }
      } catch (cause) {
        const remaining = deadline - now()
        if (cancellation.signal.aborted || remaining <= 0) throw new Error(`Public static publication was not confirmed within ${budgetMs}ms.`, { cause })
        await abortable(Promise.resolve().then(() => sleep(Math.min(remaining, 1_000 * Math.min(10, 2 ** attempt++)), cancellation.signal)), cancellation.signal)
      }
    }
  } finally { clearTimeout(timer); cancellation.abort() }
}

async function main() {
  const arguments_ = process.argv.slice(2)
  if (arguments_[0] === "--verify" && arguments_.length === 2) {
    const path = resolve(arguments_[1]), publication = JSON.parse(await readFile(path, "utf8"))
    const result = await verifyStaticUpdateCatalog({ staticSite: createStaticUpdateSite(), publication })
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`Public static catalog revision ${result.catalogRevision} and ${result.files.length} exact metadata files verified.\n`)
    return
  }
  const bootstrap = arguments_.includes("--bootstrap")
  const position = arguments_.indexOf("--output")
  if (position < 0 || !arguments_[position + 1] || arguments_.length !== (bootstrap ? 3 : 2) ||
    arguments_.some((item, index) => index !== position && index !== position + 1 && item !== "--bootstrap"))
    throw new Error("Use --output <new-directory> [--bootstrap], or --verify <publication.json>.")
  const result = await exportStaticUpdateCatalog({ github: createGitHubPublication({ token: process.env.GH_TOKEN }),
    staticSite: createStaticUpdateSite(), registry: createPublicReleaseRegistry(), outputDirectory: arguments_[position + 1], bootstrap })
  await writeFile(join(dirname(resolve(arguments_[position + 1])), "static-publication.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" })
  process.stdout.write(`Prepared static catalog revision ${result.catalogRevision} with ${result.files.length} verified metadata files.\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
