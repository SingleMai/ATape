import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { CaptureJournal, type CaptureRecordInput, type CaptureOwner, type CaptureJournalError } from "@atape/application"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeCaptureJournalLayer } from "./captureJournal.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const binding = { instanceOrigin: "https://atape.test", userId: "user", installationId: "installation" }
const scope = { projectId: "project", adapterId: "opencode", sourceSessionId: "root", originKey: "origin" }
const bytes = new Uint8Array([1, 2, 3])
const limits = { metadataEntries: 500, unitBytes: 512, targetBytes: 4096, pendingBytes: 8192, recordsPerTarget: 200, unitsPerTarget: 100 }
const input = (kind: CaptureRecordInput["kind"], key: string, fingerprint = "same"): CaptureRecordInput =>
  ({ kind, key, fingerprint: createHash("sha256").update(fingerprint).digest("hex"), projectionVersion: "v1",
    ...(kind === "event" ? { rawReference: { _tag: "unavailable", reason: "Raw disabled" } as const } : {}) })
const event = { kind: "event", key: "0" } as const
const raw = { kind: "raw", key: "part" } as const
const fail = <A>(work: Effect.Effect<A, CaptureJournalError>) => work.pipe(Effect.flip)
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-retention-")); directories.push(directory)
  const path = join(directory, "journal.sqlite")
  let mode: "create" | "open" = "create"
  return { path, directory, run: <A, E>(work: Effect.Effect<A, E, CaptureJournal>, metadataEntries = 500, selectedBinding = binding) => {
    const current = mode; mode = "open"
    return Effect.runPromise(work.pipe(Effect.provide(makeCaptureJournalLayer({ path, mode: current, binding: selectedBinding,
      limits: { ...limits, metadataEntries } }))))
  } }
}
const prepare = (j: CaptureJournal["Service"], id: string, options: {
  events?: number; changed?: string; raw?: boolean; reuse?: string; pending?: boolean; reference?: string
} = {}) => Effect.gen(function*() {
  const owner = yield* j.claim(scope), events = options.events ?? 1
  const reservation = { id, expectedCheckpoint: owner.checkpoint, beginJson: "{}", rawEnabled: options.raw ?? false, trackRecords: true }
  yield* j.reserve(owner, reservation)
  yield* j.append(owner, id, { kind: "canonical", ordinal: 0, bytes })
  for (const kind of ["session", "thread"] as const) {
    yield* j.record(owner, id, input(kind, "root"))
    yield* j.bindRecord(owner, id, { kind, key: "root" }, { _tag: "Unit", ordinal: 0 })
  }
  for (let n = 0; n < events; n++) {
    yield* j.record(owner, id, { ...input("event", String(n), n === 0 ? options.changed : undefined),
      ...(options.reference ? { rawReference: { _tag: "object" as const, sourceObjectId: options.reference } } : {}) })
    yield* j.bindRecord(owner, id, { kind: "event", key: String(n) }, { _tag: "Unit", ordinal: 0 })
  }
  if (options.raw) {
    yield* j.record(owner, id, input("raw", raw.key))
    if (options.reuse === undefined) yield* j.append(owner, id, { kind: "raw", ordinal: 0, bytes })
    yield* j.bindRecord(owner, id, raw, { _tag: "Unit", ordinal: 0, ...(options.reuse ? { captureId: options.reuse } : {}) })
  }
  const seal = { canonicalUnits: 1, rawUnits: options.raw && !options.reuse ? 1 : 0, nextCheckpoint: id, manifestJson: "{}",
    records: { canonical: { session: 1, thread: 1, event: events, usage: 0 }, ...(options.raw ? { raw: { records: 1, scopeComplete: true } } : {}) } }
  yield* j.seal(owner, id, seal)
  if (!options.pending) {
    yield* j.settle(owner, id, { _tag: "CanonicalAcknowledged", ordinal: 0, receiptJson: "{}" })
    yield* j.settle(owner, id, { _tag: "Activated", receiptJson: JSON.stringify({ head: id }) })
    yield* j.reclaim(owner, id)
  }
  return { owner, reservation, seal }
})
const drain = (j: CaptureJournal["Service"], owner: CaptureOwner) => Effect.gen(function*() {
  let count = 0
  for (;;) { const removed = yield* j.pruneRecords(owner); if (removed === 0) return count; count += removed }
})

describe("Capture observation retention", () => {
  it("verifies the binding before upgrading v6 and initializes existing membership without pruning it", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal
      yield* prepare(j, "old"); yield* prepare(j, "current", { changed: "new" })
    }))
    const old = new DatabaseSync(f.path)
    old.exec("DROP INDEX obsolete_capture_records; ALTER TABLE captures DROP COLUMN records_retired; ALTER TABLE captures DROP COLUMN retained_records; PRAGMA user_version=6"); old.close()
    await expect(f.run(CaptureJournal, 1, { ...binding, userId: "other" })).rejects.toMatchObject({ reason: "binding" })
    const unchanged = new DatabaseSync(f.path)
    expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(6); unchanged.close()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.records(owner, "old", { kind: "event" }))).toHaveLength(1)
      expect(yield* drain(j, owner)).toBe(3)
      expect((yield* j.recordStatus(owner, "current", event))?.revision).toBe(2)
      expect(owner.checkpoint).toBe("current")
    }), 1)
  })

  it("resumes committed batches after SIGKILL with the current pending Raw bytes unchanged", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal
      yield* prepare(j, "old", { events: 60 })
      yield* prepare(j, "current", { events: 60, raw: true })
    }))
    const script = join(f.directory, "interrupt.mjs")
    await writeFile(script, `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { CaptureJournal } from ${JSON.stringify(import.meta.resolve("@atape/application"))};
import { makeCaptureJournalLayer } from ${JSON.stringify(new URL("./captureJournal.ts", import.meta.url).href)};
await Effect.runPromise(Effect.gen(function*() {
  const j=yield* CaptureJournal, owner=yield* j.claim(${JSON.stringify(scope)});
  if ((yield* j.pruneRecords(owner,30))!==30) throw new Error("Unexpected retirement count");
  process.kill(process.pid,"SIGKILL");
}).pipe(Effect.provide(makeCaptureJournalLayer(${JSON.stringify({ path: f.path, mode: "open", binding, limits })}))));`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"], timeout: 10000 })
      let errors = ""; child.stderr.on("data", data => { errors += String(data) })
      child.once("error", reject)
      child.once("exit", (code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(`Child ${code}/${signal}: ${errors}`)))
    })
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(yield* drain(j, owner)).toBe(32)
      expect(yield* j.read(owner, "current", "raw", 0)).toEqual(bytes)
      expect((yield* j.recordStatus(owner, "current", raw))?.disposition).toBe("pending")
      expect(owner.checkpoint).toBe("current")
    }))
  })

  it("retires bounded historical pages across reopen while preserving proof replay and owner fencing", async () => {
    const f = await fixture()
    const original = await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, first = yield* prepare(j, "old", { events: 60 })
      const current = yield* prepare(j, "current", { events: 60, changed: "new" })
      expect(yield* fail(j.pruneRecords(first.owner))).toMatchObject({ reason: "conflict" })
      expect(yield* fail(j.pruneRecords(current.owner, 101))).toMatchObject({ reason: "invalid" })
      expect(yield* j.pruneRecords(current.owner, 30)).toBe(30)
      expect((yield* j.inspect(current.owner, "old", { kind: "canonical" })).capture.recordsRetired).toBe(true)
      expect(yield* fail(j.records(current.owner, "old", { kind: "event" }))).toMatchObject({ reason: "state" })
      expect(yield* fail(j.recordStatus(current.owner, "old", event))).toMatchObject({ reason: "state" })
      return first
    }))
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(yield* drain(j, owner)).toBe(32)
      expect((yield* j.records(owner, "current", { kind: "event", limit: 100 }))).toHaveLength(60)
      yield* j.reserve(owner, original.reservation)
      yield* j.seal(owner, "old", original.seal)
      yield* j.settle(owner, "old", { _tag: "Activated", receiptJson: '{"head":"old"}' })
      yield* j.settle(owner, "old", { _tag: "CanonicalAcknowledged", ordinal: 0, receiptJson: "{}" })
      yield* j.append(owner, "old", { kind: "canonical", ordinal: 0, bytes })
      expect(yield* fail(j.append(owner, "old", { kind: "canonical", ordinal: 0, bytes: new Uint8Array([4]) }))).toMatchObject({ reason: "conflict" })
      expect(yield* fail(j.seal(owner, "old", { ...original.seal, nextCheckpoint: "wrong" }))).toMatchObject({ reason: "conflict" })
      expect(yield* fail(j.settle(owner, "old", { _tag: "Activated", receiptJson: "{}" }))).toMatchObject({ reason: "conflict" })
      expect(yield* fail(j.record(owner, "old", input("event", "0")))).toMatchObject({ reason: "state" })
      expect((yield* j.claim(scope)).checkpoint).toBe("current")
    }), 1)
  })

  it("protects both observed and published roots and never retires independently pending Raw", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal
      yield* prepare(j, "raw-owner", { raw: true, reference: "original-object" })
      yield* prepare(j, "second", { raw: true, reuse: "raw-owner", reference: "new-proposal" })
      let { owner } = yield* prepare(j, "sealed", { raw: true, reuse: "second", pending: true })
      expect(yield* j.pruneRecords(owner)).toBe(0)
      yield* j.settle(owner, "sealed", { _tag: "Rejected", receiptJson: "{}" })
      expect(yield* j.pruneRecords(owner)).toBe(0) // Latest complete observation remains protected even after rejection.
      yield* j.settle(owner, "raw-owner", { _tag: "RawAcknowledged", ordinal: 0, receiptJson: '{"offset":3}' })
      yield* j.reclaim(owner, "raw-owner")
      expect(yield* drain(j, owner)).toBe(4)
      expect((yield* j.recordStatus(owner, "second", raw))?.disposition).toBe("acknowledged")
      const latest = yield* prepare(j, "third", { raw: true, reuse: "second", reference: "another-proposal" }); owner = latest.owner
      expect((yield* j.recordStatus(owner, "third", raw))?.unit?.captureId).toBe("raw-owner")
      expect((yield* j.recordStatus(owner, "third", event))?.rawReference).toEqual({ _tag: "object", sourceObjectId: "original-object" })
      yield* drain(j, owner)
      yield* j.settle(owner, "raw-owner", { _tag: "RawAcknowledged", ordinal: 0, receiptJson: '{"offset":3}' })
      expect((yield* j.inspect(owner, "raw-owner", { kind: "raw" })).units[0]).toMatchObject({ disposition: "acknowledged", retained: false })
    }))
  })

  it("keeps monotonic absent/reappearing and abandoned versions after their memberships are retired", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal
      yield* prepare(j, "present")
      const empty = yield* prepare(j, "absent", { events: 0 })
      expect(yield* drain(j, empty.owner)).toBe(3)
      let owner = yield* j.claim(scope)
      yield* j.reserve(owner, { id: "aborted", expectedCheckpoint: owner.checkpoint, beginJson: "{}", rawEnabled: true, trackRecords: true })
      expect((yield* j.record(owner, "aborted", { ...input("event", "0"),
        rawReference: { _tag: "object", sourceObjectId: "unpublished-object" } })).revision).toBe(2)
      yield* j.settle(owner, "aborted", { _tag: "AbandonUnsealed" })
      expect(yield* drain(j, owner)).toBe(1)
      const returned = yield* prepare(j, "returned", { raw: true, reference: "published-object" }); owner = returned.owner
      expect((yield* j.recordStatus(owner, "returned", event))?.revision).toBe(3)
      expect((yield* j.recordStatus(owner, "returned", event))?.rawReference).toEqual({ _tag: "object", sourceObjectId: "published-object" })
      const same = yield* prepare(j, "same")
      expect((yield* j.recordStatus(same.owner, "same", event))?.revision).toBe(3)
    }))
  })

  it("reuses the same admission through twenty complete rewrites without dropping current membership", async () => {
    const f = await fixture()
    for (let n = 0; n < 20; n++) await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, { owner } = yield* prepare(j, `capture-${n}`, { events: 60, changed: String(n) })
      yield* drain(j, owner)
      expect((yield* j.records(owner, `capture-${n}`, { kind: "event", limit: 100 }))).toHaveLength(60)
      expect((yield* j.recordStatus(owner, `capture-${n}`, event))?.revision).toBe(n + 1)
      expect(yield* j.pending(owner)).toEqual([])
    }), 250)
  })
})
