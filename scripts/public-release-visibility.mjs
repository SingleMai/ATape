import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { archiveName } from "./release-contract.mjs"
import { decodeReleaseBundle, releaseBundleProtocol, releasePackageNames } from "../packages/domain/src/releaseCatalog.ts"

const execute = promisify(execFile)
const registry = "https://registry.npmjs.org"
export const publicationCaptureContract = "atape.client.v3-capture.v2"
export const publicationControlProtocol = "atape.update-control.v1"
const maximumMetadataBytes = 256 * 1024
const maximumArtifactBytes = 16 * 1024 * 1024
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`
const canonicalTarball = (name, version) => `${registry}/${name}/-/${name.slice("@atape/".length)}-${version}.tgz`

// Both publication callers validate the same immutable local inputs before any
// external write, including npm writes which precede GitHub advertisement.
export function validatePublicationArtifacts(artifacts) {
  const bundle = decodeReleaseBundle(artifacts.bundle)
  const expectedFilenames = new Set([...bundle.packages.map(item => archiveName(item.name, bundle.version)), "SHA256SUMS"])
  if (!Array.isArray(artifacts.files) || artifacts.files.length !== expectedFilenames.size ||
    new Set(artifacts.files.map(file => file.filename)).size !== expectedFilenames.size ||
    artifacts.files.some(file => !expectedFilenames.has(file.filename))) {
    throw new Error("Publication requires the exact bundle tarballs and SHA256SUMS.")
  }
  for (const file of artifacts.files) {
    if (!Buffer.isBuffer(file.bytes) || file.bytes.length === 0 || file.bytes.length > maximumArtifactBytes || file.sha256 !== sha256(file.bytes)) {
      throw new Error("Local publication bytes changed.")
    }
  }
  const packages = bundle.packages.map(item => {
    const file = artifacts.files.find(file => file.filename === archiveName(item.name, bundle.version))
    if (file.name !== item.name || integrity(file.bytes) !== item.integrity) throw new Error(`Local artifact identity changed for ${item.name}.`)
    return file
  })
  const checksums = artifacts.files.find(file => file.filename === "SHA256SUMS")
  const expectedChecksums = [...packages].sort((a, b) => a.filename < b.filename ? -1 : 1)
    .map(file => `${file.sha256}  ${file.filename}\n`).join("")
  if (checksums.name !== undefined || checksums.bytes.toString("utf8") !== expectedChecksums) {
    throw new Error("Verified publication artifacts no longer match SHA256SUMS.")
  }
  return bundle
}

// Local artifacts are the exact files already exercised by test:release. No
// registry credential participates in constructing or verifying the descriptor.
export async function loadPublicationArtifacts(release) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version)) throw new Error("Publication requires a stable version.")
  const files = []
  for (const name of releasePackageNames) {
    const item = release.packages.find(item => item.name === name)
    if (!item || item.version !== release.version) throw new Error(`Missing matching local artifact for ${name}.`)
    const expectedName = `${name.replace(/^@/, "").replaceAll("/", "-")}-${release.version}.tgz`
    if (item.artifactName !== expectedName) throw new Error("Unexpected local artifact filename.")
    const path = join(release.releaseDirectory, expectedName)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size === 0 || stat.size > maximumArtifactBytes) throw new Error(`Invalid local artifact ${expectedName}.`)
    const bytes = await readFile(path)
    files.push({ name, filename: expectedName, path, bytes, integrity: integrity(bytes), sha256: sha256(bytes) })
  }
  const checksumsPath = join(release.releaseDirectory, "SHA256SUMS")
  const stat = await lstat(checksumsPath)
  if (!stat.isFile() || stat.size > 8192) throw new Error("Invalid SHA256SUMS file.")
  const checksums = await readFile(checksumsPath)
  const expectedChecksums = [...files].sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
    .map(item => `${item.sha256}  ${item.filename}\n`).join("")
  if (checksums.toString("utf8") !== expectedChecksums) throw new Error("Verified publication artifacts no longer match SHA256SUMS.")
  const cli = files.find(item => item.name === "@atape/cli")
  const manifest = JSON.parse((await execute("tar", ["-xOf", cli.path, "package/package.json"],
    { timeout: 10_000, maxBuffer: maximumMetadataBytes, encoding: "utf8" })).stdout)
  if (!(await readFile(cli.path)).equals(cli.bytes)) throw new Error("Packaged CLI changed during inspection.")
  if (manifest.name !== "@atape/cli" || manifest.version !== release.version ||
    manifest.atapeRuntime?.protocol !== "atape.runtime.v1" ||
    manifest.atapeRuntime?.stateContract !== publicationCaptureContract ||
    manifest.atapeRuntime?.updateControlProtocol !== publicationControlProtocol ||
    manifest.atapeRuntime?.releaseCatalogProtocol !== "atape.update-catalog.v1") {
    throw new Error("This publisher supports only catalog-capable capture.v2/control.v1 CLI bundles; future contracts require a separate publication policy.")
  }
  const bundle = decodeReleaseBundle({ protocol: releaseBundleProtocol, version: release.version,
    captureStateContract: manifest.atapeRuntime.stateContract, updateControlProtocol: manifest.atapeRuntime.updateControlProtocol,
    packages: files.map(item => ({ name: item.name, integrity: item.integrity, tarball: canonicalTarball(item.name, release.version) })) })
  return { bundle, files: [...files, { filename: "SHA256SUMS", path: checksumsPath, bytes: checksums, sha256: sha256(checksums) }] }
}

class PropagationError extends Error {}
const retryable = status => status === 404 || status === 408 || status === 429 || status >= 500

async function boundedBytes(response, limit) {
  const declared = response.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel()
    throw new Error("Public registry response exceeds its byte limit.")
  }
  const chunks = []
  let length = 0
  if (response.body) {
    const reader = response.body.getReader()
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.length
        if (length > limit) throw new Error("Public registry response exceeds its byte limit.")
        chunks.push(part.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
  }
  return Buffer.concat(chunks, length)
}

// fetch is the real anonymous registry transport Seam; the clock bounds retries
// across the complete producer bundle rather than granting a fresh budget per request.
export function createPublicReleaseRegistry({ fetch: transport = globalThis.fetch, now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), budgetMs = 600_000 } = {}) {
  if (!(budgetMs > 0 && budgetMs <= 600_000)) throw new Error("Invalid public visibility budget.")
  const request = async (url, limit, deadline) => {
    const remaining = deadline - now()
    if (remaining <= 0) throw new PropagationError("Public registry propagation deadline expired.")
    try {
      const response = await transport(url, { redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, remaining))),
        headers: { accept: url.endsWith(".tgz") ? "application/octet-stream" : "application/json" } })
      if (!response.ok) {
        await response.body?.cancel()
        if (retryable(response.status)) throw new PropagationError(`Public registry returned HTTP ${response.status}.`)
        throw new Error(`Public registry returned HTTP ${response.status}.`)
      }
      return await boundedBytes(response, limit)
    } catch (cause) {
      if (cause instanceof PropagationError) throw cause
      if (cause instanceof TypeError || cause?.name === "TimeoutError" || cause?.name === "AbortError") {
        throw new PropagationError(`Public registry transport unavailable: ${cause.message}`)
      }
      throw cause
    }
  }
  const metadata = async (name, version, deadline) => {
    const value = JSON.parse((await request(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, maximumMetadataBytes, deadline)).toString("utf8"))
    if (value.name !== name || typeof value.version !== "string" || (version !== "latest" && value.version !== version) ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version) ||
      typeof value.dist?.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/.test(value.dist.integrity) ||
      value.dist?.tarball !== canonicalTarball(name, value.version)) throw new Error(`Invalid public metadata for ${name}@${version}.`)
    return value
  }
  return {
    async read(name, version) {
      if (!releasePackageNames.includes(name)) throw new Error("Unknown release package.")
      try { return await metadata(name, version, now() + Math.min(30_000, budgetMs)) }
      catch (cause) { if (cause instanceof PropagationError && cause.message.includes("HTTP 404")) return undefined; throw cause }
    },
    async verify(artifacts) {
      const bundle = decodeReleaseBundle(artifacts.bundle)
      const deadline = now() + budgetMs
      const verified = []
      for (const item of bundle.packages) {
        const local = artifacts.files.find(file => file.name === item.name)
        if (!local || local.bytes.length === 0 || local.bytes.length > maximumArtifactBytes || integrity(local.bytes) !== item.integrity) throw new Error(`Local artifact identity changed for ${item.name}.`)
        let attempt = 0
        for (;;) {
          try {
            const value = await metadata(item.name, bundle.version, deadline)
            if (value.dist.integrity !== item.integrity) throw new Error(`Published integrity differs for ${item.name}@${bundle.version}.`)
            const bytes = await request(item.tarball, local.bytes.length, deadline)
            if (bytes.length !== local.bytes.length || integrity(bytes) !== item.integrity || !bytes.equals(local.bytes)) {
              throw new Error(`Published tarball bytes differ for ${item.name}@${bundle.version}.`)
            }
            verified.push({ name: item.name, bytes: bytes.length, integrity: item.integrity })
            break
          } catch (cause) {
            if (!(cause instanceof PropagationError)) throw cause
            const remaining = deadline - now()
            if (remaining <= 0) throw new Error(`Complete-bundle public visibility was not established within ${budgetMs}ms.`, { cause })
            await sleep(Math.min(remaining, 1_000 * Math.min(10, 2 ** attempt++)))
          }
        }
      }
      return { bundle, verifiedAt: new Date(now()).toISOString(), packages: verified }
    }
  }
}
