import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
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
  ATAPE_HOME: stateDirectory,
  ATAPE_DEVELOPMENT_ALLOW_HTTP: "true",
  XDG_CONFIG_HOME: join(temporaryRoot, "xdg-config"),
  XDG_DATA_HOME: join(temporaryRoot, "xdg-data"),
  XDG_STATE_HOME: join(temporaryRoot, "xdg-state"),
  ATAPE_REDACT_VALUES: "[]"
}
let collectorStarted = false
let fixtureServer

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
    const remote = await startFixtureServer()
    fixtureServer = remote.server
    environment.ATAPE_INSTANCE_URL = remote.origin
    const login = await atape(["login", "--no-browser", "--json"])
    assert.deepEqual(JSON.parse(login.stdout), {
      instanceOrigin: remote.origin,
      apiOrigin: remote.origin,
      user: { id: "package-user", displayName: "Package User" },
      credentialId: "package-credential",
      createdAt: "2026-09-06T00:00:00Z",
      browserOpened: false,
      warnings: []
    })
    assert.ok(!login.stdout.includes("atc_v1_"), "login stdout disclosed the bearer Credential")
    assert.match(login.stderr, /Q7KM4W/)

    await writeSmokeAdapter()
    await atape(["adapters", "install", adapterSource, "--json"])
    const setup = JSON.parse((await atape([
      "setup", projectDirectory, "--team", "package-team", "--create",
      "--name", "Package Project", "--type", "directory", "--adapter", "smoke", "--json"
    ])).stdout)
    assert.equal(setup.createdRemotely, true)
    assert.equal(setup.project.userId, "package-user")
    assert.equal(setup.project.teamId, "package-team-id")
    assert.equal(setup.project.instanceOrigin, remote.origin)
    const started = JSON.parse((await atape([
      "start", "--interval", "10", "--concurrency", "1", "--json"
    ])).stdout)
    assert.equal(started.created, true)
    collectorStarted = true
    await waitForHealthyCollector()
    assert.deepEqual(JSON.parse((await atape(["stop", "--json"])).stdout), { stopped: true })
    collectorStarted = false
    assert.equal(JSON.parse((await atape(["status", "--json"])).stdout).running, false)

    await closeServer(fixtureServer)
    fixtureServer = undefined
    const logout = JSON.parse((await atape(["logout", "--json"])).stdout)
    assert.equal(logout.signedOut, true)
    assert.equal(logout.warnings.length, 1)
  }

  process.stdout.write(`Verified installable CLI tarball ${manifest.filename}\n`)
} finally {
  if (collectorStarted) await atape(["stop", "--json"]).catch(() => undefined)
  await closeServer(fixtureServer)
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function startFixtureServer() {
  let origin = ""
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    response.setHeader("Content-Type", "application/json")
    const send = (status, body) => {
      response.statusCode = status
      if (body === undefined) response.end()
      else response.end(JSON.stringify(body))
    }
    switch (`${request.method} ${request.url}`) {
      case "GET /api/v1/instance":
        send(200, {
          protocol: "atape.instance.v1",
          instance_origin: origin,
          web_origin: origin,
          api_origin: origin,
          protocols: ["atape.cli-authorization.v1", "atape.canonical.v1", "atape.raw.v1"],
          release_version: "0.2.0",
          auth_epoch: "auth-v1",
          minimum_cli_version: "0.2.0"
        })
        return
      case "POST /api/v1/auth/cli/device-grants":
        send(201, {
          protocol: "atape.cli-authorization.v1",
          device_code: "atd_v1_package-device",
          user_code: "Q7KM4W",
          verification_uri: `${origin}/cli/authorize`,
          verification_uri_complete: `${origin}/cli/authorize?user_code=Q7KM4W`,
          expires_in: 60,
          interval: 1
        })
        return
      case "POST /api/v1/auth/cli/token":
        send(200, {
          token_type: "Bearer",
          credential: "atc_v1_package-secret",
          credential_id: "package-credential",
          capability_version: "atape-cli.v1",
          created_at: "2026-09-06T00:00:00Z",
          user: { id: "package-user", display_name: "Package User" }
        })
        return
      case "GET /api/v1/users/me":
        send(200, { id: "package-user", displayName: "Package User", avatarUrl: "" })
        return
      case "GET /api/v1/workspace":
        send(200, {
          teams: [{
            id: "package-team-id",
            slug: "package-team",
            displayName: "Package Team",
            membership: { role: "owner" },
            createdAt: "2026-09-06T00:00:00Z",
            updatedAt: "2026-09-06T00:00:00Z"
          }],
          projects: []
        })
        return
      case "POST /api/v1/teams/package-team/projects":
        assert.equal(request.headers.authorization, "Bearer atc_v1_package-secret")
        send(201, {
          id: "package-project",
          teamId: "package-team-id",
          type: "folder",
          name: "Package Project",
          state: "active",
          repositoryLinkState: "not_applicable",
          createdAt: "2026-09-06T00:00:00Z",
          updatedAt: "2026-09-06T00:00:00Z"
        })
        return
      case "DELETE /api/v1/auth/cli/credentials/current":
        send(204)
        return
      default:
        send(404, { status: 404, code: "not_found" })
    }
  })
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind")
  origin = `http://127.0.0.1:${address.port}`
  return { server, origin }
}

async function closeServer(server) {
  if (server === undefined) return
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
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
