import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AdapterCollectionPage, AdapterProtocolVersion, CanonicalBatch, CanonicalProfileVersion, CanonicalProfileVersion3 } from "./index.ts"

const page = {
  protocolVersion: AdapterProtocolVersion,
  nextCursor: "cursor-1",
  hasMore: false,
  observations: [{
    observationId: "observation-1",
    observedAt: "2026-09-05T00:30:00+08:00",
    session: {
      sourceSessionId: "session-1",
      revision: 1,
      title: "Session",
      summary: "",
      insight: "",
      actor: { name: "Liying", harness: "Codex" },
      branch: "main",
      status: "active",
      captureStatus: "healthy",
      updatedAt: "2026-09-05T00:30:00+08:00",
      reportedEventCount: 1
    },
    threads: [{
      sourceThreadId: "root",
      revision: 1,
      label: "Root",
      summary: "",
      captureStatus: "healthy"
    }],
    events: [{
      sourceEventId: "event-1",
      sourceThreadId: "root",
      revision: 1,
      projectionRevision: 1,
      sourceOrder: 1,
      eventIndex: 0,
      orderFidelity: "native",
      fidelity: "native",
      rawRef: { _tag: "unavailable", reason: "Harness did not retain Raw" },
      occurredAt: "2026-09-05T00:30:00+08:00",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "Hello" }
      }
    }],
    rawSegments: []
  }]
}

describe("Adapter collection protocol", () => {
  it("requires explicit nullable source times only in Canonical v3", async () => {
    const observation = page.observations[0]!
    const batch = { protocolVersion: "atape.canonical.v1", canonicalProfileVersion: CanonicalProfileVersion3,
      batchId: "unknown-time", observedAt: observation.observedAt,
      source: { adapterId: "fixture", adapterVersion: "0.0.0", installationId: "installation" }, projectId: "project",
      session: { ...observation.session, updatedAt: null }, threads: observation.threads,
      events: [{ ...observation.events[0], rawRef: { type: "unavailable", reason: "fixture" }, kind: "message", author: "User", text: "hello", occurredAt: null }] }
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(CanonicalBatch)(batch))
    expect(decoded.session.updatedAt).toBeNull(); expect(decoded.events[0]?.occurredAt).toBeNull()
    expect(decoded.observedAt).toBe(observation.observedAt)
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(CanonicalBatch)({ ...batch, canonicalProfileVersion: CanonicalProfileVersion }))).rejects.toBeDefined()
    for (const missing of [
      { ...batch, session: { ...batch.session, updatedAt: undefined } },
      { ...batch, events: [{ ...batch.events[0], occurredAt: undefined }] }
    ]) await expect(Effect.runPromise(Schema.decodeUnknownEffect(CanonicalBatch)(missing))).rejects.toBeDefined()
  })

  it("accepts the pinned ACP v1 content profile", async () => {
    const decoded = await Schema.decodeUnknownEffect(AdapterCollectionPage)(page).pipe(Effect.runPromise)
    expect(decoded.observations[0]?.events[0]?.update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" }
    })
  })

  it("rejects the retired flat Message projection at the Adapter boundary", async () => {
    const legacy = structuredClone(page) as unknown
    const event = (legacy as {
      observations: Array<{ events: Array<Record<string, unknown>> }>
    }).observations[0]?.events[0]
    if (!event) throw new Error("missing fixture event")
    delete event.update
    Object.assign(event, { kind: "message", author: "Codex", text: "Hello" })

    await expect(Schema.decodeUnknownEffect(AdapterCollectionPage)(legacy).pipe(Effect.runPromise))
      .rejects.toBeDefined()
  })
})
