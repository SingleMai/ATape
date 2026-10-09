import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { freezeClaudeArtifact } from "./freeze-claude-artifact.mjs"
import { freezeClaudeLegacy, legacyClaudeRevision } from "./freeze-claude-legacy.mjs"

const execute = promisify(execFile)
const repository = fileURLToPath(new URL("..", import.meta.url))
const digest = bytes => createHash("sha256").update(bytes).digest("hex")

test("historical Claude builds its own frozen lock despite dirty current sources and dependencies", { timeout: 300_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-freeze-independent-"))
  const root = join(directory, "current"), artifact = join(directory, "artifact")
  try {
    await execute("git", ["clone", "--shared", "--no-checkout", "--quiet", repository, root])
    // Deliberately incompatible current inputs must never become historical
    // build authority, even when the commit is available in this repository.
    await mkdir(join(root, "adapters/claude/src"), { recursive: true })
    await mkdir(join(root, "adapters/claude/node_modules/esbuild"), { recursive: true })
    const dirtyLock = "current-lock-is-not-the-historical-lock\n"
    await writeFile(join(root, "pnpm-lock.yaml"), dirtyLock)
    await writeFile(join(root, "package.json"), '{"name":"current","version":"99.0.0"}')
    await writeFile(join(root, "adapters/claude/src/index.ts"), 'throw new Error("CURRENT_SOURCE_MUST_NOT_BUILD")')
    await writeFile(join(root, "adapters/claude/node_modules/esbuild/package.json"), '{"main":"index.js","version":"99.0.0"}')
    await writeFile(join(root, "adapters/claude/node_modules/esbuild/index.js"), 'throw new Error("CURRENT_DEPENDENCY_MUST_NOT_LOAD")')
    const frozen = await freezeClaudeLegacy({ repository: root, directory: artifact, revision: "HEAD" })
    const { metadata } = frozen
    assert.equal(metadata.revision, legacyClaudeRevision)
    assert.equal(metadata.dependencyMode, "historical-frozen-lock")
    const oldLock = (await execute("git", ["show", `${legacyClaudeRevision}:pnpm-lock.yaml`], { cwd: root, encoding: "buffer" })).stdout
    assert.equal(metadata.lockSha256, digest(oldLock))
    assert.notEqual(metadata.lockSha256, digest(dirtyLock))
    for (const source of metadata.sources) {
      const original = (await execute("git", ["show", `${legacyClaudeRevision}:${source.path}`], { cwd: root, encoding: "buffer" })).stdout
      assert.equal(source.sha256, digest(original), source.path)
    }
    assert.equal(metadata.toolchain.pnpm, "11.7.0")
    assert.equal(metadata.toolchain.effect, "4.0.0-rc.112")
    assert.equal(metadata.toolchain.esbuild, "0.28.2")
    assert.equal(metadata.tarball.sha256, digest(await readFile(frozen.tarball)))
    await execute("tar", ["-xzf", frozen.tarball, "-C", artifact])
    const manifest = JSON.parse(await readFile(join(artifact, "package/package.json"), "utf8"))
    assert.equal(manifest.version, "0.5.2")
    assert.equal(metadata.bundle.sha256, digest(await readFile(join(artifact, "package/dist/index.js"))))
    const foreign = await import(pathToFileURL(join(artifact, "package/dist/index.js")).href)
    const runtime = await foreign.createAtapeAdapter({ protocolVersion: "atape.adapter.v1alpha1",
      adapter: { id: "claude", version: manifest.version }, project: { id: "freeze-test", type: "directory", path: directory },
      signal: new AbortController().signal })
    assert.equal(typeof runtime.collect, "function")
    assert.equal(runtime.sourceCapture, undefined)
    assert.equal(await readFile(join(root, "pnpm-lock.yaml"), "utf8"), dirtyLock)
    await assert.rejects(readFile(join(artifact, "historical-source/pnpm-lock.yaml")), { code: "ENOENT" })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("historical Claude rejects missing history and never substitutes current files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-freeze-missing-"))
  try {
    await execute("git", ["init", "--quiet", directory])
    await writeFile(join(directory, "package.json"), '{"name":"current"}')
    await writeFile(join(directory, "pnpm-lock.yaml"), "current")
    await assert.rejects(freezeClaudeLegacy({ repository: directory }), error =>
      error.reason === "historical_revision" && error.message.includes(legacyClaudeRevision))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("historical artifact Interface rejects current refs and relative artifact paths", async () => {
  await assert.rejects(freezeClaudeArtifact({ revision: "HEAD" }), { reason: "historical_revision" })
  await assert.rejects(freezeClaudeArtifact({ revision: "origin/main" }), { reason: "historical_revision" })
  await assert.rejects(freezeClaudeLegacy({ directory: "relative-directory" }), { reason: "configuration" })
})
