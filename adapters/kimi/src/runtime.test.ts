import { appendFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { SourceCaptureHeader, SourceCapturePage, SourceDiscoveryPage } from "@atape/domain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./runtime.ts"

const roots: string[] = [], runtimes: Awaited<ReturnType<typeof createAtapeAdapter>>[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const signal = () => new AbortController().signal
const limits = { rowBytes: 1048576, pageBytes: 2097152, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 2097152 }
const sourceId = "session_12c751bb-0285-49a2-9379-aacbf56d1bd4"
const serialize = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + "\n").join("")
const fixture = async (name = "native") => {
  const home = await mkdtemp(join(tmpdir(), "atape-kimi-")); roots.push(home)
  const native = await readFile(new URL(`./fixtures/${name}-0.42.0.jsonl`, import.meta.url), "utf8")
  const metadata = await readFile(new URL(`./fixtures/${name}-0.42.0.state.json`, import.meta.url), "utf8")
  const sourceId = JSON.parse(metadata).id as string
  const directory = join(home, "sessions", "opaque", sourceId), file = join(directory, "agents", "main", "wire.jsonl"), state = join(directory, "state.json")
  await mkdir(join(directory, "agents", "main"), { recursive: true })
  await writeFile(file, native); await writeFile(state, metadata)
  vi.stubEnv("ATAPE_KIMI_HOME", home)
  const lifetime = new AbortController()
  const runtime = await createAtapeAdapter({ protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "kimi", version: "0.5.1" }, project: { id: "project", type: "directory", path: "/unrelated/locator" }, signal: lifetime.signal })
  runtimes.push(runtime)
  const request = { sourceId, limits, projection, rawEnabled: true, signal: signal() }
  const rows = native.trim().split("\n").map(line => JSON.parse(line))
  return { home, directory, file, state, native, metadata, rows, lifetime, runtime, request }
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
describe("Kimi source-capture runtime Interface", () => {
  it("replays native undo, replacement and repeated manual compaction while retaining expenditure and surviving identities", async () => {
    const f = await fixture("context")
    let previous: SourceCapturePage["frames"][number][] = []
    for (const [length, eventCount, usageCount, input, output] of [[32, 4, 2, 203, 23], [34, 2, 2, 203, 23], [46, 4, 3, 306, 36], [52, 4, 4, 410, 50], [66, 6, 5, 515, 65], [68, 4, 5, 515, 65], [82, 6, 6, 621, 81], [88, 6, 7, 728, 98]]) {
      await writeFile(f.file, serialize(f.rows.slice(0, length)))
      const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
      Schema.decodeUnknownSync(SourceCaptureHeader)(view)
      expect(view.target).toEqual({ events: eventCount, usage: usageCount, threads: 1 })
      expect(view.session.captureStatus).toBe("healthy")
      const events = frames.flatMap(f => f.events), usage = frames.flatMap(f => f.usage)
      expect(events.map(e => e.eventIndex)).toEqual(events.map((_, i) => i))
      expect(events.map(e => e.sourceOrder)).toEqual(events.map((_, i) => i))
      for (const event of events) {
        const retained = previous.flatMap(f => f.events).find(e => e.sourceEventId === event.sourceEventId)
        if (retained) expect(event).toEqual(retained)
      }
      expect(usage.slice(0, previous.flatMap(f => f.usage).length)).toEqual(previous.flatMap(f => f.usage))
      expect(usage.reduce((sum, u) => sum + u.inputTokens!, 0)).toBe(input)
      expect(usage.reduce((sum, u) => sum + u.outputTokens!, 0)).toBe(output)
      expect(usage.map(u => u.model)).toEqual(Array(usageCount).fill("atape-context-model"))
      expect(frames.slice(1).map(f => (f.raw as { json: string }).json).join("\n") + "\n").toBe(serialize(f.rows.slice(0, length)))
      await view.close(); previous = frames
    }
    const canonical = JSON.stringify(previous.flatMap(f => f.events))
    for (const absent of ["KimiUndoBefore", "KimiUndoAfter", "KimiContextReply2", "KimiContextReply4", "KimiContextReply5", "KimiContextReply7", "contextSummary"]) expect(canonical).not.toContain(absent)
    for (const present of ["KimiKeepOne", "KimiKeepTwo", "KimiKeepAfter", "KimiContextReply1", "KimiContextReply3", "KimiContextReply6"]) expect(canonical).toContain(present)
    const off = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    expect(off.profile).toBe("kimi.code.wire.context.1")
    await rm(f.directory, { recursive: true })
    expect(await read(off)).toEqual(previous.map(({ raw: _, ...frame }) => frame))
  })
  it("keeps the user before native automatic compaction visible and accounts for its separate response", async () => {
    const f = await fixture("auto"), view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    expect(view.target).toEqual({ events: 4, usage: 3, threads: 1 })
    expect(view.session.captureStatus).toBe("healthy")
    const events = frames.flatMap(f => f.events), usage = frames.flatMap(f => f.usage)
    expect(events.map(e => e.update.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk", "user_message_chunk", "agent_message_chunk"])
    expect(JSON.stringify(events)).toContain("KimiAutoNext")
    expect(JSON.stringify(events)).not.toContain("KimiContextReply2")
    expect(usage.reduce((sum, u) => sum + u.inputTokens!, 0)).toBe(190205)
    expect(usage.reduce((sum, u) => sum + u.outputTokens!, 0)).toBe(36)
    await view.close()
    await appendFile(f.file, serialize([{ type: "context.undo", count: 1, time: f.rows.at(-1).time }]))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "unsupported" })
  })
  it("discovers native /clear as a new independent session without changing the old capture", async () => {
    const f = await fixture("context"), before = await f.runtime.sourceCapture.open(f.request), frames = await read(before); await before.close()
    const metadata = await readFile(new URL("./fixtures/clear-0.42.0.state.json", import.meta.url), "utf8"), clearId = JSON.parse(metadata).id
    const directory = join(f.home, "sessions", "opaque", clearId)
    await mkdir(join(directory, "agents", "main"), { recursive: true }); await writeFile(join(directory, "state.json"), metadata)
    await writeFile(join(directory, "agents", "main", "wire.jsonl"), await readFile(new URL("./fixtures/clear-0.42.0.jsonl", import.meta.url)))
    const found = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits: { ...limits, pageRows: 10 }, signal: signal() }))
    expect(found.sources.map(s => s.sourceId).sort()).toEqual([f.request.sourceId, clearId].sort())
    expect(new Set(found.sources.map(s => s.originKey)).size).toBe(2)
    const old = await f.runtime.sourceCapture.open(f.request); expect(await read(old)).toEqual(frames); await old.close()
    const fresh = await f.runtime.sourceCapture.open({ ...f.request, sourceId: clearId }), next = await read(fresh)
    expect(fresh.target).toEqual({ events: 2, usage: 1, threads: 1 })
    expect(JSON.stringify(next.flatMap(f => f.events))).toContain("KimiNewAfterClear")
    expect(next.flatMap(f => f.usage)[0]).toMatchObject({ inputTokens: 108, outputTokens: 18 })
    expect(next.flatMap(f => f.events).every(e => !frames.flatMap(f => f.events).some(old => old.sourceEventId === e.sourceEventId))).toBe(true)
  })
  it("allows undo of every uncompressed turn without removing usage", async () => {
    const f = await fixture("context")
    await writeFile(f.file, serialize([...f.rows.slice(0, 32), { type: "context.undo", count: 2, time: f.rows[32].time }]))
    const view = await f.runtime.sourceCapture.open(f.request)
    Schema.decodeUnknownSync(SourceCaptureHeader)(view)
    expect(view.target).toEqual({ events: 0, usage: 2, threads: 1 })
    expect((await read(view)).flatMap(f => f.events)).toEqual([])
    expect(view.session.title).toBe(JSON.parse(f.metadata).title)
  })
  it("removes complete tool/thought turns through a multi-turn undo while retaining their usage and Raw", async () => {
    const f = await fixture(), original = await f.runtime.sourceCapture.open(f.request), before = await read(original); await original.close()
    await appendFile(f.file, serialize([{ type: "context.undo", count: 2, time: f.rows.at(-1).time + 1 }]))
    const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    expect(view.target).toEqual({ events: 3, usage: 5, threads: 1 })
    expect(frames.flatMap(f => f.events)).toEqual(before.flatMap(f => f.events).slice(0, 3))
    expect(frames.flatMap(f => f.usage)).toEqual(before.flatMap(f => f.usage))
    expect(JSON.stringify(frames.flatMap(f => f.events))).not.toContain("tool_call")
    expect(JSON.stringify(frames)).toContain("ATAPE_KIMI_TOOL_MARKER_0420")
  })
  it.each(["zero", "negative", "fraction", "too-many", "cross-boundary", "active", "missing-begin", "missing-request", "range", "legacy", "model", "duplicate-usage", "retry", "counter", "cancel", "missing-apply", "incomplete-begin", "incomplete-usage", "incomplete-apply"])("rejects %s context mutations before exposing a replacement", async kind => {
    const f = await fixture("context")
    if (["zero", "negative", "fraction", "too-many"].includes(kind)) f.rows[32].count = { zero: 0, negative: -1, fraction: 0.5, "too-many": 3 }[kind]
    if (kind === "cross-boundary") f.rows.splice(68, 0, { ...f.rows[66] })
    if (kind === "active") f.rows.splice(31, 0, { ...f.rows[32] })
    if (kind === "missing-begin") f.rows.splice(46, 1)
    if (kind === "missing-request") f.rows.splice(47, 1)
    if (kind === "range") f.rows[49].wireLines.end++
    if (kind === "legacy") delete f.rows[49].keptUserMessageCount
    if (kind === "model") f.rows[48].model = "unrelated"
    if (kind === "duplicate-usage") f.rows.splice(49, 0, f.rows[48])
    if (kind === "retry") f.rows.splice(48, 0, f.rows[47])
    if (kind === "counter") f.rows[48].usage.output = -1
    if (kind === "cancel") f.rows[51].type = "full_compaction.cancel"
    if (kind === "missing-apply") f.rows.splice(49, 1)
    if (kind === "incomplete-begin") f.rows.splice(47)
    if (kind === "incomplete-usage") f.rows.splice(49)
    if (kind === "incomplete-apply") f.rows.splice(50)
    await writeFile(f.file, serialize(f.rows))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toBeDefined()
  })
  it("does not invent missing compaction counters or turn context token estimates into usage", async () => {
    const f = await fixture("context")
    f.rows[48].usage = { output: 14 }; f.rows[84].usage = {}
    f.rows[49].tokensAfter = 999999; f.rows[85].summaryOutputTokens = 999999
    await writeFile(f.file, serialize(f.rows))
    const view = await f.runtime.sourceCapture.open(f.request), usage = (await read(view)).flatMap(f => f.usage)
    expect(usage).toHaveLength(6)
    expect(usage[3]).toMatchObject({ outputTokens: 14 })
    expect(usage[3]!.inputTokens).toBeUndefined()
    expect(JSON.stringify(usage)).not.toContain("999999")
  })
  it("captures native resume, thoughts, both tool outcomes and exact response usage without double counting", async () => {
    const f = await fixture(), before = await stat(f.file)
    const discovery = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(discovery.sources).toEqual([{ sourceId, originKey: expect.any(String), cwd: "/fixture/kimi-project" }])
    expect(discovery.sourceFailures).toEqual([])
    const view = await f.runtime.sourceCapture.open(f.request)
    Schema.decodeUnknownSync(SourceCaptureHeader)(view)
    expect(view.target).toEqual({ events: 13, usage: 5, threads: 1 })
    expect(view.session.captureStatus).toBe("healthy")
    const frames = await read(view), events = frames.flatMap(f => f.events), usage = frames.flatMap(f => f.usage)
    expect(events.map(e => e.update.sessionUpdate)).toEqual(["user_message_chunk", "agent_thought_chunk", "agent_message_chunk", "user_message_chunk", "tool_call", "tool_call_update", "agent_thought_chunk", "agent_message_chunk", "user_message_chunk", "tool_call", "tool_call_update", "agent_thought_chunk", "agent_message_chunk"])
    expect(events[5]!.update).toMatchObject({ status: "failed", title: "Read", toolCallId: (events[4]!.update as { toolCallId: string }).toolCallId })
    expect(events[10]!.update).toMatchObject({ status: "completed" })
    expect(events[12]!.update).toMatchObject({ content: { text: "ATAPE_KIMI_TOOL_MARKER_0420" } })
    expect(usage.map(row => row.model)).toEqual(Array(5).fill("atape-controlled-model"))
    expect(usage.reduce((sum, row) => sum + row.inputTokens!, 0)).toBe(540)
    expect(usage.reduce((sum, row) => sum + row.outputTokens!, 0)).toBe(54)
    expect(usage.reduce((sum, row) => sum + row.cacheReadTokens!, 0)).toBe(100)
    expect((frames[0]!.raw as { json: string }).json).toBe(f.metadata)
    expect(frames.slice(1).map(f => (f.raw as { json: string }).json).join("\n") + "\n").toBe(f.native)
    expect(JSON.stringify(events)).not.toContain("system-reminder")
    await view.close(); expect((await stat(f.file)).mtimeMs).toBe(before.mtimeMs)
  })
  it("freezes bounded pages across appends and deletion; Raw-off keeps only canonical content", async () => {
    const f = await fixture(), off = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await appendFile(f.file, "unfinished")
    const frames = await read(off); await off.close()
    expect(frames.every(f => f.raw === undefined)).toBe(true)
    expect(JSON.stringify(frames)).not.toContain("system-reminder")
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
    await writeFile(f.file, f.native)
    const on = await f.runtime.sourceCapture.open(f.request)
    await rm(f.directory, { recursive: true })
    expect((await read(on)).map(({ raw: _, ...frame }) => frame)).toEqual(frames)
    await on.close()
    expect(Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() })).sources).toEqual([])
  })
  it("preserves original attribution and identities across relocation, title edits and unrelated runtime metadata", async () => {
    const f = await fixture(), view = await f.runtime.sourceCapture.open(f.request), frames = await read(view); await view.close()
    const meta = JSON.parse(f.metadata); meta.title = "Renamed session"; meta.agents.main.homedir = "/untrusted/locator"
    await writeFile(f.state, JSON.stringify(meta))
    f.rows[1].cwd = "/different/project"; await writeFile(f.file, serialize(f.rows))
    await rename(join(f.home, "sessions", "opaque"), join(f.home, "sessions", "moved"))
    const moved = await f.runtime.sourceCapture.open(f.request)
    expect(moved.origin).toEqual(view.origin); expect(moved.session.title).toBe("Renamed session")
    expect((await read(moved)).flatMap(f => f.events)).toEqual(frames.flatMap(f => f.events))
  })
  it("retains native prefix identities as a resumed session grows", async () => {
    const f = await fixture(); await writeFile(f.file, serialize(f.rows.slice(0, 20)))
    const initial = await f.runtime.sourceCapture.open(f.request), before = await read(initial); await initial.close()
    expect(initial.target).toEqual({ events: 3, usage: 1, threads: 1 })
    await writeFile(f.file, f.native)
    const resumed = await f.runtime.sourceCapture.open(f.request), after = await read(resumed)
    expect(after.flatMap(f => f.events).slice(0, 3)).toEqual(before.flatMap(f => f.events))
    expect(after.flatMap(f => f.usage).slice(0, 1)).toEqual(before.flatMap(f => f.usage))
  })
  it("diagnoses malformed and duplicate sources while discovery advances to healthy sources", async () => {
    const f = await fixture(), bad = join(f.home, "sessions", "opaque", "000-invalid")
    await mkdir(bad); await writeFile(join(bad, "state.json"), "invalid")
    const first = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(first.sources).toEqual([]); expect(first.sourceFailures[0]?.reason).toBe("format"); expect(first.done).toBe(false)
    expect(Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: first.cursor, limits, signal: signal() })).sources[0]?.sourceId).toBe(sourceId)
    await cp(f.directory, join(f.home, "sessions", "copy", sourceId), { recursive: true })
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
    const duplicate = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(duplicate.sourceFailures[0]?.reason).toBe("duplicate")
  })
  it.each(["fork", "children", "version", "cwd", "identity", "tree"])("rejects unproven %s metadata", async kind => {
    const f = await fixture(), meta = JSON.parse(f.metadata)
    if (kind === "fork") meta.forkedFrom = "parent"
    if (kind === "children") meta.agents.child = { type: "sub", parentAgentId: "main" }
    if (kind === "version") meta.version = 3
    if (kind === "cwd") delete meta.cwd
    if (kind === "identity") meta.id = "foreign"
    if (kind === "tree") await mkdir(join(f.directory, "trees"))
    await writeFile(f.state, JSON.stringify(meta))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: kind === "cwd" ? "attribution" : kind === "identity" ? "format" : "unsupported" })
  })
  it.each(["context.undo", "context.clear", "context.apply_compaction", "turn.steer", "turn.cancel"])("preserves history instead of guessing %s", async type => {
    const f = await fixture(); await appendFile(f.file, serialize([{ type, agentId: "main", time: 1789264194000 }]))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "unsupported" })
  })
  it.each(["step", "tool", "interrupted", "retry", "foreign", "protocol", "metadata", "duplicate", "counter"])("rejects invalid or unproven %s records before exposing a view", async kind => {
    const f = await fixture()
    if (kind === "step") f.rows.splice(16)
    if (kind === "tool") f.rows.splice(28, 1)
    if (kind === "interrupted") f.rows[16].event.finishReason = "interrupted"
    if (kind === "retry") f.rows.splice(12, 0, f.rows[11])
    if (kind === "foreign") f.rows[15].agentId = "child"
    if (kind === "protocol") f.rows[0].protocol_version = "1.6"
    if (kind === "metadata") f.rows.push(f.rows[0])
    if (kind === "duplicate") f.rows.splice(16, 0, f.rows[15])
    if (kind === "counter") f.rows[16].event.usage.inputOther = -1
    await writeFile(f.file, serialize(f.rows))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toBeDefined()
  })
  it("keeps unknown content and tool values bounded, marks partial, and never follows blob references", async () => {
    const f = await fixture()
    f.rows[15].event.part = { type: "image_url", image_url: { url: "file:///secret" } }
    f.rows[48].event.result.output = "x".repeat(100000)
    f.rows[28].event.result.output = [{ type: "image_url", image_url: { url: "file:///secret" } }]
    f.rows.push({ type: "future.telemetry", time: 1789264194000, unknown: "RawOnlyMarker" })
    await writeFile(f.file, serialize(f.rows))
    const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    expect(view.session.captureStatus).toBe("partial")
    expect(JSON.stringify(frames.flatMap(f => f.events))).not.toContain("file:///secret")
    expect(JSON.stringify(frames.flatMap(f => f.events))).not.toContain("RawOnlyMarker")
    expect(JSON.stringify(frames)).toContain("RawOnlyMarker")
  })
  it.each(["row", "records", "events", "usage", "page", "snapshot"])("enforces the %s bound with no partial view", async kind => {
    const f = await fixture(), request = { ...f.request, limits: { ...limits }, projection: { ...projection } }
    if (kind === "row") request.limits.rowBytes = 256
    if (kind === "records") request.limits.records = 2
    if (kind === "events") request.projection.events = 2
    if (kind === "usage") request.projection.usage = 2
    if (kind === "page") request.projection.pageBytes = 1024
    if (kind === "snapshot") await writeFile(f.file, "x".repeat(16 * 1024 * 1024))
    await expect(f.runtime.sourceCapture.open(request)).rejects.toMatchObject({ reason: "limit" })
  })
  it.each(["wire", "state", "agent"])("does not follow %s symlinks", async kind => {
    const f = await fixture(), target = kind === "wire" ? f.file : kind === "state" ? f.state : join(f.directory, "agents", "main")
    await rename(target, target + ".real"); await symlink(target + ".real", target)
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toBeDefined()
  })
  it("owns view exclusion, failed-open cleanup, cancellation and close", async () => {
    const f = await fixture(), view = await f.runtime.sourceCapture.open(f.request)
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "closed" })
    await view.close(); await expect(view.read(signal())).rejects.toMatchObject({ reason: "closed" })
    const next = await f.runtime.sourceCapture.open(f.request); f.lifetime.abort()
    await expect(next.read(signal())).rejects.toBeDefined()
    await expect(f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() })).rejects.toBeDefined()
  })
})
