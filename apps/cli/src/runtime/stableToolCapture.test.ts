import { rm } from "node:fs/promises"
import { Effect } from "effect"
import { afterEach, expect, it } from "vitest"
import { CaptureJournal, beginPublicationCapture, preparePublicationCanonical, deliverPublicationCapture,
  deliverPublicationRaw, comparePublicationSource } from "@atape/application"
import { CanonicalProfileVersion4, CanonicalProfileVersion5, ToolIdentityMetaKey } from "@atape/domain"
import { directories, fixture, nativePreparationSource, timestamp } from "./fixtures/publication-test-support.ts"

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const rawLimits = { objectBytes: 4000, wireBytes: 8192, targetBytes: 100_000, units: 100 }
const authority = { protocol: "atape.raw-publication.v1", teamRevision: 1, userRevision: 1 } as const

it("replaces a v4 capture once with v5 identity while retaining accepted bytes, IDs and Raw receipts", async () => {
  const f = await fixture(16384, {}, { v5: true }), native = await nativePreparationSource()
  // A controlled source Adapter adds explicit identity to real native-format
  // rows. This verifies Host behavior, not additional OpenCode support.
  const source = (profile: typeof CanonicalProfileVersion4 | typeof CanonicalProfileVersion5) =>
    native.source(true).pipe(Effect.map(view => ({ ...view, profile: "controlled-identity-source",
      canonicalProfileVersion: profile, sourceCheckpoint: "same-native-proof", sourceFailures: [], sourceFailuresTruncated: false,
      target: { ...view.target, retainedThreadIds: [] },
      read: () => view.read().pipe(Effect.map(page => ({ ...page, frames: page.frames.map(frame => ({ ...frame,
        events: frame.events.map(event => profile === CanonicalProfileVersion5 &&
          (event.update.sessionUpdate === "tool_call" || event.update.sessionUpdate === "tool_call_update")
          ? { ...event, update: { ...event.update, _meta: { [ToolIdentityMetaKey]: { type: "tool" as const, name: "bash" } } } }
          : event) })) }))) })))
  const prepare = (id: string, profile: typeof CanonicalProfileVersion4 | typeof CanonicalProfileVersion5, baseHead = "") =>
    f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(native.ownerScope)
      yield* beginPublicationCapture(owner, { captureId: id, baseHead, transformVersion: "host-v1", rawEnabled: true,
        rawAuthority: authority, trackRecords: true })
      return yield* preparePublicationCanonical(owner, id, { adapterVersion: "0.5.10", observedAt: timestamp,
        nextCheckpoint: "same-native-proof", rawLimits, source: source(profile) })
    }))
  const deliver = (id: string) => f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal, owner = yield* journal.claim(native.ownerScope)
    yield* deliverPublicationCapture(owner, id, 64)
    return yield* deliverPublicationRaw(owner, id, 64)
  }))
  const records = (id: string) => f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal, owner = yield* journal.claim(native.ownerScope)
    return { checkpoint: owner.checkpoint, metadata: yield* journal.sourceMetadata(owner, id),
      events: yield* journal.records(owner, id, { kind: "event" }),
      raw: yield* journal.records(owner, id, { kind: "raw" }) }
  }))
  const compare = () => f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal, owner = yield* journal.claim(native.ownerScope)
    return yield* comparePublicationSource(owner, { adapterVersion: "0.5.10", observedAt: timestamp, transformVersion: "host-v1",
      limits: { records: 1000, durationMs: 10000 }, raw: { authority, limits: rawLimits }, source: source(CanonicalProfileVersion5) })
  }))

  await prepare("v4", CanonicalProfileVersion4)
  await deliver("v4")
  const before = await records("v4"), priorBytes = f.sent.map(bytes => new Uint8Array(bytes))
  const priorReceipts = structuredClone([...f.rawReceipts])
  expect(before.raw.every(record => record.disposition === "acknowledged")).toBe(true)
  expect(await compare()).toMatchObject({ canonical: "changed" })

  await prepare("v5", CanonicalProfileVersion5, f.snapshot().id)
  f.losePut()
  await expect(deliver("v5")).rejects.toMatchObject({ reason: "network" })
  const frozen = new Uint8Array(f.sent.at(-1)!)
  await rm(native.path)
  await deliver("v5")
  expect(f.sent.slice(0, priorBytes.length)).toEqual(priorBytes)
  expect(f.sent[priorBytes.length]).toEqual(frozen)
  expect(f.sent[priorBytes.length + 1]).toEqual(frozen)
  const after = await records("v5")
  expect(after.checkpoint).toBe("same-native-proof")
  expect(JSON.parse(after.metadata!)).toMatchObject({ canonicalProfileVersion: CanonicalProfileVersion5,
    sourceCheckpoint: "same-native-proof" })
  expect(after.events.map(record => record.key).sort()).toEqual(before.events.map(record => record.key).sort())
  expect(after.events.every(record => record.revision > before.events.find(prior => prior.key === record.key)!.revision)).toBe(true)
  expect((await records("v4")).raw).toEqual(before.raw)
  for (const [key, receipt] of priorReceipts) expect(f.rawReceipts.get(key)).toEqual(receipt)
  const newWire = f.sent.slice(priorBytes.length).map(bytes => new TextDecoder().decode(bytes)).join("\n")
  expect(newWire).toContain(CanonicalProfileVersion5)
  expect(newWire).toContain('\\"type\\":\\"tool\\"')
}, 20000)
