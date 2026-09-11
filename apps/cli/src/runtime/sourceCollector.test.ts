import { CaptureJournals, CollectorStateStore, SourceCaptureCollector, makeSourceCaptureCollectorLayer, makeSecretRedactorLayer,
  AdapterRuntimeError, type HostedAdapter, type SourceCollectionLimits } from "@atape/application"
import type { AdapterInstallation, LocalProject } from "@atape/domain"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { dirname } from "node:path"
import { rm } from "node:fs/promises"
import { makeCaptureJournalsLayer } from "./captureBootstrap.ts"
import { makeCollectorStateLayer } from "./collectorLayers.ts"
import { fixture, nativePreparationSource, directories, timestamp } from "./fixtures/publication-test-support.ts"

import { sourceCollectionLimits as limits } from "./fixtures/source-collection-test-support.ts"

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const setup = async () => {
  const remote = await fixture(16384), native = await nativePreparationSource()
  const stateFile = `${remote.path}.collector.json`
  const project: LocalProject = { id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team", teamName: "Team", name: "Project",
    type: "directory", path: dirname(native.path), createdAt: timestamp, adapterIds: ["opencode"] }
  const adapter: AdapterInstallation = { adapterId: "opencode", packageName: "@atape/adapter-opencode", version: "0.0.0", displayName: "OpenCode",
    upgradeSpec: "@atape/adapter-opencode", installedAt: timestamp, updatedAt: timestamp }
  const base = Layer.mergeAll(makeCaptureJournalsLayer(stateFile), makeCollectorStateLayer(stateFile), remote.remote, remote.rawRemote,
    makeSecretRedactorLayer(["SENSITIVE_TEST_TOKEN"]))
  const layer = Layer.merge(base, makeSourceCaptureCollectorLayer(limits).pipe(Layer.provide(base)))
  const run = <A, E>(work: Effect.Effect<A, E, SourceCaptureCollector | CollectorStateStore | CaptureJournals>) => Effect.runPromise(work.pipe(Effect.provide(layer)))
  let opens = 0, discoveries = 0, discoveryMissing = false
  const host: Extract<HostedAdapter, { sourceCapture: unknown }> = {
    attribute: () => Effect.succeed("included"),
    sourceCapture: {
      discover: () => Effect.suspend(() => {
        discoveries++
        return discoveryMissing ? Effect.fail(new AdapterRuntimeError({ adapterId: "opencode", reason: "collect", retryable: true, message: "Source file is missing." })) :
          Effect.succeed({ sources: [{ ...native.metadata.origin, cwd: project.path }], cursor: null, done: true, sourceFailures: [], sourceFailuresTruncated: false })
      }),
      open: request => Effect.suspend(() => { opens++; return native.source(request.rawEnabled).pipe(
        Effect.map(view => ({ ...view, read: () => view.read().pipe(Effect.mapError(() => new AdapterRuntimeError({
          adapterId: "opencode", reason: "collect", retryable: true, message: "Could not read controlled source." }))) })),
        Effect.mapError(() => new AdapterRuntimeError({ adapterId: "opencode", reason: "collect", retryable: true, message: "Could not open controlled source." }))) })
    }
  }
  const cycle = (selected = host, configured = limits) => Effect.runPromise(Effect.gen(function*() {
    const states = yield* CollectorStateStore, collector = yield* SourceCaptureCollector
    const snapshot = yield* states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId)
    return yield* collector.collect(project, adapter, selected, snapshot)
  }).pipe(Effect.provide(Layer.merge(base, makeSourceCaptureCollectorLayer(configured).pipe(Layer.provide(base))))))
  const inspect = () => run(Effect.scoped(Effect.gen(function*() {
    const factory = yield* CaptureJournals
    const journal = yield* factory.open({ instanceOrigin: project.instanceOrigin, userId: project.userId }, limits.journal)
    const owner = yield* journal.claim(native.ownerScope), coverage = yield* journal.coverage(owner)
    const capture = coverage.canonicalCaptureId === null ? null : (yield* journal.inspect(owner, coverage.canonicalCaptureId, { kind: "canonical", limit: 1 })).capture
    return { coverage, capture, canonicalUnits: capture === null ? [] : (yield* journal.inspect(owner, capture.id, { kind: "canonical", limit: 100 })).units,
      rawUnits: capture === null ? [] : (yield* journal.inspect(owner, capture.id, { kind: "raw", limit: 100 })).units, pending: yield* journal.pending(owner), checkpoint: owner.checkpoint,
      events: coverage.canonicalCaptureId === null ? [] : yield* journal.records(owner, coverage.canonicalCaptureId, { kind: "event" }) }
  })))
  const progress = () => run(CollectorStateStore.use(states => states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId)))
  return { remote, native, project, adapter, run, host, cycle, inspect, progress, opens: () => opens, discoveries: () => discoveries,
    missing: () => { discoveryMissing = true } }
}

describe("Host source collection workflow", () => {
  it("records confirmed Canonical progress across empty cycles and recovers older checkpoints without the source", async () => {
    const f = await setup(); f.remote.policy(false)
    expect((await f.progress()).checkpoint).toBeUndefined()
    await f.cycle()
    expect((await f.progress()).checkpoint).toMatchObject({ canonicalPublished: true, rawObjects: [] })
    expect(await f.cycle()).toMatchObject({ canonicalBatches: 0, observations: 0 })
    const saved = (await f.progress()).checkpoint!
    expect(saved.canonicalPublished).toBe(true)

    // Older Collector JSON has no progress field. Recovery must derive it from
    // the real journal activation, even when discovery can no longer succeed.
    const { canonicalPublished: _published, ...older } = saved
    await f.run(CollectorStateStore.use(states => states.commit({ instanceOrigin: f.project.instanceOrigin, userId: f.project.userId,
      projectId: f.project.id, adapterId: f.adapter.adapterId, expectedRevision: saved.revision,
      checkpoint: { ...older, revision: saved.revision + 1 } })))
    expect((await f.progress()).checkpoint?.canonicalPublished).toBeUndefined()
    const opens = f.opens(); await rm(f.native.path); f.missing()
    await expect(f.cycle()).rejects.toMatchObject({ reason: "collect" })
    expect((await f.progress()).checkpoint?.canonicalPublished).toBe(true)
    expect(f.opens()).toBe(opens)
  })
  it("does not treat discovery or an unsuccessful first capture as published progress", async () => {
    const f = await setup()
    const empty = { ...f.host, sourceCapture: { ...f.host.sourceCapture, discover: () => Effect.succeed({
      sources: [], cursor: null, done: true, sourceFailures: [], sourceFailuresTruncated: false }) } }
    expect(await f.cycle(empty)).toMatchObject({ observations: 0, canonicalBatches: 0 })
    expect((await f.progress()).checkpoint?.canonicalPublished).not.toBe(true)
    const broken = { ...f.host, sourceCapture: { ...f.host.sourceCapture, open: () => Effect.fail(new AdapterRuntimeError({
      adapterId: "opencode", reason: "collect", retryable: true, message: "Controlled read failure." })) } }
    expect(await f.cycle(broken)).toMatchObject({ observations: 0, canonicalBatches: 0,
      sourceFailures: [{ source: f.native.metadata.origin.sourceId, reason: "io" }] })
    expect((await f.progress()).checkpoint?.canonicalPublished).not.toBe(true)
    expect((await f.inspect()).coverage.canonicalCaptureId).toBeNull()
  })
  it("automatically retires superseded native memberships and sustains rewrites under unchanged admission", async () => {
    const f = await setup(), bounded = { ...limits, journal: { ...limits.journal, metadataEntries: 500 } }
    let previous: Awaited<ReturnType<typeof f.inspect>> | undefined
    for (let n = 0; n < 25; n++) {
      const db = new DatabaseSync(f.native.path)
      db.prepare("UPDATE part SET data=json_set(data,'$.text',?) WHERE json_extract(data,'$.type')='text'").run(`Retention update ${n}`); db.close()
      expect(await f.cycle(f.host, bounded)).toMatchObject({ observations: 1, sourceFailures: [] })
      const current = await f.inspect()
      expect(current.events).toHaveLength(6)
      expect(current.capture?.id).not.toBe(previous?.capture?.id)
      expect(current.capture?.recordsRetired).toBe(false)
      expect(current.pending).toEqual([])
      previous = current
    }
    expect(await f.cycle(f.host, bounded)).toMatchObject({ observations: 0, sourceFailures: [] })
  }, 15000)
  it("publishes a native family, skips unchanged content, and archives a Raw-only edit without replacing Canonical", async () => {
    const f = await setup()
    const first = await f.cycle()
    expect(first).toMatchObject({ observations: 1, canonicalEvents: 6, sourceFailures: [] })
    expect(first.rawChunks).toBeGreaterThan(0); expect(first.redactions).toBeGreaterThan(0)
    const before = await f.inspect(), sent = f.remote.sent.length, rawSent = f.remote.rawSent.length
    expect(before.checkpoint).toBe(before.capture!.id === f.remote.snapshot().captureId ? f.remote.snapshot().id : "unexpected")
    expect(await f.cycle()).toMatchObject({ observations: 0, canonicalBatches: 0, rawChunks: 0, sourceFailures: [] })
    expect(f.remote.sent).toHaveLength(sent); expect(f.remote.rawSent).toHaveLength(rawSent)
    const db = new DatabaseSync(f.native.path)
    db.prepare("UPDATE part SET data=json_set(data,'$.rawOnlyChange',1) WHERE id=(SELECT id FROM part ORDER BY id LIMIT 1)").run(); db.close()
    expect(await f.cycle()).toMatchObject({ observations: 1, canonicalBatches: 0, sourceFailures: [] })
    const after = await f.inspect()
    expect(after.coverage.canonicalCaptureId).toBe(before.coverage.canonicalCaptureId)
    expect(after.coverage.observedRawCaptureId).not.toBe(before.coverage.observedRawCaptureId)
    expect(after.events).toEqual(before.events)
    expect(await f.cycle()).toMatchObject({ observations: 0, rawChunks: 0 })
  })
  it("retains the previous published head at metadata capacity and resumes after explicit admission increases", async () => {
    const f = await setup()
    await f.cycle()
    const before = await f.inspect(), sent = f.remote.sent.length
    const db = new DatabaseSync(f.native.path)
    db.prepare("UPDATE part SET data=json_set(data,'$.text','Metadata capacity changed source') WHERE json_extract(data,'$.type')='text'").run(); db.close()
    await expect(f.cycle(f.host, { ...limits, journal: { ...limits.journal, metadataEntries: 1 } })).rejects.toMatchObject({
      _tag: "CollectorStateError", message: expect.stringContaining("metadata admission exhausted")
    })
    expect((await f.inspect()).coverage).toEqual(before.coverage)
    expect(f.remote.sent).toHaveLength(sent)
    expect((await f.inspect()).pending).toEqual([])
    const resumed = await f.cycle()
    expect(resumed.observations).toBe(1); expect(resumed.canonicalBatches).toBeGreaterThan(0)
    expect((await f.inspect()).coverage.canonicalCaptureId).not.toBe(before.coverage.canonicalCaptureId)
  })
  it("recovers lost activation and frozen Raw with exhausted metadata admission after source deletion", async () => {
    const f = await setup(); f.remote.loseActivation()
    expect(await f.cycle()).toMatchObject({ observations: 1, sourceFailures: [{ source: f.native.metadata.origin.sourceId, reason: "io" }] })
    expect((await f.inspect()).coverage.canonicalCaptureId).toBeNull()
    expect((await f.progress()).checkpoint?.canonicalPublished).not.toBe(true)
    const opens = f.opens(); await rm(f.native.path); f.missing()
    await expect(f.cycle(f.host, { ...limits, journal: { ...limits.journal, metadataEntries: 1 } })).rejects.toMatchObject({ reason: "collect" })
    const recovered = await f.inspect()
    expect(recovered.coverage.canonicalCaptureId).not.toBeNull()
    expect((await f.progress()).checkpoint?.canonicalPublished).toBe(true)
    expect(f.remote.rawSent.length).toBeGreaterThan(0)
    expect(f.opens()).toBe(opens)
  })
  it("recovers Raw despite source deletion and keeps Raw policy changes separate from Canonical", async () => {
    const f = await setup(); f.remote.policy(false)
    expect(await f.cycle()).toMatchObject({ observations: 1, rawChunks: 0 })
    const canonical = await f.inspect(); f.remote.policy(true, 2)
    expect(await f.cycle()).toMatchObject({ observations: 1, canonicalBatches: 0 })
    expect((await f.inspect()).coverage.canonicalCaptureId).toBe(canonical.coverage.canonicalCaptureId)
    const db = new DatabaseSync(f.native.path)
    db.prepare("UPDATE part SET data=json_set(data,'$.text','new canonical') WHERE json_extract(data,'$.type')='text'").run(); db.close()
    f.remote.rawFault("lose-after")
    expect(await f.cycle()).toMatchObject({ observations: 1, canonicalEvents: 6 })
    const opens = f.opens(); await rm(f.native.path); f.missing()
    await expect(f.cycle()).rejects.toMatchObject({ reason: "collect" })
    expect(f.opens()).toBe(opens)
    expect((await f.inspect()).pending.every(capture => capture.state === "completed" && capture.retainedBytes === 0)).toBe(true)
  })
  it("reclaims confirmed Canonical while Raw keeps failing, and reaches an interval boundary with offset cursors", async () => {
    const f = await setup(); f.remote.receiptError("network")
    await f.cycle()
    const first = await f.inspect()
    expect(first.canonicalUnits.every(unit => !unit.retained)).toBe(true)
    expect(first.rawUnits.some(unit => unit.retained && unit.disposition === "pending")).toBe(true)
    const db = new DatabaseSync(f.native.path)
    db.prepare("UPDATE part SET data=json_set(data,'$.text','new canonical') WHERE json_extract(data,'$.type')='text'").run(); db.close()
    await f.cycle()
    expect((await f.inspect()).coverage.canonicalCaptureId).not.toBe(first.coverage.canonicalCaptureId)
    const root = { ...f.native.metadata.origin, cwd: f.project.path }
    const paged = { ...f.host, sourceCapture: { ...f.host.sourceCapture, discover: ({ cursor }: { cursor: string | null }) => Effect.succeed({
      sources: cursor === null ? [root] : [], cursor: cursor === null ? "last-page" : null, done: cursor !== null,
      sourceFailures: [], sourceFailuresTruncated: false }) } }
    const runnable = []
    for (let n = 0; n < 6; n++) runnable.push((await f.cycle(paged, { ...limits, recovery: { ...limits.recovery, sources: 1 } })).hasMore)
    expect(runnable).toEqual([true, false, true, false, true, false])
  })
  it("rotates recovery after a missing-source sweep and isolates a stalled Canonical request", async () => {
    const f = await setup(); f.remote.loseActivation(); await f.cycle()
    f.remote.hangStatus(true)
    const discoveries = f.discoveries()
    const bounded = { ...limits, recovery: { ...limits.recovery, sourceMs: 20 }, sourceWorkMs: 100, cycleMs: 500 }
    for (let n = 0; n < 3; n++) expect((await f.cycle(f.host, bounded)).sourceFailures).toHaveLength(1)
    expect(f.discoveries()).toBe(discoveries + 3)
    expect((await f.inspect()).pending[0]!.retainedBytes).toBeGreaterThan(0)
    f.remote.hangStatus(false); f.remote.receiptError("network")
    await rm(f.native.path); f.missing()
    const single = { ...limits, recovery: { ...limits.recovery, sources: 1 } }
    for (let n = 0; n < 2; n++) await expect(f.cycle(f.host, single)).rejects.toMatchObject({ reason: "collect" })
    f.remote.receiptError(undefined)
    for (let n = 0; n < 3; n++) await expect(f.cycle(f.host, single)).rejects.toMatchObject({ reason: "collect" })
    expect((await f.inspect()).pending).toEqual([])
  })
  it("rejects legacy state and advances past an attribution failure instead of starving the next source", async () => {
    const f = await setup()
    const original = await f.run(CollectorStateStore.use(states => states.snapshot(f.project.instanceOrigin, f.project.userId, f.project.id, f.adapter.adapterId)))
    await f.run(CollectorStateStore.use(states => states.commit({ instanceOrigin: f.project.instanceOrigin, userId: f.project.userId, projectId: f.project.id,
      adapterId: f.adapter.adapterId, expectedRevision: 0, checkpoint: { instanceOrigin: f.project.instanceOrigin, userId: f.project.userId, projectId: f.project.id,
        projectCreatedAt: f.project.createdAt, adapterId: f.adapter.adapterId, adapterVersion: f.adapter.version, revision: 1, cursor: "legacy-cursor", rawObjects: [], updatedAt: timestamp } })))
    await expect(f.cycle()).rejects.toMatchObject({ reason: "decode" }); expect(f.opens()).toBe(0)
    const g = await setup(), root = { ...g.native.metadata.origin, cwd: g.project.path }
    const report = await g.cycle({ ...g.host, attribute: source => Effect.succeed(source.sourceId === "unknown" ? "unknown" : "included"),
      sourceCapture: { ...g.host.sourceCapture, discover: () => Effect.succeed({ sources: [{ ...root, sourceId: "unknown" }, root], cursor: null, done: true,
        sourceFailures: [], sourceFailuresTruncated: false }) } })
    expect(report).toMatchObject({ observations: 1, sourceFailures: [{ source: "unknown", reason: "attribution" }] })
    expect(original.installationId).toBeTruthy()
  })
})
