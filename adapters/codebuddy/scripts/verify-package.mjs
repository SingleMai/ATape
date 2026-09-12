import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const root = await mkdtemp(join(tmpdir(), "atape-codebuddy-package-"))
const artifacts = join(root, "artifacts"), installed = join(root, "installed")
const run = (file, args, cwd) => execute(file, args, { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
try {
  await mkdir(artifacts)
  // Release verification supplies the exact checksummed artifact. Only standalone
  // verification builds a new bundle; neither path runs installed lifecycle scripts.
  const artifact = process.argv[2] ? resolve(process.argv[2]) : join(artifacts,
    JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", artifacts], packageRoot)).stdout)[0].filename)
  const files = (await run("tar", ["-tzf", artifact], root)).stdout.trim().split("\n").map(path => path.replace(/^package\//, ""))
  assert.deepEqual(files.sort(), ["LICENSE", "README.md", "dist/index.js", "package.json"])
  const size = (await stat(artifact)).size
  assert.ok(size < 1024 * 1024, `Unexpected tarball size: ${size}`)
  await run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, artifact], root)
  const entryRoot = join(installed, "node_modules", "@atape", "adapter-codebuddy")
  const manifest = JSON.parse(await readFile(join(entryRoot, "package.json"), "utf8"))
  const expected = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  assert.notEqual(manifest.private, true)
  assert.equal(manifest.name, "@atape/adapter-codebuddy")
  assert.equal(manifest.version, expected.version)
  assert.deepEqual(manifest.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" })
  assert.deepEqual(manifest.repository, expected.repository)
  assert.equal(manifest.dependencies, undefined, "The installed Adapter must be self-contained")
  assert.equal(manifest.atapeAdapter.sourceCapture, "atape.source-capture.v1")
  assert.equal(manifest.atapeAdapter.gitAttribution, "atape.git-attribution.v1")
  assert.equal(manifest.atapeAdapter.adapterId, "codebuddy")
  assert.equal(manifest.atapeAdapter.protocolVersion, "atape.adapter.v1alpha1")
  assert.equal(manifest.exports["."], manifest.atapeAdapter.entry)
  // Copy both inputs out of the workspace. The child imports only the installed
  // bundle and Node builtins; workspace module resolution cannot rescue it.
  await copyFile(new URL("./verify-installed.mjs", import.meta.url), join(root, "verify-installed.mjs"))
  await copyFile(new URL("../src/fixtures/native-2.124.0.jsonl", import.meta.url), join(root, "native-2.124.0.jsonl"))
  const result = await run(process.execPath, [join(root, "verify-installed.mjs"), join(entryRoot, manifest.atapeAdapter.entry), manifest.version], root)
  process.stdout.write(`Verified CodeBuddy tarball ${basename(artifact)} (${size} bytes)\n${result.stdout}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
