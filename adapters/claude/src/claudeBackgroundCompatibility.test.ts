import { SourceCaptureHeaderV2, SourceCapturePage, type AdapterOpenContext, type SourceCaptureFrame,
  type SourceOpenRequestV2 } from "@atape/domain"
import { Schema } from "effect"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"
import { historicalSourceCaptureFactory } from "./fixtures/historicalSourceCaptureFactory.ts"

type Row = Record<string, any>
const folder = new URL("../fixtures/native-background-child-2.1.263/", import.meta.url)
const proof = JSON.parse(await readFile(new URL("provenance.json", folder), "utf8")) as Row
const root = await readFile(new URL("root.jsonl", folder), "utf8"), child = await readFile(new URL("child.jsonl", folder), "utf8")
const limits = { rowBytes: 16 * 1024 * 1024, pageBytes: 32 * 1024 * 1024, pageRows: 100, records: 10000, threads: 100, durationMs: 300000 }
const projection = { events: 100000, usage: 100000, pageItems: 1, pageBytes: 32 * 1024 * 1024 }
const childId = `claude-agent:${proof.agentId}`, notificationId = `${proof.notification.uuid}:0`, launchId = `${proof.call.receiptUuid}:0`
let historical: Awaited<ReturnType<typeof historicalSourceCaptureFactory>>
let directory: string, file: string, childFile: string, context: AdapterOpenContext & { signal: AbortSignal }
beforeAll(async () => { historical = await historicalSourceCaptureFactory() }, 120000)
afterAll(async () => { await historical?.cleanup() })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-background-upgrade-")); file = join(directory, `${proof.sessionId}.jsonl`)
  childFile = join(directory, proof.sessionId, "subagents", `agent-${proof.agentId}.jsonl`)
  await mkdir(dirname(childFile), { recursive: true })
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.3" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const local = (text: string) => text.replaceAll(proof.fixtureCwd, directory)
const capture = async (factory: typeof createAtapeAdapter, extra: Partial<SourceOpenRequestV2> = {}) => {
  const runtime = await factory(context)
  try {
    const view = await runtime.sourceCapture.open({ sourceId: proof.sessionId, rawEnabled: true, limits, projection,
      priorThreads: [], signal: context.signal, ...extra })
    const header = Schema.decodeUnknownSync(SourceCaptureHeaderV2)(view), frames: SourceCaptureFrame[] = []
    try {
      for (let n = 0; n < 1000; n++) {
        const page = Schema.decodeUnknownSync(SourceCapturePage)(await view.read(context.signal)); frames.push(...page.frames)
        if (page.done) {
          const events = frames.flatMap(frame => frame.events), usage = frames.flatMap(frame => frame.usage)
          expect(events).toHaveLength(header.target.events); expect(usage).toHaveLength(header.target.usage)
          return { header, frames, events, usage }
        }
      }
      throw new Error("Historical background capture exceeded its page bound.")
    } finally { await view.close() }
  } finally { await runtime.close() }
}
const raw = (frames: SourceCaptureFrame[], threadId: string) => frames.flatMap(frame => {
  const source = frame.raw as Row | undefined
  return source?.format === "claude.jsonl.v1" && source.sourceThreadId === threadId ? [source.jsonl as string] : []
}).join("")
const prior = (value: Awaited<ReturnType<typeof capture>>): Partial<SourceOpenRequestV2> => ({
  priorCheckpoint: value.header.sourceCheckpoint, priorThreads: value.header.threads
})

it.each([false, true])("upgrades genuine a525 v2 background capture on identical bytes (old Raw %s)", async oldRaw => {
  // These are unchanged native bytes apart from the same declared CWD relocation
  // used by both factories. The prior checkpoint is never manufactured/decoded.
  await writeFile(file, local(root)); await writeFile(childFile, local(child))
  const old = await capture(historical.createAtapeAdapter, { rawEnabled: oldRaw })
  expect(historical.proof.revision).toBe("a525090395ebddc7e05a0b97ab87cb91e655a11a")
  expect(old.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root"])
  expect(old.events).toHaveLength(12); expect(old.usage).toHaveLength(6)
  expect(old.events.find(event => event.sourceEventId === notificationId)?.update)
    .toMatchObject({ sessionUpdate: "user_message_chunk", content: { text: expect.stringContaining("<task-notification>") } })
  expect(old.events.find(event => event.sourceEventId === launchId)?.childSourceThreadId).toBeUndefined()

  const current = await capture(createAtapeAdapter, prior(old))
  expect(current.header.origin).toEqual(old.header.origin)
  expect(current.header.session).toEqual({ ...old.header.session, reportedEventCount: current.events.length })
  expect(current.header.threads.find(thread => thread.sourceThreadId === "root"))
    .toEqual(old.header.threads.find(thread => thread.sourceThreadId === "root"))
  expect(current.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root", childId])
  expect(current.header.target.retainedThreadIds).toEqual([]); expect(current.header.sourceFailures).toEqual([])
  expect(current.events).toHaveLength(15); expect(current.usage).toHaveLength(8)
  expect(current.events.some(event => event.sourceEventId === notificationId)).toBe(false)
  for (const event of old.events.filter(event => event.sourceEventId !== notificationId)) {
    const retained = current.events.find(value => value.sourceThreadId === event.sourceThreadId && value.sourceEventId === event.sourceEventId)
    expect(retained).toBeDefined()
    expect(retained).toMatchObject({ sourceEventId: event.sourceEventId, sourceThreadId: event.sourceThreadId, update: event.update })
  }
  expect(current.events.find(event => event.sourceEventId === launchId)?.childSourceThreadId).toBe(childId)
  expect(current.usage.filter(sample => sample.sourceThreadId === "root")).toEqual(old.usage)
  expect(new Set(current.usage.map(sample => sample.sourceUsageId)).size).toBe(8)
  expect(current.usage.reduce((sum, sample) => sum + (sample.inputTokens ?? 0), 0)).toBe(248)
  expect(current.usage.reduce((sum, sample) => sum + (sample.outputTokens ?? 0), 0)).toBe(136)
  expect(raw(current.frames, "root")).toBe(local(root)); expect(raw(current.frames, childId)).toBe(local(child))
  expect(await capture(createAtapeAdapter, prior(current))).toEqual(current)
  expect(await readFile(file, "utf8")).toBe(local(root)); expect(await readFile(childFile, "utf8")).toBe(local(child))
})

it("preserves a genuine a525 root proof while an independently appended child becomes visible", async () => {
  const cut = proof.derivedStages.find((stage: Row) => stage.label === "running")!
  const rootPrefix = local(Buffer.from(root).subarray(0, cut.root.bytes).toString("utf8"))
  await writeFile(file, rootPrefix)
  await writeFile(childFile, local(Buffer.from(child).subarray(0, cut.child.bytes).toString("utf8")))
  const old = await capture(historical.createAtapeAdapter), running = await capture(createAtapeAdapter, prior(old))
  expect(old.header.threads).toHaveLength(1); expect(running.header.threads).toHaveLength(2)
  expect(running.events).toHaveLength(11); expect(running.usage).toHaveLength(5)
  await writeFile(childFile, local(child))
  const completed = await capture(createAtapeAdapter, prior(running))
  expect(completed.events).toHaveLength(12); expect(completed.usage).toHaveLength(6)
  expect(completed.header.origin).toEqual(old.header.origin)
  expect(completed.events.filter(event => event.sourceThreadId === "root")).toEqual(running.events.filter(event => event.sourceThreadId === "root"))
  expect(raw(completed.frames, "root")).toBe(rootPrefix)
  expect(await readFile(file, "utf8")).toBe(rootPrefix)
  expect(await capture(createAtapeAdapter, prior(completed))).toEqual(completed)
})
