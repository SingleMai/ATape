import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const root = await mkdtemp(join(tmpdir(), "atape-opencode-package-"))
const artifacts = join(root, "artifacts"), installed = join(root, "installed")
const run = (file, args, cwd) => execute(file, args, { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
try {
  await mkdir(artifacts)
  const [packed] = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", artifacts], packageRoot)).stdout)
  assert.deepEqual(packed.files.map(file => file.path).sort(), ["LICENSE", "README.md", "dist/index.js", "package.json"])
  assert.ok(packed.size < 1024 * 1024, `Unexpected tarball size: ${packed.size}`)
  await run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, join(artifacts, packed.filename)], root)
  const entryRoot = join(installed, "node_modules", "@atape", "adapter-opencode")
  const manifest = JSON.parse(await readFile(join(entryRoot, "package.json"), "utf8"))
  assert.equal(manifest.private, true)
  assert.equal(manifest.version, "0.0.0")
  assert.equal(manifest.dependencies, undefined, "The installed Adapter must be self-contained")
  assert.equal(manifest.atapeAdapter.sourceCapture, "atape.source-capture.v1")
  assert.equal(manifest.atapeAdapter.gitAttribution, "atape.git-attribution.v1")
  assert.equal(manifest.atapeAdapter.adapterId, "opencode")
  assert.equal(manifest.atapeAdapter.protocolVersion, "atape.adapter.v1alpha1")
  assert.equal(manifest.exports["."], manifest.atapeAdapter.entry)
  // Copy both inputs out of the workspace. The child imports only the installed
  // bundle and Node builtins; workspace module resolution cannot rescue it.
  await copyFile(new URL("./verify-installed.mjs", import.meta.url), join(root, "verify-installed.mjs"))
  await copyFile(new URL("../src/fixtures/native-v1.json", import.meta.url), join(root, "native-v1.json"))
  const result = await run(process.execPath, [join(root, "verify-installed.mjs"), join(entryRoot, manifest.atapeAdapter.entry)], root)
  process.stdout.write(`Verified private OpenCode tarball ${packed.filename} (${packed.size} bytes)\n${result.stdout}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
