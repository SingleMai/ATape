import { rm } from "node:fs/promises"
import { CaptureJournal, beginPublicationCapture, preparePublicationCanonical, comparePublicationSource, type PublicationDraftView } from "@atape/application"
import { CanonicalBatch, CanonicalProfileVersion, CanonicalProfileVersion3, PublicationTargetProfile3, type CanonicalProfile } from "@atape/domain"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { fixture, directories, scope, timestamp } from "./fixtures/publication-test-support.ts"

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const source = (input: { readonly profile?: CanonicalProfile; readonly unknownSession?: boolean; readonly unknownEvents?: boolean; readonly knownTime?: string } = {}) => {
  let reads = 0
  return { reads: () => reads, effect: Effect.sync((): PublicationDraftView => {
    let offset = 0
    return { profile: "fixture.time.v1", origin: { sourceId: scope.sourceSessionId, originKey: scope.originKey },
      ...(input.profile === undefined ? {} : { canonicalProfileVersion: input.profile }),
      session: { sourceSessionId: scope.sourceSessionId, title: "Time fidelity", summary: "", insight: "", actor: { name: "User", harness: "Fixture" },
        branch: "", status: "idle", captureStatus: "complete", updatedAt: input.unknownSession ? null : input.knownTime ?? timestamp, reportedEventCount: 8 },
      threads: [{ sourceThreadId: "root", label: "Root", summary: "", captureStatus: "complete" }],
      target: { threads: 1, events: 8, usage: 0 },
      read: () => Effect.sync(() => {
        reads++
        const index = offset++
        return { frames: [{ recordKey: `row-${index}`, usage: [], events: [{ sourceEventId: `event-${index}`, sourceThreadId: "root",
          sourceOrder: index, eventIndex: index, orderFidelity: "native", fidelity: "native",
          occurredAt: input.unknownEvents && index % 2 === 1 ? null : input.knownTime ?? timestamp,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `message ${index}` } } }] }], done: offset === 8 }
      }) }
  }) }
}

describe("Unknown conversation times through the Host", () => {
  it("freezes one negotiated v3 profile across mixed known/unknown parts and replays the same null bytes", async () => {
    const f = await fixture(16_000, {}, { v3: true })
    const prepared = await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "unknown", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      const ready = yield* preparePublicationCanonical(owner, "unknown", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "unknown-next",
        source: source({ profile: CanonicalProfileVersion3, unknownSession: true, unknownEvents: true }).effect })
      const units = []
      for (let ordinal = 0; ordinal < ready.units; ordinal++) units.push(yield* journal.read(owner, "unknown", "canonical", ordinal))
      expect(JSON.parse((yield* journal.sourceMetadata(owner, "unknown"))!)).toMatchObject({ canonicalProfileVersion: CanonicalProfileVersion3 })
      return units
    }))
    expect(prepared.length).toBeGreaterThan(1)
    const events = []
    for (const bytes of prepared) {
      const part = JSON.parse(new TextDecoder().decode(bytes))
      expect(part.target).toMatchObject({ profile: PublicationTargetProfile3, retainedThreadIds: [] })
      const batch = await Effect.runPromise(Schema.decodeUnknownEffect(CanonicalBatch)(part.batch))
      expect(batch.canonicalProfileVersion).toBe(CanonicalProfileVersion3)
      expect(batch.session.updatedAt).toBeNull(); expect(batch.observedAt).toBe(timestamp)
      events.push(...batch.events)
    }
    expect(events.map(event => event.occurredAt)).toEqual(Array.from({ length: 8 }, (_, index) => index % 2 ? null : timestamp))
    f.losePut()
    await expect(f.deliver(64, "unknown")).rejects.toMatchObject({ reason: "network" })
    expect(await f.deliver(64, "unknown")).toMatchObject({ state: "activated" })
    expect(f.sent[0]).toEqual(prepared[0]); expect(f.sent[1]).toEqual(prepared[0])
    expect(f.rawSent).toEqual([])
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      const comparison = yield* comparePublicationSource(owner, { adapterVersion: "0.0.0", observedAt: "2030-01-01T00:00:00Z", transformVersion: "projection-1",
        limits: { records: 100, durationMs: 10_000 }, source: source({ profile: CanonicalProfileVersion3, unknownSession: true, unknownEvents: true }).effect })
      expect(comparison).toMatchObject({ canonical: "unchanged", raw: "disabled" })
    }))
  })

  it("rejects v3 on an older Server before reading frames or freezing content", async () => {
    const f = await fixture(16_000, {}, { v2: true }), candidate = source({ profile: CanonicalProfileVersion3, unknownSession: true, unknownEvents: true })
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "unsupported", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      return yield* preparePublicationCanonical(owner, "unsupported", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "unused", source: candidate.effect })
    }))).rejects.toMatchObject({ reason: "unsupported" })
    expect(candidate.reads()).toBe(0); expect(f.sent).toEqual([])
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      expect((yield* journal.inspect(owner, "unsupported", { kind: "canonical" })).units).toEqual([])
      expect(yield* journal.sourceMetadata(owner, "unsupported")).toBeNull()
    }))
  })

  it.each(["session", "event"] as const)("rejects unknown %s time when source capture keeps its default v2 profile", async field => {
    const f = await fixture(16_000, {}, { v3: true })
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "default", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      return yield* preparePublicationCanonical(owner, "default", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "unused",
        source: source({ unknownSession: field === "session", unknownEvents: field === "event" }).effect })
    }))).rejects.toMatchObject({ _tag: "CollectionContractError" })
    expect(f.sent).toEqual([])
  })

  it.each(["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000000000Z", "0001-01-01T01:00:00+01:00",
    "0001-01-01T00:00:00.000000001Z", "0001-01-01T00:00:00.000000999Z", "0001-01-01T01:00:00.000000001+01:00"])("rejects a timestamp that truncates to zero %s before freezing content", async knownTime => {
    const f = await fixture(16_000, {}, { v3: true })
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "zero", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      return yield* preparePublicationCanonical(owner, "zero", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "unused",
        source: source({ profile: CanonicalProfileVersion3, knownTime }).effect })
    }))).rejects.toMatchObject({ _tag: "CollectionContractError" })
    expect(f.sent).toEqual([])
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      expect((yield* journal.inspect(owner, "zero", { kind: "canonical" })).units).toEqual([])
    }))
  })

  it.each(["0001-01-01T00:00:00.000001Z", "2026-10-10T00:00:00.000000001Z"])("retains a known timestamp %s when its stored microseconds are nonzero", async knownTime => {
    const f = await fixture(16_000, {}, { v3: true })
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "nanosecond", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, "nanosecond", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "next",
        source: source({ profile: CanonicalProfileVersion3, knownTime }).effect })
      const part = JSON.parse(new TextDecoder().decode(yield* journal.read(owner, "nanosecond", "canonical", 0)))
      expect(part.batch.session.updatedAt).toBe(knownTime)
      expect(part.batch.events.length).toBeGreaterThan(0)
      expect(part.batch.events.every((event: { readonly occurredAt: unknown }) => event.occurredAt === knownTime)).toBe(true)
    }))
  })

  it("keeps known-time provider bytes on v2 and compares a v3 profile selection as a change", async () => {
    const f = await fixture(16_000, {}, { v3: true })
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "known", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, "known", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "known-next", source: source().effect })
      const part = JSON.parse(new TextDecoder().decode(yield* journal.read(owner, "known", "canonical", 0)))
      expect(part.batch.canonicalProfileVersion).toBe(CanonicalProfileVersion)
      expect((yield* journal.records(owner, "known", { kind: "session" }))[0]?.projectionVersion).toBe("atape.host-canonical.v1:projection-1:fixture.time.v1")
    }))
    await f.deliver(64, "known")
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      const comparison = yield* comparePublicationSource(owner, { adapterVersion: "0.0.0", observedAt: timestamp, transformVersion: "projection-1",
        limits: { records: 100, durationMs: 10_000 }, source: source({ profile: CanonicalProfileVersion3 }).effect })
      expect(comparison.canonical).toBe("changed")
    }))
  })
})
