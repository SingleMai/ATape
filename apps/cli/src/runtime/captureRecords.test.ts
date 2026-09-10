import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CaptureJournal, type CaptureClaim, type CaptureRecordInput } from "@atape/application"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeCaptureJournalLayer } from "./captureJournal.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const binding = { instanceOrigin: "https://atape.test", userId: "user", installationId: "installation" }
const scope = { projectId: "project", adapterId: "opencode", sourceSessionId: "root", originKey: "origin" }
const bytes = (value: string) => new TextEncoder().encode(value)
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex")
const eventKey = { kind: "event", key: "message/part/text.v1" } as const
const rawKey = { kind: "raw", key: "part/row" } as const
const input = (kind: CaptureRecordInput["kind"], key: string, value: string, rawObject?: string): CaptureRecordInput => ({
  kind, key, fingerprint: fingerprint(value), projectionVersion: "projection-v1",
  ...(kind === "event" ? { rawReference: rawObject === undefined ? { _tag: "unavailable", reason: "Raw disabled" } as const : { _tag: "object", sourceObjectId: rawObject } as const } : {})
})
const fixture = async (recordsPerTarget = 1000) => {
  const directory = await mkdtemp(join(tmpdir(), "atape-records-")); directories.push(directory)
  const path = join(directory, "journal.sqlite")
  let mode: "create" | "open" = "create"
  const run = <A, E>(work: Effect.Effect<A, E, CaptureJournal>) => {
    const current = mode; mode = "open"
    return Effect.runPromise(work.pipe(Effect.provide(makeCaptureJournalLayer({ path, mode: current, binding,
      limits: { unitBytes: 512, targetBytes: 4096, pendingBytes: 8192, unitsPerTarget: 100, recordsPerTarget } }))))
  }
  return { path, run }
}
const reserve = (j: CaptureJournal["Service"], owner: CaptureClaim, id: string, raw = false) =>
  j.reserve(owner, { id, expectedCheckpoint: owner.checkpoint, beginJson: "{}", rawEnabled: raw, trackRecords: true })
const prepare = (j: CaptureJournal["Service"], owner: CaptureClaim, id: string, value: string | undefined, raw = false, reuse?: string) => Effect.gen(function*() {
  yield* reserve(j, owner, id, raw)
  yield* j.append(owner, id, { kind: "canonical", ordinal: 0, bytes: bytes(`Canonical ${value ?? "empty"}`) })
  for (const kind of ["session", "thread"] as const) {
    yield* j.record(owner, id, input(kind, "root", kind))
    yield* j.bindRecord(owner, id, { kind, key: "root" }, { _tag: "Unit", ordinal: 0 })
  }
  let event
  if (value !== undefined) {
    event = yield* j.record(owner, id, input("event", eventKey.key, value, raw ? `${id}-object` : undefined))
    yield* j.bindRecord(owner, id, eventKey, { _tag: "Unit", ordinal: 0 })
  }
  if (raw) {
    yield* j.record(owner, id, input("raw", rawKey.key, "complete raw A"))
    if (reuse === undefined) yield* j.append(owner, id, { kind: "raw", ordinal: 0, bytes: bytes(`Raw for ${id}`) })
    yield* j.bindRecord(owner, id, rawKey, { _tag: "Unit", ordinal: 0, ...(reuse === undefined ? {} : { captureId: reuse }) })
  }
  yield* j.seal(owner, id, { canonicalUnits: 1, rawUnits: raw && reuse === undefined ? 1 : 0,
    nextCheckpoint: id, manifestJson: "{}", records: { canonical: { session: 1, thread: 1, event: value === undefined ? 0 : 1, usage: 0 },
      ...(raw ? { raw: { records: 1, scopeComplete: true } } : {}) } })
  return event
})
const activate = (j: CaptureJournal["Service"], owner: CaptureClaim, id: string) =>
  j.settle(owner, id, { _tag: "Activated", receiptJson: JSON.stringify({ head: id }) })

describe("Source record journal", () => {
  it("records a complete empty Raw scope so identical reappearance receives a new version", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, first = yield* j.claim(scope)
      yield* prepare(j, first, "present", "A", true); yield* activate(j, first, "present")
      const owner = yield* j.claim(scope)
      yield* j.reserve(owner, { id: "empty", expectedCheckpoint: owner.checkpoint, beginJson: "{}", rawEnabled: true, trackRecords: true, purpose: "raw-observation" })
      const seal = { canonicalUnits: 0, rawUnits: 0, nextCheckpoint: owner.checkpoint!, manifestJson: "{}" }
      expect((yield* j.seal(owner, "empty", { ...seal, records: { raw: { records: 0, scopeComplete: false } } }).pipe(Effect.flip)).reason).toBe("state")
      yield* j.seal(owner, "empty", { ...seal, records: { raw: { records: 0, scopeComplete: true } } })
      yield* activate(j, owner, "empty")
      expect((yield* j.coverage(owner)).observedRawCaptureId).toBe("empty")
      yield* reserve(j, owner, "returned", true)
      expect((yield* j.record(owner, "returned", input("raw", rawKey.key, "complete raw A"))).revision).toBe(2)
    }))
  })
  it("fences metadata access and refuses canceled or changed Raw reuse", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, first = yield* j.claim(scope)
      yield* prepare(j, first, "original", "A", true); yield* activate(j, first, "original")
      const owner = yield* j.claim(scope)
      expect((yield* j.coverage(first).pipe(Effect.flip)).reason).toBe("conflict")
      expect((yield* j.records(first, "original", { kind: "raw" }).pipe(Effect.flip)).reason).toBe("conflict")
      yield* reserve(j, owner, "fresh", true)
      expect((yield* j.record(first, "fresh", input("raw", rawKey.key, "B")).pipe(Effect.flip)).reason).toBe("conflict")
      yield* j.record(owner, "fresh", input("raw", rawKey.key, "complete raw A"))
      expect((yield* j.bindRecord(first, "fresh", rawKey, { _tag: "Unit", captureId: "original", ordinal: 0 }).pipe(Effect.flip)).reason).toBe("conflict")
      yield* j.settle(owner, "original", { _tag: "RawCancellationStarted", reason: "disabled" })
      yield* j.settle(owner, "original", { _tag: "RawUnitCanceled", ordinal: 0 })
      expect((yield* j.bindRecord(owner, "fresh", rawKey, { _tag: "Unit", captureId: "original", ordinal: 0 }).pipe(Effect.flip)).reason).toBe("state")
      yield* j.settle(owner, "fresh", { _tag: "AbandonUnsealed" })
      yield* reserve(j, owner, "changed", true)
      yield* j.record(owner, "changed", input("raw", rawKey.key, "B"))
      expect((yield* j.bindRecord(owner, "changed", rawKey, { _tag: "Unit", captureId: "original", ordinal: 0 }).pipe(Effect.flip)).reason).toBe("conflict")
    }))
  })
  it("keeps partial Raw observations from establishing absence and exposes explicit archive gaps", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, first = yield* j.claim(scope)
      yield* prepare(j, first, "canonical", "A", true); yield* activate(j, first, "canonical")
      const owner = yield* j.claim(scope)
      for (const [id, complete] of [["partial", false], ["complete", true]] as const) {
        yield* j.reserve(owner, { id, expectedCheckpoint: owner.checkpoint, beginJson: "{}", rawEnabled: true, trackRecords: true, purpose: "raw-observation" })
        yield* j.record(owner, id, input("raw", "other/large-row", "metadata fingerprint"))
        yield* j.bindRecord(owner, id, { kind: "raw", key: "other/large-row" }, { _tag: "Unavailable", reason: "limit" })
        yield* j.seal(owner, id, { canonicalUnits: 0, rawUnits: 0, nextCheckpoint: owner.checkpoint!, manifestJson: "{}",
          records: { raw: { records: 1, scopeComplete: complete } } })
        yield* activate(j, owner, id)
        expect((yield* j.records(owner, id, { kind: "raw" }))[0]).toMatchObject({ disposition: "unavailable", unavailableReason: "limit", unit: null })
        expect((yield* j.coverage(owner)).observedRawCaptureId).toBe(complete ? "complete" : "canonical")
        yield* reserve(j, owner, `${id}-check`, true)
        expect((yield* j.record(owner, `${id}-check`, input("raw", rawKey.key, "complete raw A"))).revision).toBe(complete ? 2 : 1)
        yield* j.settle(owner, `${id}-check`, { _tag: "AbandonUnsealed" })
      }
      expect((yield* j.coverage(owner)).canonicalCaptureId).toBe("canonical")
    }))
  })
  it("allocates A→B→A monotonically while keeping observation separate from published coverage", async () => {
    const f = await fixture()
    for (const [id, value, revision] of [["one", "A", 1], ["two", "B", 2], ["three", "A", 3]] as const) {
      await f.run(Effect.gen(function*() {
        const j = yield* CaptureJournal, owner = yield* j.claim(scope)
        const prior = yield* j.coverage(owner)
        expect((yield* prepare(j, owner, id, value))!.revision).toBe(revision)
        expect(yield* j.coverage(owner)).toEqual({ ...prior, observedCanonicalCaptureId: id })
        expect((yield* j.records(owner, id, { kind: "event" }))[0]!.disposition).toBe("pending")
        yield* activate(j, owner, id)
        expect((yield* j.coverage(owner)).canonicalCaptureId).toBe(id)
        expect((yield* j.records(owner, id, { kind: "event" }))[0]!.disposition).toBe("published")
        expect(yield* j.reclaim(owner, id)).toBe(1)
      }))
    }
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* activate(j, owner, "one")
      expect(owner.checkpoint).toBe("three"); expect((yield* j.coverage(owner)).canonicalCaptureId).toBe("three")
    }))
  })
  it("consumes abandoned revisions, refuses stitched observations and changes versions for a new projection profile", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* reserve(j, owner, "discarded")
      expect((yield* j.record(owner, "discarded", input("event", eventKey.key, "A"))).revision).toBe(1)
      const conflict = yield* j.record(owner, "discarded", input("event", eventKey.key, "B")).pipe(Effect.flip)
      expect(conflict.reason).toBe("conflict")
      yield* j.settle(owner, "discarded", { _tag: "AbandonUnsealed" })
      yield* reserve(j, owner, "next")
      expect((yield* j.record(owner, "next", input("event", eventKey.key, "B"))).revision).toBe(2)
      yield* j.settle(owner, "next", { _tag: "AbandonUnsealed" })
      yield* reserve(j, owner, "profile")
      expect((yield* j.record(owner, "profile", { ...input("event", eventKey.key, "B"), projectionVersion: "projection-v2" })).revision).toBe(3)
      expect(yield* j.coverage(owner)).toEqual({ canonicalCaptureId: null, observedCanonicalCaptureId: null, observedRawCaptureId: null })
    }))
  })
  it("only a complete sealed comparison establishes absence before reappearance", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, first = yield* j.claim(scope)
      yield* prepare(j, first, "present", "A"); yield* activate(j, first, "present")
      const owner = yield* j.claim(scope)
      yield* reserve(j, owner, "failed-page"); yield* j.settle(owner, "failed-page", { _tag: "AbandonUnsealed" })
      expect((yield* prepare(j, owner, "still-present", "A"))!.revision).toBe(1)
      yield* j.settle(owner, "still-present", { _tag: "Rejected", receiptJson: "{}" })
      yield* prepare(j, owner, "absent", undefined)
      yield* j.settle(owner, "absent", { _tag: "Rejected", receiptJson: "{}" })
      expect((yield* j.coverage(owner)).canonicalCaptureId).toBe("present")
      yield* reserve(j, owner, "return-interrupted")
      expect((yield* j.record(owner, "return-interrupted", input("event", eventKey.key, "A"))).revision).toBe(2)
      yield* j.settle(owner, "return-interrupted", { _tag: "AbandonUnsealed" })
      expect((yield* prepare(j, owner, "returned", "A"))!.revision).toBe(2)
    }))
  })
  it("retains original Event provenance but never reuses an unactivated orphan reference", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* reserve(j, owner, "orphan", true)
      expect((yield* j.record(owner, "orphan", input("event", eventKey.key, "A", "orphan-object"))).revision).toBe(1)
      yield* j.settle(owner, "orphan", { _tag: "AbandonUnsealed" })
      const adopted = yield* prepare(j, owner, "adopted", "A", true)
      expect(adopted).toMatchObject({ revision: 2, rawReference: { _tag: "object", sourceObjectId: "adopted-object" } })
      yield* activate(j, owner, "adopted")
      const current = yield* j.claim(scope)
      const reused = yield* prepare(j, current, "same", "A", true, "adopted")
      expect(reused).toMatchObject({ revision: 2, rawReference: { _tag: "object", sourceObjectId: "adopted-object" } })
    }))
  })
  it("derives reused Raw coverage from actual pending, ACK and cancellation without rewriting membership", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, first = yield* j.claim(scope)
      yield* prepare(j, first, "original", "A", true); yield* activate(j, first, "original")
      const owner = yield* j.claim(scope)
      yield* prepare(j, owner, "newer", "B", true, "original"); yield* activate(j, owner, "newer")
      expect((yield* j.records(owner, "newer", { kind: "raw" }))[0]).toMatchObject({ disposition: "pending", unit: { captureId: "original", ordinal: 0 } })
      yield* j.settle(owner, "original", { _tag: "RawCancellationStarted", reason: "disabled" })
      yield* j.settle(owner, "original", { _tag: "RawUnitCanceled", ordinal: 0 })
      expect((yield* j.records(owner, "newer", { kind: "raw" }))[0]!.disposition).toBe("canceled")
      yield* j.settle(owner, "original", { _tag: "RawAcknowledged", ordinal: 0, receiptJson: '{"actual":"late receipt"}' })
      expect((yield* j.records(owner, "newer", { kind: "raw" }))[0]!.disposition).toBe("acknowledged")
      yield* j.reclaim(owner, "original")
      expect((yield* j.coverage(owner)).canonicalCaptureId).toBe("newer")
      expect((yield* j.records(owner, "newer", { kind: "raw" }))[0]!.disposition).toBe("acknowledged")
    }))
  })
  it("rejects Raw-off records, incomplete bindings and changed coverage manifests", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* reserve(j, owner, "off")
      expect((yield* j.record(owner, "off", input("raw", rawKey.key, "private source")).pipe(Effect.flip)).reason).toBe("state")
      expect((yield* j.record(owner, "off", input("event", eventKey.key, "A", "forbidden-object")).pipe(Effect.flip)).reason).toBe("state")
      yield* j.append(owner, "off", { kind: "canonical", ordinal: 0, bytes: bytes("Canonical") })
      const manifest = { canonicalUnits: 1, rawUnits: 0, nextCheckpoint: "off", manifestJson: "{}",
        records: { canonical: { session: 1, thread: 1, event: 0, usage: 0 } } }
      expect((yield* j.seal(owner, "off", manifest).pipe(Effect.flip)).reason).toBe("state")
      for (const kind of ["session", "thread"] as const) yield* j.record(owner, "off", input(kind, "root", kind))
      expect((yield* j.seal(owner, "off", manifest).pipe(Effect.flip)).reason).toBe("state")
      for (const kind of ["session", "thread"] as const) yield* j.bindRecord(owner, "off", { kind, key: "root" }, { _tag: "Unit", ordinal: 0 })
      yield* j.seal(owner, "off", manifest)
      expect((yield* j.seal(owner, "off", { ...manifest, records: { canonical: { session: 1, thread: 1, event: 1, usage: 0 } } }).pipe(Effect.flip)).reason).toBe("state")
    }))
  })
  it("pages known sources and record metadata, including after source content disappears", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* reserve(j, owner, "many")
      for (let n = 0; n < 205; n++) yield* j.record(owner, "many", input("event", `event-${String(n).padStart(3,"0")}`, "A"))
      const first = yield* j.records(owner, "many", { kind: "event", limit: 100 })
      const second = yield* j.records(owner, "many", { kind: "event", afterKey: first.at(-1)!.key, limit: 100 })
      const third = yield* j.records(owner, "many", { kind: "event", afterKey: second.at(-1)!.key, limit: 100 })
      expect([first.length,second.length,third.length]).toEqual([100,100,5])
      yield* j.settle(owner, "many", { _tag: "AbandonUnsealed" })
      for (let n = 0; n < 105; n++) yield* j.claim({ ...scope, sourceSessionId: `source-${String(n).padStart(3,"0")}` })
      const sources = yield* j.sources(scope.projectId, scope.adapterId, { limit: 100 })
      expect(sources).toHaveLength(100)
      expect(yield* j.sources(scope.projectId, scope.adapterId, { afterSessionId: sources.at(-1)!.sourceSessionId, limit: 100 })).toHaveLength(6)
      expect(yield* j.sources("other", scope.adapterId, {})).toEqual([])
    }))
  })
  it("bounds metadata admission and prevents implicit version bootstrap over untracked coverage", async () => {
    const f = await fixture(2)
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* reserve(j, owner, "bounded")
      yield* j.record(owner, "bounded", input("session", "root", "A")); yield* j.record(owner, "bounded", input("thread", "root", "A"))
      expect((yield* j.record(owner, "bounded", input("event", eventKey.key, "A")).pipe(Effect.flip)).reason).toBe("capacity")
      const other = yield* j.claim({ ...scope, sourceSessionId: "untracked" })
      yield* j.reserve(other, { id: "legacy", expectedCheckpoint: null, beginJson: "{}", rawEnabled: false })
      yield* j.append(other, "legacy", { kind: "canonical", ordinal: 0, bytes: bytes("old") })
      yield* j.seal(other, "legacy", { canonicalUnits: 1, rawUnits: 0, nextCheckpoint: "old", manifestJson: "{}" })
      yield* activate(j, other, "legacy")
      const current = yield* j.claim(other.scope)
      expect((yield* reserve(j, current, "unsafe-bootstrap").pipe(Effect.flip)).reason).toBe("state")
    }))
  })
})
