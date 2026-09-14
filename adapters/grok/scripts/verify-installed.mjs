import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const home = await mkdtemp(join(tmpdir(), "grok-installed-")), sourceId = "01a0987a-554b-7073-934d-da914245adbf"
process.env.ATAPE_GROK_HOME = home
const lifetime = new AbortController(), signal = lifetime.signal
const { createAtapeAdapter } = await import(pathToFileURL(process.argv[2]).href)
const runtime = await createAtapeAdapter({ protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "grok", version: process.argv[3] }, project: { id: "project", type: "directory", path: "/unrelated" }, signal })
const limits = { rowBytes: 65536, pageBytes: 262144, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 }
try {
  const path = join(home, "sessions", "opaque", sourceId); await mkdir(path, { recursive: true })
  let previous = []
  for (const [stage, count] of [["initial", 5], ["resumed", 10], ["shell", 15]]) {
    await cp(new URL(`./native-1.0.3/${stage}/`, import.meta.url), path, { recursive: true })
    const discovery = await runtime.sourceCapture.discover({ cursor: null, limits, signal })
    assert.equal(discovery.sources[0].cwd, "/fixture/grok-project"); assert.deepEqual(discovery.sourceFailures, [])
    for (const rawEnabled of [false, true]) {
      const view = await runtime.sourceCapture.open({ sourceId, rawEnabled, limits, projection, signal })
      const events = []; let done = false, raws = 0
      for (let n = 0; n < 30 && !done; n++) {
        const page = await view.read(signal)
        assert.ok(page.frames.length <= 2); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= projection.pageBytes)
        for (const frame of page.frames) { events.push(...frame.events); raws += Number(frame.raw !== undefined) }
        done = page.done
      }
      assert.equal(done, true); assert.equal(events.length, count); assert.equal(raws > 0, rawEnabled)
      assert.deepEqual(events.slice(0, previous.length), previous)
      if (rawEnabled) previous = events
      await view.close()
    }
  }
  const gitId = "01a0988a-e389-73f0-a5d6-fcd91c1f822b", gitPath = join(home, "sessions", "worktree", gitId)
  await cp(new URL("./native-1.0.3/worktree/", import.meta.url), gitPath, { recursive: true })
  const gitView = await runtime.sourceCapture.open({ sourceId: gitId, rawEnabled: false, limits, projection, signal })
  assert.equal(gitView.origin.cwd, "/fixture/grok-worktree")
  assert.deepEqual(gitView.target, { events: 2, usage: 1, threads: 1 })
  await gitView.close()
  for (const [stage, id, count] of [["edit", "88789e9d-9240-47c6-8a89-0842fc706348", 11], ["empty-search", "f0d683d2-d72e-4956-9a5b-a07eeb68e6fb", 5]]) {
    await cp(new URL(`./native-1.0.3/${stage}/`, import.meta.url), join(home, "sessions", "tools", id), { recursive: true })
    const view = await runtime.sourceCapture.open({ sourceId: id, rawEnabled: false, limits, projection, signal })
    const events = []
    for (let n = 0; n < 30; n++) {
      const page = await view.read(signal)
      assert.ok(page.frames.every(frame => frame.raw === undefined))
      events.push(...page.frames.flatMap(frame => frame.events))
      if (page.done) break
    }
    assert.equal(events.length, count)
    assert.equal(typeof events[3].update.rawOutput.stdout, "string")
    assert.equal(events[3].update.status, "completed")
    assert.equal(events[3].update.rawOutput.exit_code, stage === "edit" ? 0 : 1)
    if (stage === "edit") assert.equal(events[9].update.rawOutput.EditsApplied.new_string, "version=after")
    await view.close()
  }
  for (const stages of [["fork-created", "fork-resumed"], ["fork-nested", "fork-nested-resumed"]]) {
    let previous = [], previousUsage = [], origin
    for (const stage of stages) {
      const fixture = new URL(`./native-1.0.3/${stage}/`, import.meta.url)
      const summary = JSON.parse(await readFile(new URL("summary.json", fixture), "utf8")), forkId = summary.info.id
      await cp(fixture, join(home, "sessions", "fork", forkId), { recursive: true })
      for (const rawEnabled of [false, true]) {
        const view = await runtime.sourceCapture.open({ sourceId: forkId, rawEnabled, limits, projection, signal })
        assert.equal(view.profile, "grok.build.updates.fork.1")
        assert.equal(view.origin.cwd, "/fixture/grok-fork/project")
        if (origin) assert.deepEqual(view.origin, origin)
        const events = [], usage = []; let done = false, raws = 0
        for (let n = 0; n < 30 && !done; n++) {
          const page = await view.read(signal)
          assert.ok(page.frames.length <= 2)
          for (const frame of page.frames) { events.push(...frame.events); usage.push(...frame.usage); raws += Number(frame.raw !== undefined) }
          done = page.done
        }
        assert.equal(done, true); assert.equal(raws > 0, rawEnabled)
        assert.equal(events.length, { "fork-created": 10, "fork-resumed": 12, "fork-nested": 14, "fork-nested-resumed": 16 }[stage])
        assert.deepEqual(events.slice(0, previous.length), previous)
        assert.deepEqual(usage.slice(0, previousUsage.length), previousUsage)
        assert.ok(events.every(event => event.sourceThreadId === forkId))
        if (rawEnabled) { previous = events; previousUsage = usage; origin = view.origin }
        await view.close()
      }
    }
  }
  const view = await runtime.sourceCapture.open({ sourceId, rawEnabled: false, limits, projection, signal })
  lifetime.abort(); await assert.rejects(view.read(new AbortController().signal))
} finally { await runtime.close(); await rm(home, { recursive: true, force: true }) }
process.stdout.write("Installed Grok native create/resume/commands/search/edit/forks/nested forks, original CWD, stable identity, bounded pages, Raw off/on and cancellation verified.\n")
