import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { CanonicalProfileVersion, CanonicalProfileVersion3, CanonicalProfileVersion4, CanonicalProfileVersion5 } from "@atape/domain"
import { decodeSourceMetadata, sourceMetadataJson } from "./sourceMetadata.ts"
import { makeSecretRedactorLayer } from "./collectorPreparation.ts"
import type { PublicationDraftView } from "./canonicalSourceProjection.ts"

const threads = [{ sourceThreadId: "root", label: "Root", summary: "", captureStatus: "complete" as const }]
const decode = (value: unknown) => Effect.runPromise(decodeSourceMetadata(JSON.stringify(value)))

describe("frozen source metadata Interface", () => {
  it.each([undefined, CanonicalProfileVersion, CanonicalProfileVersion3, CanonicalProfileVersion4, CanonicalProfileVersion5])(
    "reads the existing direct profile %s without changing its effective value", async canonicalProfileVersion => {
      const source = { threads, ...(canonicalProfileVersion === undefined ? {} : { canonicalProfileVersion }) }
      expect(await decode(source)).toEqual(source)
    })

  it("writes v4 in an old-readable envelope and returns effective v4 to callers", async () => {
    const view: PublicationDraftView = { profile: "fixture.v4", canonicalProfileVersion: CanonicalProfileVersion4,
      origin: { sourceId: "session", originKey: "origin" }, sourceCheckpoint: "native-proof",
      session: { sourceSessionId: "session", title: "Session", summary: "", insight: "", actor: { name: "User", harness: "Fixture" },
        branch: "", status: "idle", captureStatus: "complete", updatedAt: null, reportedEventCount: 0 },
      threads, target: { threads: 1, events: 0, usage: 0, retainedThreadIds: [] },
      sourceFailures: [], sourceFailuresTruncated: false, read: () => Effect.succeed({ frames: [], done: true }) }
    const wire = await Effect.runPromise(sourceMetadataJson(view, threads).pipe(Effect.provide(makeSecretRedactorLayer())))
    expect(JSON.parse(wire)).toMatchObject({ canonicalProfileVersion: CanonicalProfileVersion3,
      canonicalProfileV4: CanonicalProfileVersion4, sourceCheckpoint: "native-proof" })
    const effective = await Effect.runPromise(decodeSourceMetadata(wire))
    expect(effective).toMatchObject({ canonicalProfileVersion: CanonicalProfileVersion4, sourceCheckpoint: "native-proof", threads })
    expect(effective).not.toHaveProperty("canonicalProfileV4")
  })

  it.each([
    { canonicalProfileV4: CanonicalProfileVersion4 },
    { canonicalProfileVersion: CanonicalProfileVersion, canonicalProfileV4: CanonicalProfileVersion4 },
    { canonicalProfileVersion: CanonicalProfileVersion4, canonicalProfileV4: CanonicalProfileVersion4 },
    { canonicalProfileVersion: CanonicalProfileVersion3, canonicalProfileV4: null },
    { canonicalProfileVersion: CanonicalProfileVersion3, canonicalProfileV4: CanonicalProfileVersion3 },
    { canonicalProfileVersion: CanonicalProfileVersion3, canonicalProfileV4: true }
  ])("rejects malformed or contradictory profile facts %j", async facts => {
    await expect(decode({ threads, ...facts })).rejects.toMatchObject({ reason: "invalid" })
  })

  it("retains null baseline behavior and rejects oversized serialized metadata", async () => {
    expect(await Effect.runPromise(decodeSourceMetadata(null))).toEqual({ threads: [] })
    await expect(Effect.runPromise(decodeSourceMetadata(" ".repeat(2 * 1024 * 1024 + 1)))).rejects.toMatchObject({ reason: "invalid" })
  })
})
