import type { AdapterOpenContext, SourceAdapterRuntime, SourceCaptureRuntimeV2 } from "@atape/domain"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const revision = "a525090395ebddc7e05a0b97ab87cb91e655a11a"
const repository = fileURLToPath(new URL("../../../..", import.meta.url))
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Untouched previous source-capture v2 public factory. Build in an isolated
 * directory so current dist/source edits cannot substitute for upgrade evidence. */
export const historicalSourceCaptureFactory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-claude-public-v2-")), execute = promisify(execFile)
  const git = async (args: string[]) => (await execute("git", args, {
    cwd: repository, encoding: "buffer", maxBuffer: 16 * 1024 * 1024
  })).stdout
  try {
    await git(["cat-file", "-e", `${revision}^{commit}`])
    const show = (path: string) => git(["show", `${revision}:${path}`])
    const lock = await show("pnpm-lock.yaml")
    if (!lock.equals(await readFile(join(repository, "pnpm-lock.yaml"))))
      throw new Error("Historical v2 requires its pinned dependency lock; changed dependencies cannot replace this artifact.")
    const require = createRequire(join(repository, "adapters/claude/package.json"))
    const esbuild = require("esbuild") as typeof import("esbuild")
    const effect = JSON.parse(await readFile(join(repository, "adapters/claude/node_modules/effect/package.json"), "utf8")) as { version: string }
    const catalog = (await show("pnpm-workspace.yaml")).toString("utf8")
    if (!catalog.includes(`effect: ${effect.version}\n`) || !catalog.includes(`esbuild: ${esbuild.version}\n`))
      throw new Error("Installed toolchain differs from historical v2 dependency pins.")
    const paths = (await git(["ls-tree", "-r", "--name-only", revision, "--",
      "adapters/claude/src", "packages/domain/src", "packages/adapter-catalog/src"]))
      .toString("utf8").trim().split("\n").filter(path => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes("/fixtures/"))
    const sources = []
    for (const path of paths) {
      const bytes = await show(path), target = join(directory, path)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
      sources.push({ path, bytes: bytes.length, sha256: digest(bytes) })
    }
    const entry = join(directory, "historical-adapter.mjs")
    await esbuild.build({ absWorkingDir: join(directory, "adapters/claude"), entryPoints: ["src/index.ts"], outfile: entry,
      bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "eof", logLevel: "silent",
      nodePaths: [join(repository, "adapters/claude/node_modules"), join(repository, "packages/domain/node_modules")],
      alias: { "@atape/domain": join(directory, "packages/domain/src/index.ts"),
        "@atape/adapter-catalog/node": join(directory, "packages/adapter-catalog/src/node.ts") } })
    const bundle = await readFile(entry)
    const proof = { revision, sources, lockSha256: digest(lock), bundle: { bytes: bundle.length, sha256: digest(bundle) },
      toolchain: { node: process.version, esbuild: esbuild.version, effect: effect.version } }
    await writeFile(join(directory, "provenance.json"), JSON.stringify(proof, null, 2) + "\n")
    const foreign = await import(pathToFileURL(entry).href) as {
      createAtapeAdapter: (context: AdapterOpenContext & { signal: AbortSignal }) => Promise<SourceAdapterRuntime<SourceCaptureRuntimeV2>>
    }
    if (typeof foreign.createAtapeAdapter !== "function") throw new Error("Historical v2 public factory is missing.")
    return { ...foreign, proof, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (cause) { await rm(directory, { recursive: true, force: true }); throw cause }
}
