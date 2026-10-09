import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const json = async file => JSON.parse(await readFile(file, "utf8"))
const exists = file => readFile(file).then(() => true, cause => { if (cause.code === "ENOENT") return false; throw cause })

// Explicit opt-in only: this runs the real current-user native manager. It is
// deliberately absent from verify-package and ordinary CI. The caller supplies
// a disposable unique directory; no Projects, credentials or sources authorize
// collection. Finally removes only this home hash's owned registration.
export async function verifyNativeLoginStartup(donorPackage, fixtureDirectory) {
  assert.ok(process.platform === "darwin" || process.platform === "linux")
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory)
  const home = join(root, "home")
  const userHome = await realpath(homedir())
  const globalRoot = join(root, "prefix", "lib", "node_modules")
  const bootstrapPackage = join(globalRoot, "@atape", "cli")
  const bootstrap = join(bootstrapPackage, "dist", "atape.js")
  const xdg = process.env.XDG_CONFIG_HOME
  const environment = {
    HOME: userHome, PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    ATAPE_HOME: home, ATAPE_BOOTSTRAP_ENTRY: bootstrap, ATAPE_LANG: "en", ATAPE_REDACT_VALUES: "[]",
    XDG_CONFIG_HOME: xdg && isAbsolute(xdg) ? xdg : join(userHome, ".config"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
    ATAPE_CODEX_HOME: join(root, "absent-codex"), ATAPE_CLAUDE_HOME: join(root, "absent-claude"),
    ATAPE_CODEBUDDY_HOME: join(root, "absent-codebuddy"), ATAPE_KIMI_HOME: join(root, "absent-kimi"),
    ATAPE_GROK_HOME: join(root, "absent-grok"), ATAPE_OPENCODE_HOME: join(root, "absent-opencode"), OPENCODE_DB: join(root, "absent-opencode.db"),
    npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npm-user.conf"), npm_config_globalconfig: join(root, "npm-global.conf"),
    LOGIN_FIXTURE_ROOT: root, LOGIN_FIXTURE_GLOBAL_ROOT: globalRoot
  }
  await mkdir(join(home, "config"), { recursive: true, mode: 0o700 })
  await cp(donorPackage, bootstrapPackage, { recursive: true })
  await writeFile(join(home, "config", "client.json"), JSON.stringify({ version: 3, toolsConfigured: true,
    projects: [], adapters: [], enabledAdapterIds: [], autoUpdateEnabled: false }), { mode: 0o600 })
  const sourceFixture = fileURLToPath(new URL("../src/runtime/fixtures/login-startup.ts", import.meta.url))
  const fixture = async operation => JSON.parse((await execute(process.execPath, [sourceFixture, operation, "--native"], {
    cwd: root, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  })).stdout)
  let metadata
  let succeeded = false
  let nativeStatus = ""
  try {
    assert.deepEqual(await fixture("register"), { state: "registered" })
    metadata = await json(join(home, "startup", "registration.json"))
    assert.equal((await fixture("inspect")).state, "registered")
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const args = process.platform === "darwin"
        ? ["print", `gui/${process.getuid()}/${metadata.job}`]
        : ["--user", "show", `${metadata.job}.service`, "--property=ActiveState", "--property=Result", "--property=ExecMainStatus", "--property=ControlGroup"]
      nativeStatus = (await execute(process.platform === "darwin" ? "/bin/launchctl" : "systemctl", args, {
        cwd: root, env: environment, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024
      })).stdout
      succeeded = process.platform === "darwin"
        ? /last exit code = 0/.test(nativeStatus) && /runs = [1-9]/.test(nativeStatus) && /state = not running/.test(nativeStatus)
        : /^Result=success$/m.test(nativeStatus) && /^ExecMainStatus=0$/m.test(nativeStatus) && /^ActiveState=active$/m.test(nativeStatus)
      if (succeeded) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(succeeded, true, `Native manager did not report successful headless helper completion: ${nativeStatus}`)
    assert.equal(await exists(join(home, "state", "collector-process.json")), false, "Empty native acceptance started collection")
  } finally {
    // Preference-off is persisted before removal, making any queued native entry
    // inert even when manager cleanup fails and must be reported to the caller.
    const removed = await fixture("disable")
    assert.equal(removed.state, "missing", `Native registration cleanup did not finish: ${JSON.stringify(removed)}`)
    if (metadata) assert.equal(await exists(metadata.file), false, "Native descriptor survived cleanup")
    assert.equal((await fixture("inspect")).state, "missing")
  }
  const evidence = { platform: process.platform, job: metadata.job, nativeManagerRegistered: true,
    headlessHelperExitStatus: 0, descriptorRemoved: true, registrationRemoved: true,
    collectorStarted: false, realLoginEventVerified: false, linuxCollectorCgroupVerified: false }
  await writeFile(join(root, "native-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`Verified native ${process.platform} user-manager registration, successful empty headless helper and owned cleanup: ${join(root, "native-acceptance.json")}\n`)
}
