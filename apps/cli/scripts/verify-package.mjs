import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { verifyAutomaticUpdate } from "./verify-automatic-update.mjs"
import { verifyLoginStartup } from "./verify-login-startup.mjs"
import { verifyLegacyStateContract } from "./verify-legacy-state-contract.mjs"
import { verifyUpdateBridge } from "./verify-update-bridge.mjs"
import { verifyPrivacyUpgrade } from "./verify-privacy-upgrade.mjs"
import { verifyCaptureMigration } from "./verify-capture-migration.mjs"

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
  assert.doesNotMatch(help, /atape (upgrade|adapters|setup|status)|__(collector-daemon|automatic-update|login-start|update-wake)/)
  assert.equal((await atape(["--version"])).stdout.trim(), `ATape ${packageManifest.version}`)
  for (const args of [["status"], ["login"], ["setup"], ["collect"], ["adapters", "prune"], []]) {
    await assert.rejects(atape(args), error => error.cause?.code === 2)
  }

  if (process.platform !== "win32") {
    await verifyAutomaticUpdate(join(installDirectory, "node_modules", "@atape", "cli"), join(temporaryRoot, "automatic-update"))
    await verifyLoginStartup(join(installDirectory, "node_modules", "@atape", "cli"), join(temporaryRoot, "login-startup"))
    await verifyUpdateWake(join(installDirectory, "node_modules", "@atape", "cli"), join(temporaryRoot, "update-wake"))
    await verifyUpdateBridge(join(installDirectory, "node_modules", "@atape", "cli"), join(temporaryRoot, "update-bridge"))
    await verifyCaptureMigration(join(installDirectory, "node_modules", "@atape", "cli"), join(temporaryRoot, "capture-migration"))
    if (process.env.ATAPE_VERIFY_LEGACY_CLI_TARBALL) {
      await verifyLegacyStateContract(join(installDirectory, "node_modules", "@atape", "cli"), join(temporaryRoot, "legacy-state-contract"), process.env.ATAPE_VERIFY_LEGACY_CLI_TARBALL)
    }
    if (process.env.ATAPE_VERIFY_PRIVACY_BASELINE_TARBALL) {
      await verifyPrivacyUpgrade(join(installDirectory, "node_modules", "@atape", "cli"), join(temporaryRoot, "privacy-upgrade"), process.env.ATAPE_VERIFY_PRIVACY_BASELINE_TARBALL, tarball)
    }
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

// Exercise the installed, bundled headless entry. Native registration is a
// controlled external-command Adapter; no user service or real network is used.
async function verifyUpdateWake(donorPackage, fixtureDirectory) {
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory)
  const manifest = JSON.parse(await readFile(join(donorPackage, "package.json"), "utf8"))
  assert.equal(manifest.atapeRuntime?.updateWakeProtocol, "atape.update-wake.v1")
  const home = join(root, "atape home 空格%$")
  const userHome = join(root, "user")
  const globalRoot = join(root, "prefix", "lib", "node_modules")
  const bootstrapPackage = join(globalRoot, "@atape", "cli")
  const bootstrap = join(bootstrapPackage, "dist", "atape.js")
  const configFile = join(home, "config", "client.json")
  const processFile = join(home, "state", "collector-process.json")
  const desiredFile = `${processFile}.desired.json`
  const wakeDirectory = join(home, "updates", "wakeup")
  const metadataFile = join(wakeDirectory, "registration.json")
  const scheduleFile = join(home, "updates", "state.json")
  const managerFile = join(root, "controlled-manager.mjs")
  const nativeTrace = join(root, "native-commands.jsonl")
  const runtimeTrace = join(root, "runtime.jsonl")
  const networkTrace = join(root, "network.jsonl")
  const spawnTrace = join(root, "spawns.jsonl")
  const json = async file => JSON.parse(await readFile(file, "utf8"))
  const rows = async file => (await readFile(file, "utf8").catch(cause => {
    if (cause.code === "ENOENT") return ""
    throw cause
  })).trim().split("\n").filter(Boolean).map(row => JSON.parse(row))
  const absent = file => assert.rejects(readFile(file), cause => cause.code === "ENOENT")
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(userHome, { mode: 0o700 }),
    mkdir(join(home, "config"), { recursive: true, mode: 0o700 })])
  await cp(donorPackage, bootstrapPackage, { recursive: true })
  await writeFile(join(root, "controlled-manager.json"), JSON.stringify({ registered: false, enabled: false, active: false }))
  await writeFile(managerFile, `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export function executeManager(file, args) {
  appendFileSync(${JSON.stringify(nativeTrace)}, JSON.stringify({ file, args }) + "\\n");
  if (file === "npm" && args.join(" ") === "root --global") return ${JSON.stringify(`${globalRoot}\n`)};
  const stateFile = ${JSON.stringify(join(root, "controlled-manager.json"))};
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const unavailable = () => Object.assign(new Error("Controlled service is absent"), { code: 1 });
  let output = "";
  if (file === "/bin/launchctl") {
    if (args[0] === "print-disabled") return "disabled services = {\\n" + (state.job ? '"' + state.job + '" => ' + (!state.enabled) + "\\n" : "") + "}\\n";
    if (args[0] === "print" && args[1]?.split("/").length === 2) return "Controlled GUI domain";
    if (args[0] === "print") { if (!state.registered) throw unavailable(); return "Controlled scheduled service"; }
    if (args[0] === "enable") { state.enabled = true; state.job = args[1]?.split("/").at(-1); }
    else if (args[0] === "disable") state.enabled = false;
    else if (args[0] === "bootstrap" && args[2]?.startsWith(${JSON.stringify(`${root}/`)})) state.registered = true;
    else if (args[0] === "bootout" && args[1]?.includes("com.atape.update.")) state.registered = false;
    else throw new Error("Unexpected controlled launchctl operation");
  } else if (file === "systemctl") {
    if (args.includes("show-environment") || args.includes("daemon-reload")) return "";
    if (!args.at(-1)?.startsWith("com.atape.update.") || !args.at(-1)?.endsWith(".timer")) throw new Error("Only the isolated update timer may be controlled");
    if (args.includes("is-enabled")) { if (!state.enabled) throw unavailable(); return "enabled\\n"; }
    if (args.includes("is-active")) { if (!state.active) throw unavailable(); return "active\\n"; }
    if (args.includes("enable")) state.enabled = true;
    else if (args.includes("disable")) state.enabled = false;
    else if (args.includes("start")) state.active = true;
    else if (args.includes("stop")) state.active = false;
    else throw new Error("Unexpected controlled systemctl operation");
  } else throw new Error("Unexpected external command in update wake acceptance: " + file);
  writeFileSync(stateFile, JSON.stringify(state));
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(executeManager(process.argv[2], process.argv.slice(3))); }
  catch (cause) { process.stderr.write(cause.message); process.exitCode = Number.isInteger(cause.code) ? cause.code : 73; }
}
`)
  const preload = join(root, "controlled-external.mjs")
  await writeFile(preload, `import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { executeManager } from ${JSON.stringify(pathToFileURL(managerFile).href)};
appendFileSync(${JSON.stringify(runtimeTrace)}, JSON.stringify({ pid: process.pid, entry: process.argv[1], args: process.argv.slice(2), tty: Boolean(process.stdin.isTTY || process.stdout.isTTY) }) + "\\n");
const originalExec = childProcess.execFile, originalSpawn = childProcess.spawn;
childProcess.execFile = function(file, args, options, callback) {
  if (file === process.execPath || file === "/bin/ps") return Reflect.apply(originalExec, this, arguments);
  const child = new EventEmitter(); child.kill = () => true;
  queueMicrotask(() => {
    try { callback(null, executeManager(file, args), ""); }
    catch (cause) { callback(cause, "", ""); }
  });
  return child;
};
childProcess.spawn = function(file, args, options) {
  appendFileSync(${JSON.stringify(spawnTrace)}, JSON.stringify({ file, args, detached: Boolean(options?.detached) }) + "\\n");
  if (file !== process.execPath || (args[0] !== ${JSON.stringify(bootstrap)} && !args[0]?.startsWith(${JSON.stringify(`${home}/releases/`)})) || args[1] !== "__update-wake" || options?.detached) throw new Error("Unexpected child in joined update wake");
  return Reflect.apply(originalSpawn, this, arguments);
};
globalThis.fetch = async function(url) {
  appendFileSync(${JSON.stringify(networkTrace)}, JSON.stringify({ url: String(url) }) + "\\n");
  if (String(url) === "https://api.github.com/repos/SingleMai/ATape/releases/tags/atape-update-catalog-v2") return new Response(null, { status: 404 });
  throw new TypeError("Controlled offline package acceptance");
};
syncBuiltinESMExports();
`)
  // Deliberately omit inherited credentials, proxies, sources and Node options.
  const environment = { HOME: userHome, PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: root, ATAPE_HOME: home, ATAPE_CONFIG_FILE: configFile, ATAPE_LANG: "en", LANG: "en_US.UTF-8",
    ATAPE_BOOTSTRAP_ENTRY: bootstrap, XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"),
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, UPDATE_WAKE_FIXTURE_ROOT: root,
    UPDATE_WAKE_FIXTURE_COMMAND_ADAPTER: managerFile, npm_config_prefix: join(root, "inactive-prefix"),
    npm_config_cache: join(root, "npm-cache"), npm_config_registry: "http://127.0.0.1:1" }
  const config = { version: 3, projects: [], adapters: [], toolsConfigured: true, enabledAdapterIds: [],
    autoUpdateEnabled: true, autoStartEnabled: false }
  await writeFile(configFile, `${JSON.stringify(config)}\n`, { mode: 0o600 })
  const command = (entry, args) => execute(process.execPath, [entry, ...args], {
    cwd: root, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024
  })
  const fixtureEntry = fileURLToPath(new URL("../src/runtime/fixtures/update-wake.ts", import.meta.url))
  const fixture = async operation => JSON.parse((await command(fixtureEntry, [operation])).stdout)
  assert.equal(await fixture("stop"), false)
  const stoppedIntent = await readFile(desiredFile, "utf8")
  assert.equal(JSON.parse(stoppedIntent).wanted, false)
  assert.deepEqual(await fixture("register"), { state: "registered" })
  assert.equal((await fixture("inspect")).enabled, true)
  const metadata = await json(metadataFile)
  assert.equal(metadata.protocol, "atape.update-wake.v1")
  assert.equal(metadata.launcher, join(wakeDirectory, "atape.mjs"))
  assert.equal(metadata.launcherHash, createHash("sha256").update(await readFile(metadata.launcher)).digest("hex"))
  assert.ok(metadata.descriptors.every(item => item.file.startsWith(`${root}/`)))
  const descriptors = await Promise.all(metadata.descriptors.map(item => readFile(item.file, "utf8")))
  if (process.platform === "darwin") {
    const parsed = JSON.parse((await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", metadata.descriptors[0].file], { encoding: "utf8" })).stdout)
    assert.deepEqual(parsed.ProgramArguments, [await realpath(process.execPath), metadata.launcher, "__update-wake", "--wake-token", metadata.token])
    assert.equal(parsed.RunAtLoad, true)
    assert.ok(Number.isInteger(parsed.StartCalendarInterval.Minute) && parsed.StartCalendarInterval.Minute < 60)
  } else {
    assert.match(descriptors[0], /RemainAfterExit=no/)
    assert.match(descriptors[0], /KillMode=process/)
    assert.match(descriptors[1], /OnCalendar=\*-\*-\* \*:\d{2}:00/)
    assert.match(descriptors[1], /Persistent=true/)
  }
  const futureSchedule = `${JSON.stringify({ nextCheckAt: Date.now() + 86_400_000, failures: 0, version: manifest.version })}\n`
  await writeFile(scheduleFile, futureSchedule, { mode: 0o600 })
  const wake = token => command(metadata.launcher, ["__update-wake", "--wake-token", token])
  const first = await wake(metadata.token)
  assert.doesNotMatch(first.stdout + first.stderr, /\x1b|Your Projects|Open browser|Sign in/)
  assert.ok((await rows(runtimeTrace)).some(row => row.entry === bootstrap && row.args[0] === "__update-wake" && !row.tty),
    "A fresh no-pointer wake must join the actual npm bootstrap instead of executing the retained copy")
  assert.ok((await rows(spawnTrace)).some(row => row.args[0] === bootstrap && !row.detached))
  assert.equal(await readFile(scheduleFile, "utf8"), futureSchedule)
  assert.equal(await readFile(desiredFile, "utf8"), stoppedIntent)
  await absent(processFile)
  assert.deepEqual(await rows(networkTrace), [])
  const beforeInvalid = (await rows(nativeTrace)).length
  await assert.rejects(wake(randomUUID()), cause => cause.code === 1 && /reserved for its registered ATape installation/.test(cause.stderr))
  assert.equal((await rows(nativeTrace)).length, beforeInvalid)
  await writeFile(configFile, `${JSON.stringify({ ...config, autoUpdateEnabled: false })}\n`)
  assert.equal((await json(metadataFile)).enabled, true, "This case must exercise queued preference rereading")
  await wake(metadata.token)
  assert.deepEqual(await rows(networkTrace), [], "A queued preference-off wake must not discover an update")
  assert.equal(await readFile(scheduleFile, "utf8"), futureSchedule)
  assert.equal(await readFile(desiredFile, "utf8"), stoppedIntent)
  await absent(processFile)
  assert.deepEqual(await fixture("disable"), { state: "missing" })
  await wake(metadata.token)
  assert.equal((await json(metadataFile)).enabled, false)
  await Promise.all(metadata.descriptors.map(item => absent(item.file)))
  assert.deepEqual(await fixture("enable"), { state: "registered" })
  assert.equal((await json(configFile)).autoStartEnabled, false)
  // An actual selected packaged runtime receives the private command after the
  // retained launcher admits it. No synthetic executable substitutes its main.
  const selectedPackage = join(home, "releases", manifest.version, "node_modules", "@atape", "cli")
  await cp(donorPackage, selectedPackage, { recursive: true })
  const selectedEntry = join(selectedPackage, "dist", "atape.js")
  const pointer = { protocol: "atape.update-control.v1", captureStateContract: manifest.atapeRuntime.stateContract,
    version: manifest.version, bootstrapEntry: bootstrap,
    bootstrapIdentity: createHash("sha256").update(await readFile(bootstrap)).digest("hex"), adapters: [] }
  await writeFile(join(home, "updates", "runtime.json"), `${JSON.stringify(pointer)}\n`, { mode: 0o600 })
  const selected = await wake(metadata.token)
  assert.doesNotMatch(selected.stdout + selected.stderr, /\x1b|Your Projects|Open browser|Sign in/)
  assert.ok((await rows(runtimeTrace)).some(row => row.entry === selectedEntry && row.args[0] === "__update-wake" && !row.tty))
  assert.ok((await rows(spawnTrace)).some(row => row.args[0] === selectedEntry && !row.detached))
  assert.equal(await readFile(scheduleFile, "utf8"), futureSchedule)
  // A due wake joins one controlled offline attempt and saves the ordinary
  // retry schedule; the next invocation remains local during that backoff.
  await writeFile(scheduleFile, `${JSON.stringify({ nextCheckAt: 0, failures: 0 })}\n`)
  await assert.rejects(wake(metadata.token), cause => cause.code === 1)
  const failed = await json(scheduleFile), requests = await rows(networkTrace)
  assert.equal(failed.failures, 1)
  assert.ok(failed.nextCheckAt > Date.now())
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, "https://api.github.com/repos/SingleMai/ATape/releases/tags/atape-update-catalog-v2")
  assert.equal(requests[1].url, "https://api.github.com/repos/SingleMai/ATape/releases/tags/atape-update-catalog-v1")
  await wake(metadata.token)
  assert.equal((await rows(networkTrace)).length, requests.length)
  assert.equal(await readFile(desiredFile, "utf8"), stoppedIntent)
  await absent(processFile)
  assert.ok((await rows(runtimeTrace)).filter(row => row.args[0] === "__update-wake").every(row => !row.tty))
  assert.ok((await rows(spawnTrace)).every(row => [bootstrap, selectedEntry].includes(row.args[0]) && !row.detached))
  const finalCommands = await rows(nativeTrace)
  assert.ok(finalCommands.every(row => ["npm", "/bin/launchctl", "systemctl"].includes(row.file)))
  assert.ok(finalCommands.filter(row => row.file === "npm").every(row => row.args.join(" ") === "root --global"))
  assert.deepEqual(await fixture("disable"), { state: "missing" })
  await writeFile(join(root, "update-wake-acceptance.json"), `${JSON.stringify({
    protocol: "atape.update-wake-package-acceptance.v1", passed: true, version: manifest.version,
    bundledLauncher: metadata.launcher, selectedEntry, stoppedIntentPreserved: true,
    queuedPreferenceOff: true, invalidTokenRefused: true, offlineRetryPreserved: true,
    nativeCommands: "controlled external-command Adapter", network: "controlled offline; no real requests",
    realTimerActivationVerified: false, realCollectorCgroupVerified: false
  }, null, 2)}\n`)
  process.stdout.write("Verified installed headless update wake, queued off/token admission, real selected bundle delegation, Stop preservation and controlled offline backoff (no native timer claim)\n")
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
