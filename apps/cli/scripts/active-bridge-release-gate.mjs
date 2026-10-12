import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
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
]

// A real external HTTP Seam. Only immutable, public, fixed-integrity historical
// packages are accepted; callers cannot provide alternate URLs or hashes.
export async function acquireActiveBridgeBaselines(directory, fetchPackage = globalThis.fetch) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const acquired = []
  try {
    for (const item of baselines) {
      const signal = AbortSignal.timeout(deadlineMs)
      const response = await fetchPackage(item.url, { signal, redirect: "error", credentials: "omit" })
      const reject = async message => { await response.body?.cancel().catch(() => {}); throw new Error(message) }
      if (!response.ok) await reject(`Historical ${item.name}@0.5.10 download failed (${response.status})`)
      const declared = response.headers.get("content-length")
      if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 1 || Number(declared) > activeBridgeBaselineMaximumBytes)) {
        await reject(`Historical ${item.name}@0.5.10 archive exceeds its size bound`)
      }
      if (response.body === null) throw new Error(`Historical ${item.name}@0.5.10 download has no body`)
      const buffer = Buffer.alloc(activeBridgeBaselineMaximumBytes)
      let bytes = 0
      const reader = response.body.getReader()
      try {
        while (true) {
          signal.throwIfAborted()
          const part = await reader.read()
          if (part.done) break
          const next = bytes + part.value.byteLength
          if (next > activeBridgeBaselineMaximumBytes) throw new Error(`Historical ${item.name}@0.5.10 archive exceeds its size bound`)
          buffer.set(part.value, bytes); bytes = next
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const content = buffer.subarray(0, bytes)
      const integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`
      if (bytes === 0 || integrity !== activeBridgeBaselineIntegrities[item.name]) {
        throw new Error(`Historical ${item.name}@0.5.10 archive does not match its fixed published integrity`)
      }
      const file = join(directory, item.filename), temporary = `${file}.pending`
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
      await rename(temporary, file)
      acquired.push(file)
    }
    return { cli: acquired[0], codex: acquired[1], claude: acquired[2] }
  } catch (cause) {
    // The caller owns this isolated directory. Never leave a half-acquired
    // baseline available for another gate to mistake for historical evidence.
    await Promise.all(baselines.flatMap(item => [join(directory, item.filename), join(directory, `${item.filename}.pending`)])
      .map(file => rm(file, { force: true })))
    throw cause
  }
}

// .11's bridge acceptance must use genuine .10 bytes. A later feature release
// must explicitly supply retained bridge artifacts, never relabel feature bytes.
export async function verifyActiveBridgeRelease({ version, releaseChannel, releaseDirectory, bridgeRelease, featureRelease, faultPoint }, fetchPackage = globalThis.fetch) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version)
  if (!parts) throw new Error("Release version must be SemVer")
  const [major, minor, patch] = parts.slice(1).map(Number)
  if (major === 0 && (minor < 5 || (minor === 5 && patch < 11))) return { required: false, reason: "older-release" }
  if (!["legacy-bridge", "target-owned"].includes(releaseChannel)) throw new Error("Active bridge acceptance requires an explicit release channel")
  if (releaseChannel === "target-owned" && !bridgeRelease) throw new Error("Feature acceptance requires retained real bridge artifacts")
  if (process.platform === "win32") return { required: false, reason: "no-posix-managed-runtime" }
  const bridge = releaseChannel === "legacy-bridge" ? { version, directory: releaseDirectory } : bridgeRelease
  const feature = releaseChannel === "target-owned" ? { version, directory: releaseDirectory } : featureRelease
  if (faultPoint && !feature) throw new Error("Installed fault acceptance requires real feature artifacts")
  const root = await mkdtemp(join(tmpdir(), "atape-active-bridge-release-"))
  let failed = false
  try {
    const baseline = await acquireActiveBridgeBaselines(join(root, "baseline"), fetchPackage)
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
