import { readFile, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, expect, it } from "vitest"
import { CaptureJournal, beginPublicationCapture, preparePublicationCanonical, deliverPublicationCapture,
  deliverPublicationRaw, comparePublicationSource, CaptureJournals, CollectorStateStore, SourceCaptureCollector,
  makeSourceCaptureCollectorLayer, makeSecretRedactorLayer, SecretRedactor, AdapterRuntimeError, type HostedAdapter } from "@atape/application"
import { CanonicalProfileVersion4, CanonicalProfileVersion5, FileActivityMetaKey, PublicationTargetProfile5, SourceCaptureVersion2,
  ToolIdentityMetaKey, type AdapterInstallation, type LocalProject } from "@atape/domain"
import { directories, fixture, nativePreparationSource, timestamp } from "./fixtures/publication-test-support.ts"
import { sourceCollectionLimits as limits } from "./fixtures/source-collection-test-support.ts"
import { makeCaptureJournalsLayer } from "./captureBootstrap.ts"
import { makeCollectorStateLayer } from "./collectorState.ts"

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

it("replays a source-profile change within Canonical v5 once and recovers its new frozen file facts without source bytes", async () => {
  const remote = await fixture(16384, {}, { v5: true }), native = await nativePreparationSource()
  const stateFile = `${remote.path}.collector.json`
  const project: LocalProject = { id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team", teamName: "Team",
    name: "Project", type: "directory", path: dirname(native.path), createdAt: timestamp, adapterIds: ["opencode"] }
  const adapter: AdapterInstallation = { adapterId: "opencode", packageName: "@atape/adapter-opencode", version: "0.5.10", displayName: "Controlled native source",
    upgradeSpec: "@atape/adapter-opencode", installedAt: timestamp, updatedAt: timestamp }
  const base = Layer.mergeAll(makeCaptureJournalsLayer(stateFile), makeCollectorStateLayer(stateFile), remote.remote, remote.rawRemote,
    makeSecretRedactorLayer(["SENSITIVE_TEST_TOKEN"]))
  const layer = Layer.merge(base, makeSourceCaptureCollectorLayer(limits).pipe(Layer.provide(base)))
  const run = <A, E>(work: Effect.Effect<A, E, SourceCaptureCollector | CollectorStateStore | CaptureJournals | SecretRedactor>) =>
    Effect.runPromise(work.pipe(Effect.provide(layer)))
  let current: "old" | "new" = "old", missing = false, opens = 0
  // The controlled Adapter uses existing native-format pages to isolate Host
  // source-profile compatibility. It does not establish new OpenCode support.
  const source = (profile: "claude.jsonl.active-path.3" | "claude.jsonl.active-path.4", activity: boolean, rawEnabled = true) =>
    native.source(rawEnabled).pipe(Effect.map(view => ({ ...view, profile, canonicalProfileVersion: CanonicalProfileVersion5,
      sourceCheckpoint: "same-native-proof", sourceFailures: [], sourceFailuresTruncated: false,
      target: { ...view.target, retainedThreadIds: [] },
      read: () => view.read().pipe(Effect.map(page => ({ ...page, frames: page.frames.map(frame => ({ ...frame,
        events: frame.events.map(event => event.update.sessionUpdate === "tool_call" || event.update.sessionUpdate === "tool_call_update"
          ? { ...event, update: { ...event.update, rawInput: { file_path: "src/retained.ts" },
            _meta: { [ToolIdentityMetaKey]: { type: "tool" as const, name: "Read" },
              ...(activity ? { [FileActivityMetaKey]: [{ operation: "read" as const, path: "src/retained.ts" }] } : {}) } } }
          : event) })) })), Effect.mapError(() => new AdapterRuntimeError({ adapterId: adapter.adapterId,
            reason: "collect", retryable: true, message: "Controlled native source read failed." }))) })),
      Effect.mapError(() => new AdapterRuntimeError({ adapterId: adapter.adapterId, reason: "collect", retryable: true, message: "Controlled native source open failed." })))
  const host: Extract<HostedAdapter, { sourceCapture: unknown }> = { publicationTargetProfile: PublicationTargetProfile5,
    attribute: () => Effect.succeed("included"), sourceCapture: { protocolVersion: SourceCaptureVersion2,
      discover: () => Effect.succeed({ sources: missing ? [] : [{ ...native.metadata.origin, cwd: project.path }], cursor: null, done: true,
        sourceFailures: [], sourceFailuresTruncated: false }),
      open: request => Effect.suspend(() => {
        opens++
        if (missing) return Effect.die("Frozen recovery must not open a removed source.")
        return source(current === "old" ? "claude.jsonl.active-path.3" : "claude.jsonl.active-path.4", current === "new", request.rawEnabled)
      })
    } }
  const cycle = () => run(Effect.gen(function*() {
    const states = yield* CollectorStateStore, collector = yield* SourceCaptureCollector
    return yield* collector.collect(project, adapter, host, yield* states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId))
  }))
  const inspect = () => run(Effect.scoped(Effect.gen(function*() {
    const journal = yield* (yield* CaptureJournals).open({ instanceOrigin: project.instanceOrigin, userId: project.userId }, limits.journal)
    const owner = yield* journal.claim(native.ownerScope), coverage = yield* journal.coverage(owner), unactivated = yield* journal.unactivated(owner)
    const id = unactivated?.id ?? coverage.canonicalCaptureId!
    return { coverage, id, checkpoint: owner.checkpoint, metadata: yield* journal.sourceMetadata(owner, id),
      capture: (yield* journal.inspect(owner, id, { kind: "canonical", limit: 100 })).capture,
      events: yield* journal.records(owner, id, { kind: "event" }), raw: yield* journal.records(owner, id, { kind: "raw" }),
      ...(unactivated ? { frozen: yield* journal.read(owner, id, "canonical", 0) } : {}) }
  })))
  expect(await cycle()).toMatchObject({ observations: 1, canonicalEvents: 6, sourceFailures: [] })
  const before = await inspect(), oldBytes = remote.sent.map(bytes => new Uint8Array(bytes)), oldReceipts = structuredClone([...remote.rawReceipts])
  expect(before.events.every(record => record.projectionVersion.startsWith("atape.host-canonical.v4:"))).toBe(true)
  expect(before.events.every(record => record.projectionVersion.endsWith(":claude.jsonl.active-path.3"))).toBe(true)
  expect(JSON.parse(before.metadata!)).toMatchObject({ canonicalProfileVersion: CanonicalProfileVersion5, sourceCheckpoint: "same-native-proof" })

  // Identical content under a different source profile must still replay. Both
  // profiles deliberately use the unchanged Host Canonical-v5 namespace.
  const profileOnly = await run(Effect.scoped(Effect.gen(function*() {
    const journal = yield* (yield* CaptureJournals).open({ instanceOrigin: project.instanceOrigin, userId: project.userId }, limits.journal)
    const owner = yield* journal.claim(native.ownerScope)
    return yield* comparePublicationSource(owner, { adapterVersion: adapter.version, observedAt: timestamp,
      transformVersion: JSON.parse(before.capture.beginJson).begin.transformVersion, limits: limits.comparison,
      raw: { authority, limits: rawLimits }, source: source("claude.jsonl.active-path.4", false) }).pipe(Effect.provideService(CaptureJournal, journal))
  })))
  expect(profileOnly.canonical).toBe("changed")
  current = "new"; remote.losePut()
  expect(await cycle()).toMatchObject({ observations: 1, sourceFailures: [{ source: native.metadata.origin.sourceId, reason: "io" }] })
  const pending = await inspect()
  expect(pending.id).not.toBe(before.id)
  expect(pending.coverage.canonicalCaptureId).toBe(before.id)
  expect(pending.checkpoint).toBe(before.checkpoint)
  expect(pending.frozen).toEqual(remote.sent.at(-1))
  expect(pending.events.map(record => record.key).sort()).toEqual(before.events.map(record => record.key).sort())
  expect(pending.events.every(record => record.revision > before.events.find(prior => prior.key === record.key)!.revision)).toBe(true)
  expect(pending.events.every(record => record.projectionVersion.endsWith(":claude.jsonl.active-path.4"))).toBe(true)
  expect(pending.events[0]!.projectionVersion.replace("claude.jsonl.active-path.4", "claude.jsonl.active-path.3"))
    .toBe(before.events[0]!.projectionVersion)
  const frozen = new Uint8Array(pending.frozen!), preservedSource = await readFile(native.path), opened = opens
  const pendingMetadata = pending.metadata
  const retainedOldMetadata = await run(Effect.scoped(Effect.gen(function*() {
    const journal = yield* (yield* CaptureJournals).open({ instanceOrigin: project.instanceOrigin, userId: project.userId }, limits.journal)
    return yield* journal.sourceMetadata(yield* journal.claim(native.ownerScope), before.id)
  })))
  expect(retainedOldMetadata).toBe(before.metadata)
  await rm(native.path); missing = true
  expect(await cycle()).toMatchObject({ observations: 0, sourceFailures: [] })
  expect(opens).toBe(opened)
  expect(remote.sent.slice(0, oldBytes.length)).toEqual(oldBytes)
  expect(remote.sent[oldBytes.length]).toEqual(frozen)
  expect(remote.sent[oldBytes.length + 1]).toEqual(frozen)
  const after = await inspect()
  expect(after.id).toBe(pending.id)
  expect(after.capture.activationReceipt).not.toBeNull()
  expect(after.checkpoint).not.toBe(before.checkpoint)
  expect(after.metadata).toBe(pendingMetadata)
  const retired = await run(Effect.scoped(Effect.gen(function*() {
    const journal = yield* (yield* CaptureJournals).open({ instanceOrigin: project.instanceOrigin, userId: project.userId }, limits.journal)
    const owner = yield* journal.claim(native.ownerScope)
    return { capture: (yield* journal.inspect(owner, before.id, { kind: "canonical", limit: 1 })).capture,
      metadata: yield* journal.sourceMetadata(owner, before.id) }
  })))
  expect(retired.capture.recordsRetired).toBe(true)
  expect(retired.metadata).toBeNull()
  expect(JSON.parse(after.metadata!)).toMatchObject({ canonicalProfileVersion: CanonicalProfileVersion5, sourceCheckpoint: "same-native-proof" })
  for (const [key, receipt] of oldReceipts) expect(remote.rawReceipts.get(key)).toEqual(receipt)
  expect(remote.sent.slice(oldBytes.length).map(bytes => new TextDecoder().decode(bytes)).join("\n"))
    .toContain('\\"atape.dev/file-activity\\"')

  // Restoring the exact unchanged source proves that normal collection compares
  // the new projection as a no-op rather than allocating another capture.
  await writeFile(native.path, preservedSource); missing = false
  const sent = remote.sent.length, rawSent = remote.rawSent.length, reservations = remote.reservations()
  for (let n = 0; n < 2; n++) expect(await cycle()).toMatchObject({ observations: 0, canonicalBatches: 0, rawChunks: 0, sourceFailures: [] })
  expect(remote.reservations()).toBe(reservations)
  expect(remote.sent).toHaveLength(sent); expect(remote.rawSent).toHaveLength(rawSent)
  expect((await inspect()).coverage).toEqual(after.coverage)
}, 30000)
