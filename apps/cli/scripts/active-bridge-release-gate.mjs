import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadReleaseContract } from "../../../scripts/release-contract.mjs"
import { activeBridgeBaselineIntegrities, verifyActiveBridgeUpgrade } from "./verify-active-bridge-upgrade.mjs"

export const activeBridgeBaselineMaximumBytes = 8 * 1024 * 1024
const deadlineMs = 30_000
const baselines = [
  { name: "@atape/cli", filename: "cli-0.5.10.tgz", url: "https://registry.npmjs.org/@atape/cli/-/cli-0.5.10.tgz" },
  { name: "@atape/adapter-codex", filename: "adapter-codex-0.5.10.tgz", url: "https://registry.npmjs.org/@atape/adapter-codex/-/adapter-codex-0.5.10.tgz" },
  { name: "@atape/adapter-claude", filename: "adapter-claude-0.5.10.tgz", url: "https://registry.npmjs.org/@atape/adapter-claude/-/adapter-claude-0.5.10.tgz" }
].map(item => ({ ...item, version: "0.5.10", integrity: activeBridgeBaselineIntegrities[item.name] }))

// This historical acceptance baseline is fixed, independently of npm latest,
// managed tags or the candidate release version. Retain all eight real archives.
const retainedBridgeVersion = "0.5.11"
const retainedBridgeIntegrities = {
  "@atape/cli": "sha512-SYZQnSmI9QSKnzEWumIIE22saB919cA2ebGJzCGfnaI4lDLiGLA4rW9c605464B7SBhNfY8zUV0C6Gvsj2rCZA==",
  "@atape/adapter-codex": "sha512-b3h4/RBl8GbNUN/M2IxkjnV/IujJqOLl1z99C9w6mzP499fENSU08SQbjXRmEephe05J92JmcfkPZEcd6wlLDw==",
  "@atape/adapter-claude": "sha512-fgkgFrNltDa6+Vq/0+SE4xmqvCyPL1SdYgP0KIDu/uas2Oz5OyLly/562zzMkfKfymuFCZUGALqzMMbQ8BLw9Q==",
  "@atape/adapter-opencode": "sha512-WD05HLDZyZg+24SAm9MAjk0Ob+tMoyuzI5Kk/teESNzWNX5aN7X8sCLAcls7NyaQg4uOmRfWAkclvKAR5CW4YQ==",
  "@atape/adapter-codebuddy": "sha512-3BbggtxinR210yLzqk1GKaRxbT1aWnnv9Xe6/NWDvzkBh5lWnawva6azCGeF9gKjr7UjZgEUKxihzRgQ9eBqKA==",
  "@atape/adapter-kimi": "sha512-y8iAqWqBT+I2E22ofgjVgATIFE9GrMGkCbpSpNw8UwtDx13GyUkijb0YmktcB0sQ7TWr8gmThL9wWeuLlKXacA==",
  "@atape/adapter-grok": "sha512-sKY39aSPOt55XWtHZ6jrLZvcukIMdtfdfjqv+c0p3G1L6EqMZD6ai9mHigy1xcms17Xp/tB5BShPWrvw/PNICw==",
  "@atape/adapter-cursor": "sha512-Ggc3vy7laTb2imRSjK6YvbLqKkSbF1Yl7I5v+yI5BxuwzBe4t8DnQg3Yqn9zs2oQi7X9SsxH7HhyrBqy2UAfSA=="
}
const retainedBridgePackages = Object.entries(retainedBridgeIntegrities).map(([name, integrity]) => ({
  name, integrity, version: retainedBridgeVersion,
  filename: `${name.replace(/^@/, "").replaceAll("/", "-")}-${retainedBridgeVersion}.tgz`,
  url: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${retainedBridgeVersion}.tgz`
}))

// A real external HTTP Seam. Only immutable, public, fixed-integrity historical
// packages are accepted; callers cannot provide alternate URLs or hashes.
async function acquirePinnedPackages(directory, packages, fetchPackage) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const acquired = []
  try {
    for (const item of packages) {
      const signal = AbortSignal.timeout(deadlineMs)
      const response = await fetchPackage(item.url, { signal, redirect: "error", credentials: "omit" })
      const reject = async message => { await response.body?.cancel().catch(() => {}); throw new Error(message) }
      if (!response.ok) await reject(`Historical ${item.name}@${item.version} download failed (${response.status})`)
      const declared = response.headers.get("content-length")
      if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 1 || Number(declared) > activeBridgeBaselineMaximumBytes)) {
        await reject(`Historical ${item.name}@${item.version} archive exceeds its size bound`)
      }
      if (response.body === null) throw new Error(`Historical ${item.name}@${item.version} download has no body`)
      const buffer = Buffer.alloc(activeBridgeBaselineMaximumBytes)
      let bytes = 0
      const reader = response.body.getReader()
      try {
        while (true) {
          signal.throwIfAborted()
          const part = await reader.read()
          if (part.done) break
          const next = bytes + part.value.byteLength
          if (next > activeBridgeBaselineMaximumBytes) throw new Error(`Historical ${item.name}@${item.version} archive exceeds its size bound`)
          buffer.set(part.value, bytes); bytes = next
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const content = buffer.subarray(0, bytes)
      const integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`
      if (bytes === 0 || integrity !== item.integrity) {
        throw new Error(`Historical ${item.name}@${item.version} archive does not match its fixed published integrity`)
      }
      const file = join(directory, item.filename), temporary = `${file}.pending`
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
      await rename(temporary, file)
      acquired.push({ path: file, filename: item.filename, sha256: createHash("sha256").update(content).digest("hex") })
    }
    return acquired
  } catch (cause) {
    // The caller owns this isolated directory. Never leave a half-acquired
    // baseline available for another gate to mistake for historical evidence.
    await Promise.all(packages.flatMap(item => [join(directory, item.filename), join(directory, `${item.filename}.pending`)])
      .map(file => rm(file, { force: true })))
    throw cause
  }
}

export async function acquireActiveBridgeBaselines(directory, fetchPackage = globalThis.fetch) {
  const acquired = await acquirePinnedPackages(directory, baselines, fetchPackage)
  return { cli: acquired[0].path, codex: acquired[1].path, claude: acquired[2].path }
}

export async function acquireRetainedActiveBridgeRelease(directory, fetchPackage = globalThis.fetch) {
  const checksums = join(directory, "SHA256SUMS")
  try {
    const acquired = await acquirePinnedPackages(directory, retainedBridgePackages, fetchPackage)
    const content = acquired.toSorted((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0)
      .map(item => `${item.sha256}  ${item.filename}`).join("\n") + "\n"
    await writeFile(`${checksums}.pending`, content, { flag: "wx", mode: 0o600 })
    await rename(`${checksums}.pending`, checksums)
    return { version: retainedBridgeVersion, directory }
  } catch (cause) {
    await Promise.all([...retainedBridgePackages.flatMap(item => [join(directory, item.filename), join(directory, `${item.filename}.pending`)]),
      checksums, `${checksums}.pending`].map(file => rm(file, { force: true })))
    throw cause
  }
}

export const assertRetainedActiveBridgeReleaseBytes = async bridge => {
  if (bridge.version !== retainedBridgeVersion) throw new Error("Historical acceptance requires the genuine retained 0.5.11 bridge version")
  for (const item of retainedBridgePackages) {
    const content = await readFile(join(bridge.directory, item.filename))
    if (`sha512-${createHash("sha512").update(content).digest("base64")}` !== item.integrity)
      throw new Error(`Retained ${item.name}@${item.version} archive does not match its fixed published integrity`)
  }
}

// .11's bridge acceptance must use genuine .10 bytes. A later feature release
// must explicitly supply retained bridge artifacts, never relabel feature bytes.
export async function verifyActiveBridgeRelease({ version, releaseChannel, releaseDirectory, bridgeRelease, featureRelease, faultPoint, baselineArchives }, fetchPackage = globalThis.fetch) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version)
  if (!parts) throw new Error("Release version must be SemVer")
  const [major, minor, patch] = parts.slice(1).map(Number)
  if (major === 0 && (minor < 5 || (minor === 5 && patch < 11))) return { required: false, reason: "older-release" }
  if (!["legacy-bridge", "target-owned"].includes(releaseChannel)) throw new Error("Active bridge acceptance requires an explicit release channel")
  if (process.platform === "win32") return { required: false, reason: "no-posix-managed-runtime" }
  if (releaseChannel === "target-owned" && !bridgeRelease) throw new Error("Feature acceptance requires retained real bridge artifacts")
  const bridge = releaseChannel === "legacy-bridge" ? { version, directory: releaseDirectory } : bridgeRelease
  const feature = releaseChannel === "target-owned" ? { version, directory: releaseDirectory } : featureRelease
  if (faultPoint && !feature) throw new Error("Installed fault acceptance requires real feature artifacts")
  const root = await mkdtemp(join(tmpdir(), "atape-active-bridge-release-"))
  let failed = false
  try {
    const baseline = baselineArchives ?? await acquireActiveBridgeBaselines(join(root, "baseline"), fetchPackage)
    if (releaseChannel === "target-owned") await assertRetainedActiveBridgeReleaseBytes(bridge)
    const evidence = await verifyActiveBridgeUpgrade(bridge.directory, join(root, "acceptance"), baseline.cli, baseline.codex, baseline.claude, bridge.version,
      feature ? { ...feature, ...(faultPoint ? { faultPoint } : {}) } : undefined)
    return { required: true, evidence }
  } catch (cause) {
    failed = true
    if (process.env.ATAPE_ACCEPTANCE_RETAIN_FAILURE === "1") process.stderr.write(`Owned synthetic acceptance failure retained at ${root}\n`)
    throw cause
  } finally {
    if (!failed || process.env.ATAPE_ACCEPTANCE_RETAIN_FAILURE !== "1") await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const release = await loadReleaseContract(fileURLToPath(new URL("../../..", import.meta.url)))
  const result = await verifyActiveBridgeRelease({ version: release.version, releaseChannel: release.releaseChannel,
    releaseDirectory: process.argv[2] ?? release.releaseDirectory,
    ...(process.argv[5] ? { faultPoint: process.argv[5] } : {}),
    ...(process.argv[3] && process.argv[4] ? { [release.releaseChannel === "legacy-bridge" ? "featureRelease" : "bridgeRelease"]:
      { directory: process.argv[3], version: process.argv[4] } } : {}) })
  process.stdout.write(`Active bridge release gate: ${JSON.stringify(result)}\n`)
}
