import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CaptureJournal, PublicationError, PublicationTransport, beginPublicationCapture, sealPublicationCapture,
  deliverPublicationCapture, deliverPublicationRaw, RawPublicationTransport, RawPublicationError, type CaptureOwner } from "@atape/application"
import { PublicationProtocol, PublicationTargetProfile, type PublicationAttempt, type PublicationCapabilities, type PublicationPart, type RawPublicationChunk, type RawPublicationReceipt, type RawPublicationPolicy } from "@atape/domain"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeCaptureJournalLayer } from "./captureJournal.ts"

const binding = { instanceOrigin: "https://atape.test", userId: "user", installationId: "installation" }
const scope = { projectId: "project", adapterId: "opencode", sourceSessionId: "root", originKey: "origin" }
const capabilities: PublicationCapabilities = { protocol: PublicationProtocol, targetProfile: PublicationTargetProfile,
  limits: { partBytes: 4096, targetBytes: 1024 * 1024, userPendingBytes: 2 * 1024 * 1024, parts: 4096, reservations: 16,
    reservationLifetimeMs: 3600000, leaseLifetimeMs: 60000 }, statusPageSize: 100, reclaimPageSize: 32 }
const timestamp = "2026-09-10T00:00:00Z"
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const failure = (reason: PublicationError["reason"]) => new PublicationError({ reason, message: "injected remote failure" })

// Test Adapter for the real owned remote Seam. Local storage is always SQLite.
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-delivery-")); directories.push(directory)
  const path = join(directory, "capture.sqlite")
  let serial = 0, mode: "create" | "open" = "create", requests = 0
  let attempt: PublicationAttempt
  const parts = new Map<number, PublicationPart>(), sent: Uint8Array[] = []
  let lostPut = false, lostActivation = false, wrongPart = false
  let statusError: PublicationError["reason"] | undefined
  const operation = <A>(body: () => A) => Effect.try({ try: () => { requests++; return body() }, catch: cause => cause as PublicationError })
  const snapshot = () => structuredClone(attempt)
  const remote = Layer.succeed(PublicationTransport, PublicationTransport.of({
    capabilities: () => operation(() => capabilities),
    reserve: () => operation(() => ({ id: `attempt-${++serial}`, sessionId: "session", expiresAt: timestamp })),
    begin: (_, input) => operation(() => {
      parts.clear()
      attempt = { ...input, id: input.reservationId, sessionId: "session", fence: serial, leaseUntil: timestamp, expiresAt: timestamp,
        state: "open", parts: 0, retainedBytes: 0, seal: null, validatedParts: 0, candidateEvents: 0, candidateUsage: 0, activation: null }
      return snapshot()
    }),
    status: () => operation(() => { if (statusError) throw failure(statusError); return snapshot() }),
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
  const run = async <A, E>(work: Effect.Effect<A, E, CaptureJournal | PublicationTransport | RawPublicationTransport>) => {
    const currentMode = mode; mode = "open"
    return Effect.runPromise(work.pipe(Effect.provide(Layer.mergeAll(remote, rawRemote, makeCaptureJournalLayer({ path, mode: currentMode, binding,
      limits: { unitBytes: 4096, targetBytes: 1024 * 1024, pendingBytes: 2 * 1024 * 1024, unitsPerTarget: 4096 } })))))
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
  const deliverRaw = (budget = 64) => run(Effect.gen(function*() {
    const j = yield* CaptureJournal; return yield* deliverPublicationRaw(yield* j.claim(scope), "capture", budget)
  }))
  return { path, run, prepare, deliver, sent, deliverRaw, rawSent, rawReceipts, rawRequests: () => rawRequests,
    rawFault: (value: typeof rawFault) => { rawFault = value },
    receiptError: (value: typeof receiptError) => { receiptError = value },
    receiptPatch: (patch: Partial<RawPublicationReceipt>) => { receiptPatch = patch },
    policy: (enabled: boolean, userRevision = 1) => { policy = { enabled, authority: { ...authority, userRevision } } },
    requests: () => requests, snapshot,
    losePut: () => { lostPut = true }, loseActivation: () => { lostActivation = true }, badPart: () => { wrongPart = true },
    failStatus: (reason: PublicationError["reason"] | undefined) => { statusError = reason },
    change: (patch: Partial<PublicationAttempt>) => { attempt = { ...attempt, ...patch } } }
}

describe("Collector publication recovery", () => {
  it("replays the exact sealed bytes after a lost part response and keeps Raw independent", async () => {
    const f = await fixture(); await f.prepare(2, true); f.losePut()
    await expect(f.deliver()).rejects.toMatchObject({ reason: "network" })
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBeNull()
      expect(yield* j.reclaim(owner, "capture")).toBe(0)
    }))
    expect(await f.deliver()).toMatchObject({ state: "activated" })
    expect(f.sent[0]).toEqual(f.sent[1])
    expect(new TextDecoder().decode(f.sent[1])).toBe(' \n{ "source": "A", "ordinal": 0 }\n')
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBe("capture-next")
      expect(yield* j.reclaim(owner, "capture")).toBe(2)
      const raw = yield* j.inspect(owner, "capture", { kind: "raw" })
      expect(raw.capture.state).toBe("activated")
      expect(raw.units[0]).toMatchObject({ disposition: "pending", receiptJson: null, retained: true })
    }))
  })
  it("recovers lost activation and never rolls a newer checkpoint back on old replay", async () => {
    const f = await fixture(); await f.prepare(); f.loseActivation()
    await expect(f.deliver()).rejects.toMatchObject({ reason: "network" })
    expect(f.snapshot().state).toBe("activated")
    // Another writer can select a newer head and reclaim old server bodies.
    // Original proof survives; current retained part count is not its manifest.
    f.change({ parts: 0, retainedBytes: 0 })
    const first = await f.deliver(); expect(first).toMatchObject({ state: "activated", operations: 1 })
    await f.prepare(1, false, true, "later", f.snapshot().id)
    await f.deliver(64, "later")
    const requests = f.requests()
    expect(await f.deliver()).toMatchObject({ state: "activated", operations: 0 })
    expect(f.requests()).toBe(requests)
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal; expect((yield* j.claim(scope)).checkpoint).toBe("later-next") }))
  })
  it("makes durable progress through 205 parts with a three-request recovery budget", async () => {
    const f = await fixture(); await f.prepare(205)
    let result
    for (let n = 0; n < 414; n++) {
      const requests = f.requests(); result = await f.deliver(3)
      expect(f.requests() - requests).toBeLessThanOrEqual(3)
      if (result.state === "activated") break
    }
    expect(result?.state).toBe("activated")
    expect(f.sent).toHaveLength(205)
  }, 30000)
  it.each(["unknown", "network", "unauthenticated"] as const)("preserves sealed content on %s", async reason => {
    const f = await fixture(); await f.prepare(); f.failStatus(reason)
    await expect(f.deliver()).rejects.toMatchObject({ reason })
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBeNull()
      expect((yield* j.inspect(owner, "capture", { kind: "canonical" })).capture).toMatchObject({ state: "sealed", rejectionReceipt: null })
      expect(yield* j.reclaim(owner, "capture")).toBe(0)
    }))
  })
  it.each(["expired", "superseded"] as const)("requires actual rejection before reclaiming %s content", async state => {
    const f = await fixture(); await f.prepare(); f.change({ state })
    expect(await f.deliver()).toMatchObject({ state: "abandoned", operations: 2 })
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBeNull()
      expect(JSON.parse((yield* j.inspect(owner, "capture", { kind: "canonical" })).capture.rejectionReceipt!).state).toBe("rejected")
      expect(yield* j.reclaim(owner, "capture")).toBe(1)
    }))
  })
  it("abandons an incomplete source view without content effects", async () => {
    const f = await fixture(); await f.prepare(1, false, false)
    const requests = f.requests()
    expect(await f.deliver()).toMatchObject({ state: "abandoned", operations: 0 })
    expect(f.requests()).toBe(requests); expect(f.sent).toEqual([])
  })
  it("refuses changed remote fences and mismatched part receipts", async () => {
    const f = await fixture(); await f.prepare(); f.change({ fence: 999 })
    await expect(f.deliver()).rejects.toMatchObject({ reason: "invalid_response" }); expect(f.sent).toEqual([])
    f.change({ fence: 1 }); f.badPart()
    await expect(f.deliver()).rejects.toMatchObject({ reason: "invalid_response" })
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.inspect(owner, "capture", { kind: "canonical", pendingOnly: true })).units).toHaveLength(1)
    }))
  })
  it("fences a stale local owner and rejects a tampered account before network effects", async () => {
    const f = await fixture(); await f.prepare()
    let old: CaptureOwner
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal; old = yield* j.claim(scope); yield* j.claim(scope) }))
    const requests = f.requests()
    await expect(f.run(deliverPublicationCapture(old!, "capture", 3))).rejects.toMatchObject({ reason: "conflict" })
    const db = new DatabaseSync(f.path)
    const row = db.prepare("SELECT begin_json FROM captures").get()!
    const intent = JSON.parse(row.begin_json as string); intent.binding.userId = "another-user"
    db.prepare("UPDATE captures SET begin_json=?").run(JSON.stringify(intent)); db.close()
    await expect(f.deliver()).rejects.toMatchObject({ reason: "binding" })
    expect(f.requests()).toBe(requests)
  })
})


describe("Collector Raw publication recovery", () => {
  it("does not claim an old receipt when equal-length frozen content has a stale declared digest", async () => {
    const previous = await fixture(); await previous.prepare(1, true); await previous.deliver(); previous.rawFault("lose-after")
    await expect(previous.deliverRaw()).rejects.toMatchObject({ reason: "network" })
    const f = await fixture(); await f.prepare(1, true, true, "capture", "", 1, "raw B"); await f.deliver()
    f.rawReceipts.set("capture-chunk-0", previous.rawReceipts.get("capture-chunk-0")!)
    await expect(f.deliverRaw()).rejects.toMatchObject({ reason: "invalid" })
    expect(f.rawSent).toHaveLength(0)
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.inspect(owner, "capture", { kind: "raw" })).units[0]).toMatchObject({ disposition: "pending", receiptJson: null, retained: true })
    }))
  })
  it("replays only frozen bytes when a request is lost before acceptance", async () => {
    const f = await fixture(); await f.prepare(1, true); await f.deliver(); f.rawFault("lose-before")
    await expect(f.deliverRaw()).rejects.toMatchObject({ reason: "network" })
    expect(await f.deliverRaw()).toMatchObject({ state: "completed" })
    expect(f.rawSent).toHaveLength(2); expect(f.rawSent[0]).toEqual(f.rawSent[1])
    expect(new TextDecoder().decode(f.rawSent[1]).startsWith(" \n")).toBe(true)
  })
  it("recovers a lost ACK with Raw off, then finishes cancellation across reopen and re-enable", async () => {
    const f = await fixture(); await f.prepare(1, true, true, "capture", "", 5); await f.deliver(); f.rawFault("lose-after")
    await expect(f.deliverRaw()).rejects.toMatchObject({ reason: "network" })
    await f.prepare(1, false, true, "later", f.snapshot().id); await f.deliver(64, "later")
    f.policy(false, 2)
    expect(await f.deliverRaw(3)).toEqual({ state: "pending", operations: 3 })
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBe("later-next")
      const page = yield* j.inspect(owner, "capture", { kind: "raw" })
      expect(page.capture.rawCancelReason).toBe("Raw capture disabled")
      expect(page.units.map(unit => unit.disposition)).toEqual(["acknowledged", "canceled", "pending", "pending", "pending"])
      expect(page.units[0]!.receiptJson).not.toBeNull(); expect(page.units[1]!.receiptJson).toBeNull()
      expect(yield* j.reclaim(owner, "capture")).toBe(3) // Canonical and two resolved Raw bodies
    }))
    f.policy(true, 3)
    expect(await f.deliverRaw(3)).toEqual({ state: "completed", operations: 3 })
    expect(f.rawSent).toHaveLength(1)
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.inspect(owner, "capture", { kind: "raw", pendingOnly: true })).units).toHaveLength(0)
      expect(owner.checkpoint).toBe("later-next"); expect(yield* j.reclaim(owner, "capture")).toBe(3)
    }))
  })
  it("cancels old authority even if off/on happened while the process was stopped", async () => {
    const f = await fixture(); await f.prepare(1, true); await f.deliver(); f.policy(true, 3)
    expect(await f.deliverRaw()).toMatchObject({ state: "completed" }); expect(f.rawSent).toHaveLength(0)
  })
  it("persists a policy race before rechecking receipt and never retries the upload", async () => {
    const f = await fixture(); await f.prepare(1, true); await f.deliver(); f.rawFault("disable")
    expect(await f.deliverRaw(3)).toEqual({ state: "pending", operations: 3 })
    expect(await f.deliverRaw(3)).toEqual({ state: "completed", operations: 1 })
    expect(f.rawSent).toHaveLength(1)
  })
  it.each(["network", "unauthenticated", "unavailable"] as const)("retains cancellation obligations when lookup fails with %s", async reason => {
    const f = await fixture(); await f.prepare(1, true); await f.deliver(); f.policy(false); f.receiptError(reason)
    await expect(f.deliverRaw()).rejects.toMatchObject({ reason })
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.inspect(owner, "capture", { kind: "raw" })).units[0]).toMatchObject({ disposition: "pending", retained: true })
    }))
    f.receiptError(undefined); f.policy(true)
    expect(await f.deliverRaw()).toMatchObject({ state: "completed" }); expect(f.rawSent).toHaveLength(0)
  })
  it.each([{ sourceName: "different.json" }, { capturedAt: "2026-09-10T00:00:00.123001Z" }, { sizeBytes: 999 },
    { sourceChunkId: "another" }, { publication: { head: "another", authority: { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 } } }
  ] satisfies Partial<RawPublicationReceipt>[])("rejects a receipt for different immutable metadata: %j", async patch => {
    const f = await fixture(); await f.prepare(1, true); await f.deliver(); f.rawFault("lose-after")
    await expect(f.deliverRaw()).rejects.toMatchObject({ reason: "network" }); f.receiptPatch(patch)
    await expect(f.deliverRaw()).rejects.toMatchObject({ reason: "invalid_response" }); expect(f.rawSent).toHaveLength(1)
  })
  it("makes bounded durable progress through 205 Raw obligations", async () => {
    const f = await fixture(); await f.prepare(1, true, true, "capture", "", 205); await f.deliver()
    let result
    for (let n = 0; n < 205; n++) {
      const before = f.rawRequests(); result = await f.deliverRaw(3)
      expect(f.rawRequests() - before).toBeLessThanOrEqual(3)
    }
    expect(result).toMatchObject({ state: "completed" }); expect(f.rawSent).toHaveLength(205)
  }, 30000)
  it("requires activation before any Raw request", async () => {
    const f = await fixture(); await f.prepare(1, true)
    await expect(f.deliverRaw()).rejects.toMatchObject({ reason: "invalid" }); expect(f.rawRequests()).toBe(0)
  })
})
