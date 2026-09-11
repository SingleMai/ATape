import type { AdapterCollectionProgress, AdapterInstallation, AdapterRawSegment,
  CollectorCheckpoint, CollectorRawObjectProgress, LocalProject } from "@atape/domain"
import { AdapterObservation, AdapterCollectionLimits, AdapterProtocolVersion, AdapterSourceFailure,
  MaxSourceFailures, RawTransportChunkBytes } from "@atape/domain"
import { Clock, Effect, Random, Semaphore } from "effect"
import { CollectorStateStore, CollectorTransport, CollectionContractError, CollectionTransportError,
  type CollectorStateSnapshot, type CollectorStateError, type CollectorTransportService,
  type HostedAdapter, type HostedCollectRequest, SecretRedactor } from "./collectorContracts.ts"
import { validatePage, prepareCollectedObservation, contractFailure } from "./collectorPreparation.ts"

/** Legacy capture owns its upload ordering, retry and checkpoint invariants. */
export const collectLegacyAdapter = (project: LocalProject, adapter: AdapterInstallation,
  runtime: Extract<HostedAdapter, { collect: unknown }>, snapshot: CollectorStateSnapshot) => Effect.gen(function*() {
  const states = yield* CollectorStateStore
  const transport = yield* CollectorTransport
  const redactor = yield* SecretRedactor
  let rawCaptureEnabled = yield* retryTransport(transport.rawCaptureEnabled(project))
  let checkpoint = snapshot.checkpoint?.projectCreatedAt === project.createdAt
    ? snapshot.checkpoint
    : undefined
  let canonicalPublished = checkpoint?.canonicalPublished === true
  let cursor = checkpoint?.cursor ?? null
  let expectedRevision = snapshot.checkpoint?.revision ?? 0
  let rawObjects = [...(checkpoint?.rawObjects ?? [])]
  const cycleStarted = yield* Clock.currentTimeMillis
  let progress: AdapterCollectionProgress | undefined
  let canonicalEvents = 0, rawBytes = 0
  let pages = 0
  let observations = 0
  let canonicalBatches = 0
  let rawChunks = 0
  let redactions = 0
  let hasMore = false
  const sourceFailures = new Map<string, AdapterSourceFailure>()
  let sourceFailuresTruncated = false

  const commitCheckpoint = (
    checkpointCursor: string | null,
    nextRawObjects: ReadonlyArray<CollectorRawObjectProgress>,
    adapterVersion: string
  ) => Effect.gen(function*() {
    const nextCheckpoint: CollectorCheckpoint = {
      instanceOrigin: project.instanceOrigin,
      userId: project.userId,
      projectId: project.id,
      projectCreatedAt: project.createdAt,
      adapterId: adapter.adapterId,
      adapterVersion,
      revision: expectedRevision + 1,
      cursor: checkpointCursor,
      rawObjects: nextRawObjects,
      ...(canonicalPublished ? { canonicalPublished: true } : {}),
      updatedAt: new Date(yield* Clock.currentTimeMillis).toISOString()
    }
    yield* states.commit({
      instanceOrigin: project.instanceOrigin,
      userId: project.userId,
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
      rawCaptureEnabled,
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
    progress = page.progress ? { ...page.progress, rawCaptureEnabled } : undefined
    pages++
    sourceFailuresTruncated ||= page.sourceFailuresTruncated === true
    for (const failure of page.sourceFailures ?? []) {
      const key = JSON.stringify(failure)
      if (sourceFailures.has(key)) continue
      if (sourceFailures.size === MaxSourceFailures) { sourceFailuresTruncated = true; continue }
      const masked = redactor.redact(failure.source)
      redactions += masked.replacements
      sourceFailures.set(key, { ...failure, source: masked.value.slice(0, 4096) })
    }

    for (const observation of page.observations) {
      const redacted = yield* prepareCollectedObservation(adapter.adapterId,
        rawCaptureEnabled ? observation : { ...observation, rawSegments: [] })
      redactions += redacted.replacements
      const canonical = yield* retryTransport(transport.submitCanonical({
        instanceOrigin: project.instanceOrigin,
        userId: project.userId,
        installationId: snapshot.installationId,
        projectId: project.id,
        adapterId: adapter.adapterId,
        adapterVersion: adapter.version,
        observation: {
          observedAt: redacted.observation.observedAt,
          session: redacted.observation.session,
          threads: redacted.observation.threads,
          events: redacted.observation.events,
          ...(redacted.observation.usage === undefined ? {} : { usage: redacted.observation.usage })
        }
      }))
      canonicalBatches++
      canonicalPublished = true
      canonicalEvents += redacted.observation.events.length
      const appended = yield* appendRawSegments({
        transport,
        instanceOrigin: project.instanceOrigin,
        userId: project.userId,
        installationId: snapshot.installationId,
        adapter,
        original: rawCaptureEnabled ? observation : { ...observation, rawSegments: [] },
        redacted: redacted.observation,
        serverSessionId: canonical.sessionId,
        rawObjects,
        persist: (nextRawObjects) => commitCheckpoint(
          cursor,
          nextRawObjects,
          checkpoint?.adapterVersion ?? adapter.version
        )
      }).pipe(Effect.catch(error => {
        if (!(error instanceof CollectionTransportError) || error.reason !== "raw_disabled") return Effect.fail(error)
        rawCaptureEnabled = false
        if (progress) progress = { ...progress, rawCaptureEnabled: false, pendingRawBytes: 0 }
        return Effect.succeed({ rawObjects: [...(checkpoint?.rawObjects ?? rawObjects)], chunks: 0, bytes: 0 })
      }))
      rawObjects = appended.rawObjects
      rawChunks += appended.chunks
      rawBytes += appended.bytes
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
    ...(progress === undefined ? {} : { progress }),
    canonicalEvents, rawBytes, durationMs: (yield* Clock.currentTimeMillis) - cycleStarted,
    projectId: project.id,
    adapterId: adapter.adapterId,
    pages,
    observations,
    canonicalBatches,
    rawChunks,
    redactions,
    hasMore,
    ...(sourceFailures.size > 0 ? { sourceFailures: [...sourceFailures.values()] } : {}),
    ...(sourceFailuresTruncated ? { sourceFailuresTruncated: true } : {})
  }
})

type RawSegmentsInput = {
  readonly transport: CollectorTransportService
  readonly instanceOrigin: string
  readonly userId: string
  readonly installationId: string
  readonly adapter: AdapterInstallation
  readonly original: AdapterObservation
  readonly redacted: AdapterObservation
  readonly serverSessionId: string
  readonly rawObjects: ReadonlyArray<CollectorRawObjectProgress>
  readonly persist: (
    rawObjects: ReadonlyArray<CollectorRawObjectProgress>
  ) => Effect.Effect<void, CollectorStateError>
}

const appendRawSegments = (input: RawSegmentsInput) => Effect.gen(function*() {
  if (input.original.rawSegments.length !== input.redacted.rawSegments.length) {
    return yield* new CollectionContractError({ adapterId: input.adapter.adapterId,
      message: "Redaction changed the Raw segment topology." })
  }
  const groups = new Map<string, number[]>()
  input.redacted.rawSegments.forEach((segment, index) => {
    const indices = groups.get(segment.sourceObjectId) ?? []
    indices.push(index)
    groups.set(segment.sourceObjectId, indices)
  })
  const lock = yield* Semaphore.make(1)
  let acknowledged = [...input.rawObjects]
  const results = yield* Effect.forEach([...groups], ([objectId, indices]) => appendRawObjectSegments({
    ...input,
    original: { ...input.original, rawSegments: indices.map(index => input.original.rawSegments[index]!) },
    redacted: { ...input.redacted, rawSegments: indices.map(index => input.redacted.rawSegments[index]!) },
    persist: progress => lock.withPermit(Effect.gen(function*() {
      const changed = progress.find(item => item.sourceSessionId === input.redacted.session.sourceSessionId && item.sourceObjectId === objectId)
      if (changed === undefined) return
      const next = acknowledged.filter(item => !(item.sourceSessionId === changed.sourceSessionId && item.sourceObjectId === objectId))
      next.push(changed)
      yield* input.persist(next)
      acknowledged = next
    }).pipe(Effect.uninterruptible))
  }), { concurrency: 3 })
  return { rawObjects: acknowledged, chunks: results.reduce((sum, result) => sum + result.chunks, 0),
    bytes: results.reduce((sum, result) => sum + result.bytes, 0) }
})

const appendRawObjectSegments = (input: RawSegmentsInput) => Effect.gen(function*() {
  let rawObjects = [...input.rawObjects]
  let chunks = 0, bytes = 0
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
        instanceOrigin: input.instanceOrigin,
        userId: input.userId,
        installationId: input.installationId,
        adapterId: input.adapter.adapterId,
        adapterVersion: input.adapter.version,
        serverSessionId: input.serverSessionId,
        observedAt: input.redacted.observedAt,
        sourceChunkId: `g${progress.serverGeneration}-o${serverOffset}`,
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
      bytes += utf8Bytes(content)
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
  return { rawObjects, chunks, bytes }
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

const retryTransport = <A>(
  effect: Effect.Effect<A, CollectionTransportError>,
  attempts = 3
): Effect.Effect<A, CollectionTransportError> => effect.pipe(Effect.matchEffect({
  onFailure: (error) => error.retryable && attempts > 1
    ? Effect.gen(function*() {
        const jitter = yield* Random.next
        const backoff = 500 * 2 ** (3 - attempts) * (1 + jitter)
        yield* Effect.sleep(Math.min(60_000, Math.max(backoff, (error.retryAfterSeconds ?? 0) * 1000)))
        return yield* retryTransport(effect, attempts - 1)
      })
    : Effect.fail(error),
  onSuccess: Effect.succeed
}))

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
