// Executed outside the checkout; only the installed bundle and Node builtins.
import assert from "node:assert/strict"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const { createAtapeAdapter } = await import(pathToFileURL(process.argv[2]).href)
const native = await readFile(new URL("./native-0.42.0.jsonl", import.meta.url), "utf8")
const metadata = await readFile(new URL("./native-0.42.0.state.json", import.meta.url), "utf8")
const sourceId = JSON.parse(metadata).id, home = join(process.cwd(), "source"), dir = join(home, "sessions", "opaque", sourceId)
await mkdir(join(dir, "agents", "main"), { recursive: true })
await writeFile(join(dir, "state.json"), metadata)
const file = join(dir, "agents", "main", "wire.jsonl"); await writeFile(file, native)
process.env.ATAPE_KIMI_HOME = home
const lifetime = new AbortController(), signal = AbortSignal.timeout(30000)
const runtime = await createAtapeAdapter({ protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "kimi", version: process.argv[3] }, project: { id: "controlled", type: "directory", path: process.cwd() }, signal: lifetime.signal })
const limits = { rowBytes: 1048576, pageBytes: 2097152, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 2097152 }
try {
  const discovery = await runtime.sourceCapture.discover({ cursor: null, limits, signal })
  assert.equal(discovery.sources[0].sourceId, sourceId)
  assert.equal(discovery.sources[0].cwd, "/fixture/kimi-project")
  assert.deepEqual(discovery.sourceFailures, [])
  for (const rawEnabled of [false, true]) {
    const view = await runtime.sourceCapture.open({ sourceId, limits, projection, rawEnabled, signal })
    assert.deepEqual(view.target, { events: 13, usage: 5, threads: 1 })
    let events = 0, usage = 0, input = 0, done = false
    for (let count = 0; count < 100 && !done; count++) {
      const page = await view.read(signal)
      assert.ok(page.frames.length <= 2)
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= projection.pageBytes)
      for (const frame of page.frames) {
        events += frame.events.length; usage += frame.usage.length
        input += frame.usage.reduce((sum, row) => sum + row.inputTokens, 0)
        assert.equal(frame.raw !== undefined, rawEnabled)
      }
      done = page.done
    }
    assert.equal(done, true); assert.equal(events, 13); assert.equal(usage, 5); assert.equal(input, 540)
    await view.close()
  }
  assert.equal(await readFile(file, "utf8"), native)
  for (const [name, eventCount, usageCount, input] of [["context", 6, 7, 728], ["auto", 4, 3, 190205], ["clear", 2, 1, 108]]) {
    const state = await readFile(new URL(`./${name}-0.42.0.state.json`, import.meta.url), "utf8"), id = JSON.parse(state).id
    const directory = join(home, "sessions", "opaque", id)
    await mkdir(join(directory, "agents", "main"), { recursive: true })
    await writeFile(join(directory, "state.json"), state)
    await writeFile(join(directory, "agents", "main", "wire.jsonl"), await readFile(new URL(`./${name}-0.42.0.jsonl`, import.meta.url)))
    for (const rawEnabled of [false, true]) {
      const view = await runtime.sourceCapture.open({ sourceId: id, limits, projection, rawEnabled, signal })
      assert.deepEqual(view.target, { events: eventCount, usage: usageCount, threads: 1 })
      const frames = []
      for (let count = 0; count < 100; count++) {
        const page = await view.read(signal); frames.push(...page.frames)
        assert.ok(page.frames.length <= 2)
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= projection.pageBytes)
        if (page.done) break
        assert.ok(count < 99)
      }
      assert.equal(frames.flatMap(f => f.events).length, eventCount)
      assert.equal(frames.flatMap(f => f.usage).length, usageCount)
      assert.equal(frames.flatMap(f => f.usage).reduce((sum, row) => sum + row.inputTokens, 0), input)
      assert.ok(frames.every(f => (f.raw !== undefined) === rawEnabled))
      const events = JSON.stringify(frames.flatMap(f => f.events))
      if (name === "context") for (const absent of ["KimiUndoBefore", "KimiUndoAfter", "KimiContextReply4", "KimiContextReply7"]) assert.ok(!events.includes(absent))
      await view.close()
    }
  }
  const view = await runtime.sourceCapture.open({ sourceId, limits, projection, rawEnabled: false, signal })
  lifetime.abort(); await assert.rejects(view.read(signal))
} finally { await runtime.close(); await rm(home, { recursive: true }) }
process.stdout.write("Installed Kimi native resume, undo, manual/auto compaction, /clear, usage, original CWD, bounded pages, Raw off/on and cancellation verified.\n")
