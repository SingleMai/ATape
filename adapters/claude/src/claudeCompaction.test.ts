import { AdapterCollectionLimits, type AdapterCollectRequest, type AdapterCollectionPage, type AdapterOpenContext } from "@atape/domain"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-manual-compact-2.1.263/", import.meta.url)
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let before: string, compacted: string, continued: string, progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-compaction-")); file = join(directory, "session.jsonl")
  const sources = await Promise.all(["before", "compacted", "continued"].map(async name =>
    (await readFile(new URL(`${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-manual-compact", directory)))
  before = sources[0]!; compacted = sources[1]!; continued = sources[2]!
  await writeFile(file, continued)
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const rows = (source: string): Row[] => source.trimEnd().split("\n").map(line => JSON.parse(line))
const jsonLines = (records: Row[]) => records.map(row => JSON.stringify(row)).join("\n") + "\n"
const request = (cursor: string | null = null, rawCaptureEnabled = true): AdapterCollectRequest => ({
  protocolVersion: "atape.adapter.v1alpha1", cursor, rawProgress: progress, rawCaptureEnabled,
  limits: AdapterCollectionLimits, signal: new AbortController().signal
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
const drain = async (cursor: string | null = null, raw = true, events = 500) => {
  const pages: AdapterCollectionPage[] = []
  for (let n = 0; n < 100; n++) {
    const input = request(cursor, raw), page = await read({ ...input, limits: { ...input.limits, eventsPerObservation: events } })
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.hasMore && !page.observations.length) return { pages, cursor }
  }
  throw new Error("Claude compaction did not finish bounded collection")
}
const events = (pages: AdapterCollectionPage[]) => pages.flatMap(p => p.observations.flatMap(o => o.events))
const usage = (pages: AdapterCollectionPage[]) => pages.flatMap(p => p.observations.flatMap(o => o.usage ?? []))
const raw = (pages: AdapterCollectionPage[]) => pages.flatMap(p => p.observations.flatMap(o => o.rawSegments))
const checkpoint = (page: AdapterCollectionPage) => JSON.parse(page.nextCursor!).sessions[0].checkpoint

it("captures native manual compaction and continuation without fabricating control messages or token usage", async () => {
  const collected = await drain()
  expect(events(collected.pages)).toHaveLength(6)
  expect(events(collected.pages).map(e => e.update.sessionUpdate)).toEqual([
    "user_message_chunk", "agent_message_chunk", "user_message_chunk", "agent_message_chunk", "user_message_chunk", "agent_message_chunk"
  ])
  expect(JSON.stringify(events(collected.pages))).not.toMatch(/ATAPE_COMPACT_SUMMARY|No response requested|command-name|local-command/)
  expect(usage(collected.pages).map(u => u.sourceUsageId)).toEqual(["msg_atape_compact_mock_1", "msg_atape_compact_mock_2", "msg_atape_compact_mock_4"])
  expect(usage(collected.pages).reduce((sum, u) => sum + u.inputTokens!, 0)).toBe(81)
  expect(usage(collected.pages).reduce((sum, u) => sum + u.outputTokens!, 0)).toBe(37)
  expect(raw(collected.pages).map(r => r.content).join("")).toBe(continued)
  expect(collected.pages.at(-1)?.progress).toMatchObject({ pendingRawBytes: 0, pendingCanonicalSessions: 0 })
})

it("appends compact and continued stages to a projection-4 legacy checkpoint while preserving old IDs and Raw identity", async () => {
  await writeFile(file, before)
  const initial = await drain(), original = events(initial.pages), originalRaw = raw(initial.pages)[0]!
  await appendFile(file, compacted.slice(before.length))
  const compact = await drain(initial.cursor)
  expect(events(compact.pages)).toEqual([]); expect(usage(compact.pages)).toEqual([])
  expect(compact.pages.at(-1)?.progress?.pendingCanonicalSessions).toBe(0)
  await appendFile(file, continued.slice(compacted.length))
  const resumed = await drain(compact.cursor)
  expect(events(resumed.pages)).toHaveLength(2); expect(usage(resumed.pages)).toHaveLength(1)
  expect(events(resumed.pages).every(e => !original.some(old => old.sourceEventId === e.sourceEventId))).toBe(true)
  const fresh = await read()
  expect(fresh.observations[0]!.events.slice(0, original.length)).toEqual(original)
  const segments = [...raw(initial.pages), ...raw(compact.pages), ...raw(resumed.pages)]
  expect(segments.every(r => r.sourceObjectId === originalRaw.sourceObjectId && r.sourceGeneration === originalRaw.sourceGeneration)).toBe(true)
  expect(segments.map(r => r.content).join("")).toBe(continued)
  expect(segments.map(r => r.sourceOffset)).toEqual([0, Buffer.byteLength(before), Buffer.byteLength(compacted)])
})

it("replays one-event pages after runtime recreation without duplicate compact or usage events", async () => {
  let cursor: string | null = null
  const pages: AdapterCollectionPage[] = []
  for (let n = 0; n < 50; n++) {
    const input = request(cursor), bounded = { ...input, limits: { ...input.limits, eventsPerObservation: 1 } }, page = await read(bounded)
    expect(await read(bounded)).toEqual(page)
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.observations.length) break
  }
  const captured = events(pages)
  expect(captured).toHaveLength(6)
  expect(new Set(captured.map(e => e.sourceEventId)).size).toBe(6)
  expect(usage(pages)).toHaveLength(3)
})

it("persists each complete native control transition, waits for append and resumes across process recreation", async () => {
  await writeFile(file, before)
  const initial = await drain(); let cursor = initial.cursor
  const captured: AdapterCollectionPage[] = []; let waitingForControls = false
  for (const line of continued.slice(before.length).trimEnd().split("\n")) {
    const record = JSON.parse(line)
    if (record.subtype === "compact_boundary") waitingForControls = true
    if (record.message?.content === "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>") waitingForControls = false
    await appendFile(file, line + "\n")
    const input = request(cursor), page = await read(input)
    expect(await read(input)).toEqual(page)
    captured.push(page); acknowledge(page); cursor = page.nextCursor
    const idle = await read(request(cursor))
    expect(idle.observations).toEqual([])
    if (waitingForControls) expect(idle.progress?.pendingCanonicalSessions).toBe(1)
  }
  expect(events(captured)).toHaveLength(2); expect(usage(captured)).toHaveLength(1)
  expect(raw(captured).map(r => r.content).join("")).toBe(continued.slice(before.length))
})

it("keeps a pending boundary Raw-only and rejects an unexpected next UUID without advancing its checkpoint", async () => {
  const boundary = rows(compacted).find(row => row.subtype === "compact_boundary")!
  await writeFile(file, before + jsonLines([boundary]))
  const initial = await drain(), cursor = initial.cursor
  expect(events(initial.pages)).toHaveLength(4)
  await appendFile(file, jsonLines([{ ...rows(continued).find(row => row.type === "user")!, uuid: "unexpected-user", parentUuid: boundary.uuid }]))
  await expect(read(request(cursor))).rejects.toThrow("summary does not match")
})

it.each(["assistant", "summary", "bookkeeping-message", "conflicting-leaf"])("rejects UUID-less conversation data during compaction: %s", async kind => {
  const boundary = rows(compacted).find(row => row.subtype === "compact_boundary")!
  await writeFile(file, before + jsonLines([boundary]))
  const initial = await drain()
  const injected: Row = kind === "assistant" ? { type: "assistant", timestamp: "2026-10-08T08:18:50.900Z",
    message: { id: "unproved-usage", model: "model", usage: { input_tokens: 999, output_tokens: 999 } } }
    : kind === "summary" ? { type: "last-prompt", isCompactSummary: true, isVisibleInTranscriptOnly: true }
    : kind === "conflicting-leaf" ? { type: "last-prompt", leafUuid: rows(before).find(row => row.type === "user")!.uuid }
    : { type: "queue-operation", message: { role: "user", content: "Unproved user text" } }
  await appendFile(file, jsonLines([injected]))
  await expect(read(request(initial.cursor))).rejects.toThrow("bookkeeping contains unsupported")
})

it.each(["auto", "logical-parent", "tail", "multiple-preserved", "anchor", "old-anchor", "version", "summary-flags", "command", "synthetic-usage", "bridge-version", "bridge-parent", "bridge-sidechain"])
("rejects unsupported manual compact evidence: %s", async kind => {
  const source = rows(continued), boundary = source.find(row => row.subtype === "compact_boundary")!, summary = source.find(row => row.isCompactSummary)!
  if (kind === "auto") boundary.compactMetadata.trigger = "auto"
  if (kind === "logical-parent") boundary.logicalParentUuid = source.find(row => row.type === "user")!.uuid
  if (kind === "tail") boundary.compactMetadata.preservedSegment.tailUuid = "unproved-tail"
  if (kind === "multiple-preserved") boundary.compactMetadata.preservedMessages.allUuids.push("unproved-tail")
  if (kind === "anchor") boundary.compactMetadata.preservedMessages.anchorUuid = "unproved-summary"
  if (kind === "old-anchor") boundary.compactMetadata.preservedMessages.anchorUuid = boundary.compactMetadata.preservedSegment.anchorUuid = boundary.logicalParentUuid
  if (kind === "version") boundary.version = "2.1.264"
  if (kind === "summary-flags") summary.isVisibleInTranscriptOnly = false
  if (kind === "command") source.find(row => row.message?.content?.startsWith?.("<command-name>"))!.message.content = "<command-name>/rewind</command-name>"
  if (kind === "synthetic-usage") source.find(row => row.message?.model === "<synthetic>")!.message.usage.input_tokens = 1
  if (kind === "bridge-version") source.find(row => row.message?.model === "<synthetic>")!.version = "2.1.264"
  if (kind === "bridge-parent") source.find(row => row.message?.model === "<synthetic>")!.parentUuid = boundary.uuid
  if (kind === "bridge-sidechain") source.find(row => row.message?.model === "<synthetic>")!.isSidechain = true
  await writeFile(file, jsonLines(source))
  await expect(read()).rejects.toThrow(/manual compaction|unambiguous|selected Thread/)
})

it("isolates child compaction and retains its acknowledged prefix rather than treating it as a new root", async () => {
  const family = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
  const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd"
  const childDirectory = join(directory, sessionId, "subagents"), childFile = join(childDirectory, `agent-${agentId}.jsonl`)
  const rootText = (await readFile(new URL(`${sessionId}.jsonl`, family), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const childText = (await readFile(new URL(`${sessionId}/subagents/agent-${agentId}.jsonl`, family), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  await mkdir(childDirectory, { recursive: true }); await writeFile(file, rootText); await writeFile(childFile, childText)
  const captured = await drain(), oldLeaf = rows(childText).filter(row => row.uuid).at(-1)!.uuid
  const boundary = rows(compacted).find(row => row.subtype === "compact_boundary")!
  const childBoundary = { ...boundary, sessionId, agentId, isSidechain: true, logicalParentUuid: oldLeaf,
    compactMetadata: { ...boundary.compactMetadata,
      preservedSegment: { ...boundary.compactMetadata.preservedSegment, headUuid: oldLeaf, tailUuid: oldLeaf },
      preservedMessages: { ...boundary.compactMetadata.preservedMessages, uuids: [oldLeaf], allUuids: [oldLeaf] } } }
  await appendFile(childFile, jsonLines([childBoundary]))
  expect(await read(request(captured.cursor))).toMatchObject({ observations: [], nextCursor: captured.cursor,
    sourceFailures: [{ source: childFile, reason: "unsupported" }] })
})

it("rejects an unbound summary and a replayed preserved tail instead of silently flattening them", async () => {
  const source = rows(continued), summary = source.find(row => row.isCompactSummary)!
  const last = rows(before).filter(row => row.uuid).at(-1)!
  await writeFile(file, before + jsonLines([{ ...summary, parentUuid: last.uuid }]))
  await expect(read()).rejects.toThrow("no admitted")
  await writeFile(file, compacted + jsonLines([last]))
  await expect(read()).rejects.toThrow(/synthetic bridge|unambiguous/)
})

it("backfills complete compaction Raw after Raw-off collection without repeating Canonical or usage", async () => {
  const off = await drain(null, false)
  expect(events(off.pages)).toHaveLength(6); expect(usage(off.pages)).toHaveLength(3); expect(raw(off.pages)).toEqual([])
  const on = await drain(off.cursor)
  expect(events(on.pages)).toEqual([]); expect(usage(on.pages)).toEqual([])
  expect(raw(on.pages).map(r => r.content).join("")).toBe(continued)
})

it("rejects changed committed summary bytes and corrupt pending control checkpoints", async () => {
  await writeFile(file, compacted)
  const initial = await drain()
  const cursor = JSON.parse(initial.cursor!)
  cursor.sessions[0].checkpoint.stream.compaction.summaryUuid = "not-seen-summary"
  await expect(read(request(JSON.stringify(cursor)))).rejects.toThrow("checkpoint")
  await writeFile(file, compacted.replace("ATAPE_COMPACT_SUMMARY", "ATAPE_CHANGED_SUMMARY"))
  await expect(read(request(initial.cursor))).rejects.toThrow("prefix changed")
})
