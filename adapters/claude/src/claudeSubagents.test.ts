import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterEvent, type AdapterOpenContext } from "@atape/domain"
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd", threadId = `claude-agent:${agentId}`
const fixture = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
let directory: string, rootFile: string, childPath: string, context: AdapterOpenContext & { signal: AbortSignal }
let rootText: string, childText: string
let progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-family-"))
  rootFile = join(directory, `${sessionId}.jsonl`)
  childPath = join(directory, sessionId, "subagents", `agent-${agentId}.jsonl`)
  rootText = (await readFile(new URL(`${sessionId}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  childText = (await readFile(new URL(`${sessionId}/subagents/agent-${agentId}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  await mkdir(join(directory, sessionId, "subagents"), { recursive: true })
  await writeFile(rootFile, rootText); await writeFile(childPath, childText)
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", rootFile)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const request = (cursor: string | null = null, rawCaptureEnabled = true, eventsPerObservation = 500): AdapterCollectRequest => ({
  protocolVersion: "atape.adapter.v1alpha1", cursor, rawCaptureEnabled, rawProgress: progress,
  limits: { ...AdapterCollectionLimits, eventsPerObservation }, signal: new AbortController().signal
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
const drain = async (cursor: string | null = null, raw = true, eventLimit = 500) => {
  const pages: AdapterCollectionPage[] = []
  for (let i = 0; i < 100; i++) {
    const page = await read(request(cursor, raw, eventLimit)); pages.push(page)
    acknowledge(page); cursor = page.nextCursor
    if (!page.observations.length && !page.hasMore) return { pages, cursor }
  }
  throw new Error("Claude family did not finish bounded collection")
}
const rewrite = async (path: string, text: string, transform: (row: Record<string, any>) => Record<string, any>) =>
  writeFile(path, text.trimEnd().split("\n").map(line => JSON.stringify(transform(JSON.parse(line)))).join("\n") + "\n")

it("captures the native foreground child under its real parent tool and keeps independent Raw and usage", async () => {
  const { pages, cursor } = await drain()
  const observations = pages.flatMap(page => page.observations), events = observations.flatMap(o => o.events)
  expect(new Set(observations.map(o => o.session.sourceSessionId))).toEqual(new Set([sessionId]))
  expect(events.filter(e => e.childSourceThreadId === threadId)).toHaveLength(1)
  expect(events.find(e => e.childSourceThreadId === threadId)?.update.sessionUpdate).toBe("tool_call_update")
  expect(events.some(e => e.sourceThreadId === threadId && e.update.sessionUpdate === "tool_call_update")).toBe(true)
  expect(observations.every(o => o.threads.some(t => t.sourceThreadId === "root"))).toBe(true)
  expect(observations.at(-1)?.threads.find(t => t.sourceThreadId === threadId)?.parentSourceThreadId).toBe("root")
  expect(observations.at(-1)?.session.title).toBe(observations[0]?.session.title)
  const usage = observations.flatMap(o => o.usage ?? [])
  expect(usage).toHaveLength(4)
  expect(usage.filter(u => u.sourceThreadId === threadId)).toHaveLength(2)
  expect(usage.reduce((sum, u) => sum + u.inputTokens!, 0)).toBe(68)
  expect(usage.reduce((sum, u) => sum + u.outputTokens!, 0)).toBe(36)
  const raw = observations.flatMap(o => o.rawSegments)
  expect(new Set(raw.map(r => r.sourceObjectId)).size).toBe(2)
  expect(raw.map(r => r.content)).toEqual([rootText, childText])
  expect(pages.at(-1)?.progress).toMatchObject({ sourceFiles: 2, pendingRawBytes: 0, pendingCanonicalSessions: 0 })
  expect((await read(request(cursor))).observations).toEqual([])
})

it("replays each one-event page exactly after restart, including the parent link and child record splits", async () => {
  let cursor: string | null = null
  const ids: string[] = []
  for (let i = 0; i < 50; i++) {
    const input = request(cursor, true, 1), page = await read(input)
    expect(await read(input)).toEqual(page)
    if (!page.observations.length) break
    for (const o of page.observations) {
      expect(o.events.length).toBeLessThanOrEqual(1)
      ids.push(...o.events.map(e => `${e.sourceThreadId}:${e.sourceEventId}`))
    }
    acknowledge(page); cursor = page.nextCursor
  }
  expect(ids).toHaveLength(8)
  expect(new Set(ids).size).toBe(ids.length)
})

it("discovers a child appearing after the parent is acknowledged without changing the pinned identity", async () => {
  await rm(childPath)
  const first = await read(); acknowledge(first)
  const waiting = await read(request(first.nextCursor))
  expect(waiting.sourceFailures).toEqual([{ source: childPath, reason: "io" }])
  expect(waiting.nextCursor).toBe(first.nextCursor)
  await writeFile(childPath, childText)
  const child = await read(request(first.nextCursor))
  expect(child.observations[0]?.events.every(e => e.sourceThreadId === threadId)).toBe(true)
  expect(child.observations[0]?.session.sourceSessionId).toBe(sessionId)
})

it("keeps legacy root identities and acknowledged Raw while upgrading a projection-3 checkpoint", async () => {
  const first = await read(); acknowledge(first)
  const old = JSON.parse(first.nextCursor!)
  const checkpoint = old.sessions[0].checkpoint
  checkpoint.projectionRevision = 3
  delete checkpoint.children; delete checkpoint.familyRevision; delete checkpoint.familyObservedAt
  const upgraded = await read(request(JSON.stringify(old)))
  expect(upgraded.observations[0]?.events.map(e => e.sourceEventId)).toEqual(first.observations[0]?.events.map(e => e.sourceEventId))
  expect(upgraded.observations[0]?.events.every(e => e.projectionRevision === 4)).toBe(true)
  expect(upgraded.observations[0]?.rawSegments).toEqual([])
  expect(upgraded.observations[0]?.events.some(e => e.childSourceThreadId === threadId)).toBe(true)
  expect((await read(request(upgraded.nextCursor))).observations[0]?.events[0]?.sourceThreadId).toBe(threadId)
})

it("collects child Canonical with Raw off then backfills both sources without repeating events", async () => {
  const off = await drain(null, false)
  expect(off.pages.flatMap(p => p.observations.flatMap(o => o.rawSegments))).toEqual([])
  expect(off.pages.flatMap(p => p.observations.flatMap(o => o.events)).filter(e => e.sourceThreadId === threadId)).toHaveLength(4)
  const on = await drain(off.cursor)
  expect(on.pages.flatMap(p => p.observations.flatMap(o => o.events))).toEqual([])
  expect(on.pages.flatMap(p => p.observations.flatMap(o => o.rawSegments)).map(r => r.content)).toEqual([rootText, childText])
})

it("retains captured child progress after deletion and rejects a changed restored prefix", async () => {
  const done = await drain()
  await rm(childPath)
  expect(await read(request(done.cursor))).toMatchObject({ observations: [], nextCursor: done.cursor })
  await writeFile(childPath, childText.replace("ATAPE_CHILD_FINAL", "ATAPE_CHANGED_CHILD_FINAL"))
  expect((await read(request(done.cursor))).sourceFailures).toEqual([{ source: childPath, reason: "changed" }])
})

it.each(["session", "agent", "cwd", "sidechain", "format"])("isolates an invalid child %s without acknowledging its bytes", async kind => {
  if (kind === "format") await writeFile(childPath, childText + "broken-json\n")
  else await rewrite(childPath, childText, row => ({ ...row,
    ...(kind === "session" ? { sessionId: "foreign" } : kind === "agent" ? { agentId: "different" } :
      kind === "cwd" ? { cwd: "/unrelated" } : { isSidechain: false }) }))
  const first = await read(); acknowledge(first)
  const invalid = await read(request(first.nextCursor))
  expect(invalid.observations).toEqual([])
  expect(invalid.nextCursor).toBe(first.nextCursor)
  expect(invalid.sourceFailures?.[0]?.reason).toBe(kind === "format" ? "format" : "unsupported")
})

it.each([
  { label: "missing UUID", patch: {} },
  { label: "empty UUID", patch: { uuid: "" } },
  { label: "whitespace UUID", patch: { uuid: " " } },
  { label: "null UUID", patch: { uuid: null } },
  { label: "numeric UUID", patch: { uuid: 123 } },
  { label: "oversized UUID", patch: { uuid: "x".repeat(501) } },
  { label: "NUL UUID", patch: { uuid: "invalid\0uuid" } },
  { label: "UUID-less foreign Agent", patch: { agentId: "foreign-agent" } },
  { label: "UUID-less root sidechain", patch: { isSidechain: false } },
  { label: "UUID-less missing sidechain", patch: { isSidechain: undefined } },
  { label: "UUID-less user", patch: { type: "user" } },
  { label: "UUID-less meta assistant", patch: { isMeta: true } }
])("isolates child $label before Events, usage or Raw are acknowledged while the root continues", async ({ patch }) => {
  const done = await drain()
  const childLeaf = childText.trimEnd().split("\n").map(line => JSON.parse(line)).filter(row => row.uuid).at(-1)!
  const rootLeaf = rootText.trimEnd().split("\n").map(line => JSON.parse(line)).filter(row => row.uuid).at(-1)!
  const childAppend = { type: "assistant", isSidechain: true, agentId, sessionId, parentUuid: childLeaf.uuid,
    timestamp: "2026-10-08T10:00:00Z", message: { id: "unbound-usage", role: "assistant", model: "foreign-model",
      content: [{ type: "text", text: "Unbound foreign conversation" }],
      usage: { input_tokens: 999, output_tokens: 888, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  await appendFile(childPath, JSON.stringify({ ...childAppend, ...patch }) + "\n")
  await appendFile(rootFile, JSON.stringify({ ...rootLeaf, uuid: "healthy-root-append", parentUuid: rootLeaf.uuid,
    message: { ...rootLeaf.message, id: "healthy-root-usage", content: "Healthy root continues",
      usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + "\n")
  const healthy = await read(request(done.cursor))
  expect(healthy.observations.flatMap(o => o.events).map(e => e.sourceEventId)).toEqual(["healthy-root-append:0"])
  expect(healthy.observations.flatMap(o => o.usage ?? [])).toMatchObject([{ sourceThreadId: "root", inputTokens: 3, outputTokens: 2 }])
  acknowledge(healthy)
  const input = request(healthy.nextCursor), retainedProgress = [...progress]
  const invalid = await read(input)
  expect(invalid).toMatchObject({ observations: [], nextCursor: healthy.nextCursor,
    sourceFailures: [{ source: childPath, reason: "unsupported" }] })
  expect(await read(input)).toEqual(invalid)
  acknowledge(invalid)
  expect(progress).toEqual(retainedProgress)
  expect(JSON.parse(invalid.nextCursor!).sessions[0].checkpoint.children[0].checkpoint)
    .toEqual(JSON.parse(done.cursor!).sessions[0].checkpoint.children[0].checkpoint)

  const repairedLine = JSON.stringify({ ...childAppend, uuid: "repaired-child-append",
    message: { ...childAppend.message, id: "repaired-child-usage",
      usage: { input_tokens: 5, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + "\n"
  await writeFile(childPath, childText + repairedLine)
  const repaired = await read(request(invalid.nextCursor))
  expect(repaired.sourceFailures).toBeUndefined()
  expect(repaired.observations.flatMap(o => o.events).map(e => e.sourceEventId)).toEqual(["repaired-child-append:0"])
  expect(repaired.observations.flatMap(o => o.usage ?? [])).toMatchObject([{ sourceThreadId: threadId, inputTokens: 5, outputTokens: 4 }])
  expect(repaired.observations[0]?.rawSegments).toMatchObject([{ sourceOffset: Buffer.byteLength(childText), content: repairedLine }])
  acknowledge(repaired)
  expect((await read(request(repaired.nextCursor))).observations).toEqual([])
})

it.each([
  { label: "UUID-less assistant", type: "assistant", patch: {}, error: "no valid UUID" },
  { label: "UUID-less user", type: "user", patch: {}, error: "no valid UUID" },
  { label: "nonboolean sidechain", type: "assistant", patch: { uuid: "foreign-root", isSidechain: "false" }, error: "selected Thread" },
  { label: "foreign Agent", type: "assistant", patch: { uuid: "foreign-root", agentId: "foreign-agent" }, error: "selected Thread" }
])("isolates root $label during discovery without advancing its checkpoint or blocking a healthy Session", async ({ type, patch, error }) => {
  const home = join(directory, "claude-home"), sourceDirectory = join(home, "projects", "profile")
  await mkdir(join(sourceDirectory, sessionId, "subagents"), { recursive: true })
  const discoveredRoot = join(sourceDirectory, `${sessionId}.jsonl`), healthyFile = join(sourceDirectory, "healthy-session.jsonl")
  await writeFile(discoveredRoot, rootText)
  await writeFile(join(sourceDirectory, sessionId, "subagents", `agent-${agentId}.jsonl`), childText)
  const rootRows = rootText.trimEnd().split("\n").map(line => JSON.parse(line))
  const root = rootRows.find(row => row.uuid)!, leaf = rootRows.filter(row => row.uuid).at(-1)!
  const healthyRows = [{ ...root, sessionId: "healthy-session", uuid: "healthy-user", parentUuid: null },
    { ...leaf, sessionId: "healthy-session", uuid: "healthy-answer", parentUuid: "healthy-user" }]
  await writeFile(healthyFile, healthyRows.map(row => JSON.stringify(row)).join("\n") + "\n")
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", ""); vi.stubEnv("ATAPE_CLAUDE_HOME", home)
  const done = await drain(), retained = JSON.parse(done.cursor!).sessions.find((item: any) => item.checkpoint.sessionId === sessionId)
  const unbound = { type, sessionId, isSidechain: false, parentUuid: leaf.uuid, timestamp: "2026-10-08T10:00:00Z",
    message: { role: type, id: "unbound-root-usage", model: "model", content: "Unbound root conversation",
      usage: { input_tokens: 999, output_tokens: 888, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, ...patch }
  await appendFile(discoveredRoot, JSON.stringify(unbound) + "\n")
  await appendFile(healthyFile, JSON.stringify({ ...healthyRows[1], uuid: "healthy-answer-append", parentUuid: "healthy-answer",
    message: { role: "assistant", id: "healthy-appended-usage", content: "Healthy Session continues",
      usage: { input_tokens: 5, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + "\n")
  const input = request(done.cursor), healthy = await read(input)
  expect(await read(input)).toEqual(healthy)
  expect(healthy.observations.map(o => o.session.sourceSessionId)).toEqual(["healthy-session"])
  expect(healthy.observations.flatMap(o => o.events).map(e => e.sourceEventId)).toEqual(["healthy-answer-append:0"])
  expect(healthy.observations.flatMap(o => o.usage ?? [])).toMatchObject([{ inputTokens: 5, outputTokens: 4 }])
  expect(JSON.parse(healthy.nextCursor!).sessions.find((item: any) => item.checkpoint.sessionId === sessionId)).toEqual(retained)
  acknowledge(healthy)
  const retainedProgress = [...progress], failed = await read(request(healthy.nextCursor))
  expect(failed).toMatchObject({ observations: [], nextCursor: healthy.nextCursor,
    sourceFailures: [{ source: await realpath(discoveredRoot), reason: "unsupported" }] })
  acknowledge(failed); expect(progress).toEqual(retainedProgress)

  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", discoveredRoot)
  await expect(read(request(failed.nextCursor))).rejects.toThrow(error)
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", "")
  const repairedLine = JSON.stringify({ ...unbound, uuid: "repaired-root-append", isSidechain: false, agentId: undefined }) + "\n"
  await writeFile(discoveredRoot, rootText + repairedLine)
  const repaired = await read(request(failed.nextCursor))
  expect(repaired.sourceFailures).toBeUndefined()
  expect(repaired.observations.flatMap(o => o.events).map(e => e.sourceEventId)).toEqual(["repaired-root-append:0"])
  expect(repaired.observations[0]?.rawSegments).toMatchObject([{ sourceOffset: Buffer.byteLength(rootText), content: repairedLine }])
  acknowledge(repaired)
  expect((await read(request(repaired.nextCursor))).observations).toEqual([])
})

it("keeps native UUID-less bookkeeping Raw-only after a foreground family is captured", async () => {
  const done = await drain(), bookkeeping = rootText.trimEnd().split("\n").map(line => JSON.parse(line)).find(row => row.type === "last-prompt")!
  const line = JSON.stringify(bookkeeping) + "\n"
  await appendFile(rootFile, line)
  const page = await read(request(done.cursor))
  expect(page.sourceFailures).toBeUndefined()
  expect(page.observations.flatMap(o => o.events)).toEqual([])
  expect(page.observations.flatMap(o => o.usage ?? [])).toEqual([])
  expect(page.observations[0]?.rawSegments).toMatchObject([{ sourceOffset: Buffer.byteLength(rootText), content: line }])
  acknowledge(page)
  expect((await read(request(page.nextCursor))).observations).toEqual([])
})

it("rejects symlinked child directories before reading their contents", async () => {
  const first = await read(); acknowledge(first)
  await rm(join(directory, sessionId, "subagents"), { recursive: true })
  const outside = join(directory, "outside"); await mkdir(outside)
  await writeFile(join(outside, `agent-${agentId}.jsonl`), childText)
  await symlink(outside, join(directory, sessionId, "subagents"), "dir")
  expect((await read(request(first.nextCursor))).sourceFailures).toEqual([{ source: childPath, reason: "unsupported" }])
})

it("requires a completed foreground parent receipt and never guesses a relation from a path", async () => {
  await rewrite(rootFile, rootText, row => row.toolUseResult?.agentId ? { ...row, toolUseResult: { ...row.toolUseResult, status: "async_launched", isAsync: true } } : row)
  await expect(read()).rejects.toThrow("completed foreground")
})

it("continues child-only appends with the same Thread and Raw object", async () => {
  const done = await drain(), previousRaw = done.pages.flatMap(p => p.observations.flatMap(o => o.rawSegments)).at(-1)!
  const last = childText.trimEnd().split("\n").map(line => JSON.parse(line)).filter(row => row.uuid).at(-1)!
  await appendFile(childPath, JSON.stringify({ ...last, uuid: "later-child-reply", parentUuid: last.uuid,
    timestamp: "2026-10-08T00:00:00Z", message: { role: "assistant", content: "Later child reply" } }) + "\n")
  const page = await read(request(done.cursor)), child = page.observations[0]!
  expect(child.events.map(e => e.sourceEventId)).toEqual(["later-child-reply:0"])
  expect(child.events[0]?.sourceThreadId).toBe(threadId)
  expect(child.rawSegments[0]?.sourceObjectId).toBe(previousRaw.sourceObjectId)
  expect(child.rawSegments[0]?.sourceOffset).toBe(Buffer.byteLength(childText))
})

it("rejects an escaped family path before publishing a child relation", async () => {
  await rewrite(rootFile, rootText, row => ({ ...row, ...(row.sessionId ? { sessionId: "../outside" } : {}) }))
  await expect(read()).rejects.toThrow("safe source path component")
})

it("rejects conflicting agent identities for one parent tool call as a source error", async () => {
  const rows = rootText.trimEnd().split("\n").map(line => JSON.parse(line))
  const receipt = rows.find(row => row.toolUseResult?.agentId)!, last = rows.filter(row => row.uuid).at(-1)!
  await appendFile(rootFile, JSON.stringify({ ...receipt, uuid: "conflicting-receipt", parentUuid: last.uuid,
    toolUseResult: { ...receipt.toolUseResult, agentId: "other-agent" } }) + "\n")
  await expect(read()).rejects.toMatchObject({ reason: "unsupported" })
})

it("pins parent evidence only after its complete receipt fits in the captured page", async () => {
  let cursor: string | null = null, linked = false
  for (let i = 0; i < 30; i++) {
    const input = request(cursor)
    const page = await read({ ...input, limits: { ...input.limits, canonicalBytesPerObservation: 10000 } })
    if (!page.observations.length) break
    linked ||= page.observations.some(o => o.events.some(e => e.childSourceThreadId === threadId))
    expect(Boolean(JSON.parse(page.nextCursor!).sessions[0].checkpoint.children?.length)).toBe(linked)
    acknowledge(page); cursor = page.nextCursor
  }
  expect(linked).toBe(true)
})

it("paginates near-limit root and child text with complete headers for 100 Threads without losing retry or Raw progress", async () => {
  // Synthetic size/width mutation of the proved native foreground layout.
  const root = rootText.trimEnd().split("\n").map(line => JSON.parse(line)).find(row => row.uuid)!
  const childRecords = childText.trimEnd().split("\n").map(line => JSON.parse(line))
  const agents = [agentId, ...Array.from({ length: 98 }, (_, index) => `a${String(index).padStart(16, "0")}`)]
  const records = [root], sources = new Map<string, string>()
  let parent = root.uuid
  for (const [index, selectedAgent] of agents.entries()) {
    const callUuid = `wide-call-${index}`, resultUuid = `wide-result-${index}`, tool = `wide-tool-${index}`
    records.push({ ...root, uuid: callUuid, parentUuid: parent, type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: tool, name: "Agent", input: {} }] } })
    records.push({ ...root, uuid: resultUuid, parentUuid: callUuid, type: "user", sourceToolAssistantUUID: callUuid,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "complete" }] },
      toolUseResult: { status: "completed", agentId: selectedAgent } })
    parent = resultUuid
    const selectedRecords = childRecords.map(row => ({ ...row, agentId: selectedAgent }))
    if (selectedAgent === agentId) {
      const leaf = selectedRecords.filter(row => row.uuid).at(-1)!
      selectedRecords.push({ ...leaf, uuid: "large-child", parentUuid: leaf.uuid,
        message: { role: "assistant", content: "c".repeat(3_125_000) } })
    }
    const source = selectedRecords.map(row => JSON.stringify(row)).join("\n") + "\n"
    sources.set(`agent-${selectedAgent}.jsonl`, source)
    await writeFile(join(directory, sessionId, "subagents", `agent-${selectedAgent}.jsonl`), source)
  }
  records.push({ ...root, uuid: "large-root", parentUuid: parent, type: "assistant",
    message: { role: "assistant", content: "r".repeat(3_015_000) } })
  const source = records.map(row => JSON.stringify(row)).join("\n") + "\n"
  sources.set(`${sessionId}.jsonl`, source)
  await writeFile(rootFile, source)

  let cursor: string | null = null, finished = false, rootTextPages = 0, childTextPages = 0
  const captured: AdapterEvent[] = [], linked = new Set<string>()
  const archived = new Map<string, { objectId: string; generation: string; content: string }>()
  for (let index = 0; index < 200; index++) {
    const input = request(cursor), page = await read(input)
    expect(await read(input)).toEqual(page)
    expect(page.sourceFailures).toBeUndefined()
    for (const observation of page.observations) {
      expect(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] })))
        .toBeLessThanOrEqual(input.limits.canonicalBytesPerObservation)
      for (const event of observation.events) if (event.childSourceThreadId) linked.add(event.childSourceThreadId)
      expect(new Set(observation.threads.map(thread => thread.sourceThreadId))).toEqual(new Set(["root", ...linked]))
      captured.push(...observation.events)
      if (observation.events.some(event => event.sourceEventId.startsWith("large-root:"))) rootTextPages++
      if (observation.events.some(event => event.sourceEventId.startsWith("large-child:"))) childTextPages++
      for (const raw of observation.rawSegments) {
        const previous = archived.get(raw.sourceName) ?? { objectId: raw.sourceObjectId, generation: raw.sourceGeneration, content: "" }
        expect(raw.sourceObjectId).toBe(previous.objectId)
        expect(raw.sourceGeneration).toBe(previous.generation)
        expect(raw.sourceOffset).toBe(Buffer.byteLength(previous.content))
        archived.set(raw.sourceName, { ...previous, content: previous.content + raw.content })
      }
    }
    acknowledge(page); cursor = page.nextCursor
    if (!page.observations.length && !page.hasMore) { finished = true; break }
  }
  expect(finished).toBe(true)
  expect(linked.size).toBe(99)
  expect(rootTextPages).toBeGreaterThan(1)
  expect(childTextPages).toBeGreaterThan(1)
  expect(captured).toHaveLength(619)
  expect(new Set(captured.map(event => `${event.sourceThreadId}:${event.sourceEventId}`)).size).toBe(captured.length)
  for (const [prefix, content] of [["large-root:", "r".repeat(3_015_000)], ["large-child:", "c".repeat(3_125_000)]]) {
    expect(captured.filter(event => event.sourceEventId.startsWith(prefix!)).map(event =>
      "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join("")).toBe(content)
  }
  expect(archived.size).toBe(sources.size)
  for (const [name, content] of sources) expect(archived.get(name)?.content).toBe(content)
  expect(new Set([...archived.values()].map(raw => raw.objectId)).size).toBe(100)
  expect((await read(request(cursor))).observations).toEqual([])
}, 60_000)

it("reports nested delegation explicitly while preserving the parent checkpoint", async () => {
  await rewrite(childPath, childText, row => row.type === "assistant" && row.message?.content?.some((block: Record<string, unknown>) => block.type === "tool_use")
    ? { ...row, message: { ...row.message, content: row.message.content.map((block: Record<string, unknown>) => block.type === "tool_use" ? { ...block, name: "Agent" } : block) } }
    : row)
  const first = await read(); acknowledge(first)
  expect(await read(request(first.nextCursor))).toMatchObject({ observations: [], nextCursor: first.nextCursor,
    sourceFailures: [{ source: childPath, reason: "unsupported" }] })
})
