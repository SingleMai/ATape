import { decodeReleaseBundle, releaseBundleFingerprint, updateCatalogProtocol } from "@atape/domain"
import { CLIUpgradeError, CLIUpgradePlatform, isNewerReleaseVersion, isStableReleaseVersion } from "@atape/application"
import { Effect, Layer, Schema } from "effect"
import { executeOwnedProcess as execute } from "./ownedProcess.ts"
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { managedStateContract, preserveSelectedInstallations } from "./runtimeSelection.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { acquireProcessLock } from "./processLock.ts"
import { createUpdateControl, updateControlProtocol } from "./updateControl.ts"
import { createReleaseDiscovery } from "./releaseDiscovery.ts"
import { cliVersion } from "../version.ts"
import { inspectLocalAdapterPackage } from "./adapterPackageSource.ts"

const registry = "https://registry.npmjs.org/"
const Manifest = Schema.Struct({ name: Schema.Literal("@atape/cli"), version: Schema.String })
const CandidateManifest = Schema.Struct({ name: Schema.Literal("@atape/cli"), version: Schema.String,
  atapeRuntime: Schema.Struct({ protocol: Schema.Literal("atape.runtime.v1"), stateContract: Schema.Literal(managedStateContract),
    updateControlProtocol: Schema.Literal(updateControlProtocol), releaseCatalogProtocol: Schema.Literal(updateCatalogProtocol) }) })
const readBounded = async (file: string) => {
  if ((await stat(file)).size > 256 * 1024) throw new Error("Metadata too large")
  return JSON.parse(await readFile(file, "utf8"))
}

type BootstrapFile = { readonly path: string; readonly bytes: Buffer; readonly mode: number }
type BootstrapBin = { readonly path: string; readonly kind: "absent" } |
  { readonly path: string; readonly kind: "link"; readonly target: string } |
  { readonly path: string; readonly kind: "file"; readonly bytes: Buffer; readonly mode: number }
const missing = (cause: unknown) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
const optionalBytes = async (file: string) => readFile(file).catch(cause => { if (missing(cause)) return undefined; throw cause })
const sameBytes = (left: Buffer | undefined, right: Buffer | undefined) => left === undefined ? right === undefined : right !== undefined && left.equals(right)
const readBootstrapFile = async (path: string, limit: number): Promise<BootstrapFile> => {
  const info = await lstat(path)
  if (!info.isFile() || info.size > limit) throw new Error("The active npm bootstrap is not a bounded regular file.")
  const bytes = await readFile(path)
  if (bytes.length > limit) throw new Error("The active npm bootstrap exceeds its recovery limit.")
  return { path, bytes, mode: info.mode & 0o777 }
}
const readBootstrapBin = async (path: string): Promise<BootstrapBin> => {
  const info = await lstat(path).catch(cause => { if (missing(cause)) return undefined; throw cause })
  if (!info) return { path, kind: "absent" }
  if (info.isSymbolicLink()) return { path, kind: "link", target: await readlink(path) }
  const file = await readBootstrapFile(path, 256 * 1024)
  return { ...file, kind: "file" }
}
const sameBin = (left: BootstrapBin, right: BootstrapBin) => left.kind === right.kind &&
  (left.kind === "absent" || left.kind === "link" && right.kind === "link" && left.target === right.target ||
    left.kind === "file" && right.kind === "file" && left.bytes.equals(right.bytes) && left.mode === right.mode)
const writeBootstrapFile = async (file: BootstrapFile, signal: AbortSignal) => {
  signal.throwIfAborted()
  await mkdir(dirname(file.path), { recursive: true })
  const temporary = `${file.path}.${randomUUID()}.restore`
  try {
    const handle = await open(temporary, "wx", file.mode)
    try { await handle.writeFile(file.bytes, { signal }); await handle.chmod(file.mode); await handle.sync() }
    finally { await handle.close() }
    signal.throwIfAborted()
    await rename(temporary, file.path)
    if (process.platform !== "win32") {
      const directory = await open(dirname(file.path), "r")
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}
const restoreBootstrap = async (files: ReadonlyArray<BootstrapFile>, bins: ReadonlyArray<BootstrapBin>, version: string,
  entry: string, environment: NodeJS.ProcessEnv, home: string) => {
  const deadline = performance.now() + 15_000, signal = AbortSignal.timeout(15_000)
  for (const file of files) {
    const current = await readBootstrapFile(file.path, file.bytes.length).catch(() => undefined)
    if (!current || !current.bytes.equals(file.bytes) || current.mode !== file.mode) await writeBootstrapFile(file, signal)
  }
  for (const bin of bins) {
    signal.throwIfAborted()
    if (await readBootstrapBin(bin.path).then(current => sameBin(bin, current), () => false)) continue
    if (bin.kind === "file") await writeBootstrapFile(bin, signal)
    else if (bin.kind === "absent") await rm(bin.path, { force: true })
    else {
      await mkdir(dirname(bin.path), { recursive: true })
      const temporary = `${bin.path}.${randomUUID()}.restore`
      try { await symlink(bin.target, temporary); signal.throwIfAborted(); await rename(temporary, bin.path) }
      finally { await rm(temporary, { force: true }).catch(() => {}) }
    }
  }
  for (const file of files) if (!(await readFile(file.path)).equals(file.bytes)) throw new Error("Restored bootstrap identity differs.")
  for (const bin of bins) {
    const actual = await readBootstrapBin(bin.path)
    if (!sameBin(bin, actual)) throw new Error("Restored npm command link differs.")
  }
  signal.throwIfAborted()
  const remaining = Math.max(1, Math.floor(deadline - performance.now()))
  const verified = await execute(process.execPath, [entry, "--version"], { ...environment, ATAPE_HOME: home, ATAPE_RUNTIME_DIRECT: "1" }, signal, remaining)
  if (verified.trim() !== `ATape ${version}`) throw new Error("The restored npm bootstrap is not runnable.")
}

export const makeCLIUpgradePlatformLayer = (
  home: string,
  entry: string,
  environment: NodeJS.ProcessEnv = process.env,
  fetchMetadata: typeof globalThis.fetch = globalThis.fetch,
  runtimeVersion: string = cliVersion
) => {
 const discovery = createReleaseDiscovery({ home, runtimeVersion, captureStateContract: managedStateContract, updateControlProtocol, fetchMetadata })
 return Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({
  acquireOwnership: () => Effect.acquireRelease(Effect.tryPromise({
    try: async () => {
      const release = await acquireUpdateWorker(home)
      if (!release) throw new CLIUpgradeError({ reason: "installation",
        message: "Another ATape update is running. Wait for it to finish, then retry in Tools and updates." })
      return release
    },
    catch: cause => cause instanceof CLIUpgradeError ? cause : new CLIUpgradeError({ reason: "installation",
      message: "Could not acquire ATape update ownership. Check local update state and installation permissions." })
  }), release => Effect.sync(release)).pipe(Effect.asVoid),
  latest: cached => Effect.tryPromise({
    try: async signal => {
      return discovery.latest({ cached, signal: AbortSignal.any([signal, AbortSignal.timeout(cached ? 1_500 : 10_000)]) })
    },
    catch: () => new CLIUpgradeError({ reason: "check", message: "Could not check for updates. Check your connection and try the update again in Tools and updates." })
  }),
  installedVersion: () => Effect.tryPromise({
    try: async () => {
      const current = await realpath(resolve(entry))
      return Schema.decodeUnknownSync(Manifest)(await readBounded(join(dirname(dirname(current)), "package.json"))).version
    },
    catch: () => new CLIUpgradeError({ reason: "installation", message: "Could not read the installed global command entry version." })
  }),
  install: value => Effect.callback<void, CLIUpgradeError>(resume => {
    const cancellation = new AbortController()
    const signal = cancellation.signal
    const task = (async () => {
      const bundle = decodeReleaseBundle(value), version = bundle.version
      const run = (args: string[]) => execute("npm", args, environment, signal, 180_000)
      const current = await realpath(resolve(entry))
      const prefix = (await run(["prefix", "--global"])).trim()
      const root = (await run(["root", "--global", "--prefix", prefix])).trim()
      const installedEntry = join(root, "@atape", "cli", "dist", "atape.js")
      if (await realpath(installedEntry).catch(() => undefined) !== current) {
        throw new CLIUpgradeError({ reason: "installation",
          message: "This ATape is not the active npm global installation. Update it with the package manager or path used to install it." })
      }
      const release = await acquireProcessLock(join(root, ".atape-upgrade.lock.sqlite")).catch(() => {
        throw new CLIUpgradeError({ reason: "installation", message: "Cannot lock this installation. Check write permissions and whether another upgrade is running." })
      })
      if (!release) throw new CLIUpgradeError({ reason: "installation", message: "Another ATape update owns this npm installation. Wait for it to finish, then retry." })
      try {
        const actual = Schema.decodeUnknownSync(Manifest)(await readBounded(join(dirname(dirname(current)), "package.json")))
        if (!isStableReleaseVersion(actual.version)) throw new CLIUpgradeError({ reason: "installation",
          message: "The installed ATape version is not a stable release. Update it with the package manager used to install it." })
        if (isNewerReleaseVersion(actual.version, version)) throw new CLIUpgradeError({ reason: "installation",
          message: `ATape ${actual.version} is already installed. Check versions again before applying an older release.` })
        const control = createUpdateControl(home), selected = await control.readSelection()
        if (await control.recoveryPending()) throw new CLIUpgradeError({ reason: "installation",
          message: "An interrupted ATape update must recover before replacing its npm installation." })
        if (selected && isNewerReleaseVersion(selected.version, version)) throw new CLIUpgradeError({ reason: "installation",
          message: `ATape ${selected.version} is already selected. Check versions again before applying an older release.` })
        // npm may remove the old package and bin entry before reporting failure.
        // Keep only the bounded runnable bundle needed to restore its routing;
        // managed runtime, Adapter selections and user intent stay authoritative.
        const packageRoot = dirname(dirname(installedEntry))
        if (await realpath(packageRoot) !== join(await realpath(root), "@atape", "cli")) throw new Error("Linked npm package roots require their original package manager.")
        const originalFiles = [await readBootstrapFile(installedEntry, 16 * 1024 * 1024),
          await readBootstrapFile(join(packageRoot, "package.json"), 256 * 1024)]
        const binPaths = process.platform === "win32" ? [join(prefix, "atape"), join(prefix, "atape.cmd"), join(prefix, "atape.ps1")] : [join(prefix, "bin", "atape")]
        const originalBins = await Promise.all(binPaths.map(readBootstrapBin))
        const originalVersion = await execute(process.execPath, [installedEntry, "--version"],
          { ...environment, ATAPE_HOME: home, ATAPE_RUNTIME_DIRECT: "1" }, signal, 15_000)
        if (originalVersion.trim() !== `ATape ${actual.version}`) throw new Error("The current npm bootstrap is not runnable.")
        const controlFiles = [join(home, "updates", "control.json"), join(home, "updates", "runtime.json")]
        const originalControl = await Promise.all(controlFiles.map(optionalBytes))
        const discovered = await discovery.exact({ version, signal })
        if (releaseBundleFingerprint(discovered) !== releaseBundleFingerprint(bundle)) throw new Error("Release bundle changed before command-entry refresh")
        const archive = await discovery.acquireArtifact(bundle, "@atape/cli", signal)
        try {
        const manifest = Schema.decodeUnknownSync(CandidateManifest)((await inspectLocalAdapterPackage(archive.path)).packageJSON)
        if (manifest.version !== version) throw new Error("The CLI archive does not match the selected release")
        signal.throwIfAborted()
        await preserveSelectedInstallations(defaultNodeClientPaths({ ...environment, ATAPE_HOME: home }))
        try {
        await run(["install", "--global", "--prefix", prefix, archive.path, "--ignore-scripts", "--engine-strict", "--no-audit", "--no-fund", "--registry", registry,
          `--@atape:registry=${registry}`])
        // Once npm has replaced the bootstrap, join verification/rebinding even
        // if the caller cancels. A killed process is repaired from the changed
        // bootstrap by the next owned startup recovery.
        const verified = await execute(process.execPath, [installedEntry, "--version"],
          { ...environment, ATAPE_HOME: home, ATAPE_RUNTIME_DIRECT: "1" }, AbortSignal.timeout(15_000), 15_000)
        if (verified.trim() !== `ATape ${version}`) throw new Error("Installed version mismatch")
        if (selected) await control.rebindBootstrap()
        } catch (cause) {
          // A rebind that durably fenced its new identity must recover forward.
          // Restoring old bytes in that case would break the control floor.
          const unchanged = await Promise.all(controlFiles.map(optionalBytes)).then(current =>
            current.every((bytes, index) => sameBytes(bytes, originalControl[index]))).catch(() => false)
          if (unchanged) {
            try { await restoreBootstrap(originalFiles, originalBins, actual.version, installedEntry, environment, home) }
            catch { throw new CLIUpgradeError({ reason: "install", message: "The npm refresh failed and its original command entry could not be restored. The selected runtime is retained; repair the global npm installation before retrying." }) }
          }
          throw cause
        }
        } finally { await archive.release() }
      } finally { release() }
    })()
    task.then(() => resume(Effect.void), cause => resume(Effect.fail(cause instanceof CLIUpgradeError ? cause : new CLIUpgradeError({ reason: "install",
      message: "ATape could not be upgraded. Check your connection and installation permissions, then retry in Tools and updates." }))))
    // Effect interruption waits for process termination and lock cleanup.
    return Effect.promise(async () => { cancellation.abort(); await task.catch(() => {}) })
  })
}))
}
