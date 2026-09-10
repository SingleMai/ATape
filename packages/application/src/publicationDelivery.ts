import { Context, Effect, Schema } from "effect"
import {
  PublicationActivation, PublicationAttempt, PublicationBegin, PublicationBinding, PublicationCapabilities,
  PublicationManifest, PublicationProtocol, PublicationScope,
  type PublicationPart, type PublicationReservation
} from "@atape/domain"
import { CaptureJournal, type CaptureClaim, type CaptureOwner, type CaptureSummary } from "./captureJournal.ts"

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
  scope: PublicationScope, sessionId: Schema.String, begin: PublicationBegin, capabilities: PublicationCapabilities })
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
const boundIntent = (journal: CaptureJournal["Service"], owner: CaptureOwner, capture: CaptureSummary) => Effect.gen(function*() {
  const intent = yield* parse(Intent, capture.beginJson)
  const b = journal.binding, s = owner.scope
  if (intent.binding.instanceOrigin !== b.instanceOrigin || intent.binding.userId !== b.userId || intent.binding.installationId !== b.installationId ||
    intent.scope.installationId !== b.installationId || intent.scope.projectId !== s.projectId || intent.scope.adapterId !== s.adapterId ||
    intent.scope.sourceSessionId !== s.sourceSessionId || intent.scope.originKey !== s.originKey || intent.begin.captureId !== capture.id)
    return yield* failure("binding", "Publication metadata differs from the journal owner.")
  return intent
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
  readonly captureId: string; readonly baseHead: string; readonly transformVersion: string; readonly rawEnabled: boolean
}) => Effect.gen(function*() {
  const journal = yield* CaptureJournal, remote = yield* PublicationTransport
  // Check the owner before consuming remote reservation quota.
  yield* journal.pending(owner, undefined, 1)
  const binding = journal.binding
  const scope = yield* decode(PublicationScope, { ...owner.scope, installationId: binding.installationId })
  const capabilities = yield* remote.capabilities(binding)
  const reservation = yield* remote.reserve(binding, scope)
  const begin = yield* decode(PublicationBegin, { reservationId: reservation.id, captureId: input.captureId,
    baseHead: input.baseHead, transformVersion: input.transformVersion })
  const intent: Intent = { protocol: PublicationProtocol, binding, scope, sessionId: reservation.sessionId, begin, capabilities }
  yield* journal.reserve(owner, { id: input.captureId, expectedCheckpoint: owner.checkpoint,
    beginJson: JSON.stringify(intent), rawEnabled: input.rawEnabled })
  const attempt = yield* checkAttempt(intent, yield* remote.begin(binding, begin))
  if (attempt.state !== "open") return yield* failure("conflict", "A new capture requires an open publication attempt.")
  return { sessionId: attempt.sessionId, attemptId: attempt.id, limits: capabilities.limits }
})

/** Close the source view before calling. Only metadata is read while computing
 * the ordered manifest; payloads remain in SQLite. This is the content-send gate.
 */
export const sealPublicationCapture = (owner: CaptureOwner, id: string, input: {
  readonly nextCheckpoint: string; readonly rawUnits: number
}) => Effect.gen(function*() {
  const journal = yield* CaptureJournal, remote = yield* PublicationTransport
  const { capture } = yield* journal.inspect(owner, id, { kind: "canonical", limit: 1 })
  const intent = yield* boundIntent(journal, owner, capture)
  if (capture.seal !== null) {
    if (capture.seal.nextCheckpoint !== input.nextCheckpoint || capture.seal.rawUnits !== input.rawUnits)
      return yield* failure("conflict", "Capture seal cannot change on replay.")
    return
  }
  if (capture.state !== "preparing") return yield* failure("conflict", "Capture is not preparing.")
  const lines: string[] = []
  let ordinal = 0, bytes = 0
  while (true) {
    const page = yield* journal.inspect(owner, id, { kind: "canonical", afterOrdinal: ordinal - 1, limit: 100 })
    for (const unit of page.units) {
      if (unit.ordinal !== ordinal || !unit.retained || unit.byteCount > intent.capabilities.limits.partBytes || ordinal >= intent.capabilities.limits.parts)
        return yield* failure("capacity", "Prepared publication units exceed the negotiated bounds.")
      lines.push(`${ordinal}:${unit.byteCount}:${unit.digest}\n`)
      ordinal++; bytes += unit.byteCount
      if (bytes > intent.capabilities.limits.targetBytes) return yield* failure("capacity", "Prepared target exceeds publication capacity.")
    }
    if (page.units.length < 100) break
  }
  const sha256 = yield* Effect.tryPromise({
    try: async () => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines.join(""))))),
    catch: () => failure("unavailable", "Could not hash the prepared publication manifest.")
  }).pipe(Effect.map(bytes => bytes.map(byte => byte.toString(16).padStart(2, "0")).join("")))
  const manifest = yield* decode(PublicationManifest, { parts: ordinal, bytes, sha256 })
  const attempt = yield* checkAttempt(intent, yield* remote.status(journal.binding, intent.begin.reservationId))
  if (attempt.state !== "open" || attempt.parts !== 0) return yield* failure("conflict", "An unsealed capture cannot already have remote content.")
  yield* journal.seal(owner, id, { canonicalUnits: ordinal, rawUnits: input.rawUnits, nextCheckpoint: input.nextCheckpoint,
    manifestJson: JSON.stringify({ protocol: PublicationProtocol, fence: attempt.fence, manifest } satisfies Seal) })
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
