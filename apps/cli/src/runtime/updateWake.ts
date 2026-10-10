import { UpdateWakeError, UpdateWakePlatform, type UpdateWakeRegistration } from "@atape/application"
import { ClientConfig } from "@atape/domain"
import { createHash, randomUUID } from "node:crypto"
import { realpath, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { defaultNodeClientPaths, type NodeClientPaths } from "./clientPaths.ts"
import { needsUpdateRecovery } from "./managedUpdates.ts"
import { makeNativeJobFiles } from "./nativeJobFiles.ts"
import { executeOwnedProcess } from "./ownedProcess.ts"
import { acquireProcessLock } from "./processLock.ts"
import { readBoundedJSON, resolveRuntimeEntry, selectedBootstrap } from "./runtimeSelection.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"

type UpdateWakeSystem = { readonly platform?: NodeJS.Platform; readonly homeDirectory?: string;
  readonly uid?: number; readonly execute?: typeof executeOwnedProcess }
const protocol = "atape.update-wake.v1" as const
const maximumBundleBytes = 16 * 1024 * 1024
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const hashPattern = /^[0-9a-f]{64}$/
const failure = (reason: UpdateWakeError["reason"], message: string) => new UpdateWakeError({ reason, message })
const { cleanText, readBundle, readRegistration, privateDirectoryPresent, readPrivateFile, secureDirectory,
  secureDirectoryTree, writeOwned, xml, unitQuote, unitDirectory } = makeNativeJobFiles(failure, "update wake")
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const missing = (cause: unknown) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
const privateNames = ["ATAPE_REDACT_VALUES", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"] as const
const publicNames = ["LANG", "LC_ALL", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "ATAPE_DEVELOPMENT_ALLOW_HTTP", "ATAPE_SOURCE_COLLECTION_LIMITS", "ATAPE_CODEX_HOME", "ATAPE_CLAUDE_HOME",
  "ATAPE_OPENCODE_HOME", "ATAPE_CODEBUDDY_HOME", "ATAPE_KIMI_HOME", "ATAPE_GROK_HOME",
  "ATAPE_CLAUDE_SESSION_FILE", "OPENCODE_DB"] as const
const pathNames = ["ATAPE_CONFIG_FILE", "ATAPE_COLLECTOR_STATE_FILE", "ATAPE_COLLECTOR_PROCESS_FILE",
  "ATAPE_COLLECTOR_STATUS_FILE", "ATAPE_COLLECTOR_LOG_FILE", "ATAPE_ADAPTER_DIRECTORY"] as const
const Metadata = Schema.Struct({ protocol: Schema.Literal(protocol), enabled: Schema.Boolean, token: Schema.String,
  home: Schema.String, job: Schema.String, platform: Schema.Literals(["darwin", "linux"]), node: Schema.String,
  bootstrap: Schema.String, launcher: Schema.String, launcherHash: Schema.String,
  precedingLauncherHash: Schema.optionalKey(Schema.String),
  descriptors: Schema.Array(Schema.Struct({ file: Schema.String, hash: Schema.String, precedingHash: Schema.optionalKey(Schema.String) })),
  environment: Schema.Record(Schema.String, Schema.String), privateEnvironment: Schema.Record(Schema.String, Schema.String) })
type Metadata = typeof Metadata.Type
type Layout = { readonly home: string; readonly base: string; readonly directory: string; readonly metadata: string;
  readonly job: string; readonly files: readonly string[] }
const directory = (home: string) => join(home, "updates", "wakeup")
const jobName = (home: string) => `com.atape.update.${digest(home).slice(0, 24)}`
const stopped = (signal: AbortSignal) => { if (signal.aborted) throw failure("manager", "Update wake registration was cancelled.") }
const managedEffect = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.callback<A, UpdateWakeError>(resume => {
  const cancellation = new AbortController()
  const task = Promise.resolve().then(() => run(cancellation.signal))
  task.then(value => resume(Effect.succeed(value)), cause => resume(Effect.fail(cause instanceof UpdateWakeError ? cause
    : failure("state", "Could not read or update ATape scheduled update state. Check local permissions and retry."))))
  return Effect.promise(async () => { cancellation.abort(); await task.catch(() => {}) })
})

export const makeUpdateWakePlatformLayer = (paths: NodeClientPaths, entryFile: string,
  environment: NodeJS.ProcessEnv = process.env, system: UpdateWakeSystem = {}) => {
  const platform = system.platform ?? process.platform, uid = system.uid ?? process.getuid?.()
  const userHome = resolve(system.homeDirectory ?? homedir()), execute = system.execute ?? executeOwnedProcess
  const unsupported = (): UpdateWakeRegistration => ({ state: "unsupported", message: "Scheduled updates require a capable npm global ATape installation on macOS or Linux." })
  const unavailable = (): UpdateWakeRegistration => ({ state: "unavailable", message: "The user service manager is unavailable. Open ATape in a normal login session and retry." })
  const run = async (file: string, args: string[], signal: AbortSignal) => {
    stopped(signal)
    return execute(file, args, { ...environment, HOME: userHome, PATH: safePath(environment.PATH) }, signal, 10_000)
  }
  const layout = async (): Promise<Layout> => {
    if (!Object.values(paths).every(isAbsolute)) throw failure("identity", "Scheduled updates require absolute ATape state paths.")
    const home = await realpath(paths.atapeHome).catch(cause => { if (missing(cause)) return resolve(paths.atapeHome); throw cause })
    let xdg = environment.XDG_CONFIG_HOME
    if (platform === "linux" && xdg === undefined && await privateDirectoryPresent(directory(home), uid)) {
      const saved = await readPrivateFile(join(directory(home), "registration.json"), uid)
      if (saved !== undefined) xdg = decodeMetadata(JSON.parse(saved), home).environment.XDG_CONFIG_HOME
    }
    const base = platform === "darwin" ? userHome : xdg && isAbsolute(xdg) ? xdg : join(userHome, ".config")
    const job = jobName(home), files = platform === "darwin" ? [join(base, "Library", "LaunchAgents", `${job}.plist`)]
      : [join(base, "systemd", "user", `${job}.service`), join(base, "systemd", "user", `${job}.timer`)]
    return { home, base, job, files, directory: directory(home), metadata: join(directory(home), "registration.json") }
  }
  const read = async (location: Layout) => {
    if (!await privateDirectoryPresent(location.home, uid) || !await privateDirectoryPresent(join(location.home, "updates"), uid)
      || !await privateDirectoryPresent(location.directory, uid)) return undefined
    const json = await readPrivateFile(location.metadata, uid)
    if (json === undefined) return undefined
    const metadata = decodeMetadata(JSON.parse(json), location.home)
    if (metadata.descriptors.some((item, index) => item.file !== location.files[index])) throw failure("identity", "The ATape update wake registration directory changed. Repair it from its original login environment.")
    return metadata
  }
  const contents = (location: Layout) => Promise.all(location.files.map(file => readRegistration({ base: location.base, file }, uid)))
  const managerAvailable = async (signal: AbortSignal) => {
    try { await run(platform === "darwin" ? "/bin/launchctl" : "systemctl",
      platform === "darwin" ? ["print", `gui/${uid}`] : ["--user", "show-environment"], signal); return true }
    catch { stopped(signal); return false }
  }
  const loaded = async (location: Layout, signal: AbortSignal) => {
    try {
      const result = await run(platform === "darwin" ? "/bin/launchctl" : "systemctl", platform === "darwin"
        ? ["print", `gui/${uid}/${location.job}`] : ["--user", "is-enabled", `${location.job}.timer`], signal)
      return platform === "darwin" || result.trim() === "enabled"
    } catch (cause) {
      stopped(signal)
      if (commandCode(cause, [1, 3, 4, 113])) return false
      throw failure("manager", "Could not inspect the ATape update timer.")
    }
  }
  const registered = async (location: Layout, signal: AbortSignal) => {
    if (!await loaded(location, signal)) return false
    if (platform === "darwin") {
      const disabled = await run("/bin/launchctl", ["print-disabled", `gui/${uid}`], signal)
      return !new RegExp(`"${location.job.replaceAll(".", "\\.")}"\\s*=>\\s*(?:true|disabled)(?:\\s|$)`).test(disabled)
    }
    try { return (await run("systemctl", ["--user", "is-active", `${location.job}.timer`], signal)).trim() === "active" }
    catch (cause) {
      stopped(signal)
      if (commandCode(cause, [1, 3, 4, 113])) return false
      throw failure("manager", "Could not inspect the ATape update timer.")
    }
  }
  const inspect = async (signal: AbortSignal): Promise<UpdateWakeRegistration> => {
    if (!(platform === "darwin" || platform === "linux") || uid === undefined) return unsupported()
    const location = await layout(), metadata = await read(location), actual = await contents(location)
    assertDescriptors(metadata, actual)
    if (!metadata || actual.some(value => value === undefined) || await readLauncher(metadata, uid, true) === undefined) return { state: "missing" }
    try { await realpath(metadata.node); await realpath(metadata.bootstrap) }
    catch { return { state: "unavailable", message: "The registered Node or ATape installation moved. Reopen ATape to repair scheduled updates." } }
    if (!await needsUpdateRecovery(paths) && !(await capableRuntime(location.home, metadata.bootstrap)).capable) return unsupported()
    if (!await managerAvailable(signal)) return unavailable()
    return await registered(location, signal) ? { state: "registered" } : { state: "missing" }
  }
  const reconcile = async (enabled: boolean, signal: AbortSignal): Promise<UpdateWakeRegistration> => {
    if (!(platform === "darwin" || platform === "linux") || uid === undefined) return unsupported()
    const location = await layout(), initial = await read(location), initialContents = await contents(location)
    assertDescriptors(initial, initialContents)
    if (!enabled && !initial && initialContents.every(value => value === undefined)) return { state: "missing" }
    await secureDirectory(location.home, uid, true); await secureDirectory(join(location.home, "updates"), uid, true)
    await secureDirectory(location.directory, uid, true)
    const release = await acquireProcessLock(join(location.directory, "registration.lock.sqlite"), 1_000)
    if (!release) throw failure("state", "Another ATape process is updating scheduled registration. Retry shortly.")
    let releaseUpdate: (() => void) | undefined
    try {
      stopped(signal)
      const previous = await read(location), current = await contents(location)
      assertDescriptors(previous, current)
      // A queued reconciliation may have waited behind a later Settings change.
      // Only the persisted preference authorizes new native enrollment.
      const config = Schema.decodeUnknownSync(ClientConfig)(await readBoundedJSON(paths.configFile, 4 * 1024 * 1024))
      if (!enabled && config.toolsConfigured && config.autoUpdateEnabled !== false) return inspect(signal)
      const permitted = enabled && config.toolsConfigured && config.autoUpdateEnabled !== false
      if (!permitted) {
        if (!previous && current.every(value => value === undefined)) return { state: "missing" }
        if (previous?.enabled) await writeOwned(location.metadata, `${JSON.stringify({ ...previous, enabled: false })}\n`, uid)
        // A worker can hold ownership before it persists its handoff. Keep a
        // recovery-only trigger until both ownership and durable state are idle.
        releaseUpdate = await acquireUpdateWorker(location.home)
        const retainRecovery = previous && (!releaseUpdate || await needsUpdateRecovery(paths))
        if (!await managerAvailable(signal)) return unavailable()
        try {
          if (retainRecovery) {
            await readLauncher(previous, uid)
            await secureDirectoryTree(location.base, dirname(location.files[0]!), uid)
            const retained = descriptors(previous)
            for (let index = 0; index < location.files.length; index++) if (current[index] !== retained[index]) {
              await writeOwned(location.files[index]!, retained[index]!, uid)
            }
            if (platform === "darwin") {
              await run("/bin/launchctl", ["enable", `gui/${uid}/${location.job}`], signal)
              if (!await registered(location, signal)) await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, location.files[0]!], signal)
            } else {
              await run("systemctl", ["--user", "daemon-reload"], signal)
              await run("systemctl", ["--user", "enable", `${location.job}.timer`], signal)
              await run("systemctl", ["--user", "start", `${location.job}.timer`], signal)
            }
            return await registered(location, signal) ? { state: "registered" } : { state: "missing" }
          }
          if (platform === "darwin") {
            // disable prevents future starts without bootout's signal to the
            // running joined updater. Retain its trusted launcher for recovery.
            if (previous) await run("/bin/launchctl", ["disable", `gui/${uid}/${location.job}`], signal)
          } else if (previous) {
            await run("systemctl", ["--user", "disable", `${location.job}.timer`], signal)
            await run("systemctl", ["--user", "stop", `${location.job}.timer`], signal)
          }
          for (let index = 0; index < location.files.length; index++) if (current[index] !== undefined) await rm(location.files[index]!)
          if (platform === "linux") await run("systemctl", ["--user", "daemon-reload"], signal)
        } catch (cause) {
          if (cause instanceof UpdateWakeError) throw cause
          throw failure("registration", "Could not remove ATape's update timer. The preference remains off; retry in Settings.")
        }
        return { state: "missing" }
      }
      releaseUpdate = await acquireUpdateWorker(location.home)
      if (!releaseUpdate) return { state: "unavailable", message: "An ATape update is running. Scheduled registration will retry after it finishes." }
      if (await needsUpdateRecovery(paths)) return { state: "unavailable", message: "ATape update recovery is pending. Scheduled registration will retry after recovery completes." }
      const precedingLauncher = previous ? await readLauncher(previous, uid, true) : undefined
      let bootstrap: string, bundle: string
      try {
        bootstrap = await realpath(await selectedBootstrap(location.home, environment.ATAPE_BOOTSTRAP_ENTRY ?? entryFile))
        const root = (await run("npm", ["root", "--global"], signal)).trim()
        if (!isAbsolute(root) || bootstrap !== await realpath(join(root, "@atape", "cli", "dist", "atape.js"))) return unsupported()
        const manifest = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.Literal("@atape/cli"), version: Schema.String }))(
          await readBoundedJSON(join(dirname(dirname(bootstrap)), "package.json")))
        if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) return unsupported()
        const selected = await capableRuntime(location.home, bootstrap)
        if (!selected.capable) return unsupported()
        bundle = await readBundle(selected.entry)
      } catch (cause) {
        stopped(signal)
        if (cause instanceof UpdateWakeError) throw cause
        return { state: "unavailable", message: "Could not verify the npm global ATape installation. Check Node/npm and reopen ATape." }
      }
      if (!await managerAvailable(signal)) return unavailable()
      const context = retainedContext(previous, environment)
      const metadata: Metadata = { protocol, enabled: true, token: previous?.token ?? randomUUID(), home: location.home,
        job: location.job, platform, node: await realpath(process.execPath), bootstrap,
        launcher: join(location.directory, "atape.mjs"), launcherHash: digest(bundle), descriptors: [],
        environment: publicEnvironment(paths, location.home, userHome, bootstrap, context), privateEnvironment: privateEnvironment(context) }
      const nextContents = descriptors(metadata), next = { ...metadata, descriptors: location.files.map((file, index) => ({ file, hash: digest(nextContents[index]!) })) }
      const wasRegistered = await registered(location, signal)
      const wasLoaded = platform === "darwin" && !wasRegistered ? await loaded(location, signal) : wasRegistered
      if (previous && JSON.stringify(previous) === JSON.stringify(next) && precedingLauncher === bundle
        && current.every((value, index) => value === nextContents[index]) && wasRegistered) return { state: "registered" }
      await secureDirectoryTree(location.base, dirname(location.files[0]!), uid)
      const pending: Metadata = { ...next,
        ...(precedingLauncher !== undefined && digest(precedingLauncher) !== next.launcherHash ? { precedingLauncherHash: digest(precedingLauncher) } : {}),
        descriptors: next.descriptors.map((item, index) => ({ ...item,
          ...(current[index] !== undefined && digest(current[index]!) !== item.hash ? { precedingHash: digest(current[index]!) } : {}) })) }
      await writeOwned(location.metadata, `${JSON.stringify(pending)}\n`, uid)
      stopped(signal)
      if (precedingLauncher !== bundle) await writeOwned(next.launcher, bundle, uid, maximumBundleBytes)
      for (let index = 0; index < location.files.length; index++) {
        stopped(signal)
        if (current[index] !== nextContents[index]) await writeOwned(location.files[index]!, nextContents[index]!, uid)
      }
      stopped(signal)
      try {
        if (platform === "darwin") {
          if (wasLoaded && current[0] !== nextContents[0]) await run("/bin/launchctl", ["bootout", `gui/${uid}/${location.job}`], signal)
          await run("/bin/launchctl", ["enable", `gui/${uid}/${location.job}`], signal)
          if (!wasLoaded || current[0] !== nextContents[0]) await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, location.files[0]!], signal)
        } else {
          await run("systemctl", ["--user", "daemon-reload"], signal)
          await run("systemctl", ["--user", "enable", `${location.job}.timer`], signal)
          await run("systemctl", ["--user", "start", `${location.job}.timer`], signal)
        }
      } catch (cause) {
        if (cause instanceof UpdateWakeError) throw cause
        throw failure("registration", "Could not install ATape's update timer. Check the user service manager and retry in Settings.")
      }
      if (!await registered(location, signal)) return { state: "missing" }
      await writeOwned(location.metadata, `${JSON.stringify(next)}\n`, uid)
      return { state: "registered" }
    } finally { releaseUpdate?.(); release() }
  }
  return Layer.succeed(UpdateWakePlatform, UpdateWakePlatform.of({ inspect: () => managedEffect(inspect),
    reconcile: enabled => managedEffect(signal => reconcile(enabled, signal)) }))
}

// Repeated under update ownership by the executable. A disabled trusted entry
// remains admitted only to recover and remove its retained future scheduling.
export const admitUpdateWake = async (paths: NodeClientPaths, token: string, entryFile: string,
  environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv | undefined> => {
  try {
    const home = await realpath(paths.atapeHome), uid = process.getuid?.()
    for (const path of [home, join(home, "updates"), directory(home)]) if (!await privateDirectoryPresent(path, uid)) return undefined
    const json = await readPrivateFile(join(directory(home), "registration.json"), uid)
    if (json === undefined) return undefined
    const metadata = decodeMetadata(JSON.parse(json), home)
    if (!tokenPattern.test(token) || token !== metadata.token) throw failure("identity", "This update wake entry is reserved for its registered ATape installation.")
    await readLauncher(metadata, uid)
    const pending = await needsUpdateRecovery(defaultNodeClientPaths(metadata.environment))
    const current = await realpath(entryFile)
    if (pending && current === metadata.launcher) await realpath(metadata.bootstrap)
    else {
      const selected = await capableRuntime(home, metadata.bootstrap)
      if (!selected.capable) return undefined
      if (current !== metadata.launcher && current !== selected.entry) throw failure("identity", "The registered ATape update executable changed. Reopen ATape to repair it.")
    }
    const config = Schema.decodeUnknownSync(ClientConfig)(await readBoundedJSON(metadata.environment.ATAPE_CONFIG_FILE!, 4 * 1024 * 1024))
    const admitted: NodeJS.ProcessEnv = { ...environment, ...metadata.environment, ...metadata.privateEnvironment,
      ATAPE_BOOTSTRAP_ENTRY: metadata.bootstrap,
      ATAPE_UPDATE_WAKE_RECOVERY_ONLY: !metadata.enabled || !config.toolsConfigured || config.autoUpdateEnabled === false ? "1" : "0" }
    if (admitted.ATAPE_SOURCE_COLLECTION_LIMITS === "") delete admitted.ATAPE_SOURCE_COLLECTION_LIMITS
    return admitted
  } catch (cause) {
    if (missing(cause)) return undefined
    if (cause instanceof UpdateWakeError) throw cause
    throw failure("state", "Could not validate ATape scheduled update state. Reopen ATape and inspect Settings.")
  }
}

const capableRuntime = async (home: string, bootstrap: string) => {
  const entry = await realpath(await resolveRuntimeEntry(home, bootstrap))
  const manifest = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.Literal("@atape/cli"),
    atapeRuntime: Schema.optionalKey(Schema.Struct({ updateWakeProtocol: Schema.optionalKey(Schema.String) }))
  }))(await readBoundedJSON(join(dirname(dirname(entry)), "package.json")))
  return { entry, capable: manifest.atapeRuntime?.updateWakeProtocol === protocol && entry === join(dirname(dirname(entry)), "dist", "atape.js") }
}
const safePath = (value: string | undefined) => [...new Set([dirname(process.execPath), ...(value ?? "").split(":").filter(isAbsolute),
  "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].map(cleanText).join(":")
const publicEnvironment = (paths: NodeClientPaths, home: string, userHome: string, bootstrap: string, source: NodeJS.ProcessEnv) => {
  const result: Record<string, string> = { HOME: userHome, PATH: safePath(source.PATH), ATAPE_HOME: home,
    ATAPE_CONFIG_FILE: paths.configFile, ATAPE_COLLECTOR_STATE_FILE: paths.collectorStateFile,
    ATAPE_COLLECTOR_PROCESS_FILE: paths.collectorProcessFile, ATAPE_COLLECTOR_STATUS_FILE: paths.collectorStatusFile,
    ATAPE_COLLECTOR_LOG_FILE: paths.collectorLogFile, ATAPE_ADAPTER_DIRECTORY: paths.adapterDirectory,
    ATAPE_BOOTSTRAP_ENTRY: bootstrap, XDG_CONFIG_HOME: source.XDG_CONFIG_HOME && isAbsolute(source.XDG_CONFIG_HOME) ? source.XDG_CONFIG_HOME : join(userHome, ".config") }
  for (const name of publicNames) if (source[name] !== undefined && (!name.startsWith("XDG_") || isAbsolute(source[name]!))) result[name] = cleanText(source[name]!)
  for (const name of publicNames) if (result[name] && (name.endsWith("_HOME") || name.endsWith("_FILE") || name === "OPENCODE_DB")) result[name] = resolve(result[name])
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, cleanText(value)]))
}
const privateEnvironment = (source: NodeJS.ProcessEnv) => Object.fromEntries(privateNames.flatMap(name => {
  const value = source[name]
  if (value === undefined) return []
  if (value.includes("\0") || value.length > 64 * 1024) throw failure("state", "A private update wake environment value is invalid or too large.")
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
  try { metadata = Schema.decodeUnknownSync(Metadata, { onExcessProperty: "error" })(value) }
  catch { throw failure("identity", "ATape refused unrecognized update wake metadata.") }
  const allowed = new Set<string>([...publicNames, ...pathNames, "HOME", "PATH", "ATAPE_HOME", "ATAPE_BOOTSTRAP_ENTRY"])
  const files = metadata.platform === "darwin" ? [join(metadata.environment.HOME ?? "", "Library", "LaunchAgents", `${metadata.job}.plist`)]
    : [join(metadata.environment.XDG_CONFIG_HOME ?? "", "systemd", "user", `${metadata.job}.service`), join(metadata.environment.XDG_CONFIG_HOME ?? "", "systemd", "user", `${metadata.job}.timer`)]
  if (metadata.home !== home || metadata.job !== jobName(home) || !tokenPattern.test(metadata.token)
    || ![metadata.node, metadata.bootstrap, metadata.environment.HOME ?? "", metadata.environment.XDG_CONFIG_HOME ?? ""].every(isAbsolute)
    || metadata.launcher !== join(directory(home), "atape.mjs") || !hashPattern.test(metadata.launcherHash)
    || metadata.precedingLauncherHash !== undefined && !hashPattern.test(metadata.precedingLauncherHash)
    || metadata.descriptors.length !== files.length || metadata.descriptors.some((item, index) => item.file !== files[index]
      || !hashPattern.test(item.hash) || item.precedingHash !== undefined && !hashPattern.test(item.precedingHash))
    || metadata.environment.ATAPE_HOME !== home || metadata.environment.ATAPE_BOOTSTRAP_ENTRY !== metadata.bootstrap
    || pathNames.some(name => !metadata.environment[name] || !isAbsolute(metadata.environment[name]!))
    || Object.keys(metadata.environment).some(name => !allowed.has(name))
    || Object.keys(metadata.privateEnvironment).some(name => !(privateNames as readonly string[]).includes(name))) throw failure("identity", "ATape refused unrecognized update wake metadata.")
  for (const value of Object.values(metadata.environment)) cleanText(value)
  privateEnvironment(metadata.privateEnvironment)
  if (descriptors(metadata).some((content, index) => digest(content) !== metadata.descriptors[index]!.hash)) throw failure("identity", "ATape update wake metadata does not match its registration.")
  return metadata
}
const assertDescriptors = (metadata: Metadata | undefined, contents: readonly (string | undefined)[]) => {
  if (contents.some((content, index) => content !== undefined && (!metadata || digest(content) !== metadata.descriptors[index]?.hash
    && digest(content) !== metadata.descriptors[index]?.precedingHash))) throw failure("identity", "ATape refused to replace a modified or foreign update wake file.")
}
const readLauncher = async (metadata: Metadata, uid: number | undefined, allowMissing = false) => {
  const bundle = await readPrivateFile(metadata.launcher, uid, maximumBundleBytes)
  if (bundle === undefined) {
    if (allowMissing) return undefined
    throw failure("identity", "The registered ATape update wake launcher is missing. Reopen ATape to repair it.")
  }
  const hash = digest(bundle)
  if (hash !== metadata.launcherHash && hash !== metadata.precedingLauncherHash) throw failure("identity", "ATape refused a modified or foreign update wake launcher.")
  return bundle
}
const descriptors = (metadata: Metadata): readonly string[] => {
  const args = [metadata.node, metadata.launcher, "__update-wake", "--wake-token", metadata.token]
  const minute = parseInt(digest(metadata.home).slice(0, 8), 16) % 60
  if (metadata.platform === "darwin") return [`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(metadata.job)}</string>\n<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>EnvironmentVariables</key><dict>${Object.entries(metadata.environment).map(([name, value]) => `<key>${xml(name)}</key><string>${xml(value)}</string>`).join("")}</dict>\n<key>WorkingDirectory</key><string>${xml(metadata.home)}</string>\n<key>RunAtLoad</key><true/>\n<key>StartCalendarInterval</key><dict><key>Minute</key><integer>${minute}</integer></dict>\n<key>ExitTimeOut</key><integer>40</integer>\n<key>AbandonProcessGroup</key><false/>\n<key>ProcessType</key><string>Background</string>\n<key>Umask</key><integer>63</integer>\n</dict></plist>\n`]
  return [`# ${protocol} ${metadata.job}\n[Unit]\nDescription=ATape scheduled update\n\n[Service]\nType=oneshot\nRemainAfterExit=no\nExecStart=${args.map(arg => unitQuote(arg, true)).join(" ")}\nWorkingDirectory=${unitDirectory(metadata.home)}\n${Object.entries(metadata.environment).map(([name, value]) => `Environment=${unitQuote(`${name}=${value}`)}`).join("\n")}\nTimeoutStartSec=600s\nTimeoutStopSec=40s\nKillMode=process\nUMask=0077\n`,
    `# ${protocol} ${metadata.job}\n[Unit]\nDescription=ATape hourly update wake\n\n[Timer]\nOnCalendar=*-*-* *:${String(minute).padStart(2, "0")}:00\nPersistent=true\nUnit=${metadata.job}.service\n\n[Install]\nWantedBy=timers.target\n`]
}
const commandCode = (cause: unknown, values: number[]) => typeof cause === "object" && cause !== null && "code" in cause && values.includes(Number(cause.code))
