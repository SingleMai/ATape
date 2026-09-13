import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { SourceCaptureHeader, SourceCapturePage, SourceDiscoveryPage } from "@atape/domain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./runtime.ts"

const roots: string[] = [], runtimes: Awaited<ReturnType<typeof createAtapeAdapter>>[] = []
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const signal = () => new AbortController().signal
const limits = { rowBytes: 65536, pageBytes: 262144, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 }
const sourceId = "01a0987a-554b-7073-934d-da914245adbf"
const fixture = async (stage = "resumed") => {
  const home = await mkdtemp(join(tmpdir(), "atape-grok-test-")); roots.push(home)
  const directory = join(home, "sessions", "opaque-location", sourceId); await mkdir(directory, { recursive: true })
  await cp(new URL(`./fixtures/native-1.0.3/${stage}/`, import.meta.url), directory, { recursive: true })
  vi.stubEnv("ATAPE_GROK_HOME", home)
  const lifetime = new AbortController(), runtime = await createAtapeAdapter({ protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "grok", version: "0.5.1" }, project: { id: "project", type: "directory", path: "/unrelated/locator" }, signal: lifetime.signal })
  runtimes.push(runtime)
  return { home, directory, lifetime, runtime, request: { sourceId, limits, projection, rawEnabled: true, signal: signal() } }
}
const read = async (view: Awaited<ReturnType<Awaited<ReturnType<typeof createAtapeAdapter>>["sourceCapture"]["open"]>>) => {
  Schema.decodeUnknownSync(SourceCaptureHeader)(view)
  const frames: SourceCapturePage["frames"][number][] = []
  for (let i = 0; i < 100; i++) {
    const page = Schema.decodeUnknownSync(SourceCapturePage)(await view.read(signal()))
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(projection.pageBytes)
    expect(page.frames.length).toBeLessThanOrEqual(projection.pageItems)
    frames.push(...page.frames); if (page.done) return frames
  }
  throw new Error("Grok view did not finish")
}
const mutate = async (f: Awaited<ReturnType<typeof fixture>>, file: string, edit: (rows: any) => void) => {
  const path = join(f.directory, file), content = await readFile(path, "utf8")
  const rows = file.endsWith("jsonl") ? content.trimEnd().split("\n").map(line => JSON.parse(line)) : JSON.parse(content)
  edit(rows); await writeFile(path, file.endsWith("jsonl") ? rows.map((r: unknown) => JSON.stringify(r) + "\n").join("") : JSON.stringify(rows))
}

describe("Grok source-capture runtime Interface", () => {
  it("captures the native foreground command and keeps hook telemetry in Raw", async () => {
    const f = await fixture("shell"), view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    expect(view.target).toEqual({ events: 15, usage: 3, threads: 1 })
    expect(frames.flatMap(f => f.events)[13]!.update).toMatchObject({ status: "completed", rawOutput: "exit: 0\nATAPE_GROK_SHELL_20260913" })
    expect(frames.flatMap(f => f.usage)[2]).toMatchObject({ inputTokens: 27653, outputTokens: 48, cacheReadTokens: 27520 })
    expect(frames.some(f => JSON.stringify(f.raw).includes("hook_execution") && f.events.length === 0)).toBe(true)
    await view.close()
  })
  it("rejects the native copied-prefix fork", async () => {
    const f = await fixture("fork"), summary = JSON.parse(await readFile(join(f.directory, "summary.json"), "utf8"))
    const target = join(f.home, "sessions", "opaque-location", summary.info.id); await rename(f.directory, target)
    await expect(f.runtime.sourceCapture.open({ ...f.request, sourceId: summary.info.id })).rejects.toMatchObject({ reason: "unsupported" })
  })
  it("projects both native turns, successful/failed tools and exact turn usage without colliding restarted event IDs", async () => {
    const f = await fixture(), page = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(page.sources).toEqual([{ sourceId, originKey: expect.any(String), cwd: "/fixture/grok-project" }])
    const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view), events = frames.flatMap(f => f.events), usage = frames.flatMap(f => f.usage)
    expect(view.target).toEqual({ events: 10, usage: 2, threads: 1 }); expect(view.session.captureStatus).toBe("healthy")
    expect(new Set(events.map(e => e.sourceEventId)).size).toBe(10)
    expect(events.filter(e => e.update.sessionUpdate === "user_message_chunk")).toHaveLength(2)
    expect(events[3]!.update).toMatchObject({ status: "completed", toolCallId: (events[1]!.update as { toolCallId: string }).toolCallId })
    expect(events[8]!.update).toMatchObject({ status: "failed" })
    expect(events[9]!.update).toMatchObject({ content: { text: "ATAPE_GROK_RESUMED_20260913" } })
    expect(usage.map(u => [u.inputTokens, u.outputTokens, u.cacheReadTokens])).toEqual([[27062, 373, 13504], [27339, 748, 27072]])
    expect(frames.filter(f => (f.raw as any)?.format === "grok.updates.v1").flatMap(f => (f.raw as any).records).join("\n") + "\n").toBe(await readFile(join(f.directory, "updates.jsonl"), "utf8"))
    await view.close()
  })
  it("joins adjacent text fragments before exposing a redaction unit", async () => {
    const f = await fixture("initial")
    await mutate(f, "updates.jsonl", rows => {
      rows[0].params.update.content.text = "SENSITIVE_"
      const continuation = structuredClone(rows[0]); continuation.params._meta.eventId = sourceId + "-1000"
      continuation.params.update.content.text = "TEST_TOKEN"
      rows.splice(1, 0, continuation)
    })
    await mutate(f, "summary.json", row => row.num_messages++)
    const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    expect(frames[0]!.events[0]!.update).toMatchObject({ content: { text: "SENSITIVE_TEST_TOKEN" } })
    expect((frames[0]!.raw as any).records).toHaveLength(2)
    expect(view.target.events).toBe(5); await view.close()
  })
  it.each(["non-text", "unknown-update", "unknown-tool", "background", "spilled"])("diagnoses %s content without exposing a partial new target", async kind => {
    const f = await fixture("shell")
    await mutate(f, "updates.jsonl", rows => {
      if (kind === "non-text") rows[0].params.update.content = { type: "image", data: "x", mimeType: "image/png" }
      if (kind === "unknown-update") rows[1].params.update.sessionUpdate = "rewind"
      if (kind === "unknown-tool") rows[1].params.update.title = "task"
      if (kind === "background") rows[15].params.update.rawInput.is_background = true
      if (kind === "spilled") rows[16].params.update.rawOutput.truncated = true
    })
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "unsupported" })
  })
  it("preserves initial Event identities and Origin across resume and source relocation", async () => {
    const f = await fixture("initial"), first = await f.runtime.sourceCapture.open(f.request), initial = await read(first); await first.close()
    await cp(new URL("./fixtures/native-1.0.3/resumed/", import.meta.url), f.directory, { recursive: true })
    await rename(join(f.home, "sessions", "opaque-location"), join(f.home, "sessions", "relocated"))
    const view = await f.runtime.sourceCapture.open(f.request), next = await read(view)
    expect(view.origin).toEqual(first.origin)
    expect(next.flatMap(f => f.events).slice(0, 5)).toEqual(initial.flatMap(f => f.events)); await view.close()
  })
  it("freezes complete content across deletion, keeps Canonical with Raw off, and rejects an unfinished turn", async () => {
    const f = await fixture(), on = await f.runtime.sourceCapture.open(f.request), original = await read(on); await on.close()
    const view = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false }); await rm(join(f.directory, "updates.jsonl"))
    const off = await read(view); expect(off.every(f => f.raw === undefined)).toBe(true)
    expect(off.flatMap(f => f.events)).toEqual(original.flatMap(f => f.events)); await view.close()
    await cp(new URL("./fixtures/native-1.0.3/resumed/", import.meta.url), f.directory, { recursive: true })
    await mutate(f, "updates.jsonl", rows => rows.pop()); await mutate(f, "summary.json", row => row.num_messages--)
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
  })
  it.each(["hasReverted", "compactionCount", "regenerationCount", "editAndRetryCount"])("rejects unverified %s without manufacturing a target", async field => {
    const f = await fixture(); await mutate(f, "signals.json", row => row[field] = field === "hasReverted" ? true : 1)
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "unsupported" })
  })
  it("diagnoses fork identity and missing original attribution independently of the folder name", async () => {
    const f = await fixture(); await mutate(f, "summary.json", row => row.parent_session_id = "parent")
    let page = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(page.sources).toEqual([]); expect(page.sourceFailures[0]!.reason).toBe("unsupported")
    await mutate(f, "summary.json", row => { delete row.parent_session_id; delete row.info.cwd })
    page = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(page.sourceFailures[0]!.reason).toBe("attribution")
  })
  it("isolates malformed sources, bounds diagnostics, and rejects duplicate native IDs", async () => {
    const f = await fixture(), bad = join(f.home, "sessions", "aaa", "broken"); await mkdir(bad, { recursive: true }); await writeFile(join(bad, "summary.json"), "bad")
    const page = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
    expect(page.sources).toEqual([]); expect(page.done).toBe(false); expect(page.sourceFailures[0]!.reason).toBe("format")
    const next = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: page.cursor, limits, signal: signal() }))
    expect(next.sources[0]?.sourceId).toBe(sourceId)
    await cp(f.directory, join(f.home, "sessions", "duplicate", sourceId), { recursive: true })
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
  })
  it.each(["row", "records", "page", "events"])("enforces the %s budget before exposing a view", async kind => {
    const f = await fixture(), request = { ...f.request, limits: { ...limits }, projection: { ...projection } }
    if (kind === "row") request.limits.rowBytes = 20
    if (kind === "records") request.limits.records = 1
    if (kind === "page") request.projection.pageBytes = 128
    if (kind === "events") request.projection.events = 1
    await expect(f.runtime.sourceCapture.open(request)).rejects.toMatchObject({ reason: "limit" })
  })
  it("enforces the per-frame usage bound even when the target budget is larger", async () => {
    const f = await fixture("initial")
    await mutate(f, "updates.jsonl", rows => {
      rows.at(-1).params.update.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
        modelUsage: Object.fromEntries(Array.from({ length: 501 }, (_, n) => ["model-" + n, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }])) }
    })
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "limit" })
  })
  it("rejects invalid UTF-8, incomplete JSONL, changed counters, and foreign prompt identities", async () => {
    const f = await fixture(), file = join(f.directory, "updates.jsonl"), original = await readFile(file)
    await writeFile(file, Buffer.concat([original, Buffer.from([0xff, 10])]))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
    await writeFile(file, original.subarray(0, original.length - 1))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
    await writeFile(file, original); await mutate(f, "updates.jsonl", rows => rows[1].params._meta.promptId = "foreign")
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "unsupported" })
    await writeFile(file, original); await mutate(f, "updates.jsonl", rows => rows.at(-1).params.update.usage.inputTokens++)
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "unsupported" })
  })
  it("does not follow source file symlinks and closes views on parent cancellation", async () => {
    const f = await fixture(), file = join(f.directory, "updates.jsonl"), backup = join(f.home, "external")
    await rename(file, backup); await symlink(backup, file)
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "io" })
    await rm(file); await rename(backup, file)
    const view = await f.runtime.sourceCapture.open(f.request); f.lifetime.abort()
    await expect(view.read(signal())).rejects.toBeDefined(); await view.close()
  })
})
