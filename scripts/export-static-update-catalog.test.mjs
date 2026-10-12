import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { releaseBundleProtocol, migrationReleaseBundleProtocol, releasePackageNames, releaseBundleSection,
  migrationReleaseBundleSection, mergeReleaseBundle, mergeMigrationReleaseBundle, updateCatalogTag,
  migrationReleaseCatalogTag, releaseMetadataBaseURL, targetReleaseBundleProtocol, targetReleaseBundleSection,
  mergeTargetReleaseBundle, targetReleaseCatalogTag, updateTargetProtocol } from "../packages/domain/src/releaseCatalog.ts"
import { createPublicReleaseRegistry } from "./public-release-visibility.mjs"
import { createStaticUpdateSite, exportStaticUpdateCatalog, verifyStaticUpdateCatalog } from "./export-static-update-catalog.mjs"

const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const capture = "atape.client.v3-capture.v2", legacyCapture = "atape.client.v3-capture.v1"
function artifacts(version = "0.5.7", { historical = false, sources = [legacyCapture, capture] } = {}) {
  const files = releasePackageNames.filter(name => !historical || name !== "@atape/adapter-cursor").map(name => {
    const bytes = Buffer.from(`${name}@${version}`)
    return { name, filename: `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`, bytes,
      sha256: digest(bytes), integrity: integrity(bytes) }
  })
  const checksums = Buffer.from([...files].sort((a, b) => a.filename < b.filename ? -1 : 1)
    .map(file => `${file.sha256}  ${file.filename}\n`).join(""))
  const legacy = { protocol: releaseBundleProtocol, version, captureStateContract: capture,
    updateControlProtocol: "atape.update-control.v1", packages: files.map(file => ({ name: file.name,
      integrity: file.integrity, tarball: `https://registry.npmjs.org/${file.name}/-/${file.name.slice("@atape/".length)}-${version}.tgz` })) }
  return { legacy, migration: { ...legacy, protocol: migrationReleaseBundleProtocol, migration: {
    protocol: "atape.capture-migration.v1", id: "journal-v7-to-v8", fromCaptureStateContracts: sources } },
  files: [...files, { filename: "SHA256SUMS", bytes: checksums }] }
}
function fixture() {
  const releases = new Map(), assets = new Map(), events = [], verified = []
  let id = 0, catalog, migrationCatalog, targetCatalog, latest
  const seed = local => {
    const version = (local.target ?? local.legacy).version
    if (local.legacy) {
      catalog = mergeReleaseBundle(catalog, local.legacy)
      migrationCatalog = mergeMigrationReleaseBundle(migrationCatalog, local.migration)
      releases.set(updateCatalogTag, { tag_name: updateCatalogTag, draft: false, prerelease: true, body: JSON.stringify(catalog) })
      releases.set(migrationReleaseCatalogTag, { tag_name: migrationReleaseCatalogTag, draft: false, prerelease: true, body: JSON.stringify(migrationCatalog) })
      latest = `v${version}`
    }
    if (local.target) {
      targetCatalog = mergeTargetReleaseBundle(targetCatalog, local.target)
      releases.set(targetReleaseCatalogTag, { tag_name: targetReleaseCatalogTag, draft: false, prerelease: true, body: JSON.stringify(targetCatalog) })
    }
    releases.set(`v${version}`, { tag_name: `v${version}`, draft: false, prerelease: false,
      body: `Release notes.\n${local.legacy ? releaseBundleSection(local.legacy) : ""}\n${local.migration ? migrationReleaseBundleSection(local.migration) : ""}\n${local.target ? targetReleaseBundleSection(local.target) : ""}\n`,
      assets: local.files.map(file => { const asset = { id: ++id, name: file.filename, size: file.bytes.length }; assets.set(asset.id, file.bytes); return asset }) })
  }
  const github = {
    async readRelease(tag) { events.push(`read:${tag}`); return structuredClone(releases.get(tag)) },
    async readLatest() { events.push("latest"); return structuredClone(releases.get(latest)) },
    async download(asset, limit) { events.push(`asset:${asset.name}`); const bytes = assets.get(asset.id); assert.ok(bytes.length <= limit); return Buffer.from(bytes) }
  }
  const registry = { async verify(value) { verified.push(value.bundle.version); assert.equal(value.files.length, value.bundle.packages.length + 1); return {} } }
  return { releases, assets, events, verified, github, registry, seed }
}
const site = files => ({ async read(path) { return files.get(path) && Buffer.from(files.get(path)) } })
async function withDirectory(run) {
  const path = await mkdtemp(join(tmpdir(), "atape-static-catalog-test-"))
  try { return await run(path) } finally { await rm(path, { recursive: true, force: true }) }
}
async function outputSite(directory, publication) {
  return new Map(await Promise.all(publication.files.map(async item => [item.path, await readFile(join(directory, item.path))])))
}
async function absent(path) { await assert.rejects(access(path), { code: "ENOENT" }) }
const input = (remote, directory, files = new Map(), bootstrap = true) => ({ github: remote.github, registry: remote.registry,
  staticSite: site(files), outputDirectory: directory, bootstrap })
function targetArtifacts(version, targetOnly = false) {
  const local = artifacts(version)
  local.target = { ...local.legacy, protocol: targetReleaseBundleProtocol, updateTargetProtocol,
    fromCaptureStateContracts: [legacyCapture, capture] }
  if (targetOnly) { delete local.legacy; delete local.migration }
  return local
}

test("a legacy index migrates to index v2 and target-only versions preserve every legacy route and historical descriptor byte", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts("0.5.10"))
  const oldDirectory = join(root, "old"), old = await exportStaticUpdateCatalog(input(remote, oldDirectory))
  const oldFiles = await outputSite(oldDirectory, old), oldIndex = JSON.parse(oldFiles.get("manifest.json"))
  oldIndex.protocol = "atape.static-release-index.v1"
  oldFiles.set("manifest.json", json(oldIndex))
  remote.seed(targetArtifacts("0.5.11"))
  const bridgeDirectory = join(root, "bridge"), bridge = await exportStaticUpdateCatalog(input(remote, bridgeDirectory, oldFiles, false))
  const bridgeFiles = await outputSite(bridgeDirectory, bridge), bridgeIndex = JSON.parse(bridgeFiles.get("manifest.json"))
  assert.equal(bridgeIndex.protocol, "atape.static-release-index.v2")
  assert.equal(bridgeIndex.catalogs.v3, digest(bridgeFiles.get("catalog/v3.json")))
  assert.ok(bridgeIndex.bundles.find(item => item.version === "0.5.11").v3)
  remote.seed(targetArtifacts("0.5.12", true))
  remote.events.length = 0
  const featureDirectory = join(root, "feature"), feature = await exportStaticUpdateCatalog(input(remote, featureDirectory, bridgeFiles, false))
  const files = await outputSite(featureDirectory, feature), index = JSON.parse(files.get("manifest.json"))
  assert.equal(feature.targetCatalogRevision, 2)
  assert.deepEqual(files.get("catalog/v1.json"), bridgeFiles.get("catalog/v1.json"))
  assert.deepEqual(files.get("catalog/v2.json"), bridgeFiles.get("catalog/v2.json"))
  for (const [path, bytes] of bridgeFiles) if (path.startsWith("releases/")) assert.deepEqual(files.get(path), bytes, path)
  assert.deepEqual(Object.keys(index.bundles.find(item => item.version === "0.5.12")).sort(), ["v3", "version"])
  assert.equal(files.has("releases/0.5.12/bundle.v1.json"), false)
  assert.equal(files.has("releases/0.5.12/bundle.v2.json"), false)
  assert.ok(!remote.events.includes("read:v0.5.10"))
  const catalog = JSON.parse(files.get("catalog/v3.json"))
  assert.ok(catalog.routes.every(route => route.version === "0.5.12"))
  assert.ok((await verifyStaticUpdateCatalog({ staticSite: site(files), publication: feature })).publiclyVerifiedAt)
}))

test("adopted static v3 cannot disappear, lose a route or change immutable target bytes", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(targetArtifacts("0.5.11"))
  const firstDirectory = join(root, "current"), first = await exportStaticUpdateCatalog(input(remote, firstDirectory))
  const original = await outputSite(firstDirectory, first)
  for (const kind of ["catalog-removed", "route-removed", "bundle-changed", "unindexed", "missing-file"]) {
    const next = fixture(); next.seed(targetArtifacts("0.5.11"))
    const files = new Map(original)
    if (kind === "catalog-removed") next.releases.delete(targetReleaseCatalogTag)
    if (kind === "route-removed" || kind === "bundle-changed") {
      const catalog = JSON.parse(next.releases.get(targetReleaseCatalogTag).body)
      if (kind === "route-removed") { catalog.revision++; catalog.routes.shift() }
      else catalog.bundles[0].packages[0].integrity = artifacts("0.5.10").legacy.packages[0].integrity
      next.releases.get(targetReleaseCatalogTag).body = JSON.stringify(catalog)
    }
    if (kind === "unindexed") {
      const index = JSON.parse(files.get("manifest.json")); delete index.catalogs.v3
      files.set("manifest.json", json(index))
    }
    if (kind === "missing-file") files.delete("releases/0.5.11/bundle.v3.json")
    const directory = join(root, kind)
    await assert.rejects(exportStaticUpdateCatalog(input(next, directory, files, false)), /removed|immutable|unindexed|differs|disappear/, kind)
    await absent(directory)
  }
}))

test("caller exports both protocols and canonical immutable descriptors only after all public package bytes verify", async () => withDirectory(async root => {
  const remote = fixture(), local = artifacts(), directory = join(root, "site")
  remote.seed(local)
  const registry = createPublicReleaseRegistry({ fetch: async url => {
    await absent(directory)
    const item = local.legacy.packages.find(item => item.tarball === url)
    if (item) return new Response(local.files.find(file => file.name === item.name).bytes)
    const parsed = new URL(url), name = decodeURIComponent(parsed.pathname.split("/")[1])
    const metadata = local.legacy.packages.find(item => item.name === name)
    assert.ok(metadata)
    return Response.json({ name, version: local.legacy.version, dist: { integrity: metadata.integrity, tarball: metadata.tarball } })
  } })
  const publication = await exportStaticUpdateCatalog({ ...input(remote, directory), registry })
  assert.equal(publication.catalogRevision, 1)
  assert.equal(publication.migrationCatalogRevision, 1)
  assert.deepEqual(publication.verifiedBundles, [{ version: "0.5.7", packages: 8 }])
  assert.deepEqual(publication.files.map(item => item.path), ["catalog/v1.json", "catalog/v2.json", "manifest.json",
    "releases/0.5.7/bundle.v1.json", "releases/0.5.7/bundle.v2.json"])
  const files = await outputSite(directory, publication), index = JSON.parse(files.get("manifest.json"))
  assert.equal(index.catalogs.v1, digest(files.get("catalog/v1.json")))
  assert.equal(index.bundles[0].v2, digest(files.get("releases/0.5.7/bundle.v2.json")))
  assert.ok((await readFile(join(directory, "_headers"), "utf8")).includes("Cache-Control: no-cache, must-revalidate"))
  assert.ok((await readFile(join(directory, "_headers"), "utf8")).includes("max-age=31536000, immutable"))
  assert.ok((await verifyStaticUpdateCatalog({ staticSite: site(files), publication })).publiclyVerifiedAt)
  assert.ok(remote.events.every(event => /^(read:|latest$|asset:)/.test(event)))
}))

test("bootstrap requires explicit opt-in, both catalogs absent, and never converts a transport failure into empty state", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts())
  await assert.rejects(exportStaticUpdateCatalog(input(remote, join(root, "none"), new Map(), false)), /explicit --bootstrap/)
  for (const path of ["catalog/v1.json", "catalog/v2.json"]) {
    await assert.rejects(exportStaticUpdateCatalog(input(remote, join(root, "partial"), new Map([[path, Buffer.from("{}")] ]))), /existing catalog/)
  }
  await assert.rejects(exportStaticUpdateCatalog({ ...input(remote, join(root, "reset")), staticSite: { read: async () => { throw new TypeError("ECONNRESET") } } }), /ECONNRESET/)
  assert.deepEqual(remote.events, [])
  for (const name of ["none", "partial", "reset"]) await absent(join(root, name))
}))

test("public draft, missing assets, corrupted assets and failed npm visibility cannot create or advertise a static directory", async () => withDirectory(async root => {
  for (const kind of ["draft", "missing", "corrupt", "checksums", "npm", "descriptor"]) {
    const remote = fixture(); remote.seed(artifacts())
    const release = remote.releases.get("v0.5.7")
    if (kind === "draft") release.draft = true
    if (kind === "missing") release.assets.pop()
    if (kind === "corrupt") remote.assets.get(release.assets[0].id)[0] ^= 1
    if (kind === "checksums") remote.assets.get(release.assets.at(-1).id)[0] ^= 1
    if (kind === "npm") remote.registry.verify = async () => { throw new Error("public npm byte mismatch") }
    if (kind === "descriptor") release.body = "Human-only notes."
    const path = join(root, kind)
    await assert.rejects(exportStaticUpdateCatalog(input(remote, path)), /unknown release identity|public stable|complete bundle|integrity|SHA256SUMS|npm byte|descriptors disagree/, kind)
    await absent(path)
  }
}))

test("historical seven-package source route is verified and retained alongside the current eight-package target", async () => withDirectory(async root => {
  const remote = fixture()
  remote.seed(artifacts("0.5.4", { historical: true }))
  const firstDirectory = join(root, "old"), first = await exportStaticUpdateCatalog(input(remote, firstDirectory))
  const oldFiles = await outputSite(firstDirectory, first)
  remote.seed(artifacts("0.5.7", { sources: [capture] }))
  const nextDirectory = join(root, "new"), next = await exportStaticUpdateCatalog(input(remote, nextDirectory, oldFiles, false))
  const files = await outputSite(nextDirectory, next), catalog = JSON.parse(files.get("catalog/v2.json"))
  assert.equal(catalog.routes.find(route => route.fromCaptureStateContract === legacyCapture).version, "0.5.4")
  assert.equal(catalog.routes.find(route => route.fromCaptureStateContract === capture).version, "0.5.7")
  assert.deepEqual(next.verifiedBundles, [{ version: "0.5.4", packages: 7 }, { version: "0.5.7", packages: 8 }])
  for (const path of ["releases/0.5.4/bundle.v1.json", "releases/0.5.4/bundle.v2.json"]) assert.deepEqual(files.get(path), oldFiles.get(path))
}))

test("superseded exact descriptors remain byte-identical after all catalog routes advance", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts("0.5.6"))
  const firstDirectory = join(root, "old"), first = await exportStaticUpdateCatalog(input(remote, firstDirectory))
  const oldFiles = await outputSite(firstDirectory, first)
  remote.seed(artifacts("0.5.7"))
  remote.events.length = 0
  const nextDirectory = join(root, "new"), next = await exportStaticUpdateCatalog(input(remote, nextDirectory, oldFiles, false))
  const files = await outputSite(nextDirectory, next)
  assert.ok(!remote.events.includes("read:v0.5.6"))
  assert.ok(JSON.parse(files.get("catalog/v2.json")).bundles.every(bundle => bundle.version === "0.5.7"))
  for (const path of ["releases/0.5.6/bundle.v1.json", "releases/0.5.6/bundle.v2.json"]) assert.deepEqual(files.get(path), oldFiles.get(path))
  assert.equal(JSON.parse(files.get("manifest.json")).bundles.length, 2)
}))

test("older reruns, removed migration routes, changed revisions and immutable conflicts fail without replacing the current site", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts())
  const firstDirectory = join(root, "current"), first = await exportStaticUpdateCatalog(input(remote, firstDirectory))
  const oldFiles = await outputSite(firstDirectory, first)
  for (const kind of ["older", "route-removed", "same-revision", "changed-bundle", "migration-removed"]) {
    const next = fixture(); next.seed(artifacts(kind === "older" ? "0.5.6" : "0.5.7"))
    if (kind === "route-removed") {
      const value = JSON.parse(next.releases.get(migrationReleaseCatalogTag).body)
      value.revision++; value.routes = value.routes.filter(route => route.fromCaptureStateContract !== legacyCapture)
      next.releases.get(migrationReleaseCatalogTag).body = JSON.stringify(value)
    }
    if (kind === "same-revision" || kind === "changed-bundle") {
      const value = JSON.parse(next.releases.get(updateCatalogTag).body)
      if (kind === "same-revision") value.bundles[0].captureStateContract = "other-contract"
      else value.bundles[0].packages[0].integrity = artifacts("0.5.6").legacy.packages[0].integrity
      next.releases.get(updateCatalogTag).body = JSON.stringify(value)
    }
    if (kind === "migration-removed") next.releases.delete(migrationReleaseCatalogTag)
    const path = join(root, kind)
    await assert.rejects(exportStaticUpdateCatalog(input(next, path, oldFiles, false)), /downgraded|removed|revision|immutable|regress/, kind)
    await absent(path)
  }
  assert.deepEqual(await outputSite(firstDirectory, first), oldFiles)
}))

test("corrupt static history, missing exact files and unindexed live v2 metadata are never silently overwritten", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts())
  const firstDirectory = join(root, "current"), first = await exportStaticUpdateCatalog(input(remote, firstDirectory))
  const original = await outputSite(firstDirectory, first)
  for (const kind of ["index", "catalog", "missing", "noncanonical", "unindexed-v2"]) {
    const files = new Map(original), index = JSON.parse(files.get("manifest.json"))
    if (kind === "index") files.set("manifest.json", json({ ...index, unexpected: true }))
    if (kind === "catalog") files.set("catalog/v1.json", Buffer.from("{}"))
    if (kind === "missing") files.delete("releases/0.5.7/bundle.v1.json")
    if (kind === "noncanonical") {
      const path = "releases/0.5.7/bundle.v1.json", bytes = json(JSON.parse(files.get(path)))
      index.bundles[0].v1 = digest(bytes); files.set(path, bytes); files.set("manifest.json", json(index))
    }
    if (kind === "unindexed-v2") { delete index.catalogs.v2; files.set("manifest.json", json(index)) }
    const path = join(root, kind)
    await assert.rejects(exportStaticUpdateCatalog(input(remote, path, files, false)), /malformed|differs|canonical|unindexed/, kind)
    await absent(path)
  }
}))

test("same-byte rerun keeps every exact descriptor and revision and refuses a preexisting local output directory", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts())
  const firstDirectory = join(root, "first"), first = await exportStaticUpdateCatalog(input(remote, firstDirectory))
  const files = await outputSite(firstDirectory, first)
  const nextDirectory = join(root, "next"), next = await exportStaticUpdateCatalog(input(remote, nextDirectory, files, false))
  assert.deepEqual(next, first)
  await writeFile(join(nextDirectory, "owner-sentinel"), "preserve")
  await assert.rejects(exportStaticUpdateCatalog(input(remote, nextDirectory, files, false)), /must not already exist/)
  assert.equal(await readFile(join(nextDirectory, "owner-sentinel"), "utf8"), "preserve")
}))

test("public confirmation checks every advertised file and rejects missing, corrupt or duplicate identities", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts())
  const directory = join(root, "site"), publication = await exportStaticUpdateCatalog(input(remote, directory))
  const original = await outputSite(directory, publication)
  for (const kind of ["missing", "corrupt", "duplicate"]) {
    const files = new Map(original), input_ = structuredClone(publication)
    if (kind === "missing") files.delete("catalog/v2.json")
    if (kind === "corrupt") files.set("releases/0.5.7/bundle.v1.json", Buffer.from("{}"))
    if (kind === "duplicate") input_.files.push(input_.files[0])
    let clock = 0
    await assert.rejects(verifyStaticUpdateCatalog({ staticSite: site(files), publication: input_, budgetMs: 1,
      now: () => clock++ }), /not confirmed|confirmation input/, kind)
  }
}))

test("public deployment confirmation retries stale edges within one budget without changing publication identity", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts())
  const directory = join(root, "site"), publication = await exportStaticUpdateCatalog(input(remote, directory))
  const files = await outputSite(directory, publication)
  let clock = 0, stale = true
  const sleeps = [], result = await verifyStaticUpdateCatalog({ publication, now: () => clock,
    sleep: async milliseconds => { sleeps.push(milliseconds); clock += milliseconds },
    staticSite: { async read(path) { if (stale) { stale = false; return Buffer.from("old deployment") } return files.get(path) } } })
  assert.deepEqual(sleeps, [1_000])
  assert.deepEqual(result.files, publication.files)
  assert.equal(result.publiclyVerifiedAt, new Date(1_000).toISOString())
}))

test("public confirmation bounds the last uncooperative read and rejects a response completing after its deadline", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts())
  const directory = join(root, "site"), publication = await exportStaticUpdateCatalog(input(remote, directory))
  const files = await outputSite(directory, publication), last = publication.files.at(-1).path
  let lastSignal
  const before = performance.now()
  await assert.rejects(verifyStaticUpdateCatalog({ publication, budgetMs: 25, staticSite: { async read(path, signal) {
    if (path === last) { lastSignal = signal; return new Promise(() => {}) }
    return files.get(path)
  } } }), /not confirmed within 25ms/)
  assert.ok(lastSignal.aborted)
  assert.ok(performance.now() - before < 1_000, "The thirty-second per-request timeout must not replace the overall deadline")
  let clock = 0
  await assert.rejects(verifyStaticUpdateCatalog({ publication, budgetMs: 10, now: () => clock, staticSite: { async read(path) {
    if (path === last) clock = 11
    return files.get(path)
  } } }), /not confirmed within 10ms/)
}))

test("anonymous static Adapter restricts canonical paths, rejects redirects/errors and enforces declared and streaming byte limits", async () => {
  const calls = [], bytes = Buffer.from("{}")
  const adapter = createStaticUpdateSite({ fetch: async (url, options) => { calls.push({ url, options }); return new Response(bytes) } })
  assert.deepEqual(await adapter.read("catalog/v1.json"), bytes)
  assert.equal(calls[0].url, `${releaseMetadataBaseURL}/catalog/v1.json`)
  assert.equal(calls[0].options.redirect, "error")
  assert.deepEqual(calls[0].options.headers, { accept: "application/json", "cache-control": "no-cache" })
  assert.deepEqual(await adapter.read("catalog/v3.json"), bytes)
  assert.deepEqual(await adapter.read("releases/0.5.12/bundle.v3.json"), bytes)
  for (const path of ["../secret", "releases/0.5.7/bundle.v4.json", "https://evil.test/manifest.json", "catalog/v1.json?x=1"])
    await assert.rejects(adapter.read(path), /Unexpected/)
  for (const status of [403, 429, 500]) {
    const failed = createStaticUpdateSite({ fetch: async () => new Response("", { status }) })
    await assert.rejects(failed.read("manifest.json"), new RegExp(`HTTP ${status}`))
  }
  assert.equal(await createStaticUpdateSite({ fetch: async () => new Response("", { status: 404 }) }).read("manifest.json"), undefined)
  await assert.rejects(createStaticUpdateSite({ fetch: async () => { throw new TypeError("reset") } }).read("manifest.json"), /reset/)
  await assert.rejects(createStaticUpdateSite({ fetch: async () => new Response("{}", { headers: { "content-length": "262145" } }) }).read("catalog/v1.json"), /byte limit/)
  await assert.rejects(createStaticUpdateSite({ fetch: async () => new Response(Buffer.alloc(262145)) }).read("catalog/v1.json"), /byte limit/)
})

test("static JSON output exceeding the client budget is refused before downloading or creating output", async () => withDirectory(async root => {
  const remote = fixture(); remote.seed(artifacts())
  const bundles = Array.from({ length: 64 }, (_, index) => {
    const original = artifacts(`1.0.${index}`).legacy
    const packages = [...original.packages, ...Array.from({ length: 24 }, (_, extra) => {
      const name = `@atape/${"x".repeat(100)}${extra}`
      return { name, integrity: original.packages[0].integrity,
        tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${original.version}.tgz` }
    })]
    return { ...original, captureStateContract: `contract-${index}`, packages }
  })
  remote.releases.get(updateCatalogTag).body = JSON.stringify({ protocol: "atape.update-catalog.v1", revision: 64, bundles })
  await assert.rejects(exportStaticUpdateCatalog(input(remote, join(root, "large"))), /reader byte limit/)
  assert.ok(remote.events.every(event => !event.startsWith("asset:")))
  await absent(join(root, "large"))
}))
