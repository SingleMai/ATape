import type { CaptureOwner, CaptureRecordInput } from "@atape/application"
import { emptyCollectorState } from "@atape/domain"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import type { NodeClientPaths } from "../clientPaths.ts"
import type { RuntimeContext } from "../runtimeAdmission.ts"
import { atomicJSON } from "../runtimeFiles.ts"
import { openCaptureJournal } from "../captureJournal.ts"
import { captureJournalV7, type CaptureJournalV7 } from "./capture-journal-v7.ts"

export const binding = { instanceOrigin: "https://journal-upgrade.test", userId: "historical-user", installationId: "historical-installation" }
export const scope = { projectId: "historical-project", adapterId: "claude", sourceSessionId: "historical-session", originKey: "frozen-origin" }
export const limits = { unitBytes: 512, targetBytes: 4096, pendingBytes: 8192, metadataEntries: 1000, unitsPerTarget: 16, recordsPerTarget: 16 }
export const bytes = (value: string) => new TextEncoder().encode(value)
export const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
export const activated = "01-activated-with-raw-pending", sealed = "02-sealed-with-canonical-pending"
export const canonical = (id: string, ordinal: number) => bytes(`Frozen Canonical ${id}/${ordinal} 空格`)
export const raw = (id: string, ordinal: number) => bytes(`Frozen Raw ${id}/${ordinal}\u0000body`)
export const activationReceipt = '{"head":"historical-activated-head"}'
export const canonicalReceipt = (id: string, ordinal: number) => JSON.stringify({ capture: id, canonical: ordinal })
export const rawReceipt = (id: string, ordinal: number) => JSON.stringify({ capture: id, raw: ordinal })
const records = (id: string, rawCount: number): readonly CaptureRecordInput[] => [
  ...(["session", "thread", "event"] as const).map(kind => ({ kind, key: `${kind}-identity`, fingerprint: sha(bytes(`${id}/${kind}`)),
    projectionVersion: "historical-projection-v1", ...(kind === "event" ? { rawReference: { _tag: "object" as const, sourceObjectId: "raw-0", fragment: "event-fragment" } } : {}) })),
  ...Array.from({ length: rawCount }, (_, ordinal) => ({ kind: "raw" as const, key: `raw-${ordinal}`, fingerprint: sha(raw(id, ordinal)), projectionVersion: "historical-raw-v1" }))
]
export const prepare = (runtime: typeof Effect, journal: CaptureJournalV7, owner: CaptureOwner, id: string, checkpoint: string | null, rawCount: number) => runtime.gen(function*() {
  yield* journal.reserve(owner, { id, expectedCheckpoint: checkpoint, beginJson: JSON.stringify({ capture: id }), rawEnabled: true, trackRecords: true })
  for (const ordinal of [0, 1]) yield* journal.append(owner, id, { kind: "canonical", ordinal, bytes: canonical(id, ordinal) })
  for (let ordinal = 0; ordinal < rawCount; ordinal++) yield* journal.append(owner, id, { kind: "raw", ordinal, bytes: raw(id, ordinal) })
  for (const record of records(id, rawCount)) {
    yield* journal.record(owner, id, record)
    yield* journal.bindRecord(owner, id, record, { _tag: "Unit", ordinal: record.kind === "raw" ? Number(record.key.slice(4)) : record.kind === "event" ? 1 : 0 })
  }
  yield* journal.seal(owner, id, { canonicalUnits: 2, rawUnits: rawCount, nextCheckpoint: id === activated ? "cursor-1" : "cursor-2",
    manifestJson: JSON.stringify({ frozen: id }), records: { canonical: { session: 1, thread: 1, event: 1, usage: 0 }, raw: { records: rawCount, scopeComplete: true } } })
})
export const snapshot = (runtime: typeof Effect, journal: CaptureJournalV7) => runtime.gen(function*() {
  const owner = yield* journal.claim(scope), captures = []
  for (const id of [activated, sealed]) {
    const recordPages = []
    for (const kind of ["session", "thread", "event", "raw"] as const) recordPages.push(yield* journal.records(owner, id, { kind }))
    captures.push({ canonical: yield* journal.inspect(owner, id, { kind: "canonical" }), raw: yield* journal.inspect(owner, id, { kind: "raw" }), records: recordPages })
  }
  return { binding: journal.binding, scope: owner.scope, checkpoint: owner.checkpoint,
    sources: yield* journal.sources(scope.projectId, scope.adapterId, {}), coverage: yield* journal.coverage(owner),
    pending: yield* journal.pending(owner), unactivated: yield* journal.unactivated(owner), captures,
    canonicalPayloads: [yield* journal.read(owner, activated, "canonical", 0), yield* journal.read(owner, activated, "canonical", 1),
      yield* journal.read(owner, sealed, "canonical", 0), yield* journal.read(owner, sealed, "canonical", 1)],
    pendingRawPayload: yield* journal.read(owner, activated, "raw", 1) }
})

/** Real published 0.5.3 creates the format and obligations. This shared fixture
 * adds only the current installation registry around that historical database. */
export const createHistoricalCaptureMigrationState = async (paths: NodeClientPaths) => {
  const historical = await captureJournalV7(), old = historical.Effect
  const root = `${paths.collectorStateFile}.captures`, key = sha(Buffer.from(JSON.stringify([binding.instanceOrigin, binding.userId]))), path = join(root, `${key}.sqlite`)
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await atomicJSON(paths.collectorStateFile, emptyCollectorState(binding.installationId))
    await atomicJSON(`${paths.collectorStateFile}.capture-installation.json`, { protocol: "atape.capture-installation.v1", installationId: binding.installationId,
      phase: "ready", accounts: [{ key, phase: "ready" }] })
    await atomicJSON(join(root, `${key}.binding.json`), { protocol: "atape.capture-account.v1", ...binding, phase: "ready" })
    const runOld = <A, E>(mode: "create" | "open", work: (journal: CaptureJournalV7) => Effect.Effect<A, E>) =>
      old.runPromise(old.scoped(historical.openCaptureJournal({ path, mode, binding, limits }).pipe(old.flatMap(work))))
    await runOld("create", journal => old.gen(function*() {
      const owner = yield* journal.claim(scope)
      yield* prepare(old, journal, owner, activated, null, 2)
      for (const ordinal of [0, 1]) yield* journal.settle(owner, activated, { _tag: "CanonicalAcknowledged", ordinal, receiptJson: canonicalReceipt(activated, ordinal) })
      yield* journal.settle(owner, activated, { _tag: "Activated", receiptJson: activationReceipt })
      yield* journal.settle(owner, activated, { _tag: "RawAcknowledged", ordinal: 0, receiptJson: rawReceipt(activated, 0) })
      yield* prepare(old, journal, owner, sealed, "cursor-1", 1)
      yield* journal.settle(owner, sealed, { _tag: "CanonicalAcknowledged", ordinal: 0, receiptJson: canonicalReceipt(sealed, 0) })
    }))
    const before = await runOld("open", journal => snapshot(old, journal))
    return { path, binding, key, limits, before, proof: historical.proof, cleanup: historical.cleanup,
      snapshotCurrent: (runtime: RuntimeContext) => Effect.runPromise(Effect.scoped(openCaptureJournal({ path, mode: "open", binding, limits, runtime }).pipe(Effect.flatMap(journal => snapshot(Effect, journal))))) }
  } catch (cause) { await historical.cleanup(); throw cause }
}
