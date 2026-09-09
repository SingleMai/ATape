import { AdapterCollectionLimits, type AdapterCollectRequest, type AdapterCollectionPage, type AdapterOpenContext } from "@atape/domain"
import { appendFile, open, stat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { inflateRawSync } from "node:zlib"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

let root: string, file: string, records: Array<Record<string, unknown>>, context: AdapterOpenContext & { signal: AbortSignal }
const receipts = new Map<string, AdapterCollectRequest["rawProgress"]>()
const request = (cursor: string | null = null): AdapterCollectRequest => ({ protocolVersion: "atape.adapter.v1alpha1", cursor, rawProgress: cursor === null ? [] : receipts.get(cursor) ?? [], limits: AdapterCollectionLimits, signal: new AbortController().signal })
beforeEach(async () => {
  receipts.clear()
  root = await mkdtemp(join(tmpdir(), "atape-claude-test-")); file = join(root, "session.jsonl")
  const source = await readFile(new URL("../fixtures/native-read-2.1.263.jsonl", import.meta.url), "utf8")
  records = source.replaceAll("/fixture/native-read", root).trimEnd().split("\n").map(line => JSON.parse(line))
  await writeFile(file, records.map(r => JSON.stringify(r)).join("\n") + "\n")
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.2.0" }, project: { id: "project", type: "directory", path: root }, signal: new AbortController().signal }
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
// Model the host: advancing a cursor acknowledges the returned Raw; retrying the
// same request retains its previous receipts.
const collect = async (r = request(), c = context) => {
  const page = await (await createAtapeAdapter(c)).collect(r) as AdapterCollectionPage
  if (page.nextCursor !== null && page.nextCursor !== r.cursor) {
    const progress = new Map(r.rawProgress.map(p => [p.sourceObjectId + p.sourceGeneration, p]))
    for (const o of page.observations) for (const raw of o.rawSegments) progress.set(raw.sourceObjectId + raw.sourceGeneration, {
      sourceSessionId: o.session.sourceSessionId, sourceObjectId: raw.sourceObjectId,
      sourceGeneration: raw.sourceGeneration, sourceOffset: raw.sourceOffset + Buffer.byteLength(raw.content),
      finalized: raw.final
    })
    receipts.set(page.nextCursor, [...progress.values()])
  }
  return page
}
const discoveredFile = async (name: string, content = records, folder = "not-a-project-path") => {
  const home = join(root, "claude-home"), directory = join(home, "projects", folder)
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", ""); vi.stubEnv("ATAPE_CLAUDE_HOME", home)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${name}.jsonl`)
  await writeFile(path, content.map(r => JSON.stringify(r)).join("\n") + "\n")
  return realpath(path)
}
const appendAnswer = async (path: string, text = "Discovered append") => {
  const last = records.filter(r => r.uuid).at(-1)!
  await appendFile(path, JSON.stringify({ ...last, uuid: "discovered-append", parentUuid: last.uuid, message: { role: "assistant", content: text } }) + "\n")
}

it("projects native Read success/error into common events without flattening tools into user messages", async () => {
  const page = await collect(), o = page.observations[0]!
  expect(o.session.actor.harness).toBe("Claude Code")
  expect(o.session.captureStatus).toBe("partial")
  expect(o.events).toHaveLength(6)
  expect(o.events.map(e => e.update.sessionUpdate)).toEqual(["user_message_chunk", "tool_call", "tool_call_update", "tool_call", "tool_call_update", "agent_message_chunk"])
  expect(o.events.flatMap(e => e.update.sessionUpdate === "tool_call_update" ? [e.update.status] : [])).toEqual(["completed", "failed"])
  expect(o.events[1]?.update).toMatchObject({ rawInput: { file_path: expect.stringContaining("fixture.txt") } })
  expect(JSON.stringify(o.events[2]?.update)).toContain("ATAPE_SYNTHETIC_TOOL_FILE")
  expect(o.events[2]?.update).toMatchObject({ toolCallId: (o.events[1]!.update as { toolCallId: string }).toolCallId })
  expect(new Set(o.events.map(e => e.sourceEventId)).size).toBe(6)
  expect(o.rawSegments[0]?.content).toBe(await readFile(file, "utf8"))
  expect(o.rawSegments[0]?.final).toBe(false)
  expect(o.session.status).toBe("active") // A finalized snapshot is not an ended source Session.
  expect(await collect()).toEqual(page)
  expect((await collect(request(page.nextCursor))).observations).toEqual([])
})

it("keeps stable event IDs on append and defers an incomplete line", async () => {
  const first = await collect(), old = first.observations[0]!
  const last = records.filter(r => r.uuid).at(-1)!
  const next = { ...last, uuid: "appended-uuid", parentUuid: last.uuid, timestamp: "2026-09-07T13:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "Appended answer" }] } }
  await appendFile(file, JSON.stringify(next))
  expect((await collect(request(first.nextCursor))).observations).toEqual([])
  await appendFile(file, "\n")
  const current = (await collect(request(first.nextCursor))).observations[0]!
  expect(current.events.map(e => e.sourceEventId)).toEqual(["appended-uuid:0"])
  expect(current.events).toHaveLength(1)
  expect(current.session.revision).toBeGreaterThan(old.session.revision)
  expect(current.rawSegments[0]?.sourceObjectId).toBe(old.rawSegments[0]?.sourceObjectId)
})

it("skips a fully acknowledged Raw snapshot on Canonical retry", async () => {
  const first = await collect(), o = first.observations[0]!, raw = o.rawSegments[0]!
  const replay = await collect({ ...request(), rawProgress: [{ sourceSessionId: o.session.sourceSessionId, sourceObjectId: raw.sourceObjectId, sourceGeneration: raw.sourceGeneration, sourceOffset: Buffer.byteLength(raw.content), finalized: true }] })
  expect(replay.observations[0]?.events).toEqual(o.events)
  expect(replay.observations[0]?.rawSegments).toEqual([])
})

it("rejects changed captured bytes rather than silently rebasing the cursor", async () => {
  const first = await collect(); await writeFile(file, (await readFile(file, "utf8")).replace("ATAPE_TOOL_DONE", "ATAPE_TOOL_FAIL"))
  await expect(collect(request(first.nextCursor))).rejects.toThrow("prefix changed")
})

it("uses the root CWD, ignoring later /cd locations and storage location", async () => {
  for (const r of records) if (r.parentUuid !== null && r.cwd) r.cwd = "/unrelated/later-directory"
  await writeFile(file, records.map(r => JSON.stringify(r)).join("\n") + "\n")
  expect((await collect()).observations).toHaveLength(1)
  const other = join(root, "other"); await mkdir(other)
  expect((await collect(request(), { ...context, project: { ...context.project, path: other } })).observations).toEqual([])
})

it("paginates bounded observations while rejecting branching", async () => {
  expect(await collect({ ...request(), limits: { ...AdapterCollectionLimits, eventsPerObservation: 2 } })).toMatchObject({ hasMore: true, observations: [{ events: expect.any(Array) }] })
  const last = records.filter(r => r.uuid).at(-1)!
  await appendFile(file, JSON.stringify({ ...last, uuid: "branch", parentUuid: records.find(r => r.parentUuid === null)?.uuid }) + "\n")
  await expect(collect()).rejects.toThrow("unambiguous")
})

it("rejects malformed complete records and does not reset corrupt checkpoints", async () => {
  await expect(collect(request("{}"))).rejects.toThrow("checkpoint")
  await appendFile(file, "broken-json\n")
  await expect(collect()).rejects.toThrow("malformed")
})

it("uses Host Git attribution for both explicit and discovered sources, without a live Project path", async () => {
  const origin = records.find(r => r.parentUuid === null)!
  const resolve = vi.fn(async () => "included" as const)
  const gitContext = { ...context, project: { ...context.project, type: "git" as const, path: "/deleted/project" },
    gitAttribution: { version: "atape.git-attribution.v1" as const, resolve } }
  expect((await collect(request(), gitContext)).observations).toHaveLength(1)
  expect(resolve).toHaveBeenCalledWith({ sourceId: origin.sessionId, originKey: origin.uuid, cwd: origin.cwd }, expect.any(AbortSignal))
  await discoveredFile("worktree")
  expect((await collect(request(), gitContext)).observations).toHaveLength(1)
  const excluded = { ...gitContext, gitAttribution: { ...gitContext.gitAttribution, resolve: async () => "excluded" as const } }
  expect((await collect(request(), excluded)).observations).toEqual([])
  const unknown = { ...gitContext, gitAttribution: { ...gitContext.gitAttribution, resolve: async () => "unknown" as const } }
  expect(await collect(request(), unknown)).toMatchObject({ observations: [], sourceFailures: [{ reason: "attribution" }] })
})

it("requires the new Host capability for Git Projects", async () => {
  await expect(createAtapeAdapter({ ...context, project: { ...context.project, type: "git" } })).rejects.toThrow("Upgrade")
})

it("skips foreign and unknown Git sources while capturing and resuming healthy history", async () => {
  const healthyId = String(records.find(r => r.parentUuid === null)!.sessionId)
  const unknownFile = await discoveredFile("unknown", records.map(r => r.sessionId ? { ...r, sessionId: "unknown" } : r))
  await discoveredFile("foreign", records.map(r => r.sessionId ? { ...r, sessionId: "foreign" } : r))
  await discoveredFile("healthy")
  const gitContext = { ...context, project: { ...context.project, type: "git" as const },
    gitAttribution: { version: "atape.git-attribution.v1" as const,
      resolve: async (source: { sourceId: string }) => source.sourceId === healthyId ? "included" as const
        : source.sourceId === "foreign" ? "excluded" as const : "unknown" as const } }
  const first = await collect(request(), gitContext)
  expect(first.observations.map(o => o.session.sourceSessionId)).toEqual([healthyId])
  expect(first.observations[0]?.events).toHaveLength(6)
  expect(first.observations[0]?.rawSegments).toHaveLength(1)
  expect(first.sourceFailures).toEqual([{ source: unknownFile, reason: "attribution" }])
  expect(await collect(request(first.nextCursor), gitContext)).toMatchObject({
    observations: [], nextCursor: first.nextCursor, hasMore: false,
    sourceFailures: [{ source: unknownFile, reason: "attribution" }] })
})

it("discovers multiple sessions, persists each checkpoint and finds later appends and new files", async () => {
  const firstFile = await discoveredFile("first")
  await discoveredFile("second", records.map(r => r.sessionId ? { ...r, sessionId: "second-session" } : r))
  const first = await collect(), second = await collect(request(first.nextCursor))
  expect(first.hasMore).toBe(true)
  expect(second.observations[0]?.session.sourceSessionId).not.toBe(first.observations[0]?.session.sourceSessionId)
  expect(await collect(request(second.nextCursor))).toMatchObject({ observations: [], hasMore: false, nextCursor: second.nextCursor })
  await appendAnswer(firstFile)
  const appended = await collect(request(second.nextCursor))
  expect(appended.observations[0]?.events).toHaveLength(1)
  expect(appended.observations[0]?.session.sourceSessionId).toBe(first.observations[0]?.session.sourceSessionId)
  await discoveredFile("third", records.map(r => r.sessionId ? { ...r, sessionId: "third-session" } : r))
  const third = await collect(request(appended.nextCursor))
  expect(third.observations[0]?.session.sourceSessionId).toBe("third-session")
  expect((await collect(request(third.nextCursor))).observations).toEqual([])
})

it("filters original CWD before reading unrelated bodies and ignores nested subagents and symlinks", async () => {
  const unrelated = await mkdtemp(join(root, "outside-")), configured = join(root, "configured")
  await mkdir(configured)
  context = { ...context, project: { ...context.project, path: configured } }
  const own = records.map(r => r.cwd ? { ...r, cwd: r.parentUuid === null ? configured : unrelated } : r)
  const selected = await discoveredFile("own", own)
  const foreign = await discoveredFile("foreign", records.map(r => r.cwd ? { ...r, cwd: unrelated, sessionId: "foreign" } : r))
  await appendFile(foreign, "broken-json" + "x".repeat(16 * 1024 * 1024 + 1))
  await discoveredFile("unavailable", records.map(r => r.cwd ? { ...r, cwd: join(root, "missing"), sessionId: "unavailable" } : r))
  await discoveredFile("child", own, "nested/subagents")
  await symlink(selected, join(root, "claude-home/projects/not-a-project-path/link.jsonl"))
  await symlink(join(root, "claude-home/projects/not-a-project-path"), join(root, "claude-home/projects/link"), "dir")
  expect((await collect()).observations).toHaveLength(1)
})

it("retains progress across file moves and source deletion without duplicating history", async () => {
  const original = await discoveredFile("original"), first = await collect()
  const moved = original.replace("original.jsonl", "moved.jsonl")
  await rename(original, moved)
  expect((await collect(request(first.nextCursor))).observations).toEqual([])
  await appendAnswer(moved)
  const appended = await collect(request(first.nextCursor))
  expect(appended.observations[0]?.events).toHaveLength(1)
  await rm(moved)
  expect(await collect(request(appended.nextCursor))).toMatchObject({ observations: [], nextCursor: appended.nextCursor })
  await discoveredFile("moved") // Restoring an older prefix is not a new Session.
  expect(await collect(request(appended.nextCursor))).toMatchObject({ observations: [], nextCursor: appended.nextCursor,
    sourceFailures: [{ source: moved, reason: "changed" }] })
})

it.each([false, true])("rejects truncation to zero complete lines (discovery=%s)", async discovery => {
  const path = discovery ? await discoveredFile("source") : file
  const first = await collect()
  await writeFile(path, "")
  if (discovery) expect(await collect(request(first.nextCursor))).toMatchObject({ observations: [], nextCursor: first.nextCursor,
    sourceFailures: [{ source: path, reason: "changed" }] })
  else await expect(collect(request(first.nextCursor))).rejects.toThrow("prefix changed")
})

it("isolates every duplicate identity while collecting an unrelated healthy session", async () => {
  const first = await discoveredFile("first"), copy = await discoveredFile("copy", records, "another-folder")
  await discoveredFile("healthy", records.map(r => r.sessionId ? { ...r, sessionId: "healthy" } : r))
  const page = await collect()
  expect(page.observations.map(o => o.session.sourceSessionId)).toEqual(["healthy"])
  expect(page.sourceFailures).toEqual(expect.arrayContaining([{ source: first, reason: "duplicate" }, { source: copy, reason: "duplicate" }]))
  expect(JSON.parse(page.nextCursor!).sessions).toHaveLength(1)
  await rm(copy)
  expect((await collect(request(page.nextCursor))).observations).toHaveLength(1)
})

it.each(["format", "unsupported", "limit"] as const)("isolates %s sources and retries them after repair without resetting healthy progress", async reason => {
  const bad = await discoveredFile("a-bad")
  const original = await readFile(bad, "utf8")
  if (reason === "format") await appendFile(bad, "broken-json\n")
  if (reason === "unsupported") await appendFile(bad, JSON.stringify({ type: "system", subtype: "compact_boundary" }) + "\n")
  if (reason === "limit") await appendFile(bad, "x".repeat(16 * 1024 * 1024 + 1))
  await discoveredFile("z-healthy", records.map(r => r.sessionId ? { ...r, sessionId: "healthy" } : r))
  const page = await collect()
  expect(page.observations.map(o => o.session.sourceSessionId)).toEqual(["healthy"])
  expect(page.sourceFailures).toEqual([{ source: bad, reason }])
  expect(JSON.parse(page.nextCursor!).sessions).toHaveLength(1)
  expect(await collect(request(page.nextCursor))).toMatchObject({ observations: [], nextCursor: page.nextCursor, hasMore: false,
    sourceFailures: [{ source: bad, reason }] })
  await writeFile(bad, original)
  const repaired = await collect(request(page.nextCursor))
  expect(repaired.observations).toHaveLength(1)
  expect(repaired.sourceFailures).toBeUndefined()
  expect(JSON.parse(repaired.nextCursor!).sessions).toHaveLength(2)
})

it("retains the failed session checkpoint while healthy appends advance, then resumes after exact prefix repair", async () => {
  const bad = await discoveredFile("a-source"), first = await collect(), original = await readFile(bad, "utf8")
  await writeFile(bad, original.replace("ATAPE_TOOL_DONE", "ATAPE_TOOL_FAIL"))
  await discoveredFile("z-healthy", records.map(r => r.sessionId ? { ...r, sessionId: "healthy" } : r))
  const page = await collect(request(first.nextCursor))
  const failedCheckpoint = JSON.parse(first.nextCursor!).sessions[0]
  expect(JSON.parse(page.nextCursor!).sessions).toContainEqual(failedCheckpoint)
  const exhausted = await collect(request(page.nextCursor))
  expect(exhausted).toMatchObject({ observations: [], nextCursor: page.nextCursor, sourceFailures: [{ source: bad, reason: "changed" }] })
  await writeFile(bad, original); await appendAnswer(bad)
  expect((await collect(request(page.nextCursor))).observations[0]?.events).toHaveLength(1)
})

it("bounds header diagnostics without acknowledging broken sources or hiding that more failed", async () => {
  for (let i = 0; i < 35; i++) await writeFile(await discoveredFile(`broken-${i}`), "broken-json\n")
  const page = await collect()
  expect(page).toMatchObject({ observations: [], nextCursor: null, hasMore: false, sourceFailuresTruncated: true })
  expect(page.sourceFailures).toHaveLength(32)
  expect(page.sourceFailures?.every(f => f.reason === "format")).toBe(true)
  const controller = new AbortController(); controller.abort()
  await expect(collect({ ...request(), signal: controller.signal })).rejects.toThrow()
  await expect(collect(request("{}"))).rejects.toThrow("checkpoint")
})

it("does not follow a captured source replaced with a symlink", async () => {
  const path = await discoveredFile("source"), first = await collect()
  await rm(path); await symlink(file, path)
  expect(await collect(request(first.nextCursor))).toMatchObject({ observations: [], nextCursor: first.nextCursor,
    sourceFailures: [{ source: path, reason: "changed" }] })
})

it("carries the selected-file v1 checkpoint into discovery without forgetting committed bytes", async () => {
  const initial = await collect()
  const checkpoint = JSON.parse(initial.nextCursor!).sessions[0].checkpoint
  receipts.set(JSON.stringify(checkpoint), receipts.get(initial.nextCursor!)!)
  const discovered = await discoveredFile("source")
  expect((await collect(request(JSON.stringify(checkpoint)))).observations).toEqual([])
  await appendAnswer(discovered)
  const changed = await collect(request(JSON.stringify(checkpoint)))
  expect(changed.observations[0]?.events).toHaveLength(1)
  expect(JSON.parse(changed.nextCursor!).v).toBe(2)
  expect((await collect(request(changed.nextCursor))).observations).toEqual([])
})

it("compresses multi-session progress without evicting old checkpoints", async () => {
  await discoveredFile("source")
  const first = await collect(), state = JSON.parse(first.nextCursor!)
  const template = state.sessions[0]
  state.sessions = []
  for (let i = 0; ; i++) {
    const session = { file: `/missing/${i}`, checkpoint: { ...template.checkpoint, sessionId: `missing-${i}` } }
    if (Buffer.byteLength(JSON.stringify({ ...state, after: "missing-0", sessions: [...state.sessions, session] })) > 15_900) break
    state.sessions.push(session)
  }
  state.after = "missing-0"
  const page = await collect(request(JSON.stringify(state)))
  expect(page.nextCursor?.startsWith("z3:")).toBe(true)
  const decoded = JSON.parse(inflateRawSync(Buffer.from(page.nextCursor!.slice(3), "base64url")).toString("utf8"))
  expect(decoded.sessions).toHaveLength(state.sessions.length + 1)
  expect(decoded.sessions).toEqual(expect.arrayContaining(state.sessions))
})

it("treats a missing Claude projects directory as an empty source without resetting state", async () => {
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", ""); vi.stubEnv("ATAPE_CLAUDE_HOME", join(root, "absent-home"))
  expect(await collect()).toMatchObject({ observations: [], nextCursor: null, hasMore: false })
})

it("reprojects an old checkpoint once without changing source/session revisions or event IDs", async () => {
  const first = await collect(), old = JSON.parse(first.nextCursor!)
  delete old.sessions[0].checkpoint.projectionRevision
  const upgraded = await collect(request(JSON.stringify(old)))
  expect(upgraded.observations[0]?.session).toEqual(first.observations[0]?.session)
  expect(upgraded.observations[0]?.events.map(e => e.sourceEventId)).toEqual(first.observations[0]?.events.map(e => e.sourceEventId))
  expect(upgraded.observations[0]?.events.every(e => e.projectionRevision === 3)).toBe(true)
  expect((await collect(request(upgraded.nextCursor))).observations).toEqual([])
})

it("resumes a supported checkpoint across package versions but rejects unknown cursor formats and changed prefixes", async () => {
  const first = await collect()
  const upgradedContext = { ...context, adapter: { ...context.adapter, version: "0.2.1" } }
  const upgradedRequest = { ...request(first.nextCursor), previousAdapterVersion: "0.2.0" }
  expect(await collect(upgradedRequest, upgradedContext)).toMatchObject({ observations: [], nextCursor: first.nextCursor })
  await appendAnswer(file)
  expect((await collect(upgradedRequest, upgradedContext)).observations[0]?.events).toHaveLength(1)
  await expect(collect({ ...upgradedRequest, cursor: JSON.stringify({ v: 999 }) }, upgradedContext)).rejects.toThrow("checkpoint")
  await writeFile(file, (await readFile(file, "utf8")).replace("ATAPE_TOOL_DONE", "ATAPE_TOOL_FAIL"))
  await expect(collect(upgradedRequest, upgradedContext)).rejects.toThrow("prefix changed")
})

it("keeps oversized tool values in Raw and marks the projection partial", async () => {
  for (const record of records) {
    const message = record.message as { content?: Array<Record<string, unknown>> } | undefined
    if (Array.isArray(message?.content)) for (const block of message.content) if (block.type === "tool_use") block.input = { large: "x".repeat(65536) }
  }
  await writeFile(file, records.map(r => JSON.stringify(r)).join("\n") + "\n")
  const page = await collect(), event = page.observations[0]!.events[1]!
  expect(event.update).not.toHaveProperty("rawInput")
  expect(event.fidelity).toBe("partial")
  expect(page.observations[0]!.rawSegments[0]!.content).toContain("x".repeat(65536))
})


it("streams a 100 MiB conversation through restartable pages, then publishes only an append", async () => {
  const handle = await open(file, "a")
  let parent = String(records.filter(r => r.uuid).at(-1)!.uuid)
  const sessionId = String(records.find(r => r.parentUuid === null)!.sessionId)
  try {
    for (let i = 0; i < 1100; i++) {
      const uuid = `large-${i}`
      await handle.writeFile(JSON.stringify({ uuid, parentUuid: parent, sessionId, type: "assistant",
        timestamp: "2026-09-09T00:00:00Z", message: { role: "assistant", content: "x".repeat(96 * 1024) } }) + "\n")
      parent = uuid
    }
  } finally { await handle.close() }
  expect((await stat(file)).size).toBeGreaterThan(100 * 1024 * 1024)
  let cursor: string | null = null
  const ids = new Set<string>(), progress: AdapterCollectRequest["rawProgress"][number][] = []
  let uploadedBytes = 0, pages = 0
  do {
    // New runtime on every page exercises durable cursor recovery, not a warm cache.
    const page = await collect({ ...request(cursor), rawProgress: progress })
    expect(Buffer.byteLength(page.nextCursor!)).toBeLessThanOrEqual(1024 * 1024)
    for (const observation of page.observations) {
      expect(observation.events.length).toBeLessThanOrEqual(AdapterCollectionLimits.eventsPerObservation)
      expect(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] }))).toBeLessThan(AdapterCollectionLimits.canonicalBytesPerObservation)
      for (const event of observation.events) { expect(ids.has(event.sourceEventId)).toBe(false); ids.add(event.sourceEventId) }
      for (const raw of observation.rawSegments) {
        expect(raw.sourceOffset).toBe(uploadedBytes)
        uploadedBytes += Buffer.byteLength(raw.content)
        progress.splice(0, progress.length, { sourceSessionId: sessionId, sourceObjectId: raw.sourceObjectId,
          sourceGeneration: raw.sourceGeneration, sourceOffset: uploadedBytes, finalized: false })
      }
    }
    cursor = page.nextCursor; pages++
    if (!page.hasMore) break
    expect(pages).toBeLessThan(100)
  } while (true)
  expect(ids.size).toBe(1106)
  expect(uploadedBytes).toBe((await stat(file)).size)
  await appendFile(file, JSON.stringify({ uuid: "large-append", parentUuid: parent, sessionId, type: "assistant",
    timestamp: "2026-09-09T00:01:00Z", message: { role: "assistant", content: "only the new answer" } }) + "\n")
  const appended = await collect({ ...request(cursor), rawProgress: progress })
  expect(appended.observations[0]?.events.map(e => e.sourceEventId)).toEqual(["large-append:0"])
  expect(appended.observations[0]?.rawSegments[0]?.sourceOffset).toBe(uploadedBytes)
}, 30000)

it("rotates away from a multi-page conversation and resumes an interrupted record", async () => {
  const last = records.filter(r => r.uuid).at(-1)!
  const content = Array.from({ length: 8 }, (_, i) => ({ type: "text", text: `fragment-${i}` }))
  await appendFile(file, JSON.stringify({ ...last, uuid: "many-blocks", parentUuid: last.uuid,
    message: { role: "assistant", content } }) + "\n")
  const runtime = await createAtapeAdapter(context)
  let cursor: string | null = null
  const events: string[] = []
  for (let i = 0; i < 20; i++) {
    const r = { ...request(cursor), limits: { ...AdapterCollectionLimits, eventsPerObservation: 2 } }
    const page = await runtime.collect(r) as AdapterCollectionPage
    const replay = await collect(r)
    expect(replay).toEqual(page)
    events.push(...page.observations.flatMap(o => o.events.map(e => e.sourceEventId)))
    cursor = page.nextCursor
    if (!page.hasMore) break
  }
  expect(events).toHaveLength(14)
  expect(new Set(events).size).toBe(14)
})


it("splits a multi-MiB text record across retryable Canonical pages and preserves blank Raw lines", async () => {
  const last = records.filter(r => r.uuid).at(-1)!
  const text = "大".repeat(1400000)
  await appendFile(file, "\n \n" + JSON.stringify({ ...last, uuid: "large-text", parentUuid: last.uuid,
    message: { role: "assistant", content: text } }) + "\n")
  let cursor: string | null = null
  const fragments: string[] = [], ids = new Set<string>()
  let raw = "", pages = 0
  do {
    const page = await collect(request(cursor))
    expect(await collect(request(cursor))).toEqual(page)
    for (const observation of page.observations) {
      expect(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] }))).toBeLessThan(AdapterCollectionLimits.canonicalBytesPerObservation)
      raw += observation.rawSegments.map(segment => segment.content).join("")
      for (const event of observation.events.filter(e => e.sourceEventId.startsWith("large-text:"))) {
        expect(ids.has(event.sourceEventId)).toBe(false); ids.add(event.sourceEventId)
        if (event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") fragments.push(event.update.content.text)
      }
    }
    cursor = page.nextCursor; pages++
    if (!page.hasMore) break
    expect(pages).toBeLessThan(10)
  } while (true)
  expect(pages).toBeGreaterThan(1)
  expect(fragments.join("")).toBe(text)
  expect(raw).toBe(await readFile(file, "utf8"))
})


it("captures Canonical with Raw disabled and backfills acknowledged Raw independently after enabling", async () => {
  let cursor: string | null = null
  const canonical: string[] = []
  let session: AdapterCollectionPage["observations"][number]["session"] | undefined
  for (let i = 0; i < 20; i++) {
    const page = await collect({ ...request(cursor), rawCaptureEnabled: false, limits: { ...AdapterCollectionLimits, eventsPerObservation: 2 } })
    for (const o of page.observations) { canonical.push(...o.events.map(e => e.sourceEventId)); expect(o.rawSegments).toEqual([]); session = o.session }
    expect(page.progress?.pendingRawBytes).toBe(0)
    cursor = page.nextCursor
    if (!page.hasMore) break
  }
  expect(canonical).toHaveLength(6)
  expect(receipts.get(cursor!) ?? []).toEqual([])
  const r = { ...request(cursor), rawCaptureEnabled: true }
  const backfill = await collect(r)
  expect(backfill.nextCursor).not.toBe(cursor)
  expect(backfill.observations[0]?.events).toEqual([])
  expect(backfill.observations[0]?.session).toEqual(session)
  expect(backfill.observations[0]?.rawSegments[0]?.content).toBe(await readFile(file, "utf8"))
  expect(await collect(r)).toEqual(backfill)
  expect((await collect(request(backfill.nextCursor))).observations).toEqual([])
})

it("backfills unacknowledged Raw after a server denial advanced the Canonical cursor", async () => {
  const first = await collect()
  // The host committed Canonical but received raw_capture_disabled: no Raw receipt.
  const off = await collect({ ...request(first.nextCursor), rawProgress: [], rawCaptureEnabled: false })
  expect(off.observations).toEqual([])
  const retry = { ...request(off.nextCursor), rawProgress: [], rawCaptureEnabled: true }
  const page = await collect(retry)
  expect(page.nextCursor).not.toBe(off.nextCursor)
  expect(page.observations[0]?.events).toEqual([])
  expect(page.observations[0]?.rawSegments[0]?.content).toBe(await readFile(file, "utf8"))
  expect(await collect(retry)).toEqual(page)
})
