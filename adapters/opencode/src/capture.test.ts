import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Effect, Schema } from "effect"
import { AdapterEvent, AdapterSession, AdapterThread, AdapterUsage } from "@atape/domain"
import { afterEach, describe, expect, it } from "vitest"
import { openOpenCodeCapture, type OpenCodeCaptureFrame } from "./capture.ts"
import { openOpenCodeSource } from "./source.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const limits = { rowBytes: 64 * 1024, pageBytes: 256 * 1024, pageRows: 2, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 256 * 1024 }
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-opencode-capture-")); directories.push(directory)
  const path = join(directory, "opencode.db"), db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT,parent_id TEXT,directory TEXT,title TEXT,version TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER,revert TEXT);
    CREATE INDEX session_parent_idx ON session(parent_id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX message_order ON message(session_id,time_created,id);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX part_order ON part(message_id,id); CREATE INDEX part_session ON part(session_id);
    CREATE TABLE event(id TEXT PRIMARY KEY,aggregate_id TEXT,seq INTEGER,type TEXT,data TEXT);
    CREATE INDEX event_order ON event(aggregate_id,type,seq);`)
  const session = (id: string, parent: string | null = null) => {
    db.prepare("INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, "project", parent, directory, id, "1.18.30", 1000, 2000, null, null)
    db.prepare("INSERT INTO event VALUES(?,?,?,?,?)").run("created-" + id, id, 0, "session.created.1", JSON.stringify({ sessionID: id, info: { id, parentID: parent, directory, time: { created: 1000 } } }))
  }
  const message = (id: string, role = "user", data = {}, sessionId = "root") =>
    db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(id, sessionId, 1000, 2000, JSON.stringify({ role, time: { created: 1000 }, ...data }))
  const part = (id: string, messageId: string, data: Record<string, unknown>, sessionId = "root") =>
    db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(id, messageId, sessionId, 1000, 2000, JSON.stringify(data))
  session("root"); message("m1"); part("p1", "m1", { type: "text", text: "first" })
  return { path, directory, db, session, message, part }
}
type View = Effect.Success<ReturnType<typeof openOpenCodeCapture>>
const readAll = (view: View) => Effect.gen(function*() {
  const frames: OpenCodeCaptureFrame[] = []
  for (;;) {
    const page = yield* view.read(); frames.push(...page.frames)
    expect(page.frames.length).toBeLessThanOrEqual(projection.pageItems)
    expect(Buffer.byteLength(JSON.stringify(page.frames))).toBeLessThanOrEqual(projection.pageBytes)
    if (page.done) return frames
  }
})
const capture = (path: string, rawEnabled = false, sessionId = "root") => Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const view = yield* openOpenCodeCapture({ path, sessionId, rawEnabled, limits, projection })
  return { origin: view.origin, session: view.session, threads: view.threads, target: view.target, frames: yield* readAll(view) }
})))

describe("OpenCode scoped projection", () => {
  it("uses immutable creation evidence across moves and rejects missing, ambiguous or mismatched evidence", async () => {
    const f = await fixture(), before = await capture(f.path)
    f.db.prepare("UPDATE session SET directory=?").run("/a/moved/project")
    expect((await capture(f.path)).origin).toEqual(before.origin)
    expect(before.origin.cwd).toBe(f.directory)
    f.db.exec("INSERT INTO event SELECT 'duplicate',aggregate_id,1,type,data FROM event")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "attribution" })
    f.db.exec("DELETE FROM event WHERE id='duplicate'; UPDATE event SET data=json_set(data,'$.info.time.created',1001)")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "attribution" })
    f.db.exec("DELETE FROM event")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "attribution" }); f.db.close()
  })
  it("projects the Active Path across part rewind, unrevert and deletion without dropping Raw suffixes or native children", async () => {
    const f = await fixture()
    f.part("p2", "m1", { type: "text", text: "second" }); f.message("m2"); f.part("p3", "m2", { type: "text", text: "third" })
    f.session("child", "root"); f.message("cm", "user", {}, "child"); f.part("cp", "cm", { type: "text", text: "child" }, "child")
    const full = await capture(f.path, true)
    f.db.exec(`UPDATE session SET revert='{"messageID":"m1","partID":"p2"}' WHERE id='root'`)
    const reverted = await capture(f.path, true)
    expect(reverted.frames.flatMap(frame => frame.events).map(event => event.sourceEventId)).toEqual([full.frames.flatMap(frame => frame.events)[0]!.sourceEventId, full.frames.flatMap(frame => frame.events)[3]!.sourceEventId])
    expect(reverted.frames.map(frame => frame.raw)).toHaveLength(full.frames.length)
    expect(reverted.threads).toHaveLength(2)
    f.db.exec("UPDATE session SET revert=NULL")
    expect((await capture(f.path)).frames.flatMap(frame => frame.events)).toEqual(full.frames.flatMap(frame => frame.events))
    f.db.exec("DELETE FROM part WHERE id IN ('p2','p3'); DELETE FROM message WHERE id='m2'")
    expect((await capture(f.path)).target.events).toBe(2); f.db.close()
  })
  it("retains fixed tool slots, native status and only proven child ownership, including completed assistants without finish", async () => {
    const f = await fixture()
    f.session("child", "root"); f.session("fork")
    f.message("m2", "assistant", { time: { created: 1000, completed: 2000 } })
    const tool = (status: string, sessionId = "child") => ({ type: "tool", callID: "call", tool: "task", state: { status, input: { task: "do it" }, output: "done", error: "failed", time: { start: 1100, end: 1900 }, metadata: { sessionId } } })
    f.part("p2", "m2", tool("running"))
    const running = await capture(f.path)
    f.db.prepare("UPDATE part SET data=? WHERE id='p2'").run(JSON.stringify(tool("completed")))
    const complete = await capture(f.path), events = complete.frames.flatMap(frame => frame.events)
    expect(events[1]!.sourceEventId).toBe(running.frames.flatMap(frame => frame.events)[1]!.sourceEventId)
    expect(events[1]!.childSourceThreadId).toBe("child"); expect(events[2]!.childSourceThreadId).toBeUndefined()
    expect(events[2]!.update).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed", rawOutput: "done" })
    expect(complete.session.status).toBe("idle")
    f.db.prepare("UPDATE part SET data=? WHERE id='p2'").run(JSON.stringify(tool("error", "fork")))
    const error = (await capture(f.path)).frames.flatMap(frame => frame.events)
    expect(error[1]!.childSourceThreadId).toBeUndefined(); expect(error[2]!.update).toMatchObject({ status: "failed", rawOutput: "failed" })
    for (const event of events) Schema.decodeUnknownSync(AdapterEvent)({ ...event, revision: 1, projectionRevision: 1, rawRef: { _tag: "unavailable", reason: "disabled" } })
    Schema.decodeUnknownSync(AdapterSession)({ ...complete.session, revision: 1 })
    for (const thread of complete.threads) Schema.decodeUnknownSync(AdapterThread)({ ...thread, revision: 1 })
    f.db.close()
  })
  it("counts only step usage with cache and reasoning restored, preserving unknown values and rejecting invalid totals", async () => {
    const f = await fixture()
    f.message("m2", "assistant", { modelID: "model", providerID: "provider", tokens: { input: 99999 } })
    f.part("p2", "m2", { type: "step-finish", tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } } })
    f.part("p3", "m2", { type: "step-finish", tokens: { input: 2, output: 1, cache: { read: 1 } } })
    const usage = (await capture(f.path)).frames.flatMap(frame => frame.usage)
    expect(usage).toHaveLength(2)
    expect(usage[0]).toMatchObject({ inputTokens: 19, outputTokens: 23, cacheReadTokens: 4, cacheWriteTokens: 5, model: "model" })
    expect(usage[1]!.inputTokens).toBeUndefined(); expect(usage[1]!.outputTokens).toBeUndefined()
    for (const item of usage) Schema.decodeUnknownSync(AdapterUsage)({ ...item, revision: 1 })
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
      f.db.prepare("UPDATE part SET data=json_set(data,'$.tokens.input',?) WHERE id='p2'").run(value)
      await expect(capture(f.path)).rejects.toMatchObject({ reason: "format" })
    }
    f.db.close()
  })
  it("retains emitted output when a running tool is interrupted", async () => {
    const f = await fixture(); f.message("m2", "assistant")
    const part = { type: "tool", callID: "call", tool: "bash", state: { status: "running", input: {}, error: "Tool execution aborted", metadata: { output: "already emitted", interrupted: true } } }
    f.part("p2", "m2", part)
    expect((await capture(f.path)).frames.flatMap(frame => frame.events)[1]!.update).toMatchObject({ status: "in_progress", rawOutput: "already emitted" })
    part.state.status = "error"; f.db.prepare("UPDATE part SET data=? WHERE id='p2'").run(JSON.stringify(part))
    const events = (await capture(f.path)).frames.flatMap(frame => frame.events)
    expect(events[2]!.update).toMatchObject({ status: "failed", rawOutput: { output: "already emitted", error: "Tool execution aborted", interrupted: true } }); f.db.close()
  })
  it("keeps compacted tool output and ignored/unknown/inline parts as source evidence with explicit partial fidelity", async () => {
    const f = await fixture()
    f.part("p2", "m1", { type: "text", text: "ignored", ignored: true })
    f.part("p3", "m1", { type: "text", text: "synthetic", synthetic: true })
    f.part("p4", "m1", { type: "file", url: "data:image/png;base64,PRIVATE", mime: "image/png" })
    f.part("p5", "m1", { type: "file", url: "file:///does-not-exist/image.png", mime: "image/png" })
    f.part("p6", "m1", { type: "future-provider-part", metadata: "UNKNOWN" })
    f.message("m2", "assistant")
    f.part("p7", "m2", { type: "tool", callID: "call", tool: "bash", state: { status: "completed", input: {}, output: "original output", time: { compacted: 2000 }, attachments: [{ url: "data:image/png;base64,TOOL_PRIVATE" }] } })
    f.part("p8", "m2", { type: "compaction", auto: true })
    const result = await capture(f.path, true), events = result.frames.flatMap(frame => frame.events)
    expect(result.session.captureStatus).toBe("partial")
    expect(events).toHaveLength(5); expect(events[1]!.fidelity).toBe("derived")
    expect(events[2]!.update).toMatchObject({ content: { type: "resource_link", uri: "file:///does-not-exist/image.png" } })
    expect(events[4]!.update).toMatchObject({ rawOutput: "original output" })
    expect(JSON.stringify(events)).not.toContain("PRIVATE"); expect(JSON.stringify(result.frames)).toContain("PRIVATE")
    expect(JSON.stringify((await capture(f.path)).frames)).not.toContain("UNKNOWN")
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const source = yield* openOpenCodeSource({ path: f.path, sessionId: "root", rawEnabled: false, limits })
      for (;;) { const page = yield* source.read(); expect(JSON.stringify(page.records)).not.toContain("PRIVATE"); if (page.done) break }
    })))
    f.db.close()
  })
  it("freezes plan/output in one snapshot despite external writes and disallows post-scope reuse", async () => {
    const f = await fixture(); let escaped!: View
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      escaped = yield* openOpenCodeCapture({ path: f.path, sessionId: "root", rawEnabled: false, limits, projection })
      f.db.prepare("UPDATE part SET data=?").run(JSON.stringify({ type: "text", text: "changed" }))
      f.message("m0"); f.part("p0", "m0", { type: "text", text: "insert earlier" })
      const events = (yield* readAll(escaped)).flatMap(frame => frame.events)
      expect(events).toHaveLength(1); expect(events[0]!.update).toMatchObject({ content: { text: "first" } })
    })))
    await expect(Effect.runPromise(escaped.read())).rejects.toMatchObject({ reason: "closed" })
    const fresh = await capture(f.path)
    expect(fresh.target.events).toBe(2); expect(fresh.frames.flatMap(frame => frame.events).map(event => event.sourceOrder)).toEqual([0, 1]); f.db.close()
  })
  it("permits exactly one complete source rescan and enforces projection admission", async () => {
    const f = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const view = yield* openOpenCodeSource({ path: f.path, sessionId: "root", rawEnabled: false, limits })
      expect((yield* Effect.result(view.rewind()))._tag).toBe("Failure")
      while (!(yield* view.read()).done) {}
      yield* view.rewind(); while (!(yield* view.read()).done) {}
      expect((yield* Effect.result(view.rewind()))._tag).toBe("Failure")
    })))
    f.part("p2", "m1", { type: "text", text: "second" })
    await expect(Effect.runPromise(Effect.scoped(openOpenCodeCapture({ path: f.path, sessionId: "root", rawEnabled: false, limits, projection: { ...projection, events: 1 } })))).rejects.toMatchObject({ reason: "limit" }); f.db.close()
  })
  it("projects actual native root/child/fork fixtures using their original creation events", async () => {
    const evidence = JSON.parse(await readFile(new URL("./fixtures/native-v1.json", import.meta.url), "utf8")) as {
      rootID: string; childID: string; forkID: string; ddl: string[]; rows: Record<string, Record<string, SQLInputValue>[]>
    }
    const directory = await mkdtemp(join(tmpdir(), "atape-native-projection-")); directories.push(directory)
    const path = join(directory, "opencode.db"), db = new DatabaseSync(path)
    db.exec("PRAGMA foreign_keys=OFF")
    for (const ddl of evidence.ddl) db.exec(ddl)
    for (const [table, rows] of Object.entries(evidence.rows)) for (const row of rows) {
      const keys = Object.keys(row)
      db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
    }
    db.close()
    const root = await capture(path, true, evidence.childID), fork = await capture(path, false, evidence.forkID)
    expect(root.origin.sourceId).toBe(evidence.rootID); expect(root.threads.map(thread => thread.sourceThreadId)).toEqual([evidence.rootID, evidence.childID])
    expect(fork.threads).toHaveLength(1); expect(fork.origin.originKey).not.toBe(root.origin.originKey)
    expect(root.frames.flatMap(frame => frame.events).some(event => event.update.sessionUpdate === "tool_call_update")).toBe(true)
    expect(root.frames.flatMap(frame => frame.events)).toHaveLength(root.target.events)
  })
  it("admits every encoded frame before returning a plan and expires already buffered pages", async () => {
    const f = await fixture()
    f.part("p2", "m1", { type: "text", text: "x".repeat(4000) })
    await expect(Effect.runPromise(Effect.scoped(openOpenCodeCapture({ path: f.path, sessionId: "root", rawEnabled: false, limits,
      projection: { ...projection, pageBytes: 1000 } })))).rejects.toMatchObject({ reason: "limit" })
    await expect(Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const view = yield* openOpenCodeCapture({ path: f.path, sessionId: "root", rawEnabled: false,
        limits: { ...limits, pageRows: 100, durationMs: 100 }, projection: { ...projection, pageItems: 1 } })
      yield* view.read()
      yield* Effect.sleep(120)
      return yield* view.read()
    })))).rejects.toMatchObject({ reason: "limit" })
    f.db.close()
  })
})
