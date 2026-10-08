import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const kinds = ["auto_single", "auto"] as const
type Kind = typeof kinds[number]
const fixture = new URL("../fixtures/native-auto-read-replay-2.1.263/", import.meta.url)
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let snapshots: Record<Kind, string[]>, progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-auto-read-")); file = join(directory, "session.jsonl")
  snapshots = {} as Record<Kind, string[]>
  for (const kind of kinds) snapshots[kind] = await Promise.all(["seed", "warmup", "toolturn", "continue", "secondcontinue"].map(async name =>
    (await readFile(new URL(`${kind}/${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-auto-tool-replay/workspace", directory)))
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const rows = (source: string): Row[] => source.trimEnd().split("\n").map(line => JSON.parse(line))
const lines = (records: Row[]) => records.map(row => JSON.stringify(row)).join("\n") + "\n"
const prefix = (source: string, count: number) => source.split(/(?<=\n)/).slice(0, count).join("")
const layout = (kind: Kind) => ({ count: kind === "auto_single" ? 6 : 8, a: kind === "auto_single" ? 25 : 27,
  s: kind === "auto_single" ? 33 : 37, f0: kind === "auto_single" ? 34 : 38 })
const request = (cursor: string | null = null, rawEnabled = true, limits: Partial<AdapterCollectRequest["limits"]> = {}): AdapterCollectRequest => ({
  protocolVersion: "atape.adapter.v1alpha1", cursor, rawProgress: progress, rawCaptureEnabled: rawEnabled,
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
  throw new Error("Claude automatic Read collection did not finish bounded pages")
}
const latestSamples = (pages: AdapterCollectionPage[]) => {
  const samples = new Map<string, AdapterUsage>()
  for (const sample of usage(pages)) {
    const key = `${sample.sourceThreadId}\0${sample.sourceUsageId}`, previous = samples.get(key)
    if (!previous || sample.revision > previous.revision) samples.set(key, sample)
    else if (sample.revision === previous.revision) expect(sample).toEqual(previous)
  }
  return [...samples.values()]
}
const latestUsage = (pages: AdapterCollectionPage[]) => {
  const samples = latestSamples(pages)
  return { records: samples.length, input: samples.reduce((sum, sample) => sum + sample.inputTokens!, 0),
    output: samples.reduce((sum, sample) => sum + sample.outputTokens!, 0) }
}
const expectRaw = (pages: AdapterCollectionPage[], source: string) => {
  const segments = raw(pages)
  expect(new Set(segments.map(segment => segment.sourceObjectId)).size).toBe(1)
  expect(new Set(segments.map(segment => segment.sourceGeneration)).size).toBe(1)
  let offset = 0
  for (const segment of segments) { expect(segment.sourceOffset).toBe(offset); offset += Buffer.byteLength(segment.content) }
  expect(segments.map(segment => segment.content).join("")).toBe(source)
}
const reject = async (input: AdapterCollectRequest, reason = "unsupported") => {
  const receipts = structuredClone(progress)
  await expect(read(input)).rejects.toMatchObject({ reason }); await expect(read(input)).rejects.toMatchObject({ reason })
  expect(progress).toEqual(receipts)
}
const damagedCursor = (cursor: string, change: (checkpoint: Row) => void) => {
  const value = JSON.parse(cursor.startsWith("z3:") ? inflateRawSync(Buffer.from(cursor.slice(3), "base64url")).toString() : cursor)
  change(value.sessions[0].checkpoint)
  return JSON.stringify(value)
}

it.each(kinds)("captures five native %s snapshots with separate original/group/answer ACKs and restarted one-event retries", async kind => {
  const sources = snapshots[kind], toolturn = sources[2]!, { a, s, f0 } = layout(kind)
  await writeFile(file, sources[0]!)
  const seed = await drain(null, true, { eventsPerObservation: 1 })
  expect(events(seed.pages)).toHaveLength(2); expect(latestUsage(seed.pages)).toEqual({ records: 1, input: 23, output: 11 })
  await appendFile(file, sources[1]!.slice(sources[0]!.length))
  const initial = await drain(seed.cursor, true, { eventsPerObservation: 1 }), captured = [...seed.pages, ...initial.pages], original = events(captured)
  expect(original).toHaveLength(4); expect(latestUsage(captured)).toEqual({ records: 2, input: 52, output: 24 })
  await appendFile(file, prefix(toolturn, a).slice(sources[1]!.length))
  const before = await drain(initial.cursor, true, { eventsPerObservation: 1 }); captured.push(...before.pages)
  expect(events(before.pages)).toHaveLength(kind === "auto_single" ? 4 : 6)
  expect(before.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  expect(latestUsage(captured)).toEqual({ records: 3, input: 190052, output: 41 })
  const originalSamples = latestSamples(captured)
  await appendFile(file, prefix(toolturn, s).slice(prefix(toolturn, a).length))
  const controls = await drain(before.cursor, true, { eventsPerObservation: 1 }); captured.push(...controls.pages)
  expect(events(controls.pages)).toEqual([]); expect(usage(controls.pages)).toEqual([])
  expect(latestSamples(captured)).toEqual(originalSamples)
  expect(controls.pages.at(-1)?.progress).toMatchObject({ pendingCanonicalSessions: 1, pendingRawBytes: 0, phase: "idle" })
  await appendFile(file, prefix(toolturn, f0).slice(prefix(toolturn, s).length))
  const first = await drain(controls.cursor, true, { eventsPerObservation: 1 }); captured.push(...first.pages)
  expect(events(first.pages)).toHaveLength(1); expect(first.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  await appendFile(file, toolturn.slice(prefix(toolturn, f0).length))
  const second = await drain(first.cursor, true, { eventsPerObservation: 1 }); captured.push(...second.pages)
  expect(events(second.pages)).toHaveLength(1); expect(latestUsage(captured)).toEqual({ records: 4, input: 190093, output: 64 })
  expectRaw(captured, toolturn)
  let cursor = second.cursor, previous = toolturn
  for (const [index, expected] of [[3, { records: 5, input: 190122, output: 77 }], [4, { records: 6, input: 190151, output: 90 }]] as const) {
    await appendFile(file, sources[index]!.slice(previous.length))
    const next = await drain(cursor, true, { eventsPerObservation: 1 }); captured.push(...next.pages)
    expect(events(next.pages)).toHaveLength(2); expect(latestUsage(captured)).toEqual(expected)
    cursor = next.cursor; previous = sources[index]!
  }
  expect(events(captured)).toHaveLength(kind === "auto_single" ? 14 : 16)
  expect(new Set(events(captured).map(event => event.sourceEventId)).size).toBe(events(captured).length)
  expect(events(captured).slice(0, 4)).toEqual(original)
  expectRaw(captured, sources[4]!)
})

it.each(kinds)("proves fresh same-page %s originals and preserves one Raw object through complete off/on backfill", async kind => {
  await writeFile(file, snapshots[kind][4]!)
  const off = await drain(null, false, { eventsPerObservation: 1 })
  expect(events(off.pages)).toHaveLength(kind === "auto_single" ? 14 : 16)
  expect(latestUsage(off.pages)).toEqual({ records: 6, input: 190151, output: 90 }); expect(raw(off.pages)).toEqual([])
  const backfill = await drain(off.cursor, true, { rawSegmentBytes: 4096, rawBytesPerObservation: 4096 })
  expect(events(backfill.pages)).toEqual([]); expect(usage(backfill.pages)).toEqual([])
  expectRaw(backfill.pages, snapshots[kind][4]!)
})

const partialSlots = kinds.flatMap(kind => Array.from({ length: layout(kind).count + 2 }, (_, slot) => [kind, slot] as const))
it.each(partialSlots)("waits before the first copy for %s group slot %i complete-prefix/partial EOF without Raw acknowledgement", async (kind, slot) => {
  const source = snapshots[kind][2]!, { a } = layout(kind), committed = prefix(source, a), beforeSlot = prefix(source, a + slot)
  await writeFile(file, committed); const initial = await drain(null, true, { eventsPerObservation: 1 })
  await appendFile(file, beforeSlot.slice(committed.length))
  if (slot > 0) {
    const input = request(initial.cursor), idle = await read(input)
    expect(await read(input)).toEqual(idle); expect(idle.observations).toEqual([]); expect(idle.nextCursor).toBe(initial.cursor)
    expect(idle.hasMore).toBe(false); expect(idle.progress?.pendingCanonicalSessions).toBe(1)
  }
  const remaining = source.slice(beforeSlot.length), cut = Math.floor(remaining.indexOf("\n") / 2)
  await appendFile(file, remaining.slice(0, cut))
  const input = request(initial.cursor), partial = await read(input)
  expect(await read(input)).toEqual(partial); expect(partial.observations).toEqual([]); expect(partial.nextCursor).toBe(initial.cursor)
  expect(partial.hasMore).toBe(false); expect(partial.progress?.pendingCanonicalSessions).toBe(1)
  await appendFile(file, remaining.slice(cut))
  const recovered = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(recovered.pages)).toHaveLength(2); expect(latestUsage([...initial.pages, ...recovered.pages])).toEqual({ records: 4, input: 190093, output: 64 })
  expectRaw([...initial.pages, ...recovered.pages], source)
})

const copyMutations: [string, number, (row: Row) => void][] = [
  ["user body", 0, row => row.message.content += "changed"],
  ["reminder body", 1, row => row.attachment.text += "changed"],
  ["plan API id", 2, row => row.message.id = "foreign-api"],
  ["plan model", 2, row => row.message.model = "foreign-model"],
  ["plan usage", 2, row => row.message.usage.input_tokens++],
  ["plan stop reason", 2, row => row.message.stop_reason = "end_turn"],
  ["call input", 3, row => row.message.content[0].input.file_path += ".other"],
  ["call id", 3, row => row.message.content[0].id = "foreign-tool"],
  ["call API index", 3, row => row.apiBlockIndex = 0],
  ["call parent", 3, row => row.parentUuid = "foreign-parent"],
  ["unknown new field", 3, row => row.unknownField = { nested: [1, 2] }],
  ["removed timestamp", 3, row => delete row.timestamp],
  ["ownership", 3, row => row.isSidechain = true],
  ["changed slug", 3, row => row.slug += "-changed"],
  ["missing slug", 3, row => delete row.slug]
]
it.each(kinds.flatMap(kind => copyMutations.map(([name, offset, mutate]) => [kind, name, offset, mutate] as const)))(
  "rejects %s copied %s before projecting another Event or usage revision", async (kind, _name, offset, mutate) => {
    const source = snapshots[kind][2]!, { a } = layout(kind), records = rows(source)
    const good = lines(records)
    await writeFile(file, prefix(good, a)); const initial = await drain()
    mutate(records[a + offset]!); await appendFile(file, lines(records.slice(a)))
    await reject(request(initial.cursor))
    await writeFile(file, good); const recovered = await drain(initial.cursor)
    expect(events(recovered.pages)).toHaveLength(2)
    expect(latestUsage([...initial.pages, ...recovered.pages])).toEqual({ records: 4, input: 190093, output: 64 })
    expectRaw([...initial.pages, ...recovered.pages], good)
  })

const receiptCopyMutations: [string, (row: Row) => void][] = [
  ["source call", row => row.sourceToolAssistantUUID = "foreign-call"],
  ["file output", row => row.toolUseResult.file.content += "changed"],
  ["formatted output", row => row.message.content[0].content += "changed"],
  ["prompt id", row => row.promptId = "foreign-prompt"],
  ["async flag", row => row.toolUseResult.isAsync = false],
  ["line counters", row => row.toolUseResult.file.numLines = 0],
  ["success marker", row => row.message.content[0].is_error = false]
]
it.each(kinds.flatMap(kind => receiptCopyMutations.map(([name, mutate]) => [kind, name, mutate] as const)))(
  "rejects %s copied receipt with changed %s", async (kind, _name, mutate) => {
    const { a, count } = layout(kind), records = rows(snapshots[kind][2]!), source = lines(records)
    await writeFile(file, prefix(source, a)); const initial = await drain()
    mutate(records[a + (count === 6 ? 4 : 6)]!)
    await appendFile(file, lines(records.slice(a))); await reject(request(initial.cursor))
  })

const controls: [string, "B" | "S", (row: Row, originals: Row[]) => void][] = [
  ["manual trigger", "B", row => row.compactMetadata.trigger = "manual"],
  ["full-copy list instead of retained suffix", "B", (row, originals) => row.compactMetadata.preservedMessages.uuids = originals.map(original => original.uuid)],
  ["different allUuids", "B", row => row.compactMetadata.preservedMessages.allUuids.reverse()],
  ["wrong head", "B", row => row.compactMetadata.preservedSegment.headUuid = "foreign-head"],
  ["wrong tail", "B", row => row.compactMetadata.preservedSegment.tailUuid = "foreign-tail"],
  ["wrong logical parent", "B", row => row.logicalParentUuid = "foreign-parent"],
  ["wrong anchor", "B", row => row.compactMetadata.preservedMessages.anchorUuid = "foreign-anchor"],
  ["reused boundary", "B", (row, originals) => row.uuid = originals[0]!.uuid],
  ["reused summary", "B", (row, originals) => { row.compactMetadata.preservedSegment.anchorUuid = originals[0]!.uuid; row.compactMetadata.preservedMessages.anchorUuid = originals[0]!.uuid }],
  ["boundary summary flag", "B", row => row.isCompactSummary = true],
  ["summary prompt", "S", row => row.promptId = "foreign-prompt"],
  ["summary parent", "S", row => row.parentUuid = "foreign-boundary"],
  ["summary visibility", "S", row => row.isVisibleInTranscriptOnly = false],
  ["summary compaction metadata", "S", row => row.compactMetadata = {}],
  ["summary meta marker", "S", row => row.isMeta = false],
  ["summary body", "S", row => row.message.content = ""]
]
it.each(kinds.flatMap(kind => controls.map(([name, slot, mutate]) => [kind, name, slot, mutate] as const)))(
  "rejects %s automatic witness with %s and leaves the original checkpoint usable", async (kind, _name, slot, mutate) => {
    const { a, count, s } = layout(kind), records = rows(snapshots[kind][2]!), source = lines(records)
    await writeFile(file, prefix(source, a)); const initial = await drain()
    mutate(records[slot === "B" ? s - 2 : s - 1]!, records.slice(a - count, a))
    await appendFile(file, lines(records.slice(a))); await reject(request(initial.cursor))
    await writeFile(file, source); const recovered = await drain(initial.cursor)
    expect(events(recovered.pages)).toHaveLength(2)
  })

it.each(kinds)("rejects %s copy reordering or physical bookkeeping before the group completes", async kind => {
  const { a } = layout(kind), source = snapshots[kind][2]!, records = rows(source)
  await writeFile(file, prefix(source, a)); const initial = await drain()
  const swapped = [...records]; [swapped[a + 1], swapped[a + 2]] = [swapped[a + 2]!, swapped[a + 1]!]
  await appendFile(file, lines(swapped.slice(a))); await reject(request(initial.cursor))
  await writeFile(file, prefix(source, a + 1) + lines([{ type: "queue-operation", operation: "enqueue" }]))
  await reject(request(initial.cursor))
  await writeFile(file, prefix(source, a + 1) + "\n"); await reject(request(initial.cursor))
})

it.each(kinds)("does not hide %s complete changed copies behind an incomplete later witness", async kind => {
  const { a } = layout(kind), records = rows(snapshots[kind][2]!), source = lines(records)
  await writeFile(file, prefix(source, a)); const initial = await drain()
  records[a + 2]!.message.content[0].text += "changed"
  await appendFile(file, lines(records.slice(a, a + 3))); await reject(request(initial.cursor))
})

const originalMutations: [string, number, (row: Row) => void][] = [
  ["meta user", 0, row => row.isMeta = false],
  ["internal user", 0, row => row.userType = "internal"],
  ["non-reminder attachment", 1, row => row.attachment.type = "file"],
  ["message on reminder", 1, row => row.message = { role: "user", content: "extra" }],
  ["nonzero plan index", 2, row => row.apiBlockIndex = 1],
  ["different plan API", 2, row => row.message.id = "foreign-api"],
  ["non-tool plan stop", 2, row => row.message.stop_reason = "end_turn"],
  ["non-text plan", 2, row => row.message.content = [{ type: "thinking", thinking: "plan" }]],
  ["zero call index", 3, row => row.apiBlockIndex = 0],
  ["different call model", 3, row => row.message.model = "foreign-model"],
  ["different tool", 3, row => row.message.content[0].name = "Write"],
  ["different native version", 3, row => row.version = "2.1.262"],
  ["different receipt prompt", 4, row => row.promptId = "foreign-prompt"],
  ["different receipt path", 4, row => row.toolUseResult.file.filePath += ".other"],
  ["async receipt marker", 4, row => row.toolUseResult.isAsync = false],
  ["explicit error false", 4, row => row.message.content[0].is_error = false],
  ["invalid receipt range", 4, row => row.toolUseResult.file.startLine = 3],
  ["meta final reminder", 5, row => row.isMeta = false]
]
it.each(originalMutations)("does not authorize whole equal copies of an unsupported original %s", async (_name, offset, mutate) => {
  const records = rows(snapshots.auto_single[2]!), { a } = layout("auto_single")
  mutate(records[19 + offset]!); mutate(records[a + offset]!)
  const source = lines(records)
  await writeFile(file, prefix(source, a)); const initial = await drain()
  await appendFile(file, source.slice(prefix(source, a).length)); await reject(request(initial.cursor))
})

it.each(kinds)("requires a complete physically adjacent %s original turn and its preceding user parent", async kind => {
  const records = rows(snapshots[kind][2]!), { a } = layout(kind), source = lines(records)
  const withGap = prefix(source, a - 1) + lines([{ type: "queue-operation", operation: "enqueue" }]) + source.slice(prefix(source, a - 1).length)
  await writeFile(file, prefix(withGap, a + 1)); const initial = await drain()
  await appendFile(file, withGap.slice(prefix(withGap, a + 1).length)); await reject(request(initial.cursor))
  records[19]!.parentUuid = records[2]!.uuid
  await writeFile(file, lines(records)); await reject(request())
})

it.each(kinds)("rejects %s replay carrying an already existing slug rather than silently broadening the tool profile", async kind => {
  const records = rows(snapshots[kind][2]!), { a, count } = layout(kind)
  for (const row of records.slice(a - count, a)) row.slug = records[a]!.slug
  const source = lines(records)
  await writeFile(file, prefix(source, a)); const initial = await drain()
  await appendFile(file, source.slice(prefix(source, a).length)); await reject(request(initial.cursor))
})

it.each(kinds)("retains %s group progress under requested fresh/remaining source capacity", async kind => {
  const source = snapshots[kind][2]!, { a, s } = layout(kind), committed = prefix(source, a), controls = prefix(source, s)
  await writeFile(file, committed); const initial = await drain()
  await appendFile(file, controls.slice(committed.length))
  const groupBytes = Buffer.byteLength(controls) - Buffer.byteLength(committed)
  await reject(request(initial.cursor, true, { rawSegmentBytes: groupBytes - 1, rawBytesPerObservation: groupBytes - 1 }), "limit")
  const grouped = await drain(initial.cursor, true, { rawSegmentBytes: groupBytes, rawBytesPerObservation: groupBytes })
  expect(events(grouped.pages)).toEqual([]); expect(usage(grouped.pages)).toEqual([])
  expect(grouped.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(1)
  expectRaw([...initial.pages, ...grouped.pages], controls)
  // A fits the page but leaves less than the whole otherwise admissible group.
  progress = []; await writeFile(file, prefix(source, a - 1)); const beforeA = await drain()
  await appendFile(file, controls.slice(prefix(source, a - 1).length))
  const input = request(beforeA.cursor, true, { rawSegmentBytes: groupBytes, rawBytesPerObservation: groupBytes }), deferred = await read(input)
  expect(await read(input)).toEqual(deferred); expect(deferred.hasMore).toBe(true)
  expect(events([deferred])).toEqual([]); expect(usage([deferred])).toEqual([])
  expect(raw([deferred]).map(segment => segment.content).join("")).toBe(committed.slice(prefix(source, a - 1).length))
  acknowledge(deferred)
  const recovered = await drain(deferred.nextCursor, true, { rawSegmentBytes: groupBytes, rawBytesPerObservation: groupBytes })
  expectRaw([...beforeA.pages, deferred, ...recovered.pages], controls)
})

it.each(kinds)("reproves the whole %s group when only independent Raw receipts were committed inside copies", async kind => {
  const source = snapshots[kind][2]!, { a, s, f0 } = layout(kind), committed = prefix(source, a), controls = prefix(source, s)
  await writeFile(file, committed); const initial = await drain(null, false)
  await appendFile(file, controls.slice(committed.length))
  const limit = Buffer.byteLength(controls) - Buffer.byteLength(committed), captured: AdapterCollectionPage[] = []
  let nextCursor = initial.cursor, expectedCursor: string | null | undefined, interruptedInCopy = false
  for (let attempt = 0; attempt < 10; attempt++) {
    const input = request(initial.cursor, true, { rawSegmentBytes: limit, rawBytesPerObservation: limit }), page = await read(input)
    expect(await read(input)).toEqual(page); expect(events([page])).toEqual([]); expect(usage([page])).toEqual([])
    expectedCursor ??= page.nextCursor; expect(page.nextCursor).toBe(expectedCursor)
    captured.push(page); acknowledge(page); nextCursor = page.nextCursor
    const offset = progress[0]!.sourceOffset
    interruptedInCopy ||= Array.from({ length: layout(kind).count }, (_, copy) =>
      offset > Buffer.byteLength(prefix(source, a + copy)) && offset < Buffer.byteLength(prefix(source, a + copy + 1))).some(Boolean)
    if (offset === Buffer.byteLength(controls)) break
    if (attempt === 9) throw new Error("Raw receipts did not reach the admitted automatic group")
  }
  expect(interruptedInCopy).toBe(true); expectRaw(captured, controls)
  await appendFile(file, prefix(source, f0).slice(controls.length))
  const answer = await drain(nextCursor, true, { eventsPerObservation: 1 }); captured.push(...answer.pages)
  expect(events(answer.pages)).toHaveLength(1); expect(usage(answer.pages)).toHaveLength(1)
  expect(answer.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  expectRaw(captured, prefix(source, f0))
})

it.each(kinds)("resumes a genuinely acknowledged %s plan Event with pending usage before admitting copied assistant records", async kind => {
  const records = rows(snapshots[kind][2]!), oldId = records[21]!.message.id
  for (const row of records) if (row.message?.id === oldId) row.message.id = "a".repeat(500)
  const source = lines(records)
  await writeFile(file, prefix(source, 21)); const initial = await drain()
  await appendFile(file, prefix(source, 22).slice(prefix(source, 21).length))
  const preview = await read(request(initial.cursor)), observation = preview.observations[0]!
  const eventBytes = Buffer.byteLength(JSON.stringify(observation.events[0])), sampleBytes = Buffer.byteLength(JSON.stringify(observation.usage![0]))
  expect(sampleBytes).toBeGreaterThan(eventBytes)
  const envelope = 8192 + Buffer.byteLength(JSON.stringify(observation.threads))
  const input = request(initial.cursor, true, { canonicalBytesPerObservation: envelope + sampleBytes + 1 }), deferred = await read(input)
  expect(await read(input)).toEqual(deferred); expect(events([deferred])).toHaveLength(1)
  expect(usage([deferred])).toEqual([]); expect(raw([deferred])).toEqual([]); acknowledge(deferred)
  await appendFile(file, source.slice(prefix(source, 22).length))
  await reject(request(deferred.nextCursor, true, { canonicalBytesPerObservation: envelope + sampleBytes - 1 }), "limit")
  const recovered = await drain(deferred.nextCursor, true, { eventsPerObservation: 1 })
  expect(events(recovered.pages).map(event => event.sourceEventId)).not.toContain(events([deferred])[0]!.sourceEventId)
  expect(latestUsage([...initial.pages, deferred, ...recovered.pages])).toEqual({ records: 4, input: 190093, output: 64 })
  expectRaw([...initial.pages, deferred, ...recovered.pages], source)
})

it.each(kinds)("retains pending %s F0 through text fragmentation and deferred usage, then treats F1 as ordinary", async kind => {
  const records = rows(snapshots[kind][2]!), { s, f0 } = layout(kind)
  records[f0 - 1]!.message.content[0].text += "x".repeat(600_000)
  const source = lines(records)
  await writeFile(file, prefix(source, s)); const initial = await drain()
  await appendFile(file, source.slice(prefix(source, s).length))
  const recovered = await drain(initial.cursor, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 300_000 })
  expect(events(recovered.pages)).toHaveLength(4)
  expect(recovered.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  expect(latestUsage([...initial.pages, ...recovered.pages])).toEqual({ records: 4, input: 190093, output: 64 })
  expectRaw([...initial.pages, ...recovered.pages], source)
})

it.each(kinds)("preserves %s first-answer pending state when its already emitted Event cannot yet commit usage", async kind => {
  const records = rows(snapshots[kind][2]!), { s, f0 } = layout(kind)
  records[f0 - 1]!.message.id = "a".repeat(500); records[f0]!.message.id = "a".repeat(500)
  const source = lines(records)
  await writeFile(file, prefix(source, s)); const initial = await drain()
  await appendFile(file, prefix(source, f0).slice(prefix(source, s).length))
  const input = request(initial.cursor, true, { canonicalBytesPerObservation: 9440 }), partial = await read(input)
  expect(await read(input)).toEqual(partial); expect(events([partial])).toHaveLength(1)
  expect(usage([partial])).toEqual([]); expect(raw([partial])).toEqual([]); expect(partial.progress?.pendingCanonicalSessions).toBe(1)
  acknowledge(partial)
  await reject(request(partial.nextCursor, true, { canonicalBytesPerObservation: 8941 }), "limit")
  await appendFile(file, source.slice(prefix(source, f0).length))
  const recovered = await drain(partial.nextCursor, true, { eventsPerObservation: 1 })
  expect(events(recovered.pages)).toHaveLength(1); expect(events(recovered.pages)[0]!.sourceEventId).toBe(`${records[f0]!.uuid}:0`)
  expect(latestUsage([...initial.pages, partial, ...recovered.pages])).toEqual({ records: 4, input: 190093, output: 64 })
  expectRaw([...initial.pages, partial, ...recovered.pages], source)
})

it.each(kinds)("accepts complete %s deep unknown values and object key reordering while rejecting leaf/array/value changes", async kind => {
  const records = rows(snapshots[kind][2]!), { a, s } = layout(kind), deep = JSON.parse('{"d":'.repeat(4000) + '1' + '}'.repeat(4000))
  records[22]!.unknown = deep; records[a + 3]!.unknown = JSON.parse(JSON.stringify(deep))
  records[22]!.unknownArray = [1, 2, 3]; records[a + 3]!.unknownArray = [1, 2, 3]
  records[22]!.numericMarker = 0; records[a + 3]!.numericMarker = 0
  records[a + 3] = Object.fromEntries(Object.entries(records[a + 3]!).reverse())
  const source = lines(records)
  await writeFile(file, prefix(source, a)); const initial = await drain()
  let leaf = records[a + 3]!.unknown
  for (let level = 1; level < 4000; level++) leaf = leaf.d
  leaf.d = 2
  await appendFile(file, lines(records.slice(a))); await reject(request(initial.cursor))
  leaf.d = 1; records[a + 3]!.unknownArray.reverse()
  await writeFile(file, prefix(source, a) + lines(records.slice(a))); await reject(request(initial.cursor))
  records[a + 3]!.unknownArray.reverse()
  const negativeZeroCopy = lines([records[a + 3]!]).replace('"numericMarker":0', '"numericMarker":-0')
  await writeFile(file, prefix(source, a + 3) + negativeZeroCopy + lines(records.slice(a + 4))); await reject(request(initial.cursor))
  await writeFile(file, source); const grouped = await drain(initial.cursor)
  expect(events(grouped.pages)).toHaveLength(2); expect(latestUsage([...initial.pages, ...grouped.pages])).toEqual({ records: 4, input: 190093, output: 64 })
  expectRaw([...initial.pages, ...grouped.pages], source)
  expect(Buffer.byteLength(prefix(source, s)) - Buffer.byteLength(prefix(source, a))).toBeLessThan(640 * 1024)
})

it.each(kinds)("ignores large irrelevant %s history in bounded proof while preserving ordinary fragmented Events", async kind => {
  const records = rows(snapshots[kind][2]!)
  records[2]!.message.content += "u".repeat(600_000); records[14]!.unknown = "x".repeat(700_000)
  const source = lines(records)
  await writeFile(file, source)
  const captured = await drain(null, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 300_000 })
  expect(events(captured.pages)).toHaveLength(kind === "auto_single" ? 12 : 14)
  expect(latestUsage(captured.pages)).toEqual({ records: 4, input: 190093, output: 64 })
  expectRaw(captured.pages, source)
})

it.each(["plan", "receipt"])("limits required %s originals that ordinary single-Read capture can acknowledge", async field => {
  const records = rows(snapshots.auto_single[2]!), { a } = layout("auto_single"), at = field === "plan" ? 21 : 23
  records[at]!.unknown = "x".repeat(70_000); records[a + at - 19]!.unknown = "x".repeat(70_000)
  const source = lines(records)
  await writeFile(file, prefix(source, a)); const initial = await drain()
  await appendFile(file, source.slice(prefix(source, a).length)); await reject(request(initial.cursor), "limit")
})

it("keeps an unclassified first partial copy on ordinary bounds, then applies the profile cap after LF", async () => {
  const source = snapshots.auto_single[2]!, { a } = layout("auto_single"), records = rows(source), copy = records[a]!
  copy.unknown = "x".repeat(70_000)
  const partial = lines([copy]).slice(0, -1)
  await writeFile(file, prefix(source, a)); const initial = await drain()
  await appendFile(file, partial)
  const input = request(initial.cursor), page = await read(input)
  expect(await read(input)).toEqual(page); expect(page.observations).toEqual([]); expect(page.nextCursor).toBe(initial.cursor); expect(page.hasMore).toBe(false)
  await appendFile(file, "\n"); await reject(request(initial.cursor), "limit")
})

it("rejects a known partial group slot at its exact LF-inclusive cap without waiting forever", async () => {
  const source = snapshots.auto[2]!, { a } = layout("auto")
  await writeFile(file, prefix(source, a)); const initial = await drain()
  await appendFile(file, prefix(source, a + 1).slice(prefix(source, a).length) + "x".repeat(64 * 1024))
  await reject(request(initial.cursor), "limit")
})

it("admits ten exact-cap frames and rejects the same 640 KiB prefix when final LF cannot fit", async () => {
  const records = rows(snapshots.auto[2]!), { a, count, s } = layout("auto"), cap = 64 * 1024
  for (let index = 0; index < count; index++) {
    const original = records[a - count + index]!, copy = records[a + index]!
    original.padding = ""; copy.padding = ""
    original.padding = copy.padding = "x".repeat(cap - Buffer.byteLength(lines([copy])))
    expect(Buffer.byteLength(lines([copy]))).toBe(cap)
  }
  for (const row of records.slice(s - 2, s)) {
    row.padding = ""; row.padding = "x".repeat(cap - Buffer.byteLength(lines([row])))
    expect(Buffer.byteLength(lines([row]))).toBe(cap)
  }
  const source = lines(records), committed = prefix(source, a), groupEnd = prefix(source, s)
  expect(Buffer.byteLength(groupEnd) - Buffer.byteLength(committed)).toBe(640 * 1024)
  await writeFile(file, committed); const initial = await drain()
  await appendFile(file, groupEnd.slice(committed.length, -1) + " ")
  await reject(request(initial.cursor), "limit")
  await writeFile(file, source); const recovered = await drain(initial.cursor, true, { rawSegmentBytes: 640 * 1024, rawBytesPerObservation: 640 * 1024 })
  expect(events(recovered.pages)).toHaveLength(2)
  expectRaw([...initial.pages, ...recovered.pages], source)
})

it.each(kinds)("rejects a %s first-copy skip fault without dropping original or new Event identities", async kind => {
  const source = snapshots[kind][2]!, { a } = layout(kind)
  await writeFile(file, prefix(source, a)); const initial = await drain()
  await appendFile(file, source.slice(prefix(source, a).length))
  await reject(request(damagedCursor(initial.cursor!, checkpoint => checkpoint.stream.eventSkip = 1)), "cursor")
  const recovered = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(recovered.pages)).toHaveLength(2)
  expect(new Set(events([...initial.pages, ...recovered.pages]).map(event => event.sourceEventId)).size).toBe(kind === "auto_single" ? 10 : 12)
})

it.each(kinds)("fails a recognized damaged %s answer stage instead of resetting acknowledged group state", async kind => {
  const source = snapshots[kind][2]!, { s } = layout(kind)
  await writeFile(file, prefix(source, s)); const initial = await drain()
  await appendFile(file, source.slice(prefix(source, s).length))
  for (const mutate of [
    (checkpoint: Row) => checkpoint.stream.autoText.v = 2,
    (checkpoint: Row) => checkpoint.projectionRevision = 3,
    (checkpoint: Row) => checkpoint.stream.autoText.summaryUuid = "foreign-summary",
    (checkpoint: Row) => checkpoint.stream.compaction = { v: 1, boundaryUuid: "b", summaryUuid: "s", phase: "summary" }
  ]) await reject(request(damagedCursor(initial.cursor!, mutate)), "cursor")
  const recovered = await drain(initial.cursor)
  expect(events(recovered.pages)).toHaveLength(2)
})

it.each(kinds)("preserves %s pending Read2/auto stages against a new incompatible group or answer", async kind => {
  const source = snapshots[kind][2]!, records = rows(source), { a, count, s } = layout(kind)
  if (kind === "auto") {
    await writeFile(file, prefix(source, 25)); const firstResult = await drain()
    expect(firstResult.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(1)
    await appendFile(file, lines(records.slice(a, s))); await reject(request(firstResult.cursor))
  }
  progress = []; await writeFile(file, prefix(source, s)); const pending = await drain()
  await appendFile(file, lines(records.slice(a, a + count))); await reject(request(pending.cursor))
  records[s]!.parentUuid = records[s - 2]!.uuid
  await writeFile(file, prefix(source, s) + lines(records.slice(s))); await reject(request(pending.cursor))
  await writeFile(file, source); const recovered = await drain(pending.cursor)
  expect(events(recovered.pages)).toHaveLength(2)
})

it.each(kinds)("does not lose %s acknowledged original/group bytes on prefix change", async kind => {
  const source = snapshots[kind][2]!, { a, s } = layout(kind), committed = prefix(source, a)
  await writeFile(file, committed); const initial = await drain()
  await writeFile(file, committed.slice(0, -1)); await reject(request(initial.cursor), "changed")
  await writeFile(file, source.replace(rows(source)[19]!.uuid, "rewritten-original-user")); await reject(request(initial.cursor), "changed")
  await writeFile(file, prefix(source, s)); const grouped = await drain(initial.cursor)
  await writeFile(file, source.replace(rows(source)[a]!.slug, "rewritten-slug")); await reject(request(grouped.cursor), "changed")
  await writeFile(file, source); const recovered = await drain(grouped.cursor)
  expect(events(recovered.pages)).toHaveLength(2)
})

it("retains foreground child capture while rejecting child tool replay and child pending-answer state", async () => {
  const familyFixture = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
  const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd"
  const rootText = (await readFile(new URL(`${sessionId}.jsonl`, familyFixture), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const childText = (await readFile(new URL(`${sessionId}/subagents/agent-${agentId}.jsonl`, familyFixture), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const childPath = join(directory, sessionId, "subagents", `agent-${agentId}.jsonl`)
  await mkdir(join(directory, sessionId, "subagents"), { recursive: true }); await writeFile(file, rootText); await writeFile(childPath, childText)
  const initial = await drain(), records = rows(snapshots.auto_single[2]!).slice(19, 33), leaf = rows(childText).filter(row => row.uuid).at(-1)!.uuid
  records[0]!.parentUuid = leaf; records[6]!.parentUuid = leaf
  for (const row of records) { row.sessionId = sessionId; row.agentId = agentId; row.isSidechain = true }
  await appendFile(childPath, lines(records.slice(0, 6))); const originals = await drain(initial.cursor)
  await appendFile(childPath, lines(records.slice(6)))
  const input = request(originals.cursor), blocked = await read(input)
  expect(await read(input)).toEqual(blocked); expect(blocked.observations).toEqual([]); expect(blocked.nextCursor).toBe(originals.cursor)
  expect(blocked.sourceFailures).toEqual([{ source: childPath, reason: "unsupported" }])
  const broken = damagedCursor(originals.cursor!, checkpoint => checkpoint.children[0].checkpoint.stream.autoText = {
    v: 1, boundaryUuid: "b", summaryUuid: "s", promptId: "p", slug: "slug"
  })
  await reject(request(broken), "cursor")
})

it("does not infer tool-only automatic replay from the ordinary exact-two Read layout", async () => {
  const records = rows(snapshots.auto[2]!), { a, count, s } = layout("auto"), planUuid = records[21]!.uuid
  for (const [base, predecessor] of [[19, records[20]!.uuid], [a, records[a + 1]!.uuid]] as const) {
    records[base + 3]!.parentUuid = predecessor; records[base + 3]!.apiBlockIndex = 0; records[base + 4]!.apiBlockIndex = 1
  }
  const metadata = records[s - 2]!.compactMetadata
  metadata.preservedSegment.headUuid = records[22]!.uuid
  metadata.preservedMessages.uuids = metadata.preservedMessages.uuids.filter((uuid: string) => uuid !== planUuid)
  metadata.preservedMessages.allUuids = metadata.preservedMessages.allUuids.filter((uuid: string) => uuid !== planUuid)
  const originals = records.slice(0, a).filter(row => row.uuid !== planUuid), copies = records.slice(a, a + count).filter(row => row.uuid !== planUuid)
  const committed = lines(originals), source = committed + lines([...copies, ...records.slice(a + count)])
  await writeFile(file, committed); const initial = await drain()
  expect(events(initial.pages).filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(2)
  await appendFile(file, source.slice(committed.length)); await reject(request(initial.cursor))
})

it.each(["JSON", "UTF-8"])("preserves the original checkpoint when a complete copied slot contains malformed %s", async format => {
  const source = snapshots.auto_single[2]!, { a } = layout("auto_single")
  await writeFile(file, prefix(source, a)); const initial = await drain()
  await appendFile(file, prefix(source, a + 1).slice(prefix(source, a).length))
  await appendFile(file, format === "JSON" ? "{broken}\n" : Buffer.from([123, 34, 255, 34, 58, 49, 125, 10]))
  await reject(request(initial.cursor), "format")
  await writeFile(file, source); const recovered = await drain(initial.cursor)
  expect(events(recovered.pages)).toHaveLength(2)
})
