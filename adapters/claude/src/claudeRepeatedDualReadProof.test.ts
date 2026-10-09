import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-repeated-dual-read-2.1.263/", import.meta.url)
let directory: string, file: string, source: string, records: Row[]
let context: AdapterOpenContext & { signal: AbortSignal }, progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-repeated-dual-proof-")); file = join(directory, "session.jsonl")
  source = (await readFile(new URL("r2.jsonl", fixture), "utf8")).replaceAll("/fixture/native-repeated-dual-read/workspace", directory)
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
  for (let n = 0; n < 200; n++) {
    const input = request(cursor, limits), page = await read(input)
    expect(await read(input)).toEqual(page); expect(page.sourceFailures).toBeUndefined()
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.hasMore && !page.observations.length) return { pages, cursor }
  }
  throw new Error("Repeated dual Read proof did not finish bounded pages")
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
const expectComplete = (pages: AdapterCollectionPage[], text: string) => {
  expect(events(pages)).toHaveLength(22)
  expect(new Set(events(pages).map(event => event.sourceEventId)).size).toBe(22)
  expect(totals(pages)).toEqual({ count: 7, input: 380163, output: 117 })
  const updates = events(pages).filter(event => event.update.sessionUpdate === "tool_call_update")
  expect(updates.map(event => "toolCallId" in event.update ? event.update.toolCallId : "")).toEqual([
    "call_82f63bfe_dual_r1_read_b", "call_82f63bfe_dual_r1_read_a",
    "call_atape_repeated_dual_4a0ecd53_r2_read_a", "call_atape_repeated_dual_4a0ecd53_r2_read_b"
  ])
  const raw = pages.flatMap(page => page.observations.flatMap(observation => observation.rawSegments))
  let offset = 0
  for (const segment of raw) { expect(segment.sourceOffset).toBe(offset); offset += Buffer.byteLength(segment.content) }
  expect(new Set(raw.map(segment => segment.sourceObjectId)).size).toBe(1)
  expect(new Set(raw.map(segment => segment.sourceGeneration)).size).toBe(1)
  expect(raw.map(segment => segment.content).join("")).toBe(text)
}
const copyCurrent = (index: number) => { records[index + 8] = structuredClone(records[index]!) }
const copyFirst = (index: number) => {
  const slug = records[index + 8]!.slug
  records[index + 8] = { ...structuredClone(records[index]!), slug }
}
const full = async (text: string, limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  await writeFile(file, text); const captured = await drain(null, limits); expectComplete(captured.pages, text); return captured
}
const failAtSecondCopies = async (change: (rows: Row[]) => void, reason = "unsupported") => {
  change(records)
  const text = serialize(records), before = await ack(text, 59)
  expect(events(before.pages)).toHaveLength(20)
  await writeFile(file, text); await reject(before.cursor, reason)
}
// Coherent derived histories may fail an earlier selected gate. Neither that
// failure nor a later historical proof may acknowledge the second replay.
const rejectDerivedHistory = async (change: (rows: Row[]) => void, reason = "unsupported") => {
  change(records); const text = serialize(records), upper = Buffer.byteLength(prefix(text, 59))
  await writeFile(file, text)
  let cursor: string | null = null
  for (let n = 0; n < 100; n++) {
    const input = request(cursor)
    try {
      const page = await read(input); expect(await read(input)).toEqual(page)
      expect(page.sourceFailures).toBeUndefined(); acknowledge(page); cursor = page.nextCursor
      expect(progress[0]?.sourceOffset ?? 0).toBeLessThanOrEqual(upper)
      if (!page.hasMore && !page.observations.length) throw new Error("Invalid source unexpectedly reached idle")
    } catch (error) {
      expect(error).toMatchObject({ reason }); await reject(cursor, reason); return
    }
  }
  throw new Error("Invalid source did not reject bounded collection")
}
const syncFirstTurn = () => { for (let index = 19; index < 27; index++) copyFirst(index) }
const syncCurrentTurn = () => { for (let index = 51; index < 59; index++) copyCurrent(index) }
const retained = (boundaryIndex: number, originals: Row[]) => {
  const metadata = records[boundaryIndex]!.compactMetadata
  metadata.preservedSegment.headUuid = originals[0]!.uuid
  metadata.preservedSegment.tailUuid = originals.at(-1)!.uuid
  metadata.preservedMessages.uuids = originals.map(row => row.uuid)
  metadata.preservedMessages.allUuids = originals.map(row => row.uuid)
}

it("preserves native ordered second results, forward last-prompt and both prior files through its caller Interface", async () => {
  expect(records[46]!.leafUuid).toBe(records[58]!.uuid)
  expect(records[46]!.lastPrompt).toBe(records[51]!.message.content)
  await full(source)
})
it.each([0, 1, 2, 3, 4, 5, 6, 7])("rejects changed unknown values in whole second copy slot %i", async slot => {
  await failAtSecondCopies(rows => { rows[59 + slot]!.unknown = { nested: [null, { changed: true }] } })
})
it("preserves whole unknown receipt values and authenticates each historical file to its own older call", async () => {
  const value = { nested: [null, false, { numbers: [1, 2, 3], text: "opaque native value" }] }
  for (const index of [24, 25]) {
    records[index]!.toolUseResult.unknown = structuredClone(value)
    records[index]!.toolUseResult.file.unknown = structuredClone(value)
  }
  records[69]!.attachment.content = structuredClone(records[25]!.toolUseResult)
  records[70]!.attachment.content = structuredClone(records[24]!.toolUseResult)
  syncFirstTurn()
  for (let index = 51; index < 59; index++) records[index]!.unknown = structuredClone(value)
  syncCurrentTurn(); await full(serialize(records))
})
it.each([69, 70])("rejects a different nested unknown value in prior file at index %i", async index => {
  const through = index === 69 ? 69 : 70, before = await ack(source, through)
  records[index]!.attachment.content.file.unknown = { changed: true }
  await writeFile(file, serialize(records)); await reject(before.cursor)
})
it.each([
  ["files reordered into old result order", (rows: Row[]) => {
    [rows[69]!.attachment, rows[70]!.attachment] = [rows[70]!.attachment, rows[69]!.attachment]
  }],
  ["current receipt instead of historical receipt", (rows: Row[]) => {
    rows[69]!.attachment.content = structuredClone(rows[56]!.toolUseResult)
    rows[69]!.attachment.filename = rows[54]!.message.content[0].input.file_path
  }],
  ["unrelated filename", (rows: Row[]) => { rows[69]!.attachment.filename += ".unrelated" }],
  ["wrong first-file parent", (rows: Row[]) => { rows[69]!.parentUuid = rows[67]!.uuid }],
  ["first file reuses known UUID", (rows: Row[]) => { rows[69]!.uuid = rows[25]!.uuid }],
  ["async file marker", (rows: Row[]) => { rows[69]!.attachment.isAsync = false }],
  ["file tool receipt field", (rows: Row[]) => { rows[69]!.toolUseResult = rows[25]!.toolUseResult }],
  ["file prompt identity", (rows: Row[]) => { rows[69]!.promptId = rows[51]!.promptId }]
] as const)("does not admit %s after the proved second summary", async (_label, change) => {
  const before = await ack(source, 69); change(records); await writeFile(file, serialize(records)); await reject(before.cursor)
})
it.each([
  ["duplicate first file", (rows: Row[]) => { rows[70]!.attachment = structuredClone(rows[69]!.attachment) }],
  ["second file parent skips first file", (rows: Row[]) => { rows[70]!.parentUuid = rows[68]!.uuid }],
  ["second file uses current B receipt", (rows: Row[]) => {
    rows[70]!.attachment.content = structuredClone(rows[57]!.toolUseResult)
    rows[70]!.attachment.filename = rows[55]!.message.content[0].input.file_path
  }]
] as const)("preserves independently ACKed first-file bytes on %s", async (_label, change) => {
  const before = await ack(source, 70); change(records); await writeFile(file, serialize(records)); await reject(before.cursor)
})
it("rejects a third file after the complete two-file sequence", async () => {
  const before = await ack(source, 71), extra = structuredClone(records[70]!)
  extra.uuid = "controlled-extra-file"; extra.parentUuid = records[70]!.uuid
  records.splice(71, 0, extra); await writeFile(file, serialize(records)); await reject(before.cursor)
})
it("rejects an omitted second file rather than accepting an answer parented by the first", async () => {
  const before = await ack(source, 70)
  records[71]!.parentUuid = records[69]!.uuid; records.splice(70, 1)
  await writeFile(file, serialize(records)); await reject(before.cursor)
})
it.each([
  ["changed future last-prompt text", (rows: Row[]) => { rows[46]!.lastPrompt += " unrelated" }],
  ["unrelated future last-prompt leaf", (rows: Row[]) => { rows[46]!.leafUuid = rows[53]!.uuid }],
  ["ordinary user is internal", (rows: Row[]) => { rows[42]!.userType = "internal" }],
  ["ordinary user bypasses first answer", (rows: Row[]) => { rows[42]!.parentUuid = rows[37]!.uuid }],
  ["ordinary user has tool receipt identity", (rows: Row[]) => { rows[42]!.sourceToolAssistantUUID = rows[22]!.uuid }],
  ["ordinary reminder has wrong parent", (rows: Row[]) => { rows[43]!.parentUuid = rows[38]!.uuid }],
  ["ordinary assistant is async", (rows: Row[]) => { rows[44]!.isAsync = false }],
  ["ordinary assistant is not index zero", (rows: Row[]) => { rows[44]!.apiBlockIndex = 1 }],
  ["ordinary assistant is unfinished", (rows: Row[]) => { rows[44]!.message.stop_reason = "tool_use" }],
  ["ordinary bridge changes common slug", (rows: Row[]) => { rows[43]!.slug = "another-slug" }],
  ["current user skips ordinary bridge", (rows: Row[]) => { rows[51]!.parentUuid = rows[38]!.uuid; syncCurrentTurn() }]
] as const)("rejects the derived historical bridge with %s", async (_label, change) => { await rejectDerivedHistory(change) })
it.each([
  ["first answer reuses first tool API", (rows: Row[]) => {
    rows[37]!.message.id = rows[38]!.message.id = rows[21]!.message.id
  }],
  ["bridge reuses first answer API", (rows: Row[]) => { rows[44]!.message.id = rows[37]!.message.id }],
  ["first final answer has unfinished stop reason", (rows: Row[]) => { rows[38]!.message.stop_reason = "tool_use" }],
  ["first answer pair changes model", (rows: Row[]) => { rows[38]!.message.model = "different-model" }],
  ["current plan reuses first plan API", (rows: Row[]) => {
    for (const i of [53, 54, 55]) rows[i]!.message.id = rows[21]!.message.id
    syncCurrentTurn()
  }],
  ["current paths repeat older paths", (rows: Row[]) => {
    for (const [c, r, old] of [[54, 56, 22], [55, 57, 23]] as const) {
      rows[c]!.message.content[0].input.file_path = rows[old]!.message.content[0].input.file_path
      rows[r]!.toolUseResult.file.filePath = rows[c]!.message.content[0].input.file_path
    }
    syncCurrentTurn()
  }]
] as const)("rejects %s instead of borrowing globally known identities", async (_label, change) => { await rejectDerivedHistory(change) })
it("keeps old reverse and current ordered result graphs selected independently of the current receipt paths", async () => {
  await rejectDerivedHistory(rows => {
    [rows[56], rows[57]] = [rows[57]!, rows[56]!]
    rows[58]!.parentUuid = rows[57]!.uuid
    syncCurrentTurn(); retained(67, rows.slice(53, 59))
  })
})
it.each([
  ["reused boundary UUID", (rows: Row[]) => { rows[67]!.uuid = rows[35]!.uuid }],
  ["reused summary UUID", (rows: Row[]) => { rows[68]!.uuid = rows[36]!.uuid }],
  ["wrong retained logical parent", (rows: Row[]) => { rows[67]!.logicalParentUuid = rows[57]!.uuid }],
  ["sorted retained results", (rows: Row[]) => {
    for (const key of ["uuids", "allUuids"]) [rows[67]!.compactMetadata.preservedMessages[key][3], rows[67]!.compactMetadata.preservedMessages[key][4]] =
      [rows[67]!.compactMetadata.preservedMessages[key][4], rows[67]!.compactMetadata.preservedMessages[key][3]]
  }],
  ["future anchor selects first file", (rows: Row[]) => { rows[67]!.compactMetadata.preservedSegment.anchorUuid = rows[69]!.uuid }],
  ["summary prompt belongs to first round", (rows: Row[]) => { rows[68]!.promptId = rows[19]!.promptId }],
  ["different current slug", (rows: Row[]) => { rows[51]!.slug = "another-slug"; syncCurrentTurn() }]
] as const)("rejects %s before acknowledging the second atomic group", async (_label, change) => { await failAtSecondCopies(change) })

it("preserves the prior ACK when a fresh replay cannot fit its requested Raw segment and resumes with sufficient capacity", async () => {
  const before = await ack(source, 59)
  await writeFile(file, source)
  await reject(before.cursor, "limit", { rawSegmentsPerObservation: 1, rawSegmentBytes: 4096, rawBytesPerObservation: 16 * 1024 })
  const recovered = await drain(before.cursor)
  expectComplete([...before.pages, ...recovered.pages], source)
})
it("rejects a controlled third automatic Read-pair replay instead of extrapolating the two-round source evidence", async () => {
  const before = await full(source)
  const turn = structuredClone(records.slice(51, 59)), uuid = new Map(turn.map(row => [row.uuid, row.uuid + ".third"]))
  for (const row of turn) {
    row.uuid = uuid.get(row.uuid)
    if (uuid.has(row.parentUuid)) row.parentUuid = uuid.get(row.parentUuid)
    if (uuid.has(row.sourceToolAssistantUUID)) row.sourceToolAssistantUUID = uuid.get(row.sourceToolAssistantUUID)
    if (row.promptId) row.promptId = "controlled-third-prompt"
    if (row.message?.id) row.message.id += ".third"
    const block = row.message?.content?.[0]
    if (block?.type === "tool_use") { block.id += ".third"; block.input.file_path = block.input.file_path.replace("r2-", "r3-") }
    if (block?.type === "tool_result") { block.tool_use_id += ".third"; row.toolUseResult.file.filePath = row.toolUseResult.file.filePath.replace("r2-", "r3-") }
  }
  turn[0]!.parentUuid = records[72]!.uuid
  const boundary = structuredClone(records[67]!), summary = structuredClone(records[68]!)
  boundary.uuid += ".third"; boundary.logicalParentUuid = turn[7]!.uuid
  summary.uuid += ".third"; summary.parentUuid = boundary.uuid; summary.promptId = turn[0]!.promptId
  boundary.compactMetadata.preservedSegment = { headUuid: turn[2]!.uuid, tailUuid: turn[7]!.uuid, anchorUuid: summary.uuid }
  boundary.compactMetadata.preservedMessages = { anchorUuid: summary.uuid, uuids: turn.slice(2).map(row => row.uuid), allUuids: turn.slice(2).map(row => row.uuid) }
  // This is an explicit mutation-derived unsupported source, not a native capture.
  await writeFile(file, source + serialize([...turn, ...structuredClone(turn), boundary, summary]))
  let cursor = before.cursor
  for (let n = 0; n < 30; n++) {
    const input = request(cursor)
    try {
      const page = await read(input); expect(await read(input)).toEqual(page); acknowledge(page); cursor = page.nextCursor
    } catch (error) {
      expect(error).toMatchObject({ reason: "unsupported" }); await reject(cursor)
      expect(progress[0]!.sourceOffset).toBeLessThanOrEqual(Buffer.byteLength(source + serialize(turn)))
      return
    }
  }
  throw new Error("Unsupported third replay was not rejected")
})
