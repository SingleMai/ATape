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
  const native = await readFile(new URL(["subagents", "nested-subagents", "background"].includes(name) ? `./fixtures/${name}-0.42.0/agents/main/wire.jsonl` : `./fixtures/${name}-0.42.0.jsonl`, import.meta.url), "utf8")
  const metadata = await readFile(new URL(["subagents", "nested-subagents", "background"].includes(name) ? `./fixtures/${name}-0.42.0/state.json` : `./fixtures/${name}-0.42.0.state.json`, import.meta.url), "utf8")
  const sourceId = JSON.parse(metadata).id as string
  const directory = join(home, "sessions", "opaque", sourceId), file = join(directory, "agents", "main", "wire.jsonl"), state = join(directory, "state.json")
  await mkdir(join(directory, "agents", "main"), { recursive: true })
  if (["subagents", "nested-subagents", "background"].includes(name)) await cp(new URL(`./fixtures/${name}-0.42.0/`, import.meta.url), directory, { recursive: true })
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
  it("captures native foreground children and resume at their parent calls without duplicate usage", async () => {
    const f = await fixture("subagents"), childFile = join(f.directory, "agents", "agent-0", "wire.jsonl")
    const child = (await readFile(childFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    let previous: SourceCapturePage["frames"][number][] = []
    for (const [rootLines, childLines, threads, events, usage, input] of [[26, 25, 2, 8, 4, 410], [45, 37, 2, 14, 7, 728], [64, 37, 3, 22, 11, 1166]] as const) {
      const meta = JSON.parse(f.metadata)
      if (threads === 2) delete meta.agents["agent-1"]
      await writeFile(f.state, JSON.stringify(meta)); await writeFile(f.file, serialize(f.rows.slice(0, rootLines))); await writeFile(childFile, serialize(child.slice(0, childLines)))
      const discovered = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: signal() }))
      expect(discovered.sources).toHaveLength(1); expect(discovered.sourceFailures).toEqual([])
      const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
      Schema.decodeUnknownSync(SourceCaptureHeader)(view)
      expect(view.profile).toBe("kimi.code.wire.family.1")
      expect(view.target).toEqual({ threads, events, usage })
      expect(view.session.captureStatus).toBe("healthy")
      expect(view.threads.slice(1).every(thread => thread.parentSourceThreadId === f.request.sourceId)).toBe(true)
      expect(frames).toHaveLength(rootLines + childLines + (threads === 3 ? 25 : 0) + 1)
      expect(frames.filter(frame => (frame.raw as { sourceAgentId?: string }).sourceAgentId === "agent-0").map(frame => (frame.raw as { json: string }).json).join("\n") + "\n").toBe(serialize(child.slice(0, childLines)))
      const values = frames.flatMap(frame => frame.events), counts = frames.flatMap(frame => frame.usage)
      expect(values.slice(0, previous.flatMap(frame => frame.events).length)).toEqual(previous.flatMap(frame => frame.events))
      expect(new Set(values.map(event => event.sourceEventId)).size).toBe(events)
      expect(values.map(event => event.sourceOrder)).toEqual(Array.from({ length: events }, (_, i) => i))
      expect(values.filter(event => event.childSourceThreadId).map(event => event.childSourceThreadId)).toEqual(threads === 3 ? ["agent-0", "agent-0", "agent-1"] : usage === 7 ? ["agent-0", "agent-0"] : ["agent-0"])
      expect(values[2]!.sourceThreadId).toBe("agent-0")
      expect(JSON.stringify(values)).toContain("KimiChildFileMarker")
      expect(counts.reduce((n, u) => n + u.inputTokens!, 0)).toBe(input)
      expect(counts.filter(u => u.sourceThreadId === "agent-0").reduce((n, u) => n + u.inputTokens!, 0)).toBe(usage === 4 ? 205 : 311)
      expect(counts.every(u => u.model === "atape-child-model")).toBe(true)
      previous = frames; await view.close()
    }
    const frozen = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await rm(f.directory, { recursive: true })
    expect(await read(frozen)).toEqual(previous.map(({ raw: _, ...frame }) => frame))
  })
  it("captures native nested delegation and resumes each layer with stable identity, order and usage", async () => {
    const f = await fixture("nested-subagents"), originals = new Map<string, string>()
    for (const agent of ["main", "agent-0", "agent-1"]) originals.set(agent, await readFile(join(f.directory, "agents", agent, "wire.jsonl"), "utf8"))
    let previous: SourceCapturePage["frames"][number][] = []
    for (const [lengths, events, usage, input] of [[[26, 25, 25], 12, 6, 621], [[45, 44, 37], 22, 11, 1166]] as const) {
      for (const [index, agent] of ["main", "agent-0", "agent-1"].entries()) await writeFile(join(f.directory, "agents", agent, "wire.jsonl"), originals.get(agent)!.split("\n").slice(0, lengths[index]).join("\n") + "\n")
      const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
      Schema.decodeUnknownSync(SourceCaptureHeader)(view)
      expect(view.target).toEqual({ threads: 3, events, usage })
      expect(view.threads.map(t => [t.sourceThreadId, t.parentSourceThreadId])).toEqual([[f.request.sourceId, undefined], ["agent-0", f.request.sourceId], ["agent-1", "agent-0"]])
      const values = frames.flatMap(f => f.events), counts = frames.flatMap(f => f.usage)
      expect(values.slice(0, previous.flatMap(f => f.events).length)).toEqual(previous.flatMap(f => f.events))
      expect(counts.slice(0, previous.flatMap(f => f.usage).length)).toEqual(previous.flatMap(f => f.usage))
      expect(values.filter(e => e.childSourceThreadId).map(e => [e.sourceThreadId, e.childSourceThreadId])).toEqual(Array.from({ length: usage === 6 ? 1 : 2 }, () => [[f.request.sourceId, "agent-0"], ["agent-0", "agent-1"]]).flat())
      expect(values.map(e => e.sourceOrder)).toEqual(Array.from({ length: events }, (_, i) => i))
      expect(new Set(values.map(e => e.sourceEventId)).size).toBe(events)
      expect(counts.reduce((n, u) => n + u.inputTokens!, 0)).toBe(input)
      expect(counts.filter(u => u.sourceThreadId === "agent-1").reduce((n, u) => n + u.inputTokens!, 0)).toBe(usage === 6 ? 207 : 316)
      for (const [index, agent] of ["main", "agent-0", "agent-1"].entries()) {
        const raw = frames.filter(f => (f.raw as { format?: string; sourceAgentId?: string }).format === "kimi.wire.v1.5" && ((f.raw as { sourceAgentId?: string }).sourceAgentId ?? "main") === agent)
        expect(raw.map(f => (f.raw as { json: string }).json).join("\n") + "\n").toBe(originals.get(agent)!.split("\n").slice(0, lengths[index]).join("\n") + "\n")
      }
      previous = frames; await view.close()
    }
    const frozen = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await rm(f.directory, { recursive: true })
    expect(await read(frozen)).toEqual(previous.map(({ raw: _, ...frame }) => frame))
  })
  it.each(["cycle", "self-parent", "absent-parent", "wrong-owner", "cross-parent-resume", "incomplete-leaf", "background-leaf", "swarm-leaf", "leaf-undo"])("rejects nested %s before exposing a target", async kind => {
    const f = await fixture("nested-subagents"), meta = JSON.parse(f.metadata), middleFile = join(f.directory, "agents", "agent-0", "wire.jsonl"), leafFile = join(f.directory, "agents", "agent-1", "wire.jsonl")
    const rows = (await readFile(middleFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    if (kind === "cycle") meta.agents["agent-0"].labels.parentAgentId = "agent-1"
    if (kind === "self-parent") meta.agents["agent-1"].labels.parentAgentId = "agent-1"
    if (kind === "absent-parent") meta.agents["agent-1"].labels.parentAgentId = "agent-missing"
    if (kind === "wrong-owner") meta.agents["agent-1"].labels.parentAgentId = "main"
    const calls = rows.filter(row => row.event?.type === "tool.call")
    if (kind === "cross-parent-resume") calls[1].event.args.resume = "agent-0"
    if (kind === "background-leaf") calls[0].event.args.run_in_background = true
    if (kind === "swarm-leaf") calls[0].event.name = "AgentSwarm"
    await writeFile(f.state, JSON.stringify(meta)); await writeFile(middleFile, serialize(rows))
    if (kind === "incomplete-leaf") await rm(leafFile)
    if (kind === "leaf-undo") await appendFile(leafFile, serialize([{ type: "context.undo", agentId: "agent-1", count: 1, time: 1789401500000 }]))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toBeDefined()
  })
  it("scopes delegation call UUIDs to the parent Thread", async () => {
    const f = await fixture("nested-subagents"), middleFile = join(f.directory, "agents", "agent-0", "wire.jsonl")
    const before = await f.runtime.sourceCapture.open(f.request), original = await read(before); await before.close()
    const rows = (await readFile(middleFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    const rootId = f.rows.find(row => row.event?.type === "tool.call").event.uuid, childId = rows.find(row => row.event?.type === "tool.call").event.uuid
    await writeFile(middleFile, serialize(rows).replaceAll(childId, rootId))
    const after = await f.runtime.sourceCapture.open(f.request), frames = await read(after)
    expect(after.target).toEqual(before.target)
    expect(frames.flatMap(f => f.events).map(e => [e.sourceThreadId, e.childSourceThreadId, e.update])).toEqual(original.flatMap(f => f.events).map(e => [e.sourceThreadId, e.childSourceThreadId, e.update]))
    const events = frames.flatMap(f => f.events)
    expect(new Set(events.map(e => e.sourceEventId)).size).toBe(events.length)
  })
  it("captures completed native background tasks, background/foreground resume and independent children", async () => {
    const f = await fixture("background"), childFile = join(f.directory, "agents", "agent-0", "wire.jsonl")
    const child = (await readFile(childFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    let previous: SourceCapturePage["frames"][number][] = []
    for (const [rootLines, childLines, threads, events, usage, input, rootUsage, childInput] of [[38, 25, 2, 9, 5, 515, 3, 206], [69, 37, 2, 16, 9, 945, 6, 313], [88, 49, 2, 22, 12, 1278, 8, 424], [119, 49, 3, 31, 17, 1853, 11, 424]] as const) {
      const meta = JSON.parse(f.metadata)
      if (threads === 2) delete meta.agents["agent-1"]
      await writeFile(f.state, JSON.stringify(meta)); await writeFile(f.file, serialize(f.rows.slice(0, rootLines))); await writeFile(childFile, serialize(child.slice(0, childLines)))
      const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
      Schema.decodeUnknownSync(SourceCaptureHeader)(view)
      expect(view.target).toEqual({ threads, events, usage }); expect(view.session.captureStatus).toBe("healthy")
      const values = frames.flatMap(f => f.events), counts = frames.flatMap(f => f.usage)
      expect(values.slice(0, previous.flatMap(f => f.events).length)).toEqual(previous.flatMap(f => f.events))
      expect(counts.slice(0, previous.flatMap(f => f.usage).length)).toEqual(previous.flatMap(f => f.usage))
      expect(values.filter(e => e.childSourceThreadId).map(e => e.childSourceThreadId)).toEqual(threads === 3 ? ["agent-0", "agent-0", "agent-0", "agent-1"] : Array(usage === 5 ? 1 : usage === 9 ? 2 : 3).fill("agent-0"))
      const rootMessages = values.filter(e => e.sourceThreadId === f.request.sourceId && e.update.sessionUpdate === "user_message_chunk")
      expect(rootMessages).toHaveLength(usage === 5 ? 1 : usage === 9 ? 2 : usage === 12 ? 3 : 4)
      expect(JSON.stringify(values)).not.toContain('<notification id=')
      expect(JSON.stringify(frames)).toContain('<notification id=')
      expect(frames).toHaveLength(rootLines + childLines + (threads === 3 ? 25 : 0) + 1)
      expect(counts.reduce((n, u) => n + u.inputTokens!, 0)).toBe(input)
      expect(counts.filter(u => u.sourceThreadId === f.request.sourceId)).toHaveLength(rootUsage)
      expect(counts.filter(u => u.sourceThreadId === "agent-0").reduce((n, u) => n + u.inputTokens!, 0)).toBe(childInput)
      previous = frames; await view.close()
    }
    const frozen = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await rm(f.directory, { recursive: true })
    expect(await read(frozen)).toEqual(previous.map(({ raw: _, ...frame }) => frame))
  })
  it("allows background tool-call IDs to repeat in a later model step", async () => {
    const f = await fixture("background")
    await writeFile(f.file, f.native.replaceAll("controlled-call-6", "controlled-call-1"))
    const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    expect(view.target).toEqual({ events: 31, usage: 17, threads: 3 })
    const calls = frames.flatMap(f => f.events).filter(e => e.childSourceThreadId)
    expect(calls.map(e => e.childSourceThreadId)).toEqual(["agent-0", "agent-0", "agent-0", "agent-1"])
    expect(new Set(calls.map(e => "toolCallId" in e.update && e.update.toolCallId)).size).toBe(4)
  })
  it.each(["running", "missing-notification", "missing-context", "duplicate-notification", "wrong-task", "wrong-agent", "wrong-status", "wrong-description", "context-content", "context-origin", "late-child", "duplicate-task", "receipt-tail", "receipt-mode", "task-prompt-id", "missing-start", "missing-terminal", "terminal-status", "terminal-agent", "terminal-output", "duplicate-terminal", "foreign-output-path"])("validates background %s through the runtime Interface", async kind => {
    const f = await fixture("background"), notifications = f.rows.filter(row => row.type === "turn.prompt" && row.origin.kind === "task"), contexts = f.rows.filter(row => row.type === "context.append_message" && row.message.origin.kind === "task")
    if (kind === "running") f.rows.splice(28)
    if (kind === "missing-notification") f.rows.splice(f.rows.indexOf(notifications[0]), 1)
    if (kind === "missing-context") f.rows.splice(f.rows.indexOf(contexts[0]), 1)
    if (kind === "duplicate-notification") f.rows.push(notifications[0])
    if (kind === "wrong-task") notifications[0].origin.taskId = "agent-unknown0"
    if (kind === "wrong-agent") notifications[0].input[0].text = notifications[0].input[0].text.replace('agent_id="agent-0"', 'agent_id="agent-1"')
    if (kind === "wrong-status") notifications[0].origin.status = "lost"
    if (kind === "wrong-description") notifications[0].input[0].text = notifications[0].input[0].text.replace("Controlled child task completed.", "Unrelated task completed.")
    if (kind === "context-content") contexts[0].message.content[0].text = "unrelated context"
    if (kind === "context-origin") contexts[0].message.origin.notificationId = "other"
    if (kind === "task-prompt-id") notifications[0].promptId = "unexpected-id"
    if (kind === "late-child") {
      const childFile = join(f.directory, "agents", "agent-0", "wire.jsonl"), rows = (await readFile(childFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      rows.find(row => row.type === "turn.ended").time = notifications[0].time + 1
      await writeFile(childFile, serialize(rows))
    }
    const start = f.rows.find(row => row.type === "task.started"), terminal = f.rows.find(row => row.type === "task.terminated")
    if (kind === "missing-start") f.rows.splice(f.rows.indexOf(start), 1)
    if (kind === "missing-terminal") f.rows.splice(f.rows.indexOf(terminal), 1)
    if (kind === "terminal-status") terminal.info.status = "failed"
    if (kind === "terminal-agent") terminal.info.agentId = "agent-1"
    if (kind === "terminal-output") terminal.outputTail = "unrelated result"
    if (kind === "duplicate-terminal") f.rows.push(terminal)
    const receipts = f.rows.filter(row => row.event?.type === "tool.result" && String(row.event.result.output).startsWith("task_id:"))
    if (kind === "duplicate-task") receipts[1].event.result.output = receipts[0].event.result.output
    if (kind === "receipt-tail") receipts[0].event.result.output += "changed"
    if (kind === "receipt-mode") f.rows.find(row => row.event?.type === "tool.call" && row.event.name === "Agent").event.args.run_in_background = false
    if (kind === "foreign-output-path") for (const row of f.rows) {
      if (row.type === "turn.prompt" && row.origin.kind === "task") row.input[0].text = row.input[0].text.replaceAll("/fixture/kimi-home", "/must-not-read/outside")
      if (row.type === "context.append_message" && row.message.origin.kind === "task") row.message.content[0].text = row.message.content[0].text.replaceAll("/fixture/kimi-home", "/must-not-read/outside")
    }
    await writeFile(f.file, serialize(f.rows))
    if (kind === "foreign-output-path") expect((await f.runtime.sourceCapture.open(f.request)).target).toEqual({ events: 31, usage: 17, threads: 3 })
    else await expect(f.runtime.sourceCapture.open(f.request)).rejects.toBeDefined()
  })
  it("scopes native child identities by Session and ignores homedir locators", async () => {
    const f = await fixture("subagents"), view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
    await view.close()
    const otherId = "another-native-session", other = join(f.home, "sessions", "opaque", otherId), meta = JSON.parse(f.metadata)
    meta.id = otherId
    for (const agent of Object.values(meta.agents) as { homedir: string }[]) agent.homedir = "/unrelated/must-not-read"
    await cp(f.directory, other, { recursive: true }); await writeFile(join(other, "state.json"), JSON.stringify(meta))
    const copy = await f.runtime.sourceCapture.open({ ...f.request, sourceId: otherId }), copied = await read(copy)
    expect(copy.origin.cwd).toBe(view.origin.cwd)
    expect(copy.origin.originKey).not.toBe(view.origin.originKey)
    expect(copy.target).toEqual(view.target)
    const keys = new Set(frames.map(frame => frame.recordKey)), events = new Set(frames.flatMap(frame => frame.events).map(event => event.sourceEventId)), usage = new Set(frames.flatMap(frame => frame.usage).map(row => row.sourceUsageId))
    expect(copied.every(frame => !keys.has(frame.recordKey))).toBe(true)
    expect(copied.flatMap(frame => frame.events).every(event => !events.has(event.sourceEventId))).toBe(true)
    expect(copied.flatMap(frame => frame.usage).every(row => !usage.has(row.sourceUsageId))).toBe(true)
  })
  it.each(["missing", "symlink", "unfinished", "foreign-agent", "prompt", "summary", "metadata-parent", "parent-conflict", "path", "orphan", "receipt", "resume", "background", "fork", "undo", "nested", "thread-limit", "record-limit", "event-limit", "usage-limit"])("rejects %s child families before exposing a target", async kind => {
    const f = await fixture("subagents"), childFile = join(f.directory, "agents", "agent-0", "wire.jsonl")
    const rows = (await readFile(childFile, "utf8")).trim().split("\n").map(line => JSON.parse(line)), meta = JSON.parse(f.metadata)
    if (kind === "foreign-agent") rows[4].agentId = "main"
    if (kind === "prompt") rows[4].input[0].text = "unrelated delegated prompt"
    if (kind === "summary") rows[20].event.part.text = "different completion"
    if (kind === "metadata-parent") meta.agents["agent-0"].parentAgentId = "absent"
    if (kind === "parent-conflict") meta.agents["agent-0"].labels.parentAgentId = "agent-1"
    if (kind === "path") { meta.agents["../outside"] = meta.agents["agent-0"]; delete meta.agents["agent-0"] }
    if (kind === "orphan") meta.agents["agent-extra"] = meta.agents["agent-0"]
    if (kind === "receipt") f.rows[15].event.result.output = "agent_id: agent-unknown"
    if (kind === "resume") f.rows[33].event.args.resume = "agent-1"
    if (kind === "background") f.rows[14].event.args.run_in_background = true
    if (kind === "fork") meta.forkedFrom = "parent-session"
    if (kind === "undo") f.rows.push({ type: "context.undo", agentId: "main", count: 1, time: f.rows.at(-1).time })
    if (kind === "nested") rows[13].event.name = "Agent"
    await writeFile(childFile, serialize(rows)); await writeFile(f.state, JSON.stringify(meta)); await writeFile(f.file, serialize(f.rows))
    if (kind === "missing") await rm(childFile)
    if (kind === "symlink") { await rm(childFile); await symlink(f.file, childFile) }
    if (kind === "unfinished") await appendFile(childFile, "unfinished")
    const request = { ...f.request, limits: { ...limits, ...(kind === "thread-limit" ? { threads: 2 } : {}), ...(kind === "record-limit" ? { records: 100 } : {}) }, projection: { ...projection, ...(kind === "event-limit" ? { events: 21 } : {}), ...(kind === "usage-limit" ? { usage: 10 } : {}) } }
    await expect(f.runtime.sourceCapture.open(request)).rejects.toBeDefined()
  })
  it("captures a native fork independently through copied history, resume, undo and replacement", async () => {
    const f = await fixture("fork")
    let previous: SourceCapturePage["frames"][number][] = []
    for (const [length, eventCount, usageCount, input, output] of [[89, 6, 7, 728, 98], [102, 8, 8, 837, 117], [104, 6, 8, 837, 117], [117, 8, 9, 947, 137]]) {
      await writeFile(f.file, serialize(f.rows.slice(0, length)))
      const view = await f.runtime.sourceCapture.open(f.request), frames = await read(view)
      Schema.decodeUnknownSync(SourceCaptureHeader)(view)
      expect(view.profile).toBe("kimi.code.wire.fork.1")
      expect(view.session.captureStatus).toBe("healthy")
      expect(view.target).toEqual({ events: eventCount, usage: usageCount, threads: 1 })
      const events = frames.flatMap(f => f.events), usage = frames.flatMap(f => f.usage)
      expect(events.slice(0, 6)).toEqual(previous.length ? previous.flatMap(f => f.events).slice(0, 6) : events)
      expect(usage.slice(0, previous.flatMap(f => f.usage).length)).toEqual(previous.flatMap(f => f.usage))
      expect(usage.reduce((sum, u) => sum + u.inputTokens!, 0)).toBe(input)
      expect(usage.reduce((sum, u) => sum + u.outputTokens!, 0)).toBe(output)
      expect(events.every(e => e.sourceThreadId === f.request.sourceId)).toBe(true)
      expect(frames.slice(1).map(f => (f.raw as { json: string }).json).join("\n") + "\n").toBe(serialize(f.rows.slice(0, length)))
      previous = frames; await view.close()
    }
    expect(JSON.stringify(previous.flatMap(f => f.events))).toContain("KimiForkReplacement")
    expect(JSON.stringify(previous.flatMap(f => f.events))).not.toContain("KimiForkNext")
    expect(JSON.stringify(previous)).toContain("KimiForkNext")
    const frozen = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false })
    await rm(f.directory, { recursive: true })
    expect(await read(frozen)).toEqual(previous.map(({ raw: _, ...frame }) => frame))
  })
  it("keeps parent, fork and nested-fork identities distinct without requiring the parent source", async () => {
    const f = await fixture("context"), parent = await f.runtime.sourceCapture.open(f.request), parentFrames = await read(parent); await parent.close()
    const allIds = new Set(parentFrames.flatMap(f => f.events).map(e => e.sourceEventId))
    const usageIds = new Set(parentFrames.flatMap(f => f.usage).map(u => u.sourceUsageId))
    for (const [name, eventCount, usageCount, input, output] of [["fork", 8, 9, 947, 137], ["nested-fork", 10, 10, 1058, 158]] as const) {
      const meta = await readFile(new URL(`./fixtures/${name}-0.42.0.state.json`, import.meta.url), "utf8"), sid = JSON.parse(meta).id
      const directory = join(f.home, "sessions", "opaque", sid)
      await mkdir(join(directory, "agents", "main"), { recursive: true }); await writeFile(join(directory, "state.json"), meta)
      await writeFile(join(directory, "agents", "main", "wire.jsonl"), await readFile(new URL(`./fixtures/${name}-0.42.0.jsonl`, import.meta.url)))
      const view = await f.runtime.sourceCapture.open({ ...f.request, sourceId: sid }), frames = await read(view)
      expect(view.target).toEqual({ events: eventCount, usage: usageCount, threads: 1 })
      expect(view.origin.originKey).not.toBe(parent.origin.originKey)
      expect(view.origin.cwd).toBe(parent.origin.cwd)
      for (const e of frames.flatMap(f => f.events)) { expect(allIds.has(e.sourceEventId)).toBe(false); allIds.add(e.sourceEventId) }
      for (const u of frames.flatMap(f => f.usage)) { expect(usageIds.has(u.sourceUsageId)).toBe(false); usageIds.add(u.sourceUsageId) }
      expect(frames.flatMap(f => f.usage).reduce((sum, u) => sum + u.inputTokens!, 0)).toBe(input)
      expect(frames.flatMap(f => f.usage).reduce((sum, u) => sum + u.outputTokens!, 0)).toBe(output)
      await view.close()
      const discovery = Schema.decodeUnknownSync(SourceDiscoveryPage)(await f.runtime.sourceCapture.discover({ cursor: null, limits: { ...limits, pageRows: 10 }, signal: signal() }))
      expect(discovery.sourceFailures).toEqual([])
      expect(discovery.sources.some(s => s.sourceId === sid)).toBe(true)
      // Next iteration has only the nested fork and no readable ancestors.
      await rm(directory, { recursive: true })
      await rm(f.directory, { recursive: true, force: true })
    }
  })
  it.each(["missing-marker", "missing-parent", "self-parent", "invalid-parent", "active-marker", "compaction-marker", "unfinished-copy"])("rejects %s fork boundaries without exposing a target", async kind => {
    const f = await fixture("fork"), meta = JSON.parse(f.metadata)
    if (kind === "missing-marker") f.rows.splice(88, 1)
    if (kind === "missing-parent") delete meta.forkedFrom
    if (kind === "self-parent") meta.forkedFrom = meta.id
    if (kind === "invalid-parent") meta.forkedFrom = {}
    if (kind === "active-marker") f.rows.splice(94, 0, f.rows[88])
    if (kind === "compaction-marker") f.rows.splice(48, 0, f.rows[88])
    if (kind === "unfinished-copy") f.rows.splice(88)
    await writeFile(f.state, JSON.stringify(meta)); await writeFile(f.file, serialize(f.rows))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toBeDefined()
  })
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
