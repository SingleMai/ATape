import { Effect, Schema, Scope } from "effect"
import { sameRawAuthority, RawAuthority, type AdapterSourceFailure } from "@atape/domain"
import { CaptureJournal, type CaptureOwner, type CaptureRecordKey } from "./captureJournal.ts"
import { canonicalSourceProjection, validateCanonicalSourceMetadata, sourceFingerprint, type PublicationDraftView } from "./canonicalSourceProjection.ts"
import { captureRawAuthority, sourceComparisonContext } from "./publicationDelivery.ts"
import { rawSourceRecord, rawProjectionProfile, rawAdmissionFingerprint, validateRawPreparationLimits, type RawPreparationLimits } from "./rawPreparation.ts"
import { decodeSourceMetadata, maskSourceFailures } from "./sourceMetadata.ts"
import { admitRedactionTransform } from "./collectorRedactionPolicy.ts"

export class SourceComparisonError extends Schema.TaggedError<SourceComparisonError>()("SourceComparisonError", {
  reason: Schema.Literals(["invalid", "capacity", "deadline", "conflict"]), message: Schema.String
}) {}
const fail = (reason: SourceComparisonError["reason"], message: string) => new SourceComparisonError({ reason, message })
export type SourceComparisonResult = {
  readonly canonical: "changed" | "unchanged"
  readonly raw: "required" | "unchanged" | "disabled"
  readonly sourceFailures?: ReadonlyArray<AdapterSourceFailure>
  readonly sourceFailuresTruncated?: boolean
}
/** Disposable read-only preflight. It allocates no capture, version or checkpoint
 * and performs no HTTP. A changed result requires a fresh source after Begin;
 * these pages are never retained as publication evidence. Limits bound exact
 * membership identities and the entire operation, including source acquisition.
 * The owner serializes recovery, comparison and fresh capture; callers reconcile
 * unresolved captures first. Concurrent ownership or baseline changes fail. */
export const comparePublicationSource = <E, R>(owner: CaptureOwner, input: {
  readonly adapterVersion: string; readonly observedAt: string; readonly transformVersion: string
  readonly limits: { readonly records: number; readonly durationMs: number }
  readonly raw?: { readonly authority: typeof RawAuthority.Type; readonly limits: RawPreparationLimits }
  readonly source: Effect.Effect<PublicationDraftView<E, R>, E, R | Scope.Scope>
}) => Effect.gen(function*() {
  yield* validateCanonicalSourceMetadata(owner, input.adapterVersion)
  yield* admitRedactionTransform(input.transformVersion)
  if (!Number.isSafeInteger(input.limits.records) || input.limits.records < 1 || input.limits.records > 1_000_000 ||
    !Number.isSafeInteger(input.limits.durationMs) || input.limits.durationMs < 1 || input.limits.durationMs > 300_000)
    return yield* fail("invalid", "Source comparison requires explicit record and duration admission.")
  if (!input.transformVersion || input.transformVersion.length > 200) return yield* fail("invalid", "Source comparison requires a bounded transform version.")
  if (input.raw) {
    yield* validateRawPreparationLimits(input.raw.limits)
    yield* Schema.decodeUnknownEffect(RawAuthority)(input.raw.authority).pipe(Effect.mapError(() => fail("invalid", "Source comparison requires current Raw authority.")))
  }
  return yield* Effect.scoped(Effect.gen(function*() {
    const journal = yield* CaptureJournal, baseline = yield* sourceComparisonContext(owner)
    const changed = { canonical: "changed", raw: input.raw ? "required" : "disabled" } as const
    if (baseline === null) return changed
    const view = yield* input.source
    const prior = view.sourceCheckpoint === undefined ? { threads: [] } : yield* decodeSourceMetadata(yield* journal.sourceMetadata(owner, baseline.capture.id))
    const diagnostics = view.sourceCheckpoint === undefined ? {} : { sourceFailures: yield* maskSourceFailures(view.sourceFailures ?? []), sourceFailuresTruncated: view.sourceFailuresTruncated ?? false }
    const changedView = { ...changed, ...diagnostics }
    // The complete physical prefix is acknowledged only by a sealed/activated
    // target. Even Raw-only controls require durable source authentication.
    if (view.sourceCheckpoint !== undefined && prior.sourceCheckpoint !== view.sourceCheckpoint) return changedView
    if (view.sourceCheckpoint !== undefined && (JSON.stringify(prior.sourceFailures ?? []) !== JSON.stringify(diagnostics.sourceFailures ?? []) ||
      (prior.sourceFailuresTruncated ?? false) !== (view.sourceFailuresTruncated ?? false))) return changedView
    const projection = yield* canonicalSourceProjection(owner, view, { ...input, captureId: "source-comparison" })
    const expected = baseline.capture.seal!.records!.canonical!
    if (expected.session !== 1 || expected.thread !== view.target.threads || expected.event !== view.target.events || expected.usage !== view.target.usage)
      return changedView
    if (JSON.stringify([...(prior.retainedThreadIds ?? [])].sort()) !== JSON.stringify([...(view.target.retainedThreadIds ?? [])].sort())) return changedView
    const seen = new Set<string>()
    const unique = (record: CaptureRecordKey) => Effect.gen(function*() {
      if (seen.size >= input.limits.records) return yield* fail("capacity", "Source comparison exceeds its exact membership admission.")
      const identity = yield* sourceFingerprint([record.kind, record.key])
      if (seen.has(identity)) return yield* fail("invalid", "Source comparison repeated a record identity.")
      seen.add(identity)
    })
    const matches = (record: CaptureRecordKey, fingerprint: string) => Effect.gen(function*() {
      yield* unique(record)
      const prior = yield* journal.recordStatus(owner, baseline.capture.id, record)
      return prior?.disposition === "published" && prior.fingerprint === fingerprint && prior.projectionVersion === projection.profile
    })
    const { masked } = projection
    if (!(yield* matches({ kind: "session", key: masked.session.sourceSessionId }, yield* sourceFingerprint({ ...masked.session, revision: undefined })))) return changedView
    for (const thread of masked.threads)
      if (!(yield* matches({ kind: "thread", key: thread.sourceThreadId }, yield* sourceFingerprint({ ...thread, revision: undefined })))) return changedView
    const rawManifest = baseline.raw?.seal?.records?.raw
    const admission = input.raw ? yield* rawAdmissionFingerprint(owner, { profile: projection.profile, sessionId: baseline.receipt.sessionId,
      head: baseline.receipt.head, authority: input.raw.authority, adapterVersion: input.adapterVersion, observedAt: input.observedAt, limits: input.raw.limits }) : undefined
    let rawChanged = input.raw !== undefined && (baseline.raw?.activationReceipt == null || rawManifest?.scopeComplete !== true || rawManifest.admission !== admission)
    let rawCount = 0, frameCount = 0
    for (;;) {
      const page = yield* view.read()
      yield* projection.page(page)
      for (const frame of page.frames) {
        if (++frameCount > input.limits.records) return yield* fail("capacity", "Source comparison exceeds its frame admission.")
        if (!input.raw && frame.raw !== undefined) return yield* fail("invalid", "Raw-off comparison returned archive content.")
        const ready = yield* projection.frame(frame)
        for (const [kind, records] of [["event", ready.events], ["usage", ready.usage]] as const)
          for (const record of records) if (!(yield* matches({ kind, key: record.key }, record.fingerprint))) return changedView
        if (input.raw) {
          const record = yield* rawSourceRecord(frame.recordKey, frame.raw)
          yield* unique({ kind: "raw", key: record.key }); rawCount++
          if (!rawChanged) {
            const prior = yield* journal.recordStatus(owner, baseline.raw!.id, { kind: "raw", key: record.key })
            if (prior?.fingerprint !== record.fingerprint || prior?.projectionVersion !== rawProjectionProfile(projection.profile)) rawChanged = true
            else if (prior.disposition === "unavailable") {
              // Same masking and packing admission preserves an explicit gap.
              if ("gap" in record.masked ? prior.unavailableReason !== record.masked.gap : prior.unavailableReason !== "limit") rawChanged = true
            } else if (prior.disposition === "pending" && prior.unit !== null) {
              const owning = (yield* journal.inspect(owner, prior.unit.captureId, { kind: "raw", limit: 1 })).capture
              const authority = yield* captureRawAuthority(owner, prior.unit.captureId)
              if (owning.rawCancelReason !== null || authority === undefined || !sameRawAuthority(authority, input.raw.authority)) rawChanged = true
            } else if (prior.disposition !== "acknowledged") rawChanged = true
          }
        }
      }
      if (page.done) break
    }
    yield* projection.finish()
    // Recheck the owner even for complete empty sources before returning a no-op.
    const current = yield* journal.coverage(owner)
    if (current.canonicalCaptureId !== baseline.coverage.canonicalCaptureId || current.observedRawCaptureId !== baseline.coverage.observedRawCaptureId)
      return yield* fail("conflict", "Published source coverage changed during comparison.")
    return { canonical: "unchanged", raw: input.raw ? rawChanged || rawCount !== rawManifest?.records ? "required" : "unchanged" : "disabled", ...diagnostics } satisfies SourceComparisonResult & typeof diagnostics
  })).pipe(Effect.timeoutOrElse({ duration: input.limits.durationMs,
    orElse: () => Effect.fail(fail("deadline", "Source comparison exceeded its deadline.")) }))
})
