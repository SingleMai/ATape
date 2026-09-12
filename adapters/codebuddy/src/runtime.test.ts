import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
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
  it("marks external tool output partial and rejects child-agent calls", async () => {
    const f = await fixture(), values = rows(f.native)
    values[7].output.text = "<persisted-output>not-captured.txt</persisted-output>"
    await writeFile(f.file, serialize(values))
    const view = await f.runtime.sourceCapture.open(f.request)
    expect(view.session.captureStatus).toBe("partial"); await view.close()
    values[6].name = "Agent"; await writeFile(f.file, serialize(values))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "unsupported" })
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
