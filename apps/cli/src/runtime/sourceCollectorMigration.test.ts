import { CaptureJournals, CollectorStateStore, SourceCaptureCollector, makeSourceCaptureCollectorLayer, makeSecretRedactorLayer,
  AdapterRuntimeError, type HostedAdapter } from "@atape/application"
import { SourceCaptureVersion2, PublicationTargetProfile2, type AdapterInstallation, type LocalProject, type CollectorCheckpoint } from "@atape/domain"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { dirname } from "node:path"
import { createHash } from "node:crypto"
import { rm } from "node:fs/promises"
import { makeCaptureJournalsLayer } from "./captureBootstrap.ts"
import { makeCollectorStateLayer } from "./collectorLayers.ts"
import { fixture, nativePreparationSource, directories, timestamp } from "./fixtures/publication-test-support.ts"
import { sourceCollectionLimits as limits } from "./fixtures/source-collection-test-support.ts"

// Generated v2 test Adapter over the controlled OpenCode-format source. These
// tests exercise the public Host workflow, not native Claude rewind evidence.
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const setup = async (options: { readonly largeBaseline?: boolean; readonly rootOnly?: boolean } = {}) => {
  const native = await nativePreparationSource()
  const projected = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const view = yield* native.source(false), events = [], usage = []
    for (;;) { const page = yield* view.read(); for (const frame of page.frames) { events.push(...frame.events); usage.push(...frame.usage) }; if (page.done) break }
    return { events, usage }
  })))
  const floor = 900
  const remote = await fixture(16384, {}, { v2: true, adoption: {
    revisionFloor: floor, baselineThreads: options.largeBaseline ? [
      { ...native.metadata.threads.find(thread => thread.parentSourceThreadId === undefined)!, revision: floor },
      ...Array.from({ length: 20 }, (_, index) => ({ sourceThreadId: `old-child-${index}`, parentSourceThreadId: native.metadata.session.sourceSessionId,
        revision: floor, label: "Prior child", summary: "prior metadata ".repeat(200), captureStatus: "complete" as const }))
    ] : native.metadata.threads.map(thread => ({ ...thread, revision: floor }))
  } })
  const stateFile = `${remote.path}.collector.json`
  const project: LocalProject = { id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team", teamName: "Team", name: "Project",
    type: "directory", path: dirname(native.path), createdAt: timestamp, adapterIds: ["opencode"] }
  const adapter: AdapterInstallation = { adapterId: "opencode", packageName: "@atape/adapter-opencode", version: "0.0.0", displayName: "Controlled v2",
    upgradeSpec: "@atape/adapter-opencode", installedAt: timestamp, updatedAt: timestamp }
  const base = Layer.mergeAll(makeCaptureJournalsLayer(stateFile), makeCollectorStateLayer(stateFile), remote.remote, remote.rawRemote,
    makeSecretRedactorLayer(["SENSITIVE_TEST_TOKEN"]))
  const layer = Layer.merge(base, makeSourceCaptureCollectorLayer(limits).pipe(Layer.provide(base)))
  const run = <A, E>(work: Effect.Effect<A, E, SourceCaptureCollector | CollectorStateStore | CaptureJournals>) => Effect.runPromise(work.pipe(Effect.provide(layer)))
  const calls: Array<{ operation: string; legacy?: string; prior?: string; threads?: number }> = []
  let missing = false, invalid = false, checkpoint = "physical-prefix-1", retained: string[] = [], diagnostics = false
  let mutateOpen: { at: number; checkpoint: string } | undefined
  const source = { ...native.metadata.origin, cwd: project.path }
  const host: Extract<HostedAdapter, { sourceCapture: unknown }> = {
    attribute: () => Effect.succeed("included"),
    sourceCapture: {
      protocolVersion: SourceCaptureVersion2,
      legacyMigration: request => Effect.sync(() => {
        calls.push({ operation: "decode", legacy: request.checkpointCursor })
        if (!["generated-original-opaque", "generated-original-opaque-v2"].includes(request.checkpointCursor)) throw new Error("unexpected legacy cursor")
        return { sources: [source], cursor: null, done: true, sourceFailures: [], sourceFailuresTruncated: false }
      }),
      discover: () => Effect.sync(() => {
        calls.push({ operation: "discover" })
        return { sources: missing ? [] : [source], cursor: null, done: true, sourceFailures: [], sourceFailuresTruncated: false }
      }),
      open: request => Effect.suspend(() => {
        calls.push({ operation: "open", ...(request.legacyCheckpoint === undefined ? {} : { legacy: request.legacyCheckpoint }),
          ...(request.priorCheckpoint === undefined ? {} : { prior: request.priorCheckpoint }), threads: request.priorThreads?.length ?? 0 })
        if (mutateOpen?.at === calls.filter(call => call.operation === "open").length) checkpoint = mutateOpen.checkpoint
        if (missing || invalid) return Effect.fail(new AdapterRuntimeError({ adapterId: "opencode", reason: "contract", retryable: false,
          sourceFailureReason: invalid ? "format" : "io", message: "Controlled source authentication failure." }))
        return native.source(request.rawEnabled).pipe(Effect.map(view => {
          const excluded = new Set([...retained, ...(options.rootOnly ? view.threads.filter(thread => thread.parentSourceThreadId !== undefined).map(thread => thread.sourceThreadId) : [])])
          const included = projected.events.filter(event => !excluded.has(event.sourceThreadId)).length
          const threads = options.rootOnly ? view.threads.filter(thread => thread.parentSourceThreadId === undefined) : view.threads
          let eventIndex = 0
          return { ...view, threads, sourceCheckpoint: checkpoint, session: { ...view.session, reportedEventCount: included },
            target: { ...view.target, threads: threads.length, events: included, usage: projected.usage.filter(sample => !excluded.has(sample.sourceThreadId)).length, retainedThreadIds: retained },
            sourceFailures: diagnostics ? [{ source: "controlled-child", reason: "unsupported" as const }] : [], sourceFailuresTruncated: false,
            read: () => view.read().pipe(Effect.map(page => ({ ...page, frames: page.frames.map(frame => ({ ...frame,
              events: frame.events.filter(event => !excluded.has(event.sourceThreadId)).map(event => {
                const { childSourceThreadId: child, ...rest } = event
                return { ...rest, ...(!options.rootOnly && child !== undefined ? { childSourceThreadId: child } : {}), eventIndex: eventIndex++ }
              }), usage: frame.usage.filter(sample => !excluded.has(sample.sourceThreadId)) })) })), Effect.mapError(() => new AdapterRuntimeError({
                adapterId: "opencode", reason: "collect", retryable: true, message: "Controlled source read failed." }))) }
        }), Effect.mapError(() => new AdapterRuntimeError({ adapterId: "opencode", reason: "collect", retryable: true, message: "Controlled source failed." })))
      })
    }
  }
  const progress = () => run(CollectorStateStore.use(states => states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId)))
  const legacy = async (rawObjects: CollectorCheckpoint["rawObjects"] = []) => {
    const snapshot = await progress()
    const old: CollectorCheckpoint = { instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id,
      projectCreatedAt: project.createdAt, adapterId: adapter.adapterId, adapterVersion: "old", revision: 1, cursor: "generated-original-opaque", rawObjects,
      canonicalPublished: true, updatedAt: timestamp }
    await run(CollectorStateStore.use(states => states.commit({ instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id,
      adapterId: adapter.adapterId, expectedRevision: snapshot.checkpoint?.revision ?? 0, checkpoint: old })))
    return { old, installationId: snapshot.installationId }
  }
  const cycle = (selected = host) => run(Effect.gen(function*() {
    const snapshot = yield* CollectorStateStore.use(states => states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId))
    return yield* SourceCaptureCollector.use(collector => collector.collect(project, adapter, selected, snapshot))
  }))
  const inspect = () => run(Effect.scoped(Effect.gen(function*() {
    const journal = yield* (yield* CaptureJournals).open({ instanceOrigin: project.instanceOrigin, userId: project.userId }, limits.journal)
    const owner = yield* journal.claim(native.ownerScope), coverage = yield* journal.coverage(owner)
    const id = coverage.canonicalCaptureId
    const state = yield* CollectorStateStore.use(states => states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId))
    const marker = state.checkpoint?.cursor?.startsWith("{") ? JSON.parse(state.checkpoint.cursor).legacyMigration as { checkpointDigest: string } | undefined : undefined
    return { coverage, floor: yield* journal.recordFloor(owner), migration: marker === undefined ? null : yield* journal.legacyMigration(project.id, adapter.adapterId, marker.checkpointDigest),
      metadata: yield* journal.sourceMetadata(owner, id), pending: yield* journal.pending(owner),
      events: id === null ? [] : yield* journal.records(owner, id, { kind: "event" }) }
  })))
  return { native, remote, host, calls, cycle, legacy, progress, inspect, run, project, adapter,
    mutateNextRawOpen: (next: string) => { mutateOpen = { at: calls.filter(call => call.operation === "open").length + 2, checkpoint: next } },
    missing: () => { missing = true }, invalid: () => { invalid = true }, checkpoint: (next: string) => { checkpoint = next },
    diagnostics: (enabled = true) => { diagnostics = enabled }, retained: (ids: string[]) => { retained = ids } }
}

describe("explicit legacy source migration through the Host Interface", () => {
  it("authenticates before adoption, freezes all acknowledged metadata and seeds versions above the Server floor", async () => {
    const f = await setup(); f.remote.policy(false)
    const raw = [{ sourceSessionId: f.native.metadata.origin.sourceId, sourceObjectId: "legacy-owned-object", sourceName: "old.jsonl", mediaType: "application/jsonl",
      sourceGeneration: "old-generation", sourceOffset: 123, serverGeneration: 7, serverOffset: 123, finalized: true }]
    const old = await f.legacy(raw)
    expect(await f.cycle()).toMatchObject({ observations: 1, canonicalEvents: 6, sourceFailures: [] })
    expect(f.remote.adoptions()).toBe(1); expect(f.remote.reservations()).toBe(0)
    const opens = f.calls.filter(call => call.operation === "open")
    expect(opens[0]).toMatchObject({ legacy: "generated-original-opaque", threads: 0 })
    expect(opens[1]).toMatchObject({ legacy: "generated-original-opaque", threads: f.native.metadata.threads.length })
    const actual = await f.inspect()
    expect(JSON.parse(actual.migration!.checkpointJson)).toEqual({ installationId: old.installationId, projectCreatedAt: timestamp, checkpoint: old.old })
    expect(actual.floor).toBe(900)
    expect(actual.events.every(event => event.revision > 900)).toBe(true)
    const wire = f.remote.sent.map(bytes => JSON.parse(new TextDecoder().decode(bytes)))
    expect(wire.every(part => part.target.profile === PublicationTargetProfile2 && part.target.retainedThreadIds.length === 0)).toBe(true)
    expect(wire.every(part => part.batch.session.revision > 900 && part.batch.threads.every((thread: { revision: number }) => thread.revision > 900))).toBe(true)
    expect(JSON.stringify(wire)).not.toContain("SENSITIVE_TEST_TOKEN")
    expect((await f.progress()).checkpoint).toMatchObject({ rawObjects: [], canonicalPublished: true })
    const sent = f.remote.sent.length
    expect(await f.cycle()).toMatchObject({ observations: 0, sourceFailures: [] })
    expect(f.remote.adoptions()).toBe(1); expect(f.remote.sent).toHaveLength(sent)
    expect(f.calls.filter(call => call.operation === "open").at(-1)).toMatchObject({ prior: "physical-prefix-1" })
  })
  it("keeps legacy visibility and the frozen migration recoverable when source validation fails before adoption", async () => {
    const f = await setup(); await f.legacy(); f.invalid()
    expect(await f.cycle()).toMatchObject({ observations: 0, sourceFailures: [{ source: f.native.metadata.origin.sourceId, reason: "format" }] })
    expect(f.remote.adoptions()).toBe(0); expect(f.remote.reservations()).toBe(0); expect(f.remote.sent).toEqual([])
    const state = await f.inspect()
    expect(state.coverage.canonicalCaptureId).toBeNull(); expect(state.migration).not.toBeNull()
    expect(JSON.parse((await f.progress()).checkpoint!.cursor!)).toHaveProperty("legacyMigration.checkpointDigest", state.migration!.checkpointDigest)
  })
  it("rejects migration without explicit opt-in while preserving the old opaque checkpoint", async () => {
    const f = await setup(); const old = await f.legacy()
    const { legacyMigration: _migration, ...sourceCapture } = f.host.sourceCapture
    await expect(f.cycle({ ...f.host, sourceCapture })).rejects.toMatchObject({ _tag: "CollectorStateError" })
    expect((await f.progress()).checkpoint).toEqual(old.old)
    expect(f.remote.adoptions()).toBe(0); expect(f.calls).toEqual([])
  })
  it("recovers frozen adoption and Raw receipts without reopening a deleted source", async () => {
    const f = await setup(); await f.legacy(); f.remote.loseActivation(); f.diagnostics()
    expect(await f.cycle()).toMatchObject({ observations: 1, sourceFailures: expect.arrayContaining([{ source: "controlled-child", reason: "unsupported" },
      { source: f.native.metadata.origin.sourceId, reason: "io" }]) })
    expect((await f.inspect()).coverage.canonicalCaptureId).toBeNull()
    const opens = f.calls.filter(call => call.operation === "open").length
    f.missing(); await rm(f.native.path)
    const recovered = await f.cycle()
    expect(recovered.canonicalBatches).toBeGreaterThan(0); expect(recovered.rawChunks).toBeGreaterThan(0)
    expect(recovered.sourceFailures).toContainEqual({ source: "controlled-child", reason: "unsupported" })
    expect(f.calls.filter(call => call.operation === "open")).toHaveLength(opens)
    expect((await f.inspect()).coverage.canonicalCaptureId).not.toBeNull()
    expect(f.remote.adoptions()).toBe(1)
  })
  it("activates newer physical-prefix proof with unchanged Canonical versions and preserves diagnostics on idle", async () => {
    const f = await setup(); f.remote.policy(false); f.diagnostics()
    await f.cycle()
    const first = await f.inspect()
    f.checkpoint("physical-prefix-2")
    expect(await f.cycle()).toMatchObject({ observations: 1, sourceFailures: [{ source: "controlled-child", reason: "unsupported" }] })
    const second = await f.inspect()
    expect(second.coverage.canonicalCaptureId).not.toBe(first.coverage.canonicalCaptureId)
    expect(second.events.map(event => event.revision)).toEqual(first.events.map(event => event.revision))
    expect(JSON.parse(second.metadata!).sourceCheckpoint).toBe("physical-prefix-2")
    expect(await f.cycle()).toMatchObject({ observations: 0, sourceFailures: [{ source: "controlled-child", reason: "unsupported" }] })
    f.diagnostics(false)
    expect(await f.cycle()).toMatchObject({ observations: 1, sourceFailures: [] })
    expect(JSON.parse((await f.inspect()).metadata!).sourceFailures).toEqual([])
  })
  it("publishes complete retained Thread headers with honest explicit counts and treats selector changes as a new target", async () => {
    const f = await setup(); await f.legacy(); f.remote.policy(false)
    const child = f.native.metadata.threads.find(thread => thread.parentSourceThreadId !== undefined)!.sourceThreadId
    f.retained([child])
    expect(await f.cycle()).toMatchObject({ observations: 1, sourceFailures: [] })
    const parts = f.remote.sent.map(bytes => JSON.parse(new TextDecoder().decode(bytes)))
    expect(parts.every(part => part.target.retainedThreadIds[0] === child)).toBe(true)
    expect(parts[0].target.threads).toBe(f.native.metadata.threads.length)
    expect(parts[0].target.events).toBeLessThan(f.native.metadata.target.events)
    expect(parts.every(part => part.batch.session.reportedEventCount === part.target.events &&
      part.batch.events.every((event: { sourceThreadId: string }) => event.sourceThreadId !== child))).toBe(true)
    const first = await f.inspect()
    expect(JSON.parse(first.metadata!).retainedThreadIds).toEqual([child])
    f.retained([])
    expect(await f.cycle()).toMatchObject({ observations: 1, canonicalEvents: 6, sourceFailures: [] })
    expect((await f.inspect()).coverage.canonicalCaptureId).not.toBe(first.coverage.canonicalCaptureId)
  })
  it("does not publish an unknown/root retained Thread or record it as covered", async () => {
    const f = await setup(); f.remote.policy(false)
    f.retained([f.native.metadata.session.sourceSessionId])
    expect(await f.cycle()).toMatchObject({ observations: 0, sourceFailures: [{ source: f.native.metadata.origin.sourceId, reason: "format" }] })
    expect((await f.inspect()).coverage.canonicalCaptureId).toBeNull()
    expect(f.remote.sent).toEqual([])
  })
  it("selects a new immutable legacy freeze after a stale-snapshot CAS failure without adopting the old snapshot", async () => {
    const f = await setup(); f.remote.policy(false)
    const old = await f.legacy(), stale = await f.progress()
    const newer = { ...old.old, revision: 2, cursor: "generated-original-opaque-v2", updatedAt: "2026-09-10T00:01:00Z" }
    await f.run(CollectorStateStore.use(states => states.commit({ instanceOrigin: f.project.instanceOrigin, userId: f.project.userId,
      projectId: f.project.id, adapterId: f.adapter.adapterId, expectedRevision: 1, checkpoint: newer })))
    await expect(f.run(SourceCaptureCollector.use(collector => collector.collect(f.project, f.adapter, f.host, stale)))).rejects.toMatchObject({ reason: "conflict" })
    expect(f.remote.adoptions()).toBe(0); expect(f.calls).toEqual([])
    expect((await f.progress()).checkpoint).toEqual(newer)
    const previousJson = JSON.stringify({ installationId: old.installationId, projectCreatedAt: timestamp, checkpoint: old.old })
    const previousDigest = createHash("sha256").update(previousJson).digest("hex")
    expect(await f.cycle()).toMatchObject({ observations: 1, sourceFailures: [] })
    const current = await f.inspect()
    expect(current.migration!.checkpointDigest).not.toBe(previousDigest)
    expect(JSON.parse(current.migration!.checkpointJson).checkpoint).toEqual(newer)
    await f.run(Effect.scoped(Effect.gen(function*() {
      const journal = yield* (yield* CaptureJournals).open({ instanceOrigin: f.project.instanceOrigin, userId: f.project.userId }, limits.journal)
      expect((yield* journal.legacyMigration(f.project.id, f.adapter.adapterId, previousDigest))?.checkpointJson).toBe(previousJson)
    })))
    expect(f.remote.adoptions()).toBe(1)
  })
  it("accepts a baseline larger than the Begin metadata budget and more prior Threads than the selected root-only target", async () => {
    const f = await setup({ largeBaseline: true, rootOnly: true }); f.remote.policy(false); await f.legacy()
    expect(await f.cycle()).toMatchObject({ observations: 1, sourceFailures: [] })
    expect(f.remote.adoptions()).toBe(1)
    expect(f.calls.filter(call => call.operation === "open").at(-1)?.threads).toBe(21)
    const parts = f.remote.sent.map(bytes => JSON.parse(new TextDecoder().decode(bytes)))
    expect(parts.every(part => part.target.threads === 1 && part.batch.threads.length === 1)).toBe(true)
    expect(JSON.parse((await f.inspect()).metadata!).threads).toHaveLength(1)
  })
  it("rejects a new physical prefix between comparison and Raw preparation, then publishes it before Raw ACK", async () => {
    const f = await setup(); f.remote.policy(false); await f.cycle()
    const before = await f.inspect(), sent = f.remote.sent.length
    f.remote.policy(true, 2); f.mutateNextRawOpen("physical-prefix-2")
    expect(await f.cycle()).toMatchObject({ observations: 0, rawChunks: 0, sourceFailures: [{ source: f.native.metadata.origin.sourceId, reason: "io" }] })
    expect((await f.inspect()).coverage.canonicalCaptureId).toBe(before.coverage.canonicalCaptureId)
    expect(f.remote.rawSent).toEqual([]); expect(f.remote.sent).toHaveLength(sent)
    const next = await f.cycle()
    expect(next.observations).toBe(1); expect(next.canonicalBatches).toBeGreaterThan(0); expect(next.rawChunks).toBeGreaterThan(0)
    expect(JSON.parse((await f.inspect()).metadata!).sourceCheckpoint).toBe("physical-prefix-2")
  })

})
