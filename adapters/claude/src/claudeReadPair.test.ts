import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-read-pair-2.1.263/", import.meta.url)
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let tools: string, resume: string, warmup: string, textPlan: string, progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-read-pair-")); file = join(directory, "session.jsonl")
  const sources = await Promise.all(["tool-only/tools", "tool-only/resume", "text-plan/warmup", "text-plan/toolturn"].map(async name =>
    (await readFile(new URL(`${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-parallel-read/workspace", directory)))
  tools = sources[0]!; resume = sources[1]!; warmup = sources[2]!; textPlan = sources[3]!
  await writeFile(file, resume)
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const rows = (source: string): Row[] => source.trimEnd().split("\n").map(line => JSON.parse(line))
const lines = (records: Row[]) => records.map(row => JSON.stringify(row)).join("\n") + "\n"
const prefix = (source: string, count: number) => source.split(/(?<=\n)/).slice(0, count).join("")
const request = (cursor: string | null = null, raw = true, limits: Partial<AdapterCollectRequest["limits"]> = {}): AdapterCollectRequest => ({
  protocolVersion: "atape.adapter.v1alpha1", cursor, rawProgress: progress, rawCaptureEnabled: raw,
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
const raw = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.rawSegments))
const usage = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.usage ?? []))
const drain = async (cursor: string | null = null, rawEnabled = true, limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  const pages: AdapterCollectionPage[] = []
  for (let n = 0; n < 150; n++) {
    const input = request(cursor, rawEnabled, limits), page = await read(input)
    expect(await read(input)).toEqual(page); expect(page.sourceFailures).toBeUndefined()
    for (const observation of page.observations) {
      expect(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] }))).toBeLessThanOrEqual(input.limits.canonicalBytesPerObservation)
      expect(observation.events.length).toBeLessThanOrEqual(input.limits.eventsPerObservation)
      expect(observation.rawSegments.reduce((sum, segment) => sum + Buffer.byteLength(segment.content), 0)).toBeLessThanOrEqual(input.limits.rawBytesPerObservation)
    }
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.hasMore && !page.observations.length) return { pages, cursor }
  }
  throw new Error("Claude Read pair collection did not finish bounded pages")
}
const latestUsage = (pages: AdapterCollectionPage[]) => {
  const samples = new Map<string, AdapterUsage>()
  for (const sample of usage(pages)) {
    const key = `${sample.sourceThreadId}\0${sample.sourceUsageId}`, previous = samples.get(key)
    if (!previous || sample.revision > previous.revision) samples.set(key, sample)
    else if (sample.revision === previous.revision) expect(sample).toEqual(previous)
  }
  return { records: samples.size, input: [...samples.values()].reduce((sum, sample) => sum + sample.inputTokens!, 0),
    output: [...samples.values()].reduce((sum, sample) => sum + sample.outputTokens!, 0) }
}
const expectRaw = (pages: AdapterCollectionPage[], source: string) => {
  const segments = raw(pages)
  expect(new Set(segments.map(segment => segment.sourceObjectId)).size).toBe(1)
  expect(new Set(segments.map(segment => segment.sourceGeneration)).size).toBe(1)
  let offset = 0
  for (const segment of segments) { expect(segment.sourceOffset).toBe(offset); offset += Buffer.byteLength(segment.content) }
  expect(segments.map(segment => segment.content).join("")).toBe(source)
}
const damagedCursor = (cursor: string, change: (checkpoint: Row) => void) => {
  const value = JSON.parse(cursor.startsWith("z3:") ? inflateRawSync(Buffer.from(cursor.slice(3), "base64url")).toString() : cursor)
  change(value.sessions[0].checkpoint)
  return JSON.stringify(value)
}
const reject = async (input: AdapterCollectRequest, reason = "unsupported") => {
  const receipts = structuredClone(progress)
  await expect(read(input)).rejects.toMatchObject({ reason }); await expect(read(input)).rejects.toMatchObject({ reason })
  expect(progress).toEqual(receipts)
}

it.each(["tool-only", "text-plan"])("captures native %s through separate calls/results, EOF polls and one-event restarted retries", async kind => {
  const source = kind === "tool-only" ? tools : textPlan, call0 = kind === "tool-only" ? 6 : 20
  await writeFile(file, prefix(source, call0))
  const initial = await drain(null, true, { eventsPerObservation: 1 }), captured = [...initial.pages]
  expect(events(initial.pages)).toHaveLength(kind === "tool-only" ? 2 : 7)
  expect(initial.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(0)
  let cursor = initial.cursor, old = prefix(source, call0)
  for (const [offset, pending] of [[1, 0], [2, 1], [3, 0]] as const) {
    const next = prefix(source, call0 + offset)
    await appendFile(file, next.slice(old.length))
    const collected = await drain(cursor, true, { eventsPerObservation: 1 }); captured.push(...collected.pages)
    expect(events(collected.pages)).toHaveLength(1)
    const idle = collected.pages.at(-1)!
    expect(idle.progress).toMatchObject({ pendingCanonicalSessions: pending, pendingRawBytes: 0, phase: "idle" })
    expect((await read(request(collected.cursor))).nextCursor).toBe(collected.cursor)
    cursor = collected.cursor; old = next
  }
  await appendFile(file, source.slice(old.length))
  const final = await drain(cursor, true, { eventsPerObservation: 1 }); captured.push(...final.pages)
  expect(events(final.pages)).toHaveLength(kind === "tool-only" ? 1 : 2)
  expect(events(captured)).toHaveLength(kind === "tool-only" ? 6 : 12)
  expect(latestUsage(captured)).toEqual(kind === "tool-only" ? { records: 2, input: 72, output: 18 } : { records: 4, input: 130, output: 64 })
  const sourceRows = rows(source), updates = events(captured).filter(event => event.update.sessionUpdate === "tool_call_update")
  expect(updates.map(event => "toolCallId" in event.update ? event.update.toolCallId : "")).toEqual(sourceRows
    .filter(row => row.type === "assistant" && row.message.content[0]?.type === "tool_use").map(row => row.message.content[0].id))
  expect(updates.every(event => event.update.sessionUpdate === "tool_call_update" && event.update.status === "completed")).toBe(true)
  expect(new Set(events(captured).map(event => event.sourceEventId)).size).toBe(events(captured).length)
  expectRaw(captured, source)
  if (kind === "tool-only") {
    await appendFile(file, resume.slice(tools.length))
    const continued = await drain(final.cursor, true, { eventsPerObservation: 1 }); captured.push(...continued.pages)
    expect(events(continued.pages)).toHaveLength(2)
    expect(latestUsage(captured)).toEqual({ records: 3, input: 101, output: 31 })
    expectRaw(captured, resume)
  }
})

it.each(["tool-only", "text-plan"])("proves same-page %s calls and preserves identities through Raw-off/full backfill", async kind => {
  const source = kind === "tool-only" ? resume : textPlan
  await writeFile(file, source)
  const off = await drain(null, false)
  expect(events(off.pages)).toHaveLength(kind === "tool-only" ? 8 : 12); expect(raw(off.pages)).toEqual([])
  expect(latestUsage(off.pages)).toEqual(kind === "tool-only" ? { records: 3, input: 101, output: 31 } : { records: 4, input: 130, output: 64 })
  const backfill = await drain(off.cursor, true, { rawSegmentBytes: 4096, rawBytesPerObservation: 4096 })
  expect(events(backfill.pages)).toEqual([]); expect(usage(backfill.pages)).toEqual([])
  expectRaw(backfill.pages, source)
})

it.each(["tool-only", "text-plan"].flatMap(kind => ["first", "second"].map(slot => [kind, slot]))) (
  "waits for the complete %s %s receipt without acknowledging partial bytes", async (kind, slot) => {
    const source = kind === "tool-only" ? tools : textPlan, index = (kind === "tool-only" ? 7 : 21) + (slot === "second" ? 1 : 0)
    const committed = prefix(source, index), remaining = source.slice(committed.length), cut = Math.floor(remaining.indexOf("\n") / 2)
    await writeFile(file, committed)
    const initial = await drain(null, true, { eventsPerObservation: 1 })
    await appendFile(file, remaining.slice(0, cut))
    const input = request(initial.cursor), idle = await read(input)
    expect(await read(input)).toEqual(idle); expect(idle.observations).toEqual([]); expect(idle.nextCursor).toBe(initial.cursor)
    expect(idle.hasMore).toBe(false); expect(idle.progress?.pendingCanonicalSessions).toBe(1)
    await appendFile(file, remaining.slice(cut))
    const recovered = await drain(initial.cursor, true, { eventsPerObservation: 1 })
    expect(events(recovered.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(slot === "first" ? 2 : 1)
    expectRaw([...initial.pages, ...recovered.pages], source)
  })

const receiptMutations: [string, (row: Row) => void][] = [
  ["foreign source call", row => row.sourceToolAssistantUUID = "foreign-call"],
  ["missing source call", row => delete row.sourceToolAssistantUUID],
  ["foreign parent", row => row.parentUuid = "foreign-parent"],
  ["foreign tool id", row => row.message.content[0].tool_use_id = "foreign-tool"],
  ["multiple result blocks", row => row.message.content.push(structuredClone(row.message.content[0]))],
  ["explicit is_error false", row => row.message.content[0].is_error = false],
  ["non-string result", row => row.message.content[0].content = []],
  ["wrong role", row => row.message.role = "assistant"],
  ["async flag false", row => row.toolUseResult.isAsync = false],
  ["status null", row => row.toolUseResult.status = null],
  ["agent marker empty", row => row.toolUseResult.agentId = ""],
  ["different file path", row => row.toolUseResult.file.filePath += ".other"],
  ["invalid line counters", row => row.toolUseResult.file.numLines = 0.5],
  ["line range overflow", row => row.toolUseResult.file.startLine = row.toolUseResult.file.totalLines + 1],
  ["root meta marker", row => row.isMeta = false],
  ["summary marker", row => row.isCompactSummary = false],
  ["child identity", row => { row.isSidechain = true; row.agentId = "foreign-agent" }],
  ["non-native version", row => row.version = "2.1.264"]
]
it.each(receiptMutations.flatMap(([name, mutate]) => ["first", "second"].map(slot => [slot, name, mutate] as const)))(
  "rejects %s Read receipt with %s and recovers from the unchanged public checkpoint", async (slot, _name, mutate) => {
    const index = slot === "first" ? 7 : 8, sourceRows = rows(tools)
    await writeFile(file, prefix(tools, index))
    const initial = await drain(null, true, { eventsPerObservation: 1 })
    mutate(sourceRows[index]!); await appendFile(file, lines([sourceRows[index]!]))
    await reject(request(initial.cursor))
    await writeFile(file, tools)
    const restored = await drain(initial.cursor, true, { eventsPerObservation: 1 })
    expect(events(restored.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(slot === "first" ? 2 : 1)
    expectRaw([...initial.pages, ...restored.pages], tools)
  })

it("pins the shared prompt id to the first receipt", async () => {
  await writeFile(file, prefix(tools, 8)); const initial = await drain()
  const second = rows(tools)[8]!; second.promptId = "different-prompt"
  await appendFile(file, lines([second])); await reject(request(initial.cursor))
  await writeFile(file, tools); const recovered = await drain(initial.cursor)
  expect(events(recovered.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(1)
})

const callMutations: [string, (records: Row[]) => void][] = [
  ["different API id", records => records[6]!.message.id = "different-api"],
  ["different model", records => records[6]!.message.model = "different-model"],
  ["wrong role", records => records[6]!.message.role = "user"],
  ["non-tool stop reason", records => records[6]!.message.stop_reason = "end_turn"],
  ["wrong first API index", records => records[5]!.apiBlockIndex = 1],
  ["wrong second API index", records => records[6]!.apiBlockIndex = 2],
  ["non-Read tool", records => records[6]!.message.content[0].name = "Write"],
  ["mixed block", records => records[6]!.message.content.push({ type: "text", text: "extra" })],
  ["root meta flag", records => records[6]!.isMeta = false],
  ["compaction marker", records => records[6]!.isVisibleInTranscriptOnly = false],
  ["foreign CWD", records => records[6]!.cwd += "/foreign"],
  ["non-native version", records => records[6]!.version = "2.1.264"]
]
it.each(callMutations)("rejects a call witness with %s after ordinary calls were acknowledged", async (_name, mutate) => {
  const records = rows(tools); mutate(records)
  await writeFile(file, lines(records.slice(0, 7))); const initial = await drain()
  await appendFile(file, lines(records.slice(7)))
  await reject(request(initial.cursor))
})

it.each(["blank", "bookkeeping"])("requires physically adjacent calls even across %s records", async kind => {
  const source = prefix(tools, 6) + (kind === "blank" ? "\n" : lines([{ type: "queue-operation", operation: "enqueue" }])) + tools.slice(prefix(tools, 6).length)
  const callEnd = prefix(source, 8)
  await writeFile(file, callEnd); const initial = await drain()
  await appendFile(file, source.slice(callEnd.length)); await reject(request(initial.cursor))
})

it.each(["API id", "model", "index", "non-text", "empty", "stop reason"])("requires the native same-response text plan: %s", async change => {
  const records = rows(textPlan), plan = records[18]!
  if (change === "API id") plan.message.id = "another-api"
  if (change === "model") plan.message.model = "another-model"
  if (change === "index") plan.apiBlockIndex = 1
  if (change === "non-text") plan.message.content = [{ type: "thinking", thinking: "plan" }]
  if (change === "empty") plan.message.content[0].text = ""
  if (change === "stop reason") plan.message.stop_reason = "end_turn"
  await writeFile(file, lines(records.slice(0, 21))); const initial = await drain()
  await appendFile(file, lines(records.slice(21))); await reject(request(initial.cursor))
})

it("rejects a damaged first-result skip while recovering exactly its missing update", async () => {
  await writeFile(file, prefix(tools, 7)); const initial = await drain()
  await appendFile(file, prefix(tools, 8).slice(prefix(tools, 7).length))
  const broken = damagedCursor(initial.cursor!, checkpoint => checkpoint.stream.eventSkip = 1)
  await reject(request(broken), "cursor")
  const recovered = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(recovered.pages)).toHaveLength(1)
  expect(events(recovered.pages)[0]!.update).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "call_parallel_read_a" })
  expectRaw([...initial.pages, ...recovered.pages], prefix(tools, 8))
})

const cursorMutations: [string, (checkpoint: Row) => void][] = [
  ["positive skip", checkpoint => checkpoint.stream.eventSkip = 1],
  ["negative skip", checkpoint => checkpoint.stream.eventSkip = -1],
  ["fractional skip", checkpoint => checkpoint.stream.eventSkip = 0.5],
  ["stage version", checkpoint => checkpoint.stream.readPair.v = 2],
  ["missing path", checkpoint => delete checkpoint.stream.readPair.secondFilePath],
  ["NUL path", checkpoint => checkpoint.stream.readPair.secondFilePath = "bad\0path"],
  ["wrong second call", checkpoint => checkpoint.stream.readPair.secondCallUuid = "foreign"],
  ["wrong tool binding", checkpoint => checkpoint.stream.readPair.secondToolId = "foreign"],
  ["older projection", checkpoint => checkpoint.projectionRevision = 3],
  ["duplicate call id", checkpoint => checkpoint.stream.calls.push(checkpoint.stream.calls.at(-1))],
  ["invalid first call id", checkpoint => checkpoint.stream.calls[0][0] = ""],
  ["concurrent auto stage", checkpoint => checkpoint.stream.autoText = { v: 1, boundaryUuid: "b", summaryUuid: "s", promptId: "p", slug: "slug" }]
]
it.each(cursorMutations)("fails a recognized pending Read checkpoint with %s instead of resetting it", async (_name, mutate) => {
  await writeFile(file, prefix(tools, 8)); const initial = await drain()
  await appendFile(file, tools.slice(prefix(tools, 8).length))
  await reject(request(damagedCursor(initial.cursor!, mutate)), "cursor")
  const recovered = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(recovered.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(1)
})

it("finishes a genuinely acknowledged call Event's pending usage before proving the result batch", async () => {
  const records = rows(tools)
  for (const call of records.slice(5, 7)) call.message.id = "a".repeat(500)
  records[6]!.message.usage.input_tokens = 11; records[6]!.message.usage.output_tokens = 3
  const source = lines(records), beforeCall1 = prefix(source, 6)
  await writeFile(file, beforeCall1); const initial = await drain()
  await appendFile(file, prefix(source, 7).slice(beforeCall1.length))
  const preview = await read(request(initial.cursor)), observation = preview.observations[0]!
  const eventSize = Buffer.byteLength(JSON.stringify(observation.events[0])), usageSize = Buffer.byteLength(JSON.stringify(observation.usage![0]))
  expect(usageSize).toBeGreaterThan(eventSize)
  const envelope = 8192 + Buffer.byteLength(JSON.stringify(observation.threads))
  const input = request(initial.cursor, true, { canonicalBytesPerObservation: envelope + usageSize + 1 }), deferred = await read(input)
  expect(await read(input)).toEqual(deferred); expect(events([deferred])).toHaveLength(1)
  expect(usage([deferred])).toEqual([]); expect(raw([deferred])).toEqual([]); expect(deferred.hasMore).toBe(true)
  acknowledge(deferred)
  await appendFile(file, source.slice(prefix(source, 7).length))
  await reject(request(deferred.nextCursor, true, { canonicalBytesPerObservation: envelope + usageSize - 1 }), "limit")
  const recovered = await drain(deferred.nextCursor, true, { eventsPerObservation: 1 })
  expect(events(recovered.pages).map(event => event.sourceEventId)).not.toContain(events([deferred])[0]!.sourceEventId)
  expect(events(recovered.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(2)
  expect(latestUsage([...initial.pages, deferred, ...recovered.pages])).toEqual({ records: 2, input: 52, output: 14 })
  expectRaw([...initial.pages, deferred, ...recovered.pages], source)
})

it("admits each result on its own Raw page and rejects an impossible fresh record budget", async () => {
  const callEnd = prefix(tools, 7), firstEnd = prefix(tools, 8), secondEnd = prefix(tools, 9)
  await writeFile(file, callEnd); const initial = await drain()
  await appendFile(file, secondEnd.slice(callEnd.length))
  const firstBytes = Buffer.byteLength(firstEnd) - Buffer.byteLength(callEnd), secondBytes = Buffer.byteLength(secondEnd) - Buffer.byteLength(firstEnd)
  await reject(request(initial.cursor, true, { rawSegmentBytes: firstBytes - 1, rawBytesPerObservation: firstBytes - 1 }), "limit")
  const limit = Math.max(firstBytes, secondBytes), recovered = await drain(initial.cursor, true, { rawSegmentBytes: limit, rawBytesPerObservation: limit })
  expect(events(recovered.pages)).toHaveLength(2)
  expect(recovered.pages.filter(page => page.observations.length)).toHaveLength(2)
  expect(recovered.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  expectRaw([...initial.pages, ...recovered.pages], secondEnd)
})

it("defers a whole first result when this page cannot hold it without pinning pending progress", async () => {
  const callEnd = prefix(tools, 6), records = rows(tools)
  await writeFile(file, callEnd); const initial = await drain()
  await appendFile(file, prefix(tools, 8).slice(callEnd.length))
  const callBytes = Buffer.byteLength(lines([records[6]!]))
  const input = request(initial.cursor, true, { rawSegmentBytes: callBytes, rawBytesPerObservation: callBytes }), callPage = await read(input)
  expect(await read(input)).toEqual(callPage)
  expect(events([callPage])).toHaveLength(1); expect(callPage.hasMore).toBe(true)
  expect(raw([callPage]).map(segment => segment.content).join("")).toBe(lines([records[6]!]))
  acknowledge(callPage)
  const receipt = await drain(callPage.nextCursor, true, { eventsPerObservation: 1 })
  expect(events(receipt.pages)).toHaveLength(1); expect(receipt.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(1)
  expectRaw([...initial.pages, callPage, ...receipt.pages], prefix(tools, 8))
})

it("retains separate complete large Read receipts while bounded Canonical details are omitted", async () => {
  const records = rows(tools)
  for (const row of records.slice(7, 9)) {
    row.message.content[0].content = "1\t" + "r".repeat(500_000)
    row.toolUseResult.file.content = "r".repeat(500_000) + "\n"
  }
  const source = lines(records), callEnd = prefix(source, 7), secondEnd = prefix(source, 9)
  await writeFile(file, callEnd); const initial = await drain()
  await appendFile(file, secondEnd.slice(callEnd.length))
  const limit = Math.max(...records.slice(7, 9).map(row => Buffer.byteLength(lines([row]))))
  const results = await drain(initial.cursor, true, { rawSegmentBytes: limit, rawBytesPerObservation: limit, canonicalBytesPerObservation: 9000, eventsPerObservation: 1 })
  const updates = events(results.pages)
  expect(updates).toHaveLength(2)
  expect(updates.map(event => event.sourceEventId)).toEqual(records.slice(7, 9).map(row => `${row.uuid}:0`))
  expect(updates.every(event => event.update.sessionUpdate === "tool_call_update" && event.update.rawOutput === undefined)).toBe(true)
  expectRaw([...initial.pages, ...results.pages], secondEnd)
})

it("authenticates calls after fragmenting a large ordinary user without treating its partial record as committed proof", async () => {
  const records = rows(tools), root = records.find(row => row.type === "user")!
  root.message.content = "Large earlier user " + "u".repeat(600_000)
  const source = lines(records)
  await writeFile(file, source)
  const captured = await drain(null, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 300_000 })
  expect(events(captured.pages).filter(event => event.update.sessionUpdate === "user_message_chunk")).toHaveLength(3)
  expect(events(captured.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(2)
  expect(new Set(events(captured.pages).map(event => event.sourceEventId)).size).toBe(events(captured.pages).length)
  expect(latestUsage(captured.pages)).toEqual({ records: 2, input: 72, output: 18 })
  expectRaw(captured.pages, source)
})

it.each(["call", "text-plan"])("rejects a %s witness exceeding 64 KiB after preserving ordinary acknowledged Events", async kind => {
  const records = rows(kind === "call" ? tools : textPlan), callCount = kind === "call" ? 7 : 21
  records[kind === "call" ? 5 : 18]!.unknownNativeField = "x".repeat(70_000)
  const source = lines(records)
  await writeFile(file, prefix(source, callCount)); const initial = await drain()
  await appendFile(file, source.slice(prefix(source, callCount).length)); await reject(request(initial.cursor), "limit")
  expect(events(initial.pages).length).toBeGreaterThan(0)
})

it("does not impose a new JSON depth policy or a witness cap on an irrelevant preceding record", async () => {
  const records = rows(tools)
  records[5]!.unknownNativeField = JSON.parse('{"d":'.repeat(4000) + '1' + '}'.repeat(4000))
  records[4]!.unknownNativeField = "x".repeat(400_000)
  const source = lines(records)
  await writeFile(file, source); const captured = await drain(null, true, { eventsPerObservation: 1 })
  expect(events(captured.pages)).toHaveLength(6); expect(latestUsage(captured.pages)).toEqual({ records: 2, input: 72, output: 18 })
  expectRaw(captured.pages, source)
})

it("recovers from independent Raw receipts while the caller retains its pre-result parser checkpoint", async () => {
  const callEnd = prefix(tools, 7), firstEnd = prefix(tools, 8), secondEnd = prefix(tools, 9)
  await writeFile(file, callEnd); const initial = await drain(null, false)
  await appendFile(file, secondEnd.slice(callEnd.length))
  const limit = Math.ceil((Buffer.byteLength(callEnd) + (Buffer.byteLength(firstEnd) - Buffer.byteLength(callEnd)) / 2) / 4)
  expect(limit).toBeGreaterThanOrEqual(Buffer.byteLength(secondEnd) - Buffer.byteLength(firstEnd))
  const captured: AdapterCollectionPage[] = []
  let nextCursor = initial.cursor, expectedEvent: ReturnType<typeof events>[number] | undefined, interruptedInResult = false
  for (let attempt = 0; attempt < 20; attempt++) {
    const input = request(initial.cursor, true, { rawSegmentBytes: limit, rawBytesPerObservation: limit }), page = await read(input)
    expect(await read(input)).toEqual(page); expect(events([page])).toHaveLength(1)
    expectedEvent ??= events([page])[0]!
    expect(events([page])[0]).toEqual(expectedEvent)
    expect(usage([page])).toEqual([]); captured.push(page); acknowledge(page); nextCursor = page.nextCursor
    const offset = progress[0]!.sourceOffset
    interruptedInResult ||= offset > Buffer.byteLength(callEnd) && offset < Buffer.byteLength(firstEnd)
    if (offset === Buffer.byteLength(firstEnd)) break
    if (attempt === 19) throw new Error("Independent Raw receipts did not reach the first result")
  }
  expect(interruptedInResult).toBe(true)
  const second = await drain(nextCursor, true, { rawSegmentBytes: limit, rawBytesPerObservation: limit })
  expect(events(second.pages)).toHaveLength(1); expect(events(second.pages)[0]!.sourceEventId).not.toBe(expectedEvent!.sourceEventId)
  expect(second.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  expectRaw([...captured, ...second.pages], secondEnd)
})

it.each(["blank", "bookkeeping", "assistant", "manual boundary"])("rejects %s between the two receipts without acknowledging it", async kind => {
  await writeFile(file, prefix(tools, 8)); const initial = await drain()
  const unrelated = kind === "blank" ? "\n" : kind === "bookkeeping" ? lines([{ type: "queue-operation" }]) : kind === "assistant"
    ? lines([{ ...rows(tools)[10], parentUuid: rows(tools)[7]!.uuid }]) : lines([{ type: "system", subtype: "compact_boundary", uuid: "foreign-boundary" }])
  await appendFile(file, unrelated); await reject(request(initial.cursor))
  await writeFile(file, tools); const restored = await drain(initial.cursor)
  expect(events(restored.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(1)
})

it("retains a committed first result when its prefix is rewritten or truncated", async () => {
  const committed = prefix(tools, 8)
  await writeFile(file, committed); const initial = await drain()
  await writeFile(file, committed.slice(0, -1)); await reject(request(initial.cursor), "changed")
  await writeFile(file, committed.replace(rows(tools)[5]!.uuid, "rewritten-call-uuid"))
  await reject(request(initial.cursor), "changed")
  await writeFile(file, tools); const restored = await drain(initial.cursor)
  expect(events(restored.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(1)
})

it("does not grant a result parent exception to a foreground child's ordinary Read calls", async () => {
  const familyFixture = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
  const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd"
  const rootText = (await readFile(new URL(`${sessionId}.jsonl`, familyFixture), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const childText = (await readFile(new URL(`${sessionId}/subagents/agent-${agentId}.jsonl`, familyFixture), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const childPath = join(directory, sessionId, "subagents", `agent-${agentId}.jsonl`)
  await mkdir(join(directory, sessionId, "subagents"), { recursive: true }); await writeFile(file, rootText); await writeFile(childPath, childText)
  const initial = await drain(), childRows = rows(childText), callRows = rows(tools).slice(5, 8)
  const last = childRows.filter(row => row.uuid).at(-1)!.uuid
  callRows[0]!.parentUuid = last
  for (const row of callRows) { row.sessionId = sessionId; row.agentId = agentId; row.isSidechain = true }
  await appendFile(childPath, lines(callRows.slice(0, 2)))
  const calls = await drain(initial.cursor), before = structuredClone(progress)
  await appendFile(childPath, lines(callRows.slice(2)))
  const rejected = await read(request(calls.cursor))
  expect(rejected.observations).toEqual([]); expect(rejected.nextCursor).toBe(calls.cursor)
  expect(rejected.sourceFailures).toEqual([{ source: childPath, reason: "unsupported" }]); expect(progress).toEqual(before)
  const broken = damagedCursor(calls.cursor!, checkpoint => {
    checkpoint.children[0].checkpoint.stream.readPair = { v: 1, firstResultUuid: "r", secondCallUuid: "c", secondToolId: "t", secondFilePath: "/f", promptId: "p" }
  })
  await reject(request(broken), "cursor")
})

it.each(["first", "second"])("retains the %s result checkpoint when its one Event cannot fit the requested Canonical page", async slot => {
  const count = slot === "first" ? 7 : 8, committed = prefix(tools, count)
  await writeFile(file, committed); const initial = await drain()
  await appendFile(file, prefix(tools, count + 1).slice(committed.length))
  const preview = await read(request(initial.cursor)), observation = preview.observations[0]!
  const budget = 8192 + Buffer.byteLength(JSON.stringify(observation.threads)) + Buffer.byteLength(JSON.stringify(observation.events[0])) - 1
  await reject(request(initial.cursor, true, { canonicalBytesPerObservation: budget }), "limit")
  const recovered = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(recovered.pages)).toHaveLength(1)
  expect(recovered.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(slot === "first" ? 1 : 0)
  expectRaw([...initial.pages, ...recovered.pages], prefix(tools, count + 1))
})

it("rejects an exact-response third call instead of granting earlier known calls new parent edges", async () => {
  const records = rows(tools), third = structuredClone(records[6]!)
  third.uuid = "third-read-call"; third.parentUuid = records[6]!.uuid; third.apiBlockIndex = 2; third.message.content[0].id = "third-read-id"
  await writeFile(file, prefix(tools, 7) + lines([third])); const initial = await drain()
  await appendFile(file, lines([records[7]!])); await reject(request(initial.cursor))
})

it("preserves the existing linear last-call result but rejects a subsequent reverse batch", async () => {
  const records = rows(tools)
  await writeFile(file, prefix(tools, 7)); const initial = await drain()
  // The last call's own receipt was already a linear update before this profile.
  await appendFile(file, lines([records[8]!]))
  const linear = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(linear.pages)).toHaveLength(1)
  expect(events(linear.pages)[0]!.update).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "call_parallel_read_b" })
  expect(linear.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  await appendFile(file, lines([records[7]!])); await reject(request(linear.cursor))
})

it("rejects pair-local reused tool ids before acknowledging the duplicate call", async () => {
  const records = rows(tools); records[6]!.message.content[0].id = records[5]!.message.content[0].id
  await writeFile(file, lines(records.slice(0, 6))); const initial = await drain()
  await appendFile(file, lines(records.slice(6))); await reject(request(initial.cursor))
})
