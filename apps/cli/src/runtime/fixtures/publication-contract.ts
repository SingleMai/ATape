// Executed in separate Node processes by the authenticated PostgreSQL/HTTP
// contract. The fixture credential travels over stdin, never argv or logs.
import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { CaptureJournal, CLICredentialStore, PublicationTransport,
  beginPublicationCapture, sealPublicationCapture, deliverPublicationCapture, deliverPublicationRaw, RawPublicationTransport, beginRawObservation, sealRawObservation } from "@atape/application"
import { PublicationTargetProfile, type CanonicalBatch, type StoredCLICredential } from "@atape/domain"
import { Effect, Layer, Logger } from "effect"
import { makeCaptureJournalLayer } from "../captureJournal.ts"
import { makeAuthenticatedHTTPClientLayer } from "../authenticatedHTTPClient.ts"
import { makeHTTPAuthenticationGatewayLayer } from "../authenticationLayers.ts"
import { makeRawPublicationTransportLayer } from "../rawPublicationTransport.ts"
import { makePublicationTransportLayer } from "../publicationTransport.ts"

const input = JSON.parse(readFileSync(0, "utf8")) as {
  phase: "prepare" | "lose-put" | "lose-activation" | "recover" | "lose-raw" | "cancel-raw" | "finish-raw" | "revoked-raw" | "prepare-observation" | "lose-observation" | "recover-observation"
  origin: string; credential: string; userId: string; journal: string; baseHead: string; batch: CanonicalBatch
}
const binding = { instanceOrigin: input.origin, userId: input.userId, installationId: input.batch.source.installationId }
const scope = { projectId: input.batch.projectId, adapterId: input.batch.source.adapterId,
  sourceSessionId: input.batch.session.sourceSessionId, originKey: "http-origin" }
const stored: StoredCLICredential = { version: 1, instanceOrigin: input.origin, apiOrigin: input.origin,
  credential: input.credential, credentialId: "integration-credential", capabilityVersion: "atape-cli.v1",
  createdAt: "2026-09-10T00:00:00Z", user: { id: input.userId, displayName: "Fixture" } }
let discarded = false, rawUploads = 0
const faultFetch: typeof fetch = async (url, init) => {
  if (String(url).endsWith("/ingestion/raw/chunks")) rawUploads++
  const response = await fetch(url, init)
  if (!discarded && (response.status === 200 || response.status === 201) && ((input.phase === "lose-put" && init?.method === "PUT") ||
    (input.phase === "lose-activation" && String(url).endsWith("/activate")) ||
    ((input.phase === "lose-raw" || input.phase === "lose-observation") && String(url).endsWith("/ingestion/raw/chunks")))) {
    discarded = true
    await response.arrayBuffer() // Server has completed the actual request.
    throw new TypeError("Simulated response loss")
  }
  return response
}
const auth = makeAuthenticatedHTTPClientLayer(faultFetch, true).pipe(Layer.provide(Layer.merge(
  makeHTTPAuthenticationGatewayLayer(fetch), Layer.succeed(CLICredentialStore, CLICredentialStore.of({
    read: () => Effect.succeed(stored), replace: () => Effect.void, remove: () => Effect.succeed(true)
  })))))
const dependencies = Layer.mergeAll(makePublicationTransportLayer().pipe(Layer.provide(auth)), makeRawPublicationTransportLayer().pipe(Layer.provide(auth)), makeCaptureJournalLayer({
  path: input.journal, mode: input.phase === "prepare" ? "create" : "open", binding,
  limits: { unitBytes: 4 * 1024 * 1024, targetBytes: 32 * 1024 * 1024, pendingBytes: 64 * 1024 * 1024, metadataEntries: 100_000, unitsPerTarget: 32 }
}))
const result = await Effect.runPromise(Effect.gen(function*() {
  const j = yield* CaptureJournal, owner = yield* j.claim(scope)
  if (input.phase === "prepare") {
    const remoteRaw = yield* RawPublicationTransport
    const policy = yield* remoteRaw.policy(binding, scope.projectId)
    assert.equal(policy.enabled, true)
    const started = yield* beginPublicationCapture(owner, { captureId: "node-process-capture", baseHead: input.baseHead,
      transformVersion: "http-node-v1", rawEnabled: true, rawAuthority: policy.authority })
    for (let ordinal = 0; ordinal < input.batch.events.length; ordinal++) {
      const value = { target: { profile: PublicationTargetProfile, events: input.batch.events.length, threads: input.batch.threads.length, usage: 0 },
        batch: { ...input.batch, batchId: `node-part-${ordinal}`, events: [input.batch.events[ordinal]] } }
      yield* j.append(owner, "node-process-capture", { kind: "canonical", ordinal,
        bytes: new TextEncoder().encode(` \n${JSON.stringify(value)}\n`) })
    }
    for (let ordinal = 0; ordinal < 5; ordinal++) {
      const content = `{"observation":${ordinal}}\n`
      const chunk = { protocolVersion: "atape.raw.v1", sessionId: started.sessionId, installationId: binding.installationId,
        adapterId: scope.adapterId, sourceObjectId: `node-observation-${ordinal}`, sourceChunkId: `node-chunk-${ordinal}`,
        sourceName: "observation.jsonl", mediaType: "application/x-ndjson", adapterVersion: "node-fixture-v1",
        capturedAt: "2026-09-10T00:00:00.123456Z", clientRedacted: true, generation: 1, offset: 0, final: true,
        contentBase64: Buffer.from(content).toString("base64"), sha256: createHash("sha256").update(content).digest("hex"),
        publication: { head: started.attemptId, authority: policy.authority } }
      yield* j.append(owner, "node-process-capture", { kind: "raw", ordinal, bytes: new TextEncoder().encode(` \n${JSON.stringify(chunk)}\n`) })
    }
    yield* sealPublicationCapture(owner, "node-process-capture", { nextCheckpoint: "node-capture-covered", rawUnits: 5 })
    return { state: "sealed", ...started }
  }
  if (input.phase === "prepare-observation") {
    const started = yield* beginRawObservation(owner, { observationId: "fresh-raw", canonicalCaptureId: "node-process-capture" })
    const content = '{"observation":"fresh after re-enable"}\n'
    const chunk = { protocolVersion: "atape.raw.v1", sessionId: started.sessionId, installationId: binding.installationId,
      adapterId: scope.adapterId, sourceObjectId: "fresh-raw-object", sourceChunkId: "fresh-raw-chunk",
      sourceName: "observation.jsonl", mediaType: "application/x-ndjson", adapterVersion: "node-fixture-v1",
      capturedAt: "2026-09-10T00:01:00.123456Z", clientRedacted: true, generation: 1, offset: 0, final: true,
      contentBase64: Buffer.from(content).toString("base64"), sha256: createHash("sha256").update(content).digest("hex"),
      publication: { head: started.head, authority: started.rawAuthority } }
    yield* j.append(owner, "fresh-raw", { kind: "raw", ordinal: 0, bytes: new TextEncoder().encode(` \n${JSON.stringify(chunk)}\n`) })
    yield* sealRawObservation(owner, "fresh-raw", 1)
    assert.equal(owner.checkpoint, "node-capture-covered")
    assert.equal((yield* j.inspect(owner, "fresh-raw", { kind: "canonical" })).units.length, 0)
    return { state: "sealed", ...started }
  }
  if (input.phase === "lose-observation" || input.phase === "recover-observation") {
    const outcome = yield* deliverPublicationRaw(owner, "fresh-raw", 3).pipe(
      Effect.match({ onFailure: error => ({ state: error.reason }), onSuccess: result => result }))
    assert.equal(owner.checkpoint, "node-capture-covered")
    if (input.phase === "lose-observation") {
      assert.equal(outcome.state, "network"); assert.equal(discarded, true); assert.equal(rawUploads, 1)
      assert.equal(yield* j.reclaim(owner, "fresh-raw"), 0)
    } else {
      assert.equal(outcome.state, "completed"); assert.equal(rawUploads, 0)
      const fresh = yield* j.inspect(owner, "fresh-raw", { kind: "raw" })
      assert.equal(fresh.capture.purpose, "raw-observation")
      assert.equal(fresh.capture.seal!.nextCheckpoint, "node-capture-covered")
      assert.equal(fresh.units[0]!.disposition, "acknowledged")
      assert.equal(yield* j.reclaim(owner, "fresh-raw"), 1)
      assert.equal((yield* j.pending(owner)).length, 0)
    }
    return outcome
  }
  if (input.phase === "lose-put" || input.phase === "lose-activation") {
    const outcome = yield* deliverPublicationCapture(owner, "node-process-capture", 64).pipe(
      Effect.match({ onFailure: error => ({ state: error.reason }), onSuccess: result => result }))
    assert.equal(discarded, true); assert.equal(outcome.state, "network")
    assert.equal(owner.checkpoint, null)
    assert.equal(yield* j.reclaim(owner, "node-process-capture"), 0)
    return outcome
  }
  if (input.phase === "lose-raw") {
    const outcome = yield* deliverPublicationRaw(owner, "node-process-capture", 3).pipe(
      Effect.match({ onFailure: error => ({ state: error.reason }), onSuccess: result => result }))
    assert.equal(discarded, true); assert.equal(outcome.state, "network"); assert.equal(rawUploads, 1)
    assert.equal((yield* j.inspect(owner, "node-process-capture", { kind: "raw", pendingOnly: true })).units.length, 5)
    return outcome
  }
  if (input.phase === "revoked-raw") {
    const outcome = yield* deliverPublicationRaw(owner, "node-process-capture", 3).pipe(
      Effect.match({ onFailure: error => ({ state: error.reason }), onSuccess: result => result }))
    assert.equal(outcome.state, "unauthenticated"); assert.equal(rawUploads, 0)
    const pending = yield* j.inspect(owner, "node-process-capture", { kind: "raw", pendingOnly: true })
    assert.equal(pending.units.length, 3); assert.equal(pending.capture.rawCancelReason, "Raw capture disabled")
    assert.equal(yield* j.reclaim(owner, "node-process-capture"), 0)
    return outcome
  }
  if (input.phase === "cancel-raw" || input.phase === "finish-raw") {
    const result = yield* deliverPublicationRaw(owner, "node-process-capture", 3)
    assert.equal(result.operations, 3); assert.equal(rawUploads, 0)
    const page = yield* j.inspect(owner, "node-process-capture", { kind: "raw" })
    assert.equal(page.capture.rawCancelReason, "Raw capture disabled")
    assert.equal(owner.checkpoint, "node-capture-covered")
    assert.equal(page.units[0]!.disposition, "acknowledged")
    assert.equal(JSON.parse(page.units[0]!.receiptJson!).capturedAt, "2026-09-10T00:00:00.123456Z")
    if (input.phase === "cancel-raw") {
      assert.equal(result.state, "pending")
      assert.deepEqual(page.units.map(unit => unit.disposition), ["acknowledged", "canceled", "pending", "pending", "pending"])
      assert.equal(yield* j.reclaim(owner, "node-process-capture"), 2)
    } else {
      assert.equal(result.state, "completed")
      assert.deepEqual(page.units.slice(1).map(unit => [unit.disposition, unit.receiptJson]), Array.from({ length: 4 }, () => ["canceled", null]))
      assert.equal(yield* j.reclaim(owner, "node-process-capture"), 3)
      assert.equal((yield* j.pending(owner)).length, 0)
    }
    return result
  }
  const result = yield* deliverPublicationCapture(owner, "node-process-capture", 3)
  assert.equal(result.state, "activated"); assert.equal(result.operations, 1)
  const current = yield* j.claim(scope)
  assert.equal(current.checkpoint, "node-capture-covered")
  assert.equal(yield* j.reclaim(current, "node-process-capture"), input.batch.events.length)
  assert.equal((yield* j.pending(current)).length, 1)
  // Unknown remains a typed, unresolved outcome at the actual HTTP boundary.
  const remote = yield* PublicationTransport
  const unknown = yield* remote.status(binding, "00000000-0000-4000-8000-000000000000").pipe(
    Effect.match({ onFailure: error => error.reason, onSuccess: () => "unexpected" }))
  assert.equal(unknown, "unknown")
  return result
}).pipe(Effect.provide(dependencies), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
