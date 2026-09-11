import { Clock, Context, Effect, Layer, Schema } from "effect"
import { SourceCaptureLimits, SourceProjectionLimits, type AdapterInstallation, type AdapterSourceFailure, type LocalProject } from "@atape/domain"
import { AdapterRuntimeError, CollectorConfigurationError, CollectorStateError, CollectorStateStore, SecretRedactor,
  type AdapterCollectionReport, type CollectorStateSnapshot, type HostedAdapter } from "./collector.ts"
import { CaptureJournal, CaptureJournalError, CaptureJournals, type CaptureOwner, type CaptureSummary } from "./captureJournal.ts"
import { PublicationTransport, PublicationError, beginPublicationCapture, beginRawObservation, deliverPublicationCapture, deliverPublicationRaw, sourceComparisonContext } from "./publicationDelivery.ts"
import { RawPublicationTransport, RawPublicationError } from "./rawPublicationTransport.ts"
import { comparePublicationSource } from "./sourceComparison.ts"
import { preparePublicationCanonical, prepareRawObservation } from "./publicationPreparation.ts"
import { validateRawPreparationLimits } from "./rawPreparation.ts"

const count = (maximum: number, minimum = 1) => Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))
const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isPattern(/^[^\u0000]+$/))
const Protocol = "atape.source-collector.v1"
const Transform = "atape.host-redaction.v1"
export const SourceCollectionLimits = Schema.Struct({
  source: SourceCaptureLimits, projection: SourceProjectionLimits,
  journal: Schema.Struct({ unitBytes: count(16 * 1024 * 1024), targetBytes: count(Number.MAX_SAFE_INTEGER), pendingBytes: count(Number.MAX_SAFE_INTEGER),
    unitsPerTarget: count(1_000_000), recordsPerTarget: count(1_000_000), metadataEntries: count(1_000_000) }),
  raw: Schema.Struct({ objectBytes: count(3 * 1024 * 1024), wireBytes: count(5 * 1024 * 1024), targetBytes: count(Number.MAX_SAFE_INTEGER), units: count(1_000_000) }),
  comparison: Schema.Struct({ records: count(1_000_000), durationMs: count(300_000) }),
  recovery: Schema.Struct({ sources: count(100), captures: count(100), operations: count(64, 3), reclaimUnits: count(32), sourceMs: count(60000) }),
  sourceWorkMs: count(300000), cycleMs: count(600_000)
})
export type SourceCollectionLimits = typeof SourceCollectionLimits.Type
const Cursor = Schema.Struct({ protocol: Schema.Literal(Protocol), discovery: Schema.NullOr(identity), offset: count(100, 0),
  recoveryAfter: Schema.NullOr(identity), recoverySource: Schema.NullOr(Schema.Struct({ sourceId: identity, originKey: identity })),
  recoveryCapture: Schema.NullOr(identity) })
type Cursor = typeof Cursor.Type
const initialCursor = (): Cursor => ({ protocol: Protocol, discovery: null, offset: 0, recoveryAfter: null, recoverySource: null, recoveryCapture: null })
type SourceHost = Extract<HostedAdapter, { sourceCapture: unknown }>

/** Host-owned cycle: recover frozen obligations independently of discovery, then
 * attribute and compare fresh sources before creating another durable capture. */
export class SourceCaptureCollector extends Context.Service<SourceCaptureCollector, {
  collect(project: LocalProject, adapter: AdapterInstallation, host: SourceHost, snapshot: CollectorStateSnapshot):
    Effect.Effect<AdapterCollectionReport, AdapterRuntimeError | CollectorStateError>
}>()("atape/application/SourceCaptureCollector") {}

const configuredFailure = (message: string) => new CollectorConfigurationError({ reason: "limits", message })
const stateFailure = (message: string) => new CollectorStateError({ reason: "decode", message })
export const makeSourceCaptureCollectorLayer = (configuration: unknown) => Layer.effect(SourceCaptureCollector, Effect.gen(function*() {
  const limits = yield* Schema.decodeUnknownEffect(SourceCollectionLimits)(configuration).pipe(
    Effect.mapError(() => configuredFailure("Source collection requires explicit bounded source, projection, journal, Raw, comparison and recovery admission.")))
  yield* validateRawPreparationLimits(limits.raw).pipe(Effect.mapError(error => configuredFailure(error.message)))
  if (limits.source.pageBytes < limits.source.rowBytes || limits.journal.targetBytes < limits.journal.unitBytes ||
    limits.journal.pendingBytes < limits.journal.targetBytes || limits.journal.unitBytes < Math.max(4 * 1024 * 1024, limits.raw.wireBytes))
    return yield* configuredFailure("Source collection budgets cannot hold their admitted pages and delivery units.")
  if (limits.cycleMs < 3 * limits.recovery.sourceMs || limits.cycleMs < 2 * limits.sourceWorkMs)
    return yield* configuredFailure("The cycle deadline must leave room to advance beyond a timed-out source.")
  const journals = yield* CaptureJournals, states = yield* CollectorStateStore
  const publication = yield* PublicationTransport, raw = yield* RawPublicationTransport, redactor = yield* SecretRedactor
  return SourceCaptureCollector.of({ collect: (project, adapter, host, snapshot) => Effect.scoped(Effect.gen(function*() {
    const journal = yield* journals.open({ instanceOrigin: project.instanceOrigin, userId: project.userId }, limits.journal)
    if (snapshot.installationId !== journal.binding.installationId) return yield* stateFailure("Collector and capture journal installation identities differ.")
    let cursor = initialCursor(), revision = snapshot.checkpoint?.revision ?? 0
    let canonicalPublished = snapshot.checkpoint?.canonicalPublished === true
    if (snapshot.checkpoint !== undefined) {
      if (snapshot.checkpoint.projectCreatedAt !== project.createdAt || snapshot.checkpoint.rawObjects.length !== 0 || snapshot.checkpoint.cursor === null ||
        new TextEncoder().encode(snapshot.checkpoint.cursor).byteLength > 8192)
        return yield* stateFailure("Source collection cannot reuse a legacy or differently bound checkpoint.")
      cursor = yield* Effect.try({ try: () => JSON.parse(snapshot.checkpoint!.cursor!) as unknown,
        catch: () => stateFailure("Source collection checkpoint is not valid JSON.") }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Cursor)), Effect.mapError(() => stateFailure("Source collection requires its own versioned checkpoint; legacy history is not migrated.")))
      if (cursor.recoverySource === null && cursor.recoveryCapture !== null)
        return yield* stateFailure("Source recovery cursor lacks its owning source.")
    }
    const started = yield* Clock.currentTimeMillis
    let observations = 0, canonicalBatches = 0, canonicalEvents = 0, rawChunks = 0, rawBytes = 0, redactions = 0
    const failures = new Map<string, AdapterSourceFailure>()
    let truncated = false
    const diagnostic = (source: string, reason: AdapterSourceFailure["reason"]) => {
      if (failures.has(source)) return
      if (failures.size === 32) { truncated = true; return }
      failures.set(source, { source, reason })
    }
    const commit = () => Effect.gen(function*() {
      yield* states.commit({ instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id, adapterId: adapter.adapterId,
        expectedRevision: revision, checkpoint: { instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id,
          projectCreatedAt: project.createdAt, adapterId: adapter.adapterId, adapterVersion: adapter.version, revision: revision + 1,
          cursor: JSON.stringify(cursor), rawObjects: [], canonicalPublished, updatedAt: new Date(yield* Clock.currentTimeMillis).toISOString() } })
      revision++
    })
    const recover = (owner: CaptureOwner, capture: CaptureSummary) => Effect.gen(function*() {
      if (capture.purpose === "publication" && capture.activationReceipt === null) {
        const result = yield* deliverPublicationCapture(owner, capture.id, limits.recovery.operations)
        if (result.state === "pending") return
        if (result.state === "activated") {
          canonicalPublished = true
          canonicalBatches += capture.seal?.canonicalUnits ?? 0
          canonicalEvents += capture.seal?.records?.canonical?.event ?? 0
        }
      }
      // Reclaim confirmed Canonical before attempting independent Raw I/O,
      // including when a later request never returns before its deadline.
      yield* journal.reclaim(owner, capture.id, limits.recovery.reclaimUnits)
      const current = (yield* journal.inspect(owner, capture.id, { kind: "raw", pendingOnly: true, limit: limits.recovery.operations })).capture
      if (current.state !== "abandoned" && current.rawEnabled && (current.purpose === "raw-observation" || current.activationReceipt !== null)) {
        yield* sourceFailure(owner.scope.sourceSessionId, Effect.gen(function*() {
        const before = (yield* journal.inspect(owner, capture.id, { kind: "raw", pendingOnly: true, limit: limits.recovery.operations })).units
        yield* deliverPublicationRaw(owner, capture.id, limits.recovery.operations)
        for (const unit of before) {
          const after = (yield* journal.inspect(owner, capture.id, { kind: "raw", afterOrdinal: unit.ordinal - 1, limit: 1 })).units[0]
          if (after?.ordinal === unit.ordinal && after.disposition === "acknowledged") { rawChunks++; rawBytes += unit.byteCount }
        }
        }))
      }
      yield* journal.reclaim(owner, capture.id, limits.recovery.reclaimUnits)
    })
    const sourceFailure = <A, E extends { readonly _tag: string; readonly message: string; readonly reason?: string }, R>(source: string, work: Effect.Effect<A, E, R>, duration = limits.sourceWorkMs) => work.pipe(
      Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(new AdapterRuntimeError({ adapterId: adapter.adapterId,
        reason: "collect", retryable: true, message: "A source exceeded its work deadline; retained obligations will be retried." })) }),
      Effect.catch(error => {
        if (error._tag === "CaptureJournalError" || error._tag === "CollectorStateError" || error.reason === "unauthenticated") return Effect.fail(error)
        diagnostic(source, error.reason === "capacity" || error.reason === "limit" ? "limit" : error.reason === "binding" ? "attribution" :
          error.reason === "invalid" || error.reason === "contract" ? "format" : "io")
        return Effect.succeed(undefined)
      }))
    const retireSupersededRecords = (owner: CaptureOwner) => sourceFailure(owner.scope.sourceSessionId, Effect.gen(function*() {
      while ((yield* journal.pruneRecords(owner)) > 0) yield* Effect.yieldNow
      return true
    }), limits.recovery.sourceMs)
    const claim = (source: { readonly sourceId: string; readonly originKey: string }) => Effect.gen(function*() {
      const owner = yield* journal.claim({ projectId: project.id, adapterId: adapter.adapterId,
        sourceSessionId: source.sourceId, originKey: source.originKey })
      // Journal activation may precede the Collector JSON commit. Repair this
      // derived progress during the normal recovery walk, without source I/O.
      canonicalPublished ||= owner.checkpoint !== null
      return owner
    })
    const work = Effect.gen(function*() {
      // The indexed pending source walk remains available if the provider database
      // has disappeared. Its bounded cursor is independent of discovery progress.
      for (let n = 0; n < limits.recovery.sources; n++) {
        let source = cursor.recoverySource
        if (source === null) {
          const next = (yield* journal.sources(project.id, adapter.adapterId, {
            ...(cursor.recoveryAfter === null ? {} : { afterSessionId: cursor.recoveryAfter }), limit: 1 }))[0]
          if (next === undefined) { cursor = { ...cursor, recoveryAfter: null, recoveryCapture: null }; yield* commit(); break }
          source = { sourceId: next.sourceSessionId, originKey: next.originKey }
          cursor = { ...cursor, recoverySource: source, recoveryCapture: null }
        }
        const owner = yield* claim(source)
        const active = yield* journal.unactivated(owner)
        if (active !== null) yield* sourceFailure(source.sourceId, recover(owner, active), limits.recovery.sourceMs)
        const captures = yield* journal.pending(owner, cursor.recoveryCapture ?? undefined, limits.recovery.captures)
        for (const capture of captures) {
          yield* sourceFailure(source.sourceId, recover(owner, capture), limits.recovery.sourceMs)
          cursor = { ...cursor, recoveryCapture: capture.id }
          yield* commit()
        }
        yield* retireSupersededRecords(owner)
        if (captures.length === limits.recovery.captures) {
          cursor = { ...cursor, recoveryCapture: captures.at(-1)!.id }
          yield* commit(); break
        }
        cursor = { ...cursor, recoveryAfter: source.sourceId, recoverySource: null, recoveryCapture: null }
        yield* commit()
      }
      const page = yield* host.sourceCapture.discover({ cursor: cursor.discovery, limits: limits.source })
      for (const failure of page.sourceFailures) diagnostic(failure.source, failure.reason)
      truncated ||= page.sourceFailuresTruncated
      // Catalog mutation can shorten a repeated page. Restart this page's local
      // offset; comparison prevents duplicate publication on revisits.
      if (cursor.offset > page.sources.length) cursor = { ...cursor, offset: 0 }
      for (let index = cursor.offset; index < page.sources.length; index++) {
        const source = page.sources[index]!
        yield* sourceFailure(source.sourceId, Effect.gen(function*() {
          const attribution = yield* host.attribute(source)
          if (attribution === "unknown") { diagnostic(source.sourceId, "attribution"); return }
          if (attribution === "excluded") return
          let owner = yield* claim(source)
          const active = yield* journal.unactivated(owner)
          if (active !== null) {
            yield* sourceFailure(source.sourceId, recover(owner, active), limits.recovery.sourceMs)
            if ((yield* journal.unactivated(owner)) !== null) return
            owner = yield* claim(source)
          }
          // Clear superseded memberships before admitting another complete
          // observation. Deadline interruption postpones new work to a later cycle.
          if (!(yield* retireSupersededRecords(owner))) return
          const policy = yield* raw.policy(journal.binding, project.id)
          const baseline = yield* sourceComparisonContext(owner)
          const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
          const open = () => host.sourceCapture.open({ sourceId: source.sourceId, rawEnabled: policy.enabled, limits: limits.source, projection: limits.projection })
          const comparison = yield* comparePublicationSource(owner, { adapterVersion: adapter.version, observedAt, transformVersion: Transform,
            limits: limits.comparison, source: open(), ...(policy.enabled ? { raw: { authority: policy.authority, limits: limits.raw } } : {}) })
          if (comparison.canonical === "unchanged" && comparison.raw !== "required") return
          const id = yield* Effect.sync(() => globalThis.crypto.randomUUID())
          if (comparison.canonical === "changed") {
            const begun = yield* beginPublicationCapture(owner, { captureId: id, baseHead: baseline?.receipt.head ?? "", transformVersion: Transform,
              rawEnabled: policy.enabled, trackRecords: true, ...(policy.enabled ? { rawAuthority: policy.authority } : {}) })
            yield* preparePublicationCanonical(owner, id, { adapterVersion: adapter.version, observedAt, nextCheckpoint: begun.attemptId,
              source: open(), ...(policy.enabled ? { rawLimits: limits.raw } : {}) })
          } else {
            if (baseline === null) return yield* stateFailure("Raw observation lacks its actual Canonical baseline.")
            yield* beginRawObservation(owner, { observationId: id, canonicalCaptureId: baseline.capture.id })
            yield* prepareRawObservation(owner, id, { adapterVersion: adapter.version, observedAt, limits: limits.raw, source: open() })
          }
          observations++
          yield* recover(owner, (yield* journal.inspect(owner, id, { kind: "canonical", limit: 1 })).capture)
          yield* retireSupersededRecords(owner)
        }))
        cursor = { ...cursor, offset: index + 1 }
        yield* commit()
      }
      cursor = { ...cursor, discovery: page.done ? null : page.cursor, offset: 0 }
      yield* commit()
      // Every complete discovery sweep reaches the interval backoff. Independent
      // recovery/discovery cursors must not keep each other permanently runnable.
      return { projectId: project.id, adapterId: adapter.adapterId, pages: 1, observations, canonicalBatches, canonicalEvents, rawChunks, rawBytes,
        redactions, hasMore: !page.done, sourceFailures: [...failures.values()], sourceFailuresTruncated: truncated,
        durationMs: (yield* Clock.currentTimeMillis) - started } satisfies AdapterCollectionReport
    })
    return yield* work.pipe(Effect.provideService(CaptureJournal, journal), Effect.provideService(PublicationTransport, publication),
      Effect.provideService(RawPublicationTransport, raw), Effect.provideService(SecretRedactor, { redact: value => {
        const result = redactor.redact(value); redactions += result.replacements; return result
      } }))
  })).pipe(Effect.timeoutOrElse({ duration: limits.cycleMs, orElse: () => Effect.fail(new AdapterRuntimeError({ adapterId: adapter.adapterId,
    reason: "collect", retryable: true, message: "Source collection exceeded its cycle deadline; durable recovery remains pending." })) }), Effect.mapError(error => {
    if (error instanceof CollectorStateError || error instanceof AdapterRuntimeError) return error
    if (error instanceof CaptureJournalError) return new CollectorStateError({ reason: error.reason === "io" ? "io" : error.reason === "conflict" ? "conflict" : "decode", message: error.message })
    return new AdapterRuntimeError({ adapterId: adapter.adapterId, reason: error instanceof PublicationError || error instanceof RawPublicationError
      ? error.reason === "unauthenticated" ? "unauthenticated" : "transport" : "contract",
      retryable: error instanceof PublicationError || error instanceof RawPublicationError,
      message: error.message })
  })) })
}))
