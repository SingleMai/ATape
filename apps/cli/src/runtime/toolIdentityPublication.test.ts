import { rm } from "node:fs/promises"
import { CaptureJournal, beginPublicationCapture, comparePublicationSource, preparePublicationCanonical, publicationPreparationContext,
  type PublicationDraftView } from "@atape/application"
import { CanonicalProfileVersion, CanonicalProfileVersion3, CanonicalProfileVersion4, PublicationTargetProfile2, PublicationTargetProfile3,
  PublicationTargetProfile4, ToolIdentityMetaKey, type CanonicalProfile } from "@atape/domain"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { fixture, directories, scope, timestamp } from "./fixtures/publication-test-support.ts"
import { FrozenOldPublicationIntent } from "./fixtures/frozen-publication-v2.ts"

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const source = (profile: CanonicalProfile = CanonicalProfileVersion4, name = "review") => {
  let reads = 0
  return { reads: () => reads, effect: Effect.sync((): PublicationDraftView => {
    let offset = 0
    return { profile: "fixture.identity.v1", canonicalProfileVersion: profile, sourceCheckpoint: "native-prefix",
      origin: { sourceId: scope.sourceSessionId, originKey: scope.originKey },
      session: { sourceSessionId: scope.sourceSessionId, title: "Identity", summary: "", insight: "", actor: { name: "User", harness: "Fixture" },
        branch: "", status: "idle", captureStatus: "complete", updatedAt: timestamp, reportedEventCount: 8 },
      threads: [{ sourceThreadId: "root", label: "Root", summary: "", captureStatus: "complete" }],
      target: { threads: 1, events: 8, usage: 0, retainedThreadIds: [] },
      read: () => Effect.sync(() => {
        const index = offset++; reads++
        return { frames: [{ recordKey: `row-${index}`, usage: [], events: [{ sourceEventId: `event-${index}`, sourceThreadId: "root",
          sourceOrder: index, eventIndex: index, orderFidelity: "native", fidelity: "native", occurredAt: index % 2 ? null : timestamp,
          update: index % 2 ? { sessionUpdate: "tool_call_update", toolCallId: `call-${Math.floor(index / 2)}`, status: "completed" } : {
            sessionUpdate: "tool_call", toolCallId: `call-${Math.floor(index / 2)}`, title: "Skill", status: "pending",
            _meta: { [ToolIdentityMetaKey]: { type: "skill", name } }
          } }] }], done: offset === 8 }
      }) }
  }) }
}

describe("tool identity through publication preparation and recovery", () => {
  it("freezes v4 outside old durable capabilities and preserves exact identity bytes across retry", async () => {
    const f = await fixture(16_000, {}, { v4: true })
    const prepared = await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "identity", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      const stored = JSON.parse((yield* journal.inspect(owner, "identity", { kind: "canonical" })).capture.beginJson)
      expect(stored).toMatchObject({ targetProfileV3: PublicationTargetProfile3, targetProfileV4: PublicationTargetProfile4,
        capabilities: { targetProfiles: ["atape.publication-target.v1", PublicationTargetProfile2] } })
      const old = yield* Schema.decodeUnknownEffect(FrozenOldPublicationIntent)(stored)
      expect(old).not.toHaveProperty("targetProfileV4")
      expect(old.capabilities.targetProfiles).toEqual(["atape.publication-target.v1", PublicationTargetProfile2])
      expect((yield* publicationPreparationContext(owner, "identity")).targetProfiles).toContain(PublicationTargetProfile4)
      const result = yield* preparePublicationCanonical(owner, "identity", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "identity-next",
        source: source().effect })
      const units: Uint8Array[] = []
      for (let ordinal = 0; ordinal < result.units; ordinal++) units.push(yield* journal.read(owner, "identity", "canonical", ordinal))
      expect(JSON.parse((yield* journal.sourceMetadata(owner, "identity"))!)).toMatchObject({ canonicalProfileVersion: CanonicalProfileVersion4 })
      return units
    }))
    expect(prepared.length).toBeGreaterThan(1)
    const events: { toolUpdateJson: string }[] = []
    for (const bytes of prepared) {
      const part = JSON.parse(new TextDecoder().decode(bytes))
      expect(part.target).toMatchObject({ profile: PublicationTargetProfile4, retainedThreadIds: [] })
      expect(part.batch.canonicalProfileVersion).toBe(CanonicalProfileVersion4)
      events.push(...part.batch.events)
    }
    expect(events.map(event => JSON.parse(event.toolUpdateJson)).filter(update => update._meta).map(update => update._meta))
      .toEqual(Array.from({ length: 4 }, () => ({ [ToolIdentityMetaKey]: { type: "skill", name: "review" } })))
    f.losePut()
    await expect(f.deliver(64, "identity")).rejects.toMatchObject({ reason: "network" })
    expect(await f.deliver(64, "identity")).toMatchObject({ state: "activated" })
    expect(f.sent[0]).toEqual(prepared[0]); expect(f.sent[1]).toEqual(prepared[0])
    const compare = (name: string) => f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      return yield* comparePublicationSource(owner, { adapterVersion: "0.0.0", observedAt: timestamp, transformVersion: "projection-1",
        limits: { records: 100, durationMs: 10_000 }, source: source(CanonicalProfileVersion4, name).effect })
    }))
    expect(await compare("review")).toMatchObject({ canonical: "unchanged", raw: "disabled" })
    expect(await compare("changed-review")).toMatchObject({ canonical: "changed", raw: "disabled" })
  })

  it("refuses a v3-only Server before reading frames, freezing content or uploading", async () => {
    const f = await fixture(16_000, {}, { v3: true }), candidate = source()
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "unsupported", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, "unsupported", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "unused", source: candidate.effect })
    }))).rejects.toMatchObject({ reason: "unsupported" })
    expect(candidate.reads()).toBe(0); expect(f.sent).toEqual([])
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      expect((yield* journal.inspect(owner, "unsupported", { kind: "canonical" })).units).toEqual([])
      expect(yield* journal.sourceMetadata(owner, "unsupported")).toBeNull()
    }))
  })

  it.each([CanonicalProfileVersion, CanonicalProfileVersion3])("rejects new tool metadata in a %s source", async profile => {
    const f = await fixture(16_000, {}, { v4: true })
    await expect(f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      yield* beginPublicationCapture(owner, { captureId: "old-profile", baseHead: "", transformVersion: "projection-1", rawEnabled: false, trackRecords: true })
      yield* preparePublicationCanonical(owner, "old-profile", { adapterVersion: "0.0.0", observedAt: timestamp, nextCheckpoint: "unused", source: source(profile).effect })
    }))).rejects.toMatchObject({ _tag: "CollectionContractError" })
    expect(f.sent).toEqual([])
  })
})
