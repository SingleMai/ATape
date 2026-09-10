import {
  AdapterRuntimeError,
  AdapterRuntimes,
  CollectionTransportError,
  CollectorStateError,
  CollectorStateStore,
  CollectorTransport,
  makeSecretRedactorLayer,
  makeSourceCaptureCollectorLayer,
  CollectorConfigurationError,
  projectCanonicalSubmission,
  GitSourceAttribution,
  GitAttributionError,
  ProjectLocator,
  type CanonicalSubmission,
  type CollectorStateSnapshot,
  type HostedAdapter,
  type RawSubmission
} from "@atape/application"
import {
  AdapterCollectionPage as AdapterCollectionPageSchema,
  AdapterManifest as AdapterManifestSchema,
  AdapterProtocolVersion,
  GitAttributionVersion,
  GitSource,
  CanonicalApplyReceipt as CanonicalApplyReceiptSchema,
  CollectorState as CollectorStateSchema,
  RawAppendReceipt as RawAppendReceiptSchema,
  RawIngestionProtocolVersion,
  emptyCollectorState,
  type AdapterCollectionPage,
  type AdapterManifest,
  type AtapeAdapterModule,
  type AtapeAdapterRuntime,
  type CanonicalApplyReceipt,
  type CanonicalBatch,
  type CollectorCheckpoint,
  type CollectorState,
  type RawAppendReceipt,
  type RawUploadChunk
} from "@atape/domain"
import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Layer, Schema } from "effect"
import {
  AuthenticatedHTTPClient,
  AuthenticatedHTTPError
} from "./authenticatedHTTPClient.ts"
import { makeCaptureJournalsLayer } from "./captureBootstrap.ts"
import { makePublicationTransportLayer } from "./publicationTransport.ts"
import { makeRawPublicationTransportLayer } from "./rawPublicationTransport.ts"
import { hostSourceCapture, isSourceCaptureRuntime } from "./sourceCaptureRuntime.ts"
import { withCollectorStateLock } from "./collectorStateLock.ts"
import { captureInstallationPath, capturePathState, captureRoot, readCaptureInstallation } from "./captureBinding.ts"

export type NodeCollectorPaths = {
  readonly collectorStateFile: string
  readonly adapterDirectory: string
}

export const makeNodeCollectorLayer = (
  paths: NodeCollectorPaths,
  environment: NodeJS.ProcessEnv = process.env
) => {
  const states = makeCollectorStateLayer(paths.collectorStateFile)
  const journals = makeCaptureJournalsLayer(paths.collectorStateFile)
  const redactor = makeSecretRedactorLayer(environmentSecretValues(environment))
  const configured = environment.ATAPE_SOURCE_COLLECTION_LIMITS
  const sources = configured === undefined ? Layer.empty : Layer.unwrap(Effect.try({
    try: () => {
      if (new TextEncoder().encode(configured).byteLength > 16384) throw new Error("Source admission is too large")
      return JSON.parse(configured) as unknown
    },
    catch: () => new CollectorConfigurationError({ reason: "limits", message: "ATAPE_SOURCE_COLLECTION_LIMITS must be bounded JSON source admission." })
  }).pipe(Effect.map(value => makeSourceCaptureCollectorLayer(value)))).pipe(Layer.provide(Layer.mergeAll(
    states, journals, redactor, makePublicationTransportLayer(), makeRawPublicationTransportLayer()
  )))
  return Layer.mergeAll(states, journals, makeAdapterRuntimeLayer(paths.adapterDirectory), makeCollectorTransportLayer(), redactor, sources)
}

export const environmentSecretValues = (environment: NodeJS.ProcessEnv) => {
  const values = Object.entries(environment)
    .filter(([name, value]) => value !== undefined && name !== "ATAPE_REDACT_VALUES" &&
      /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|DSN)$/i.test(name))
    .map(([, value]) => value as string)
  const configured = environment.ATAPE_REDACT_VALUES
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as unknown
      if (Array.isArray(parsed)) {
        values.push(...parsed.filter((value): value is string => typeof value === "string"))
      } else {
        values.push(configured)
      }
    } catch {
      values.push(...configured.split(",").map((value) => value.trim()).filter(Boolean))
    }
  }
  return values
}

export const makeCollectorStateLayer = (stateFile: string) => Layer.succeed(
  CollectorStateStore,
  CollectorStateStore.of({
    snapshot: (instanceOrigin, userId, projectId, adapterId) => withCollectorState(stateFile, (state) => ({
      value: (() => {
        const checkpoint = state.checkpoints.find((item) =>
          item.instanceOrigin === instanceOrigin && item.userId === userId &&
          item.projectId === projectId && item.adapterId === adapterId)
        return {
          installationId: state.installationId,
          ...(checkpoint === undefined ? {} : { checkpoint })
        } satisfies CollectorStateSnapshot
      })()
    })),
    commit: ({ instanceOrigin, userId, projectId, adapterId, expectedRevision, checkpoint }) =>
      withCollectorState(stateFile, (state) => {
        const current = state.checkpoints.find((item) =>
          item.instanceOrigin === instanceOrigin && item.userId === userId &&
          item.projectId === projectId && item.adapterId === adapterId)
        const currentRevision = current?.revision ?? 0
        if (currentRevision !== expectedRevision || checkpoint.revision !== expectedRevision + 1 ||
          checkpoint.instanceOrigin !== instanceOrigin || checkpoint.userId !== userId ||
          checkpoint.projectId !== projectId || checkpoint.adapterId !== adapterId) {
          throw new CollectorStateError({
            reason: "conflict",
            message: `Collector checkpoint ${projectId}/${adapterId} advanced concurrently.`
          })
        }
        return {
          value: undefined,
          state: {
            ...state,
            checkpoints: [
              ...state.checkpoints.filter((item) =>
                item.instanceOrigin !== instanceOrigin || item.userId !== userId ||
                item.projectId !== projectId || item.adapterId !== adapterId),
              checkpoint
            ].sort((left, right) =>
              checkpointKey(left).localeCompare(checkpointKey(right)))
          }
        }
      })
  })
)

type CollectorStateChange<A> = {
  readonly value: A
  readonly state?: CollectorState
}

const withCollectorState = <A>(
  stateFile: string,
  change: (state: CollectorState) => CollectorStateChange<A>
): Effect.Effect<A, CollectorStateError> => withCollectorStateLock(stateFile,
  readCollectorState(stateFile).pipe(
    Effect.flatMap((loaded) => Effect.try({
      try: () => ({ loaded, result: change(loaded.state) }),
      catch: (cause) => cause instanceof CollectorStateError ? cause : new CollectorStateError({
        reason: "io", message: errorMessage("Could not update the collector state", cause)
      })
    })),
    Effect.flatMap(({ loaded, result }) => result.state === undefined && !loaded.created
      ? Effect.succeed(result.value)
      : writeCollectorState(stateFile, result.state ?? loaded.state, loaded.created).pipe(Effect.as(result.value)))
  )
)

/** Bootstrap uses the same installation and lock as legacy checkpoint writes.
 * The callback's resources stay in its caller Scope; only the metadata lock ends. */
export const withCollectorInstallation = <A, E, R>(stateFile: string, use: (installationId: string) => Effect.Effect<A, E, R>) =>
  withCollectorStateLock(stateFile, Effect.gen(function*() {
    const loaded = yield* readCollectorState(stateFile)
    if (loaded.created) yield* writeCollectorState(stateFile, loaded.state, true)
    return yield* use(loaded.state.installationId)
  }))

const readCollectorState = (
  stateFile: string
): Effect.Effect<{ readonly state: CollectorState; readonly created: boolean }, CollectorStateError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return { value: JSON.parse(await readFile(stateFile, "utf8")) as unknown, created: false }
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) {
          return { value: undefined as unknown, created: true }
        }
        throw cause
      }
    },
    catch: (cause) => cause instanceof CollectorStateError ? cause : new CollectorStateError({
      reason: "io", message: errorMessage("Could not read the collector state", cause)
    })
  }).pipe(
    Effect.flatMap(loaded => !loaded.created ? Effect.succeed(loaded) : Effect.gen(function*() {
      const bound = yield* capturePathState(captureInstallationPath(stateFile)), root = yield* capturePathState(captureRoot(stateFile))
      if (bound !== null || root !== null) return yield* new CollectorStateError({ reason: "decode",
        message: "Collector state is missing while bound captures exist; restore the original installation state." })
      return { value: emptyCollectorState(`i_${randomUUID()}`) as unknown, created: true }
    })),
    Effect.flatMap(({ value, created }) => Schema.decodeUnknownEffect(CollectorStateSchema)(value).pipe(
      Effect.map((state) => ({ state, created }))
    )),
    Effect.tap(({ state }) => readCaptureInstallation(stateFile).pipe(Effect.flatMap(binding =>
      binding === null || binding.installationId === state.installationId ? Effect.void :
        Effect.fail(new CollectorStateError({ reason: "conflict", message: "Collector installation identity differs from its established capture binding." }))))),
    Effect.mapError((error) => error instanceof CollectorStateError
      ? error
      : new CollectorStateError({
        reason: "decode", message: `The ATape collector state is invalid: ${String(error)}`
      }))
  )

const writeCollectorState = (stateFile: string, state: CollectorState, initialize = false): Effect.Effect<void, CollectorStateError> =>
  Schema.decodeUnknownEffect(CollectorStateSchema)(state).pipe(
    Effect.mapError((error) => new CollectorStateError({
      reason: "decode", message: `ATape refused to persist invalid collector state: ${String(error)}`
    })),
    Effect.flatMap((validated) => Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
        const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`
        try {
          const file = await open(temporary, "wx", 0o600)
          try { await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`); await file.sync() } finally { await file.close() }
          if (initialize) await link(temporary, stateFile)
          else await rename(temporary, stateFile)
          const directory = await open(dirname(stateFile), "r")
          try { await directory.sync() } finally { await directory.close() }
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
      },
      catch: (cause) => new CollectorStateError({
        reason: "io", message: errorMessage("Could not write the collector state", cause)
      })
    }))
  )

export const makeAdapterRuntimeLayer = (adapterDirectory: string) => Layer.effect(
  AdapterRuntimes,
  Effect.gen(function*() {
    const attribution = yield* GitSourceAttribution
    const locator = yield* ProjectLocator
    return AdapterRuntimes.of({
      open: (project, adapter) => Effect.acquireRelease(
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
      ).pipe(Effect.map(({ hosted }) => hosted))
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
  const packageRoot = join(adapterDirectory, "node_modules", ...adapter.packageName.split("/"))
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

export const makeCollectorTransportLayer = () => Layer.effect(
  CollectorTransport,
  Effect.gen(function*() {
    const client = yield* AuthenticatedHTTPClient
    return CollectorTransport.of({
    rawCaptureEnabled: project => client.request({
      instanceOrigin: project.instanceOrigin, expectedUserId: project.userId,
      path: `/api/v1/projects/${encodeURIComponent(project.id)}/raw-capture`, method: "GET"
    }).pipe(
      Effect.mapError(error => transportError("policy", error)),
      Effect.flatMap(response => response.status === 200
        ? Schema.decodeUnknownEffect(Schema.Struct({ teamPolicy: Schema.Literals(["force", "personal", "close"]),
            userPreference: Schema.Literals(["enable", "disable"]), enabled: Schema.Boolean }))(response.body).pipe(
              Effect.mapError(() => new CollectionTransportError({ reason: "invalid_response", operation: "policy", retryable: false,
                message: "ATape returned an invalid Raw capture policy." })),
              Effect.map(policy => policy.enabled))
        : Effect.fail(new CollectionTransportError({ reason: response.status === 401 ? "unauthenticated" : "rejected",
            operation: "policy", status: response.status, retryable: response.status === 429 || response.status >= 500,
            ...(response.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.retryAfterSeconds }),
            message: `ATape Raw capture policy returned ${response.status}; update the server if this endpoint is unavailable.` })))
    ),
    submitCanonical: (submission) => {
      const batch = canonicalBatch(submission)
      return postJSON(
        client,
        submission.instanceOrigin,
        "/api/v1/ingestion/canonical/batches",
        batch,
        "canonical",
        CanonicalApplyReceiptSchema
      )
    },
    appendRaw: (submission) => {
      const chunk = rawChunk(submission)
      return postJSON(
        client,
        submission.instanceOrigin,
        "/api/v1/ingestion/raw/chunks",
        chunk,
        "raw",
        RawAppendReceiptSchema
      )
    }
    })
  })
)

const canonicalBatch = (submission: CanonicalSubmission): CanonicalBatch => {
  const base = projectCanonicalSubmission(submission)
  return { ...base, batchId: `b_${digest(JSON.stringify(base))}` }
}

const rawChunk = (submission: RawSubmission): RawUploadChunk => {
  const content = Buffer.from(submission.content, "utf8")
  const sha256 = digest(content)
  const base = {
    protocolVersion: RawIngestionProtocolVersion,
    sourceObjectId: submission.sourceObjectId,
    sessionId: submission.serverSessionId,
    installationId: submission.installationId,
    generation: submission.serverGeneration,
    offset: submission.serverOffset,
    sourceName: submission.sourceName,
    mediaType: submission.mediaType,
    adapterId: submission.adapterId,
    adapterVersion: submission.adapterVersion,
    capturedAt: submission.observedAt,
    clientRedacted: true as const,
    final: submission.final,
    contentBase64: content.toString("base64"),
    sha256
  }
  return { ...base, sourceChunkId: submission.sourceChunkId }
}

const postJSON = <A, I>(
  client: AuthenticatedHTTPClient["Service"],
  instanceOrigin: string,
  path: `/${string}`,
  body: unknown,
  operation: "canonical" | "raw",
  schema: Schema.Codec<A, I>
): Effect.Effect<A, CollectionTransportError> => client.request({
  instanceOrigin,
  path,
  method: "POST",
  body
}).pipe(
  Effect.mapError((error) => transportError(operation, error)),
  Effect.flatMap((response) => response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(new CollectionTransportError({
      reason: operation === "raw" && response.status === 403 && typeof response.body === "object" && response.body !== null &&
        "code" in response.body && response.body.code === "raw_capture_disabled" ? "raw_disabled"
        : response.status === 401 ? "unauthenticated" : "rejected",
      operation,
      status: response.status,
      ...(response.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.retryAfterSeconds }),
      retryable: response.status !== 401 &&
        (response.status === 408 || response.status === 429 || response.status >= 500),
      message: response.status === 401
        ? `ATape ${operation} authentication failed; run \`atape login\` again.`
        : `ATape ${operation} endpoint returned ${response.status}.${problemIdentity(response.body)}`
    }))),
  Effect.flatMap((response) => Schema.decodeUnknownEffect(schema)(response.body)),
  Effect.mapError((error) => error instanceof CollectionTransportError
    ? error
    : new CollectionTransportError({
      reason: "invalid_response",
      operation,
      retryable: false,
      message: `ATape ${operation} endpoint returned an invalid receipt: ${String(error)}`
    }))
)

const problemIdentity = (body: unknown): string => {
  if (typeof body !== "object" || body === null) return ""
  const problem = body as Record<string, unknown>
  const code = typeof problem.code === "string" && /^[a-z_]{1,80}$/.test(problem.code) ? problem.code : undefined
  const requestId = typeof problem.requestId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(problem.requestId) ? problem.requestId : undefined
  return [code, requestId === undefined ? undefined : `request ${requestId}`].filter(Boolean).map(value => ` ${value}`).join("")
}

const transportError = (
  operation: "canonical" | "raw" | "policy",
  error: AuthenticatedHTTPError
) => new CollectionTransportError({
  reason: error.reason === "unauthenticated" || error.reason === "identity_changed"
    ? "unauthenticated"
    : error.reason === "network" ? "network" : "invalid_response",
  operation,
  ...(error.status === undefined ? {} : { status: error.status }),
  retryable: error.reason === "network",
  message: error.message
})

const checkpointKey = (checkpoint: CollectorCheckpoint) =>
  `${checkpoint.instanceOrigin}\0${checkpoint.userId}\0${checkpoint.projectId}\0${checkpoint.adapterId}`

const runtimeFailure = (
  adapterId: string,
  reason: AdapterRuntimeError["reason"],
  retryable: boolean,
  message: string
) => new AdapterRuntimeError({ reason, adapterId, retryable, message })

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code
const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
