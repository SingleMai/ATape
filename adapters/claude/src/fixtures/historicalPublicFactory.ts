import type { AdapterOpenContext, LegacyAdapterRuntime } from "@atape/domain"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/** Genuine previous public package, built from its pinned Git revision by the
 * reproducible release fixture. No current private parser is exposed to tests. */
export const historicalPublicFactory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-claude-public-legacy-")), execute = promisify(execFile)
  try {
    const { stdout } = await execute(process.execPath, [new URL("../../../../scripts/freeze-claude-legacy.mjs", import.meta.url).pathname,
      "--directory", directory], { maxBuffer: 1024 * 1024, timeout: 300000 })
    const proof = JSON.parse(stdout) as { revision: string; tarball: { path: string }; bundle: { sha256: string } }
    if (proof.revision !== "f6093535e92acfee47170b53c7dec7244fccf8c7") throw new Error("Historical factory revision differs")
    await execute("tar", ["-xzf", proof.tarball.path, "-C", directory])
    const foreign = await import(pathToFileURL(join(directory, "package", "dist", "index.js")).href) as {
      createAtapeAdapter: (context: AdapterOpenContext & { signal: AbortSignal }) => Promise<LegacyAdapterRuntime>
    }
    if (typeof foreign.createAtapeAdapter !== "function") throw new Error("Historical public factory is missing")
    return { ...foreign, proof, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (cause) { await rm(directory, { recursive: true, force: true }); throw cause }
}
