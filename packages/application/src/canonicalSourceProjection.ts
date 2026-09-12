import { Effect, Schema } from "effect"
import type { AdapterEvent, AdapterSession, AdapterThread, AdapterUsage, SourceCaptureFrame } from "@atape/domain"
import { CaptureJournal, type CaptureOwner } from "./captureJournal.ts"
import { prepareCanonicalSlice } from "./collectorPreparation.ts"
import { projectCanonicalSubmission } from "./canonicalProjection.ts"
export type PublicationDraftFrame = SourceCaptureFrame
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
export const encodeSource = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
export const sourceFingerprint = (value: unknown) => Effect.tryPromise({
  try: async () => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encodeSource(value)))).map(byte => byte.toString(16).padStart(2, "0")).join(""),
  catch: () => fail("invalid", "Prepared content could not be fingerprinted.")
})
const positive = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
export const PublicationPreparationVersion = "atape.host-canonical.v1"


export const validateCanonicalSourceMetadata = (owner: CaptureOwner, adapterVersion: string) => Effect.gen(function*() {
  const journal = yield* CaptureJournal
  for (const [value, maximum] of [[adapterVersion, 100], [owner.scope.adapterId, 200], [owner.scope.projectId, 200], [journal.binding.installationId, 200]] as const)
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || new TextEncoder().encode(value).byteLength > maximum)
      return yield* fail("invalid", "Canonical source metadata exceeds its wire bounds.")
})

/** Internal shared projection: preparation and disposable comparison must hash
 * exactly the same validated, masked Canonical semantics. No durable writes. */
export const canonicalSourceProjection = <E, R>(owner: CaptureOwner, view: PublicationDraftView<E, R>, input: {
  readonly captureId: string; readonly observedAt: string; readonly adapterVersion: string; readonly transformVersion: string
}) => Effect.gen(function*() {
  const journal = yield* CaptureJournal
  if (view.origin.sourceId !== owner.scope.sourceSessionId || view.origin.originKey !== owner.scope.originKey ||
    view.session.sourceSessionId !== owner.scope.sourceSessionId) return yield* fail("binding", "Fresh source Origin differs from the claimed capture.")
  if (!view.profile || view.profile.length > 500 || !positive(view.target.events) || !positive(view.target.usage) ||
    !positive(view.target.threads, 1) || view.target.threads !== view.threads.length || view.session.reportedEventCount !== view.target.events)
    return yield* fail("invalid", "Source target counts are inconsistent.")
  const profile = `${PublicationPreparationVersion}:${input.transformVersion}:${view.profile}`
  if (profile.length > 500) return yield* fail("invalid", "Capture projection profile exceeds its bound.")
  const placeholder = { _tag: "unavailable", reason: "Raw capture disabled" } as const
  const observation = (events: ReadonlyArray<AdapterEvent>, usage: ReadonlyArray<AdapterUsage>) => ({
    observationId: input.captureId, observedAt: input.observedAt, session: { ...view.session, revision: 1 },
    threads: view.threads.map(thread => ({ ...thread, revision: 1 })), events, usage, rawSegments: []
  })
  const masked = (yield* prepareCanonicalSlice(owner.scope.adapterId, observation([], []))).observation
  const project = (events: ReadonlyArray<AdapterEvent>) => projectCanonicalSubmission({
    instanceOrigin: journal.binding.instanceOrigin, installationId: journal.binding.installationId,
    adapterId: owner.scope.adapterId, adapterVersion: input.adapterVersion, projectId: owner.scope.projectId,
    observation: { observedAt: input.observedAt, session: masked.session, threads: masked.threads, events, usage: [] }
  })
  let eventCount = 0, usageCount = 0, lastSourceOrder = -1, pages = 0
  const page = (value: { readonly frames: ReadonlyArray<PublicationDraftFrame>; readonly done: boolean }) => Effect.gen(function*() {
    if (++pages > 1_000_001 || value.frames.length > 100 || !value.done && value.frames.length === 0)
      return yield* fail("capacity", "Source frame pagination exceeds its contract.")
  })
  const frame = (value: PublicationDraftFrame) => Effect.gen(function*() {
    if (value.events.length > 500 || value.usage.length > 500) return yield* fail("capacity", "Source frame exceeds Canonical slice admission.")
    if (value.events.length === 0 && value.usage.length === 0) return { events: [], usage: [] }
    const ready = (yield* prepareCanonicalSlice(owner.scope.adapterId, observation(
      value.events.map(event => ({ ...event, revision: 1, projectionRevision: 1, rawRef: placeholder })),
      value.usage.map(sample => ({ ...sample, revision: 1 }))
    ))).observation
    const events = [], usage = []
    for (const event of ready.events) {
      if (event.eventIndex !== eventCount || event.sourceOrder <= lastSourceOrder || ++eventCount > view.target.events)
        return yield* fail("invalid", "Source Event order or target count is inconsistent.")
      lastSourceOrder = event.sourceOrder
      const semantic = project([event]).events[0]!
      events.push({ value: event, key: yield* sourceFingerprint([event.sourceThreadId, event.sourceEventId]),
        fingerprint: yield* sourceFingerprint({ ...semantic, revision: undefined, projectionRevision: undefined, rawRef: undefined }) })
    }
    for (const sample of ready.usage ?? []) {
      if (++usageCount > view.target.usage) return yield* fail("invalid", "Source usage exceeds the declared target.")
      usage.push({ value: sample, key: yield* sourceFingerprint([sample.sourceThreadId, sample.sourceUsageId]),
        fingerprint: yield* sourceFingerprint({ ...sample, revision: undefined }) })
    }
    return { events, usage }
  })
  const finish = () => Effect.gen(function*() {
    if (eventCount !== view.target.events || usageCount !== view.target.usage) return yield* fail("invalid", "Source ended before its complete declared target.")
    return { session: 1, thread: masked.threads.length, event: eventCount, usage: usageCount }
  })
  return { profile, placeholder, masked, page, frame, finish }
})
