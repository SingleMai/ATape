import { SourceCaptureHeaderV2, SourceCapturePage, SourceCaptureVersion2, AdapterCollectionLimits,
  type AdapterOpenContext, type SourceOpenRequestV2, type SourceCaptureFrame } from "@atape/domain"
import { Effect, Schema } from "effect"
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { makeSecretRedactorLayer, prepareCanonicalSlice } from "../../../packages/application/src/index.ts"
import { createAtapeAdapter } from "./index.ts"
import { historicalPublicFactory } from "./fixtures/historicalPublicFactory.ts"
let historical: Awaited<ReturnType<typeof historicalPublicFactory>>
beforeAll(async () => { historical = await historicalPublicFactory() }, 120000)
afterAll(async () => { await historical?.cleanup() })

type Row = Record<string, any>
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
const sid = "generated-capture-session", encode = (rows: Row[]) => rows.map(row => JSON.stringify(row) + "\n").join("")
const limits = { rowBytes: 16 * 1024 * 1024, pageBytes: 32 * 1024 * 1024, pageRows: 100, records: 10000, threads: 100, durationMs: 300000 }
const projection = { events: 100000, usage: 100000, pageItems: 1, pageBytes: 32 * 1024 * 1024 }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-capture-")); file = join(directory, "session.jsonl")
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const request = (extra: Partial<SourceOpenRequestV2> = {}): SourceOpenRequestV2 => ({ sourceId: sid, rawEnabled: true, limits, projection,
  priorThreads: [], signal: new AbortController().signal, ...extra })
const capture = async (input = request()) => {
  const runtime = await createAtapeAdapter(context), source = runtime.sourceCapture
  expect(source.protocolVersion).toBe(SourceCaptureVersion2)
  if (source.protocolVersion !== SourceCaptureVersion2) throw new Error("Expected v2")
  try {
    const view = await source.open(input), header = Schema.decodeUnknownSync(SourceCaptureHeaderV2)(view)
    const frames: SourceCaptureFrame[] = []
    try {
      for (let n = 0; n < 20000; n++) {
        const page = Schema.decodeUnknownSync(SourceCapturePage)(await view.read(input.signal))
        for (const frame of page.frames) {
          await Effect.runPromise(prepareCanonicalSlice("claude", { observationId: "capture", observedAt: header.session.updatedAt,
            session: { ...header.session, revision: 1 }, threads: header.threads.map(thread => ({ ...thread, revision: 1 })),
            events: frame.events.map(event => ({ ...event, revision: 1, projectionRevision: 1, rawRef: { _tag: "unavailable", reason: "test" } })),
            usage: frame.usage.map(sample => ({ ...sample, revision: 1 })), rawSegments: [] }).pipe(Effect.provide(makeSecretRedactorLayer())))
        }
        frames.push(...page.frames)
        if (page.done) {
          const events = frames.flatMap(frame => frame.events), usage = frames.flatMap(frame => frame.usage)
          expect(events.map(event => event.eventIndex)).toEqual(events.map((_, n) => n))
          expect(events.map(event => event.sourceOrder)).toEqual(events.map((_, n) => n))
          expect(events).toHaveLength(header.target.events); expect(usage).toHaveLength(header.target.usage)
          return { header, frames, events, usage }
        }
      }
      throw new Error("Source view exceeded bounded pages")
    } finally { await view.close() }
  } finally { await runtime.close() }
}
const rows = (): Row[] => {
  const common = { sessionId: sid, cwd: directory, isSidechain: false }
  const user = (uuid: string, parentUuid: string | null): Row => ({ ...common, type: "user", uuid, parentUuid,
    timestamp: "2026-10-09T08:00:00Z", message: { role: "user", content: uuid } })
  const answer = (uuid: string, parentUuid: string, api: string): Row => ({ ...common, type: "assistant", uuid, parentUuid,
    timestamp: "2026-10-09T08:00:01Z", message: { role: "assistant", id: api, model: "generated-model",
      content: [{ type: "thinking", thinking: `think ${uuid}`, signature: "opaque" }, { type: "text", text: uuid }],
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  return [user("root", null), answer("first", "root", "api-first"), user("discarded", "first"), answer("old", "discarded", "api-old"),
    user("current", "first"), answer("new", "current", "api-new")]
}
const rawText = (frames: SourceCaptureFrame[], thread = "root") => frames.flatMap(frame => {
  const raw = frame.raw as Row | undefined
  return raw?.format === "claude.jsonl.v1" && raw.sourceThreadId === thread ? [raw.jsonl as string] : []
}).join("")
const nativeFamily = async () => {
  const folder = new URL("../fixtures/native-thinking-2.1.263/", import.meta.url)
  const proof = JSON.parse(await readFile(new URL("provenance.json", folder), "utf8")) as Row
  const sources = new Map<string, string>()
  for (const entry of proof.files.filter((entry: Row) => entry.path.endsWith(".jsonl"))) {
    const source = (await readFile(new URL(entry.path, folder), "utf8")).replaceAll(proof.fixtureCwd, directory)
    const target = join(directory, entry.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, source); sources.set(entry.path, source)
  }
  file = join(directory, `${proof.sessionId}.jsonl`); vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  const childFile = join(directory, proof.sessionId, "subagents", `agent-${proof.agentId}.jsonl`)
  return { proof, sources, childFile, childId: `claude-agent:${proof.agentId}` }
}

it("selects a generated truncating-resume branch and retains all physical Raw", async () => {
  const source = encode(rows()); await writeFile(file, source)
  const actual = await capture()
  expect(actual.events.map(event => event.sourceEventId)).toEqual(["root:0", "first:0", "first:1", "current:0", "new:0", "new:1"])
  expect(actual.usage.map(sample => sample.sourceUsageId)).toEqual(["api-first", "api-new"])
  expect(rawText(actual.frames)).toBe(source)
  expect(await capture()).toEqual(actual)
  const appended = rows().slice(4).map(row => ({ ...row, uuid: `${row.uuid}-after`, parentUuid: row.type === "user" ? "new" : "current-after",
    ...(row.type === "assistant" ? { message: { ...row.message, id: "api-after" } } : {}) }))
  await appendFile(file, encode(appended))
  expect((await capture(request({ priorCheckpoint: actual.header.sourceCheckpoint, priorThreads: actual.header.threads }))).usage.map(sample => sample.sourceUsageId))
    .toEqual(["api-first", "api-new", "api-after"])
})
it("honors explicit rewind-only, descendants after the marker, and empty rewind", async () => {
  const initial = rows().slice(0, 4), marker = { type: "last-prompt", sessionId: sid, leafUuid: "first", explicit: true, rewound: true }
  await writeFile(file, encode([...initial, marker]))
  expect((await capture()).events.map(event => event.sourceEventId)).toEqual(["root:0", "first:0", "first:1"])
  await appendFile(file, encode(rows().slice(4)))
  expect((await capture()).events.at(-1)?.sourceEventId).toBe("new:1")
  await appendFile(file, encode([{ ...marker, leafUuid: null }]))
  const empty = await capture(); expect(empty.events).toEqual([]); expect(empty.usage).toEqual([])
  expect(empty.header.origin.originKey).toBe("root")
  const fresh = rows().slice(0, 2).map(row => ({ ...row, uuid: `${row.uuid}-fresh`, parentUuid: row.type === "user" ? null : "root-fresh" }))
  await appendFile(file, encode(fresh))
  expect((await capture()).events.map(event => event.sourceEventId)).toEqual(["root-fresh:0", "first-fresh:0", "first-fresh:1"])
})
it("rejects changed committed prefixes, unknown selectors and unproved second roots", async () => {
  const original = rows().slice(0, 2); await writeFile(file, encode(original)); const captured = await capture()
  original[1]!.message.content[1].text = "edited"; await writeFile(file, encode(original))
  await expect(capture(request({ priorCheckpoint: captured.header.sourceCheckpoint }))).rejects.toThrow("prefix")
  await writeFile(file, encode([...rows().slice(0, 2), { type: "last-prompt", sessionId: sid, leafUuid: "missing", explicit: true }]))
  await expect(capture()).rejects.toThrow("unknown")
  await writeFile(file, encode([...rows().slice(0, 2), { ...rows()[0], uuid: "second-root" }]))
  await expect(capture()).rejects.toThrow("anchor")
})
it("ignores incomplete physical tails, remains Raw-off, and keeps latest API usage once", async () => {
  const original = rows().slice(0, 2), split = { ...original[1], uuid: "split", parentUuid: "first", message: { ...original[1]!.message,
    content: [{ type: "text", text: "split answer" }], usage: { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  await writeFile(file, encode([...original, split]) + '{"type":"user"')
  const actual = await capture(request({ rawEnabled: false })); expect(actual.frames.every(frame => frame.raw === undefined)).toBe(true)
  expect(actual.usage).toMatchObject([{ sourceUsageId: "api-first", inputTokens: 11, outputTokens: 5 }])
})
it("decodes and authenticates the acknowledged legacy cursor before publishing a rewind", async () => {
  await writeFile(file, encode(rows().slice(0, 4)))
  const runtime = await historical.createAtapeAdapter(context), page = await runtime.collect({ protocolVersion: "atape.adapter.v1alpha1", cursor: null,
    rawCaptureEnabled: false, rawProgress: [], limits: AdapterCollectionLimits, signal: context.signal }) as any
  await appendFile(file, encode(rows().slice(4)))
  const current = await createAtapeAdapter(context), source = current.sourceCapture
  if (source.protocolVersion !== SourceCaptureVersion2) throw new Error("Expected v2")
  expect(await source.legacyMigration!({ checkpointCursor: page.nextCursor, cursor: null, limits, signal: context.signal }))
    .toMatchObject({ sources: [{ sourceId: sid, originKey: "root", cwd: directory }], done: true })
  await current.close()
  expect((await capture(request({ legacyCheckpoint: page.nextCursor }))).usage.map(sample => sample.sourceUsageId)).toEqual(["api-first", "api-new"])
})
it("keeps generic compaction on the selected branch and rejects sibling replay", async () => {
  const common = { sessionId: sid, cwd: directory, isSidechain: false, version: "generated" }
  const ids = ["root", "first", "current", "new"]
  const boundary = { ...common, uuid: "boundary", type: "system", subtype: "compact_boundary", parentUuid: null, logicalParentUuid: "new",
    compactMetadata: { trigger: "manual", preservedSegment: { headUuid: "root", tailUuid: "new", anchorUuid: "summary" },
      preservedMessages: { uuids: ids, allUuids: ids, anchorUuid: "summary" } } }
  const summary = { ...common, type: "user", uuid: "summary", parentUuid: "boundary", isCompactSummary: true, isVisibleInTranscriptOnly: true,
    promptId: "compact-prompt", message: { role: "user", content: "Generated summary" } }
  const after = rows().slice(4).map(row => ({ ...row, uuid: `${row.uuid}-compact`, parentUuid: row.type === "user" ? "summary" : "current-compact" }))
  await writeFile(file, encode([...rows(), boundary, summary, ...after]))
  const actual = await capture()
  expect(actual.events.map(event => event.sourceEventId)).toEqual(["root:0", "first:0", "first:1", "current:0", "new:0", "new:1",
    "current-compact:0", "new-compact:0", "new-compact:1"])
  await writeFile(file, encode([...rows(), rows()[3]!]))
  await expect(capture()).rejects.toThrow("sibling")
})
it("captures a native foreground family, retains a missing child and removes it when its receipt leaves the path", async () => {
  const { proof, sources, childFile, childId } = await nativeFamily()
  const actual = await capture(request({ sourceId: proof.sessionId }))
  expect(actual.header.threads).toHaveLength(2); expect(actual.header.target.retainedThreadIds).toEqual([])
  expect(actual.events.filter(event => event.sourceThreadId === childId).length).toBeGreaterThan(0)
  expect(rawText(actual.frames)).toBe(sources.get(`${proof.sessionId}.jsonl`))
  expect(rawText(actual.frames, childId)).toBe(sources.get(`${proof.sessionId}/subagents/agent-${proof.agentId}.jsonl`))
  await rm(childFile)
  const retained = await capture(request({ sourceId: proof.sessionId, priorThreads: actual.header.threads, priorCheckpoint: actual.header.sourceCheckpoint }))
  expect(retained.header.target.retainedThreadIds).toEqual([childId]); expect(retained.events.every(event => event.sourceThreadId === "root")).toBe(true)
  const root = JSON.parse(sources.get(`${proof.sessionId}.jsonl`)!.split("\n").find(line => JSON.parse(line).uuid)!) as Row
  await appendFile(file, encode([{ type: "last-prompt", sessionId: proof.sessionId, leafUuid: root.uuid, explicit: true, rewound: true }]))
  const removed = await capture(request({ sourceId: proof.sessionId, priorThreads: retained.header.threads, priorCheckpoint: retained.header.sourceCheckpoint }))
  expect(removed.header.threads).toHaveLength(1); expect(removed.header.target.retainedThreadIds).toEqual([])
})
it.each(["missing", "wrong-origin", "malformed"])("does not declare a never-captured %s child", async failure => {
  const { proof, childFile, childId } = await nativeFamily()
  if (failure === "missing") await rm(childFile)
  else if (failure === "malformed") await writeFile(childFile, '{"invalid"\n')
  else await writeFile(childFile, (await readFile(childFile, "utf8")).replaceAll(directory, `${directory}/wrong`))
  const actual = await capture(request({ sourceId: proof.sessionId }))
  expect(actual.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root"])
  expect(actual.header.target.retainedThreadIds).toEqual([])
  expect(actual.events.every(event => event.childSourceThreadId === undefined)).toBe(true)
  expect(actual.frames.every(frame => (frame.raw as Row)?.sourceThreadId !== childId)).toBe(true)
  expect(actual.header.sourceFailures).toEqual([{ source: childFile, reason: failure === "missing" ? "io" : failure === "malformed" ? "format" : "unsupported" }])
})
it("isolates a changed captured child and retains its authenticated proof", async () => {
  const { proof, childFile, childId } = await nativeFamily(), original = await capture(request({ sourceId: proof.sessionId }))
  const source = await readFile(childFile, "utf8")
  await writeFile(childFile, source.replace("thinking", "thinkinG"))
  const actual = await capture(request({ sourceId: proof.sessionId, priorThreads: original.header.threads, priorCheckpoint: original.header.sourceCheckpoint }))
  expect(actual.header.target.retainedThreadIds).toEqual([childId])
  expect(actual.events.every(event => event.sourceThreadId === "root")).toBe(true)
  expect(actual.events.some(event => event.childSourceThreadId === childId)).toBe(true)
  expect(actual.header.sourceFailures).toEqual([{ source: childFile, reason: "changed" }])
  expect(JSON.parse(actual.header.sourceCheckpoint).streams.find((stream: Row) => stream.threadId === childId))
    .toEqual(JSON.parse(original.header.sourceCheckpoint).streams.find((stream: Row) => stream.threadId === childId))
})
it.each([false, true])("backfills physical abandoned child Raw after Raw-off capture (previous child %s)", async capturedBeforeRewind => {
  const { proof, sources, childId } = await nativeFamily()
  let prior = capturedBeforeRewind ? await capture(request({ sourceId: proof.sessionId, rawEnabled: false })) : undefined
  const root = sources.get(`${proof.sessionId}.jsonl`)!.trimEnd().split("\n").map(line => JSON.parse(line) as Row).find(row => row.uuid)!
  await appendFile(file, encode([{ type: "last-prompt", sessionId: proof.sessionId, leafUuid: root.uuid, explicit: true, rewound: true }]))
  prior = await capture(request({ sourceId: proof.sessionId, rawEnabled: false,
    ...(prior === undefined ? {} : { priorThreads: prior.header.threads, priorCheckpoint: prior.header.sourceCheckpoint }) }))
  expect(prior.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root"])
  const actual = await capture(request({ sourceId: proof.sessionId, priorThreads: prior.header.threads, priorCheckpoint: prior.header.sourceCheckpoint }))
  expect(actual.header.threads).toEqual(prior.header.threads); expect(actual.events).toEqual(prior.events); expect(actual.usage).toEqual(prior.usage)
  expect(actual.header.session).toEqual(prior.header.session)
  expect(rawText(actual.frames, childId)).toBe(sources.get(`${proof.sessionId}/subagents/agent-${proof.agentId}.jsonl`))
  expect(actual.header.sourceFailures).toEqual([])
})
it.each(["missing", "malformed"])("isolates %s historical child Raw without current membership", async failure => {
  const { proof, sources, childFile, childId } = await nativeFamily()
  const initial = await capture(request({ sourceId: proof.sessionId, rawEnabled: false }))
  const root = sources.get(`${proof.sessionId}.jsonl`)!.trimEnd().split("\n").map(line => JSON.parse(line) as Row).find(row => row.uuid)!
  await appendFile(file, encode([{ type: "last-prompt", sessionId: proof.sessionId, leafUuid: root.uuid, explicit: true, rewound: true }]))
  if (failure === "missing") await rm(childFile); else await writeFile(childFile, '{"invalid"\n')
  const actual = await capture(request({ sourceId: proof.sessionId, priorThreads: initial.header.threads, priorCheckpoint: initial.header.sourceCheckpoint }))
  expect(actual.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root"])
  expect(actual.header.target.retainedThreadIds).toEqual([])
  expect(actual.events).toHaveLength(1); expect(actual.events[0]?.childSourceThreadId).toBeUndefined()
  expect(rawText(actual.frames, childId)).toBe("")
  expect(actual.header.sourceFailures).toEqual([{ source: childFile, reason: failure === "missing" ? "io" : "format" }])
  expect(JSON.parse(actual.header.sourceCheckpoint).streams.find((stream: Row) => stream.threadId === childId))
    .toEqual(JSON.parse(initial.header.sourceCheckpoint).streams.find((stream: Row) => stream.threadId === childId))
})
it("uses one total order for discovery and legacy migration pagination", async () => {
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", ""); vi.stubEnv("ATAPE_CLAUDE_HOME", directory)
  const folder = join(directory, "projects", "project"); await mkdir(folder, { recursive: true })
  const ids = ["a-session", "Z-session", "A-session", "z-session"], expected = [...ids].sort()
  for (const [index, id] of ids.entries()) await writeFile(join(folder, `source-${index}.jsonl`), encode([{ ...rows()[0], sessionId: id, uuid: `${id}-root` }]))
  const runtime = await createAtapeAdapter(context), source = runtime.sourceCapture
  if (source.protocolVersion !== SourceCaptureVersion2) throw new Error("Expected v2")
  const pagedLimits = { ...limits, pageRows: 1 }, found: string[] = []
  let cursor: string | null = null
  for (let n = 0; n < ids.length; n++) {
    const page = await source.discover({ cursor, limits: pagedLimits, signal: context.signal }) as any
    expect(page.sources.map((source: Row) => source.sourceId)).toEqual([expected[n]])
    found.push(...page.sources.map((source: Row) => source.sourceId)); cursor = page.cursor
    expect(page.done).toBe(n === ids.length - 1)
  }
  expect(found).toEqual(expected)
  const legacy = await historical.createAtapeAdapter(context)
  let checkpointCursor: string | null = null
  for (let n = 0; n < ids.length; n++) {
    const page = await legacy.collect({ protocolVersion: "atape.adapter.v1alpha1", cursor: checkpointCursor,
      rawCaptureEnabled: false, rawProgress: [], limits: AdapterCollectionLimits, signal: context.signal }) as any
    checkpointCursor = page.nextCursor
  }
  const migrated: string[] = []; cursor = null
  for (let n = 0; n < ids.length; n++) {
    const result = await source.legacyMigration!({ checkpointCursor: checkpointCursor!, cursor, limits: pagedLimits, signal: context.signal }) as any
    migrated.push(...result.sources.map((source: Row) => source.sourceId)); cursor = result.cursor
    expect(result.done).toBe(n === ids.length - 1)
  }
  expect(migrated).toEqual(expected); await runtime.close(); await legacy.close?.()
})
it("keeps current Thread after unproved delegation and rebuilds its bounded diagnostic", async () => {
  const original = rows().slice(0, 2)
  original[1]!.message.content = [{ type: "tool_use", id: "call", name: "Agent", input: { prompt: "generated task" } }]
  const receipt = { ...original[0], uuid: "receipt", parentUuid: "first", sourceToolAssistantUUID: "first",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "pending" }] }, toolUseResult: { status: "running", agentId: "unproved" } }
  const answer = { ...rows()[5], parentUuid: "receipt" }
  await writeFile(file, encode([...original, receipt, answer]))
  const actual = await capture(); expect(actual.events.at(-1)?.sourceEventId).toBe("new:1")
  expect(actual.header.sourceFailures).toEqual([{ source: file, reason: "unsupported" }]); expect(actual.header.threads).toHaveLength(1)
  expect((await capture(request({ priorThreads: actual.header.threads, priorCheckpoint: actual.header.sourceCheckpoint }))).header.sourceFailures)
    .toEqual(actual.header.sourceFailures)
})
it("passes complete Raw records to the Host and splits only Canonical frame membership", async () => {
  const original = rows().slice(0, 2)
  original[1]!.message.content = Array.from({ length: 501 }, (_, index) => ({ type: "text", text: `block ${index}` }))
  const source = encode(original); await writeFile(file, source)
  const actual = await capture()
  expect(actual.events).toHaveLength(502); expect(actual.frames.every(frame => frame.events.length <= 500)).toBe(true)
  expect(rawText(actual.frames)).toBe(source)
  const references = actual.frames.filter(frame => (frame.raw as Row)?.format === "claude.record-reference.v1")
  expect(references).toHaveLength(1); expect(JSON.stringify(references[0]!.raw)).not.toContain("block 500")
})

it.each([
  ["resume-01-first-0.jsonl", [1]], ["resume-02-discarded-0.jsonl", [1, 2]],
  ["resume-03-rewound-0.jsonl", [1, 3]], ["resume-04-continued-0.jsonl", [1, 3, 4]],
  ["control-01-first.jsonl", [1]], ["control-02-discarded.jsonl", [1, 2]],
  ["control-03-rewind-only.jsonl", [1]], ["control-04-current.jsonl", [1, 3]], ["control-05-empty-rewind.jsonl", []]
] as const)("selects recorded native stage %s through the public factory", async (name, included) => {
  const folder = new URL("../fixtures/native-rewind-2.1.263/", import.meta.url)
  const proof = JSON.parse(await readFile(new URL("provenance.json", folder), "utf8")) as Row
  const source = (await readFile(new URL(name, folder), "utf8")).replaceAll(proof.fixtureCwd, directory)
  const native = source.trimEnd().split("\n").map(line => JSON.parse(line) as Row), root = native.find(row => row.uuid)!
  const users = native.filter(row => row.type === "user"), expected: string[] = []
  for (const turn of included) {
    expected.push(`${users[turn - 1]!.uuid}:0`)
    for (const row of native.filter(row => row.type === "assistant" && row.message.id === `msg_atape_thinking_mock_${turn}`)) expected.push(`${row.uuid}:0`)
  }
  await writeFile(file, source)
  const actual = await capture(request({ sourceId: root.sessionId }))
  expect(actual.events.map(event => event.sourceEventId)).toEqual(expected)
  expect(actual.usage.map(sample => sample.sourceUsageId)).toEqual(included.map(turn => `msg_atape_thinking_mock_${turn}`))
  expect(actual.events.filter(event => event.update.sessionUpdate === "agent_thought_chunk")).toHaveLength(included.length)
  expect(rawText(actual.frames)).toBe(source); expect(actual.header.sourceFailures).toEqual([])
})
it.each(["resume", "control"])("authenticates every recorded %s stage with the previous v2 checkpoint", async mode => {
  const folder = new URL("../fixtures/native-rewind-2.1.263/", import.meta.url)
  const proof = JSON.parse(await readFile(new URL("provenance.json", folder), "utf8")) as Row
  let priorCheckpoint: string | undefined
  for (const snapshot of proof.snapshots.filter((snapshot: Row) => snapshot.mode === mode)) {
    const source = (await readFile(new URL(snapshot.file, folder), "utf8")).replaceAll(proof.fixtureCwd, directory)
    const root = source.trimEnd().split("\n").map(line => JSON.parse(line) as Row).find(row => row.uuid)!
    await writeFile(file, source)
    const actual = await capture(request({ sourceId: root.sessionId, ...(priorCheckpoint === undefined ? {} : { priorCheckpoint }) }))
    expect(rawText(actual.frames)).toBe(source); priorCheckpoint = actual.header.sourceCheckpoint
  }
})

// Run retained native source bytes through the shipped factory, independently
// of the historical collect regressions. CWD-only aliases preserve source facts.
const nativeFiles = async (directory: URL): Promise<URL[]> => {
  const result: URL[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory)
    if (entry.isDirectory()) result.push(...await nativeFiles(url))
    else if (entry.name.endsWith(".jsonl")) result.push(url)
  }
  return result
}
it("captures all retained native root snapshots through sourceCapture v2", async () => {
  for (const fixture of await nativeFiles(new URL("../fixtures/", import.meta.url))) {
    const source = await readFile(fixture, "utf8"), parsed = source.trimEnd().split("\n").map(line => JSON.parse(line) as Row)
    const root = parsed.find(row => row.uuid)
    if (!root || root.isSidechain === true) continue
    const mapped = source.replaceAll(root.cwd, directory)
    await writeFile(file, mapped)
    const children = new Map<string, string>(), childDirectory = new URL(`${root.sessionId}/subagents/`, fixture)
    for (const entry of await readdir(childDirectory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const child = (await readFile(new URL(entry.name, childDirectory), "utf8")).replaceAll(root.cwd, directory)
      const target = join(directory, root.sessionId, "subagents", entry.name)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, child)
      children.set(`claude-agent:${entry.name.slice("agent-".length, -".jsonl".length)}`, child)
    }
    const actual = await capture(request({ sourceId: root.sessionId }))
    expect(actual.header.origin.originKey, fixture.pathname).toBe(root.uuid)
    expect(rawText(actual.frames), fixture.pathname).toBe(mapped)
    for (const [thread, child] of children) expect(rawText(actual.frames, thread), fixture.pathname).toBe(child)
    expect(new Set(actual.events.map(event => event.sourceThreadId + event.sourceEventId)).size).toBe(actual.events.length)
  }
})

it("preserves meaningful thoughts, physical block IDs and bounded tool JSON while leaving opaque blocks Raw-only", async () => {
  const original = rows().slice(0, 2)
  original[1]!.message.content = [
    { type: "thinking", thinking: "  first thought\n", signature: "secret-signature" }, { type: "text", text: "visible text" },
    { type: "thinking", thinking: "second thought", signature: "another-signature" },
    { type: "tool_use", id: "json-tool", name: "Read", input: { nested: [null, false, { file_path: "/generated" }] } },
    { type: "text", text: "after tool" }, { type: "unknown_provider", text: "do not fabricate" },
    { type: "redacted_thinking", data: "opaque-redacted" }, { type: "thinking", thinking: 123 }, { type: "thinking", thinking: "" }
  ]
  const result = { ...original[0], uuid: "receipt-json", parentUuid: "first", sourceToolAssistantUUID: "first",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "json-tool", content: { nested: [1, "output", null] } }] } }
  const text = encode([...original, result]); await writeFile(file, text)
  const actual = await capture()
  expect(actual.events.map(event => event.sourceEventId)).toEqual(["root:0", "first:0", "first:1", "first:2", "first:3", "first:4", "receipt-json:0"])
  expect(actual.events[1]?.update).toMatchObject({ sessionUpdate: "agent_thought_chunk", messageId: "first:0", content: { text: "  first thought\n" } })
  expect(actual.events[4]?.update).toMatchObject({ rawInput: { nested: [null, false, { file_path: "/generated" }] } })
  expect(actual.events.at(-1)?.update).toMatchObject({ rawOutput: { nested: [1, "output", null] } })
  expect(JSON.stringify(actual.events)).not.toMatch(/secret-signature|another-signature|opaque-redacted|do not fabricate/)
  expect(actual.usage).toHaveLength(1); expect(rawText(actual.frames)).toBe(text)
})
it.each([" \n\t ", "\u0085", "\ufeff", "\u00a0"])("keeps blank thought %j Raw-only through real Host preparation", async blank => {
  const original = rows().slice(0, 2); original[1]!.message.content = [{ type: "thinking", thinking: blank }, { type: "text", text: "still visible" }]
  const text = encode(original); await writeFile(file, text)
  const actual = await capture()
  expect(actual.events.map(event => event.sourceEventId)).toEqual(["root:0", "first:1"])
  expect(actual.usage).toHaveLength(1); expect(rawText(actual.frames)).toBe(text)
})
it.each(["multibyte", "internal-blank", "leading-blank", "trailing-blank"])("fragments %s thought without trimming or renumbering surviving parts", async shape => {
  const size = 256 * 1024
  const body = shape === "multibyte" ? "界".repeat(Math.ceil(size / 3) + 100) : shape === "internal-blank" ? "a".repeat(size) + " ".repeat(size) + "b".repeat(size) :
    shape === "leading-blank" ? " ".repeat(size) + "body " : "body" + " ".repeat(size * 2)
  const original = rows().slice(0, 2); original[1]!.message.content = [{ type: "thinking", thinking: body, signature: "opaque" }, { type: "text", text: "after thought" }]
  await writeFile(file, encode(original)); const actual = await capture(), thoughts = actual.events.filter(event => event.update.sessionUpdate === "agent_thought_chunk")
  const text = thoughts.map(event => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join("")
  for (const event of thoughts) {
    expect(event.update).toMatchObject({ messageId: "first:0" })
    if ("content" in event.update && event.update.content.type === "text") expect(Buffer.byteLength(event.update.content.text)).toBeLessThanOrEqual(size)
  }
  if (shape === "multibyte") expect(text).toBe(body)
  else {
    expect(thoughts.every(event => event.fidelity === "partial")).toBe(true)
    expect(thoughts.map(event => event.sourceEventId)).toEqual(shape === "internal-blank" ? ["first:0:0", "first:0:2"] : shape === "leading-blank" ? ["first:0:1"] : ["first:0:0"])
    expect(text.trim()).toBe(shape === "internal-blank" ? "a".repeat(size) + "b".repeat(size) : "body")
  }
  expect(actual.events.at(-1)?.sourceEventId).toBe("first:1")
})

const delegationSource = async () => {
  const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd"
  const folder = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
  const source = (await readFile(new URL(`${sessionId}.jsonl`, folder), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const values = source.trimEnd().split("\n").map(line => JSON.parse(line) as Row)
  const childFile = join(directory, sessionId, "subagents", `agent-${agentId}.jsonl`)
  await mkdir(dirname(childFile), { recursive: true }); await writeFile(childFile, "invalid-unadmitted-child\n")
  const receipt = values.find(row => row.toolUseResult?.agentId)!, invocation = values.find(row => row.type === "assistant" && row.message.content.some((block: Row) => block.type === "tool_use"))!
  return { sessionId, agentId, values, receipt, invocation, childFile }
}
const unlinkedMutations: Array<[string, (fixture: Awaited<ReturnType<typeof delegationSource>>) => void]> = [
  ["async launch", f => Object.assign(f.receipt.toolUseResult, { status: "async_launched", isAsync: true })],
  ["async completion", f => Object.assign(f.receipt.toolUseResult, { isAsync: true })],
  ["failed status", f => Object.assign(f.receipt.toolUseResult, { status: "failed" })],
  ["missing status", f => { delete f.receipt.toolUseResult.status }],
  ["tool error", f => { f.receipt.message.content[0].is_error = true }],
  ["missing assistant proof", f => { delete f.receipt.sourceToolAssistantUUID }],
  ["missing metadata", f => { delete f.receipt.toolUseResult }], ["null metadata", f => { f.receipt.toolUseResult = null }],
  ["missing agentId", f => { delete f.receipt.toolUseResult.agentId }], ["empty agentId", f => { f.receipt.toolUseResult.agentId = "" }],
  ["unsafe agentId", f => { f.receipt.toolUseResult.agentId = "../outside" }], ["large agentId", f => { f.receipt.toolUseResult.agentId = "a".repeat(129) }],
  ["nonstring agentId", f => { f.receipt.toolUseResult.agentId = 123 }],
  ["Task without proof", f => { f.invocation.message.content[0].name = "Task"; delete f.receipt.sourceToolAssistantUUID }],
  ["two Agent results", f => { f.invocation.message.content.push({ type: "tool_use", id: "second", name: "Agent", input: {} }); f.receipt.message.content.push({ type: "tool_result", tool_use_id: "second", content: "Second returned" }) }],
  ["ordinary and Agent results", f => { f.invocation.message.content.push({ type: "tool_use", id: "second", name: "Bash", input: {} }); f.receipt.message.content.push({ type: "tool_result", tool_use_id: "second", content: "Second returned" }) }],
  ["result plus visible user text", f => { f.receipt.message.content.push({ type: "text", text: "Additional user text" }) }]
]
it.each(unlinkedMutations)("preserves current content, usage and Raw for generated unlinked %s", async (_label, mutate) => {
  const f = await delegationSource(); mutate(f)
  const previous = f.values.filter(row => row.uuid).at(-1)!
  f.values.push({ ...previous, uuid: "following", parentUuid: previous.uuid, message: { role: "assistant", id: "following-api", model: "generated-model",
    content: [{ type: "text", text: "Current root continues" }], usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } })
  const text = encode(f.values); await writeFile(file, text)
  const actual = await capture(request({ sourceId: f.sessionId }))
  expect(actual.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root"])
  expect(actual.events.every(event => event.childSourceThreadId === undefined)).toBe(true)
  expect(actual.events.at(-1)?.update).toMatchObject({ content: { text: "Current root continues" } })
  expect(actual.usage.at(-1)).toMatchObject({ sourceUsageId: "following-api", inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 })
  expect(actual.header.sourceFailures).toEqual([{ source: file, reason: "unsupported" }])
  expect(rawText(actual.frames)).toBe(text); expect(actual.frames.every(frame => (frame.raw as Row)?.sourceThreadId === "root")).toBe(true)
  expect((await capture(request({ sourceId: f.sessionId, priorThreads: actual.header.threads, priorCheckpoint: actual.header.sourceCheckpoint }))).header.sourceFailures).toEqual(actual.header.sourceFailures)
})
it.each(["wrong correlation", "foreign session", "foreign thread", "closed call"])("keeps %s a hard failure despite async metadata", async kind => {
  const f = await delegationSource(); Object.assign(f.receipt.toolUseResult, { status: "async_launched", isAsync: true })
  if (kind === "wrong correlation") f.receipt.sourceToolAssistantUUID = "different-assistant"
  if (kind === "foreign session") f.receipt.sessionId = "foreign-session"
  if (kind === "foreign thread") f.receipt.isSidechain = true
  if (kind === "closed call") f.values.push({ ...f.receipt, uuid: "closed-again", parentUuid: f.values.filter(row => row.uuid).at(-1)!.uuid })
  await writeFile(file, encode(f.values)); await expect(capture(request({ sourceId: f.sessionId }))).rejects.toMatchObject({ reason: "unsupported" })
})
it("does not diagnose pending Agent invocations or infer relationships from ordinary tool metadata", async () => {
  const f = await delegationSource()
  await writeFile(file, encode(f.values.slice(0, f.values.indexOf(f.invocation) + 1)))
  expect((await capture(request({ sourceId: f.sessionId }))).header.sourceFailures).toEqual([])
  f.invocation.message.content[0].name = "Bash"; await writeFile(file, encode(f.values))
  const actual = await capture(request({ sourceId: f.sessionId }))
  expect(actual.header.sourceFailures).toEqual([]); expect(actual.header.threads).toHaveLength(1)
})

it.each([false, true])("rejects reuse of an already pinned Agent even inside ambiguous async results=%s", async ambiguous => {
  const f = await delegationSource(), previous = f.values.filter(row => row.uuid).at(-1)!
  const calls = [{ type: "tool_use", id: "new-agent-a", name: "Agent", input: {} }]
  if (ambiguous) calls.push({ type: "tool_use", id: "new-agent-b", name: "Task", input: {} })
  f.values.push({ ...f.invocation, uuid: "new-call", parentUuid: previous.uuid, message: { ...f.invocation.message, id: "new-api", content: calls } })
  f.values.push({ ...f.receipt, uuid: "new-result", parentUuid: "new-call", sourceToolAssistantUUID: "new-call",
    toolUseResult: { status: "async_launched", isAsync: true, agentId: f.agentId },
    message: { role: "user", content: calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: "returned" })) } })
  await writeFile(file, encode(f.values)); await expect(capture(request({ sourceId: f.sessionId }))).rejects.toMatchObject({ reason: "unsupported" })
})
it("captures nested unlinked delegation in its existing child and keeps its diagnostic on later root replies", async () => {
  const f = await delegationSource(), folder = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
  const child = (await readFile(new URL(`${f.sessionId}/subagents/agent-${f.agentId}.jsonl`, folder), "utf8"))
    .replaceAll("/fixture/native-foreground-child", directory).trimEnd().split("\n").map(line => JSON.parse(line) as Row)
  const call = child.find(row => row.type === "assistant" && row.message.content.some((block: Row) => block.type === "tool_use"))!
  call.message.content[0].name = "Agent"
  const result = child.find(row => row.type === "user" && Array.isArray(row.message.content))!
  result.toolUseResult = { status: "completed", agentId: "generated-grandchild" }
  await writeFile(file, encode(f.values)); await writeFile(f.childFile, encode(child))
  const first = await capture(request({ sourceId: f.sessionId })), childId = `claude-agent:${f.agentId}`
  expect(first.header.threads).toHaveLength(2)
  expect(first.events.some(event => event.sourceThreadId === childId && event.update.sessionUpdate === "tool_call_update")).toBe(true)
  expect(first.header.sourceFailures).toEqual([{ source: f.childFile, reason: "unsupported" }])
  const previous = f.values.filter(row => row.uuid).at(-1)!
  await appendFile(file, encode([{ ...previous, uuid: "root-continues", parentUuid: previous.uuid,
    message: { ...previous.message, id: "root-continues-api", content: [{ type: "text", text: "Root continues" }] } }]))
  const next = await capture(request({ sourceId: f.sessionId, priorThreads: first.header.threads, priorCheckpoint: first.header.sourceCheckpoint }))
  expect(next.header.sourceFailures).toEqual(first.header.sourceFailures)
  expect(next.events.at(-1)?.sourceThreadId).toBe(childId)
  expect(next.events.some(event => event.sourceEventId === "root-continues:0")).toBe(true)
})
it("does not count empty thinking or opaque Raw blocks as extra receipt Events", async () => {
  const f = await delegationSource(), folder = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
  const child = (await readFile(new URL(`${f.sessionId}/subagents/agent-${f.agentId}.jsonl`, folder), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  f.receipt.message.content.push({ type: "thinking", thinking: "" }, { type: "unknown_provider", data: "opaque" })
  await writeFile(file, encode(f.values)); await writeFile(f.childFile, child)
  const actual = await capture(request({ sourceId: f.sessionId }))
  expect(actual.header.threads).toHaveLength(2); expect(actual.header.sourceFailures).toEqual([])
})
it("authenticates a genuine previous public pending Event cursor before selecting the current branch", async () => {
  await writeFile(file, encode(rows().slice(0, 4)))
  const old = await historical.createAtapeAdapter(context)
  const requestOld = (cursor: string | null) => ({ protocolVersion: "atape.adapter.v1alpha1" as const, cursor, rawCaptureEnabled: false,
    rawProgress: [], limits: { ...AdapterCollectionLimits, eventsPerObservation: 1 }, signal: context.signal })
  try {
    const root = await old.collect(requestOld(null)) as any
    const pending = await old.collect(requestOld(root.nextCursor)) as any
    expect(pending.observations.flatMap((observation: Row) => observation.events)).toHaveLength(1)
    await appendFile(file, encode(rows().slice(4)))
    const current = await capture(request({ legacyCheckpoint: pending.nextCursor }))
    expect(current.events.map(event => event.sourceEventId)).toEqual(["root:0", "first:0", "first:1", "current:0", "new:0", "new:1"])
  } finally { await old.close?.() }
})

it.each(["JSON", "UTF-8"])("rejects malformed complete %s rows without replacing the prior public checkpoint", async format => {
  const prefix = encode(rows().slice(0, 2)); await writeFile(file, prefix)
  const prior = await capture(), invalid = format === "JSON" ? Buffer.from("{broken}\n") : Buffer.from([123, 34, 255, 34, 58, 49, 125, 10])
  await writeFile(file, Buffer.concat([Buffer.from(prefix), invalid]))
  await expect(capture(request({ priorCheckpoint: prior.header.sourceCheckpoint }))).rejects.toMatchObject({ reason: "format" })
  await writeFile(file, prefix)
  expect(await capture(request({ priorCheckpoint: prior.header.sourceCheckpoint }))).toEqual(prior)
})
it("rejects an over-16MiB physical row before returning a replacement view", async () => {
  const prefix = encode(rows().slice(0, 2)); await writeFile(file, prefix); const prior = await capture()
  const oversized = { ...rows()[4], parentUuid: "first", generatedUnknown: "x".repeat(16 * 1024 * 1024) }
  await writeFile(file, prefix + encode([oversized]))
  await expect(capture(request({ priorCheckpoint: prior.header.sourceCheckpoint }))).rejects.toMatchObject({ reason: "limit" })
})
