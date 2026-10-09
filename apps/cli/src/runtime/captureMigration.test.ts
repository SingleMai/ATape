import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CaptureJournal, type CaptureJournalError } from "@atape/application"
import { Effect } from "effect"
import { afterEach, expect, it } from "vitest"
import { makeCaptureJournalLayer } from "./captureJournal.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const binding = { instanceOrigin: "https://atape.test", userId: "user", installationId: "installation" }
const scope = { projectId: "project", adapterId: "claude", sourceSessionId: "session", originKey: "original-root" }
const limits = { unitBytes: 1024, targetBytes: 1024 * 1024, pendingBytes: 2 * 1024 * 1024, metadataEntries: 1000, unitsPerTarget: 100, recordsPerTarget: 100 }
const checkpoint = (value: unknown) => {
  const checkpointJson = JSON.stringify(value)
  return { checkpointJson, checkpointDigest: createHash("sha256").update(checkpointJson).digest("hex") }
}
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-migration-journal-")); directories.push(directory)
  const path = join(directory,"journal.sqlite")
  let mode: "create" | "open" = "create"
  const run = <A, E>(work: Effect.Effect<A,E,CaptureJournal>, selectedLimits = limits, selectedBinding = binding) => {
    const current = mode; mode = "open"
    return Effect.runPromise(work.pipe(Effect.provide(makeCaptureJournalLayer({ path, mode: current, binding: selectedBinding, limits: selectedLimits }))))
  }
  return { path, run }
}
const failed = <A>(work: Effect.Effect<A,CaptureJournalError>) => work.pipe(Effect.flip)

it("freezes large exact checkpoints by digest so a lost CAS can safely select a later acknowledged checkpoint", async () => {
  const f = await fixture(), first = checkpoint({ cursor: "opaque:" + "a".repeat(256 * 1024), rawObjects: [{ offset: 812, receipt: "ack" }] }), later = checkpoint({ cursor: "later" })
  await f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal
    expect(yield* journal.freezeLegacyMigration(scope.projectId,scope.adapterId,first)).toEqual(first)
    expect(yield* journal.freezeLegacyMigration(scope.projectId,scope.adapterId,first)).toEqual(first)
    yield* journal.freezeLegacyMigration(scope.projectId,scope.adapterId,later)
    expect(yield* failed(journal.freezeLegacyMigration(scope.projectId,scope.adapterId,{ ...first,checkpointJson: "{}" }))).toMatchObject({ reason: "invalid" })
  }))
  await f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal
    expect(yield* journal.legacyMigration(scope.projectId,scope.adapterId,first.checkpointDigest)).toEqual(first)
    expect(yield* journal.legacyMigration(scope.projectId,scope.adapterId,later.checkpointDigest)).toEqual(later)
    expect(yield* journal.legacyMigration("other",scope.adapterId,first.checkpointDigest)).toBeNull()
  }))
  await expect(f.run(Effect.void,limits,{ ...binding,installationId: "other" })).rejects.toMatchObject({ reason: "binding" })
})

it("persists the authenticated revision floor before allocating any new records and fences stale owners", async () => {
  const f = await fixture(), metadataJson = JSON.stringify({ threads: [{ sourceThreadId: "root" }] })
  await f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
    yield* journal.adoptBaseline(owner,{ revisionFloor: 900,metadataJson })
    expect(yield* journal.recordFloor(owner)).toBe(900)
    expect(yield* journal.sourceMetadata(owner,null)).toBe(metadataJson)
    expect(yield* failed(journal.adoptBaseline(owner,{ revisionFloor: 899,metadataJson }))).toMatchObject({ reason: "conflict" })
    const current = yield* journal.claim(scope)
    expect(yield* failed(journal.adoptBaseline(owner,{ revisionFloor: 900,metadataJson }))).toMatchObject({ reason: "conflict" })
    yield* journal.reserve(current,{ id: "first",expectedCheckpoint: null,beginJson: "{}",rawEnabled: false,trackRecords: true })
    yield* journal.setSourceMetadata(current,"first",'{"sourceCheckpoint":"old-proof"}')
    for (const kind of ["session","thread","event","usage"] as const) {
      const record = yield* journal.record(current,"first",{ kind,key: kind,fingerprint: "a".repeat(64),projectionVersion: "v2",
        ...(kind === "event" ? { rawReference: { _tag: "unavailable" as const,reason: "Raw off" } } : {}) })
      expect(record.revision).toBe(901)
    }
    expect(yield* failed(journal.setSourceMetadata(current,"first",'{"sourceCheckpoint":"changed"}'))).toMatchObject({ reason: "conflict" })
    yield* journal.settle(current,"first",{ _tag: "AbandonUnsealed" })
    expect(yield* journal.sourceMetadata(current,"first")).toBeNull()
  }))
  await f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
    expect(yield* journal.recordFloor(owner)).toBe(900)
    yield* journal.reserve(owner,{ id: "second",expectedCheckpoint: null,beginJson: "{}",rawEnabled: false,trackRecords: true })
    expect((yield* journal.record(owner,"second",{ kind: "session",key: "session",fingerprint: "b".repeat(64),projectionVersion: "v2" })).revision).toBe(902)
    expect(yield* failed(journal.adoptBaseline(owner,{ revisionFloor: Number.MAX_SAFE_INTEGER,metadataJson }))).toMatchObject({ reason: "invalid" })
  }))
})

it("keeps only selected source headers after activation while failed preparation preserves the prior header", async () => {
  const f = await fixture()
  await f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal
    let owner = yield* journal.claim(scope)
    for (const id of ["first","failed","second"]) {
      yield* journal.reserve(owner,{ id,expectedCheckpoint: owner.checkpoint,beginJson: "{}",rawEnabled: false })
      const metadata = JSON.stringify({ sourceCheckpoint: id })
      yield* journal.setSourceMetadata(owner,id,metadata)
      yield* journal.append(owner,id,{ kind: "canonical",ordinal: 0,bytes: new Uint8Array([1]) })
      if (id === "failed") {
        yield* journal.settle(owner,id,{ _tag: "AbandonUnsealed" })
        expect(yield* journal.sourceMetadata(owner,"first")).toBe('{"sourceCheckpoint":"first"}')
        expect(yield* journal.sourceMetadata(owner,id)).toBeNull()
        continue
      }
      yield* journal.seal(owner,id,{ canonicalUnits: 1,rawUnits: 0,nextCheckpoint: id,manifestJson: "{}" })
      yield* journal.settle(owner,id,{ _tag: "Activated",receiptJson: JSON.stringify({ head: id }) })
      yield* journal.reclaim(owner,id)
      expect(yield* journal.sourceMetadata(owner,id)).toBe(metadata)
      owner = yield* journal.claim(scope)
    }
    expect(yield* journal.sourceMetadata(owner,"first")).toBeNull()
    expect(yield* journal.sourceMetadata(owner,"second")).toBe('{"sourceCheckpoint":"second"}')
  }))
})

it("accounts frozen metadata against byte admission and detects corrupted metadata before recovery", async () => {
  const f = await fixture(), frozen = checkpoint({ cursor: "a".repeat(400) }), tiny = { ...limits,unitBytes: 64,targetBytes: 512,pendingBytes: 512 }
  await f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
    yield* journal.freezeLegacyMigration(scope.projectId,scope.adapterId,frozen)
    yield* journal.reserve(owner,{ id: "capture",expectedCheckpoint: null,beginJson: "{}",rawEnabled: false })
    expect(yield* failed(journal.setSourceMetadata(owner,"capture",JSON.stringify({ proof: "b".repeat(200) })))).toMatchObject({ reason: "capacity" })
    expect(yield* journal.sourceMetadata(owner,"capture")).toBeNull()
  }),tiny)
  const db = new DatabaseSync(f.path)
  db.prepare("UPDATE legacy_migrations SET checkpoint_json=?").run('{"cursor":"changed"}')
  db.close()
  await expect(f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal
    return yield* journal.legacyMigration(scope.projectId,scope.adapterId,frozen.checkpointDigest)
  }),tiny)).rejects.toMatchObject({ reason: "corrupt" })
})
