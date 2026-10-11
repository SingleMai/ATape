import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadReleaseContract } from "../../../scripts/release-contract.mjs"
import { toolIdentityBaselineIntegrities, verifyToolIdentityUpgrade } from "./verify-tool-identity-upgrade.mjs"

export const toolIdentityBaselineMaximumBytes = 8 * 1024 * 1024
const deadlineMs = 30_000
const baselines = [
  { name: "@atape/cli", filename: "cli-0.5.8.tgz", url: "https://registry.npmjs.org/@atape/cli/-/cli-0.5.8.tgz" },
  { name: "@atape/adapter-claude", filename: "adapter-claude-0.5.8.tgz", url: "https://registry.npmjs.org/@atape/adapter-claude/-/adapter-claude-0.5.8.tgz" }
]

// A real external HTTP Seam. Only immutable, public, fixed-integrity historical
// packages are accepted; callers cannot provide alternate URLs or hashes.
export async function acquireToolIdentityBaselines(directory, fetchPackage = globalThis.fetch) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const acquired = []
  try {
    for (const item of baselines) {
      const signal = AbortSignal.timeout(deadlineMs)
      const response = await fetchPackage(item.url, { signal, redirect: "error", credentials: "omit" })
      const reject = async message => { await response.body?.cancel().catch(() => {}); throw new Error(message) }
      if (!response.ok) await reject(`Historical ${item.name}@0.5.8 download failed (${response.status})`)
      const declared = response.headers.get("content-length")
      if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 1 || Number(declared) > toolIdentityBaselineMaximumBytes)) {
        await reject(`Historical ${item.name}@0.5.8 archive exceeds its size bound`)
      }
      if (response.body === null) throw new Error(`Historical ${item.name}@0.5.8 download has no body`)
      const buffer = Buffer.alloc(toolIdentityBaselineMaximumBytes)
      let bytes = 0
      const reader = response.body.getReader()
      try {
        while (true) {
          signal.throwIfAborted()
          const part = await reader.read()
          if (part.done) break
          const next = bytes + part.value.byteLength
          if (next > toolIdentityBaselineMaximumBytes) throw new Error(`Historical ${item.name}@0.5.8 archive exceeds its size bound`)
          buffer.set(part.value, bytes); bytes = next
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const content = buffer.subarray(0, bytes)
      const integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`
      if (bytes === 0 || integrity !== toolIdentityBaselineIntegrities[item.name]) {
        throw new Error(`Historical ${item.name}@0.5.8 archive does not match its fixed published integrity`)
      }
      const file = join(directory, item.filename), temporary = `${file}.pending`
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
      await rename(temporary, file)
      acquired.push(file)
    }
    return { cli: acquired[0], claude: acquired[1] }
  } catch (cause) {
    // The caller owns this isolated directory. Never leave a half-acquired
    // baseline available for another gate to mistake for historical evidence.
    await Promise.all(baselines.flatMap(item => [join(directory, item.filename), join(directory, `${item.filename}.pending`)])
      .map(file => rm(file, { force: true })))
    throw cause
  }
}

// Version-limited transition evidence. Windows has no POSIX PTY contract here;
// every supported .9 POSIX run is mandatory, with no environment skip override.
export async function verifyToolIdentityRelease({ version, releaseDirectory }, fetchPackage = globalThis.fetch) {
  if (version !== "0.5.9") return { required: false, reason: "other-release" }
  if (process.platform === "win32") return { required: false, reason: "no-posix-pty" }
  const root = await mkdtemp(join(tmpdir(), "atape-tool-identity-release-"))
  try {
    const baseline = await acquireToolIdentityBaselines(join(root, "baseline"), fetchPackage)
    const evidence = await verifyToolIdentityUpgrade(releaseDirectory, join(root, "acceptance"), baseline.cli, baseline.claude)
    return { required: true, evidence }
  } finally { await rm(root, { recursive: true, force: true }) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const release = await loadReleaseContract(fileURLToPath(new URL("../../..", import.meta.url)))
  const result = await verifyToolIdentityRelease({ version: release.version, releaseDirectory: process.argv[2] ?? release.releaseDirectory })
  process.stdout.write(`Tool identity release gate: ${JSON.stringify(result)}\n`)
}
