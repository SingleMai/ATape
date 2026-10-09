import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const json = async file => JSON.parse(await readFile(file, "utf8"))
const exists = file => readFile(file).then(() => true, cause => { if (cause.code === "ENOENT") return false; throw cause })
const processExists = pid => {
  try { process.kill(pid, 0); return true } catch (cause) { if (cause.code === "ESRCH") return false; throw cause }
}
const waitFor = async (description, check) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

// This accepts the exact npm-installed bundled executable. OS registration is
// controlled at the external command Seam, never installed in the user's OS.
// Native descriptor parsing is evidence of syntax only, not a real OS login.
export async function verifyLoginStartup(donorPackage, fixtureDirectory) {
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory)
  const manifest = await json(join(donorPackage, "package.json"))
  assert.equal(manifest.atapeRuntime?.loginStartupProtocol, "atape.login-startup.v1")
  const home = join(root, "atape home 空格%$")
  const userHome = join(root, "user")
  const globalRoot = join(root, "prefix", "lib", "node_modules")
  const bootstrapPackage = join(globalRoot, "@atape", "cli")
  const bootstrap = join(bootstrapPackage, "dist", "atape.js")
  const launcher = join(home, "startup", "atape.mjs")
  const configFile = join(home, "config", "client.json")
  const processFile = join(home, "state", "collector-process.json")
  const desiredFile = `${processFile}.desired.json`
  const metadataFile = join(home, "startup", "registration.json")
  const collected = join(root, "collected.jsonl")
  const runtimeTrace = join(root, "selected-runtime.jsonl")
  const browserTrace = join(root, "unexpected-browser.jsonl")
  const commandAdapterTrace = join(root, "command-adapter-processes.jsonl")
  const project = join(root, "project")
  const bin = join(root, "bin")
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(userHome, { mode: 0o700 }), mkdir(bin), mkdir(project)])
  await cp(donorPackage, bootstrapPackage, { recursive: true })
  await writeFile(join(root, "controlled-manager.json"), JSON.stringify({ registered: false }))
  const commandPreload = join(root, "controlled-native.mjs")
  // The packaged Collector also reconciles startup. Replace its OS command
  // Adapter through Node's external child_process binding, including absolute
  // /bin/launchctl. A PATH wrapper alone cannot intercept that absolute path.
  await writeFile(commandPreload, `import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
appendFileSync(${JSON.stringify(commandAdapterTrace)}, JSON.stringify({ pid: process.pid, entry: process.argv[1], args: process.argv.slice(2) }) + "\\n");
const original = childProcess.execFile;
childProcess.execFile = function(file, args, options, callback) {
  if (file !== "/bin/launchctl" && file !== "systemctl") return Reflect.apply(original, this, arguments);
  const child = new EventEmitter(); child.kill = () => true;
  queueMicrotask(() => {
    try {
      appendFileSync(${JSON.stringify(join(root, "native-commands.jsonl"))}, JSON.stringify({ origin: "bundle-command-adapter", file, args }) + "\\n");
      const stateFile = ${JSON.stringify(join(root, "controlled-manager.json"))};
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      const absent = () => Object.assign(new Error("Controlled service is absent"), { code: 1 });
      let stdout = "";
      if (file === "/bin/launchctl") {
        if (args[0] === "print" && args[1].split("/").length === 2) stdout = "Controlled GUI domain";
        else if (args[0] === "print") { if (!state.registered) throw absent(); stdout = "Controlled login service"; }
        else if (args[0] === "enable") {}
        else if (args[0] === "bootstrap" && args[2].startsWith(${JSON.stringify(`${root}/`)})) state.registered = true;
        else if (args[0] === "bootout" && args[1].includes("com.atape.login.")) state.registered = false;
        else throw new Error("Unexpected controlled launchctl operation");
      } else {
        if (args.includes("show-environment") || args.includes("daemon-reload") || args.includes("start")) {}
        else if (args.includes("is-enabled")) { if (!state.registered) throw absent(); stdout = "enabled\\n"; }
        else if (args.includes("enable")) state.registered = true;
        else if (args.includes("disable")) state.registered = false;
        else throw new Error("Unexpected controlled systemctl operation");
      }
      writeFileSync(stateFile, JSON.stringify(state));
      callback(null, stdout, "");
    } catch (cause) { callback(cause, "", ""); }
  });
  return child;
};
syncBuiltinESMExports();\n`)
  // A browser launch is observable and fails locally even if a regression enters
  // interactive authentication. No actual browser or service command is run.
  for (const name of ["open", "xdg-open", "rundll32", "launchctl", "systemctl", "npm"]) {
    const command = join(bin, name)
    await writeFile(command, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(browserTrace)}, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + "\\n");\nprocess.exit(73);\n`)
    await chmod(command, 0o755)
  }
  // Do not inherit production credentials, source paths, proxies, NODE_OPTIONS,
  // CI behavior or npm settings from the invoking shell.
  const environment = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: userHome, TMPDIR: root, ATAPE_HOME: home, ATAPE_LANG: "en", LANG: "en_US.UTF-8",
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"),
    ATAPE_BOOTSTRAP_ENTRY: bootstrap, ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_REDACT_VALUES: "[]",
    NODE_OPTIONS: `--import=${pathToFileURL(commandPreload).href}`,
    ATAPE_CODEX_HOME: join(root, "absent-codex"), ATAPE_CLAUDE_HOME: join(root, "absent-claude"),
    ATAPE_CODEBUDDY_HOME: join(root, "absent-codebuddy"), ATAPE_KIMI_HOME: join(root, "absent-kimi"),
    ATAPE_GROK_HOME: join(root, "absent-grok"), ATAPE_OPENCODE_HOME: join(root, "absent-opencode"),
    OPENCODE_DB: join(root, "absent-opencode.db"),
    // A second guard keeps ordinary npm ownership validation fail-closed if a
    // future child intentionally drops the test's external-command Adapter.
    npm_config_prefix: join(root, "inactive-prefix"), npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npm-user.conf"), npm_config_globalconfig: join(root, "npm-global.conf"),
    LOGIN_FIXTURE_ROOT: root, LOGIN_FIXTURE_GLOBAL_ROOT: globalRoot
  }
  const legacyTarball = process.env.ATAPE_VERIFY_LEGACY_CLI_TARBALL
  if (legacyTarball) {
    const legacyInstall = join(root, "legacy-install")
    await execute("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", legacyInstall, legacyTarball], {
      cwd: root, env: { ...environment, PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
      encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024
    })
    const legacyPackage = join(legacyInstall, "node_modules", "@atape", "cli")
    const legacyManifest = await json(join(legacyPackage, "package.json"))
    assert.equal(legacyManifest.version, "0.5.3", "The optional compatibility fixture must be the actual published 0.5.3 CLI")
    assert.equal(legacyManifest.atapeRuntime?.loginStartupProtocol, undefined, "The optional fixture already supports login startup")
    await cp(legacyPackage, bootstrapPackage, { recursive: true, force: true })
  }
  const bootstrapHash = createHash("sha256").update(await readFile(bootstrap)).digest("hex")
  const selectedPackage = join(home, "releases", manifest.version, "node_modules", "@atape", "cli")
  const selectedEntry = join(selectedPackage, "dist", "atape.js")
  const selectInstalledRuntime = async () => {
    await cp(donorPackage, selectedPackage, { recursive: true })
    const selectedSource = await readFile(selectedEntry, "utf8")
    const traceStatement = `import { appendFileSync as loginFixtureTrace } from "node:fs";\nloginFixtureTrace(${JSON.stringify(runtimeTrace)}, JSON.stringify({ entry: process.argv[1], pid: process.pid, args: process.argv.slice(2) }) + "\\n");\n`
    await writeFile(selectedEntry, selectedSource.replace(/^(#![^\n]*\n)?/, match => `${match}${traceStatement}`))
    await writeFile(join(home, "releases", "current.json"), JSON.stringify({
      protocol: "atape.runtime.v1", stateContract: "atape.client.v3-capture.v1", version: manifest.version,
      bootstrapEntry: await realpath(bootstrap), bootstrapIdentity: bootstrapHash, adapters: []
    }))
  }
  // An existing published bootstrap cannot parse __login-start. Registration
  // must use the selected new bundle's stable launcher without replacing npm.
  if (legacyTarball) await selectInstalledRuntime()
  const requests = []
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain the bounded local request */ }
    requests.push(`${request.method} ${request.url}`)
    response.setHeader("Content-Type", "application/json")
    if (request.url === "/api/v1/projects/login-startup-project/raw-capture") {
      response.end(JSON.stringify({ teamPolicy: "personal", userPreference: "disable", enabled: false }))
    } else if (request.url === "/api/v1/instance") {
      response.end(JSON.stringify({ protocol: "atape.instance.v1", instance_origin: origin, web_origin: origin, api_origin: origin,
        protocols: ["atape.cli-authorization.v1", "atape.canonical.v1", "atape.raw.v1"],
        release_version: manifest.version, auth_epoch: "auth-v1", minimum_cli_version: "0.2.0" }))
    } else if (request.url === "/api/v1/users/me") {
      response.end(JSON.stringify({ id: "login-startup-user", displayName: "Login Startup Fixture", avatarUrl: "" }))
    } else {
      response.statusCode = 404
      response.end(JSON.stringify({ status: 404, code: "not_found" }))
    }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  environment.LOGIN_FIXTURE_ORIGIN = origin
  environment.ATAPE_INSTANCE_URL = origin
  const command = async (entry, args) => execute(process.execPath, [entry, ...args], {
    cwd: root, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  })
  const sourceFixture = fileURLToPath(new URL("../src/runtime/fixtures/login-startup.ts", import.meta.url))
  const fixture = async operation => JSON.parse((await command(sourceFixture, [operation])).stdout)
  const login = async token => {
    const result = await command(launcher, ["__login-start", "--startup-token", token])
    assert.equal(result.stdout, "", "Headless login unexpectedly printed terminal output")
    assert.doesNotMatch(result.stderr, /\x1b|Sign in|Open:|Code:|Welcome to ATape|interactive.*terminal/)
    return result
  }
  const adapterPackage = join(home, "adapters", "node_modules", "atape-login-startup-smoke-adapter")
  await mkdir(adapterPackage, { recursive: true })
  await writeFile(join(adapterPackage, "package.json"), JSON.stringify({
    name: "atape-login-startup-smoke-adapter", version: "1.0.0", type: "module", atapeAdapter: {
      protocolVersion: "atape.adapter.v1alpha1", adapterId: "login-smoke", displayName: "Login smoke",
      entry: "./index.js", harnesses: ["login-smoke"], rawCapturePolicy: "atape.raw-capture.v1"
    }
  }))
  await writeFile(join(adapterPackage, "index.js"), `import { appendFile } from "node:fs/promises";\nexport const createAtapeAdapter = async () => ({ collect: async () => {\n  await appendFile(${JSON.stringify(collected)}, JSON.stringify({ pid: process.pid }) + "\\n");\n  return { protocolVersion: "atape.adapter.v1alpha1", nextCursor: null, hasMore: false, observations: [] };\n} });\n`)
  await mkdir(dirname(configFile), { recursive: true })
  const at = "2026-10-09T00:00:00Z"
  await writeFile(configFile, JSON.stringify({ version: 3, toolsConfigured: true, enabledAdapterIds: ["login-smoke"],
    autoUpdateEnabled: false, // Missing autoStartEnabled deliberately accepts the default-on contract.
    activeInstanceOrigin: origin,
    adapters: [{ adapterId: "login-smoke", packageName: "atape-login-startup-smoke-adapter", upgradeSpec: adapterPackage,
      displayName: "Login smoke", version: "1.0.0", installedAt: at, updatedAt: at }],
    projects: [{ id: "login-startup-project", instanceOrigin: origin, userId: "login-startup-user", teamId: "login-startup-team",
      teamSlug: "login-startup", teamName: "Login startup", name: "Login project", type: "directory", path: project, createdAt: at }]
  }), { mode: 0o600 })
  let collectorPid
  try {
    assert.deepEqual(await fixture("credential"), { saved: true })
    assert.deepEqual(await fixture("register"), { state: "registered" })
    const metadata = await json(metadataFile)
    assert.equal(metadata.bootstrap, await realpath(bootstrap))
    assert.equal(metadata.launcher, launcher)
    assert.equal(createHash("sha256").update(await readFile(launcher)).digest("hex"), metadata.launcherHash)
    assert.equal(metadata.enabled, true)
    assert.equal(metadata.environment.NODE_OPTIONS, undefined)
    assert.equal(metadata.privateEnvironment.NODE_OPTIONS, undefined)
    assert.equal((await fixture("inspect")).enabled, true)
    assert.ok(metadata.file.startsWith(`${root}/`), "Native descriptor escaped the isolated fixture")
    if (process.platform === "darwin") {
      await execute("/usr/bin/plutil", ["-lint", "--", metadata.file], { timeout: 2_000 })
      const parsed = JSON.parse((await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", metadata.file], { timeout: 2_000 })).stdout)
      assert.deepEqual(parsed.ProgramArguments, [await realpath(process.execPath), launcher, "__login-start", "--startup-token", metadata.token])
    }
    await assert.rejects(login(randomUUID()), cause => cause.code === 1 && /registered ATape installation/.test(cause.stderr))
    assert.equal(await exists(processFile), false)
    await login(metadata.token)
    assert.equal(await exists(processFile), false, "Login without durable sync intent started collection")
    assert.deepEqual(await json(desiredFile), { version: 1, wanted: false })

    const started = await fixture("start")
    collectorPid = started.pid
    await waitFor("the installed background Collector's successful cycle", async () => {
      const statusFile = join(home, "state", "collector-status.json")
      return await exists(statusFile) && (await json(statusFile)).jobs.some(job => job.adapterId === "login-smoke" && job.lastSuccessAt && !job.lastFailureAt)
    })
    assert.equal(await exists(collected), true)
    assert.ok((await readFile(commandAdapterTrace, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      .some(item => item.pid === collectorPid && item.args[0] === "__collector-daemon"), "The installed Collector did not inherit the controlled OS command Adapter")
    await login(metadata.token)
    await login(metadata.token)
    assert.equal((await json(processFile)).pid, collectorPid, "Repeated login created competing Collectors")
    assert.equal(processExists(collectorPid), true, "Exiting login stopped background collection")
    const collectorGroup = Number((await execute("ps", ["-p", String(collectorPid), "-o", "pgid="], { timeout: 2_000 })).stdout.trim())
    const consoleGroup = Number((await execute("ps", ["-p", String(process.pid), "-o", "pgid="], { timeout: 2_000 })).stdout.trim())
    assert.equal(collectorGroup, collectorPid, "Collector does not own its detached process group")
    assert.notEqual(collectorGroup, consoleGroup, "Collector lifetime is still bound to the login caller's process group")
    assert.equal(await fixture("pause"), true)
    await waitFor("maintenance pause to stop the Collector", () => !processExists(collectorPid))
    const pausedIntent = await json(desiredFile)
    assert.equal(pausedIntent.wanted, true)
    assert.equal(pausedIntent.intervalMs, 23_000)
    assert.equal(pausedIntent.concurrency, 2)
    assert.equal((await json(processFile)).restartPending, true)

    // A managed selection is a real copied installed bundle, with a disposable
    // trace statement to prove which runtime admitted login and collection.
    if (!legacyTarball) await selectInstalledRuntime()
    await login(metadata.token)
    await waitFor("login to resume the selected installed Collector", async () => {
      if (!(await exists(processFile))) return false
      const record = await json(processFile)
      return record.pid !== collectorPid && processExists(record.pid)
    })
    const resumed = await json(processFile)
    collectorPid = resumed.pid
    assert.equal(resumed.intervalMs, 23_000)
    assert.equal(resumed.concurrency, 2)
    await waitFor("the selected Collector executable to enter", async () =>
      (await readFile(runtimeTrace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
        .some(item => item.entry === selectedEntry && item.pid === collectorPid && item.args[0] === "__collector-daemon"))
    const traces = (await readFile(runtimeTrace, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    assert.ok((await readFile(commandAdapterTrace, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      .some(item => item.pid === collectorPid), "The resumed Collector lost the controlled OS command Adapter")
    assert.ok(traces.some(item => item.entry === selectedEntry && item.args[0] === "__collector-daemon"), "Login bound the Collector to the obsolete bootstrap")
    assert.ok(traces.some(item => item.entry === selectedEntry && item.args[0] === "__login-start"), "Login did not delegate to a capable selected runtime")
    assert.equal((await json(metadataFile)).bootstrap, await realpath(bootstrap), "Registration was rebound to a disposable version directory")

    assert.deepEqual(await fixture("disable"), { state: "missing" })
    assert.equal((await json(configFile)).autoStartEnabled, false)
    assert.equal((await json(metadataFile)).enabled, false)
    assert.equal(await exists(metadata.file), false)
    await login(metadata.token)
    assert.equal((await json(processFile)).pid, collectorPid, "Disabling future login stopped current sync")
    assert.equal(await fixture("pause"), true)
    await waitFor("disabled fixture pause", () => !processExists(collectorPid))
    await login(metadata.token)
    assert.equal(processExists((await json(processFile)).pid), false, "Queued disabled login resumed collection")
    assert.equal((await json(processFile)).restartPending, true)
    assert.equal((await json(desiredFile)).wanted, true, "Disabling login erased the user's sync intent")

    assert.deepEqual(await fixture("enable"), { state: "registered" })
    await login((await json(metadataFile)).token)
    await waitFor("reenabled login Collector", async () => {
      const record = await json(processFile)
      return record.pid !== collectorPid && processExists(record.pid)
    })
    collectorPid = (await json(processFile)).pid
    assert.equal(await fixture("stop"), true)
    await waitFor("explicit Stop", () => !processExists(collectorPid))
    assert.deepEqual(await json(desiredFile), { version: 1, wanted: false })
    await login((await json(metadataFile)).token)
    assert.equal(await exists(processFile), false, "Login revived explicitly stopped collection")
    if (legacyTarball) {
      const legacyStop = fileURLToPath(new URL("verify-legacy-stop.py", import.meta.url))
      const stopFromLegacyUI = async entry => {
        await mkdir(join(home, "cache"), { recursive: true })
        await writeFile(join(home, "cache", "cli-update.json"), JSON.stringify({ checkedAt: Date.now(), version: "0.5.3" }))
        await execute("python3", [legacyStop, entry], {
          // Retain the actual old UI while it controls the currently selected
          // new Collector, as an already-open pre-update console would do.
          cwd: root, env: { ...environment, ATAPE_RUNTIME_DIRECT: "1" }, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024
        })
      }
      const currentStarted = await fixture("start")
      collectorPid = currentStarted.pid
      await stopFromLegacyUI(bootstrap)
      await waitFor("legacy Stop of the selected current Collector", () => !processExists(collectorPid))
      assert.equal(await exists(processFile), false)
      assert.equal((await json(desiredFile)).wanted, true, "The legacy UI unexpectedly implemented new durable Stop")
      await login((await json(metadataFile)).token)
      assert.equal(await exists(processFile), false, "Login revived a current Collector stopped by an older open UI")

      // Exercise the actual older TUI's Stop, which predates durable desired
      // state. Rollback must keep the new coordinator inert rather than revive
      // that stopped Collector from the newer sidecar's stale wanted=true.
      await cp(join(root, "legacy-install", "node_modules", "@atape", "cli"), selectedPackage, { recursive: true, force: true })
      assert.equal((await fixture("inspect")).state, "unsupported")
      const legacyStarted = await fixture("start")
      collectorPid = legacyStarted.pid
      await stopFromLegacyUI(selectedEntry)
      await waitFor("the published legacy TUI Stop", () => !processExists(collectorPid))
      assert.equal(await exists(processFile), false)
      assert.equal((await json(desiredFile)).wanted, true, "The legacy fixture did not exercise pre-intent Stop behavior")
      await login((await json(metadataFile)).token)
      assert.equal(await exists(processFile), false, "Rollback login revived collection stopped by the legacy TUI")
    }
    assert.equal(await exists(browserTrace), false, "Headless login invoked a browser/npm/native manager")
    assert.equal(requests.some(request => /auth\/cli\/device-grants|auth\/cli\/token/.test(request)), false, "Login requested interactive authorization")
    assert.equal(createHash("sha256").update(await readFile(bootstrap)).digest("hex"), bootstrapHash, "Login modified npm's bootstrap")
    await writeFile(join(root, "login-startup-acceptance.json"), `${JSON.stringify({
      version: manifest.version, platform: process.platform, nativeCommands: "controlled", headlessEntry: true,
      defaultOn: true, repeatLoginSingleCollector: true, detachedCollectorProcessGroup: true,
      disabledQueuedLoginInert: true, durableStop: true, selectedRuntime: true, preservedSchedule: true,
      ...(legacyTarball ? { legacyPublishedBootstrap: { version: "0.5.3", sha256: createHash("sha256").update(await readFile(legacyTarball)).digest("hex") },
        legacyTuiStopCurrentCollector: true, legacyTuiStopAfterRollback: true } : {}),
      realLoginEventVerified: false, linuxCollectorCgroupVerified: false
    }, null, 2)}\n`)
    process.stdout.write(`Verified installed headless login, default-on preference, repeat ownership, durable Stop, disabled queued entries, selected runtime and preserved schedule using controlled native commands${legacyTarball ? "; retained published 0.5.3 npm bootstrap compatibility and real legacy TUI Stop against current and rolled-back Collectors" : ""}.\n`)
  } finally {
    await fixture("stop").catch(() => undefined)
    const lastRecord = await json(processFile).catch(() => undefined)
    for (const pid of new Set([collectorPid, lastRecord?.pid].filter(Boolean))) {
      if (!processExists(pid)) continue
      // This PID was returned by our own public Start/resume and also must have
      // the unique fixture entry in ps before emergency cleanup can signal it.
      const { stdout } = await execute("ps", ["-p", String(pid), "-o", "command="], { timeout: 2_000 }).catch(() => ({ stdout: "" }))
      if (stdout.includes(root)) process.kill(pid, "SIGKILL")
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
