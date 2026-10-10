import assert from "node:assert/strict"
import { copyFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
const base = await realpath(await mkdtemp(join(tmpdir(), "cursor-installed-")))
const root = join(base, "cursor"), cwd = join(base, "workspace")
await mkdir(cwd)
process.env.CURSOR_CONFIG_DIR = root; process.env.CURSOR_DATA_DIR = root
const rows = [
  { role: "user", message: { content: [{ type: "text", text: "--literal 中文\nwhole text" }] }, vendor: { unknown: true } },
  { role: "assistant", message: { content: [{ type: "text", text: "answer" }, { type: "tool_use", name: "write_file", input: { text: "quoted \"value\"\nline" } }] } },
  { type: "turn_ended", status: "success" }
]
const content = rows.map(row => JSON.stringify(row) + "\n").join("")
const control = { mode: "complete", hold: false, cwd, rows, ready: join(base, "ready.json"), exited: join(base, "exited.json"), command: join(base, "command"), prompt: "--literal 中文" }
const file = join(base, "cursor-agent"); await copyFile(new URL("./native-agent.mjs", import.meta.url), file); await chmod(file, 0o700)
const controlPath = join(base, "control.json"); await writeFile(controlPath, JSON.stringify(control))
process.env.ATAPE_CURSOR_EXECUTABLE = file; process.env.CURSOR_TEST_CONTROL = controlPath
const { createAtapeAdapter } = await import(pathToFileURL(process.argv[2]).href)
const signal = new AbortController().signal, receipts = new Map()
const runtime = await createAtapeAdapter({ protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "cursor", version: process.argv[3] },
  project: { id: "project", type: "directory", path: cwd }, signal,
  creationReceipts: { readConfirmed: async ({ sourceId }) => receipts.get(sourceId) } })
const limits = { rowBytes: 1048576, pageBytes: 262144, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 100, pageItems: 1, pageBytes: 262144 }
try {
  assert.equal(runtime.newSession.protocolVersion, "atape.new-session.v1")
  assert.equal(runtime.sourceCapture.protocolVersion, "atape.source-capture.v2")
  assert.deepEqual((await runtime.sourceCapture.discover({ cursor: null, limits, signal })).sources, [])
  await assert.rejects(readFile(root), { code: "ENOENT" })
  let attempt
  const result = await runtime.newSession.start({ origin: { cwd }, initialPrompt: control.prompt, signal, creation: {
    recordAttempt: async input => attempt = { protocolVersion: "atape.creation-receipt.v1", attemptId: randomUUID(), adapterId: "cursor", ...input,
      origin: { sourceId: input.sourceId, originKey: "origin-" + input.sourceId, cwd }, recordedAt: "2026-10-10T00:00:00Z" },
    confirm: async ({ prefix }) => { const receipt = { ...attempt, confirmedAt: "2026-10-10T00:00:01Z", prefix }; receipts.set(attempt.sourceId, receipt); return receipt },
    abandon: async () => { throw new Error("Successful native proof must not be abandoned") }
  } })
  assert.deepEqual(result, { sourceId: attempt.sourceId, creation: "confirmed", exitCode: 0 })
  assert.deepEqual(receipts.get(attempt.sourceId).prefix, { bytes: Buffer.byteLength(content), rows: 3, sha256: createHash("sha256").update(content).digest("hex") })
  const page = await runtime.sourceCapture.discover({ cursor: null, limits, signal })
  assert.deepEqual(page.sources, [attempt.origin]); assert.deepEqual(page.sourceFailures, [])
  let checkpoint, previous = []
  for (let round = 0; round < 4; round++) {
    if (round > 0) {
      const old = await readFile(attempt.sourcePath)
      const addition = JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "repeat" }] } }) + "\n"
      await writeFile(attempt.sourcePath, Buffer.concat([old, Buffer.from(addition)]))
    }
    for (const rawEnabled of [false, true]) {
      const view = await runtime.sourceCapture.open({ sourceId: attempt.sourceId, rawEnabled, limits, projection, signal, priorThreads: [], ...(checkpoint ? { priorCheckpoint: checkpoint } : {}) })
      assert.equal(view.canonicalProfileVersion, "atape.acp-centered.v3"); assert.equal(view.session.updatedAt, null)
      assert.equal(view.session.title, rows[0].message.content[0].text); assert.equal(view.session.status, "idle")
      const frames = []
      for (let n = 0; n < 30; n++) {
        const part = await view.read(signal); assert.ok(part.frames.length <= 1)
        assert.ok(Buffer.byteLength(JSON.stringify(part)) <= projection.pageBytes)
        frames.push(...part.frames); if (part.done) break
        assert.ok(n < 29)
      }
      const events = frames.flatMap(frame => frame.events)
      assert.equal(events.length, 3 + round); assert.ok(events.every(event => event.occurredAt === null && event.fidelity === "partial"))
      assert.deepEqual(events.slice(0, previous.length), previous)
      assert.deepEqual(events.slice(0, 3).map(event => event.sourceEventId), ["row:1:part:0", "row:2:part:0", "row:2:part:1"])
      assert.equal(events[2].update.status, undefined); assert.equal(frames[2].events.length, 0)
      assert.ok(frames.every(frame => (frame.raw !== undefined) === rawEnabled))
      if (rawEnabled) { assert.deepEqual(frames[0].raw.record, rows[0]); assert.equal(frames[0].raw.rawJson, undefined); previous = events }
      checkpoint = view.sourceCheckpoint; assert.ok(Buffer.byteLength(checkpoint) < 512)
      await view.close()
    }
  }
  await writeFile(attempt.sourcePath, content)
  await assert.rejects(runtime.sourceCapture.open({ sourceId: attempt.sourceId, rawEnabled: false, limits, projection, signal, priorThreads: [], priorCheckpoint: checkpoint }), { reason: "changed" })
  const history = join(dirname(dirname(attempt.sourcePath)), "historical")
  await mkdir(history); await writeFile(join(history, "historical.jsonl"), content)
  const historical = await runtime.sourceCapture.discover({ cursor: null, limits: { ...limits, pageRows: 100 }, signal })
  assert.deepEqual(historical.sources, [attempt.origin]); assert.equal(historical.sourceFailures[0].reason, "attribution")
  process.stdout.write("Installed Cursor synthetic controlled start, immutable receipt, v3 unknown clocks, stable derived IDs, bounded pages, structured Raw off/on and prefix continuity verified. Native authenticated acceptance remains deferred.\n")
} finally { await runtime.close(); await rm(base, { recursive: true, force: true }) }
