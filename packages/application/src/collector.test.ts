import {
  AdapterProtocolVersion,
  RawTransportChunkBytes,
  emptyClientConfig,
  type AdapterCollectionPage,
  type ClientConfig,
  type CollectorCheckpoint
} from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ClientConfigStore } from "./clientManagement.ts"
import {
  AdapterRuntimes,
  CollectionTransportError,
  CollectorStateStore,
  CollectorTransport,
  SecretRedactor,
  makeSecretRedactorLayer,
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
  userId: "liying",
  projects: [{
    id: "payments",
    teamId: "acme",
    teamName: "Acme",
    name: "Payments",
    type: "git",
    path: "/work/payments",
    adapterIds: ["fixture"],
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
  readonly page?: AdapterCollectionPage
  readonly rawFailure?: CollectionTransportError
  readonly rawFailureAtServerOffset?: number
  readonly replayedRawAheadBytes?: number
} = {}) => {
  let checkpoint: CollectorCheckpoint | undefined
  let commits = 0
  let rawAttempts = 0
  let rawBlocked = options.rawFailureAtServerOffset !== undefined
  const canonical: Array<CanonicalSubmission> = []
  const raw: Array<RawSubmission> = []
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({
      transact: (change) => change(clientConfig()).pipe(Effect.map((result) => result.value))
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
      open: () => Effect.succeed({ collect: () => Effect.succeed(options.page ?? collectionPage()) })
    })),
    Layer.succeed(CollectorTransport, CollectorTransport.of({
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
      appendRaw: (submission) => Effect.suspend(() => {
        rawAttempts++
        if (options.rawFailure || (rawBlocked && options.rawFailureAtServerOffset === submission.serverOffset)) {
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
      })
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
    allowRaw: () => { rawBlocked = false }
  }
}

describe("Collector Module", () => {
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
      text: "界".repeat(100_000),
      token: "supersecret"
    })}\n`
    const redactedContent = sourceContent.replace("supersecret", "[REDACTED]")
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
    expect(report.jobs[0]).toMatchObject({ rawChunks: 2 })
    expect(capture.raw).toHaveLength(2)
    expect(capture.raw.every((submission) => utf8Length(submission.content) <= RawTransportChunkBytes)).toBe(true)
    expect(capture.raw.map((submission) => submission.content).join("")).toBe(redactedContent)
    expect(capture.raw.map((submission) => submission.final)).toEqual([false, true])
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
