import { AdapterPackageError, AdapterPackages, type InstalledAdapterPackage } from "@atape/application"
import { AdapterManifest as AdapterManifestSchema } from "@atape/domain"
import { open, opendir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect, Layer, Schema, type Scope } from "effect"
import { adapterPackageRoot, prepareAdapterSlot, trackAdapterSlot, pruneAdapterSlots } from "./adapterInstallation.ts"
import { executeOwnedProcess } from "./ownedProcess.ts"
import { downloadAdapterPackage, inspectLocalAdapterPackage, type AdapterPackageFetch } from "./adapterPackageSource.ts"

export const makeAdapterPackagesLayer = (
  adapterDirectory: string,
  fetchAdapterPackage: AdapterPackageFetch = globalThis.fetch
) => Layer.succeed(
  AdapterPackages,
  AdapterPackages.of({
    prune: input => pruneAdapterSlots(adapterDirectory, input),
    install: (packageSpec) => installAdapterPackage(adapterDirectory, packageSpec, fetchAdapterPackage)
  })
)

const installAdapterPackage = (
  adapterDirectory: string,
  packageSpec: string,
  fetchAdapterPackage: AdapterPackageFetch
): Effect.Effect<InstalledAdapterPackage, AdapterPackageError, Scope.Scope> => Effect.acquireUseRelease(
  acquirePackageSource(adapterDirectory, packageSpec, fetchAdapterPackage),
  (source) => installAcquiredAdapterPackage(adapterDirectory, packageSpec, source),
  (source) => Effect.promise(() => source.release().catch(() => undefined))
)

const installAcquiredAdapterPackage = (
  adapterDirectory: string,
  packageSpec: string,
  source: PackageSource
): Effect.Effect<InstalledAdapterPackage, AdapterPackageError, Scope.Scope> => Effect.gen(function*() {
  const preflight = source.packageJSON === undefined
    ? undefined
    : yield* decodePackageManifest(packageSpec, source.packageJSON)
  const packageName = source.packageName ?? preflight?.name
  if (packageName === undefined) {
    return yield* new AdapterPackageError({
      reason: "manifest", packageSpec, message: "Could not determine the Adapter package name."
    })
  }
  const slot = yield* prepareAdapterSlot(adapterDirectory, packageSpec)
  yield* Effect.callback<void, AdapterPackageError>(resume => {
    const cancellation = new AbortController()
    const task = (async () => {
      await writeFile(join(slot.root, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
      await executeOwnedProcess("npm", [
        "install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--install-links",
        "--prefix", slot.root, source.installSpec
      ], process.env, cancellation.signal, 120_000)
    })()
    task.then(() => resume(Effect.void), cause => resume(Effect.fail(new AdapterPackageError({
      reason: "install", packageSpec, message: errorMessage(`Could not install ${packageSpec}`, cause)
    }))))
    // Do not remove a cancelled slot while npm can still mutate its files.
    return Effect.promise(async () => { cancellation.abort(); await task.catch(() => {}) })
  })

  const packageRoot = adapterPackageRoot(adapterDirectory, { packageName, packageSlot: slot.packageSlot })
  const packageJSON = yield* Effect.tryPromise({
    try: async () => JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as unknown,
    catch: (cause) => new AdapterPackageError({
      reason: "io", packageSpec, message: errorMessage(`Could not read ${packageName} metadata`, cause)
    })
  })
  const decoded = yield* decodePackageManifest(packageSpec, packageJSON)
  if (decoded.name !== packageName) {
    return yield* new AdapterPackageError({
      reason: "manifest", packageSpec, message: `Installed package name ${decoded.name} does not match ${packageName}.`
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
      const canonicalRoot = await realpath(packageRoot)
      const canonicalEntry = await realpath(entryPath)
      const within = relative(canonicalRoot, canonicalEntry)
      if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("entry leaves the installed package")
      const entry = await stat(entryPath)
      if (!entry.isFile()) throw new Error("entry is not a file")
    },
    catch: (cause) => new AdapterPackageError({
      reason: "manifest", packageSpec, message: errorMessage("Adapter entry does not exist", cause)
    })
  })
  // Make the selected files durable before configuration can reference them.
  yield* Effect.tryPromise({
    try: async () => {
      await trackAdapterSlot(slot.root, { packageSlot: slot.packageSlot, packageName: decoded.name, version: decoded.version })
      await syncPackageTree(slot.root)
      await syncDirectory(dirname(slot.root))
      await syncDirectory(adapterDirectory)
    },
    catch: cause => new AdapterPackageError({ reason: "io", packageSpec, message: errorMessage("Could not persist the Adapter installation", cause) })
  }).pipe(Effect.uninterruptible)
  slot.retained = true
  return {
    packageName: decoded.name,
    packageSlot: slot.packageSlot,
    upgradeSpec: source.upgradeSpec,
    version: decoded.version,
    manifest: decoded.manifest
  }
})

const syncDirectory = async (path: string) => {
  if (process.platform === "win32") return
  const directory = await open(path, "r")
  try { await directory.sync() } finally { await directory.close() }
}

const syncPackageTree = async (path: string): Promise<void> => {
  const directory = await opendir(path)
  for await (const entry of directory) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await syncPackageTree(child)
    else if (entry.isFile()) {
      const file = await open(child, "r")
      try { await file.sync() } finally { await file.close() }
    }
  }
  await syncDirectory(path)
}

type PackageSource = {
  readonly packageName?: string
  readonly packageJSON?: unknown
  readonly installSpec: string
  readonly upgradeSpec: string
  readonly release: () => Promise<void>
}

const packageNamePattern = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/

const acquirePackageSource = (
  adapterDirectory: string,
  packageSpec: string,
  fetchAdapterPackage: AdapterPackageFetch
): Effect.Effect<PackageSource, AdapterPackageError> => {
  const registry = packageSpec.match(/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[^\s/]+)?$/)
  if (registry?.[1]) {
    return Effect.succeed({
      packageName: registry[1],
      installSpec: packageSpec,
      upgradeSpec: registry[1],
      release: noRelease
    })
  }
  if (packageSpec.startsWith("https://")) {
    return Effect.tryPromise({
      try: async () => {
        const downloaded = await downloadAdapterPackage(packageSpec, adapterDirectory, fetchAdapterPackage)
        return {
          packageJSON: downloaded.packageJSON,
          installSpec: `file:${downloaded.path}`,
          upgradeSpec: packageSpec,
          release: downloaded.release
        }
      },
      catch: (cause) => new AdapterPackageError({
        reason: "invalid_spec",
        packageSpec,
        message: errorMessage("Could not acquire the remote Adapter package", cause)
      })
    })
  }
  const isFile = packageSpec.startsWith("file:") || packageSpec.startsWith(".") || isAbsolute(packageSpec)
  if (!isFile) {
    return Effect.fail(new AdapterPackageError({
      reason: "invalid_spec",
      packageSpec,
      message: "Adapter package must be an npm package name, a local package directory/archive, or an HTTPS archive URL."
    }))
  }
  const requestedPath = packageSpec.startsWith("file:") ? packageSpec.slice("file:".length) : packageSpec
  return Effect.tryPromise({
    try: async () => {
      const packagePath = await realpath(resolve(requestedPath))
      const metadata = await stat(packagePath)
      if (metadata.isDirectory()) {
        const packageJSON = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as unknown
        return {
          packageJSON,
          installSpec: `file:${packagePath}`,
          upgradeSpec: `file:${packagePath}`,
          release: noRelease
        }
      }
      const archive = await inspectLocalAdapterPackage(packagePath)
      return {
        packageJSON: archive.packageJSON,
        installSpec: `file:${archive.path}`,
        upgradeSpec: `file:${archive.path}`,
        release: noRelease
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
  if (!packageNamePattern.test(record.name)) {
    return yield* new AdapterPackageError({
      reason: "manifest", packageSpec, message: "Adapter package.json has an invalid package name."
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

const noRelease = async () => undefined

const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
