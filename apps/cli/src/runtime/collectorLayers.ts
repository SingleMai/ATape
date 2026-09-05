import {
  AdapterRuntimeError,
  AdapterRuntimes,
  CollectionTransportError,
  CollectorStateError,
  CollectorStateStore,
  CollectorTransport,
  makeSecretRedactorLayer,
  type CanonicalSubmission,
  type CollectorStateSnapshot,
  type HostedAdapter,
  type RawSubmission
} from "@atape/application"
import {
  AdapterCollectionPage as AdapterCollectionPageSchema,
  AdapterManifest as AdapterManifestSchema,
  AdapterProtocolVersion,
  CanonicalApplyReceipt as CanonicalApplyReceiptSchema,
  CanonicalIngestionProtocolVersion,
  CanonicalProfileVersion,
  CollectorState as CollectorStateSchema,
  RawAppendReceipt as RawAppendReceiptSchema,
  RawIngestionProtocolVersion,
  emptyCollectorState,
  type AdapterCollectionPage,
  type AdapterManifest,
  type AcpContentBlock,
  type AcpSessionUpdate,
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
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Layer, Schema } from "effect"
import {
  AuthenticatedHTTPClient,
  AuthenticatedHTTPError
} from "./authenticatedHTTPClient.ts"

export type NodeCollectorPaths = {
  readonly collectorStateFile: string
  readonly adapterDirectory: string
}

export const makeNodeCollectorLayer = (
  paths: NodeCollectorPaths,
  environment: NodeJS.ProcessEnv = process.env
) => Layer.mergeAll(
  makeCollectorStateLayer(paths.collectorStateFile),
  makeAdapterRuntimeLayer(paths.adapterDirectory),
  makeCollectorTransportLayer(),
  makeSecretRedactorLayer(environmentSecretValues(environment))
)

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
): Effect.Effect<A, CollectorStateError> => Effect.acquireUseRelease(
  acquireStateLock(stateFile),
  () => readCollectorState(stateFile).pipe(
    Effect.flatMap((loaded) => Effect.try({
      try: () => ({ loaded, result: change(loaded.state) }),
      catch: (cause) => cause instanceof CollectorStateError
        ? cause
        : new CollectorStateError({
          reason: "io", message: errorMessage("Could not update the collector state", cause)
        })
    })),
    Effect.flatMap(({ loaded, result }) => result.state === undefined && !loaded.created
      ? Effect.succeed(result.value)
      : writeCollectorState(stateFile, result.state ?? loaded.state).pipe(Effect.as(result.value)))
  ),
  (lock) => Effect.promise(async () => {
    await lock.close().catch(() => undefined)
    await rm(lock.path, { force: true }).catch(() => undefined)
  })
)

const acquireStateLock = (stateFile: string) => Effect.tryPromise({
  try: async () => {
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
    const lockPath = `${stateFile}.lock`
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
        if (await staleLock(lockPath)) {
          await rm(lockPath, { force: true })
          continue
        }
        if (Date.now() >= deadline) throw cause
        await new Promise((done) => setTimeout(done, 50))
      }
    }
  },
  catch: (cause) => new CollectorStateError({
    reason: "io",
    message: hasCode(cause, "EEXIST")
      ? "Another ATape collector is updating local progress."
      : errorMessage("Could not lock the collector state", cause)
  })
})

const readCollectorState = (
  stateFile: string
): Effect.Effect<{ readonly state: CollectorState; readonly created: boolean }, CollectorStateError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return { value: JSON.parse(await readFile(stateFile, "utf8")) as unknown, created: false }
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) {
          return { value: emptyCollectorState(`i_${randomUUID()}`) as unknown, created: true }
        }
        throw cause
      }
    },
    catch: (cause) => new CollectorStateError({
      reason: "io", message: errorMessage("Could not read the collector state", cause)
    })
  }).pipe(
    Effect.flatMap(({ value, created }) => Schema.decodeUnknownEffect(CollectorStateSchema)(value).pipe(
      Effect.map((state) => ({ state, created }))
    )),
    Effect.mapError((error) => error instanceof CollectorStateError
      ? error
      : new CollectorStateError({
        reason: "decode", message: `The ATape collector state is invalid: ${String(error)}`
      }))
  )

const writeCollectorState = (stateFile: string, state: CollectorState): Effect.Effect<void, CollectorStateError> =>
  Schema.decodeUnknownEffect(CollectorStateSchema)(state).pipe(
    Effect.mapError((error) => new CollectorStateError({
      reason: "decode", message: `ATape refused to persist invalid collector state: ${String(error)}`
    })),
    Effect.flatMap((validated) => Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
        const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: "wx" })
          await rename(temporary, stateFile)
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
      },
      catch: (cause) => new CollectorStateError({
        reason: "io", message: errorMessage("Could not write the collector state", cause)
      })
    }))
  )

export const makeAdapterRuntimeLayer = (adapterDirectory: string) => Layer.succeed(
  AdapterRuntimes,
  AdapterRuntimes.of({
    open: (project, adapter) => Effect.acquireRelease(
      loadAdapterRuntime(adapterDirectory, project, adapter),
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
)

const loadAdapterRuntime = (
  adapterDirectory: string,
  project: Parameters<AdapterRuntimes["Service"]["open"]>[0],
  adapter: Parameters<AdapterRuntimes["Service"]["open"]>[1]
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
  const foreign = yield* Effect.tryPromise({
    try: (signal) => Promise.resolve(module.createAtapeAdapter?.({
      protocolVersion: AdapterProtocolVersion,
      adapter: { id: adapter.adapterId, version: adapter.version },
      project: { id: project.id, type: project.type, path: project.path },
      signal: AbortSignal.any([signal, lifetime.signal])
    })) as Promise<AtapeAdapterRuntime>,
    catch: (cause) => runtimeFailure(
      adapter.adapterId, "load", false, errorMessage(`Could not create Adapter ${adapter.adapterId}`, cause)
    )
  })
  if (!foreign || typeof foreign.collect !== "function") {
    return yield* runtimeFailure(
      adapter.adapterId, "contract", false, "createAtapeAdapter must return an object with collect(request)."
    )
  }
  const hosted: HostedAdapter = {
    collect: (request) => Effect.tryPromise({
      try: (signal) => Promise.resolve(foreign.collect({
        ...request,
        signal: AbortSignal.any([signal, lifetime.signal])
      })),
      catch: (cause) => runtimeFailure(
        adapter.adapterId, "collect", true, errorMessage(`Adapter ${adapter.adapterId} collection failed`, cause)
      )
    }).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(AdapterCollectionPageSchema)(value)),
      Effect.mapError((error) => error instanceof AdapterRuntimeError
        ? error
        : runtimeFailure(
          adapter.adapterId, "contract", false, `Adapter ${adapter.adapterId} returned an invalid page: ${String(error)}`
        ))
    )
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
  const source = {
    adapterId: submission.adapterId,
    adapterVersion: submission.adapterVersion,
    installationId: submission.installationId
  }
  const events = submission.observation.events.map((event) => {
    const projection = projectAcpUpdate(event.update, submission.observation.session.actor)
    return {
      sourceEventId: event.sourceEventId,
      sourceThreadId: event.sourceThreadId,
      revision: event.revision,
      projectionRevision: event.projectionRevision,
      sourceOrder: event.sourceOrder,
      eventIndex: event.eventIndex,
      orderFidelity: event.orderFidelity,
      fidelity: event.fidelity,
      rawRef: event.rawRef._tag === "object"
        ? {
            type: "object" as const,
            sourceObjectId: event.rawRef.sourceObjectId,
            ...(event.rawRef.fragment === undefined ? {} : { fragment: event.rawRef.fragment })
          }
        : { type: "unavailable" as const, reason: event.rawRef.reason },
      kind: event.childSourceThreadId === undefined ? projection.kind : "spawn" as const,
      author: projection.author,
      occurredAt: event.occurredAt,
      text: projection.text,
      ...(projection.toolLabel === undefined ? {} : { toolLabel: projection.toolLabel }),
      ...(event.childSourceThreadId === undefined ? {} : { childSourceThreadId: event.childSourceThreadId })
    }
  })
  const base = {
    protocolVersion: CanonicalIngestionProtocolVersion,
    canonicalProfileVersion: CanonicalProfileVersion,
    observedAt: submission.observation.observedAt,
    source,
    projectId: submission.projectId,
    session: submission.observation.session,
    threads: submission.observation.threads,
    events
  }
  return { ...base, batchId: `b_${digest(JSON.stringify(base))}` }
}

const projectAcpUpdate = (
  update: AcpSessionUpdate,
  actor: { readonly name: string; readonly harness: string }
): { readonly kind: "message" | "thought" | "tool_call" | "tool_result"; readonly author: string; readonly text: string; readonly toolLabel?: string } => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return { kind: "message", author: actor.name, text: projectAcpContent(update.content) }
    case "agent_message_chunk":
      return { kind: "message", author: actor.harness, text: projectAcpContent(update.content) }
    case "agent_thought_chunk":
      return { kind: "thought", author: actor.harness, text: projectAcpContent(update.content) }
    case "tool_call":
      return {
        kind: "tool_call",
        author: actor.harness,
        text: update.status ? `${update.title} · ${update.status}` : update.title,
        toolLabel: update.title
      }
    case "tool_call_update": {
      const label = update.title || update.toolCallId
      const status = update.status || "updated"
      return {
        kind: status === "completed" || status === "failed" ? "tool_result" : "tool_call",
        author: actor.harness,
        text: `${label} · ${status}`,
        toolLabel: label
      }
    }
  }
}

const projectAcpContent = (content: AcpContentBlock): string => {
  switch (content.type) {
    case "text":
      return content.text
    case "image":
      return `[Image: ${content.mimeType}]`
    case "audio":
      return `[Audio: ${content.mimeType}]`
    case "resource_link":
      return `${content.title || content.name} · ${content.uri}`
    case "resource":
      return "text" in content.resource ? content.resource.text : `[Resource: ${content.resource.uri}]`
  }
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
      reason: response.status === 401 ? "unauthenticated" : "rejected",
      operation,
      status: response.status,
      retryable: response.status !== 401 &&
        (response.status === 408 || response.status === 429 || response.status >= 500),
      message: response.status === 401
        ? `ATape ${operation} authentication failed; run \`atape login\` again.`
        : `ATape ${operation} endpoint returned ${response.status}.`
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

const transportError = (
  operation: "canonical" | "raw",
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

const staleLock = async (lockPath: string) => {
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
    // A newly-created lock may not contain its owner yet.
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > 30_000
  } catch (cause) {
    return hasCode(cause, "ENOENT")
  }
}

const runtimeFailure = (
  adapterId: string,
  reason: "load" | "contract" | "collect" | "close",
  retryable: boolean,
  message: string
) => new AdapterRuntimeError({ reason, adapterId, retryable, message })

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code
const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
