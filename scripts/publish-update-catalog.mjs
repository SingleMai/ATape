import { createHash } from "node:crypto"
import { decodeReleaseBundle, decodeReleaseCatalog, mergeReleaseBundle, releaseBundleFingerprint,
  releaseBundleFromBody, releaseBundleSection, updateCatalogTag } from "../packages/domain/src/releaseCatalog.ts"
import { publicationCaptureContract, publicationControlProtocol } from "./public-release-visibility.mjs"

const repository = "SingleMai/ATape"
const api = `https://api.github.com/repos/${repository}`
const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export function compareReleaseVersions(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  return 0
}

async function readBytes(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    throw new Error("GitHub publication response exceeds its byte limit.")
  }
  const reader = response.body?.getReader()
  const parts = []
  let length = 0
  if (reader) try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.length
      if (length > limit) throw new Error("GitHub publication response exceeds its byte limit.")
      parts.push(item.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(parts, length)
}

// GitHub is a remote dependency. This transport is shared by preflight and the
// publication workflow; its test Adapter uses the same HTTP Interface.
export function createGitHubPublication({ token, fetch: transport = globalThis.fetch } = {}) {
  if (!token) throw new Error("GitHub publication requires GH_TOKEN.")
  const request = async (path, { method = "GET", body, binary = false, limit = 1024 * 1024 } = {}) => {
    const url = path.startsWith("https://") ? path : `${api}${path}`
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || !["api.github.com", "uploads.github.com"].includes(parsed.hostname) ||
      !parsed.pathname.startsWith(`/repos/${repository}/`)) throw new Error("Unexpected GitHub publication URL.")
    const response = await transport(url, { method, redirect: binary ? "follow" : "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, accept: binary ? "application/octet-stream" : "application/vnd.github+json",
        "x-github-api-version": "2022-11-28", ...(body !== undefined ? { "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" } : {}) },
      ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) })
    if (response.status === 404 && method === "GET") { await response.body?.cancel(); return undefined }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub publication ${method} ${parsed.pathname} failed with HTTP ${response.status}.`) }
    const bytes = await readBytes(response, limit)
    return binary ? bytes : bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined
  }
  return {
    readRelease: tag => request(`/releases/tags/${encodeURIComponent(tag)}`),
    readLatest: () => request("/releases/latest"),
    async verifyVersionTag(tag, commit) {
      let object = (await request(`/git/ref/tags/${encodeURIComponent(tag)}`))?.object
      for (let depth = 0; object?.type === "tag" && depth < 4; depth++) object = (await request(`/git/tags/${object.sha}`))?.object
      if (object?.type !== "commit" || object.sha !== commit) throw new Error("Version tag does not identify the exact verified release commit.")
    },
    create: body => request("/releases", { method: "POST", body }),
    edit: (id, body) => request(`/releases/${id}`, { method: "PATCH", body }),
    download: (asset, limit) => request(`/releases/assets/${asset.id}`, { binary: true, limit }),
    upload: (release, file) => {
      if (typeof release.upload_url !== "string" || !release.upload_url.endsWith("{?name,label}")) throw new Error("Invalid GitHub release upload URL.")
      return request(`${release.upload_url.slice(0, -"{?name,label}".length)}?name=${encodeURIComponent(file.filename)}`,
        { method: "POST", body: file.bytes })
    }
  }
}

const bodyBudget = 128 * 1024
const requireReadableBody = body => {
  // GitHub serializes body as a JSON string. Budget encoded bytes, including
  // escaping/UTF-8, leaving half the client response limit for its API envelope.
  if (typeof body !== "string" || Buffer.byteLength(JSON.stringify(body), "utf8") > bodyBudget) {
    throw new Error("Release body exceeds the client-readable publication metadata budget.")
  }
}

// Preflight is pure so the npm coordinator applies the same advertisement
// limits before the first irreversible package publication.
export function preparePublicationMetadata(bundle, notes, previous) {
  const selected = decodeReleaseBundle(bundle)
  if (typeof notes !== "string" || releaseBundleFromBody(notes) !== undefined) throw new Error("Invalid release notes or reserved bundle section.")
  const versionBody = `${notes.trimEnd()}\n\n${releaseBundleSection(selected)}\n`
  const catalog = mergeReleaseBundle(previous, selected)
  const catalogBody = `${JSON.stringify(catalog, null, 2)}\n`
  requireReadableBody(versionBody)
  requireReadableBody(catalogBody)
  return { versionBody, catalog, catalogBody }
}

function checkCatalogRelease(release) {
  if (!release) return undefined
  if (release.tag_name !== updateCatalogTag || release.draft !== false || release.prerelease !== true || typeof release.body !== "string") {
    throw new Error("Existing update catalog is not the fixed public prerelease.")
  }
  return decodeReleaseCatalog(JSON.parse(release.body))
}

export async function readPublicationTargets(github) {
  const [release, latest] = await Promise.all([github.readRelease(updateCatalogTag), github.readLatest()])
  const catalog = checkCatalogRelease(release)
  if (latest && (!versionPattern.test(latest.tag_name) || latest.draft || latest.prerelease)) throw new Error("GitHub Latest has an unknown release identity.")
  return { catalog, latestVersion: latest?.tag_name.slice(1) }
}

// This Module owns all GitHub advertisement. The caller invokes it only after
// anonymous verification of the complete seven-package bundle has succeeded.
export async function publishUpdateCatalog({ artifacts, notes, commit, github }) {
  const bundle = decodeReleaseBundle(artifacts.bundle)
  if (bundle.captureStateContract !== publicationCaptureContract || bundle.updateControlProtocol !== publicationControlProtocol) {
    throw new Error("This publication policy cannot advertise another capture/control contract.")
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Publication requires an exact commit.")
  preparePublicationMetadata(bundle, notes)
  if (artifacts.files.length !== 8 || new Set(artifacts.files.map(file => file.filename)).size !== 8) throw new Error("Publication requires exactly seven tarballs and SHA256SUMS.")
  for (const file of artifacts.files) if (!Buffer.isBuffer(file.bytes) || file.sha256 !== digest(file.bytes)) throw new Error("Local publication bytes changed.")
  const tag = `v${bundle.version}`
  await github.verifyVersionTag(tag, commit)
  // Read malformed catalog metadata before creating or modifying a version.
  const preflight = await readPublicationTargets(github)
  const { versionBody: body } = preparePublicationMetadata(bundle, notes, preflight.catalog)
  let release = await github.readRelease(tag)
  if (release) {
    if (release.tag_name !== tag || release.prerelease !== false || typeof release.body !== "string") throw new Error("Existing version release has an unexpected identity.")
    requireReadableBody(release.body)
    const existing = releaseBundleFromBody(release.body)
    if (existing && releaseBundleFingerprint(existing) !== releaseBundleFingerprint(bundle)) throw new Error("Existing Release bundle differs; refusing replacement.")
    if (!existing && release.body.trim() !== notes.trim()) throw new Error("Existing release notes differ; refusing replacement.")
  } else {
    release = await github.create({ tag_name: tag, target_commitish: commit, name: `ATape ${tag}`,
      body, draft: true, prerelease: false, make_latest: "false" })
  }
  const expected = new Map(artifacts.files.map(file => [file.filename, file]))
  const seen = new Set()
  for (const asset of release.assets ?? []) {
    const file = expected.get(asset.name)
    if (!file || seen.has(asset.name) || asset.size !== file.bytes.length) throw new Error("Existing Release asset set differs; refusing to clobber.")
    seen.add(asset.name)
    const bytes = await github.download(asset, file.bytes.length)
    if (!bytes || digest(bytes) !== file.sha256 || !bytes.equals(file.bytes)) throw new Error(`Existing Release asset ${asset.name} has different bytes; refusing to clobber.`)
  }
  for (const file of artifacts.files) if (!seen.has(file.filename)) await github.upload(release, file)
  const targets = await readPublicationTargets(github)
  const makeLatest = !targets.latestVersion || compareReleaseVersions(bundle.version, targets.latestVersion) > 0
  // Preserve existing human notes when a rerun already has its exact descriptor.
  const finalBody = releaseBundleFromBody(release.body ?? "") ? release.body : body
  if (release.draft || release.body !== finalBody || makeLatest) {
    release = await github.edit(release.id, { body: finalBody, draft: false, prerelease: false, make_latest: makeLatest || targets.latestVersion === bundle.version ? "true" : "false" })
  }
  if (release.draft !== false || release.prerelease !== false ||
    releaseBundleFingerprint(releaseBundleFromBody(release.body)) !== releaseBundleFingerprint(bundle)) throw new Error("Version Release advertisement was not confirmed.")
  // A fresh read immediately before merge prevents a stale local snapshot from
  // regressing another completed run. Workflow concurrency serializes writers.
  const catalogRelease = await github.readRelease(updateCatalogTag)
  const previous = checkCatalogRelease(catalogRelease)
  const { catalog: next, catalogBody } = preparePublicationMetadata(bundle, notes, previous)
  if (!previous || JSON.stringify(next) !== JSON.stringify(previous)) {
    if (catalogRelease) await github.edit(catalogRelease.id, { body: catalogBody, draft: false, prerelease: true, make_latest: "false" })
    else await github.create({ tag_name: updateCatalogTag, target_commitish: commit, name: "ATape compatible update catalog",
      body: catalogBody, draft: false, prerelease: true, make_latest: "false" })
  }
  const confirmed = checkCatalogRelease(await github.readRelease(updateCatalogTag))
  if (JSON.stringify(confirmed) !== JSON.stringify(next)) throw new Error("Update catalog publication was not confirmed.")
  return { version: bundle.version, catalogRevision: confirmed.revision, releaseUrl: release.html_url }
}
