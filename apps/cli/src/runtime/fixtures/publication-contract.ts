// Executed in separate Node processes by the authenticated PostgreSQL/HTTP
// contract. The fixture credential travels over stdin, never argv or logs.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { CaptureJournal, CLICredentialStore, PublicationTransport,
  beginPublicationCapture, sealPublicationCapture, deliverPublicationCapture } from "@atape/application"
import { PublicationTargetProfile, type CanonicalBatch, type StoredCLICredential } from "@atape/domain"
import { Effect, Layer, Logger } from "effect"
import { makeCaptureJournalLayer } from "../captureJournal.ts"
import { makeAuthenticatedHTTPClientLayer } from "../authenticatedHTTPClient.ts"
import { makeHTTPAuthenticationGatewayLayer } from "../authenticationLayers.ts"
import { makePublicationTransportLayer } from "../publicationTransport.ts"

const input = JSON.parse(readFileSync(0, "utf8")) as {
  phase: "prepare" | "lose-put" | "lose-activation" | "recover"
  origin: string; credential: string; userId: string; journal: string; baseHead: string; batch: CanonicalBatch
}
const binding = { instanceOrigin: input.origin, userId: input.userId, installationId: input.batch.source.installationId }
const scope = { projectId: input.batch.projectId, adapterId: input.batch.source.adapterId,
  sourceSessionId: input.batch.session.sourceSessionId, originKey: "http-origin" }
const stored: StoredCLICredential = { version: 1, instanceOrigin: input.origin, apiOrigin: input.origin,
  credential: input.credential, credentialId: "integration-credential", capabilityVersion: "atape-cli.v1",
  createdAt: "2026-09-10T00:00:00Z", user: { id: input.userId, displayName: "Fixture" } }
let discarded = false
const faultFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, init)
  if (!discarded && response.status === 200 && ((input.phase === "lose-put" && init?.method === "PUT") ||
    (input.phase === "lose-activation" && String(url).endsWith("/activate")))) {
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
const dependencies = Layer.merge(makePublicationTransportLayer().pipe(Layer.provide(auth)), makeCaptureJournalLayer({
  path: input.journal, mode: input.phase === "prepare" ? "create" : "open", binding,
  limits: { unitBytes: 4 * 1024 * 1024, targetBytes: 32 * 1024 * 1024, pendingBytes: 64 * 1024 * 1024, unitsPerTarget: 32 }
}))
const result = await Effect.runPromise(Effect.gen(function*() {
  const j = yield* CaptureJournal, owner = yield* j.claim(scope)
  if (input.phase === "prepare") {
    const started = yield* beginPublicationCapture(owner, { captureId: "node-process-capture", baseHead: input.baseHead,
      transformVersion: "http-node-v1", rawEnabled: false })
    for (let ordinal = 0; ordinal < input.batch.events.length; ordinal++) {
      const value = { target: { profile: PublicationTargetProfile, events: input.batch.events.length, threads: input.batch.threads.length, usage: 0 },
        batch: { ...input.batch, batchId: `node-part-${ordinal}`, events: [input.batch.events[ordinal]] } }
      yield* j.append(owner, "node-process-capture", { kind: "canonical", ordinal,
        bytes: new TextEncoder().encode(` \n${JSON.stringify(value)}\n`) })
    }
    yield* sealPublicationCapture(owner, "node-process-capture", { nextCheckpoint: "node-capture-covered", rawUnits: 0 })
    return { state: "sealed", ...started }
  }
  if (input.phase === "lose-put" || input.phase === "lose-activation") {
    const outcome = yield* deliverPublicationCapture(owner, "node-process-capture", 64).pipe(
      Effect.match({ onFailure: error => ({ state: error.reason }), onSuccess: result => result }))
    assert.equal(discarded, true); assert.equal(outcome.state, "network")
    assert.equal(owner.checkpoint, null)
    assert.equal(yield* j.reclaim(owner, "node-process-capture"), 0)
    return outcome
  }
  const result = yield* deliverPublicationCapture(owner, "node-process-capture", 3)
  assert.equal(result.state, "activated"); assert.equal(result.operations, 1)
  const current = yield* j.claim(scope)
  assert.equal(current.checkpoint, "node-capture-covered")
  assert.equal(yield* j.reclaim(current, "node-process-capture"), input.batch.events.length)
  assert.equal((yield* j.pending(current)).length, 0)
  // Unknown remains a typed, unresolved outcome at the actual HTTP boundary.
  const remote = yield* PublicationTransport
  const unknown = yield* remote.status(binding, "00000000-0000-4000-8000-000000000000").pipe(
    Effect.match({ onFailure: error => error.reason, onSuccess: () => "unexpected" }))
  assert.equal(unknown, "unknown")
  return result
}).pipe(Effect.provide(dependencies), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
