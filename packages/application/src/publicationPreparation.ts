import { Effect, Scope } from "effect"
import { PublicationTargetProfile, type AdapterEvent, type AdapterThread, type AdapterUsage, type AdapterRawReference } from "@atape/domain"
import { CaptureJournal, type CaptureOwner, type CaptureRecordKey } from "./captureJournal.ts"
import { canonicalMaterializationBound, projectCanonicalSubmission } from "./canonicalProjection.ts"
import { publicationPreparationContext, rawObservationPreparationContext, sealPublicationCapture, sealRawObservation } from "./publicationDelivery.ts"
import { createRawPreparation, validateRawPreparationLimits, type RawPreparationLimits } from "./rawPreparation.ts"
export type { RawPreparationLimits } from "./rawPreparation.ts"

import { canonicalSourceProjection, validateCanonicalSourceMetadata, PublicationPreparationError, PublicationPreparationVersion, sourceFingerprint as hash, encodeSource as encode,
  type PublicationDraftView } from "./canonicalSourceProjection.ts"
export { PublicationPreparationError, PublicationPreparationVersion, type PublicationDraftFrame, type PublicationDraftView } from "./canonicalSourceProjection.ts"
const fail = (reason: PublicationPreparationError["reason"], message: string) => new PublicationPreparationError({ reason, message })

/** Prepare a complete Canonical replacement under the persisted capture policy.
 * The lazy external source Effect stays in this operation's scope. Only final
 * validated/masked/encoded bytes enter the journal; sealing occurs after close.
 * Raw-enabled captures additionally require independent explicit Raw admission.
 */
export const preparePublicationCanonical = <E, R>(owner: CaptureOwner, captureId: string, input: {
  readonly adapterVersion: string
  readonly observedAt: string
  readonly nextCheckpoint: string
  readonly rawLimits?: RawPreparationLimits
  readonly source: Effect.Effect<PublicationDraftView<E, R>, E, R | Scope.Scope>
}) => Effect.gen(function*() {
  const journal = yield* CaptureJournal
  yield* validateCanonicalSourceMetadata(owner, input.adapterVersion)
  const context = yield* publicationPreparationContext(owner, captureId)
  if (context.rawEnabled && input.rawLimits === undefined) return yield* fail("unsupported", "Raw-enabled preparation requires explicit Raw admission.")
  if (!context.rawEnabled && input.rawLimits !== undefined) return yield* fail("invalid", "Raw-off preparation cannot request archive admission.")
  if (input.rawLimits !== undefined) yield* validateRawPreparationLimits(input.rawLimits)
  const limits = context.intent.capabilities.limits
  const prepared = yield* Effect.scoped(Effect.gen(function*() {
    const view = yield* input.source
    const projection = yield* canonicalSourceProjection(owner, view, { ...input, captureId, transformVersion: context.intent.begin.transformVersion })
    const { profile, placeholder, masked } = projection
    const version = (kind: CaptureRecordKey["kind"], key: string, fingerprint: string, rawReference: AdapterRawReference = placeholder) => Effect.gen(function*() {
      return yield* journal.record(owner, captureId, { kind, key, fingerprint, projectionVersion: profile,
        ...(kind === "event" ? { rawReference } : {}) })
    })
    const sessionVersion = yield* version("session", masked.session.sourceSessionId, yield* hash({ ...masked.session, revision: undefined }))
    const raw = context.rawEnabled ? yield* createRawPreparation(owner, captureId, {
      profile, sessionId: context.intent.sessionId, head: context.intent.begin.reservationId, authority: context.intent.rawAuthority!,
      adapterVersion: input.adapterVersion, observedAt: input.observedAt, limits: input.rawLimits!
    }) : undefined
    const session = { ...masked.session, revision: sessionVersion.revision }
    const batchKey = yield* hash([PublicationPreparationVersion, captureId])
    const threads: AdapterThread[] = []
    for (const thread of masked.threads) {
      const allocated = yield* version("thread", thread.sourceThreadId, yield* hash({ ...thread, revision: undefined }))
      threads.push({ ...thread, revision: allocated.revision })
    }
    let events: AdapterEvent[] = [], usage: AdapterUsage[] = [], bindings: CaptureRecordKey[] = []
    let ordinal = 0, totalBytes = 0, materializedBytes = 0
    const project = (projectedEvents: ReadonlyArray<AdapterEvent>, projectedUsage: ReadonlyArray<AdapterUsage>) =>
      projectCanonicalSubmission({ instanceOrigin: journal.binding.instanceOrigin, installationId: journal.binding.installationId,
        adapterId: owner.scope.adapterId, adapterVersion: input.adapterVersion, projectId: owner.scope.projectId,
        observation: { observedAt: input.observedAt, session, threads, events: projectedEvents, usage: projectedUsage } })
    const wire = () => {
      const batch = project(events, usage)
      return { target: { profile: PublicationTargetProfile, events: view.target.events, threads: view.target.threads, usage: view.target.usage }, batch: { ...batch, batchId: `p_${batchKey}_${ordinal}` } }
    }
    const flush = () => Effect.gen(function*() {
      const value = wire(), bytes = encode(value), bound = canonicalMaterializationBound(value.batch, journal.binding.userId)
      if (bytes.byteLength > limits.partBytes || bound > limits.partBytes || ordinal >= limits.parts ||
        bytes.byteLength > limits.targetBytes - totalBytes || bound > limits.targetBytes - materializedBytes)
        return yield* fail("capacity", "Canonical target exceeds negotiated publication capacity.")
      yield* journal.append(owner, captureId, { kind: "canonical", ordinal, bytes })
      if (ordinal === 0) for (const record of [{ kind: "session" as const, key: session.sourceSessionId }, ...threads.map(thread => ({ kind: "thread" as const, key: thread.sourceThreadId }))])
        yield* journal.bindRecord(owner, captureId, record, { _tag: "Unit", ordinal })
      for (const record of bindings) yield* journal.bindRecord(owner, captureId, record, { _tag: "Unit", ordinal })
      totalBytes += bytes.byteLength; materializedBytes += bound; ordinal++; events = []; usage = []; bindings = []
    })
    const partFull = () => { const value = wire(); return encode(value).byteLength > limits.partBytes || canonicalMaterializationBound(value.batch, journal.binding.userId) > limits.partBytes }
    for (;;) {
      const page = yield* view.read()
      yield* projection.page(page)
      for (const frame of page.frames) {
        if (!raw && frame.raw !== undefined) return yield* fail("invalid", "Raw-off source preparation returned archive content.")
        const rawReference = raw ? yield* raw.record(frame.recordKey, frame.raw) : placeholder
        const ready = yield* projection.frame(frame)
        for (const record of ready.events) {
          const event = record.value, recordKey = record.key
          const allocated = yield* version("event", recordKey, record.fingerprint, rawReference)
          const next = { ...event, revision: allocated.revision, projectionRevision: allocated.revision, rawRef: allocated.rawReference! }
          events.push(next)
          if (events.length > 500 || partFull()) { events.pop(); yield* flush(); events.push(next) }
          bindings.push({ kind: "event", key: recordKey })
        }
        for (const record of ready.usage) {
          const sample = record.value, recordKey = record.key
          const allocated = yield* version("usage", recordKey, record.fingerprint)
          const next = { ...sample, revision: allocated.revision }
          usage.push(next)
          if (usage.length > 500 || partFull()) { usage.pop(); yield* flush(); usage.push(next) }
          bindings.push({ kind: "usage", key: recordKey })
        }
      }
      if (page.done) break
    }
    const counts = yield* projection.finish()
    if (events.length > 0 || usage.length > 0 || ordinal === 0) yield* flush()
    const archive = raw ? yield* raw.finish() : undefined
    return { units: ordinal, bytes: totalBytes, materializedBytes, raw: archive,
      records: { canonical: counts,
        ...(archive === undefined ? {} : { raw: { records: archive.records, scopeComplete: true, admission: archive.admission } }) } }
  }))
  yield* sealPublicationCapture(owner, captureId, { nextCheckpoint: input.nextCheckpoint, rawUnits: prepared.raw?.units ?? 0, records: prepared.records })
  return prepared
})

/** Fresh Raw capture under an existing genuine activation. Canonical records,
 * references, selected head and checkpoint are never rewritten by this operation. */
export const prepareRawObservation = <E, R>(owner: CaptureOwner, observationId: string, input: {
  readonly adapterVersion: string; readonly observedAt: string; readonly limits: RawPreparationLimits
  readonly source: Effect.Effect<PublicationDraftView<E, R>, E, R | Scope.Scope>
}) => Effect.gen(function*() {
  const context = yield* rawObservationPreparationContext(owner, observationId)
  yield* validateRawPreparationLimits(input.limits)
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const view = yield* input.source
    if (!view.profile || new TextEncoder().encode(view.profile).byteLength > 500) return yield* fail("invalid", "Raw source profile exceeds its bound.")
    if (view.origin.sourceId !== owner.scope.sourceSessionId || view.origin.originKey !== owner.scope.originKey ||
      view.session.sourceSessionId !== owner.scope.sourceSessionId) return yield* fail("binding", "Fresh Raw source Origin differs from the claimed capture.")
    const raw = yield* createRawPreparation(owner, observationId, {
      profile: `${PublicationPreparationVersion}:${context.canonical.intent.begin.transformVersion}:${view.profile}`,
      sessionId: context.canonical.receipt.sessionId, head: context.canonical.receipt.head, authority: context.rawAuthority,
      adapterVersion: input.adapterVersion, observedAt: input.observedAt, limits: input.limits
    })
    let pages = 0
    for (;;) {
      const page = yield* view.read()
      if (++pages > 1_000_001 || page.frames.length > 100 || !page.done && page.frames.length === 0)
        return yield* fail("capacity", "Raw source pagination exceeds its contract.")
      for (const frame of page.frames) yield* raw.record(frame.recordKey, frame.raw)
      if (page.done) break
    }
    return yield* raw.finish()
  }))
  yield* sealRawObservation(owner, observationId, result.units, { raw: { records: result.records, scopeComplete: true, admission: result.admission } })
  return result
})
