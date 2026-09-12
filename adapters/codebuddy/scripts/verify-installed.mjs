// Executed outside the checkout: only the installed tarball and Node builtins.
import assert from "node:assert/strict"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const { createAtapeAdapter } = await import(pathToFileURL(process.argv[2]).href)
const native = await readFile(new URL("./native-2.124.0.jsonl", import.meta.url), "utf8")
const home = join(process.cwd(), "source"), dir = join(home, "projects", "opaque")
await mkdir(dir, { recursive: true })
const sourceId = "atape-codebuddy-native-21240", file = join(dir, `${sourceId}.jsonl`)
await writeFile(file, native)
process.env.ATAPE_CODEBUDDY_HOME = home
const lifetime = new AbortController(), signal = AbortSignal.timeout(30000)
const runtime = await createAtapeAdapter({ protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "codebuddy", version: process.argv[3] }, project: { id: "controlled", type: "directory", path: process.cwd() }, signal: lifetime.signal })
const limits = { rowBytes: 65536, pageBytes: 262144, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 }
try {
  const page = await runtime.sourceCapture.discover({ cursor: null, limits, signal })
  assert.equal(page.sources[0].sourceId, sourceId)
  assert.equal(page.sources[0].cwd, "/fixture/codebuddy-project")
  assert.deepEqual(page.sourceFailures, [])
  for (const rawEnabled of [false, true]) {
    const view = await runtime.sourceCapture.open({ sourceId, limits, projection, rawEnabled, signal })
    assert.deepEqual(view.target, { events: 12, usage: 5, threads: 1 })
    let events = 0, usage = 0, count = 0, done = false
    while (!done && count++ < 20) {
      const page = await view.read(signal)
      assert.ok(page.frames.length <= 2)
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= projection.pageBytes)
      for (const frame of page.frames) {
        events += frame.events.length; usage += frame.usage.length
        assert.equal(frame.raw !== undefined, rawEnabled)
      }
      done = page.done
    }
    assert.equal(done, true); assert.equal(events, 12); assert.equal(usage, 5)
    await view.close()
  }
  for (const fixture of [
    { name: "native-nested-fork", id: "atape-codebuddy-nested-fork-21240", cwd: "fork", events: 18, usage: 8, meta: "native-fork" },
    { name: "native-compaction", id: "atape-codebuddy-compact-21240", cwd: "compact", events: 10, usage: 4 },
    { name: "native-compaction-fork", id: "atape-codebuddy-compact-fork-21240", cwd: "compact", events: 12, usage: 5, meta: "native-compaction-fork" }
  ]) {
    await writeFile(join(dir, `${fixture.id}.jsonl`), await readFile(new URL(`./${fixture.name}-2.124.0.jsonl`, import.meta.url), "utf8"))
    if (fixture.meta) await writeFile(join(dir, `${fixture.id}.meta.json`), await readFile(new URL(`./${fixture.meta}-2.124.0.meta.json`, import.meta.url), "utf8"))
    for (const rawEnabled of [false, true]) {
      const view = await runtime.sourceCapture.open({ sourceId: fixture.id, limits, projection, rawEnabled, signal })
      assert.equal(view.origin.cwd, `/fixture/codebuddy-${fixture.cwd}-project`)
      assert.deepEqual(view.target, { events: fixture.events, usage: fixture.usage, threads: 1 })
      let events = 0, sidecars = 0, done = false
      for (let count = 0; count < 30 && !done; count++) {
        const page = await view.read(signal)
        for (const frame of page.frames) {
          events += frame.events.length
          assert.equal(frame.raw !== undefined, rawEnabled)
          if (frame.raw?.sidecar?.json.includes("forkedFrom")) sidecars++
        }
        done = page.done
      }
      assert.equal(done, true); assert.equal(events, fixture.events); assert.equal(sidecars, rawEnabled && fixture.meta ? 1 : 0)
      await view.close()
    }
  }
  await cp(new URL("./native-family-2.124.0", import.meta.url), dir, { recursive: true })
  for (const rawEnabled of [false, true]) {
    const view = await runtime.sourceCapture.open({ sourceId: "atape-codebuddy-child-21240", limits, projection, rawEnabled, signal })
    assert.deepEqual(view.target, { events: 37, usage: 15, threads: 5 })
    assert.equal(view.origin.cwd, "/fixture/codebuddy-family-project")
    assert.equal(view.threads.find(thread => thread.sourceThreadId === "agent-bc513377").parentSourceThreadId, "agent-60a8b853")
    let done = false, events = 0, childLinks = 0, samples = 0
    for (let count = 0; count < 30 && !done; count++) {
      const page = await view.read(signal)
      for (const frame of page.frames) {
        events += frame.events.length; samples += frame.usage.length
        childLinks += frame.events.filter(event => event.childSourceThreadId).length
        assert.equal(frame.raw !== undefined, rawEnabled)
      }
      done = page.done
    }
    assert.equal(done, true); assert.equal(events, 37); assert.equal(samples, 15); assert.equal(childLinks, 5)
    await view.close()
  }
  assert.equal(await readFile(file, "utf8"), native)
  const view = await runtime.sourceCapture.open({ sourceId, limits, projection, rawEnabled: false, signal })
  lifetime.abort()
  await assert.rejects(view.read(signal))
} finally { await runtime.close(); await rm(home, { recursive: true }) }
process.stdout.write("Installed CodeBuddy native/fork/resume/compaction/family projection, original CWD, bounded pages, Raw off/on and cancellation verified.\n")
