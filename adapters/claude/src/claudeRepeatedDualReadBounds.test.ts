import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-repeated-dual-read-2.1.263/", import.meta.url)
let directory: string, file: string, sources: string[], context: AdapterOpenContext & { signal: AbortSignal }
let progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-dual-bounds-")); file = join(directory, "session.jsonl")
  sources = await Promise.all(["before-r2", "r2", "ordinary-resume"].map(async name =>
    (await readFile(new URL(`${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-repeated-dual-read/workspace", directory)))
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
  throw new Error("Repeated automatic Read did not finish bounded pages")
}
const reject = async (input: AdapterCollectRequest, reason = "unsupported") => {
  const saved = JSON.stringify(progress)
  await expect(read(input)).rejects.toMatchObject({ reason }); await expect(read(input)).rejects.toMatchObject({ reason })
  expect(JSON.stringify(progress)).toBe(saved)
}

const padded = (record: Row, bytes: number) => {
  const result = { ...record, proofPadding: "" }
  result.proofPadding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(result) + "\n"))
  expect(Buffer.byteLength(JSON.stringify(result) + "\n")).toBe(bytes)
  return result
}
const withGap = (count: number) => {
  const records = rows(sources[1]!)
  records.splice(51, 0, ...Array.from({ length: count }, () => ({ ...records[50]! })))
  return lines(records)
}

it("admits both files when the new dual historical witness ends exactly at 64 LF frames", async () => {
  const source = withGap(12)
  await writeFile(file, source); const captured = await drain(null, true, { eventsPerObservation: 1 })
  expect(events(captured.pages)).toHaveLength(22); expect(totals(captured.pages)).toEqual({ records: 7, input: 380163, output: 117 })
  expectRaw(captured.pages, source); expect(captured.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
})

it.each([[13, 70], [14, 69], [15, 59]] as const)("preserves the last resumable ACK with %i additional gap frames before the next selected control", async (gap, admittedLine) => {
  const source = withGap(gap), admitted = prefix(source, admittedLine + gap)
  await writeFile(file, admitted); const before = await drain()
  expect(events(before.pages)).toHaveLength(20); expect(totals(before.pages)).toEqual({ records: 6, input: 380122, output: 94 })
  const pending = admittedLine === 59 ? 0 : 1
  expect(before.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(pending)
  const idleInput = request(before.cursor), idle = await read(idleInput)
  expect(await read(idleInput)).toEqual(idle); expect(idle.observations).toEqual([]); expect(idle.nextCursor).toBe(before.cursor)
  expect(idle.progress?.pendingCanonicalSessions).toBe(pending)
  await appendFile(file, source.slice(admitted.length)); await reject(request(before.cursor), "limit")
  await writeFile(file, admitted); const restored = await read(request(before.cursor))
  expect(restored.nextCursor).toBe(before.cursor); expect(restored.observations).toEqual([])
  expect(restored.progress?.pendingCanonicalSessions).toBe(pending); expectRaw(before.pages, admitted)
})

it.each([43, 44, 45, 70, 71])("admits a complete selected dual bridge/file frame %i at exactly 64 KiB", async line => {
  const records = rows(sources[1]!); records[line - 1] = padded(records[line - 1]!, 64 * 1024)
  const source = lines(records)
  await writeFile(file, source); const captured = await drain(null, true, { eventsPerObservation: 1 })
  expect(events(captured.pages)).toHaveLength(22); expect(totals(captured.pages)).toEqual({ records: 7, input: 380163, output: 117 }); expectRaw(captured.pages, source)
})

it.each([43, 44, 45, 70, 71])("rejects a complete selected dual bridge/file frame %i at 64 KiB plus one without advancing its prior ACK", async line => {
  const records = rows(sources[1]!); records[line - 1] = padded(records[line - 1]!, 64 * 1024 + 1)
  const source = lines(records), beforeLine = line < 52 ? 59 : line - 1, admitted = prefix(source, beforeLine)
  await writeFile(file, admitted); const before = await drain()
  expect(events(before.pages)).toHaveLength(20); expect(totals(before.pages)).toEqual({ records: 6, input: 380122, output: 94 })
  await appendFile(file, source.slice(admitted.length)); await reject(request(before.cursor), "limit")
  expectRaw(before.pages, admitted)
  if (line >= 70) {
    records[line - 1]!.proofPadding = records[line - 1]!.proofPadding.slice(0, -1)
    const repaired = lines(records); expect(repaired.startsWith(admitted)).toBe(true)
    await writeFile(file, repaired); const restored = await drain(before.cursor)
    expect(events(restored.pages)).toHaveLength(2); expect(totals([...before.pages, ...restored.pages])).toEqual({ records: 7, input: 380163, output: 117 })
    expectRaw([...before.pages, ...restored.pages], repaired)
  }
})

it("retains only the selected dual history when unrelated ordinary prehistory exceeds 4 MiB", async () => {
  const records = rows(sources[1]!), original = records.findIndex(record => record.type === "user" && record.parentUuid === null)
  records[original]!.unrelatedHistory = "x".repeat(4 * 1024 * 1024 + 1)
  const source = lines(records)
  await writeFile(file, source); const captured = await drain(null, true, { eventsPerObservation: 1 })
  expect(events(captured.pages)).toHaveLength(22); expect(totals(captured.pages)).toEqual({ records: 7, input: 380163, output: 117 }); expectRaw(captured.pages, source)
})
