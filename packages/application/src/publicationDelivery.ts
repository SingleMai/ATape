import { Context, Effect, Schema } from "effect"
import {
  PublicationActivation, PublicationAttempt, PublicationBegin, PublicationBinding, PublicationCapabilities,
  PublicationManifest, PublicationProtocol, PublicationScope, RawAuthority, RawPublicationChunk, RawPublicationWireBytes, sameRawAuthority,
  type RawPublicationReceipt,
  type PublicationPart, type PublicationReservation
} from "@atape/domain"
import { RawPublicationError, RawPublicationTransport } from "./rawPublicationTransport.ts"
import { CaptureJournal, type CaptureClaim, type CaptureOwner, type CaptureSummary, type CaptureRecordManifest } from "./captureJournal.ts"

export class PublicationError extends Schema.TaggedError<PublicationError>()("PublicationError", {
  reason: Schema.Literals(["invalid", "binding", "invalid_response", "unauthenticated", "network", "unknown", "expired", "superseded", "conflict", "capacity", "unavailable"]),
  message: Schema.String,
  retryAfterSeconds: Schema.optionalKey(Schema.Number)
}) {}

/** Remote, owned Seam. The Node Adapter owns credentials, HTTP and wire decoding. */
export class PublicationTransport extends Context.Service<PublicationTransport, {
  capabilities(binding: PublicationBinding): Effect.Effect<PublicationCapabilities, PublicationError>
  reserve(binding: PublicationBinding, scope: PublicationScope): Effect.Effect<typeof PublicationReservation.Type, PublicationError>
  begin(binding: PublicationBinding, input: PublicationBegin): Effect.Effect<PublicationAttempt, PublicationError>
  status(binding: PublicationBinding, id: string): Effect.Effect<PublicationAttempt, PublicationError>
  put(binding: PublicationBinding, id: string, part: PublicationPart, bytes: Uint8Array): Effect.Effect<PublicationPart, PublicationError>
  seal(binding: PublicationBinding, id: string, manifest: PublicationManifest): Effect.Effect<PublicationAttempt, PublicationError>
  validate(binding: PublicationBinding, id: string): Effect.Effect<PublicationAttempt, PublicationError>
  renew(binding: PublicationBinding, id: string): Effect.Effect<PublicationAttempt, PublicationError>
  reject(binding: PublicationBinding, id: string): Effect.Effect<PublicationAttempt, PublicationError>
  activate(binding: PublicationBinding, id: string): Effect.Effect<PublicationActivation, PublicationError>
}>()("atape/application/PublicationTransport") {}

const Intent = Schema.Struct({ protocol: Schema.Literal(PublicationProtocol), binding: PublicationBinding,
  scope: PublicationScope, sessionId: Schema.String, begin: PublicationBegin, capabilities: PublicationCapabilities,
  rawAuthority: Schema.optionalKey(RawAuthority) })
const Seal = Schema.Struct({ protocol: Schema.Literal(PublicationProtocol), fence: PublicationAttempt.fields.fence, manifest: PublicationManifest })
type Intent = typeof Intent.Type
type Seal = typeof Seal.Type
const failure = (reason: PublicationError["reason"], message: string) => new PublicationError({ reason, message })
const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
  Effect.mapError(() => failure("invalid_response", "Publication metadata failed validation.")))
const parse = <A>(schema: Schema.ConstraintDecoder<A>, value: string) => Effect.try({
  try: () => JSON.parse(value) as unknown, catch: () => failure("invalid", "Stored publication metadata is not JSON.")
}).pipe(Effect.flatMap(value => decode(schema, value)))
const sameManifest = (a: PublicationManifest, b: PublicationManifest) => a.parts === b.parts && a.bytes === b.bytes && a.sha256 === b.sha256
const checkIntentBinding = (journal: CaptureJournal["Service"], owner: CaptureOwner, intent: Intent, captureId: string) => Effect.gen(function*() {
  const b = journal.binding, s = owner.scope
  if (intent.binding.instanceOrigin !== b.instanceOrigin || intent.binding.userId !== b.userId || intent.binding.installationId !== b.installationId ||
    intent.scope.installationId !== b.installationId || intent.scope.projectId !== s.projectId || intent.scope.adapterId !== s.adapterId ||
    intent.scope.sourceSessionId !== s.sourceSessionId || intent.scope.originKey !== s.originKey || intent.begin.captureId !== captureId)
    return yield* failure("binding", "Publication metadata differs from the journal owner.")
  return intent
})
const boundIntent = (journal: CaptureJournal["Service"], owner: CaptureOwner, capture: CaptureSummary) => Effect.gen(function*() {
  if (capture.purpose !== "publication") return yield* failure("invalid", "This operation requires a Canonical publication capture.")
  return yield* checkIntentBinding(journal, owner, yield* parse(Intent, capture.beginJson), capture.id)
})
const checkAttempt = (intent: Intent, attempt: PublicationAttempt, seal?: Seal) => Effect.gen(function*() {
  if (attempt.id !== intent.begin.reservationId || attempt.sessionId !== intent.sessionId || attempt.captureId !== intent.begin.captureId ||
    attempt.baseHead !== intent.begin.baseHead || attempt.transformVersion !== intent.begin.transformVersion ||
    (seal !== undefined && (attempt.fence !== seal.fence || (attempt.seal !== null && !sameManifest(attempt.seal, seal.manifest)))))
    return yield* failure("invalid_response", "Publication attempt identity or frozen manifest changed.")
  if ((attempt.state === "activated") !== (attempt.activation !== null) ||
    (["sealed", "validating", "validated", "activated"].includes(attempt.state) && attempt.seal === null) ||
    (attempt.seal !== null && attempt.validatedParts > attempt.seal.parts) ||
    (attempt.state === "open" && attempt.validatedParts !== 0))
    return yield* failure("invalid_response", "Publication attempt has inconsistent state.")
  return attempt
})
const checkActivation = (intent: Intent, seal: Seal, receipt: PublicationActivation) => Effect.gen(function*() {
  if (receipt.head !== intent.begin.reservationId || receipt.sessionId !== intent.sessionId || receipt.captureId !== intent.begin.captureId ||
    receipt.baseHead !== intent.begin.baseHead || receipt.transformVersion !== intent.begin.transformVersion || receipt.fence !== seal.fence ||
    !sameManifest(receipt.manifest, seal.manifest))
    return yield* failure("invalid_response", "Activation receipt does not prove this frozen capture.")
  return receipt
})

/** Control-only reservation. Host appends final validated/redacted wire units to
 * CaptureJournal after this returns. Failed/unsealed captures must be discarded,
 * never completed with newly read source pages after a restart.
 */
export const beginPublicationCapture = (owner: CaptureClaim, input: {
  readonly captureId: string; readonly baseHead: string; readonly transformVersion: string; readonly rawEnabled: boolean; readonly rawAuthority?: RawAuthority; readonly trackRecords?: boolean
}) => Effect.gen(function*() {
  const journal = yield* CaptureJournal, remote = yield* PublicationTransport
  // Check the owner before consuming remote reservation quota.
  yield* journal.pending(owner, undefined, 1)
  const binding = journal.binding
  const scope = yield* decode(PublicationScope, { ...owner.scope, installationId: binding.installationId })
  const rawAuthority = input.rawEnabled ? yield* decode(RawAuthority, input.rawAuthority) : undefined
  const capabilities = yield* remote.capabilities(binding)
  const reservation = yield* remote.reserve(binding, scope)
  const begin = yield* decode(PublicationBegin, { reservationId: reservation.id, captureId: input.captureId,
    baseHead: input.baseHead, transformVersion: input.transformVersion })
  const intent: Intent = { protocol: PublicationProtocol, binding, scope, sessionId: reservation.sessionId, begin, capabilities,
    ...(rawAuthority === undefined ? {} : { rawAuthority }) }
  yield* journal.reserve(owner, { id: input.captureId, expectedCheckpoint: owner.checkpoint,
    beginJson: JSON.stringify(intent), rawEnabled: input.rawEnabled, trackRecords: input.trackRecords ?? false })
  const attempt = yield* checkAttempt(intent, yield* remote.begin(binding, begin))
  if (attempt.state !== "open") return yield* failure("conflict", "A new capture requires an open publication attempt.")
  return { sessionId: attempt.sessionId, attemptId: attempt.id, limits: capabilities.limits }
})

/** Checked local preparation context. This reads metadata only and does no HTTP.
 * Source preparation uses the persisted Begin identity, never an independent proof. */
export const publicationPreparationContext = (owner: CaptureOwner, id: string) => Effect.gen(function*() {
  const journal = yield* CaptureJournal
  const { capture, units } = yield* journal.inspect(owner, id, { kind: "canonical", limit: 1 })
  const intent = yield* boundIntent(journal, owner, capture)
  if (capture.state !== "preparing" || !capture.trackRecords) return yield* failure("conflict", "Source preparation requires a tracked unsealed capture.")
  if (units.length > 0 || (yield* journal.records(owner, id, { kind: "session", limit: 1 })).length > 0)
    return yield* failure("conflict", "An interrupted source preparation must be abandoned before opening a fresh source.")
  return { intent, rawEnabled: capture.rawEnabled }
})

const hashManifestText = (value: string) => Effect.tryPromise({
  try: async () => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, "0")).join(""),
  catch: () => failure("unavailable", "Could not hash the prepared manifest.")
})
const preparedManifest = (journal: CaptureJournal["Service"], owner: CaptureOwner, id: string, kind: "canonical" | "raw",
  limits: { readonly unitBytes: number; readonly units: number; readonly targetBytes: number }) => Effect.gen(function*() {
  const lines: string[] = []
  let ordinal = 0, bytes = 0, rawDigest = "0".repeat(64)
  while (true) {
    const page = yield* journal.inspect(owner, id, { kind, afterOrdinal: ordinal - 1, limit: 100 })
    for (const unit of page.units) {
      if (unit.ordinal !== ordinal || !unit.retained || unit.byteCount > limits.unitBytes || ordinal >= limits.units)
        return yield* failure("capacity", "Prepared publication units exceed the negotiated bounds.")
      lines.push(`${ordinal}:${unit.byteCount}:${unit.digest}\n`)
      ordinal++; bytes += unit.byteCount
      if (bytes > limits.targetBytes) return yield* failure("capacity", "Prepared target exceeds publication capacity.")
    }
    if (kind === "raw" && lines.length > 0) {
      // Raw has no Server aggregate manifest. Chain fixed 100-unit metadata
      // pages so even a large local observation retains only one page here.
      rawDigest = yield* hashManifestText(`${rawDigest}\n${lines.join("")}`)
      lines.length = 0
    }
    if (page.units.length < 100) break
  }
  const sha256 = kind === "raw" ? rawDigest : yield* hashManifestText(lines.join(""))
  return { parts: ordinal, bytes, sha256 }
})

const sameRecordManifest = (a: CaptureRecordManifest | undefined, b: CaptureRecordManifest | undefined) => {
  const key = (v: CaptureRecordManifest | undefined) => JSON.stringify([v !== undefined, v?.canonical !== undefined,
    v?.canonical?.session,v?.canonical?.thread,v?.canonical?.event,v?.canonical?.usage,v?.raw !== undefined,v?.raw?.records,v?.raw?.scopeComplete])
  return key(a) === key(b)
}

/** Close the source view before calling. Only metadata is read while computing
 * the ordered manifest; payloads remain in SQLite. This is the content-send gate.
 */
export const sealPublicationCapture = (owner: CaptureOwner, id: string, input: {
  readonly nextCheckpoint: string; readonly rawUnits: number; readonly records?: CaptureRecordManifest
}) => Effect.gen(function*() {
  const journal = yield* CaptureJournal, remote = yield* PublicationTransport
  const { capture } = yield* journal.inspect(owner, id, { kind: "canonical", limit: 1 })
  const intent = yield* boundIntent(journal, owner, capture)
  if (capture.seal !== null) {
    if (capture.seal.nextCheckpoint !== input.nextCheckpoint || capture.seal.rawUnits !== input.rawUnits || !sameRecordManifest(capture.seal.records,input.records))
      return yield* failure("conflict", "Capture seal cannot change on replay.")
    return
  }
  if (capture.state !== "preparing") return yield* failure("conflict", "Capture is not preparing.")
  const manifest = yield* decode(PublicationManifest, yield* preparedManifest(journal, owner, id, "canonical", {
    unitBytes: intent.capabilities.limits.partBytes, units: intent.capabilities.limits.parts, targetBytes: intent.capabilities.limits.targetBytes }))
  const attempt = yield* checkAttempt(intent, yield* remote.status(journal.binding, intent.begin.reservationId))
  if (attempt.state !== "open" || attempt.parts !== 0) return yield* failure("conflict", "An unsealed capture cannot already have remote content.")
  yield* journal.seal(owner, id, { canonicalUnits: manifest.parts, rawUnits: input.rawUnits, nextCheckpoint: input.nextCheckpoint,
    ...(input.records === undefined ? {} : { records: input.records }), manifestJson: JSON.stringify({ protocol: PublicationProtocol, fence: attempt.fence, manifest } satisfies Seal) })
})

export type PublicationDeliveryResult =
  | { readonly state: "pending"; readonly operations: number }
  | { readonly state: "activated"; readonly operations: number; readonly receipt: PublicationActivation }
  | { readonly state: "abandoned"; readonly operations: number }

/** One bounded recovery slice. No source or converter dependency exists here.
 * Network failures propagate with every durable obligation intact. Call again
 * to reconcile; unknown is never a rejection. Raw remains independently pending.
 */
export const deliverPublicationCapture = (owner: CaptureOwner, id: string, maxOperations: number) => Effect.gen(function*() {
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 3 || maxOperations > 64)
    return yield* failure("invalid", "Publication recovery needs an explicit operation budget between 3 and 64.")
  const journal = yield* CaptureJournal, remote = yield* PublicationTransport
  const { capture } = yield* journal.inspect(owner, id, { kind: "canonical", limit: 1 })
  const intent = yield* boundIntent(journal, owner, capture)
  if (capture.state === "preparing") {
    yield* journal.settle(owner, id, { _tag: "AbandonUnsealed" })
    return { state: "abandoned", operations: 0 } as PublicationDeliveryResult
  }
  if (capture.state === "abandoned") return { state: "abandoned", operations: 0 } as PublicationDeliveryResult
  if (capture.seal === null) return yield* failure("invalid", "Publication capture lacks its local seal.")
  const seal = yield* parse(Seal, capture.seal.manifestJson)
  if (seal.manifest.parts !== capture.seal.canonicalUnits) return yield* failure("invalid", "Publication seal has inconsistent counts.")
  const activateLocally = (receipt: PublicationActivation) => Effect.gen(function*() {
    const verified = yield* checkActivation(intent, seal, receipt)
    yield* journal.settle(owner, id, { _tag: "Activated", receiptJson: JSON.stringify(verified) })
    return verified
  })
  if (capture.activationReceipt !== null) {
    const receipt = yield* activateLocally(yield* parse(PublicationActivation, capture.activationReceipt))
    return { state: "activated", operations: 0, receipt } as PublicationDeliveryResult
  }
  const binding = journal.binding, attemptId = intent.begin.reservationId
  let operations = 1
  let attempt = yield* checkAttempt(intent, yield* remote.status(binding, attemptId), seal)
  while (true) {
    if (attempt.activation !== null) {
      const receipt = yield* activateLocally(attempt.activation)
      return { state: "activated", operations, receipt } as PublicationDeliveryResult
    }
    if (attempt.state === "rejected") {
      yield* journal.settle(owner, id, { _tag: "Rejected", receiptJson: JSON.stringify(attempt) })
      return { state: "abandoned", operations } as PublicationDeliveryResult
    }
    if (operations >= maxOperations) return { state: "pending", operations } as PublicationDeliveryResult
    if (attempt.state === "expired" || attempt.state === "superseded") {
      operations++
      attempt = yield* checkAttempt(intent, yield* remote.reject(binding, attemptId), seal)
      if (attempt.state !== "rejected") return yield* failure("invalid_response", "Rejection did not prove a terminal unactivated capture.")
      continue
    }
    // Reserve one operation for useful work after renewal. Server time owns
    // expiry; renewal never changes the frozen fence or revives stale authority.
    if (operations + 1 >= maxOperations) return { state: "pending", operations } as PublicationDeliveryResult
    operations++
    attempt = yield* checkAttempt(intent, yield* remote.renew(binding, attemptId), seal)
    if (attempt.activation !== null || attempt.state === "rejected" || attempt.state === "expired" || attempt.state === "superseded") continue
    operations++
    if (attempt.state === "open") {
      const pending = yield* journal.inspect(owner, id, { kind: "canonical", pendingOnly: true, limit: 1 })
      const unit = pending.units[0]
      if (unit !== undefined) {
        const part = { ordinal: unit.ordinal, bytes: unit.byteCount, sha256: unit.digest }
        const bytes = yield* journal.read(owner, id, "canonical", unit.ordinal)
        const receipt = yield* remote.put(binding, attemptId, part, bytes)
        if (receipt.ordinal !== part.ordinal || receipt.bytes !== part.bytes || receipt.sha256 !== part.sha256)
          return yield* failure("invalid_response", "Part receipt differs from the frozen bytes.")
        yield* journal.settle(owner, id, { _tag: "CanonicalAcknowledged", ordinal: unit.ordinal, receiptJson: JSON.stringify(receipt) })
      } else {
        attempt = yield* checkAttempt(intent, yield* remote.seal(binding, attemptId, seal.manifest), seal)
        if (attempt.state !== "sealed" && attempt.state !== "validating" && attempt.state !== "validated" && attempt.state !== "activated")
          return yield* failure("invalid_response", "Remote seal did not complete the prepared target.")
      }
    } else if (attempt.state === "sealed" || attempt.state === "validating") {
      const previous = attempt.validatedParts
      attempt = yield* checkAttempt(intent, yield* remote.validate(binding, attemptId), seal)
      if (attempt.state !== "activated" && (attempt.validatedParts <= previous || attempt.validatedParts > seal.manifest.parts))
        return yield* failure("invalid_response", "Publication validation did not make bounded progress.")
    } else if (attempt.state === "validated") {
      const receipt = yield* activateLocally(yield* remote.activate(binding, attemptId))
      return { state: "activated", operations, receipt } as PublicationDeliveryResult
    }
  }
})

const RawObservationProtocol = "atape.raw-observation.v1"
const CanonicalProof = Schema.Struct({ intent: Intent, seal: Seal, receipt: PublicationActivation })
const RawObservationIntent = Schema.Struct({ protocol: Schema.Literal(RawObservationProtocol), observationId: Schema.String,
  rawAuthority: RawAuthority, canonical: CanonicalProof })
const boundedCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const RawObservationSeal = Schema.Struct({ protocol: Schema.Literal(RawObservationProtocol), manifest: Schema.Struct({
  parts: boundedCount, bytes: boundedCount, sha256: PublicationManifest.fields.sha256 }) })
const checkCanonicalProof = (journal: CaptureJournal["Service"], owner: CaptureOwner, proof: typeof CanonicalProof.Type) => Effect.gen(function*() {
  yield* checkIntentBinding(journal, owner, proof.intent, proof.intent.begin.captureId)
  yield* checkActivation(proof.intent, proof.seal, proof.receipt)
  return proof
})
const boundObservation = (journal: CaptureJournal["Service"], owner: CaptureOwner, capture: CaptureSummary) => Effect.gen(function*() {
  if (capture.purpose !== "raw-observation" || capture.expectedCheckpoint === null || !capture.rawEnabled)
    return yield* failure("invalid", "This operation requires an independent Raw observation.")
  const intent = yield* parse(RawObservationIntent, capture.beginJson)
  if (intent.observationId !== capture.id) return yield* failure("binding", "Raw observation identity changed.")
  yield* checkCanonicalProof(journal, owner, intent.canonical)
  return intent
})

/** Starts a fresh source observation under current Raw authority. Its existing
 * Canonical proof is rechecked remotely, but no new Canonical attempt is created.
 * Host must freshly observe and redact the source before appending Raw units.
 */
export const beginRawObservation = (owner: CaptureClaim, input: {
  readonly observationId: string; readonly canonicalCaptureId: string
}) => Effect.gen(function*() {
  const journal = yield* CaptureJournal, remote = yield* PublicationTransport, raw = yield* RawPublicationTransport
  const { capture } = yield* journal.inspect(owner, input.canonicalCaptureId, { kind: "canonical", limit: 1 })
  const intent = yield* boundIntent(journal, owner, capture)
  if (capture.seal === null || capture.activationReceipt === null || owner.checkpoint === null)
    return yield* failure("invalid", "A fresh Raw observation requires existing Canonical activation and coverage.")
  const seal = yield* parse(Seal, capture.seal.manifestJson)
  const saved = yield* checkActivation(intent, seal, yield* parse(PublicationActivation, capture.activationReceipt))
  const policy = yield* raw.policy(journal.binding, owner.scope.projectId)
  if (!policy.enabled) return yield* rawFailure("disabled", "Raw is disabled; no fresh source observation can begin.")
  const rawAuthority = yield* decode(RawAuthority, policy.authority)
  const attempt = yield* checkAttempt(intent, yield* remote.status(journal.binding, saved.head), seal)
  if (attempt.activation === null) return yield* failure("invalid_response", "The original Canonical activation proof is unavailable.")
  const receipt = yield* checkActivation(intent, seal, attempt.activation)
  const observation = { protocol: RawObservationProtocol, observationId: input.observationId, rawAuthority,
    canonical: { intent, seal, receipt } } satisfies typeof RawObservationIntent.Type
  yield* journal.reserve(owner, { id: input.observationId, purpose: "raw-observation", expectedCheckpoint: owner.checkpoint,
    beginJson: JSON.stringify(observation), rawEnabled: true, trackRecords: capture.trackRecords })
  return { sessionId: receipt.sessionId, head: receipt.head, rawAuthority }
})

/** Close the source view first. Zero Canonical units and an unchanged checkpoint
 * are enforced by the journal, independently of the workflow metadata.
 */
export const sealRawObservation = (owner: CaptureOwner, id: string, rawUnits: number, records?: CaptureRecordManifest) => Effect.gen(function*() {
  const journal = yield* CaptureJournal
  const { capture } = yield* journal.inspect(owner, id, { kind: "raw", limit: 1 })
  yield* boundObservation(journal, owner, capture)
  if (capture.seal !== null) {
    if (capture.seal.rawUnits !== rawUnits || !sameRecordManifest(capture.seal.records,records)) return yield* failure("conflict", "Raw observation seal cannot change.")
    return
  }
  const manifest = yield* preparedManifest(journal, owner, id, "raw", {
    unitBytes: RawPublicationWireBytes, units: 1_000_000, targetBytes: Number.MAX_SAFE_INTEGER })
  if (manifest.parts !== rawUnits) return yield* failure("invalid", "Raw observation does not contain every promised unit.")
  const seal = yield* decode(RawObservationSeal, { protocol: RawObservationProtocol, manifest })
  yield* journal.seal(owner, id, { canonicalUnits: 0, rawUnits, nextCheckpoint: capture.expectedCheckpoint!, manifestJson: JSON.stringify(seal),
    ...(records === undefined ? {} : { records }) })
})

export type RawPublicationDeliveryResult = { readonly state: "pending" | "completed" | "abandoned"; readonly operations: number }
const rawFailure = (reason: RawPublicationError["reason"], message: string) => new RawPublicationError({ reason, message })
const timestampKey = (value: string) => {
  const [seconds, fraction = ""] = value.slice(0, -1).split(".")
  return `${seconds}.${fraction.padEnd(6, "0")}`
}
const checkRawReceipt = (chunk: RawPublicationChunk, receipt: RawPublicationReceipt) => Effect.gen(function*() {
  const fields = ["protocolVersion", "sessionId", "installationId", "adapterId", "sourceObjectId", "sourceChunkId",
    "sourceName", "mediaType", "adapterVersion", "clientRedacted", "generation", "offset", "sha256", "final"] as const
  const size = chunk.contentBase64.length / 4 * 3 - (chunk.contentBase64.endsWith("==") ? 2 : chunk.contentBase64.endsWith("=") ? 1 : 0)
  if (fields.some(field => chunk[field] !== receipt[field]) || receipt.sizeBytes !== size ||
    timestampKey(chunk.capturedAt) !== timestampKey(receipt.capturedAt) || receipt.publication.head !== chunk.publication.head ||
    !sameRawAuthority(chunk.publication.authority, receipt.publication.authority))
    return yield* rawFailure("invalid_response", "Raw receipt does not prove the frozen observation.")
  return receipt
})

/** Bounded Raw recovery over the same journal. A policy change durably starts
 * cancellation; every remaining unit first reconciles its actual receipt. No
 * source read, transformation, re-encoding or Canonical checkpoint advance.
 */
export const deliverPublicationRaw = (owner: CaptureOwner, id: string, maxOperations: number) => Effect.gen(function*() {
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 3 || maxOperations > 64)
    return yield* rawFailure("invalid", "Raw recovery needs an explicit operation budget between 3 and 64.")
  const journal = yield* CaptureJournal, remote = yield* RawPublicationTransport
  const { capture } = yield* journal.inspect(owner, id, { kind: "raw", limit: 1 })
  let activation: PublicationActivation, rawAuthority: RawAuthority | undefined
  if (capture.purpose === "raw-observation") {
    const observation = yield* boundObservation(journal, owner, capture)
    if (capture.state === "preparing") {
      yield* journal.settle(owner, id, { _tag: "AbandonUnsealed" })
      return { state: "abandoned", operations: 0 } satisfies RawPublicationDeliveryResult
    }
    if (capture.state === "abandoned") return { state: "abandoned", operations: 0 } satisfies RawPublicationDeliveryResult
    if (capture.seal === null) return yield* rawFailure("invalid", "Raw observation lacks its local seal.")
    const seal = yield* parse(RawObservationSeal, capture.seal.manifestJson)
    if (seal.manifest.parts !== capture.seal.rawUnits || capture.seal.canonicalUnits !== 0 || capture.seal.nextCheckpoint !== capture.expectedCheckpoint)
      return yield* rawFailure("invalid", "Raw observation seal changed its unit set or Canonical coverage.")
    activation = observation.canonical.receipt
    rawAuthority = observation.rawAuthority
    // This settlement records the original proof; the Raw purpose prevents any
    // Canonical checkpoint advancement, even after process restart.
    yield* journal.settle(owner, id, { _tag: "Activated", receiptJson: JSON.stringify(activation) })
  } else {
    const intent = yield* boundIntent(journal, owner, capture)
    if (capture.activationReceipt === null || capture.seal === null)
      return yield* rawFailure("invalid", "Raw delivery requires a sealed, activated capture.")
    const seal = yield* parse(Seal, capture.seal.manifestJson)
    activation = yield* checkActivation(intent, seal, yield* parse(PublicationActivation, capture.activationReceipt))
    rawAuthority = intent.rawAuthority
  }
  if (capture.state === "completed") return { state: "completed", operations: 0 } satisfies RawPublicationDeliveryResult
  if (!capture.rawEnabled || rawAuthority === undefined)
    return yield* rawFailure("invalid", "Prepared Raw capture lacks its original policy authority.")
  const binding = journal.binding
  let operations = 0, cancelReason = capture.rawCancelReason
  const startCancellation = (reason: string) => journal.settle(owner, id, { _tag: "RawCancellationStarted", reason }).pipe(
    Effect.tap(() => Effect.sync(() => { cancelReason = reason })))
  if (cancelReason === null) {
    operations++
    const policy = yield* remote.policy(binding, owner.scope.projectId)
    if (!policy.enabled || !sameRawAuthority(policy.authority, rawAuthority))
      yield* startCancellation(policy.enabled ? "Raw authority changed" : "Raw capture disabled")
  }
  while (true) {
    const page = yield* journal.inspect(owner, id, { kind: "raw", pendingOnly: true, limit: 1 })
    const unit = page.units[0]
    if (unit === undefined) return { state: "completed", operations } satisfies RawPublicationDeliveryResult
    if (operations >= maxOperations) return { state: "pending", operations } satisfies RawPublicationDeliveryResult
    if (unit.byteCount > RawPublicationWireBytes) return yield* rawFailure("invalid", "Frozen Raw unit exceeds its wire bound.")
    const bytes = yield* journal.read(owner, id, "raw", unit.ordinal)
    const chunk = yield* Effect.try({ try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      catch: () => rawFailure("invalid", "Frozen Raw unit is not valid JSON.") }).pipe(
      Effect.flatMap(value => Schema.decodeUnknownEffect(RawPublicationChunk)(value)),
      Effect.mapError(() => rawFailure("invalid", "Frozen Raw unit failed wire validation.")))
    if (chunk.sessionId !== activation.sessionId || chunk.installationId !== binding.installationId || chunk.adapterId !== owner.scope.adapterId ||
      chunk.publication.head !== activation.head || !sameRawAuthority(chunk.publication.authority, rawAuthority))
      return yield* rawFailure("binding", "Frozen Raw observation differs from its capture authority.")
    // The journal digest protects the entire envelope, not the content digest
    // declared inside it. Verify both before accepting a metadata-only receipt.
    const content = yield* Effect.try({ try: () => {
      const decoded = globalThis.atob(chunk.contentBase64)
      if (globalThis.btoa(decoded) !== chunk.contentBase64 || (decoded.length === 0 && !chunk.final)) throw new Error()
      return Uint8Array.from(decoded, char => char.charCodeAt(0))
    }, catch: () => rawFailure("invalid", "Frozen Raw content is not canonical Base64.") })
    const digest = yield* Effect.tryPromise({
      try: async () => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", content)))
        .map(byte => byte.toString(16).padStart(2, "0")).join(""),
      catch: () => rawFailure("unavailable", "Could not verify frozen Raw content.")
    })
    if (digest !== chunk.sha256) return yield* rawFailure("invalid", "Frozen Raw content differs from its declared digest.")
    const acknowledge = (receipt: RawPublicationReceipt) => checkRawReceipt(chunk, receipt).pipe(Effect.flatMap(verified =>
      journal.settle(owner, id, { _tag: "RawAcknowledged", ordinal: unit.ordinal, receiptJson: JSON.stringify(verified) })))
    operations++
    const receipt = yield* remote.receipt(binding, { sessionId: chunk.sessionId, installationId: chunk.installationId,
      adapterId: chunk.adapterId, sourceObjectId: chunk.sourceObjectId, sourceChunkId: chunk.sourceChunkId }).pipe(
      Effect.catchIf(error => error.reason === "unknown", () => Effect.succeed(null)))
    if (receipt !== null) { yield* acknowledge(receipt); continue }
    if (cancelReason !== null) {
      yield* journal.settle(owner, id, { _tag: "RawUnitCanceled", ordinal: unit.ordinal })
      continue
    }
    if (operations >= maxOperations) return { state: "pending", operations } satisfies RawPublicationDeliveryResult
    operations++
    const appended = yield* remote.append(binding, bytes).pipe(Effect.catchIf(
      error => error.reason === "disabled" || error.reason === "authority_changed",
      error => startCancellation(error.reason).pipe(Effect.as(null))))
    if (appended !== null) yield* acknowledge(appended)
    // A rejected append cannot substitute for receipt reconciliation: another
    // writer may have completed it before the policy changed.
  }
})
