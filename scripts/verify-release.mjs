import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { loadReleaseContract } from "./release-contract.mjs"

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const release = await loadReleaseContract(repositoryRoot)
const releaseDirectory = release.releaseDirectory
const cliPackage = release.packages.find((package_) => package_.name === "@atape/cli")
const adapterPackage = release.packages.find((package_) => package_.name === "@atape/adapter-codex")
if (cliPackage === undefined || adapterPackage === undefined) throw new Error("Release packages are incomplete.")
const cliArtifact = join(releaseDirectory, cliPackage.artifactName)
const adapterArtifact = join(releaseDirectory, adapterPackage.artifactName)
const temporaryRoot = await mkdtemp(join(tmpdir(), "atape-release-"))
const installDirectory = join(temporaryRoot, "install")
const projectDirectory = join(temporaryRoot, "project")
const codexHome = join(temporaryRoot, "codex-home")
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
  ATAPE_CODEX_HOME: codexHome,
  ATAPE_REDACT_VALUES: "[]"
}

try {
  await run("node", ["scripts/pack-release.mjs"], repositoryRoot)
  await verifyChecksums()
  await Promise.all([
    mkdir(projectDirectory, { recursive: true }),
    mkdir(join(codexHome, "sessions"), { recursive: true }),
    mkdir(join(codexHome, "archived_sessions"), { recursive: true })
  ])
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, cliArtifact
  ], temporaryRoot)

  const installed = JSON.parse((await atape(["adapters", "install", adapterArtifact, "--json"])).stdout)
  assert.equal(installed.created, true)
  assert.equal(installed.adapter.adapterId, "codex")
  assert.equal(installed.adapter.packageName, "@atape/adapter-codex")
  assert.equal(installed.adapter.upgradeSpec, `file:${adapterArtifact}`)
  assert.equal(installed.adapter.version, adapterPackage.version)
  assert.equal(installed.adapter.displayName, "Codex")
  await atape([
    "setup", projectDirectory,
    "--user-id", "release-user",
    "--team-id", "release-team",
    "--team-name", "Release Team",
    "--project-id", "release-project",
    "--name", "Release Project",
    "--type", "directory",
    "--server", "http://127.0.0.1:9",
    "--adapter", "codex",
    "--json"
  ])
  const collected = JSON.parse((await atape([
    "collect", "--once", "--project", "release-project", "--json"
  ])).stdout)
  assert.equal(collected.failures.length, 0)
  assert.deepEqual(collected.jobs.map((job) => ({
    projectId: job.projectId,
    adapterId: job.adapterId,
    observations: job.observations
  })), [{ projectId: "release-project", adapterId: "codex", observations: 0 }])

  process.stdout.write("Verified packaged CLI loading and collecting with the packaged Codex Adapter.\n")
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function verifyChecksums() {
  const expected = new Map((await readFile(join(releaseDirectory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [digest, filename] = line.split(/\s{2}/)
      return [filename, digest]
    }))
  for (const artifact of [cliArtifact, adapterArtifact]) {
    const filename = artifact.slice(releaseDirectory.length + 1)
    const digest = createHash("sha256").update(await readFile(artifact)).digest("hex")
    assert.equal(expected.get(filename), digest)
  }
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
