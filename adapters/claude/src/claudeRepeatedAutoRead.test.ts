import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-repeated-auto-read-2.1.263/", import.meta.url)
let directory: string, file: string, sources: string[], context: AdapterOpenContext & { signal: AbortSignal }
let progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-repeated-read-")); file = join(directory, "session.jsonl")
  sources = await Promise.all(["seed", "warmup", "r1", "r2", "ordinary-resume"].map(async name =>
    (await readFile(new URL(`${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-repeated-auto-read/workspace", directory)))
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

it("captures five native snapshots with distinct group, prior-file and complete-answer ACKs", async () => {
  const all: AdapterCollectionPage[] = []
  let cursor: string | null = null, previous = ""
  for (const [index, expectedEvents, expectedUsage] of [
    [0, 2, { records: 1, input: 23, output: 11 }], [1, 4, { records: 2, input: 52, output: 24 }],
    [2, 10, { records: 4, input: 190093, output: 64 }]
  ] as const) {
    await appendFile(file, sources[index]!.slice(previous.length))
    const next = await drain(cursor, true, { eventsPerObservation: 1 }); all.push(...next.pages); cursor = next.cursor; previous = sources[index]!
    expect(events(all)).toHaveLength(expectedEvents); expect(totals(all)).toEqual(expectedUsage); expectRaw(all, previous)
  }
  const oldEvents = events(all), r2 = sources[3]!
  for (const [cut, count, pending, expectedUsage] of [
    [47, 14, 0, { records: 5, input: 380093, output: 81 }],
    [55, 14, 1, { records: 5, input: 380093, output: 81 }],
    [56, 14, 1, { records: 5, input: 380093, output: 81 }],
    [57, 15, 0, { records: 6, input: 380134, output: 104 }],
    [59, 16, 0, { records: 6, input: 380134, output: 104 }]
  ] as const) {
    const source = prefix(r2, cut); await appendFile(file, source.slice(previous.length))
    const next = await drain(cursor, true, { eventsPerObservation: 1 }); all.push(...next.pages); cursor = next.cursor; previous = source
    expect(events(all)).toHaveLength(count); expect(totals(all)).toEqual(expectedUsage)
    expect(next.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(pending); expectRaw(all, source)
  }
  await appendFile(file, sources[4]!.slice(previous.length)); const last = await drain(cursor, true, { eventsPerObservation: 1 }); all.push(...last.pages)
  expect(events(all)).toHaveLength(18); expect(new Set(events(all).map(event => event.sourceEventId)).size).toBe(18)
  expect(events(all).slice(0, oldEvents.length)).toEqual(oldEvents)
  expect(totals(all)).toEqual({ records: 7, input: 380163, output: 117 }); expectRaw(all, sources[4]!)
})

it.each(["empty", "partial", "blank", "complete"])("rejects damaged file-tail Event progress before accepting a %s answer", async variant => {
  const before = prefix(sources[3]!, 56)
  await writeFile(file, before); const captured = await drain()
  const corrupted = damage(captured.cursor!, checkpoint => { checkpoint.stream.eventSkip = 1 })
  const next = sources[3]!.slice(before.length)
  await appendFile(file, variant === "partial" ? next.slice(0, next.indexOf("\n")) : variant === "blank" ? "\n" : variant === "complete" ? next : "")
  await reject(request(corrupted), "cursor")
  await writeFile(file, sources[3]!); const restored = await drain(captured.cursor)
  expect(events(restored.pages)).toHaveLength(2)
  expect(totals([...captured.pages, ...restored.pages])).toEqual({ records: 6, input: 380134, output: 104 })
  expectRaw([...captured.pages, ...restored.pages], sources[3]!)
})

it("resumes genuine answer Event-only usage progress without replaying that Event", async () => {
  const records = rows(sources[3]!)
  records[56]!.message.id = records[57]!.message.id = "response-" + "x".repeat(491)
  await writeFile(file, lines(records.slice(0, 56))); const before = await drain()
  await appendFile(file, lines(records.slice(56)))
  const input = request(before.cursor, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 9440 })
  const eventPage = await read(input); expect(await read(input)).toEqual(eventPage)
  expect(events([eventPage])).toHaveLength(1); expect(usage([eventPage])).toHaveLength(0)
  expect(eventPage.progress?.pendingCanonicalSessions).toBe(1); acknowledge(eventPage)
  await reject(request(eventPage.nextCursor, true, { canonicalBytesPerObservation: 8941 }), "limit")
  const restored = await drain(eventPage.nextCursor, true, { eventsPerObservation: 1 })
  expect(events(restored.pages)).toHaveLength(1)
  expect(events(restored.pages)[0]!.sourceEventId).not.toBe(events([eventPage])[0]!.sourceEventId)
  expect(totals([...before.pages, eventPage, ...restored.pages])).toEqual({ records: 6, input: 380134, output: 104 })
  expectRaw([...before.pages, eventPage, ...restored.pages], lines(records))
})

it("retains the prior-file witness through genuine fragmented answer pages and usage commit", async () => {
  const records = rows(sources[3]!)
  records[56]!.message.content[0].text = "ATAPE_REPEAT_LARGE_F0 " + "cobalt ".repeat(100_000)
  await writeFile(file, lines(records.slice(0, 56))); const before = await drain()
  await appendFile(file, lines(records.slice(56)))
  const restored = await drain(before.cursor, true, { eventsPerObservation: 1 })
  const answer = events(restored.pages)
  expect(answer.length).toBeGreaterThan(2); expect(new Set(answer.map(event => event.sourceEventId)).size).toBe(answer.length)
  const body = answer.slice(0, -1).map(event => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join("")
  expect(body).toBe(records[56]!.message.content[0].text)
  expect(restored.pages.filter(page => page.progress?.pendingCanonicalSessions === 1).length).toBeGreaterThan(1)
  expect(restored.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  expect(totals([...before.pages, ...restored.pages])).toEqual({ records: 6, input: 380134, output: 104 })
  expectRaw([...before.pages, ...restored.pages], lines(records))
})

it.each(Array.from({ length: 8 }, (_, index) => 48 + index))("keeps all second-round replay bytes unacknowledged until slot %i is complete", async slot => {
  const source = sources[3]!, original = prefix(source, 47)
  await writeFile(file, original); const captured = await drain()
  const completeBefore = prefix(source, slot - 1), line = source.split(/(?<=\n)/)[slot - 1]!
  for (const next of [completeBefore, completeBefore + line.slice(0, -1)]) {
    await writeFile(file, next); const input = request(captured.cursor), page = await read(input)
    expect(await read(input)).toEqual(page); expect(page.nextCursor).toBe(captured.cursor)
    expect(page.observations).toEqual([]); expect(page.hasMore).toBe(false)
    expect(page.progress?.pendingCanonicalSessions).toBe(next === original ? 0 : 1)
  }
  await writeFile(file, prefix(source, 55)); const restored = await drain(captured.cursor)
  expect(events(restored.pages)).toEqual([]); expect(usage(restored.pages)).toEqual([])
  expect(restored.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(1)
  expectRaw([...captured.pages, ...restored.pages], prefix(source, 55))
})

it("waits for a complete prior-file line and first-answer line without acknowledging their partial bytes", async () => {
  const source = sources[3]!
  await writeFile(file, prefix(source, 55)); const summary = await drain()
  const fileLine = source.split(/(?<=\n)/)[55]!
  await appendFile(file, fileLine.slice(0, -1)); const partialFile = await read(request(summary.cursor))
  expect(partialFile.nextCursor).toBe(summary.cursor); expect(partialFile.observations).toEqual([])
  expect(partialFile.progress?.pendingCanonicalSessions).toBe(1)
  await appendFile(file, "\n"); const priorFile = await drain(summary.cursor)
  expect(events(priorFile.pages)).toEqual([]); expect(usage(priorFile.pages)).toEqual([])
  const answerLine = source.split(/(?<=\n)/)[56]!
  await appendFile(file, answerLine.slice(0, -1)); const partialAnswer = await read(request(priorFile.cursor))
  expect(partialAnswer.nextCursor).toBe(priorFile.cursor); expect(partialAnswer.observations).toEqual([])
  expect(partialAnswer.progress?.pendingCanonicalSessions).toBe(1)
  await appendFile(file, source.slice(prefix(source, 57).length - 1)); const restored = await drain(priorFile.cursor)
  expect(events(restored.pages)).toHaveLength(2)
  expectRaw([...summary.pages, ...priorFile.pages, ...restored.pages], source)
})

it("backfills one Raw object after capturing both rounds with Raw disabled", async () => {
  await writeFile(file, sources[4]!); const captured = await drain(null, false, { eventsPerObservation: 1 })
  expect(events(captured.pages)).toHaveLength(18); expect(raw(captured.pages)).toEqual([]); expect(progress).toEqual([])
  const backfill = await drain(captured.cursor, true, { rawSegmentBytes: 4096, rawBytesPerObservation: 4096 })
  expect(events(backfill.pages)).toEqual([]); expect(usage(backfill.pages)).toEqual([])
  expect(totals(captured.pages)).toEqual({ records: 7, input: 380163, output: 117 })
  expectRaw(backfill.pages, sources[4]!)
})

it("retries the proved group with independently advanced Raw receipts before committing the parser cursor", async () => {
  const source = sources[3]!, originals = prefix(source, 47), summary = prefix(source, 55)
  await writeFile(file, originals); const captured = await drain(null, false)
  const oldCursor = captured.cursor; await appendFile(file, summary.slice(originals.length))
  const groupBytes = Buffer.byteLength(summary.slice(originals.length))
  let nextCursor: string | null = null, replayed: AdapterCollectionPage[] = [], insideCopy = false
  for (let index = 0; index < 20; index++) {
    const input = request(oldCursor, true, { rawSegmentBytes: groupBytes, rawBytesPerObservation: groupBytes }), page = await read(input)
    expect(await read(input)).toEqual(page); expect(events([page])).toEqual([]); expect(usage([page])).toEqual([])
    nextCursor ??= page.nextCursor; expect(page.nextCursor).toBe(nextCursor)
    const offset = raw([page]).at(-1)!.sourceOffset + Buffer.byteLength(raw([page]).at(-1)!.content)
    insideCopy ||= offset > Buffer.byteLength(originals) && offset < Buffer.byteLength(prefix(source, 53))
    replayed.push(page); acknowledge(page)
    if (offset === Buffer.byteLength(summary)) break
  }
  expect(insideCopy).toBe(true); expectRaw(replayed, summary)
  await appendFile(file, source.slice(summary.length)); const restored = await drain(nextCursor)
  expect(events(restored.pages)).toHaveLength(2)
  expectRaw([...replayed, ...restored.pages], source)
  expect(totals([...captured.pages, ...restored.pages])).toEqual({ records: 6, input: 380134, output: 104 })
})

it("preserves a committed file checkpoint and Raw receipts across a prefix rewrite rejection and repair", async () => {
  const source = sources[3]!, admitted = prefix(source, 56)
  await writeFile(file, admitted); const captured = await drain()
  const rewritten = rows(source); rewritten[23]!.toolUseResult.file.content += " foreign"
  await writeFile(file, lines(rewritten)); await reject(request(captured.cursor), "changed")
  await writeFile(file, source); const restored = await drain(captured.cursor)
  expect(events(restored.pages)).toHaveLength(2); expectRaw([...captured.pages, ...restored.pages], source)
})

it("does not acknowledge a cancelled collection and resumes from the same public checkpoint", async () => {
  const source = sources[3]!
  await writeFile(file, prefix(source, 56)); const captured = await drain()
  await appendFile(file, source.slice(prefix(source, 56).length))
  const controller = new AbortController(); controller.abort(new Error("cancel repeated Read"))
  const saved = JSON.stringify(progress)
  await expect(read({ ...request(captured.cursor), signal: controller.signal })).rejects.toBeDefined()
  expect(JSON.stringify(progress)).toBe(saved)
  const restored = await drain(captured.cursor)
  expect(events(restored.pages)).toHaveLength(2); expectRaw([...captured.pages, ...restored.pages], source)
})

it.each([
  ["negative Event offset", (checkpoint: Row) => { checkpoint.stream.eventSkip = -1 }],
  ["fractional Event offset", (checkpoint: Row) => { checkpoint.stream.eventSkip = 0.5 }],
  ["duplicate remembered tool IDs", (checkpoint: Row) => { checkpoint.stream.calls.push(checkpoint.stream.calls[0]) }],
  ["mismatched file leaf", (checkpoint: Row) => { checkpoint.stream.lastUuid = checkpoint.stream.autoText.summaryUuid }],
  ["unknown recognized stage version", (checkpoint: Row) => { checkpoint.stream.autoText.v = 2 }]
] as const)("rejects recognized file checkpoint corruption: %s", async (_label, mutate) => {
  await writeFile(file, prefix(sources[3]!, 56)); const captured = await drain()
  await reject(request(damage(captured.cursor!, mutate)), "cursor")
  await appendFile(file, sources[3]!.slice(prefix(sources[3]!, 56).length))
  const restored = await drain(captured.cursor)
  expect(events(restored.pages)).toHaveLength(2); expectRaw([...captured.pages, ...restored.pages], sources[3]!)
})

it.each([undefined, "invalid recorded time"])("requires a recorded answer timestamp before creating resumable Event progress: %s", async recorded => {
  const source = sources[3]!
  await writeFile(file, prefix(source, 56)); const captured = await drain()
  const changed = rows(source); changed[56]!.timestamp = recorded
  await appendFile(file, lines(changed.slice(56))); await reject(request(captured.cursor))
  await writeFile(file, source); const restored = await drain(captured.cursor)
  expect(events(restored.pages)).toHaveLength(2); expectRaw([...captured.pages, ...restored.pages], source)
})
