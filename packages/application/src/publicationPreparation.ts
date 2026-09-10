import { Effect, Schema, Scope } from "effect"
import { PublicationTargetProfile, type AdapterEvent, type AdapterSession, type AdapterThread, type AdapterUsage } from "@atape/domain"
import { CaptureJournal, type CaptureOwner, type CaptureRecordKey } from "./captureJournal.ts"
import { prepareCanonicalSlice } from "./collector.ts"
import { canonicalMaterializationBound, projectCanonicalSubmission } from "./canonicalProjection.ts"
import { publicationPreparationContext, sealPublicationCapture } from "./publicationDelivery.ts"

export type PublicationDraftFrame = {
  readonly recordKey: string
  readonly events: ReadonlyArray<Omit<AdapterEvent, "revision" | "projectionRevision" | "rawRef">>
  readonly usage: ReadonlyArray<Omit<AdapterUsage, "revision">>
  readonly raw?: unknown
}
export type PublicationDraftView<E = never, R = never> = {
  readonly profile: string
  readonly origin: { readonly sourceId: string; readonly originKey: string }
  readonly session: Omit<AdapterSession, "revision">
  readonly threads: ReadonlyArray<Omit<AdapterThread, "revision">>
  readonly target: { readonly events: number; readonly usage: number; readonly threads: number }
  readonly read: () => Effect.Effect<{ readonly frames: ReadonlyArray<PublicationDraftFrame>; readonly done: boolean }, E, R>
}
export class PublicationPreparationError extends Schema.TaggedError<PublicationPreparationError>()("PublicationPreparationError", {
  reason: Schema.Literals(["invalid", "binding", "capacity", "unsupported"]), message: Schema.String
}) {}
const fail = (reason: PublicationPreparationError["reason"], message: string) => new PublicationPreparationError({ reason, message })
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const hash = (value: unknown) => Effect.tryPromise({
  try: async () => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encode(value)))).map(byte => byte.toString(16).padStart(2, "0")).join(""),
  catch: () => fail("invalid", "Prepared content could not be fingerprinted.")
})
const positive = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
export const PublicationPreparationVersion = "atape.host-canonical.v1"

/** Prepare a complete Canonical replacement under an explicitly Raw-off Begin.
 * The lazy external source Effect stays in this operation's scope. Only final
 * validated/masked/encoded bytes enter the journal; sealing occurs after close.
 * Raw-enabled preparation has a separate admission contract and is rejected here.
 */
export const preparePublicationCanonical = <E, R>(owner: CaptureOwner, captureId: string, input: {
  readonly adapterVersion: string
  readonly observedAt: string
  readonly nextCheckpoint: string
  readonly source: Effect.Effect<PublicationDraftView<E, R>, E, R | Scope.Scope>
}) => Effect.gen(function*() {
  const journal = yield* CaptureJournal
  for (const [value, maximum] of [[input.adapterVersion, 100], [owner.scope.adapterId, 200], [owner.scope.projectId, 200], [journal.binding.installationId, 200]] as const)
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || new TextEncoder().encode(value).byteLength > maximum)
      return yield* fail("invalid", "Canonical source metadata exceeds its wire bounds.")
  const context = yield* publicationPreparationContext(owner, captureId)
  if (context.rawEnabled) return yield* fail("unsupported", "This preparation operation requires an explicit Raw-off capture.")
  const limits = context.intent.capabilities.limits
  const prepared = yield* Effect.scoped(Effect.gen(function*() {
    const view = yield* input.source
    if (view.origin.sourceId !== owner.scope.sourceSessionId || view.origin.originKey !== owner.scope.originKey ||
      view.session.sourceSessionId !== owner.scope.sourceSessionId) return yield* fail("binding", "Fresh source Origin differs from the claimed capture.")
    if (!view.profile || view.profile.length > 500 || !positive(view.target.events) || !positive(view.target.usage) ||
      !positive(view.target.threads, 1) || view.target.threads !== view.threads.length || view.session.reportedEventCount !== view.target.events)
      return yield* fail("invalid", "Source target counts are inconsistent.")
    const profile = `${PublicationPreparationVersion}:${context.intent.begin.transformVersion}:${view.profile}`
    if (profile.length > 500) return yield* fail("invalid", "Capture projection profile exceeds its bound.")
    const placeholder = { _tag: "unavailable", reason: "Raw capture disabled" } as const
    const observation = (events: ReadonlyArray<AdapterEvent>, usage: ReadonlyArray<AdapterUsage>) => ({
      observationId: captureId, observedAt: input.observedAt, session: { ...view.session, revision: 1 },
      threads: view.threads.map(thread => ({ ...thread, revision: 1 })), events, usage, rawSegments: []
    })
    const masked = (yield* prepareCanonicalSlice(owner.scope.adapterId, observation([], []))).observation
    const version = (kind: CaptureRecordKey["kind"], key: string, value: unknown) => Effect.gen(function*() {
      return yield* journal.record(owner, captureId, { kind, key, fingerprint: yield* hash(value), projectionVersion: profile,
        ...(kind === "event" ? { rawReference: placeholder } : {}) })
    })
    const sessionVersion = yield* version("session", masked.session.sourceSessionId, { ...masked.session, revision: undefined })
    const session = { ...masked.session, revision: sessionVersion.revision }
    const batchKey = yield* hash([PublicationPreparationVersion, captureId])
    const threads: AdapterThread[] = []
    for (const thread of masked.threads) {
      const allocated = yield* version("thread", thread.sourceThreadId, { ...thread, revision: undefined })
      threads.push({ ...thread, revision: allocated.revision })
    }
    let events: AdapterEvent[] = [], usage: AdapterUsage[] = [], bindings: CaptureRecordKey[] = []
    let ordinal = 0, totalBytes = 0, materializedBytes = 0, eventCount = 0, usageCount = 0, lastSourceOrder = -1, pages = 0
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
      // The Interface admits bounded pages and requires progress. This also caps
      // malformed sources emitting endless empty continuation pages.
      if (++pages > 1_000_001 || page.frames.length > 100 || !page.done && page.frames.length === 0)
        return yield* fail("capacity", "Source frame pagination exceeds its contract.")
      for (const frame of page.frames) {
        if (frame.raw !== undefined) return yield* fail("invalid", "Raw-off source preparation returned archive content.")
        if (frame.events.length > 500 || frame.usage.length > 500) return yield* fail("capacity", "Source frame exceeds Canonical slice admission.")
        if (frame.events.length === 0 && frame.usage.length === 0) continue
        const ready = (yield* prepareCanonicalSlice(owner.scope.adapterId, observation(
          frame.events.map(event => ({ ...event, revision: 1, projectionRevision: 1, rawRef: placeholder })),
          frame.usage.map(sample => ({ ...sample, revision: 1 }))
        ))).observation
        for (const event of ready.events) {
          if (event.eventIndex !== eventCount || event.sourceOrder <= lastSourceOrder || ++eventCount > view.target.events)
            return yield* fail("invalid", "Source Event order or target count is inconsistent.")
          lastSourceOrder = event.sourceOrder
          const recordKey = yield* hash([event.sourceThreadId, event.sourceEventId])
          const semantic = project([event], []).events[0]!
          const allocated = yield* version("event", recordKey, { ...semantic, revision: undefined, projectionRevision: undefined, rawRef: undefined })
          const next = { ...event, revision: allocated.revision, projectionRevision: allocated.revision, rawRef: allocated.rawReference! }
          events.push(next)
          if (events.length > 500 || partFull()) { events.pop(); yield* flush(); events.push(next) }
          bindings.push({ kind: "event", key: recordKey })
        }
        for (const sample of ready.usage ?? []) {
          if (++usageCount > view.target.usage) return yield* fail("invalid", "Source usage exceeds the declared target.")
          const recordKey = yield* hash([sample.sourceThreadId, sample.sourceUsageId])
          const allocated = yield* version("usage", recordKey, { ...sample, revision: undefined })
          const next = { ...sample, revision: allocated.revision }
          usage.push(next)
          if (usage.length > 500 || partFull()) { usage.pop(); yield* flush(); usage.push(next) }
          bindings.push({ kind: "usage", key: recordKey })
        }
      }
      if (page.done) break
    }
    if (eventCount !== view.target.events || usageCount !== view.target.usage) return yield* fail("invalid", "Source ended before its complete declared target.")
    if (events.length > 0 || usage.length > 0 || ordinal === 0) yield* flush()
    return { units: ordinal, bytes: totalBytes, materializedBytes, records: { canonical: { session: 1, thread: threads.length, event: eventCount, usage: usageCount } } }
  }))
  yield* sealPublicationCapture(owner, captureId, { nextCheckpoint: input.nextCheckpoint, rawUnits: 0, records: prepared.records })
  return prepared
})
