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
const fixture = async (stage = "resumed", version = "1.0.3") => {
  const home = await mkdtemp(join(tmpdir(), "atape-grok-test-")); roots.push(home)
  const selectedId = JSON.parse(await readFile(new URL(`./fixtures/native-${version}/${stage}/summary.json`, import.meta.url), "utf8")).info.id as string
  const directory = join(home, "sessions", "opaque-location", selectedId); await mkdir(directory, { recursive: true })
  await cp(new URL(`./fixtures/native-${version}/${stage}/`, import.meta.url), directory, { recursive: true })
  vi.stubEnv("ATAPE_GROK_HOME", home)
  const lifetime = new AbortController(), runtime = await createAtapeAdapter({ protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "grok", version: "0.5.1" }, project: { id: "project", type: "directory", path: "/unrelated/locator" }, signal: lifetime.signal })
  runtimes.push(runtime)
  return { home, directory, lifetime, runtime, request: { sourceId: selectedId, limits, projection, rawEnabled: true, signal: signal() } }
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
  it.each([["initial", "resumed", 5, 7], ["fork", "fork-resumed", 9, 11], ["nested", "nested-resumed", 13, 15]] as const)("captures 1.0.30 %s and continuation with stable history and standalone controls", async (stage, resumed, initialCount, count) => {
    const f = await fixture(stage, "1.0.30"), first = await f.runtime.sourceCapture.open(f.request), initial = await read(first)
    expect(first.target.events).toBe(initialCount); await first.close()
    await cp(new URL(`./fixtures/native-1.0.30/${resumed}/`, import.meta.url), f.directory, { recursive: true })
    const view = await f.runtime.sourceCapture.open(f.request), after = await read(view)
    expect(view.origin).toEqual(first.origin); expect(view.origin.cwd).toBe("/fixture/grok-1030/project")
    expect(view.target.events).toBe(count); expect(view.session.captureStatus).toBe("healthy")
    expect(after.slice(0, initial.length - 1)).toEqual(initial.slice(0, -1))
    const background = after.filter(f => JSON.stringify(f.raw).includes("background_tasks"))
    expect(background.length).toBeGreaterThan(0); expect(background.every(f => f.events.length === 0 && f.usage.length === 0)).toBe(true)
    await view.close()
    await cp(new URL("./fixtures/native-1.0.30/parent-grown/", import.meta.url), join(f.home, "sessions", "later-parent", "5a9ae393-eebe-4c06-be9b-52e13d37b081"), { recursive: true })
    if (stage !== "initial") {
      const unchanged = await f.runtime.sourceCapture.open(f.request)
      expect(await read(unchanged)).toEqual(after); await unchanged.close()
    }
  })
  it("preserves native manual compaction, failed commands and both continuations without inventing usage", async () => {
    const f = await fixture("compact-initial", "1.0.30")
    let previous: SourceCapturePage["frames"][number][] = []
    for (const [stage, events, usages, status] of [
      ["compact-initial", 2, 1, "healthy"], ["compact-noop", 3, 1, "healthy"], ["compact-context", 13, 6, "healthy"],
      ["compact-failed", 14, 6, "partial"], ["compact-failed-resumed", 16, 7, "partial"],
      ["compact-before-success", 18, 8, "partial"], ["compact-success", 19, 8, "partial"], ["compact-success-resumed", 21, 9, "partial"]
    ] as const) {
      await cp(new URL(`./fixtures/native-1.0.30/${stage}/`, import.meta.url), f.directory, { recursive: true })
      const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
      expect(view.target).toEqual({ events, usage: usages, threads: 1 }); expect(view.session.captureStatus).toBe(status)
      expect(frames.slice(0, previous.length)).toEqual(previous)
      expect(frames.filter(f => (f.raw as any)?.format === "grok.updates.v1").flatMap(f => (f.raw as any).records).join("\n") + "\n").toBe(await readFile(join(f.directory, "updates.jsonl"), "utf8"))
      expect(frames.filter(f => JSON.stringify(f.raw).includes("auto_compact_completed")).every(f => f.events.length === 0 && f.usage.length === 0)).toBe(true)
      previous = frames.slice(0, -1); await view.close()
      const off = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false }), canonical = await read(off)
      expect(canonical.every(f => f.raw === undefined)).toBe(true)
      expect(canonical.flatMap(f => f.events)).toEqual(frames.flatMap(f => f.events)); await off.close()
    }
  })
  it("keeps a trailing native background notification stable when its next command arrives", async () => {
    const f = await fixture("compact-noop", "1.0.30")
    await mutate(f, "updates.jsonl", rows => rows.splice(4))
    await mutate(f, "summary.json", row => row.num_messages = 4)
    await mutate(f, "signals.json", row => { row.turnCount = 1; row.userMessageCount = 1; row.compactionCount = 0 })
    const view = await f.runtime.sourceCapture.open(f.request), before = await read(view); await view.close()
    await cp(new URL("./fixtures/native-1.0.30/compact-noop/", import.meta.url), f.directory, { recursive: true })
    const next = await f.runtime.sourceCapture.open(f.request), after = await read(next)
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1)); await next.close()
  })
  it.each(["tasks", "owner", "background-prompt", "failed-time", "retry-kind", "retry-attempt", "host-command", "checkpoint-index", "checkpoint-time", "checkpoint-path", "checkpoint-reused", "missing-completion", "usage", "count"])("rejects unsupported 1.0.30 control state: %s", async kind => {
    const f = await fixture("compact-success-resumed", "1.0.30")
    await mutate(f, "updates.jsonl", rows => {
      const first = (name: string) => rows.find((r: any) => r.params.update.sessionUpdate === name)
      const update = (name: string) => first(name).params.update
      if (kind === "tasks") update("background_tasks").tasks = [{ id: "active" }]
      if (kind === "owner") first("background_tasks").params._meta.eventId = "foreign-1"
      if (kind === "background-prompt") first("background_tasks").params._meta.promptId = "foreign"
      if (kind === "failed-time") rows.find((r: any) => r.params.update.stop_reason === "error").params._meta.agentTimestampMs = 0
      if (kind === "retry-kind") update("retry_state").error_type = "unknown"
      if (kind === "retry-attempt") update("retry_state").attempt = 0
      const command = rows.find((r: any) => r.params.update._meta?.hostTurn)
      if (kind === "host-command") command.params.update.content.text = "/rewind"
      if (kind === "checkpoint-index") update("compaction_checkpoint").prompt_index_at_compaction++
      if (kind === "checkpoint-time") update("compaction_checkpoint").created_at = "2020-01-01T00:00:00Z"
      if (kind === "checkpoint-path") update("compaction_checkpoint").checkpoint_file = "../../external"
      if (kind === "checkpoint-reused") {
        const last = rows.findLast((r: any) => r.params.update.sessionUpdate === "compaction_checkpoint").params.update
        last.checkpoint_id = update("compaction_checkpoint").checkpoint_id; last.checkpoint_file = update("compaction_checkpoint").checkpoint_file
      }
      if (kind === "missing-completion") update("auto_compact_completed").sessionUpdate = "unknown"
      if (kind === "usage") rows[rows.indexOf(command) + 1].params.update.usage = { inputTokens: 100 }
    })
    if (kind === "count") await mutate(f, "signals.json", row => row.compactionCount++)
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toBeDefined()
  })
  it("captures native grep and search_replace with readable results and edit details", async () => {
    const f = await fixture("edit"), view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    const events = frames.flatMap(f => f.events)
    expect(view.target).toEqual({ events: 11, usage: 1, threads: 1 })
    expect(events[1]!.update).toMatchObject({ title: "grep", kind: "search" })
    expect(events[3]!.update).toMatchObject({ status: "completed", rawOutput: { stdout: expect.stringContaining("1:ATAPE_GROK_SEARCH_NEEDLE_20260913"), stderr: "", exit_code: 0, match_count: 1 } })
    expect(events[7]!.update).toMatchObject({ title: "search_replace", kind: "edit", rawInput: { old_string: "version=before", new_string: "version=after" } })
    expect(events[9]!.update).toMatchObject({ status: "completed", rawOutput: { EditsApplied: { old_string: "version=before", new_string: "version=after" } } })
    expect(frames.flatMap(f => f.usage)[0]).toMatchObject({ inputTokens: 57670, outputTokens: 1417, cacheReadTokens: 43072 })
    expect(JSON.stringify(frames.map(f => f.raw))).toContain("oldText")
    await view.close()
  })
  it("preserves a native no-match search as completed even with exit code one", async () => {
    const f = await fixture("empty-search"), view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    expect(frames.flatMap(f => f.events)[3]!.update).toMatchObject({ status: "completed", rawOutput: { stdout: expect.stringContaining("No matches found"), exit_code: 1, match_count: 0 } })
    await view.close()
  })
  it.each([[-1], [256], [1.5], [255], "encoded"].map(bytes => ({ bytes })))("rejects malformed search bytes before exposing a target: $bytes", async ({ bytes }) => {
    const f = await fixture("edit")
    await mutate(f, "updates.jsonl", rows => rows[3].params.update.rawOutput.stdout = bytes)
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "format" })
  })
  it("captures the native foreground command and keeps hook telemetry in Raw", async () => {
    const f = await fixture("shell"), view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    expect(view.target).toEqual({ events: 15, usage: 3, threads: 1 })
    expect(frames.flatMap(f => f.events)[13]!.update).toMatchObject({ status: "completed", rawOutput: "exit: 0\nATAPE_GROK_SHELL_20260913" })
    expect(frames.flatMap(f => f.usage)[2]).toMatchObject({ inputTokens: 27653, outputTokens: 48, cacheReadTokens: 27520 })
    expect(frames.some(f => JSON.stringify(f.raw).includes("hook_execution") && f.events.length === 0)).toBe(true)
    await view.close()
  })
  it("captures the native copied-prefix fork as an independent root without its parent files", async () => {
    const parent = await fixture(), parentView = await parent.runtime.sourceCapture.open(parent.request), parentFrames = await read(parentView)
    await parentView.close()
    const f = await fixture("fork"), view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    const events = frames.flatMap(f => f.events), usage = frames.flatMap(f => f.usage)
    expect(view.profile).toBe("grok.build.updates.fork.1")
    expect(view.target).toEqual({ events: 12, usage: 3, threads: 1 })
    expect(view.threads).toEqual([expect.objectContaining({ sourceThreadId: f.request.sourceId })])
    expect(view.threads[0]).not.toHaveProperty("parentSourceThreadId")
    expect(view.session.title).toContain("ATAPE_GROK_FORK_PROBE")
    expect(events.every(event => event.sourceThreadId === f.request.sourceId)).toBe(true)
    const parentKeys = new Set(parentFrames.flatMap(f => f.events).map(e => e.sourceEventId))
    expect(events.every(event => !parentKeys.has(event.sourceEventId))).toBe(true)
    expect(usage.slice(0, 2).map(u => [u.inputTokens, u.outputTokens])).toEqual(parentFrames.flatMap(f => f.usage).map(u => [u.inputTokens, u.outputTokens]))
    expect(usage.slice(0, 2).map(u => u.sourceUsageId)).not.toEqual(parentFrames.flatMap(f => f.usage).map(u => u.sourceUsageId))
    expect(JSON.stringify(frames.map(f => f.raw))).toContain("parent_session_id")
    await view.close()
  })
  it.each([["fork-created", "fork-resumed", 10, 12], ["fork-nested", "fork-nested-resumed", 14, 16]] as const)("preserves %s identity through native resume, parent growth and parent deletion", async (stage, resumed, beforeCount, afterCount) => {
    const f = await fixture(stage), first = await f.runtime.sourceCapture.open(f.request), before = await read(first)
    expect(first.target.events).toBe(beforeCount); await first.close()
    const parentPath = join(f.home, "sessions", "parent", "dc53ec99-cb4b-4f5d-9a89-72eeccd9615e")
    await cp(new URL("./fixtures/native-1.0.3/fork-parent-grown/", import.meta.url), parentPath, { recursive: true })
    const unchanged = await f.runtime.sourceCapture.open(f.request)
    expect(await read(unchanged)).toEqual(before); await unchanged.close()
    await rm(parentPath, { recursive: true })
    await cp(new URL(`./fixtures/native-1.0.3/${resumed}/`, import.meta.url), f.directory, { recursive: true })
    const view = await f.runtime.sourceCapture.open(f.request), after = await read(view)
    expect(view.origin).toEqual(first.origin)
    expect(view.session.title).toEqual(first.session.title)
    expect(view.origin.cwd).toBe("/fixture/grok-fork/project")
    expect(view.target.events).toBe(afterCount)
    expect(after.flatMap(f => f.events).slice(0, beforeCount)).toEqual(before.flatMap(f => f.events))
    expect(after.flatMap(f => f.usage).slice(0, first.target.usage)).toEqual(before.flatMap(f => f.usage))
    expect(JSON.stringify(after)).not.toContain("ATAPE_GROK_PARENT_LATER_20260914")
    await view.close()
    const off = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await rm(f.directory, { recursive: true })
    const frozen = await read(off)
    expect(frozen.every(f => f.raw === undefined)).toBe(true)
    expect(frozen.flatMap(f => f.events)).toEqual(after.flatMap(f => f.events))
    await off.close()
  })
  it.each(["missing-parent", "missing-boundary", "self-parent", "wrong-parent", "child-kind"])("rejects incomplete or unrelated fork metadata: %s", async kind => {
    const f = await fixture("fork-created")
    await mutate(f, "summary.json", row => {
      if (kind === "missing-parent") delete row.parent_session_id
      if (kind === "missing-boundary") delete row.forked_at
      if (kind === "self-parent") row.parent_session_id = row.info.id
      if (kind === "wrong-parent") row.parent_session_id = "other-parent"
      if (kind === "child-kind") row.session_kind = "subagent"
    })
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toBeDefined()
  })
  it.each(["mixed-owner", "foreign-session", "ancestor-after-own", "reentered-ancestor", "copied-after-fork", "own-before-fork", "prefix-only"])("rejects an inconsistent fork target: %s", async kind => {
    const f = await fixture("fork-nested-resumed")
    const metadata = JSON.parse(await readFile(join(f.directory, "summary.json"), "utf8"))
    await mutate(f, "updates.jsonl", rows => {
      const root = "dc53ec99-cb4b-4f5d-9a89-72eeccd9615e"
      if (kind === "mixed-owner") rows[1].params._meta.eventId = f.request.sourceId + "-4"
      if (kind === "foreign-session") rows[1].params.sessionId = root
      if (kind === "ancestor-after-own") for (const row of rows.slice(18)) row.params._meta.eventId = root + "-" + row.params._meta.eventId.split("-").at(-1)
      if (kind === "reentered-ancestor") for (const row of rows.slice(12, 15)) row.params._meta.eventId = root + "-" + row.params._meta.eventId.split("-").at(-1)
      if (kind === "copied-after-fork") rows[1].params._meta.agentTimestampMs = Date.parse(metadata.forked_at) + 1000
      if (kind === "own-before-fork") rows[15].params._meta.agentTimestampMs = Date.parse(metadata.forked_at) - 1000
      if (kind === "prefix-only") rows.splice(15)
    })
    if (kind === "prefix-only") {
      await mutate(f, "summary.json", row => row.num_messages = 15)
      await mutate(f, "signals.json", row => { row.turnCount = 3; row.userMessageCount = 3 })
    }
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: kind === "prefix-only" ? "format" : "unsupported" })
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
  it.each(["non-text", "unknown-update", "unknown-tool", "background-call", "background", "spilled"])("diagnoses %s content without exposing a partial new target", async kind => {
    const f = await fixture("shell")
    await mutate(f, "updates.jsonl", rows => {
      if (kind === "non-text") rows[0].params.update.content = { type: "image", data: "x", mimeType: "image/png" }
      if (kind === "unknown-update") rows[1].params.update.sessionUpdate = "rewind"
      if (kind === "unknown-tool") rows[1].params.update.title = "task"
      if (kind === "background-call") rows[13].params.update.rawInput.is_background = true
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
