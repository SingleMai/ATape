import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { openOpenCodeCapture } from "../../../../../adapters/opencode/src/capture.ts"
import { createHash } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CaptureJournal, PublicationError, PublicationTransport, beginPublicationCapture, sealPublicationCapture,
  deliverPublicationCapture, deliverPublicationRaw, beginRawObservation, sealRawObservation, RawPublicationTransport, RawPublicationError,
  SecretRedactor, makeSecretRedactorLayer } from "@atape/application"
import { PublicationProtocol, PublicationTargetProfile, type PublicationAttempt, type PublicationCapabilities, type PublicationPart,
  type RawPublicationChunk, type RawPublicationReceipt, type RawPublicationPolicy } from "@atape/domain"
import { Effect, Layer } from "effect"
import { expect } from "vitest"
import { makeCaptureJournalLayer } from "../captureJournal.ts"

export const binding = { instanceOrigin: "https://atape.test", userId: "user", installationId: "installation" }
export const scope = { projectId: "project", adapterId: "opencode", sourceSessionId: "root", originKey: "origin" }
export const capabilities: PublicationCapabilities = { protocol: PublicationProtocol, targetProfile: PublicationTargetProfile,
  limits: { partBytes: 4096, targetBytes: 1024 * 1024, userPendingBytes: 2 * 1024 * 1024, parts: 4096, reservations: 16,
    reservationLifetimeMs: 3600000, leaseLifetimeMs: 60000 }, statusPageSize: 100, reclaimPageSize: 32 }
export const timestamp = "2026-09-10T00:00:00Z"
export const directories: string[] = []
export const failure = (reason: PublicationError["reason"]) => new PublicationError({ reason, message: "injected remote failure" })

// Test Adapter for the real owned remote Seam. Local storage is always SQLite.
export const fixture = async (partBytes = 4096) => {
  const directory = await mkdtemp(join(tmpdir(), "atape-delivery-")); directories.push(directory)
  const path = join(directory, "capture.sqlite")
  let serial = 0, mode: "create" | "open" = "create", requests = 0
  let attempt: PublicationAttempt
  const parts = new Map<number, PublicationPart>(), sent: Uint8Array[] = []
  let lostPut = false, lostActivation = false, wrongPart = false
  let statusHangs = false
  let statusError: PublicationError["reason"] | undefined
  const operation = <A>(body: () => A) => Effect.try({ try: () => { requests++; return body() }, catch: cause => cause as PublicationError })
  const snapshot = () => structuredClone(attempt)
  const remote = Layer.succeed(PublicationTransport, PublicationTransport.of({
    capabilities: () => operation(() => ({ ...capabilities, limits: { ...capabilities.limits, partBytes } })),
    reserve: () => operation(() => ({ id: `attempt-${++serial}`, sessionId: "session", expiresAt: timestamp })),
    begin: (_, input) => operation(() => {
      parts.clear()
      attempt = { ...input, id: input.reservationId, sessionId: "session", fence: serial, leaseUntil: timestamp, expiresAt: timestamp,
        state: "open", parts: 0, retainedBytes: 0, seal: null, validatedParts: 0, candidateEvents: 0, candidateUsage: 0, activation: null }
      return snapshot()
    }),
    status: () => statusHangs ? Effect.never : operation(() => { if (statusError) throw failure(statusError); return snapshot() }),
    renew: () => operation(snapshot),
    put: (_, id, part, bytes) => operation(() => {
      expect(id).toBe(attempt.id)
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(part.sha256)
      expect(bytes.byteLength).toBe(part.bytes)
      sent.push(new Uint8Array(bytes))
      const old = parts.get(part.ordinal)
      if (old) expect(part).toEqual(old)
      parts.set(part.ordinal, part); attempt = { ...attempt, parts: parts.size }
      if (lostPut) { lostPut = false; throw failure("network") }
      return wrongPart ? { ...part, sha256: "f".repeat(64) } : part
    }),
    seal: (_, id, manifest) => operation(() => {
      expect(id).toBe(attempt.id)
      const lines = [...parts.values()].sort((a, b) => a.ordinal - b.ordinal).map(p => `${p.ordinal}:${p.bytes}:${p.sha256}\n`).join("")
      expect(manifest).toEqual({ parts: parts.size, bytes: [...parts.values()].reduce((n, p) => n + p.bytes, 0), sha256: createHash("sha256").update(lines).digest("hex") })
      attempt = { ...attempt, state: "sealed", seal: manifest }; return snapshot()
    }),
    validate: () => operation(() => {
      const validatedParts = attempt.validatedParts + 1
      attempt = { ...attempt, validatedParts, state: validatedParts === parts.size ? "validated" : "validating" }; return snapshot()
    }),
    activate: () => operation(() => {
      const receipt = { head: attempt.id, sessionId: attempt.sessionId, captureId: attempt.captureId, baseHead: attempt.baseHead,
        fence: attempt.fence, transformVersion: attempt.transformVersion, manifest: attempt.seal!, activatedAt: timestamp }
      attempt = { ...attempt, state: "activated", activation: receipt }
      if (lostActivation) { lostActivation = false; throw failure("network") }
      return receipt
    }),
    reject: () => operation(() => { attempt = { ...attempt, state: "rejected" }; return snapshot() })
  }))
  const authority = { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 } as const
  let policy: RawPublicationPolicy = { enabled: true, authority: { ...authority } }
  let rawRequests = 0
  let rawFault: "none" | "lose-before" | "lose-after" | "disable" = "none"
  let receiptError: RawPublicationError["reason"] | undefined
  let receiptPatch: Partial<RawPublicationReceipt> = {}
  const rawReceipts = new Map<string, RawPublicationReceipt>(), rawSent: Uint8Array[] = []
  const rawOperation = <A>(body: () => A) => Effect.try({ try: () => { rawRequests++; return body() }, catch: cause => cause as RawPublicationError })
  const rawRemote = Layer.succeed(RawPublicationTransport, RawPublicationTransport.of({
    policy: () => rawOperation(() => structuredClone(policy)),
    receipt: (_, identity) => rawOperation(() => {
      if (receiptError) throw new RawPublicationError({ reason: receiptError, message: "injected lookup error" })
      const receipt = rawReceipts.get(identity.sourceChunkId)
      if (!receipt) throw new RawPublicationError({ reason: "unknown", message: "missing receipt" })
      return { ...structuredClone(receipt), ...receiptPatch }
    }),
    append: (_, bytes) => rawOperation(() => {
      rawSent.push(new Uint8Array(bytes))
      const fault = rawFault; rawFault = "none"
      if (fault === "disable") throw new RawPublicationError({ reason: "disabled", message: "policy changed during request" })
      if (fault === "lose-before") throw new RawPublicationError({ reason: "network", message: "request lost" })
      const { contentBase64, ...metadata } = JSON.parse(new TextDecoder().decode(bytes)) as RawPublicationChunk
      const receipt = { ...metadata, capturedAt: metadata.capturedAt.replace(".123000Z", ".123Z"),
        objectId: `object-${metadata.sourceObjectId}`, sizeBytes: Buffer.from(contentBase64, "base64").length }
      rawReceipts.set(receipt.sourceChunkId, receipt)
      if (fault === "lose-after") throw new RawPublicationError({ reason: "network", message: "response lost" })
      return { ...receipt, ...receiptPatch }
    })
  }))
  const run = async <A, E>(work: Effect.Effect<A, E, CaptureJournal | PublicationTransport | RawPublicationTransport | SecretRedactor>) => {
    const currentMode = mode; mode = "open"
    return Effect.runPromise(work.pipe(Effect.provide(Layer.mergeAll(remote, rawRemote, makeSecretRedactorLayer(["SENSITIVE_TEST_TOKEN"]), makeCaptureJournalLayer({ path, mode: currentMode, binding,
      limits: { unitBytes: partBytes, targetBytes: 1024 * 1024, pendingBytes: 2 * 1024 * 1024, metadataEntries: 100_000, unitsPerTarget: 4096, recordsPerTarget: 4096 } })))))
  }
  const prepare = (count = 1, raw = false, seal = true, id = "capture", baseHead = "", rawCount = 1, rawContent = "raw A") => run(Effect.gen(function*() {
    const j = yield* CaptureJournal, owner = yield* j.claim(scope)
    yield* beginPublicationCapture(owner, { captureId: id, baseHead, transformVersion: "projection-1", rawEnabled: raw, ...(raw ? { rawAuthority: { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 } as const } : {}) })
    for (let n = 0; n < count; n++) yield* j.append(owner, id, { kind: "canonical", ordinal: n,
      bytes: new TextEncoder().encode(` \n{ "source": "A", "ordinal": ${n} }\n`) })
    if (raw) for (let ordinal = 0; ordinal < rawCount; ordinal++) {
      const chunk: RawPublicationChunk = { protocolVersion: "atape.raw.v1", sessionId: "session", installationId: binding.installationId,
        adapterId: scope.adapterId, sourceObjectId: `${id}-object-${ordinal}`, sourceChunkId: `${id}-chunk-${ordinal}`,
        sourceName: "observation.json", mediaType: "application/json", adapterVersion: "0.1.0", capturedAt: "2026-09-10T00:00:00.123000Z",
        clientRedacted: true, generation: 1, offset: 0, final: true, contentBase64: Buffer.from(rawContent).toString("base64"),
        sha256: createHash("sha256").update("raw A").digest("hex"), publication: { head: attempt.id, authority } }
      yield* j.append(owner, id, { kind: "raw", ordinal, bytes: new TextEncoder().encode(` \n${JSON.stringify(chunk)}\n`) })
    }
    if (seal) yield* sealPublicationCapture(owner, id, { nextCheckpoint: `${id}-next`, rawUnits: raw ? rawCount : 0 })
  }))
  const deliver = (budget = 64, id = "capture") => run(Effect.gen(function*() {
    const j = yield* CaptureJournal
    return yield* deliverPublicationCapture(yield* j.claim(scope), id, budget)
  }))
  const deliverRaw = (budget = 64, id = "capture") => run(Effect.gen(function*() {
    const j = yield* CaptureJournal; return yield* deliverPublicationRaw(yield* j.claim(scope), id, budget)
  }))
  const observe = (count = 1, seal = true, id = "raw-observation", canonicalCaptureId = "capture") => run(Effect.gen(function*() {
    const j = yield* CaptureJournal, owner = yield* j.claim(scope)
    const started = yield* beginRawObservation(owner, { observationId: id, canonicalCaptureId })
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const content = `fresh B ${ordinal}`
      const chunk: RawPublicationChunk = { protocolVersion: "atape.raw.v1", sessionId: started.sessionId, installationId: binding.installationId,
        adapterId: scope.adapterId, sourceObjectId: `${id}-object-${ordinal}`, sourceChunkId: `${id}-chunk-${ordinal}`,
        sourceName: "observation.json", mediaType: "application/json", adapterVersion: "0.1.0", capturedAt: "2026-09-10T00:01:00.123456Z",
        clientRedacted: true, generation: 1, offset: 0, final: true, contentBase64: Buffer.from(content).toString("base64"),
        sha256: createHash("sha256").update(content).digest("hex"), publication: { head: started.head, authority: started.rawAuthority } }
      yield* j.append(owner, id, { kind: "raw", ordinal, bytes: new TextEncoder().encode(` \n${JSON.stringify(chunk)}\n`) })
    }
    if (seal) yield* sealRawObservation(owner, id, count)
    return started
  }))
  return { path, run, prepare, deliver, sent, remote, rawRemote, deliverRaw, observe, rawSent, rawReceipts, rawRequests: () => rawRequests,
    rawFault: (value: typeof rawFault) => { rawFault = value },
    receiptError: (value: typeof receiptError) => { receiptError = value },
    receiptPatch: (patch: Partial<RawPublicationReceipt>) => { receiptPatch = patch },
    policy: (enabled: boolean, userRevision = 1) => { policy = { enabled, authority: { ...authority, userRevision } } },
    requests: () => requests, snapshot,
    losePut: () => { lostPut = true }, loseActivation: () => { lostActivation = true }, badPart: () => { wrongPart = true },
    hangStatus: (enabled: boolean) => { statusHangs = enabled },
    failStatus: (reason: PublicationError["reason"] | undefined) => { statusError = reason },
    change: (patch: Partial<PublicationAttempt>) => { attempt = { ...attempt, ...patch } } }
}

export const nativePreparationSource = async () => {
  const evidence = JSON.parse(await readFile(new URL("../../../../../adapters/opencode/src/fixtures/native-v1.json", import.meta.url), "utf8")) as {
    rootID: string; ddl: string[]; rows: Record<string, Record<string, SQLInputValue>[]>
  }
  const directory = await mkdtemp(join(tmpdir(), "atape-host-native-")); directories.push(directory)
  const path = join(directory, "opencode.db"), db = new DatabaseSync(path)
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL")
  for (const ddl of evidence.ddl) db.exec(ddl)
  for (const [table, rows] of Object.entries(evidence.rows)) for (const row of rows) {
    const keys = Object.keys(row)
    db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
  }
  db.prepare("UPDATE part SET data=json_set(data,'$.text',?) WHERE json_extract(data,'$.type')='text'").run("SENSITIVE_TEST_TOKEN " + "native text ".repeat(30))
  db.close()
  const source = (rawEnabled = false) => openOpenCodeCapture({ path, sessionId: evidence.rootID, rawEnabled,
    limits: { rowBytes: 65536, pageBytes: 262144, pageRows: 2, records: 1000, threads: 20, durationMs: 10000 },
    projection: { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 } })
  const metadata = await Effect.runPromise(Effect.scoped(source()))
  const ownerScope = { ...scope, sourceSessionId: metadata.origin.sourceId, originKey: metadata.origin.originKey }
  return { path, source, metadata, ownerScope }
}
