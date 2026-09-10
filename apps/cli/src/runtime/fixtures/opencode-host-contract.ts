// Real native source → Host → authenticated HTTP/PostgreSQL in separate processes.
// Credentials are supplied by the owning Go fixture over stdin only.
import assert from "node:assert/strict"
import { readFileSync, rmSync } from "node:fs"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Effect, Layer, Logger } from "effect"
import { CaptureJournal, CLICredentialStore, RawPublicationTransport, beginPublicationCapture, preparePublicationCanonical,
  deliverPublicationCapture, deliverPublicationRaw, beginRawObservation, prepareRawObservation, makeSecretRedactorLayer } from "@atape/application"
import type { CanonicalBatch, StoredCLICredential } from "@atape/domain"
import { openOpenCodeCapture } from "../../../../../adapters/opencode/src/capture.ts"
import { makeCaptureJournalLayer } from "../captureJournal.ts"
import { makeAuthenticatedHTTPClientLayer } from "../authenticatedHTTPClient.ts"
import { makeHTTPAuthenticationGatewayLayer } from "../authenticationLayers.ts"
import { makeRawPublicationTransportLayer } from "../rawPublicationTransport.ts"
import { makePublicationTransportLayer } from "../publicationTransport.ts"

const input = JSON.parse(readFileSync(0, "utf8")) as {
  phase: "prepare" | "canonical" | "lose-raw" | "recover-raw" | "prepare-observation" | "recover-observation"
  origin: string; credential: string; userId: string; journal: string; batch: CanonicalBatch
}
const native = JSON.parse(readFileSync(new URL("../../../../../adapters/opencode/src/fixtures/native-v1.json", import.meta.url), "utf8")) as {
  rootID: string; ddl: string[]; rows: Record<string, Record<string, SQLInputValue>[]>
}
const path = `${input.journal}.source.db`, adapterId = "opencode-host-contract", at = "2026-09-10T00:00:00.123456Z"
if (input.phase === "prepare" || input.phase === "prepare-observation") {
  const db = new DatabaseSync(path)
  db.exec("PRAGMA foreign_keys=OFF")
  for (const ddl of native.ddl) db.exec(ddl)
  for (const [table, rows] of Object.entries(native.rows)) for (const row of rows) {
    const keys = Object.keys(row)
    db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
  }
  db.prepare("UPDATE part SET data=json_set(data,'$.text',?) WHERE json_extract(data,'$.type')='text'").run("Host HTTP SENSITIVE_TEST_TOKEN native message")
  if (input.phase === "prepare-observation") db.prepare("UPDATE part SET data=json_set(data,'$.freshArchive',?) WHERE id=(SELECT id FROM part ORDER BY id LIMIT 1)").run("new raw observation")
  db.close()
}
if (input.phase === "lose-raw" || input.phase === "recover-observation") rmSync(path)
const source = (rawEnabled: boolean) => openOpenCodeCapture({ path, sessionId: native.rootID, rawEnabled,
  limits: { rowBytes: 65536, pageBytes: 262144, pageRows: 2, records: 1000, threads: 20, durationMs: 10000 },
  projection: { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 } })
const binding = { instanceOrigin: input.origin, userId: input.userId, installationId: input.batch.source.installationId }
const stored: StoredCLICredential = { version: 1, instanceOrigin: input.origin, apiOrigin: input.origin,
  credential: input.credential, credentialId: "integration-credential", capabilityVersion: "atape-cli.v1",
  createdAt: at, user: { id: input.userId, displayName: "Fixture" } }
let lost = false, uploads = 0
const faultFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, init)
  if (String(url).endsWith("/ingestion/raw/chunks")) {
    uploads++
    if (!lost && input.phase === "lose-raw" && response.status === 201) {
      lost = true; await response.arrayBuffer(); throw new TypeError("Simulated response loss")
    }
  }
  return response
}
const auth = makeAuthenticatedHTTPClientLayer(faultFetch, true).pipe(Layer.provide(Layer.merge(
  makeHTTPAuthenticationGatewayLayer(fetch), Layer.succeed(CLICredentialStore, CLICredentialStore.of({
    read: () => Effect.succeed(stored), replace: () => Effect.void, remove: () => Effect.succeed(true)
  })))))
const dependencies = Layer.mergeAll(makePublicationTransportLayer().pipe(Layer.provide(auth)), makeRawPublicationTransportLayer().pipe(Layer.provide(auth)),
  makeSecretRedactorLayer(["SENSITIVE_TEST_TOKEN"]), makeCaptureJournalLayer({ path: input.journal, mode: input.phase === "prepare" ? "create" : "open", binding,
    limits: { unitBytes: 4 * 1024 * 1024, targetBytes: 32 * 1024 * 1024, pendingBytes: 64 * 1024 * 1024, unitsPerTarget: 100, recordsPerTarget: 1000 } }))
const rawLimits = { objectBytes: 4000, wireBytes: 8192, targetBytes: 100_000, units: 100 }
const result = await Effect.runPromise(Effect.gen(function*() {
  const j = yield* CaptureJournal
  if (input.phase === "prepare") {
    const remote = yield* RawPublicationTransport, policy = yield* remote.policy(binding, input.batch.projectId)
    assert.equal(policy.enabled, true)
    const view = yield* Effect.scoped(source(false))
    const owner = yield* j.claim({ projectId: input.batch.projectId, adapterId, sourceSessionId: view.origin.sourceId, originKey: view.origin.originKey })
    const started = yield* beginPublicationCapture(owner, { captureId: "native-host", baseHead: "", transformVersion: "host-v1", rawEnabled: true,
      rawAuthority: policy.authority, trackRecords: true })
    const prepared = yield* preparePublicationCanonical(owner, "native-host", { adapterVersion: "0.0.0", observedAt: at, nextCheckpoint: "native-covered",
      source: source(true), rawLimits })
    assert.ok(prepared.raw!.units > 1); assert.equal(prepared.raw!.gaps, 0)
    assert.equal(uploads, 0); assert.equal(owner.checkpoint, null)
    return { ...started, prepared }
  }
  const scopes = yield* j.sources(input.batch.projectId, adapterId, { limit: 100 })
  assert.equal(scopes.length, 1)
  const owner = yield* j.claim(scopes[0]!)
  if (input.phase === "canonical") {
    const delivered = yield* deliverPublicationCapture(owner, "native-host", 64)
    assert.equal(delivered.state, "activated")
    assert.equal(uploads, 0)
    return delivered
  }
  assert.equal(owner.checkpoint, "native-covered")
  if (input.phase === "prepare-observation") {
    yield* beginRawObservation(owner, { observationId: "native-fresh", canonicalCaptureId: "native-host" })
    const observed = yield* prepareRawObservation(owner, "native-fresh", { adapterVersion: "0.0.0", observedAt: at, limits: rawLimits, source: source(true) })
    assert.equal(observed.units, 1); assert.equal(observed.reused, observed.records - 1)
    assert.equal((yield* j.records(owner, "native-fresh", { kind: "event" })).length, 0)
    return observed
  }
  const id = input.phase === "recover-observation" ? "native-fresh" : "native-host"
  if (input.phase === "lose-raw") {
    const failure = yield* deliverPublicationRaw(owner, id, 64).pipe(Effect.flip)
    assert.equal(failure.reason, "network"); assert.equal(lost, true); assert.equal(uploads, 1)
    return { state: "network" }
  }
  const pending = (yield* j.inspect(owner, id, { kind: "raw", pendingOnly: true, limit: 100 })).units.length
  if (input.phase === "recover-raw") for (const unit of (yield* j.inspect(owner, id, { kind: "raw", limit: 100 })).units) {
    const wire = JSON.parse(new TextDecoder().decode(yield* j.read(owner, id, "raw", unit.ordinal)))
    const content = Buffer.from(wire.contentBase64, "base64").toString()
    assert.ok(!content.includes("SENSITIVE_TEST_TOKEN"))
  }
  const delivered = yield* deliverPublicationRaw(owner, id, 64)
  assert.equal(delivered.state, "completed")
  assert.equal(uploads, input.phase === "recover-raw" ? pending - 1 : pending)
  const rows = yield* j.records(owner, id, { kind: "raw", limit: 100 })
  assert.ok(rows.every(row => row.disposition === "acknowledged"))
  while ((yield* j.reclaim(owner, id)) > 0) { /* bounded reclamation */ }
  assert.equal((yield* j.claim(scopes[0]!)).checkpoint, "native-covered")
  return delivered
}).pipe(Effect.provide(dependencies), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
