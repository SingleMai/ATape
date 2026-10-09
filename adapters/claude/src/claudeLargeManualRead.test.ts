import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-manual-large-read-reinjection-2.1.263/", import.meta.url)
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let snapshots: string[], progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-manual-read-")); file = join(directory, "session.jsonl")
  snapshots = await Promise.all(["seed", "warmup", "toolturn", "compact", "continue", "secondcontinue"].map(async name =>
    (await readFile(new URL(`${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-manual-large-read-reinjection/workspace", directory)))
  await writeFile(file, snapshots[5]!)
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
  throw new Error("Larger Claude manual Read collection did not finish bounded pages")
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

it("captures all six native larger-Read snapshots with restarted one-event exact retries", async () => {
  const captured: AdapterCollectionPage[] = []
  let cursor: string | null = null, previous = ""
  const expected = [[2, 1, 23, 11], [4, 2, 52, 24], [12, 4, 130, 64], [12, 4, 130, 64], [14, 5, 159, 77], [16, 6, 188, 90]]
  for (const [index, source] of snapshots.entries()) {
    await writeFile(file, previous); await appendFile(file, source.slice(previous.length))
    const collected = await drain(cursor, true, { eventsPerObservation: 1 }); captured.push(...collected.pages)
    const [count, records, input, output] = expected[index]!
    expect(events(captured)).toHaveLength(count!); expect(latestUsage(captured)).toEqual({ records, input, output })
    expectRaw(captured, source); cursor = collected.cursor; previous = source
    expect(collected.pages.at(-1)?.progress).toMatchObject({ pendingRawBytes: 0, pendingCanonicalSessions: 0 })
  }
  const updates = events(captured).filter(event => event.update.sessionUpdate === "tool_call_update")
  expect(updates).toHaveLength(2)
  const calls = events(captured).filter(event => event.update.sessionUpdate === "tool_call")
  for (const event of updates) {
    expect(event.update).toMatchObject({ sessionUpdate: "tool_call_update", title: "Read", status: "completed" })
    expect(event.update).not.toHaveProperty("rawOutput")
    expect(calls.some(call => "toolCallId" in call.update && "toolCallId" in event.update && call.update.toolCallId === event.update.toolCallId)).toBe(true)
  }
  expect(new Set(events(captured).map(event => event.sourceEventId)).size).toBe(16)
  expect(JSON.stringify(events(captured))).not.toMatch(/ATAPE_MANUAL_SUMMARY|Continue from where you left off|No response requested|command-name|local-command/)
  expect(latestSamples(captured).map(sample => sample.sourceUsageId)).not.toContain("msg_atape_manual_large_1_mock_5")
})

it.each([26, 34, 35, 36, 37, 38, 39, 40, 46, 47, 48, 49, 50])
("resumes the native complete-LF cut at line %i without replaying acknowledged messages", async count => {
  const source = snapshots[5]!, eligible = count === 39 ? 38 : count === 46 ? 45 : count
  await writeFile(file, prefix(source, count)); const initial = await drain(null, true, { eventsPerObservation: 1 })
  const old = events(initial.pages), initialCount = count >= 50 ? 14 : count >= 48 ? 13 : 12
  expect(old).toHaveLength(initialCount); expectRaw(initial.pages, prefix(source, eligible))
  const input = request(initial.cursor), idle = await read(input)
  expect(await read(input)).toEqual(idle); expect(idle.observations).toEqual([]); expect(idle.nextCursor).toBe(initial.cursor)
  await appendFile(file, source.slice(prefix(source, count).length))
  const continued = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(continued.pages)).toHaveLength(16 - initialCount)
  expect(events(continued.pages).every(event => !old.some(previous => previous.sourceEventId === event.sourceEventId))).toBe(true)
  expect(latestUsage([...initial.pages, ...continued.pages])).toEqual({ records: 6, input: 188, output: 90 })
  expectRaw([...initial.pages, ...continued.pages], source)
})

it.each([39, 40, 46, 47])("does not acknowledge a partial native group slot %i", async slot => {
  const source = snapshots[5]!, start = slot < 45 ? 38 : 45, committed = prefix(source, start)
  await writeFile(file, committed); const initial = await drain()
  const before = prefix(source, slot - 1), next = source.slice(before.length).split("\n")[0]!, half = Math.floor(next.length / 2)
  await appendFile(file, before.slice(committed.length) + next.slice(0, half))
  const input = request(initial.cursor), waiting = await read(input)
  expect(await read(input)).toEqual(waiting); expect(waiting.observations).toEqual([]); expect(waiting.nextCursor).toBe(initial.cursor)
  expect(waiting.hasMore).toBe(false); expect(waiting.progress?.pendingCanonicalSessions).toBe(1)
  await appendFile(file, source.slice(before.length + half))
  const resumed = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(resumed.pages)).toHaveLength(4); expectRaw([...initial.pages, ...resumed.pages], source)
})

// Padding, unknown JSON and modified budgets below are derived capacity cases,
// rather than additional native invocations or native file-size guarantees.
const sized = (row: Row, bytes: number) => {
  row.padding = ""; row.padding = "x".repeat(bytes - Buffer.byteLength(lines([row])))
  expect(Buffer.byteLength(lines([row]))).toBe(bytes)
}
it("admits exact 2 MiB original receipts and a 2 MiB pair of exact 1 MiB file frames", async () => {
  const source = rows(snapshots[5]!)
  for (const index of [21, 22]) sized(source[index]!, 2 * 1024 * 1024)
  for (const index of [38, 39]) sized(source[index]!, 1024 * 1024)
  const text = lines(source), committed = prefix(text, 38), throughFiles = prefix(text, 40)
  await writeFile(file, committed); const initial = await drain(null, true, { eventsPerObservation: 1 })
  await appendFile(file, throughFiles.slice(committed.length))
  const files = await drain(initial.cursor, true, { rawSegmentBytes: 2 * 1024 * 1024, rawBytesPerObservation: 2 * 1024 * 1024 })
  expect(events(files.pages)).toEqual([]); expect(usage(files.pages)).toEqual([])
  expectRaw([...initial.pages, ...files.pages], throughFiles)
  await appendFile(file, text.slice(throughFiles.length)); const continued = await drain(files.cursor, true, { eventsPerObservation: 1 })
  expect(events(continued.pages)).toHaveLength(4); expectRaw([...initial.pages, ...files.pages, ...continued.pages], text)
  expect(latestUsage([...initial.pages, ...files.pages, ...continued.pages])).toEqual({ records: 6, input: 188, output: 90 })
})

it.each([21, 22, 38, 39])("rejects an above-envelope selected receipt/file frame %i while preserving its input ACK", async index => {
  const source = rows(snapshots[5]!), cap = index < 30 ? 2 * 1024 * 1024 : 1024 * 1024
  sized(source[index]!, cap + 1); const text = lines(source)
  await writeFile(file, prefix(text, 38)); const initial = await drain()
  await appendFile(file, text.slice(prefix(text, 38).length)); await reject(request(initial.cursor), "limit")
})

it.each([16, 17, 23, 24, 25, 33, 34, 35, 36, 37, 45, 46])
("keeps the 64 KiB cap on a selected non-receipt/file frame %i", async index => {
  const source = rows(snapshots[5]!); sized(source[index]!, 64 * 1024 + 1)
  const text = lines(source), count = index >= 45 ? 45 : 38
  await writeFile(file, prefix(text, count)); const initial = await drain()
  await appendFile(file, text.slice(prefix(text, count).length)); await reject(request(initial.cursor), "limit")
})

it("does not turn a larger ordinary Read result in the selected user slot into a receipt witness", async () => {
  const source = rows(snapshots[5]!), prior = source[11]!, user = source[16]!, result = source[22]!
  prior.message.content = [{ type: "tool_use", id: "prior-read", name: "Read", input: { file_path: result.toolUseResult.file.filePath } }]
  prior.message.stop_reason = "tool_use"
  user.message.content = [{ ...result.message.content[0], tool_use_id: "prior-read" }]
  user.toolUseResult = JSON.parse(JSON.stringify(result.toolUseResult)); user.sourceToolAssistantUUID = prior.uuid
  const text = lines(source); await writeFile(file, prefix(text, 38)); const initial = await drain()
  expect(events(initial.pages).some(event => event.update.sessionUpdate === "tool_call_update" && event.update.toolCallId === "prior-read")).toBe(true)
  await appendFile(file, text.slice(prefix(text, 38).length)); await reject(request(initial.cursor), "limit")
})

it.each([40, 47])("rejects a classified second slot %i whose exact cap lacks LF", async count => {
  const source = rows(snapshots[5]!), start = count === 40 ? 38 : 45, cap = count === 40 ? 1024 * 1024 : 64 * 1024
  sized(source[count - 1]!, cap + 1)
  await writeFile(file, prefix(snapshots[5]!, start)); const initial = await drain()
  await appendFile(file, lines(source.slice(start, count - 1)) + lines([source[count - 1]!]).slice(0, -1))
  await reject(request(initial.cursor), "limit")
})

it.each(["deep", "wide"])("compares the whole larger receipt's unknown %s values and repairs a changed file leaf", async kind => {
  const source = rows(snapshots[5]!), value = kind === "deep"
    ? JSON.parse('{"child":'.repeat(4000) + '{"value":1,"array":[1,2]}' + '}'.repeat(4000))
    : { value: 1, array: Array.from({ length: 40_000 }, (_, index) => index) }
  source[22]!.toolUseResult.unknown = value
  const content = JSON.parse(JSON.stringify(source[22]!.toolUseResult))
  source[38]!.attachment.content = Object.fromEntries(Object.entries(content).reverse())
  const text = lines(source); await writeFile(file, text)
  const positive = await drain(null, true, { eventsPerObservation: 1 })
  expect(events(positive.pages)).toHaveLength(16); expectRaw(positive.pages, text)
  progress = []; await writeFile(file, prefix(text, 38)); const initial = await drain()
  let leaf = source[38]!.attachment.content.unknown
  if (kind === "deep") for (let depth = 0; depth < 4000; depth++) leaf = leaf.child
  leaf.value = 2
  await appendFile(file, lines(source.slice(38))); await reject(request(initial.cursor))
  await writeFile(file, text); const restored = await drain(initial.cursor)
  expect(events(restored.pages)).toHaveLength(4); expectRaw([...initial.pages, ...restored.pages], text)
})

it.each([38, 45])("enforces fresh capacity and whole-group deferral for selected native group at %i", async count => {
  const source = snapshots[5]!, committed = prefix(source, count), throughGroup = prefix(source, count + 2)
  const group = throughGroup.slice(committed.length), size = Buffer.byteLength(group)
  await writeFile(file, committed); const initial = await drain()
  await appendFile(file, group)
  await reject(request(initial.cursor, false, { rawSegmentBytes: size - 1, rawBytesPerObservation: size - 1 }), "limit")
  const recovered = await drain(initial.cursor, true, { rawSegmentBytes: size, rawBytesPerObservation: size })
  expect(events(recovered.pages)).toEqual([]); expect(usage(recovered.pages)).toEqual([])
  expectRaw([...initial.pages, ...recovered.pages], throughGroup)
  await appendFile(file, source.slice(throughGroup.length)); const continuation = await drain(recovered.cursor)
  expect(events(continuation.pages)).toHaveLength(4); expectRaw([...initial.pages, ...recovered.pages, ...continuation.pages], source)
  progress = []; const before = count - 1
  await writeFile(file, prefix(source, before)); const old = await drain()
  await appendFile(file, throughGroup.slice(prefix(source, before).length))
  const input = request(old.cursor, true, { rawSegmentBytes: size, rawBytesPerObservation: size }), deferred = await read(input)
  expect(await read(input)).toEqual(deferred); expect(deferred.hasMore).toBe(true)
  expect(raw([deferred]).map(segment => segment.content).join("")).toBe(committed.slice(prefix(source, before).length))
  acknowledge(deferred); const rest = await drain(deferred.nextCursor, true, { rawSegmentBytes: size, rawBytesPerObservation: size })
  expect(events(rest.pages)).toEqual([]); expect(usage(rest.pages)).toEqual([])
  expectRaw([...old.pages, deferred, ...rest.pages], throughGroup)
  await appendFile(file, source.slice(throughGroup.length)); const tail = await drain(rest.cursor)
  expect(events(tail.pages)).toHaveLength(4); expectRaw([...old.pages, deferred, ...rest.pages, ...tail.pages], source)
})

// Small group budgets backfill the large source through hundreds of restarted exact retries.
it.each([38, 45])("resumes independently acknowledged Raw prefixes inside the proved group after %i with the old parser input", async count => {
  const source = snapshots[5]!, committed = prefix(source, count), throughGroup = prefix(source, count + 2)
  await writeFile(file, committed); const initial = await drain(null, false)
  await appendFile(file, throughGroup.slice(committed.length))
  const size = Buffer.byteLength(throughGroup.slice(committed.length)), accepted: AdapterCollectionPage[] = []
  const stops = [Buffer.byteLength(committed) + 32, Buffer.byteLength(prefix(source, count + 1)) + 32, Buffer.byteLength(throughGroup)]
  let next: string | null = null
  for (const stop of stops) {
    while ((progress[0]?.sourceOffset ?? 0) < stop) {
      const input = request(initial.cursor, true, { rawSegmentBytes: size, rawBytesPerObservation: size }), page = await read(input)
      expect(await read(input)).toEqual(page); expect(events([page])).toEqual([]); expect(usage([page])).toEqual([])
      if (next === null) next = page.nextCursor
      else expect(page.nextCursor).toBe(next)
      const receipt = raw([page])[0]!, bytes = Math.min(Buffer.byteLength(receipt.content), stop - receipt.sourceOffset)
      expect(bytes).toBeGreaterThan(0)
      // The Host can persist a successful prefix of its Raw upload before the
      // final parser checkpoint; only those acknowledged bytes enter this ledger.
      const portion = { ...page, observations: page.observations.map(observation => ({ ...observation,
        rawSegments: [{ ...receipt, content: Buffer.from(receipt.content).subarray(0, bytes).toString("utf8") }] })) }
      accepted.push(portion); acknowledge(portion)
    }
    expect(progress[0]!.sourceOffset).toBe(stop)
  }
  expectRaw(accepted, throughGroup)
  const idle = await read(request(next)); expect(idle.observations).toEqual([])
  await appendFile(file, source.slice(throughGroup.length)); const rest = await drain(next, true, { eventsPerObservation: 1 })
  expect(events(rest.pages)).toHaveLength(4); expectRaw([...accepted, ...rest.pages], source)
  expect(latestUsage([...initial.pages, ...rest.pages])).toEqual({ records: 6, input: 188, output: 90 })
}, 30_000)

it("backfills complete larger receipts after Raw capture was off without replaying messages or usage", async () => {
  const off = await drain(null, false, { eventsPerObservation: 1 })
  expect(events(off.pages)).toHaveLength(16); expect(raw(off.pages)).toEqual([])
  const backfill = await drain(off.cursor, true, { rawSegmentBytes: 8192, rawBytesPerObservation: 8192 })
  expect(events(backfill.pages)).toEqual([]); expect(usage(backfill.pages)).toEqual([])
  expectRaw(backfill.pages, snapshots[5]!)
})

it("rejects a changed acknowledged larger receipt prefix and resumes from its exact repair", async () => {
  const source = snapshots[5]!; await writeFile(file, prefix(source, 38)); const initial = await drain()
  const altered = rows(source); altered[22]!.toolUseResult.file.content += "edited"
  await writeFile(file, lines(altered)); await reject(request(initial.cursor), "changed")
  await writeFile(file, source); const rest = await drain(initial.cursor)
  expect(events(rest.pages)).toHaveLength(4); expectRaw([...initial.pages, ...rest.pages], source)
})

it("resumes genuine call Event-only progress before usage without reprojection", async () => {
  const source = rows(snapshots[5]!), api = "a".repeat(500)
  for (const index of [18, 19, 20]) source[index]!.message.id = api
  const text = lines(source); await writeFile(file, prefix(text, 19)); const initial = await drain()
  await appendFile(file, text.slice(prefix(text, 19).length))
  const input = request(initial.cursor, true, { canonicalBytesPerObservation: 9440 }), partial = await read(input)
  expect(await read(input)).toEqual(partial); expect(events([partial])).toHaveLength(1); expect(usage([partial])).toEqual([])
  acknowledge(partial)
  await reject(request(partial.nextCursor, true, { canonicalBytesPerObservation: 8941 }), "limit")
  const rest = await drain(partial.nextCursor, true, { eventsPerObservation: 1 })
  expect(events(rest.pages).some(event => event.sourceEventId === events([partial])[0]!.sourceEventId)).toBe(false)
  expect(new Set(events([...initial.pages, partial, ...rest.pages]).map(event => event.sourceEventId)).size).toBe(16)
  expectRaw([...initial.pages, partial, ...rest.pages], text)
  expect(latestUsage([...initial.pages, partial, ...rest.pages])).toEqual({ records: 6, input: 188, output: 90 })
})

it("commits genuine ordinary text fragments before larger receipt proof without capping unrelated history", async () => {
  const source = rows(snapshots[5]!), body = "u".repeat(600_000)
  source[2]!.message.content = body
  const text = lines(source); await writeFile(file, text)
  const result = await drain(null, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 300_000 })
  const fragments = events(result.pages).filter(event => event.sourceEventId.startsWith(source[2]!.uuid + ":"))
  expect(fragments).toHaveLength(3)
  expect(fragments.map(event => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join("")).toBe(body)
  expect(new Set(events(result.pages).map(event => event.sourceEventId)).size).toBe(18)
  expect(latestUsage(result.pages)).toEqual({ records: 6, input: 188, output: 90 }); expectRaw(result.pages, text)
})

it.each([41, 42].flatMap(index => ["SID", "message", "parent", "CWD", "version", "agent"].map(kind => [index, kind] as const)))
("rejects native post-file mode/atis metadata %i with %s before ACK", async (index, kind) => {
  const source = rows(snapshots[5]!), metadata = source[index]!
  if (kind === "SID") delete metadata.sessionId
  if (kind === "message") metadata.message = { role: "user", content: "fake" }
  if (kind === "parent") metadata.parentUuid = null
  if (kind === "CWD") metadata.cwd = directory
  if (kind === "version") metadata.version = "2.1.263"
  if (kind === "agent") metadata.agentId = "foreign"
  await writeFile(file, prefix(snapshots[5]!, index)); const initial = await drain()
  await appendFile(file, lines([metadata])); await reject(request(initial.cursor))
  await writeFile(file, snapshots[5]!); expect(events((await drain(initial.cursor)).pages)).toHaveLength(4)
})

it.each([41, 42])("does not admit file-branch metadata %i at a no-file stdout leaf", async index => {
  await writeFile(file, prefix(snapshots[5]!, 38)); const initial = await drain()
  await appendFile(file, lines([rows(snapshots[5]!)[index]!])); await reject(request(initial.cursor))
})

it("rejects damaged Event progress at a large file-pair checkpoint before EOF or metadata", async () => {
  const source = snapshots[5]!; await writeFile(file, prefix(source, 40)); const initial = await drain()
  const damaged = damagedCursor(initial.cursor!, checkpoint => checkpoint.stream.eventSkip = 1)
  await reject(request(damaged), "cursor")
  await appendFile(file, prefix(source, 43).slice(prefix(source, 40).length)); await reject(request(damaged), "cursor")
  await appendFile(file, source.slice(prefix(source, 43).length)); const rest = await drain(initial.cursor)
  expect(events(rest.pages)).toHaveLength(4); expectRaw([...initial.pages, ...rest.pages], source)
})

it.each(["auto_single", "auto"])("keeps the automatic %s receipt witness cap at 64 KiB", async kind => {
  const source = rows((await readFile(new URL(`../fixtures/native-auto-read-replay-2.1.263/${kind}/toolturn.jsonl`, import.meta.url), "utf8"))
    .replaceAll("/fixture/native-auto-tool-replay/workspace", directory))
  const seen = new Set<string>(), duplicate = source.findIndex(row => {
    if (typeof row.uuid !== "string") return false
    if (seen.has(row.uuid)) return true
    seen.add(row.uuid); return false
  })
  const receipt = source.find(row => row.toolUseResult?.type === "text")!
  for (const row of source.filter(row => row.uuid === receipt.uuid)) sized(row, 64 * 1024 + 1)
  const text = lines(source); await writeFile(file, prefix(text, duplicate)); const initial = await drain()
  await appendFile(file, text.slice(prefix(text, duplicate).length)); await reject(request(initial.cursor), "limit")
})

it("retains ordinary no-file manual admission for a preserved text frame above 64 KiB", async () => {
  const source = rows((await readFile(new URL("../fixtures/native-manual-text-tail-2.1.263/continued-again.jsonl", import.meta.url), "utf8"))
    .replaceAll("/fixture/native-manual-text-tail/workspace", directory))
  const boundary = source.find(row => row.subtype === "compact_boundary")!
  source.find(row => row.uuid === boundary.compactMetadata.preservedSegment.headUuid)!.unknown = "x".repeat(70_000)
  const text = lines(source); await writeFile(file, text); const result = await drain(null, true, { eventsPerObservation: 1 })
  expect(events(result.pages)).toHaveLength(11); expect(latestUsage(result.pages)).toEqual({ records: 5, input: 151, output: 73 })
  expectRaw(result.pages, text)
})
