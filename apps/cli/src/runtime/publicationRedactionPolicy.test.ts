import { rm } from "node:fs/promises"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { CaptureJournal, SecretRedactor, beginPublicationCapture, deliverPublicationCapture, deliverPublicationRaw,
  beginRawObservation, preparePublicationCanonical, sealPublicationCapture, comparePublicationSource, type SecretRedactorService } from "@atape/application"
import { redactionTransformVersion } from "../../../../packages/application/src/collectorRedactionPolicy.ts"
import { directories, fixture, scope, timestamp, nativePreparationSource } from "./fixtures/publication-test-support.ts"

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const policy = (policyId: string): SecretRedactorService => ({ policyId, redact: value => ({ value, replacements: 0 }) })
const recover = (f: Awaited<ReturnType<typeof fixture>>, raw = false, id = "capture") =>
  f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
    return raw ? yield* deliverPublicationRaw(owner, id, 64) : yield* deliverPublicationCapture(owner, id, 64)
  }).pipe(Effect.provideService(SecretRedactor, policy("new"))))

describe("policy-bound immutable publication recovery", () => {
  it("retains exact sealed-byte replay when the effective policy did not change", async () => {
    const f = await fixture()
    const work = <A, E>(effect: Effect.Effect<A, E, CaptureJournal | import("@atape/application").PublicationTransport>) =>
      f.run(effect.pipe(Effect.provideService(SecretRedactor, policy("new"))))
    await work(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "capture", baseHead: "", transformVersion: redactionTransformVersion("new"), rawEnabled: false })
      yield* journal.append(owner, "capture", { kind: "canonical", ordinal: 0, bytes: new TextEncoder().encode("{\"prepared\":true}\n") })
      yield* sealPublicationCapture(owner, "capture", { nextCheckpoint: "next", rawUnits: 0 })
    }))
    f.losePut(); await expect(recover(f)).rejects.toMatchObject({ reason: "network" })
    expect(await recover(f)).toMatchObject({ state: "activated" })
    expect(f.sent).toHaveLength(2); expect(f.sent[0]).toEqual(f.sent[1])
  })
  it("rejects an unversioned sealed capture without sending its old content", async () => {
    const f = await fixture(); await f.prepare()
    expect(await recover(f)).toMatchObject({ state: "abandoned", operations: 2 })
    expect(f.sent).toEqual([])
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      expect(owner.checkpoint).toBeNull()
      expect((yield* journal.inspect(owner, "capture", { kind: "canonical" })).capture).toMatchObject({ state: "abandoned" })
    }))
  })
  it("cannot fall back to unversioned delivery for a policy-aware frozen capture", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "capture", baseHead: "", transformVersion: redactionTransformVersion("new"), rawEnabled: false })
      yield* journal.append(owner, "capture", { kind: "canonical", ordinal: 0, bytes: new TextEncoder().encode("{\"prepared\":true}\n") })
      yield* sealPublicationCapture(owner, "capture", { nextCheckpoint: "next", rawUnits: 0 })
    }).pipe(Effect.provideService(SecretRedactor, policy("new"))))
    await expect(f.deliver()).rejects.toMatchObject({ _tag: "CapturePolicyError", reason: "policy" })
    expect(f.sent).toEqual([])
    expect(await recover(f)).toMatchObject({ state: "activated" })
    // Already accepted history remains recoverable without content admission.
    expect(await f.deliver()).toMatchObject({ state: "activated", operations: 0 })
  })
  it("reconciles a lost part response and does not replay the old policy bytes", async () => {
    const f = await fixture(); await f.prepare(2); f.losePut()
    await expect(f.deliver()).rejects.toMatchObject({ reason: "network" })
    expect(f.sent).toHaveLength(1)
    expect(await recover(f)).toMatchObject({ state: "abandoned" })
    expect(f.sent).toHaveLength(1)
  })
  it.each(["unknown", "network"] as const)("keeps frozen evidence and pauses on %s status across restart", async reason => {
    const f = await fixture(); await f.prepare(); f.failStatus(reason)
    await expect(recover(f)).rejects.toMatchObject({ reason })
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      expect((yield* journal.inspect(owner, "capture", { kind: "canonical" })).capture).toMatchObject({ state: "sealed", rejectionReceipt: null })
      expect(yield* journal.reclaim(owner, "capture")).toBe(0)
    }))
    expect(f.sent).toEqual([])
    f.failStatus(undefined)
    expect(await recover(f)).toMatchObject({ state: "abandoned" })
  })
  it("recovers an actual lost activation instead of discarding accepted history", async () => {
    const f = await fixture(); await f.prepare(); f.loseActivation()
    await expect(f.deliver()).rejects.toMatchObject({ reason: "network" })
    const sent = f.sent.length
    expect(await recover(f)).toMatchObject({ state: "activated", operations: 1 })
    expect(f.sent).toHaveLength(sent)
    await f.run(Effect.gen(function*() { const journal = yield* CaptureJournal; expect((yield* journal.claim(scope)).checkpoint).toBe("capture-next") }))
  })
  it("reconciles an accepted Raw chunk and cancels only remaining obligations", async () => {
    const f = await fixture(); await f.prepare(1, true, true, "capture", "", 2); await f.deliver()
    f.rawFault("lose-after")
    await expect(f.deliverRaw()).rejects.toMatchObject({ reason: "network" })
    expect(f.rawSent).toHaveLength(1)
    expect(await recover(f, true)).toMatchObject({ state: "completed" })
    expect(f.rawSent).toHaveLength(1)
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      const state = yield* journal.inspect(owner, "capture", { kind: "raw" })
      expect(state.capture.rawCancelReason).toBe("Redaction policy changed")
      expect(state.units.map(unit => unit.disposition)).toEqual(["acknowledged", "canceled"])
      expect(owner.checkpoint).toBe("capture-next")
    }))
  })
  it("persists Raw cancellation before a failed receipt lookup and never resumes append", async () => {
    const f = await fixture(); await f.prepare(1, true); await f.deliver()
    f.receiptError("network")
    await expect(recover(f, true)).rejects.toMatchObject({ reason: "network" })
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      const state = yield* journal.inspect(owner, "capture", { kind: "raw" })
      expect(state.capture.rawCancelReason).toBe("Redaction policy changed")
      expect(state.units[0]).toMatchObject({ disposition: "pending", retained: true })
    }))
    f.receiptError(undefined)
    expect(await f.deliverRaw()).toMatchObject({ state: "completed" })
    expect(f.rawSent).toEqual([])
  })
  it("fences fresh reservation and source preparation before any content source opens", async () => {
    const f = await fixture(); await f.prepare(1, false, false)
    let opened = false
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      return yield* preparePublicationCanonical(owner, "capture", { adapterVersion: "0.0.0", observedAt: timestamp,
        nextCheckpoint: "next", source: Effect.sync(() => { opened = true; throw new Error("must not open") }) })
    }).pipe(Effect.provideService(SecretRedactor, policy("new"))))).rejects.toMatchObject({ _tag: "CapturePolicyError", reason: "policy" })
    expect(opened).toBe(false)
    const requests = f.requests()
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      return yield* beginPublicationCapture(owner, { captureId: "wrong", baseHead: "", transformVersion: redactionTransformVersion("old"), rawEnabled: false })
    }).pipe(Effect.provideService(SecretRedactor, policy("new"))))).rejects.toMatchObject({ reason: "policy" })
    expect(f.requests()).toBe(requests)
  })
  it("requires a new Canonical policy publication before independent Raw preparation", async () => {
    const f = await fixture(); await f.prepare(); await f.deliver()
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      return yield* beginRawObservation(owner, { observationId: "new-raw", canonicalCaptureId: "capture" })
    }).pipe(Effect.provideService(SecretRedactor, policy("new"))))).rejects.toMatchObject({ reason: "policy" })
    expect(f.rawSent).toEqual([])
  })
  it("forces a new projection and fresh packed Raw objects even when only the policy identity changes", async () => {
    const f = await fixture(16384), native = await nativePreparationSource()
    const rawLimits = { objectBytes: 2048, wireBytes: 4096, targetBytes: 1024 * 1024, units: 1000 }
    const run = <A, E>(id: string, work: Effect.Effect<A, E, CaptureJournal | import("@atape/application").PublicationTransport | SecretRedactor>) =>
      f.run(work.pipe(Effect.provideService(SecretRedactor, policy(id))))
    const prepare = (id: string, baseHead: string) => run(id, Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(native.ownerScope)
      yield* beginPublicationCapture(owner, { captureId: id, baseHead, transformVersion: redactionTransformVersion(id), rawEnabled: true, trackRecords: true,
        rawAuthority: { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 } })
      const result = yield* preparePublicationCanonical(owner, id, { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: id,
        source: native.source(true), rawLimits })
      yield* deliverPublicationCapture(owner, id, 64)
      return result
    }))
    const first = await prepare("first-policy", "")
    expect(first.raw!.units).toBeGreaterThan(0)
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(native.ownerScope)
      return yield* deliverPublicationRaw(owner, "first-policy", 64)
    }))).rejects.toMatchObject({ _tag: "CapturePolicyError", reason: "policy" })
    expect(f.rawSent).toEqual([])
    const head = f.snapshot().id
    const comparison = await run("second-policy", Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(native.ownerScope)
      return yield* comparePublicationSource(owner, { adapterVersion: "0.0.0", observedAt: timestamp,
        transformVersion: redactionTransformVersion("second-policy"), limits: { records: 10000, durationMs: 10000 },
        source: native.source(true), raw: { authority: { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 }, limits: rawLimits } })
    }))
    expect(comparison).toMatchObject({ canonical: "changed", raw: "required" })
    const second = await prepare("second-policy", head)
    expect(second.raw!.units).toBeGreaterThan(0)
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(native.ownerScope)
      const old = yield* journal.inspect(owner, "first-policy", { kind: "raw" })
      const fresh = yield* journal.inspect(owner, "second-policy", { kind: "raw" })
      const object = (id: string) => journal.read(owner, id, "raw", 0).pipe(Effect.map(bytes => JSON.parse(new TextDecoder().decode(bytes)).sourceObjectId as string))
      expect(old.units.length).toBeGreaterThan(0); expect(fresh.units.length).toBeGreaterThan(0)
      expect(yield* object("first-policy")).not.toBe(yield* object("second-policy"))
    }))
  })
})
