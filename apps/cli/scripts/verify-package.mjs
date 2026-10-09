import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { verifyAutomaticUpdate } from "./verify-automatic-update.mjs"
import { verifyLoginStartup } from "./verify-login-startup.mjs"

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
  ATAPE_LANG: "en",
  ATAPE_HOME: stateDirectory,
  ATAPE_DEVELOPMENT_ALLOW_HTTP: "true",
  XDG_CONFIG_HOME: join(temporaryRoot, "xdg-config"),
  XDG_DATA_HOME: join(temporaryRoot, "xdg-data"),
  XDG_STATE_HOME: join(temporaryRoot, "xdg-state"),
  ATAPE_GROK_HOME: join(temporaryRoot, "missing-grok"),
  ATAPE_CODEBUDDY_HOME: join(temporaryRoot, "missing-codebuddy"),
  ATAPE_KIMI_HOME: join(temporaryRoot, "missing-kimi"),
  OPENCODE_DB: join(temporaryRoot, "missing-opencode.db"),
  ATAPE_REDACT_VALUES: "[]",
  ATAPE_REDACTION_CONFIG_FILE: undefined
}
let fixtureServer

try {
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    mkdir(adapterSource, { recursive: true })
  ])
  const packed = JSON.parse((await run("npm", [
    "pack", ...(process.env.ATAPE_VERIFY_CLI_TARBALL ? [process.env.ATAPE_VERIFY_CLI_TARBALL, "--ignore-scripts"] : []), "--json", "--pack-destination", artifactDirectory
  ], packageRoot)).stdout)
  assert.equal(packed.length, 1)
  const manifest = packed[0]
  assert.deepEqual(
    manifest.files.map((file) => file.path).sort(),
    ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "dist/atape.js", "package.json"]
  )
  assert.ok(manifest.size < 1024 * 1024, `CLI tarball is unexpectedly large: ${manifest.size} bytes`)

  const tarball = join(artifactDirectory, manifest.filename)
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball
  ], temporaryRoot)
  const notices = await readFile(join(installDirectory, "node_modules", "@atape", "cli", "THIRD_PARTY_NOTICES.md"), "utf8")
  assert.match(notices, /Confab Contributors/)
  assert.match(notices, /RE2JS/)
  await verifyLocalRedaction()
  const help = (await atape(["--help"])).stdout
  assert.match(help, /^ATape CLI/m)
  assert.match(help, /projects, tools and settings/)
  assert.doesNotMatch(help, /atape (upgrade|adapters|setup|status)|__(collector-daemon|automatic-update|login-start)/)
  assert.equal((await atape(["--version"])).stdout.trim(), `ATape ${packageManifest.version}`)
  for (const args of [["status"], ["login"], ["setup"], ["collect"], ["adapters", "prune"], []]) {
    await assert.rejects(atape(args), error => error.cause?.code === 2)
  }

  if (process.platform !== "win32") {
    await verifyAutomaticUpdate(join(installDirectory, "node_modules", "@atape", "cli"), join(temporaryRoot, "automatic-update"))
    await verifyLoginStartup(join(installDirectory, "node_modules", "@atape", "cli"), join(temporaryRoot, "login-startup"))
    const remote = await startFixtureServer()
    fixtureServer = remote.server
    environment.ATAPE_INSTANCE_URL = remote.origin
    await writeSmokeAdapter()
    process.stdout.write((await run("python3", [fileURLToPath(new URL("verify-terminal.py", import.meta.url)), binary, join(temporaryRoot, "terminal"), adapterSource, remote.origin], temporaryRoot, environment)).stdout)

  }

  process.stdout.write(`Verified installable CLI tarball ${manifest.filename}\n`)
} finally {
  await closeServer(fixtureServer)
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function startFixtureServer() {
  let origin = ""
  let teamsEnabled = true
  const projects = []
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
      case "POST /__terminal-fixture/teams":
        teamsEnabled = JSON.parse(Buffer.concat(chunks).toString("utf8")).enabled
        send(200, {})
        return
      case "GET /api/v1/projects/package-project/raw-capture":
        send(200, {teamPolicy: "personal", userPreference: "disable", enabled: false})
        return
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
          teams: teamsEnabled ? [{
            id: "package-team-id",
            slug: "package-team",
            displayName: "Package Team",
            membership: { role: "owner" },
            createdAt: "2026-09-06T00:00:00Z",
            updatedAt: "2026-09-06T00:00:00Z"
          }] : [],
          projects
        })
        return
      case "POST /api/v1/teams/package-team/projects":
        assert.equal(request.headers.authorization, "Bearer atc_v1_package-secret")
        const project = {
          id: "package-project",
          teamId: "package-team-id",
          type: "folder",
          name: "Package Project",
          state: "active",
          repositoryLinkState: "not_applicable",
          createdAt: "2026-09-06T00:00:00Z",
          updatedAt: "2026-09-06T00:00:00Z"
        }
        if (projects.length === 0) projects.push(project)
        send(201, project)
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
      rawCapturePolicy: "atape.raw-capture.v1",
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

async function verifyLocalRedaction() {
  const home = join(temporaryRoot, "redaction-home")
  const sample = join(temporaryRoot, "redaction-sample.jsonl")
  const configuration = join(temporaryRoot, "redaction-rules.json")
  let requests = 0
  const server = createServer((_, response) => { requests++; response.end() })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const env = { ...environment, ATAPE_HOME: home, ATAPE_INSTANCE_URL: `http://127.0.0.1:${address.port}` }
  const invoke = args => execute(binary, ["redaction-test", ...args], { cwd: temporaryRoot, env, encoding: "utf8", timeout: 30_000 })
  try {
    await writeFile(sample, '{"message":"keep ticket=private-alpha","password":"x"}\n')
    await writeFile(configuration, JSON.stringify({ patterns: [{ name: "Installed custom rule", pattern: "ticket=(private-[a-z]+)", type: "local", capture_group: 1 }] }))
    const tested = await invoke([sample, "--config", configuration])
    assert.deepEqual(JSON.parse(tested.stdout), { message: "keep ticket=[REDACTED:LOCAL]", password: "[REDACTED]" })
    assert.match(tested.stderr, /Redaction test: \d+ mask operation\(s\)/)
    assert.match(tested.stderr, /custom:0 \(local\): 1/)
    await assert.rejects(stat(home), { code: "ENOENT" })
    await mkdir(join(home, "releases"), { recursive: true })
    await writeFile(join(home, "releases", "current.json"), "malformed managed selection")
    const again = await invoke([sample, "--config", configuration])
    assert.equal(again.stdout, tested.stdout)
    assert.equal(await readFile(join(home, "releases", "current.json"), "utf8"), "malformed managed selection")
    await writeFile(configuration, '{"patterns":[{"name":"Invalid custom rule","pattern":"regex-secret(","type":"local"}]}')
    await assert.rejects(invoke([sample, "--config", configuration]), error => {
      assert.equal(error.code, 1)
      assert.equal(error.stdout, "")
      assert.match(error.stderr, /Local redaction test failed/)
      assert.doesNotMatch(error.stderr, /private-alpha|regex-secret|Installed custom rule|redaction-rules/)
      return true
    })
    const help = await invoke(["--help"])
    assert.match(help.stdout, /same redaction policy/)
    assert.equal(help.stderr, "")
    assert.equal(requests, 0)
    process.stdout.write("Verified installed local redaction command without network or capture state changes.\n")
  } finally { await closeServer(server) }
}
