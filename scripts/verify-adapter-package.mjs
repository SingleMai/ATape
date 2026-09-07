import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const packageRoot = process.cwd()
const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
const adapterId = packageManifest.atapeAdapter.adapterId
assert.ok(["codex", "claude"].includes(adapterId))
const sourceHomeVariable = adapterId === "codex" ? "ATAPE_CODEX_HOME" : "ATAPE_CLAUDE_HOME"
const previousSelectedFile = process.env.ATAPE_CLAUDE_SESSION_FILE
const temporaryRoot = await mkdtemp(join(tmpdir(), `atape-${adapterId}-package-`))
const artifactDirectory = join(temporaryRoot, "artifact")
const installDirectory = join(temporaryRoot, "install")
const sourceHome = join(temporaryRoot, "source-home")
const projectDirectory = join(temporaryRoot, "project")
const previousSourceHome = process.env[sourceHomeVariable]

try {
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(join(sourceHome, "sessions"), { recursive: true }),
    mkdir(join(sourceHome, "archived_sessions"), { recursive: true }),
    mkdir(join(sourceHome, "projects"), { recursive: true }),
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
  assert.ok(manifest.size < 1024 * 1024, `${adapterId} Adapter tarball is unexpectedly large: ${manifest.size} bytes`)

  const tarball = join(artifactDirectory, manifest.filename)
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball
  ], temporaryRoot)
  const installedEntry = join(
    installDirectory,
    "node_modules",
    "@atape",
    `adapter-${adapterId}`,
    "dist",
    "index.js"
  )
  const adapter = await import(pathToFileURL(installedEntry).href)
  assert.equal(typeof adapter.createAtapeAdapter, "function")

  process.env.ATAPE_CLAUDE_SESSION_FILE = ""
  process.env[sourceHomeVariable] = sourceHome
  const runtime = await adapter.createAtapeAdapter({
    protocolVersion: "atape.adapter.v1alpha1",
    adapter: { id: adapterId, version: packageManifest.version },
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
      rawSegmentBytes: 16 * 1024 * 1024,
      rawBytesPerObservation: 16 * 1024 * 1024,
      pagesPerCycle: 20
    },
    rawProgress: [],
    signal: AbortSignal.timeout(5_000)
  })
  assert.deepEqual(page.observations, [])
  assert.equal(page.hasMore, false)
  if (adapterId === "codex") assert.equal(typeof page.nextCursor, "string")
  else assert.equal(page.nextCursor, null)
  assert.equal(page.sourceFailures, undefined)
  await runtime.close?.()
  const installedManifest = JSON.parse(await readFile(join(installDirectory, "node_modules", "@atape", `adapter-${adapterId}`, "package.json"), "utf8"))
  assert.equal(installedManifest.dependencies, undefined, "Adapter must be self-contained")

  process.stdout.write(`Verified installable ${adapterId} Adapter tarball ${manifest.filename}\n`)
} finally {
  if (previousSelectedFile === undefined) delete process.env.ATAPE_CLAUDE_SESSION_FILE
  else process.env.ATAPE_CLAUDE_SESSION_FILE = previousSelectedFile
  if (previousSourceHome === undefined) delete process.env[sourceHomeVariable]
  else process.env[sourceHomeVariable] = previousSourceHome
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
