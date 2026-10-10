import { AdapterProtocolVersion, emptyClientConfig, type AdapterCollectionPage, type CollectorCheckpoint, type ClientConfig } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ClientConfigStore } from "./clientManagement.ts"
import { AdapterRuntimes, CollectorStateStore, CollectorTransport, CollectionTransportError, AdapterRuntimeError, SecretRedactor,
  type CanonicalSubmission, type RawSubmission, type HostedCollectRequest } from "./collectorContracts.ts"
import { CollectorRedactionPolicies } from "./collectorRedactionPolicy.ts"
import { SourceCaptureCollector } from "./sourceCollector.ts"
import { compileRedactionPolicy, secretRedactorForPolicy } from "./redaction.ts"
import { runCollectionCycle } from "./collector.ts"
import { CollectorRunStatusStore, type CollectorRedactionJobEvent } from "./collectorRunStatus.ts"

const timestamp = "2026-10-09T00:00:00Z", secret = "PRIVATE_LITERAL"
const content = `{"message":"${secret}"}\n`
const bytes = (text: string) => new TextEncoder().encode(text).byteLength
const config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: ["fixture"],
  projects: [{ id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team", teamName: "Team",
    name: "Project", type: "directory", path: "/work/project", createdAt: timestamp }],
  adapters: [{ adapterId: "fixture", packageName: "@atape/adapter-fixture", upgradeSpec: "@atape/adapter-fixture",
    displayName: "Fixture", version: "1.0.0", installedAt: timestamp, updatedAt: timestamp }] }
const page = (index: number, sourceOffset = 0): AdapterCollectionPage => ({ protocolVersion: AdapterProtocolVersion,
  nextCursor: `cursor-${index}`, hasMore: false, observations: [{ observationId: `observation-${index}`, observedAt: timestamp,
    session: { sourceSessionId: "session", revision: index, title: "Session", summary: "", insight: "", branch: "main",
      actor: { name: "User", harness: "Fixture" }, status: "active", captureStatus: "healthy", updatedAt: timestamp, reportedEventCount: index },
    threads: [{ sourceThreadId: "root", revision: index, label: "Root", summary: "", captureStatus: "healthy" }],
    events: [{ sourceThreadId: "root", sourceEventId: `event-${index}`, revision: index, projectionRevision: index,
      sourceOrder: index, eventIndex: index - 1, occurredAt: timestamp, fidelity: "native", orderFidelity: "native",
      rawRef: { _tag: "object", sourceObjectId: "transcript" },
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Message ${secret}` } } }],
    rawSegments: [{ sourceObjectId: "transcript", sourceGeneration: "source-1", sourceOffset, sourceName: "session.jsonl",
      mediaType: "application/x-ndjson", content, final: false }] }] })
const checkpoint = (rawObjects: CollectorCheckpoint["rawObjects"] = []): CollectorCheckpoint => ({ instanceOrigin: "https://atape.test",
  userId: "user", projectId: "project", projectCreatedAt: timestamp, adapterId: "fixture", adapterVersion: "1.0.0",
  revision: 1, cursor: "cursor-1", rawObjects, canonicalPublished: true, updatedAt: timestamp })
const oldRaw = (): CollectorCheckpoint["rawObjects"][number] => ({ sourceSessionId: "session", sourceObjectId: "transcript",
  sourceName: "session.jsonl", mediaType: "application/x-ndjson", sourceGeneration: "source-1", sourceOffset: bytes(content),
  serverGeneration: 1, serverOffset: bytes(content), finalized: false })

// Test Adapters replace the real owned transport/state Seams. Every behavior
// enters through the same runCollectionCycle Interface as the CLI Host.
const fixture = async () => {
  const key = new Uint8Array(32).fill(7)
  const a = secretRedactorForPolicy(await Effect.runPromise(compileRedactionPolicy({ installationKey: key })))
  const b = secretRedactorForPolicy(await Effect.runPromise(compileRedactionPolicy({ installationKey: key, secretValues: [secret] })))
  let selected = a, saved: CollectorCheckpoint | undefined, opens = 0, reads = 0, lostRaw = false, lostCanonical = false
  let disabledRaw = false, retryBeforeDisable = false, openFailure = false
  let rawEnabled = true
  let duringOpen: (() => void) | undefined
  let currentPage = (request: HostedCollectRequest) => request.cursor === "cursor-1" ? page(2, bytes(content)) : page(1)
  const canonical: CanonicalSubmission[] = [], raw: RawSubmission[] = [], accepted = new Map<string, string>()
  const events: CollectorRedactionJobEvent[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, { transact: change => change(config).pipe(Effect.map(result => result.value)) }),
    Layer.succeed(CollectorStateStore, { capturedScopes: () => Effect.succeed([]), snapshot: () => Effect.sync(() => {
      expect(events.at(-1)).toMatchObject({ kind: "loaded", snapshot: { revision: selected.policyId ?? "unversioned" } })
      return { installationId: "installation", ...(saved ? { checkpoint: saved } : {}) }
    }),
      commit: input => Effect.sync(() => { expect(input.expectedRevision).toBe(saved?.revision ?? 0); saved = structuredClone(input.checkpoint) }) }),
    Layer.succeed(CollectorRedactionPolicies, { snapshot: () => Effect.sync(() => ({ redactor: selected, descriptor: {
      configFile: "/state/redaction.json", origin: "default" as const, revision: selected.policyId ?? "unversioned",
      exists: true, literalCount: selected === b ? 1 : 0, customRuleCount: 0
    } })) }),
    Layer.succeed(SecretRedactor, a),
    Layer.succeed(CollectorRunStatusStore, { read: () => Effect.succeed({ version: 1, jobs: [] }),
      recordCycle: () => Effect.void, recordCollectorFailure: () => Effect.void,
      recordRedactionJob: event => Effect.sync(() => { events.push(structuredClone(event)) }) }),
    Layer.succeed(AdapterRuntimes, { open: () => Effect.sync(() => { opens++; duringOpen?.(); return {
      collect: (request: HostedCollectRequest) => Effect.sync(() => { reads++; return currentPage(request) }) } }).pipe(Effect.flatMap(runtime => openFailure
        ? Effect.fail(new AdapterRuntimeError({ adapterId: "fixture", reason: "load", retryable: false, message: `Source error ${secret}` })) : Effect.succeed(runtime))) }),
    Layer.succeed(SourceCaptureCollector, { collect: () => Effect.die("Unexpected sourceCapture runtime") }),
    Layer.succeed(CollectorTransport, { rawCaptureEnabled: () => Effect.succeed(rawEnabled),
      submitCanonical: submission => Effect.suspend(() => {
        expect(saved?.deliveryPending).toBe(true)
        canonical.push(structuredClone(submission))
        if (lostCanonical) { lostCanonical = false; return Effect.fail(new CollectionTransportError({ operation: "canonical", reason: "network", retryable: false, message: `response lost ${secret}` })) }
        return Effect.succeed({ sessionId: "server-session", sessionCreated: false, insertedEvents: 1, updatedEvents: 0, unchangedEvents: 0, staleEvents: 0, replayed: false })
      }),
      appendRaw: submission => Effect.suspend(() => {
        expect(saved?.deliveryPending).toBe(true)
        raw.push(structuredClone(submission))
        if (disabledRaw) return Effect.fail(new CollectionTransportError({ operation: "raw", reason: "raw_disabled", retryable: false, message: "Raw disabled" }))
        const position = `${submission.serverGeneration}:${submission.serverOffset}`, prior = accepted.get(position)
        if (prior !== undefined && prior !== submission.content)
          return Effect.fail(new CollectionTransportError({ operation: "raw", reason: "rejected", retryable: false, message: "unknown legacy append conflicts with accepted bytes" }))
        accepted.set(position, submission.content)
        if (lostRaw) { lostRaw = false; disabledRaw = retryBeforeDisable; return Effect.fail(new CollectionTransportError({ operation: "raw", reason: "network", retryable: retryBeforeDisable, message: "Raw response lost" })) }
        return Effect.succeed({ objectId: "object", generation: submission.serverGeneration, sizeBytes: submission.serverOffset + bytes(submission.content), finalized: submission.final, replayed: prior !== undefined })
      }) })
  )
  return { a, b, canonical, raw, accepted, events, cycle: () => Effect.runPromise(runCollectionCycle().pipe(Effect.provide(layer))),
    saved: () => saved, reads: () => reads, opens: () => opens,
    select: (id: "a" | "b") => { selected = id === "a" ? a : b }, seed: (value: CollectorCheckpoint) => { saved = value },
    unversioned: () => { selected = { redact: value => ({ value, replacements: 0 }) } },
    pages: (value: typeof currentPage) => { currentPage = value }, duringOpen: (value: () => void) => { duringOpen = value },
    loseRaw: () => { lostRaw = true }, loseCanonical: () => { lostCanonical = true },
    disableRaw: () => { disabledRaw = true }, loseThenDisableRaw: () => { lostRaw = true; retryBeforeDisable = true },
    rawPolicy: (enabled: boolean) => { rawEnabled = enabled },
    failOpen: () => { openFailure = true } }
}

describe("legacy policy-bound collection admission", () => {
  it("pins one compiled policy before runtime acquisition and reloads on the next job", async () => {
    const f = await fixture(); f.duringOpen(() => f.select("b"))
    expect((await f.cycle()).failures).toEqual([])
    expect(f.saved()?.policyId).toBe(f.a.policyId)
    expect(f.events[1]).toMatchObject({ kind: "loaded", snapshot: { revision: f.a.policyId, literalCount: 0 } })
    expect(JSON.stringify(f.canonical[0])).toContain(secret)
    expect((await f.cycle()).failures).toEqual([])
    expect(f.saved()?.policyId).toBe(f.b.policyId)
    expect(f.events[4]).toMatchObject({ kind: "loaded", snapshot: { revision: f.b.policyId, literalCount: 1 } })
    expect(JSON.stringify(f.canonical[1])).not.toContain(secret)
  })
  it("continues a fully acknowledged nonfinal Raw object under a new policy without rewriting history", async () => {
    const f = await fixture(); await f.cycle()
    const old = structuredClone(f.raw[0]!)
    expect(f.saved()).toMatchObject({ deliveryPending: false, rawObjects: [{ finalized: false, policyId: f.a.policyId }] })
    f.select("b"); expect((await f.cycle()).failures).toEqual([])
    expect(f.raw[1]).toMatchObject({ serverGeneration: 1, serverOffset: bytes(old.content) })
    expect(f.raw[1]!.sourceChunkId).toContain(f.b.policyId!)
    expect(f.raw[1]!.content).not.toContain(secret)
    expect(f.raw[0]).toEqual(old)
    expect(f.saved()?.rawObjects[0]?.policyId).toBe(f.b.policyId)
  })
  it.each(["raw", "canonical"] as const)("persists uncertainty before a lost %s response and blocks cross-policy retry", async kind => {
    const f = await fixture(); kind === "raw" ? f.loseRaw() : f.loseCanonical()
    expect((await f.cycle()).failures).toHaveLength(1)
    const saved = structuredClone(f.saved())
    expect(saved).toMatchObject({ cursor: null, deliveryPending: true, policyId: f.a.policyId })
    const rawRequests = f.raw.length, canonicalRequests = f.canonical.length, reads = f.reads()
    f.select("b")
    expect((await f.cycle()).failures[0]).toMatchObject({ retryable: false, message: expect.stringContaining("unknown outcome") })
    expect(f.saved()).toEqual(saved)
    expect(f.raw).toHaveLength(rawRequests); expect(f.canonical).toHaveLength(canonicalRequests); expect(f.reads()).toBe(reads)
    f.select("a"); expect((await f.cycle()).failures).toEqual([])
    expect(f.saved()).toMatchObject({ cursor: "cursor-1", deliveryPending: false })
    if (kind === "raw") expect(f.raw[0]!.sourceChunkId).toBe(f.raw[1]!.sourceChunkId)
  })
  it("pauses an unversioned active Raw mapping before content I/O without clearing its cursor", async () => {
    const f = await fixture(), old = checkpoint([oldRaw()]); f.seed(old); f.select("b")
    expect((await f.cycle()).failures[0]).toMatchObject({ retryable: false, message: expect.stringContaining("unversioned legacy Raw object") })
    expect(f.saved()).toEqual(old); expect(f.canonical).toEqual([]); expect(f.raw).toEqual([])
  })
  it("allows idle old history but does not relabel unknown Raw mappings as acknowledged under the new policy", async () => {
    const f = await fixture(); f.seed(checkpoint([oldRaw()])); f.select("b")
    f.pages(() => ({ protocolVersion: AdapterProtocolVersion, nextCursor: "cursor-1", hasMore: false, observations: [] }))
    expect((await f.cycle()).failures).toEqual([])
    expect(f.saved()).toMatchObject({ policyId: f.b.policyId, deliveryPending: false })
    expect(f.saved()?.rawObjects[0]?.policyId).toBeUndefined()
    f.pages(() => page(2, bytes(content)))
    expect((await f.cycle()).failures[0]?.message).toContain("unversioned legacy Raw object")
    expect(f.canonical).toEqual([]); expect(f.raw).toEqual([])
  })
  it("fails explicitly if an unversioned first object has accepted bytes but no local mapping", async () => {
    const f = await fixture(); f.seed({ ...checkpoint(), cursor: "old-start" }); f.select("b")
    f.accepted.set("1:0", content)
    expect((await f.cycle()).failures[0]).toMatchObject({ reason: "transport", message: expect.stringContaining("conflicts") })
    expect(f.raw[0]!.sourceChunkId).toContain(f.b.policyId!)
    expect(f.raw[0]!.content).not.toContain(secret)
    expect(f.accepted.get("1:0")).toBe(content)
    expect(f.saved()).toMatchObject({ cursor: "old-start", deliveryPending: true, rawObjects: [] })
  })
  it("does not treat an empty source page as proof that pending content was accepted", async () => {
    const f = await fixture(); f.loseCanonical(); await f.cycle()
    const saved = structuredClone(f.saved())
    f.pages(() => ({ protocolVersion: AdapterProtocolVersion, nextCursor: "empty", hasMore: false, observations: [] }))
    expect((await f.cycle()).failures[0]?.message).toContain("empty page is not a receipt")
    expect(f.saved()).toEqual(saved)
  })
  it("cannot resume policy-aware progress through an unversioned redactor", async () => {
    const f = await fixture(); await f.cycle()
    const saved = structuredClone(f.saved()), sent = f.canonical.length
    f.unversioned()
    expect((await f.cycle()).failures[0]?.message).toContain("requires a current compiled policy")
    expect(f.saved()).toEqual(saved); expect(f.canonical).toHaveLength(sent)
  })
  it("does not infer acknowledged completion from a missing policy-aware outcome marker", async () => {
    const f = await fixture(); f.seed({ ...checkpoint(), policyId: f.a.policyId! })
    const saved = structuredClone(f.saved())
    expect((await f.cycle()).failures[0]?.message).toContain("lacks its delivery outcome marker")
    expect(f.saved()).toEqual(saved); expect(f.canonical).toEqual([]); expect(f.raw).toEqual([])
  })
  it("does not erase uncertainty when a lost Raw response is followed by raw_disabled", async () => {
    const f = await fixture(); f.loseThenDisableRaw()
    expect((await f.cycle()).failures[0]?.message).toContain("disabled after an uncertain")
    expect(f.raw).toHaveLength(2)
    expect(f.saved()).toMatchObject({ cursor: null, deliveryPending: true, rawObjects: [] })
    const saved = structuredClone(f.saved()); f.select("b")
    expect((await f.cycle()).failures[0]?.message).toContain("unknown outcome")
    expect(f.saved()).toEqual(saved); expect(f.raw).toHaveLength(2)
  })
  it("preserves a previous-job uncertain Raw outcome when the next response is raw_disabled", async () => {
    const f = await fixture(); f.loseRaw(); await f.cycle(); f.disableRaw()
    expect((await f.cycle()).failures[0]?.message).toContain("disabled after an uncertain")
    expect(f.saved()).toMatchObject({ cursor: null, deliveryPending: true, rawObjects: [] })
  })
  it("can skip Raw on a first definitive disabled response without claiming Raw receipts", async () => {
    const f = await fixture(); f.disableRaw()
    expect((await f.cycle()).failures).toEqual([])
    expect(f.saved()).toMatchObject({ cursor: "cursor-1", deliveryPending: false, rawObjects: [] })
    expect(f.accepted.size).toBe(0)
  })
  it("does not clear prior uncertainty when Raw is already disabled before restart collection", async () => {
    const f = await fixture(); f.loseRaw(); await f.cycle()
    const saved = structuredClone(f.saved()), reads = f.reads(), canonical = f.canonical.length
    f.rawPolicy(false)
    expect((await f.cycle()).failures[0]?.message).toContain("Closing Raw is not a receipt")
    expect(f.saved()).toEqual(saved); expect(f.reads()).toBe(reads); expect(f.canonical).toHaveLength(canonical)
  })
  it.each(["adapter", "transport"] as const)("masks %s error messages using the pinned job policy before reporting", async failure => {
    const f = await fixture(); f.select("b"); failure === "adapter" ? f.failOpen() : f.loseCanonical()
    const report = await f.cycle()
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]!.message).toContain("[REDACTED]")
    expect(JSON.stringify(report)).not.toContain(secret)
  })
})
