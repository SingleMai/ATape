import { LoginStartupError, LoginStartupPlatform, type LoginStartupRegistration } from "@atape/application"
import { ClientConfig } from "@atape/domain"
import { constants } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"
import type { NodeClientPaths } from "./clientPaths.ts"
import { executeOwnedProcess } from "./ownedProcess.ts"
import { acquireProcessLock } from "./processLock.ts"
import { needsUpdateRecovery, recoverPendingUpdate } from "./managedUpdates.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { readBoundedJSON, resolveRuntimeEntry, selectedBootstrap } from "./runtimeSelection.ts"

// launchd/systemd are a real external Seam. Tests replace only their command
// Adapter and platform identity, retaining the production filesystem contract.
type LoginStartupSystem = {
  readonly platform?: NodeJS.Platform
  readonly homeDirectory?: string
  readonly uid?: number
  readonly execute?: typeof executeOwnedProcess
}
const protocol = "atape.login.v1" as const
const startupProtocol = "atape.login-startup.v1" as const
const maximumBundleBytes = 16 * 1024 * 1024
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const privateNames = ["ATAPE_REDACT_VALUES", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"] as const
const publicNames = ["LANG", "LC_ALL", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "ATAPE_CODEX_HOME", "ATAPE_CLAUDE_HOME", "ATAPE_OPENCODE_HOME", "ATAPE_CODEBUDDY_HOME",
  "ATAPE_KIMI_HOME", "ATAPE_GROK_HOME", "ATAPE_CLAUDE_SESSION_FILE", "OPENCODE_DB"] as const
const Metadata = Schema.Struct({
  owner: Schema.Literal(protocol), version: Schema.Literal(1), enabled: Schema.Boolean,
  token: Schema.String, home: Schema.String, job: Schema.String,
  platform: Schema.Literals(["darwin", "linux"]), node: Schema.String, bootstrap: Schema.String,
  launcher: Schema.String, launcherHash: Schema.String,
  precedingLauncherHash: Schema.optionalKey(Schema.String),
  file: Schema.String, environment: Schema.Record(Schema.String, Schema.String),
  privateEnvironment: Schema.Record(Schema.String, Schema.String), hash: Schema.String,
  precedingHash: Schema.optionalKey(Schema.String)
})
type Metadata = typeof Metadata.Type
type Layout = { readonly home: string; readonly directory: string; readonly metadata: string;
  readonly job: string; readonly file: string; readonly base: string }
const failure = (reason: LoginStartupError["reason"], message: string) => new LoginStartupError({ reason, message })
const missing = (cause: unknown) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const stopped = (signal: AbortSignal) => { if (signal.aborted) throw failure("manager", "Login startup registration was cancelled.") }
const managedEffect = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.callback<A, LoginStartupError>(resume => {
  const cancellation = new AbortController()
  const task = Promise.resolve().then(() => run(cancellation.signal))
  task.then(value => resume(Effect.succeed(value)), cause => resume(Effect.fail(cause instanceof LoginStartupError ? cause
    : failure("state", "Could not read or update ATape login startup state. Check local permissions and retry."))))
  return Effect.promise(async () => { cancellation.abort(); await task.catch(() => {}) })
})

export const makeLoginStartupPlatformLayer = (
  paths: NodeClientPaths,
  bootstrapEntry: string,
  environment: NodeJS.ProcessEnv = process.env,
  system: LoginStartupSystem = {}
) => {
  const platform = system.platform ?? process.platform
  const uid = system.uid ?? process.getuid?.()
  const userHome = resolve(system.homeDirectory ?? homedir())
  const execute = system.execute ?? executeOwnedProcess
  const supported = platform === "darwin" || platform === "linux"
  const unavailable = (): LoginStartupRegistration => ({ state: "unavailable",
    message: "The user login service manager is unavailable. Open ATape in a normal login session and retry." })
  const unsupported = (): LoginStartupRegistration => ({ state: "unsupported",
    message: "Login startup requires the active npm global ATape installation on macOS or Linux." })
  const incapable = (): LoginStartupRegistration => ({ state: "unsupported",
    message: "The selected ATape version does not support login startup. Update ATape before enabling it." })
  const commandEnvironment = () => ({ ...environment, HOME: userHome, PATH: safePath(environment.PATH) })
  const run = async (file: string, args: string[], signal: AbortSignal) => {
    stopped(signal)
    return execute(file, args, commandEnvironment(), signal, 10_000)
  }
  const layout = async (): Promise<Layout> => {
    if (!Object.values(paths).every(isAbsolute)) throw failure("identity", "Login startup requires absolute ATape state paths.")
    const home = await realpath(paths.atapeHome).catch(cause => { if (missing(cause)) return resolve(paths.atapeHome); throw cause })
    const job = `com.atape.login.${digest(home).slice(0, 24)}`
    let xdg = environment.XDG_CONFIG_HOME
    // A later terminal need not repeat the login environment that established
    // this home. Keep its existing XDG location unless explicitly overridden.
    if (platform === "linux" && xdg === undefined && await privateDirectoryPresent(join(home, "startup"), uid)) {
      const saved = await readPrivateFile(join(home, "startup", "registration.json"), uid)
      if (saved !== undefined) xdg = decodeMetadata(JSON.parse(saved), home).environment.XDG_CONFIG_HOME
    }
    const base = platform === "darwin" ? userHome : xdg && isAbsolute(xdg) ? xdg : join(userHome, ".config")
    const file = platform === "darwin" ? join(base, "Library", "LaunchAgents", `${job}.plist`)
      : join(base, "systemd", "user", `${job}.service`)
    return { home, job, base, file, directory: join(home, "startup"), metadata: join(home, "startup", "registration.json") }
  }
  const managerAvailable = async (signal: AbortSignal) => {
    try {
      await run(platform === "darwin" ? "/bin/launchctl" : "systemctl",
        platform === "darwin" ? ["print", `gui/${uid}`] : ["--user", "show-environment"], signal)
      return true
    } catch { stopped(signal); return false }
  }
  const registered = async (location: Layout, signal: AbortSignal) => {
    try {
      const output = await run(platform === "darwin" ? "/bin/launchctl" : "systemctl", platform === "darwin"
        ? ["print", `gui/${uid}/${location.job}`] : ["--user", "is-enabled", `${location.job}.service`], signal)
      return platform === "darwin" || output.trim() === "enabled"
    } catch (cause) {
      stopped(signal)
      if (commandCode(cause, [1, 3, 4, 113])) return false
      throw failure("manager", "Could not inspect the ATape user login service.")
    }
  }
  const read = async (location: Layout) => readMetadata(location, uid)
  const inspect = async (signal: AbortSignal): Promise<LoginStartupRegistration> => {
    if (!supported || uid === undefined) return unsupported()
    const location = await layout()
    const metadata = await read(location)
    const content = await readRegistration(location, uid)
    if (!metadata) {
      if (content !== undefined) throw failure("identity", "The login startup path is occupied by an unrecognized file.")
      return { state: "missing" }
    }
    assertRegistration(metadata, content)
    if (await readLauncher(metadata, uid, true) === undefined) return { state: "missing" }
    if (!metadata.enabled || content === undefined) return { state: "missing" }
    try { await realpath(metadata.node); await realpath(metadata.bootstrap) }
    catch { return { state: "unavailable", message: "The registered Node or ATape installation moved. Reopen ATape to repair login startup." } }
    if (!(await capableRuntime(location.home, metadata.bootstrap)).capable) return incapable()
    if (!(await managerAvailable(signal))) return unavailable()
    return await registered(location, signal) ? { state: "registered" } : { state: "missing" }
  }
  const reconcile = async (enabled: boolean, signal: AbortSignal): Promise<LoginStartupRegistration> => {
    if (!supported || uid === undefined) return unsupported()
    const location = await layout()
    // No preference or unfinished setup must create an OS job implicitly.
    const initial = await read(location)
    const original = await readRegistration(location, uid)
    if (!initial && original !== undefined) throw failure("identity", "The login startup path is occupied by an unrecognized file.")
    if (initial) { assertRegistration(initial, original); if (enabled) await readLauncher(initial, uid, true) }
    if (!enabled && !initial && original === undefined) return { state: "missing" }
    await secureDirectory(location.home, uid, true)
    await secureDirectory(location.directory, uid, true)
    const release = await acquireProcessLock(join(location.directory, "registration.lock.sqlite"), 1_000)
    if (!release) throw failure("state", "Another ATape process is updating login startup. Retry shortly.")
    let releaseUpdate: (() => void) | undefined
    try {
      stopped(signal)
      const previous = await read(location)
      const content = await readRegistration(location, uid)
      if (!previous && content !== undefined) throw failure("identity", "The login startup path is occupied by an unrecognized file.")
      const precedingLauncher = previous && enabled ? await readLauncher(previous, uid, true) : undefined
      if (previous) assertRegistration(previous, content)
      if (!enabled) {
        if (previous?.enabled) await writeOwned(location.metadata, `${JSON.stringify({ ...previous, enabled: false })}\n`, uid)
        stopped(signal)
        if (!(await managerAvailable(signal))) return unavailable()
        try {
          if (platform === "darwin") {
            if (await registered(location, signal)) await run("/bin/launchctl", ["bootout", `gui/${uid}/${location.job}`], signal)
          } else if (content !== undefined) {
            // disable is deliberately separate from stop: an active unit's
            // cgroup may still contain Collector and independent updater work.
            await run("systemctl", ["--user", "disable", `${location.job}.service`], signal)
          }
          if (content !== undefined) await rm(location.file)
          if (platform === "linux") await run("systemctl", ["--user", "daemon-reload"], signal)
        } catch (cause) {
          if (cause instanceof LoginStartupError) throw cause
          throw failure("registration", "Could not remove the ATape login startup registration. The preference remains off; retry in Settings.")
        }
        return { state: "missing" }
      }
      // Do not copy npm files while a manual/automatic update owns this home.
      // Selected managed bundles are immutable, and manual replacement uses the
      // same ownership through its npm tree mutation.
      releaseUpdate = await acquireUpdateWorker(location.home)
      if (!releaseUpdate) return { state: "unavailable", message: "An ATape update is running. Login startup registration will retry after it finishes." }
      // First-time enrollment must wait until the installing updater commits
      // recovery. In particular, a pre-feature worker may still roll selection
      // back to a runtime that cannot persist the new desired-running state.
      if (await needsUpdateRecovery(paths)) return { state: "unavailable", message: "ATape update recovery is pending. Login startup registration will retry after recovery completes." }
      let bootstrap: string
      let bundle: string
      try {
        bootstrap = await realpath(await selectedBootstrap(location.home, environment.ATAPE_BOOTSTRAP_ENTRY ?? bootstrapEntry))
        const root = (await run("npm", ["root", "--global"], signal)).trim()
        if (!isAbsolute(root) || bootstrap !== await realpath(join(root, "@atape", "cli", "dist", "atape.js"))) return unsupported()
        const manifest = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.Literal("@atape/cli"), version: Schema.String }))(
          await readBoundedJSON(join(dirname(dirname(bootstrap)), "package.json")))
        if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) return unsupported()
        const selected = await capableRuntime(location.home, bootstrap)
        // A pre-feature TUI cannot persist a Stop in the new desired-state
        // contract. Keep the capable coordinator, but never resume that runtime
        // at login or replace our launcher with its older parser.
        if (!selected.capable) return incapable()
        bundle = await readBundle(selected.entry)
      } catch (cause) {
        stopped(signal)
        if (cause instanceof LoginStartupError) throw cause
        return { state: "unavailable", message: "Could not verify the npm global ATape installation. Check Node/npm and reopen ATape." }
      }
      if (!(await managerAvailable(signal))) return unavailable()
      const context = retainedContext(previous, environment)
      const metadata: Metadata = { owner: protocol, version: 1, enabled: true, token: previous?.token ?? randomUUID(),
        home: location.home, job: location.job, platform: platform as "darwin" | "linux", node: await realpath(process.execPath),
        launcher: join(location.directory, "atape.mjs"), launcherHash: digest(bundle),
        bootstrap, file: location.file, environment: publicEnvironment(paths, location.home, userHome, bootstrap, context),
        privateEnvironment: privateEnvironment(context), hash: "" }
      const nextContent = descriptor(metadata)
      const next = { ...metadata, hash: digest(nextContent) }
      const currentRegistered = content !== undefined && await registered(location, signal)
      if (previous && JSON.stringify(previous) === JSON.stringify(next) && content === nextContent && precedingLauncher === bundle && currentRegistered) return { state: "registered" }
      await secureDirectoryTree(location.base, dirname(location.file), uid)
      // Journal both owned descriptors before replacing either file. A crash
      // between the two atomic writes can then be repaired without accepting
      // arbitrary files that merely copied our marker.
      const pending = { ...next,
        ...(content !== undefined && digest(content) !== next.hash ? { precedingHash: digest(content) } : {}),
        ...(precedingLauncher !== undefined && digest(precedingLauncher) !== next.launcherHash ? { precedingLauncherHash: digest(precedingLauncher) } : {}) }
      await writeOwned(location.metadata, `${JSON.stringify(pending)}\n`, uid)
      stopped(signal)
      if (precedingLauncher !== bundle) await writeOwned(next.launcher, bundle, uid, maximumBundleBytes)
      stopped(signal)
      if (content !== nextContent) await writeOwned(location.file, nextContent, uid)
      stopped(signal)
      try {
        if (platform === "darwin" && (!currentRegistered || content !== nextContent)) {
          if (currentRegistered) await run("/bin/launchctl", ["bootout", `gui/${uid}/${location.job}`], signal)
          await run("/bin/launchctl", ["enable", `gui/${uid}/${location.job}`], signal)
          await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, location.file], signal)
        } else if (platform === "linux" && (!currentRegistered || content !== nextContent)) {
          await run("systemctl", ["--user", "daemon-reload"], signal)
          await run("systemctl", ["--user", "enable", `${location.job}.service`], signal)
          // start is idempotent for RemainAfterExit=yes; do not restart an active
          // unit or its Collector/updater cgroup when launch context changes.
          if (!currentRegistered) await run("systemctl", ["--user", "--no-block", "start", `${location.job}.service`], signal)
        }
      } catch (cause) {
        if (cause instanceof LoginStartupError) throw cause
        throw failure("registration", "Could not install ATape login startup. Check the user login service and retry in Settings.")
      }
      if (!(await registered(location, signal))) return { state: "missing" }
      if ("precedingHash" in pending || "precedingLauncherHash" in pending) await writeOwned(location.metadata, `${JSON.stringify(next)}\n`, uid)
      return { state: "registered" }
    } finally { releaseUpdate?.(); release() }
  }
  return Layer.succeed(LoginStartupPlatform, LoginStartupPlatform.of({
    inspect: () => managedEffect(inspect), reconcile: enabled => managedEffect(signal => reconcile(enabled, signal))
  }))
}

// A queued login job becomes inert as soon as its preference or private
// registration is disabled. Admission never trusts a caller-supplied home/token.
export const admitLoginStartup = async (paths: NodeClientPaths, token: string, entryFile: string,
  environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv | undefined> => {
  try {
    const home = await realpath(paths.atapeHome).catch(cause => { if (missing(cause)) return undefined; throw cause })
    if (!home) return undefined
    const uid = process.getuid?.()
    if (!(await privateDirectoryPresent(home, uid))) return undefined
    const metadataFile = join(home, "startup", "registration.json")
    if (!(await privateDirectoryPresent(dirname(metadataFile), uid))) return undefined
    const json = await readPrivateFile(metadataFile, uid)
    if (json === undefined) return undefined
    const metadata = decodeMetadata(JSON.parse(json), home)
    if (!metadata.enabled) return undefined
    await readLauncher(metadata, uid)
    if (!tokenPattern.test(token) || token !== metadata.token) throw failure("identity", "This login startup entry is reserved for its registered ATape installation.")
    const current = await realpath(entryFile)
    const selected = await capableRuntime(home, metadata.bootstrap)
    if (!selected.capable) return undefined
    if (current !== metadata.launcher && current !== selected.entry) throw failure("identity", "The registered ATape login startup executable changed. Reopen ATape to repair it.")
    // A queued job may still carry the preceding config override. The private
    // registration, rather than that stale process environment, selects the
    // current configuration and its off preference.
    const config = Schema.decodeUnknownSync(ClientConfig)(await readBoundedJSON(metadata.environment.ATAPE_CONFIG_FILE!, 4 * 1024 * 1024))
    if (!config.toolsConfigured || config.autoStartEnabled === false) return undefined
    return { ...environment, ...metadata.environment, ...metadata.privateEnvironment, ATAPE_BOOTSTRAP_ENTRY: metadata.bootstrap }
  } catch (cause) {
    if (missing(cause)) return undefined
    if (cause instanceof LoginStartupError) throw cause
    throw failure("state", "Could not validate ATape login startup state. Reopen ATape and inspect Settings.")
  }
}

// Recovery uses exactly the updater's ownership and bounded handoff Interface;
// a busy worker is retried by the OS instead of allowing a competing Collector.
export const withLoginStartupRecovery = async (paths: NodeClientPaths, bootstrap: string,
  environment: NodeJS.ProcessEnv, work: () => Promise<void>): Promise<void> => {
  try {
    const release = await acquireUpdateWorker(paths.atapeHome)
    if (!release) throw failure("manager", "ATape update recovery is already running. Login startup will retry.")
    try {
      if (await needsUpdateRecovery(paths)) await recoverPendingUpdate(paths, bootstrap, environment)
      // Admission and desired-state resume run under the same ownership as
      // recovery, so activation cannot select an older runtime between them.
      await work()
    } finally { release() }
  } catch (cause) {
    if (cause instanceof LoginStartupError) throw cause
    throw failure("state", "ATape login startup could not recover pending update maintenance. Reopen ATape to inspect local state.")
  }
}

const capableRuntime = async (home: string, bootstrap: string) => {
  const entry = await realpath(await resolveRuntimeEntry(home, bootstrap))
  const runtime = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.Literal("@atape/cli"),
    atapeRuntime: Schema.optionalKey(Schema.Struct({ loginStartupProtocol: Schema.optionalKey(Schema.String) }))
  }))(await readBoundedJSON(join(dirname(dirname(entry)), "package.json")))
  return { entry, capable: runtime.atapeRuntime?.loginStartupProtocol === startupProtocol && entry === join(dirname(dirname(entry)), "dist", "atape.js") }
}

const safePath = (value: string | undefined) => [...new Set([dirname(process.execPath), ...(value ?? "").split(":").filter(isAbsolute),
  "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].map(cleanText).join(":")
const cleanText = (value: string) => {
  if (/[\x00-\x1f\x7f]/.test(value)) throw failure("identity", "Login startup paths and public environment values cannot contain control characters.")
  return value
}
const publicEnvironment = (paths: NodeClientPaths, home: string, userHome: string, bootstrap: string, source: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = { HOME: userHome, PATH: safePath(source.PATH), ATAPE_HOME: home,
    ATAPE_CONFIG_FILE: paths.configFile, ATAPE_COLLECTOR_STATE_FILE: paths.collectorStateFile,
    ATAPE_COLLECTOR_PROCESS_FILE: paths.collectorProcessFile, ATAPE_COLLECTOR_STATUS_FILE: paths.collectorStatusFile,
    ATAPE_COLLECTOR_LOG_FILE: paths.collectorLogFile, ATAPE_ADAPTER_DIRECTORY: paths.adapterDirectory,
    ATAPE_BOOTSTRAP_ENTRY: bootstrap, XDG_CONFIG_HOME: source.XDG_CONFIG_HOME && isAbsolute(source.XDG_CONFIG_HOME) ? source.XDG_CONFIG_HOME : join(userHome, ".config") }
  for (const name of publicNames) if (source[name] !== undefined && (!name.startsWith("XDG_") || isAbsolute(source[name]!))) env[name] = cleanText(source[name]!)
  // Relative source overrides must retain their original meaning after login.
  for (const name of publicNames) if (env[name] && (name.endsWith("_HOME") || name.endsWith("_FILE") || name === "OPENCODE_DB")) env[name] = resolve(env[name])
  return Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, cleanText(value)]))
}
const privateEnvironment = (source: NodeJS.ProcessEnv): Record<string, string> => Object.fromEntries(privateNames.flatMap(name => {
  const value = source[name]
  if (value === undefined) return []
  if (value.includes("\0") || value.length > 64 * 1024) throw failure("state", "A private login startup environment value is invalid or too large.")
  return [[name, name === "NODE_EXTRA_CA_CERTS" && value ? resolve(value) : value]]
}))
const retainedContext = (previous: Metadata | undefined, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const context = { ...source }
  for (const name of publicNames) if (context[name] === undefined && previous?.environment[name] !== undefined) context[name] = previous.environment[name]
  for (const name of privateNames) if (context[name] === undefined && previous?.privateEnvironment[name] !== undefined) context[name] = previous.privateEnvironment[name]
  return context
}
const decodeMetadata = (value: unknown, home: string): Metadata => {
  let metadata: Metadata
  try { metadata = Schema.decodeUnknownSync(Metadata)(value) }
  catch { throw failure("identity", "ATape refused unrecognized login startup metadata.") }
  const allowed = new Set<string>([...publicNames, "HOME", "PATH", "ATAPE_HOME", "ATAPE_CONFIG_FILE", "ATAPE_COLLECTOR_STATE_FILE",
    "ATAPE_COLLECTOR_PROCESS_FILE", "ATAPE_COLLECTOR_STATUS_FILE", "ATAPE_COLLECTOR_LOG_FILE", "ATAPE_ADAPTER_DIRECTORY", "ATAPE_BOOTSTRAP_ENTRY"])
  if (metadata.home !== home || metadata.job !== `com.atape.login.${digest(home).slice(0, 24)}` ||
    !tokenPattern.test(metadata.token) || ![metadata.node, metadata.bootstrap, metadata.file].every(isAbsolute) ||
    metadata.launcher !== join(home, "startup", "atape.mjs") || !/^[0-9a-f]{64}$/.test(metadata.launcherHash) ||
    metadata.precedingLauncherHash !== undefined && !/^[0-9a-f]{64}$/.test(metadata.precedingLauncherHash) ||
    !/^[0-9a-f]{64}$/.test(metadata.hash) || metadata.precedingHash !== undefined && !/^[0-9a-f]{64}$/.test(metadata.precedingHash) || metadata.environment.ATAPE_HOME !== home ||
    metadata.environment.ATAPE_BOOTSTRAP_ENTRY !== metadata.bootstrap ||
    ["HOME", "ATAPE_CONFIG_FILE", "ATAPE_COLLECTOR_STATE_FILE", "ATAPE_COLLECTOR_PROCESS_FILE", "ATAPE_COLLECTOR_STATUS_FILE",
      "ATAPE_COLLECTOR_LOG_FILE", "ATAPE_ADAPTER_DIRECTORY"].some(name => !metadata.environment[name] || !isAbsolute(metadata.environment[name]!)) ||
    Object.keys(metadata.environment).some(name => !allowed.has(name)) ||
    Object.keys(metadata.privateEnvironment).some(name => !(privateNames as readonly string[]).includes(name))) {
    throw failure("identity", "ATape refused unrecognized login startup metadata.")
  }
  for (const value of Object.values(metadata.environment)) cleanText(value)
  privateEnvironment(metadata.privateEnvironment)
  if (digest(descriptor(metadata)) !== metadata.hash) throw failure("identity", "ATape login startup metadata does not match its registration.")
  return metadata
}
const readMetadata = async (location: Layout, uid: number | undefined) => {
  if (!(await privateDirectoryPresent(location.home, uid))) return undefined
  if (!(await privateDirectoryPresent(location.directory, uid))) return undefined
  const value = await readPrivateFile(location.metadata, uid)
  if (value === undefined) return undefined
  const metadata = decodeMetadata(JSON.parse(value), location.home)
  if (metadata.file !== location.file) throw failure("identity", "The ATape login startup registration directory changed. Repair it from its original login environment.")
  return metadata
}
const assertRegistration = (metadata: Metadata, content: string | undefined) => {
  if (content !== undefined && digest(content) !== metadata.hash && digest(content) !== metadata.precedingHash) throw failure("identity", "ATape refused to replace a modified or foreign login startup file.")
}
const readLauncher = async (metadata: Metadata, uid: number | undefined, allowMissing = false) => {
  const bundle = await readPrivateFile(metadata.launcher, uid, maximumBundleBytes)
  if (bundle === undefined) {
    if (allowMissing) return undefined
    throw failure("identity", "The registered ATape login launcher is missing. Reopen ATape to repair it.")
  }
  const hash = digest(bundle)
  if (hash !== metadata.launcherHash && hash !== metadata.precedingLauncherHash) throw failure("identity", "ATape refused a modified or foreign login launcher.")
  return bundle
}
const readBundle = async (file: string) => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size <= 0 || before.size > maximumBundleBytes || (before.mode & 0o022) !== 0) throw failure("identity", "The ATape login startup bundle has unsafe type, size or permissions.")
    const bundle = await boundedText(handle, maximumBundleBytes)
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || Buffer.byteLength(bundle) !== after.size) throw failure("state", "The ATape installation changed while preparing login startup. Retry shortly.")
    return bundle
  } finally { await handle.close() }
}
const readRegistration = async (location: Layout, uid: number | undefined) => {
  let directory = location.base
  for (const component of ["", ...dirname(location.file).slice(location.base.length + 1).split("/")]) {
    directory = join(directory, component)
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0) throw failure("identity", "The login startup registration directory has unsafe ownership or permissions.")
    } catch (cause) { if (missing(cause)) return undefined; throw cause }
  }
  return readPrivateFile(location.file, uid)
}
const privateDirectoryPresent = async (directory: string, uid: number | undefined) => {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) throw failure("identity", "ATape login startup metadata directory must be private and owned.")
    return true
  } catch (cause) { if (missing(cause)) return false; throw cause }
}
const readPrivateFile = async (file: string, uid: number | undefined, limit = 256 * 1024): Promise<string | undefined> => {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > limit) {
      throw failure("identity", "ATape login startup files must be private, owned regular files.")
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const actual = await handle.stat()
      if (!actual.isFile() || actual.uid !== uid || (actual.mode & 0o077) !== 0 || actual.size > limit) throw failure("identity", "Unsafe ATape login startup file.")
      return await boundedText(handle, limit)
    } finally { await handle.close() }
  } catch (cause) { if (missing(cause)) return undefined; throw cause }
}
const boundedText = async (handle: Awaited<ReturnType<typeof open>>, limit: number) => {
  const bytes = Buffer.alloc(limit + 1)
  let length = 0
  while (length < bytes.length) {
    const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
    if (bytesRead === 0) break
    length += bytesRead
  }
  if (length > limit) throw failure("state", "ATape login startup state exceeds its size limit.")
  return bytes.subarray(0, length).toString("utf8")
}
const secureDirectory = async (directory: string, uid: number | undefined, privateMode: boolean) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & (privateMode ? 0o077 : 0o022)) !== 0) {
    throw failure("identity", "ATape login startup directories have unsafe ownership or permissions.")
  }
}
const secureDirectoryTree = async (base: string, directory: string, uid: number | undefined) => {
  await secureDirectory(base, uid, false)
  const relative = directory.slice(base.length + 1).split("/")
  let current = base
  for (const component of relative) { current = join(current, component); await secureDirectory(current, uid, false) }
}
const writeOwned = async (file: string, content: string, uid: number | undefined, limit = 256 * 1024) => {
  if (Buffer.byteLength(content) > limit) throw failure("state", "ATape login startup context is too large to persist safely.")
  await readPrivateFile(file, uid, limit)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
    const directory = await open(dirname(file), "r")
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temporary, { force: true }) }
}
const xml = (value: string) => cleanText(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
const unitQuote = (value: string, argument = false) => `"${cleanText(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => argument ? "$$" : "$")}"`
// WorkingDirectory is a scalar path, not an ExecStart/Environment word list:
// systemd keeps quotes and backslashes literally. The final /. protects a
// trailing space or backslash in the home from line trimming/continuation.
const unitDirectory = (value: string) => `${cleanText(value).replaceAll("%", "%%")}/.`
const descriptor = (metadata: Metadata): string => {
  const args = [metadata.node, metadata.launcher, "__login-start", "--startup-token", metadata.token]
  if (metadata.platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(metadata.job)}</string>\n<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>EnvironmentVariables</key><dict>${Object.entries(metadata.environment).map(([name, value]) => `<key>${xml(name)}</key><string>${xml(value)}</string>`).join("")}</dict>\n<key>WorkingDirectory</key><string>${xml(metadata.home)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>ExitTimeOut</key><integer>10</integer>\n<key>AbandonProcessGroup</key><false/>\n<key>ProcessType</key><string>Background</string>\n<key>Umask</key><integer>63</integer>\n</dict></plist>\n`
  return `# ${protocol} ${metadata.job}\n[Unit]\nDescription=ATape login startup\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${args.map(arg => unitQuote(arg, true)).join(" ")}\nWorkingDirectory=${unitDirectory(metadata.home)}\n${Object.entries(metadata.environment).map(([name, value]) => `Environment=${unitQuote(`${name}=${value}`)}`).join("\n")}\nRestart=on-failure\nRestartSec=30s\nTimeoutStartSec=90s\nTimeoutStopSec=10s\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`
}
const commandCode = (cause: unknown, values: number[]) => typeof cause === "object" && cause !== null && "code" in cause && values.includes(Number(cause.code))
