import { AdapterCollectionLimits, type AdapterCollectRequest, type AdapterCollectionPage, type AdapterEvent,
  type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { Effect } from "effect"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { makeSecretRedactorLayer, prepareCanonicalSlice } from "../../../packages/application/src/index.ts"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let progress: AdapterCollectRequest["rawProgress"]
const sid = "generated-thinking-session", encode = (rows: Row[]) => rows.map(row => JSON.stringify(row) + "\n").join("")
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-thinking-")); file = join(directory, "session.jsonl")
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const request = (cursor: string | null = null, raw = true, eventLimit = 1): AdapterCollectRequest => ({
  protocolVersion: "atape.adapter.v1alpha1", cursor, rawCaptureEnabled: raw, rawProgress: progress,
  limits: { ...AdapterCollectionLimits, eventsPerObservation: eventLimit }, signal: new AbortController().signal
})
const prepare = (observation: AdapterCollectionPage["observations"][number]) =>
  prepareCanonicalSlice("claude", { ...observation, rawSegments: [] }).pipe(
    Effect.provide(makeSecretRedactorLayer()), Effect.runPromise)
const collect = async (input: AdapterCollectRequest) => {
  const page = await (await createAtapeAdapter(context)).collect(input) as AdapterCollectionPage
  // Exercise the caller's public Canonical preparation Interface for every actual
  // Adapter slice. Raw has its separate capture path and is asserted below.
  for (const observation of page.observations) await prepare(observation)
  return page
}
const acknowledge = (page: AdapterCollectionPage) => {
  const receipts = new Map(progress.map(item => [item.sourceObjectId, item]))
  for (const observation of page.observations) for (const raw of observation.rawSegments) receipts.set(raw.sourceObjectId, {
    sourceSessionId: observation.session.sourceSessionId, sourceObjectId: raw.sourceObjectId,
    sourceGeneration: raw.sourceGeneration, sourceOffset: raw.sourceOffset + Buffer.byteLength(raw.content), finalized: raw.final
  })
  progress = [...receipts.values()]
}
const drain = async (cursor: string | null = null, raw = true, eventLimit = 1, rawBytes?: number) => {
  const pages: AdapterCollectionPage[] = []
  for (let count = 0; count < 200; count++) {
    const base = request(cursor, raw, eventLimit), input = rawBytes === undefined ? base : { ...base,
      limits: { ...base.limits, rawSegmentBytes: rawBytes, rawBytesPerObservation: rawBytes } }
    const page = await collect(input)
    expect(await collect(input)).toEqual(page)
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.observations.length && !page.hasMore) return { pages, cursor }
  }
  throw new Error("Claude thinking source did not finish bounded collection")
}
const events = (pages: AdapterCollectionPage[]): AdapterEvent[] => pages.flatMap(page => page.observations.flatMap(o => o.events))
const usages = (pages: AdapterCollectionPage[]): AdapterUsage[] => pages.flatMap(page => page.observations.flatMap(o => o.usage ?? []))
const latestUsage = (pages: AdapterCollectionPage[]) => [...new Map(usages(pages).map(sample =>
  [`${sample.sourceThreadId}:${sample.sourceUsageId}`, sample])).values()]
const rawSources = (pages: AdapterCollectionPage[]) => {
  const result = new Map<string, { objectId: string; generation: string; text: string }>()
  for (const segment of pages.flatMap(page => page.observations.flatMap(o => o.rawSegments))) {
    const prior = result.get(segment.sourceName) ?? { objectId: segment.sourceObjectId, generation: segment.sourceGeneration, text: "" }
    expect(segment.sourceObjectId).toBe(prior.objectId); expect(segment.sourceGeneration).toBe(prior.generation)
    expect(segment.sourceOffset).toBe(Buffer.byteLength(prior.text))
    result.set(segment.sourceName, { ...prior, text: prior.text + segment.content })
  }
  return result
}
const thoughtText = (event: AdapterEvent) => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : ""
const loadNative = async () => {
  const folder = new URL("../fixtures/native-thinking-2.1.263/", import.meta.url)
  const proof = JSON.parse(await readFile(new URL("provenance.json", folder), "utf8")), sources = new Map<string, string>()
  for (const entry of proof.files.filter((entry: Row) => entry.path.endsWith(".jsonl"))) {
    const path = join(directory, entry.path), source = (await readFile(new URL(entry.path, folder), "utf8"))
      .replaceAll(proof.fixtureCwd, directory)
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); sources.set(entry.path, source)
  }
  file = join(directory, `${proof.sessionId}.jsonl`); vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  return { proof, sources, child: join(directory, proof.sessionId, "subagents", `agent-${proof.agentId}.jsonl`) }
}

// Generated ordinary records exercise combinations and bounds independently of
// native persistence evidence. They are never written into the native fixtures.
const generated = (): Row[] => {
  const common = { sessionId: sid, cwd: directory, isSidechain: false }
  const assistant = (uuid: string, parentUuid: string, api: string, content: Row[], input: number, output: number, second: number): Row => ({
    ...common, type: "assistant", uuid, parentUuid, timestamp: `2026-10-09T02:00:0${second}Z`,
    message: { role: "assistant", id: api, model: "generated-model", content,
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } }
  })
  return [
    { ...common, type: "user", uuid: "generated-root", parentUuid: null, timestamp: "2026-10-09T02:00:00Z",
      message: { role: "user", content: "Generated thinking prompt" } },
    assistant("generated-plan", "generated-root", "generated-plan-api", [
      { type: "thinking", thinking: "First recorded thought 思考🧠", signature: "opaque-signature-one" },
      { type: "text", text: "Visible plan" }, { type: "thinking", thinking: " \n\t " },
      { type: "redacted_thinking", data: "opaque-redacted-body" }, { type: "generated_unknown", data: "unknown-body" },
      { type: "thinking", thinking: "", signature: "opaque-empty-signature" }
    ], 17, 7, 1),
    { ...assistant("generated-call", "generated-plan", "generated-plan-api", [
      { type: "thinking", thinking: "Recorded thought before the tool" },
      { type: "tool_use", id: "generated-tool", name: "Bash", input: { command: "pwd" } }
    ], 19, 11, 2), apiBlockIndex: 1 },
    { ...common, type: "user", uuid: "generated-result", parentUuid: "generated-call", sourceToolAssistantUUID: "generated-call",
      timestamp: "2026-10-09T02:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "generated-tool", content: "/generated\n" }] } },
    assistant("generated-answer", "generated-result", "generated-answer-api", [
      { type: "thinking", thinking: "Final recorded thought" }, { type: "text", text: "Visible final answer" }
    ], 23, 13, 4)
  ]
}
const expectedIds = ["generated-root:0", "generated-plan:0", "generated-plan:1", "generated-call:0",
  "generated-call:1", "generated-result:0", "generated-answer:0", "generated-answer:1"]
const expectGenerated = (pages: AdapterCollectionPage[], rows: Row[]) => {
  const captured = events(pages), lines = rows.map(row => JSON.stringify(row) + "\n")
  expect(captured.map(event => event.sourceEventId)).toEqual(expectedIds)
  expect(captured.map(event => event.update.sessionUpdate)).toEqual(["user_message_chunk", "agent_thought_chunk", "agent_message_chunk",
    "agent_thought_chunk", "tool_call", "tool_call_update", "agent_thought_chunk", "agent_message_chunk"])
  expect(captured.every(event => event.projectionRevision === 5 && event.sourceThreadId === "root")).toBe(true)
  for (const event of captured) {
    const index = rows.findIndex(row => row.uuid === event.sourceEventId.split(":")[0])
    expect(event.revision).toBe(Buffer.byteLength(lines.slice(0, index + 1).join("")))
    expect(event.sourceOrder).toBe(index)
    expect(event.rawRef).toMatchObject({ _tag: "object", fragment: `record=${rows[index]!.uuid}&block=${event.sourceEventId.split(":")[1]}` })
    if (event.update.sessionUpdate === "agent_thought_chunk") expect(event.update.messageId).toBe(event.sourceEventId)
  }
  expect(captured.filter(event => event.update.sessionUpdate === "agent_thought_chunk").map(thoughtText))
    .toEqual(["First recorded thought 思考🧠", "Recorded thought before the tool", "Final recorded thought"])
  expect(JSON.stringify(captured)).not.toMatch(/opaque-signature|opaque-redacted|opaque-empty|unknown-body/)
  expect(latestUsage(pages)).toMatchObject([
    { sourceUsageId: "generated-plan-api", inputTokens: 24, outputTokens: 11, cacheReadTokens: 2, cacheWriteTokens: 3 },
    { sourceUsageId: "generated-answer-api", inputTokens: 28, outputTokens: 13, cacheReadTokens: 2, cacheWriteTokens: 3 }
  ])
}

it("projects generated mixed thinking/text/tools by physical slot and keeps latest split-response usage", async () => {
  const rows = generated(), source = encode(rows); await writeFile(file, source)
  const done = await drain(null, true, 500)
  expectGenerated(done.pages, rows)
  expect(rawSources(done.pages).get(`${sid}.jsonl`)?.text).toBe(source)
})

it("retries every one-Event page through fresh factories without repeating fragments or tool anchors", async () => {
  const rows = generated(), source = encode(rows); await writeFile(file, source)
  const done = await drain()
  expectGenerated(done.pages, rows)
  expect(done.pages.every(page => page.observations.every(observation => observation.events.length <= 1))).toBe(true)
  expect(rawSources(done.pages).get(`${sid}.jsonl`)?.text).toBe(source)
})

it.each([undefined, null, 7, {}, [], ""])("keeps generated thinking=%j and opaque/non-assistant content Raw-only", async value => {
  const rows = generated().slice(0, 2)
  rows[0]!.message.content = [{ type: "thinking", thinking: "A user block is not assistant reasoning" }, { type: "text", text: "User prompt" }]
  rows[1]!.message.content = [{ type: "thinking", thinking: value, signature: "opaque-signature" },
    { type: "redacted_thinking", data: "opaque-redacted" }, { type: "generated_unknown", data: "opaque-unknown" }, { type: "text", text: "Recorded answer" }]
  const source = encode(rows); await writeFile(file, source)
  const done = await drain()
  expect(events(done.pages).map(event => event.sourceEventId)).toEqual(["generated-root:1", "generated-plan:3"])
  expect(events(done.pages).some(event => event.update.sessionUpdate === "agent_thought_chunk")).toBe(false)
  expect(JSON.stringify(events(done.pages))).not.toMatch(/opaque-|assistant reasoning/)
  expect(rawSources(done.pages).get(`${sid}.jsonl`)?.text).toBe(source)
  expect(latestUsage(done.pages)).toHaveLength(1)
})

it.each([" \n\t ", "\u0085", "\uFEFF"])("keeps generated blank thinking=%j Raw-only while the Host accepts following text, tools and usage", async blank => {
  const rows = generated()
  rows[1]!.message.content = [{ type: "thinking", thinking: blank, signature: "opaque-blank-signature" },
    { type: "text", text: "Answer after blank thinking" }]
  const source = encode(rows); await writeFile(file, source)
  const done = await drain(), captured = events(done.pages)
  expect(captured.some(event => event.sourceEventId === "generated-plan:0")).toBe(false)
  expect(captured.find(event => event.sourceEventId === "generated-plan:1")?.update)
    .toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "Answer after blank thinking" } })
  expect(captured.filter(event => event.update.sessionUpdate === "agent_thought_chunk").map(thoughtText))
    .toEqual(["Recorded thought before the tool", "Final recorded thought"])
  expect(captured.map(event => event.update.sessionUpdate)).toContain("tool_call")
  expect(captured.map(event => event.update.sessionUpdate)).toContain("tool_call_update")
  expect(captured.at(-1)?.update).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "Visible final answer" } })
  expect(latestUsage(done.pages)).toHaveLength(2)
  expect(rawSources(done.pages).get(`${sid}.jsonl`)?.text).toBe(source)
  expect(done.pages.every(page => page.sourceFailures === undefined)).toBe(true)
})

it.each(["leading", "internal", "trailing"])("omits generated %s blank thought fragments without renumbering the meaningful physical parts", async position => {
  const size = 256 * 1024, head = "head".padEnd(size, "h"), middle = "middle".padEnd(size, "m"), blank = " ".repeat(size)
  const parts = position === "leading" ? [blank, middle, "tail"] : position === "internal" ? [head, blank, "tail"] : [head, middle, blank]
  const meaningful = position === "leading" ? [1, 2] : position === "internal" ? [0, 2] : [0, 1]
  const rows = generated().slice(0, 2)
  rows[1]!.message.content = [{ type: "text", text: "Before thought" },
    { type: "thinking", thinking: parts.join(""), signature: "opaque-large-blank-signature" }, { type: "text", text: "After thought" }]
  const source = encode(rows); await writeFile(file, source)
  const done = await drain(), captured = events(done.pages), thoughts = captured.filter(event => event.update.sessionUpdate === "agent_thought_chunk")
  expect(thoughts.map(event => event.sourceEventId)).toEqual(meaningful.map(part => `generated-plan:1:${part}`))
  expect(thoughts.map(event => event.eventIndex)).toEqual(meaningful.map(part => 128 + part))
  expect(thoughts.map(thoughtText)).toEqual(meaningful.map(part => parts[part]))
  expect(thoughts.every(event => event.fidelity === "partial" && "messageId" in event.update && event.update.messageId === "generated-plan:1")).toBe(true)
  expect(thoughts.every(event => event.revision === Buffer.byteLength(source) && event.projectionRevision === 5)).toBe(true)
  expect(captured.map(event => event.sourceEventId)).toEqual(["generated-root:0", "generated-plan:0",
    ...meaningful.map(part => `generated-plan:1:${part}`), "generated-plan:2"])
  expect(latestUsage(done.pages)).toHaveLength(1)
  expect(rawSources(done.pages).get(`${sid}.jsonl`)?.text).toBe(source)
})

it("preserves meaningful thought whitespace and passes the real Host redaction Interface", async () => {
  const secret = `sk-${"x".repeat(24)}`, body = ` \n\u0085\uFEFFRecorded ${secret} thought\n\t `, rows = generated().slice(0, 2)
  rows[1]!.message.content = [{ type: "thinking", thinking: body, signature: "opaque-host-signature" }, { type: "text", text: "Following answer" }]
  await writeFile(file, encode(rows))
  const done = await drain(), captured = events(done.pages), thought = captured.find(event => event.update.sessionUpdate === "agent_thought_chunk")!
  expect(thoughtText(thought)).toBe(body)
  expect(thought.fidelity).toBe("native")
  const observation = done.pages.flatMap(page => page.observations).find(value => value.events.some(event => event.sourceEventId === thought.sourceEventId))!
  const prepared = await prepare(observation), redacted = prepared.observation.events.find(event => event.sourceEventId === thought.sourceEventId)!
  expect(thoughtText(redacted)).toBe(body.replace(secret, "[REDACTED]"))
  expect(redacted.fidelity).toBe("redacted")
  expect(prepared.replacements).toBeGreaterThan(0)
  expect(JSON.stringify(prepared.observation)).not.toMatch(/opaque-host-signature|sk-x{24}/)
  expect(captured.at(-1)?.update).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "Following answer" } })
})

it("splits generated thinking at UTF-8 boundaries with one shared messageId", async () => {
  const rows = generated().slice(0, 2), body = "a".repeat(262143) + "界🙂" + "b".repeat(262144) + "尾"
  rows[1]!.message.content = [{ type: "text", text: "Before thought" }, { type: "thinking", thinking: body, signature: "opaque-large-signature" },
    { type: "text", text: "After thought" }]
  await writeFile(file, encode(rows))
  const done = await drain(), captured = events(done.pages), thoughts = captured.filter(event => event.update.sessionUpdate === "agent_thought_chunk")
  expect(thoughts.map(event => event.sourceEventId)).toEqual(["generated-plan:1:0", "generated-plan:1:1", "generated-plan:1:2"])
  expect(thoughts.map(event => event.eventIndex)).toEqual([128, 129, 130])
  expect(thoughts.every(event => "messageId" in event.update && event.update.messageId === "generated-plan:1")).toBe(true)
  expect(thoughts.every(event => Buffer.byteLength(thoughtText(event)) <= 256 * 1024 && !thoughtText(event).includes("�"))).toBe(true)
  expect(thoughts.map(thoughtText).join("")).toBe(body)
  expect(captured.map(event => event.sourceEventId)).toEqual(["generated-root:0", "generated-plan:0", ...thoughts.map(event => event.sourceEventId), "generated-plan:2"])
  expect(new Set(thoughts.map(event => event.revision))).toEqual(new Set([Buffer.byteLength(encode(rows))]))
  expect(latestUsage(done.pages)).toHaveLength(1)
})

it("defers partial thinking lines and resumes every generated LF cut with the same Events and Raw", async () => {
  const rows = generated(), pages: AdapterCollectionPage[] = []
  await writeFile(file, encode(rows.slice(0, 1)))
  const first = await drain(); pages.push(...first.pages); let cursor = first.cursor
  for (const row of rows.slice(1)) {
    const line = Buffer.from(JSON.stringify(row) + "\n"), middle = Math.floor(line.length / 2)
    await appendFile(file, line.subarray(0, middle))
    const partial = await drain(cursor); cursor = partial.cursor; pages.push(...partial.pages)
    expect(events(partial.pages)).toEqual([]); expect(usages(partial.pages)).toEqual([])
    expect(partial.pages.flatMap(page => page.observations.flatMap(o => o.rawSegments))).toEqual([])
    await appendFile(file, line.subarray(middle))
    const complete = await drain(cursor); cursor = complete.cursor; pages.push(...complete.pages)
  }
  expectGenerated(pages, rows)
  expect(rawSources(pages).get(`${sid}.jsonl`)?.text).toBe(encode(rows))
})

it("keeps thought Canonical with Raw off and later backfills bounded Raw without Events or usage", async () => {
  const rows = generated(); rows[1]!.message.content[1].text += "x".repeat(12_000)
  const source = encode(rows); await writeFile(file, source)
  const off = await drain(null, false)
  expectGenerated(off.pages, rows)
  expect(rawSources(off.pages).size).toBe(0)
  const on = await drain(off.cursor, true, 1, 4096)
  expect(events(on.pages)).toEqual([]); expect(usages(on.pages)).toEqual([])
  expect(rawSources(on.pages).get(`${sid}.jsonl`)?.text).toBe(source)
  expect(on.pages.flatMap(page => page.observations.flatMap(o => o.rawSegments)).every(segment => Buffer.byteLength(segment.content) <= 4096)).toBe(true)
})

it("does not duplicate generated thoughts or usage when automatic compaction replays their originals", async () => {
  const rows = generated(), originals = structuredClone(rows), before = encode(rows)
  const native: Row[] = (await readFile(new URL("../fixtures/native-auto-text-replay-rounds-2.1.263/thirdcontinue.jsonl", import.meta.url), "utf8"))
    .trimEnd().split("\n").map(line => JSON.parse(line))
  const boundary: Row = structuredClone(native.find(row => row.subtype === "compact_boundary")!)
  const summary: Row = structuredClone(native.find(row => row.isCompactSummary === true)!)
  const anchor = "generated-summary", retained = originals.map(row => row.uuid)
  for (const original of originals) rows.push({ ...original, slug: "generated-thinking-slug" })
  Object.assign(boundary, { uuid: "generated-boundary", parentUuid: null, logicalParentUuid: originals.at(-1)!.uuid,
    sessionId: sid, cwd: directory, isSidechain: false, slug: "generated-thinking-slug" })
  boundary.compactMetadata.trigger = "auto"
  boundary.compactMetadata.preservedSegment = { headUuid: retained[0], tailUuid: retained.at(-1), anchorUuid: anchor }
  boundary.compactMetadata.preservedMessages = { anchorUuid: anchor, uuids: retained, allUuids: [...retained] }
  Object.assign(summary, { uuid: anchor, parentUuid: boundary.uuid, sessionId: sid, cwd: directory, isSidechain: false, slug: "generated-thinking-slug" })
  rows.push(boundary, summary)
  rows.push({ ...structuredClone(originals.at(-1)!), uuid: "generated-after-compaction", parentUuid: anchor,
    timestamp: "2026-10-09T02:10:00Z", message: { role: "assistant", id: "generated-continuation-api", model: "generated-model",
      content: [{ type: "thinking", thinking: "The first real continuation can itself be a recorded thought." }],
      usage: { input_tokens: 31, output_tokens: 17, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  const source = encode(rows); await writeFile(file, source)
  const done = await drain(), captured = events(done.pages)
  expect(captured.map(event => event.sourceEventId)).toEqual([...expectedIds, "generated-after-compaction:0"])
  expect(new Set(captured.map(event => event.sourceEventId)).size).toBe(captured.length)
  expect(captured.at(-1)?.update).toMatchObject({ sessionUpdate: "agent_thought_chunk", content: { text: "The first real continuation can itself be a recorded thought." } })
  expect(latestUsage(done.pages)).toHaveLength(3)
  expect(latestUsage(done.pages).find(sample => sample.sourceUsageId === "generated-answer-api")?.revision).toBe(Buffer.byteLength(before))
  expect(rawSources(done.pages).get(`${sid}.jsonl`)?.text).toBe(source)
})

it.each([true, false])("captures recorded native root and child thinking through cold pages with Raw=%s", async raw => {
  const { proof, sources } = await loadNative()
  const done = await drain(null, raw), captured = events(done.pages), thoughts = captured.filter(event => event.update.sessionUpdate === "agent_thought_chunk")
  expect(captured).toHaveLength(12); expect(thoughts).toHaveLength(4)
  for (const recorded of proof.thoughts) {
    const thought = thoughts.find(event => event.sourceEventId === `${recorded.uuid}:${recorded.block}`)!
    expect(thought.update).toMatchObject({ sessionUpdate: "agent_thought_chunk", messageId: `${recorded.uuid}:${recorded.block}`,
      content: { type: "text", text: recorded.body } })
    expect(thought.sourceThreadId).toBe(recorded.source.includes("/subagents/") ? `claude-agent:${proof.agentId}` : "root")
    const lines = sources.get(recorded.source)!.match(/[^\n]*\n/g)!
    expect(thought.revision).toBe(Buffer.byteLength(lines.slice(0, recorded.recordLine).join("")))
    expect(JSON.stringify(captured)).not.toContain(recorded.signature)
  }
  expect(captured.filter(event => event.childSourceThreadId === `claude-agent:${proof.agentId}`)).toHaveLength(1)
  expect(new Set(captured.map(event => `${event.sourceThreadId}:${event.sourceEventId}`)).size).toBe(12)
  expect(latestUsage(done.pages)).toHaveLength(4)
  expect(latestUsage(done.pages).reduce((sum, sample) => sum + sample.inputTokens!, 0)).toBe(68)
  expect(latestUsage(done.pages).reduce((sum, sample) => sum + sample.outputTokens!, 0)).toBe(36)
  expect(done.pages.every(page => page.sourceFailures === undefined)).toBe(true)
  const backfilled = raw ? done : await drain(done.cursor, true, 1, 8192)
  if (!raw) { expect(events(backfilled.pages)).toEqual([]); expect(usages(backfilled.pages)).toEqual([]) }
  const archived = rawSources(backfilled.pages)
  for (const [name, source] of sources) expect(archived.get(name.split("/").at(-1)!)?.text).toBe(source)
})

it("keeps generated nested-unlinked diagnostics while capturing current thoughts and a following root thought", async () => {
  const { proof, child } = await loadNative(), childRows: Row[] = (await readFile(child, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line))
  const call = childRows.find(row => row.message?.content?.some?.((block: Row) => block.type === "tool_use"))!
  call.message.content[0].name = "Agent"
  const result = childRows.find(row => row.message?.content?.some?.((block: Row) => block.type === "tool_result"))!
  result.toolUseResult = { status: "async_launched", isAsync: true, agentId: "generated-grandchild" }
  await writeFile(child, encode(childRows))
  const done = await drain(), captured = events(done.pages)
  expect(captured).toHaveLength(12)
  expect(captured.filter(event => event.update.sessionUpdate === "agent_thought_chunk")).toHaveLength(4)
  expect(captured.filter(event => event.childSourceThreadId !== undefined)).toHaveLength(1)
  expect(done.pages.at(-1)?.sourceFailures).toEqual([{ source: child, reason: "unsupported" }])
  const rootRows: Row[] = (await readFile(file, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line))
  const last = rootRows.filter(row => row.uuid).at(-1)!, rootSize = Buffer.byteLength(encode(rootRows))
  const line = JSON.stringify({ ...last, uuid: "generated-next-root-thought", parentUuid: last.uuid,
    timestamp: "2026-10-09T04:00:00Z", message: { role: "assistant", id: "generated-next-root-api", model: "generated-model",
      content: [{ type: "thinking", thinking: "Current root thought remains capturable." }],
      usage: { input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + "\n"
  await appendFile(file, line)
  const input = request(done.cursor), page = await collect(input)
  expect(await collect(input)).toEqual(page)
  expect(events([page]).map(event => event.sourceEventId)).toEqual(["generated-next-root-thought:0"])
  expect(events([page])[0]?.update.sessionUpdate).toBe("agent_thought_chunk")
  expect(page.sourceFailures).toEqual([{ source: child, reason: "unsupported" }])
  expect(usages([page])).toMatchObject([{ sourceThreadId: "root", sourceUsageId: "generated-next-root-api", inputTokens: 17, outputTokens: 9 }])
  expect(page.observations.flatMap(observation => observation.rawSegments))
    .toMatchObject([{ sourceName: `${proof.sessionId}.jsonl`, sourceOffset: rootSize, content: line }])
})

// A deliberate version-marker downgrade exercises mixed-family routing. It
// supplements, and does not replace, genuine previous-factory upgrade inputs.
it.each(["root", "child"])("upgrades only a generated older %s checkpoint in a mixed projection family", async selected => {
  const { proof } = await loadNative(), original = await drain(), before = latestUsage(original.pages)
  const mixed = JSON.parse(original.cursor!), checkpoint = mixed.sessions[0].checkpoint
  if (selected === "root") checkpoint.projectionRevision = 4
  else checkpoint.children[0].checkpoint.projectionRevision = 4
  const firstInput = request(JSON.stringify(mixed)), first = await collect(firstInput)
  expect(await collect(firstInput)).toEqual(first)
  expect(first.hasMore).toBe(true)
  expect(first.progress?.pendingCanonicalSessions).toBeGreaterThan(0)
  acknowledge(first)
  const rest = await drain(first.nextCursor), pages = [first, ...rest.pages], captured = events(pages)
  const thread = selected === "root" ? "root" : `claude-agent:${proof.agentId}`
  expect(captured).toHaveLength(6)
  expect(captured.every(event => event.sourceThreadId === thread && event.projectionRevision === 5)).toBe(true)
  expect(captured.filter(event => event.update.sessionUpdate === "agent_thought_chunk")).toHaveLength(2)
  expect(captured).toEqual(events(original.pages).filter(event => event.sourceThreadId === thread))
  expect(latestUsage(pages)).toEqual(before.filter(sample => sample.sourceThreadId === thread))
  expect(rawSources(pages).size).toBe(0)
  expect(rest.pages.at(-1)?.progress).toMatchObject({ pendingCanonicalSessions: 0, pendingRawBytes: 0 })
})

const generatedChildPending = async () => {
  const { proof, child } = await loadNative(), childRows: Row[] = (await readFile(child, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line))
  const thought = childRows[1]!
  thought.message.content.push({ type: "text", text: "One generated old-visible child Event" })
  await writeFile(child, encode(childRows))
  const root = await collect(request(null, true, 500)); acknowledge(root)
  const childRoot = await collect(request(root.nextCursor)); acknowledge(childRoot)
  const pending = await collect(request(childRoot.nextCursor)); acknowledge(pending)
  expect(events([pending])[0]?.update.sessionUpdate).toBe("agent_thought_chunk")
  const mixed = JSON.parse(pending.nextCursor!), checkpoint = mixed.sessions[0].checkpoint.children[0].checkpoint
  checkpoint.projectionRevision = 4
  return { proof, child, childRows, mixed, checkpoint }
}
it("validates a generated old child skip against old-visible text before reprojecting all child thoughts", async () => {
  const { proof, mixed } = await generatedChildPending()
  const done = await drain(JSON.stringify(mixed)), captured = events(done.pages)
  expect(captured).toHaveLength(7)
  expect(captured.every(event => event.sourceThreadId === `claude-agent:${proof.agentId}`)).toBe(true)
  expect(captured.filter(event => event.update.sessionUpdate === "agent_thought_chunk")).toHaveLength(2)
  expect(captured.some(event => thoughtText(event) === "One generated old-visible child Event")).toBe(true)
  expect(latestUsage(done.pages)).toHaveLength(2)
})

it.each(["oversized skip", "zero old-visible Events", "EOF", "partial LF", "bookkeeping"])(
  "rejects a generated projection-4 child pending checkpoint with %s", async kind => {
    const { proof, child, childRows, mixed, checkpoint } = await generatedChildPending()
    if (kind === "oversized skip") checkpoint.stream.eventSkip = 2
    if (kind === "zero old-visible Events") childRows[1]!.message.content = childRows[1]!.message.content.slice(0, 1)
    const suffix = kind === "EOF" ? "" : kind === "partial LF" ? JSON.stringify(childRows[1])
      : kind === "bookkeeping" ? JSON.stringify({ type: "queue-operation", sessionId: proof.sessionId, operation: "enqueue",
        isSidechain: true, agentId: proof.agentId }) + "\n" : encode(childRows.slice(1))
    await writeFile(child, encode(childRows.slice(0, 1)) + suffix)
    const input = request(JSON.stringify(mixed))
    await expect(collect(input)).rejects.toMatchObject({ reason: "cursor" })
    await expect(collect(input)).rejects.toMatchObject({ reason: "cursor" })
  })

// Deliberate malformed projection-4 states below are generated robustness tests.
// Genuine prior-main factory checkpoints are validated by the separate upgrade
// producer; these mutations must never be described as genuine old evidence.
it.each(["oversized skip", "zero old-visible Events", "EOF", "partial LF", "blank LF", "bookkeeping", "timestamp"])(
  "rejects a generated old projection-4 pending checkpoint with %s before reprojecting", async kind => {
    const rows = generated().slice(0, 2)
    rows[1]!.message.content = [{ type: "thinking", thinking: "Newly visible thought precedes the old text." }, { type: "text", text: "Only old-visible Event" }]
    const prefix = encode(rows.slice(0, 1)); await writeFile(file, encode(rows))
    const root = await collect(request()), pending = await collect(request(root.nextCursor))
    expect(events([pending])[0]?.update.sessionUpdate).toBe("agent_thought_chunk")
    const malformed = JSON.parse(pending.nextCursor!)
    malformed.sessions[0].checkpoint.projectionRevision = 4
    if (kind === "oversized skip") malformed.sessions[0].checkpoint.stream.eventSkip = 2
    if (kind === "zero old-visible Events") rows[1]!.message.content = rows[1]!.message.content.slice(0, 1)
    if (kind === "timestamp") rows[1]!.timestamp = "2026-10-09T03:00:00Z"
    const suffix = kind === "EOF" ? "" : kind === "partial LF" ? JSON.stringify(rows[1]) : kind === "blank LF" ? "\n"
      : kind === "bookkeeping" ? JSON.stringify({ type: "queue-operation", sessionId: sid, operation: "enqueue" }) + "\n" : encode(rows.slice(1))
    await writeFile(file, prefix + suffix)
    const input = request(JSON.stringify(malformed))
    await expect(collect(input)).rejects.toMatchObject({ reason: "cursor" })
    await expect(collect(input)).rejects.toMatchObject({ reason: "cursor" })
  })

it.each(["boundary", "summary"])("rejects an omitted continuation in a generated projection-4 %s checkpoint", async stage => {
  const folder = new URL("../fixtures/native-auto-text-replay-rounds-2.1.263/", import.meta.url)
  const proof = JSON.parse(await readFile(new URL("provenance.json", folder), "utf8"))
  const source = (await readFile(new URL("thirdcontinue.jsonl", folder), "utf8")).replaceAll(proof.fixtureCwd, directory)
  await writeFile(file, source)
  let cursor: string | null = null, found = false
  for (let count = 0; count < 100; count++) {
    const page = await collect(request(cursor, true, 500))
    acknowledge(page); cursor = page.nextCursor
    const committed = page.observations.flatMap(observation => observation.rawSegments)
      .flatMap(segment => segment.content.trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line)))
    if (committed.some(row => stage === "boundary" ? row.subtype === "compact_boundary" : row.isCompactSummary === true)) {
      found = true; break
    }
    if (!page.observations.length && !page.hasMore) break
  }
  expect(found).toBe(true)
  // Explicit malformed-state mutation, not a previous-factory checkpoint.
  const malformed = JSON.parse(cursor!)
  malformed.sessions[0].checkpoint.projectionRevision = 4
  delete malformed.sessions[0].checkpoint.stream.continuation
  const input = request(JSON.stringify(malformed))
  await expect(collect(input)).rejects.toMatchObject({ reason: "cursor" })
  await expect(collect(input)).rejects.toMatchObject({ reason: "cursor" })
})
