import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, readFile } from "node:fs/promises"
import test from "node:test"
import { mergeReleaseBundle, releaseBundleProtocol, releaseBundleSection, releasePackageNames,
  updateCatalogTag } from "../packages/domain/src/releaseCatalog.ts"
import { publicationCaptureContract, publicationControlProtocol } from "./public-release-visibility.mjs"
import { createGitHubPublication, publishUpdateCatalog } from "./publish-update-catalog.mjs"
import { publishRelease } from "./publish-npm-release.mjs"

const commit = "a".repeat(40)
const digest = bytes => createHash("sha256").update(bytes).digest("hex")
function artifacts(version = "0.5.6") {
  const files = releasePackageNames.map(name => {
    const bytes = Buffer.from(`${name}@${version}`)
    return { name, filename: `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`, path: "/unused/source.tgz", bytes,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, sha256: digest(bytes) }
  })
  const checksums = Buffer.from([...files].sort((a, b) => a.filename < b.filename ? -1 : 1).map(file => `${file.sha256}  ${file.filename}\n`).join(""))
  return { files: [...files, { filename: "SHA256SUMS", bytes: checksums, sha256: digest(checksums) }],
    bundle: { protocol: releaseBundleProtocol, version, captureStateContract: publicationCaptureContract,
      updateControlProtocol: publicationControlProtocol, packages: files.map(file => ({ name: file.name, integrity: file.integrity,
        tarball: `https://registry.npmjs.org/${file.name}/-/${file.name.slice("@atape/".length)}-${version}.tgz` })) } }
}
function githubFixture() {
  const releases = new Map(), bytes = new Map(), events = []
  let id = 0, latest
  const clone = value => JSON.parse(JSON.stringify(value))
  const seed = (tag, body, files = [], { draft = false, prerelease = false, isLatest = false } = {}) => {
    const release = { id: ++id, tag_name: tag, body, draft, prerelease, name: tag,
      upload_url: `https://uploads.github.com/repos/SingleMai/ATape/releases/${id}/assets{?name,label}`,
      html_url: `https://github.com/SingleMai/ATape/releases/tag/${tag}`, assets: [] }
    for (const file of files) {
      const asset = { id: ++id, name: file.filename, size: file.bytes.length }
      bytes.set(asset.id, file.bytes); release.assets.push(asset)
    }
    releases.set(tag, release)
    if (isLatest) latest = tag
    return release
  }
  const fetch = async (url, options) => {
    const parsed = new URL(url), route = decodeURIComponent(parsed.pathname.replace("/repos/SingleMai/ATape", ""))
    const method = options.method
    const body = options.body && !Buffer.isBuffer(options.body) ? JSON.parse(options.body) : options.body
    events.push({ method, route, body })
    const json = value => value ? Response.json(clone(value)) : new Response("", { status: 404 })
    if (method === "GET" && route.startsWith("/git/ref/tags/")) return json({ object: { type: "commit", sha: commit } })
    if (method === "GET" && route === "/releases/latest") return json(releases.get(latest))
    if (method === "GET" && route.startsWith("/releases/tags/")) return json(releases.get(route.slice("/releases/tags/".length)))
    if (method === "GET" && route.startsWith("/releases/assets/")) return new Response(bytes.get(Number(route.split("/").at(-1))))
    if (method === "POST" && route === "/releases") {
      if (releases.has(body.tag_name)) return new Response("", { status: 422 })
      return json(seed(body.tag_name, body.body, [], { draft: body.draft, prerelease: body.prerelease, isLatest: body.make_latest === "true" }))
    }
    const release = [...releases.values()].find(release => route === `/releases/${release.id}` || route === `/releases/${release.id}/assets`)
    assert.ok(release, `${method} ${route}`)
    if (method === "POST" && route.endsWith("/assets")) {
      const asset = { id: ++id, name: parsed.searchParams.get("name"), size: body.length }
      bytes.set(asset.id, body); release.assets.push(asset); return json(asset)
    }
    if (method === "PATCH") {
      if (body.make_latest === "true") latest = release.tag_name
      Object.assign(release, body)
      return json(release)
    }
    throw new Error(`Unexpected ${method} ${route}`)
  }
  return { releases, bytes, events, seed, github: createGitHubPublication({ token: "test-only-token", fetch }) }
}
const writes = remote => remote.events.filter(event => event.method !== "GET")
const publish = (remote, local = artifacts()) => publishUpdateCatalog({ artifacts: local, notes: "Release notes.", commit, github: remote.github })

test("caller creates complete version assets before public version, then fixed nonlatest catalog", async () => {
  const remote = githubFixture(), local = artifacts()
  const result = await publish(remote, local)
  assert.equal(result.catalogRevision, 1)
  const mutations = writes(remote)
  assert.equal(mutations[0].body.draft, true)
  assert.equal(mutations.filter(event => event.route.endsWith("/assets")).length, local.files.length)
  const advertised = mutations.findIndex(event => event.method === "PATCH" && event.body.draft === false && event.body.prerelease === false)
  assert.equal(advertised, local.files.length + 1)
  assert.equal(mutations.at(-1).body.tag_name, updateCatalogTag)
  assert.equal(mutations.at(-1).body.prerelease, true)
  assert.equal(mutations.at(-1).body.make_latest, "false")
})

test("missing Cursor, renamed, duplicate and extra files fail before external writes", async () => {
  for (const kind of ["missing-cursor", "renamed", "duplicate", "extra"]) {
    const remote = githubFixture(), local = artifacts()
    const cursor = local.files.find(file => file.name === "@atape/adapter-cursor")
    assert.ok(cursor)
    if (kind === "missing-cursor") local.files = local.files.filter(file => file !== cursor)
    if (kind === "renamed") local.files = local.files.map(file => file === cursor ? { ...file, filename: "unexpected.tgz" } : file)
    if (kind === "duplicate") local.files = local.files.map(file => file === cursor ? local.files[0] : file)
    if (kind === "extra") local.files.push({ ...cursor, filename: "unexpected.tgz" })
    await assert.rejects(publish(remote, local), /exact bundle tarballs/)
    assert.equal(remote.events.length, 0)
  }
})

test("same-byte rerun performs no uploads, tag moves or catalog revision changes", async () => {
  const remote = githubFixture(), local = artifacts()
  await publish(remote, local)
  remote.events.length = 0
  const result = await publish(remote, local)
  assert.equal(result.catalogRevision, 1)
  assert.equal(writes(remote).length, 0)
})

test("older retry cannot regress catalog or GitHub Latest", async () => {
  const remote = githubFixture()
  await publish(remote, artifacts("0.5.7"))
  remote.events.length = 0
  const result = await publish(remote, artifacts("0.5.6"))
  assert.equal(result.catalogRevision, 1)
  assert.ok(writes(remote).every(event => event.body?.make_latest !== "true"))
  assert.equal(JSON.parse(remote.releases.get(updateCatalogTag).body).bundles[0].version, "0.5.7")
})

test("different same-version descriptor fails without replacing any existing release", async () => {
  const remote = githubFixture(), local = artifacts()
  const other = artifacts(); other.bundle.packages[0].integrity = artifacts("0.5.7").bundle.packages[0].integrity
  remote.seed("v0.5.6", `Release notes.\n${releaseBundleSection(other.bundle)}`, local.files)
  await assert.rejects(publish(remote, local), /bundle differs/)
  assert.equal(writes(remote).length, 0)
})

test("different existing asset is never clobbered", async () => {
  const remote = githubFixture(), local = artifacts()
  const corrupt = local.files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }))
  corrupt[2].bytes[0] ^= 1
  remote.seed("v0.5.6", `Release notes.\n${releaseBundleSection(local.bundle)}`, corrupt)
  await assert.rejects(publish(remote, local), /different bytes/)
  assert.equal(writes(remote).length, 0)
})

test("draft interruption resumes missing uploads and publishes only after completion", async () => {
  const remote = githubFixture(), local = artifacts()
  remote.seed("v0.5.6", `Release notes.\n${releaseBundleSection(local.bundle)}`, local.files.slice(0, 3), { draft: true })
  await publish(remote, local)
  assert.equal(writes(remote).filter(event => event.route.endsWith("/assets")).length, local.files.length - 3)
  assert.equal(remote.releases.get("v0.5.6").draft, false)
})

test("unknown catalog is refused before version advertisement", async () => {
  const remote = githubFixture()
  remote.seed(updateCatalogTag, JSON.stringify({ protocol: "unknown" }), [], { prerelease: true })
  await assert.rejects(publish(remote))
  assert.equal(writes(remote).length, 0)
})

test("catalog cannot be a draft or stable latest release", async () => {
  for (const flags of [{ draft: true, prerelease: true }, { prerelease: false }]) {
    const remote = githubFixture()
    remote.seed(updateCatalogTag, JSON.stringify(mergeReleaseBundle(undefined, artifacts().bundle)), [], flags)
    await assert.rejects(publish(remote), /fixed public prerelease/)
    assert.equal(writes(remote).length, 0)
  }
})

test("tag identity mismatch prevents any publication", async () => {
  const remote = githubFixture()
  await assert.rejects(publishUpdateCatalog({ artifacts: artifacts(), notes: "Release notes.", commit: "b".repeat(40), github: remote.github }), /exact verified release commit/)
  assert.equal(writes(remote).length, 0)
})

function publicationFixture(local, remote, { published = false, latest = "0.5.5", visibilityFailure = false } = {}) {
  const events = [], staging = []
  return { events, staging, input: { release: { version: local.bundle.version, tag: `v${local.bundle.version}`, repositoryRoot: "/unused" },
    artifacts: local, notes: "Release notes.", commit, github: remote.github, log: () => {},
    registry: {
      read: async (name, version) => version === "latest" ? { version: latest } : published ? { dist: { integrity: local.bundle.packages.find(item => item.name === name).integrity } } : undefined,
      verify: async () => { events.push("visible"); if (visibilityFailure) throw new Error("not yet public"); return { packages: local.bundle.packages } }
    },
    execute: async (command, arguments_) => {
      assert.equal(command, "npm")
      const name = local.files.find(file => arguments_[1].endsWith(file.filename)).name
      assert.deepEqual(await readFile(arguments_[1]), local.files.find(file => file.name === name).bytes)
      staging.push(arguments_[1]); events.push({ name, tag: arguments_[arguments_.indexOf("--tag") + 1] })
      return { stdout: "", stderr: "" }
    } } }
}

test("malformed bundle artifacts cannot reach the first npm publication", async () => {
  for (const kind of ["missing-cursor", "renamed", "duplicate", "extra", "swapped-names", "changed-bytes", "changed-integrity", "changed-checksums"]) {
    const remote = githubFixture(), local = artifacts(), fixture = publicationFixture(local, remote)
    const cursor = local.files.find(file => file.name === "@atape/adapter-cursor")
    if (kind === "missing-cursor") local.files = local.files.filter(file => file !== cursor)
    if (kind === "renamed") cursor.filename = "unexpected.tgz"
    if (kind === "duplicate") local.files = local.files.map(file => file === cursor ? local.files[0] : file)
    if (kind === "extra") local.files.push({ ...cursor, filename: "unexpected.tgz" })
    if (kind === "swapped-names") [cursor.name, local.files[0].name] = [local.files[0].name, cursor.name]
    if (kind === "changed-bytes") cursor.bytes = Buffer.from("changed")
    if (kind === "changed-integrity") local.bundle.packages.find(item => item.name === cursor.name).integrity = artifacts("0.5.7").bundle.packages[0].integrity
    if (kind === "changed-checksums") {
      const checksums = local.files.find(file => file.filename === "SHA256SUMS")
      checksums.bytes = Buffer.from("changed\n"); checksums.sha256 = digest(checksums.bytes)
    }
    await assert.rejects(publishRelease(fixture.input), /exact bundle tarballs|Local .* changed|SHA256SUMS/, kind)
    assert.deepEqual(fixture.events, [], kind)
    assert.deepEqual(fixture.staging, [], kind)
    assert.deepEqual(remote.events, [], kind)
  }
})

test("publication orders adapters then CLI, explicit latest, public verification before any GitHub write", async () => {
  const remote = githubFixture(), local = artifacts(), fixture = publicationFixture(local, remote)
  const verify = fixture.input.registry.verify
  fixture.input.registry.verify = async () => { assert.equal(writes(remote).length, 0); return verify() }
  await publishRelease(fixture.input)
  assert.equal(fixture.events.length, local.bundle.packages.length + 1)
  assert.equal(fixture.events[local.bundle.packages.length - 1].name, "@atape/cli")
  assert.ok(fixture.events.slice(0, local.bundle.packages.length).every(event => event.tag === "latest"))
  for (const path of fixture.staging) await assert.rejects(access(path))
})

test("older npm publication uses nonlatest tag and cannot advertise backward", async () => {
  const remote = githubFixture(), local = artifacts()
  await publish(remote, artifacts("0.5.7"))
  const fixture = publicationFixture(local, remote, { latest: "0.5.7" })
  const result = await publishRelease(fixture.input)
  assert.equal(result.npmTag, "atape-managed")
  assert.ok(fixture.events.slice(0, local.bundle.packages.length).every(event => event.tag === "atape-managed"))
})

test("existing exact npm versions skip publish but still require all public bytes", async () => {
  const remote = githubFixture(), fixture = publicationFixture(artifacts(), remote, { published: true, visibilityFailure: true })
  await assert.rejects(publishRelease(fixture.input), /not yet public/)
  assert.deepEqual(fixture.events, ["visible"])
  assert.equal(writes(remote).length, 0)
})

test("immutable npm mismatch and future contract fail before first external write", async () => {
  const remote = githubFixture(), fixture = publicationFixture(artifacts(), remote)
  fixture.input.registry.read = async (_, version) => version === "latest" ? undefined : { dist: { integrity: "different" } }
  await assert.rejects(publishRelease(fixture.input), /different tarball integrity/)
  assert.equal(fixture.events.length, 0)
  fixture.input.artifacts.bundle.captureStateContract = "future.v3"
  await assert.rejects(publishRelease(fixture.input), /same-capture/)
  assert.equal(writes(remote).length, 0)
})

test("npm failure cleans staging and cannot advertise the partial bundle", async () => {
  const remote = githubFixture(), fixture = publicationFixture(artifacts(), remote)
  let staged
  fixture.input.execute = async (_, arguments_) => { staged = arguments_[1]; throw new Error("npm failed") }
  await assert.rejects(publishRelease(fixture.input), /npm failed/)
  await assert.rejects(access(staged))
  assert.equal(writes(remote).length, 0)
})

test("immutable npm conflict during propagation still requires complete public byte verification", async () => {
  const remote = githubFixture(), fixture = publicationFixture(artifacts(), remote)
  const execute = fixture.input.execute
  let first = true
  fixture.input.execute = async (...arguments_) => {
    if (first) { first = false; throw Object.assign(new Error("already written"), { stderr: "npm error E403 You cannot publish over the previously published versions: 0.5.6." }) }
    return execute(...arguments_)
  }
  fixture.input.registry.verify = async () => { throw new Error("public bytes differ") }
  await assert.rejects(publishRelease(fixture.input), /public bytes differ/)
  assert.equal(writes(remote).length, 0)
})

for (const [label, notes] of [["large", "x".repeat(128 * 1024)], ["escaped", "\\".repeat(70 * 1024)], ["UTF-8", "语".repeat(50 * 1024)]]) {
  test(`${label} notes exceed the encoded metadata budget before the first npm write`, async () => {
    const remote = githubFixture(), fixture = publicationFixture(artifacts(), remote)
    fixture.input.notes = notes
    await assert.rejects(publishRelease(fixture.input), /publication metadata budget/)
    assert.equal(fixture.events.length, 0)
    assert.equal(writes(remote).length, 0)
  })
}

test("an oversized merged catalog is refused before any package or GitHub write", async () => {
  const remote = githubFixture(), fixture = publicationFixture(artifacts(), remote)
  const bundles = Array.from({ length: 60 }, (_, index) => ({ ...artifacts(`1.0.${index}`).bundle,
    captureStateContract: `${"c".repeat(180)}${index}`, updateControlProtocol: `${"u".repeat(180)}${index}` }))
  remote.seed(updateCatalogTag, JSON.stringify({ protocol: "atape.update-catalog.v1", revision: 60, bundles }), [], { prerelease: true })
  await assert.rejects(publishRelease(fixture.input), /publication metadata budget/)
  assert.equal(fixture.events.length, 0)
  assert.equal(writes(remote).length, 0)
})

test("an existing version body above the client budget cannot become an automatic target", async () => {
  const remote = githubFixture(), local = artifacts()
  remote.seed("v0.5.6", `${"x".repeat(128 * 1024)}\n${releaseBundleSection(local.bundle)}`, local.files)
  await assert.rejects(publish(remote, local), /publication metadata budget/)
  assert.equal(writes(remote).length, 0)
})
