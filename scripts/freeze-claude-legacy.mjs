import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
export const legacyClaudeRevision = "f6093535e92acfee47170b53c7dec7244fccf8c7"
const repository = fileURLToPath(new URL("..", import.meta.url))
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
export class ClaudeLegacyFreezeError extends Error {
  constructor(reason, message, cause) { super(message, { cause }); this.name = "ClaudeLegacyFreezeError"; this.reason = reason }
}

/** Build untouched historical sources, never a renamed current package. The
 * caller owns the returned lifetime, including after a failed Go contract. */
export async function freezeClaudeLegacy(options = {}) {
  const root = options.repository ?? repository
  const owned = options.directory === undefined
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "atape-claude-legacy-"))
  if (!isAbsolute(directory)) throw new ClaudeLegacyFreezeError("configuration", "Legacy artifact directory must be absolute.")
  const checkout = join(directory, "historical-source")
  const git = args => execute("git", args, { cwd: root, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })
  try {
    try { await git(["cat-file", "-e", `${legacyClaudeRevision}^{commit}`]) }
    catch (cause) {
      throw new ClaudeLegacyFreezeError("historical_revision", `Required genuine Claude legacy commit ${legacyClaudeRevision} is unavailable. Fetch repository history (git fetch --unshallow, or git fetch origin ${legacyClaudeRevision}) and retry; current sources cannot replace this evidence.`, cause)
    }
    const show = async path => (await git(["show", `${legacyClaudeRevision}:${path}`])).stdout
    const lock = await show("pnpm-lock.yaml")
    if (!lock.equals(await readFile(join(root, "pnpm-lock.yaml"))))
      throw new ClaudeLegacyFreezeError("dependencies", "Historical Claude requires its pinned dependency lock. Install/build that historical lock in isolation before updating this gate; do not bundle old sources against changed dependencies.")
    const require = createRequire(join(root, "adapters/claude/package.json"))
    const esbuild = require("esbuild")
    const effect = JSON.parse(await readFile(join(root, "adapters/claude/node_modules/effect/package.json"), "utf8"))
    const catalog = (await show("pnpm-workspace.yaml")).toString("utf8")
    if (!catalog.includes(`effect: ${effect.version}\n`) || !catalog.includes(`esbuild: ${esbuild.version}\n`))
      throw new ClaudeLegacyFreezeError("dependencies", "Installed Effect/esbuild versions differ from the historical Claude dependency pins. Run pnpm install --frozen-lockfile.")
    const listed = (await git(["ls-tree", "-r", "--name-only", legacyClaudeRevision, "--", "packages/domain/src", "packages/adapter-catalog/src"])).stdout.toString("utf8").trim().split("\n")
      .filter(path => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    const paths = ["adapters/claude/src/index.ts", "adapters/claude/src/claudeArchive.ts", "adapters/claude/package.json", "adapters/claude/README.md", "adapters/claude/LICENSE", ...listed]
    const sources = []
    for (const path of paths) {
      const bytes = await show(path), destination = join(checkout, path)
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes)
      sources.push({ path, bytes: bytes.length, sha256: sha256(bytes) })
    }
    const packageRoot = join(checkout, "adapters/claude")
    await esbuild.build({ absWorkingDir: packageRoot, entryPoints: ["src/index.ts"], outfile: "dist/index.js",
      bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "eof", logLevel: "silent",
      nodePaths: [join(root, "adapters/claude/node_modules"), join(root, "packages/domain/node_modules")],
      alias: { "@atape/domain": join(checkout, "packages/domain/src/index.ts"),
        "@atape/adapter-catalog/node": join(checkout, "packages/adapter-catalog/src/node.ts") } })
    const packed = JSON.parse((await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
      cwd: packageRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000
    })).stdout)
    assert.equal(packed.length, 1)
    assert.deepEqual(packed[0].files.map(file => file.path).sort(), ["LICENSE", "README.md", "dist/index.js", "package.json"])
    const tarball = join(directory, packed[0].filename), bundle = await readFile(join(packageRoot, "dist/index.js"))
    const metadata = { revision: legacyClaudeRevision, sources, lockSha256: sha256(lock),
      toolchain: { node: process.version, esbuild: esbuild.version, effect: effect.version },
      bundle: { bytes: bundle.length, sha256: sha256(bundle) },
      tarball: { path: tarball, sha256: sha256(await readFile(tarball)), integrity: packed[0].integrity } }
    await writeFile(join(directory, "legacy-provenance.json"), JSON.stringify(metadata, null, 2) + "\n")
    await rm(checkout, { recursive: true, force: true })
    return { tarball, metadata, cleanup: () => owned ? rm(directory, { recursive: true, force: true }) : Promise.resolve() }
  } catch (cause) {
    await rm(checkout, { recursive: true, force: true })
    if (owned) await rm(directory, { recursive: true, force: true })
    if (cause instanceof ClaudeLegacyFreezeError) throw cause
    throw new ClaudeLegacyFreezeError("artifact", "Could not freeze the genuine historical Claude artifact.", cause)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--directory") {
    console.error("Use node scripts/freeze-claude-legacy.mjs --directory /absolute/artifact-directory")
    process.exitCode = 1
  } else freezeClaudeLegacy({ directory: process.argv[3] }).then(result => console.log(JSON.stringify(result.metadata))).catch(error => {
    console.error(`${error.name}[${error.reason}]: ${error.message}`); process.exitCode = 1
  })
}
