import { mkdtemp, rm, stat, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { discoverOpenCodeSessions, openOpenCodeSource, type OpenCodeSourceLimits, type OpenCodeSourceRecord, type OpenCodeSourceView } from "./source.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const limits: OpenCodeSourceLimits = { rowBytes: 16 * 1024, pageBytes: 64 * 1024, pageRows: 3, records: 1000, threads: 20, durationMs: 10_000 }
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-opencode-source-")); directories.push(directory)
  const path = join(directory, "opencode.db"), db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT,parent_id TEXT,directory TEXT,title TEXT,version TEXT,
      time_created INTEGER,time_updated INTEGER,time_archived INTEGER,revert TEXT,unknown_metadata TEXT);
    CREATE INDEX session_parent_idx ON session(parent_id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX part_message_id_id_idx ON part(message_id,id); CREATE INDEX part_session_idx ON part(session_id);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT); CREATE INDEX v2_session ON session_message(session_id);`)
  const session = (id: string, parent: string | null = null) => db.prepare("INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "project", parent, directory, id, "1.18.30", 1000, 2000, null, null, "RAW_SESSION_SENTINEL")
  const message = (id: string, sessionId = "root", time = 1000) => db.prepare("INSERT INTO message VALUES(?,?,?,?,?)")
    .run(id, sessionId, time, time, JSON.stringify({ role: "user", time: { created: time }, unknown: "RAW_MESSAGE_SENTINEL" }))
  const part = (id: string, messageId: string, sessionId = "root", text = "A") => db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)")
    .run(id, messageId, sessionId, 1000, 1001, JSON.stringify({ type: "text", text, metadata: { future: "RAW_PART_SENTINEL" } }))
  session("root"); message("m1"); part("p1", "m1")
  const close = () => db.close()
  return { path, directory, db, session, message, part, close }
}
const readAll = (view: OpenCodeSourceView) => Effect.gen(function*() {
  const result: OpenCodeSourceRecord[] = []
  for (;;) { const page = yield* view.read(); result.push(...page.records); if (page.done) return result }
})
const capture = (path: string, rawEnabled = false, sessionId = "root", bounds = limits) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() { return yield* readAll(yield* openOpenCodeSource({ path, rawEnabled, sessionId, limits: bounds })) })))

describe("OpenCode read-only source", () => {
  it("rejects non-object source JSON and invalid discovery IDs instead of reporting empty content", async () => {
    const f = await fixture()
    for (const data of ["null", "[]", "42", '"text"', Buffer.from('{"type":"text","text":"A"}')]) {
      f.db.prepare("UPDATE part SET data=? WHERE id='p1'").run(data)
      for (const raw of [false, true]) await expect(capture(f.path, raw)).rejects.toMatchObject({ reason: "format" })
    }
    f.session("")
    await expect(Effect.runPromise(discoverOpenCodeSessions(f.path, { limit: 10 }))).rejects.toMatchObject({ reason: "format" })
    f.db.exec("DELETE FROM session WHERE id=''; UPDATE session SET id=NULL WHERE id='root'")
    await expect(Effect.runPromise(discoverOpenCodeSessions(f.path, { limit: 10 }))).rejects.toMatchObject({ reason: "format" })
    f.close()
  })
  it("preserves boolean projection fields instead of converting them to SQLite integers", async () => {
    const f = await fixture()
    f.db.prepare("UPDATE message SET data=? WHERE id='m1'").run(JSON.stringify({ role: "assistant", time: { created: 1000 }, summary: true }))
    f.db.prepare("UPDATE part SET data=? WHERE id='p1'").run(JSON.stringify({ type: "text", text: "A", ignored: false, synthetic: true, auto: false }))
    f.close()
    for (const raw of [false, true]) {
      const rows = await capture(f.path, raw)
      expect(rows.find(row => row.table === "message")?.data.summary).toBe(true)
      expect(rows.find(row => row.table === "part")?.data).toMatchObject({ ignored: false, synthetic: true, auto: false })
    }
  })
  it("rejects composite source identities that would make row IDs ambiguous across Sessions", async () => {
    const f = await fixture()
    f.db.exec(`DROP TABLE message; CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT,PRIMARY KEY(id,session_id));
      CREATE INDEX message_order ON message(session_id,time_created,id)`)
    f.message("same", "root"); f.session("child", "root"); f.message("same", "child")
    f.close()
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "unsupported" })
  })
  it("never seals missing traversal membership as complete when message ordering keys are invalid", async () => {
    const f = await fixture()
    for (const time of [-2, null]) {
      f.db.prepare("UPDATE message SET time_created=? WHERE id='m1'").run(time)
      await expect(capture(f.path)).rejects.toMatchObject({ reason: "format" })
    }
    f.close()
  })
  it("matches the controlled native v1 export for every message and part, including child, fork and compaction", async () => {
    const evidence = JSON.parse(await readFile(new URL("./fixtures/native-v1.json", import.meta.url), "utf8")) as {
      rootID: string; childID: string; forkID: string; ddl: string[];
      rows: Record<string, Record<string, SQLInputValue>[]>; exports: Record<string, { info: { id: string }; parts: unknown[] }[]>
    }
    const directory = await mkdtemp(join(tmpdir(), "atape-opencode-native-contract-")); directories.push(directory)
    const path = join(directory, "opencode.db"), db = new DatabaseSync(path)
    db.exec("PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL")
    for (const ddl of evidence.ddl) db.exec(ddl)
    for (const [table, rows] of Object.entries(evidence.rows)) for (const row of rows) {
      const keys = Object.keys(row)
      db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
    }
    db.close()
    const roots = await capture(path, true, evidence.rootID)
    const forks = await capture(path, true, evidence.forkID)
    for (const [label, sessionId, rows] of [["root", evidence.rootID, roots], ["child", evidence.childID, roots], ["fork", evidence.forkID, forks]] as const) {
      const messages = rows.filter(row => row.table === "message" && row.sessionId === sessionId).map(row => ({
        info: { ...JSON.parse(String(row.raw!.data)), id: row.id, sessionID: row.sessionId },
        parts: rows.filter(part => part.table === "part" && part.messageId === row.id).map(part => ({
          ...JSON.parse(String(part.raw!.data)), id: part.id, sessionID: part.sessionId, messageID: part.messageId
        }))
      }))
      expect(messages).toEqual(evidence.exports[label])
    }
    const projected = await capture(path, false, evidence.rootID)
    expect(JSON.stringify(projected)).not.toContain("atapeFixtureUnknown")
    expect(projected.some(row => row.data.type === "compaction")).toBe(true)
    expect(projected.some(row => row.data.type === "tool")).toBe(true)
  })
  it("pages native IDs and resolves child families while keeping copied forks independent", async () => {
    const f = await fixture()
    f.session("child", "root"); f.message("cm", "child"); f.part("cp", "cm", "child", "child")
    f.session("fork"); f.message("fm", "fork"); f.part("fp", "fm", "fork", "A")
    f.close()
    expect(await Effect.runPromise(discoverOpenCodeSessions(f.path, { limit: 2 }))).toEqual(["child", "fork"])
    expect(await Effect.runPromise(discoverOpenCodeSessions(f.path, { afterId: "fork", limit: 2 }))).toEqual(["root"])
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const view = yield* openOpenCodeSource({ path: f.path, sessionId: "child", rawEnabled: false, limits })
      expect(view.root.id).toBe("root"); expect(view.threads.map(thread => thread.id)).toEqual(["root", "child"])
      const records = yield* readAll(view)
      expect(records.map(record => record.id)).toEqual(["root", "m1", "p1", "child", "cm", "cp"])
      expect(JSON.stringify(records)).not.toContain("SENTINEL")
      expect(records.every(record => record.raw === undefined)).toBe(true)
    })))
    expect((await capture(f.path, true, "fork")).map(record => record.id)).toEqual(["fork", "fm", "fp"])
  })
  it("preserves complete Raw row columns and original JSON text only under explicit Raw enablement", async () => {
    const f = await fixture()
    const text = ' { "type": "text", "text": "中文 🚀", "metadata": {"future": [1,true,null]} }\n'
    f.db.prepare("UPDATE part SET data=? WHERE id='p1'").run(text); f.close()
    const before = await stat(f.path)
    const rows = await capture(f.path, true)
    expect(rows.find(row => row.id === "p1")?.raw?.data).toBe(text)
    expect(rows.find(row => row.id === "root")?.raw?.unknown_metadata).toBe("RAW_SESSION_SENTINEL")
    expect(rows.find(row => row.id === "p1")?.data.text).toBe("中文 🚀")
    expect(JSON.stringify((await capture(f.path)).map(row => row.data))).not.toContain("future")
    expect((await stat(f.path)).mtimeMs).toBe(before.mtimeMs)
  })
  it("retains one snapshot across pages while another writer changes and deletes source rows", async () => {
    const f = await fixture()
    f.message("m2", "root", 1000); f.part("p2", "m2", "root", "second")
    const rows = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const view = yield* openOpenCodeSource({ path: f.path, sessionId: "root", rawEnabled: true, limits: { ...limits, pageRows: 1 } })
      const first = yield* view.read()
      f.db.prepare("UPDATE part SET data=? WHERE id='p1'").run(JSON.stringify({ type: "text", text: "B" }))
      f.db.exec("DELETE FROM part WHERE id='p2'; DELETE FROM message WHERE id='m2'")
      return [...first.records, ...yield* readAll(view)]
    })))
    expect(rows.map(row => row.id)).toEqual(["root", "m1", "p1", "m2", "p2"])
    expect(rows.find(row => row.id === "p1")?.data.text).toBe("A")
    f.close()
    const fresh = await capture(f.path)
    expect(fresh.map(row => row.id)).toEqual(["root", "m1", "p1"])
    expect(fresh.find(row => row.id === "p1")?.data.text).toBe("B")
  })
  it("rejects v2-only and mixed families, missing parents, cycles and unresolved revert boundaries", async () => {
    const f = await fixture()
    f.db.exec("INSERT INTO session_message VALUES('v2','root')")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "unsupported" })
    f.db.exec("DELETE FROM session_message; UPDATE session SET parent_id='missing' WHERE id='root'")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "missing" })
    f.db.exec("UPDATE session SET parent_id='root' WHERE id='root'")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "attribution" })
    f.db.exec("UPDATE session SET parent_id=NULL,revert='{\"messageID\":\"gone\"}' WHERE id='root'")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "format" })
    f.db.exec("UPDATE session SET revert=NULL; UPDATE part SET session_id='other' WHERE id='p1'")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "format" })
    f.close()
  })
  it("does not treat missing, unsupported, malformed or oversized history as an empty successful capture", async () => {
    const f = await fixture()
    await expect(capture(join(f.directory, "absent.db"))).rejects.toMatchObject({ reason: "missing" })
    f.db.exec("DROP INDEX part_message_id_id_idx")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "unsupported" })
    f.db.exec("CREATE INDEX equivalent_index ON part(message_id,id); UPDATE part SET data='{' WHERE id='p1'")
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "format" })
    f.db.prepare("UPDATE part SET data=? WHERE id='p1'").run(JSON.stringify({ type: "text", text: "x".repeat(20_000) }))
    await expect(capture(f.path)).rejects.toMatchObject({ reason: "limit" })
    await expect(capture(f.path, true)).rejects.toMatchObject({ reason: "limit" })
    f.close()
  })
  it("enforces record, family, page and lifetime bounds and prevents reuse after scope exit", async () => {
    const f = await fixture()
    f.session("child", "root")
    await expect(capture(f.path, false, "root", { ...limits, threads: 1 })).rejects.toMatchObject({ reason: "limit" })
    await expect(capture(f.path, false, "root", { ...limits, records: 2 })).rejects.toMatchObject({ reason: "limit" })
    let closed!: OpenCodeSourceView
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      closed = yield* openOpenCodeSource({ path: f.path, sessionId: "root", rawEnabled: true, limits: { ...limits, pageRows: 1 } })
      for (;;) { const page = yield* closed.read(); expect(page.records.length).toBeLessThanOrEqual(1)
        expect(Buffer.byteLength(JSON.stringify(page.records))).toBeLessThan(limits.pageBytes); if (page.done) break }
    })))
    await expect(Effect.runPromise(closed.read())).rejects.toMatchObject({ reason: "closed" })
    await expect(Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const view = yield* openOpenCodeSource({ path: f.path, sessionId: "root", rawEnabled: false, limits: { ...limits, durationMs: 2 } })
      yield* Effect.sleep(10)
      return yield* view.read()
    })))).rejects.toMatchObject({ reason: "limit" })
    f.close()
  })
})
