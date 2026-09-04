import type {
  AdapterCollectionPage,
  AdapterCollectionLimitValues,
  AdapterInstallation,
  AdapterObservation,
  AdapterRawSegment,
  AcpContentBlock,
  AcpSessionUpdate,
  CanonicalApplyReceipt,
  CollectorCheckpoint,
  CollectorRawObjectProgress,
  LocalProject,
  RawAppendReceipt
} from "@atape/domain"
import { AdapterCollectionLimits, AdapterProtocolVersion } from "@atape/domain"
import { RawTransportChunkBytes } from "@atape/domain"
import { Clock, Context, Effect, Layer, Schema, Scope } from "effect"
import { ClientConfigStore, inspectClient } from "./clientManagement.ts"

export class CollectorConfigurationError extends Schema.TaggedError<CollectorConfigurationError>()("CollectorConfigurationError", {
  reason: Schema.Literals(["identity", "project", "limits"]),
  message: Schema.String
}) {}

export class CollectorStateError extends Schema.TaggedError<CollectorStateError>()("CollectorStateError", {
  reason: Schema.Literals(["io", "decode", "conflict"]),
  message: Schema.String
}) {}

export class AdapterRuntimeError extends Schema.TaggedError<AdapterRuntimeError>()("AdapterRuntimeError", {
  reason: Schema.Literals(["load", "contract", "collect", "close"]),
  adapterId: Schema.String,
  retryable: Schema.Boolean,
  message: Schema.String
}) {}

export class CollectionContractError extends Schema.TaggedError<CollectionContractError>()("CollectionContractError", {
  adapterId: Schema.String,
  message: Schema.String
}) {}

export class CollectionTransportError extends Schema.TaggedError<CollectionTransportError>()("CollectionTransportError", {
  reason: Schema.Literals(["network", "rejected", "invalid_response"]),
  operation: Schema.Literals(["canonical", "raw"]),
  status: Schema.optionalKey(Schema.Number),
  retryable: Schema.Boolean,
  message: Schema.String
}) {}

export type CollectorStateSnapshot = {
  readonly installationId: string
  readonly checkpoint?: CollectorCheckpoint
}

export class CollectorStateStore extends Context.Service<CollectorStateStore, {
  snapshot(projectId: string, adapterId: string): Effect.Effect<CollectorStateSnapshot, CollectorStateError>
  commit(input: {
    readonly projectId: string
    readonly adapterId: string
    readonly expectedRevision: number
    readonly checkpoint: CollectorCheckpoint
  }): Effect.Effect<void, CollectorStateError>
}>()("atape/application/CollectorStateStore") {}

export type HostedCollectRequest = {
  readonly protocolVersion: typeof AdapterProtocolVersion
  readonly cursor: string | null
  readonly previousAdapterVersion?: string
  readonly limits: AdapterCollectionLimitValues
  readonly rawProgress: ReadonlyArray<{
    readonly sourceSessionId: string
    readonly sourceObjectId: string
    readonly sourceGeneration: string
    readonly sourceOffset: number
    readonly finalized: boolean
  }>
}

export type HostedAdapter = {
  readonly collect: (request: HostedCollectRequest) => Effect.Effect<AdapterCollectionPage, AdapterRuntimeError>
}

export class AdapterRuntimes extends Context.Service<AdapterRuntimes, {
  open(
    project: LocalProject,
    adapter: AdapterInstallation,
    userId: string
  ): Effect.Effect<HostedAdapter, AdapterRuntimeError, Scope.Scope>
}>()("atape/application/AdapterRuntimes") {}

export type CanonicalSubmission = {
  readonly serverUrl: string
  readonly userId: string
  readonly installationId: string
  readonly project: LocalProject
  readonly adapter: AdapterInstallation
  readonly observation: AdapterObservation
}

export type RawSubmission = {
  readonly serverUrl: string
  readonly userId: string
  readonly installationId: string
  readonly project: LocalProject
  readonly adapter: AdapterInstallation
  readonly sourceSessionId: string
  readonly serverSessionId: string
  readonly observationId: string
  readonly observedAt: string
  readonly adapterSegmentIndex: number
  readonly transportChunkIndex: number
  readonly sourceObjectId: string
  readonly sourceName: string
  readonly mediaType: string
  readonly content: string
  readonly final: boolean
  readonly serverGeneration: number
  readonly serverOffset: number
}

export type CollectorTransportService = {
  submitCanonical(submission: CanonicalSubmission): Effect.Effect<CanonicalApplyReceipt, CollectionTransportError>
  appendRaw(submission: RawSubmission): Effect.Effect<RawAppendReceipt, CollectionTransportError>
}

export class CollectorTransport extends Context.Service<CollectorTransport, CollectorTransportService>()(
  "atape/application/CollectorTransport"
) {}

export type RedactedText = {
  readonly value: string
  readonly replacements: number
}

export type SecretRedactorService = {
  redact(value: string): RedactedText
}

export class SecretRedactor extends Context.Service<SecretRedactor, SecretRedactorService>()(
  "atape/application/SecretRedactor"
) {}

export const makeSecretRedactorLayer = (secretValues: ReadonlyArray<string> = []) => {
  const values = [...new Set(secretValues.filter((value) => value.length >= 8 && value.length <= 4_096))]
    .sort((left, right) => right.length - left.length)
  return Layer.succeed(SecretRedactor, SecretRedactor.of({
    redact: (input) => redactText(input, values)
  }))
}

export type AdapterCollectionReport = {
  readonly projectId: string
  readonly adapterId: string
  readonly pages: number
  readonly observations: number
  readonly canonicalBatches: number
  readonly rawChunks: number
  readonly redactions: number
  readonly hasMore: boolean
}

export type AdapterCollectionFailure = {
  readonly projectId: string
  readonly adapterId: string
  readonly retryable: boolean
  readonly message: string
}

export type CollectionCycleReport = {
  readonly startedAt: string
  readonly completedAt: string
  readonly jobs: ReadonlyArray<AdapterCollectionReport>
  readonly failures: ReadonlyArray<AdapterCollectionFailure>
}

export type CollectionCycleOptions = {
  readonly projectId?: string
  readonly concurrency?: number
}

export type RunCollectorOptions = CollectionCycleOptions & {
  readonly once?: boolean
  readonly intervalMs?: number
}

type CollectionJobError = CollectorStateError | AdapterRuntimeError | CollectionContractError | CollectionTransportError

export const runCollectionCycle = Effect.fn("Collector.runCycle")(function*(options: CollectionCycleOptions = {}) {
  const input = yield* prepareCycle(options)
  return yield* collectPreparedCycle(input)
})

export const runCollector = Effect.fn("Collector.run")(function*(options: RunCollectorOptions = {}) {
  const intervalMs = options.intervalMs ?? 30_000
  if (!Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 3_600_000) {
    return yield* new CollectorConfigurationError({
      reason: "limits", message: "Collector interval must be between 10 seconds and 1 hour."
    })
  }
  while (true) {
    const report = yield* runCollectionCycle(options)
    if (options.once === true) return report
    yield* Effect.logInfo("ATape collection cycle completed", {
      jobs: report.jobs.length,
      failures: report.failures.length,
      observations: report.jobs.reduce((sum, job) => sum + job.observations, 0),
      rawChunks: report.jobs.reduce((sum, job) => sum + job.rawChunks, 0)
    })
    yield* Effect.sleep(intervalMs)
  }
})

type PreparedCycle = {
  readonly startedAt: string
  readonly serverUrl: string
  readonly userId: string
  readonly concurrency: number
  readonly jobs: ReadonlyArray<{ readonly project: LocalProject; readonly adapter: AdapterInstallation }>
}

const prepareCycle = (options: CollectionCycleOptions): Effect.Effect<
  PreparedCycle,
  CollectorConfigurationError | import("./clientManagement.ts").ClientConfigStoreError,
  ClientConfigStore
> => Effect.gen(function*() {
  const concurrency = options.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    return yield* new CollectorConfigurationError({
      reason: "limits", message: "Collector concurrency must be between 1 and 8."
    })
  }
  const config = yield* inspectClient()
  if (!config.userId) {
    return yield* new CollectorConfigurationError({
      reason: "identity",
      message: "This client has no Team user ID. Run `atape setup --user-id <id>` first."
    })
  }
  const projects = options.projectId === undefined
    ? config.projects
    : config.projects.filter((project) => project.id === options.projectId)
  if (options.projectId !== undefined && projects.length === 0) {
    return yield* new CollectorConfigurationError({
      reason: "project", message: `Project ${options.projectId} is not configured locally.`
    })
  }
  const jobs: Array<{ project: LocalProject; adapter: AdapterInstallation }> = []
  for (const project of projects) {
    for (const adapterId of project.adapterIds) {
      const adapter = config.adapters.find((item) => item.adapterId === adapterId)
      if (!adapter) {
        return yield* new CollectorConfigurationError({
          reason: "project", message: `Project ${project.id} references missing Adapter ${adapterId}.`
        })
      }
      jobs.push({ project, adapter })
    }
  }
  return {
    startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    serverUrl: config.serverUrl,
    userId: config.userId,
    concurrency,
    jobs
  }
})

const collectPreparedCycle = (input: PreparedCycle) => Effect.gen(function*() {
  const results = yield* Effect.forEach(input.jobs, ({ project, adapter }) =>
    collectAdapter(input.serverUrl, input.userId, project, adapter).pipe(
      Effect.match({
        onFailure: (error): AdapterCollectionFailure => ({
          projectId: project.id,
          adapterId: adapter.adapterId,
          retryable: isRetryable(error),
          message: error.message
        }),
        onSuccess: (report) => report
      })
    ), { concurrency: input.concurrency })
  const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  return {
    startedAt: input.startedAt,
    completedAt,
    jobs: results.filter((item): item is AdapterCollectionReport => "pages" in item),
    failures: results.filter((item): item is AdapterCollectionFailure => !("pages" in item))
  } satisfies CollectionCycleReport
})

const collectAdapter = (
  serverUrl: string,
  userId: string,
  project: LocalProject,
  adapter: AdapterInstallation
): Effect.Effect<
  AdapterCollectionReport,
  CollectionJobError,
  CollectorStateStore | AdapterRuntimes | CollectorTransport | SecretRedactor
> => Effect.scoped(Effect.gen(function*() {
  const states = yield* CollectorStateStore
  const runtimes = yield* AdapterRuntimes
  const transport = yield* CollectorTransport
  const redactor = yield* SecretRedactor
  const snapshot = yield* states.snapshot(project.id, adapter.adapterId)
  const runtime = yield* runtimes.open(project, adapter, userId)
  let checkpoint = snapshot.checkpoint?.projectCreatedAt === project.createdAt
    ? snapshot.checkpoint
    : undefined
  let cursor = checkpoint?.cursor ?? null
  let expectedRevision = snapshot.checkpoint?.revision ?? 0
  let rawObjects = [...(checkpoint?.rawObjects ?? [])]
  let pages = 0
  let observations = 0
  let canonicalBatches = 0
  let rawChunks = 0
  let redactions = 0
  let hasMore = false

  const commitCheckpoint = (
    checkpointCursor: string | null,
    nextRawObjects: ReadonlyArray<CollectorRawObjectProgress>,
    adapterVersion: string
  ) => Effect.gen(function*() {
    const nextCheckpoint: CollectorCheckpoint = {
      projectId: project.id,
      projectCreatedAt: project.createdAt,
      adapterId: adapter.adapterId,
      adapterVersion,
      revision: expectedRevision + 1,
      cursor: checkpointCursor,
      rawObjects: nextRawObjects,
      updatedAt: new Date(yield* Clock.currentTimeMillis).toISOString()
    }
    yield* states.commit({
      projectId: project.id,
      adapterId: adapter.adapterId,
      expectedRevision,
      checkpoint: nextCheckpoint
    })
    checkpoint = nextCheckpoint
    expectedRevision = nextCheckpoint.revision
  })

  while (pages < AdapterCollectionLimits.pagesPerCycle) {
    const request: HostedCollectRequest = {
      protocolVersion: AdapterProtocolVersion,
      cursor,
      limits: AdapterCollectionLimits,
      rawProgress: rawObjects.map((item) => ({
        sourceSessionId: item.sourceSessionId,
        sourceObjectId: item.sourceObjectId,
        sourceGeneration: item.sourceGeneration,
        sourceOffset: item.sourceOffset,
        finalized: item.finalized
      })),
      ...(checkpoint?.adapterVersion ? { previousAdapterVersion: checkpoint.adapterVersion } : {})
    }
    const page = yield* runtime.collect(request)
    yield* validatePage(adapter.adapterId, cursor, page)
    pages++

    for (const observation of page.observations) {
      const redacted = redactObservation(redactor, observation)
      redactions += redacted.replacements
      const canonical = yield* retryTransport(transport.submitCanonical({
        serverUrl,
        userId,
        installationId: snapshot.installationId,
        project,
        adapter,
        observation: redacted.observation
      }))
      canonicalBatches++
      const appended = yield* appendRawSegments({
        transport,
        serverUrl,
        userId,
        installationId: snapshot.installationId,
        project,
        adapter,
        original: observation,
        redacted: redacted.observation,
        serverSessionId: canonical.sessionId,
        rawObjects,
        persist: (nextRawObjects) => commitCheckpoint(
          cursor,
          nextRawObjects,
          checkpoint?.adapterVersion ?? adapter.version
        )
      })
      rawObjects = appended.rawObjects
      rawChunks += appended.chunks
      observations++
    }

    const needsCommit = page.observations.length > 0 || page.nextCursor !== cursor ||
      checkpoint?.adapterVersion !== adapter.version
    if (needsCommit) {
      yield* commitCheckpoint(page.nextCursor, rawObjects, adapter.version)
    }
    cursor = page.nextCursor
    hasMore = page.hasMore
    if (!page.hasMore) break
  }

  return {
    projectId: project.id,
    adapterId: adapter.adapterId,
    pages,
    observations,
    canonicalBatches,
    rawChunks,
    redactions,
    hasMore
  }
}))

const appendRawSegments = (input: {
  readonly transport: CollectorTransportService
  readonly serverUrl: string
  readonly userId: string
  readonly installationId: string
  readonly project: LocalProject
  readonly adapter: AdapterInstallation
  readonly original: AdapterObservation
  readonly redacted: AdapterObservation
  readonly serverSessionId: string
  readonly rawObjects: ReadonlyArray<CollectorRawObjectProgress>
  readonly persist: (
    rawObjects: ReadonlyArray<CollectorRawObjectProgress>
  ) => Effect.Effect<void, CollectorStateError>
}) => Effect.gen(function*() {
  let rawObjects = [...input.rawObjects]
  let chunks = 0
  for (let index = 0; index < input.redacted.rawSegments.length; index++) {
    const segment = input.redacted.rawSegments[index]
    const original = input.original.rawSegments[index]
    if (!segment || !original) {
      return yield* new CollectionContractError({
        adapterId: input.adapter.adapterId, message: "Redaction changed the Raw segment topology."
      })
    }
    const existingIndex = rawObjects.findIndex((item) =>
      item.sourceSessionId === input.redacted.session.sourceSessionId &&
      item.sourceObjectId === segment.sourceObjectId)
    const existing = existingIndex < 0 ? undefined : rawObjects[existingIndex]
    const sourceEnd = segment.sourceOffset + utf8Bytes(original.content)
    if (existing?.sourceGeneration === segment.sourceGeneration &&
      (segment.sourceOffset < existing.sourceOffset ||
        (existing.finalized && sourceEnd === existing.sourceOffset))) {
      if (existing.sourceName !== segment.sourceName || existing.mediaType !== segment.mediaType ||
        sourceEnd > existing.sourceOffset) {
        return yield* new CollectionContractError({
          adapterId: input.adapter.adapterId,
          message: `Raw segment ${segment.sourceObjectId} overlaps previously committed source bytes.`
        })
      }
      continue
    }
    const progress = yield* nextRawProgress(
      input.adapter.adapterId,
      input.redacted.session.sourceSessionId,
      segment,
      existing
    )
    const transportChunks = splitRawTransportChunks(segment.content)
    let serverOffset = progress.serverOffset
    for (let chunkIndex = 0; chunkIndex < transportChunks.length; chunkIndex++) {
      const content = transportChunks[chunkIndex] ?? ""
      const final = segment.final && chunkIndex === transportChunks.length - 1
      const receipt = yield* retryTransport(input.transport.appendRaw({
        serverUrl: input.serverUrl,
        userId: input.userId,
        installationId: input.installationId,
        project: input.project,
        adapter: input.adapter,
        sourceSessionId: input.redacted.session.sourceSessionId,
        serverSessionId: input.serverSessionId,
        observationId: input.redacted.observationId,
        observedAt: input.redacted.observedAt,
        adapterSegmentIndex: index,
        transportChunkIndex: chunkIndex,
        sourceObjectId: segment.sourceObjectId,
        sourceName: segment.sourceName,
        mediaType: segment.mediaType,
        content,
        final,
        serverGeneration: progress.serverGeneration,
        serverOffset
      }))
      chunks++
      const expectedServerOffset = serverOffset + utf8Bytes(content)
      const validReceipt = receipt.generation === progress.serverGeneration &&
        (receipt.replayed
          ? receipt.sizeBytes >= expectedServerOffset && (!final || receipt.finalized)
          : receipt.sizeBytes === expectedServerOffset && receipt.finalized === final)
      if (!validReceipt) {
        return yield* new CollectionContractError({
          adapterId: input.adapter.adapterId,
          message: `Raw receipt for ${segment.sourceObjectId} does not match the submitted append position.`
        })
      }
      serverOffset = expectedServerOffset
    }
    const next: CollectorRawObjectProgress = {
      sourceSessionId: input.redacted.session.sourceSessionId,
      sourceObjectId: segment.sourceObjectId,
      sourceName: segment.sourceName,
      mediaType: segment.mediaType,
      sourceGeneration: segment.sourceGeneration,
      sourceOffset: sourceEnd,
      serverGeneration: progress.serverGeneration,
      serverOffset,
      finalized: segment.final
    }
    rawObjects = existingIndex < 0
      ? [...rawObjects, next]
      : rawObjects.map((item, itemIndex) => itemIndex === existingIndex ? next : item)
    yield* input.persist(rawObjects)
  }
  return { rawObjects, chunks }
})

const splitRawTransportChunks = (content: string): ReadonlyArray<string> => {
  const encoded = new TextEncoder().encode(content)
  if (encoded.byteLength === 0) return [""]
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const chunks: Array<string> = []
  let start = 0
  while (start < encoded.byteLength) {
    let end = Math.min(start + RawTransportChunkBytes, encoded.byteLength)
    while (end < encoded.byteLength && end > start && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--
    chunks.push(decoder.decode(encoded.subarray(start, end)))
    start = end
  }
  return chunks
}

const nextRawProgress = (
  adapterId: string,
  sourceSessionId: string,
  segment: AdapterRawSegment,
  existing: CollectorRawObjectProgress | undefined
): Effect.Effect<{ readonly serverGeneration: number; readonly serverOffset: number }, CollectionContractError> => {
  if (!existing) {
    return segment.sourceOffset === 0
      ? Effect.succeed({ serverGeneration: 1, serverOffset: 0 })
      : contractFailure(adapterId, `${segment.sourceObjectId} starts at source offset ${segment.sourceOffset}; expected 0.`)
  }
  if (existing.sourceName !== segment.sourceName || existing.mediaType !== segment.mediaType ||
    existing.sourceSessionId !== sourceSessionId) {
    return contractFailure(adapterId, `${segment.sourceObjectId} changed immutable Raw object metadata.`)
  }
  if (existing.sourceGeneration !== segment.sourceGeneration) {
    return segment.sourceOffset === 0
      ? Effect.succeed({ serverGeneration: existing.serverGeneration + 1, serverOffset: 0 })
      : contractFailure(adapterId, `${segment.sourceObjectId} changed generation without restarting at source offset 0.`)
  }
  if (existing.finalized) {
    return contractFailure(adapterId, `${segment.sourceObjectId} appended after its generation was finalized.`)
  }
  return existing.sourceOffset === segment.sourceOffset
    ? Effect.succeed({ serverGeneration: existing.serverGeneration, serverOffset: existing.serverOffset })
    : contractFailure(
      adapterId,
      `${segment.sourceObjectId} reported source offset ${segment.sourceOffset}; expected ${existing.sourceOffset}.`
    )
}

const validatePage = (
  adapterId: string,
  requestCursor: string | null,
  page: AdapterCollectionPage
): Effect.Effect<void, CollectionContractError> => {
  const fail = (message: string) => contractFailure(adapterId, message)
  if (page.observations.length > AdapterCollectionLimits.observations) {
    return fail(`returned ${page.observations.length} observations; limit is ${AdapterCollectionLimits.observations}.`)
  }
  if (page.nextCursor !== null && (page.nextCursor.length === 0 || page.nextCursor.length > 16_384)) {
    return fail("returned an invalid next cursor.")
  }
  if (page.hasMore && (page.observations.length === 0 || page.nextCursor === null || page.nextCursor === requestCursor)) {
    return fail("must advance a non-empty cursor when hasMore is true.")
  }
  if (page.observations.length > 0 && (page.nextCursor === null || page.nextCursor === requestCursor)) {
    return fail("must advance to a new committed cursor after emitting observations.")
  }
  const observations = new Set<string>()
  for (const observation of page.observations) {
    if (!boundedIdentity(observation.observationId, 200) || observations.has(observation.observationId)) {
      return fail(`returned an invalid or duplicate observation ID ${JSON.stringify(observation.observationId)}.`)
    }
    observations.add(observation.observationId)
    if (!validTimestamp(observation.observedAt) || !validTimestamp(observation.session.updatedAt)) {
      return fail(`observation ${observation.observationId} contains an invalid timestamp.`)
    }
    if (!boundedIdentity(observation.session.sourceSessionId, 500) ||
      !positiveInteger(observation.session.revision) ||
      !nonNegativeInteger(observation.session.reportedEventCount) ||
      !boundedText(observation.session.actor.name, 200, false) ||
      !boundedText(observation.session.actor.harness, 200, false) ||
      !boundedText(observation.session.title, 2_000, true) ||
      !boundedText(observation.session.summary, 2_000, true) ||
      !boundedText(observation.session.insight, 2_000, true) ||
      !boundedText(observation.session.branch, 2_000, true)) {
      return fail(`observation ${observation.observationId} contains invalid Session counters.`)
    }
    if (utf8Bytes(JSON.stringify({
      session: observation.session,
      threads: observation.threads,
      events: observation.events
    })) > AdapterCollectionLimits.canonicalBytesPerObservation) {
      return fail(`observation ${observation.observationId} exceeds the Canonical byte limit.`)
    }
    if (observation.threads.length < 1 || observation.threads.length > AdapterCollectionLimits.threadsPerObservation) {
      return fail(`observation ${observation.observationId} has an invalid Thread count.`)
    }
    if (observation.events.length > AdapterCollectionLimits.eventsPerObservation ||
      observation.rawSegments.length > AdapterCollectionLimits.rawSegmentsPerObservation) {
      return fail(`observation ${observation.observationId} exceeds Event or Raw segment limits.`)
    }
    if (observation.rawSegments.reduce((bytes, segment) => bytes + utf8Bytes(segment.content), 0) >
      AdapterCollectionLimits.rawBytesPerObservation) {
      return fail(`observation ${observation.observationId} exceeds the aggregate Raw byte limit.`)
    }
    const threadIds = new Set(observation.threads.map((thread) => thread.sourceThreadId))
    const roots = observation.threads.filter((thread) => thread.parentSourceThreadId === undefined)
    if (threadIds.size !== observation.threads.length || roots.length !== 1 ||
      observation.threads.some((thread) => !boundedIdentity(thread.sourceThreadId, 500) ||
        !positiveInteger(thread.revision) || !boundedText(thread.label, 200, true) ||
        !boundedText(thread.summary, 2_000, true) ||
        (thread.parentSourceThreadId !== undefined &&
          (thread.parentSourceThreadId === thread.sourceThreadId || !threadIds.has(thread.parentSourceThreadId)))) ||
      hasThreadCycle(observation.threads)) {
      return fail(`observation ${observation.observationId} has an invalid Thread topology.`)
    }
    const eventIds = new Set<string>()
    for (const event of observation.events) {
      const eventKey = `${event.sourceThreadId}\0${event.sourceEventId}`
      if (!boundedIdentity(event.sourceEventId, 500) || eventIds.has(eventKey) ||
        !threadIds.has(event.sourceThreadId) || !positiveInteger(event.revision) ||
        !positiveInteger(event.projectionRevision) || !nonNegativeInteger(event.sourceOrder) ||
        !nonNegativeInteger(event.eventIndex) || !validTimestamp(event.occurredAt) ||
        !validAcpUpdate(event.update) ||
        (event.childSourceThreadId !== undefined && !threadIds.has(event.childSourceThreadId)) ||
        (event.rawRef._tag === "object"
          ? !boundedIdentity(event.rawRef.sourceObjectId, 200) ||
            (event.rawRef.fragment !== undefined && !boundedText(event.rawRef.fragment, 1_500, true))
          : !boundedText(event.rawRef.reason, 1_000, false))) {
        return fail(`observation ${observation.observationId} contains an invalid Event.`)
      }
      eventIds.add(eventKey)
    }
    for (const segment of observation.rawSegments) {
      if (!boundedIdentity(segment.sourceObjectId, 200) || !boundedIdentity(segment.sourceGeneration, 200) ||
        !nonNegativeInteger(segment.sourceOffset) || utf8Bytes(segment.content) > AdapterCollectionLimits.rawSegmentBytes ||
        (segment.content.length === 0 && !segment.final) || !boundedText(segment.sourceName, 512, false) ||
        (!segment.final && !segment.content.endsWith("\n")) ||
        !boundedText(segment.mediaType, 512, false) || !supportedRawMediaType(segment.mediaType)) {
        return fail(`observation ${observation.observationId} contains an invalid Raw segment.`)
      }
    }
  }
  return Effect.void
}

const redactObservation = (redactor: SecretRedactorService, observation: AdapterObservation) => {
  let replacements = 0
  const redact = (value: string) => {
    const result = redactor.redact(value)
    replacements += result.replacements
    return result.value
  }
  const events = observation.events.map((event) => {
    const before = replacements
    const update = redactAcpUpdate(event.update, redact)
    const rawRef = event.rawRef._tag === "object"
      ? {
          ...event.rawRef,
          ...(event.rawRef.fragment === undefined ? {} : { fragment: redact(event.rawRef.fragment) })
        }
      : { ...event.rawRef, reason: redact(event.rawRef.reason) }
    return {
      ...event,
      update,
      rawRef,
      fidelity: replacements > before ? "redacted" as const : event.fidelity
    }
  })
  const redacted: AdapterObservation = {
    ...observation,
    session: {
      ...observation.session,
      title: redact(observation.session.title),
      summary: redact(observation.session.summary),
      insight: redact(observation.session.insight),
      actor: {
        name: redact(observation.session.actor.name),
        harness: redact(observation.session.actor.harness)
      },
      branch: redact(observation.session.branch)
    },
    threads: observation.threads.map((thread) => ({
      ...thread,
      label: redact(thread.label),
      summary: redact(thread.summary)
    })),
    events,
    rawSegments: observation.rawSegments.map((segment) => ({
      ...segment,
      sourceName: redact(segment.sourceName),
      content: redact(segment.content)
    }))
  }
  return { observation: redacted, replacements }
}

const redactText = (input: string, secretValues: ReadonlyArray<string>): RedactedText => {
  let value = input
  let replacements = 0
  const replace = (pattern: RegExp, replacement: string | ((...values: Array<string>) => string)) => {
    value = value.replace(pattern, (...args: Array<string>) => {
      replacements++
      return typeof replacement === "string" ? replacement : replacement(...args)
    })
  }
  replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_match, label: string) => `${label} [REDACTED]`)
  replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]")
  replace(
    /(["']?)(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\b)\1(\s*[:=]\s*)(["']?)[^\s,"'}]{8,}\4/gi,
    (_match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
      `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`
  )
  replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
  for (const secret of secretValues) {
    replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]")
  }
  return { value, replacements }
}

const retryTransport = <A>(
  effect: Effect.Effect<A, CollectionTransportError>,
  attempts = 3
): Effect.Effect<A, CollectionTransportError> => effect.pipe(Effect.matchEffect({
  onFailure: (error) => error.retryable && attempts > 1
    ? Effect.sleep((4 - attempts) * 100).pipe(Effect.flatMap(() => retryTransport(effect, attempts - 1)))
    : Effect.fail(error),
  onSuccess: Effect.succeed
}))

const contractFailure = (adapterId: string, message: string) =>
  Effect.fail(new CollectionContractError({ adapterId, message: `Adapter ${adapterId} ${message}` }))

const isRetryable = (error: CollectionJobError) =>
  error instanceof CollectionTransportError ? error.retryable
    : error instanceof AdapterRuntimeError ? error.retryable
      : error instanceof CollectorStateError ? error.reason === "io" || error.reason === "conflict"
        : false

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value >= 1
const nonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0
const validTimestamp = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  !Number.isNaN(Date.parse(value))
const boundedIdentity = (value: string, max: number) => value.trim() !== "" && utf8Bytes(value) <= max
const boundedText = (value: string, max: number, empty: boolean) =>
  (empty || value.trim() !== "") && utf8Bytes(value) <= max
const supportedRawMediaType = (value: string) => /^(?:text\/|application\/(?:json|x-ndjson|[A-Za-z0-9.+-]+\+json)$)/i.test(value)
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const hasThreadCycle = (threads: AdapterObservation["threads"]) => {
  const parents = new Map(threads.map((thread) => [thread.sourceThreadId, thread.parentSourceThreadId]))
  for (const id of parents.keys()) {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current !== undefined) {
      if (seen.has(current)) return true
      seen.add(current)
      current = parents.get(current)
    }
  }
  return false
}

const validAcpUpdate = (update: AcpSessionUpdate) => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return (update.messageId === undefined || update.messageId === null || boundedIdentity(update.messageId, 500)) &&
        validAcpContentBlock(update.content)
    case "tool_call":
      return boundedIdentity(update.toolCallId, 500) && boundedText(update.title, 500, false)
    case "tool_call_update":
      return boundedIdentity(update.toolCallId, 500) &&
        (update.title === undefined || update.title === null || boundedText(update.title, 500, true))
  }
}

const validAcpContentBlock = (content: AcpContentBlock) => {
  switch (content.type) {
    case "text":
      return boundedText(content.text, 1 << 20, false)
    case "image":
      return boundedText(content.mimeType, 200, false) &&
        (content.uri === undefined || content.uri === null || boundedText(content.uri, 2_000, false))
    case "audio":
      return boundedText(content.mimeType, 200, false)
    case "resource_link":
      return boundedText(content.name, 500, false) && boundedText(content.uri, 2_000, false)
    case "resource":
      return boundedText(content.resource.uri, 2_000, false) &&
        ("text" in content.resource ? boundedText(content.resource.text, 1 << 20, true) : true)
  }
}

const redactAcpUpdate = (
  update: AcpSessionUpdate,
  redact: (value: string) => string
): AcpSessionUpdate => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return { ...update, content: redactAcpContentBlock(update.content, redact) }
    case "tool_call":
      return { ...update, title: redact(update.title) }
    case "tool_call_update":
      return {
        ...update,
        ...(typeof update.title === "string" ? { title: redact(update.title) } : {})
      }
  }
}

const redactAcpContentBlock = (
  content: AcpContentBlock,
  redact: (value: string) => string
): AcpContentBlock => {
  switch (content.type) {
    case "text":
      return { ...content, text: redact(content.text) }
    case "image":
      return {
        ...content,
        ...(typeof content.uri === "string" ? { uri: redact(content.uri) } : {})
      }
    case "audio":
      return content
    case "resource_link":
      return {
        ...content,
        name: redact(content.name),
        uri: redact(content.uri),
        ...(typeof content.title === "string" ? { title: redact(content.title) } : {}),
        ...(typeof content.description === "string" ? { description: redact(content.description) } : {})
      }
    case "resource":
      return {
        ...content,
        resource: "text" in content.resource
          ? { ...content.resource, uri: redact(content.resource.uri), text: redact(content.resource.text) }
          : { ...content.resource, uri: redact(content.resource.uri) }
      }
  }
}
