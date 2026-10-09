import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { releaseBundleProtocol, releasePackageNames } from "../packages/domain/src/releaseCatalog.ts"
import { createPublicReleaseRegistry, loadPublicationArtifacts, publicationCaptureContract,
  publicationControlProtocol } from "./public-release-visibility.mjs"

const hash = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding)
function artifacts(version = "0.5.6") {
  const files = releasePackageNames.map(name => {
    const bytes = Buffer.from(`${name}@${version}`)
    return { name, filename: `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`, bytes,
      integrity: `sha512-${hash("sha512", bytes, "base64")}`, sha256: hash("sha256", bytes, "hex") }
  })
  return { files, bundle: { protocol: releaseBundleProtocol, version, captureStateContract: publicationCaptureContract,
    updateControlProtocol: publicationControlProtocol, packages: files.map(file => ({ name: file.name, integrity: file.integrity,
      tarball: `https://registry.npmjs.org/${file.name}/-/${file.name.slice("@atape/".length)}-${version}.tgz` })) } }
}
function registryTransport(local, change = () => undefined) {
  const calls = []
  return { calls, fetch: async (url, options) => {
    calls.push({ url, options })
    const replacement = change(url, calls)
    if (replacement) return replacement
    const package_ = local.bundle.packages.find(item => url === item.tarball || url === `https://registry.npmjs.org/${encodeURIComponent(item.name)}/${local.bundle.version}`)
    assert.ok(package_, url)
    if (url.endsWith(".tgz")) return new Response(local.files.find(file => file.name === package_.name).bytes)
    return Response.json({ name: package_.name, version: local.bundle.version, dist: { integrity: package_.integrity, tarball: package_.tarball } })
  } }
}

test("anonymous caller verifies all seven exact manifests and bytes without auth or redirects", async () => {
  const local = artifacts(), remote = registryTransport(local)
  const result = await createPublicReleaseRegistry({ fetch: remote.fetch }).verify(local)
  assert.equal(result.packages.length, 7)
  assert.equal(remote.calls.length, 14)
  for (const { options } of remote.calls) {
    assert.equal(options.redirect, "error")
    assert.equal(options.headers.authorization, undefined)
    assert.ok(options.signal)
  }
})

test("propagation failures retry with one shared bounded deadline", async () => {
  const local = artifacts()
  let clock = 0, failures = 0
  const remote = registryTransport(local, url => !url.endsWith(".tgz") && failures++ < 2 ? new Response("", { status: 404 }) : undefined)
  await createPublicReleaseRegistry({ fetch: remote.fetch, now: () => clock, sleep: async ms => { clock += ms }, budgetMs: 10_000 }).verify(local)
  assert.equal(clock, 3000)
  assert.equal(remote.calls.length, 16)
  clock = 0
  const unavailable = async () => new Response("", { status: 503 })
  await assert.rejects(createPublicReleaseRegistry({ fetch: unavailable, now: () => clock,
    sleep: async ms => { clock += ms }, budgetMs: 1500 }).verify(local), /within 1500ms/)
  assert.equal(clock, 1500)
})

for (const field of ["identity", "integrity", "url", "bytes", "oversize", "metadata-size"]) {
  test(`public ${field} mismatch fails immediately without retry`, async () => {
    const local = artifacts(), first = local.bundle.packages[0]
    let sleeps = 0
    const remote = registryTransport(local, url => {
      if (field === "bytes" && url === first.tarball) return new Response(Buffer.alloc(local.files[0].bytes.length))
      if (field === "oversize" && url === first.tarball) return new Response(Buffer.alloc(local.files[0].bytes.length + 1))
      if (!url.endsWith(".tgz")) {
        if (field === "metadata-size") return new Response(" ".repeat(256 * 1024 + 1))
        const dist = { integrity: first.integrity, tarball: first.tarball }
        if (field === "integrity") dist.integrity = artifacts("0.5.7").bundle.packages[0].integrity
        if (field === "url") dist.tarball = "https://example.com/wrong.tgz"
        return Response.json({ name: field === "identity" ? "@other/cli" : first.name, version: local.bundle.version, dist })
      }
    })
    await assert.rejects(createPublicReleaseRegistry({ fetch: remote.fetch, sleep: async () => { sleeps++ } }).verify(local))
    assert.equal(sleeps, 0)
  })
}

test("exact lookup treats only a 404 as absent; unknown metadata remains an error", async () => {
  const registry = createPublicReleaseRegistry({ fetch: async () => new Response("", { status: 404 }) })
  assert.equal(await registry.read("@atape/cli", "0.5.6"), undefined)
  await assert.rejects(registry.read("@other/cli", "0.5.6"), /Unknown/)
  await assert.rejects(createPublicReleaseRegistry({ fetch: async () => Response.json({ version: "0.5.6" }) }).read("@atape/cli", "latest"), /Invalid/)
})

async function localRelease(t, contract = publicationCaptureContract, protocol = "atape.runtime.v1") {
  const directory = await mkdtemp(join(tmpdir(), "atape-publication-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const local = artifacts()
  const packageDirectory = join(directory, "package")
  await mkdir(packageDirectory)
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "@atape/cli", version: local.bundle.version,
    atapeRuntime: { protocol, stateContract: contract, updateControlProtocol: publicationControlProtocol, releaseCatalogProtocol: "atape.update-catalog.v1" } }))
  const packages = []
  for (const file of local.files) {
    const path = join(directory, file.filename)
    if (file.name === "@atape/cli") await promisify(execFile)("tar", ["-czf", path, "-C", directory, "package"])
    else await writeFile(path, file.bytes)
    packages.push({ name: file.name, version: local.bundle.version, artifactName: file.filename })
  }
  const sums = []
  for (const item of [...packages].sort((a, b) => a.artifactName < b.artifactName ? -1 : 1)) {
    sums.push(`${hash("sha256", await readFile(join(directory, item.artifactName)), "hex")}  ${item.artifactName}\n`)
  }
  await writeFile(join(directory, "SHA256SUMS"), sums.join(""))
  return { version: local.bundle.version, releaseDirectory: directory, packages }
}

test("local artifacts bind exact checksums and the actual packaged CLI capabilities", async t => {
  const release = await localRelease(t)
  const result = await loadPublicationArtifacts(release)
  assert.equal(result.files.length, 8)
  assert.equal(result.bundle.packages.length, 7)
  await writeFile(join(release.releaseDirectory, release.packages[1].artifactName), "changed")
  await assert.rejects(loadPublicationArtifacts(release), /SHA256SUMS/)
})

test("future capture contract is refused before publication", async t => {
  await assert.rejects(loadPublicationArtifacts(await localRelease(t, "atape.client.v3-capture.v3")), /future contracts/)
})

test("packaged runtime protocol and the client's 16MiB acquisition limit are publication gates", async t => {
  await assert.rejects(loadPublicationArtifacts(await localRelease(t, publicationCaptureContract, "unknown.runtime")), /catalog-capable/)
  const release = await localRelease(t)
  await writeFile(join(release.releaseDirectory, release.packages[1].artifactName), Buffer.alloc(16 * 1024 * 1024 + 1))
  await assert.rejects(loadPublicationArtifacts(release), /Invalid local artifact/)
})
