import { rm } from "node:fs/promises"
import { CaptureJournal, PublicationTransport, beginPublicationCapture, beginRawObservation, publicationPreparationContext, preparePublicationCanonical, prepareRawObservation, comparePublicationSource, type PublicationDraftView } from "@atape/application"
import { CanonicalBatch, CanonicalProfileVersion, CanonicalProfileVersion3, PublicationTargetProfile, PublicationTargetProfile2, PublicationTargetProfile3, type CanonicalProfile, type PublicationCapabilities } from "@atape/domain"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { fixture, directories, scope, timestamp } from "./fixtures/publication-test-support.ts"
import { FrozenOldPublicationIntent } from "./fixtures/frozen-publication-v2.ts"

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const source = (input: { readonly profile?: CanonicalProfile; readonly unknownSession?: boolean; readonly unknownEvents?: boolean; readonly knownTime?: string;
  readonly rawEnabled?: boolean; readonly sourceProfile?: string; readonly checkpoint?: string } = {}) => {
  let reads = 0
  return { reads: () => reads, effect: Effect.sync((): PublicationDraftView => {
    let offset = 0
    return { profile: input.sourceProfile ?? "fixture.time.v1", origin: { sourceId: scope.sourceSessionId, originKey: scope.originKey },
      ...(input.profile === undefined ? {} : { canonicalProfileVersion: input.profile }),
      ...(input.checkpoint === undefined ? {} : { sourceCheckpoint: input.checkpoint }),
      session: { sourceSessionId: scope.sourceSessionId, title: "Time fidelity", summary: "", insight: "", actor: { name: "User", harness: "Fixture" },
        branch: "", status: "idle", captureStatus: "complete", updatedAt: input.unknownSession ? null : input.knownTime ?? timestamp, reportedEventCount: 8 },
      threads: [{ sourceThreadId: "root", label: "Root", summary: "", captureStatus: "complete" }],
      target: { threads: 1, events: 8, usage: 0 },
      read: () => Effect.sync(() => {
        reads++
        const index = offset++
        return { frames: [{ recordKey: `row-${index}`, usage: [], ...(input.rawEnabled ? { raw: { row: index, text: `native message ${index}` } } : {}),
          events: [{ sourceEventId: `event-${index}`, sourceThreadId: "root",
          sourceOrder: index, eventIndex: index, orderFidelity: "native", fidelity: "native",
          occurredAt: input.unknownEvents && index % 2 === 1 ? null : input.knownTime ?? timestamp,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `message ${index}` } } }] }], done: offset === 8 }
      }) }
  }) }
}

describe("Unknown conversation times through the Host", () => {
  const rawLimits = { objectBytes: 4000, wireBytes: 8192, targetBytes: 100_000, units: 100 }
  const authority = { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 } as const

  it.each([CanonicalProfileVersion, CanonicalProfileVersion3])("persists a frozen-old-Host-readable Intent and reopens negotiated %s preparation", async profile => {
    const f = await fixture(16_000, {}, { v3: true })
    const intentJson = await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "negotiated", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      return (yield* journal.inspect(owner, "negotiated", { kind: "canonical" })).capture.beginJson
    }))
    const stored = JSON.parse(intentJson)
    expect(stored).toMatchObject({ targetProfileV3: PublicationTargetProfile3,
      capabilities: { targetProfiles: ["atape.publication-target.v1", "atape.publication-target.v2"] } })
    const legacy = await Effect.runPromise(Schema.decodeUnknownEffect(FrozenOldPublicationIntent)(stored))
    expect(legacy.capabilities.targetProfiles).toEqual(["atape.publication-target.v1", "atape.publication-target.v2"])
    expect(legacy).not.toHaveProperty("targetProfileV3")
    const prepared = await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* preparePublicationCanonical(owner, "negotiated", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "next",
        source: source({ profile, unknownSession: profile === CanonicalProfileVersion3, unknownEvents: profile === CanonicalProfileVersion3 }).effect })
      return JSON.parse(new TextDecoder().decode(yield* journal.read(owner, "negotiated", "canonical", 0)))
    }))
    expect(prepared.batch.canonicalProfileVersion).toBe(profile)
    expect(await f.deliver(64, "negotiated")).toMatchObject({ state: "activated" })
  })

  it("reads an earlier unpublished all-three-profiles Intent without requiring the new fact", async () => {
    const f = await fixture(16_000, {}, { v3: true })
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "seed", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      const stored = JSON.parse((yield* journal.inspect(owner, "seed", { kind: "canonical" })).capture.beginJson)
      delete stored.targetProfileV3
      stored.capabilities.targetProfiles.push(PublicationTargetProfile3)
      stored.begin.captureId = "prior-all3"
      yield* journal.settle(owner, "seed", { _tag: "AbandonUnsealed" })
      yield* journal.reserve(owner, { id: "prior-all3", expectedCheckpoint: owner.checkpoint, beginJson: JSON.stringify(stored), rawEnabled: false, trackRecords: true })
      expect((yield* publicationPreparationContext(owner, "prior-all3")).targetProfiles).toContain(PublicationTargetProfile3)
    }))
  })

  it.each([
    { wire: [PublicationTargetProfile, PublicationTargetProfile, PublicationTargetProfile2], durable: [PublicationTargetProfile, PublicationTargetProfile2] },
    { wire: [PublicationTargetProfile3], durable: [] }
  ] satisfies ReadonlyArray<{ wire: NonNullable<PublicationCapabilities["targetProfiles"]>; durable: NonNullable<PublicationCapabilities["targetProfiles"]> }>)("keeps the durable capability list old-readable for $wire", async ({ wire, durable }) => {
    const f = await fixture(16_000, {}, { v3: true })
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope), remote = yield* PublicationTransport
      yield* beginPublicationCapture(owner, { captureId: "bounded", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true }).pipe(
        Effect.provideService(PublicationTransport, { ...remote, capabilities: binding => remote.capabilities(binding).pipe(
          Effect.map(capabilities => ({ ...capabilities, targetProfiles: wire }))) }))
      const stored = JSON.parse((yield* journal.inspect(owner, "bounded", { kind: "canonical" })).capture.beginJson)
      expect(stored.capabilities.targetProfiles).toEqual(durable)
      yield* Schema.decodeUnknownEffect(FrozenOldPublicationIntent)(stored)
      expect((yield* publicationPreparationContext(owner, "bounded")).targetProfiles).toEqual(wire.some(profile => profile === PublicationTargetProfile3)
        ? [...durable, PublicationTargetProfile3] : durable)
    }))
  })

  it.each([CanonicalProfileVersion, CanonicalProfileVersion3])("keeps Raw-only identity compatible with Canonical+Raw under %s", async profile => {
    const f = await fixture(16_000, {}, { v3: true })
    const input = { profile, unknownSession: profile === CanonicalProfileVersion3, unknownEvents: profile === CanonicalProfileVersion3,
      checkpoint: "native-prefix" }
    f.policy(false)
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "off", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, "off", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "off-next", source: source(input).effect })
    }))
    await f.deliver(64, "off")
    f.policy(true)
    const compare = () => f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      return yield* comparePublicationSource(owner, { adapterVersion: "0.0.0", observedAt: timestamp, transformVersion: "projection-1",
        limits: { records: 100, durationMs: 10_000 }, raw: { authority, limits: rawLimits }, source: source({ ...input, rawEnabled: true }).effect })
    }))
    expect(await compare()).toMatchObject({ canonical: "unchanged", raw: "required" })
    const fresh = await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginRawObservation(owner, { observationId: "raw-only", canonicalCaptureId: "off" })
      const observation = JSON.parse((yield* journal.inspect(owner, "raw-only", { kind: "raw" })).capture.beginJson)
      yield* Schema.decodeUnknownEffect(FrozenOldPublicationIntent)(observation.canonical.intent)
      return yield* prepareRawObservation(owner, "raw-only", { adapterVersion: "0.0.0", observedAt: timestamp, limits: rawLimits,
        source: source({ ...input, rawEnabled: true }).effect })
    }))
    expect(fresh.units).toBeGreaterThan(0)
    expect(await f.deliverRaw(64, "raw-only")).toMatchObject({ state: "completed" })
    expect(await compare()).toMatchObject({ canonical: "unchanged", raw: "unchanged" })
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      const before = yield* journal.records(owner, "raw-only", { kind: "raw" })
      expect(before.every(record => record.disposition === "acknowledged")).toBe(true)
      yield* beginPublicationCapture(owner, { captureId: "together", baseHead: f.snapshot().id, transformVersion: "projection-1",
        rawEnabled: true, rawAuthority: authority, trackRecords: true })
      const together = yield* preparePublicationCanonical(owner, "together", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "together-next",
        rawLimits, source: source({ ...input, rawEnabled: true }).effect })
      expect(together.raw).toMatchObject({ units: 0, reused: 8, records: 8 })
      const identity = (record: (typeof before)[number]) => [record.key, record.revision, record.fingerprint, record.projectionVersion]
      expect((yield* journal.records(owner, "together", { kind: "raw" })).map(identity)).toEqual(before.map(identity))
    }))
  })

  it.each(["default_v2", "explicit_v2", "source_profile", "checkpoint"] as const)("rejects a fresh Raw view whose frozen projection changed (%s)", async change => {
    const f = await fixture(16_000, {}, { v3: true })
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "baseline", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, "baseline", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "baseline-next",
        source: source({ profile: CanonicalProfileVersion3, unknownSession: true, unknownEvents: true, checkpoint: "same-prefix" }).effect })
    }))
    await f.deliver(64, "baseline")
    const fresh = source({ rawEnabled: true, ...(change === "checkpoint" ? {} : { checkpoint: "same-prefix" }),
      ...(change === "default_v2" ? {} : { profile: change === "explicit_v2" ? CanonicalProfileVersion : CanonicalProfileVersion3 }),
      ...(change === "source_profile" ? { sourceProfile: "fixture.time.v2" } : {}) })
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginRawObservation(owner, { observationId: "changed", canonicalCaptureId: "baseline" })
      yield* prepareRawObservation(owner, "changed", { adapterVersion: "0.0.0", observedAt: timestamp, limits: rawLimits, source: fresh.effect })
    }))).rejects.toMatchObject({ reason: "conflict" })
    expect(fresh.reads()).toBe(0)
    expect(f.rawSent).toEqual([])
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      expect((yield* journal.inspect(owner, "changed", { kind: "raw" })).units).toEqual([])
      expect(yield* journal.records(owner, "changed", { kind: "raw" })).toEqual([])
      expect((yield* journal.coverage(owner)).canonicalCaptureId).toBe("baseline")
      expect(owner.checkpoint).toBe("baseline-next")
    }))
  })

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
