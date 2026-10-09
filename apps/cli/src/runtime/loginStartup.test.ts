import { LoginStartupPlatform } from "@atape/application"
import { emptyClientConfig } from "@atape/domain"
import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { admitLoginStartup, makeLoginStartupPlatformLayer, withLoginStartupRecovery } from "./loginStartup.ts"
import { atomicJSON, managedStateContract, runtimeEntry, selectRuntime } from "./runtimeSelection.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import type { executeOwnedProcess } from "./ownedProcess.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const commandFailure = (code: number) => Object.assign(new Error("Controlled external manager failure"), { code })
const inspect = () => LoginStartupPlatform.use(platform => platform.inspect())
const reconcile = (enabled: boolean) => LoginStartupPlatform.use(platform => platform.reconcile(enabled))
const fixture = async (platform: "darwin" | "linux" = "darwin", suffix = "") => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atape-login-"))); roots.push(root)
  const home = join(root, `atape${suffix}`), userHome = join(root, "user"), xdg = join(root, "config")
  await mkdir(home, { mode: 0o700 }); await mkdir(userHome, { mode: 0o700 }); await mkdir(xdg, { mode: 0o700 })
  const paths = defaultNodeClientPaths({ ATAPE_HOME: home })
  const modules = join(root, `prefix${suffix}`, "lib", "node_modules"), entry = join(modules, "@atape", "cli", "dist", "atape.js")
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, "// disposable npm-global bootstrap\n")
  await writeFile(join(dirname(dirname(entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version: "0.5.3",
    atapeRuntime: { loginStartupProtocol: "atape.login-startup.v1" } }))
  await atomicJSON(paths.configFile, { ...emptyClientConfig(), toolsConfigured: true })
  const environment: NodeJS.ProcessEnv = { HOME: userHome, PATH: `relative-dropped:.:${dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: xdg, ATAPE_HOME: home, ATAPE_CODEX_HOME: join(root, "codex"),
    ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_SOURCE_COLLECTION_LIMITS: '{"maxSourceBytes":1048576}',
    ATAPE_REDACT_VALUES: '["private-login-redaction"]', HTTPS_PROXY: "http://private-proxy-user:private-proxy-pass@proxy.test:8080",
    NODE_EXTRA_CA_CERTS: join(root, "custom-ca.pem"), NPM_TOKEN: "never-persist-token", NODE_OPTIONS: "never-persist-node-options" }
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number }[] = []
  const state = { available: true, registered: false, starts: 0, failRegistration: false, npmRoot: modules }
  let custom: typeof executeOwnedProcess | undefined
  const execute: typeof executeOwnedProcess = async (file, args, env, signal, timeout) => {
    calls.push({ file, args, env, timeout })
    expect(signal).toBeInstanceOf(AbortSignal); expect(timeout).toBeLessThanOrEqual(10_000)
    if (custom) return custom(file, args, env, signal, timeout)
    if (file === "npm") return `${state.npmRoot}\n`
    if (!state.available) throw commandFailure(1)
    if (file === "/bin/launchctl") {
      if (args[0] === "print" && args[1]?.split("/").length === 2) return "GUI login domain"
      if (args[0] === "print") { if (!state.registered) throw commandFailure(113); return "ATape login service" }
      if (args[0] === "bootstrap") {
        if (state.failRegistration) throw commandFailure(5)
        state.registered = true; state.starts++; return ""
      }
      if (args[0] === "bootout") { state.registered = false; return "" }
      if (args[0] === "enable") return ""
    } else if (file === "systemctl") {
      if (args.includes("show-environment") || args.includes("daemon-reload")) return ""
      if (args.includes("is-enabled")) { if (!state.registered) throw commandFailure(1); return "enabled\n" }
      if (args.includes("enable")) { if (state.failRegistration) throw commandFailure(5); state.registered = true; return "" }
      if (args.includes("disable")) { state.registered = false; return "" }
      if (args.includes("start")) { state.starts++; return "" }
    }
    throw new Error("Unexpected external command")
  }
  const layer = (env = environment, executable = entry, nativePlatform: NodeJS.Platform = platform) => makeLoginStartupPlatformLayer(paths,
    executable, env, { platform: nativePlatform, homeDirectory: userHome, execute })
  const run = <A, E>(effect: Effect.Effect<A, E, LoginStartupPlatform>, env = environment, executable = entry,
    nativePlatform: NodeJS.Platform = platform, signal?: AbortSignal) => Effect.runPromise(effect.pipe(Effect.provide(layer(env, executable, nativePlatform))), signal ? { signal } : undefined)
  const metadataFile = join(home, "startup", "registration.json")
  const metadata = async () => JSON.parse(await readFile(metadataFile, "utf8")) as { token: string; file: string; job: string; enabled: boolean;
    launcher: string; launcherHash: string; precedingLauncherHash?: string;
    environment: Record<string, string>; privateEnvironment: Record<string, string>; hash: string; precedingHash?: string }
  return { root, home, paths, userHome, environment, entry, modules, calls, state, run, metadataFile, metadata,
    setExecute: (value: typeof executeOwnedProcess | undefined) => { custom = value } }
}

describe("native login startup Adapter", () => {
  it("leaves unfinished/disabled first setup entirely unregistered", async () => {
    const client = await fixture()
    expect(await client.run(inspect())).toEqual({ state: "missing" })
    expect(await client.run(reconcile(false))).toEqual({ state: "missing" })
    expect(client.calls).toHaveLength(0)
    await expect(readFile(client.metadataFile)).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("registers a private macOS LaunchAgent against bootstrap and reconciles unchanged state without relaunch", async () => {
    const client = await fixture("darwin", " 空格&<标签>$%")
    expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
    const metadata = await client.metadata(), content = await readFile(metadata.file, "utf8")
    expect(metadata.file).toBe(join(client.userHome, "Library", "LaunchAgents", `${metadata.job}.plist`))
    expect(content).toContain("RunAtLoad"); expect(content).toContain("SuccessfulExit")
    expect(content).toContain("&amp;&lt;标签&gt;$%")
    expect(content).not.toContain("private-login-redaction"); expect(content).not.toContain("private-proxy-pass")
    expect(content).not.toContain("never-persist")
    expect((await lstat(metadata.file)).mode & 0o777).toBe(0o600)
    expect((await lstat(client.metadataFile)).mode & 0o777).toBe(0o600)
    if (process.platform === "darwin") {
      const exec = promisify(execFile)
      await exec("/usr/bin/plutil", ["-lint", "--", metadata.file], { timeout: 2_000 })
      const { stdout } = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", metadata.file], { timeout: 2_000 })
      const plist = JSON.parse(stdout)
      expect(plist.ProgramArguments).toEqual([process.execPath, metadata.launcher, "__login-start", "--startup-token", metadata.token])
      expect(plist.EnvironmentVariables.ATAPE_HOME).toBe(client.home)
      expect(plist.Umask).toBe(63); expect(plist.ExitTimeOut).toBe(10)
      expect(plist.AbandonProcessGroup).toBe(false)
    }
    expect(await client.run(inspect())).toEqual({ state: "registered" })
    await client.run(reconcile(true)); expect(client.state.starts).toBe(1)
    expect(client.calls.some(call => call.args.includes("kickstart"))).toBe(false)
    expect(await readFile(metadata.launcher, "utf8")).toBe(await readFile(client.entry, "utf8"))
    expect((await lstat(metadata.launcher)).mode & 0o777).toBe(0o600)
    await client.run(reconcile(false))
    expect(await client.run(inspect())).toEqual({ state: "missing" })
    expect((await client.metadata()).enabled).toBe(false)
    await expect(readFile(metadata.file)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await admitLoginStartup(client.paths, metadata.token, client.entry, {})).toBeUndefined()
  })
  it("keeps Linux oneshot cgroups active and disables future login without stopping Collector/updater", async () => {
    const client = await fixture("linux", ' 空格%$\\" ')
    expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
    const metadata = await client.metadata(), content = await readFile(metadata.file, "utf8")
    expect(metadata.file).toBe(join(client.environment.XDG_CONFIG_HOME!, "systemd", "user", `${metadata.job}.service`))
    expect(content).toContain("Type=oneshot\nRemainAfterExit=yes")
    expect(content).toContain("Restart=on-failure\nRestartSec=30s")
    expect(content).toContain("TimeoutStartSec=90s\nTimeoutStopSec=10s\nKillMode=control-group")
    expect(content).toContain(`WorkingDirectory=${client.home.replaceAll("%", "%%")}/.\n`)
    expect(content).toContain(' 空格%%$$\\\\\\"')
    expect(content).toContain("WantedBy=default.target")
    expect(content).not.toContain("private-proxy-pass"); expect(content).not.toContain("private-login-redaction")
    expect(client.calls.find(call => call.args.includes("start"))?.args).toContain("--no-block")
    await client.run(reconcile(true)); expect(client.state.starts).toBe(1)
    await client.run(reconcile(false)); await client.run(reconcile(false))
    expect(client.calls.filter(call => call.args.includes("disable"))).toHaveLength(1)
    expect(client.calls.some(call => call.args.some(arg => ["--now", "stop", "restart", "enable-linger"].includes(arg)))).toBe(false)
    await expect(readFile(metadata.file)).rejects.toMatchObject({ code: "ENOENT" })
  })
  it.runIf(process.platform === "linux")("verifies the rendered Linux unit with the real offline systemd parser when available", async context => {
    const exec = promisify(execFile)
    try { await exec("systemd-analyze", ["--version"], { timeout: 2_000 }) }
    catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
        context.skip("systemd-analyze is not installed")
        return
      }
      throw cause
    }
    const client = await fixture("linux", ' 空格%$\\" ')
    await client.run(reconcile(true))
    const metadata = await client.metadata(), runtime = join(client.root, "runtime")
    await mkdir(runtime, { mode: 0o700 })
    // verify creates an in-process test manager. It parses the descriptor and
    // checks ExecStart without connecting to or starting a real user service.
    const { stdout } = await exec("systemd-analyze", ["--user", "--man=no", "--generators=no", "--recursive-errors=no", "verify", metadata.file], {
      timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: client.userHome, XDG_CONFIG_HOME: client.environment.XDG_CONFIG_HOME,
        XDG_RUNTIME_DIR: runtime, SYSTEMD_LOG_LEVEL: "debug", SYSTEMD_LOG_COLOR: "0", LANG: "C.UTF-8" }
    })
    expect(stdout).toContain("Type: oneshot")
    expect(stdout).toContain("RemainAfterExit: yes")
    expect(stdout).toContain(`WorkingDirectory: ${client.home}`)
    expect(stdout).toMatch(new RegExp(`Command Line: .*__login-start --startup-token ${metadata.token}(?:\\n|$)`))
    expect(stdout).toContain("atape.mjs")
    expect(client.state.starts).toBe(1)
  })
  it("preserves private redaction, proxy and CA context at admitted login without persisting unrelated tokens", async () => {
    const client = await fixture()
    await client.run(reconcile(true)); const metadata = await client.metadata()
    const admitted = await admitLoginStartup(client.paths, metadata.token, metadata.launcher, { LOGIN_SESSION: "retained" })
    expect(admitted).toMatchObject({ LOGIN_SESSION: "retained", ATAPE_REDACT_VALUES: client.environment.ATAPE_REDACT_VALUES,
      HTTPS_PROXY: client.environment.HTTPS_PROXY, NODE_EXTRA_CA_CERTS: client.environment.NODE_EXTRA_CA_CERTS,
      ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_SOURCE_COLLECTION_LIMITS: client.environment.ATAPE_SOURCE_COLLECTION_LIMITS,
      ATAPE_HOME: client.home, ATAPE_BOOTSTRAP_ENTRY: client.entry, ATAPE_CODEX_HOME: client.environment.ATAPE_CODEX_HOME })
    expect(admitted?.NPM_TOKEN).toBeUndefined(); expect(admitted?.NODE_OPTIONS).toBeUndefined()
    expect(admitted?.PATH?.split(":")).not.toContain(".")
    expect(await readFile(client.metadataFile, "utf8")).not.toContain("never-persist")
    await expect(admitLoginStartup(client.paths, metadata.token, metadata.launcher, {})).resolves.toBeDefined()
    await expect(admitLoginStartup(client.paths, "invalid", client.entry)).rejects.toMatchObject({ reason: "identity" })
    const foreign = join(client.root, "foreign.js"); await writeFile(foreign, "")
    await expect(admitLoginStartup(client.paths, metadata.token, foreign)).rejects.toMatchObject({ reason: "identity" })
    await atomicJSON(client.paths.configFile, { ...emptyClientConfig(), toolsConfigured: true, autoStartEnabled: false })
    expect(await admitLoginStartup(client.paths, metadata.token, client.entry)).toBeUndefined()
    await atomicJSON(client.paths.configFile, emptyClientConfig())
    expect(await admitLoginStartup(client.paths, metadata.token, client.entry)).toBeUndefined()
  })
  it("serializes simultaneous registration and retains a single admitted job identity", async () => {
    const client = await fixture("linux")
    expect(await Promise.all([client.run(reconcile(true)), client.run(reconcile(true))])).toEqual([{ state: "registered" }, { state: "registered" }])
    expect(client.state.starts).toBe(1)
    const metadata = await client.metadata()
    expect(await admitLoginStartup(client.paths, metadata.token, client.entry)).toBeDefined()
  })
  it.each(["pending", "maintenance"] as const)("defers first registration and leaves an existing launcher untouched while %s recovery is pending", async kind => {
    const client = await fixture("linux")
    const pending = kind === "pending" ? join(client.home, "updates", "pending.json") : `${client.paths.collectorProcessFile}.maintenance.json`
    const mark = () => atomicJSON(pending, kind === "pending"
      ? { next: { protocol: "atape.runtime.v1", stateContract: managedStateContract, version: "0.5.4", bootstrapEntry: client.entry, adapters: [] } }
      : { version: 1, token: "pending", generation: 0, phase: "failed" })
    await mark()
    expect(await client.run(reconcile(true))).toMatchObject({ state: "unavailable", message: expect.stringContaining("recovery is pending") })
    expect(client.calls).toHaveLength(0)
    await expect(readFile(client.metadataFile)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(client.home, "startup", "atape.mjs"))).rejects.toMatchObject({ code: "ENOENT" })
    await rm(pending)
    expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
    const metadata = await client.metadata()
    const before = await Promise.all([client.metadataFile, metadata.launcher, metadata.file].map(file => readFile(file, "utf8")))
    await writeFile(client.entry, "// newer capable bundle\n")
    await mark()
    expect(await client.run(reconcile(true), { ...client.environment, ATAPE_CODEX_HOME: join(client.root, "changed-codex") })).toMatchObject({ state: "unavailable" })
    expect(await Promise.all([client.metadataFile, metadata.launcher, metadata.file].map(file => readFile(file, "utf8")))).toEqual(before)
    expect(client.state.starts).toBe(1)
    await rm(pending)
    expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
    expect(await readFile(metadata.launcher, "utf8")).toBe("// newer capable bundle\n")
  })
  it("retains explicit private and provider context when reopened from a shell without those overrides", async () => {
    const client = await fixture("linux")
    await client.run(reconcile(true)); const original = await client.metadata()
    const next = { ...client.environment }
    delete next.ATAPE_REDACT_VALUES; delete next.HTTPS_PROXY; delete next.NODE_EXTRA_CA_CERTS; delete next.ATAPE_CODEX_HOME; delete next.XDG_CONFIG_HOME
    delete next.ATAPE_DEVELOPMENT_ALLOW_HTTP; delete next.ATAPE_SOURCE_COLLECTION_LIMITS
    await client.run(reconcile(true), next)
    const admitted = await admitLoginStartup(client.paths, original.token, client.entry, {})
    expect(admitted?.ATAPE_REDACT_VALUES).toBe(client.environment.ATAPE_REDACT_VALUES)
    expect(admitted?.HTTPS_PROXY).toBe(client.environment.HTTPS_PROXY)
    expect(admitted?.ATAPE_CODEX_HOME).toBe(client.environment.ATAPE_CODEX_HOME)
    expect(admitted?.XDG_CONFIG_HOME).toBe(client.environment.XDG_CONFIG_HOME)
    expect(admitted?.ATAPE_DEVELOPMENT_ALLOW_HTTP).toBe("true")
    expect(admitted?.ATAPE_SOURCE_COLLECTION_LIMITS).toBe(client.environment.ATAPE_SOURCE_COLLECTION_LIMITS)
    expect(client.state.starts).toBe(1)
    await client.run(reconcile(true), { ...next, HTTPS_PROXY: "", ATAPE_SOURCE_COLLECTION_LIMITS: "" })
    const cleared = await admitLoginStartup(client.paths, original.token, client.entry, { ATAPE_SOURCE_COLLECTION_LIMITS: "stale queued override" })
    expect(cleared?.HTTPS_PROXY).toBe("")
    expect(cleared?.ATAPE_SOURCE_COLLECTION_LIMITS).toBeUndefined()
  })
  it("copies a capable managed runtime over an old npm bootstrap and becomes inert across a pre-feature rollback", async () => {
    const client = await fixture("linux")
    await writeFile(join(dirname(dirname(client.entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version: "0.5.3" }))
    expect(await client.run(reconcile(true))).toMatchObject({ state: "unsupported" })
    const select = async (version: string, capable: boolean) => {
      const entry = runtimeEntry(client.home, version)
      await mkdir(dirname(entry), { recursive: true, mode: 0o700 })
      await writeFile(entry, `// bundled ${version} ${capable ? "capable" : "legacy"}\n`)
      await writeFile(join(dirname(dirname(entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version,
        atapeRuntime: { protocol: "atape.runtime.v1", stateContract: managedStateContract,
          ...(capable ? { loginStartupProtocol: "atape.login-startup.v1" } : {}) } }))
      await selectRuntime(client.home, { protocol: "atape.runtime.v1", stateContract: managedStateContract,
        version, bootstrapEntry: client.entry, adapters: [] })
      return entry
    }
    const first = await select("0.5.4", true)
    expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
    const metadata = await client.metadata()
    expect(await readFile(metadata.launcher, "utf8")).toBe(await readFile(first, "utf8"))
    expect(await admitLoginStartup(client.paths, metadata.token, metadata.launcher)).toBeDefined()
    expect(await admitLoginStartup(client.paths, metadata.token, first)).toBeDefined()
    await expect(admitLoginStartup(client.paths, metadata.token, client.entry)).rejects.toMatchObject({ reason: "identity" })
    const newer = await select("0.5.5", true)
    await client.run(reconcile(true))
    const retained = await readFile(newer, "utf8")
    expect(await readFile(metadata.launcher, "utf8")).toBe(retained)
    await select("0.5.3", false)
    expect(await client.run(reconcile(true))).toMatchObject({ state: "unsupported" })
    expect(await client.run(inspect())).toMatchObject({ state: "unsupported" })
    expect(await admitLoginStartup(client.paths, metadata.token, metadata.launcher)).toBeUndefined()
    expect(await readFile(metadata.launcher, "utf8")).toBe(retained)
    expect(client.state.starts).toBe(1)
  })
  it("repairs a missing owned launcher after interrupted registration but rejects changed launcher bytes", async () => {
    const client = await fixture()
    await client.run(reconcile(true)); const metadata = await client.metadata()
    await rm(metadata.launcher)
    expect(await client.run(inspect())).toEqual({ state: "missing" })
    await expect(admitLoginStartup(client.paths, metadata.token, client.entry)).rejects.toMatchObject({ reason: "identity" })
    await client.run(reconcile(true))
    expect(await readFile(metadata.launcher, "utf8")).toBe(await readFile(client.entry, "utf8"))
    expect(client.state.starts).toBe(1)
    await writeFile(metadata.launcher, "// foreign launcher")
    await expect(client.run(reconcile(true))).rejects.toMatchObject({ reason: "identity" })
    await expect(admitLoginStartup(client.paths, metadata.token, metadata.launcher)).rejects.toMatchObject({ reason: "identity" })
    expect(await client.run(reconcile(false))).toEqual({ state: "missing" })
    expect(await readFile(metadata.launcher, "utf8")).toBe("// foreign launcher")
  })
  it("repairs registration failures and launch context changes without restarting an active Linux cgroup", async () => {
    const client = await fixture("linux")
    client.state.failRegistration = true
    await expect(client.run(reconcile(true))).rejects.toMatchObject({ reason: "registration" })
    const originalToken = (await client.metadata()).token
    client.state.failRegistration = false
    await client.run(reconcile(true))
    expect((await client.metadata()).token).toBe(originalToken)
    expect(client.state.starts).toBe(1)
    await client.run(reconcile(true), { ...client.environment, ATAPE_CODEX_HOME: join(client.root, "changed-codex") })
    expect(client.state.starts).toBe(1)
    expect((await client.metadata()).environment.ATAPE_CODEX_HOME).toBe(join(client.root, "changed-codex"))
    expect((await client.metadata()).precedingHash).toBeUndefined()
  })
  it("recovers an interrupted descriptor replacement through its retained owned hash", async () => {
    const client = await fixture("linux")
    await client.run(reconcile(true)); const metadata = await client.metadata()
    const previous = await readFile(metadata.file, "utf8"), directory = dirname(metadata.file)
    const environment = { ...client.environment, ATAPE_CODEX_HOME: join(client.root, "replacement-codex") }
    await chmod(directory, 0o500)
    try {
      await expect(client.run(reconcile(true), environment)).rejects.toMatchObject({ reason: "state" })
      expect(await readFile(metadata.file, "utf8")).toBe(previous)
      expect((await client.metadata()).precedingHash).toBe(metadata.hash)
    } finally { await chmod(directory, 0o700) }
    await client.run(reconcile(true), environment)
    expect(await readFile(metadata.file, "utf8")).toContain("replacement-codex")
    expect((await client.metadata()).precedingHash).toBeUndefined()
    expect(client.state.starts).toBe(1)
  })
  it("makes queued login inert even when disabling cannot reach the user manager", async () => {
    const client = await fixture()
    await client.run(reconcile(true)); const metadata = await client.metadata()
    client.state.available = false
    expect(await client.run(reconcile(false))).toMatchObject({ state: "unavailable" })
    expect((await client.metadata()).enabled).toBe(false)
    expect(await admitLoginStartup(client.paths, metadata.token, client.entry)).toBeUndefined()
    client.state.available = true
    expect(await client.run(reconcile(false))).toEqual({ state: "missing" })
  })
  it("reports missing managers and unsupported installs without installing fallback jobs", async () => {
    const client = await fixture("linux")
    client.state.available = false
    expect(await client.run(reconcile(true))).toMatchObject({ state: "unavailable" })
    await expect(readFile(client.metadataFile)).rejects.toMatchObject({ code: "ENOENT" })
    client.state.available = true
    const foreign = join(client.root, "dev-entry.ts"); await writeFile(foreign, "")
    expect(await client.run(reconcile(true), client.environment, foreign)).toMatchObject({ state: "unsupported" })
    expect(await client.run(reconcile(true), client.environment, client.entry, "win32")).toMatchObject({ state: "unsupported" })
    expect(client.calls.some(call => call.args.includes("enable"))).toBe(false)
  })
  it.each([undefined, "", "relative-config"])("uses the Linux default config directory for invalid XDG_CONFIG_HOME=%s", async xdg => {
    const client = await fixture("linux")
    await client.run(reconcile(true), { ...client.environment, XDG_CONFIG_HOME: xdg })
    expect((await client.metadata()).file).toBe(join(client.userHome, ".config", "systemd", "user", `${(await client.metadata()).job}.service`))
  })
  it("refuses public control characters and modified or symlinked private registration files", async () => {
    const client = await fixture()
    await expect(client.run(reconcile(true), { ...client.environment, LANG: "en\nInjected" })).rejects.toMatchObject({ reason: "identity" })
    await client.run(reconcile(true)); const metadata = await client.metadata()
    const original = await readFile(metadata.file, "utf8")
    await writeFile(metadata.file, `${original}\nforeign change\n`)
    await expect(client.run(reconcile(true))).rejects.toMatchObject({ reason: "identity" })
    await writeFile(metadata.file, original); await chmod(metadata.file, 0o644)
    await expect(client.run(inspect())).rejects.toMatchObject({ reason: "identity" })
    await chmod(metadata.file, 0o600)
    const outside = join(client.root, "outside"); await writeFile(outside, original, { mode: 0o600 })
    await rm(metadata.file); await symlink(outside, metadata.file)
    await expect(client.run(reconcile(false))).rejects.toMatchObject({ reason: "identity" })
    expect(await readFile(outside, "utf8")).toBe(original)
  })
  it("rejects a symlinked startup metadata directory before reading or rewriting its files", async () => {
    const client = await fixture()
    const directory = join(client.home, "startup"), outside = join(client.root, "outside-startup")
    await mkdir(outside, { mode: 0o700 }); await symlink(outside, directory)
    await expect(client.run(reconcile(true))).rejects.toMatchObject({ reason: "identity" })
    await expect(admitLoginStartup(client.paths, "invalid", client.entry)).rejects.toMatchObject({ reason: "identity" })
  })
  it("waits for a cancelled manager Adapter and releases registration ownership only after it completes", async () => {
    const client = await fixture()
    let entered = false, release!: () => void
    const completion = new Promise<string>(resolve => { release = () => resolve("") })
    client.setExecute(async (_file, _args, _env, signal) => { entered = true; await completion; if (signal.aborted) throw signal.reason; return client.modules })
    const cancellation = new AbortController()
    let settled = false
    const pending = client.run(reconcile(true), client.environment, client.entry, "darwin", cancellation.signal)
      .then(() => "finished", () => "cancelled").finally(() => { settled = true })
    await expect.poll(() => entered).toBe(true)
    cancellation.abort()
    expect(settled).toBe(false)
    release(); expect(await pending).toBe("cancelled")
    client.setExecute(undefined)
    expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
  })
  it("shares update ownership through recovery and resume, including when no recovery is needed", async () => {
    const client = await fixture()
    const release = await acquireUpdateWorker(client.home)
    expect(release).toBeDefined()
    try {
      await expect(withLoginStartupRecovery(client.paths, client.entry, {}, async () => {})).rejects.toMatchObject({ reason: "manager" })
      await atomicJSON(`${client.paths.collectorProcessFile}.maintenance.json`, { version: 1, token: "pending", generation: 0, phase: "failed" })
      await expect(withLoginStartupRecovery(client.paths, client.entry, {}, async () => {})).rejects.toMatchObject({ reason: "manager" })
    } finally { release?.() }
    let resumed = false
    await expect(withLoginStartupRecovery(client.paths, client.entry, {}, async () => {
      expect(await acquireUpdateWorker(client.home)).toBeUndefined()
      resumed = true
    })).resolves.toBeUndefined()
    expect(resumed).toBe(true)
    await expect(readFile(`${client.paths.collectorProcessFile}.maintenance.json`)).rejects.toMatchObject({ code: "ENOENT" })
    const owner = await acquireUpdateWorker(client.home); expect(owner).toBeDefined(); owner?.()
    await expect(withLoginStartupRecovery(client.paths, client.entry, {}, async () => { throw new Error("Controlled resume failure") })).rejects.toMatchObject({ reason: "state" })
    const afterFailure = await acquireUpdateWorker(client.home); expect(afterFailure).toBeDefined(); afterFailure?.()
  })
})
