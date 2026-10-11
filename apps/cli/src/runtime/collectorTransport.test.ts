import { CollectorTransport, projectCanonicalSubmission, type CanonicalSubmission } from "@atape/application"
import { CanonicalBatch, CanonicalCapabilitiesProtocol, CanonicalProfileVersion, CanonicalProfileVersion3, CanonicalProfileVersion4, PublicationTargetProfile3 } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { AuthenticatedHTTPClient, type AuthenticatedHTTPRequest } from "./authenticatedHTTPClient.ts"
import { makeCollectorTransportLayer } from "./collectorTransport.ts"

const project = { instanceOrigin: "https://atape.net", userId: "user-1", id: "project-1" }
const capabilities = {
  protocol: "atape.publication.v1", targetProfile: "atape.publication-target.v1",
  targetProfiles: ["atape.publication-target.v1", "atape.publication-target.v2"],
  limits: { partBytes: 4096, targetBytes: 1_000_000, userPendingBytes: 2_000_000, parts: 100,
    reservations: 16, reservationLifetimeMs: 60_000, leaseLifetimeMs: 30_000 }, statusPageSize: 100, reclaimPageSize: 32
}
const { targetProfiles: _legacyProfiles, ...capabilitiesWithoutProfiles } = capabilities
const canonicalCapabilities = { protocol: CanonicalCapabilitiesProtocol,
  canonicalProfiles: [CanonicalProfileVersion, CanonicalProfileVersion3, CanonicalProfileVersion4] }
const receipt = { sessionId: "session-1", sessionCreated: false, insertedEvents: 2,
  updatedEvents: 0, unchangedEvents: 0, staleEvents: 0, replayed: false }
const fixture = (body: unknown = canonicalCapabilities, status = 200, fallback?: { readonly body: unknown; readonly status: number }) => {
  const requests: AuthenticatedHTTPRequest[] = []
  const layer = makeCollectorTransportLayer().pipe(Layer.provide(Layer.succeed(AuthenticatedHTTPClient, {
    request: input => Effect.sync(() => { requests.push(input);
      return input.path === "/api/v1/publications/capabilities" && fallback !== undefined ? fallback : { status, body } })
  })))
  const run = <A, E>(effect: Effect.Effect<A, E, CollectorTransport>) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { requests, run }
}
const submission = (): CanonicalSubmission => ({
  instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id,
  installationId: "installation-1", adapterId: "codex", adapterVersion: "1.0.0",
  canonicalProfileVersion: CanonicalProfileVersion3,
  observation: { observedAt: "2026-10-11T00:00:00Z",
    session: { sourceSessionId: "source-1", revision: 1, title: "[REDACTED]", summary: "", insight: "", branch: "main",
      actor: { name: "User", harness: "Codex" }, status: "ended", captureStatus: "healthy", updatedAt: null, reportedEventCount: 2 },
    threads: [{ sourceThreadId: "root", revision: 1, label: "", summary: "", captureStatus: "healthy" }],
    events: [null, "2026-10-11T00:01:00Z"].map((occurredAt, index) => ({ sourceEventId: `event-${index}`,
      sourceThreadId: "root", revision: 1, projectionRevision: 1, sourceOrder: index, eventIndex: index,
      orderFidelity: "native", fidelity: "native", rawRef: { _tag: "unavailable", reason: "Raw disabled" }, occurredAt,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[REDACTED]" } } })) }
})

describe("legacy Canonical transport profile admission", () => {
  it("requests explicit v3 support with the selected authenticated account", async () => {
    const f = fixture()
    await f.run(CollectorTransport.use(transport => transport.ensureCanonicalProfile(project, CanonicalProfileVersion3)))
    expect(f.requests).toEqual([{ instanceOrigin: project.instanceOrigin, expectedUserId: project.userId,
      path: "/api/v1/ingestion/canonical/capabilities", method: "GET" }])
  })
  it.each([
    { status: 200, body: { ...canonicalCapabilities, canonicalProfiles: [CanonicalProfileVersion] }, reason: "rejected", retryable: false },
    { status: 200, body: { ...canonicalCapabilities, canonicalProfiles: [CanonicalProfileVersion4] }, reason: "rejected", retryable: false },
    { status: 200, body: {}, reason: "invalid_response", retryable: false },
    { status: 200, body: { ...canonicalCapabilities, canonicalProfiles: [CanonicalProfileVersion3, CanonicalProfileVersion3] }, reason: "invalid_response", retryable: false },
    { status: 401, body: {}, reason: "unauthenticated", retryable: false },
    { status: 403, body: {}, reason: "unauthenticated", retryable: false },
    { status: 429, body: {}, reason: "rejected", retryable: true },
    { status: 500, body: {}, reason: "rejected", retryable: true },
    { status: 503, body: {}, reason: "rejected", retryable: true }
  ])("rejects missing or invalid direct v3 affirmation without fallback ($status/$reason)", async ({ status, body, reason, retryable }) => {
    const f = fixture(body, status, { status: 200, body: { ...capabilities, targetProfiles: [PublicationTargetProfile3] } })
    await expect(f.run(CollectorTransport.use(transport => transport.ensureCanonicalProfile(project, CanonicalProfileVersion3))))
      .rejects.toMatchObject({ _tag: "CollectionTransportError", reason, operation: "canonical", retryable })
    expect(f.requests.map(request => request.path)).toEqual(["/api/v1/ingestion/canonical/capabilities"])
  })
  it.each([404, 405, 501])("uses genuine target-v3 support only when the direct route is absent or unimplemented (%s)", async status => {
    const f = fixture({}, status, { status: 200, body: { ...capabilities, targetProfiles: [...capabilities.targetProfiles, PublicationTargetProfile3] } })
    await f.run(CollectorTransport.use(transport => transport.ensureCanonicalProfile(project, CanonicalProfileVersion3)))
    expect(f.requests).toEqual([{ instanceOrigin: project.instanceOrigin, expectedUserId: project.userId,
      path: "/api/v1/ingestion/canonical/capabilities", method: "GET" },
    { instanceOrigin: project.instanceOrigin, expectedUserId: project.userId,
      path: "/api/v1/publications/capabilities", method: "GET", acceptPublicationTarget: PublicationTargetProfile3 }])
  })
  it.each([
    [200, capabilities, "rejected"], [200, capabilitiesWithoutProfiles, "rejected"], [200, {}, "invalid_response"],
    [404, {}, "rejected"], [401, {}, "unauthenticated"]
  ])("rejects absent or invalid older-Server fallback affirmation (%s/%j)", async (status, body, reason) => {
    const f = fixture({}, 404, { status: Number(status), body })
    await expect(f.run(CollectorTransport.use(transport => transport.ensureCanonicalProfile(project, CanonicalProfileVersion3))))
      .rejects.toMatchObject({ _tag: "CollectionTransportError", reason, operation: "canonical", retryable: false })
    expect(f.requests).toHaveLength(2)
  })
  it("binds mixed-clock nullable v3 payloads to their stable batch hash", async () => {
    const f = fixture(receipt, 201), selected = submission()
    await f.run(CollectorTransport.use(transport => transport.submitCanonical(selected)))
    await f.run(CollectorTransport.use(transport => transport.submitCanonical(selected)))
    const batch = Schema.decodeUnknownSync(CanonicalBatch)(f.requests[0]?.body)
    const expected = projectCanonicalSubmission(selected)
    expect(batch).toEqual({ ...expected, batchId: `b_${createHash("sha256").update(JSON.stringify(expected)).digest("hex")}` })
    expect(batch.canonicalProfileVersion).toBe(CanonicalProfileVersion3)
    expect(batch.session.updatedAt).toBeNull()
    expect(batch.events.map(event => event.occurredAt)).toEqual([null, "2026-10-11T00:01:00Z"])
    expect(f.requests[1]?.body).toEqual(batch)
    expect(f.requests.every(request => request.acceptPublicationTarget === undefined)).toBe(true)
  })
  it("preserves the default v2 payload and hashing for undeclared legacy runtimes", async () => {
    const f = fixture(receipt, 201), { canonicalProfileVersion: _selected, ...legacy } = submission()
    const known: CanonicalSubmission = { ...legacy, observation: { ...legacy.observation,
      session: { ...legacy.observation.session, updatedAt: legacy.observation.observedAt },
      events: legacy.observation.events.map(event => ({ ...event, occurredAt: legacy.observation.observedAt })) } }
    await f.run(CollectorTransport.use(transport => transport.submitCanonical(known)))
    const batch = Schema.decodeUnknownSync(CanonicalBatch)(f.requests[0]?.body)
    const expected = projectCanonicalSubmission(known, CanonicalProfileVersion)
    expect(batch).toEqual({ ...expected, batchId: `b_${createHash("sha256").update(JSON.stringify(expected)).digest("hex")}` })
    expect(f.requests).toHaveLength(1)
  })
})
