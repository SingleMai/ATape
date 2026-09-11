import { AdapterRuntimeError, AdapterRuntimes, GitSourceAttribution, GitAttributionError, ProjectLocator, type HostedAdapter } from "@atape/application"
import { AdapterCollectionPage as AdapterCollectionPageSchema, AdapterManifest as AdapterManifestSchema,
  AdapterProtocolVersion, GitAttributionVersion, GitSource,
  type AdapterManifest, type AtapeAdapterModule, type AtapeAdapterRuntime } from "@atape/domain"
import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Layer, Schema } from "effect"
import { hostSourceCapture, isSourceCaptureRuntime } from "./sourceCaptureRuntime.ts"
import { adapterPackageRoot, leaseAdapterInstallation } from "./adapterInstallation.ts"

export const makeAdapterRuntimeLayer = (adapterDirectory: string) => Layer.effect(
  AdapterRuntimes,
  Effect.gen(function*() {
    const attribution = yield* GitSourceAttribution
    const locator = yield* ProjectLocator
    return AdapterRuntimes.of({
      open: (project, adapter) => leaseAdapterInstallation(adapterDirectory, adapter).pipe(
        Effect.mapError(cause => runtimeFailure(adapter.adapterId, "load", true, cause.message)),
        Effect.andThen(Effect.acquireRelease(
        loadAdapterRuntime(adapterDirectory, project, adapter, attribution, locator),
        ({ foreign, lifetime }) => Effect.sync(() => lifetime.abort()).pipe(
          Effect.flatMap(() => foreign.close === undefined
            ? Effect.void
            : Effect.tryPromise({
              try: () => Promise.resolve(foreign.close?.()),
              catch: (cause) => new AdapterRuntimeError({
                reason: "close",
                adapterId: adapter.adapterId,
                retryable: false,
                message: errorMessage(`Adapter ${adapter.adapterId} failed to close`, cause)
              })
            }).pipe(Effect.matchEffect({
              onFailure: (error) => Effect.logWarning(error.message),
              onSuccess: () => Effect.void
            })))
        )
      ).pipe(Effect.map(({ hosted }) => hosted))))
    })
  })
)

const loadAdapterRuntime = (
  adapterDirectory: string,
  project: Parameters<AdapterRuntimes["Service"]["open"]>[0],
  adapter: Parameters<AdapterRuntimes["Service"]["open"]>[1],
  attribution: GitSourceAttribution["Service"],
  locator: ProjectLocator["Service"]
) => Effect.gen(function*() {
  const packageRoot = adapterPackageRoot(adapterDirectory, adapter)
  const packageJSON = yield* Effect.tryPromise({
    try: async () => JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
    catch: (cause) => runtimeFailure(adapter.adapterId, "load", false,
      errorMessage(`Could not read installed package ${adapter.packageName}`, cause))
  })
  const manifest = yield* Schema.decodeUnknownEffect(AdapterManifestSchema)(packageJSON.atapeAdapter).pipe(
    Effect.mapError((error) => runtimeFailure(
      adapter.adapterId, "contract", false, `Installed Adapter manifest is invalid: ${String(error)}`
    ))
  )
  if (packageJSON.name !== adapter.packageName || packageJSON.version !== adapter.version ||
    manifest.adapterId !== adapter.adapterId) {
    return yield* runtimeFailure(
      adapter.adapterId,
      "contract",
      false,
      `Installed package identity no longer matches the client configuration; reinstall ${adapter.packageName}.`
    )
  }
  if (project.type === "git" && manifest.gitAttribution !== GitAttributionVersion) {
    return yield* runtimeFailure(adapter.adapterId, "contract", false,
      `Adapter ${adapter.adapterId} does not support Git repository attribution. Upgrade it before collecting this Git Project.`)
  }
  if (manifest.sourceCapture === undefined && project.type === "directory") yield* locator.locate(project.path, "directory").pipe(
    Effect.mapError(error => runtimeFailure(adapter.adapterId, "load", false, error.message)), Effect.asVoid)
  const entry = yield* resolveAdapterEntry(packageRoot, manifest, adapter.adapterId)
  const imported = yield* Effect.tryPromise({
    try: () => import(`${pathToFileURL(entry).href}?atape=${encodeURIComponent(adapter.updatedAt)}`) as Promise<unknown>,
    catch: (cause) => runtimeFailure(
      adapter.adapterId, "load", false, errorMessage(`Could not import Adapter ${adapter.adapterId}`, cause)
    )
  })
  const module = imported as Partial<AtapeAdapterModule>
  if (typeof module.createAtapeAdapter !== "function") {
    return yield* runtimeFailure(
      adapter.adapterId, "contract", false, "Adapter package must export createAtapeAdapter(context)."
    )
  }
  const lifetime = new AbortController()
  let resolver = attribution.forProject(project, adapter.adapterId)
  let attributionFailure: GitAttributionError | undefined
  const attributionRuntimeFailure = () => runtimeFailure(adapter.adapterId,
    attributionFailure?.reason === "unauthenticated" ? "unauthenticated"
      : attributionFailure?.reason === "transport" ? "transport" : "collect",
    attributionFailure?.reason === "transport" || attributionFailure?.reason === "io",
    attributionFailure?.message ?? "Could not determine Git source attribution.")
  const foreign = yield* Effect.tryPromise({
    try: (signal) => Promise.resolve(module.createAtapeAdapter?.({
      protocolVersion: AdapterProtocolVersion,
      adapter: { id: adapter.adapterId, version: adapter.version },
      project: { id: project.id, type: project.type, path: project.path },
      ...(project.type !== "git" ? {} : { gitAttribution: {
        version: GitAttributionVersion,
        resolve: (source: GitSource, sourceSignal: AbortSignal) => Effect.runPromise(
          Schema.decodeUnknownEffect(GitSource)(source).pipe(
            Effect.mapError(() => new GitAttributionError({ reason: "contract", message: "Adapter supplied invalid Git source metadata." })),
            Effect.flatMap(source => isAbsolute(source.cwd)
              ? resolver(source)
              : Effect.fail(new GitAttributionError({ reason: "contract", message: "Adapter supplied a relative Git source directory." }))),
            Effect.tapError(error => Effect.sync(() => { attributionFailure = error }))
          ),
          { signal: AbortSignal.any([sourceSignal, lifetime.signal]) }
        )
      } }),
      signal: AbortSignal.any([signal, lifetime.signal])
    })) as Promise<AtapeAdapterRuntime>,
    catch: (cause) => attributionFailure ? attributionRuntimeFailure() : runtimeFailure(
      adapter.adapterId, "load", false, errorMessage(`Could not create Adapter ${adapter.adapterId}`, cause)
    )
  }).pipe(Effect.onError(() => Effect.sync(() => lifetime.abort())))
  if (typeof foreign !== "object" || foreign === null || (manifest.sourceCapture === undefined
    ? !("collect" in foreign) || typeof foreign.collect !== "function" || "sourceCapture" in foreign
    : !("sourceCapture" in foreign) || !isSourceCaptureRuntime(foreign.sourceCapture) || typeof foreign.close !== "function" || "collect" in foreign)) {
    lifetime.abort()
    if (typeof foreign?.close === "function") yield* Effect.tryPromise({ try: () => Promise.resolve(foreign.close?.()), catch: () => undefined }).pipe(Effect.catch(() => Effect.void))
    return yield* runtimeFailure(
      adapter.adapterId, "contract", false, "createAtapeAdapter must return the exact runtime capability declared by its manifest."
    )
  }
  if (attributionFailure) {
    lifetime.abort()
    if (typeof foreign.close === "function") yield* Effect.tryPromise({
      try: () => Promise.resolve(foreign.close?.()), catch: () => undefined
    }).pipe(Effect.catch(() => Effect.void))
    return yield* attributionRuntimeFailure()
  }
  if ("sourceCapture" in foreign) return { foreign, lifetime, hosted: {
    sourceCapture: hostSourceCapture(adapter.adapterId, foreign.sourceCapture, lifetime.signal),
    attribute: (source) => Schema.decodeUnknownEffect(GitSource)(source).pipe(
      Effect.mapError(() => runtimeFailure(adapter.adapterId, "contract", false, "Source supplied invalid Origin metadata.")),
      Effect.flatMap(source => {
        if (!isAbsolute(source.cwd)) return Effect.fail(runtimeFailure(adapter.adapterId, "contract", false, "Source supplied a relative Origin directory."))
        if (project.type === "git") return resolver(source).pipe(Effect.mapError(error => runtimeFailure(adapter.adapterId,
          error.reason === "unauthenticated" ? "unauthenticated" : error.reason === "transport" ? "transport" : "collect",
          error.reason === "transport" || error.reason === "io", error.message)))
        return locator.locate(project.path, "directory").pipe(
          Effect.mapError(error => runtimeFailure(adapter.adapterId, "collect", error.reason === "io", error.message)),
          Effect.flatMap(local => Effect.tryPromise({
          try: async () => {
            const root = local.path, candidate = await realpath(source.cwd)
            const child = relative(root, candidate)
            return child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`) ? "included" as const : "excluded" as const
          },
          catch: cause => runtimeFailure(adapter.adapterId, "collect", true, errorMessage("Could not inspect source directory ownership", cause))
        })))
      })
    )
  } satisfies HostedAdapter }
  const hosted: HostedAdapter = {
    collect: (request) => Effect.suspend(() => {
      if (request.rawCaptureEnabled === false && manifest.rawCapturePolicy !== "atape.raw-capture.v1") {
        return Effect.fail(runtimeFailure(adapter.adapterId, "contract", false,
          `Upgrade Adapter ${adapter.adapterId} to support the Team Raw capture policy.`))
      }
      resolver = attribution.forProject(project, adapter.adapterId)
      attributionFailure = undefined
      return Effect.tryPromise({
        try: (signal) => Promise.resolve(foreign.collect({
          ...request,
          signal: AbortSignal.any([signal, lifetime.signal])
        })),
        catch: (cause) => attributionFailure ? attributionRuntimeFailure() : runtimeFailure(
          adapter.adapterId, "collect", true, errorMessage(`Adapter ${adapter.adapterId} collection failed`, cause)
        )
      }).pipe(
        Effect.flatMap(value => attributionFailure ? Effect.fail(attributionRuntimeFailure()) : Effect.succeed(value)),
        Effect.flatMap((value) => Schema.decodeUnknownEffect(AdapterCollectionPageSchema)(value)),
        Effect.mapError((error) => error instanceof AdapterRuntimeError
          ? error
          : runtimeFailure(
            adapter.adapterId, "contract", false, `Adapter ${adapter.adapterId} returned an invalid page: ${String(error)}`
          ))
      )
    })
  }
  return { foreign, hosted, lifetime }
})

const resolveAdapterEntry = (
  packageRoot: string,
  manifest: AdapterManifest,
  adapterId: string
) => Effect.tryPromise({
  try: async () => {
    const canonicalRoot = await realpath(packageRoot)
    const entry = await realpath(resolve(canonicalRoot, manifest.entry))
    const entryRelative = relative(canonicalRoot, entry)
    if (!manifest.entry.startsWith("./") || entryRelative.startsWith(`..${sep}`) || isAbsolute(entryRelative)) {
      throw new Error("entry leaves the installed package")
    }
    if (!(await stat(entry)).isFile()) throw new Error("entry is not a file")
    return entry
  },
  catch: (cause) => runtimeFailure(
    adapterId, "contract", false, errorMessage(`Adapter ${adapterId} entry is invalid`, cause)
  )
})

const runtimeFailure = (
  adapterId: string,
  reason: AdapterRuntimeError["reason"],
  retryable: boolean,
  message: string
) => new AdapterRuntimeError({ reason, adapterId, retryable, message })

const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
