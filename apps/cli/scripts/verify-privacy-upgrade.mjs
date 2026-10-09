import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { verifyAutomaticUpdate } from "./verify-automatic-update.mjs"

const execute = promisify(execFile)
const json = async file => JSON.parse(await readFile(file, "utf8"))
const digest = async file => createHash("sha256").update(await readFile(file)).digest("hex")
// npm registry dist metadata verified for the immutable published 0.5.4 package.
// Supplying another version or a rebuilt lookalike cannot satisfy this fixture.
const baselineIntegrity = "sha512-8MMBBHPuWfnSNW72k2zDZOLzKpBV6grlMBgZGh+z5/xMdL71f/QHatrSJHDatT+KuM1alv7QueWZ2krd7xwodA=="

/** Optional offline acceptance; the caller supplies downloaded historical and
 * exact candidate tarballs. All npm writes and OS interactions stay isolated. */
export async function verifyPrivacyUpgrade(donorPackage, fixtureDirectory, baselineTarball, candidateTarball) {
  assert.equal(`sha512-${createHash("sha512").update(await readFile(baselineTarball)).digest("base64")}`, baselineIntegrity,
    "Privacy upgrade requires the exact npm-published 0.5.4 tarball")
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory)
  const realNpm = (await execute("which", ["npm"], { encoding: "utf8" })).stdout.trim()
  assert.ok(realNpm.startsWith("/"), "The real npm executable must be identified before installing the isolated command Adapter")
  const candidate = await realpath(candidateTarball)
  const nativeCalls = join(root, "forbidden-native.jsonl")
  const nativeGuard = join(root, "guard-native.mjs")
  await writeFile(nativeGuard, `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";
for (const method of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
  const original = childProcess[method];
  childProcess[method] = function(file, ...args) {
    if (["launchctl", "systemctl", "open", "xdg-open", "rundll32"].includes(basename(file))) {
      appendFileSync(${JSON.stringify(nativeCalls)}, JSON.stringify({ method, file }) + "\\n");
      throw new Error("Native login/browser commands are forbidden in isolated upgrade acceptance");
    }
    return Reflect.apply(original, this, [file, ...args]);
  };
}
syncBuiltinESMExports();\n`)
  const environment = {
    PATH: process.env.PATH, HOME: join(root, "user"), TMPDIR: root, LANG: "en_US.UTF-8", ATAPE_LANG: "en",
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"),
    ATAPE_CODEX_HOME: join(root, "absent-codex"), ATAPE_CLAUDE_HOME: join(root, "absent-claude"),
    ATAPE_GROK_HOME: join(root, "absent-grok"), ATAPE_KIMI_HOME: join(root, "absent-kimi"),
    ATAPE_CODEBUDDY_HOME: join(root, "absent-codebuddy"), OPENCODE_DB: join(root, "absent-opencode.db"),
    ATAPE_REDACT_VALUES: "[]",
    npm_config_prefix: join(root, "automatic", "prefix"), npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npm-user.conf"), npm_config_globalconfig: join(root, "npm-global.conf"),
    PRIVACY_FIXTURE_REAL_NPM: realNpm, PRIVACY_FIXTURE_ORIGINAL_PATH: process.env.PATH,
    PRIVACY_FIXTURE_PREFIX: join(root, "automatic", "prefix"), PRIVACY_FIXTURE_CANDIDATE_TARBALL: candidate,
    PRIVACY_FIXTURE_BASELINE_VERSION: "0.5.4", PRIVACY_FIXTURE_NODE: process.execPath, NODE_OPTIONS: `--import=${pathToFileURL(nativeGuard).href}`
  }
  await mkdir(environment.HOME, { mode: 0o700 })
  const installation = join(root, "historical")
  await execute(realNpm, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installation, baselineTarball],
    { cwd: root, env: environment, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  const baselinePackage = join(installation, "node_modules", "@atape", "cli")
  assert.equal((await json(join(baselinePackage, "package.json"))).version, "0.5.4")
  const baselineEntryDigest = await digest(join(baselinePackage, "dist", "atape.js"))
  const upgraded = await verifyAutomaticUpdate(donorPackage, join(root, "automatic"), { bootstrapPackage: baselinePackage, environment })
  assert.equal(upgraded.beforeDigest, baselineEntryDigest)
  const env = { ...upgraded.environment, ATAPE_RUNTIME_DIRECT: "0" }
  const command = (entry, args = []) => execute(process.execPath, [entry, ...args], {
    cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  })
  const sample = join(root, "sample.json")
  await writeFile(sample, '{"message":"ticket=private-alpha","password":"x"}\n')
  await assert.rejects(command(upgraded.bootstrap, ["redaction-test", sample]), error => error.code === 2 && error.stdout === "",
    "The historical bootstrap must retain its actual pre-delegation argument grammar")
  assert.match((await command(upgraded.bootstrap, ["--help"])).stdout, /redaction-test/)
  // Stop auto checks for deterministic navigation; this is a deliberate fixture
  // preference edit after the old worker's byte-preservation assertions above.
  const beforePreferences = await json(upgraded.configFile)
  const settingsConfig = { ...beforePreferences, autoUpdateEnabled: false }
  await writeFile(upgraded.configFile, `${JSON.stringify(settingsConfig)}\n`, { mode: 0o600 })
  await mkdir(join(upgraded.home, "cache"), { recursive: true })
  await writeFile(join(upgraded.home, "cache", "cli-update.json"), JSON.stringify({ checkedAt: Date.now(), version: upgraded.version }))
  const terminal = fileURLToPath(new URL("verify-privacy-upgrade-terminal.py", import.meta.url))
  process.stdout.write((await execute("python3", [terminal, upgraded.bootstrap, root], { cwd: root, env, encoding: "utf8", timeout: 45_000 })).stdout)
  const entries = async () => (await readFile(upgraded.trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  assert.ok((await entries()).some(item => item.entry === upgraded.selectedEntry && item.args.length === 0),
    "The old bootstrap must actually delegate the Settings console to the installed candidate")
  assert.equal(await digest(upgraded.bootstrap), baselineEntryDigest)
  const manual = fileURLToPath(new URL("../src/runtime/fixtures/privacy-bootstrap-upgrade.ts", import.meta.url))
  const result = JSON.parse((await command(manual)).stdout.trim())
  assert.deepEqual(result, { version: upgraded.version, updated: true, resumed: false })
  const targetDigest = await digest(join(donorPackage, "dist", "atape.js"))
  assert.equal(await digest(upgraded.bootstrap), targetDigest, "Real npm global entry refresh must install the exact candidate")
  assert.notEqual(targetDigest, baselineEntryDigest)
  const afterPreferences = await json(upgraded.configFile)
  const selected = await json(upgraded.currentFile)
  assert.deepEqual(afterPreferences, { ...settingsConfig, adapters: [selected.adapters[0].after] },
    "Refreshing npm must preserve the selected official Adapter overlay and all user preferences")
  const tested = await command(upgraded.bootstrap, ["redaction-test", sample])
  assert.deepEqual(JSON.parse(tested.stdout), { message: "ticket=private-alpha", password: "[REDACTED]" })
  assert.match(tested.stderr, /Redaction test:/)
  process.stdout.write((await execute("python3", [terminal, upgraded.bootstrap, root], { cwd: root, env, encoding: "utf8", timeout: 45_000 })).stdout)
  for (const [file, bytes] of upgraded.preserved) assert.equal(await readFile(file, "utf8"), bytes)
  assert.equal((await readdir(join(upgraded.home, "state"))).some(name => name.includes("redaction-key") || name === "collector-process.json"), false,
    "Entry refresh, Settings inspection and local test must not start collection or initialize its policy identity")
  await assert.rejects(readFile(nativeCalls), { code: "ENOENT" })
  const evidence = {
    baselineVersion: "0.5.4", baselineIntegrity, baselineTarballSha256: await digest(baselineTarball), baselineEntrySha256: baselineEntryDigest,
    candidateVersion: upgraded.version, candidateTarballSha256: await digest(candidate), candidateEntrySha256: targetDigest,
    baselineWorkerUnmodified: true, metadataAndAutomaticAcquisition: "controlled offline Adapter; exact installed candidate",
    realNpmEntryRefresh: "actual npm install --global --prefix isolated-prefix exact-candidate.tgz --offline --ignore-scripts",
    managedSettingsBeforeEntryRefresh: true, oldBootstrapRedactionTestExitCode: 2, redactionTestAfterEntryRefresh: true,
    selectedAdapterOverlayPreserved: true, syntheticExistingV2CheckpointBytesPreserved: true, stopIntentPreserved: true,
    candidateCollectorStarted: false, providerCaptureTested: false, policyHistoryReconciliation: "existing shared Host caller contracts; not simulated by this upgrade fixture",
    realLoginOrRebootTested: false, publicationVerified: false
  }
  await writeFile(join(root, "privacy-upgrade-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`Verified genuine 0.5.4 privacy upgrade: ${JSON.stringify(evidence)}\n`)
}
