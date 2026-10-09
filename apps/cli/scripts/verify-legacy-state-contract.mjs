import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const json = async file => JSON.parse(await readFile(file, "utf8"))
const digest = async file => createHash("sha256").update(await readFile(file)).digest("hex")
const exists = file => readFile(file).then(() => true, cause => { if (cause.code === "ENOENT") return false; throw cause })
const processExists = pid => {
  try { process.kill(pid, 0); return true } catch (cause) { if (cause.code === "ESRCH") return false; throw cause }
}

// Optional offline acceptance of an unmodified supplied published 0.5.3
// tarball. The current source Interface only dispatches: the process that
// acquires and rejects the v2 candidate must be the exact old bundled worker.
export async function verifyLegacyStateContract(donorPackage, fixtureDirectory, legacyTarball) {
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory)
  const manifest = await json(join(donorPackage, "package.json"))
  assert.equal(manifest.atapeRuntime?.stateContract, "atape.client.v3-capture.v2")
  const version = manifest.version
  const home = join(root, "home"), userHome = join(root, "user"), bin = join(root, "bin")
  const installation = join(root, "install")
  const globalRoot = join(root, "prefix", "lib", "node_modules")
  const bootstrapPackage = join(globalRoot, "@atape", "cli")
  const bootstrap = join(bootstrapPackage, "dist", "atape.js")
  const configFile = join(home, "config", "client.json")
  const trace = join(root, "processes.jsonl"), calls = join(root, "npm.jsonl"), unexpected = join(root, "unexpected.jsonl")
  const preload = join(root, "controlled-external.mjs")
  const environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: userHome, TMPDIR: root,
    ATAPE_HOME: home, ATAPE_LANG: "en", LANG: "en_US.UTF-8", ATAPE_RUNTIME_DIRECT: "1",
    ATAPE_BOOTSTRAP_ENTRY: bootstrap,
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"),
    ATAPE_CODEX_HOME: join(root, "absent-codex"), ATAPE_CLAUDE_HOME: join(root, "absent-claude"),
    ATAPE_OPENCODE_HOME: join(root, "absent-opencode"), OPENCODE_DB: join(root, "absent-opencode.db"),
    ATAPE_CODEBUDDY_HOME: join(root, "absent-codebuddy"), ATAPE_KIMI_HOME: join(root, "absent-kimi"), ATAPE_GROK_HOME: join(root, "absent-grok"),
    npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npm-user.conf"), npm_config_globalconfig: join(root, "npm-global.conf"),
    UPDATE_FIXTURE_VERSION: "0.5.3"
  }
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(userHome, { mode: 0o700 }), mkdir(bin)])
  await execute("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installation, legacyTarball], {
    cwd: root, env: environment, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024
  })
  await cp(join(installation, "node_modules", "@atape", "cli"), bootstrapPackage, { recursive: true })
  const oldManifest = await json(join(bootstrapPackage, "package.json"))
  assert.equal(oldManifest.name, "@atape/cli")
  assert.equal(oldManifest.version, "0.5.3")
  assert.equal(oldManifest.atapeRuntime?.protocol, "atape.runtime.v1")
  assert.equal(oldManifest.atapeRuntime?.stateContract, "atape.client.v3-capture.v1")
  assert.equal(oldManifest.atapeRuntime?.loginStartupProtocol, undefined)
  const oldDigest = await digest(bootstrap), oldManifestDigest = await digest(join(bootstrapPackage, "package.json"))
  const targetDigest = await digest(join(donorPackage, "dist", "atape.js"))
  await writeFile(preload, `import childProcess from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";
const entry = process.argv[1];
if (isMainThread) appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid: process.pid, entry, args: process.argv.slice(2),
  sha256: entry?.startsWith(${JSON.stringify(`${root}/`)}) ? createHash("sha256").update(readFileSync(entry)).digest("hex") : undefined }) + "\\n");
for (const method of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
  const original = childProcess[method];
  childProcess[method] = function(file, ...args) {
    if (["/bin/launchctl", "launchctl", "systemctl", "/bin/systemctl", "/usr/bin/systemctl"].includes(file)) {
      appendFileSync(${JSON.stringify(unexpected)}, JSON.stringify({ method, file, args: args[0] }) + "\\n");
      throw new Error("Native manager commands are forbidden in contract rejection acceptance");
    }
    return Reflect.apply(original, this, [file, ...args]);
  };
}
syncBuiltinESMExports();
globalThis.fetch = async input => {
  const address = String(input);
  if (address === "https://api.github.com/repos/SingleMai/ATape/releases/latest") return Response.json({
    tag_name: ${JSON.stringify(`v${version}`)}, prerelease: false, draft: false, published_at: "2026-01-01T00:00:00Z"
  });
  const parsed = new URL(address), segments = parsed.pathname.slice(1).split("/");
  const name = decodeURIComponent(segments[0]);
  if (parsed.origin !== "https://registry.npmjs.org" || segments.length !== 2 || segments[1] !== ${JSON.stringify(version)} ||
    !["@atape/cli", "@atape/adapter-codex", "@atape/adapter-claude", "@atape/adapter-opencode", "@atape/adapter-codebuddy", "@atape/adapter-kimi", "@atape/adapter-grok"].includes(name))
    throw new Error("Unexpected metadata request in offline rejection acceptance: " + address);
  return Response.json({ name, version: ${JSON.stringify(version)} });
};\n`)
  const npm = join(bin, "npm")
  await writeFile(npm, `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);
if (args[0] === "root" && args.includes("--global")) console.log(${JSON.stringify(globalRoot)});
else if (args[0] === "install" && args.includes(${JSON.stringify(`@atape/cli@${version}`)})) {
  if (!args.includes("--ignore-scripts")) throw new Error("Candidate scripts must stay disabled");
  const prefix = args[args.indexOf("--prefix") + 1];
  if (!prefix?.startsWith(${JSON.stringify(`${home}/releases/.${version}-`)})) throw new Error("Candidate escaped isolated staging");
  fs.cpSync(${JSON.stringify(donorPackage)}, path.join(prefix, "node_modules/@atape/cli"), { recursive: true });
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, targetCopied: true }) + "\\n");
} else throw new Error("Unexpected npm operation: " + JSON.stringify(args));\n`)
  await chmod(npm, 0o700)
  for (const name of ["open", "xdg-open", "rundll32", "launchctl", "systemctl"]) {
    await writeFile(join(bin, name), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(unexpected)}, ${JSON.stringify(`${name}\n`)}); process.exit(73);\n`, { mode: 0o700 })
  }
  environment.PATH = `${bin}:${environment.PATH}`
  environment.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`
  const encodedConfig = `${JSON.stringify({ version: 3, toolsConfigured: true, projects: [], adapters: [], enabledAdapterIds: [], autoStartEnabled: false })}\n`
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(configFile, encodedConfig, { mode: 0o600 })
  const opaqueState = join(home, "capture-preservation-sentinel.json")
  const opaqueBytes = '{"synthetic":true,"purpose":"opaque byte preservation only"}\n'
  await writeFile(opaqueState, opaqueBytes, { mode: 0o600 })
  const command = async (entry, args = []) => execute(process.execPath, [entry, ...args], {
    cwd: root, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  })
  const entries = async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  const workers = async () => (await entries()).filter(item => item.entry?.startsWith(join(home, "updates", "workers")))
  const stateFile = join(home, "updates", "state.json")
  const dispatcher = fileURLToPath(new URL("../src/runtime/fixtures/automatic-update-launch.ts", import.meta.url))
  try {
    assert.equal((await command(bootstrap, ["--version"])).stdout.trim(), "ATape 0.5.3")
    await command(dispatcher)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const state = await json(stateFile).catch(() => undefined)
      const observed = await workers()
      if (state?.failures === 1 && state.failure === "prepare" && observed.length && observed.every(item => !processExists(item.pid)) &&
        (await readdir(join(home, "updates", "workers"))).length === 0) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.deepEqual(await json(stateFile).then(({ failures, failure }) => ({ failures, failure })), { failures: 1, failure: "prepare" })
    const observed = await workers()
    assert.ok(observed.length > 0, "The genuine 0.5.3 worker never ran")
    assert.ok(observed.every(item => item.sha256 === oldDigest && item.args[0] === "__automatic-update" && !processExists(item.pid)),
      "The rejection must come from the unmodified 0.5.3 worker, not current source")
    assert.deepEqual(await readdir(join(home, "updates", "workers")), [], "The rejected worker was not cleaned up")
    assert.ok((await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)).some(item => item.targetCopied),
      "The genuine worker must acquire the actual v2 candidate before rejecting it")
    assert.equal((await entries()).some(item => item.sha256 === targetDigest), false, "The incompatible candidate executable ran")
    for (const file of [join(home, "releases", "current.json"), join(home, "updates", "retained.json"), join(home, "updates", "pending.json"),
      join(home, "state", "collector-process.json"), join(home, "state", "collector-process.json.desired.json"),
      join(home, "state", "collector-process.json.maintenance.json"), join(home, "startup", "registration.json"),
      join(home, "releases", version, "node_modules", "@atape", "cli", "dist", "atape.js")]) assert.equal(await exists(file), false, file)
    assert.equal((await readdir(join(home, "releases"))).some(name => name.startsWith(`.${version}-`)), false)
    assert.equal(await readFile(configFile, "utf8"), encodedConfig)
    assert.equal(await readFile(opaqueState, "utf8"), opaqueBytes)
    assert.equal(await digest(bootstrap), oldDigest)
    assert.equal(await digest(join(bootstrapPackage, "package.json")), oldManifestDigest)
    assert.equal((await command(bootstrap, ["--version"])).stdout.trim(), "ATape 0.5.3")
    const retryState = await readFile(stateFile, "utf8"), workerCount = (await workers()).length
    assert.ok((await json(stateFile)).nextCheckAt > Date.now())
    await command(dispatcher)
    assert.equal((await workers()).length, workerCount, "Retry backoff dispatched another incompatible worker")
    assert.equal(await readFile(stateFile, "utf8"), retryState)
    assert.equal((await entries()).some(item => item.args[0] === "__collector-daemon"), false)
    assert.equal(await exists(unexpected), false)
    await writeFile(join(root, "legacy-state-contract-acceptance.json"), `${JSON.stringify({
      suppliedTarballSha256: await digest(legacyTarball), sourceVersion: "0.5.3", sourceStateContract: oldManifest.atapeRuntime.stateContract,
      suppliedTarballProvenance: "Must be bound to previously verified npm publication evidence by the caller; this offline test does not authenticate registry origin",
      workerSha256: oldDigest, targetVersion: version, targetSha256: targetDigest, targetStateContract: manifest.atapeRuntime.stateContract,
      targetAcquisition: "controlled offline copy of exact installed candidate", targetExecution: false,
      rejectedDuringPreparation: true, activation: false, stoppedInstallationPreserved: true,
      originalConfigAndBootstrapBytesPreserved: true, syntheticOpaqueStatePreserved: true,
      realJournalMigrationVerified: false, nativeCommands: "forbidden", realLoginEventVerified: false
    }, null, 2)}\n`)
    process.stdout.write("Verified genuine supplied 0.5.3 v1 worker rejects the exact installed v2 candidate before execution or activation, preserves original bytes and leaves stopped sync stopped (offline acquisition; not publication or manual-upgrade evidence).\n")
  } finally {
    for (const worker of await workers()) {
      if (!processExists(worker.pid)) continue
      const listing = await execute("ps", ["-p", String(worker.pid), "-o", "command="], { timeout: 2_000, encoding: "utf8" }).catch(() => undefined)
      if (listing?.stdout.includes(root)) process.kill(worker.pid, "SIGKILL")
    }
  }
}
