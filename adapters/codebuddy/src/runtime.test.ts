import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { SourceCaptureHeader, SourceCapturePage, SourceDiscoveryPage } from "@atape/domain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./runtime.ts"

const roots: string[] = [], runtimes: Awaited<ReturnType<typeof createAtapeAdapter>>[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const signal = () => new AbortController().signal
const limits = { rowBytes: 65536, pageBytes: 262144, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 }
const sourceId = "atape-codebuddy-native-21240"
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "atape-codebuddy-")); roots.push(home)
  const directory = join(home, "projects", "opaque-project-label"), file = join(directory, `${sourceId}.jsonl`)
  await mkdir(directory, { recursive: true })
  const native = await readFile(new URL("./fixtures/native-2.124.0.jsonl", import.meta.url), "utf8")
  await writeFile(file, native)
  vi.stubEnv("ATAPE_CODEBUDDY_HOME", home)
  const lifetime = new AbortController()
  const runtime = await createAtapeAdapter({ protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "codebuddy", version: "0.5.1" }, project: { id: "project", type: "directory", path: "/unrelated/locator" }, signal: lifetime.signal })
  runtimes.push(runtime)
  const request = { sourceId, limits, projection, rawEnabled: true, signal: signal() }
  return { home, directory, file, native, lifetime, runtime, request }
}
const read = async (view: Awaited<ReturnType<Awaited<ReturnType<typeof createAtapeAdapter>>["sourceCapture"]["open"]>>) => {
  const frames: SourceCapturePage["frames"][number][] = []
  for (let i = 0; i < 100; i++) {
    const page = Schema.decodeUnknownSync(SourceCapturePage)(await view.read(signal()))
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(projection.pageBytes)
    expect(page.frames.length).toBeLessThanOrEqual(projection.pageItems)
    frames.push(...page.frames)
    if (page.done) return frames
  }
  throw new Error("Fixture failed to finish")
}
const rows = (native: string) => native.trim().split("\n").map(line => JSON.parse(line))
const serialize = (values: unknown[]) => values.map(row => JSON.stringify(row) + "\n").join("")

describe("CodeBuddy installed runtime Interface", () => {
  it("projects native resume, thoughts, successful and failed tools, and per-response usage with original attribution", async () => {
    const f = await fixture(), before = await stat(f.file)
    const discovery = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(discovery.sources).toEqual([{ sourceId, originKey: expect.any(String), cwd: "/fixture/codebuddy-project" }])
    const view = await f.runtime.sourceCapture.open(f.request)
    Schema.decodeUnknownSync(SourceCaptureHeader)(view)
    expect(view.target).toEqual({ events: 12, usage: 5, threads: 1 })
    expect(view.session.captureStatus).toBe("healthy")
    const frames = await read(view), events = frames.flatMap(f => f.events), usage = frames.flatMap(f => f.usage)
    expect(events.map(e => e.update.sessionUpdate)).toEqual(["user_message_chunk", "agent_thought_chunk", "agent_message_chunk", "user_message_chunk", "tool_call", "tool_call_update", "agent_thought_chunk", "agent_message_chunk", "user_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"])
    expect(events[5]!.update).toMatchObject({ status: "failed", title: "Read", toolCallId: (events[4]!.update as { toolCallId: string }).toolCallId })
    expect(events[10]!.update).toMatchObject({ status: "completed" })
    expect(events[11]!.update).toMatchObject({ content: { text: "ATAPE_CODEBUDDY_TOOL_MARKER_21240" } })
    const expected = rows(f.native).filter(r => r.message?.usage).map(r => r.message.usage)
    expect(usage.reduce((sum, row) => sum + row.inputTokens!, 0)).toBe(expected.reduce((sum, row) => sum + row.input_tokens, 0))
    expect(usage[0]).toMatchObject({ inputTokens: 6210, outputTokens: 40, cacheReadTokens: 512 })
    expect(frames.map(f => (f.raw as { json: string }).json).join("\n") + "\n").toBe(f.native)
    await view.close()
    expect((await stat(f.file)).mtimeMs).toBe(before.mtimeMs)
  })
  it("freezes a view across source appends/deletion; Raw off retains identical canonical identities and no raw payloads", async () => {
    const f = await fixture(), view = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await appendFile(f.file, "unfinished")
    const off = await read(view)
    expect(off.every(frame => frame.raw === undefined)).toBe(true)
    await view.close()
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
    await writeFile(f.file, f.native)
    const fresh = await f.runtime.sourceCapture.open(f.request)
    await rm(f.file)
    const on = await read(fresh)
    expect(on.map(({ raw: _, ...rest }) => rest)).toEqual(off)
    await fresh.close()
    expect((await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }) as SourceDiscoveryPage).sources).toEqual([])
  })
  it("keeps event identities after relocation and later CWD changes", async () => {
    const f = await fixture(), first = await f.runtime.sourceCapture.open(f.request), initial = await read(first)
    await first.close()
    const changed = rows(f.native); for (const row of changed.slice(1)) row.cwd = "/different/project"
    await writeFile(f.file, serialize(changed)); await rename(f.directory, join(f.home, "projects", "relocated"))
    const moved = await f.runtime.sourceCapture.open(f.request)
    expect(moved.origin.cwd).toBe("/fixture/codebuddy-project")
    expect((await read(moved)).flatMap(f => f.events)).toEqual(initial.flatMap(f => f.events))
    await moved.close()
  })
  it("isolates malformed and duplicate discovery sources and advances diagnostic-only pages", async () => {
    const f = await fixture()
    await writeFile(join(f.directory, "000-malformed.jsonl"), "broken\n")
    const first = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(first.sources).toEqual([]); expect(first.sourceFailures[0]?.reason).toBe("format"); expect(first.done).toBe(false)
    const next = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: first.cursor, limits, signal: signal() }))
    expect(next.sources[0]?.sourceId).toBe(sourceId)
    const duplicate = join(f.home, "projects", "duplicate"); await mkdir(duplicate); await copyFile(f.file, join(duplicate, `${sourceId}.jsonl`))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
    const bad = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(bad.sourceFailures[0]?.reason).toBe("duplicate")
  })
  it.each(["fork", "nested-fork"])("captures native %s with copied history, isolated identities and fork-owned attribution", async kind => {
    const f = await fixture(), forkId = `atape-codebuddy-${kind}-21240`
    const file = join(f.directory, `${forkId}.jsonl`), meta = file.replace(/\.jsonl$/, ".meta.json")
    const native = await readFile(new URL(`./fixtures/native-${kind}-2.124.0.jsonl`, import.meta.url), "utf8")
    const metadata = await readFile(new URL("./fixtures/native-fork-2.124.0.meta.json", import.meta.url), "utf8")
    await writeFile(file, native); await writeFile(meta, metadata)
    const rootView = await f.runtime.sourceCapture.open(f.request), rootFrames = await read(rootView)
    await rootView.close()
    let cursor: string | null = null
    const sources: SourceDiscoveryPage["sources"][number][] = []
    do {
      const page = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor, limits, signal: signal() }))
      expect(page.sourceFailures).toEqual([]); sources.push(...page.sources); cursor = page.cursor
    } while (cursor)
    const expectedCwd = kind === "fork" ? "/fixture/codebuddy-project" : "/fixture/codebuddy-fork-project"
    expect(sources.find(source => source.sourceId === forkId)?.cwd).toBe(expectedCwd)
    const view = await f.runtime.sourceCapture.open({ ...f.request, sourceId: forkId })
    expect(view.profile).toBe("codebuddy.cli.jsonl.fork.1")
    expect(view.origin).toEqual(sources.find(source => source.sourceId === forkId))
    expect(view.target).toEqual({ events: kind === "fork" ? 14 : 18, usage: kind === "fork" ? 6 : 8, threads: 1 })
    expect(view.session.title).toBe(rows(native).find(row => row.sessionId === forkId).content[0].text)
    const origin = view.origin, frames = await read(view), events = frames.flatMap(frame => frame.events)
    const content = (event: typeof events[number]) => { const { toolCallId: _, ...value } = event.update as typeof event.update & { toolCallId?: string }; return value }
    expect(events.slice(0, 12).map(content)).toEqual(rootFrames.flatMap(frame => frame.events).map(content))
    expect(events[5]!.update).toMatchObject({ toolCallId: (events[4]!.update as { toolCallId: string }).toolCallId })
    expect(events.every(event => !rootFrames.flatMap(frame => frame.events).some(root => root.sourceEventId === event.sourceEventId))).toBe(true)
    expect(frames[0]!.raw).toMatchObject({ sidecar: { format: "codebuddy.meta.v1", json: metadata } })
    expect(frames.map(frame => (frame.raw as { json: string }).json).join("\n") + "\n").toBe(native)
    await view.close()
    // The source snapshot is self-contained even without the original parent.
    await rm(f.file)
    const offView = await f.runtime.sourceCapture.open({ ...f.request, sourceId: forkId, rawEnabled: false })
    await rm(meta); await rm(file)
    const off = await read(offView)
    expect(off).toEqual(frames.map(({ raw: _, ...frame }) => frame))
    expect(offView.origin).toEqual(origin)
    await offView.close()
    await writeFile(file, native)
    await expect(f.runtime.sourceCapture.open({ ...f.request, sourceId: forkId })).rejects.toMatchObject({ reason: "unsupported" })
  })
  it.each(["parent", "prefix-only", "foreign-suffix", "assistant-transition", "meta-shape", "meta-limit"])("rejects an unproven fork %s", async variant => {
    const f = await fixture(), forkId = "atape-codebuddy-fork-21240", file = join(f.directory, `${forkId}.jsonl`)
    const values = rows(await readFile(new URL("./fixtures/native-fork-2.124.0.jsonl", import.meta.url), "utf8"))
    let meta: object = { forkedFrom: sourceId }
    if (variant === "parent") meta = { forkedFrom: "unrelated" }
    if (variant === "prefix-only") values.splice(15)
    if (variant === "foreign-suffix") values.push({ ...values.at(-1), id: "foreign", parentId: values.at(-1).id, sessionId: "unrelated", role: "user" })
    if (variant === "assistant-transition") values.at(-1).sessionId = sourceId
    if (variant === "meta-shape") meta = { forkedFrom: sourceId, forkedAt: 1 }
    await writeFile(file, serialize(values))
    await writeFile(file.replace(/\.jsonl$/, ".meta.json"), variant === "meta-limit" ? "x".repeat(65537) : JSON.stringify(meta))
    await expect(f.runtime.sourceCapture.open({ ...f.request, sourceId: forkId })).rejects.toMatchObject({ reason: variant === "prefix-only" ? "attribution" : variant === "meta-limit" ? "limit" : "unsupported" })
  })
  it.each([false, true])("captures native manual/automatic compaction and continued history (fork=%s)", async fork => {
    const f = await fixture(), compactId = `atape-codebuddy-compact${fork ? "-fork" : ""}-21240`
    const file = join(f.directory, `${compactId}.jsonl`), meta = file.replace(/\.jsonl$/, ".meta.json")
    const native = await readFile(new URL(`./fixtures/native-compaction${fork ? "-fork" : ""}-2.124.0.jsonl`, import.meta.url), "utf8")
    if (fork) await copyFile(new URL("./fixtures/native-compaction-fork-2.124.0.meta.json", import.meta.url), meta)
    let initial: SourceCapturePage["frames"][number][] = []
    if (!fork) {
      await writeFile(file, serialize(rows(native).slice(0, 4)))
      const view = await f.runtime.sourceCapture.open({ ...f.request, sourceId: compactId })
      initial = await read(view); await view.close()
    }
    await writeFile(file, native)
    const view = await f.runtime.sourceCapture.open({ ...f.request, sourceId: compactId })
    expect(view.profile).toBe(`codebuddy.cli.jsonl.${fork ? "fork." : ""}compaction.1`)
    expect(view.origin.cwd).toBe("/fixture/codebuddy-compact-project")
    expect(view.target).toEqual({ events: fork ? 12 : 10, usage: fork ? 5 : 4, threads: 1 })
    const origin = view.origin, frames = await read(view), events = frames.flatMap(frame => frame.events)
    if (!fork) expect(events.slice(0, 3)).toEqual(initial.flatMap(frame => frame.events))
    expect(frames[4]!.events[0]!.update).toMatchObject({ sessionUpdate: "user_message_chunk", content: { text: "/compact Keep the summary short: retain only the marker ATAPE_COMPACT_SEED_21240." } })
    expect(frames[6]!.events[0]!.update).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: expect.stringContaining("<conversation_history_summary>") } })
    expect(frames[10]!.events).toEqual([]) // Engine-generated context is not a user turn.
    expect(frames[10]!.raw).toMatchObject({ json: expect.stringContaining("logicalParentId") })
    expect(frames.map(frame => (frame.raw as { json: string }).json).join("\n") + "\n").toBe(native)
    expect(frames.flatMap(frame => frame.usage)).toHaveLength(fork ? 5 : 4)
    const last = events.at(-1)!.update
    expect(last).toMatchObject({ content: { text: expect.stringContaining(fork ? "ATAPE_COMPACT_FORK_21240" : "ATAPE_AUTO_COMPACT_21240") } })
    await view.close()
    const off = await f.runtime.sourceCapture.open({ ...f.request, sourceId: compactId, rawEnabled: false })
    await rm(file); if (fork) await rm(meta)
    expect(off.origin).toEqual(origin)
    expect(await read(off)).toEqual(frames.map(({ raw: _, ...frame }) => frame))
    await off.close()
  })
  it.each(["pending", "command", "summary", "logical-parent", "missing-prefix", "emergency", "model-summary", "interrupted"])("rejects unproven compaction %s without a partial view", async variant => {
    const f = await fixture(), compactId = "atape-codebuddy-compact-21240", file = join(f.directory, `${compactId}.jsonl`)
    const values = rows(await readFile(new URL("./fixtures/native-compaction-2.124.0.jsonl", import.meta.url), "utf8"))
    if (variant === "pending") values.splice(6)
    if (variant === "command") delete values[4].content[0].providerData.content
    if (variant === "summary") values[6].content[0].text = "unfinished summary"
    if (variant === "logical-parent") values[10].logicalParentId = values[0].id
    if (variant === "missing-prefix") values.splice(0, 10)
    if (variant === "emergency") values[10].providerData.compactType = "emergency-auto"
    if (variant === "model-summary") values[10].providerData.isSummary = true
    if (variant === "interrupted") values[6].providerData.agent = "cli"
    await writeFile(file, serialize(values))
    await expect(f.runtime.sourceCapture.open({ ...f.request, sourceId: compactId })).rejects.toMatchObject({ reason: variant === "pending" ? "format" : "unsupported" })
  })
  const family = async () => {
    const f = await fixture(), familyId = "atape-codebuddy-child-21240"
    await cp(new URL("./fixtures/native-family-2.124.0", import.meta.url), f.directory, { recursive: true })
    const parent = join(f.directory, `${familyId}.jsonl`), child = join(f.directory, familyId, "subagents", "agent-6b64fa37.jsonl")
    return { ...f, parent, child, parentRows: rows(await readFile(parent, "utf8")), childRows: rows(await readFile(child, "utf8")), request: { ...f.request, sourceId: familyId } }
  }
  it("captures native child resume, nested children and parent compaction through stable linked Threads", async () => {
    const f = await family()
    // Unreferenced child files are present throughout; only native receipts admit them.
    await writeFile(f.parent, serialize(f.parentRows.slice(0, 6))); await writeFile(f.child, serialize(f.childRows.slice(0, 3)))
    const initial = await f.runtime.sourceCapture.open(f.request), before = await read(initial), origin = initial.origin
    expect(initial.target).toEqual({ events: 8, usage: 3, threads: 2 }); await initial.close()
    await writeFile(f.parent, serialize(f.parentRows.slice(0, 11))); await writeFile(f.child, serialize(f.childRows))
    const resumed = await f.runtime.sourceCapture.open(f.request), resumedFrames = await read(resumed)
    expect(resumed.target).toEqual({ events: 15, usage: 6, threads: 2 }); expect(resumed.origin).toEqual(origin)
    const firstChild = before.flatMap(frame => frame.events).filter(event => event.sourceThreadId === "agent-6b64fa37")
    expect(resumedFrames.flatMap(frame => frame.events).filter(event => event.sourceThreadId === "agent-6b64fa37").slice(0, 3)).toEqual(firstChild)
    await resumed.close(); await writeFile(f.parent, serialize(f.parentRows))
    const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    Schema.decodeUnknownSync(SourceCaptureHeader)(view)
    expect(view.profile).toBe("codebuddy.cli.jsonl.family.1"); expect(view.target).toEqual({ events: 37, usage: 15, threads: 5 })
    expect(view.threads.map(thread => [thread.sourceThreadId, thread.parentSourceThreadId])).toEqual([
      [f.request.sourceId, undefined], ["agent-6b64fa37", f.request.sourceId], ["agent-60a8b853", f.request.sourceId], ["agent-64db2ff8", f.request.sourceId], ["agent-bc513377", "agent-60a8b853"]
    ])
    const events = frames.flatMap(frame => frame.events), usage = frames.flatMap(frame => frame.usage)
    expect(events.map(event => [event.sourceOrder, event.eventIndex])).toEqual(events.map((_, index) => [index, index]))
    expect(events.filter(event => event.childSourceThreadId).map(event => event.childSourceThreadId)).toEqual(["agent-6b64fa37", "agent-6b64fa37", "agent-60a8b853", "agent-bc513377", "agent-64db2ff8"])
    expect(events.filter(event => event.sourceThreadId === "agent-6b64fa37").slice(0, 3)).toEqual(firstChild)
    expect(events.filter(event => event.sourceThreadId === "agent-bc513377").at(-1)!.update).toMatchObject({ content: { text: "ATAPE_LEAF_21240" } })
    expect(usage.reduce((n, row) => n + (row.inputTokens ?? 0), 0)).toBe(108859)
    expect(usage.reduce((n, row) => n + (row.outputTokens ?? 0), 0)).toBe(2886)
    expect(usage.reduce((n, row) => n + (row.cacheReadTokens ?? 0), 0)).toBe(57664)
    expect(usage.filter(row => row.sourceThreadId === "agent-6b64fa37")).toHaveLength(2)
    expect(frames.filter(frame => (frame.raw as { sourceThreadId?: string }).sourceThreadId)).toHaveLength(17)
    await view.close()
    const changed = f.childRows.map(row => ({ ...row, cwd: "/foreign/child-cwd" }))
    await writeFile(f.child, serialize(changed)); await rename(f.directory, join(f.home, "projects", "moved"))
    const moved = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await rm(join(f.home, "projects"), { recursive: true })
    expect(moved.origin).toEqual(origin)
    expect(await read(moved)).toEqual(frames.map(({ raw: _, ...frame }) => frame))
    await moved.close()
  })
  it.each(["missing", "truncated", "prompt", "after", "last", "identity", "extra-turn", "pending", "path", "symlink", "background", "fork"])("refuses an incomplete or unproven child family: %s", async variant => {
    const f = await family()
    let reason = "unsupported"
    if (variant === "missing") { await rm(f.child); reason = "io" }
    if (variant === "truncated") { await appendFile(f.child, "unfinished"); reason = "format" }
    if (variant === "prompt") f.parentRows[3].arguments = JSON.stringify({ ...JSON.parse(f.parentRows[3].arguments), prompt: "different prompt" })
    if (variant === "after") f.parentRows[9].providerData.toolResult.subAgent.afterId = "not-the-previous-turn"
    if (variant === "last") { f.parentRows[4].providerData.toolResult.subAgent.lastId = "missing-record"; reason = "format" }
    if (variant === "identity") { f.childRows[2].sessionId = "foreign"; await writeFile(f.child, serialize(f.childRows)) }
    if (variant === "extra-turn") { await appendFile(f.child, serialize([{ ...f.childRows[0], id: "unacknowledged", parentId: f.childRows.at(-1).id }])); reason = "format" }
    if (variant === "pending") { f.parentRows.splice(4); reason = "format" }
    if (variant === "path") { f.parentRows[4].providerData.toolResult.subAgent.sessionId = "../outside"; reason = "format" }
    if (variant === "symlink") { const saved = join(f.home, "outside.jsonl"); await rename(f.child, saved); await symlink(saved, f.child); reason = "io" }
    if (variant === "background") f.parentRows[3].arguments = JSON.stringify({ ...JSON.parse(f.parentRows[3].arguments), run_in_background: true })
    if (variant === "fork") {
      const forkId = "family-fork"
      f.parentRows.push({ ...f.parentRows[0], id: "fork-owned", parentId: f.parentRows.at(-1).id, sessionId: forkId })
      f.parent = join(f.directory, `${forkId}.jsonl`); f.request.sourceId = forkId
      await writeFile(f.parent.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ forkedFrom: "atape-codebuddy-child-21240" }))
    }
    await writeFile(f.parent, serialize(f.parentRows))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason })
  })
  const background = async () => {
    const f = await fixture(), backgroundId = "atape-codebuddy-background-21240"
    await cp(new URL("./fixtures/native-background-2.124.0", import.meta.url), f.directory, { recursive: true })
    const parent = join(f.directory, `${backgroundId}.jsonl`), child = join(f.directory, backgroundId, "subagents", "agent-aeb3d60f.jsonl")
    const reporter = join(f.directory, backgroundId, "subagents", "agent-93604b67.jsonl")
    return { ...f, parent, child, reporter, parentRows: rows(await readFile(parent, "utf8")), childRows: rows(await readFile(child, "utf8")), request: { ...f.request, sourceId: backgroundId } }
  }
  it("captures completed native background launches and ordinary parent resume without inventing inbox messages", async () => {
    const f = await background()
    await writeFile(f.parent, serialize(f.parentRows.slice(0, 9)))
    const first = await f.runtime.sourceCapture.open(f.request), before = await read(first), origin = first.origin
    expect(first.target).toEqual({ events: 11, usage: 4, threads: 2 }); await first.close()
    await writeFile(f.parent, serialize(f.parentRows))
    const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    Schema.decodeUnknownSync(SourceCaptureHeader)(view)
    expect(view.profile).toBe("codebuddy.cli.jsonl.family.background.1")
    expect(view.target).toEqual({ events: 24, usage: 9, threads: 3 })
    expect(view.origin).toEqual(origin); expect(view.origin.cwd).toBe("/fixture/codebuddy-background-project")
    expect(view.threads.map(thread => [thread.sourceThreadId, thread.parentSourceThreadId])).toEqual([
      [f.request.sourceId, undefined], ["agent-aeb3d60f", f.request.sourceId], ["agent-93604b67", f.request.sourceId]
    ])
    const events = frames.flatMap(frame => frame.events), usage = frames.flatMap(frame => frame.usage)
    expect(events.slice(0, 11)).toEqual(before.flatMap(frame => frame.events))
    expect(events.map(event => [event.sourceOrder, event.eventIndex])).toEqual(events.map((_, index) => [index, index]))
    expect(events.filter(event => event.childSourceThreadId).map(event => event.childSourceThreadId)).toEqual(["agent-aeb3d60f", "agent-93604b67"])
    const childEvents = events.filter(event => event.sourceThreadId === "agent-aeb3d60f")
    expect(childEvents[0]!.update).toMatchObject({ content: { text: "Reply exactly ATAPE_BACKGROUND_CHILD_21240. Do not use tools." } })
    expect(childEvents.at(-1)!.occurredAt > before.flatMap(frame => frame.events).at(-1)!.occurredAt).toBe(true)
    expect(events.filter(event => event.sourceThreadId === f.request.sourceId && event.update.sessionUpdate === "user_message_chunk")).toHaveLength(3)
    expect(JSON.stringify(events.map(event => event.update))).not.toContain("<teammate-message")
    expect(events.filter(event => event.sourceThreadId === "agent-93604b67").map(event => event.update)).toContainEqual(expect.objectContaining({ title: "SendMessage", status: "completed" }))
    expect(usage.reduce((n, row) => n + (row.inputTokens ?? 0), 0)).toBe(74371)
    expect(usage.reduce((n, row) => n + (row.outputTokens ?? 0), 0)).toBe(1162)
    expect(usage.reduce((n, row) => n + (row.cacheReadTokens ?? 0), 0)).toBe(43072)
    expect(usage.filter(row => row.sourceThreadId === "agent-93604b67")).toHaveLength(2)
    expect(frames.find(frame => (frame.raw as { sourceThreadId?: string }).sourceThreadId === "agent-aeb3d60f")!.raw).toMatchObject({
      sourceSessionId: f.request.sourceId, json: expect.stringContaining('<teammate-message teammate_id=')
    })
    await view.close()
    await writeFile(f.child, serialize(f.childRows.map(row => ({ ...row, cwd: "/foreign/child-cwd" }))))
    await rename(f.directory, join(f.home, "projects", "moved"))
    const frozen = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await rm(join(f.home, "projects"), { recursive: true })
    expect(frozen.origin).toEqual(origin)
    expect(await read(frozen)).toEqual(frames.map(({ raw: _, ...frame }) => frame))
    await frozen.close()
  })
  it.each(["pending-launch", "pending-child", "missing", "truncated", "wrapper", "renderer", "team", "prompt", "path", "named", "resume", "failed", "extra-turn", "compaction", "inbox", "duplicate-launch", "child-delegation"])("refuses an unproven background target: %s", async variant => {
    const f = await background(), spawn = f.parentRows[4].providerData.toolResult.renderer
    let reason = "unsupported"
    if (variant === "pending-launch") { f.parentRows.splice(4); reason = "format" }
    if (variant === "pending-child") { f.childRows.splice(1); reason = "format" }
    if (variant === "missing") { await rm(f.child); reason = "io" }
    if (variant === "wrapper") f.childRows[0].content[0].text = "unproven task"
    if (variant === "renderer") spawn.type = "unknown-spawn"
    if (variant === "team") spawn.value = JSON.stringify({ ...JSON.parse(spawn.value), teamName: "unrelated" })
    if (variant === "prompt") spawn.value = JSON.stringify({ ...JSON.parse(spawn.value), prompt: "unrelated" })
    if (variant === "path") { spawn.value = JSON.stringify({ ...JSON.parse(spawn.value), taskId: "../outside" }); reason = "format" }
    if (variant === "named" || variant === "resume") f.parentRows[3].arguments = JSON.stringify({ ...JSON.parse(f.parentRows[3].arguments), [variant === "named" ? "name" : "resume"]: "agent-aeb3d60f" })
    if (variant === "failed") f.parentRows[4].status = "failed"
    if (variant === "extra-turn") { f.childRows.push({ ...f.childRows[0], id: "extra-turn", parentId: f.childRows.at(-1).id }); reason = "format" }
    if (variant === "compaction") f.childRows[2].providerData.isCompacted = true
    if (variant === "inbox") f.parentRows[15].content[0].text = '<teammate-message teammate_id="atape-reporter-1">notice</teammate-message>'
    if (variant === "child-delegation") {
      const foreground = rows(await readFile(new URL("./fixtures/native-family-2.124.0/atape-codebuddy-child-21240.jsonl", import.meta.url), "utf8"))
      f.childRows[2].parentId = foreground[4].id
      f.childRows.splice(2, 0, ...foreground.slice(3, 5).map((row, index) => ({ ...row, sessionId: f.childRows[0].sessionId,
        parentId: index === 0 ? f.childRows[1].id : foreground[3].id, providerData: { ...row.providerData, agent: "atape-background" } })))
    }
    if (variant === "duplicate-launch") {
      f.parentRows[12].arguments = f.parentRows[3].arguments
      f.parentRows[13].providerData.toolResult.renderer = spawn
    }
    await writeFile(f.parent, serialize(f.parentRows))
    if (variant !== "missing") await writeFile(f.child, serialize(f.childRows) + (variant === "truncated" ? "unfinished" : ""))
    if (variant === "truncated") reason = "format"
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason })
  })
  const backgroundTurns = async () => {
    const f = await fixture(), id = "atape-codebuddy-background-turns-21240"
    await cp(new URL("./fixtures/native-background-turns-2.124.0", import.meta.url), f.directory, { recursive: true })
    const parent = join(f.directory, `${id}.jsonl`), child = join(f.directory, id, "subagents", "agent-6004ad24.jsonl")
    return { ...f, parent, child, parentRows: rows(await readFile(parent, "utf8")), childRows: rows(await readFile(child, "utf8")), request: { ...f.request, sourceId: id } }
  }
  it("preserves one background child through SendMessage reactivation, native notices and foreground resume", async () => {
    const f = await backgroundTurns()
    let previous: SourceCapturePage["frames"][number][] = [], origin: unknown
    for (const [parentRows, childRows, events, usage] of [[6, 3, 8, 3], [11, 6, 15, 6], [15, 6, 17, 7], [20, 9, 24, 10]]) {
      await writeFile(f.parent, serialize(f.parentRows.slice(0, parentRows))); await writeFile(f.child, serialize(f.childRows.slice(0, childRows)))
      const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view), captured = frames.flatMap(frame => frame.events)
      Schema.decodeUnknownSync(SourceCaptureHeader)(view)
      expect(view.target).toEqual({ events, usage, threads: 2 })
      expect(view.profile).toBe(`codebuddy.cli.jsonl.family.background${parentRows! > 6 ? ".turns" : ""}.1`)
      expect(view.session.captureStatus).toBe("healthy")
      origin ??= view.origin; expect(view.origin).toEqual(origin)
      expect(captured.slice(0, previous.flatMap(frame => frame.events).length)).toEqual(previous.flatMap(frame => frame.events))
      expect(captured.map(event => [event.sourceOrder, event.eventIndex])).toEqual(captured.map((_, index) => [index, index]))
      previous = frames; await view.close()
    }
    const events = previous.flatMap(frame => frame.events), usage = previous.flatMap(frame => frame.usage)
    expect(events.filter(event => event.childSourceThreadId).map(event => [event.update.sessionUpdate, event.childSourceThreadId])).toEqual([
      ["tool_call", "agent-6004ad24"], ["tool_call", "agent-6004ad24"], ["tool_call", "agent-6004ad24"]
    ])
    const childUsers = events.filter(event => event.sourceThreadId === "agent-6004ad24" && event.update.sessionUpdate === "user_message_chunk")
    expect(childUsers.map(event => (event.update as { content: { text: string } }).content.text)).toEqual([
      "Reply exactly ATAPE_BG_FIRST_21240. Do not use tools.", "Reply exactly ATAPE_BG_SECOND_21240. Do not use tools.", "Reply exactly ATAPE_BG_RESUME_21240. Do not use tools."
    ])
    expect(events.filter(event => event.sourceThreadId === f.request.sourceId && event.update.sessionUpdate === "user_message_chunk")).toHaveLength(3)
    for (const at of [11, 12]) {
      const notice = previous.find(frame => (frame.raw as { recordId: string }).recordId === f.parentRows[at].id)!
      expect(notice.events).toEqual([]); expect(notice.usage).toEqual([])
      expect(notice.raw).toMatchObject({ json: JSON.stringify(f.parentRows[at]) })
    }
    expect(usage.filter(row => row.sourceThreadId === "agent-6004ad24")).toHaveLength(3)
    expect(usage.reduce((n, row) => n + (row.inputTokens ?? 0), 0)).toBe(100306)
    expect(usage.reduce((n, row) => n + (row.outputTokens ?? 0), 0)).toBe(801)
    expect(usage.reduce((n, row) => n + (row.cacheReadTokens ?? 0), 0)).toBe(74880)
    // Supported framework context changes remain independent of Canonical data.
    f.parentRows[12].content[0].text = f.parentRows[12].content[0].text.replace("Duration: 2s", "Duration: 902s")
    await writeFile(f.parent, serialize(f.parentRows))
    await writeFile(f.child, serialize(f.childRows.map(row => ({ ...row, cwd: "/foreign/child-cwd" }))))
    await rename(f.directory, join(f.home, "projects", "moved"))
    const off = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await rm(join(f.home, "projects"), { recursive: true })
    expect(off.origin).toEqual(origin)
    expect(await read(off)).toEqual(previous.map(({ raw: _, ...frame }) => frame))
    await off.close()
  })
  it.each(["pending-receipt", "pending-child", "missing-turn", "routing", "renderer", "unregistered", "recipient", "broadcast", "wrapper", "overlap", "resume-boundary", "notice-metadata", "notice-sender", "notice-body", "notice-status", "duplicate-name"])("refuses unproven background continuation: %s", async variant => {
    const f = await backgroundTurns()
    let reason = "unsupported"
    if (variant === "pending-receipt") { f.parentRows.splice(9); reason = "format" }
    if (variant === "pending-child") { f.childRows.splice(7); reason = "format" }
    if (variant === "missing-turn") { f.childRows.splice(6); reason = "format" }
    const result = f.parentRows[9]?.providerData?.toolResult
    if (variant === "routing") result.content = JSON.stringify({ ...JSON.parse(result.content), routing: { ...JSON.parse(result.content).routing, content: "different task" } })
    if (variant === "renderer") result.renderer.value = JSON.stringify({ ...JSON.parse(result.renderer.value), sender: "unknown" })
    if (variant === "unregistered") result.content = JSON.stringify({ ...JSON.parse(result.content), notice: "pending registration" })
    if (variant === "recipient" || variant === "broadcast") f.parentRows[8].arguments = JSON.stringify({ ...JSON.parse(f.parentRows[8].arguments), ...(variant === "recipient" ? { recipient: "unrelated" } : { type: "broadcast" }) })
    if (variant === "wrapper") f.childRows[3].content[0].text = "unwrapped task"
    if (variant === "overlap") f.parentRows[8].timestamp = f.childRows[2].timestamp - 1
    if (variant === "resume-boundary") f.parentRows[18].providerData.toolResult.subAgent.afterId = f.childRows[2].id
    if (variant === "notice-metadata") delete f.parentRows[11].providerData.teammateMessage
    if (variant === "notice-sender") f.parentRows[11].providerData.teammateMessage.from = "unrelated"
    if (variant === "notice-body") f.parentRows[11].content[0].text += "Additional unproven instructions"
    if (variant === "notice-status") f.parentRows[12].content[0].text = f.parentRows[12].content[0].text.replace("completed successfully", "failed")
    if (variant === "duplicate-name") {
      const call = structuredClone(f.parentRows[3]), receipt = structuredClone(f.parentRows[4])
      call.id = "another-launch"; call.callId = "another-call"; call.parentId = f.parentRows[5].id
      receipt.id = "another-result"; receipt.callId = call.callId; receipt.parentId = call.id
      const renderer = receipt.providerData.toolResult.renderer
      renderer.value = JSON.stringify({ ...JSON.parse(renderer.value), taskId: "agent-another" })
      f.parentRows[6].parentId = receipt.id
      f.parentRows.splice(6, 0, call, receipt)
    }
    await writeFile(f.parent, serialize(f.parentRows)); await writeFile(f.child, serialize(f.childRows))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason })
  })
  const emergencyFamily = async () => {
    const f = await fixture(), id = "atape-codebuddy-child-compact-21240"
    await cp(new URL("./fixtures/native-emergency-2.124.0", import.meta.url), f.directory, { recursive: true })
    const parent = join(f.directory, id + ".jsonl"), child = join(f.directory, id, "subagents", "agent-1fc648c0.jsonl")
    return { ...f, parent, child, parentRows: rows(await readFile(parent, "utf8")), childRows: rows(await readFile(child, "utf8")),
      request: { ...f.request, sourceId: id, limits: { ...limits, rowBytes: 131072 } } }
  }
  it("retains native parent/child emergency history, resumes one child and keeps internal context Raw-only", async () => {
    const f = await emergencyFamily()
    let previous: SourceCapturePage["frames"][number][] = []
    for (const [parentCount, childCount, events, usage] of [[6, 3, 8, 3], [14, 8, 18, 7], [20, 18, 31, 12], [25, 21, 38, 15]] as const) {
      await writeFile(f.parent, serialize(f.parentRows.slice(0, parentCount)))
      await writeFile(f.child, serialize(f.childRows.slice(0, childCount)))
      const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
      expect(view.target).toEqual({ events, usage, threads: 2 })
      expect(view.profile).toBe(parentCount === 6 ? "codebuddy.cli.jsonl.family.1" : "codebuddy.cli.jsonl.family.emergency.1")
      // The native Read results explicitly spill large output; the Adapter never follows those files.
      expect(view.session.captureStatus).toBe(childCount >= 18 ? "partial" : "healthy")
      expect(frames.flatMap(frame => frame.events).slice(0, previous.flatMap(frame => frame.events).length)).toEqual(previous.flatMap(frame => frame.events))
      previous = frames; await view.close()
    }
    const events = previous.flatMap(frame => frame.events), usage = previous.flatMap(frame => frame.usage)
    expect(events.map(event => [event.sourceOrder, event.eventIndex])).toEqual(events.map((_, index) => [index, index]))
    expect(events.filter(event => event.childSourceThreadId).map(event => event.childSourceThreadId)).toEqual(Array(4).fill("agent-1fc648c0"))
    expect(events.filter(event => event.update.sessionUpdate === "user_message_chunk")).toHaveLength(8)
    expect(events.filter(event => event.sourceThreadId === "agent-1fc648c0").at(-1)!.update).toMatchObject({ content: { text: "ATAPE_CHILD_AFTER_COMPACT_21240" } })
    const contexts = previous.filter(frame => JSON.parse((frame.raw as { json: string }).json).providerData?.isCompactInternal)
    expect(contexts).toHaveLength(4)
    expect(contexts.every(frame => frame.events.length === 0 && frame.usage.length === 0)).toBe(true)
    expect(usage).toHaveLength(15); expect(usage.filter(row => row.sourceThreadId === "agent-1fc648c0")).toHaveLength(7)
    expect(usage.reduce((n, row) => n + (row.inputTokens ?? 0), 0)).toBe(151085)
    expect(usage.reduce((n, row) => n + (row.outputTokens ?? 0), 0)).toBe(1795)
    expect(usage.reduce((n, row) => n + (row.cacheReadTokens ?? 0), 0)).toBe(75840)
    f.childRows[11].content[0].text = f.childRows[11].content[0].text.replace("</conversation_history_summary>", "EmergencyRawOnlyNeedle</conversation_history_summary>")
    await writeFile(f.child, serialize(f.childRows.map(row => ({ ...row, cwd: "/foreign/child-cwd" }))))
    const off = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await rm(f.parent); await rm(f.child)
    expect(await read(off)).toEqual(previous.map(({ raw: _, ...frame }) => frame)); await off.close()
  })
  it.each(["root-summary-pending", "child-summary-pending", "root-continue", "child-intent", "summary-parent", "continue-parent", "summary-wrapper", "flags", "context-usage", "extra-human", "child-manual", "child-pre-message"])("refuses incomplete or unproven emergency compaction: %s", async variant => {
    const f = await emergencyFamily()
    let reason = "unsupported"
    if (variant === "root-summary-pending") { f.parentRows.splice(11); f.childRows.splice(8); reason = "format" }
    if (variant === "child-summary-pending") { f.parentRows.splice(20); f.childRows.splice(12); reason = "format" }
    if (variant === "root-continue") f.parentRows[11].content[0].text = "Unproven continue instruction"
    if (variant === "child-intent") f.childRows[12].content[0].text = f.childRows[12].content[0].text.replace("offset 1", "offset 2")
    if (variant === "summary-parent") f.childRows[11].logicalParentId = f.childRows[8].id
    if (variant === "continue-parent") f.childRows[12].logicalParentId = f.childRows[10].id
    if (variant === "summary-wrapper") f.childRows[11].content[0].text = "unwrapped summary"
    if (variant === "flags") f.childRows[11].providerData.isSummary = false
    if (variant === "context-usage") f.childRows[11].message = { usage: { input_tokens: 1 } }
    if (variant === "extra-human") { delete f.childRows[12].providerData.isCompactInternal; reason = "format" }
    if (variant === "child-manual") f.childRows[11].providerData.agent = "compact"
    if (variant === "child-pre-message") f.childRows[11].providerData.compactType = "pre-message-auto"
    await writeFile(f.parent, serialize(f.parentRows)); await writeFile(f.child, serialize(f.childRows))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason })
  })
  it.each(["threads", "records", "bytes"])("applies %s limits to the complete family", async variant => {
    const f = await family()
    if (variant === "threads") f.request.limits = { ...limits, threads: 3 }
    if (variant === "records") f.request.limits = { ...limits, records: 24 }
    if (variant === "bytes") {
      f.request.limits = { ...limits, rowBytes: 16 * 1024 * 1024 }
      f.parentRows[0].padding = "x".repeat(8 * 1024 * 1024); f.childRows[0].padding = "x".repeat(8 * 1024 * 1024)
      await writeFile(f.parent, serialize(f.parentRows)); await writeFile(f.child, serialize(f.childRows))
    }
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "limit" })
  })
  it.each(["fork", "compaction", "branch", "foreign", "revision", "missing-origin"])("rejects %s without returning an incomplete target", async variant => {
    const f = await fixture(), values = rows(f.native)
    if (variant === "fork") await writeFile(f.file.replace(/\.jsonl$/, ".meta.json"), await readFile(new URL("./fixtures/native-fork-2.124.0.meta.json", import.meta.url), "utf8"))
    if (variant === "compaction") values[2].logicalParentId = values[0].id
    if (variant === "branch") values[4].parentId = values[0].id
    if (variant === "foreign") values[4].sessionId = "other"
    if (variant === "revision") values.push({ ...values[3], content: [] })
    if (variant === "missing-origin") delete values[0].cwd
    await writeFile(f.file, serialize(values))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: variant === "missing-origin" ? "attribution" : "unsupported" })
  })
  it.each(["row", "records", "events", "page", "source"])("enforces %s bounds before a view escapes", async variant => {
    const f = await fixture()
    if (variant === "row") f.request.limits = { ...limits, rowBytes: 100 }
    if (variant === "records") f.request.limits = { ...limits, records: 3 }
    if (variant === "events") f.request.projection = { ...projection, events: 2 }
    if (variant === "page") f.request.projection = { ...projection, pageBytes: 100 }
    if (variant === "source") await writeFile(f.file, " ".repeat(16 * 1024 * 1024 + 1))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "limit" })
  })
  it("releases its view on close/cancellation, rejects overlapping opens, and ignores a repeated old close", async () => {
    const f = await fixture(), first = await f.runtime.sourceCapture.open(f.request)
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "closed" })
    await first.close(); const second = await f.runtime.sourceCapture.open(f.request); await first.close()
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "closed" })
    f.lifetime.abort()
    await expect(second.read(signal())).rejects.toBeDefined()
    await expect(f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() })).rejects.toBeDefined()
  })
  it("deduplicates native response usage across tool calls and keeps copied usage out of unrelated Sessions", async () => {
    const f = await fixture(), values = rows(f.native)
    const call = values[6], another = { ...call, id: "parallel-call", callId: "parallel-call-id", parentId: call.id }
    values.splice(7, 0, another); values[8].parentId = another.id
    await writeFile(f.file, serialize(values))
    const view = await f.runtime.sourceCapture.open(f.request)
    expect(view.target).toEqual({ events: 13, usage: 5, threads: 1 })
    await view.close()
  })
  it("does not cut a long first message into an unredactable title fragment", async () => {
    const f = await fixture(), values = rows(f.native)
    values[0].content[0].text = "x".repeat(190) + "SENSITIVE_TEST_TOKEN"
    await writeFile(f.file, serialize(values))
    const view = await f.runtime.sourceCapture.open(f.request)
    expect(view.session.title).toBe("CodeBuddy session")
    const frames = await read(view)
    expect(frames[0]!.events[0]!.update).toMatchObject({ content: { text: values[0].content[0].text } })
    await view.close()
  })
  it("returns a null terminal discovery cursor and restarts after cursor source deletion", async () => {
    const f = await fixture()
    const first = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(first.done).toBe(true); expect(first.cursor).toBeNull()
    const restarted = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: "removed-file", limits, signal: signal() }))
    expect(restarted.sources).toEqual(first.sources)
  })
  it("marks external tool output partial and rejects malformed Agent calls", async () => {
    const f = await fixture(), values = rows(f.native)
    values[7].output.text = "<persisted-output>not-captured.txt</persisted-output>"
    await writeFile(f.file, serialize(values))
    const view = await f.runtime.sourceCapture.open(f.request)
    expect(view.session.captureStatus).toBe("partial"); await view.close()
    values[6].name = "Agent"; await writeFile(f.file, serialize(values))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
  })
  it("does not follow a history symlink and marks unknown content partial", async () => {
    const f = await fixture()
    await symlink(f.file, join(f.directory, "linked.jsonl"))
    expect((await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }) as SourceDiscoveryPage).sources).toHaveLength(1)
    const values = rows(f.native); values[0].content.push({ type: "input_image", image: "blob:controlled" })
    await writeFile(f.file, serialize(values))
    const view = await f.runtime.sourceCapture.open(f.request)
    expect(view.session.captureStatus).toBe("partial"); expect(view.target.events).toBe(12)
    await view.close()
  })
})
