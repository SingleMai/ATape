import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-manual-read-reinjection-2.1.263/", import.meta.url)
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let snapshots: string[], progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-manual-read-")); file = join(directory, "session.jsonl")
  snapshots = await Promise.all(["seed", "warmup", "toolturn", "compact", "continue", "secondcontinue"].map(async name =>
    (await readFile(new URL(`${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-manual-read-reinjection/workspace", directory)))
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

it("captures six native snapshots and both Raw-only groups with restarted one-event retries", async () => {
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
  expect(new Set(events(captured).map(event => event.sourceEventId)).size).toBe(16)
  expect(JSON.stringify(events(captured))).not.toMatch(/ATAPE_MANUAL_SUMMARY|Continue from where you left off|No response requested|command-name|local-command/)
  expect(latestSamples(captured).map(sample => sample.sourceUsageId)).not.toContain("msg_atape_manual_mock_5")
})

it("admits fresh same-page originals and backfills one exact Raw object after capture is disabled", async () => {
  const fresh = await drain()
  expect(events(fresh.pages)).toHaveLength(16); expect(latestUsage(fresh.pages)).toEqual({ records: 6, input: 188, output: 90 })
  progress = []
  const off = await drain(null, false, { eventsPerObservation: 1 })
  expect(events(off.pages)).toEqual(events(fresh.pages)); expect(raw(off.pages)).toEqual([])
  const backfill = await drain(off.cursor, true, { rawSegmentBytes: 4096, rawBytesPerObservation: 4096 })
  expect(events(backfill.pages)).toEqual([]); expect(usage(backfill.pages)).toEqual([])
  expectRaw(backfill.pages, snapshots[5]!)
})

it("acknowledges compact files before a later process, but commits internal Continue only with its synthetic bridge", async () => {
  await writeFile(file, snapshots[3]!); const compact = await drain()
  expect(events(compact.pages)).toHaveLength(12); expect(latestUsage(compact.pages)).toEqual({ records: 4, input: 130, output: 64 })
  await appendFile(file, prefix(snapshots[4]!, 42).slice(snapshots[3]!.length))
  const waiting = await drain(compact.cursor)
  expect(events(waiting.pages)).toEqual([]); expect(usage(waiting.pages)).toEqual([])
  expectRaw([...compact.pages, ...waiting.pages], prefix(snapshots[4]!, 41))
  expect(waiting.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(1)
  await appendFile(file, prefix(snapshots[4]!, 43).slice(prefix(snapshots[4]!, 42).length))
  const bridge = await drain(waiting.cursor)
  expect(events(bridge.pages)).toEqual([]); expect(usage(bridge.pages)).toEqual([])
  expect(bridge.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  await appendFile(file, snapshots[5]!.slice(prefix(snapshots[4]!, 43).length))
  const rest = await drain(bridge.cursor)
  expect(events(rest.pages)).toHaveLength(4); expect(latestUsage([...compact.pages, ...waiting.pages, ...bridge.pages, ...rest.pages])).toEqual({ records: 6, input: 188, output: 90 })
})

it.each([32, 33, 34, 35, 36])("resumes an acknowledged native manual control at line %i without replaying old Events or usage", async count => {
  await writeFile(file, prefix(snapshots[5]!, count)); const initial = await drain(null, true, { eventsPerObservation: 1 })
  const old = events(initial.pages); expect(old).toHaveLength(12)
  await appendFile(file, snapshots[5]!.slice(prefix(snapshots[5]!, count).length))
  const continued = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(continued.pages)).toHaveLength(4); expect(events(continued.pages).every(event => !old.some(previous => previous.sourceEventId === event.sourceEventId))).toBe(true)
  expect(latestUsage([...initial.pages, ...continued.pages])).toEqual({ records: 6, input: 188, output: 90 })
  expectRaw([...initial.pages, ...continued.pages], snapshots[5]!)
})

it.each([37, 38, 42, 43])("waits at every partial native atomic slot %i and recovers without a lone Raw record", async slot => {
  const source = snapshots[5]!, groupStart = slot < 40 ? 36 : 41, committed = prefix(source, groupStart)
  await writeFile(file, committed); const initial = await drain()
  const before = prefix(source, slot - 1), next = source.slice(before.length).split("\n")[0]!
  await appendFile(file, before.slice(committed.length) + next.slice(0, Math.floor(next.length / 2)))
  const input = request(initial.cursor), waiting = await read(input)
  expect(await read(input)).toEqual(waiting); expect(waiting.observations).toEqual([]); expect(waiting.nextCursor).toBe(initial.cursor)
  expect(waiting.hasMore).toBe(false); expect(waiting.progress?.pendingCanonicalSessions).toBe(1)
  await appendFile(file, source.slice(before.length + Math.floor(next.length / 2)))
  const resumed = await drain(initial.cursor, true, { eventsPerObservation: 1 })
  expect(events(resumed.pages)).toHaveLength(4); expectRaw([...initial.pages, ...resumed.pages], source)
})

const fileFaults: Array<[string, (r: Row[]) => void]> = [
  ["wrong first filename", r => r[36]!.attachment.filename = r[37]!.attachment.filename],
  ["changed file content", r => r[36]!.attachment.content.file.content += " changed"],
  ["changed unknown receipt value", r => r[36]!.attachment.content.extra = { hidden: [1, 2] }],
  ["wrong second parent", r => r[37]!.parentUuid = r[35]!.uuid],
  ["reused second UUID", r => r[37]!.uuid = r[36]!.uuid],
  ["missing selected SID", r => delete r[36]!.sessionId],
  ["foreign CWD", r => r[36]!.cwd += "/foreign"],
  ["foreign ownership", r => r[37]!.agentId = "foreign"],
  ["marked file summary", r => r[36]!.isCompactSummary = false],
  ["message on attachment", r => r[36]!.message = { role: "user", content: "fake" }],
  ["foreign result link", r => r[37]!.sourceToolAssistantUUID = r[20]!.uuid],
  ["async attachment marker", r => r[36]!.attachment.isAsync = false],
  ["wrong root version", r => r[37]!.version = "2.1.264"],
  ["changed slug", r => r[37]!.slug += "-changed"],
  ["swapped file order", r => [r[36]!.attachment, r[37]!.attachment] = [r[37]!.attachment, r[36]!.attachment]],
  ["inserted physical record", r => r.splice(37, 0, { type: "queue-operation", sessionId: r[0]!.sessionId })]
]
it.each(fileFaults)("preserves the stdout ACK when rejecting %s", async (_name, change) => {
  const source = snapshots[5]!, changed = rows(source); change(changed)
  await writeFile(file, prefix(source, 36)); const initial = await drain()
  await appendFile(file, lines(changed.slice(36))); await reject(request(initial.cursor))
  await writeFile(file, source); const restored = await drain(initial.cursor)
  expect(events(restored.pages)).toHaveLength(4); expectRaw([...initial.pages, ...restored.pages], source)
})

const bridgeFaults: Array<[string, (r: Row[]) => void]> = [
  ["wrong Meta text", r => r[41]!.message.content[0].text += " changed"],
  ["missing Meta flag", r => delete r[41]!.isMeta],
  ["old Meta prompt", r => r[41]!.promptId = r[32]!.promptId],
  ["wrong Meta parent", r => r[41]!.parentUuid = r[35]!.uuid],
  ["reused Meta UUID", r => r[41]!.uuid = r[37]!.uuid],
  ["foreign Meta SID", r => r[41]!.sessionId += "-foreign"],
  ["missing Meta CWD", r => delete r[41]!.cwd],
  ["marked Meta control", r => r[41]!.compactMetadata = {}],
  ["wrong synthetic parent", r => r[42]!.parentUuid = r[37]!.uuid],
  ["synthetic usage", r => r[42]!.message.usage.input_tokens = 1],
  ["synthetic API block", r => r[42]!.apiBlockIndex = 0],
  ["synthetic error", r => r[42]!.isApiErrorMessage = true],
  ["wrong synthetic stop", r => r[42]!.message.stop_sequence = "stop"],
  ["foreign synthetic CWD", r => r[42]!.cwd += "/foreign"],
  ["bridge slug change", r => r[42]!.slug += "-new"],
  ["duplicate new Meta", r => r.splice(42, 0, { ...r[41]!, uuid: "second-meta", parentUuid: r[41]!.uuid })]
]
it.each(bridgeFaults)("preserves the file-pair ACK when rejecting %s", async (_name, change) => {
  const source = snapshots[5]!, changed = rows(source); change(changed)
  await writeFile(file, prefix(source, 41)); const initial = await drain()
  await appendFile(file, lines(changed.slice(41))); await reject(request(initial.cursor))
  await writeFile(file, source); const restored = await drain(initial.cursor)
  expect(events(restored.pages)).toHaveLength(4); expectRaw([...initial.pages, ...restored.pages], source)
})

it("rejects a synthetic bridge that skips internal Continue after files, while retaining the old stdout bridge", async () => {
  const source = rows(snapshots[5]!); await writeFile(file, prefix(snapshots[5]!, 41)); const initial = await drain()
  await appendFile(file, lines([{ ...source[42]!, parentUuid: source[37]!.uuid }]))
  await reject(request(initial.cursor))
  const old = (await readFile(new URL("../fixtures/native-manual-text-tail-2.1.263/continued-again.jsonl", import.meta.url), "utf8"))
    .replaceAll("/fixture/native-manual-text-tail/workspace", directory)
  await writeFile(file, old); progress = []; const legacy = await drain(null, true, { eventsPerObservation: 1 })
  expect(events(legacy.pages)).toHaveLength(11); expect(latestUsage(legacy.pages)).toEqual({ records: 5, input: 151, output: 73 })
})

it.each(["missing SID", "wrong leaf", "parent null", "attachment", "subtype", "CWD", "version", "error", "file-history"])
("rejects post-file %s bookkeeping before acknowledging its bytes", async kind => {
  const source = rows(snapshots[5]!), metadata = source[38]!
  if (kind === "missing SID") delete metadata.sessionId
  if (kind === "wrong leaf") metadata.leafUuid = source[35]!.uuid
  if (kind === "parent null") metadata.parentUuid = null
  if (kind === "attachment") metadata.attachment = { type: "file" }
  if (kind === "subtype") metadata.subtype = "anything"
  if (kind === "CWD") metadata.cwd = directory
  if (kind === "version") metadata.version = "2.1.263"
  if (kind === "error") metadata.isApiErrorMessage = false
  if (kind === "file-history") { metadata.type = "file-history-snapshot"; delete metadata.leafUuid }
  await writeFile(file, prefix(snapshots[5]!, 38)); const initial = await drain()
  await appendFile(file, lines([metadata])); await reject(request(initial.cursor))
  await writeFile(file, snapshots[5]!); expect(events((await drain(initial.cursor)).pages)).toHaveLength(4)
})

it.each([31, 32, 33, 34, 35])("revalidates required root identity of acknowledged compact witness %i", async index => {
  const source = rows(snapshots[5]!); source[index]!.cwd = directory + "/foreign"
  await writeFile(file, lines(source.slice(0, 36))); const initial = await drain()
  await appendFile(file, lines(source.slice(36))); await reject(request(initial.cursor))
  // Restore bytes from the acknowledged source, rather than pretending its old digest still matches.
  await writeFile(file, snapshots[5]!); progress = []
  expect(events((await drain()).pages)).toHaveLength(16)
})

it.each(["missing original SID", "changed receipt", "same literal paths", "intervening original metadata", "existing original slug"])
("rejects unsupported original tool-turn witness: %s", async kind => {
  const source = rows(snapshots[5]!)
  if (kind === "missing original SID") delete source[16]!.sessionId
  if (kind === "changed receipt") source[22]!.toolUseResult.extra = { onlyOriginal: true }
  if (kind === "same literal paths") {
    source[20]!.message.content[0].input.file_path = source[19]!.message.content[0].input.file_path
    source[22]!.toolUseResult.file.filePath = source[21]!.toolUseResult.file.filePath
    source[36]!.attachment.filename = source[22]!.toolUseResult.file.filePath
    source[36]!.attachment.content.file.filePath = source[22]!.toolUseResult.file.filePath
  }
  if (kind === "intervening original metadata") source.splice(18, 0, { type: "queue-operation", sessionId: source[0]!.sessionId })
  if (kind === "existing original slug") source[16]!.slug = source[31]!.slug
  const stdout = source.findIndex(row => row.message?.content === "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>")
  await writeFile(file, lines(source.slice(0, stdout + 1))); const initial = await drain()
  await appendFile(file, lines(source.slice(stdout + 1))); await reject(request(initial.cursor))
})

it.each([36, 41])("rejects damaged Event progress before raw-only group at line %i", async count => {
  const source = snapshots[5]!; await writeFile(file, prefix(source, count)); const initial = await drain()
  await appendFile(file, source.slice(prefix(source, count).length))
  const bad = damagedCursor(initial.cursor!, checkpoint => checkpoint.stream.eventSkip = 1)
  await reject(request(bad), "cursor")
  const restored = await drain(initial.cursor); expect(events(restored.pages)).toHaveLength(4)
  expectRaw([...initial.pages, ...restored.pages], source)
})

it("accepts entire deeply nested unknown receipt values with reordered object keys and rejects a changed leaf", async () => {
  const source = rows(snapshots[5]!)
  let value: Row = { value: 1, array: [1, 2] }
  for (let depth = 0; depth < 4000; depth++) value = { child: value }
  source[22]!.toolUseResult.unknown = value
  source[36]!.attachment.content = JSON.parse(JSON.stringify(source[22]!.toolUseResult))
  const receipt = source[36]!.attachment.content
  source[36]!.attachment.content = { unknown: receipt.unknown, file: receipt.file, type: receipt.type }
  const text = lines(source); await writeFile(file, text)
  const positive = await drain(null, true, { eventsPerObservation: 1 }); expect(events(positive.pages)).toHaveLength(16)
  expectRaw(positive.pages, text)
  progress = []; await writeFile(file, prefix(text, 36)); const initial = await drain()
  let leaf = source[36]!.attachment.content.unknown
  for (let depth = 0; depth < 4000; depth++) leaf = leaf.child
  leaf.value = 2
  await appendFile(file, lines(source.slice(36))); await reject(request(initial.cursor))
})

it("keeps an oversized irrelevant earlier record out of the selected witness without a new source cap", async () => {
  const source = rows(snapshots[5]!); source[0]!.irrelevant = "x".repeat(500_000); source[13]!.irrelevant = "y".repeat(400_000)
  await writeFile(file, lines(source)); const result = await drain()
  expect(events(result.pages)).toHaveLength(16); expect(latestUsage(result.pages)).toEqual({ records: 6, input: 188, output: 90 })
})

const sized = (row: Row, size: number) => {
  row.padding = ""; row.padding = "x".repeat(size - Buffer.byteLength(lines([row])))
  expect(Buffer.byteLength(lines([row]))).toBe(size)
}
it("admits exact 64 KiB selected frames and 128 KiB groups with fresh source capacity", async () => {
  const source = rows(snapshots[5]!)
  for (const index of [...Array.from({ length: 10 }, (_, index) => index + 16), 31, 32, 33, 34, 35, 36, 37, 41, 42]) sized(source[index]!, 64 * 1024)
  const text = lines(source); await writeFile(file, prefix(text, 36)); const initial = await drain()
  await appendFile(file, text.slice(prefix(text, 36).length))
  const result = await drain(initial.cursor, true, { rawSegmentBytes: 128 * 1024, rawBytesPerObservation: 128 * 1024 })
  expect(events(result.pages)).toHaveLength(4); expectRaw([...initial.pages, ...result.pages], text)
})

it.each(["original receipt", "summary", "first file", "second file", "Meta", "bridge"])
("rejects an over-cap selected %s without applying its limit to ordinary parsing", async kind => {
  const source = rows(snapshots[5]!), index = ({ "original receipt": 22, summary: 32, "first file": 36, "second file": 37, Meta: 41, bridge: 42 } as Record<string, number>)[kind]!
  const limit = kind === "original receipt" ? 2 * 1024 * 1024 : kind === "first file" || kind === "second file" ? 1024 * 1024 : 64 * 1024
  sized(source[index]!, limit + 1); const text = lines(source), count = index < 40 ? 36 : 41
  await writeFile(file, prefix(text, count)); const initial = await drain()
  await appendFile(file, text.slice(prefix(text, count).length)); await reject(request(initial.cursor), "limit")
})

it.each([38, 43])("reports limit for a recognized second slot %i with no room for LF", async count => {
  const source = rows(snapshots[5]!), row = source[count - 1]!, start = count === 38 ? 36 : 41
  sized(row, (count === 38 ? 1024 * 1024 : 64 * 1024) + 1)
  await writeFile(file, prefix(snapshots[5]!, start)); const initial = await drain()
  await appendFile(file, lines(source.slice(start, count - 1)) + lines([row]).slice(0, -1))
  await reject(request(initial.cursor), "limit")
})

it("retains ordinary incomplete-line rules until a large first candidate has a complete LF", async () => {
  const source = rows(snapshots[5]!); sized(source[36]!, 1024 * 1024 + 1)
  await writeFile(file, prefix(snapshots[5]!, 36)); const initial = await drain()
  await appendFile(file, lines([source[36]!]).slice(0, -1))
  const pending = await read(request(initial.cursor)); expect(pending.observations).toEqual([]); expect(pending.nextCursor).toBe(initial.cursor)
  await appendFile(file, "\n"); await reject(request(initial.cursor), "limit")
})

it.each([36, 41])("enforces fresh group source capacity and defers the full group when page capacity is already used: %i", async count => {
  const source = snapshots[5]!, committed = prefix(source, count), throughGroup = prefix(source, count + 2)
  const group = throughGroup.slice(committed.length), size = Buffer.byteLength(group)
  await writeFile(file, committed); const initial = await drain()
  await appendFile(file, group)
  await reject(request(initial.cursor, true, { rawSegmentBytes: size - 1, rawBytesPerObservation: size - 1 }), "limit")
  const recovered = await drain(initial.cursor, true, { rawSegmentBytes: size, rawBytesPerObservation: size })
  expect(events(recovered.pages)).toEqual([]); expect(usage(recovered.pages)).toEqual([])
  expectRaw([...initial.pages, ...recovered.pages], throughGroup)
  await appendFile(file, source.slice(throughGroup.length)); const continuation = await drain(recovered.cursor)
  expect(events(continuation.pages)).toHaveLength(4); expectRaw([...initial.pages, ...recovered.pages, ...continuation.pages], source)
  progress = []; const before = count === 36 ? 35 : 40
  await writeFile(file, prefix(source, before)); const old = await drain()
  await appendFile(file, throughGroup.slice(prefix(source, before).length))
  const input = request(old.cursor, true, { rawSegmentBytes: size, rawBytesPerObservation: size }), deferred = await read(input)
  expect(await read(input)).toEqual(deferred); expect(deferred.hasMore).toBe(true)
  expect(raw([deferred]).map(segment => segment.content).join("")).toBe(prefix(source, count).slice(prefix(source, before).length))
  acknowledge(deferred); const rest = await drain(deferred.nextCursor, true, { rawSegmentBytes: size, rawBytesPerObservation: size })
  expect(events(rest.pages)).toEqual([]); expect(usage(rest.pages)).toEqual([])
  expectRaw([...old.pages, deferred, ...rest.pages], throughGroup)
  await appendFile(file, source.slice(throughGroup.length)); const tail = await drain(rest.cursor)
  expect(events(tail.pages)).toHaveLength(4); expectRaw([...old.pages, deferred, ...rest.pages, ...tail.pages], source)
})

it.each([36, 41])("keeps old parser input and independent Raw receipts inside each proved group: %i", async count => {
  const source = snapshots[5]!, committed = prefix(source, count), throughGroup = prefix(source, count + 2)
  await writeFile(file, committed); const initial = await drain(null, false)
  await appendFile(file, throughGroup.slice(committed.length))
  const size = Buffer.byteLength(throughGroup.slice(committed.length)), captured: AdapterCollectionPage[] = []
  let next: string | null = null
  for (let n = 0; n < 50; n++) {
    const input = request(initial.cursor, true, { rawSegmentBytes: size, rawBytesPerObservation: size }), page = await read(input)
    expect(await read(input)).toEqual(page); expect(events([page])).toEqual([]); expect(usage([page])).toEqual([])
    if (next === null) next = page.nextCursor
    else expect(page.nextCursor).toBe(next)
    captured.push(page); acknowledge(page)
    if (progress[0]!.sourceOffset === Buffer.byteLength(throughGroup)) break
    expect(n).toBeLessThan(49)
  }
  expectRaw(captured, throughGroup)
  const idle = await read(request(next)); expect(idle.observations).toEqual([])
  await appendFile(file, source.slice(throughGroup.length))
  const continued = await drain(next, true, { eventsPerObservation: 1 })
  expect(events(continued.pages)).toHaveLength(4); expectRaw([...captured, ...continued.pages], source)
  expect(latestUsage([...initial.pages, ...continued.pages])).toEqual({ records: 6, input: 188, output: 90 })
})

it("resumes a genuine Event-only call checkpoint after deferred usage without replaying that Event", async () => {
  const source = rows(snapshots[5]!), api = "a".repeat(500)
  for (const index of [18, 19, 20]) source[index]!.message.id = api
  const text = lines(source); await writeFile(file, prefix(text, 19)); const initial = await drain()
  await appendFile(file, text.slice(prefix(text, 19).length))
  const input = request(initial.cursor, true, { canonicalBytesPerObservation: 9440 }), partial = await read(input)
  expect(await read(input)).toEqual(partial)
  expect(events([partial])).toHaveLength(1); expect(events([partial])[0]!.sourceEventId).toBe(`${source[19]!.uuid}:0`)
  expect(usage([partial])).toEqual([]); acknowledge(partial)
  await reject(request(partial.nextCursor, true, { canonicalBytesPerObservation: 8941 }), "limit")
  const resumed = await drain(partial.nextCursor, true, { eventsPerObservation: 1 })
  expect(events(resumed.pages).some(event => event.sourceEventId === events([partial])[0]!.sourceEventId)).toBe(false)
  expect(new Set(events([...initial.pages, partial, ...resumed.pages]).map(event => event.sourceEventId)).size).toBe(16)
  expect(latestUsage([...initial.pages, partial, ...resumed.pages])).toEqual({ records: 6, input: 188, output: 90 })
  expectRaw([...initial.pages, partial, ...resumed.pages], text)
})

it("fully commits genuine final-text fragment progress before applying the narrower reinjection witness cap", async () => {
  const source = rows(snapshots[5]!), body = "z".repeat(300_000)
  source[24]!.message.content[0].text = body
  const text = lines(source); await writeFile(file, prefix(text, 24)); const initial = await drain()
  await appendFile(file, prefix(text, 25).slice(prefix(text, 24).length))
  const input = request(initial.cursor, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 300_000 }), partial = await read(input)
  expect(await read(input)).toEqual(partial); expect(events([partial])).toHaveLength(1); expect(usage([partial])).toEqual([])
  expect(events([partial])[0]!.sourceEventId).toBe(`${source[24]!.uuid}:0:0`); acknowledge(partial)
  const tail = await drain(partial.nextCursor, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 300_000 })
  const fragments = events([partial, ...tail.pages])
  expect(fragments).toHaveLength(2); expect(new Set(fragments.map(event => event.sourceEventId)).size).toBe(2)
  expect(fragments.map(event => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join("")).toBe(body)
  await appendFile(file, prefix(text, 36).slice(prefix(text, 25).length)); const controls = await drain(tail.cursor, true, { eventsPerObservation: 1 })
  expect(latestUsage([...initial.pages, partial, ...tail.pages, ...controls.pages])).toEqual({ records: 4, input: 130, output: 64 })
  await appendFile(file, text.slice(prefix(text, 36).length)); await reject(request(controls.cursor), "limit")
})

it("rejects a changed acknowledged prefix before the next atomic group and preserves valid recovery", async () => {
  const source = snapshots[5]!; await writeFile(file, prefix(source, 41)); const initial = await drain()
  const altered = rows(source); altered[36]!.attachment.content.file.content += "edited"
  await writeFile(file, lines(altered)); await reject(request(initial.cursor), "changed")
  await writeFile(file, source); const rest = await drain(initial.cursor)
  expect(events(rest.pages)).toHaveLength(4); expectRaw([...initial.pages, ...rest.pages], source)
})

it.each([32, 36, 38].flatMap(count => ["EOF", "partial", "complete", "blank"].map(kind => [count, kind] as const)))
("rejects damaged manual Event progress at acknowledged line %i with %s next source", async (count, kind) => {
  const source = snapshots[5]!, committed = prefix(source, count)
  await writeFile(file, committed); const initial = await drain()
  const damaged = damagedCursor(initial.cursor!, checkpoint => checkpoint.stream.eventSkip = 1)
  const incomplete = source.slice(committed.length).split("\n")[0]!
  if (kind === "partial") await appendFile(file, incomplete.slice(0, Math.floor(incomplete.length / 2)))
  if (kind === "blank") await appendFile(file, "\n")
  if (kind === "complete") await writeFile(file, count === 38 ? prefix(source, 41) : prefix(source, count + 1))
  await reject(request(damaged), "cursor")
  await writeFile(file, source); const restored = await drain(initial.cursor)
  expect(events(restored.pages)).toHaveLength(4)
  expectRaw([...initial.pages, ...restored.pages], source)
})
