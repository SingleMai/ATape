import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { CaptureJournals, CollectorStateStore, SourceCaptureCollector, makeSourceCaptureCollectorLayer, makeSecretRedactorLayer,
  PublicationTransport, PublicationError, RawPublicationTransport, type HostedAdapter } from "@atape/application"
import { CanonicalProfileVersion3, CanonicalProfileVersion4, PublicationTargetProfile4, SourceCaptureVersion2,
  ToolIdentityMetaKey, type AdapterInstallation, type LocalProject } from "@atape/domain"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeCaptureJournalsLayer } from "./captureBootstrap.ts"
import { makeCollectorStateLayer } from "./collectorState.ts"
import { fixture, directories, timestamp } from "./fixtures/publication-test-support.ts"
import { sourceCollectionLimits as limits } from "./fixtures/source-collection-test-support.ts"
import { sourceCollectorV058 } from "./fixtures/source-collector-v058.ts"

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe("genuine 0.5.8 source-free v4 recovery", () => {
  it("recovers frozen v4 parts and activation through the old SourceCollector without rewriting source metadata", async () => {
    const historical = await sourceCollectorV058()
    try {
      expect(historical.proof.revision).toBe("9b4db957a768b6a7a80ae9f3873a54fe3ea94002")
      expect(historical.proof.runtime.version).toBe("0.5.8")
      expect(historical.proof.dependencyMode).toBe("historical-frozen-lock")
      expect(historical.proof.inputs.find(input => input.path === "packages/application/src/sourceMetadata.ts")).toBeDefined()
      const f = await fixture(16384, {}, { v4: true, adoption: { revisionFloor: 0, baselineThreads: [] } })
      f.policy(false)
      const stateFile = join(dirname(f.path), "collector.json")
      const project: LocalProject = { id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team", teamName: "Team",
        name: "Project", type: "directory", path: "/nonexistent-provider-source", createdAt: timestamp, adapterIds: ["claude"] }
      const adapter: AdapterInstallation = { adapterId: "claude", packageName: "@atape/adapter-claude", version: "0.5.8", displayName: "Claude",
        upgradeSpec: "@atape/adapter-claude", installedAt: timestamp, updatedAt: timestamp }
      const ownerScope = { projectId: "project", adapterId: "claude", sourceSessionId: "root", originKey: "origin" }
      const account = { instanceOrigin: project.instanceOrigin, userId: project.userId }
      const old = historical.Effect, oldLayer = historical.Layer
      const oldPersistence = oldLayer.merge(historical.makeCaptureJournalsLayer(stateFile), historical.makeCollectorStateLayer(stateFile))
      // Initialize the exact old Node persistence before the new producer writes.
      await old.runPromise(old.scoped(historical.CaptureJournals.use(factory => factory.open(account, limits.journal))).pipe(old.provide(oldPersistence)))
      const base = Layer.mergeAll(makeCaptureJournalsLayer(stateFile), makeCollectorStateLayer(stateFile), f.remote, f.rawRemote, makeSecretRedactorLayer())
      const graph = Layer.merge(base, makeSourceCaptureCollectorLayer(limits).pipe(Layer.provide(base)))
      const run = <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.runPromise(program.pipe(Effect.provide(graph)) as Effect.Effect<A, E>)
      const source: Extract<HostedAdapter, { sourceCapture: unknown }> = { attribute: () => Effect.succeed("included"), sourceCapture: {
        protocolVersion: SourceCaptureVersion2,
        discover: () => Effect.succeed({ sources: [{ sourceId: "root", originKey: "origin", cwd: project.path }], cursor: null, done: true,
          sourceFailures: [], sourceFailuresTruncated: false }),
        open: () => Effect.succeed({ profile: "fixture.tool-identity.v1", canonicalProfileVersion: CanonicalProfileVersion4, sourceCheckpoint: "native-proof",
          origin: { sourceId: "root", originKey: "origin" },
          session: { sourceSessionId: "root", title: "Root", summary: "", insight: "", actor: { name: "User", harness: "Fixture" }, branch: "", status: "idle",
            captureStatus: "complete", updatedAt: null, reportedEventCount: 1 },
          threads: [{ sourceThreadId: "root", label: "Root", summary: "", captureStatus: "complete" }],
          target: { threads: 1, events: 1, usage: 0, retainedThreadIds: [] }, sourceFailures: [], sourceFailuresTruncated: false,
          read: () => Effect.succeed({ frames: [{ recordKey: "row", usage: [], events: [{ sourceEventId: "call", sourceThreadId: "root", sourceOrder: 0,
            eventIndex: 0, orderFidelity: "native", fidelity: "native", occurredAt: null, update: { sessionUpdate: "tool_call", toolCallId: "call", title: "Skill",
              status: "completed", _meta: { [ToolIdentityMetaKey]: { type: "skill", name: "review" } } } }] }], done: true }) })
      } }
      f.losePut()
      const first = await run(Effect.gen(function*() {
        const states = yield* CollectorStateStore, collector = yield* SourceCaptureCollector
        return yield* collector.collect(project, { ...adapter, version: "0.5.9" }, source,
          yield* states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId))
      }))
      expect(first.sourceFailures).toEqual([{ source: "root", reason: "io" }])
      const frozen = await run(Effect.scoped(Effect.gen(function*() {
        const factory = yield* CaptureJournals, journal = yield* factory.open(account, limits.journal)
        const owner = yield* journal.claim(ownerScope), capture = yield* journal.unactivated(owner)
        expect(capture).not.toBeNull()
        return { capture: capture!, metadata: yield* journal.sourceMetadata(owner, capture!.id), bytes: yield* journal.read(owner, capture!.id, "canonical", 0) }
      })))
      expect(JSON.parse(frozen.metadata!)).toMatchObject({ canonicalProfileVersion: CanonicalProfileVersion3, canonicalProfileV4: CanonicalProfileVersion4 })
      const part = JSON.parse(new TextDecoder().decode(frozen.bytes))
      expect(part.target.profile).toBe(PublicationTargetProfile4)
      expect(part.batch.canonicalProfileVersion).toBe(CanonicalProfileVersion4)
      expect(JSON.parse(part.batch.events[0].toolUpdateJson)._meta).toEqual({ [ToolIdentityMetaKey]: { type: "skill", name: "review" } })
      const remote = await run(PublicationTransport), rawRemote = await run(RawPublicationTransport)
      // This Test Adapter bridges only the owned remote transport, not storage or
      // orchestration. Every historical operation uses its isolated Effect runtime.
      const bridge = <A>(work: () => Effect.Effect<A, PublicationError>) => old.tryPromise({ try: () => Effect.runPromise(work()),
        catch: cause => new historical.PublicationError({ reason: (cause as PublicationError).reason, message: "Controlled publication failure." }) })
      const publication = historical.PublicationTransport.of({
        capabilities: binding => bridge(() => remote.capabilities(binding)).pipe(old.map(value => ({ ...value,
          ...(value.targetProfiles === undefined ? {} : { targetProfiles: value.targetProfiles.filter(profile => profile !== PublicationTargetProfile4) }) }))),
        reserve: (binding, scope) => bridge(() => remote.reserve(binding, scope)), adoptLegacy: (binding, scope) => bridge(() => remote.adoptLegacy(binding, scope)),
        begin: (binding, input) => bridge(() => remote.begin(binding, input)), status: (binding, id) => bridge(() => remote.status(binding, id)),
        put: (binding, id, part, bytes) => bridge(() => remote.put(binding, id, part, bytes)), seal: (binding, id, manifest) => bridge(() => remote.seal(binding, id, manifest)),
        validate: (binding, id) => bridge(() => remote.validate(binding, id)), renew: (binding, id) => bridge(() => remote.renew(binding, id)),
        reject: (binding, id) => bridge(() => remote.reject(binding, id)), activate: (binding, id) => bridge(() => remote.activate(binding, id))
      })
      const oldBase = oldLayer.mergeAll(oldPersistence, oldLayer.succeed(historical.PublicationTransport, publication),
        oldLayer.succeed(historical.RawPublicationTransport, historical.RawPublicationTransport.of({
          policy: (binding, projectId) => old.tryPromise({ try: () => Effect.runPromise(rawRemote.policy(binding, projectId)), catch: () => new historical.RawPublicationError({ reason: "unavailable", message: "Unused Raw policy." }) }),
          append: () => old.die("Raw is disabled."), receipt: () => old.die("Raw is disabled.")
        })), historical.makeSecretRedactorLayer())
      const oldGraph = oldLayer.merge(oldBase, historical.makeSourceCaptureCollectorLayer(limits).pipe(oldLayer.provide(oldBase)))
      let sourceOpens = 0
      const missing: Extract<HostedAdapter, { sourceCapture: unknown }> = { attribute: () => old.succeed("included"), sourceCapture: {
        protocolVersion: SourceCaptureVersion2, discover: () => old.succeed({ sources: [], cursor: null, done: true, sourceFailures: [], sourceFailuresTruncated: false }),
        open: () => { sourceOpens++; return old.die("Recovery must not open the missing Provider source.") }
      } }
      const cycle = () => old.runPromise(old.gen(function*() {
        const states = yield* historical.CollectorStateStore, collector = yield* historical.SourceCaptureCollector
        return yield* collector.collect(project, adapter, missing, yield* states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId))
      }).pipe(old.provide(oldGraph)))
      f.loseActivation()
      await cycle()
      const recovered = await cycle()
      expect(recovered.sourceFailures).toEqual([])
      expect(sourceOpens).toBe(0)
      expect(f.sent).toHaveLength(2); expect(f.sent[0]).toEqual(frozen.bytes); expect(f.sent[1]).toEqual(frozen.bytes)
      await run(Effect.scoped(Effect.gen(function*() {
        const factory = yield* CaptureJournals, journal = yield* factory.open(account, limits.journal)
        const owner = yield* journal.claim(ownerScope), coverage = yield* journal.coverage(owner)
        expect(coverage.canonicalCaptureId).toBe(frozen.capture.id)
        expect(yield* journal.sourceMetadata(owner, frozen.capture.id)).toBe(frozen.metadata)
        expect((yield* journal.inspect(owner, frozen.capture.id, { kind: "canonical" })).capture.state).toBe("completed")
        expect(yield* journal.pending(owner)).toEqual([])
      })))
      const progress = await run(CollectorStateStore.use(states => states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId)))
      expect(progress.checkpoint?.canonicalPublished).toBe(true)
      expect(progress.checkpoint?.rawObjects).toEqual([])
      console.info(JSON.stringify({ test: "genuine-0.5.8-source-free-v4-recovery", revision: historical.proof.revision,
        lockSha256: historical.proof.lockSha256, dependencyMode: historical.proof.dependencyMode,
        runtime: historical.proof.runtime, toolchain: historical.proof.toolchain, bundle: historical.proof.bundle,
        sources: historical.proof.inputs.filter(input => ["packages/application/src/sourceMetadata.ts", "packages/application/src/sourceCollector.ts",
          "packages/application/src/publicationDelivery.ts", "apps/cli/src/runtime/captureJournal.ts"].includes(input.path)),
        sourceOpens, frozenBytesPreserved: true, metadataBytesPreserved: true, pendingCleared: true }))
    } finally { await historical.cleanup() }
  }, 180_000)
})
