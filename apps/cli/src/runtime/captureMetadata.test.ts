import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { CaptureJournal, CaptureJournalError } from "@atape/application"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeCaptureJournalLayer } from "./captureJournal.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const binding = { instanceOrigin: "https://atape.test", userId: "user", installationId: "installation" }
const scope = { projectId: "project", adapterId: "opencode", sourceSessionId: "root", originKey: "origin" }
const limits = { metadataEntries: 5, unitBytes: 512, targetBytes: 4096, pendingBytes: 8192, unitsPerTarget: 10, recordsPerTarget: 10 }
const record = { kind: "session", key: "root", fingerprint: "a".repeat(64), projectionVersion: "v1" } as const
const failure = <A>(work: Effect.Effect<A, CaptureJournalError>) => work.pipe(Effect.flip)
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-metadata-")); directories.push(directory)
  const path = join(directory, "journal.sqlite")
  let mode: "create" | "open" = "create"
  const run = <A, E>(work: Effect.Effect<A, E, CaptureJournal>, metadataEntries = 5, selectedBinding = binding) => {
    const current = mode; mode = "open"
    return Effect.runPromise(work.pipe(Effect.provide(makeCaptureJournalLayer({ path, mode: current, binding: selectedBinding, limits: { ...limits, metadataEntries } }))))
  }
  return { path, directory, run }
}

const removeAccounting = (db: DatabaseSync) => {
  for (const table of ["scopes", "captures", "units", "source_record_versions", "capture_records"]) {
    db.exec(`DROP TRIGGER metadata_${table}_insert; DROP TRIGGER metadata_${table}_delete`)
  }
  db.exec("ALTER TABLE binding DROP COLUMN metadata_entries; PRAGMA user_version=5")
}

describe("Account journal metadata admission", () => {
  it("atomically admits new versions and membership while retries, reclamation and abandoned rows preserve accounting", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      const reservation = { id: "first", expectedCheckpoint: null, beginJson: "{}", rawEnabled: false, trackRecords: true }
      yield* j.reserve(owner,reservation)
      yield* j.append(owner,"first",{ kind: "canonical", ordinal: 0, bytes: new Uint8Array([1]) })
      expect(yield* failure(j.record(owner,"first",record))).toMatchObject({ reason: "capacity", message: expect.stringContaining("used 3, limit 4, required 2") })
      expect(yield* j.records(owner,"first",{ kind: "session" })).toEqual([])
      yield* j.reserve(owner,reservation)
      yield* j.append(owner,"first",{ kind: "canonical", ordinal: 0, bytes: new Uint8Array([1]) })
    }),4)
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      // A rejected two-row admission never consumes a source revision.
      expect((yield* j.record(owner,"first",record)).revision).toBe(1)
      expect((yield* j.record(owner,"first",record)).revision).toBe(1)
      yield* j.bindRecord(owner,"first",record,{ _tag: "Unit", ordinal: 0 })
      expect(yield* failure(j.claim({ ...scope, sourceSessionId: "another" }))).toMatchObject({ reason: "capacity" })
      const current = yield* j.claim(scope)
      expect(yield* failure(j.claim({ ...scope, originKey: "changed" }))).toMatchObject({ reason: "binding" })
      expect(yield* failure(j.record(owner,"first",record))).toMatchObject({ reason: "conflict" })
      yield* j.settle(current,"first",{ _tag: "AbandonUnsealed" })
      expect(yield* j.reclaim(current,"first")).toBe(1)
      expect(yield* failure(j.reserve(current,{ id: "second", expectedCheckpoint: null, beginJson: "{}", rawEnabled: false, trackRecords: true }))).toMatchObject({ reason: "capacity" })
    }))
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* j.reserve(owner,{ id: "second", expectedCheckpoint: null, beginJson: "{}", rawEnabled: false, trackRecords: true })
      expect((yield* j.record(owner,"second",{ ...record, fingerprint: "b".repeat(64) })).revision).toBe(2)
      // One new capture + membership: replacing an existing source version is free.
      expect(yield* failure(j.record(owner,"second",{ ...record, key: "new" }))).toMatchObject({ reason: "capacity", message: expect.stringContaining("used 7") })
    }),7)
  })

  it("finishes admitted Canonical and Raw delivery after reopening below current usage", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* j.reserve(owner,{ id: "pending", expectedCheckpoint: null, beginJson: "{}", rawEnabled: true })
      yield* j.append(owner,"pending",{ kind: "canonical", ordinal: 0, bytes: new Uint8Array([1]) })
      expect(yield* failure(j.append(owner,"pending",{ kind: "raw", ordinal: 0, bytes: new Uint8Array([1]) }))).toMatchObject({ reason: "capacity" })
      expect((yield* j.inspect(owner,"pending",{ kind: "raw" })).units).toEqual([])
    }),3)
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* j.append(owner,"pending",{ kind: "raw", ordinal: 0, bytes: new Uint8Array([1]) })
      yield* j.seal(owner,"pending",{ canonicalUnits: 1, rawUnits: 1, nextCheckpoint: "published", manifestJson: "{}" })
    }),4)
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.pending(owner))).toHaveLength(1)
      yield* j.settle(owner,"pending",{ _tag: "CanonicalAcknowledged", ordinal: 0, receiptJson: "{}" })
      yield* j.settle(owner,"pending",{ _tag: "Activated", receiptJson: '{"head":"published"}' })
      expect(yield* j.reclaim(owner,"pending")).toBe(1)
      expect(yield* j.read(owner,"pending","raw",0)).toEqual(new Uint8Array([1]))
      yield* j.settle(owner,"pending",{ _tag: "RawAcknowledged", ordinal: 0, receiptJson: "{}" })
      expect(yield* j.reclaim(owner,"pending")).toBe(1)
      expect(yield* j.pending(owner)).toEqual([])
      expect((yield* j.claim(scope)).checkpoint).toBe("published")
      const current = yield* j.claim(scope)
      expect(yield* failure(j.reserve(current,{ id: "new", expectedCheckpoint: "published", beginJson: "{}", rawEnabled: false }))).toMatchObject({ reason: "capacity", message: expect.stringContaining("used 4, limit 1") })
    }),1)
  })

  it("verifies the binding before migrating v5 and counts every existing metadata table", async () => {
    const f = await fixture()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* j.reserve(owner,{ id: "old", expectedCheckpoint: null, beginJson: "{}", rawEnabled: false, trackRecords: true })
      yield* j.append(owner,"old",{ kind: "canonical", ordinal: 0, bytes: new Uint8Array([1]) })
      yield* j.record(owner,"old",record)
    }))
    const old = new DatabaseSync(f.path); removeAccounting(old); old.close()
    await expect(f.run(CaptureJournal,1,{ ...binding, userId: "other" })).rejects.toMatchObject({ reason: "binding" })
    const unchanged = new DatabaseSync(f.path); expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(5); unchanged.close()
    await f.run(Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.recordStatus(owner,"old",record))?.revision).toBe(1)
      expect(yield* failure(j.claim({ ...scope, sourceSessionId: "another" }))).toMatchObject({ reason: "capacity", message: expect.stringContaining("used 5, limit 1") })
      yield* j.settle(owner,"old",{ _tag: "AbandonUnsealed" })
      expect(yield* j.reclaim(owner,"old")).toBe(1)
    }),1)
    const upgraded = new DatabaseSync(f.path); expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(6); upgraded.close()
  })

  it("allows only one process to consume the last account-wide metadata slot", async () => {
    const f = await fixture()
    await f.run(CaptureJournal,1)
    const script = join(f.directory,"claim.mjs")
    await writeFile(script, `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { makeCaptureJournalLayer } from ${JSON.stringify(new URL("./captureJournal.ts",import.meta.url).href)};
import { CaptureJournal } from ${JSON.stringify(import.meta.resolve("@atape/application"))};
const work=Effect.gen(function*(){const j=yield* CaptureJournal;yield* j.claim({...${JSON.stringify(scope)},sourceSessionId:process.argv[2]});return "admitted"});
const result=await Effect.runPromise(work.pipe(Effect.provide(makeCaptureJournalLayer(${JSON.stringify({path:f.path,mode:"open",binding,limits:{...limits,metadataEntries:1}})})),Effect.catch(error=>Effect.succeed(error.reason))));
process.stdout.write(result);`)
    const child = (name: string) => new Promise<string>((resolve,reject) => {
      const process = spawn(globalThis.process.execPath,[script,name],{ stdio: ["ignore","pipe","pipe"] })
      let output="", error=""
      process.stdout.on("data",data=>{output+=String(data)})
      process.stderr.on("data",data=>{error+=String(data)})
      process.once("error",reject)
      process.once("exit",code=>code===0?resolve(output):reject(new Error(error)))
    })
    expect((await Promise.all([child("one"),child("two")])).sort()).toEqual(["admitted","capacity"])
    await f.run(Effect.gen(function*() { const j=yield* CaptureJournal;expect(yield* j.sources(scope.projectId,scope.adapterId,{})).toHaveLength(1) }),1)
  })
})
