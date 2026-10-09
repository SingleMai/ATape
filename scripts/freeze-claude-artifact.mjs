import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const supportedRevisions = new Set(["f6093535e92acfee47170b53c7dec7244fccf8c7", "a525090395ebddc7e05a0b97ab87cb91e655a11a"])
const repository = fileURLToPath(new URL("..", import.meta.url))
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
export class ClaudeLegacyFreezeError extends Error {
  constructor(reason, message, cause) { super(message, { cause }); this.name = "ClaudeLegacyFreezeError"; this.reason = reason }
}

/** Build untouched historical sources, never a renamed current package. The
 * caller owns the returned lifetime, including after a failed Go contract. */
export async function freezeClaudeArtifact(options = {}) {
  const revision = options.revision
  if (!supportedRevisions.has(revision)) throw new ClaudeLegacyFreezeError("historical_revision", "A pinned supported historical Claude revision is required; current refs and sources cannot replace this evidence.")
  const root = options.repository ?? repository
  const owned = options.directory === undefined
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "atape-claude-legacy-"))
  if (!isAbsolute(directory)) throw new ClaudeLegacyFreezeError("configuration", "Legacy artifact directory must be absolute.")
  const checkout = join(directory, "historical-source")
  const git = args => execute("git", args, { cwd: root, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })
  try {
    try { await git(["cat-file", "-e", `${revision}^{commit}`]) }
    catch (cause) {
      throw new ClaudeLegacyFreezeError("historical_revision", `Required genuine Claude legacy commit ${revision} is unavailable. Fetch repository history (git fetch --unshallow, or git fetch origin ${revision}) and retry; current sources cannot replace this evidence.`, cause)
    }
    const show = async path => (await git(["show", `${revision}:${path}`])).stdout
    const lock = await show("pnpm-lock.yaml")
    // The current workspace can add or upgrade dependencies independently. Its
    // node_modules and lock are never authority for this historical artifact.
    const tree = (await git(["ls-tree", "-r", "--name-only", revision])).stdout.toString("utf8").trim().split("\n")
    const listed = (await git(["ls-tree", "-r", "--name-only", revision, "--", "adapters/claude/src", "packages/domain/src", "packages/adapter-catalog/src"])).stdout.toString("utf8").trim().split("\n")
      .filter(path => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes("/fixtures/"))
    const manifests = tree.filter(path => /^(?:apps|adapters|packages)\/[^/]+\/package\.json$/.test(path))
    const paths = [...new Set(["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ...manifests,
      "adapters/claude/README.md", "adapters/claude/LICENSE", ...listed])]
    const sources = []
    for (const path of paths) {
      const bytes = await show(path), destination = join(checkout, path)
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes)
      sources.push({ path, bytes: bytes.length, sha256: sha256(bytes) })
    }
    const packageRoot = join(checkout, "adapters/claude")
    const installArgs = ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@atape/adapter-claude..."]
    const install = args => execute("pnpm", args, { cwd: checkout, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })
    try {
      try { await install([...installArgs, "--offline"]) }
      catch (cause) {
        const output = `${cause.stdout ?? ""}\n${cause.stderr ?? ""}`
        if (!/ERR_PNPM_NO_OFFLINE_(?:META|TARBALL)/.test(output)) throw cause
        await install(installArgs)
      }
    } catch (cause) {
      throw new ClaudeLegacyFreezeError("dependencies", "Could not install the genuine historical dependency lock in isolation; no current dependency fallback was used.", cause)
    }
    // Frozen install must not silently rewrite any historical input.
    for (const source of sources) assert.equal(sha256(await readFile(join(checkout, source.path))), source.sha256)
    const require = createRequire(join(packageRoot, "package.json"))
    const esbuild = require("esbuild")
    const effect = JSON.parse(await readFile(join(packageRoot, "node_modules/effect/package.json"), "utf8"))
    const catalog = (await readFile(join(checkout, "pnpm-workspace.yaml"))).toString("utf8")
    const pnpm = (await execute("pnpm", ["--version"], { cwd: checkout, encoding: "utf8", timeout: 30_000 })).stdout.trim()
    const manifest = JSON.parse(await readFile(join(checkout, "package.json"), "utf8"))
    if (manifest.packageManager !== `pnpm@${pnpm}` || !catalog.includes(`effect: ${effect.version}\n`) || !catalog.includes(`esbuild: ${esbuild.version}\n`))
      throw new ClaudeLegacyFreezeError("dependencies", "Isolated toolchain differs from the historical dependency pins; no current dependency fallback was used.")
    const built = await esbuild.build({ absWorkingDir: packageRoot, entryPoints: ["src/index.ts"], outfile: "dist/index.js",
      bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "eof", logLevel: "silent", metafile: true,
      nodePaths: [join(packageRoot, "node_modules"), join(checkout, "packages/domain/node_modules")],
      alias: { "@atape/domain": join(checkout, "packages/domain/src/index.ts"),
        "@atape/adapter-catalog/node": join(checkout, "packages/adapter-catalog/src/node.ts") } })
    for (const input of Object.keys(built.metafile.inputs)) {
      const local = relative(checkout, resolve(packageRoot, input))
      if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
        throw new ClaudeLegacyFreezeError("dependencies", "Historical build resolved an input outside its isolated checkout; current sources or dependencies cannot replace this evidence.")
    }
    const packed = JSON.parse((await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
      cwd: packageRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000
    })).stdout)
    assert.equal(packed.length, 1)
    assert.deepEqual(packed[0].files.map(file => file.path).sort(), ["LICENSE", "README.md", "dist/index.js", "package.json"])
    const tarball = join(directory, packed[0].filename), bundle = await readFile(join(packageRoot, "dist/index.js"))
    const metadata = { revision, sources, lockSha256: sha256(lock), dependencyMode: "historical-frozen-lock",
      toolchain: { node: process.version, pnpm, esbuild: esbuild.version, effect: effect.version },
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
  if (process.argv.length !== 6 || process.argv[2] !== "--revision" || process.argv[4] !== "--directory") {
    console.error("Use node scripts/freeze-claude-artifact.mjs --revision PINNED_SHA --directory /absolute/artifact-directory")
    process.exitCode = 1
  } else freezeClaudeArtifact({ revision: process.argv[3], directory: process.argv[5] }).then(result => console.log(JSON.stringify(result.metadata))).catch(error => {
    console.error(`${error.name}[${error.reason}]: ${error.message}`); process.exitCode = 1
  })
}
