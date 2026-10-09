import type { CaptureOwner, CaptureRecordInput } from "@atape/application"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { openCaptureJournal } from "./captureJournal.ts"
import { captureJournalV7, type CaptureJournalV7 } from "./fixtures/capture-journal-v7.ts"

const binding = { instanceOrigin: "https://journal-upgrade.test", userId: "historical-user", installationId: "historical-installation" }
const scope = { projectId: "historical-project", adapterId: "claude", sourceSessionId: "historical-session", originKey: "frozen-origin" }
const limits = { unitBytes: 512, targetBytes: 4096, pendingBytes: 8192, metadataEntries: 1000, unitsPerTarget: 16, recordsPerTarget: 16 }
const bytes = (value: string) => new TextEncoder().encode(value)
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const activated = "01-activated-with-raw-pending"
const sealed = "02-sealed-with-canonical-pending"
const canonical = (id: string, ordinal: number) => bytes(`Frozen Canonical ${id}/${ordinal} 空格`)
const raw = (id: string, ordinal: number) => bytes(`Frozen Raw ${id}/${ordinal}\u0000body`)
const activationReceipt = '{"head":"historical-activated-head"}'
const canonicalReceipt = (id: string, ordinal: number) => JSON.stringify({ capture: id, canonical: ordinal })
const rawReceipt = (id: string, ordinal: number) => JSON.stringify({ capture: id, raw: ordinal })
const schemaVersion = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare("PRAGMA user_version").get()?.user_version }
  finally { db.close() }
}
const records = (id: string, rawCount: number): readonly CaptureRecordInput[] => [
  ...(["session", "thread", "event"] as const).map(kind => ({ kind, key: `${kind}-identity`,
    fingerprint: sha(bytes(`${id}/${kind}`)), projectionVersion: "historical-projection-v1",
    ...(kind === "event" ? { rawReference: { _tag: "object" as const, sourceObjectId: "raw-0", fragment: "event-fragment" } } : {}) })),
  ...Array.from({ length: rawCount }, (_, ordinal) => ({ kind: "raw" as const, key: `raw-${ordinal}`,
    fingerprint: sha(raw(id, ordinal)), projectionVersion: "historical-raw-v1" }))
]
const prepare = (runtime: typeof Effect, journal: CaptureJournalV7, owner: CaptureOwner,
  id: string, checkpoint: string | null, rawCount: number) => runtime.gen(function*() {
  yield* journal.reserve(owner, { id, expectedCheckpoint: checkpoint, beginJson: JSON.stringify({ capture: id }), rawEnabled: true, trackRecords: true })
  for (const ordinal of [0, 1]) yield* journal.append(owner, id, { kind: "canonical", ordinal, bytes: canonical(id, ordinal) })
  for (let ordinal = 0; ordinal < rawCount; ordinal++) yield* journal.append(owner, id, { kind: "raw", ordinal, bytes: raw(id, ordinal) })
  for (const record of records(id, rawCount)) {
    yield* journal.record(owner, id, record)
    yield* journal.bindRecord(owner, id, record, { _tag: "Unit",
      ordinal: record.kind === "raw" ? Number(record.key.slice(4)) : record.kind === "event" ? 1 : 0 })
  }
  yield* journal.seal(owner, id, { canonicalUnits: 2, rawUnits: rawCount, nextCheckpoint: id === activated ? "cursor-1" : "cursor-2",
    manifestJson: JSON.stringify({ frozen: id }), records: { canonical: { session: 1, thread: 1, event: 1, usage: 0 }, raw: { records: rawCount, scopeComplete: true } } })
})
const snapshot = (runtime: typeof Effect, journal: CaptureJournalV7) => runtime.gen(function*() {
  const owner = yield* journal.claim(scope)
  const captures = []
  for (const id of [activated, sealed]) {
    const recordPages = []
    for (const kind of ["session", "thread", "event", "raw"] as const) recordPages.push(yield* journal.records(owner, id, { kind }))
    captures.push({ canonical: yield* journal.inspect(owner, id, { kind: "canonical" }),
      raw: yield* journal.inspect(owner, id, { kind: "raw" }), records: recordPages })
  }
  return { binding: journal.binding, scope: owner.scope, checkpoint: owner.checkpoint,
    sources: yield* journal.sources(scope.projectId, scope.adapterId, {}), coverage: yield* journal.coverage(owner),
    pending: yield* journal.pending(owner), unactivated: yield* journal.unactivated(owner), captures,
    canonicalPayloads: [yield* journal.read(owner, activated, "canonical", 0), yield* journal.read(owner, activated, "canonical", 1),
      yield* journal.read(owner, sealed, "canonical", 0), yield* journal.read(owner, sealed, "canonical", 1)],
    // The sealed target's Raw bytes become publicly readable after activation;
    // their exact payload is checked during resumed delivery below.
    pendingRawPayload: yield* journal.read(owner, activated, "raw", 1) }
})

it("recovers genuine published 0.5.3 v7 Canonical/Raw obligations forward to v8 and fences the old reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-journal-v7-upgrade-"))
  const path = join(directory, "capture.sqlite")
  const historical = await captureJournalV7().catch(async cause => {
    await rm(directory, { recursive: true, force: true })
    throw cause
  })
  const old = historical.Effect
  const runOld = <A, E>(mode: "create" | "open", work: (journal: CaptureJournalV7) => Effect.Effect<A, E>) =>
    old.runPromise(old.scoped(historical.openCaptureJournal({ path, mode, binding, limits }).pipe(old.flatMap(work))))
  const runCurrent = <A, E>(work: (journal: CaptureJournalV7) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.scoped(openCaptureJournal({ path, mode: "open", binding, limits }).pipe(Effect.flatMap(work))))
  try {
    expect(historical.proof).toMatchObject({ tag: "v0.5.3", revision: "0840d6a7061f3a38302f2ed97a4d26915d238845" })
    expect(historical.proof.sources.map(source => source.path)).toEqual([
      "apps/cli/src/runtime/captureJournal.ts", "packages/application/src/captureJournal.ts"
    ])
    await runOld("create", journal => old.gen(function*() {
      const owner = yield* journal.claim(scope)
      yield* prepare(old, journal, owner, activated, null, 2)
      for (const ordinal of [0, 1]) yield* journal.settle(owner, activated, { _tag: "CanonicalAcknowledged", ordinal, receiptJson: canonicalReceipt(activated, ordinal) })
      yield* journal.settle(owner, activated, { _tag: "Activated", receiptJson: activationReceipt })
      yield* journal.settle(owner, activated, { _tag: "RawAcknowledged", ordinal: 0, receiptJson: rawReceipt(activated, 0) })
      yield* prepare(old, journal, owner, sealed, "cursor-1", 1)
      yield* journal.settle(owner, sealed, { _tag: "CanonicalAcknowledged", ordinal: 0, receiptJson: canonicalReceipt(sealed, 0) })
    }))
    expect(schemaVersion(path)).toBe(7)
    const before = await runOld("open", journal => snapshot(old, journal))
    expect(before.checkpoint).toBe("cursor-1")
    expect(before.pending.map(capture => capture.id)).toEqual([activated, sealed])
    expect(before.unactivated?.id).toBe(sealed)
    expect(before.captures[0]?.raw.units).toMatchObject([
      { disposition: "acknowledged", receiptJson: rawReceipt(activated, 0), retained: true },
      { disposition: "pending", receiptJson: null, retained: true }
    ])
    expect(before.captures[1]?.canonical.units).toMatchObject([
      { disposition: "acknowledged", receiptJson: canonicalReceipt(sealed, 0), retained: true },
      { disposition: "pending", receiptJson: null, retained: true }
    ])
    // A wrong account must not migrate even a genuine older database.
    await expect(Effect.runPromise(Effect.scoped(openCaptureJournal({ path, mode: "open", limits,
      binding: { ...binding, userId: "other-account" } })))).rejects.toMatchObject({ reason: "binding" })
    expect(schemaVersion(path)).toBe(7)
    expect(await runCurrent(journal => snapshot(Effect, journal))).toEqual(before)
    expect(schemaVersion(path)).toBe(8)
    await expect(runOld("open", journal => old.succeed(journal.binding))).rejects.toMatchObject({ reason: "corrupt" })
    expect(schemaVersion(path)).toBe(8)

    // Reopen after the migration and rejected downgrade. Existing identities,
    // receipt-aware retries and every unconfirmed obligation still agree.
    expect(await runCurrent(journal => snapshot(Effect, journal))).toEqual(before)
    await runCurrent(journal => Effect.gen(function*() {
      const owner = yield* journal.claim(scope)
      expect(yield* journal.recordStatus(owner, activated, { kind: "event", key: "event-identity" })).toMatchObject({
        revision: 1, disposition: "published", rawReference: { _tag: "object", sourceObjectId: "raw-0", fragment: "event-fragment" } })
      expect(yield* journal.recordStatus(owner, sealed, { kind: "event", key: "event-identity" })).toMatchObject({ revision: 2, disposition: "pending" })
      yield* journal.settle(owner, sealed, { _tag: "CanonicalAcknowledged", ordinal: 0, receiptJson: canonicalReceipt(sealed, 0) })
      expect(yield* journal.settle(owner, sealed, { _tag: "CanonicalAcknowledged", ordinal: 0, receiptJson: '{"changed":true}' }).pipe(
        Effect.match({ onFailure: error => error.reason, onSuccess: () => "unexpected-success" }))).toBe("conflict")
      yield* journal.settle(owner, sealed, { _tag: "CanonicalAcknowledged", ordinal: 1, receiptJson: canonicalReceipt(sealed, 1) })
      yield* journal.settle(owner, sealed, { _tag: "Activated", receiptJson: '{"head":"recovered-head"}' })
    }))
    await runCurrent(journal => Effect.gen(function*() {
      const owner = yield* journal.claim(scope)
      expect(owner.checkpoint).toBe("cursor-2")
      expect(yield* journal.read(owner, activated, "raw", 1)).toEqual(raw(activated, 1))
      expect(yield* journal.read(owner, sealed, "raw", 0)).toEqual(raw(sealed, 0))
      expect((yield* journal.inspect(owner, sealed, { kind: "canonical" })).units.map(unit => unit.receiptJson)).toEqual([
        canonicalReceipt(sealed, 0), canonicalReceipt(sealed, 1)
      ])
      // Replaying the old activation must not move the recovered checkpoint back.
      yield* journal.settle(owner, activated, { _tag: "Activated", receiptJson: activationReceipt })
      expect((yield* journal.claim(scope)).checkpoint).toBe("cursor-2")
      const current = yield* journal.claim(scope)
      yield* journal.settle(current, activated, { _tag: "RawAcknowledged", ordinal: 1, receiptJson: rawReceipt(activated, 1) })
      yield* journal.settle(current, sealed, { _tag: "RawAcknowledged", ordinal: 0, receiptJson: rawReceipt(sealed, 0) })
      expect(yield* journal.reclaim(current, activated)).toBe(4)
      expect(yield* journal.reclaim(current, sealed)).toBe(3)
      expect(yield* journal.pending(current)).toEqual([])
    }))
    await runCurrent(journal => Effect.gen(function*() {
      const owner = yield* journal.claim(scope)
      expect(journal.binding).toEqual(binding)
      expect(owner.checkpoint).toBe("cursor-2")
      expect(yield* journal.pending(owner)).toEqual([])
      expect((yield* journal.inspect(owner, activated, { kind: "raw" })).units).toMatchObject([
        { ordinal: 0, digest: sha(raw(activated, 0)), disposition: "acknowledged", retained: false, receiptJson: rawReceipt(activated, 0) },
        { ordinal: 1, digest: sha(raw(activated, 1)), disposition: "acknowledged", retained: false, receiptJson: rawReceipt(activated, 1) }
      ])
      expect((yield* journal.inspect(owner, sealed, { kind: "canonical" })).capture).toMatchObject({
        id: sealed, expectedCheckpoint: "cursor-1", activationReceipt: '{"head":"recovered-head"}', state: "completed" })
      expect(yield* journal.recordStatus(owner, activated, { kind: "event", key: "event-identity" })).toMatchObject({ revision: 1, disposition: "published" })
      expect(yield* journal.recordStatus(owner, sealed, { kind: "event", key: "event-identity" })).toMatchObject({ revision: 2, disposition: "published" })
    }))
  } finally {
    await historical.cleanup()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
