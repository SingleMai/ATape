import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-reversed-read-pair-2.1.263/", import.meta.url)
let directory: string, file: string, source: string, records: Row[]
let context: AdapterOpenContext & { signal: AbortSignal }, progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-reversed-read-proof-")); file = join(directory, "session.jsonl")
  source = (await readFile(new URL("r1.jsonl", fixture), "utf8")).replaceAll("/fixture/native-reversed-read-pair/workspace", directory)
  records = source.trimEnd().split("\n").map(line => JSON.parse(line))
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
// Every reserialization/mutation below is an explicit controlled source-proof
// or resource derivation. The checked-in native snapshots are never edited.
const serialize = (rows: Row[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n"
const prefix = (text: string, count: number) => text.split(/(?<=\n)/).slice(0, count).join("")
const request = (cursor: string | null = null, limits: Partial<AdapterCollectRequest["limits"]> = {}): AdapterCollectRequest => ({
  protocolVersion: context.protocolVersion, cursor, rawCaptureEnabled: true, rawProgress: progress,
  limits: { ...AdapterCollectionLimits, eventsPerObservation: 1, ...limits }, signal: new AbortController().signal
})
const read = async (input: AdapterCollectRequest) => {
  const runtime = await createAtapeAdapter(context)
  try { return await runtime.collect(input) as AdapterCollectionPage } finally { await runtime.close?.() }
}
const acknowledge = (page: AdapterCollectionPage) => {
  const receipts = new Map(progress.map(item => [item.sourceObjectId, item]))
  for (const observation of page.observations) for (const raw of observation.rawSegments) receipts.set(raw.sourceObjectId, {
    sourceSessionId: observation.session.sourceSessionId, sourceObjectId: raw.sourceObjectId, sourceGeneration: raw.sourceGeneration,
    sourceOffset: raw.sourceOffset + Buffer.byteLength(raw.content), finalized: raw.final
  })
  progress = [...receipts.values()]
}
const drain = async (cursor: string | null = null, limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  const pages: AdapterCollectionPage[] = []
  for (let n = 0; n < 150; n++) {
    const input = request(cursor, limits), page = await read(input)
    expect(await read(input)).toEqual(page); expect(page.sourceFailures).toBeUndefined()
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.hasMore && !page.observations.length) return { pages, cursor }
  }
  throw new Error("Reversed Read proof did not finish bounded pages")
}
const ack = async (text: string, throughLine: number) => {
  await writeFile(file, prefix(text, throughLine)); return await drain()
}
const reject = async (cursor: string | null, reason = "unsupported", limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  const saved = structuredClone(progress), input = request(cursor, limits)
  await expect(read(input)).rejects.toMatchObject({ reason }); await expect(read(input)).rejects.toMatchObject({ reason })
  expect(input.cursor).toBe(cursor); expect(progress).toEqual(saved)
}
const events = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.events))
const totals = (pages: AdapterCollectionPage[]) => {
  const samples = new Map<string, AdapterUsage>()
  for (const page of pages) for (const observation of page.observations) for (const sample of observation.usage ?? []) {
    const old = samples.get(sample.sourceUsageId); if (!old || old.revision < sample.revision) samples.set(sample.sourceUsageId, sample)
  }
  return { count: samples.size, input: [...samples.values()].reduce((sum, sample) => sum + sample.inputTokens!, 0),
    output: [...samples.values()].reduce((sum, sample) => sum + sample.outputTokens!, 0) }
}
const expectComplete = (pages: AdapterCollectionPage[], text: string, ordinary = false) => {
  expect(events(pages)).toHaveLength(ordinary ? 10 : 12); expect(new Set(events(pages).map(event => event.sourceEventId)).size).toBe(ordinary ? 10 : 12)
  expect(totals(pages)).toEqual(ordinary ? { count: 3, input: 190052, output: 41 } : { count: 4, input: 190093, output: 64 })
  const updates = events(pages).filter(event => event.update.sessionUpdate === "tool_call_update")
  expect(updates.map(event => "toolCallId" in event.update ? event.update.toolCallId : "")).toEqual([
    "call_82f63bfe_dual_r1_read_b", "call_82f63bfe_dual_r1_read_a"
  ])
  const raw = pages.flatMap(page => page.observations.flatMap(observation => observation.rawSegments)); let offset = 0
  for (const segment of raw) { expect(segment.sourceOffset).toBe(offset); offset += Buffer.byteLength(segment.content) }
  expect(new Set(raw.map(segment => segment.sourceObjectId)).size).toBe(1)
  expect(new Set(raw.map(segment => segment.sourceGeneration)).size).toBe(1)
  expect(raw.map(segment => segment.content).join("")).toBe(text)
}
const failAtCopies = async (change: (rows: Row[]) => void, reason = "unsupported") => {
  change(records); const text = serialize(records), before = await ack(text, 27)
  expect(events(before.pages)).toHaveLength(10); await writeFile(file, text); await reject(before.cursor, reason)
}
const padFrame = (row: Row, bytes: number) => {
  row.proofPadding = ""; row.proofPadding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(row) + "\n"))
  expect(Buffer.byteLength(JSON.stringify(row) + "\n")).toBe(bytes)
}
const copyOriginal = (originalIndex: number) => {
  const slug = records[originalIndex + 8]!.slug
  records[originalIndex + 8] = { ...structuredClone(records[originalIndex]!), slug }
}

it.each([0, 1, 2, 3, 4, 5, 6, 7])("rejects changed unknown values in whole-copy slot %i without acknowledging any replay", async slot => {
  await failAtCopies(rows => { rows[27 + slot]!.unknown = { nested: [null, { altered: true }] } })
})
it("preserves complete unknown receipt/copy values while binding reverse results to their own calls", async () => {
  const unknown = { nested: [null, false, { value: "opaque source data", values: [1, 2, 3] }] }
  for (let i = 19; i < 27; i++) {
    records[i]!.unknown = structuredClone(unknown); copyOriginal(i)
  }
  records[24]!.toolUseResult.unknown = structuredClone(unknown); copyOriginal(24)
  records[25]!.toolUseResult.file.unknown = structuredClone(unknown); copyOriginal(25)
  const text = serialize(records); await writeFile(file, text); const captured = await drain(); expectComplete(captured.pages, text)
})
it.each([
  ["first-added slug on an original", (rows: Row[]) => { rows[19]!.slug = rows[27]!.slug }],
  ["different copy slug", (rows: Row[]) => { rows[31]!.slug = "changed-slug" }],
  ["copy root CWD", (rows: Row[]) => { rows[27]!.cwd += "/other" }],
  ["copy current result prompt", (rows: Row[]) => { rows[32]!.promptId = "changed-prompt" }],
  ["copy call index", (rows: Row[]) => { rows[31]!.apiBlockIndex = 1 }],
  ["copy unknown receipt field", (rows: Row[]) => { rows[33]!.toolUseResult.file.extra = "different" }]
] as const)("rejects %s even when the copied UUID is already known", async (_label, change) => { await failAtCopies(change) })
it.each([
  ["sorted preserved UUIDs", (rows: Row[]) => {
    for (const key of ["uuids", "allUuids"]) [rows[35]!.compactMetadata.preservedMessages[key][3], rows[35]!.compactMetadata.preservedMessages[key][4]] =
      [rows[35]!.compactMetadata.preservedMessages[key][4], rows[35]!.compactMetadata.preservedMessages[key][3]]
  }],
  ["stale logical parent", (rows: Row[]) => { rows[35]!.logicalParentUuid = rows[24]!.uuid }],
  ["wrong retained head", (rows: Row[]) => { rows[35]!.compactMetadata.preservedSegment.headUuid = rows[22]!.uuid }],
  ["future summary anchor", (rows: Row[]) => { rows[35]!.compactMetadata.preservedSegment.anchorUuid = rows[37]!.uuid }],
  ["reused boundary UUID", (rows: Row[]) => { rows[35]!.uuid = rows[24]!.uuid }],
  ["summary wrong parent", (rows: Row[]) => { rows[36]!.parentUuid = rows[26]!.uuid }],
  ["summary wrong prompt", (rows: Row[]) => { rows[36]!.promptId = "changed-prompt" }]
] as const)("rejects %s in the boundary/summary without sorting physical results", async (_label, change) => { await failAtCopies(change) })
it.each([
  ["call API ID", (rows: Row[]) => { rows[22]!.message.id = "different-response" }],
  ["call model", (rows: Row[]) => { rows[22]!.message.model = "different-model" }],
  ["call index", (rows: Row[]) => { rows[22]!.apiBlockIndex = 0 }],
  ["call stop reason", (rows: Row[]) => { rows[22]!.message.stop_reason = "end_turn" }],
  ["plan API ID", (rows: Row[]) => { rows[21]!.message.id = "different-plan-response" }],
  ["plan index", (rows: Row[]) => { rows[21]!.apiBlockIndex = 1 }],
  ["empty plan text", (rows: Row[]) => { rows[21]!.message.content[0].text = "" }],
  ["call root version", (rows: Row[]) => { rows[22]!.version = "2.1.264" }]
] as const)("requires current planned same-response proof for %s before first reverse receipt ACK", async (_label, change) => {
  change(records); const text = serialize(records), before = await ack(text, 24)
  await writeFile(file, prefix(text, 25)); await reject(before.cursor)
})
it("rejects a pending result that reuses the already completed B call instead of completing A", async () => {
  const before = await ack(source, 25), wrong = records[25]!
  wrong.parentUuid = records[23]!.uuid; wrong.sourceToolAssistantUUID = records[23]!.uuid
  wrong.message.content[0].tool_use_id = records[23]!.message.content[0].id
  wrong.toolUseResult.file.filePath = records[23]!.message.content[0].input.file_path
  await writeFile(file, serialize(records)); await reject(before.cursor)
})
it("rejects a globally known older tool ID instead of borrowing it for the remaining current call", async () => {
  records[11]!.message.content = [{ type: "tool_use", id: "old-read", name: "Read", input: { file_path: join(directory, "old.txt") } }]
  const text = serialize(records), before = await ack(text, 25), wrong = records[25]!
  wrong.parentUuid = records[11]!.uuid; wrong.sourceToolAssistantUUID = records[11]!.uuid
  wrong.message.content[0].tool_use_id = "old-read"; wrong.toolUseResult.file.filePath = join(directory, "old.txt")
  await writeFile(file, serialize(records)); await reject(before.cursor)
})
it("detects changed authenticated historical values after an actual first-result ACK", async () => {
  const before = await ack(source, 25); records[21]!.proofUnknown = { changed: true }
  await writeFile(file, serialize(records)); await reject(before.cursor, "changed")
})
it("accepts a 64 KiB first reverse receipt through the completed ordinary pair", async () => {
  padFrame(records[24]!, 64 * 1024); copyOriginal(24)
  const text = prefix(serialize(records), 27); await writeFile(file, text); const captured = await drain(); expectComplete(captured.pages, text, true)
})
it("rejects a first reverse receipt one byte beyond the selected 64 KiB policy", async () => {
  padFrame(records[24]!, 64 * 1024 + 1); copyOriginal(24)
  const text = serialize(records), before = await ack(text, 24); await writeFile(file, text); await reject(before.cursor, "limit")
})
it.each([21, 22, 23])("keeps selected planned call frame %i at 64 KiB", async index => {
  padFrame(records[index]!, 64 * 1024); copyOriginal(index)
  const text = prefix(serialize(records), 27); await writeFile(file, text); const captured = await drain(); expectComplete(captured.pages, text, true)
})
it.each([21, 22, 23])("rejects selected planned call frame %i above 64 KiB without first-result ACK", async index => {
  padFrame(records[index]!, 64 * 1024 + 1); copyOriginal(index)
  const text = serialize(records), before = await ack(text, 24); await writeFile(file, text); await reject(before.cursor, "limit")
})
it("retains exactly four 64 KiB proof frames through a first reverse receipt", async () => {
  for (const index of [21, 22, 23, 24]) { padFrame(records[index]!, 64 * 1024); copyOriginal(index) }
  const text = prefix(serialize(records), 27), before = await ack(text, 24); await writeFile(file, prefix(text, 25))
  const first = await drain(before.cursor); expect(events(first.pages)).toHaveLength(1)
  expect(first.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(1)
  await writeFile(file, text); const rest = await drain(first.cursor); expectComplete([...before.pages, ...first.pages, ...rest.pages], text, true)
})
it("hashes unrelated prehistory larger than the 256 KiB selected tail without retaining it as proof", async () => {
  records.splice(14, 0, { type: "queue-operation", operation: "dequeue", sessionId: records[2]!.sessionId, padding: "x".repeat(300 * 1024) })
  const text = serialize(records); await writeFile(file, text); const captured = await drain(); expectComplete(captured.pages, text)
})
it("does not search across a UUID-less gap to invent the adjacent remaining-call proof", async () => {
  const text = prefix(source, 24) + serialize([{ type: "queue-operation", operation: "dequeue", sessionId: records[2]!.sessionId }]) + source.slice(prefix(source, 24).length)
  const before = await ack(text, 25); await writeFile(file, text)
  // This unselected linear result retains prior ordinary behavior. It cannot
  // authorize the non-linear A result or the later automatic group.
  const input = request(before.cursor), first = await read(input); expect(await read(input)).toEqual(first)
  expect(events([first])).toHaveLength(1); acknowledge(first); await reject(first.nextCursor)
})
it("requires a fresh Raw page to fit the complete first reverse receipt", async () => {
  const before = await ack(source, 24), bytes = Buffer.byteLength(prefix(source, 25)) - Buffer.byteLength(prefix(source, 24))
  await writeFile(file, prefix(source, 25)); await reject(before.cursor, "limit", { rawSegmentBytes: bytes - 1, rawBytesPerObservation: bytes - 1 })
  const collected = await drain(before.cursor, { rawSegmentBytes: bytes, rawBytesPerObservation: bytes })
  expect(events(collected.pages)).toHaveLength(1); expect(collected.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(1)
  await writeFile(file, source); const rest = await drain(collected.cursor); expectComplete([...before.pages, ...collected.pages, ...rest.pages], source)
})
it("defers first reverse receipt when its call consumed the remaining Raw page", async () => {
  const before = await ack(source, 23), bytes = Math.max(Buffer.byteLength(prefix(source, 25)) - Buffer.byteLength(prefix(source, 24)),
    Buffer.byteLength(prefix(source, 24)) - Buffer.byteLength(prefix(source, 23)))
  await writeFile(file, prefix(source, 25)); const input = request(before.cursor, { eventsPerObservation: 500, rawSegmentBytes: bytes, rawBytesPerObservation: bytes })
  const page = await read(input); expect(await read(input)).toEqual(page); expect(events([page])).toHaveLength(1)
  acknowledge(page); expect(progress[0]!.sourceOffset).toBe(Buffer.byteLength(prefix(source, 24))); expect(page.hasMore).toBe(true)
  const first = await drain(page.nextCursor, { rawSegmentBytes: bytes, rawBytesPerObservation: bytes })
  expect(events(first.pages)).toHaveLength(1); expect(first.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(1)
  await writeFile(file, source); const rest = await drain(first.cursor); expectComplete([...before.pages, page, ...first.pages, ...rest.pages], source)
})
it("rejects replay that cannot fit its fresh Raw budget and recovers with exactly sufficient capacity", async () => {
  const before = await ack(source, 27), bytes = Buffer.byteLength(prefix(source, 37)) - Buffer.byteLength(prefix(source, 27))
  await writeFile(file, source); await reject(before.cursor, "limit", { rawSegmentBytes: bytes - 1, rawBytesPerObservation: bytes - 1 })
  const rest = await drain(before.cursor, { rawSegmentBytes: bytes, rawBytesPerObservation: bytes }); expectComplete([...before.pages, ...rest.pages], source)
})
it("defers replay to a fresh page after the final reminder consumed its remaining Raw budget", async () => {
  const before = await ack(source, 26), bytes = Buffer.byteLength(prefix(source, 37)) - Buffer.byteLength(prefix(source, 27))
  await writeFile(file, source); const input = request(before.cursor, { rawSegmentBytes: bytes, rawBytesPerObservation: bytes }), page = await read(input)
  expect(await read(input)).toEqual(page); expect(events([page])).toEqual([]); expect(page.hasMore).toBe(true)
  acknowledge(page); expect(progress[0]!.sourceOffset).toBe(Buffer.byteLength(prefix(source, 27)))
  const rest = await drain(page.nextCursor, { rawSegmentBytes: bytes, rawBytesPerObservation: bytes }); expectComplete([...before.pages, page, ...rest.pages], source)
})
