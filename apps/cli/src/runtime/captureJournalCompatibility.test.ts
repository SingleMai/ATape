import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { openCaptureJournal } from "./captureJournal.ts"
import { captureJournalV7, type CaptureJournalV7 } from "./fixtures/capture-journal-v7.ts"
import { binding, scope, limits, activated, sealed, raw, sha, activationReceipt, canonicalReceipt, rawReceipt, prepare, snapshot } from "./fixtures/capture-migration-state.ts"

const schemaVersion = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare("PRAGMA user_version").get()?.user_version }
  finally { db.close() }
}

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
    expect(historical.proof).toMatchObject({ tag: "v0.5.3", revision: "0840d6a7061f3a38302f2ed97a4d26915d238845",
      dependencyMode: "historical-frozen-lock", lockSha256: "e2f3ca5c7bc99a43dd4e9e0c89b624abc6639eb5b84050023a3cfd6dfc044bda",
      publicIndexSha256: "3652260ff39bd74c11e51f5a25e24620fb9825c3b687c9880ecd9616e8e5e8b2",
      toolchain: { pnpm: "11.7.0", effect: "4.0.0-rc.112", esbuild: "0.28.2" } })
    expect(historical.proof.sources).toEqual([
      { path: "apps/cli/src/runtime/captureJournal.ts", bytes: 51517, sha256: "ca965bf61bccd11060d8c88206e4289943e6c30801bc27149e3b2e44dc01f6f2" },
      { path: "packages/application/src/captureJournal.ts", bytes: 9405, sha256: "d05b28196d1d4c711d92cbea7288da82455345700a8f522c3853e5a1bea22022" }
    ])
    expect(historical.proof.inputs).toEqual(expect.arrayContaining([
      { path: "pnpm-lock.yaml", bytes: 178939, sha256: historical.proof.lockSha256 },
      { path: "packages/application/src/index.ts", bytes: 1118, sha256: historical.proof.publicIndexSha256 }
    ]))
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
}, 300_000)
