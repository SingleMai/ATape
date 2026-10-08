import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-repeated-auto-read-2.1.263/", import.meta.url)
let directory: string, file: string, source: string, records: Row[]
let context: AdapterOpenContext & { signal: AbortSignal }, progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-repeated-read-proof-")); file = join(directory, "session.jsonl")
  source = (await readFile(new URL("r2.jsonl", fixture), "utf8")).replaceAll("/fixture/native-repeated-auto-read/workspace", directory)
  records = source.trimEnd().split("\n").map(line => JSON.parse(line))
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
// Reordered/reserialized records below are explicit controlled negative/resource
// derivations. The native fixture files themselves are never edited by tests.
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
  throw new Error("Repeated Read proof did not finish bounded pages")
}
const ack = async (text: string, throughLine: number) => {
  await writeFile(file, prefix(text, throughLine)); return await drain()
}
const reject = async (cursor: string | null, reason = "unsupported", limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  const saved = JSON.stringify(progress), input = request(cursor, limits)
  await expect(read(input)).rejects.toMatchObject({ reason }); await expect(read(input)).rejects.toMatchObject({ reason })
  expect(input.cursor).toBe(cursor); expect(JSON.stringify(progress)).toBe(saved)
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
const expectComplete = (pages: AdapterCollectionPage[], text: string) => {
  expect(events(pages)).toHaveLength(16); expect(new Set(events(pages).map(event => event.sourceEventId)).size).toBe(16)
  expect(totals(pages)).toEqual({ count: 6, input: 380134, output: 104 })
  const raw = pages.flatMap(page => page.observations.flatMap(observation => observation.rawSegments)); let offset = 0
  for (const segment of raw) { expect(segment.sourceOffset).toBe(offset); offset += Buffer.byteLength(segment.content) }
  expect(new Set(raw.map(segment => segment.sourceObjectId)).size).toBe(1)
  expect(new Set(raw.map(segment => segment.sourceGeneration)).size).toBe(1)
  expect(raw.map(segment => segment.content).join("")).toBe(text)
}
const failAtSecondCopies = async (change: (rows: Row[]) => void, reason = "unsupported", expectedEvents = 14) => {
  change(records); const text = serialize(records), before = await ack(text, 47)
  expect(events(before.pages)).toHaveLength(expectedEvents); await writeFile(file, text); await reject(before.cursor, reason)
}
const queue = (padding = ""): Row => ({ type: "queue-operation", operation: "dequeue", sessionId: records[0]!.sessionId ?? records[2]!.sessionId, padding })
const padFrame = (row: Row, bytes: number) => {
  row.proofPadding = ""; row.proofPadding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(row) + "\n"))
  expect(Buffer.byteLength(JSON.stringify(row) + "\n")).toBe(bytes)
}

it.each([0, 1, 2, 3, 4, 5])("rejects changed unknown values in R2 whole-copy slot %i without acknowledging it", async slot => {
  await failAtSecondCopies(rows => { rows[47 + slot]!.unknown = { nested: [null, { changed: true }] } })
})
it("preserves whole unknown values in original/copy records and the proved historical receipt", async () => {
  const unknown = { nested: [null, false, { value: "opaque provider data", values: [1, 2, 3] }] }
  records[23]!.toolUseResult.unknown = structuredClone(unknown)
  records[29]!.toolUseResult.unknown = structuredClone(unknown)
  records[55]!.attachment.content.unknown = structuredClone(unknown)
  for (let index = 41; index < 47; index++) {
    records[index]!.unknown = structuredClone(unknown); records[index + 6]!.unknown = structuredClone(unknown)
  }
  const text = serialize(records); await writeFile(file, text); const captured = await drain(); expectComplete(captured.pages, text)
})
it.each([
  ["missing original slug", (rows: Row[]) => { delete rows[41]!.slug; delete rows[47]!.slug }],
  ["changed copy slug", (rows: Row[]) => { rows[47]!.slug = "changed-slug" }],
  ["mixed original slugs", (rows: Row[]) => { rows[43]!.slug = "changed-slug"; rows[49]!.slug = "changed-slug" }],
  ["changed common slug", (rows: Row[]) => { for (const row of rows.slice(41)) if (row.slug) row.slug = "changed-slug" }],
  ["current original CWD", (rows: Row[]) => { rows[43]!.cwd += "/other"; rows[49]!.cwd += "/other" }],
  ["current result prompt", (rows: Row[]) => { rows[45]!.promptId = "other-prompt"; rows[51]!.promptId = "other-prompt" }],
  ["original reminder type", (rows: Row[]) => { rows[42]!.attachment.type = "other-reminder"; rows[48]!.attachment.type = "other-reminder" }]
] as const)("rejects %s in the current single-Read witness", async (_label, change) => { await failAtSecondCopies(change) })
it.each([
  ["B UUID reused from R1", (rows: Row[]) => { rows[53]!.uuid = rows[31]!.uuid }],
  ["S UUID reused from R1", (rows: Row[]) => { rows[53]!.compactMetadata.preservedSegment.anchorUuid = rows[32]!.uuid; rows[53]!.compactMetadata.preservedMessages.anchorUuid = rows[32]!.uuid; rows[54]!.uuid = rows[32]!.uuid }],
  ["B physical parent", (rows: Row[]) => { rows[53]!.parentUuid = rows[46]!.uuid }],
  ["B stale logical parent", (rows: Row[]) => { rows[53]!.logicalParentUuid = rows[24]!.uuid }],
  ["B stale retained tail", (rows: Row[]) => { rows[53]!.compactMetadata.preservedSegment.tailUuid = rows[24]!.uuid }],
  ["B stale preserved UUID", (rows: Row[]) => { rows[53]!.compactMetadata.preservedMessages.allUuids[0] = rows[21]!.uuid }],
  ["B future anchor", (rows: Row[]) => { rows[53]!.compactMetadata.preservedSegment.anchorUuid = rows[56]!.uuid }],
  ["S wrong parent", (rows: Row[]) => { rows[54]!.parentUuid = rows[31]!.uuid }],
  ["S wrong prompt", (rows: Row[]) => { rows[54]!.promptId = "other-prompt" }],
  ["S compact flag", (rows: Row[]) => { delete rows[54]!.isCompactSummary }]
] as const)("rejects %s in the second B/S group", async (_label, change) => { await failAtSecondCopies(change) })
it.each([
  ["first F1 block index", (rows: Row[]) => { rows[34]!.apiBlockIndex = 0 }],
  ["first F1 API ID", (rows: Row[]) => { rows[34]!.message.id = "other-first-answer" }],
  ["first F1 model", (rows: Row[]) => { rows[34]!.message.model = "other-model" }],
  ["first F1 slug", (rows: Row[]) => { rows[34]!.slug = "other-slug" }],
  ["first F1 error marker", (rows: Row[]) => { rows[34]!.isApiErrorMessage = true }],
  ["first F0 stop reason", (rows: Row[]) => { rows[33]!.message.stop_reason = "tool_use" }],
  ["first F1 stop reason", (rows: Row[]) => { rows[34]!.message.stop_reason = null }],
  ["current tool API reused from first tool", (rows: Row[]) => { for (const index of [43, 44, 49, 50]) rows[index]!.message.id = rows[21]!.message.id }],
  ["current tool API reused from first answer", (rows: Row[]) => { for (const index of [43, 44, 49, 50]) rows[index]!.message.id = rows[33]!.message.id }],
  ["same old/current literal file path", (rows: Row[]) => { const path = rows[22]!.message.content[0].input.file_path; for (const index of [44, 50]) rows[index]!.message.content[0].input.file_path = path; for (const index of [45, 51]) rows[index]!.toolUseResult.file.filePath = path }],
  ["inter-round last-prompt leaf", (rows: Row[]) => { rows[35]!.leafUuid = rows[23]!.uuid }],
  ["inter-round control ownership", (rows: Row[]) => { rows[37]!.cwd = directory }]
] as const)("rejects %s while re-proving the first completed round", async (_label, change) => { await failAtSecondCopies(change) })
it.each([
  ["whole unknown receipt value", (row: Row) => { row.attachment.content.unknown = { nested: [false] } }],
  ["current-round receipt", (row: Row) => { row.attachment.content = structuredClone(records[45]!.toolUseResult) }],
  ["changed filename", (row: Row) => { row.attachment.filename = records[44]!.message.content[0].input.file_path }],
  ["wrong parent", (row: Row) => { row.parentUuid = records[31]!.uuid }],
  ["old UUID", (row: Row) => { row.uuid = records[23]!.uuid }],
  ["wrong CWD", (row: Row) => { row.cwd += "/other" }],
  ["wrong Session", (row: Row) => { row.sessionId = "other-session" }],
  ["top-level async", (row: Row) => { row.isAsync = true }],
  ["top-level status", (row: Row) => { row.status = "completed" }],
  ["attachment async", (row: Row) => { row.attachment.isAsync = true }],
  ["attachment status", (row: Row) => { row.attachment.status = "completed" }],
  ["file prompt", (row: Row) => { row.promptId = records[41]!.promptId }],
  ["file message", (row: Row) => { row.message = { role: "user", content: "spoofed file turn" } }]
] as const)("rejects %s without replacing the proved S ACK", async (_label, change) => {
  const before = await ack(source, 55); change(records[55]!); await writeFile(file, serialize(records)); await reject(before.cursor)
})
it("rejects a second reinjected file after acknowledging exactly one", async () => {
  const before = await ack(source, 56), extra = structuredClone(records[55]!); extra.uuid = "extra-prior-file"; extra.parentUuid = records[55]!.uuid
  records.splice(56, 0, extra); await writeFile(file, serialize(records)); await reject(before.cursor)
})
it("keeps a selected historical 64 KiB frame valid, with full Raw and once-only usage", async () => {
  padFrame(records[33]!, 64 * 1024); const text = serialize(records); await writeFile(file, text); const captured = await drain(); expectComplete(captured.pages, text)
})
it("rejects a selected historical frame one byte beyond 64 KiB", async () => {
  await failAtSecondCopies(rows => { padFrame(rows[33]!, 64 * 1024 + 1) }, "limit")
})
it("can retain exactly 64 physical proof frames through the prior file", async () => {
  records.splice(35, 0, ...Array.from({ length: 27 }, () => queue())); const text = serialize(records); await writeFile(file, text)
  const captured = await drain(); expectComplete(captured.pages, text)
})
it("does not acknowledge a prior file whose added frame exceeds the 64-frame witness", async () => {
  records.splice(35, 0, ...Array.from({ length: 28 }, () => queue())); const text = serialize(records), before = await ack(text, 83)
  await writeFile(file, text); await reject(before.cursor, "limit")
})
it("hashes more than 4 MiB of unrelated prehistory without retaining it as selected proof", async () => {
  records.splice(14, 0, queue("x".repeat(4 * 1024 * 1024))); const text = serialize(records); await writeFile(file, text)
  const captured = await drain(); expectComplete(captured.pages, text)
})
it("rejects a greater-than-4-MiB inter-round gap before acknowledging replay", async () => {
  records.splice(35, 0, queue("x".repeat(4 * 1024 * 1024))); const text = serialize(records), before = await ack(text, 48)
  await writeFile(file, text); await reject(before.cursor, "limit")
})
it("rejects a replay group larger than a fresh requested Raw page without changing its ACK", async () => {
  const before = await ack(source, 47), bytes = Buffer.byteLength(prefix(source, 55)) - Buffer.byteLength(prefix(source, 47))
  await writeFile(file, source); await reject(before.cursor, "limit", { rawSegmentBytes: bytes - 1, rawBytesPerObservation: bytes - 1 })
  const resumed = await drain(before.cursor, { rawSegmentBytes: bytes, rawBytesPerObservation: bytes }); expectComplete([...before.pages, ...resumed.pages], source)
})
it("defers a proved replay group to a fresh page when earlier records consumed the remaining Raw budget", async () => {
  const before = await ack(source, 46), groupBytes = Buffer.byteLength(prefix(source, 55)) - Buffer.byteLength(prefix(source, 47))
  await writeFile(file, source); const input = request(before.cursor, { rawSegmentBytes: groupBytes, rawBytesPerObservation: groupBytes }), page = await read(input)
  expect(await read(input)).toEqual(page); expect(page.hasMore).toBe(true); expect(events([page])).toHaveLength(0)
  acknowledge(page); expect(progress[0]!.sourceOffset).toBe(Buffer.byteLength(prefix(source, 47)))
  const resumed = await drain(page.nextCursor, { rawSegmentBytes: groupBytes, rawBytesPerObservation: groupBytes }); expectComplete([...before.pages, page, ...resumed.pages], source)
})

it("rejects a user-shaped current witness that has no actual user role", async () => {
  await failAtSecondCopies(rows => { rows[41]!.message.role = "assistant"; rows[47]!.message.role = "assistant" }, "unsupported", 13)
})
it("does not acknowledge a replay summary that exceeds the future 64-frame witness", async () => {
  records.splice(35, 0, ...Array.from({ length: 29 }, () => queue())); const text = serialize(records), before = await ack(text, 76)
  await writeFile(file, text); await reject(before.cursor, "limit")
})
it("rejects a controlled third single-Read round instead of treating the previous existing-slug round as first", async () => {
  const before = await ack(source, 59), next = structuredClone(records.slice(41))
  const ids = new Map(next.filter(row => row.uuid).map(row => [row.uuid, `third-${row.uuid}`]))
  const rewrite = (value: any): any => {
    if (typeof value === "string") return ids.get(value) ?? (value.startsWith("msg_atape_") ? `third-${value}` : value === "call_82f63bfe_single_r2_read_a" ? "call-controlled-third-read" : value === join(directory, "r2-a.txt") ? join(directory, "r3-a.txt") : value)
    if (Array.isArray(value)) return value.map(rewrite)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]))
    return value
  }
  const round: Row[] = next.map(rewrite); round[0]!.parentUuid = records[57]!.uuid
  const all = [...records, ...round], text = serialize(all), originals = serialize(all.slice(0, 65))
  await writeFile(file, originals); const current = await drain(before.cursor)
  expect(events(current.pages)).toHaveLength(4); await writeFile(file, text); await reject(current.cursor)
})
it("rejects a controlled existing-slug dual-Read round while preserving its two successful own-call results", async () => {
  const old = records.slice(0, 41), [u, g, p, c0, r0, a] = structuredClone(records.slice(41, 47)) as [Row, Row, Row, Row, Row, Row]
  const c1 = structuredClone(c0), r1 = structuredClone(r0)
  c1.uuid = "controlled-dual-second-call"; c1.parentUuid = c0!.uuid; c1.apiBlockIndex = 2
  c1.message.content[0].id = "call-controlled-dual-second"; c1.message.content[0].input.file_path = join(directory, "r2-b.txt")
  r1.uuid = "controlled-dual-second-result"; r1.parentUuid = c1.uuid; r1.sourceToolAssistantUUID = c1.uuid
  r1.message.content[0].tool_use_id = c1.message.content[0].id; r1.toolUseResult.file.filePath = c1.message.content[0].input.file_path
  a!.parentUuid = r1.uuid; const originals = [u!, g!, p!, c0!, c1, r0!, r1, a!]
  const copies = structuredClone(originals), b = structuredClone(records[53]!), summary = structuredClone(records[54]!)
  const retained = originals.slice(2).map(row => row.uuid)
  b.compactMetadata.preservedSegment.headUuid = retained[0]; b.compactMetadata.preservedSegment.tailUuid = retained.at(-1)
  b.compactMetadata.preservedMessages.uuids = retained; b.compactMetadata.preservedMessages.allUuids = retained
  const text = serialize([...old, ...originals, ...copies, b, summary]), before = await ack(text, 49)
  expect(events(before.pages)).toHaveLength(16); await writeFile(file, text); await reject(before.cursor)
})

it.each([
  ["current receipt literal path", (rows: Row[]) => { for (const index of [45, 51]) rows[index]!.toolUseResult.file.filePath = join(directory, "unrelated.txt") }],
  ["current plan block index", (rows: Row[]) => { for (const index of [43, 49]) rows[index]!.apiBlockIndex = 2 }],
  ["current same-response call model", (rows: Row[]) => { for (const index of [44, 50]) rows[index]!.message.model = "different-model" }]
] as const)("rejects %s despite complete identical copies", async (_label, change) => { await failAtSecondCopies(change) })
it("rejects an intervening UUID turn instead of searching past it for the old successful Read", async () => {
  const extra = structuredClone(records[34]!); extra.uuid = "intervening-answer"; extra.parentUuid = records[34]!.uuid
  extra.message.id = "intervening-api"; extra.apiBlockIndex = 0
  records[41]!.parentUuid = extra.uuid; records[47]!.parentUuid = extra.uuid; records.splice(35, 0, extra)
  const text = serialize(records), before = await ack(text, 48)
  expect(events(before.pages)).toHaveLength(15); await writeFile(file, text); await reject(before.cursor)
})
it("requires fresh requested Raw capacity for the whole prior-file record before publishing its new ACK", async () => {
  const before = await ack(source, 55), bytes = Buffer.byteLength(prefix(source, 56)) - Buffer.byteLength(prefix(source, 55))
  await writeFile(file, source); await reject(before.cursor, "limit", { rawSegmentBytes: bytes - 1, rawBytesPerObservation: bytes - 1 })
  const input = request(before.cursor, { rawSegmentBytes: bytes, rawBytesPerObservation: bytes }), page = await read(input)
  expect(await read(input)).toEqual(page); expect(events([page])).toHaveLength(0); expect(page.progress?.pendingCanonicalSessions).toBe(1)
  acknowledge(page); expect(progress[0]!.sourceOffset).toBe(Buffer.byteLength(prefix(source, 56)))
  const resumed = await drain(page.nextCursor); expectComplete([...before.pages, page, ...resumed.pages], source)
})

it("rejects an altered own-call source UUID before acknowledging the current result", async () => {
  const before = await ack(source, 45)
  for (const index of [45, 51]) records[index]!.sourceToolAssistantUUID = records[22]!.uuid
  await writeFile(file, serialize(records)); await reject(before.cursor)
})
