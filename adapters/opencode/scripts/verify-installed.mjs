// Runs outside the checkout with only Node builtins and the installed artifact.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"

const { createAtapeAdapter } = await import(pathToFileURL(process.argv[2]).href)
assert.equal(typeof createAtapeAdapter, "function")
const fixture = JSON.parse(await readFile(new URL("./native-v1.json", import.meta.url), "utf8"))
const path = join(process.cwd(), "opencode.db"), database = new DatabaseSync(path)
try {
  database.exec("PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL")
  for (const ddl of fixture.ddl) database.exec(ddl)
  for (const [table, rows] of Object.entries(fixture.rows)) for (const row of rows) {
    const keys = Object.keys(row)
    database.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
  }
  database.exec("UPDATE session SET directory='/moved/current-directory'")
} finally { database.close() }
const digest = async () => createHash("sha256").update(await readFile(path)).digest("hex")
const before = { hash: await digest(), mtime: (await stat(path)).mtimeMs }
process.env.OPENCODE_DB = path
const limits = { rowBytes: 65536, pageBytes: 262144, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 }
const context = signal => ({ protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "opencode", version: "0.0.0" },
  project: { id: "controlled", type: "directory", path: process.cwd() }, signal })
const signal = AbortSignal.timeout(30000), lifetime = new AbortController()
const runtime = await createAtapeAdapter(context(lifetime.signal))
const request = { sourceId: fixture.rootID, rawEnabled: false, limits, projection, signal }
try {
  assert.equal(runtime.sourceCapture.protocolVersion, "atape.source-capture.v1")
  const sources = []
  let cursor = null, done = false, pages = 0
  while (!done && pages++ < 20) {
    const page = await runtime.sourceCapture.discover({ cursor, limits, signal })
    assert.ok(page.sources.length <= limits.pageRows)
    assert.deepEqual(page.sourceFailures, [])
    sources.push(...page.sources)
    done = page.done
    if (!done) { assert.notEqual(page.cursor, cursor); cursor = page.cursor }
  }
  assert.equal(done, true)
  assert.equal(pages, 4, "Child-only discovery pages must still advance")
  assert.deepEqual(sources.map(source => source.sourceId).sort(), [fixture.rootID, fixture.forkID].sort())
  assert.ok(sources.every(source => source.cwd !== "/moved/current-directory"))
  for (const rawEnabled of [false, true]) {
    const view = await runtime.sourceCapture.open({ ...request, rawEnabled })
    try {
      await assert.rejects(runtime.sourceCapture.open(request), { reason: "closed" })
      let events = 0, rows = 0, raw = 0, done = false, pages = 0
      while (!done && pages++ < 100) {
        const page = await view.read(signal)
        assert.ok(page.frames.length <= projection.pageItems)
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= projection.pageBytes)
        for (const frame of page.frames) { rows++; events += frame.events.length; raw += Number(frame.raw !== undefined) }
        done = page.done
      }
      assert.equal(done, true)
      assert.equal(events, 6)
      assert.ok(rows > 0)
      assert.equal(raw, rawEnabled ? rows : 0)
    } finally { await view.close() }
    await assert.rejects(view.read(signal), { reason: "closed" })
  }
  const active = await runtime.sourceCapture.open(request)
  lifetime.abort()
  // Observe cancellation before explicit cleanup; close() must not make an
  // ignored lifetime signal appear to work.
  await assert.rejects(active.read(signal))
  await assert.rejects(runtime.sourceCapture.open(request))
  await assert.rejects(runtime.sourceCapture.discover({ cursor: null, limits, signal }))
} finally { await runtime.close() }
assert.deepEqual({ hash: await digest(), mtime: (await stat(path)).mtimeMs }, before)
process.env.OPENCODE_DB = `${path}.missing`
const missing = await createAtapeAdapter(context(signal))
try {
  await assert.rejects(missing.sourceCapture.discover({ cursor: null, limits, signal }), { reason: "missing" })
  await assert.rejects(stat(process.env.OPENCODE_DB), { code: "ENOENT" })
} finally { await missing.close() }
process.stdout.write("Installed artifact: native discovery, bounded projection, Raw off/on, lifetime cancellation and read-only source verified.\n")
