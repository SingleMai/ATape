import { createHash } from "node:crypto"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { CaptureJournal, PublicationError, PublicationTransport, beginPublicationCapture, sealPublicationCapture,
  deliverPublicationCapture, deliverPublicationRaw, beginRawObservation, sealRawObservation, RawPublicationTransport, RawPublicationError, type CaptureOwner,
  comparePublicationSource, preparePublicationCanonical, prepareRawObservation, SecretRedactor, makeSecretRedactorLayer } from "@atape/application"
import { PublicationProtocol, PublicationTargetProfile, type PublicationAttempt, type PublicationCapabilities, type PublicationPart, type RawPublicationChunk, type RawPublicationReceipt, type RawPublicationPolicy } from "@atape/domain"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeCaptureJournalLayer } from "./captureJournal.ts"
import { openOpenCodeCapture } from "../../../../adapters/opencode/src/capture.ts"

import { binding, scope, capabilities, timestamp, directories, failure, fixture, nativePreparationSource } from "./fixtures/publication-test-support.ts"
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe("Collector publication recovery", () => {
  it("publishes tracked coverage and recovers a Raw-only explicit gap without sending content", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "tracked", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      yield* j.append(owner, "tracked", { kind: "canonical", ordinal: 0, bytes: new TextEncoder().encode("prepared Canonical") })
      for (const kind of ["session", "thread"] as const) {
        yield* j.record(owner, "tracked", { kind, key: "root", fingerprint: createHash("sha256").update(kind).digest("hex"), projectionVersion: "v1" })
        yield* j.bindRecord(owner, "tracked", { kind, key: "root" }, { _tag: "Unit", ordinal: 0 })
      }
      yield* sealPublicationCapture(owner, "tracked", { nextCheckpoint: "tracked-next", rawUnits: 0,
        records: { canonical: { session: 1, thread: 1, event: 0, usage: 0 } } })
    }))
    expect(await f.deliver(64, "tracked")).toMatchObject({ state: "activated" })
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.coverage(owner)).canonicalCaptureId).toBe("tracked")
      yield* beginRawObservation(owner, { observationId: "gap", canonicalCaptureId: "tracked" })
      yield* j.record(owner, "gap", { kind: "raw", key: "part/oversized", fingerprint: createHash("sha256").update("limited row metadata").digest("hex"), projectionVersion: "v1" })
      yield* j.bindRecord(owner, "gap", { kind: "raw", key: "part/oversized" }, { _tag: "Unavailable", reason: "limit" })
      yield* sealRawObservation(owner, "gap", 0, { raw: { records: 1, scopeComplete: false } })
    }))
    expect(await f.deliverRaw(64, "gap")).toMatchObject({ state: "completed" })
    expect(f.rawSent).toEqual([])
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBe("tracked-next")
      expect((yield* j.records(owner, "gap", { kind: "raw" }))[0]).toMatchObject({ disposition: "unavailable", unavailableReason: "limit" })
      expect((yield* j.coverage(owner)).canonicalCaptureId).toBe("tracked")
    }))
  })
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


describe("Independent fresh Raw observations", () => {
  it("refuses a fresh observation while Raw is off before reserving source content", async () => {
    const f = await fixture(); await f.prepare(); await f.deliver(); f.policy(false)
    const canonicalRequests = f.requests()
    await expect(f.observe()).rejects.toMatchObject({ reason: "disabled" })
    expect(f.requests()).toBe(canonicalRequests); expect(f.rawSent).toHaveLength(0)
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.pending(owner)).some(capture => capture.purpose === "raw-observation")).toBe(false)
    }))
  })
  it("seals a multi-page fresh observation and resumes 205 units with bounded slices", async () => {
    const f = await fixture(); await f.prepare(); await f.deliver(); await f.observe(205)
    let result
    for (let n = 0; n < 205; n++) {
      const before = f.rawRequests(); result = await f.deliverRaw(3, "raw-observation")
      expect(f.rawRequests() - before).toBeLessThanOrEqual(3)
    }
    expect(result).toMatchObject({ state: "completed" }); expect(f.rawSent).toHaveLength(205)
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal; expect((yield* j.claim(scope)).checkpoint).toBe("capture-next") }))
  }, 30000)
  it("archives fresh Raw after an off capture without replacing Canonical or rolling later coverage back", async () => {
    const f = await fixture(); await f.prepare(); await f.deliver()
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal; expect(yield* j.reclaim(yield* j.claim(scope), "capture")).toBe(1) }))
    f.change({ parts: 0, retainedBytes: 0 }); f.policy(true, 3)
    const before = f.snapshot(), requests = f.requests()
    const observation = await f.observe(2)
    expect(observation.head).toBe(before.id); expect(f.snapshot()).toEqual(before)
    expect(f.requests() - requests).toBe(1) // Only checks the old proof, no Begin/activation.
    f.rawFault("lose-after")
    await expect(f.deliverRaw(3, "raw-observation")).rejects.toMatchObject({ reason: "network" })
    await f.prepare(1, false, true, "later", before.id); await f.deliver(64, "later")
    const after = f.snapshot(), canonicalRequests = f.requests()
    expect(await f.deliverRaw(64, "raw-observation")).toMatchObject({ state: "completed" })
    expect(f.requests()).toBe(canonicalRequests); expect(f.snapshot()).toEqual(after); expect(f.rawSent).toHaveLength(2)
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBe("later-next")
      const original = yield* j.inspect(owner, "capture", { kind: "raw" })
      expect(original.capture.rawEnabled).toBe(false); expect(original.units).toHaveLength(0)
      const fresh = yield* j.inspect(owner, "raw-observation", { kind: "canonical" })
      expect(fresh.units).toHaveLength(0); expect(fresh.capture).toMatchObject({ purpose: "raw-observation", state: "completed", expectedCheckpoint: "capture-next" })
      expect(yield* j.reclaim(owner, "raw-observation")).toBe(2)
    }))
    const rawRequests = f.rawRequests()
    expect(await f.deliverRaw(3, "raw-observation")).toEqual({ state: "completed", operations: 0 })
    expect(f.rawRequests()).toBe(rawRequests)
  })
  it("abandons an unsealed fresh view after reopening without upload or coverage", async () => {
    const f = await fixture(); await f.prepare(); await f.deliver(); await f.observe(2, false)
    const requests = f.rawRequests()
    expect(await f.deliverRaw(3, "raw-observation")).toEqual({ state: "abandoned", operations: 0 })
    expect(f.rawRequests()).toBe(requests)
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBe("capture-next"); expect(yield* j.reclaim(owner, "raw-observation")).toBe(2)
    }))
  })
  it("requires genuine activation and retains uncertainty instead of reserving a new Raw view", async () => {
    const f = await fixture(); await f.prepare()
    await expect(f.observe()).rejects.toMatchObject({ reason: "invalid" })
    await f.deliver(); f.failStatus("unknown")
    await expect(f.observe()).rejects.toMatchObject({ reason: "unknown" })
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.pending(owner)).some(c => c.purpose === "raw-observation")).toBe(false)
    }))
  })
  it("rejects Canonical routing and an incomplete or coverage-changing Raw seal", async () => {
    const f = await fixture(); await f.prepare(); await f.deliver(); await f.observe(1, false)
    const operation = <A, E>(work: (owner: CaptureOwner) => Effect.Effect<A, E, CaptureJournal | PublicationTransport>) => f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal; return yield* work(yield* j.claim(scope))
    }))
    await expect(operation(owner => deliverPublicationCapture(owner, "raw-observation", 3))).rejects.toMatchObject({ reason: "invalid" })
    await expect(operation(owner => sealRawObservation(owner, "raw-observation", 2))).rejects.toMatchObject({ reason: "invalid" })
    await expect(operation(owner => CaptureJournal.use(j => j.append(owner, "raw-observation", {
      kind: "canonical", ordinal: 0, bytes: new TextEncoder().encode("invalid") })))).rejects.toMatchObject({ reason: "state" })
    await expect(operation(owner => CaptureJournal.use(j => j.seal(owner, "raw-observation", {
      canonicalUnits: 0, rawUnits: 1, nextCheckpoint: "forbidden", manifestJson: "{}" })))).rejects.toMatchObject({ reason: "state" })
    await operation(owner => sealRawObservation(owner, "raw-observation", 1))
    expect(await f.deliverRaw(3, "raw-observation")).toMatchObject({ state: "completed" })
  })
})



describe("Host Canonical publication preparation", () => {
  it("freezes native projections after masking, keeps headers fixed and recovers exact bytes after source deletion", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    let escaped!: Effect.Success<ReturnType<typeof native.source>>
    const prepared = await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginPublicationCapture(owner, { captureId: "host-native", baseHead: "", transformVersion: "host-v1", rawEnabled: false, trackRecords: true })
      return yield* preparePublicationCanonical(owner, "host-native", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "native-covered",
        source: native.source().pipe(Effect.tap(view => Effect.sync(() => { escaped = view }))) })
    }))
    expect(prepared.units).toBeGreaterThan(1)
    await expect(Effect.runPromise(escaped.read())).rejects.toMatchObject({ reason: "closed" })
    const frozen = await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      const bodies: Uint8Array[] = []
      for (let n = 0; n < prepared.units; n++) bodies.push(yield* j.read(owner, "host-native", "canonical", n))
      expect(owner.checkpoint).toBeNull()
      expect((yield* j.records(owner, "host-native", { kind: "event" })).every(row => row.disposition === "pending")).toBe(true)
      return bodies
    }))
    const pages = frozen.map(bytes => JSON.parse(new TextDecoder().decode(bytes)))
    expect(JSON.stringify(pages)).not.toContain("SENSITIVE_TEST_TOKEN")
    expect(JSON.stringify(pages)).toContain("[REDACTED]")
    expect(JSON.stringify(pages)).not.toContain("atapeFixtureUnknown")
    expect(pages.every(page => JSON.stringify(page.batch.session) === JSON.stringify(pages[0].batch.session) && JSON.stringify(page.batch.threads) === JSON.stringify(pages[0].batch.threads))).toBe(true)
    expect(pages.flatMap(page => page.batch.events)).toHaveLength(native.metadata.target.events)
    expect(pages.flatMap(page => page.batch.events).every(event => event.rawRef.type === "unavailable")).toBe(true)
    await rm(native.path)
    f.losePut()
    const deliver = () => f.run(Effect.gen(function*() { const j = yield* CaptureJournal; return yield* deliverPublicationCapture(yield* j.claim(native.ownerScope), "host-native", 64) }))
    await expect(deliver()).rejects.toMatchObject({ reason: "network" })
    expect(await deliver()).toMatchObject({ state: "activated" })
    expect(f.sent.map(bytes => Buffer.from(bytes).toString())).toEqual([frozen[0]!, ...frozen].map(bytes => Buffer.from(bytes).toString()))
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      expect(owner.checkpoint).toBe("native-covered")
      expect((yield* j.records(owner, "host-native", { kind: "event" })).every(row => row.disposition === "published")).toBe(true)
    }))
  })
  it("allocates changed source versions while retaining unchanged Event provenance", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    const prepare = (id: string, baseHead: string) => f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginPublicationCapture(owner, { captureId: id, baseHead, transformVersion: "host-v1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, id, { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: id, source: native.source() })
      const records = yield* j.records(owner, id, { kind: "event" })
      yield* deliverPublicationCapture(owner, id, 64)
      return records
    }))
    const before = await prepare("native-a", "")
    const db = new DatabaseSync(native.path)
    db.prepare("UPDATE part SET data=json_set(data,'$.text',?) WHERE id=(SELECT id FROM part WHERE json_extract(data,'$.type')='text' ORDER BY id LIMIT 1)").run("changed source")
    db.close()
    const after = await prepare("native-b", f.snapshot().id)
    expect(after.some(row => row.revision === 2)).toBe(true)
    expect(after.some(row => row.revision === 1)).toBe(true)
    expect(after.map(row => row.rawReference)).toEqual(before.map(row => row.rawReference))
  })
  it("versions the final derived author and scopes shared native IDs to their Thread", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    const prepare = (id: string, name: string, baseHead: string) => f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginPublicationCapture(owner, { captureId: id, baseHead, transformVersion: "host-v1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, id, { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: id,
        source: native.source().pipe(Effect.map(view => ({ ...view, session: { ...view.session, actor: { ...view.session.actor, name } },
          target: { ...view.target, usage: view.target.usage + 1 },
          read: () => view.read().pipe(Effect.map(page => ({ ...page, frames: page.frames.map(frame => {
            const child = frame.events.find(event => event.sourceThreadId !== view.session.sourceSessionId)
            return { ...frame, events: frame.events.map(event => ({ ...event,
              sourceEventId: event.eventIndex === 0 || event.sourceThreadId !== view.session.sourceSessionId ? "shared-native-id" : event.sourceEventId })),
              usage: [...frame.usage.map(sample => ({ ...sample, sourceUsageId: "shared-usage-id" })),
                ...(child ? [{ sourceUsageId: "shared-usage-id", sourceThreadId: child.sourceThreadId, occurredAt: timestamp, model: "fixture", inputTokens: 1 }] : [])] }
          }) })))
        }))) })
      const records = yield* j.records(owner, id, { kind: "event" })
      expect((yield* j.records(owner, id, { kind: "usage" })).length).toBe(2)
      yield* deliverPublicationCapture(owner, id, 64)
      return records
    }))
    const before = await prepare("actor-a", "User", ""), after = await prepare("actor-b", "Renamed user", f.snapshot().id)
    expect(before.every(record => record.revision === 1)).toBe(true)
    expect(after.some(record => record.revision === 2)).toBe(true)
    expect(after.some(record => record.revision === 1)).toBe(true)
    expect(f.sent.some(bytes => new TextDecoder().decode(bytes).includes('"author":"Renamed user"'))).toBe(true)
  })
  it("refuses Raw-enabled preparation before opening a source and does not seal changed Origin", async () => {
    const f = await fixture(16384), native = await nativePreparationSource(); let opened = false
    await expect(f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginPublicationCapture(owner, { captureId: "raw-wrong", baseHead: "", transformVersion: "host-v1", rawEnabled: true, trackRecords: true,
        rawAuthority: { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 } })
      return yield* preparePublicationCanonical(owner, "raw-wrong", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "bad",
        source: native.source().pipe(Effect.tap(() => Effect.sync(() => { opened = true }))) })
    }))).rejects.toMatchObject({ reason: "unsupported" })
    expect(opened).toBe(false)
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal; yield* j.settle(yield* j.claim(native.ownerScope), "raw-wrong", { _tag: "AbandonUnsealed" }) }))
    await expect(f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginPublicationCapture(owner, { captureId: "wrong-origin", baseHead: "", transformVersion: "host-v1", rawEnabled: false, trackRecords: true })
      return yield* preparePublicationCanonical(owner, "wrong-origin", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "bad",
        source: native.source().pipe(Effect.map(view => ({ ...view, origin: { ...view.origin, originKey: "different" } }))) })
    }))).rejects.toMatchObject({ reason: "binding" })
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      expect((yield* j.inspect(owner, "wrong-origin", { kind: "canonical" })).capture.seal).toBeNull()
      expect(owner.checkpoint).toBeNull()
    }))
  })
  it("rejects incomplete or unordered targets without publishing a prefix or advancing coverage", async () => {
    for (const problem of ["incomplete", "order", "oversize"] as const) {
      const f = await fixture(16384), native = await nativePreparationSource()
      await expect(f.run(Effect.gen(function*() {
        const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
        yield* beginPublicationCapture(owner, { captureId: problem, baseHead: "", transformVersion: "host-v1", rawEnabled: false, trackRecords: true })
        return yield* preparePublicationCanonical(owner, problem, { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "bad",
          source: native.source().pipe(Effect.map(view => ({ ...view,
            ...(problem === "incomplete" ? { target: { ...view.target, events: view.target.events + 1 }, session: { ...view.session, reportedEventCount: view.target.events + 1 } } : {}),
            read: () => view.read().pipe(Effect.map(page => ({ ...page, frames: page.frames.map(frame => ({ ...frame,
              events: frame.events.map(event => problem === "order" ? { ...event, eventIndex: 99 } : problem === "oversize" && "content" in event.update ?
                { ...event, update: { ...event.update, content: { type: "text" as const, text: "x".repeat(10000) } } } : event) })) })))
          }))) })
      }))).rejects.toMatchObject({ reason: problem === "oversize" ? "capacity" : "invalid" })
      expect(f.sent).toHaveLength(0)
      await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
        expect(owner.checkpoint).toBeNull()
        expect((yield* j.coverage(owner)).canonicalCaptureId).toBeNull()
        expect((yield* j.inspect(owner, problem, { kind: "canonical" })).capture.seal).toBeNull()
        expect(yield* deliverPublicationCapture(owner, problem, 3)).toMatchObject({ state: "abandoned", operations: 0 })
      }))
    }
  })
  it("does not reopen a fresh source to finish an interrupted preparing capture", async () => {
    const f = await fixture(16384), native = await nativePreparationSource(); let reads = 0, reopened = false
    await expect(f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginPublicationCapture(owner, { captureId: "interrupted", baseHead: "", transformVersion: "host-v1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, "interrupted", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "bad",
        source: native.source().pipe(Effect.map(view => ({ ...view,
          read: () => view.read().pipe(Effect.flatMap(page => ++reads > 2 ? Effect.fail(failure("invalid")) : Effect.succeed(page)))
        }))) })
    }))).rejects.toMatchObject({ reason: "invalid" })
    await expect(f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* preparePublicationCanonical(owner, "interrupted", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "bad",
        source: native.source().pipe(Effect.tap(() => Effect.sync(() => { reopened = true }))) })
    }))).rejects.toMatchObject({ reason: "conflict" })
    expect(reopened).toBe(false)
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      expect(yield* deliverPublicationCapture(owner, "interrupted", 3)).toMatchObject({ state: "abandoned", operations: 0 })
      expect(owner.checkpoint).toBeNull()
    }))
  })
})

const rawLimits = { objectBytes: 4000, wireBytes: 8192, targetBytes: 100_000, units: 100 }
const prepareNative = (f: Awaited<ReturnType<typeof fixture>>, native: Awaited<ReturnType<typeof nativePreparationSource>>,
  id: string, raw = true, limits = rawLimits, baseHead = "") => f.run(Effect.gen(function*() {
  const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
  yield* beginPublicationCapture(owner, { captureId: id, baseHead, transformVersion: "host-v1", rawEnabled: raw, trackRecords: true,
    ...(raw ? { rawAuthority: { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 } as const } : {}) })
  return yield* preparePublicationCanonical(owner, id, { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: id,
    source: native.source(raw), ...(raw ? { rawLimits: limits } : {}) })
}))
const nativeDelivery = (f: Awaited<ReturnType<typeof fixture>>, native: Awaited<ReturnType<typeof nativePreparationSource>>, id: string, raw = false) =>
  f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
    return raw ? yield* deliverPublicationRaw(owner, id, 64) : yield* deliverPublicationCapture(owner, id, 64)
  }))

describe("Host Raw preparation", () => {
  it("packs native rows after decoding escaped secrets and retries frozen bytes after source deletion", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    const db = new DatabaseSync(native.path)
    const row = db.prepare("SELECT id,data FROM part ORDER BY id LIMIT 1").get()!
    const data = JSON.parse(row.data as string)
    data.nested = JSON.stringify({ password: "another-long-password", secretValue: "SENSITIVE_TEST_TOKEN" }).replace("SENSITIVE_TEST_TOKEN", "SENSITIVE_TEST_\\u0054OKEN")
    db.prepare("UPDATE part SET data=? WHERE id=?").run(JSON.stringify(data), row.id as string); db.close()
    const prepared = await prepareNative(f, native, "raw-native")
    expect(prepared.raw!.units).toBeGreaterThan(1)
    expect(prepared.raw!.records).toBeGreaterThan(prepared.raw!.units)
    expect(f.rawSent).toHaveLength(0)
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      expect((yield* j.read(owner, "raw-native", "raw", 0).pipe(Effect.flip)).reason).toBe("state")
    }))
    await nativeDelivery(f, native, "raw-native")
    const frozen = await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      const result: Uint8Array[] = []
      for (let n = 0; n < prepared.raw!.units; n++) result.push(yield* j.read(owner, "raw-native", "raw", n))
      return result
    }))
    const content = frozen.map(bytes => Buffer.from(JSON.parse(Buffer.from(bytes).toString()).contentBase64, "base64").toString()).join("\n")
    expect(content).toContain("atapeFixtureUnknown")
    expect(content).toContain("[REDACTED]")
    expect(content).not.toContain("SENSITIVE_TEST_TOKEN")
    expect(content).not.toContain("another-long-password")
    expect(content).not.toContain("u0054OKEN")
    await rm(native.path)
    f.rawFault("lose-before")
    await expect(nativeDelivery(f, native, "raw-native", true)).rejects.toMatchObject({ reason: "network" })
    expect(await nativeDelivery(f, native, "raw-native", true)).toMatchObject({ state: "completed" })
    expect(f.rawSent.map(bytes => Buffer.from(bytes).toString())).toEqual([frozen[0]!, ...frozen].map(bytes => Buffer.from(bytes).toString()))
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      const records = yield* j.records(owner, "raw-native", { kind: "raw", limit: 100 })
      expect(records.every(record => record.disposition === "acknowledged")).toBe(true)
      const envelopes = frozen.map(bytes => JSON.parse(Buffer.from(JSON.parse(Buffer.from(bytes).toString()).contentBase64, "base64").toString()))
      for (const record of records) expect(envelopes[record.unit!.ordinal].records[record.key].revision).toBe(record.revision)
      expect((yield* j.records(owner, "raw-native", { kind: "event" })).every(record => record.rawReference?._tag === "object")).toBe(true)
    }))
  })
  it("reuses acknowledged objects after payload GC and versions only changed Raw rows", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    await prepareNative(f, native, "raw-a"); await nativeDelivery(f, native, "raw-a"); await nativeDelivery(f, native, "raw-a", true)
    const before = await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      while ((yield* j.reclaim(owner, "raw-a")) > 0) { /* bounded calls */ }
      return yield* j.records(owner, "raw-a", { kind: "event" })
    }))
    const repeated = await prepareNative(f, native, "raw-b", true, rawLimits, f.snapshot().id)
    expect(repeated.raw!.units).toBe(0); expect(repeated.raw!.reused).toBe(repeated.raw!.records)
    await nativeDelivery(f, native, "raw-b")
    const db = new DatabaseSync(native.path)
    db.prepare("UPDATE part SET data=json_set(data,'$.rawOnlyChange',?) WHERE id=(SELECT id FROM part ORDER BY id LIMIT 1)").run("fresh archive value"); db.close()
    const changed = await prepareNative(f, native, "raw-c", true, rawLimits, f.snapshot().id)
    expect(changed.raw!.units).toBe(1); expect(changed.raw!.reused).toBe(changed.raw!.records - 1)
    await nativeDelivery(f, native, "raw-c")
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      const after = yield* j.records(owner, "raw-c", { kind: "event" })
      expect(after.map(record => [record.revision, record.rawReference])).toEqual(before.map(record => [record.revision, record.rawReference]))
      const rows = yield* j.records(owner, "raw-c", { kind: "raw" })
      expect(rows.filter(record => record.revision === 2)).toHaveLength(1)
      expect(rows.filter(record => record.disposition === "acknowledged")).toHaveLength(rows.length - 1)
    }))
  })
  it("freshly observes after Raw-off and re-enable without changing Canonical references or checkpoint", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    await prepareNative(f, native, "off", false); await nativeDelivery(f, native, "off")
    const head = f.snapshot().id
    const observe = (id: string) => f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginRawObservation(owner, { observationId: id, canonicalCaptureId: "off" })
      return yield* prepareRawObservation(owner, id, { adapterVersion: "0.0.0", observedAt: timestamp, limits: rawLimits, source: native.source(true) })
    }))
    f.policy(true, 2)
    expect((await observe("enabled")).units).toBeGreaterThan(0)
    f.rawFault("lose-before")
    await expect(nativeDelivery(f, native, "enabled", true)).rejects.toMatchObject({ reason: "network" })
    f.policy(false, 3)
    expect(await nativeDelivery(f, native, "enabled", true)).toMatchObject({ state: "completed" })
    f.policy(true, 4)
    const fresh = await observe("re-enabled")
    expect(fresh.reused).toBe(0); expect(fresh.units).toBeGreaterThan(0)
    await nativeDelivery(f, native, "re-enabled", true)
    expect(f.snapshot().id).toBe(head)
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      expect(owner.checkpoint).toBe("off")
      expect((yield* j.coverage(owner)).canonicalCaptureId).toBe("off")
      expect((yield* j.records(owner, "off", { kind: "event" })).every(record => record.revision === 1 && record.rawReference?._tag === "unavailable")).toBe(true)
      expect(yield* j.records(owner, "re-enabled", { kind: "event" })).toEqual([])
      expect((yield* j.records(owner, "enabled", { kind: "raw" })).every(record => record.disposition === "canceled")).toBe(true)
      expect((yield* j.records(owner, "re-enabled", { kind: "raw" })).every(record => record.disposition === "acknowledged")).toBe(true)
    }))
  })
  it("records limit and redaction gaps while allowing complete Canonical activation", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    const limited = await prepareNative(f, native, "limited", true, { ...rawLimits, objectBytes: 1 })
    expect(limited.raw!.units).toBe(0); expect(limited.raw!.gaps).toBe(limited.raw!.records)
    await nativeDelivery(f, native, "limited")
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      expect((yield* j.records(owner, "limited", { kind: "raw" })).every(record => record.unavailableReason === "limit")).toBe(true)
      yield* beginRawObservation(owner, { observationId: "redaction", canonicalCaptureId: "limited" })
      const result = yield* prepareRawObservation(owner, "redaction", { adapterVersion: "0.0.0", observedAt: timestamp, limits: rawLimits,
        source: native.source(true).pipe(Effect.map(view => ({ ...view,
          read: () => view.read().pipe(Effect.map(page => ({ ...page, frames: page.frames.map(frame => ({ ...frame,
            raw: { SENSITIVE_TEST_TOKEN: "one", "[REDACTED]": "two" } })) })))
        }))) })
      expect(result.units).toBe(0); expect(result.gaps).toBe(result.records)
      yield* deliverPublicationRaw(owner, "redaction", 64)
      expect((yield* j.records(owner, "redaction", { kind: "raw" })).every(record => record.disposition === "unavailable" && record.unavailableReason === "redaction")).toBe(true)
      expect(owner.checkpoint).toBe("limited")
    }))
    expect(f.rawSent).toHaveLength(0)
  })
  it("abandons interrupted Raw preparation before a new owner can reopen the source", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    await prepareNative(f, native, "base", false); await nativeDelivery(f, native, "base")
    let reads = 0, reopened = false
    await expect(f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginRawObservation(owner, { observationId: "interrupted-raw", canonicalCaptureId: "base" })
      yield* prepareRawObservation(owner, "interrupted-raw", { adapterVersion: "0.0.0", observedAt: timestamp, limits: rawLimits,
        source: native.source(true).pipe(Effect.map(view => ({ ...view,
          read: () => view.read().pipe(Effect.flatMap(page => ++reads > 2 ? Effect.fail(failure("invalid")) : Effect.succeed(page)))
        }))) })
    }))).rejects.toMatchObject({ reason: "invalid" })
    await expect(f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* prepareRawObservation(owner, "interrupted-raw", { adapterVersion: "0.0.0", observedAt: timestamp, limits: rawLimits,
        source: native.source(true).pipe(Effect.tap(() => Effect.sync(() => { reopened = true }))) })
    }))).rejects.toMatchObject({ reason: "conflict" })
    expect(reopened).toBe(false)
    expect(await nativeDelivery(f, native, "interrupted-raw", true)).toMatchObject({ state: "abandoned", operations: 0 })
    expect(f.rawSent).toHaveLength(0)
  })
})

describe("Raw source preparation edge cases", () => {
  it("does not archive a hidden escaped secret in duplicate JSON TEXT members", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    await prepareNative(f, native, "base", false); await nativeDelivery(f, native, "base")
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginRawObservation(owner, { observationId: "duplicates", canonicalCaptureId: "base" })
      const result = yield* prepareRawObservation(owner, "duplicates", { adapterVersion: "0.0.0", observedAt: timestamp, limits: rawLimits,
        source: native.source(true).pipe(Effect.map(view => ({ ...view,
          read: () => view.read().pipe(Effect.map(page => ({ ...page, frames: page.frames.map(frame => ({ ...frame,
            raw: { data: JSON.stringify({ nested: '{"x":"SENSITIVE_TEST_\\u0054OKEN","\\u0078":"safe"}' }) } })) })))
        }))) })
      expect(result.gaps).toBe(result.records); expect(result.units).toBe(0)
      yield* deliverPublicationRaw(owner, "duplicates", 64)
      expect((yield* j.records(owner, "duplicates", { kind: "raw" })).every(record => record.unavailableReason === "redaction")).toBe(true)
    }))
    expect(f.rawSent).toHaveLength(0)
  })
  it("keeps reused pending obligations pending until their original receipt arrives", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    await prepareNative(f, native, "pending-a"); await nativeDelivery(f, native, "pending-a")
    const second = await prepareNative(f, native, "pending-b", true, rawLimits, f.snapshot().id)
    expect(second.raw!.reused).toBe(second.raw!.records); expect(second.raw!.units).toBe(0)
    await nativeDelivery(f, native, "pending-b")
    expect(await nativeDelivery(f, native, "pending-b", true)).toMatchObject({ state: "completed" })
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      expect((yield* j.records(owner, "pending-b", { kind: "raw" })).every(record => record.disposition === "pending")).toBe(true)
    }))
    await nativeDelivery(f, native, "pending-a", true)
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      expect((yield* j.records(owner, "pending-b", { kind: "raw" })).every(record => record.disposition === "acknowledged")).toBe(true)
    }))
  })
  it("does not borrow pending uploads under superseded Raw authority", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    await prepareNative(f, native, "old-authority"); await nativeDelivery(f, native, "old-authority")
    f.policy(true, 2)
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginRawObservation(owner, { observationId: "new-authority", canonicalCaptureId: "old-authority" })
      const result = yield* prepareRawObservation(owner, "new-authority", { adapterVersion: "0.0.0", observedAt: timestamp, limits: rawLimits, source: native.source(true) })
      expect(result.reused).toBe(0); expect(result.units).toBeGreaterThan(0)
    }))
    expect(await nativeDelivery(f, native, "old-authority", true)).toMatchObject({ state: "completed" })
    expect(f.rawSent).toHaveLength(0)
    await nativeDelivery(f, native, "new-authority", true)
  })
})

describe("Raw preparation admission", () => {
  it("keeps Raw wire and unit exhaustion as per-record gaps within a complete Canonical capture", async () => {
    for (const limits of [{ ...rawLimits, units: 1 }, { ...rawLimits, targetBytes: rawLimits.wireBytes }]) {
      const f = await fixture(16384), native = await nativePreparationSource()
      const prepared = await prepareNative(f, native, "budget", true, limits)
      expect(prepared.raw!.units).toBeLessThanOrEqual(limits.units)
      expect(prepared.raw!.bytes).toBeLessThanOrEqual(limits.targetBytes)
      expect(prepared.raw!.gaps).toBeGreaterThan(0)
      expect(prepared.raw!.units).toBeGreaterThan(0)
      await nativeDelivery(f, native, "budget")
      await nativeDelivery(f, native, "budget", true)
      await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
        expect(owner.checkpoint).toBe("budget")
        const rows = yield* j.records(owner, "budget", { kind: "raw" })
        expect(rows.filter(row => row.disposition === "unavailable")).toHaveLength(prepared.raw!.gaps)
        expect(rows.filter(row => row.disposition === "acknowledged")).toHaveLength(rows.length - prepared.raw!.gaps)
      }))
    }
  })
})


describe("Host read-only source comparison", () => {
  const compare = (f: Awaited<ReturnType<typeof fixture>>, native: Awaited<ReturnType<typeof nativePreparationSource>>,
    raw = false, limits = rawLimits, teamRevision = 1, adapterVersion = "0.0.0") => f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      return yield* comparePublicationSource(owner, { adapterVersion, observedAt: "2026-09-10T01:00:00Z", transformVersion: "host-v1",
        limits: { records: 1000, durationMs: 10000 }, source: native.source(raw),
        ...(raw ? { raw: { limits, authority: { protocol: "atape.raw-publication.v1", teamRevision, userRevision: 1 } as const } } : {}) })
    }))
  it("does not open a source without activated coverage, and repeats unchanged observations without captures or versions", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    const initial = await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      return yield* comparePublicationSource(owner, { adapterVersion: "0.0.0", observedAt: timestamp, transformVersion: "host-v1",
        limits: { records: 1000, durationMs: 10000 }, source: Effect.die("Unpublished baseline must not open a source") })
    }))
    expect(initial).toEqual({ canonical: "changed", raw: "disabled" })
    await expect(compare(f, native, false, rawLimits, 1, "x".repeat(101))).rejects.toMatchObject({ reason: "invalid" })
    await prepareNative(f, native, "baseline", false); await nativeDelivery(f, native, "baseline")
    const before = await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      return { coverage: yield* j.coverage(owner), pending: yield* j.pending(owner), events: yield* j.records(owner, "baseline", { kind: "event" }) }
    }))
    const journalCounts = () => {
      const db = new DatabaseSync(f.path, { readOnly: true })
      try { return ["captures", "capture_records", "source_record_versions"].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) }
      finally { db.close() }
    }
    const counts = journalCounts(), requests = f.requests()
    for (let n = 0; n < 10; n++) expect(await compare(f, native)).toEqual({ canonical: "unchanged", raw: "disabled" })
    expect(f.requests()).toBe(requests); expect(journalCounts()).toEqual(counts)
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      expect(yield* j.coverage(owner)).toEqual(before.coverage); expect(yield* j.pending(owner)).toEqual(before.pending)
      expect(yield* j.records(owner, "baseline", { kind: "event" })).toEqual(before.events)
      // An abandoned different observation consumes versions, but cannot make
      // identical published content appear changed during a later preflight.
      yield* j.reserve(owner, { id: "abandoned", expectedCheckpoint: owner.checkpoint, beginJson: "{}", rawEnabled: false, trackRecords: true })
      const row = before.events[0]!
      yield* j.record(owner, "abandoned", { ...row, fingerprint: "f".repeat(64) })
      yield* j.settle(owner, "abandoned", { _tag: "AbandonUnsealed" })
    }))
    expect(await compare(f, native)).toEqual({ canonical: "unchanged", raw: "disabled" })
    const db = new DatabaseSync(native.path)
    db.prepare("UPDATE part SET data=json_set(data,'$.text','changed source') WHERE json_extract(data,'$.type')='text'").run(); db.close()
    expect(await compare(f, native)).toEqual({ canonical: "changed", raw: "disabled" })
  })
  it("distinguishes Raw-only edits, current pending authority, cancellation and actual ACK after reclamation", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    await prepareNative(f, native, "baseline"); await nativeDelivery(f, native, "baseline")
    expect(await compare(f, native, true)).toEqual({ canonical: "unchanged", raw: "unchanged" })
    expect(await compare(f, native, true, rawLimits, 2)).toEqual({ canonical: "unchanged", raw: "required" })
    await f.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* j.settle(owner, "baseline", { _tag: "RawCancellationStarted", reason: "disabled" })
    }))
    expect(await compare(f, native, true)).toEqual({ canonical: "unchanged", raw: "required" })
    // Genuine receipts win even after cancellation intent. Use the real Raw
    // transport for the independent ACK/reclamation case.
    const g = await fixture(16384)
    await prepareNative(g, native, "acked"); await nativeDelivery(g, native, "acked"); await nativeDelivery(g, native, "acked", true)
    await g.run(Effect.gen(function*() { const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      while ((yield* j.reclaim(owner, "acked")) > 0) { /* bounded payload reclamation */ }
    }))
    expect(await compare(g, native, true, rawLimits, 2)).toEqual({ canonical: "unchanged", raw: "unchanged" })
    const db = new DatabaseSync(native.path)
    db.prepare("UPDATE part SET data=json_set(data,'$.rawOnlyChange',1) WHERE id=(SELECT id FROM part ORDER BY id LIMIT 1)").run(); db.close()
    expect(await compare(g, native, true)).toEqual({ canonical: "unchanged", raw: "required" })
    expect(await compare(g, native)).toEqual({ canonical: "unchanged", raw: "disabled" })
    await g.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginRawObservation(owner, { observationId: "raw-only", canonicalCaptureId: "acked" })
      yield* prepareRawObservation(owner, "raw-only", { adapterVersion: "0.0.0", observedAt: timestamp, limits: rawLimits, source: native.source(true) })
      yield* deliverPublicationRaw(owner, "raw-only", 64)
      expect((yield* j.coverage(owner)).canonicalCaptureId).toBe("acked")
    }))
    expect(await compare(g, native, true)).toEqual({ canonical: "unchanged", raw: "unchanged" })
  })
  it("keeps identical capacity gaps stable and retries when Raw admission changes or Raw is first enabled", async () => {
    const f = await fixture(16384), native = await nativePreparationSource(), small = { ...rawLimits, objectBytes: 1 }
    await prepareNative(f, native, "gaps", true, small); await nativeDelivery(f, native, "gaps")
    expect(await compare(f, native, true, small)).toEqual({ canonical: "unchanged", raw: "unchanged" })
    expect(await compare(f, native, true, small, 1, "v")).toEqual({ canonical: "unchanged", raw: "required" })
    expect(await compare(f, native, true)).toEqual({ canonical: "unchanged", raw: "required" })
    const g = await fixture(16384)
    await prepareNative(g, native, "off", false); await nativeDelivery(g, native, "off")
    expect(await compare(g, native, true)).toEqual({ canonical: "unchanged", raw: "required" })
  })
  it("rejects a published baseline replaced during comparison even under the same owner", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    await prepareNative(f, native, "baseline", false); await nativeDelivery(f, native, "baseline")
    await expect(f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      yield* beginPublicationCapture(owner, { captureId: "replacement", baseHead: f.snapshot().id, transformVersion: "host-v1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, "replacement", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "replacement", source: native.source() })
      let replaced = false
      return yield* comparePublicationSource(owner, { adapterVersion: "0.0.0", observedAt: timestamp, transformVersion: "host-v1",
        limits: { records: 1000, durationMs: 10000 }, source: native.source().pipe(Effect.map(view => ({ ...view,
          read: () => view.read().pipe(Effect.tap(page => Effect.gen(function*() {
            // Simulate a concurrent worker publishing a prepared candidate; the
            // comparison itself has no transport dependency or content writes.
            if (page.done && !replaced) { replaced = true; yield* deliverPublicationCapture(owner, "replacement", 64) }
          })))
        }))) })
    }))).rejects.toMatchObject({ reason: "conflict" })
    expect(await compare(f, native)).toEqual({ canonical: "unchanged", raw: "disabled" })
  })
  it("rejects duplicate Raw membership, bounds records, and closes the source on deadline", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    await prepareNative(f, native, "baseline"); await nativeDelivery(f, native, "baseline")
    let closed = false
    const run = (mode: "duplicate" | "capacity" | "deadline") => f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(native.ownerScope)
      return yield* comparePublicationSource(owner, { adapterVersion: "0.0.0", observedAt: timestamp, transformVersion: "host-v1",
        limits: { records: mode === "capacity" ? 1 : 1000, durationMs: mode === "deadline" ? 20 : 10000 },
        raw: { limits: rawLimits, authority: { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 } },
        source: native.source(true).pipe(Effect.flatMap(view => Effect.gen(function*() {
          yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true }))
          return { ...view, read: () => mode === "deadline" ? Effect.never : view.read().pipe(Effect.map(page => ({ ...page,
            frames: page.frames.map(frame => mode === "duplicate" ? { ...frame, recordKey: "same-key" } : frame) }))) }
        }))) })
    }))
    await expect(run("duplicate")).rejects.toMatchObject({ reason: "invalid" })
    await expect(run("capacity")).rejects.toMatchObject({ reason: "capacity" })
    closed = false
    await expect(run("deadline")).rejects.toMatchObject({ reason: "deadline" }); expect(closed).toBe(true)
    expect(await compare(f, native, true)).toEqual({ canonical: "unchanged", raw: "unchanged" })
  })
})
