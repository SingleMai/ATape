import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-repeated-dual-read-2.1.263/", import.meta.url)
let directory: string, file: string, sources: string[], context: AdapterOpenContext & { signal: AbortSignal }
let progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-repeated-dual-")); file = join(directory, "session.jsonl")
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
const damage = (cursor: string, change: (checkpoint: Row) => void) => {
  const value = JSON.parse(cursor.startsWith("z3:") ? inflateRawSync(Buffer.from(cursor.slice(3), "base64url")).toString() : cursor)
  change(value.sessions[0].checkpoint); return JSON.stringify(value)
}

it("captures the native dual rounds and ordinary resume with independent prior-file ACKs and exact retries", async () => {
  const all: AdapterCollectionPage[] = []
  await writeFile(file, sources[0]!); const before = await drain(null, true, { eventsPerObservation: 1 })
  all.push(...before.pages); let cursor = before.cursor, previous = sources[0]!
  expect(events(all)).toHaveLength(14); expect(totals(all)).toEqual({ records: 5, input: 190122, output: 77 }); expectRaw(all, previous)
  const oldEvents = events(all), source = sources[1]!
  for (const [cut, count, pending, expectedUsage] of [
    [59, 20, 0, { records: 6, input: 380122, output: 94 }],
    [69, 20, 1, { records: 6, input: 380122, output: 94 }],
    [70, 20, 1, { records: 6, input: 380122, output: 94 }],
    [71, 20, 1, { records: 6, input: 380122, output: 94 }],
    [72, 21, 0, { records: 7, input: 380163, output: 117 }],
    [74, 22, 0, { records: 7, input: 380163, output: 117 }]
  ] as const) {
    const nextSource = prefix(source, cut); await appendFile(file, nextSource.slice(previous.length))
    const next = await drain(cursor, true, { eventsPerObservation: 1 }); all.push(...next.pages); cursor = next.cursor; previous = nextSource
    expect(events(all)).toHaveLength(count); expect(totals(all)).toEqual(expectedUsage)
    expect(next.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(pending); expectRaw(all, nextSource)
  }
  expect(events(all).slice(0, oldEvents.length)).toEqual(oldEvents)
  expect(new Set(events(all).map(event => event.sourceEventId)).size).toBe(22)
  for (const [resultLine, callLine] of [[25, 24], [26, 23], [57, 55], [58, 56]] as const) {
    const records = rows(source), event = events(all).find(event => event.sourceEventId === records[resultLine - 1]!.uuid + ":0")!
    expect(event.update).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: records[callLine - 1]!.message.content[0].id, status: "completed" })
  }
  await appendFile(file, sources[2]!.slice(source.length)); const ordinary = await drain(cursor, true, { eventsPerObservation: 1 }); all.push(...ordinary.pages)
  expect(events(ordinary.pages)).toHaveLength(2); expect(events(all)).toHaveLength(24)
  expect(new Set(events(all).map(event => event.sourceEventId)).size).toBe(24)
  expect(totals(all)).toEqual({ records: 8, input: 380192, output: 130 }); expectRaw(all, sources[2]!)
  expect(ordinary.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
})


it.each(Array.from({ length: 10 }, (_, index) => 60 + index))("preserves the original ACK until repeated dual replay slot %i is complete", async slot => {
  const source = sources[1]!, originals = prefix(source, 59)
  await writeFile(file, originals); const before = await drain()
  const prior = prefix(source, slot - 1), line = source.split(/(?<=\n)/)[slot - 1]!
  for (const next of [prior, prior + line.slice(0, -1)]) {
    await writeFile(file, next); const input = request(before.cursor), page = await read(input)
    expect(await read(input)).toEqual(page); expect(page.observations).toEqual([])
    expect(page.nextCursor).toBe(before.cursor); expect(page.hasMore).toBe(false)
    expect(page.progress?.pendingCanonicalSessions).toBe(next === originals ? 0 : 1)
  }
  await writeFile(file, prefix(source, 69)); const summary = await drain(before.cursor)
  expect(events(summary.pages)).toEqual([]); expect(usage(summary.pages)).toEqual([])
  expect(summary.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(1)
  expectRaw([...before.pages, ...summary.pages], prefix(source, 69))
})

it("waits independently for both complete file frames and the first real answer", async () => {
  const source = sources[1]!
  await writeFile(file, prefix(source, 69)); const before = await drain()
  let cursor = before.cursor; const all = [...before.pages]
  for (const cut of [70, 71, 72]) {
    const line = source.split(/(?<=\n)/)[cut - 1]!
    await appendFile(file, line.slice(0, -1)); const input = request(cursor), partial = await read(input)
    expect(await read(input)).toEqual(partial); expect(partial.nextCursor).toBe(cursor); expect(partial.observations).toEqual([])
    expect(partial.hasMore).toBe(false); expect(partial.progress?.pendingCanonicalSessions).toBe(1)
    await appendFile(file, "\n"); const admitted = await drain(cursor, true, { eventsPerObservation: 1 })
    expect(events(admitted.pages)).toHaveLength(cut === 72 ? 1 : 0)
    expect(usage(admitted.pages)).toHaveLength(cut === 72 ? 1 : 0)
    expect(admitted.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(cut === 72 ? 0 : 1)
    cursor = admitted.cursor; all.push(...admitted.pages)
  }
  await appendFile(file, source.slice(prefix(source, 72).length)); const final = await drain(cursor); all.push(...final.pages)
  expect(events(all)).toHaveLength(22); expect(totals(all)).toEqual({ records: 7, input: 380163, output: 117 }); expectRaw(all, source)
})

it.each([69, 70, 71])("rejects fabricated answer progress at an incomplete or idle file sequence: %i", async cut => {
  const source = sources[1]!, beforeSource = prefix(source, cut)
  await writeFile(file, beforeSource); const before = await drain()
  const corrupt = damage(before.cursor!, checkpoint => { checkpoint.stream.eventSkip = 1 })
  const nextLine = source.split(/(?<=\n)/)[cut]!
  for (const next of [beforeSource, beforeSource + nextLine.slice(0, -1), beforeSource + "\n", source]) {
    await writeFile(file, next); await reject(request(corrupt), "cursor")
  }
  await writeFile(file, source); const repaired = await drain(before.cursor)
  expect(events(repaired.pages)).toHaveLength(2); expectRaw([...before.pages, ...repaired.pages], source)
})

it("requires the second proved file even when a complete answer is already available", async () => {
  const source = sources[1]!, beforeSource = prefix(source, 70)
  await writeFile(file, beforeSource); const before = await drain()
  await writeFile(file, beforeSource + source.slice(prefix(source, 71).length)); await reject(request(before.cursor))
  await writeFile(file, source); const restored = await drain(before.cursor)
  expect(events(restored.pages)).toHaveLength(2); expectRaw([...before.pages, ...restored.pages], source)
})

it("resumes real first-answer Event-only usage progress through the two-file opaque tail", async () => {
  const records = rows(sources[1]!)
  records[71]!.message.id = records[72]!.message.id = "response-" + "x".repeat(491)
  await writeFile(file, lines(records.slice(0, 71))); const before = await drain()
  await appendFile(file, lines(records.slice(71)))
  const input = request(before.cursor, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 9440 })
  const eventPage = await read(input); expect(await read(input)).toEqual(eventPage)
  expect(events([eventPage])).toHaveLength(1); expect(usage([eventPage])).toEqual([])
  expect(eventPage.progress?.pendingCanonicalSessions).toBe(1); acknowledge(eventPage)
  await reject(request(eventPage.nextCursor, true, { canonicalBytesPerObservation: 8941 }), "limit")
  const restored = await drain(eventPage.nextCursor, true, { eventsPerObservation: 1 })
  expect(events(restored.pages)).toHaveLength(1); expect(events(restored.pages)[0]!.sourceEventId).not.toBe(events([eventPage])[0]!.sourceEventId)
  expect(totals([...before.pages, eventPage, ...restored.pages])).toEqual({ records: 7, input: 380163, output: 117 })
  expectRaw([...before.pages, eventPage, ...restored.pages], lines(records))
})

it("keeps the completed two-file witness during answer fragments until full usage and bytes commit", async () => {
  const records = rows(sources[1]!)
  records[71]!.message.content[0].text = "ATAPE_DUAL_FRAGMENT " + "cobalt ".repeat(100_000)
  await writeFile(file, lines(records.slice(0, 71))); const before = await drain()
  await appendFile(file, lines(records.slice(71))); const restored = await drain(before.cursor, true, { eventsPerObservation: 1 })
  const answer = events(restored.pages)
  expect(answer.length).toBeGreaterThan(2); expect(new Set(answer.map(event => event.sourceEventId)).size).toBe(answer.length)
  expect(answer.slice(0, -1).map(event => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join(""))
    .toBe(records[71]!.message.content[0].text)
  expect(restored.pages.filter(page => page.progress?.pendingCanonicalSessions === 1).length).toBeGreaterThan(1)
  expect(restored.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  expect(totals([...before.pages, ...restored.pages])).toEqual({ records: 7, input: 380163, output: 117 })
  expectRaw([...before.pages, ...restored.pages], lines(records))
})

it("backfills all native bytes without reprojecting either dual round after Raw-off capture", async () => {
  await writeFile(file, sources[1]!); const before = await drain(null, false, { eventsPerObservation: 1 })
  expect(events(before.pages)).toHaveLength(22); expect(raw(before.pages)).toEqual([]); expect(progress).toEqual([])
  const backfill = await drain(before.cursor, true, { rawSegmentBytes: 4096, rawBytesPerObservation: 4096 })
  expect(events(backfill.pages)).toEqual([]); expect(usage(backfill.pages)).toEqual([])
  expect(totals(before.pages)).toEqual({ records: 7, input: 380163, output: 117 }); expectRaw(backfill.pages, sources[1]!)
})

it.each([70, 71])("recovers independently acknowledged Raw inside file %i with an older parser cursor", async cut => {
  const source = sources[1]!, oldSource = prefix(source, cut - 1), admitted = prefix(source, cut)
  await writeFile(file, oldSource); const before = await drain(null, false), oldCursor = before.cursor
  await appendFile(file, admitted.slice(oldSource.length))
  const fileBytes = Buffer.byteLength(admitted.slice(oldSource.length)); let limit = fileBytes
  while (Buffer.byteLength(admitted) % limit === 0 || Buffer.byteLength(admitted) % limit >= fileBytes) limit++
  const replayed: AdapterCollectionPage[] = []; let nextCursor: string | null = null, insideFile = false
  for (let index = 0; index < 150; index++) {
    const input = request(oldCursor, true, { rawSegmentBytes: limit, rawBytesPerObservation: limit }), page = await read(input)
    expect(await read(input)).toEqual(page); expect(events([page])).toEqual([]); expect(usage([page])).toEqual([])
    nextCursor ??= page.nextCursor; expect(page.nextCursor).toBe(nextCursor)
    const last = raw([page]).at(-1)!, offset = last.sourceOffset + Buffer.byteLength(last.content)
    insideFile ||= offset > Buffer.byteLength(oldSource) && offset < Buffer.byteLength(admitted)
    replayed.push(page); acknowledge(page)
    if (offset === Buffer.byteLength(admitted)) break
  }
  expect(insideFile).toBe(true); expectRaw(replayed, admitted)
  await appendFile(file, source.slice(admitted.length)); const restored = await drain(nextCursor)
  expect(events(restored.pages)).toHaveLength(2); expectRaw([...replayed, ...restored.pages], source)
  expect(totals([...before.pages, ...restored.pages])).toEqual({ records: 7, input: 380163, output: 117 })
})

it("retries the complete second replay group while only advancing its independent Raw receipts", async () => {
  const source = sources[1]!, originals = prefix(source, 59), summary = prefix(source, 69)
  await writeFile(file, originals); const before = await drain(null, false)
  await appendFile(file, summary.slice(originals.length))
  const groupBytes = Buffer.byteLength(summary.slice(originals.length)); const replayed: AdapterCollectionPage[] = []
  let nextCursor: string | null = null, insideCopies = false
  for (let index = 0; index < 20; index++) {
    const input = request(before.cursor, true, { rawSegmentBytes: groupBytes, rawBytesPerObservation: groupBytes }), page = await read(input)
    expect(await read(input)).toEqual(page); expect(events([page])).toEqual([]); expect(usage([page])).toEqual([])
    nextCursor ??= page.nextCursor; expect(page.nextCursor).toBe(nextCursor)
    const last = raw([page]).at(-1)!, offset = last.sourceOffset + Buffer.byteLength(last.content)
    insideCopies ||= offset > Buffer.byteLength(originals) && offset < Buffer.byteLength(summary)
    replayed.push(page); acknowledge(page)
    if (offset === Buffer.byteLength(summary)) break
  }
  expect(insideCopies).toBe(true); expectRaw(replayed, summary)
  await appendFile(file, source.slice(summary.length)); const restored = await drain(nextCursor)
  expect(events(restored.pages)).toHaveLength(2); expectRaw([...replayed, ...restored.pages], source)
})

it.each([70, 71])("preserves admitted file %i and Raw receipts across prefix rejection and exact repair", async cut => {
  const source = sources[1]!, admitted = prefix(source, cut)
  await writeFile(file, admitted); const before = await drain()
  const rewritten = rows(source); rewritten[25]!.toolUseResult.file.content += " foreign"
  await writeFile(file, lines(rewritten)); await reject(request(before.cursor), "changed")
  await writeFile(file, source); const restored = await drain(before.cursor)
  expect(events(restored.pages)).toHaveLength(2); expectRaw([...before.pages, ...restored.pages], source)
})

it("keeps the last proved file ACK when collection is cancelled", async () => {
  const source = sources[1]!
  await writeFile(file, prefix(source, 71)); const before = await drain()
  await appendFile(file, source.slice(prefix(source, 71).length)); const controller = new AbortController(); controller.abort(new Error("cancel dual Read"))
  const saved = JSON.stringify(progress); await expect(read({ ...request(before.cursor), signal: controller.signal })).rejects.toBeDefined()
  expect(JSON.stringify(progress)).toBe(saved)
  const restored = await drain(before.cursor); expect(events(restored.pages)).toHaveLength(2); expectRaw([...before.pages, ...restored.pages], source)
})
