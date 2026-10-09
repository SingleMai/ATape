import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterEvent,
  type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

// These are generated relationship mutations of recorded foreground JSONL.
// They verify the public Adapter contract, not additional native acquisitions.
type Row = Record<string, any>
const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd"
const fixture = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
let directory: string, rootFile: string, childFile: string, sourcePath: string
let context: AdapterOpenContext & { signal: AbortSignal }, rows: Row[], childText: string
let progress: AdapterCollectRequest["rawProgress"]
const encode = (values: Row[]) => values.map(row => JSON.stringify(row)).join("\n") + "\n"
const receipt = (values = rows) => values.find(row => row.toolUseResult?.agentId)!
const invocation = (values = rows) => values.find(row => row.type === "assistant" &&
  Array.isArray(row.message?.content) && row.message.content.some((block: Row) => block.type === "tool_use"))!
const leaf = (values = rows) => values.filter(row => row.uuid).at(-1)!
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-unlinked-"))
  rootFile = join(directory, `${sessionId}.jsonl`); sourcePath = rootFile
  childFile = join(directory, sessionId, "subagents", `agent-${agentId}.jsonl`)
  const rootText = (await readFile(new URL(`${sessionId}.jsonl`, fixture), "utf8"))
    .replaceAll("/fixture/native-foreground-child", directory)
  childText = (await readFile(new URL(`${sessionId}/subagents/agent-${agentId}.jsonl`, fixture), "utf8"))
    .replaceAll("/fixture/native-foreground-child", directory)
  rows = rootText.trimEnd().split("\n").map(line => JSON.parse(line))
  await mkdir(join(directory, sessionId, "subagents"), { recursive: true })
  // Presence of a proposed file never proves ownership. Reading this file
  // without a qualifying relationship would expose a format failure.
  await writeFile(childFile, "deliberately-invalid-proposed-child\n")
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", rootFile)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const request = (cursor: string | null = null, rawCaptureEnabled = true, eventLimit = 1): AdapterCollectRequest => ({
  protocolVersion: "atape.adapter.v1alpha1", cursor, rawCaptureEnabled, rawProgress: progress,
  limits: { ...AdapterCollectionLimits, eventsPerObservation: eventLimit }, signal: new AbortController().signal
})
const collect = async (input: AdapterCollectRequest) => await (await createAtapeAdapter(context)).collect(input) as AdapterCollectionPage
const acknowledge = (page: AdapterCollectionPage) => {
  const receipts = new Map(progress.map(item => [item.sourceObjectId, item]))
  for (const observation of page.observations) for (const raw of observation.rawSegments) receipts.set(raw.sourceObjectId, {
    sourceSessionId: observation.session.sourceSessionId, sourceObjectId: raw.sourceObjectId,
    sourceGeneration: raw.sourceGeneration, sourceOffset: raw.sourceOffset + Buffer.byteLength(raw.content), finalized: raw.final
  })
  progress = [...receipts.values()]
}
const drain = async (cursor: string | null = null, raw = true, rawBytes?: number) => {
  const pages: AdapterCollectionPage[] = []
  for (let count = 0; count < 100; count++) {
    const base = request(cursor, raw)
    const input = rawBytes === undefined ? base : { ...base,
      limits: { ...base.limits, rawSegmentBytes: rawBytes, rawBytesPerObservation: rawBytes } }
    const page = await collect(input)
    // Each call constructs a new factory, including the exact retry.
    expect(await collect(input)).toEqual(page)
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.observations.length && !page.hasMore) return { pages, cursor }
  }
  throw new Error("Generated Claude relationship case did not finish")
}
const events = (pages: AdapterCollectionPage[]): AdapterEvent[] => pages.flatMap(page => page.observations.flatMap(o => o.events))
const usage = (pages: AdapterCollectionPage[]): AdapterUsage[] => pages.flatMap(page => page.observations.flatMap(o => o.usage ?? []))
const rawText = (pages: AdapterCollectionPage[]) => {
  let offset = 0, objectId: string | undefined, generation: string | undefined, text = ""
  for (const segment of pages.flatMap(page => page.observations.flatMap(o => o.rawSegments))) {
    expect(segment.sourceName).toBe(`${sessionId}.jsonl`)
    expect(segment.sourceOffset).toBe(offset)
    objectId ??= segment.sourceObjectId; generation ??= segment.sourceGeneration
    expect(segment.sourceObjectId).toBe(objectId); expect(segment.sourceGeneration).toBe(generation)
    offset += Buffer.byteLength(segment.content); text += segment.content
  }
  return text
}
const appendReply = () => {
  const previous = leaf()
  rows.push({ ...previous, uuid: "generated-following-reply", parentUuid: previous.uuid,
    timestamp: "2026-10-09T01:00:00Z", message: { role: "assistant", id: "generated-following-api", model: "generated-model",
      content: [{ type: "text", text: "The current root Thread continues after the unlinked result." }],
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } })
}
const expectCurrentRoot = (pages: AdapterCollectionPage[], expectedCount = 5) => {
  const observations = pages.flatMap(page => page.observations), captured = events(pages)
  expect(captured).toHaveLength(expectedCount)
  expect(new Set(captured.map(event => event.sourceEventId)).size).toBe(expectedCount)
  expect(captured.every(event => event.sourceThreadId === "root" && event.childSourceThreadId === undefined)).toBe(true)
  expect(observations.every(observation => observation.threads.length === 1 && observation.threads[0]?.sourceThreadId === "root")).toBe(true)
  expect(observations.every(observation => observation.events.length <= 1)).toBe(true)
  expect(usage(pages)).toHaveLength(3)
  expect(usage(pages).map(sample => sample.sourceUsageId)).toEqual(["msg_atape_mock_1", "msg_atape_mock_4", "generated-following-api"])
  expect(usage(pages).at(-1)).toMatchObject({ sourceThreadId: "root", model: "generated-model", inputTokens: 8,
    outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 })
  expect(captured.at(-1)?.update).toMatchObject({ content: { text: "The current root Thread continues after the unlinked result." } })
}
const expectIdleDiagnostic = async (cursor: string | null, raw = true) => {
  const input = request(cursor, raw), idle = await collect(input)
  expect(idle).toMatchObject({ observations: [], nextCursor: cursor, hasMore: false,
    sourceFailures: [{ source: sourcePath, reason: "unsupported" }] })
  expect(await collect(input)).toEqual(idle)
  expect(idle.sourceFailures).toHaveLength(1)
  expect(idle.progress).toMatchObject({ sourceFiles: 1, pendingCanonicalSessions: 0, pendingRawBytes: 0 })
}
const nestedChildRows = (): Row[] => {
  const values: Row[] = childText.trimEnd().split("\n").map(line => JSON.parse(line))
  const call = values.find(row => row.type === "assistant" && row.message.content.some((block: Row) => block.type === "tool_use"))!
  call.message.content[0].name = "Agent"
  const result = values.find(row => row.type === "user" && Array.isArray(row.message.content))!
  result.toolUseResult = { status: "completed", agentId: "generated-grandchild" }
  return values
}

const mutations: Array<{ label: string; change: () => void; extraEvents?: number; failed?: boolean }> = [
  { label: "asynchronous launch", change: () => Object.assign(receipt().toolUseResult, { status: "async_launched", isAsync: true }) },
  { label: "asynchronous completed metadata", change: () => Object.assign(receipt().toolUseResult, { isAsync: true }) },
  { label: "unsuccessful receipt", change: () => Object.assign(receipt().toolUseResult, { status: "failed" }) },
  { label: "missing completion status", change: () => { delete receipt().toolUseResult.status } },
  { label: "tool error", change: () => { receipt().message.content[0].is_error = true }, failed: true },
  { label: "missing assistant proof", change: () => { delete receipt().sourceToolAssistantUUID } },
  { label: "missing relationship metadata", change: () => { delete receipt().toolUseResult } },
  { label: "null relationship metadata", change: () => { receipt().toolUseResult = null } },
  { label: "missing Agent identity", change: () => { delete receipt().toolUseResult.agentId } },
  { label: "empty Agent identity", change: () => { receipt().toolUseResult.agentId = "" } },
  { label: "unsafe Agent path", change: () => { receipt().toolUseResult.agentId = "../outside" } },
  { label: "oversized Agent identity", change: () => { receipt().toolUseResult.agentId = "a".repeat(129) } },
  { label: "nonstring Agent identity", change: () => { receipt().toolUseResult.agentId = 123 } },
  { label: "Task receipt without relationship proof", change: () => {
    invocation().message.content[0].name = "Task"; delete receipt().sourceToolAssistantUUID
  } },
  { label: "two Agent results in one receipt", extraEvents: 2, change: () => {
    invocation().message.content.push({ type: "tool_use", id: "generated-second-agent", name: "Agent", input: {} })
    receipt().message.content.push({ type: "tool_result", tool_use_id: "generated-second-agent", content: "Second Agent returned." })
  } },
  { label: "Agent and ordinary tool results in one receipt", extraEvents: 2, change: () => {
    invocation().message.content.push({ type: "tool_use", id: "generated-other-tool", name: "Bash", input: { command: "pwd" } })
    receipt().message.content.push({ type: "tool_result", tool_use_id: "generated-other-tool", content: "/generated" })
  } },
  { label: "tool result plus ordinary user text", extraEvents: 1, change: () => {
    receipt().message.content.push({ type: "text", text: "Additional ordinary user text remains visible." })
  } }
]
it.each(mutations)("preserves current Events, real usage and Raw for generated $label", async ({ change, extraEvents = 0, failed }) => {
  change(); appendReply(); const source = encode(rows)
  await writeFile(rootFile, source)
  const done = await drain()
  expectCurrentRoot(done.pages, 5 + extraEvents)
  expect(rawText(done.pages)).toBe(source)
  if (failed) expect(events(done.pages).find(event => event.update.sessionUpdate === "tool_call_update")?.update)
    .toMatchObject({ status: "failed" })
  await expectIdleDiagnostic(done.cursor)
})

it("does not diagnose an Agent invocation as an unlinked receipt", async () => {
  const throughCall = rows.slice(0, rows.indexOf(invocation()) + 1)
  await writeFile(rootFile, encode(throughCall))
  const done = await drain()
  expect(events(done.pages)).toHaveLength(2)
  expect(usage(done.pages)).toHaveLength(1)
  expect(done.pages.every(page => page.sourceFailures === undefined)).toBe(true)
  expect((await collect(request(done.cursor))).sourceFailures).toBeUndefined()
})

it("does not infer a relationship from unrelated ordinary tool metadata", async () => {
  invocation().message.content[0].name = "Bash"
  appendReply(); const source = encode(rows); await writeFile(rootFile, source)
  const done = await drain()
  expectCurrentRoot(done.pages)
  expect(rawText(done.pages)).toBe(source)
  expect(done.pages.every(page => page.sourceFailures === undefined)).toBe(true)
})

it("keeps a proved foreground link when extra blocks add no Canonical Event", async () => {
  receipt().message.content.push({ type: "thinking", thinking: "", signature: "generated-opaque-signature" },
    { type: "generated_unknown", data: { remains: "Raw-only" } })
  const source = encode(rows); await writeFile(rootFile, source); await writeFile(childFile, childText)
  const done = await drain(), observations = done.pages.flatMap(page => page.observations), captured = events(done.pages)
  expect(captured).toHaveLength(8)
  expect(captured.filter(event => event.childSourceThreadId === `claude-agent:${agentId}`)).toHaveLength(1)
  expect(captured.filter(event => event.sourceThreadId === `claude-agent:${agentId}`)).toHaveLength(4)
  expect(usage(done.pages)).toHaveLength(4)
  expect(observations.flatMap(observation => observation.rawSegments).filter(raw => raw.sourceName === `${sessionId}.jsonl`)
    .map(raw => raw.content).join("")).toBe(source)
  expect(observations.flatMap(observation => observation.rawSegments).filter(raw => raw.sourceName === `agent-${agentId}.jsonl`)
    .map(raw => raw.content).join("")).toBe(childText)
  expect(done.pages.every(page => page.sourceFailures === undefined)).toBe(true)
})

it("keeps every complete-line and partial-line restart around an unlinked receipt", async () => {
  Object.assign(receipt().toolUseResult, { status: "async_launched", isAsync: true }); appendReply()
  const completeSource = encode(rows), pages: AdapterCollectionPage[] = []
  await writeFile(rootFile, "")
  let cursor: string | null = null, committed = "", diagnosed = false
  for (const row of rows) {
    const line = JSON.stringify(row) + "\n", halfway = Math.floor(line.length / 2)
    await appendFile(rootFile, line.slice(0, halfway))
    // Discovery cannot identify the original root until its first complete LF.
    if (committed.includes('"uuid"')) {
      const partial = await drain(cursor); pages.push(...partial.pages); cursor = partial.cursor
      expect(events(partial.pages)).toEqual([])
      expect(usage(partial.pages)).toEqual([])
      expect(partial.pages.flatMap(page => page.observations.flatMap(o => o.rawSegments))).toEqual([])
      if (diagnosed) expect(partial.pages.at(-1)?.sourceFailures).toEqual([{ source: sourcePath, reason: "unsupported" }])
      else expect(partial.pages.every(page => page.sourceFailures === undefined)).toBe(true)
    }
    await appendFile(rootFile, line.slice(halfway)); committed += line
    if (!committed.includes('"uuid"')) continue
    const next = await drain(cursor); pages.push(...next.pages); cursor = next.cursor
    if (row.toolUseResult?.agentId) diagnosed = true
    if (diagnosed) expect(next.pages.at(-1)?.sourceFailures).toEqual([{ source: sourcePath, reason: "unsupported" }])
    else expect(next.pages.every(page => page.sourceFailures === undefined)).toBe(true)
  }
  expectCurrentRoot(pages)
  expect(rawText(pages)).toBe(completeSource)
  await expectIdleDiagnostic(cursor)
})

it("backfills bounded Raw after Raw-off capture and preserves advanced acknowledgements", async () => {
  Object.assign(receipt().toolUseResult, { status: "failed" }); appendReply()
  const source = encode(rows); await writeFile(rootFile, source)
  const off = await drain(null, false)
  expectCurrentRoot(off.pages)
  expect(off.pages.flatMap(page => page.observations.flatMap(o => o.rawSegments))).toEqual([])
  await expectIdleDiagnostic(off.cursor, false)

  const base = request(off.cursor), firstInput = { ...base,
    limits: { ...base.limits, rawSegmentBytes: 4096, rawBytesPerObservation: 4096 } }
  const first = await collect(firstInput)
  expect(await collect(firstInput)).toEqual(first)
  expect(events([first])).toEqual([]); expect(usage([first])).toEqual([])
  acknowledge(first)
  expect(progress[0]?.sourceOffset).toBeGreaterThan(0)
  expect(progress[0]?.sourceOffset).toBeLessThan(Buffer.byteLength(source))
  // The caller may retain the old Canonical cursor with a newer durable Raw ACK.
  const advanced = await drain(off.cursor, true, 4096)
  expect(events(advanced.pages)).toEqual([]); expect(usage(advanced.pages)).toEqual([])
  expect(rawText([first, ...advanced.pages])).toBe(source)
  expect(advanced.pages.flatMap(page => page.observations.flatMap(o => o.rawSegments)).every(raw => Buffer.byteLength(raw.content) <= 4096)).toBe(true)
  await expectIdleDiagnostic(advanced.cursor)
})

it("deduplicates several unlinked receipts to one diagnostic for their current source", async () => {
  Object.assign(receipt().toolUseResult, { status: "failed" }); appendReply()
  const firstCall = invocation(), firstReceipt = receipt(), previous = leaf()
  rows.push({ ...firstCall, uuid: "generated-next-agent-call", parentUuid: previous.uuid,
    message: { ...firstCall.message, id: "generated-next-agent-api",
      content: [{ type: "tool_use", id: "generated-next-agent-tool", name: "Agent", input: {} }] } })
  rows.push({ ...firstReceipt, uuid: "generated-next-agent-result", parentUuid: "generated-next-agent-call",
    sourceToolAssistantUUID: "generated-next-agent-call", toolUseResult: { status: "async_launched", isAsync: true, agentId: "other-agent" },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "generated-next-agent-tool", content: "Background launch acknowledged." }] } })
  await writeFile(rootFile, encode(rows))
  const done = await drain()
  expect(events(done.pages)).toHaveLength(7)
  expect(done.pages.every(page => (page.sourceFailures?.length ?? 0) <= 1)).toBe(true)
  await expectIdleDiagnostic(done.cursor)
})

it.each([true, false])("retains a captured child's unlinked diagnostic on a root append page with Raw=%s", async raw => {
  const source = encode(rows), childSource = encode(nestedChildRows())
  await writeFile(rootFile, source); await writeFile(childFile, childSource)
  const done = await drain(null, raw)
  expect(done.pages.at(-1)?.sourceFailures).toEqual([{ source: childFile, reason: "unsupported" }])
  const retainedProgress = [...progress]
  appendReply(); const line = JSON.stringify(leaf()) + "\n"
  await appendFile(rootFile, line)
  const input = request(done.cursor, raw), page = await collect(input)
  expect(await collect(input)).toEqual(page)
  expect(events([page]).map(event => event.sourceEventId)).toEqual(["generated-following-reply:0"])
  expect(events([page])[0]?.sourceThreadId).toBe("root")
  expect(usage([page])).toMatchObject([{ sourceThreadId: "root", sourceUsageId: "generated-following-api", inputTokens: 8, outputTokens: 3 }])
  expect(page.sourceFailures).toEqual([{ source: childFile, reason: "unsupported" }])
  const segments = page.observations.flatMap(observation => observation.rawSegments)
  if (raw) expect(segments).toMatchObject([{ sourceName: `${sessionId}.jsonl`, sourceOffset: Buffer.byteLength(source), content: line }])
  else expect(segments).toEqual([])
  acknowledge(page)
  expect(progress.filter(item => item.sourceObjectId.startsWith("claude-agent-rollout-")))
    .toEqual(retainedProgress.filter(item => item.sourceObjectId.startsWith("claude-agent-rollout-")))
  const idle = await collect(request(page.nextCursor, raw))
  expect(idle).toMatchObject({ observations: [], sourceFailures: [{ source: childFile, reason: "unsupported" }] })
})

it.each(["changed", "missing"])("keeps captured child %s semantics while publishing a healthy root append", async kind => {
  await writeFile(rootFile, encode(rows)); await writeFile(childFile, encode(nestedChildRows()))
  const done = await drain()
  if (kind === "changed") await writeFile(childFile, encode(nestedChildRows()).replace("ATAPE_CHILD_FINAL", "CHANGED_CHILD_FINAL"))
  else await rm(childFile)
  appendReply(); await appendFile(rootFile, JSON.stringify(leaf()) + "\n")
  const input = request(done.cursor), page = await collect(input)
  expect(await collect(input)).toEqual(page)
  expect(events([page]).map(event => event.sourceEventId)).toEqual(["generated-following-reply:0"])
  expect(usage([page])).toHaveLength(1)
  expect(page.observations[0]?.threads.map(thread => thread.sourceThreadId)).toEqual(["root", `claude-agent:${agentId}`])
  expect(page.observations.flatMap(observation => observation.rawSegments).every(segment => segment.sourceName === `${sessionId}.jsonl`)).toBe(true)
  if (kind === "changed") expect(page.sourceFailures).toEqual([{ source: childFile, reason: "changed" }])
  else expect(page.sourceFailures).toBeUndefined()
})

it("retains another captured child's unlinked diagnostic when a healthy child publishes first", async () => {
  const secondAgent = "generated-second-child", secondFile = join(directory, sessionId, "subagents", `agent-${secondAgent}.jsonl`)
  const call = invocation(), selectedReceipt = receipt(), previous = leaf()
  rows.push({ ...call, uuid: "generated-second-child-call", parentUuid: previous.uuid,
    message: { ...call.message, id: "generated-second-child-api",
      content: [{ type: "tool_use", id: "generated-second-child-tool", name: "Agent", input: {} }] } })
  rows.push({ ...selectedReceipt, uuid: "generated-second-child-result", parentUuid: "generated-second-child-call",
    sourceToolAssistantUUID: "generated-second-child-call", toolUseResult: { status: "completed", agentId: secondAgent },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "generated-second-child-tool", content: "Second child completed." }] } })
  await writeFile(rootFile, encode(rows)); await writeFile(childFile, childText)
  await writeFile(secondFile, encode(nestedChildRows().map(row => ({ ...row, agentId: secondAgent }))))
  const done = await drain()
  expect(done.pages.at(-1)?.sourceFailures).toEqual([{ source: secondFile, reason: "unsupported" }])
  const childLeaf: Row = childText.trimEnd().split("\n").map(line => JSON.parse(line)).filter(row => row.uuid).at(-1)!
  const line = JSON.stringify({ ...childLeaf, uuid: "generated-healthy-child-append", parentUuid: childLeaf.uuid,
    message: { role: "assistant", id: "generated-healthy-child-api", model: "generated-model", content: "Healthy child continues.",
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } }) + "\n"
  await appendFile(childFile, line)
  const input = request(done.cursor), page = await collect(input)
  expect(await collect(input)).toEqual(page)
  expect(events([page]).map(event => event.sourceEventId)).toEqual(["generated-healthy-child-append:0"])
  expect(events([page])[0]?.sourceThreadId).toBe(`claude-agent:${agentId}`)
  expect(usage([page])).toMatchObject([{ sourceThreadId: `claude-agent:${agentId}`, sourceUsageId: "generated-healthy-child-api" }])
  expect(page.sourceFailures).toEqual([{ source: secondFile, reason: "unsupported" }])
  expect(page.observations.flatMap(observation => observation.rawSegments))
    .toMatchObject([{ sourceName: `agent-${agentId}.jsonl`, sourceOffset: Buffer.byteLength(childText), content: line }])
})

it.each(["wrong source correlation", "stale parent", "foreign Thread", "foreign Session", "closed tool call"])(
  "keeps generated %s a hard source failure even with soft relationship metadata", async kind => {
    const selectedReceipt = receipt(), call = invocation()
    Object.assign(selectedReceipt.toolUseResult, { status: "async_launched", isAsync: true })
    if (kind === "wrong source correlation") selectedReceipt.sourceToolAssistantUUID = "different-assistant"
    if (kind === "stale parent") selectedReceipt.parentUuid = rows.find(row => row.parentUuid === null)!.uuid
    if (kind === "foreign Thread") selectedReceipt.isSidechain = true
    if (kind === "foreign Session") selectedReceipt.sessionId = "foreign-session"
    if (kind === "closed tool call") {
      const previous = leaf()
      rows.push({ ...selectedReceipt, uuid: "generated-closed-result", parentUuid: previous.uuid,
        sourceToolAssistantUUID: call.uuid })
    }
    await writeFile(rootFile, encode(rows))
    await expect(collect(request(null, true, 500))).rejects.toMatchObject({ reason: "unsupported" })
  })

it("does not let asynchronous metadata reassign an already pinned Agent to a new invocation", async () => {
  await writeFile(childFile, childText)
  const call = invocation(), selectedReceipt = receipt(), previous = leaf()
  rows.push({ ...call, uuid: "generated-conflicting-agent-call", parentUuid: previous.uuid,
    message: { ...call.message, id: "generated-conflicting-agent-api",
      content: [{ type: "tool_use", id: "generated-conflicting-agent-tool", name: "Agent", input: {} }] } })
  rows.push({ ...selectedReceipt, uuid: "generated-conflicting-agent-result", parentUuid: "generated-conflicting-agent-call",
    sourceToolAssistantUUID: "generated-conflicting-agent-call",
    toolUseResult: { status: "async_launched", isAsync: true, agentId },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "generated-conflicting-agent-tool", content: "Conflicting Agent identity." }] } })
  await writeFile(rootFile, encode(rows))
  await expect(collect(request(null, true, 500))).rejects.toMatchObject({ reason: "unsupported" })
})

it("does not let ambiguous asynchronous results waive a pinned Agent conflict", async () => {
  await writeFile(childFile, childText)
  const call = invocation(), selectedReceipt = receipt(), previous = leaf()
  rows.push({ ...call, uuid: "generated-conflicting-batch", parentUuid: previous.uuid,
    message: { ...call.message, id: "generated-conflicting-batch-api",
      content: [{ type: "tool_use", id: "generated-conflicting-tool-a", name: "Agent", input: {} },
        { type: "tool_use", id: "generated-conflicting-tool-b", name: "Task", input: {} }] } })
  rows.push({ ...selectedReceipt, uuid: "generated-conflicting-batch-result", parentUuid: "generated-conflicting-batch",
    sourceToolAssistantUUID: "generated-conflicting-batch", toolUseResult: { status: "async_launched", isAsync: true, agentId },
    message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "generated-conflicting-tool-a", content: "A returned." },
      { type: "tool_result", tool_use_id: "generated-conflicting-tool-b", content: "B returned." }] } })
  await writeFile(rootFile, encode(rows))
  await expect(collect(request(null, true, 500))).rejects.toMatchObject({ reason: "unsupported" })
})

it("keeps an explicit nested claim to the root's pinned Agent identity a hard child source failure", async () => {
  await writeFile(rootFile, encode(rows))
  const childRows: Row[] = childText.trimEnd().split("\n").map(line => JSON.parse(line))
  const childCall = childRows.find(row => row.type === "assistant" && row.message.content.some((block: Row) => block.type === "tool_use"))!
  childCall.message.content[0].name = "Agent"
  const childResult = childRows.find(row => row.type === "user" && Array.isArray(row.message.content))!
  childResult.toolUseResult = { status: "async_launched", isAsync: true, agentId }
  await writeFile(childFile, encode(childRows))
  const root = await collect(request(null, true, 500)); acknowledge(root)
  const failed = await collect(request(root.nextCursor, true, 500))
  expect(failed).toMatchObject({ observations: [], nextCursor: root.nextCursor,
    sourceFailures: [{ source: childFile, reason: "unsupported" }] })
  expect(await collect(request(root.nextCursor, true, 500))).toEqual(failed)
})
