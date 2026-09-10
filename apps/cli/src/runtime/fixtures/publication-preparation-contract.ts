// Cross-language contract: no external HTTP or user source; only the committed
// controlled native fixture and a temporary real capture journal.
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Effect, Layer } from "effect"
import { CaptureJournal, PublicationTransport, PublicationError, beginPublicationCapture, preparePublicationCanonical,
  canonicalMaterializationBound, makeSecretRedactorLayer } from "@atape/application"
import { PublicationProtocol, PublicationTargetProfile, type CanonicalBatch, type PublicationAttempt, type PublicationCapabilities } from "@atape/domain"
import { openOpenCodeCapture } from "../../../../../adapters/opencode/src/capture.ts"
import { makeCaptureJournalLayer } from "../captureJournal.ts"

const input = JSON.parse(readFileSync(0, "utf8")) as { mode: "bound"; batch: CanonicalBatch; userId: string } | { mode: "prepare"; text: string; partBytes: number }
if (input.mode === "bound") {
  process.stdout.write(JSON.stringify({ bound: canonicalMaterializationBound(input.batch, input.userId) }))
} else {
  const directory = await mkdtemp(join(tmpdir(), "atape-host-wire-contract-"))
  try {
    const path = join(directory, "source.db"), db = new DatabaseSync(path)
    const native = JSON.parse(readFileSync(new URL("../../../../../adapters/opencode/src/fixtures/native-v1.json", import.meta.url), "utf8")) as {
      rootID: string; ddl: string[]; rows: Record<string, Record<string, SQLInputValue>[]>
    }
    db.exec("PRAGMA foreign_keys=OFF")
    for (const ddl of native.ddl) db.exec(ddl)
    for (const [table, rows] of Object.entries(native.rows)) for (const row of rows) {
      const keys = Object.keys(row)
      db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
    }
    db.prepare("UPDATE part SET data=json_set(data,'$.text',?) WHERE json_extract(data,'$.type')='text'").run(input.text)
    db.close()
    const source = () => openOpenCodeCapture({ path, sessionId: native.rootID, rawEnabled: false,
      limits: { rowBytes: 65536, pageBytes: 262144, pageRows: 2, records: 1000, threads: 20, durationMs: 10000 },
      projection: { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 } })
    const binding = { instanceOrigin: "https://atape.test", userId: "user", installationId: "installation" }, at = "2026-09-10T00:00:00Z"
    const caps: PublicationCapabilities = { protocol: PublicationProtocol, targetProfile: PublicationTargetProfile,
      limits: { partBytes: input.partBytes, targetBytes: 1048576, userPendingBytes: 2097152, parts: 100, reservations: 10,
        reservationLifetimeMs: 60000, leaseLifetimeMs: 60000 }, statusPageSize: 100, reclaimPageSize: 32 }
    let attempt!: PublicationAttempt
    const unavailable = () => Effect.fail(new PublicationError({ reason: "unavailable", message: "Content HTTP is forbidden during preparation." }))
    const remote = Layer.succeed(PublicationTransport, PublicationTransport.of({
      capabilities: () => Effect.succeed(caps), reserve: () => Effect.succeed({ id: "attempt", sessionId: "session", expiresAt: at }),
      begin: (_, begin) => Effect.sync(() => { attempt = { ...begin, id: "attempt", sessionId: "session", fence: 1, leaseUntil: at, expiresAt: at,
        state: "open", parts: 0, retainedBytes: 0, seal: null, validatedParts: 0, candidateEvents: 0, candidateUsage: 0, activation: null }; return attempt }),
      status: () => Effect.succeed(attempt), put: unavailable, seal: unavailable, validate: unavailable, renew: unavailable, reject: unavailable, activate: unavailable
    }))
    const metadata = await Effect.runPromise(Effect.scoped(source()))
    const result = await Effect.runPromise(Effect.gen(function*() {
      const journal = yield* CaptureJournal
      const owner = yield* journal.claim({ projectId: "project", adapterId: "opencode", sourceSessionId: metadata.origin.sourceId, originKey: metadata.origin.originKey })
      yield* beginPublicationCapture(owner, { captureId: "host-contract", baseHead: "", transformVersion: "host-v1", rawEnabled: false, trackRecords: true })
      const prepared = yield* preparePublicationCanonical(owner, "host-contract", { adapterVersion: "0.0.0", observedAt: at, nextCheckpoint: "covered", source: source() })
      const parts = []
      for (let ordinal = 0; ordinal < prepared.units; ordinal++) {
        const body = JSON.parse(new TextDecoder().decode(yield* journal.read(owner, "host-contract", "canonical", ordinal))) as { batch: CanonicalBatch }
        parts.push({ body, bound: canonicalMaterializationBound(body.batch, binding.userId) })
      }
      return { parts, prepared, userId: binding.userId }
    }).pipe(Effect.provide(Layer.mergeAll(remote, makeSecretRedactorLayer(), makeCaptureJournalLayer({ path: join(directory, "journal.db"), mode: "create", binding,
      limits: { unitBytes: input.partBytes, targetBytes: 1048576, pendingBytes: 2097152, unitsPerTarget: 100, recordsPerTarget: 1000 } })))))
    process.stdout.write(JSON.stringify(result))
  } finally { await rm(directory, { recursive: true, force: true }) }
}
