// Real local-substitutable storage failure, through the caller's journal Interface.
// Only the dedicated small tmpfs created by verify-capture-disk.mjs may be filled.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, fsyncSync, openSync, statfsSync, unlinkSync, writeSync } from "node:fs"
import { Effect } from "effect"
import { openCaptureJournal } from "../captureJournal.ts"

const path = "/disk/capture.sqlite", fill = "/disk/fill"
const filesystem = statfsSync("/disk")
assert.equal(filesystem.type, 0x01021994, "This contract must run on its dedicated tmpfs")
assert.equal(filesystem.blocks * filesystem.bsize, 16 * 1024 * 1024)
const binding = { instanceOrigin: "https://disk.example.test", userId: "fixture", installationId: "fixture" }
const limits = { unitBytes: 4 * 1024 * 1024, targetBytes: 32 * 1024 * 1024, pendingBytes: 64 * 1024 * 1024,
  unitsPerTarget: 100, recordsPerTarget: 1000, metadataEntries: 10000 }
const scope = { projectId: "fixture", adapterId: "fixture", sourceSessionId: "frozen", originKey: "fixture" }
const nextScope = { ...scope, sourceSessionId: "new" }
const payload = Buffer.alloc(512 * 1024, 0x61), nextPayload = Buffer.alloc(2 * 1024 * 1024, 0x62)
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const open = (mode: "create" | "open") => openCaptureJournal({ path, binding, limits, mode })
type Journal = Effect.Success<ReturnType<typeof open>>
type Owner = Effect.Success<ReturnType<Journal["claim"]>>
const snapshot = (journal: Journal, owner: Owner) => Effect.gen(function*() {
  const inspected = yield* journal.inspect(owner, "frozen", { kind: "canonical", limit: 10 })
  const bytes = yield* journal.read(owner, "frozen", "canonical", 0)
  return { checkpoint: owner.checkpoint, coverage: yield* journal.coverage(owner), ...inspected,
    record: yield* journal.recordStatus(owner, "frozen", { kind: "session", key: "frozen" }),
    payload: { bytes: bytes.byteLength, sha256: sha(bytes) } }
})
const fillDisk = () => {
  const file = openSync(fill, "wx", 0o600)
  let written = 0
  try {
    for (const size of [65536, 4096, 1]) {
      const bytes = Buffer.alloc(size, 0x66)
      for (;;) {
        try { const count = writeSync(file, bytes); assert.ok(count > 0); written += count }
        catch (cause) { assert.equal((cause as NodeJS.ErrnoException).code, "ENOSPC"); break }
      }
    }
    fsyncSync(file)
  } finally { closeSync(file) }
  const fs = statfsSync("/disk")
  assert.equal(fs.bavail * fs.bsize, 0)
  return { code: "ENOSPC", writtenBytes: written, availableBytes: 0 }
}

const phase = process.argv[2]
if (phase === "orchestrate") {
  const results: Record<string, any> = {}
  for (const step of ["seed", "fill-write", "reopen", "free", "recover"]) {
    const child = spawnSync(process.execPath, [process.argv[1]!, step], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 })
    assert.equal(child.status, 0, `${step}: ${child.error ?? child.stderr}`)
    results[step] = JSON.parse(child.stdout)
  }
  const baseline = results.seed
  for (const observed of [results["fill-write"].before, results["fill-write"].after, results.reopen, results.recover.before, results.recover.after]) {
    assert.deepEqual(observed, baseline, "Failure/reopen must preserve all frozen bytes, versions and unconfirmed progress")
  }
  assert.equal(baseline.checkpoint, null)
  assert.equal(baseline.capture.activationReceipt, null)
  assert.equal(baseline.capture.state, "sealed")
  assert.equal(baseline.record.revision, 1)
  assert.equal(baseline.units[0].disposition, "pending")
  assert.equal(baseline.units[0].receiptJson, null)
  assert.deepEqual(baseline.payload, { bytes: payload.byteLength, sha256: sha(payload) })
  assert.deepEqual(results.recover.next, { bytes: nextPayload.byteLength, sha256: sha(nextPayload) })
  process.stdout.write(JSON.stringify({ verified: "physical ENOSPC, capacity failure, atomic rollback, fresh-process recovery",
    node: process.version, platform: process.platform, arch: process.arch, frozen: baseline.payload, fill: results["fill-write"].fill }) + "\n")
} else if (phase === "free") {
  unlinkSync(fill)
  process.stdout.write("{}\n")
} else {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const journal = yield* open(phase === "seed" ? "create" : "open")
    const owner = yield* journal.claim(scope)
    if (phase === "seed") {
      yield* journal.reserve(owner, { id: "frozen", expectedCheckpoint: null, beginJson: "{}", rawEnabled: false, trackRecords: true })
      for (const [kind, key] of [["session", "frozen"], ["thread", "root"]] as const) {
        yield* journal.record(owner, "frozen", { kind, key, fingerprint: sha(Buffer.from(key)), projectionVersion: "fixture.v1" })
      }
      yield* journal.append(owner, "frozen", { kind: "canonical", ordinal: 0, bytes: payload })
      for (const [kind, key] of [["session", "frozen"], ["thread", "root"]] as const) {
        yield* journal.bindRecord(owner, "frozen", { kind, key }, { _tag: "Unit", ordinal: 0 })
      }
      yield* journal.seal(owner, "frozen", { canonicalUnits: 1, rawUnits: 0, nextCheckpoint: "unconfirmed", manifestJson: "{}",
        records: { canonical: { session: 1, thread: 1, event: 0, usage: 0 } } })
      yield* journal.reserve(yield* journal.claim(nextScope), { id: "new", expectedCheckpoint: null, beginJson: "{}", rawEnabled: false })
      return yield* snapshot(journal, owner)
    }
    if (phase === "reopen") return yield* snapshot(journal, owner)
    const nextOwner = yield* journal.claim(nextScope), before = yield* snapshot(journal, owner)
    if (phase === "fill-write") {
      const fill = yield* Effect.sync(fillDisk)
      const error = yield* journal.append(nextOwner, "new", { kind: "canonical", ordinal: 0, bytes: nextPayload }).pipe(
        Effect.match({ onSuccess: () => null, onFailure: error => ({ _tag: error._tag, reason: error.reason }) }))
      assert.deepEqual(error, { _tag: "CaptureJournalError", reason: "capacity" })
      const rejected = yield* journal.inspect(nextOwner, "new", { kind: "canonical", limit: 10 })
      assert.deepEqual(rejected.units, [])
      assert.equal(rejected.capture.retainedBytes, 0)
      return { before, after: yield* snapshot(journal, owner), fill }
    }
    assert.equal(phase, "recover")
    yield* journal.append(nextOwner, "new", { kind: "canonical", ordinal: 0, bytes: nextPayload })
    yield* journal.seal(nextOwner, "new", { canonicalUnits: 1, rawUnits: 0, nextCheckpoint: "still-unconfirmed", manifestJson: "{}" })
    const bytes = yield* journal.read(nextOwner, "new", "canonical", 0)
    return { before, after: yield* snapshot(journal, owner), next: { bytes: bytes.byteLength, sha256: sha(bytes) } }
  })))
  process.stdout.write(JSON.stringify(result) + "\n")
}
