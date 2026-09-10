import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CaptureJournal, PublicationError, PublicationTransport, beginPublicationCapture, sealPublicationCapture,
  deliverPublicationCapture, type CaptureOwner } from "@atape/application"
import { PublicationProtocol, PublicationTargetProfile, type PublicationAttempt, type PublicationCapabilities, type PublicationPart } from "@atape/domain"
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
  const run = async <A, E>(work: Effect.Effect<A, E, CaptureJournal | PublicationTransport>) => {
    const currentMode = mode; mode = "open"
    return Effect.runPromise(work.pipe(Effect.provide(Layer.merge(remote, makeCaptureJournalLayer({ path, mode: currentMode, binding,
      limits: { unitBytes: 4096, targetBytes: 1024 * 1024, pendingBytes: 2 * 1024 * 1024, unitsPerTarget: 4096 } })))))
  }
  const prepare = (count = 1, raw = false, seal = true, id = "capture", baseHead = "") => run(Effect.gen(function*() {
    const j = yield* CaptureJournal, owner = yield* j.claim(scope)
    yield* beginPublicationCapture(owner, { captureId: id, baseHead, transformVersion: "projection-1", rawEnabled: raw })
    for (let n = 0; n < count; n++) yield* j.append(owner, id, { kind: "canonical", ordinal: n,
      bytes: new TextEncoder().encode(` \n{ "source": "A", "ordinal": ${n} }\n`) })
    if (raw) yield* j.append(owner, id, { kind: "raw", ordinal: 0, bytes: new TextEncoder().encode("raw A") })
    if (seal) yield* sealPublicationCapture(owner, id, { nextCheckpoint: `${id}-next`, rawUnits: raw ? 1 : 0 })
  }))
  const deliver = (budget = 64, id = "capture") => run(Effect.gen(function*() {
    const j = yield* CaptureJournal
    return yield* deliverPublicationCapture(yield* j.claim(scope), id, budget)
  }))
  return { path, run, prepare, deliver, sent, requests: () => requests, snapshot,
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
