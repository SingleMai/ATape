import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { loadReleaseContract } from "./release-contract.mjs"
import { createPublicReleaseRegistry, loadPublicationArtifacts, publicationCaptureContract,
  publicationControlProtocol, validatePublicationArtifacts } from "./public-release-visibility.mjs"
import { compareReleaseVersions, createGitHubPublication, publishUpdateCatalog, readPublicationTargets, preparePublicationMetadata } from "./publish-update-catalog.mjs"

// One caller Interface owns npm ordering, anonymous visibility and advertisement.
// execFile/npm and GitHub/registry HTTP are the actual remote process/transport Seams.
export async function publishRelease({ release, artifacts, registry, github, notes, commit,
  execute = promisify(execFile), log = message => process.stdout.write(message) }) {
  const bundle = validatePublicationArtifacts(artifacts)
  if (bundle.version !== release.version || release.tag !== `v${bundle.version}` ||
    bundle.captureStateContract !== publicationCaptureContract || bundle.updateControlProtocol !== publicationControlProtocol) {
    throw new Error("Only the matching same-capture.v2/control.v1 release may be published.")
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Publication requires an exact commit.")
  await github.verifyVersionTag(release.tag, commit)
  const targets = await readPublicationTargets(github)
  // Detect immutable same-version catalog conflicts before the first npm write.
  preparePublicationMetadata(bundle, notes, targets.catalog)
  const latest = []
  const existing = new Map()
  for (const item of bundle.packages) {
    const [current, published] = await Promise.all([registry.read(item.name, "latest"), registry.read(item.name, bundle.version)])
    if (current) latest.push(current.version)
    if (published && published.dist.integrity !== item.integrity) throw new Error(`${item.name}@${bundle.version} already exists with different tarball integrity.`)
    existing.set(item.name, published)
  }
  const advertised = [...latest, ...(targets.latestVersion ? [targets.latestVersion] : []),
    ...(targets.catalog?.bundles.map(item => item.version) ?? [])]
  const tag = advertised.some(version => compareReleaseVersions(version, bundle.version) > 0) ? "atape-managed" : "latest"
  const ordered = [...bundle.packages.filter(item => item.name !== "@atape/cli"), bundle.packages.find(item => item.name === "@atape/cli")]
  const staging = await mkdtemp(join(tmpdir(), "atape-npm-publication-"))
  try {
    for (const item of ordered) {
      if (existing.get(item.name)) { log(`Already published ${item.name}@${bundle.version}; integrity matches.\n`); continue }
      const file = artifacts.files.find(file => file.name === item.name)
      if (!file) throw new Error(`Missing publication artifact for ${item.name}.`)
      const stagedArtifact = join(staging, file.filename)
      await writeFile(stagedArtifact, file.bytes, { mode: 0o600, flag: "wx" })
      let result
      try {
        result = await execute("npm", ["publish", stagedArtifact, "--tag", tag, "--access", "public", "--provenance", "--registry", "https://registry.npmjs.org/"],
          { cwd: release.repositoryRoot, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
      } catch (cause) {
        const stderr = typeof cause?.stderr === "string" ? cause.stderr : ""
        if (!/EPUBLISHCONFLICT|cannot publish over (?:the )?previously published versions/i.test(stderr)) throw cause
        // The write registry may see an earlier successful attempt before the
        // public read replica. No identity is accepted until the full verifier.
        log(`Existing immutable ${item.name}@${bundle.version}; awaiting public byte verification.\n`)
        continue
      }
      log(result.stdout ?? "")
      if (result.stderr) process.stderr.write(result.stderr)
    }
  } finally { await rm(staging, { recursive: true, force: true }) }
  const visibility = await registry.verify(artifacts)
  log(`Verified all ${bundle.packages.length} public npm manifests and exact tarball bytes for ${bundle.version}.\n`)
  const publication = await publishUpdateCatalog({ artifacts, notes, commit, github })
  return { ...publication, npmTag: tag, visibility }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "SingleMai/ATape") {
    throw new Error("Release publication is restricted to the SingleMai/ATape GitHub Actions release workflow.")
  }
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
  const release = { ...await loadReleaseContract(repositoryRoot), repositoryRoot }
  if (process.env.GITHUB_REF_NAME !== release.tag) throw new Error("Release workflow tag differs from the local verified bundle.")
  const artifacts = await loadPublicationArtifacts(release)
  const notes = await readFile(join(repositoryRoot, "docs", "releases", `${release.tag}.md`), "utf8")
  const result = await publishRelease({ release, artifacts, notes, commit: process.env.GITHUB_SHA,
    registry: createPublicReleaseRegistry(), github: createGitHubPublication({ token: process.env.GH_TOKEN }) })
  await writeFile(join(release.releaseDirectory, "publication.json"), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`Published ${result.version}; compatible catalog revision ${result.catalogRevision}.\n`)
}
