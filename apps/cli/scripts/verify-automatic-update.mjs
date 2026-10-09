import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"

const execute = promisify(execFile)
const officialPackages = ["@atape/cli", "@atape/adapter-codex", "@atape/adapter-claude", "@atape/adapter-opencode",
  "@atape/adapter-codebuddy", "@atape/adapter-kimi", "@atape/adapter-grok"]
const exists = file => readFile(file).then(() => true, cause => { if (cause.code === "ENOENT") return false; throw cause })
const json = async file => JSON.parse(await readFile(file, "utf8"))
const digest = async file => createHash("sha256").update(await readFile(file)).digest("hex")
const processExists = pid => {
  try { process.kill(pid, 0); return true } catch (cause) { if (cause.code === "ESRCH") return false; throw cause }
}

export async function verifyAutomaticUpdate(donorPackage, fixtureDirectory) {
  await mkdir(fixtureDirectory, { recursive: true })
  const root = await realpath(fixtureDirectory)
  const manifest = await json(join(donorPackage, "package.json"))
  assert.equal(manifest.atapeRuntime?.protocol, "atape.runtime.v1")
  assert.equal(manifest.atapeRuntime?.stateContract, "atape.client.v3-capture.v1")
  const version = manifest.version
  const [major, minor, patch] = version.split(".").map(Number)
  const previous = patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.0` : `${major - 1}.0.0`
  const globalRoot = join(root, "prefix", "lib", "node_modules")
  const bootstrapPackage = join(globalRoot, "@atape", "cli")
  await cp(donorPackage, bootstrapPackage, { recursive: true })
  const bootstrap = join(bootstrapPackage, "dist", "atape.js")
  const beforeDigest = await digest(bootstrap)
  const home = join(root, "home")
  const currentFile = join(home, "releases", "current.json")
  const selectedPackage = join(home, "releases", version, "node_modules", "@atape", "cli")
  // Keep CLI acquisition offline while exercising validation of the exact
  // packaged CLI and a newly prepared official Adapter generation.
  await cp(donorPackage, selectedPackage, { recursive: true })

  const adapter = join(root, "official-codex")
  await mkdir(adapter, { recursive: true })
  await writeFile(join(adapter, "package.json"), JSON.stringify({
    name: "@atape/adapter-codex", version, type: "module", atapeAdapter: {
      protocolVersion: "atape.adapter.v1alpha1", adapterId: "codex", displayName: "Fixture Codex", entry: "./index.js",
      harnesses: ["codex"], gitAttribution: "atape.git-attribution.v1", rawCapturePolicy: "atape.raw-capture.v1"
    }
  }))
  const healthyAdapter = "export const createAtapeAdapter = async () => { throw new Error('readiness must not collect or construct provider runtime') }\n"
  await writeFile(join(adapter, "index.js"), healthyAdapter)
  const originalAdapter = { adapterId: "codex", packageName: "@atape/adapter-codex", version: previous,
    upgradeSpec: "@atape/adapter-codex", displayName: "Fixture Codex", installedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }
  const legacyAdapter = join(home, "adapters", "node_modules", "@atape", "adapter-codex")
  await cp(adapter, legacyAdapter, { recursive: true })
  await writeFile(join(legacyAdapter, "package.json"), JSON.stringify({ ...await json(join(adapter, "package.json")), version: previous }))
  const configFile = join(home, "config", "client.json")
  await mkdir(dirname(configFile), { recursive: true })
  const raw = { version: 3, projects: [], adapters: [originalAdapter], toolsConfigured: true, enabledAdapterIds: ["codex"], autoStartEnabled: false }
  const encodedRaw = `${JSON.stringify(raw)}\n`
  await writeFile(configFile, encodedRaw)

  const trace = join(root, "trace.jsonl")
  const metadata = join(root, "metadata.jsonl")
  const calls = join(root, "npm.jsonl")
  const hangingImport = join(root, "hanging-import.json")
  const collectorHeartbeat = join(root, "collector-heartbeat")
  const collectorSignals = join(root, "collector-signals")
  const collectorFile = join(home, "state", "collector-process.json")
  const maintenanceFile = `${collectorFile}.maintenance.json`
  const preload = join(root, "controlled-fetch.mjs")
  await writeFile(preload, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.UPDATE_FIXTURE_TRACE, JSON.stringify({ entry: process.argv[1], args: process.argv.slice(2), pid: process.pid }) + "\\n");
globalThis.fetch = async input => {
  const address = String(input);
  appendFileSync(process.env.UPDATE_FIXTURE_METADATA, JSON.stringify(address) + "\\n");
  if (address === "https://api.github.com/repos/SingleMai/ATape/releases/latest") return Response.json({
    tag_name: "v" + process.env.UPDATE_FIXTURE_VERSION, prerelease: false, draft: false, published_at: "2026-01-01T00:00:00Z"
  });
  const parsed = new URL(address);
  const segments = parsed.pathname.slice(1).split("/");
  const name = decodeURIComponent(segments[0]);
  if (parsed.origin !== "https://registry.npmjs.org" || segments.length !== 2 || segments[1] !== process.env.UPDATE_FIXTURE_VERSION ||
    !${JSON.stringify(officialPackages)}.includes(name)) throw new Error("Unexpected external request in isolated update fixture: " + address);
  return Response.json({ name, version: process.env.UPDATE_FIXTURE_VERSION });
};\n`)
  const bin = join(root, "bin")
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.UPDATE_FIXTURE_NPM_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "root" && args.includes("--global")) console.log(process.env.UPDATE_FIXTURE_GLOBAL_ROOT);
else if (args[0] === "prefix" && args.includes("--global")) console.log(path.dirname(path.dirname(process.env.UPDATE_FIXTURE_GLOBAL_ROOT)));
else if (args[0] === "config" && args[1] === "get" && args[2] === "registry") console.log("https://registry.npmjs.org/");
else if (args[0] === "install") {
  if (!args.includes("--ignore-scripts")) throw new Error("Fixture installation must disable scripts");
  const prefix = args[args.indexOf("--prefix") + 1];
  if (args.includes("@atape/adapter-codex@" + process.env.UPDATE_FIXTURE_VERSION)) {
    fs.cpSync(process.env.UPDATE_FIXTURE_ADAPTER, path.join(prefix, "node_modules/@atape/adapter-codex"), { recursive: true });
  } else if (args.includes("@atape/cli@" + process.env.UPDATE_FIXTURE_VERSION)) {
    fs.cpSync(process.env.UPDATE_FIXTURE_DONOR, path.join(prefix, "node_modules/@atape/cli"), { recursive: true });
  } else throw new Error("Unexpected package installation in fixture");
} else throw new Error("Unexpected npm operation in fixture: " + JSON.stringify(args));\n`)
  await chmod(join(bin, "npm"), 0o755)
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ATAPE_HOME: home, ATAPE_LANG: "en",
    ATAPE_BOOTSTRAP_ENTRY: bootstrap, ATAPE_RUNTIME_DIRECT: "1", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    UPDATE_FIXTURE_VERSION: version, UPDATE_FIXTURE_GLOBAL_ROOT: globalRoot, UPDATE_FIXTURE_ADAPTER: adapter,
    UPDATE_FIXTURE_DONOR: donorPackage, UPDATE_FIXTURE_TRACE: trace, UPDATE_FIXTURE_METADATA: metadata, UPDATE_FIXTURE_NPM_CALLS: calls,
    UPDATE_FIXTURE_HANGING_IMPORT: hangingImport }
  for (const name of ["ATAPE_CONFIG_FILE", "ATAPE_COLLECTOR_STATE_FILE", "ATAPE_COLLECTOR_PROCESS_FILE", "ATAPE_COLLECTOR_STATUS_FILE",
    "ATAPE_COLLECTOR_LOG_FILE", "ATAPE_ADAPTER_DIRECTORY", "ATAPE_UPDATE_WORKER_TOKEN", "ATAPE_COLLECTOR_READY_FILE", "ATAPE_COLLECTOR_READY_TOKEN"]) delete environment[name]
  const command = async (entry, args, env = environment) => execute(process.execPath, [entry, ...args], {
    cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  })
  const entries = async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  const workerEntries = async () => (await entries()).filter(item => item.entry?.startsWith(join(home, "updates", "workers")))
  let originalCollector
  try {
    await assert.rejects(command(bootstrap, ["__automatic-update", "--update-token", randomUUID()]), error =>
      error.code === 1 && /reserved for the owning ATape process/.test(error.stderr))
    const launch = fileURLToPath(new URL("../src/runtime/fixtures/automatic-update-launch.ts", import.meta.url))
    // A stuck import must fail before collection admission closes. Keep an
    // observable old Collector alive so a transient gate/stop is also caught.
    const collectorEntry = join(root, "original-collector.mjs")
    await writeFile(collectorEntry, `import { appendFileSync } from "node:fs";
setInterval(() => appendFileSync(${JSON.stringify(collectorHeartbeat)}, "tick\\n"), 25);
process.on("SIGTERM", () => { appendFileSync(${JSON.stringify(collectorSignals)}, "SIGTERM\\n"); process.exit(0) });\n`)
    const collectorToken = randomUUID()
    originalCollector = spawn(process.execPath, [collectorEntry, "__collector-daemon", "--daemon-token", collectorToken], { stdio: "ignore", env: environment })
    await new Promise((resolve, reject) => { originalCollector.once("spawn", resolve); originalCollector.once("error", reject) })
    const originalProcess = `${JSON.stringify({ version: 1, token: collectorToken, pid: originalCollector.pid,
      startedAt: new Date().toISOString(), intervalMs: 60_000, concurrency: 1, logFile: join(home, "logs", "collector.log") })}\n`
    await mkdir(dirname(collectorFile), { recursive: true })
    await writeFile(collectorFile, originalProcess)
    await waitFor(() => exists(collectorHeartbeat), async () => "Original fixture Collector did not start")
    const heartbeatBefore = (await readFile(collectorHeartbeat)).length
    await writeFile(join(adapter, "index.js"), `import { writeFileSync } from "node:fs";
writeFileSync(process.env.UPDATE_FIXTURE_HANGING_IMPORT, JSON.stringify({ pid: process.pid }));
process.on("SIGTERM", () => {});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
export const createAtapeAdapter = async () => { throw new Error("Unreachable factory") };\n`)
    const failedDispatch = await command(launch, [])
    await waitFor(async () => {
      assert.equal(await exists(maintenanceFile), false, "Adapter preparation closed collection admission")
      assert.equal(await readFile(collectorFile, "utf8"), originalProcess, "Adapter preparation changed the running Collector")
      assert.equal(await exists(collectorSignals), false, "Adapter preparation stopped the running Collector")
      if (!(await exists(join(home, "updates", "state.json")))) return false
      const state = await json(join(home, "updates", "state.json"))
      const workers = await workerEntries()
      return state.failures === 1 && state.failure === "prepare" && workers.length === 1 && !processExists(workers[0].pid) &&
        (await readdir(join(home, "updates", "workers")).catch(() => [])).length === 0
    }, async () => `Hung Adapter import was not bounded. Dispatcher: ${failedDispatch.stdout}\n${failedDispatch.stderr}\n${await readFile(join(home, "logs", "collector.log"), "utf8").catch(() => "no worker log")}`)
    const hung = await json(hangingImport)
    assert.notEqual(hung.pid, (await workerEntries())[0].pid, "Adapter import ran inside the updater process")
    assert.equal(processExists(hung.pid), false, "Timed-out Adapter import process survived its worker")
    assert.equal(await exists(currentFile), false)
    assert.equal(await exists(join(home, "updates", "pending.json")), false)
    assert.equal(await readFile(configFile, "utf8"), encodedRaw)
    assert.ok((await readFile(collectorHeartbeat)).length > heartbeatBefore, "Original Collector stopped making progress during preparation")
    assert.ok((await json(join(home, "updates", "state.json"))).nextCheckAt > Date.now())
    const updateLock = new DatabaseSync(join(home, "updates", "worker.lock.sqlite"))
    try { updateLock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK") } finally { updateLock.close() }
    originalCollector.kill("SIGTERM")
    await waitFor(async () => originalCollector.exitCode !== null, async () => "Original fixture Collector did not stop after the regression check")
    await rm(collectorFile)
    await writeFile(join(adapter, "index.js"), healthyAdapter)
    await writeFile(join(home, "updates", "state.json"), JSON.stringify({ nextCheckAt: 0, failures: 1 }))
    const dispatched = await command(launch, [])
    await waitFor(async () => await exists(currentFile) && await exists(join(home, "updates", "state.json")) &&
      (await readdir(join(home, "updates", "workers")).catch(() => [])).length === 0,
      async () => `Detached update did not complete. Dispatcher: ${dispatched.stdout}\n${dispatched.stderr}\n${await readFile(join(home, "logs", "collector.log"), "utf8").catch(() => "no worker log")}`)
    const current = await json(currentFile)
    assert.equal(current.version, version)
    assert.equal(current.bootstrapEntry, bootstrap)
    assert.equal(current.bootstrapIdentity, beforeDigest)
    assert.equal(current.adapters.length, 1)
    assert.deepEqual(current.adapters[0].before, originalAdapter)
    assert.equal(current.adapters[0].after.version, version)
    assert.match(current.adapters[0].after.packageSlot, /^[0-9a-f-]{36}$/)
    assert.equal(await readFile(configFile, "utf8"), encodedRaw)
    assert.equal(await digest(bootstrap), beforeDigest)
    assert.equal(await exists(join(home, "updates", "pending.json")), false)
    assert.equal(await exists(collectorFile), false)
    assert.equal(await exists(maintenanceFile), false)
    assert.ok((await json(join(home, "updates", "state.json"))).nextCheckAt > Date.now())
    const workers = await workerEntries()
    assert.equal(workers.length, 2)
    assert.ok(workers.every(worker => worker.args[0] === "__automatic-update"))
    await waitFor(async () => workers.every(worker => !processExists(worker.pid)),
      async () => "Detached update worker did not exit after activation")
    const requests = (await readFile(metadata, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    assert.equal(requests[0], "https://api.github.com/repos/SingleMai/ATape/releases/latest")
    assert.equal(requests.length, (officialPackages.length + 1) * 2)
    assert.equal(requests[officialPackages.length + 1], requests[0])
    assert.ok(requests.filter(address => address !== requests[0]).every(address => address.endsWith(`/${version}`)))
    const npmCalls = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    assert.ok(npmCalls.some(args => args.includes(`@atape/adapter-codex@${version}`)))
    await writeFile(trace, "")
    const delegated = await command(bootstrap, ["--version"], { ...environment, ATAPE_RUNTIME_DIRECT: "0" })
    assert.equal(delegated.stdout.trim(), `ATape ${version}`)
    const selectedEntry = join(selectedPackage, "dist", "atape.js")
    assert.ok((await entries()).some(item => item.entry === selectedEntry), "npm bootstrap did not delegate to the selected packaged CLI")
    process.stdout.write("Verified packaged independent automatic update worker, bounded Adapter preflight and healthy retry, exact release alignment and bootstrap delegation\n")
  } finally {
    for (const worker of await workerEntries()) {
      try { process.kill(worker.pid, "SIGKILL") } catch (cause) { if (cause.code !== "ESRCH") throw cause }
    }
    if (originalCollector?.exitCode === null) originalCollector.kill("SIGKILL")
    const hung = await json(hangingImport).catch(() => undefined)
    if (hung) {
      try { process.kill(hung.pid, "SIGKILL") } catch (cause) { if (cause.code !== "ESRCH") throw cause }
    }
    const collector = await json(collectorFile).catch(() => undefined)
    if (collector && collector.pid !== originalCollector?.pid) {
      try { process.kill(collector.pid, "SIGKILL") } catch (cause) { if (cause.code !== "ESRCH") throw cause }
    }
  }
}

async function waitFor(check, detail) {
  const deadline = performance.now() + 20_000
  while (performance.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(await detail())
}
