import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
const temporaryRoot = await mkdtemp(join(tmpdir(), "atape-codex-package-"))
const artifactDirectory = join(temporaryRoot, "artifact")
const installDirectory = join(temporaryRoot, "install")
const codexHome = join(temporaryRoot, "codex-home")
const projectDirectory = join(temporaryRoot, "project")
const previousCodexHome = process.env.ATAPE_CODEX_HOME

try {
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(join(codexHome, "sessions"), { recursive: true }),
    mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
    mkdir(projectDirectory, { recursive: true })
  ])
  const packed = JSON.parse((await run("npm", [
    "pack", "--json", "--pack-destination", artifactDirectory
  ], packageRoot)).stdout)
  assert.equal(packed.length, 1)
  const manifest = packed[0]
  assert.deepEqual(
    manifest.files.map((file) => file.path).sort(),
    ["LICENSE", "README.md", "dist/index.js", "package.json"]
  )
  assert.ok(manifest.size < 1024 * 1024, `Codex Adapter tarball is unexpectedly large: ${manifest.size} bytes`)

  const tarball = join(artifactDirectory, manifest.filename)
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball
  ], temporaryRoot)
  const installedEntry = join(
    installDirectory,
    "node_modules",
    "@atape",
    "adapter-codex",
    "dist",
    "index.js"
  )
  const adapter = await import(pathToFileURL(installedEntry).href)
  assert.equal(typeof adapter.createAtapeAdapter, "function")

  process.env.ATAPE_CODEX_HOME = codexHome
  const runtime = await adapter.createAtapeAdapter({
    protocolVersion: "atape.adapter.v1alpha1",
    adapter: { id: "codex", version: packageManifest.version },
    user: { id: "package-user" },
    project: { id: "package-project", type: "directory", path: projectDirectory },
    signal: AbortSignal.timeout(5_000)
  })
  const page = await runtime.collect({
    protocolVersion: "atape.adapter.v1alpha1",
    cursor: null,
    limits: {
      observations: 10,
      threadsPerObservation: 100,
      eventsPerObservation: 500,
      canonicalBytesPerObservation: 3 * 1024 * 1024,
      rawSegmentsPerObservation: 16,
      rawSegmentBytes: 4 * 1024 * 1024,
      rawBytesPerObservation: 4 * 1024 * 1024,
      pagesPerCycle: 20
    },
    rawProgress: [],
    signal: AbortSignal.timeout(5_000)
  })
  assert.deepEqual(page.observations, [])
  assert.equal(page.hasMore, false)
  assert.equal(typeof page.nextCursor, "string")

  process.stdout.write(`Verified installable Codex Adapter tarball ${manifest.filename}\n`)
} finally {
  if (previousCodexHome === undefined) delete process.env.ATAPE_CODEX_HOME
  else process.env.ATAPE_CODEX_HOME = previousCodexHome
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function run(file, arguments_, cwd) {
  try {
    return await execute(file, arguments_, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (cause) {
    const detail = cause && typeof cause === "object"
      ? `\nstdout: ${cause.stdout ?? ""}\nstderr: ${cause.stderr ?? ""}`
      : ""
    throw new Error(`${file} ${arguments_.join(" ")} failed${detail}`, { cause })
  }
}
