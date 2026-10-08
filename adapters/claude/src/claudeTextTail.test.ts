import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-manual-text-tail-2.1.263/", import.meta.url)
const headUuid = "efa512f0-1a00-47b4-8311-8a804635a4df", tailUuid = "f7e8db2a-f843-4a96-a9d0-07fbadb3df1a"
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let before: string, compacted: string, continued: string, again: string, progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-text-tail-")); file = join(directory, "session.jsonl")
  const sources = await Promise.all(["before", "compacted", "continued", "continued-again"].map(async name =>
    (await readFile(new URL(`${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-manual-text-tail/workspace", directory)))
  before = sources[0]!; compacted = sources[1]!; continued = sources[2]!; again = sources[3]!
  await writeFile(file, again)
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const rows = (source: string): Row[] => source.trimEnd().split("\n").map(line => JSON.parse(line))
const lines = (records: Row[]) => records.map(row => JSON.stringify(row)).join("\n") + "\n"
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
const drain = async (cursor: string | null = null, raw = true, limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  const pages: AdapterCollectionPage[] = []
  for (let n = 0; n < 150; n++) {
    const input = request(cursor, raw, limits), page = await read(input)
    expect(await read(input)).toEqual(page)
    expect(page.sourceFailures).toBeUndefined()
    for (const observation of page.observations) expect(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] })))
      .toBeLessThanOrEqual(input.limits.canonicalBytesPerObservation)
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.hasMore && !page.observations.length) return { pages, cursor }
  }
  throw new Error("Claude text-tail collection did not finish bounded pages")
}
const events = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.events))
const raw = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.rawSegments))
const latestUsage = (pages: AdapterCollectionPage[]) => {
  const samples = new Map<string, AdapterUsage>()
  for (const sample of pages.flatMap(page => page.observations.flatMap(observation => observation.usage ?? []))) {
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

it("appends all four native snapshots to an acknowledged projection-4 prefix without replaying old data", async () => {
  await writeFile(file, before)
  const initial = await drain(), captured = [...initial.pages], original = events(initial.pages)
  expect(original).toHaveLength(7)
  expect(latestUsage(captured)).toEqual({ records: 3, input: 93, output: 47 })
  await appendFile(file, compacted.slice(before.length))
  const compact = await drain(initial.cursor, true, { rawSegmentBytes: 4096, rawBytesPerObservation: 4096 })
  expect(events(compact.pages)).toEqual([])
  expect(compact.pages.flatMap(page => page.observations.flatMap(observation => observation.usage ?? []))).toEqual([])
  captured.push(...compact.pages)
  expect(latestUsage(captured)).toEqual({ records: 3, input: 93, output: 47 })
  await appendFile(file, continued.slice(compacted.length))
  const resume = await drain(compact.cursor); captured.push(...resume.pages)
  expect(events(resume.pages)).toHaveLength(2)
  expect(latestUsage(captured)).toEqual({ records: 4, input: 122, output: 60 })
  await appendFile(file, again.slice(continued.length))
  const second = await drain(resume.cursor); captured.push(...second.pages)
  expect(events(second.pages)).toHaveLength(2)
  expect(events(captured)).toHaveLength(11)
  expect(new Set(events(captured).map(event => event.sourceEventId)).size).toBe(11)
  expect(latestUsage(captured)).toEqual({ records: 5, input: 151, output: 73 })
  expectRaw(captured, again)
  const fresh = await drain()
  expect(events(fresh.pages).slice(0, original.length)).toEqual(original)
  expect(JSON.stringify(events(captured))).not.toMatch(/ATAPE_MANUAL_TEXT_SUMMARY|No response requested|command-name|local-command/)
  expect((await read(request(second.cursor))).observations).toEqual([])
})

it("admits the pair committed on the current page and keeps one usage identity across one-event retries and new runtimes", async () => {
  const fresh = await drain()
  expect(events(fresh.pages)).toHaveLength(11)
  expect(latestUsage(fresh.pages)).toEqual({ records: 5, input: 151, output: 73 })
  progress = []
  const paged = await drain(null, true, { eventsPerObservation: 1 })
  expect(events(paged.pages)).toEqual(events(fresh.pages))
  expect(paged.pages.every(page => page.observations.every(observation => observation.events.length <= 1))).toBe(true)
  expect(paged.pages.flatMap(page => page.observations.flatMap(observation => observation.usage ?? []))
    .filter(sample => sample.sourceUsageId === "msg_atape_manual_text_mock_10")).toHaveLength(2)
  expect(latestUsage(paged.pages)).toEqual({ records: 5, input: 151, output: 73 })
  expectRaw(paged.pages, again)
})

it("preserves two large text records through fragment pages before admitting their boundary", async () => {
  const source = rows(again).map(row => row.uuid === headUuid || row.uuid === tailUuid
    ? { ...row, message: { ...row.message, content: [{ type: "text", text: (row.uuid === headUuid ? "h" : "t").repeat(600_000) }] } } : row)
  const text = lines(source); await writeFile(file, text)
  const collected = await drain(null, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 300_000 })
  const captured = events(collected.pages)
  expect(captured).toHaveLength(15)
  expect(new Set(captured.map(event => event.sourceEventId)).size).toBe(captured.length)
  for (const [uuid, body] of [[headUuid, "h"], [tailUuid, "t"]] as const) {
    const fragments = captured.filter(event => event.sourceEventId.startsWith(`${uuid}:`))
    expect(fragments).toHaveLength(3)
    expect(fragments.map(event => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join(""))
      .toBe(body.repeat(600_000))
  }
  expect(latestUsage(collected.pages)).toEqual({ records: 5, input: 151, output: 73 })
  expectRaw(collected.pages, text)
})

it("waits for an incomplete second record, then joins the committed old head with the newly appended tail", async () => {
  const sourceLines = again.split("\n"), tail = sourceLines.findIndex(line => line.includes(`"uuid":"${tailUuid}"`))
  const line = sourceLines[tail]!, cut = Math.floor(line.length / 2), prefix = sourceLines.slice(0, tail).join("\n") + "\n"
  await writeFile(file, prefix + line.slice(0, cut))
  const partial = await drain()
  expect(events(partial.pages)).toHaveLength(6)
  expectRaw(partial.pages, prefix)
  expect((await read(request(partial.cursor))).observations).toEqual([])
  await appendFile(file, line.slice(cut) + "\n" + sourceLines.slice(tail + 1).join("\n"))
  const rest = await drain(partial.cursor)
  expect(events(rest.pages)).toHaveLength(5)
  expect(latestUsage([...partial.pages, ...rest.pages])).toEqual({ records: 5, input: 151, output: 73 })
  expectRaw([...partial.pages, ...rest.pages], again)
})

it("keeps proof and Canonical collection independent from Raw-off capture and later backfill", async () => {
  const off = await drain(null, false, { eventsPerObservation: 1 })
  expect(events(off.pages)).toHaveLength(11); expect(raw(off.pages)).toEqual([])
  expect(latestUsage(off.pages)).toEqual({ records: 5, input: 151, output: 73 })
  const on = await drain(off.cursor)
  expect(events(on.pages)).toEqual([])
  expect(on.pages.flatMap(page => page.observations.flatMap(observation => observation.usage ?? []))).toEqual([])
  expectRaw(on.pages, again)
})

it("commits usage deferred after its Event before using that source record as preserved-tail evidence", async () => {
  const collected = await drain(null, true, { canonicalBytesPerObservation: 9000 })
  expect(collected.pages.some(page => page.observations.some(observation => !observation.events.length && (observation.usage?.length ?? 0) > 0)))
    .toBe(true)
  expect(events(collected.pages)).toHaveLength(11)
  expect(latestUsage(collected.pages)).toEqual({ records: 5, input: 151, output: 73 })
  expectRaw(collected.pages, again)
})

it("uses the same collect Interface when a long-lived runtime caches previously verified prefix hashes", async () => {
  const runtime = await createAtapeAdapter(context), captured: AdapterCollectionPage[] = []
  let cursor: string | null = null, finished = false
  for (let index = 0; index < 30; index++) {
    const input = request(cursor, true, { eventsPerObservation: 1 }), page = await runtime.collect(input) as AdapterCollectionPage
    expect(await runtime.collect(input)).toEqual(page)
    captured.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.observations.length && !page.hasMore) { finished = true; break }
  }
  expect(finished).toBe(true)
  expect(events(captured)).toHaveLength(11)
  expect(latestUsage(captured)).toEqual({ records: 5, input: 151, output: 73 })
  expectRaw(captured, again)
})

it.each(["api", "missing-api", "index", "index-order", "model", "role", "extra-text", "empty-text", "tool", "meta", "version", "sidechain", "session", "parent",
  "bookkeeping-gap", "blank-gap", "head", "tail", "list-order", "unequal-list", "excess-list", "unequal-anchor", "past-anchor", "future-anchor", "auto"])
("rejects unsupported retained text evidence: %s", async kind => {
  const source = rows(again), head = source.find(row => row.uuid === headUuid)!, tail = source.find(row => row.uuid === tailUuid)!
  const boundary = source.find(row => row.subtype === "compact_boundary")!, segment = boundary.compactMetadata.preservedSegment, preserved = boundary.compactMetadata.preservedMessages
  if (kind === "api") head.message.id = "different-api-response"
  if (kind === "missing-api") delete head.message.id
  if (kind === "index") tail.apiBlockIndex = 2
  if (kind === "index-order") { head.apiBlockIndex = 1; tail.apiBlockIndex = 0 }
  if (kind === "model") head.message.model = "different-model"
  if (kind === "role") head.message.role = "user"
  if (kind === "extra-text") head.message.content.push({ type: "text", text: "extra body" })
  if (kind === "empty-text") head.message.content[0].text = ""
  if (kind === "tool") head.message.content = [{ type: "tool_use", id: "unexpected-tool", name: "Read", input: {} }]
  if (kind === "meta") head.isMeta = true
  if (kind === "version") head.version = "2.1.262"
  if (kind === "sidechain") head.isSidechain = true
  if (kind === "session") head.sessionId = "foreign-session"
  if (kind === "parent") tail.parentUuid = source.find(row => row.type === "user")!.uuid
  if (kind === "bookkeeping-gap") source.splice(source.indexOf(tail), 0, { type: "queue-operation", operation: "dequeue", sessionId: head.sessionId })
  if (kind === "head") { segment.headUuid = source.find(row => row.type === "assistant")!.uuid; preserved.uuids[0] = segment.headUuid; preserved.allUuids[0] = segment.headUuid }
  if (kind === "tail") segment.tailUuid = headUuid
  if (kind === "list-order") { preserved.uuids.reverse(); preserved.allUuids.reverse() }
  if (kind === "unequal-list") preserved.allUuids[0] = tailUuid
  if (kind === "excess-list") { preserved.uuids.push("extra-tail"); preserved.allUuids.push("extra-tail") }
  if (kind === "unequal-anchor") preserved.anchorUuid = "different-summary"
  if (kind === "past-anchor") segment.anchorUuid = preserved.anchorUuid = headUuid
  if (kind === "future-anchor") segment.anchorUuid = preserved.anchorUuid = "unbound-summary"
  if (kind === "auto") boundary.compactMetadata.trigger = "auto"
  let text = lines(source)
  if (kind === "blank-gap") text = text.replace(JSON.stringify(tail) + "\n", "\n" + JSON.stringify(tail) + "\n")
  await writeFile(file, text)
  await expect(read()).rejects.toThrow(/same-response text tail|append-only root evidence|unambiguous|selected Thread|Mixed Claude|summary identity|summary does not match/)
})

it("rejects an unsupported pair after ordinary prefix capture without acknowledging the boundary or replaying the old Events", async () => {
  const source = rows(before), head = source.find(row => row.uuid === headUuid)!
  head.message.id = "different-api-response"
  const prefix = lines(source); await writeFile(file, prefix)
  const initial = await drain(), retainedProgress = [...progress], oldEvents = events(initial.pages)
  await appendFile(file, compacted.slice(before.length))
  const input = request(initial.cursor)
  await expect(read(input)).rejects.toThrow("same-response text tail")
  await expect(read(input)).rejects.toThrow("same-response text tail")
  expect(progress).toEqual(retainedProgress)
  await writeFile(file, prefix)
  expect((await read(input)).observations).toEqual([])
  expect(oldEvents).toHaveLength(7)
})

it("rejects rewritten committed text and can resume after restoring the exact prefix without resetting its cursor", async () => {
  await writeFile(file, before)
  const initial = await drain(), retainedProgress = [...progress]
  await writeFile(file, again.replace("ATAPE_MANUAL_TEXT_FINAL_A", "ATAPE_REWRITTEN_TEXT_FINAL_A"))
  await expect(read(request(initial.cursor))).rejects.toThrow("prefix changed")
  expect(progress).toEqual(retainedProgress)
  await writeFile(file, again)
  const rest = await drain(initial.cursor)
  expect(events(rest.pages)).toHaveLength(4)
  expect(latestUsage([...initial.pages, ...rest.pages])).toEqual({ records: 5, input: 151, output: 73 })
  expectRaw([...initial.pages, ...rest.pages], again)
})

it("checks original identity against the same preserved-prefix read when a file changes after Host attribution", async () => {
  const root = rows(again).find(row => row.uuid)!, changed = again.replaceAll(root.uuid, "changed-original-root")
  const runtime = await createAtapeAdapter({ ...context, project: { ...context.project, type: "git" },
    gitAttribution: { version: "atape.git-attribution.v1", resolve: async () => { await writeFile(file, changed); return "included" } } })
  await expect(runtime.collect(request())).rejects.toThrow("original identity changed")
  expect(progress).toEqual([])
})

it("rejects child compaction even when its retained pair otherwise matches the native text profile", async () => {
  const family = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
  const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd"
  const childFile = join(directory, sessionId, "subagents", `agent-${agentId}.jsonl`)
  const rootText = (await readFile(new URL(`${sessionId}.jsonl`, family), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const childText = (await readFile(new URL(`${sessionId}/subagents/agent-${agentId}.jsonl`, family), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const leaf = rows(childText).filter(row => row.uuid).at(-1)!, manual = rows(again)
  const head = { ...manual.find(row => row.uuid === headUuid)!, parentUuid: leaf.uuid, sessionId, agentId, isSidechain: true }
  const tail = { ...manual.find(row => row.uuid === tailUuid)!, sessionId, agentId, isSidechain: true }
  await mkdir(join(directory, sessionId, "subagents"), { recursive: true })
  await writeFile(file, rootText); await writeFile(childFile, childText + lines([head, tail]))
  const initial = await drain(), retainedProgress = [...progress]
  const boundary = { ...manual.find(row => row.subtype === "compact_boundary")!, sessionId, agentId, isSidechain: true }
  await appendFile(childFile, lines([boundary]))
  const input = request(initial.cursor), rejected = await read(input)
  expect(rejected).toMatchObject({ observations: [], nextCursor: initial.cursor,
    sourceFailures: [{ source: childFile, reason: "unsupported" }] })
  expect(await read(input)).toEqual(rejected)
  acknowledge(rejected); expect(progress).toEqual(retainedProgress)
})

it("retains requested Raw and Canonical page limits while validating preserved tails", async () => {
  await writeFile(file, before)
  const initial = await drain(), retainedProgress = [...progress]
  await appendFile(file, compacted.slice(before.length))
  await expect(read(request(initial.cursor, true, { rawSegmentBytes: 1, rawBytesPerObservation: 1 }))).rejects.toThrow("Raw page limit")
  expect(progress).toEqual(retainedProgress)
  progress = []
  await writeFile(file, again)
  await expect(read(request(null, true, { canonicalBytesPerObservation: 8600 }))).rejects.toThrow("Canonical observation limit")
  const large = lines(rows(again).map(row => row.uuid === headUuid
    ? { ...row, message: { ...row.message, content: [{ type: "text", text: "large source".repeat(60_000) }] } } : row))
  await writeFile(file, large)
  const limits = { rawSegmentBytes: 128_000, rawBytesPerObservation: 128_000 }, accepted = await read(request(null, true, limits))
  expect(raw([accepted]).reduce((total, segment) => total + Buffer.byteLength(segment.content), 0)).toBeLessThanOrEqual(limits.rawBytesPerObservation)
  acknowledge(accepted)
  const admittedProgress = [...progress]
  await expect(read(request(accepted.nextCursor, true, limits))).rejects.toThrow("Raw page limit")
  expect(progress).toEqual(admittedProgress)
})
