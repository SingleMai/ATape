import {
  AdapterCollectionLimits,
  AdapterProtocolVersion,
  RawTransportChunkBytes,
  emptyClientConfig,
  type AdapterCollectionPage,
  type ClientConfig,
  type CollectorCheckpoint
} from "@atape/domain"
import { CollectorDeviceGateway } from "./collectorMonitoring.ts"
import { SourceCaptureCollector } from "./sourceCollector.ts"
import { CollectorRunStatusStore, runManagedCollector } from "./collectorDaemon.ts"
import { TestClock } from "effect/testing"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ClientConfigStore } from "./clientManagement.ts"
import {
  AdapterRuntimes,
  CollectionTransportError,
  CollectorStateStore,
  CollectorTransport,
  SecretRedactor,
  makeSecretRedactorLayer,
  runCollector,
  runCollectionCycle,
  type CanonicalSubmission,
  type RawSubmission
} from "./collector.ts"

const now = "2026-09-05T00:20:00+08:00"

const collectionPage = (): AdapterCollectionPage => ({
  protocolVersion: AdapterProtocolVersion,
  nextCursor: "cursor-1",
  hasMore: false,
  observations: [{
    observationId: "checkout-r1",
    observedAt: now,
    session: {
      sourceSessionId: "checkout",
      revision: 1,
      title: "Debug api_key=supersecret",
      summary: "Inspect checkout",
      insight: "Use one idempotency key",
      actor: { name: "Liying", harness: "Fixture CLI" },
      branch: "main",
      status: "active",
      captureStatus: "healthy",
      updatedAt: now,
      reportedEventCount: 2
    },
    threads: [
      {
        sourceThreadId: "root",
        revision: 1,
        label: "Root",
        summary: "",
        captureStatus: "healthy"
      },
      {
        sourceThreadId: "child",
        parentSourceThreadId: "root",
        revision: 1,
        label: "Schema review",
        summary: "Subagent result",
        captureStatus: "complete"
      }
    ],
    events: [
      {
        sourceEventId: "e1",
        sourceThreadId: "root",
        revision: 1,
        projectionRevision: 1,
        sourceOrder: 1,
        eventIndex: 0,
        orderFidelity: "native",
        fidelity: "native",
        rawRef: { _tag: "object", sourceObjectId: "transcript", fragment: "#line:1" },
        occurredAt: now,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "spawn-reviewer",
          title: "Spawn a schema reviewer",
          kind: "think",
          status: "completed"
        },
        childSourceThreadId: "child"
      },
      {
        sourceEventId: "e2",
        sourceThreadId: "child",
        revision: 1,
        projectionRevision: 1,
        sourceOrder: 2,
        eventIndex: 0,
        orderFidelity: "native",
        fidelity: "native",
        rawRef: { _tag: "object", sourceObjectId: "transcript", fragment: "#line:2" },
        occurredAt: now,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The token is supersecret" },
          messageId: "review-result"
        }
      }
    ],
    rawSegments: [{
      sourceObjectId: "transcript",
      sourceGeneration: "inode-1",
      sourceOffset: 0,
      sourceName: "session.jsonl",
      mediaType: "application/x-ndjson",
      content: "{\"token\":\"supersecret\"}\n",
      final: false
    }]
  }]
})

const twoSegmentCollectionPage = (): AdapterCollectionPage => {
  const page = collectionPage()
  const first = "{\"part\":1}\n"
  const second = "{\"token\":\"supersecret\"}\n"
  return {
    ...page,
    observations: page.observations.map((observation) => ({
      ...observation,
      rawSegments: [
        {
          sourceObjectId: "transcript",
          sourceGeneration: "inode-1",
          sourceOffset: 0,
          sourceName: "session.jsonl",
          mediaType: "application/x-ndjson",
          content: first,
          final: false
        },
        {
          sourceObjectId: "transcript",
          sourceGeneration: "inode-1",
          sourceOffset: new TextEncoder().encode(first).byteLength,
          sourceName: "session.jsonl",
          mediaType: "application/x-ndjson",
          content: second,
          final: true
        }
      ]
    }))
  }
}

const clientConfig = (): ClientConfig => ({
  ...emptyClientConfig(),
  toolsConfigured: true,
  enabledAdapterIds: ["fixture"],
  activeInstanceOrigin: "https://atape.net",
  projects: [{
    id: "payments",
    instanceOrigin: "https://atape.net",
    userId: "user-1",
    teamId: "acme",
    teamSlug: "acme",
    teamName: "Acme",
    name: "Payments",
    type: "git",
    path: "/work/payments",
    createdAt: now
  }],
  adapters: [{
    adapterId: "fixture",
    packageName: "@atape/adapter-fixture",
    upgradeSpec: "@atape/adapter-fixture",
    displayName: "Fixture CLI",
    version: "1.0.0",
    installedAt: now,
    updatedAt: now
  }]
})

const fixture = (options: {
  readonly rawEnabled?: boolean
  readonly policyFailure?: CollectionTransportError
  readonly config?: () => ClientConfig
  readonly page?: AdapterCollectionPage
  readonly pages?: ReadonlyArray<AdapterCollectionPage>
  readonly rawGate?: (submission: RawSubmission) => Effect.Effect<void>
  readonly rawFailure?: CollectionTransportError
  readonly rawFailureAtServerOffset?: number
  readonly replayedRawAheadBytes?: number
} = {}) => {
  let checkpoint: CollectorCheckpoint | undefined
  let commits = 0
  let pageIndex = 0
  let rawAttempts = 0
  let rawBlocked = options.rawFailureAtServerOffset !== undefined
  const canonical: Array<CanonicalSubmission> = []
  const raw: Array<RawSubmission> = []
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({
      transact: (change) => change(options.config?.() ?? clientConfig()).pipe(Effect.map((result) => result.value))
    })),
    Layer.succeed(CollectorStateStore, CollectorStateStore.of({
      snapshot: () => Effect.succeed({
        installationId: "i_fixture",
        ...(checkpoint === undefined ? {} : { checkpoint })
      }),
      commit: (input) => Effect.sync(() => {
        expect(input.expectedRevision).toBe(checkpoint?.revision ?? 0)
        checkpoint = structuredClone(input.checkpoint)
        commits++
      })
    })),
    Layer.succeed(AdapterRuntimes, AdapterRuntimes.of({
      open: () => Effect.succeed({ collect: () => Effect.succeed(options.pages?.[pageIndex++] ?? options.page ?? collectionPage()) })
    })),
    Layer.succeed(CollectorTransport, CollectorTransport.of({
      rawCaptureEnabled: () => options.policyFailure ? Effect.fail(options.policyFailure) : Effect.succeed(options.rawEnabled ?? true),
      submitCanonical: (submission) => Effect.sync(() => {
        canonical.push(structuredClone(submission))
        return {
          sessionId: "s_checkout",
          sessionCreated: true,
          insertedEvents: 2,
          updatedEvents: 0,
          unchangedEvents: 0,
          staleEvents: 0,
          replayed: false
        }
      }),
      appendRaw: (submission) => (options.rawGate?.(submission) ?? Effect.void).pipe(Effect.andThen(Effect.suspend(() => {
        rawAttempts++
        if (options.rawFailure && options.rawFailureAtServerOffset === undefined || (rawBlocked && options.rawFailureAtServerOffset === submission.serverOffset)) {
          return Effect.fail(options.rawFailure ?? new CollectionTransportError({
            reason: "network",
            operation: "raw",
            retryable: true,
            message: "Raw is temporarily unavailable"
          }))
        }
        raw.push(structuredClone(submission))
        const expectedSize = submission.serverOffset +
          new TextEncoder().encode(submission.content).byteLength
        return Effect.succeed({
          objectId: "r_fixture",
          generation: submission.serverGeneration,
          sizeBytes: expectedSize + (options.replayedRawAheadBytes ?? 0),
          finalized: options.replayedRawAheadBytes === undefined ? submission.final : true,
          replayed: options.replayedRawAheadBytes !== undefined
        })
      })))
    })),
    makeSecretRedactorLayer(["supersecret"])
  )
  const run = <A, E>(effect: Effect.Effect<A, E, ClientConfigStore | CollectorStateStore |
    AdapterRuntimes | CollectorTransport | import("./collector.ts").SecretRedactor>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return {
    run,
    canonical,
    raw,
    checkpoint: () => checkpoint,
    commits: () => commits,
    rawAttempts: () => rawAttempts,
    pageReads: () => pageIndex,
    allowRaw: () => { rawBlocked = false }
  }
}

describe("Collector Module", () => {
  it("preserves accepted Raw receipts when a later chunk is disabled", async () => {
    const page = collectionPage(), observation = page.observations[0]!, segment = observation.rawSegments[0]!
    const capture = fixture({
      page: { ...page, observations: [{ ...observation, rawSegments: [
        { ...segment, content: "first\n", final: false },
        { ...segment, sourceOffset: 6, content: "last\n", final: true }
      ] }] },
      rawFailureAtServerOffset: 6,
      rawFailure: new CollectionTransportError({ operation: "raw", reason: "raw_disabled", retryable: false, message: "disabled" })
    })
    await capture.run(runCollectionCycle())
    expect(capture.raw).toHaveLength(1)
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
    expect(capture.checkpoint()?.rawObjects[0]?.sourceOffset).toBe(6)
    expect(capture.checkpoint()?.rawObjects[0]?.finalized).toBe(false)
  })

  it("continues Canonical without Raw or invented receipts when policy disables upload", async () => {
    const capture = fixture({ rawEnabled: false })
    await capture.run(runCollectionCycle())
    expect(capture.canonical).toHaveLength(1)
    expect(capture.rawAttempts()).toBe(0)
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
    expect(capture.checkpoint()?.rawObjects).toEqual([])
  })
  it("fails closed when the authoritative policy cannot be read", async () => {
    const capture = fixture({ policyFailure: new CollectionTransportError({
      operation: "policy", reason: "invalid_response", retryable: false, message: "invalid policy"
    }) })
    await capture.run(runCollectionCycle())
    expect(capture.canonical).toHaveLength(0)
    expect(capture.rawAttempts()).toBe(0)
    expect(capture.checkpoint()).toBeUndefined()
  })
  it("treats a server Raw policy change as a skip and commits Canonical progress", async () => {
    const capture = fixture({ rawFailure: new CollectionTransportError({
      operation: "raw", reason: "raw_disabled", retryable: false, message: "Raw capture disabled"
    }) })
    await capture.run(runCollectionCycle())
    expect(capture.canonical).toHaveLength(1)
    expect(capture.rawAttempts()).toBe(1)
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
    expect(capture.checkpoint()?.rawObjects).toEqual([])
  })

  it("overlaps independent Raw objects while preserving each object order and all receipts", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const secondStarted = yield* Deferred.make<void>()
      const page = collectionPage()
      const segment = page.observations[0]!.rawSegments[0]!
      const a = { ...segment, sourceObjectId: "a", content: "first\n" }
      const b = { ...segment, sourceObjectId: "b", content: "other\n" }
      const capture = fixture({ page: { ...page, observations: [{ ...page.observations[0]!,
        rawSegments: [a, { ...a, sourceOffset: 6, content: "second\n", final: true }, b] }] },
        rawGate: submission => submission.sourceObjectId === "a" && submission.serverOffset === 0
          ? Deferred.await(secondStarted)
          : submission.sourceObjectId === "b" ? Deferred.succeed(secondStarted, undefined).pipe(Effect.asVoid) : Effect.void })
      const report = yield* Effect.promise(() => capture.run(runCollectionCycle()))
      expect(report.failures).toEqual([])
      expect(capture.raw.filter(chunk => chunk.sourceObjectId === "a").map(chunk => chunk.serverOffset)).toEqual([0, 6])
      expect(capture.checkpoint()?.rawObjects).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceObjectId: "a", sourceOffset: 13, finalized: true }),
        expect.objectContaining({ sourceObjectId: "b", sourceOffset: 6 })
      ]))
    }))
  })

  it.each(["foreground", "managed"] as const)("%s drains bounded backlog immediately, then waits when idle", async mode => {
    const count = AdapterCollectionLimits.pagesPerCycle
    const capture = fixture({ pages: [
      ...Array.from({ length: count }, (_, index) => ({ protocolVersion: AdapterProtocolVersion,
        nextCursor: `backlog-${index}`, hasMore: true, observations: [],
        sourceFailures: [{ source: "/unrelated/source", reason: "unsupported" as const }] })),
      collectionPage()
    ], page: { protocolVersion: AdapterProtocolVersion, nextCursor: "cursor-1", hasMore: false, observations: [] } })
    await capture.run(Effect.gen(function*() {
      const runner = mode === "managed" ? runManagedCollector : runCollector
      const fiber = yield* runner({ intervalMs: 10_000 }).pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      expect(capture.pageReads()).toBe(count + 1)
      expect(capture.canonical).toHaveLength(1)
      yield* TestClock.adjust("9 seconds")
      expect(capture.pageReads()).toBe(count + 2)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("30 seconds")
      expect(capture.pageReads()).toBe(count + 2)
    }).pipe(Effect.provideService(CollectorRunStatusStore, {
      read: () => Effect.succeed({ version: 1, jobs: [] }),
      recordCycle: () => Effect.void,
      recordCollectorFailure: () => Effect.void
    }), Effect.provide(TestClock.layer())))
  })

  it.each(["foreground", "managed"] as const)("%s backs off after backlog upload fails", async mode => {
    const capture = fixture({ pages: [], page: { ...collectionPage(), hasMore: true }, rawFailureAtServerOffset: 0 })
    await capture.run(Effect.gen(function*() {
      const runner = mode === "managed" ? runManagedCollector : runCollector
      const fiber = yield* runner({ intervalMs: 10_000 }).pipe(Effect.forkChild)
      yield* TestClock.adjust("3 seconds")
      expect(capture.pageReads()).toBe(1)
      expect(capture.checkpoint()).toBeUndefined()
      yield* TestClock.adjust("8 seconds")
      expect(capture.pageReads()).toBe(1)
      yield* TestClock.adjust("3 seconds")
      expect(capture.pageReads()).toBe(2)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provideService(CollectorRunStatusStore, {
      read: () => Effect.succeed({ version: 1, jobs: [] }),
      recordCycle: () => Effect.void,
      recordCollectorFailure: () => Effect.void
    }), Effect.provide(TestClock.layer())))
  })

  it.each(["foreground", "managed"] as const)("%s pauses and resumes two source projects whose scans stay out of phase", async mode => {
    const original = clientConfig(), first = original.projects[0]!
    const capture = fixture({ config: () => ({ ...original, projects: [first, { ...first, id: "second" }] }) })
    const reads = new Map<string, number>(), reports: boolean[][] = []
    const firstBurst = Deferred.makeUnsafe<void>(), secondBurst = Deferred.makeUnsafe<void>()
    await capture.run(Effect.gen(function*() {
      const runner = mode === "managed" ? runManagedCollector : runCollector
      const fiber = yield* runner({ intervalMs: 10_000 }).pipe(Effect.forkChild)
      yield* Deferred.await(firstBurst)
      yield* TestClock.adjust("1 second")
      expect([...reads.values()]).toEqual([16, 16])
      yield* TestClock.adjust("8 seconds")
      expect([...reads.values()]).toEqual([16, 16])
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(secondBurst)
      expect([...reads.values()]).toEqual([32, 32])
      yield* Fiber.interrupt(fiber)
      if (mode === "managed") expect(reports.slice(0, 4)).toEqual([[true, false], [false, true], [true, false], [false, true]])
    }).pipe(Effect.provideService(AdapterRuntimes, { open: () => Effect.succeed({
      attribute: () => Effect.succeed("included"), sourceCapture: {
        discover: () => Effect.die("The controlled collector owns this fixture."),
        open: () => Effect.die("The controlled collector owns this fixture.")
      }
    }) }), Effect.provideService(SourceCaptureCollector, { collect: (project, adapter) => Effect.gen(function*() {
      const count = (reads.get(project.id) ?? 0) + 1; reads.set(project.id, count)
      if (reads.size === 2 && [...reads.values()].every(value => value === 16)) yield* Deferred.succeed(firstBurst, undefined)
      if (reads.size === 2 && [...reads.values()].every(value => value === 32)) yield* Deferred.succeed(secondBurst, undefined)
      return { projectId: project.id, adapterId: adapter.adapterId, pages: 1, observations: 0, canonicalBatches: 0,
        canonicalEvents: 0, rawChunks: 0, rawBytes: 0, redactions: 0, durationMs: 0,
        hasMore: count % 2 === (project.id === first.id ? 1 : 0) }
    }) }), Effect.provideService(CollectorRunStatusStore, {
      read: () => Effect.succeed({ version: 1, jobs: [] }),
      recordCycle: report => Effect.sync(() => { reports.push(report.jobs.map(job => job.hasMore)) }),
      recordCollectorFailure: () => Effect.void
    }), Effect.provide(TestClock.layer())))
  })

  it("continues through an empty progress page before publishing history", async () => {
    const capture = fixture({ pages: [
      { protocolVersion: AdapterProtocolVersion, nextCursor: "transition", hasMore: true, observations: [] },
      collectionPage(),
      { protocolVersion: AdapterProtocolVersion, nextCursor: "cursor-1", hasMore: false, observations: [] }
    ] })
    const report = await capture.run(runCollectionCycle())
    expect(report.failures).toEqual([])
    expect(report.jobs[0]).toMatchObject({ pages: 2, observations: 1, canonicalBatches: 1, rawChunks: 1, hasMore: false })
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
    expect((await capture.run(runCollectionCycle())).failures).toEqual([])
    expect(capture.canonical).toHaveLength(1)
    expect(capture.raw).toHaveLength(1)
  })

  it.each([null, "", "transition"])("rejects a stalled empty continuation cursor %s", async nextCursor => {
    const capture = fixture({ pages: [
      { protocolVersion: AdapterProtocolVersion, nextCursor: "transition", hasMore: true, observations: [] },
      { protocolVersion: AdapterProtocolVersion, nextCursor, hasMore: true, observations: [] }
    ] })
    const report = await capture.run(runCollectionCycle())
    expect(report.failures[0]?.reason).toBe("contract")
    expect(capture.checkpoint()?.cursor).toBe("transition")
    expect(capture.commits()).toBe(1)
    expect(capture.canonical).toEqual([])
    expect(capture.raw).toEqual([])
  })

  it("bounds empty continuation pages and resumes their progress on the next cycle", async () => {
    const count = AdapterCollectionLimits.pagesPerCycle
    const capture = fixture({ pages: [
      ...Array.from({ length: count }, (_, index) => ({ protocolVersion: AdapterProtocolVersion,
        nextCursor: `empty-${index}`, hasMore: true, observations: [] })),
      collectionPage()
    ] })
    const report = await capture.run(runCollectionCycle())
    expect(report.failures).toEqual([])
    expect(report.jobs[0]).toMatchObject({ pages: count, observations: 0, canonicalBatches: 0, rawChunks: 0, hasMore: true })
    expect(capture.checkpoint()?.cursor).toBe(`empty-${count - 1}`)
    expect(capture.canonical).toEqual([])
    expect(capture.raw).toEqual([])
    expect((await capture.run(runCollectionCycle())).jobs[0]).toMatchObject({ observations: 1, hasMore: false })
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
  })

  it("retains empty-page progress without acknowledging a later failed Raw upload", async () => {
    const capture = fixture({ pages: [
      { protocolVersion: AdapterProtocolVersion, nextCursor: "transition", hasMore: true, observations: [] },
      collectionPage(), collectionPage()
    ], rawFailureAtServerOffset: 0 })
    expect((await capture.run(runCollectionCycle())).failures).toHaveLength(1)
    expect(capture.checkpoint()).toMatchObject({ cursor: "transition", rawObjects: [] })
    capture.allowRaw()
    expect((await capture.run(runCollectionCycle())).failures).toEqual([])
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
    expect(capture.raw).toHaveLength(1)
  })

  it("reports idle liveness without new content and stops its heartbeat on cancellation", async () => {
    const reports: import("@atape/domain").CLISyncReport[] = []
    const capture = fixture({ page: { protocolVersion: AdapterProtocolVersion, nextCursor: null, hasMore: false, observations: [] } })
    await capture.run(Effect.gen(function*() {
      const fiber = yield* runCollector({ intervalMs: 3_600_000 }).pipe(Effect.forkChild)
      yield* TestClock.adjust("31 seconds")
      expect(reports.some(report => report.phase === "waiting" && report.jobs[0]?.state === "synced")).toBe(true)
      yield* Fiber.interrupt(fiber)
      expect(reports.at(-1)?.phase).toBe("stopped")
      const count = reports.length
      yield* TestClock.adjust("90 seconds")
      expect(reports).toHaveLength(count)
    }).pipe(Effect.provideService(CollectorDeviceGateway, { publish: report => Effect.sync(() => { reports.push(report) }) }), Effect.provide(TestClock.layer())))
  })

  it("bounds shutdown even when reporting is unavailable", async () => {
    const capture = fixture({ page: { protocolVersion: AdapterProtocolVersion, nextCursor: null, hasMore: false, observations: [] } })
    await capture.run(Effect.gen(function*() {
      const fiber = yield* runCollector({ intervalMs: 3_600_000 }).pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      const stopping = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
      yield* TestClock.adjust("6 seconds")
      yield* Fiber.join(stopping)
    }).pipe(Effect.provideService(CollectorDeviceGateway, { publish: () => Effect.never }), Effect.provide(TestClock.layer())))
  })

  it("uploads only categorized failures and retains prior successful sync timestamps", async () => {
    const reports: import("@atape/domain").CLISyncReport[] = []
    const page = collectionPage()
    const capture = fixture({ pages: [page], page: { ...page, observations: [], sourceFailures: [{ source: "/private/session.jsonl", reason: "format" }] } })
    await capture.run(Effect.gen(function*() {
      const fiber = yield* runCollector({ intervalMs: 10_000 }).pipe(Effect.forkChild)
      yield* TestClock.adjust("31 seconds")
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provideService(CollectorDeviceGateway, { publish: report => Effect.sync(() => { reports.push(report) }) }), Effect.provide(TestClock.layer())))
    expect(JSON.stringify(reports)).not.toContain("/private/")
    expect(reports.at(-1)?.jobs[0]?.lastSuccessAt).toBeDefined()
    expect(reports.at(-1)?.jobs[0]?.state).toBe("partial")
  })

  it("uses global tools for collection and preserves its checkpoint while a tool is disabled", async () => {
    const original = clientConfig()
    let config: ClientConfig = original
    const capture = fixture({ config: () => config, pages: [collectionPage(), {
      protocolVersion: AdapterProtocolVersion, nextCursor: "cursor-1", hasMore: false, observations: []
    }] })
    const first = await capture.run(runCollectionCycle())
    expect(first.jobs).toHaveLength(1)
    expect(capture.canonical).toHaveLength(1)
    const checkpoint = structuredClone(capture.checkpoint())
    config = { ...config, enabledAdapterIds: [], projects: original.projects }
    expect((await capture.run(runCollectionCycle())).jobs).toEqual([])
    expect(capture.canonical).toHaveLength(1)
    expect(capture.checkpoint()).toEqual(checkpoint)
    config = { ...config, enabledAdapterIds: ["fixture"] }
    expect((await capture.run(runCollectionCycle())).jobs).toHaveLength(1)
    expect(capture.checkpoint()?.cursor).toBe(checkpoint?.cursor)
  })

  it("deduplicates diagnostics across pages and bounds the cycle report without blocking publication", async () => {
    const sourceFailures = Array.from({ length: 32 }, (_, i) => ({ source: `/history/file-${i}`, reason: "format" as const }))
    const capture = fixture({ pages: [
      { ...collectionPage(), hasMore: true, sourceFailures },
      { protocolVersion: AdapterProtocolVersion, nextCursor: "cursor-1", hasMore: false, observations: [], sourceFailures },
    ] })
    const first = await capture.run(runCollectionCycle())
    expect(first.jobs[0]?.sourceFailures).toEqual(sourceFailures)
    expect(first.jobs[0]?.sourceFailuresTruncated).toBeUndefined()
    const overflow = fixture({ pages: [
      { ...collectionPage(), hasMore: true, sourceFailures },
      { protocolVersion: AdapterProtocolVersion, nextCursor: "cursor-1", hasMore: false, observations: [],
        sourceFailures: [{ source: "/history/another-file", reason: "io" }] },
    ] })
    expect((await overflow.run(runCollectionCycle())).jobs[0]).toMatchObject({ observations: 1, sourceFailures, sourceFailuresTruncated: true })
    expect(overflow.checkpoint()?.cursor).toBe("cursor-1")
  })

  it("reports bounded redacted source failures locally while publishing healthy observations", async () => {
    const capture = fixture({ page: { ...collectionPage(), sourceFailures: [{ source: "/history/supersecret.jsonl", reason: "unsupported" }], sourceFailuresTruncated: true } })
    const report = await capture.run(runCollectionCycle())
    expect(report.failures).toEqual([])
    expect(report.jobs[0]).toMatchObject({ observations: 1,
      sourceFailures: [{ source: "/history/[REDACTED].jsonl", reason: "unsupported" }], sourceFailuresTruncated: true })
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
    expect(JSON.stringify([...capture.canonical, ...capture.raw])).not.toContain("/history/")
  })

  it.each(["format", "attribution"] as const)("reports a %s-only page without fabricating observations or progress", async reason => {
    const capture = fixture({ page: { protocolVersion: AdapterProtocolVersion, nextCursor: null, hasMore: false, observations: [],
      sourceFailures: [{ source: "/history/broken.jsonl", reason }] } })
    const report = await capture.run(runCollectionCycle())
    expect(report.failures).toEqual([])
    expect(report.jobs[0]).toMatchObject({ observations: 0, sourceFailures: [{ reason }] })
    expect(capture.canonical).toEqual([]); expect(capture.raw).toEqual([])
    expect(capture.checkpoint()?.cursor).toBeNull()
  })

  it("publishes healthy history and preserves progress alongside unknown Git sources", async () => {
    const sourceFailures = [{ source: "/history/supersecret.jsonl", reason: "attribution" as const }]
    const capture = fixture({ pages: [
      { ...collectionPage(), sourceFailures },
      { protocolVersion: AdapterProtocolVersion, nextCursor: "cursor-1", hasMore: false, observations: [], sourceFailures }
    ] })
    const first = await capture.run(runCollectionCycle())
    expect(first.failures).toEqual([])
    expect(first.jobs[0]).toMatchObject({ observations: 1, canonicalBatches: 1, rawChunks: 1,
      sourceFailures: [{ source: "/history/[REDACTED].jsonl", reason: "attribution" }] })
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
    const second = await capture.run(runCollectionCycle())
    expect(second.failures).toEqual([])
    expect(second.jobs[0]).toMatchObject({ observations: 0, canonicalBatches: 0, rawChunks: 0,
      sourceFailures: [{ reason: "attribution" }] })
    expect(capture.canonical).toHaveLength(1)
    expect(capture.raw).toHaveLength(1)
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
    expect(JSON.stringify([...capture.canonical, ...capture.raw])).not.toContain("/history/")
  })

  it("rejects undeclared diagnostic reasons before uploading history or committing progress", async () => {
    const page = { ...collectionPage(), sourceFailures: [{ source: "/history/source", reason: "not-a-protocol-reason" }] }
    const capture = fixture({ page: page as AdapterCollectionPage })
    expect((await capture.run(runCollectionCycle())).failures[0]?.reason).toBe("contract")
    expect(capture.canonical).toEqual([])
    expect(capture.raw).toEqual([])
    expect(capture.commits()).toBe(0)
  })

  it("rejects excessive source diagnostics before any network submission", async () => {
    const capture = fixture({ page: { ...collectionPage(), sourceFailures: Array.from({ length: 33 }, () => ({ source: "/history/file", reason: "format" as const })) } })
    expect((await capture.run(runCollectionCycle())).failures[0]?.reason).toBe("contract")
    expect(capture.canonical).toEqual([]); expect(capture.commits()).toBe(0)
  })

  it("masks nested tool values and credential fields before Canonical submission", async () => {
    const original = collectionPage()
    const page: AdapterCollectionPage = { ...original, observations: original.observations.map(o => ({ ...o,
      events: o.events.map(e => e.update.sessionUpdate === "tool_call" ? { ...e, update: { ...e.update,
        rawInput: { supersecret: ["supersecret", { password: "not-configured-password", fraction: 0.125, empty: "", null: null, flag: false }] },
        rawOutput: "Output supersecret"
      } } : e)
    })) }
    const capture = fixture({ page })
    expect((await capture.run(runCollectionCycle())).failures).toEqual([])
    const event = capture.canonical[0]!.observation.events[0]!
    expect(JSON.stringify(event)).not.toContain("supersecret")
    expect(JSON.stringify(event)).not.toContain("not-configured-password")
    expect(event.fidelity).toBe("redacted")
    expect(event.update).toMatchObject({ rawInput: { "[REDACTED]": ["[REDACTED]", { password: "[REDACTED]", fraction: 0.125, empty: "", null: null, flag: false }] }, rawOutput: "Output [REDACTED]" })
  })

  it.each(["tool_call", "tool_call_update"] as const)("keeps a %s title within its UTF-8 limit when redaction expands it", async sessionUpdate => {
    const original = collectionPage()
    const title = `api_key=12345678 ${"x".repeat(480)}中`
    expect(utf8Length(title)).toBe(500)
    const page: AdapterCollectionPage = { ...original, observations: original.observations.map(o => ({ ...o,
      events: o.events.map(e => e.update.sessionUpdate === "tool_call"
        ? { ...e, update: sessionUpdate === "tool_call"
          ? { ...e.update, title }
          : { ...e.update, sessionUpdate: "tool_call_update" as const, title } } : e)
    })) }
    const capture = fixture({ page })

    expect((await capture.run(runCollectionCycle())).failures).toEqual([])
    const event = capture.canonical[0]!.observation.events[0]!
    expect(event.update).toMatchObject({ sessionUpdate, title: `api_key=[REDACTED] ${"x".repeat(480)}` })
    expect(event.fidelity).toBe("redacted")
    expect(JSON.stringify(event)).not.toContain("12345678")
    expect(capture.raw).toHaveLength(1)
    expect(capture.checkpoint()?.cursor).toBe("cursor-1")
  })

  it.each([undefined, Infinity, "x".repeat(65536)])("rejects inadmissible tool values before network or checkpoint writes", async rawInput => {
    const original = collectionPage()
    const page: AdapterCollectionPage = { ...original, observations: original.observations.map(o => ({ ...o,
      events: o.events.map(e => e.update.sessionUpdate === "tool_call" ? { ...e, update: { ...e.update, rawInput } } : e)
    })) }
    const capture = fixture({ page })
    expect((await capture.run(runCollectionCycle())).failures).toHaveLength(1)
    expect(capture.canonical).toEqual([])
    expect(capture.commits()).toBe(0)
  })

  it("redacts quoted JSON credentials while preserving valid JSON", async () => {
    const value = await Effect.gen(function*() {
      const redactor = yield* SecretRedactor
      return redactor.redact('{"api_key":"abcdefghijk","password":"longpassword"}')
    }).pipe(Effect.provide(makeSecretRedactorLayer()), Effect.runPromise)

    expect(JSON.parse(value.value)).toEqual({ api_key: "[REDACTED]", password: "[REDACTED]" })
    expect(value.replacements).toBe(2)
  })

  it("redacts and commits Canonical then Raw before advancing one checkpoint", async () => {
    const capture = fixture()
    const report = await capture.run(runCollectionCycle())

    expect(report.failures).toEqual([])
    expect(report.jobs).toEqual([expect.objectContaining({
      projectId: "payments",
      adapterId: "fixture",
      observations: 1,
      canonicalBatches: 1,
      rawChunks: 1
    })])
    expect(JSON.stringify(capture.canonical)).not.toContain("supersecret")
    expect(JSON.stringify(capture.raw)).not.toContain("supersecret")
    expect(capture.canonical[0]?.observation.threads[1]).toMatchObject({
      sourceThreadId: "child", parentSourceThreadId: "root"
    })
    expect(capture.canonical[0]?.observation.events[0]).toMatchObject({
      update: { sessionUpdate: "tool_call" }, childSourceThreadId: "child"
    })
    expect(capture.canonical[0]?.observation).not.toHaveProperty("rawSegments")
    expect(capture.commits()).toBe(2)
    expect(capture.checkpoint()).toMatchObject({
      revision: 2,
      cursor: "cursor-1",
      rawObjects: [{
        sourceObjectId: "transcript",
        sourceGeneration: "inode-1",
        sourceOffset: new TextEncoder().encode("{\"token\":\"supersecret\"}\n").byteLength,
        serverOffset: new TextEncoder().encode("{\"token\":\"[REDACTED]\"}\n").byteLength
      }]
    })
  })

  it("honors server Retry-After without advancing an unacknowledged cursor", async () => {
    const capture = fixture({ rawFailure: new CollectionTransportError({ reason: "rejected", operation: "raw",
      retryable: true, status: 429, retryAfterSeconds: 5, message: "Busy" }) })
    await capture.run(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(runCollectionCycle())
      yield* TestClock.adjust("1 second")
      expect(capture.rawAttempts()).toBe(1)
      yield* TestClock.adjust("3 seconds")
      expect(capture.rawAttempts()).toBe(1)
      yield* TestClock.adjust("1 second")
      expect(capture.rawAttempts()).toBe(2)
      yield* TestClock.adjust("5 seconds")
      const report = yield* Fiber.join(fiber)
      expect(report.failures).toHaveLength(1)
      expect(capture.rawAttempts()).toBe(3)
      expect(capture.checkpoint()).toBeUndefined()
    }).pipe(Effect.provide(TestClock.layer())))
  })

  it("backs off transient uploads and cancels a pending retry without advancing the cursor", async () => {
    const capture = fixture({ rawFailure: new CollectionTransportError({ reason: "network", operation: "raw",
      retryable: true, message: "Offline" }) })
    await capture.run(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(runCollectionCycle())
      yield* TestClock.adjust("400 millis")
      expect(capture.rawAttempts()).toBe(1)
      yield* TestClock.adjust("600 millis")
      expect(capture.rawAttempts()).toBe(2)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("1 minute")
      expect(capture.rawAttempts()).toBe(2)
      expect(capture.checkpoint()).toBeUndefined()
    }).pipe(Effect.provide(TestClock.layer())))
  })

  it("does not advance the cursor when Raw remains unavailable after bounded retries", async () => {
    const failure = new CollectionTransportError({
      reason: "network",
      operation: "raw",
      retryable: true,
      message: "Raw is temporarily unavailable"
    })
    const capture = fixture({ rawFailure: failure })
    const report = await capture.run(runCollectionCycle())

    expect(report.jobs).toEqual([])
    expect(report.failures).toEqual([expect.objectContaining({
      adapterId: "fixture", retryable: true, message: "Raw is temporarily unavailable"
    })])
    expect(capture.rawAttempts()).toBe(3)
    expect(capture.commits()).toBe(0)
    expect(capture.checkpoint()).toBeUndefined()
    expect(capture.canonical).toHaveLength(1)
  })

  it("surfaces unauthenticated explicitly and stops continuous collection without retrying", async () => {
    const capture = fixture({
      rawFailure: new CollectionTransportError({
        reason: "unauthenticated",
        operation: "raw",
        status: 401,
        retryable: false,
        message: "The CLI credential is no longer valid."
      })
    })
    const report = await capture.run(runCollectionCycle())
    expect(report.failures).toEqual([expect.objectContaining({
      reason: "unauthenticated",
      retryable: false
    })])
    expect(capture.rawAttempts()).toBe(1)

    await expect(capture.run(runCollector({ intervalMs: 10_000 }))).rejects.toMatchObject({
      reason: "unauthenticated"
    })
    expect(capture.rawAttempts()).toBe(2)
  })

  it("keeps its own Raw offset when a replay receipt reports a later server position", async () => {
    const capture = fixture({ replayedRawAheadBytes: 1_000 })
    const report = await capture.run(runCollectionCycle())
    const expectedOffset = new TextEncoder().encode("{\"token\":\"[REDACTED]\"}\n").byteLength

    expect(report.failures).toEqual([])
    expect(capture.checkpoint()?.rawObjects[0]).toMatchObject({
      serverOffset: expectedOffset,
      finalized: false
    })
  })

  it("checkpoints acknowledged Raw ranges without advancing the page cursor", async () => {
    const page = twoSegmentCollectionPage()
    const firstContent = page.observations[0]?.rawSegments[0]?.content
    if (!firstContent) throw new Error("missing first Raw fixture")
    const firstOffset = new TextEncoder().encode(firstContent).byteLength
    const capture = fixture({ page, rawFailureAtServerOffset: firstOffset })

    const interrupted = await capture.run(runCollectionCycle())
    expect(interrupted.jobs).toEqual([])
    expect(capture.checkpoint()).toMatchObject({
      revision: 1,
      cursor: null,
      rawObjects: [{ sourceOffset: firstOffset, serverOffset: firstOffset, finalized: false }]
    })
    expect(capture.raw).toHaveLength(1)

    capture.allowRaw()
    const resumed = await capture.run(runCollectionCycle())

    expect(resumed.failures).toEqual([])
    expect(resumed.jobs[0]).toMatchObject({ rawChunks: 1 })
    expect(capture.raw).toHaveLength(2)
    expect(capture.canonical).toHaveLength(2)
    expect(capture.checkpoint()).toMatchObject({ revision: 3, cursor: "cursor-1" })
  })

  it("splits a complete Adapter Raw segment into bounded UTF-8 transport chunks", async () => {
    const sourceContent = `${JSON.stringify({
      text: "界".repeat(2_000_000),
      token: "supersecret"
    })}\n`
    const redactedContent = sourceContent.replace("supersecret", "[REDACTED]")
    const expectedChunks = Math.ceil(utf8Length(redactedContent) / RawTransportChunkBytes)
    const base = collectionPage()
    const page: AdapterCollectionPage = {
      ...base,
      observations: base.observations.map((observation) => ({
        ...observation,
        rawSegments: [{
          ...(observation.rawSegments[0] as NonNullable<typeof observation.rawSegments[0]>),
          content: sourceContent,
          final: true
        }]
      }))
    }
    const capture = fixture({ page })

    const report = await capture.run(runCollectionCycle())

    expect(report.failures).toEqual([])
    expect(utf8Length(sourceContent)).toBeGreaterThan(4 * 1024 * 1024)
    expect(report.jobs[0]).toMatchObject({ rawChunks: expectedChunks })
    expect(capture.raw).toHaveLength(expectedChunks)
    expect(capture.raw.every((submission) => utf8Length(submission.content) <= RawTransportChunkBytes)).toBe(true)
    expect(capture.raw.map((submission) => submission.content).join("")).toBe(redactedContent)
    expect(capture.raw.slice(0, -1).every((submission) => !submission.final)).toBe(true)
    expect(capture.raw.at(-1)?.final).toBe(true)
    expect(capture.raw[0]?.sourceChunkId).toBe("g1-o0")
    expect(capture.raw[1]?.sourceChunkId)
      .toBe(`g1-o${utf8Length(capture.raw[0]?.content ?? "")}`)
    expect(capture.checkpoint()?.rawObjects[0]).toMatchObject({
      sourceOffset: utf8Length(sourceContent),
      serverOffset: utf8Length(redactedContent),
      finalized: true
    })
  })

  it("does not checkpoint a partial Adapter segment when a later transport chunk fails", async () => {
    const sourceContent = `${JSON.stringify({ text: "x".repeat(RawTransportChunkBytes + 1024) })}\n`
    const base = collectionPage()
    const page: AdapterCollectionPage = {
      ...base,
      observations: base.observations.map((observation) => ({
        ...observation,
        rawSegments: [{
          ...(observation.rawSegments[0] as NonNullable<typeof observation.rawSegments[0]>),
          content: sourceContent
        }]
      }))
    }
    const capture = fixture({ page, rawFailureAtServerOffset: RawTransportChunkBytes })

    const report = await capture.run(runCollectionCycle())

    expect(report.jobs).toEqual([])
    expect(report.failures[0]).toMatchObject({ retryable: true, message: "Raw is temporarily unavailable" })
    expect(capture.raw).toHaveLength(1)
    expect(capture.raw[0]).toMatchObject({ serverOffset: 0, sourceChunkId: "g1-o0", final: false })
    expect(capture.rawAttempts()).toBe(4)
    expect(capture.checkpoint()).toBeUndefined()
  })

  it("rejects a non-final Raw fragment without a complete record boundary", async () => {
    const validPage = collectionPage()
    const page: AdapterCollectionPage = {
      ...validPage,
      observations: validPage.observations.map((observation, observationIndex) => observationIndex === 0
        ? {
            ...observation,
            rawSegments: observation.rawSegments.map((segment, segmentIndex) => segmentIndex === 0
              ? { ...segment, content: segment.content.trimEnd() }
              : segment)
          }
        : observation)
    }
    const capture = fixture({ page })
    const report = await capture.run(runCollectionCycle())

    expect(report.jobs).toEqual([])
    expect(report.failures[0]).toMatchObject({
      adapterId: "fixture",
      retryable: false,
      message: "Adapter fixture observation checkout-r1 contains an invalid Raw segment."
    })
    expect(capture.canonical).toEqual([])
    expect(capture.commits()).toBe(0)
  })
})

const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength
