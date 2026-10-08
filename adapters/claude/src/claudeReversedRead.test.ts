import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-reversed-read-pair-2.1.263/", import.meta.url)
let directory: string, file: string, sources: string[], context: AdapterOpenContext & { signal: AbortSignal }
let progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-reversed-read-")); file = join(directory, "session.jsonl")
  sources = await Promise.all(["seed", "warmup", "r1", "ordinary-resume"].map(async name =>
    (await readFile(new URL(`${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-reversed-read-pair/workspace", directory)))
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const rows = (source: string): Row[] => source.trimEnd().split("\n").map(line => JSON.parse(line))
const lines = (records: Row[]) => records.map(row => JSON.stringify(row)).join("\n") + "\n"
const prefix = (source: string, count: number) => source.split(/(?<=\n)/).slice(0, count).join("")
const request = (cursor: string | null = null, rawEnabled = true, limits: Partial<AdapterCollectRequest["limits"]> = {}): AdapterCollectRequest => ({
  protocolVersion: context.protocolVersion, cursor, rawCaptureEnabled: rawEnabled, rawProgress: progress,
  limits: { ...AdapterCollectionLimits, ...limits }, signal: new AbortController().signal
})
const read = async (input = request()) => await (await createAtapeAdapter(context)).collect(input) as AdapterCollectionPage
const acknowledge = (page: AdapterCollectionPage) => {
  const receipts = new Map(progress.map(item => [item.sourceObjectId, item]))
  for (const observation of page.observations) for (const raw of observation.rawSegments) receipts.set(raw.sourceObjectId, {
    sourceSessionId: observation.session.sourceSessionId, sourceObjectId: raw.sourceObjectId, sourceGeneration: raw.sourceGeneration,
    sourceOffset: raw.sourceOffset + Buffer.byteLength(raw.content), finalized: raw.final
  })
  progress = [...receipts.values()]
}
const events = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.events))
const usage = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.usage ?? []))
const raw = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.rawSegments))
const totals = (pages: AdapterCollectionPage[]) => {
  const latest = new Map<string, AdapterUsage>()
  for (const sample of usage(pages)) {
    const previous = latest.get(sample.sourceUsageId)
    if (!previous || sample.revision > previous.revision) latest.set(sample.sourceUsageId, sample)
    else if (sample.revision === previous.revision) expect(sample).toEqual(previous)
  }
  return { records: latest.size, input: [...latest.values()].reduce((sum, sample) => sum + sample.inputTokens!, 0),
    output: [...latest.values()].reduce((sum, sample) => sum + sample.outputTokens!, 0) }
}
const expectRaw = (pages: AdapterCollectionPage[], source: string) => {
  const segments = raw(pages); let offset = 0
  for (const segment of segments) { expect(segment.sourceOffset).toBe(offset); offset += Buffer.byteLength(segment.content) }
  expect(new Set(segments.map(segment => segment.sourceObjectId)).size).toBe(1)
  expect(new Set(segments.map(segment => segment.sourceGeneration)).size).toBe(1)
  expect(segments.map(segment => segment.content).join("")).toBe(source)
}
const drain = async (cursor: string | null = null, rawEnabled = true, limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  const pages: AdapterCollectionPage[] = []
  for (let n = 0; n < 150; n++) {
    const input = request(cursor, rawEnabled, limits), page = await read(input)
    expect(await read(input)).toEqual(page); expect(page.sourceFailures).toBeUndefined()
    for (const observation of page.observations) {
      expect(observation.events.length).toBeLessThanOrEqual(input.limits.eventsPerObservation)
      expect(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] }))).toBeLessThanOrEqual(input.limits.canonicalBytesPerObservation)
      expect(observation.rawSegments.reduce((sum, segment) => sum + Buffer.byteLength(segment.content), 0)).toBeLessThanOrEqual(input.limits.rawBytesPerObservation)
    }
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.hasMore && !page.observations.length) return { pages, cursor }
  }
  throw new Error("Reversed Read did not finish bounded pages")
}
const reject = async (input: AdapterCollectRequest, reason = "unsupported") => {
  const saved = JSON.stringify(progress)
  await expect(read(input)).rejects.toMatchObject({ reason }); await expect(read(input)).rejects.toMatchObject({ reason })
  expect(JSON.stringify(progress)).toBe(saved)
}
const damage = (cursor: string, change: (checkpoint: Row) => void) => {
  const value = JSON.parse(cursor.startsWith("z3:") ? inflateRawSync(Buffer.from(cursor.slice(3), "base64url")).toString() : cursor)
  change(value.sessions[0].checkpoint); return JSON.stringify(value)
}

it("captures four native snapshots in physical result order with one-Event restarted retries", async () => {
  let cursor: string | null = null, old = ""; const all: AdapterCollectionPage[] = []
  for (const [index, count, expectedUsage] of [
    [0, 2, { records: 1, input: 23, output: 11 }], [1, 4, { records: 2, input: 52, output: 24 }],
    [2, 12, { records: 4, input: 190093, output: 64 }], [3, 14, { records: 5, input: 190122, output: 77 }]
  ] as const) {
    await appendFile(file, sources[index]!.slice(old.length)); const next = await drain(cursor, true, { eventsPerObservation: 1 })
    all.push(...next.pages); cursor = next.cursor; old = sources[index]!
    expect(events(all)).toHaveLength(count); expect(totals(all)).toEqual(expectedUsage); expectRaw(all, old)
  }
  const updates = events(all).filter(event => event.update.sessionUpdate === "tool_call_update")
  expect(updates.map(event => "toolCallId" in event.update ? event.update.toolCallId : "")).toEqual([rows(old)[24]!.message.content[0].tool_use_id, rows(old)[25]!.message.content[0].tool_use_id])
  expect(new Set(events(all).map(event => event.sourceEventId)).size).toBe(14)
})

it("captures each native call, result and compaction boundary while preserving pending EOF polls", async () => {
  const source = sources[2]!; let cursor: string | null = null, old = ""; const all: AdapterCollectionPage[] = []
  for (const [cut, count, pending] of [[23, 7, 0], [24, 8, 0], [25, 9, 1], [26, 10, 0], [27, 10, 0], [36, 10, 1], [37, 10, 1], [38, 11, 0], [40, 12, 0]] as const) {
    const next = prefix(source, cut); await appendFile(file, next.slice(old.length)); const captured = await drain(cursor, true, { eventsPerObservation: 1 })
    all.push(...captured.pages); cursor = captured.cursor; old = next
    expect(events(all)).toHaveLength(count); expect(captured.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(pending)
    expectRaw(all, cut === 36 ? prefix(source, 27) : next)
    const idle = await read(request(cursor)); expect(idle.nextCursor).toBe(cursor); expect(idle.observations).toEqual([])
  }
  expect(totals(all)).toEqual({ records: 4, input: 190093, output: 64 })
})

it("rejects a reverse checkpoint disguised as an ordered remaining-call state at EOF", async () => {
  const source = sources[2]!, records = rows(source)
  await writeFile(file, prefix(source, 25)); const captured = await drain()
  const corrupted = damage(captured.cursor!, checkpoint => {
    checkpoint.stream.readPair.secondCallUuid = records[23]!.uuid
    checkpoint.stream.readPair.secondToolId = records[23]!.message.content[0].id
    checkpoint.stream.readPair.secondFilePath = records[23]!.message.content[0].input.file_path
  })
  await reject(request(corrupted), "cursor")
})

it.each(["first", "remaining"])("waits for a complete %s result and preserves the input Raw frontier", async slot => {
  const source = sources[2]!, cut = slot === "first" ? 24 : 25, admitted = prefix(source, cut)
  await writeFile(file, admitted); const before = await drain()
  const remainder = source.slice(admitted.length), firstLine = remainder.slice(0, remainder.indexOf("\n"))
  await appendFile(file, firstLine); const input = request(before.cursor), partial = await read(input)
  expect(await read(input)).toEqual(partial); expect(partial.nextCursor).toBe(before.cursor); expect(partial.observations).toEqual([])
  expect(partial.hasMore).toBe(false); expect(partial.progress?.pendingCanonicalSessions).toBe(1)
  await appendFile(file, remainder.slice(firstLine.length)); const restored = await drain(before.cursor, true, { eventsPerObservation: 1 })
  expect(events(restored.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(slot === "first" ? 2 : 1)
  expectRaw([...before.pages, ...restored.pages], source)
})

it.each(["blank", "bookkeeping", "external user", "wrong prompt"])("rejects an intervening %s after the first reverse receipt and repairs without replaying it", async variant => {
  const source = sources[2]!, records = rows(source)
  await writeFile(file, prefix(source, 25)); const before = await drain()
  const wrong = variant === "blank" ? "\n" : variant === "bookkeeping" ? lines([{ type: "queue-operation", operation: "enqueue", sessionId: records[0]!.sessionId }]) :
    variant === "external user" ? lines([{ ...records[19], uuid: "foreign-user", parentUuid: records[24]!.uuid }]) :
      lines([{ ...records[25], promptId: "wrong-prompt" }])
  await appendFile(file, wrong); await reject(request(before.cursor))
  await writeFile(file, source); const restored = await drain(before.cursor)
  const updates = events(restored.pages).filter(event => event.update.sessionUpdate === "tool_call_update")
  expect(updates).toHaveLength(1); expect(updates[0]!.sourceEventId).not.toBe(events(before.pages).at(-1)!.sourceEventId)
  expectRaw([...before.pages, ...restored.pages], source)
})

it.each([
  ["positive Event offset", (checkpoint: Row) => { checkpoint.stream.eventSkip = 1 }],
  ["negative Event offset", (checkpoint: Row) => { checkpoint.stream.eventSkip = -1 }],
  ["fractional Event offset", (checkpoint: Row) => { checkpoint.stream.eventSkip = 0.5 }],
  ["wrong remaining path", (checkpoint: Row) => { checkpoint.stream.readPair.secondFilePath += ".other" }],
  ["wrong stored prompt", (checkpoint: Row) => { checkpoint.stream.readPair.promptId = "other-prompt" }],
  ["duplicate remembered tool", (checkpoint: Row) => { checkpoint.stream.calls.push(checkpoint.stream.calls[0]) }],
  ["wrong recognized version", (checkpoint: Row) => { checkpoint.stream.readPair.v = 2 }]
] as const)("rejects reverse pending cursor damage at EOF: %s", async (_label, change) => {
  await writeFile(file, prefix(sources[2]!, 25)); const before = await drain()
  await reject(request(damage(before.cursor!, change)), "cursor")
  await appendFile(file, sources[2]!.slice(prefix(sources[2]!, 25).length)); const restored = await drain(before.cursor)
  expect(events(restored.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(1)
  expectRaw([...before.pages, ...restored.pages], sources[2]!)
})

it("preserves genuine Call1 Event-only usage progress until the complete call enters the reverse proof", async () => {
  const records = rows(sources[2]!), response = "response-" + "x".repeat(491)
  for (const index of [21, 22, 23, 29, 30, 31]) records[index]!.message.id = response
  await writeFile(file, lines(records.slice(0, 23))); const before = await drain()
  await appendFile(file, lines(records.slice(23)))
  const input = request(before.cursor, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 9440 }), eventPage = await read(input)
  expect(await read(input)).toEqual(eventPage); expect(events([eventPage])).toHaveLength(1); expect(usage([eventPage])).toEqual([])
  acknowledge(eventPage)
  await reject(request(eventPage.nextCursor, true, { canonicalBytesPerObservation: 8941 }), "limit")
  const restored = await drain(eventPage.nextCursor, true, { eventsPerObservation: 1 })
  expect(events(restored.pages)).toHaveLength(4)
  expect(new Set(events([...before.pages, eventPage, ...restored.pages]).map(event => event.sourceEventId)).size).toBe(12)
  expect(totals([...before.pages, eventPage, ...restored.pages])).toEqual({ records: 4, input: 190093, output: 64 })
  expectRaw([...before.pages, eventPage, ...restored.pages], lines(records))
})

it("keeps the remaining result's ordinary large receipt bound and omits oversized Canonical details", async () => {
  const records = rows(sources[2]!)
  records[25]!.message.content[0].content = "remaining Read detail ".repeat(10_000)
  records[25]!.toolUseResult.file.content = "remaining file body ".repeat(5_000)
  await writeFile(file, lines(records.slice(0, 25))); const before = await drain()
  await appendFile(file, lines(records.slice(25, 27))); const remaining = await drain(before.cursor)
  const update = events(remaining.pages).find(event => event.update.sessionUpdate === "tool_call_update")!
  expect(update.update).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" })
  expect(update.update).not.toHaveProperty("rawOutput")
  expect(remaining.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  expectRaw([...before.pages, ...remaining.pages], lines(records.slice(0, 27)))
})

it("captures Canonical while Raw is disabled then backfills the unchanged source object", async () => {
  await writeFile(file, sources[2]!); const captured = await drain(null, false, { eventsPerObservation: 1 })
  expect(events(captured.pages)).toHaveLength(12); expect(raw(captured.pages)).toEqual([])
  const backfill = await drain(captured.cursor, true, { rawSegmentBytes: 4096, rawBytesPerObservation: 4096 })
  expect(events(backfill.pages)).toEqual([]); expect(usage(backfill.pages)).toEqual([])
  expectRaw(backfill.pages, sources[2]!)
})

it("retries first-result Canonical deterministically while independently acknowledging Raw inside that receipt", async () => {
  const source = sources[2]!, beforeSource = prefix(source, 24), firstSource = prefix(source, 25)
  await writeFile(file, beforeSource); const before = await drain(null, false)
  await appendFile(file, firstSource.slice(beforeSource.length))
  const initial = await read(request(before.cursor)), initialRaw = raw([initial])[0]!
  const split = Buffer.byteLength(beforeSource) + 32
  expect(split).toBeLessThan(Buffer.byteLength(firstSource))
  progress = [{ sourceSessionId: initial.observations[0]!.session.sourceSessionId, sourceObjectId: initialRaw.sourceObjectId,
    sourceGeneration: initialRaw.sourceGeneration, sourceOffset: split, finalized: false }]
  const input = request(before.cursor), restoredRaw = await read(input)
  expect(await read(input)).toEqual(restoredRaw); expect(events([restoredRaw])).toEqual(events([initial])); expect(usage([restoredRaw])).toEqual([])
  const remainder = raw([restoredRaw])[0]!
  expect(remainder.sourceOffset).toBe(split)
  expect(Buffer.from(initialRaw.content).subarray(0, split).toString() + remainder.content).toBe(firstSource)
  acknowledge(restoredRaw)
  await appendFile(file, source.slice(firstSource.length)); const restored = await drain(restoredRaw.nextCursor)
  expect(events(restored.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(1)
  expect(totals([...before.pages, restoredRaw, ...restored.pages])).toEqual({ records: 4, input: 190093, output: 64 })
})

it.each([false, true])("retains ordinary tool-only reverse-first ACK behavior with large unrelated history: %s", async large => {
  const rawSource = (await readFile(new URL("../fixtures/native-read-pair-2.1.263/tool-only/tools.jsonl", import.meta.url), "utf8"))
    .replaceAll("/fixture/native-parallel-read/workspace", directory), records = rows(rawSource)
  const firstResult = records[7]!; records[7] = records[8]!; records[8] = firstResult
  records[7]!.unknown = "x".repeat(70_000)
  if (large) records.find(row => row.type === "user" && row.parentUuid === null)!.message.content = "large ordinary root ".repeat(30_000)
  await writeFile(file, lines(records.slice(0, 8))); const first = await drain(null, true, { eventsPerObservation: 1 })
  expect(first.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  const idle = await read(request(first.cursor)); expect(idle.nextCursor).toBe(first.cursor); expect(idle.observations).toEqual([])
  expectRaw(first.pages, lines(records.slice(0, 8)))
  await appendFile(file, lines(records.slice(8))); await reject(request(first.cursor), "limit")
})

it("rejects a changed admitted reverse prefix and resumes its unchanged ACK after repair", async () => {
  const source = sources[2]!
  await writeFile(file, prefix(source, 25)); const before = await drain()
  const changed = rows(source); changed[24]!.toolUseResult.file.content += " changed"
  await writeFile(file, lines(changed)); await reject(request(before.cursor), "changed")
  await writeFile(file, source); const restored = await drain(before.cursor)
  expect(events(restored.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(1)
  expectRaw([...before.pages, ...restored.pages], source)
})
