import type { AdapterOpenContext, SourceAdapterRuntime, SourceCaptureRuntimeV2 } from "@atape/domain"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const revision = "a525090395ebddc7e05a0b97ab87cb91e655a11a"
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
type HistoricalProof = {
  revision: string
  sources: Array<{ path: string; bytes: number; sha256: string }>
  lockSha256: string
  dependencyMode: "historical-frozen-lock"
  toolchain: { node: string; pnpm: string; esbuild: string; effect: string }
  bundle: { bytes: number; sha256: string }
  tarball: { path: string; sha256: string; integrity: string }
}

/** Untouched previous source-capture v2 public factory. Build in an isolated
 * directory so current dist/source edits cannot substitute for upgrade evidence. */
export const historicalSourceCaptureFactory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-claude-public-v2-")), execute = promisify(execFile)
  try {
    const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("../../../../scripts/freeze-claude-artifact.mjs", import.meta.url)),
      "--revision", revision, "--directory", directory], { maxBuffer: 1024 * 1024, timeout: 300_000 })
    const proof = JSON.parse(stdout) as HistoricalProof
    if (proof.revision !== revision || proof.dependencyMode !== "historical-frozen-lock")
      throw new Error("Historical v2 artifact differs from its frozen source and dependency authority.")
    if (digest(await readFile(proof.tarball.path)) !== proof.tarball.sha256)
      throw new Error("Historical v2 tarball differs from its frozen proof.")
    await execute("tar", ["-xzf", proof.tarball.path, "-C", directory], { timeout: 30_000 })
    const entry = join(directory, "package", "dist", "index.js"), bundle = await readFile(entry)
    if (bundle.length !== proof.bundle.bytes || digest(bundle) !== proof.bundle.sha256)
      throw new Error("Historical v2 public bundle differs from its frozen proof.")
    const foreign = await import(pathToFileURL(entry).href) as {
      createAtapeAdapter: (context: AdapterOpenContext & { signal: AbortSignal }) => Promise<SourceAdapterRuntime<SourceCaptureRuntimeV2>>
    }
    if (typeof foreign.createAtapeAdapter !== "function") throw new Error("Historical v2 public factory is missing.")
    return { ...foreign, proof, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (cause) { await rm(directory, { recursive: true, force: true }); throw cause }
}
