import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadReleaseContract } from "../../../scripts/release-contract.mjs"
import { codexClockBaselineIntegrities, verifyCodexClockUpgrade } from "./verify-codex-clock-upgrade.mjs"

export const codexClockBaselineMaximumBytes = 8 * 1024 * 1024
const deadlineMs = 30_000
const baselines = [
  { name: "@atape/cli", filename: "cli-0.5.9.tgz", url: "https://registry.npmjs.org/@atape/cli/-/cli-0.5.9.tgz" },
  { name: "@atape/adapter-codex", filename: "adapter-codex-0.5.9.tgz", url: "https://registry.npmjs.org/@atape/adapter-codex/-/adapter-codex-0.5.9.tgz" }
]

// A real external HTTP Seam. Only immutable, public, fixed-integrity historical
// packages are accepted; callers cannot provide alternate URLs or hashes.
export async function acquireCodexClockBaselines(directory, fetchPackage = globalThis.fetch) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const acquired = []
  try {
    for (const item of baselines) {
      const signal = AbortSignal.timeout(deadlineMs)
      const response = await fetchPackage(item.url, { signal, redirect: "error", credentials: "omit" })
      const reject = async message => { await response.body?.cancel().catch(() => {}); throw new Error(message) }
      if (!response.ok) await reject(`Historical ${item.name}@0.5.9 download failed (${response.status})`)
      const declared = response.headers.get("content-length")
      if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 1 || Number(declared) > codexClockBaselineMaximumBytes)) {
        await reject(`Historical ${item.name}@0.5.9 archive exceeds its size bound`)
      }
      if (response.body === null) throw new Error(`Historical ${item.name}@0.5.9 download has no body`)
      const buffer = Buffer.alloc(codexClockBaselineMaximumBytes)
      let bytes = 0
      const reader = response.body.getReader()
      try {
        while (true) {
          signal.throwIfAborted()
          const part = await reader.read()
          if (part.done) break
          const next = bytes + part.value.byteLength
          if (next > codexClockBaselineMaximumBytes) throw new Error(`Historical ${item.name}@0.5.9 archive exceeds its size bound`)
          buffer.set(part.value, bytes); bytes = next
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const content = buffer.subarray(0, bytes)
      const integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`
      if (bytes === 0 || integrity !== codexClockBaselineIntegrities[item.name]) {
        throw new Error(`Historical ${item.name}@0.5.9 archive does not match its fixed published integrity`)
      }
      const file = join(directory, item.filename), temporary = `${file}.pending`
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
      await rename(temporary, file)
      acquired.push(file)
    }
    return { cli: acquired[0], codex: acquired[1] }
  } catch (cause) {
    // The caller owns this isolated directory. Never leave a half-acquired
    // baseline available for another gate to mistake for historical evidence.
    await Promise.all(baselines.flatMap(item => [join(directory, item.filename), join(directory, `${item.filename}.pending`)])
      .map(file => rm(file, { force: true })))
    throw cause
  }
}

// Every release at or beyond the first clock-profile release must exercise the
// genuine old parent transition on POSIX; no environment skip override exists.
export async function verifyCodexClockRelease({ version, releaseDirectory, releaseChannel, bridgeRelease }, fetchPackage = globalThis.fetch) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version)
  if (!parts) throw new Error("Release version must be SemVer")
  const [major, minor, patch] = parts.slice(1).map(Number)
  if (major === 0 && (minor < 5 || (minor === 5 && patch < 10))) return { required: false, reason: "older-release" }
  if (process.platform === "win32") return { required: false, reason: "no-posix-pty" }
  const root = await mkdtemp(join(tmpdir(), "atape-codex-clock-release-"))
  try {
    const baseline = await acquireCodexClockBaselines(join(root, "baseline"), fetchPackage)
    let evidence
    if (releaseChannel === "target-owned") {
      const { acquireRetainedActiveBridgeRelease, assertRetainedActiveBridgeReleaseBytes } = await import("./active-bridge-release-gate.mjs")
      const bridge = bridgeRelease ?? await acquireRetainedActiveBridgeRelease(join(root, "retained-bridge"), fetchPackage)
      await assertRetainedActiveBridgeReleaseBytes(bridge)
      evidence = await verifyCodexClockUpgrade(bridge.directory, join(root, "acceptance"), baseline.cli, baseline.codex, bridge.version,
        { directory: releaseDirectory, version })
    } else {
      evidence = await verifyCodexClockUpgrade(releaseDirectory, join(root, "acceptance"), baseline.cli, baseline.codex, version)
    }
    return { required: true, evidence }
  } finally { await rm(root, { recursive: true, force: true }) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const release = await loadReleaseContract(fileURLToPath(new URL("../../..", import.meta.url)))
  const result = await verifyCodexClockRelease({ version: release.version, releaseChannel: release.releaseChannel,
    releaseDirectory: process.argv[2] ?? release.releaseDirectory })
  process.stdout.write(`Codex clock release gate: ${JSON.stringify(result)}\n`)
}
