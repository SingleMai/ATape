import { Effect, Schema } from "effect"
import { RawPublicationChunk, RawPublicationWireBytes, sameRawAuthority, type AdapterRawReference, type RawAuthority } from "@atape/domain"
import { CaptureJournal, type CaptureOwner } from "./captureJournal.ts"
import { SecretRedactor, type SecretRedactorService } from "./collector.ts"
import { captureRawAuthority } from "./publicationDelivery.ts"

export type RawPreparationLimits = {
  readonly objectBytes: number
  readonly wireBytes: number
  readonly targetBytes: number
  readonly units: number
}
export class RawPreparationError extends Schema.TaggedError<RawPreparationError>()("RawPreparationError", {
  reason: Schema.Literals(["invalid", "binding", "capacity"]), message: Schema.String
}) {}
const fail = (message: string) => new RawPreparationError({ reason: "invalid", message })
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const digest = (bytes: Uint8Array) => Effect.tryPromise({
  try: async () => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))).map(byte => byte.toString(16).padStart(2, "0")).join(""),
  catch: () => fail("Raw preparation could not fingerprint content.")
})
const hash = (value: unknown) => digest(encode(value))
const Version = "atape.host-raw.v1"
const objectId = (profile: string, captureId: string, ordinal: number) => hash([profile, captureId, ordinal]).pipe(Effect.map(value => `r_${value}`))
export const validateRawPreparationLimits = (limits: RawPreparationLimits) => Effect.gen(function*() {
  for (const [value, maximum] of [[limits.objectBytes, 3 * 1024 * 1024], [limits.wireBytes, RawPublicationWireBytes],
    [limits.targetBytes, Number.MAX_SAFE_INTEGER], [limits.units, 1_000_000]] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return yield* fail("Raw preparation needs explicit bounded admission.")
  if (limits.targetBytes < limits.wireBytes) return yield* fail("Raw target admission is smaller than its wire unit admission.")
})
class Gap extends Error {
  readonly reason: "limit" | "redaction"
  constructor(reason: "limit" | "redaction") { super("Raw row cannot be safely archived."); this.reason = reason }
}

/** Mask actual JSON values, including nested JSON TEXT. Strings retain their native
 * encoding when no masking occurs. Only the returned masked value may be persisted. */
const maskRow = (redactor: SecretRedactorService, input: unknown): { row: unknown } | { gap: "limit" | "redaction" } => {
  let nodes = 0, bytes = 0
  const charge = (text: string) => {
    bytes += new TextEncoder().encode(text).byteLength
    if (bytes > 32 * 1024 * 1024) throw new Gap("limit")
  }
  // JSON.parse discards earlier duplicate members before a reviver runs. Scan
  // valid JSON tokens first, comparing decoded keys, so no hidden earlier value
  // can survive in an unchanged native JSON TEXT string.
  const checkMembers = (text: string, depth: number) => {
    const stack: Array<{ keys: Set<string> | null; key: boolean }> = []
    const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g
    for (const token of text.matchAll(tokens)) {
      if (++nodes > 100_000) throw new Gap("limit")
      const value = token[0], current = stack[stack.length - 1]
      if (value === "{" || value === "[") {
        if (stack.length + depth >= 32) throw new Gap("limit")
        stack.push({ keys: value === "{" ? new Set() : null, key: true })
      } else if (value === "}" || value === "]") stack.pop()
      else if (value === "," && current) current.key = true
      else if (value.startsWith('"') && current?.keys && current.key) {
        const key = JSON.parse(value) as string
        if (current.keys.has(key)) throw new Gap("redaction")
        current.keys.add(key); current.key = false
      }
    }
  }
  const walk = (value: unknown, depth: number): { value: unknown; changed: boolean } => {
    if (++nodes > 100_000 || depth > 32) throw new Gap("limit")
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return { value, changed: false }
    if (typeof value === "string") {
      charge(value)
      let text = value, changed = false
      if (/^[\s]*[\[{"]/.test(text)) {
        let parsed: unknown, valid = false
        try { parsed = JSON.parse(text); valid = true } catch { /* ordinary source text */ }
        if (valid) {
          checkMembers(text, depth)
          const nested = walk(parsed, depth + 1)
          if (nested.changed) { text = JSON.stringify(nested.value); changed = true }
        }
      }
      const masked = redactor.redact(text)
      return { value: masked.value, changed: changed || masked.value !== value }
    }
    if (typeof value !== "object" || value === null || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Gap("redaction")
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null)
    let changed = false
    for (const [key, child] of Object.entries(value)) {
      charge(key)
      const maskedKey = Array.isArray(value) ? key : redactor.redact(key).value
      if (Object.hasOwn(result, maskedKey)) throw new Gap("redaction")
      const nested = walk(child, depth + 1)
      Object.defineProperty(result, maskedKey, { value: nested.value, enumerable: true, configurable: true, writable: true })
      changed ||= maskedKey !== key || nested.changed
    }
    // The shared policy also recognizes credentials by their surrounding key.
    const serialized = JSON.stringify(result), masked = redactor.redact(serialized).value
    if (serialized !== masked) {
      try { return { value: JSON.parse(masked), changed: true } } catch { throw new Gap("redaction") }
    }
    return { value: result, changed }
  }
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Gap("redaction")
    return { row: walk(input, 0).value }
  } catch (cause) { return { gap: cause instanceof Gap ? cause.reason : "redaction" } }
}

/** Internal collaborator of source preparation. Holds one object and at most 100
 * bindings; only final wire chunks enter the journal. It never performs HTTP. */
export const createRawPreparation = (owner: CaptureOwner, captureId: string, input: {
  readonly profile: string; readonly sessionId: string; readonly head: string; readonly authority: RawAuthority
  readonly adapterVersion: string; readonly observedAt: string; readonly limits: RawPreparationLimits
}) => Effect.gen(function*() {
  yield* validateRawPreparationLimits(input.limits)
  const journal = yield* CaptureJournal, redactor = yield* SecretRedactor
  const profile = `${Version}:${input.profile}`
  if (new TextEncoder().encode(profile).byteLength > 500) return yield* fail("Raw projection profile exceeds its bound.")
  const previousId = (yield* journal.coverage(owner)).observedRawCaptureId
  const previous = previousId === null ? null : (yield* journal.inspect(owner, previousId, { kind: "raw", limit: 1 })).capture
  const reusableCapture = previous?.activationReceipt !== null && previous?.activationReceipt !== undefined ? previousId : null
  let ordinal = 0, totalBytes = 0, records = 0, reused = 0, gaps = 0
  let entries: Record<string, { revision: number; row: unknown }> = Object.create(null)
  let keys: string[] = []
  let currentObjectId = yield* objectId(profile, captureId, ordinal)
  const envelope = () => ({ profile, observedAt: input.observedAt, records: entries })
  const emptyBytes = encode(envelope()).byteLength
  let contentBytes = emptyBytes
  const metadata = () => ({ protocolVersion: "atape.raw.v1" as const, sessionId: input.sessionId, installationId: journal.binding.installationId,
    adapterId: owner.scope.adapterId, sourceObjectId: currentObjectId, sourceChunkId: `${currentObjectId}_0`,
    sourceName: "source-records.json", mediaType: "application/json", adapterVersion: input.adapterVersion, capturedAt: input.observedAt,
    clientRedacted: true as const, generation: 1 as const, offset: 0, final: true, publication: { head: input.head, authority: input.authority } })
  for (const value of Object.values(metadata())) if (typeof value === "string" &&
    (!value.trim() || value.includes("\0") || new TextEncoder().encode(value).byteLength > 512))
    return yield* fail("Raw observation metadata exceeds its byte bounds.")
  yield* Schema.decodeUnknownEffect(RawPublicationChunk)({ ...metadata(), sha256: "0".repeat(64), contentBase64: "" }).pipe(
    Effect.mapError(() => fail("Raw observation metadata failed validation.")))
  if (!Number.isFinite(Date.parse(input.observedAt))) return yield* fail("Raw observation time is invalid.")
  const wireOverhead = encode({ ...metadata(), sha256: "0".repeat(64), contentBase64: "" }).byteLength
  const wireSize = (bytes: number) => wireOverhead + 4 * Math.ceil(bytes / 3)
  const flush = () => Effect.gen(function*() {
    if (keys.length === 0) return
    const content = encode(envelope())
    let binary = ""
    for (let start = 0; start < content.length; start += 8192) binary += String.fromCharCode(...content.subarray(start, start + 8192))
    const chunk = yield* Schema.decodeUnknownEffect(RawPublicationChunk)({ ...metadata(), sha256: yield* digest(content), contentBase64: btoa(binary) }).pipe(
      Effect.mapError(() => fail("Prepared Raw chunk failed validation.")))
    const bytes = encode(chunk)
    if (content.byteLength !== contentBytes || content.byteLength > input.limits.objectBytes || bytes.byteLength > input.limits.wireBytes || ordinal >= input.limits.units || bytes.byteLength > input.limits.targetBytes - totalBytes)
      return yield* fail("Prepared Raw packing exceeded its admitted budget.")
    yield* journal.append(owner, captureId, { kind: "raw", ordinal, bytes })
    for (const key of keys) yield* journal.bindRecord(owner, captureId, { kind: "raw", key }, { _tag: "Unit", ordinal })
    totalBytes += bytes.byteLength; ordinal++; keys = []; entries = Object.create(null); contentBytes = emptyBytes
    currentObjectId = yield* objectId(profile, captureId, ordinal)
  })
  const record = (recordKey: string, raw: unknown) => Effect.gen(function*() {
    if (typeof recordKey !== "string" || !recordKey || recordKey.includes("\0") || new TextEncoder().encode(recordKey).byteLength > 500 || raw === undefined)
      return yield* fail("Raw-enabled source omitted a bounded record identity or archive row.")
    const key = yield* hash(recordKey), masked = maskRow(redactor, raw)
    const fingerprint = yield* hash(masked)
    const allocated = yield* journal.record(owner, captureId, { kind: "raw", key, fingerprint, projectionVersion: profile })
    records++
    const unavailable = (reason: "limit" | "redaction") => journal.bindRecord(owner, captureId, { kind: "raw", key }, { _tag: "Unavailable", reason }).pipe(
      Effect.map((): AdapterRawReference => { gaps++; return { _tag: "unavailable", reason: `Raw ${reason} gap` } }))
    if ("gap" in masked) return yield* unavailable(masked.gap)
    if (reusableCapture !== null) {
      const prior = yield* journal.recordStatus(owner, reusableCapture, { kind: "raw", key })
      if (prior?.unit && prior.revision === allocated.revision && prior.fingerprint === fingerprint && prior.projectionVersion === profile &&
        (prior.disposition === "acknowledged" || prior.disposition === "pending")) {
        const owning = (yield* journal.inspect(owner, prior.unit.captureId, { kind: "raw", limit: 1 })).capture
        const authority = yield* captureRawAuthority(owner, prior.unit.captureId)
        if (prior.disposition === "acknowledged" || owning.rawCancelReason === null && authority !== undefined && sameRawAuthority(authority, input.authority)) {
          yield* journal.bindRecord(owner, captureId, { kind: "raw", key }, { _tag: "Unit", captureId: reusableCapture, ordinal: prior.unit.ordinal })
          reused++
          return { _tag: "object", sourceObjectId: yield* objectId(profile, prior.unit.captureId, prior.unit.ordinal), fragment: `/records/${key}` } satisfies AdapterRawReference
        }
      }
    }
    if (keys.includes(key)) return yield* fail("A source observation repeated a Raw record.")
    const entry = { revision: allocated.revision, row: masked.row }
    const entryBytes = encode(key).byteLength + 1 + encode(entry).byteLength
    const candidateSize = () => contentBytes + entryBytes + (keys.length === 0 ? 0 : 1)
    if (keys.length === 100 || candidateSize() > input.limits.objectBytes || wireSize(candidateSize()) > input.limits.wireBytes) yield* flush()
    const size = candidateSize()
    if (size > input.limits.objectBytes || wireSize(size) > input.limits.wireBytes || ordinal >= input.limits.units || wireSize(size) > input.limits.targetBytes - totalBytes) {
      return yield* unavailable("limit")
    }
    entries[key] = entry; keys.push(key); contentBytes = size
    return { _tag: "object", sourceObjectId: currentObjectId, fragment: `/records/${key}` } satisfies AdapterRawReference
  })
  return { record, finish: () => flush().pipe(Effect.map(() => ({ units: ordinal, bytes: totalBytes, records, reused, gaps }))) }
})
