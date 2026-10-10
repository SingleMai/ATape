import { UpdateWakePlatform } from "@atape/application"
import { emptyClientConfig } from "@atape/domain"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { executeOwnedProcess } from "./ownedProcess.ts"
import { atomicJSON, managedStateContract, runtimeEntry, selectRuntime } from "./runtimeSelection.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { admitUpdateWake, makeUpdateWakePlatformLayer } from "./updateWake.ts"
import { createUpdateControl, updateControlProtocol, type UpdateRuntimeSelection } from "./updateControl.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const inspect = () => UpdateWakePlatform.use(platform => platform.inspect())
const reconcile = (enabled: boolean) => UpdateWakePlatform.use(platform => platform.reconcile(enabled))
const commandFailure = (code: number) => Object.assign(new Error("Controlled native manager failure"), { code })
const fixture = async (platform: "darwin" | "linux" = "darwin", suffix = "") => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atape-update-wake-"))); roots.push(root)
  const home = join(root, `atape${suffix}`), userHome = join(root, "user"), xdg = join(root, "config")
  for (const path of [home, userHome, xdg]) await mkdir(path, { mode: 0o700 })
  const paths = defaultNodeClientPaths({ ATAPE_HOME: home })
  const modules = join(root, `prefix${suffix}`, "lib", "node_modules"), entry = join(modules, "@atape", "cli", "dist", "atape.js")
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, "// disposable capable npm bootstrap\n")
  const manifestFile = join(dirname(dirname(entry)), "package.json")
  await atomicJSON(manifestFile, { name: "@atape/cli", version: "0.5.5", atapeRuntime: { updateWakeProtocol: "atape.update-wake.v1" } })
  await atomicJSON(paths.configFile, { ...emptyClientConfig(), toolsConfigured: true, autoStartEnabled: false })
  const environment: NodeJS.ProcessEnv = { HOME: userHome, ATAPE_HOME: home, XDG_CONFIG_HOME: xdg,
    PATH: `.:relative:${dirname(process.execPath)}:/usr/bin:/bin`, ATAPE_CODEX_HOME: join(root, "codex"),
    ATAPE_REDACT_VALUES: '["private-wake-redaction"]', HTTPS_PROXY: "http://private-wake-proxy:secret@proxy.test",
    NODE_EXTRA_CA_CERTS: join(root, "ca.pem"), NPM_TOKEN: "never-persist-token", NODE_OPTIONS: "never-persist-options" }
  const calls: { file: string; args: string[]; timeout: number }[] = []
  const state = { available: true, registered: false, active: false, disabled: false, starts: 0, failRegistration: false, npmRoot: modules }
  let custom: typeof executeOwnedProcess | undefined
  const execute: typeof executeOwnedProcess = async (file, args, env, signal, timeout) => {
    calls.push({ file, args, timeout })
    expect(timeout).toBeLessThanOrEqual(10_000); expect(signal).toBeInstanceOf(AbortSignal)
    if (custom) return custom(file, args, env, signal, timeout)
    if (file === "npm") return `${state.npmRoot}\n`
    if (!state.available) throw commandFailure(1)
    if (file === "/bin/launchctl") {
      if (args[0] === "print" && args[1]?.split("/").length === 2) return "GUI domain"
      if (args[0] === "print") { if (!state.registered) throw commandFailure(113); return "Update wake" }
      if (args[0] === "print-disabled") return `disabled services = {\n "${(await metadata()).job}" => ${state.disabled}\n}\n`
      if (args[0] === "bootstrap") { if (state.failRegistration) throw commandFailure(5); state.registered = true; state.starts++; return "" }
      if (args[0] === "bootout") { state.registered = false; return "" }
      if (args[0] === "disable") { state.disabled = true; return "" }
      if (args[0] === "enable") { state.disabled = false; return "" }
    } else if (file === "systemctl") {
      if (args.includes("show-environment") || args.includes("daemon-reload")) return ""
      if (args.includes("is-enabled")) { if (!state.registered) throw commandFailure(1); return "enabled\n" }
      if (args.includes("is-active")) { if (!state.active) throw commandFailure(3); return "active\n" }
      if (args.includes("enable")) { if (state.failRegistration) throw commandFailure(5); state.registered = true; return "" }
      if (args.includes("disable")) { state.registered = false; return "" }
      if (args.includes("start")) { state.active = true; state.starts++; return "" }
      if (args.includes("stop")) { state.active = false; return "" }
    }
    throw new Error("Unexpected external command")
  }
  const run = <A, E>(program: Effect.Effect<A, E, UpdateWakePlatform>, env = environment, executable = entry,
    nativePlatform: NodeJS.Platform = platform, signal?: AbortSignal) => Effect.runPromise(program.pipe(Effect.provide(
      makeUpdateWakePlatformLayer(paths, executable, env, { platform: nativePlatform, homeDirectory: userHome, execute }))), signal ? { signal } : undefined)
  const metadataFile = join(home, "updates", "wakeup", "registration.json")
  const metadata = async () => JSON.parse(await readFile(metadataFile, "utf8")) as { token: string; job: string; enabled: boolean;
    launcher: string; launcherHash: string; precedingLauncherHash?: string; descriptors: { file: string; hash: string; precedingHash?: string }[];
    environment: Record<string, string>; privateEnvironment: Record<string, string> }
  return { root, home, userHome, paths, modules, entry, manifestFile, environment, state, calls, run, metadataFile, metadata,
    setExecute: (value: typeof executeOwnedProcess | undefined) => { custom = value } }
}

const disable = async (client: Awaited<ReturnType<typeof fixture>>) => {
  await atomicJSON(client.paths.configFile, { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: false })
  return client.run(reconcile(false))
}

describe("independent native update wake Adapter", () => {
  it("leaves disabled unfinished setup unregistered", async () => {
    const client = await fixture()
    expect(await client.run(inspect())).toEqual({ state: "missing" })
    expect(await disable(client)).toEqual({ state: "missing" })
    expect(client.calls).toHaveLength(0)
    await expect(readFile(client.metadataFile)).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("registers one hourly macOS calendar job with private context and repairs a disabled registration", async () => {
    const client = await fixture("darwin", " 空格&<标签>$%")
    expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
    const metadata = await client.metadata(), file = metadata.descriptors[0]!.file, content = await readFile(file, "utf8")
    expect(file).toBe(join(client.userHome, "Library", "LaunchAgents", `${metadata.job}.plist`))
    expect(content).toContain("StartCalendarInterval"); expect(content).not.toContain("KeepAlive")
    expect(content).toContain("&amp;&lt;标签&gt;$%"); expect(content).not.toContain("private-wake")
    expect(content).not.toContain("never-persist"); expect(content).not.toContain("secret@")
    for (const path of [file, client.metadataFile, metadata.launcher]) expect((await lstat(path)).mode & 0o777).toBe(0o600)
    if (process.platform === "darwin") {
      const exec = promisify(execFile)
      await exec("/usr/bin/plutil", ["-lint", "--", file], { timeout: 2_000 })
      const { stdout } = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", file], { timeout: 2_000 })
      const plist = JSON.parse(stdout)
      expect(plist.ProgramArguments).toEqual([await realpath(process.execPath), metadata.launcher, "__update-wake", "--wake-token", metadata.token])
      expect(plist.RunAtLoad).toBe(true); expect(plist.AbandonProcessGroup).toBe(false)
      expect(plist.StartCalendarInterval).toEqual({ Minute: parseInt(createHash("sha256").update(client.home).digest("hex").slice(0, 8), 16) % 60 })
    }
    expect(await client.run(inspect())).toEqual({ state: "registered" })
    await client.run(reconcile(true)); expect(client.state.starts).toBe(1)
    client.state.disabled = true
    expect(await client.run(inspect())).toEqual({ state: "missing" })
    await client.run(reconcile(true)); expect(client.state.disabled).toBe(false); expect(client.state.starts).toBe(1)
    await disable(client)
    expect(client.state.disabled).toBe(true)
    expect(client.calls.some(call => call.args.includes("bootout"))).toBe(false)
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(metadata.launcher, "utf8")).toBe(await readFile(client.entry, "utf8"))
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toMatchObject({ ATAPE_UPDATE_WAKE_RECOVERY_ONLY: "1" })
    await atomicJSON(client.paths.configFile, { ...emptyClientConfig(), toolsConfigured: true })
    await client.run(reconcile(true)); expect(client.state.disabled).toBe(false)
    expect((await client.metadata()).token).toBe(metadata.token)
  })
  it("uses a repeatable Linux timer and disables only future timer scheduling", async () => {
    const client = await fixture("linux", ' 空格%$\\" ')
    expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
    const metadata = await client.metadata(), [service, timer] = metadata.descriptors
    const serviceText = await readFile(service!.file, "utf8"), timerText = await readFile(timer!.file, "utf8")
    expect(serviceText).toContain("Type=oneshot\nRemainAfterExit=no")
    expect(serviceText).toContain("TimeoutStartSec=600s\nTimeoutStopSec=40s\nKillMode=process")
    expect(serviceText).not.toContain("Restart="); expect(serviceText).not.toContain("private-wake")
    expect(serviceText).toContain(`WorkingDirectory=${client.home.replaceAll("%", "%%")}/.\n`)
    expect(serviceText).toContain(' 空格%%$$\\\\\\"')
    expect(timerText).toMatch(/OnCalendar=\*-\*-\* \*:\d{2}:00/)
    expect(timerText).toContain(`Persistent=true\nUnit=${metadata.job}.service`)
    expect(timerText).toContain("WantedBy=timers.target")
    await client.run(reconcile(true)); expect(client.state.starts).toBe(1)
    client.state.active = false
    expect(await client.run(inspect())).toEqual({ state: "missing" })
    await client.run(reconcile(true)); expect(client.state.active).toBe(true)
    await disable(client)
    const stop = client.calls.filter(call => call.args.includes("stop"))
    expect(stop).toHaveLength(1); expect(stop[0]!.args.at(-1)).toBe(`${metadata.job}.timer`)
    expect(client.calls.some(call => call.args.includes("restart") || call.args.includes("enable-linger") || call.args.includes("--now"))).toBe(false)
    for (const descriptor of metadata.descriptors) await expect(readFile(descriptor.file)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await client.metadata()).enabled).toBe(false)
  })
  it("admits updates independently of login startup and rereads the saved automatic-update preference", async () => {
    const client = await fixture()
    await client.run(reconcile(true)); const metadata = await client.metadata()
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toBeDefined()
    const config = { ...emptyClientConfig(), toolsConfigured: true, autoStartEnabled: true, autoUpdateEnabled: false }
    await atomicJSON(client.paths.configFile, config)
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toMatchObject({ ATAPE_UPDATE_WAKE_RECOVERY_ONLY: "1" })
    await atomicJSON(client.paths.configFile, emptyClientConfig())
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toMatchObject({ ATAPE_UPDATE_WAKE_RECOVERY_ONLY: "1" })
  })
  it("retains trusted recovery authority after disable without admitting ordinary checks", async () => {
    const client = await fixture("linux")
    await client.run(reconcile(true)); const metadata = await client.metadata()
    await disable(client)
    await atomicJSON(client.paths.configFile, { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: false })
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toMatchObject({ ATAPE_UPDATE_WAKE_RECOVERY_ONLY: "1" })
    const maintenance = `${client.paths.collectorProcessFile}.maintenance.json`
    await atomicJSON(maintenance, { version: 1, token: "pending", generation: 0, phase: "failed" })
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toBeDefined()
    await expect(admitUpdateWake(client.paths, "invalid", metadata.launcher, {})).rejects.toMatchObject({ reason: "identity" })
    const foreign = join(client.root, "foreign.mjs"); await writeFile(foreign, "// foreign\n")
    await expect(admitUpdateWake(client.paths, metadata.token, foreign, {})).rejects.toMatchObject({ reason: "identity" })
    await rm(maintenance)
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toMatchObject({ ATAPE_UPDATE_WAKE_RECOVERY_ONLY: "1" })
  })
  it.each(["owned-before-intent", "durable-pending"] as const)("retains recovery-only scheduling after disable with %s and removes it only when idle", async stage => {
    const client = await fixture("linux")
    await client.run(reconcile(true)); const metadata = await client.metadata()
    await atomicJSON(client.paths.configFile, { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: false })
    const maintenance = `${client.paths.collectorProcessFile}.maintenance.json`
    const release = stage === "owned-before-intent" ? await acquireUpdateWorker(client.home) : undefined
    if (stage === "durable-pending") await atomicJSON(maintenance, { version: 1, token: "pending", generation: 0, phase: "failed" })
    try {
      expect(await disable(client)).toEqual({ state: "registered" })
      expect((await client.metadata()).enabled).toBe(false)
      expect(client.state.active).toBe(true)
      expect(await client.run(inspect())).toEqual({ state: "registered" })
      for (const item of metadata.descriptors) expect(await readFile(item.file, "utf8")).toBeTruthy()
      expect(client.calls.some(call => call.args.includes("stop") || call.args.includes("disable"))).toBe(false)
      expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toMatchObject({ ATAPE_UPDATE_WAKE_RECOVERY_ONLY: "1" })
    } finally { release?.(); if (stage === "durable-pending") await rm(maintenance) }
    expect(await disable(client)).toEqual({ state: "missing" })
    expect(client.state.active).toBe(false)
    for (const item of metadata.descriptors) await expect(readFile(item.file)).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("does not enroll a stale enabled request after the saved preference turns off", async () => {
    const client = await fixture("linux")
    await atomicJSON(client.paths.configFile, { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: false })
    expect(await client.run(reconcile(true))).toEqual({ state: "missing" })
    expect(client.calls).toHaveLength(0)
    await expect(readFile(client.metadataFile)).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("does not remove a newer enabled registration from stale recovery cleanup", async () => {
    const client = await fixture("linux")
    await client.run(reconcile(true)); const metadata = await client.metadata()
    expect(await client.run(reconcile(false))).toEqual({ state: "registered" })
    expect((await client.metadata()).enabled).toBe(true)
    expect(client.state.active).toBe(true)
    expect(client.calls.some(call => call.args.includes("disable") || call.args.includes("stop"))).toBe(false)
    for (const item of metadata.descriptors) expect(await readFile(item.file, "utf8")).toBeTruthy()
  })
  it("preserves private/provider context across shells and keeps credentials out of native descriptors", async () => {
    const client = await fixture("linux")
    await client.run(reconcile(true)); const metadata = await client.metadata(), env = { ...client.environment }
    for (const name of ["ATAPE_REDACT_VALUES", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "ATAPE_CODEX_HOME", "XDG_CONFIG_HOME"]) delete env[name]
    await client.run(reconcile(true), env)
    const admitted = await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})
    expect(admitted).toMatchObject({ ATAPE_REDACT_VALUES: client.environment.ATAPE_REDACT_VALUES,
      HTTPS_PROXY: client.environment.HTTPS_PROXY, NODE_EXTRA_CA_CERTS: client.environment.NODE_EXTRA_CA_CERTS,
      ATAPE_CODEX_HOME: client.environment.ATAPE_CODEX_HOME, XDG_CONFIG_HOME: client.environment.XDG_CONFIG_HOME })
    expect(admitted?.NPM_TOKEN).toBeUndefined(); expect(admitted?.NODE_OPTIONS).toBeUndefined()
    expect(admitted?.PATH?.split(":")).not.toContain(".")
    expect(await readFile(client.metadataFile, "utf8")).not.toContain("never-persist")
    await client.run(reconcile(true), { ...env, HTTPS_PROXY: "", ATAPE_SOURCE_COLLECTION_LIMITS: "" })
    const cleared = await admitUpdateWake(client.paths, metadata.token, metadata.launcher, { ATAPE_SOURCE_COLLECTION_LIMITS: "stale" })
    expect(cleared?.HTTPS_PROXY).toBe(""); expect(cleared?.ATAPE_SOURCE_COLLECTION_LIMITS).toBeUndefined()
  })
  it("serializes registration and defers copying while update ownership or recovery is pending", async () => {
    const client = await fixture("linux")
    expect(await Promise.all([client.run(reconcile(true)), client.run(reconcile(true))])).toEqual([{ state: "registered" }, { state: "registered" }])
    expect(client.state.starts).toBe(1)
    const metadata = await client.metadata(), before = await readFile(metadata.launcher, "utf8")
    await writeFile(client.entry, "// new candidate bytes\n")
    const release = await acquireUpdateWorker(client.home)
    try { expect(await client.run(reconcile(true))).toMatchObject({ state: "unavailable" }) } finally { release?.() }
    const maintenance = `${client.paths.collectorProcessFile}.maintenance.json`
    await atomicJSON(maintenance, { version: 1, token: "pending", generation: 0, phase: "failed" })
    expect(await client.run(reconcile(true))).toMatchObject({ state: "unavailable" })
    expect(await readFile(metadata.launcher, "utf8")).toBe(before)
    await rm(maintenance); await client.run(reconcile(true))
    expect(await readFile(metadata.launcher, "utf8")).toBe("// new candidate bytes\n")
  })
  it("copies a capable managed runtime and retains it through an incapable rollback", async () => {
    const client = await fixture("linux")
    await atomicJSON(client.manifestFile, { name: "@atape/cli", version: "0.5.4" })
    expect(await client.run(reconcile(true))).toMatchObject({ state: "unsupported" })
    const select = async (version: string, capable: boolean) => {
      const entry = runtimeEntry(client.home, version); await mkdir(dirname(entry), { recursive: true })
      await writeFile(entry, `// selected ${version}\n`)
      await atomicJSON(join(dirname(dirname(entry)), "package.json"), { name: "@atape/cli", version,
        atapeRuntime: { protocol: "atape.runtime.v1", stateContract: managedStateContract,
          ...(capable ? { updateWakeProtocol: "atape.update-wake.v1" } : {}) } })
      await selectRuntime(client.home, { protocol: "atape.runtime.v1", stateContract: managedStateContract, version, bootstrapEntry: client.entry, adapters: [] })
      return entry
    }
    const capable = await select("0.5.5", true)
    await client.run(reconcile(true)); const metadata = await client.metadata(), copy = await readFile(metadata.launcher, "utf8")
    expect(copy).toBe(await readFile(capable, "utf8"))
    expect(await admitUpdateWake(client.paths, metadata.token, capable, {})).toBeDefined()
    await expect(admitUpdateWake(client.paths, metadata.token, client.entry, {})).rejects.toMatchObject({ reason: "identity" })
    await select("0.5.4", false)
    expect(await client.run(reconcile(true))).toMatchObject({ state: "unsupported" })
    expect(await client.run(inspect())).toMatchObject({ state: "unsupported" })
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toBeUndefined()
    expect(await readFile(metadata.launcher, "utf8")).toBe(copy)
  })
  it("admits the stable launcher to recover an unavailable selected candidate", async () => {
    const client = await fixture()
    const identity = createHash("sha256").update(await readFile(client.entry)).digest("hex")
    const generation = async (version: string): Promise<UpdateRuntimeSelection> => {
      const entry = runtimeEntry(client.home, version); await mkdir(dirname(entry), { recursive: true })
      await writeFile(entry, `// capable ${version}\n`)
      await atomicJSON(join(dirname(dirname(entry)), "package.json"), { name: "@atape/cli", version,
        atapeRuntime: { stateContract: managedStateContract, updateControlProtocol, updateWakeProtocol: "atape.update-wake.v1" } })
      return { protocol: updateControlProtocol, captureStateContract: managedStateContract, version,
        bootstrapEntry: client.entry, bootstrapIdentity: identity, adapters: [] }
    }
    const bridge = await generation("0.5.5")
    await selectRuntime(client.home, { protocol: "atape.runtime.v1", stateContract: managedStateContract,
      version: bridge.version, bootstrapEntry: client.entry, bootstrapIdentity: identity, adapters: [] })
    await client.run(reconcile(true)); const metadata = await client.metadata()
    const target = await generation("0.5.6"), control = createUpdateControl(client.home)
    const ticket = await control.prepare({ previous: bridge, next: target }); await control.begin(ticket)
    await rm(runtimeEntry(client.home, target.version))
    await atomicJSON(client.paths.configFile, { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: false })
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toMatchObject({ ATAPE_BOOTSTRAP_ENTRY: client.entry })
    const before = await readFile(metadata.launcher, "utf8"); await writeFile(metadata.launcher, "// tampered\n")
    await expect(admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).rejects.toMatchObject({ reason: "identity" })
    await writeFile(metadata.launcher, before)
  })
  it("reports unavailable managers without claiming registration and disables queued work before manager calls", async () => {
    const client = await fixture()
    client.state.available = false
    expect(await client.run(reconcile(true))).toMatchObject({ state: "unavailable" })
    await expect(readFile(client.metadataFile)).rejects.toMatchObject({ code: "ENOENT" })
    client.state.available = true; await client.run(reconcile(true)); const metadata = await client.metadata()
    client.state.available = false
    expect(await disable(client)).toMatchObject({ state: "unavailable" })
    expect((await client.metadata()).enabled).toBe(false)
    expect(await admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).toMatchObject({ ATAPE_UPDATE_WAKE_RECOVERY_ONLY: "1" })
  })
  it("repairs partial registration with the same token and owned preceding descriptor hashes", async () => {
    const client = await fixture("linux")
    client.state.failRegistration = true
    await expect(client.run(reconcile(true))).rejects.toMatchObject({ reason: "registration" })
    const token = (await client.metadata()).token
    client.state.failRegistration = false; await client.run(reconcile(true))
    const metadata = await client.metadata(), old = await readFile(metadata.descriptors[0]!.file, "utf8")
    await chmod(dirname(metadata.descriptors[0]!.file), 0o500)
    try {
      await expect(client.run(reconcile(true), { ...client.environment, ATAPE_CODEX_HOME: join(client.root, "changed-codex") })).rejects.toMatchObject({ reason: "state" })
      expect(await readFile(metadata.descriptors[0]!.file, "utf8")).toBe(old)
      expect((await client.metadata()).descriptors[0]!.precedingHash).toBe(metadata.descriptors[0]!.hash)
    } finally { await chmod(dirname(metadata.descriptors[0]!.file), 0o700) }
    await client.run(reconcile(true), { ...client.environment, ATAPE_CODEX_HOME: join(client.root, "changed-codex") })
    expect((await client.metadata()).token).toBe(token)
    expect((await client.metadata()).descriptors.every(item => item.precedingHash === undefined)).toBe(true)
  })
  it("rejects foreign descriptors, symlinks and corrupt private metadata without overwriting them", async () => {
    const client = await fixture()
    await client.run(reconcile(true)); const metadata = await client.metadata(), file = metadata.descriptors[0]!.file
    const original = await readFile(file, "utf8"), outside = join(client.root, "outside")
    await writeFile(file, `${original}\nforeign\n`)
    await expect(client.run(reconcile(false))).rejects.toMatchObject({ reason: "identity" })
    await writeFile(file, original); await chmod(file, 0o644)
    await expect(client.run(inspect())).rejects.toMatchObject({ reason: "identity" })
    await chmod(file, 0o600); await writeFile(outside, original, { mode: 0o600 }); await rm(file); await symlink(outside, file)
    await expect(client.run(reconcile(true))).rejects.toMatchObject({ reason: "identity" })
    expect(await readFile(outside, "utf8")).toBe(original)
    await rm(file); await writeFile(file, original, { mode: 0o600 })
    const saved = JSON.parse(await readFile(client.metadataFile, "utf8"))
    await atomicJSON(client.metadataFile, { ...saved, unexpected: true })
    await expect(admitUpdateWake(client.paths, metadata.token, metadata.launcher, {})).rejects.toMatchObject({ reason: "identity" })
  })
  it("rejects a symlinked private wake directory and public control characters", async () => {
    const client = await fixture()
    await expect(client.run(reconcile(true), { ...client.environment, LANG: "en\nInjected" })).rejects.toMatchObject({ reason: "identity" })
    const outside = join(client.root, "outside-wake"); await mkdir(outside, { mode: 0o700 })
    await rm(join(client.home, "updates", "wakeup"), { recursive: true })
    await symlink(outside, join(client.home, "updates", "wakeup"))
    await expect(client.run(reconcile(true))).rejects.toMatchObject({ reason: "identity" })
    await expect(admitUpdateWake(client.paths, "invalid", client.entry, {})).rejects.toMatchObject({ reason: "identity" })
  })
  it("joins cancelled native commands before releasing registration ownership", async () => {
    const client = await fixture()
    let entered = false, release!: () => void
    const completion = new Promise<string>(resolve => { release = () => resolve("") })
    client.setExecute(async (_file, _args, _env, signal) => { entered = true; await completion; if (signal.aborted) throw signal.reason; return client.modules })
    const cancellation = new AbortController(); let settled = false
    const pending = client.run(reconcile(true), client.environment, client.entry, "darwin", cancellation.signal)
      .then(() => "finished", () => "cancelled").finally(() => { settled = true })
    await expect.poll(() => entered).toBe(true); cancellation.abort(); expect(settled).toBe(false)
    release(); expect(await pending).toBe("cancelled")
    client.setExecute(undefined); expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
  })
  it("reports unsupported installations without installing fallback jobs", async () => {
    const client = await fixture()
    const foreign = join(client.root, "source.ts"); await writeFile(foreign, "// source\n")
    expect(await client.run(reconcile(true), client.environment, foreign)).toMatchObject({ state: "unsupported" })
    expect(await client.run(reconcile(true), client.environment, client.entry, "win32")).toMatchObject({ state: "unsupported" })
    expect(client.calls.some(call => call.args.includes("enable"))).toBe(false)
  })
  it.runIf(process.platform === "darwin" && process.env.ATAPE_VERIFY_NATIVE_UPDATE_WAKE === "1")(
    "runs two isolated native macOS wakes and disables future starts without killing the independently owned child", async () => {
      const client = await fixture("darwin")
      // This empty helper proves launchd lifetime only. It does not enter the
      // Application, read credentials, contact a Server or collect source data.
      await writeFile(client.entry, `import { appendFile, readFile, writeFile } from "node:fs/promises";\nimport { spawn } from "node:child_process";\nimport { join } from "node:path";\nconst home = process.env.ATAPE_HOME;\nconst marker = join(home, "native-child.pid");\nlet existing; try { existing = Number(await readFile(marker, "utf8")); process.kill(existing, 0); } catch { existing = undefined; }\nif (!existing) { const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); await writeFile(marker, String(child.pid)); child.unref(); }\nawait appendFile(join(home, "native-wakes.jsonl"), JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\\n");\n`)
      const nativeExecute: typeof executeOwnedProcess = async (file, args, env, signal, timeout) => file === "npm"
        ? `${client.modules}\n` : executeOwnedProcess(file, args, env, signal, timeout)
      client.setExecute(nativeExecute)
      let metadata: Awaited<ReturnType<typeof client.metadata>> | undefined, childPid: number | undefined
      let stage = "register"
      const wakes = async () => (await readFile(join(client.home, "native-wakes.jsonl"), "utf8").catch(() => ""))
        .trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number; argv: string[] })
      const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
      try {
        expect(await client.run(reconcile(true))).toEqual({ state: "registered" })
        metadata = await client.metadata()
        stage = "first native wake"
        await expect.poll(async () => (await wakes()).length, { timeout: 10_000 }).toBe(1)
        childPid = Number(await readFile(join(client.home, "native-child.pid"), "utf8"))
        expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true); expect(alive(childPid)).toBe(true)
        stage = "first native wake exit"
        await expect.poll(async () => (await executeOwnedProcess("/bin/launchctl", ["print", `gui/${process.getuid!()}/${metadata!.job}`],
          process.env, AbortSignal.timeout(2_000), 2_000)).includes("state = not running"), { timeout: 10_000 }).toBe(true)
        stage = "second native kickstart"
        // launchd reports minimum runtime=10 and spawn scheduled for an
        // immediate second start. Respect that native throttle in this test.
        await executeOwnedProcess("/bin/launchctl", ["kickstart", `gui/${process.getuid!()}/${metadata.job}`], process.env, AbortSignal.timeout(15_000), 15_000)
        stage = "second native wake"
        await expect.poll(async () => (await wakes()).length, { timeout: 10_000 }).toBe(2)
        const observations = await wakes()
        expect(observations[0]!.pid).not.toBe(observations[1]!.pid)
        expect(observations.every(item => item.argv.join(" ") === `__update-wake --wake-token ${metadata!.token}`)).toBe(true)
        expect(alive(childPid)).toBe(true)
        stage = "disable native scheduling"
        expect(await disable(client)).toEqual({ state: "missing" })
        expect((await client.metadata()).enabled).toBe(false)
        expect(alive(childPid)).toBe(true)
        await expect(readFile(metadata.descriptors[0]!.file)).rejects.toMatchObject({ code: "ENOENT" })
        const disabled = await executeOwnedProcess("/bin/launchctl", ["print-disabled", `gui/${process.getuid!()}`], process.env,
          AbortSignal.timeout(2_000), 2_000)
        expect(disabled).toMatch(new RegExp(`"${metadata.job.replaceAll(".", "\\.")}"\\s*=>\\s*(?:true|disabled)`))
      } catch (cause) {
        const state = metadata ? await executeOwnedProcess("/bin/launchctl", ["print", `gui/${process.getuid!()}/${metadata.job}`],
          process.env, AbortSignal.timeout(2_000), 2_000).catch(error => String(error)) : "No registration metadata"
        throw new Error(`Native update wake failed at ${stage}; observations=${JSON.stringify(await wakes())}; job=${state.slice(-6_000)}`, { cause })
      } finally {
        // Also repair failures between native registration and metadata read.
        metadata ??= await client.metadata().catch(() => undefined)
        if (metadata) {
          await executeOwnedProcess("/bin/launchctl", ["bootout", `gui/${process.getuid!()}/${metadata.job}`], process.env,
            AbortSignal.timeout(2_000), 2_000).catch(() => {})
          // Clear the unique disabled override as well as the owned plist.
          await executeOwnedProcess("/bin/launchctl", ["enable", `gui/${process.getuid!()}/${metadata.job}`], process.env,
            AbortSignal.timeout(2_000), 2_000).catch(() => {})
          for (const item of metadata.descriptors) await rm(item.file, { force: true })
        }
        childPid ??= Number(await readFile(join(client.home, "native-child.pid"), "utf8").catch(() => "0"))
        if (childPid > 0 && alive(childPid)) {
          process.kill(childPid, "SIGTERM")
          await expect.poll(() => alive(childPid!), { timeout: 5_000 }).toBe(false)
        }
      }
    }, 30_000)
})
