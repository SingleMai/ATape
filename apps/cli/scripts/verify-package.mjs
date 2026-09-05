import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
const temporaryRoot = await mkdtemp(join(tmpdir(), "atape-cli-package-"))
const artifactDirectory = join(temporaryRoot, "artifact")
const installDirectory = join(temporaryRoot, "install")
const projectDirectory = join(temporaryRoot, "project")
const adapterSource = join(temporaryRoot, "smoke-adapter")
const stateDirectory = join(temporaryRoot, "state")
const binary = join(
  installDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "atape.cmd" : "atape"
)
const environment = {
  ...process.env,
  ATAPE_CONFIG_FILE: join(stateDirectory, "config.json"),
  ATAPE_COLLECTOR_STATE_FILE: join(stateDirectory, "collector.json"),
  ATAPE_COLLECTOR_PROCESS_FILE: join(stateDirectory, "collector-process.json"),
  ATAPE_COLLECTOR_STATUS_FILE: join(stateDirectory, "collector-status.json"),
  ATAPE_COLLECTOR_LOG_FILE: join(stateDirectory, "collector.log"),
  ATAPE_ADAPTER_DIRECTORY: join(stateDirectory, "adapters"),
  ATAPE_REDACT_VALUES: "[]"
}
let collectorStarted = false

try {
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    mkdir(adapterSource, { recursive: true })
  ])
  const packed = JSON.parse((await run("npm", [
    "pack", "--json", "--pack-destination", artifactDirectory
  ], packageRoot)).stdout)
  assert.equal(packed.length, 1)
  const manifest = packed[0]
  assert.deepEqual(
    manifest.files.map((file) => file.path).sort(),
    ["LICENSE", "README.md", "dist/atape.js", "package.json"]
  )
  assert.ok(manifest.size < 1024 * 1024, `CLI tarball is unexpectedly large: ${manifest.size} bytes`)

  const tarball = join(artifactDirectory, manifest.filename)
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball
  ], temporaryRoot)
  assert.match((await atape(["--help"])).stdout, /^ATape CLI/m)
  assert.equal((await atape(["--version"])).stdout.trim(), `ATape ${packageManifest.version}`)
  assert.deepEqual(JSON.parse((await atape(["status", "--json"])).stdout), {
    running: false,
    jobs: []
  })

  if (process.platform !== "win32") {
    await writeSmokeAdapter()
    await atape(["adapters", "install", adapterSource, "--json"])
    await atape([
      "setup", projectDirectory,
      "--user-id", "package-user",
      "--team-id", "package-team",
      "--team-name", "Package Team",
      "--project-id", "package-project",
      "--name", "Package Project",
      "--type", "directory",
      "--server", "http://127.0.0.1:9",
      "--adapter", "smoke",
      "--json"
    ])
    const started = JSON.parse((await atape([
      "start", "--interval", "10", "--concurrency", "1", "--json"
    ])).stdout)
    assert.equal(started.created, true)
    collectorStarted = true
    await waitForHealthyCollector()
    assert.deepEqual(JSON.parse((await atape(["stop", "--json"])).stdout), { stopped: true })
    collectorStarted = false
    assert.equal(JSON.parse((await atape(["status", "--json"])).stdout).running, false)
  }

  process.stdout.write(`Verified installable CLI tarball ${manifest.filename}\n`)
} finally {
  if (collectorStarted) await atape(["stop", "--json"]).catch(() => undefined)
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function writeSmokeAdapter() {
  await writeFile(join(adapterSource, "package.json"), `${JSON.stringify({
    name: "atape-package-smoke-adapter",
    version: "1.0.0",
    type: "module",
    atapeAdapter: {
      protocolVersion: "atape.adapter.v1alpha1",
      adapterId: "smoke",
      displayName: "Package smoke Adapter",
      entry: "./index.js",
      harnesses: ["smoke"]
    }
  }, null, 2)}\n`)
  await writeFile(join(adapterSource, "index.js"), [
    "export const createAtapeAdapter = async () => ({",
    "  collect: async () => ({",
    "    protocolVersion: 'atape.adapter.v1alpha1',",
    "    nextCursor: null,",
    "    hasMore: false,",
    "    observations: []",
    "  })",
    "})",
    ""
  ].join("\n"))
}

async function waitForHealthyCollector() {
  for (let attempt = 0; attempt < 80; attempt++) {
    const status = JSON.parse((await atape(["status", "--json"])).stdout)
    const job = status.jobs.find((candidate) =>
      candidate.projectId === "package-project" && candidate.adapterId === "smoke")
    if (status.running === true && job?.state === "healthy") return
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error("Installed CLI Collector did not complete its smoke Adapter cycle.")
}

function atape(arguments_) {
  return run(binary, arguments_, temporaryRoot, environment)
}

async function run(file, arguments_, cwd, env = process.env) {
  try {
    return await execute(file, arguments_, {
      cwd,
      env,
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
