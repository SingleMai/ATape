import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Schema } from "effect"
import { SourceCapturePage, SourceDiscoveryPage } from "@atape/domain"
import { afterEach, describe, expect, it } from "vitest"
import { createOpenCodeRuntime } from "./runtime.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const limits = { rowBytes: 64 * 1024, pageBytes: 256 * 1024, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 256 * 1024 }
const signal = () => new AbortController().signal
const fixture = async () => {
  const evidence = JSON.parse(await readFile(new URL("./fixtures/native-v1.json", import.meta.url), "utf8")) as {
    rootID: string; childID: string; forkID: string; ddl: string[]; rows: Record<string, Record<string, SQLInputValue>[]>
  }
  const directory = await mkdtemp(join(tmpdir(), "atape-source-sdk-")); directories.push(directory)
  const path = join(directory, "opencode.db"), database = new DatabaseSync(path)
  database.exec("PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL")
  for (const ddl of evidence.ddl) database.exec(ddl)
  for (const [table, rows] of Object.entries(evidence.rows)) for (const row of rows) {
    const keys = Object.keys(row)
    database.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
  }
  database.close()
  return { path, evidence }
}
const discover = async (runtime: Awaited<ReturnType<typeof createOpenCodeRuntime>>) => {
  const sources: SourceDiscoveryPage["sources"][number][] = [], failures: SourceDiscoveryPage["sourceFailures"][number][] = []
  let cursor: string | null = null, pages = 0
  for (;;) {
    const page = Schema.decodeUnknownSync(SourceDiscoveryPage)(await runtime.sourceCapture.discover({ cursor, limits, signal: signal() }))
    sources.push(...page.sources); failures.push(...page.sourceFailures); pages++
    if (page.done) return { sources, failures, pages }
    expect(page.cursor).not.toBe(cursor); cursor = page.cursor
    expect(pages).toBeLessThan(20)
  }
}

describe("OpenCode source SDK runtime", () => {
  it("discovers root and fork once across child-only pages and uses original creation directories", async () => {
    const f = await fixture(), writer = new DatabaseSync(f.path)
    writer.exec("UPDATE session SET directory='/moved/current-directory'"); writer.close()
    const before = await stat(f.path), runtime = await createOpenCodeRuntime({ path: f.path, signal: signal() })
    try {
      const result = await discover(runtime)
      expect(result.sources.map(source => source.sourceId).sort()).toEqual([f.evidence.rootID, f.evidence.forkID].sort())
      expect(result.sources.every(source => source.cwd !== "/moved/current-directory")).toBe(true)
      expect(result.failures).toEqual([]); expect(result.pages).toBe(4)
    } finally { await runtime.close() }
    expect((await stat(f.path)).mtimeMs).toBe(before.mtimeMs)
  })
  it("reports unproven children and missing creation evidence without inventing roots", async () => {
    const f = await fixture(), writer = new DatabaseSync(f.path)
    writer.exec("PRAGMA foreign_keys=OFF")
    writer.prepare("UPDATE session SET parent_id='missing-parent' WHERE id=?").run(f.evidence.childID)
    writer.prepare("DELETE FROM event WHERE aggregate_id=?").run(f.evidence.forkID); writer.close()
    const runtime = await createOpenCodeRuntime({ path: f.path, signal: signal() })
    try {
      const result = await discover(runtime)
      expect(result.sources.map(source => source.sourceId)).toEqual([f.evidence.rootID])
      expect(result.failures).toEqual(expect.arrayContaining([{ source: f.evidence.childID, reason: "attribution" }, { source: f.evidence.forkID, reason: "attribution" }]))
    } finally { await runtime.close() }
  })
  it("streams native drafts through one scoped snapshot, enforces one open view and allows a fresh view after close", async () => {
    const f = await fixture(), runtime = await createOpenCodeRuntime({ path: f.path, signal: signal() })
    const request = { sourceId: f.evidence.rootID, rawEnabled: false, limits, projection, signal: signal() }
    try {
      const view = await runtime.sourceCapture.open(request)
      await expect(Promise.resolve(runtime.sourceCapture.open(request))).rejects.toMatchObject({ reason: "closed" })
      const frames: SourceCapturePage["frames"][number][] = []
      for (;;) {
        const page = Schema.decodeUnknownSync(SourceCapturePage)(await view.read(signal())); frames.push(...page.frames)
        if (page.done) break
      }
      expect(frames.flatMap(frame => frame.events)).toHaveLength(6)
      expect(frames.every(frame => frame.raw === undefined)).toBe(true)
      await view.close()
      await expect(Promise.resolve(view.read(signal()))).rejects.toMatchObject({ reason: "closed" })
      const fresh = await runtime.sourceCapture.open({ ...request, rawEnabled: true })
      expect(Schema.decodeUnknownSync(SourceCapturePage)(await fresh.read(signal())).frames.every(frame => frame.raw !== undefined)).toBe(true)
      await runtime.close()
      await expect(Promise.resolve(fresh.read(signal()))).rejects.toBeDefined()
    } finally { await runtime.close() }
  })
  it("admits the complete frame-page envelope at the exact byte boundary", async () => {
    const f = await fixture(), writer = new DatabaseSync(f.path)
    writer.exec("PRAGMA foreign_keys=OFF")
    writer.prepare("UPDATE part SET data=json_set(data,'$.text',?) WHERE id=(SELECT id FROM part WHERE session_id=? AND json_extract(data,'$.type')='text' LIMIT 1)").run("x".repeat(6000), f.evidence.rootID)
    writer.close()
    const runtime = await createOpenCodeRuntime({ path: f.path, signal: signal() })
    const request = { sourceId: f.evidence.rootID, rawEnabled: false, limits, projection: { ...projection, pageItems: 1 }, signal: signal() }
    try {
      const initial = await runtime.sourceCapture.open(request)
      let maximum = 0
      for (;;) {
        const page = Schema.decodeUnknownSync(SourceCapturePage)(await initial.read(signal()))
        for (const frame of page.frames) maximum = Math.max(maximum, Buffer.byteLength(JSON.stringify(frame)))
        if (page.done) break
      }
      await initial.close()
      await expect(Promise.resolve(runtime.sourceCapture.open({ ...request, projection: { ...request.projection, pageBytes: maximum + 2 } }))).rejects.toMatchObject({ reason: "limit" })
      const bytes = maximum + Buffer.byteLength(JSON.stringify({ frames: [], done: false }))
      const bounded = await runtime.sourceCapture.open({ ...request, projection: { ...request.projection, pageBytes: bytes } })
      for (;;) {
        const page = Schema.decodeUnknownSync(SourceCapturePage)(await bounded.read(signal()))
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(bytes)
        if (page.done) break
      }
      await bounded.close()
    } finally { await runtime.close() }
  })
  it("releases source resources on lifetime cancellation and preserves failures for missing databases", async () => {
    const f = await fixture(), lifetime = new AbortController(), runtime = await createOpenCodeRuntime({ path: f.path, signal: lifetime.signal })
    const view = await runtime.sourceCapture.open({ sourceId: f.evidence.rootID, rawEnabled: false, limits, projection, signal: signal() })
    lifetime.abort(); await runtime.close()
    await expect(Promise.resolve(view.read(signal()))).rejects.toBeDefined()
    const missing = await createOpenCodeRuntime({ path: f.path + ".missing", signal: signal() })
    try { await expect(discover(missing)).rejects.toMatchObject({ reason: "missing" }) } finally { await missing.close() }
  })
})
