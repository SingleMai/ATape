import {
  AdapterPackageError,
  AdapterPackages,
  ClientConfigStore,
  ClientConfigStoreError,
  ProjectLocator,
  ProjectLocatorError,
  type ClientConfigChange,
  type InstalledAdapterPackage
} from "@atape/application"
import {
  AdapterManifest as AdapterManifestSchema,
  ClientConfig as ClientConfigSchema,
  emptyClientConfig,
  type ClientConfig
} from "@atape/domain"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { makeNodeCollectorLayer } from "./collectorLayers.ts"

export type NodeClientPaths = {
  readonly configFile: string
  readonly collectorStateFile: string
  readonly adapterDirectory: string
}

export const defaultNodeClientPaths = (environment: NodeJS.ProcessEnv = process.env): NodeClientPaths => {
  const configRoot = environment.XDG_CONFIG_HOME || join(homedir(), ".config")
  const dataRoot = environment.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const stateRoot = environment.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return {
    configFile: environment.ATAPE_CONFIG_FILE || join(configRoot, "atape", "config.json"),
    collectorStateFile: environment.ATAPE_COLLECTOR_STATE_FILE || join(stateRoot, "atape", "collector.json"),
    adapterDirectory: environment.ATAPE_ADAPTER_DIRECTORY || join(dataRoot, "atape", "adapters")
  }
}

export const makeNodeClientLayer = (
  paths: NodeClientPaths,
  environment: NodeJS.ProcessEnv = process.env
) => Layer.mergeAll(
  makeConfigStoreLayer(paths.configFile),
  makeProjectLocatorLayer(),
  makeAdapterPackagesLayer(paths.adapterDirectory),
  makeNodeCollectorLayer(paths, environment)
)

export const makeConfigStoreLayer = (configFile: string) => Layer.succeed(
  ClientConfigStore,
  ClientConfigStore.of({
    transact: <A, E, R>(change: (config: ClientConfig) => Effect.Effect<ClientConfigChange<A>, E, R>) =>
      Effect.acquireUseRelease(
        acquireConfigLock(configFile),
        () => readClientConfig(configFile).pipe(
          Effect.flatMap(change),
          Effect.flatMap((result) => result.config === undefined
            ? Effect.succeed(result.value)
            : writeClientConfig(configFile, result.config).pipe(Effect.as(result.value)))
        ),
        (lock) => Effect.promise(async () => {
          await lock.close().catch(() => undefined)
          await rm(lock.path, { force: true }).catch(() => undefined)
        })
      )
  })
)

const acquireConfigLock = (configFile: string) => Effect.tryPromise({
  try: async () => {
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 })
    const lockPath = `${configFile}.lock`
    const deadline = Date.now() + 5_000
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
          await handle.sync()
          return { path: lockPath, close: () => handle.close() }
        } catch (cause) {
          await handle.close().catch(() => undefined)
          await rm(lockPath, { force: true }).catch(() => undefined)
          throw cause
        }
      } catch (cause) {
        if (!hasCode(cause, "EEXIST")) throw cause
        if (await staleConfigLock(lockPath)) {
          await rm(lockPath, { force: true })
          continue
        }
        if (Date.now() >= deadline) throw cause
        await new Promise((done) => setTimeout(done, 50))
      }
    }
  },
  catch: (cause) => new ClientConfigStoreError({
    reason: "io",
    message: hasCode(cause, "EEXIST")
      ? "Another ATape CLI command is still updating the client configuration."
      : errorMessage("Could not lock the ATape client configuration", cause)
  })
})

const staleConfigLock = async (lockPath: string) => {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown }
    if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
      try {
        process.kill(value.pid, 0)
        return false
      } catch (cause) {
        return hasCode(cause, "ESRCH")
      }
    }
  } catch {
    // A process may have created the lock and not written its owner yet. Only
    // remove malformed locks once they are old enough to be unambiguously stale.
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > 30_000
  } catch (cause) {
    return hasCode(cause, "ENOENT")
  }
}

const readClientConfig = (configFile: string): Effect.Effect<ClientConfig, ClientConfigStoreError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return JSON.parse(await readFile(configFile, "utf8")) as unknown
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) return emptyClientConfig()
        throw cause
      }
    },
    catch: (cause) => new ClientConfigStoreError({
      reason: "io",
      message: errorMessage("Could not read the ATape client configuration", cause)
    })
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(ClientConfigSchema)(value)),
    Effect.mapError((error) => error instanceof ClientConfigStoreError
      ? error
      : new ClientConfigStoreError({
        reason: "decode",
        message: `The ATape client configuration is invalid: ${String(error)}`
      }))
  )

const writeClientConfig = (configFile: string, config: ClientConfig): Effect.Effect<void, ClientConfigStoreError> =>
  Schema.decodeUnknownEffect(ClientConfigSchema)(config).pipe(
    Effect.mapError((error) => new ClientConfigStoreError({
      reason: "decode", message: `ATape refused to persist an invalid client configuration: ${String(error)}`
    })),
    Effect.flatMap((validated) => Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(configFile), { recursive: true, mode: 0o700 })
        const temporary = `${configFile}.${process.pid}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: "wx" })
          await rename(temporary, configFile)
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
      },
      catch: (cause) => new ClientConfigStoreError({
        reason: "io", message: errorMessage("Could not write the ATape client configuration", cause)
      })
    }))
  )

export const makeProjectLocatorLayer = () => Layer.succeed(ProjectLocator, ProjectLocator.of({
  locate: (inputPath, preference) => Effect.tryPromise({
    try: async () => {
      const requested = await realpath(resolve(inputPath))
      const metadata = await stat(requested)
      if (!metadata.isDirectory()) {
        throw locatedFailure("not_directory", requested, `${requested} is not a directory.`)
      }
      if (preference === "directory") {
        return { path: requested, name: basename(requested), type: "directory" as const }
      }
      const gitRoot = await findGitRoot(requested)
      if (gitRoot === undefined) {
        if (preference === "git") {
          throw locatedFailure("not_git", requested, `${requested} is not inside a Git worktree.`)
        }
        return { path: requested, name: basename(requested), type: "directory" as const }
      }
      const root = await realpath(gitRoot)
      return { path: root, name: basename(root), type: "git" as const }
    },
    catch: (cause) => {
      if (cause instanceof ProjectLocatorError) return cause
      if (hasCode(cause, "ENOENT")) {
        return new ProjectLocatorError({
          reason: "missing", path: inputPath, message: `${inputPath} does not exist.`
        })
      }
      return new ProjectLocatorError({
        reason: "io", path: inputPath, message: errorMessage(`Could not inspect ${inputPath}`, cause)
      })
    }
  })
}))

const findGitRoot = (path: string): Promise<string | undefined> => new Promise((resolveResult, reject) => {
  execFile("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  }, (error, stdout) => {
    if (error === null) {
      resolveResult(stdout.trim())
      return
    }
    if (hasCode(error, "ENOENT")) {
      reject(error)
      return
    }
    resolveResult(undefined)
  })
})

export const makeAdapterPackagesLayer = (adapterDirectory: string) => Layer.succeed(
  AdapterPackages,
  AdapterPackages.of({
    install: (packageSpec) => installAdapterPackage(adapterDirectory, packageSpec)
  })
)

const installAdapterPackage = (
  adapterDirectory: string,
  packageSpec: string
): Effect.Effect<InstalledAdapterPackage, AdapterPackageError> => Effect.gen(function*() {
  const request = yield* resolvePackageRequest(packageSpec)
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(adapterDirectory, { recursive: true, mode: 0o700 })
      const packageFile = join(adapterDirectory, "package.json")
      try {
        await access(packageFile, constants.F_OK)
      } catch {
        await writeFile(packageFile, `${JSON.stringify({ private: true }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
      }
      await execFilePromise("npm", [
        "install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund",
        "--prefix", adapterDirectory, request.installSpec
      ], 120_000)
    },
    catch: (cause) => new AdapterPackageError({
      reason: "install", packageSpec, message: errorMessage(`Could not install ${packageSpec}`, cause)
    })
  })

  const packageRoot = join(adapterDirectory, "node_modules", ...request.packageName.split("/"))
  const packageJSON = yield* Effect.tryPromise({
    try: async () => JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as unknown,
    catch: (cause) => new AdapterPackageError({
      reason: "io", packageSpec, message: errorMessage(`Could not read ${request.packageName} metadata`, cause)
    })
  })
  const decoded = yield* decodePackageManifest(packageSpec, packageJSON)
  if (decoded.name !== request.packageName) {
    return yield* new AdapterPackageError({
      reason: "manifest", packageSpec, message: `Installed package name ${decoded.name} does not match ${request.packageName}.`
    })
  }
  const entryPath = resolve(packageRoot, decoded.manifest.entry)
  const entryRelative = relative(packageRoot, entryPath)
  if (decoded.manifest.entry.startsWith("./") === false || entryRelative.startsWith(`..${sep}`) || isAbsolute(entryRelative)) {
    return yield* new AdapterPackageError({
      reason: "manifest", packageSpec, message: "Adapter entry must be a package-relative path."
    })
  }
  yield* Effect.tryPromise({
    try: async () => {
      const entry = await stat(entryPath)
      if (!entry.isFile()) throw new Error("entry is not a file")
    },
    catch: (cause) => new AdapterPackageError({
      reason: "manifest", packageSpec, message: errorMessage("Adapter entry does not exist", cause)
    })
  })
  return {
    packageName: decoded.name,
    upgradeSpec: request.upgradeSpec,
    version: decoded.version,
    manifest: decoded.manifest
  }
})

type PackageRequest = {
  readonly packageName: string
  readonly installSpec: string
  readonly upgradeSpec: string
}

const packageNamePattern = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/

const resolvePackageRequest = (packageSpec: string): Effect.Effect<PackageRequest, AdapterPackageError> => {
  const registry = packageSpec.match(/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[^\s/]+)?$/)
  if (registry?.[1]) {
    return Effect.succeed({
      packageName: registry[1], installSpec: packageSpec, upgradeSpec: registry[1]
    })
  }
  const isFile = packageSpec.startsWith("file:") || packageSpec.startsWith(".") || isAbsolute(packageSpec)
  if (!isFile) {
    return Effect.fail(new AdapterPackageError({
      reason: "invalid_spec",
      packageSpec,
      message: "Adapter package must be an npm package name or a local package directory."
    }))
  }
  const requestedPath = packageSpec.startsWith("file:") ? packageSpec.slice("file:".length) : packageSpec
  return Effect.tryPromise({
    try: async () => {
      const packagePath = await realpath(resolve(requestedPath))
      const metadata = await stat(packagePath)
      if (!metadata.isDirectory()) throw new Error("local Adapter package is not a directory")
      const value = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as Record<string, unknown>
      if (typeof value.name !== "string" || !packageNamePattern.test(value.name)) {
        throw new Error("local Adapter package has an invalid name")
      }
      return {
        packageName: value.name,
        installSpec: `file:${packagePath}`,
        upgradeSpec: `file:${packagePath}`
      }
    },
    catch: (cause) => new AdapterPackageError({
      reason: "invalid_spec",
      packageSpec,
      message: errorMessage("Could not inspect the local Adapter package", cause)
    })
  })
}

const decodePackageManifest = (packageSpec: string, value: unknown) => Effect.gen(function*() {
  if (typeof value !== "object" || value === null) {
    return yield* new AdapterPackageError({ reason: "manifest", packageSpec, message: "package.json must be an object." })
  }
  const record = value as Record<string, unknown>
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    return yield* new AdapterPackageError({
      reason: "manifest", packageSpec, message: "Adapter package.json requires name and version."
    })
  }
  const manifest = yield* Schema.decodeUnknownEffect(AdapterManifestSchema)(record.atapeAdapter).pipe(
    Effect.mapError((error) => new AdapterPackageError({
      reason: "manifest", packageSpec, message: `Invalid atapeAdapter manifest: ${String(error)}`
    }))
  )
  if (manifest.displayName.trim() === "" || manifest.harnesses.length === 0) {
    return yield* new AdapterPackageError({
      reason: "manifest", packageSpec, message: "Adapter manifest requires a display name and at least one Harness."
    })
  }
  return { name: record.name, version: record.version, manifest }
})

const execFilePromise = (file: string, args: ReadonlyArray<string>, timeout: number) => new Promise<void>((resolveResult, reject) => {
  execFile(file, [...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (error) => {
    if (error) reject(error)
    else resolveResult()
  })
})

const locatedFailure = (
  reason: "not_directory" | "not_git",
  path: string,
  message: string
) => new ProjectLocatorError({ reason, path, message })

const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code

const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
