import {
  AdapterCollectionLimits,
  type AdapterCollectionLimitValues,
  AdapterProtocolVersion,
  CanonicalProfileVersion3,
  type AdapterCollectionPage,
  type AdapterSourceProgress,
  type LegacyAdapterRuntime
} from "@atape/domain"
import { randomUUID } from "node:crypto"
import { deflateRawSync } from "node:zlib"
import { appendFile, mkdir, mkdtemp, realpath, readFile, rename, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createAtapeAdapter } from "./index.ts"

const temporaryDirectories: Array<string> = []
const previousCodexHome = process.env.ATAPE_CODEX_HOME

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.ATAPE_CODEX_HOME
  else process.env.ATAPE_CODEX_HOME = previousCodexHome
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("Codex Adapter", () => {
  it("refuses a Host without explicit nullable-clock support before opening sources", async () => {
    await expect(createAtapeAdapter({ protocolVersion: AdapterProtocolVersion,
      adapter: { id: "codex", version: "0.1.0" }, project: { id: "project", type: "directory", path: "/missing-atape-clock-test" },
      signal: AbortSignal.timeout(5_000) })).rejects.toThrow("explicit source clock quality")
  })

  it("opens lazily and retries a failed or cancelled first collection", async () => {
    const root = await makeEmptyFixture()
    const laterProject = join(root.workspace, "later-project")
    await writeJsonl(join(root.sessionsDirectory, "lazy.jsonl"), [sessionMeta({ id: "lazy", cwd: laterProject }),
      itemCompleted("2026-09-05T00:01:00Z", "lazy", { type: "AgentMessage", id: "answer", content: [{ type: "output_text", text: "ready" }] })])
    const runtime = await openAdapter(laterProject, "directory")
    expect(runtime.canonicalProfileVersion).toBe(CanonicalProfileVersion3)
    await expect(collect(runtime)).rejects.toThrow("Could not open the Codex archive")
    await mkdir(laterProject)
    const cancellation = new AbortController()
    cancellation.abort()
    await expect(runtime.collect({ protocolVersion: AdapterProtocolVersion, cursor: null, limits: AdapterCollectionLimits,
      rawProgress: [], signal: cancellation.signal })).rejects.toBeDefined()
    expect(requiredObservation(await collect(runtime)).events.map(event => event.sourceEventId)).toEqual(["answer"])
    await runtime.close?.()
    await expect(collect(runtime)).rejects.toBeDefined()
  })

  it("cancels an in-flight first source read and retries through the same runtime", async () => {
    const root = await makeEmptyFixture()
    await writeJsonl(join(root.sessionsDirectory, "cancel.jsonl"), [sessionMeta({ id: "cancel", cwd: root.project }),
      itemCompleted("2026-09-05T00:01:00Z", "cancel", { type: "AgentMessage", id: "answer", content: [{ type: "output_text", text: "ready" }] })])
    let announceStarted: () => void = () => undefined
    const started = new Promise<void>(resolve => { announceStarted = resolve })
    let firstRead = true, cancelledSource = false
    const runtime = await openAdapter(root.project, "git", { version: "atape.git-attribution.v1", resolve: async (_source, signal) => {
      if (!firstRead) return "included"
      firstRead = false
      announceStarted()
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { cancelledSource = true; resolve() }, { once: true }))
      return "excluded"
    } })
    const cancellation = new AbortController()
    const first = runtime.collect({ protocolVersion: AdapterProtocolVersion, cursor: null, limits: AdapterCollectionLimits,
      rawProgress: [], signal: cancellation.signal })
    await started
    cancellation.abort()
    await expect(first).rejects.toBeDefined()
    expect(cancelledSource).toBe(true)
    expect(requiredObservation(await collect(runtime)).events.map(event => event.sourceEventId)).toEqual(["answer"])
  })

  it.each(["item_completed", "response_item", "event_msg"] as const)(
    "keeps missing and invalid clocks in %s records in physical source order", async format => {
      const root = await makeEmptyFixture()
      const message = (id: string, timestamp: unknown) => format === "item_completed"
        ? { timestamp, type: "event_msg", payload: { type: "item_completed", thread_id: "clock", item: { type: "AgentMessage", id, content: [{ type: "output_text", text: id }] } } }
        : format === "response_item"
          ? { timestamp, type: "response_item", payload: { type: "message", id, role: "assistant", content: [{ type: "output_text", text: id }] } }
          : { timestamp, type: "event_msg", payload: { type: "agent_message", id, message: id } }
      const path = join(root.sessionsDirectory, "clock.jsonl")
      await writeJsonl(path, [sessionMeta({ id: "clock", cwd: root.project, timestamp: "invalid metadata clock" }),
        message("first", "2026-09-05T00:03:00Z"), message("missing", undefined), message("null", null),
        message("invalid", "bad clock"), message("number", 100), message("empty", ""),
        message("calendar", "2026-02-30T00:00:00Z"), message("zero", "0001-01-01T00:00:00.000000999Z"),
        message("last", "2026-09-05T00:01:00Z")])
      const filesystemClock = new Date("2000-01-01T00:00:00Z")
      await utimes(path, filesystemClock, filesystemClock)
      const runtime = await openAdapter(root.project, "directory")
      let cursor: string | null = null
      const events: AdapterCollectionPage["observations"][number]["events"][number][] = []
      let progress: ReadonlyArray<AdapterSourceProgress> = []
      for (let i = 0; i < 30; i++) {
        const page = await collect(runtime, cursor, progress, { ...AdapterCollectionLimits, eventsPerObservation: 2 })
        for (const observation of page.observations) {
          events.push(...observation.events)
          expect(observation.session.updatedAt).toBe("2026-09-05T00:03:00Z")
          expect(observation.observedAt).toBe(filesystemClock.toISOString())
          progress = mergeProgress(progress, observation.session.sourceSessionId, observation.rawSegments)
        }
        cursor = page.nextCursor
        if (!page.hasMore) break
      }
      expect(events.map(event => event.sourceEventId)).toEqual(["first", "missing", "null", "invalid", "number", "empty", "calendar", "zero", "last"])
      expect(events.map(event => event.occurredAt)).toEqual(["2026-09-05T00:03:00Z", null, null, null, null, null, null, null, "2026-09-05T00:01:00Z"])
      expect([...events].sort((a, b) => a.sourceOrder - b.sourceOrder || a.eventIndex - b.eventIndex).map(event => event.sourceEventId))
        .toEqual(events.map(event => event.sourceEventId))
      expect(events.every(event => event.orderFidelity === "native" && event.fidelity === "native" && event.rawRef._tag === "object")).toBe(true)
      const laterFilesystemClock = new Date("2001-01-01T00:00:00Z")
      await utimes(path, laterFilesystemClock, laterFilesystemClock)
      const changed = requiredObservation(await collect(await openAdapter(root.project, "directory"), cursor, progress))
      expect(changed.session.updatedAt).toBe("2026-09-05T00:03:00Z")
      expect(changed.rawSegments).toEqual([])
    }
  )

  it("keeps wholly unknown Session and spawn clocks null and preserves original attribution metadata", async () => {
    const root = await makeEmptyFixture()
    const meta = sessionMeta({ id: "unknown", cwd: root.project, timestamp: "broken source time" })
    const child = sessionMeta({ id: "child", sessionId: "unknown", parentThreadId: "unknown", cwd: root.project })
    await writeJsonl(join(root.sessionsDirectory, "unknown.jsonl"), [meta,
      { ...itemCompleted("unused", "unknown", { type: "AgentMessage", id: "unknown-message", content: [{ type: "output_text", text: "retained" }] }), timestamp: undefined }])
    await writeJsonl(join(root.sessionsDirectory, "child.jsonl"), [{ ...child, timestamp: undefined, payload: { ...child.payload, timestamp: undefined } }])
    const origins = new Map<string, string>()
    const runtime = await openAdapter(root.project, "git", { version: "atape.git-attribution.v1",
      resolve: async source => { origins.set(source.sourceId, source.originKey); return "included" } })
    const observation = requiredObservation(await collect(runtime))
    expect(observation.session.updatedAt).toBeNull()
    expect(observation.events.find(event => event.sourceEventId === "unknown-message")?.occurredAt).toBeNull()
    expect(observation.events.find(event => event.sourceEventId === "spawn-child")).toMatchObject({ occurredAt: null, fidelity: "derived", orderFidelity: "derived" })
    expect(origins.get("unknown")).toBe(JSON.stringify(["unknown", "broken source time"]))
    expect(origins.get("child")).toBe(JSON.stringify(["unknown", null]))
  })

  it("freezes Session recency and the provider title clock while continuing an unchanged snapshot", async () => {
    const root = await makeEmptyFixture()
    await writeJsonl(join(root.sessionsDirectory, "frozen.jsonl"), [sessionMeta({ id: "frozen", cwd: root.project }),
      ...[1, 2, 3].map(index => itemCompleted(`2026-09-05T00:0${index}:00Z`, "frozen", { type: "AgentMessage", id: `event-${index}`, content: [{ type: "output_text", text: "answer" }] }))])
    const titleIndex = join(root.codexHome, "session_index.jsonl")
    await writeJsonl(titleIndex, [sessionTitle("frozen", "Frozen title", "2026-09-05T00:04:00Z")])
    const runtime = await openAdapter(root.project, "directory")
    const first = await collect(runtime, null, [], { ...AdapterCollectionLimits, eventsPerObservation: 1 })
    const initial = requiredObservation(first)
    expect(initial.session.updatedAt).toBe("2026-09-05T00:04:00Z")
    await appendFile(titleIndex, JSON.stringify(sessionTitle("frozen", "Later title", "2026-09-05T00:05:00Z")) + "\n")
    const continued = requiredObservation(await collect(await openAdapter(root.project, "directory"), first.nextCursor, [],
      { ...AdapterCollectionLimits, eventsPerObservation: 1 }))
    expect(continued.session).toMatchObject({ revision: initial.session.revision, title: "Frozen title", updatedAt: "2026-09-05T00:04:00Z" })
  })

  it("retains known source clocks at microsecond precision instead of the unknown zero instant", async () => {
    const root = await makeEmptyFixture()
    await writeJsonl(join(root.sessionsDirectory, "precision.jsonl"), [sessionMeta({ id: "precision", cwd: root.project, timestamp: "unknown" }),
      ...["0001-01-01T00:00:00.000001Z", "0001-01-01T00:00:00.000002Z"].map((at, index) => itemCompleted(at, "precision",
        { type: "AgentMessage", id: `event-${index}`, content: [{ type: "output_text", text: "known" }] }))])
    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))
    expect(observation.session.updatedAt).toBe("0001-01-01T00:00:00.000002Z")
    expect(observation.events.map(event => event.occurredAt)).toEqual(["0001-01-01T00:00:00.000001Z", "0001-01-01T00:00:00.000002Z"])
  })

  it("keeps assigned file namespaces when metadata changes the derived scan order", async () => {
    const root = await makeEmptyFixture()
    const firstPath = join(root.sessionsDirectory, "first-part.jsonl")
    const secondPath = join(root.sessionsDirectory, "second-part.jsonl")
    const records = (id: string, at: string) => [sessionMeta({ id: "many", cwd: root.project, timestamp: at }),
      itemCompleted("2026-09-05T00:03:00Z", "many", { type: "AgentMessage", id, content: [{ type: "output_text", text: id }] })]
    await writeJsonl(firstPath, records("first", "2026-09-05T00:01:00Z"))
    await writeJsonl(secondPath, records("second", "2026-09-05T00:02:00Z"))
    const runtime = await openAdapter(root.project, "directory")
    const first = await collect(runtime, null, [], AdapterCollectionLimits, false)
    const initialEvents = requiredObservation(first).events
    expect(initialEvents.map(event => event.sourceEventId)).toEqual(["first", "second"])
    await writeJsonl(secondPath, records("second", "2026-09-05T00:00:00Z"))
    const changedTime = new Date(Date.now() + 1_000)
    await utimes(secondPath, changedTime, changedTime)
    const changed = requiredObservation(await collect(await openAdapter(root.project, "directory"), first.nextCursor, [], AdapterCollectionLimits, false))
    expect(changed.events.map(event => event.sourceEventId)).toEqual(["second", "first"])
    expect(changed.events.map(event => event.sourceOrder)).toEqual([initialEvents[1]?.sourceOrder, initialEvents[0]?.sourceOrder])
    expect([...changed.events].sort((a, b) => a.sourceOrder - b.sourceOrder).map(event => event.sourceEventId)).toEqual(["first", "second"])
    expect(changed.events.every(event => event.orderFidelity === "derived" && event.fidelity === "native")).toBe(true)
  })

  it("gives separate UserMessage records distinct stable input group orders", async () => {
    const root = await makeEmptyFixture()
    const path = join(root.sessionsDirectory, "inputs.jsonl")
    const input = (id: string) => ({ ...itemCompleted("ignored", "inputs",
      { type: "UserMessage", id, content: [{ type: "input_text", text: id }] }), timestamp: null })
    await writeJsonl(path, [sessionMeta({ id: "inputs", cwd: root.project }), input("one"), input("two")])
    const runtime = await openAdapter(root.project, "directory")
    const first = await collect(runtime, null, [], AdapterCollectionLimits, false)
    const events = requiredObservation(first).events
    expect(events.map(event => event.update.sessionUpdate)).toEqual(["user_message_chunk", "user_message_chunk"])
    expect(new Set(events.map(event => event.sourceOrder)).size).toBe(2)
    expect(events[0]!.sourceOrder).toBeLessThan(events[1]!.sourceOrder)
    expect(events.every(event => Number.isSafeInteger(event.sourceOrder) && event.orderFidelity === "native")).toBe(true)
    await appendFile(path, JSON.stringify(input("three")) + "\n")
    const changedTime = new Date(Date.now() + 1_000)
    await utimes(path, changedTime, changedTime)
    const appended = requiredObservation(await collect(await openAdapter(root.project, "directory"), first.nextCursor, [], AdapterCollectionLimits, false))
    expect(appended.events.map(event => event.sourceEventId)).toEqual(["three"])
    expect(appended.events[0]!.sourceOrder).toBeGreaterThan(events[1]!.sourceOrder)
    const replay = requiredObservation(await collect(await openAdapter(root.project, "directory"), null, [], AdapterCollectionLimits, false))
    expect(replay.events.slice(0, 2).map(event => event.sourceOrder)).toEqual(events.map(event => event.sourceOrder))
  })

  it("reconstructs the same legacy Raw capture basis from an unacknowledged cursor", async () => {
    const root = await makeEmptyFixture()
    const path = join(root.sessionsDirectory, "raw-retry.jsonl")
    await writeJsonl(path, [sessionMeta({ id: "raw-retry", cwd: root.project }), itemCompleted("2026-09-05T00:01:00Z", "raw-retry",
      { type: "AgentMessage", id: "answer", content: [{ type: "output_text", text: "same bytes" }] })])
    const snapshotBasis = new Date("2020-01-01T00:00:00Z")
    await utimes(path, snapshotBasis, snapshotBasis)
    const canonical = await collect(await openAdapter(root.project, "directory"))
    const first = requiredObservation(await collect(await openAdapter(root.project, "directory"), canonical.nextCursor))
    // A server may have accepted these bytes without its reply reaching the
    // Host. Reconstruct from the last acknowledged cursor and no invented receipt.
    const retried = requiredObservation(await collect(await openAdapter(root.project, "directory"), canonical.nextCursor))
    expect(first.rawSegments.length).toBeGreaterThan(0)
    expect(retried.rawSegments).toEqual(first.rawSegments)
    expect(first.observedAt).toBe(snapshotBasis.toISOString())
    expect(retried.observedAt).toBe(first.observedAt)
    expect(retried.session.updatedAt).toBe("2026-09-05T00:01:00Z")
  })

  it("retains deleted file namespaces and never reuses them for new sources", async () => {
    const root = await makeEmptyFixture()
    const firstPath = join(root.sessionsDirectory, "retained-first.jsonl")
    const secondPath = join(root.sessionsDirectory, "retained-second.jsonl")
    const records = (id: string, at: string) => [sessionMeta({ id: "retained", cwd: root.project, timestamp: at }),
      itemCompleted(at, "retained", { type: "UserMessage", id, content: [{ type: "input_text", text: id }] })]
    await writeJsonl(firstPath, records("first", "2026-09-05T00:01:00Z"))
    await writeJsonl(secondPath, records("second", "2026-09-05T00:02:00Z"))
    const first = await collect(await openAdapter(root.project, "directory"), null, [], AdapterCollectionLimits, false)
    const initialEvents = requiredObservation(first).events
    const firstRegistry = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")).sourceRanks
    await rm(firstPath)
    const thirdPath = join(root.sessionsDirectory, "new-first-in-scan.jsonl")
    await writeJsonl(thirdPath, records("third", "2026-09-05T00:00:00Z"))
    const changedTime = new Date(Date.now() + 1_000)
    await utimes(thirdPath, changedTime, changedTime)
    const changed = await collect(await openAdapter(root.project, "directory"), first.nextCursor, [], AdapterCollectionLimits, false)
    const changedEvents = requiredObservation(changed).events
    expect(changedEvents.find(event => event.sourceEventId === "second")?.sourceOrder).toBe(initialEvents[1]?.sourceOrder)
    expect(changedEvents.find(event => event.sourceEventId === "third")!.sourceOrder).toBeGreaterThan(Math.max(...initialEvents.map(event => event.sourceOrder)))
    const nextRegistry = JSON.parse(Buffer.from(changed.nextCursor!, "base64url").toString("utf8")).sourceRanks
    expect(nextRegistry[0].sources).toHaveLength(3)
    expect(nextRegistry[0].sources.slice(0, 2)).toEqual(firstRegistry[0].sources)
    expect(new Set(nextRegistry[0].sources.map((source: { rank: number }) => source.rank)).size).toBe(3)
  })

  it("allocates a new namespace when the same basename is recreated with a new source generation", async () => {
    const root = await makeEmptyFixture()
    const path = join(root.sessionsDirectory, "recreated.jsonl")
    const replacementPath = join(root.sessionsDirectory, "replacement.jsonl")
    const records = (id: string) => [sessionMeta({ id: "recreated", cwd: root.project }),
      { ...itemCompleted("unused", "recreated", { type: "UserMessage", id, content: [{ type: "input_text", text: id }] }), timestamp: null }]
    await writeJsonl(path, records("before"))
    const first = await collect(await openAdapter(root.project, "directory"), null, [], AdapterCollectionLimits, false)
    const previous = requiredObservation(first).events[0]!
    // Both files exist together, so the replacement has a distinct inode even
    // on a filesystem which quickly reuses removed files' inode numbers.
    await writeJsonl(replacementPath, records("after"))
    await rm(path)
    await rename(replacementPath, path)
    const changedTime = new Date(Date.now() + 1_000)
    await utimes(path, changedTime, changedTime)
    const changed = await collect(await openAdapter(root.project, "directory"), first.nextCursor, [], AdapterCollectionLimits, false)
    const replacement = requiredObservation(changed).events[0]!
    expect(replacement.sourceEventId).toBe("after")
    expect(replacement.rawRef).toEqual(previous.rawRef)
    expect(replacement.sourceOrder).toBe(previous.sourceOrder + 2 ** 39)
    expect(replacement.orderFidelity).toBe("derived")
    const registry = JSON.parse(Buffer.from(changed.nextCursor!, "base64url").toString("utf8")).sourceRanks[0].sources
    expect(registry).toHaveLength(2)
    expect(registry[0].sourceObjectId).toBe(registry[1].sourceObjectId)
    expect(registry[0].generation).not.toBe(registry[1].generation)
  })

  it("reports an exhausted retained namespace without emitting colliding records", async () => {
    const root = await makeEmptyFixture()
    const records = (id: string) => [sessionMeta({ id: "full", cwd: root.project }), itemCompleted("2026-09-05T00:01:00Z", "full",
      { type: "UserMessage", id, content: [{ type: "input_text", text: id }] })]
    await writeJsonl(join(root.sessionsDirectory, "full.jsonl"), records("first"))
    const first = await collect(await openAdapter(root.project, "directory"), null, [], AdapterCollectionLimits, false)
    const state = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"))
    state.sourceRanks[0].sources.push(...Array.from({ length: 9_999 }, (_, index) => ({ sourceObjectId: `retained-${index}`, generation: `generation-${index}`, rank: index + 2 })))
    const secondPath = join(root.sessionsDirectory, "second-full.jsonl")
    await writeJsonl(secondPath, records("second"))
    const changedTime = new Date(Date.now() + 1_000)
    await utimes(secondPath, changedTime, changedTime)
    const rejected = await collect(await openAdapter(root.project, "directory"), Buffer.from(JSON.stringify(state)).toString("base64url"), [], AdapterCollectionLimits, false)
    expect(rejected.observations).toEqual([])
    expect(rejected.sourceFailures).toContainEqual(expect.objectContaining({ reason: "limit" }))
    await writeJsonl(join(root.sessionsDirectory, "healthy.jsonl"), [sessionMeta({ id: "healthy", cwd: root.project }),
      itemCompleted("2026-09-05T00:01:00Z", "healthy", { type: "AgentMessage", id: "healthy-answer", content: [{ type: "output_text", text: "still eligible" }] })])
    const continued = await collect(await openAdapter(root.project, "directory"), rejected.nextCursor, [], AdapterCollectionLimits, false)
    expect(requiredObservation(continued).session.sourceSessionId).toBe("healthy")
  })

  it("rejects a source snapshot beyond the fixed byte namespace before projecting it", async () => {
    const root = await makeEmptyFixture()
    await writeJsonl(join(root.sessionsDirectory, "offset-limit.jsonl"), [sessionMeta({ id: "offset-limit", cwd: root.project }),
      itemCompleted("2026-09-05T00:01:00Z", "offset-limit", { type: "UserMessage", id: "input", content: [{ type: "input_text", text: "bounded" }] })])
    const stalled = await collect(await openAdapter(root.project, "directory"), null, [], { ...AdapterCollectionLimits, eventsPerObservation: 0 }, false)
    const state = JSON.parse(Buffer.from(stalled.nextCursor!, "base64url").toString("utf8"))
    state.active.files[0].size = 2 ** 39
    const rejected = await collect(await openAdapter(root.project, "directory"), Buffer.from(JSON.stringify(state)).toString("base64url"), [], AdapterCollectionLimits, false)
    expect(rejected.observations).toEqual([])
    expect(rejected.sourceFailures).toContainEqual(expect.objectContaining({ reason: "limit" }))
  })

  it.each(["canonical", "raw"] as const)("upgrades an active projection 4 %s cursor without losing its Raw receipt", async phase => {
    const root = await makeEmptyFixture()
    const path = join(root.sessionsDirectory, "upgrade.jsonl")
    await writeJsonl(path, [sessionMeta({ id: "upgrade", cwd: root.project }),
      ...[1, 2, 3].map(index => itemCompleted(`2026-09-05T00:0${index}:00Z`, "upgrade",
        { type: "AgentMessage", id: `event-${index}`, content: [{ type: "output_text", text: "answer".repeat(100) }] }))])
    const runtime = await openAdapter(root.project, "directory")
    const limits = { ...AdapterCollectionLimits, eventsPerObservation: phase === "canonical" ? 1 : 500,
      rawBytesPerObservation: 1200, rawSegmentBytes: 1200 }
    const first = await collect(runtime, null, [], limits)
    const page = phase === "canonical" ? first : await collect(runtime, first.nextCursor, [], limits)
    const state = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"))
    expect(state.active.phase).toBe(phase)
    state.eventProjectionVersion = 4
    state.active.revision += 100
    const previousRevision = state.active.revision
    delete state.active.sourceUpdatedAt
    delete state.active.providerTitleUpdatedAt
    const observation = requiredObservation(page)
    const progress = rawProgress(observation.session.sourceSessionId, observation.rawSegments)
    const upgraded = requiredObservation(await collect(await openAdapter(root.project, "directory"),
      Buffer.from(JSON.stringify(state)).toString("base64url"), progress, limits))
    expect(upgraded.session.revision).toBeGreaterThan(previousRevision)
    expect(upgraded.session.updatedAt).toBe("2026-09-05T00:03:00Z")
    if (phase === "canonical") {
      expect(upgraded.events.map(event => event.sourceEventId)).toEqual(["event-1"])
      expect(upgraded.events[0]?.projectionRevision).toBe(5)
    } else {
      expect(upgraded.events).toEqual([])
      expect(upgraded.rawSegments[0]?.sourceOffset).toBe(progress[0]?.sourceOffset)
      expect(upgraded.rawSegments[0]?.sourceGeneration).toBe(observation.rawSegments[0]?.sourceGeneration)
    }
  })

  it("reads owned per-response usage without summing repeated or cumulative snapshots", async () => {
    const root = await makeEmptyFixture()
    const counters = { input_tokens: 100, output_tokens: 10, cached_input_tokens: 40, cache_write_input_tokens: 60, reasoning_output_tokens: 5, total_tokens: 110 }
    const usage = { timestamp: "2026-09-09T00:00:00Z", type: "token_usage_record", payload: { thread_id: "usage", session_id: "usage", turn_id: "turn", root_turn_id: "turn", response_id: "response", usage: counters, turn_token_usage: counters, thread_token_usage: counters } }
    await writeJsonl(join(root.sessionsDirectory, "usage.jsonl"), [sessionMeta({ id: "usage", cwd: root.project }),
      { type: "turn_context", payload: { turn_id: "turn", model: "model-a" } },
      itemCompleted("2026-09-09T00:00:00Z", "usage", { type: "AgentMessage", id: "answer", content: [{ type: "output_text", text: "done" }] }),
      usage, usage,
      { ...usage, payload: { ...usage.payload, thread_id: "copied-parent", response_id: "other" } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: counters, total_token_usage: counters } } }])
    const runtime = await openAdapter(root.project, "directory")
    let cursor: string | null = null
    const samples = []
    for (let i = 0; i < 20; i++) {
      const page = await collect(runtime, cursor, [], { ...AdapterCollectionLimits, eventsPerObservation: 1 }, false)
      samples.push(...page.observations.flatMap(o => o.usage ?? [])); cursor = page.nextCursor
      if (!page.hasMore) break
    }
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({ sourceThreadId: "usage", sourceUsageId: "response", inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 60, model: "model-a" })
  })
  it("recovers Raw rejected after Canonical was checkpointed", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "denied.jsonl")
    await writeJsonl(file, [sessionMeta({ id: "denied", cwd: root.project }),
      itemCompleted("2026-09-09T00:00:00Z", "denied", { type: "AgentMessage", id: "answer", content: [{ type: "output_text", text: "captured" }] })])
    const runtime = await openAdapter(root.project, "directory")
    let cursor: string | null = null
    let offered = false
    for (let i = 0; i < 20; i++) {
      const page = await collect(runtime, cursor)
      cursor = page.nextCursor
      if (page.observations.some(o => o.rawSegments.length > 0)) { offered = true; break }
    }
    expect(offered).toBe(true)
    // The server refused Raw; the host retained Canonical and no Raw receipt.
    const off = await collect(runtime, cursor, [], AdapterCollectionLimits, false)
    cursor = off.nextCursor
    let progress: ReadonlyArray<AdapterSourceProgress> = []
    let raw = ""
    for (let i = 0; i < 20; i++) {
      const page = await collect(runtime, cursor, progress)
      for (const o of page.observations) {
        expect(page.nextCursor).not.toBe(cursor)
        raw += o.rawSegments.map(s => s.content).join("")
        progress = mergeProgress(progress, o.session.sourceSessionId, o.rawSegments)
      }
      cursor = page.nextCursor
      if (!page.hasMore) break
    }
    expect(raw).toBe(await readFile(file, "utf8"))
  })

  it("collects Canonical with Raw disabled and backfills Raw when enabled", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "policy.jsonl")
    await writeJsonl(file, [sessionMeta({ id: "policy", cwd: root.project }),
      itemCompleted("2026-09-09T00:00:00Z", "policy", { type: "AgentMessage", id: "answer", content: [{ type: "output_text", text: "captured without Raw" }] })])
    const runtime = await openAdapter(root.project, "directory")
    let cursor: string | null = null
    const events: string[] = []
    for (let i = 0; i < 20; i++) {
      const page = await collect(runtime, cursor, [], AdapterCollectionLimits, false)
      for (const o of page.observations) { events.push(...o.events.map(e => e.sourceEventId)); expect(o.rawSegments).toEqual([]) }
      expect(page.progress?.pendingRawBytes).toBe(0)
      cursor = page.nextCursor
      if (!page.hasMore) break
    }
    expect(events).toEqual(["answer"])
    let progress: ReadonlyArray<AdapterSourceProgress> = []
    let raw = ""
    for (let i = 0; i < 20; i++) {
      const page = await collect(runtime, cursor, progress)
      for (const o of page.observations) {
        expect(o.events).toEqual([])
        raw += o.rawSegments.map(s => s.content).join("")
        progress = mergeProgress(progress, o.session.sourceSessionId, o.rawSegments)
      }
      cursor = page.nextCursor
      if (!page.hasMore) break
    }
    expect(raw).toBe(await readFile(file, "utf8"))
  })

  it("yields a large Session to new work and retains every unfinished page across restarts", async () => {
    const root = await makeEmptyFixture()
    const large = join(root.sessionsDirectory, "large.jsonl")
    await writeJsonl(large, [sessionMeta({ id: "large", cwd: root.project }), ...Array.from({ length: 30 }, (_, i) =>
      itemCompleted("2026-09-05T00:01:00Z", "large", { type: "AgentMessage", id: `large-${i}`, content: [{ type: "output_text", text: `answer ${i}` }] }))])
    const limits = { ...AdapterCollectionLimits, eventsPerObservation: 1 }
    let runtime = await openAdapter(root.project, "directory")
    let page = await collect(runtime, null, [], limits)
    const ids = page.observations.flatMap(o => o.events.map(e => e.sourceEventId))
    await writeJsonl(join(root.sessionsDirectory, "new.jsonl"), [sessionMeta({ id: "new", cwd: root.project }),
      itemCompleted("2026-09-09T00:01:00Z", "new", { type: "AgentMessage", id: "new-answer", content: [{ type: "output_text", text: "new answer" }] })])
    let progress: ReadonlyArray<AdapterSourceProgress> = []
    let newPage = -1
    for (let i = 1; i < 100; i++) {
      runtime = await openAdapter(root.project, "directory")
      page = await collect(runtime, page.nextCursor, progress, limits)
      for (const observation of page.observations) {
        for (const event of observation.events) { ids.push(event.sourceEventId); if (event.sourceEventId === "new-answer") newPage = i }
        progress = mergeProgress(progress, observation.session.sourceSessionId, observation.rawSegments)
      }
      if (!page.hasMore) break
    }
    expect(newPage).toBeGreaterThan(0)
    expect(newPage).toBeLessThanOrEqual(4)
    expect(ids).toHaveLength(31)
    expect(new Set(ids).size).toBe(31)
    expect(page.hasMore).toBe(false)
  })

  it("continues older Canonical history while multiple newer Sessions stay busy", async () => {
    const root = await makeEmptyFixture()
    const writeSession = async (id: string, at: string) => {
      const path = join(root.sessionsDirectory, `${id}.jsonl`)
      await writeJsonl(path, [sessionMeta({ id, cwd: root.project }), ...Array.from({ length: 40 }, (_, i) =>
        itemCompleted(at, id, { type: "AgentMessage", id: `${id}-${i}`, content: [{ type: "output_text", text: `${id} answer ${i}` }] }))])
      await utimes(path, new Date(at), new Date(at))
    }
    await writeSession("old", "2026-09-05T00:00:00Z")
    const limits = { ...AdapterCollectionLimits, eventsPerObservation: 1 }
    const runtime = await openAdapter(root.project, "directory")
    let page = await collect(runtime, null, [], limits)
    await writeSession("hot-a", "2026-09-09T00:00:00Z")
    await writeSession("hot-b", "2026-09-09T00:01:00Z")
    const ids = page.observations.flatMap(o => o.events.map(e => e.sourceEventId))
    for (let i = 0; i < 20; i++) {
      page = await collect(runtime, page.nextCursor, [], limits)
      ids.push(...page.observations.flatMap(o => o.events.map(e => e.sourceEventId)))
    }
    expect(ids).toContain("hot-a-0")
    expect(ids).toContain("hot-b-0")
    expect(ids).toContain("old-4")
  })

  it("isolates a broken large record and resumes it after repair without forgetting other Sessions", async () => {
    const root = await makeEmptyFixture()
    const bad = join(root.sessionsDirectory, "bad.jsonl")
    await writeJsonl(bad, [sessionMeta({ id: "bad", cwd: root.project })])
    await appendFile(bad, "x".repeat(16 * 1024 * 1024 + 1))
    await writeJsonl(join(root.sessionsDirectory, "good.jsonl"), [sessionMeta({ id: "good", cwd: root.project }),
      itemCompleted("2026-09-05T00:01:00Z", "good", { type: "AgentMessage", id: "good-answer", content: [{ type: "output_text", text: "good" }] })])
    const runtime = await openAdapter(root.project, "directory")
    let page = await collect(runtime)
    expect(page.sourceFailures).toContainEqual({ source: await realpath(bad), reason: "limit" })
    page = await collect(runtime, page.nextCursor)
    expect(requiredObservation(page).events.map(e => e.sourceEventId)).toEqual(["good-answer"])
    await writeJsonl(bad, [sessionMeta({ id: "bad", cwd: root.project }),
      itemCompleted("2026-09-05T00:01:00Z", "bad", { type: "AgentMessage", id: "repaired-answer", content: [{ type: "output_text", text: "repaired" }] })])
    const repaired = await collect(runtime, page.nextCursor)
    expect(requiredObservation(repaired).events.map(e => e.sourceEventId)).toEqual(["repaired-answer"])
  })

  it("reprojects same-size rewrites rather than skipping them at an old byte offset", async () => {
    const fixture = await makeFixture()
    const runtime = await openAdapter(fixture.project, "directory")
    const first = await collect(runtime)
    const raw = await collect(runtime, first.nextCursor)
    const observation = requiredObservation(raw)
    const progress = rawProgress(observation.session.sourceSessionId, observation.rawSegments)
    const before = await readFile(fixture.rootFile, "utf8")
    expect(before).toContain("Why were there two charges?")
    await writeFile(fixture.rootFile, before.replace("Why were there two charges?", "Why were there SIX charges?"))
    const modified = new Date("2026-09-09T00:02:00Z")
    await utimes(fixture.rootFile, modified, modified)
    const changed = await collect(runtime, raw.nextCursor, progress)
    expect(requiredObservation(changed).events.map(e => e.sourceEventId)).toContain("user-1")
  })

  it("projects a Codex session and its subagent while keeping Raw records separate", async () => {
    const fixture = await makeFixture()
    const runtime = await openAdapter(fixture.project, "directory")

    const first = await collect(runtime)

    expect(first.hasMore).toBe(true)
    expect(first.observations).toHaveLength(1)
    const observation = first.observations[0]
    expect(observation?.session).toMatchObject({
      sourceSessionId: "session-root",
      title: "Why were there two charges?",
      actor: { name: "User", harness: "Codex" },
      branch: "main",
      status: "active"
    })
    expect(observation?.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceThreadId: "session-root", label: "Main" }),
      expect.objectContaining({
        sourceThreadId: "child-a",
        parentSourceThreadId: "session-root",
        label: "reviewer"
      })
    ]))
    expect(observation?.events.map((event) => event.sourceEventId)).toEqual([
      "spawn-child-a",
      "user-1",
      "agent-1",
      "thought-1",
      "command-1",
      "child-answer"
    ])
    expect(observation?.events.find((event) => event.sourceEventId === "spawn-child-a")).toMatchObject({
      sourceThreadId: "session-root",
      childSourceThreadId: "child-a",
      fidelity: "derived"
    })
    expect(observation?.events.find((event) => event.sourceEventId === "child-answer")?.sourceThreadId)
      .toBe("child-a")
    expect(observation?.events.some((event) => event.sourceEventId === "copied-parent")).toBe(false)
    expect(observation?.events.find((event) => event.sourceEventId === "thought-1")?.update)
      .toMatchObject({ sessionUpdate: "agent_thought_chunk", content: { text: "Keep one key" } })
    expect(observation?.rawSegments).toEqual([])
    const rawObservation = requiredObservation(await collect(runtime, first.nextCursor))
    expect(rawObservation.events).toEqual([])
    expect(rawObservation.rawSegments).toHaveLength(2)
    expect(rawObservation.rawSegments.every((segment) => segment.mediaType === "application/x-ndjson")).toBe(true)
    expect(rawObservation.rawSegments.map((segment) => segment.content).join(""))
      .toContain("provider-only-private-field")
    expect(JSON.stringify(observation?.events)).not.toContain("provider-only-private-field")
  })

  it("projects legacy event messages plus post-turn response summaries and tools", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "legacy-events.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "legacy-event-session", cwd: root.project }),
      responseItem("2026-08-16T00:00:00.100Z", {
        type: "message",
        role: "user",
        id: "restored-context",
        content: [{ type: "input_text", text: "Restored context must not become a new event" }]
      }),
      turnContext("2026-08-16T00:00:01.000Z"),
      legacyMessage("2026-08-16T00:00:02.000Z", "user_message", "Inspect the legacy event stream", "user-1"),
      responseItem("2026-08-16T00:00:03.000Z", {
        type: "reasoning",
        id: "legacy-summary",
        summary: [{ type: "summary_text", text: "Use the live event boundary" }],
        encrypted_content: "provider-only-reasoning"
      }),
      legacyMessage("2026-08-16T00:00:04.000Z", "agent_message", "The event boundary is sound"),
      responseItem("2026-08-16T00:00:05.000Z", {
        type: "custom_tool_call",
        id: "legacy-live-tool",
        call_id: "call-1",
        name: "exec",
        status: "completed",
        input: "provider-only-tool-input"
      }),
      responseItem("2026-08-16T00:00:06.000Z", {
        type: "custom_tool_call_output",
        id: "legacy-live-output",
        call_id: "call-1",
        output: "provider-only-tool-output"
      }),
      taskStarted("2026-08-16T00:00:07.000Z"),
      responseItem("2026-08-16T00:00:07.100Z", {
        type: "function_call",
        id: "restored-tool",
        call_id: "call-restored",
        name: "apply_patch",
        arguments: "restored context"
      }),
      turnContext("2026-08-16T00:00:08.000Z"),
      legacyMessage("2026-08-16T00:00:09.000Z", "user_message", "Continue", "user-2"),
      responseItem("2026-08-16T00:00:10.000Z", {
        type: "function_call",
        id: "legacy-live-function",
        call_id: "call-2",
        name: "apply_patch",
        arguments: "provider-only-function-input"
      }),
      legacyMessage("2026-08-16T00:00:11.000Z", "agent_message", "Done")
    ])

    const runtime = await openAdapter(root.project, "directory")
    const page = await collect(runtime)
    const observation = requiredObservation(page)
    const projected = observation.events.map((event) => event.update)

    expect(observation.session.title).toBe("Inspect the legacy event stream")
    expect(projected.map((update) => update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
      "tool_call",
      "user_message_chunk",
      "tool_call",
      "agent_message_chunk"
    ])
    expect(observation.events.map((event) => event.sourceEventId)).toContain("legacy-summary")
    expect(observation.events.map((event) => event.sourceEventId)).toContain("legacy-live-tool")
    expect(observation.events.map((event) => event.sourceEventId)).toContain("legacy-live-function")
    expect(observation.events.map((event) => event.sourceEventId)).not.toContain("restored-context")
    expect(observation.events.map((event) => event.sourceEventId)).not.toContain("restored-tool")
    expect(JSON.stringify(observation.events)).not.toContain("provider-only")
  })

  it("falls back to response_item when legacy event messages are unavailable", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "legacy.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "legacy-session", cwd: root.project }),
      responseItem("2026-08-16T00:00:01.000Z", {
        type: "message",
        role: "developer",
        id: "developer-1",
        content: [{ type: "input_text", text: "Provider-only instruction" }]
      }),
      responseItem("2026-08-16T00:00:02.000Z", {
        type: "message",
        role: "user",
        id: "legacy-user",
        content: [
          { type: "input_text", text: "Inspect the legacy archive" },
          { type: "input_image", image_url: "data:image/png;base64,private" }
        ]
      }),
      responseItem("2026-08-16T00:00:03.000Z", {
        type: "message",
        role: "assistant",
        id: "legacy-agent",
        content: [{ type: "output_text", text: "I will inspect it." }]
      }),
      responseItem("2026-08-16T00:00:04.000Z", {
        type: "reasoning",
        id: "legacy-thought",
        summary: [{ type: "summary_text", text: "Compare both projections" }],
        encrypted_content: "provider-only-reasoning"
      }),
      responseItem("2026-08-16T00:00:05.000Z", {
        type: "custom_tool_call",
        id: "legacy-tool",
        call_id: "call-1",
        name: "exec",
        status: "completed",
        input: "provider-only-tool-input"
      }),
      responseItem("2026-08-16T00:00:06.000Z", {
        type: "custom_tool_call_output",
        id: "legacy-tool-output",
        call_id: "call-1",
        output: "provider-only-tool-output"
      }),
      responseItem("2026-08-16T00:00:07.000Z", {
        type: "function_call",
        id: "legacy-function",
        call_id: "call-2",
        name: "apply_patch",
        arguments: "provider-only-function-input"
      }),
      responseItem("2026-08-16T00:00:08.000Z", {
        type: "function_call_output",
        id: "legacy-function-output",
        call_id: "call-2",
        output: "provider-only-function-output"
      }),
      responseItem("2026-08-16T00:00:09.000Z", {
        type: "agent_message",
        id: "legacy-agent-direct",
        author: "agent",
        content: [{ type: "input_text", text: "A delegated result" }]
      })
    ])

    const runtime = await openAdapter(root.project, "directory")
    const page = await collect(runtime)
    const observation = requiredObservation(page)

    expect(observation.session.title).toBe("Inspect the legacy archive")
    expect(observation.events.map((event) => event.sourceEventId)).toEqual([
      "legacy-user",
      "legacy-agent",
      "legacy-thought",
      "legacy-tool",
      "legacy-function",
      "legacy-agent-direct"
    ])
    expect(observation.events.find((event) => event.sourceEventId === "legacy-tool")?.update)
      .toMatchObject({ sessionUpdate: "tool_call", title: "exec", kind: "execute", status: "completed" })
    expect(observation.events.find((event) => event.sourceEventId === "legacy-function")?.update)
      .toMatchObject({ sessionUpdate: "tool_call", title: "apply_patch", kind: "edit" })
    expect(observation.events.find((event) => event.sourceEventId === "legacy-function")?.update)
      .not.toHaveProperty("status")
    expect(JSON.stringify(observation.events)).not.toContain("provider-only")
    const rawObservation = requiredObservation(await collect(runtime, page.nextCursor))
    expect(rawObservation.rawSegments.map((segment) => segment.content).join(""))
      .toContain("provider-only-tool-output")
  })

  it("preserves unknown tool outcomes instead of inferring success or failure", async () => {
    const root = await makeEmptyFixture()
    await writeJsonl(join(root.sessionsDirectory, "tool-status.jsonl"), [
      sessionMeta({ id: "tool-status", cwd: root.project }),
      ...[undefined, "provider_future_status", "completed", "failed", "running"].map((status, index) =>
        responseItem(`2026-08-16T00:00:0${index + 1}.000Z`, {
          type: "function_call", id: `tool-${index}`, name: "exec", ...(status === undefined ? {} : { status })
        }))
    ])
    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))
    expect(observation.events).toHaveLength(5)
    expect(observation.events[0]?.update).not.toHaveProperty("status")
    expect(observation.events[1]?.update).not.toHaveProperty("status")
    expect(observation.events[2]?.update).toMatchObject({ status: "completed" })
    expect(observation.events[3]?.update).toMatchObject({ status: "failed" })
    expect(observation.events[4]?.update).toMatchObject({ status: "in_progress" })
  })

  it("honors explicit outcomes and preserves missing outcomes across native tool item types", async () => {
    const root = await makeEmptyFixture()
    const types = ["CommandExecution", "McpToolCall", "FileChange", "ImageView", "Extension"]
    const statuses = [undefined, "provider_future_status", "failed", "completed"]
    await writeJsonl(join(root.sessionsDirectory, "native-tool-status.jsonl"), [
      sessionMeta({ id: "native-tool-status", cwd: root.project }),
      ...types.flatMap((type, typeIndex) => statuses.map((status, statusIndex) =>
        itemCompleted(new Date(Date.UTC(2026, 7, 16, 0, 0, typeIndex * statuses.length + statusIndex + 1)).toISOString(), "native-tool-status", {
          type, id: `${type}-${statusIndex}`, command: ["echo", "fixture"], server: "fixture", tool: "inspect",
          path: "/tmp/fixture.png", kind: "Fixture extension", ...(status === undefined ? {} : { status })
        })))
    ])
    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))
    expect(observation.events).toHaveLength(types.length * statuses.length)
    for (const type of types) {
      expect(observation.events.find(event => event.sourceEventId === `${type}-0`)?.update).not.toHaveProperty("status")
      expect(observation.events.find(event => event.sourceEventId === `${type}-1`)?.update).not.toHaveProperty("status")
      expect(observation.events.find(event => event.sourceEventId === `${type}-2`)?.update).toMatchObject({ status: "failed" })
      expect(observation.events.find(event => event.sourceEventId === `${type}-3`)?.update).toMatchObject({ status: "completed" })
    }
  })

  it("prefers supported item_completed records when both Codex projections coexist", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "mixed.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "mixed-session", cwd: root.project }),
      responseItem("2026-08-27T00:00:01.000Z", {
        type: "message",
        role: "user",
        id: "response-user",
        content: [{ type: "input_text", text: "Use the normalized projection" }]
      }),
      itemCompleted("2026-08-27T00:00:01.001Z", "mixed-session", {
        type: "UserMessage",
        id: "completed-user",
        content: [{ type: "input_text", text: "Use the normalized projection" }]
      }),
      itemCompleted("2026-08-27T00:00:02.000Z", "mixed-session", {
        type: "Reasoning",
        id: "completed-thought",
        summary_text: ["Keep one representation"]
      }),
      responseItem("2026-08-27T00:00:02.001Z", {
        type: "reasoning",
        id: "completed-thought",
        summary: [{ type: "summary_text", text: "Keep one representation" }]
      }),
      itemCompleted("2026-08-27T00:00:03.000Z", "mixed-session", {
        type: "AgentMessage",
        id: "completed-agent",
        content: [{ type: "output_text", text: "Only once" }]
      }),
      responseItem("2026-08-27T00:00:03.001Z", {
        type: "message",
        role: "assistant",
        id: "completed-agent",
        content: [{ type: "output_text", text: "Only once" }]
      }),
      responseItem("2026-08-27T00:00:04.000Z", {
        type: "custom_tool_call",
        id: "response-tool",
        call_id: "call-1",
        name: "exec",
        status: "completed"
      }),
      itemCompleted("2026-08-27T00:00:04.001Z", "mixed-session", {
        type: "CommandExecution",
        id: "completed-tool",
        command: ["pnpm", "test"],
        status: "completed",
        exit_code: 0
      }),
      responseItem("2026-08-27T00:00:04.002Z", {
        type: "custom_tool_call_output",
        id: "response-tool-output",
        call_id: "call-1",
        output: "hidden"
      })
    ])

    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))

    expect(observation.session.title).toBe("Use the normalized projection")
    expect(observation.events.map((event) => event.sourceEventId)).toEqual([
      "completed-user",
      "completed-thought",
      "completed-agent",
      "completed-tool"
    ])
  })

  it("uses legacy event messages when item_completed contains only unsupported Codex items", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "transition.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "transition-session", cwd: root.project }),
      responseItem("2026-08-20T00:00:01.000Z", {
        type: "message",
        role: "user",
        id: "transition-user",
        content: [{ type: "input_text", text: "Restored transition context" }]
      }),
      turnContext("2026-08-20T00:00:01.500Z"),
      legacyMessage(
        "2026-08-20T00:00:01.600Z",
        "user_message",
        "Do not mistake Plan for the new projection",
        "transition-live-user"
      ),
      itemCompleted("2026-08-20T00:00:02.000Z", "transition-session", {
        type: "Plan",
        id: "unsupported-plan",
        text: "Provider-only plan"
      }),
      legacyMessage("2026-08-20T00:00:03.000Z", "agent_message", "The fallback remains active")
    ])

    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))

    expect(observation.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk"
    ])
    expect(observation.events.map((event) => event.sourceEventId)).not.toContain("transition-user")
    expect(observation.events.map((event) => event.sourceEventId)).not.toContain("unsupported-plan")
  })

  it("assigns copied legacy response items to one owning Thread", async () => {
    const root = await makeEmptyFixture()
    const rootFile = join(root.sessionsDirectory, "legacy-root.jsonl")
    const childFile = join(root.sessionsDirectory, "legacy-child.jsonl")
    const copiedUser = responseItem("2026-08-19T00:00:01.000Z", {
      type: "message",
      role: "user",
      id: "copied-user",
      content: [{ type: "input_text", text: "Review the parent history" }]
    })
    const copiedAgent = responseItem("2026-08-19T00:00:02.000Z", {
      type: "message",
      role: "assistant",
      id: "copied-agent",
      content: [{ type: "output_text", text: "Parent answer" }]
    })
    await writeJsonl(rootFile, [
      sessionMeta({ id: "legacy-root", cwd: root.project, timestamp: "2026-08-19T00:00:00.000Z" }),
      copiedUser,
      copiedAgent
    ])
    await writeJsonl(childFile, [
      sessionMeta({
        id: "legacy-child",
        sessionId: "legacy-root",
        parentThreadId: "legacy-root",
        nickname: "reviewer",
        cwd: root.project,
        timestamp: "2026-08-19T00:00:03.000Z"
      }),
      copiedUser,
      copiedAgent,
      responseItem("2026-08-19T00:00:04.000Z", {
        type: "message",
        role: "assistant",
        id: "child-only-agent",
        content: [{ type: "output_text", text: "Child answer" }]
      })
    ])

    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))

    expect(observation.events.map((event) => event.sourceEventId)).toEqual([
      "spawn-legacy-child",
      "copied-user",
      "copied-agent",
      "child-only-agent"
    ])
    expect(observation.events.find((event) => event.sourceEventId === "copied-agent")?.sourceThreadId)
      .toBe("legacy-root")
    expect(observation.events.find((event) => event.sourceEventId === "child-only-agent")?.sourceThreadId)
      .toBe("legacy-child")
  })

  it("migrates legacy cursors by replaying Canonical data and advertises following Sessions", async () => {
    const root = await makeEmptyFixture()
    const firstFile = join(root.sessionsDirectory, "first.jsonl")
    const secondFile = join(root.sessionsDirectory, "second.jsonl")
    await writeJsonl(firstFile, [
      sessionMeta({ id: "first-session", cwd: root.project }),
      responseItem("2026-08-16T00:00:01.000Z", {
        type: "message",
        role: "assistant",
        id: "first-agent",
        content: [{ type: "output_text", text: "First" }]
      })
    ])
    await writeJsonl(secondFile, [
      sessionMeta({ id: "second-session", cwd: root.project }),
      responseItem("2026-08-17T00:00:01.000Z", {
        type: "message",
        role: "assistant",
        id: "second-agent",
        content: [{ type: "output_text", text: "Second" }]
      })
    ])
    const firstModified = new Date("2026-08-16T01:00:00.000Z")
    const secondModified = new Date("2026-08-17T01:00:00.000Z")
    await utimes(firstFile, firstModified, firstModified)
    await utimes(secondFile, secondModified, secondModified)
    const runtime = await openAdapter(root.project, "directory")

    const first = await collect(runtime)
    const firstObservation = requiredObservation(first)
    expect(firstObservation.session.sourceSessionId).toBe("first-session")
    expect(firstObservation.rawSegments).toEqual([])
    expect(firstObservation.session.revision).toBe(firstModified.getTime() * 1_000 * 2 + 12)
    expect(first.hasMore).toBe(true)
    const second = await collect(runtime, first.nextCursor)
    const secondObservation = requiredObservation(second)
    expect(secondObservation.session.sourceSessionId).toBe("second-session")
    expect(secondObservation.rawSegments).toEqual([])
    expect(second.hasMore).toBe(true)

    const rawAfterCanonical = requiredObservation(await collect(runtime, second.nextCursor))
    expect(rawAfterCanonical.session.sourceSessionId).toBe("first-session")
    expect(rawAfterCanonical.events).toEqual([])
    expect(rawAfterCanonical.rawSegments).not.toEqual([])

    for (const version of [1, 2, 3]) {
      const replay = await collect(runtime, Buffer.from(JSON.stringify({
        v: version,
        watermarkModifiedMs: secondModified.getTime() + 1,
        watermarkSessionId: "after-everything",
        commitSequence: 2
      })).toString("base64url"))
      expect(requiredObservation(replay).session.sourceSessionId).toBe("first-session")
      expect(replay.hasMore).toBe(true)
      if (replay.nextCursor === null) throw new Error("Expected migrated Cursor")
      expect(JSON.parse(Buffer.from(replay.nextCursor, "base64url").toString("utf8"))).toMatchObject({ v: 5 })
    }

    const stalled = await collect(runtime, null, [], {
      ...AdapterCollectionLimits,
      eventsPerObservation: 0
    })
    if (stalled.nextCursor === null) throw new Error("Expected active Cursor")
    const old = JSON.parse(Buffer.from(stalled.nextCursor, "base64url").toString("utf8")) as {
      readonly active: { readonly phase?: string }
    }
    const { phase: _phase, ...oldActive } = old.active
    const migrated = await collect(runtime, Buffer.from(JSON.stringify({
      ...old,
      v: 4,
      active: oldActive
    })).toString("base64url"))
    expect(requiredObservation(migrated).events).not.toEqual([])
    if (migrated.nextCursor === null) throw new Error("Expected migrated Cursor")
    expect(JSON.parse(Buffer.from(migrated.nextCursor, "base64url").toString("utf8"))).toMatchObject({ v: 5 })
  })

  it("prefers the latest valid Codex title index record", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "titled.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "titled-session", cwd: root.project }),
      itemCompleted("2026-09-05T00:00:01.000Z", "titled-session", {
        type: "UserMessage",
        id: "title-user",
        content: [{ type: "input_text", text: "This first prompt is only the fallback" }]
      })
    ])
    const rolloutModified = new Date("2026-09-05T00:03:00.000Z")
    await utimes(file, rolloutModified, rolloutModified)
    await writeFile(join(root.codexHome, "session_index.jsonl"), [
      JSON.stringify(sessionTitle("titled-session", "Old generated title", "2026-09-05T00:01:00.000Z")),
      "not-json",
      JSON.stringify(sessionTitle("titled-session", "  Checkout   accessibility review  ", "2026-09-05T00:02:00.000Z")),
      JSON.stringify(sessionTitle("titled-session", "   ", "2026-09-05T00:03:00.000Z")),
      "{\"id\":\"incomplete"
    ].join("\n"))

    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))

    expect(observation.session.title).toBe("Checkout accessibility review")
    expect(observation.session.updatedAt).toBe("2026-09-05T00:02:00.000Z")
    expect(observation.session.revision).toBe(rolloutModified.getTime() * 1_000 * 2 + 12)
  })

  it("collects a title-only rename without new rollout or Raw bytes", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "rename.jsonl")
    const index = join(root.codexHome, "session_index.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "renamed-session", cwd: root.project }),
      itemCompleted("2026-09-05T00:00:01.000Z", "renamed-session", {
        type: "UserMessage",
        id: "rename-user",
        content: [{ type: "input_text", text: "Fallback prompt" }]
      })
    ])
    const rolloutModified = new Date("2026-09-04T23:59:00.000Z")
    await utimes(file, rolloutModified, rolloutModified)
    await writeJsonl(index, [
      sessionTitle("renamed-session", "Initial Codex title", "2026-09-05T00:01:00.000Z")
    ])
    const runtime = await openAdapter(root.project, "directory")
    const first = await collect(runtime)
    const initial = requiredObservation(first)
    const progress = rawProgress(initial.session.sourceSessionId, initial.rawSegments)

    await appendFile(index, `${JSON.stringify(
      sessionTitle("renamed-session", "Renamed in Codex", "2026-09-05T00:02:00.000Z")
    )}\n`)
    const renamed = await collect(runtime, first.nextCursor, progress)
    const observation = requiredObservation(renamed)

    expect(observation.session.title).toBe("Renamed in Codex")
    expect(observation.session.updatedAt).toBe("2026-09-05T00:02:00.000Z")
    expect(observation.session.revision).toBeGreaterThan(initial.session.revision)
    expect(observation.rawSegments).toEqual([])
    const raw = await collect(runtime, renamed.nextCursor, progress)
    const rawObservation = requiredObservation(raw)
    const completedProgress = mergeProgress(progress, rawObservation.session.sourceSessionId, rawObservation.rawSegments)
    expect((await collect(runtime, raw.nextCursor, completedProgress)).observations).toEqual([])
  })

  it("resumes Raw bytes, replays Canonical events idempotently, and never mirrors provider deletion", async () => {
    const fixture = await makeFixture()
    const runtime = await openAdapter(fixture.project, "directory")
    const first = await collect(runtime)
    const firstObservation = requiredObservation(first)
    expect(firstObservation.rawSegments).toEqual([])
    const firstRaw = await collect(runtime, first.nextCursor)
    const firstRawObservation = requiredObservation(firstRaw)
    let progress = rawProgress(firstRawObservation.session.sourceSessionId, firstRawObservation.rawSegments)

    const unchanged = await collect(runtime, firstRaw.nextCursor, progress)
    expect(unchanged.observations).toEqual([])

    const appended = itemCompleted("2026-09-05T00:01:00.000Z", "session-root", {
      type: "AgentMessage",
      id: "agent-2",
      content: [{ type: "output_text", text: "A newly appended answer" }]
    })
    await appendFile(fixture.rootFile, `${JSON.stringify(appended)}\n`)
    const changedAt = new Date("2026-09-05T00:02:00.000Z")
    await utimes(fixture.rootFile, changedAt, changedAt)

    const changed = await collect(runtime, unchanged.nextCursor, progress)
    const changedObservation = requiredObservation(changed)
    expect(changedObservation.events.map((event) => event.sourceEventId)).toContain("agent-2")
    expect(changedObservation.events.map((event) => event.sourceEventId)).not.toContain("user-1")
    expect(changedObservation.rawSegments).toEqual([])
    const changedRaw = await collect(runtime, changed.nextCursor, progress)
    const changedRawObservation = requiredObservation(changedRaw)
    expect(changedRawObservation.rawSegments).toHaveLength(1)
    expect(changedRawObservation.rawSegments[0]).toMatchObject({
      sourceOffset: progress.find((item) => item.sourceObjectId === changedRawObservation.rawSegments[0]?.sourceObjectId)
        ?.sourceOffset,
      final: false
    })
    expect(changedRawObservation.rawSegments[0]?.content).toBe(`${JSON.stringify(appended)}\n`)
    progress = mergeProgress(progress, changedRawObservation.session.sourceSessionId, changedRawObservation.rawSegments)

    await rename(fixture.rootFile, join(fixture.archivedDirectory, "root.jsonl"))
    await rename(fixture.childFile, join(fixture.archivedDirectory, "child.jsonl"))
    const archived = await collect(runtime, changedRaw.nextCursor, progress)
    const archivedObservation = requiredObservation(archived)
    expect(archived.nextCursor).not.toBe(changedRaw.nextCursor)
    expect(archivedObservation.session.status).toBe("ended")
    expect(archivedObservation.rawSegments).toHaveLength(2)
    expect(archivedObservation.rawSegments.every((segment) => segment.content === "" && segment.final)).toBe(true)
    progress = mergeProgress(progress, archivedObservation.session.sourceSessionId, archivedObservation.rawSegments)

    await rm(fixture.archivedDirectory, { recursive: true, force: true })
    await mkdir(fixture.archivedDirectory, { recursive: true })
    const deleted = await collect(runtime, archived.nextCursor, progress)
    expect(deleted.observations).toEqual([])
  })

  it("passes recorded Git metadata to the Host and obeys its attribution decision", async () => {
    const root = await makeEmptyFixture()
    const outside = join(root.workspace, "worktree")
    await mkdir(outside)
    await writeFile(join(root.project, ".git-placeholder"), "")
    const file = join(root.sessionsDirectory, "remote.jsonl")
    await writeJsonl(file, [
      sessionMeta({
        id: "remote-session",
        cwd: outside,
        repository: "ssh://git@github.com/Example/ATape.git"
      }),
      itemCompleted("2026-09-05T01:00:01.000Z", "remote-session", {
        type: "AgentMessage",
        id: "remote-answer",
        content: [{ type: "output_text", text: "Matched by repository" }]
      })
    ])
    await runGit(root.project, ["init"])
    await runGit(root.project, ["remote", "add", "origin", "git@github.com:example/atape.git"])

    const sources: Array<unknown> = []
    const runtime = await openAdapter(root.project, "git", {
      version: "atape.git-attribution.v1",
      resolve: async source => { sources.push(source); return "included" }
    })
    const page = await collect(runtime)

    expect(requiredObservation(page).session.sourceSessionId).toBe("remote-session")
    expect(sources[0]).toMatchObject({ sourceId: "remote-session", cwd: outside, repositoryRemote: "ssh://git@github.com/Example/ATape.git" })
    const denied = await openAdapter(root.project, "git", { version: "atape.git-attribution.v1", resolve: async () => "excluded" })
    expect((await collect(denied)).observations).toEqual([])
    const unknown = await openAdapter("/deleted/project", "git", { version: "atape.git-attribution.v1", resolve: async () => "unknown" })
    const unknownPage = await collect(unknown)
    expect(unknownPage).toMatchObject({ observations: [], sourceFailures: [{ reason: "attribution" }] })
    const recovered = await collect(runtime, unknownPage.nextCursor)
    expect(requiredObservation(recovered).events.length).toBeGreaterThan(0)
    expect(requiredObservation(await collect(runtime, recovered.nextCursor)).rawSegments.length).toBeGreaterThan(0)
    await expect(openAdapter(root.project, "git")).rejects.toThrow("Upgrade")
  })

  it("attributes paginated files independently from their shared Thread and keeps identity after archival", async () => {
    const root = await makeEmptyFixture()
    const original = join(root.sessionsDirectory, "root.jsonl")
    const segment = join(root.sessionsDirectory, "root_segment.jsonl")
    const first = sessionMeta({ id: "shared-thread", cwd: root.project, repository: "git@github.com:example/project.git" })
    const next = sessionMeta({ id: "shared-thread", cwd: root.project, repository: "git@github.com:example/project.git", timestamp: "2026-09-05T01:00:00.000Z" })
    await writeJsonl(original, [first, itemCompleted("2026-09-05T00:01:00.000Z", "shared-thread", {
      type: "AgentMessage", id: "original-event", content: [{ type: "output_text", text: "Original answer" }]
    })])
    await writeJsonl(segment, [{ ...next, payload: { ...next.payload, history_mode: "paginated",
      history_base: { thread_id: "shared-thread", end_ordinal_exclusive: 10, end_byte_offset: 100 }
    } }, itemCompleted("2026-09-05T01:01:00.000Z", "shared-thread", {
      type: "AgentMessage", id: "segment-event", content: [{ type: "output_text", text: "Recent answer" }]
    })])
    const bindings = new Map<string, string>([["shared-thread", JSON.stringify(["shared-thread", first.payload.timestamp])]])
    const sources = new Set<string>()
    const attribution: NonNullable<import("@atape/domain").AdapterOpenContext["gitAttribution"]> = {
      version: "atape.git-attribution.v1",
      resolve: async source => {
        sources.add(source.sourceId)
        if (bindings.has(source.sourceId) && bindings.get(source.sourceId) !== source.originKey) return "unknown"
        bindings.set(source.sourceId, source.originKey)
        return "included"
      }
    }
    const runtime = await openAdapter(root.project, "git", attribution)
    const canonical = await collect(runtime)
    expect(canonical.sourceFailures).toBeUndefined()
    expect(requiredObservation(canonical).events.map(event => event.sourceEventId)).toEqual(["original-event", "segment-event"])
    expect(requiredObservation(canonical).events.every(event => event.orderFidelity === "derived")).toBe(true)
    expect(sources.size).toBe(2)
    expect(sources.has("shared-thread")).toBe(true)
    const raw = await collect(runtime, canonical.nextCursor)
    expect(requiredObservation(raw).rawSegments).toHaveLength(2)
    const previousSources = new Set(sources)
    await rename(segment, join(root.archivedDirectory, "root_segment.jsonl"))
    const reopened = await openAdapter(root.project, "git", attribution)
    const afterMove = await collect(reopened, raw.nextCursor, rawProgress("shared-thread", requiredObservation(raw).rawSegments))
    expect(afterMove.sourceFailures).toBeUndefined()
    expect(sources).toEqual(previousSources)
  })

  it("publishes newly attributable files behind the watermark in an already captured Session before Raw", async () => {
    const root = await makeEmptyFixture()
    const original = join(root.sessionsDirectory, "original.jsonl")
    const segment = join(root.sessionsDirectory, "segment.jsonl")
    for (const [path, id, paginated] of [[original, "old-event", false], [segment, "new-event", true]] as const) {
      const meta = sessionMeta({ id: "known-session", cwd: root.project })
      await writeJsonl(path, [{ ...meta, payload: { ...meta.payload, ...(paginated ? { history_mode: "paginated" } : {}) } },
        itemCompleted("2026-09-05T00:01:00.000Z", "known-session", {
          type: "AgentMessage", id, content: [{ type: "output_text", text: id }]
        })])
    }
    await utimes(original, new Date("2026-09-05T01:00:00Z"), new Date("2026-09-05T01:00:00Z"))
    await utimes(segment, new Date("2026-09-04T01:00:00Z"), new Date("2026-09-04T01:00:00Z"))
    let includeSegment = false
    const runtime = await openAdapter(root.project, "git", {
      version: "atape.git-attribution.v1",
      resolve: async source => source.sourceId === "known-session" || includeSegment ? "included" : "excluded"
    })
    const first = await collect(runtime)
    const oldRaw = await collect(runtime, first.nextCursor)
    const progress = rawProgress("known-session", requiredObservation(oldRaw).rawSegments)
    expect(progress).toHaveLength(1)
    includeSegment = true
    const recovered = await collect(runtime, oldRaw.nextCursor, progress)
    expect(requiredObservation(recovered).events.map(event => event.sourceEventId)).toContain("new-event")
    expect(requiredObservation(recovered).rawSegments).toEqual([])
    const newRaw = await collect(runtime, recovered.nextCursor, progress)
    expect(requiredObservation(newRaw).rawSegments).toHaveLength(1)
    expect(requiredObservation(newRaw).rawSegments[0]?.sourceName).toBe("segment.jsonl")
    const complete = mergeProgress(progress, "known-session", requiredObservation(newRaw).rawSegments)
    expect((await collect(runtime, newRaw.nextCursor, complete)).observations).toEqual([])
  })

  it("skips foreign and unknown Git sources while capturing and resuming healthy history", async () => {
    const root = await makeEmptyFixture()
    for (const id of ["healthy", "foreign", "unknown"]) {
      await writeJsonl(join(root.sessionsDirectory, `${id}.jsonl`), [
        sessionMeta({ id, cwd: root.project }),
        itemCompleted("2026-09-05T01:00:01.000Z", id, {
          type: "AgentMessage", id: `${id}-answer`, content: [{ type: "output_text", text: id }]
        })
      ])
    }
    const runtime = await openAdapter(root.project, "git", {
      version: "atape.git-attribution.v1",
      resolve: async source => source.sourceId === "healthy" ? "included" : source.sourceId === "foreign" ? "excluded" : "unknown"
    })
    const canonical = await collect(runtime)
    expect(canonical.observations.map(o => o.session.sourceSessionId)).toEqual(["healthy"])
    expect(requiredObservation(canonical).events).toHaveLength(1)
    const raw = await collect(runtime, canonical.nextCursor)
    expect(raw.observations.map(o => o.session.sourceSessionId)).toEqual(["healthy"])
    expect(requiredObservation(raw).rawSegments).toHaveLength(1)
    const progress = mergeProgress([], "healthy", requiredObservation(raw).rawSegments)
    const resumed = await collect(runtime, raw.nextCursor, progress)
    expect(resumed).toMatchObject({ observations: [], hasMore: false })
    const unknownFile = await realpath(join(root.sessionsDirectory, "unknown.jsonl"))
    for (const page of [canonical, raw, resumed]) {
      expect(page.sourceFailures).toEqual([{ source: unknownFile, reason: "attribution" }])
    }
  })

  it("uses a stable untitled label when the root Thread has no user message", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "assistant-only.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "assistant-only", cwd: root.project }),
      itemCompleted("2026-09-05T01:10:01.000Z", "assistant-only", {
        type: "AgentMessage",
        id: "assistant-answer",
        content: [{ type: "output_text", text: "No user prompt was recorded" }]
      })
    ])

    const runtime = await openAdapter(root.project, "directory")
    expect(requiredObservation(await collect(runtime)).session.title).toBe("Untitled Codex conversation")
  })

  it("waits for an active file's trailing JSONL record to become complete", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "partial.jsonl")
    const metadata = sessionMeta({ id: "partial-session", cwd: root.project })
    const complete = itemCompleted("2026-09-05T02:00:01.000Z", "partial-session", {
      type: "AgentMessage",
      id: "complete-answer",
      content: [{ type: "output_text", text: "Complete" }]
    })
    const partial = itemCompleted("2026-09-05T02:00:02.000Z", "partial-session", {
      type: "AgentMessage",
      id: "partial-answer",
      content: [{ type: "output_text", text: "Incomplete until newline" }]
    })
    await writeFile(file, `${JSON.stringify(metadata)}\n${JSON.stringify(complete)}\n${JSON.stringify(partial)}`)

    const runtime = await openAdapter(root.project, "directory")
    const first = await collect(runtime)
    const firstObservation = requiredObservation(first)
    expect(firstObservation.events.map((event) => event.sourceEventId)).toEqual(["complete-answer"])
    expect(firstObservation.rawSegments).toEqual([])
    const raw = await collect(runtime, first.nextCursor)
    const rawObservation = requiredObservation(raw)
    expect(rawObservation.rawSegments.map((segment) => segment.content).join(""))
      .not.toContain("partial-answer")
    const unchanged = await collect(
      runtime,
      raw.nextCursor,
      rawProgress(rawObservation.session.sourceSessionId, rawObservation.rawSegments)
    )
    expect(unchanged.observations).toEqual([])
  })

  it("keeps oversized compaction records in Raw while omitting them from Canonical events", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "large-compaction.jsonl")
    const compacted = {
      timestamp: "2026-08-16T00:00:02.000Z",
      type: "compacted",
      payload: {
        message: "",
        replacement_history: [{ type: "provider_private", value: "x".repeat(5 * 1024 * 1024) }],
        window_number: 2
      }
    }
    await writeJsonl(file, [
      sessionMeta({ id: "large-compaction", cwd: root.project }),
      turnContext("2026-08-16T00:00:00.500Z"),
      legacyMessage("2026-08-16T00:00:01.000Z", "user_message", "Keep the Raw compaction", "user-1"),
      compacted,
      legacyMessage("2026-08-16T00:00:03.000Z", "agent_message", "Canonical remains small")
    ])

    const runtime = await openAdapter(root.project, "directory")
    const page = await collect(runtime)
    const observation = requiredObservation(page)

    expect(observation.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk"
    ])
    const rawObservation = requiredObservation(await collect(runtime, page.nextCursor))
    expect(rawObservation.rawSegments).toHaveLength(1)
    expect(Buffer.byteLength(rawObservation.rawSegments[0]?.content ?? "")).toBeGreaterThan(4 * 1024 * 1024)
    expect(rawObservation.rawSegments[0]?.content).toContain('"type":"compacted"')
    expect(Buffer.byteLength(JSON.stringify(observation.events))).toBeLessThan(10_000)
  })

  it("publishes the last cumulative item update across page boundaries and advances its revision after append", async () => {
    const root = await makeEmptyFixture()
    const path = join(root.sessionsDirectory, "updates.jsonl")
    const item = (text: string, at: string) => itemCompleted(at, "updates", { type: "Reasoning", id: "item-297", summary_text: [text] })
    await writeJsonl(path, [sessionMeta({ id: "updates", cwd: root.project }),
      item("first fragment", "2026-09-05T00:01:00Z"),
      itemCompleted("2026-09-05T00:01:01Z", "updates", { type: "AgentMessage", id: "separator", content: [{ type: "output_text", text: "answer" }] }),
      item("first fragment and the rest", "2026-09-05T00:01:02Z")])
    await utimes(path, new Date("2026-09-05T00:02:00Z"), new Date("2026-09-05T00:02:00Z"))
    let cursor: string | null = null
    let progress: ReadonlyArray<AdapterSourceProgress> = []
    const events: AdapterCollectionPage["observations"][number]["events"][number][] = []
    for (let i = 0; i < 10; i++) {
      const runtime = await openAdapter(root.project, "directory")
      const page = await collect(runtime, cursor, progress, { ...AdapterCollectionLimits, eventsPerObservation: 1 })
      for (const observation of page.observations) { events.push(...observation.events); progress = mergeProgress(progress, observation.session.sourceSessionId, observation.rawSegments) }
      cursor = page.nextCursor
      if (!page.hasMore) break
    }
    expect(events.map(e => e.sourceEventId)).toEqual(["separator", "item-297"])
    expect(events[1]?.update).toMatchObject({ content: { text: "first fragment and the rest" } })
    await appendFile(path, JSON.stringify(item("final cumulative answer", "2026-09-05T00:03:00Z")) + "\n")
    await utimes(path, new Date("2026-09-05T00:04:00Z"), new Date("2026-09-05T00:04:00Z"))
    const appended = requiredObservation(await collect(await openAdapter(root.project, "directory"), cursor, progress))
    expect(appended.events).toHaveLength(1)
    expect(appended.events[0]?.sourceEventId).toBe("item-297")
    expect(appended.events[0]!.revision).toBeGreaterThan(events[1]!.revision)
    expect(appended.events[0]?.update).toMatchObject({ content: { text: "final cumulative answer" } })
  })

  it("replays old Canonical projection checkpoints while retaining acknowledged Raw bytes", async () => {
    const fixture = await makeFixture()
    const runtime = await openAdapter(fixture.project, "directory")
    const first = await collect(runtime)
    const raw = await collect(runtime, first.nextCursor)
    const observation = requiredObservation(raw)
    const progress = rawProgress(observation.session.sourceSessionId, observation.rawSegments)
    const state = JSON.parse(Buffer.from(raw.nextCursor!, "base64url").toString("utf8"))
    state.eventProjectionVersion = 4
    const priorRevision = state.canonicalProgress[0].revision + 100
    state.canonicalProgress[0].revision = priorRevision
    let page = await collect(await openAdapter(fixture.project, "directory"), Buffer.from(JSON.stringify(state)).toString("base64url"), progress)
    expect(requiredObservation(page).events.map(e => e.sourceEventId)).toEqual(requiredObservation(first).events.map(e => e.sourceEventId))
    expect(requiredObservation(page).events.every(event => event.projectionRevision === 5)).toBe(true)
    expect(requiredObservation(page).session.revision).toBeGreaterThan(priorRevision)
    for (let i = 0; i < 10; i++) {
      expect(page.observations.flatMap(o => o.rawSegments)).toEqual([])
      if (!page.hasMore) break
      page = await collect(runtime, page.nextCursor, progress)
    }
    expect(page.hasMore).toBe(false)
  })

  it("reuses discovery across short Sessions but reauthorizes the selected source", async () => {
    const root = await makeEmptyFixture()
    for (const [index, id] of ["alpha", "beta", "gamma"].entries()) {
      const path = join(root.sessionsDirectory, `${id}.jsonl`)
      await writeJsonl(path, [sessionMeta({ id, cwd: root.project }), itemCompleted("2026-09-05T00:01:00Z", id,
        { type: "AgentMessage", id: `${id}-answer`, content: [{ type: "output_text", text: id }] })])
      await utimes(path, new Date(1788566400000 + index * 1000), new Date(1788566400000 + index * 1000))
    }
    const sources: string[] = []
    let denied = ""
    const runtime = await openAdapter(root.project, "git", { version: "atape.git-attribution.v1",
      resolve: async source => { sources.push(source.sourceId); return source.sourceId === denied ? "excluded" : "included" } })
    const first = await collect(runtime)
    expect(requiredObservation(first).session.sourceSessionId).toBe("alpha")
    expect(sources).toHaveLength(3)
    sources.length = 0
    const second = await collect(runtime, first.nextCursor)
    expect(requiredObservation(second).session.sourceSessionId).toBe("gamma")
    expect(sources).toEqual(["gamma"])
    denied = "beta"
    const next = await collect(runtime, second.nextCursor)
    expect(sources).toContain("beta")
    expect(next.observations.every(o => o.session.sourceSessionId !== "beta")).toBe(true)
  })

  it("refreshes only active sources while still honoring changed attribution on continuation pages", async () => {
    const root = await makeEmptyFixture()
    const hot = join(root.sessionsDirectory, "hot.jsonl")
    await writeJsonl(hot, [sessionMeta({ id: "hot", cwd: root.project }), ...[1, 2, 3].map(i =>
      itemCompleted(`2026-09-05T00:00:0${i}.000Z`, "hot", {
        type: "AgentMessage", id: `hot-${i}`, content: [{ type: "output_text", text: `Answer ${i}` }]
      }))])
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonl(join(root.sessionsDirectory, `foreign-${i}.jsonl`), [
      sessionMeta({ id: `foreign-${i}`, cwd: root.project })
    ])))
    let allowed = true
    const sources: string[] = []
    const runtime = await openAdapter(root.project, "git", {
      version: "atape.git-attribution.v1",
      resolve: async source => { sources.push(source.sourceId); return allowed && source.sourceId === "hot" ? "included" : "excluded" }
    })
    const limits = { ...AdapterCollectionLimits, eventsPerObservation: 1 }
    const first = await collect(runtime, null, [], limits)
    expect(requiredObservation(first).events.map(event => event.sourceEventId)).toEqual(["hot-1"])
    expect(sources).toHaveLength(21)
    sources.length = 0
    const second = await collect(runtime, first.nextCursor, [], limits)
    expect(requiredObservation(second).events.map(event => event.sourceEventId)).toEqual(["hot-2"])
    expect(sources).toEqual(["hot"])
    allowed = false
    expect((await collect(runtime, second.nextCursor, [], limits)).observations).toEqual([])
  })

  it("finds archived active files and newly created Sessions at the next discovery boundary", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "moving.jsonl")
    await writeJsonl(file, [sessionMeta({ id: "moving", cwd: root.project }), ...[1, 2].map(i =>
      itemCompleted(`2026-09-05T00:00:0${i}.000Z`, "moving", {
        type: "AgentMessage", id: `moving-${i}`, content: [{ type: "output_text", text: `Answer ${i}` }]
      }))])
    const runtime = await openAdapter(root.project, "directory")
    const limits = { ...AdapterCollectionLimits, eventsPerObservation: 1 }
    const first = await collect(runtime, null, [], limits)
    await rename(file, join(root.archivedDirectory, "moving.jsonl"))
    await writeJsonl(join(root.sessionsDirectory, "new.jsonl"), [sessionMeta({ id: "new", cwd: root.project }),
      itemCompleted("2026-09-05T01:00:00.000Z", "new", {
        type: "AgentMessage", id: "new-event", content: [{ type: "output_text", text: "New conversation" }]
      })])
    let cursor = first.nextCursor
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const next = await collect(runtime, cursor, [], limits)
      ids.push(...next.observations.flatMap(o => o.events.map(e => e.sourceEventId)))
      cursor = next.nextCursor
      if (ids.includes("new-event")) break
    }
    expect(ids).toContain("moving-2")
    expect(ids).toContain("new-event")
  })

  it("refreshes projection ownership when a file changes between continuation pages", async () => {
    const root = await makeEmptyFixture()
    await writeJsonl(join(root.sessionsDirectory, "a.jsonl"), [
      sessionMeta({ id: "changing-session", cwd: root.project }),
      itemCompleted("2026-09-05T00:01:00.000Z", "changing-session", {
        type: "AgentMessage", id: "first", content: [{ type: "output_text", text: "First" }]
      })
    ])
    const changing = join(root.sessionsDirectory, "b.jsonl")
    const records = (id: string) => [
      sessionMeta({ id: "changing-session", cwd: root.project }),
      responseItem("2026-09-05T00:02:00.000Z", {
        type: "message", role: "assistant", id, content: [{ type: "output_text", text: "Second" }]
      })
    ]
    await writeJsonl(changing, records("before"))
    const runtime = await openAdapter(root.project, "directory")
    const limits = { ...AdapterCollectionLimits, eventsPerObservation: 1 }
    const first = await collect(runtime, null, [], limits)
    expect(requiredObservation(first).events.map(event => event.sourceEventId)).toEqual(["first"])
    await writeJsonl(changing, records("after!"))
    const changedAt = new Date(Date.now() + 1000)
    await utimes(changing, changedAt, changedAt)
    const next = await collect(runtime, first.nextCursor, [], limits)
    expect(requiredObservation(next).events.map(event => event.sourceEventId)).toEqual(["after!"])
  })

  it("resumes a 100-file Session within the cursor limit and captures every event and Raw file", async () => {
    const root = await makeEmptyFixture()
    await Promise.all(Array.from({ length: 100 }, async (_, i) => {
      await writeJsonl(join(root.sessionsDirectory, `rollout-2026-09-05T03-00-00-${randomUUID()}.jsonl`), [
        sessionMeta({ id: "many-files", cwd: root.project }),
        itemCompleted("2026-09-05T03:00:01.000Z", "many-files", {
          type: "AgentMessage", id: `event-${i}`, content: [{ type: "output_text", text: `Answer ${i}` }]
        })
      ])
    }))
    const limits = { ...AdapterCollectionLimits, eventsPerObservation: 10 }
    let cursor: string | null = null
    let progress: ReadonlyArray<AdapterSourceProgress> = []
    const events: Array<string> = []
    let completed = false
    let compressed = false
    for (let i = 0; i < 30; i++) {
      const runtime = await openAdapter(root.project, "directory")
      const page = await collect(runtime, cursor, progress, limits)
      expect(Buffer.byteLength(page.nextCursor ?? "")).toBeLessThanOrEqual(16_000)
      compressed ||= page.nextCursor?.startsWith("z1:") === true
      for (const observation of page.observations) {
        events.push(...observation.events.map(event => event.sourceEventId))
        progress = mergeProgress(progress, observation.session.sourceSessionId, observation.rawSegments)
      }
      cursor = page.nextCursor
      if (!page.hasMore) { completed = true; break }
    }
    expect(compressed).toBe(true)
    expect(completed).toBe(true)
    expect(events).toHaveLength(100)
    expect(new Set(events).size).toBe(100)
    expect(progress).toHaveLength(100)
    expect(progress.every(file => file.sourceOffset > 0)).toBe(true)
  })

  it.each([
    "z1:not-a-deflate-stream",
    `z1:${deflateRawSync(Buffer.alloc(256 * 1024 + 1, 32)).toString("base64url")}`,
    "x".repeat(16_001)
  ])("rejects corrupt or oversized compressed cursor input", async cursor => {
    const root = await makeEmptyFixture()
    const runtime = await openAdapter(root.project, "directory")
    await expect(collect(runtime, cursor)).rejects.toMatchObject({ reason: "cursor" })
  })

  it("paginates Canonical and Raw independently by byte limits", async () => {
    const root = await makeEmptyFixture()
    const firstFile = join(root.sessionsDirectory, "large-a.jsonl")
    const secondFile = join(root.sessionsDirectory, "large-b.jsonl")
    const largeText = "x".repeat(700 * 1024)
    await writeJsonl(firstFile, [
      sessionMeta({ id: "large-session", cwd: root.project }),
      itemCompleted("2026-09-05T03:00:01.000Z", "large-session", {
        type: "AgentMessage", id: "large-1", content: [{ type: "output_text", text: largeText }]
      }),
      itemCompleted("2026-09-05T03:00:02.000Z", "large-session", {
        type: "AgentMessage", id: "large-2", content: [{ type: "output_text", text: largeText }]
      })
    ])
    await writeJsonl(secondFile, [
      sessionMeta({
        id: "large-session",
        cwd: root.project,
        timestamp: "2026-09-05T03:00:03.000Z"
      }),
      itemCompleted("2026-09-05T03:00:04.000Z", "large-session", {
        type: "AgentMessage", id: "large-3", content: [{ type: "output_text", text: largeText }]
      }),
      { type: "provider_private", payload: { value: "r".repeat(1536 * 1024) } }
    ])
    const runtime = await openAdapter(root.project, "directory")
    const limits: AdapterCollectionLimitValues = {
      ...AdapterCollectionLimits,
      canonicalBytesPerObservation: 1024 * 1024,
      rawBytesPerObservation: 2 * 1024 * 1024,
      rawSegmentBytes: 2 * 1024 * 1024
    }
    let cursor: string | null = null
    let progress: ReadonlyArray<AdapterSourceProgress> = []
    let pages = 0
    const eventIds: Array<string> = []
    do {
      const page = await collect(runtime, cursor, progress, limits)
      for (const observation of page.observations) {
        expect(Buffer.byteLength(JSON.stringify({
          session: observation.session,
          threads: observation.threads,
          events: observation.events
        }))).toBeLessThanOrEqual(limits.canonicalBytesPerObservation)
        expect(observation.rawSegments.reduce((bytes, segment) =>
          bytes + Buffer.byteLength(segment.content), 0)).toBeLessThanOrEqual(limits.rawBytesPerObservation)
        eventIds.push(...observation.events.map((event) => event.sourceEventId))
        progress = mergeProgress(progress, observation.session.sourceSessionId, observation.rawSegments)
      }
      cursor = page.nextCursor
      pages++
      if (!page.hasMore) break
    } while (pages < 10)

    expect(pages).toBeGreaterThan(1)
    expect(eventIds).toEqual(["large-1", "large-2", "large-3"])
  })
})

const makeFixture = async () => {
  const root = await makeEmptyFixture()
  const outside = join(root.workspace, "outside")
  await mkdir(outside)
  const rootFile = join(root.sessionsDirectory, "root.jsonl")
  const childFile = join(root.sessionsDirectory, "child.jsonl")
  await writeJsonl(rootFile, [
    sessionMeta({ id: "session-root", cwd: root.project, branch: "main" }),
    itemCompleted("2026-09-05T00:00:01.000Z", "session-root", {
      type: "UserMessage",
      id: "user-1",
      content: [{ type: "input_text", text: "Why were there two charges?" }]
    }),
    itemCompleted("2026-09-05T00:00:02.000Z", "session-root", {
      type: "AgentMessage",
      id: "agent-1",
      content: [{ type: "output_text", text: "I will inspect the idempotency path." }],
      provider_only: "provider-only-private-field"
    }),
    itemCompleted("2026-09-05T00:00:03.000Z", "session-root", {
      type: "Reasoning",
      id: "thought-1",
      summary_text: ["Keep one key"],
      raw_content: ["provider-only-private-field"]
    }),
    itemCompleted("2026-09-05T00:00:04.000Z", "session-root", {
      type: "CommandExecution",
      id: "command-1",
      command: ["pnpm", "test"],
      status: "completed",
      exit_code: 0
    })
  ])
  await writeJsonl(childFile, [
    sessionMeta({
      id: "child-a",
      sessionId: "session-root",
      parentThreadId: "session-root",
      nickname: "reviewer",
      cwd: root.project,
      timestamp: "2026-09-05T00:00:05.000Z"
    }),
    itemCompleted("2026-09-05T00:00:02.000Z", "session-root", {
      type: "AgentMessage",
      id: "copied-parent",
      content: [{ type: "output_text", text: "Copied parent history" }]
    }),
    itemCompleted("2026-09-05T00:00:06.000Z", "child-a", {
      type: "AgentMessage",
      id: "child-answer",
      content: [{ type: "output_text", text: "The schema is safe." }]
    })
  ])
  await writeJsonl(join(root.sessionsDirectory, "outside.jsonl"), [
    sessionMeta({ id: "outside-session", cwd: outside }),
    itemCompleted("2026-09-05T00:00:01.000Z", "outside-session", {
      type: "AgentMessage",
      id: "outside-answer",
      content: [{ type: "output_text", text: "Must not be collected" }]
    })
  ])
  await writeFile(join(root.sessionsDirectory, "malformed.jsonl"), "not json\n")
  const timestamp = new Date("2026-09-05T00:01:00.000Z")
  await Promise.all([rootFile, childFile].map((file) => utimes(file, timestamp, timestamp)))
  return { ...root, rootFile, childFile }
}

const makeEmptyFixture = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "atape-codex-adapter-"))
  temporaryDirectories.push(workspace)
  const codexHome = join(workspace, "codex-home")
  const project = join(workspace, "project")
  const sessionsDirectory = join(codexHome, "sessions", "2026", "09", "05")
  const archivedDirectory = join(codexHome, "archived_sessions")
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(sessionsDirectory, { recursive: true }),
    mkdir(archivedDirectory, { recursive: true })
  ])
  process.env.ATAPE_CODEX_HOME = codexHome
  return { workspace, codexHome, project, sessionsDirectory, archivedDirectory }
}

const openAdapter = (project: string, type: "git" | "directory", gitAttribution?: import("@atape/domain").AdapterOpenContext["gitAttribution"]) => createAtapeAdapter({
  legacyCanonicalProfiles: [CanonicalProfileVersion3],
  ...(gitAttribution === undefined ? {} : { gitAttribution }),
  protocolVersion: AdapterProtocolVersion,
  adapter: { id: "codex", version: "0.1.0" },
  project: { id: "project-1", type, path: project },
  signal: AbortSignal.timeout(5_000)
})

const collect = async (
  runtime: LegacyAdapterRuntime,
  cursor: string | null = null,
  rawProgressValue: ReadonlyArray<AdapterSourceProgress> = [],
  limits: AdapterCollectionLimitValues = AdapterCollectionLimits,
  rawCaptureEnabled = true
) => await runtime.collect({
  protocolVersion: AdapterProtocolVersion,
  cursor,
  limits,
  rawProgress: rawProgressValue,
  rawCaptureEnabled,
  signal: AbortSignal.timeout(5_000)
}) as AdapterCollectionPage

const requiredObservation = (page: AdapterCollectionPage) => {
  const observation = page.observations[0]
  if (observation === undefined) throw new Error("Expected one Codex observation")
  return observation
}

const rawProgress = (
  sourceSessionId: string,
  segments: AdapterCollectionPage["observations"][number]["rawSegments"]
): ReadonlyArray<AdapterSourceProgress> => segments.map((segment) => ({
  sourceSessionId,
  sourceObjectId: segment.sourceObjectId,
  sourceGeneration: segment.sourceGeneration,
  sourceOffset: segment.sourceOffset + Buffer.byteLength(segment.content),
  finalized: segment.final
}))

const mergeProgress = (
  current: ReadonlyArray<AdapterSourceProgress>,
  sourceSessionId: string,
  segments: AdapterCollectionPage["observations"][number]["rawSegments"]
) => {
  const next = new Map(current.map((item) => [item.sourceObjectId, item]))
  for (const item of rawProgress(sourceSessionId, segments)) next.set(item.sourceObjectId, item)
  return [...next.values()]
}

const sessionMeta = (input: {
  readonly id: string
  readonly cwd: string
  readonly sessionId?: string
  readonly parentThreadId?: string
  readonly nickname?: string
  readonly timestamp?: string
  readonly repository?: string
  readonly branch?: string
}) => ({
  timestamp: input.timestamp ?? "2026-09-05T00:00:00.000Z",
  type: "session_meta",
  payload: {
    id: input.id,
    session_id: input.sessionId ?? input.id,
    timestamp: input.timestamp ?? "2026-09-05T00:00:00.000Z",
    cwd: input.cwd,
    thread_source: input.parentThreadId === undefined ? "user" : "subagent",
    source: input.parentThreadId === undefined
      ? {}
      : { subagent: { thread_spawn: {
          parent_thread_id: input.parentThreadId,
          agent_nickname: input.nickname
        } } },
    git: {
      repository_url: input.repository,
      branch: input.branch
    }
  }
})

const itemCompleted = (timestamp: string, threadId: string, item: Record<string, unknown>) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "item_completed", thread_id: threadId, item }
})

const responseItem = (timestamp: string, item: Record<string, unknown>) => ({
  timestamp,
  type: "response_item",
  payload: item
})

const turnContext = (timestamp: string) => ({
  timestamp,
  type: "turn_context",
  payload: { turn_id: "turn-1" }
})

const taskStarted = (timestamp: string) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "task_started", turn_id: "turn-2" }
})

const legacyMessage = (
  timestamp: string,
  type: "user_message" | "agent_message",
  message: string,
  clientId?: string
) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type,
    message,
    ...(clientId === undefined ? {} : { client_id: clientId })
  }
})

const sessionTitle = (id: string, threadName: string, updatedAt: string) => ({
  id,
  thread_name: threadName,
  updated_at: updatedAt
})

const writeJsonl = (path: string, records: ReadonlyArray<unknown>) =>
  writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const { execFile } = await import("node:child_process")
  await new Promise<void>((resolve, reject) => execFile("git", args, { cwd }, (error) => error ? reject(error) : resolve()))
}
