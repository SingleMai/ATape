import { AdapterCollectionLimits, SourceCaptureHeaderV2, SourceCapturePage, type AdapterOpenContext, type SourceCaptureFrame, type SourceOpenRequestV2 } from "@atape/domain"
import { Effect, Schema } from "effect"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { makeSecretRedactorLayer, prepareCanonicalSlice } from "../../../packages/application/src/index.ts"
import { createAtapeAdapter } from "./index.ts"
import { historicalPublicFactory } from "./fixtures/historicalPublicFactory.ts"

type Row = Record<string, any>
const folder = new URL("../fixtures/native-background-child-2.1.263/", import.meta.url)
const proof = JSON.parse(await readFile(new URL("provenance.json", folder), "utf8")) as Row
const nativeRoot = await readFile(new URL("root.jsonl", folder), "utf8")
const nativeChild = await readFile(new URL("child.jsonl", folder), "utf8")
const childId = `claude-agent:${proof.agentId}`, launchId = `${proof.call.receiptUuid}:0`
const limits = { rowBytes: 16 * 1024 * 1024, pageBytes: 32 * 1024 * 1024, pageRows: 100, records: 10000, threads: 100, durationMs: 300000 }
const projection = { events: 100000, usage: 100000, pageItems: 1, pageBytes: 32 * 1024 * 1024 }
const encode = (rows: Row[]) => rows.map(row => JSON.stringify(row) + "\n").join("")
const decode = (text: string): Row[] => text.trimEnd().split("\n").map(line => JSON.parse(line))
let directory: string, file: string, childFile: string, context: AdapterOpenContext & { signal: AbortSignal }
let historical: Awaited<ReturnType<typeof historicalPublicFactory>>
beforeAll(async () => { historical = await historicalPublicFactory() }, 120000)
afterAll(async () => { await historical?.cleanup() })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-background-"))
  file = join(directory, `${proof.sessionId}.jsonl`)
  childFile = join(directory, proof.sessionId, "subagents", `agent-${proof.agentId}.jsonl`)
  await mkdir(dirname(childFile), { recursive: true })
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.3" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const local = (text: string) => text.replaceAll(proof.fixtureCwd, directory)
const write = async (root = nativeRoot, child = nativeChild) => {
  await writeFile(file, local(root)); await writeFile(childFile, local(child))
}
const stage = async (label: string) => {
  const cut = proof.derivedStages.find((entry: Row) => entry.label === label)!
  await write(Buffer.from(nativeRoot).subarray(0, cut.root.bytes).toString("utf8"), Buffer.from(nativeChild).subarray(0, cut.child.bytes).toString("utf8"))
}
const rawText = (frames: SourceCaptureFrame[], thread = "root") => frames.flatMap(frame => {
  const raw = frame.raw as Row | undefined
  return raw?.format === "claude.jsonl.v1" && raw.sourceThreadId === thread ? [raw.jsonl as string] : []
}).join("")
const capture = async (extra: Partial<SourceOpenRequestV2> = {}) => {
  const runtime = await createAtapeAdapter(context)
  const request: SourceOpenRequestV2 = { sourceId: proof.sessionId, rawEnabled: true, limits, projection,
    priorThreads: [], signal: context.signal, ...extra }
  try {
    const view = await runtime.sourceCapture.open(request), header = Schema.decodeUnknownSync(SourceCaptureHeaderV2)(view)
    const frames: SourceCaptureFrame[] = []
    try {
      for (let n = 0; n < 20000; n++) {
        const page = Schema.decodeUnknownSync(SourceCapturePage)(await view.read(context.signal))
        for (const frame of page.frames) await Effect.runPromise(prepareCanonicalSlice("claude", { observationId: "background", observedAt: header.session.updatedAt,
          session: { ...header.session, revision: 1 }, threads: header.threads.map(thread => ({ ...thread, revision: 1 })),
          events: frame.events.map(event => ({ ...event, revision: 1, projectionRevision: 1, rawRef: { _tag: "unavailable", reason: "test" } })),
          usage: frame.usage.map(sample => ({ ...sample, revision: 1 })), rawSegments: [] }).pipe(Effect.provide(makeSecretRedactorLayer())))
        frames.push(...page.frames)
        if (page.done) {
          const events = frames.flatMap(frame => frame.events), usage = frames.flatMap(frame => frame.usage)
          expect(events.map(event => event.eventIndex)).toEqual(events.map((_, n) => n))
          expect(events.map(event => event.sourceOrder)).toEqual(events.map((_, n) => n))
          expect(events).toHaveLength(header.target.events); expect(usage).toHaveLength(header.target.usage)
          return { header, frames, events, usage }
        }
      }
      throw new Error("Background source exceeded its bounded page count")
    } finally { await view.close() }
  } finally { await runtime.close() }
}
const resume = (prior: Awaited<ReturnType<typeof capture>>): Partial<SourceOpenRequestV2> => ({ priorThreads: prior.header.threads, priorCheckpoint: prior.header.sourceCheckpoint })

it("captures the three actually observed native background snapshots through cold public views", async () => {
  let prior: Awaited<ReturnType<typeof capture>> | undefined
  for (const snapshot of proof.observedSnapshots) {
    await write(await readFile(new URL(snapshot.root, folder), "utf8"), await readFile(new URL(snapshot.child, folder), "utf8"))
    const actual = await capture(prior ? resume(prior) : {})
    expect(actual.header.sourceFailures).toEqual([])
    expect(actual.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root", childId])
    expect(actual.events.filter(event => event.childSourceThreadId)).toMatchObject([{ sourceEventId: launchId, childSourceThreadId: childId }])
    expect(rawText(actual.frames)).toBe(await readFile(file, "utf8"))
    expect(rawText(actual.frames, childId)).toBe(await readFile(childFile, "utf8"))
    if (prior) expect(prior.events.every(event => actual.events.some(current => current.sourceEventId === event.sourceEventId && current.sourceThreadId === event.sourceThreadId))).toBe(true)
    prior = actual
  }
  expect(prior!.events).toHaveLength(15); expect(prior!.usage).toHaveLength(8)
  expect(prior!.events.some(event => event.sourceEventId.startsWith(proof.notification.uuid))).toBe(false)
  for (const [id, expected] of Object.entries(proof.latestUsageByApiId) as Array<[string, Row]>)
    expect(prior!.usage.find(sample => sample.sourceUsageId === id)).toMatchObject({ sourceThreadId: expected.thread === "root" ? "root" : childId,
      inputTokens: expected.inputTokens, outputTokens: expected.outputTokens })
})

it("replays native-derived lifecycle cuts, including child-only append, without changing the launch anchor", async () => {
  const counts = [[4, 1], [7, 3], [11, 5], [12, 6], [12, 6], [13, 7], [15, 8]]
  let prior: Awaited<ReturnType<typeof capture>> | undefined
  for (const [index, cut] of proof.derivedStages.entries()) {
    await stage(cut.label)
    const actual = await capture(prior ? resume(prior) : {})
    expect([actual.events.length, actual.usage.length]).toEqual(counts[index])
    expect(actual.header.sourceFailures).toEqual([])
    expect(actual.events.filter(event => event.childSourceThreadId).map(event => event.sourceEventId)).toEqual([launchId])
    if (cut.label === "child-completed-root-unchanged") {
      expect(actual.events.filter(event => event.sourceThreadId === "root")).toEqual(prior!.events.filter(event => event.sourceThreadId === "root"))
      expect(JSON.parse(actual.header.sourceCheckpoint).streams.find((stream: Row) => stream.threadId === "root"))
        .toEqual(JSON.parse(prior!.header.sourceCheckpoint).streams.find((stream: Row) => stream.threadId === "root"))
      expect(actual.header.sourceCheckpoint).not.toBe(prior!.header.sourceCheckpoint)
    }
    expect(await capture(resume(actual))).toEqual(actual)
    prior = actual
  }
})

it("backfills root and child Raw after Raw-off capture with unchanged Canonical and usage", async () => {
  await write()
  const before = await capture({ rawEnabled: false }), after = await capture(resume(before))
  expect(before.frames.every(frame => frame.raw === undefined)).toBe(true)
  expect(after.events).toEqual(before.events); expect(after.usage).toEqual(before.usage)
  expect(after.header.sourceCheckpoint).toBe(before.header.sourceCheckpoint)
  expect(rawText(after.frames)).toBe(local(nativeRoot)); expect(rawText(after.frames, childId)).toBe(local(nativeChild))
})

it("retains a captured missing child, diagnoses a first missing child, and recovers exact source", async () => {
  await stage("running"); const before = await capture()
  await rm(childFile)
  const retained = await capture(resume(before)), fresh = await capture()
  expect(retained.header.target.retainedThreadIds).toEqual([childId])
  expect(retained.header.threads).toEqual(before.header.threads)
  expect(retained.events.find(event => event.sourceEventId === launchId)?.childSourceThreadId).toBe(childId)
  expect(retained.header.sourceCheckpoint).toBe(before.header.sourceCheckpoint)
  expect(retained.header.sourceFailures).toEqual([{ source: childFile, reason: "io" }])
  expect(fresh.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root"])
  expect(fresh.events.every(event => event.childSourceThreadId === undefined)).toBe(true)
  expect(fresh.header.sourceFailures).toEqual(retained.header.sourceFailures)
  await stage("child-completed-root-unchanged")
  const recovered = await capture(resume(retained))
  expect(recovered.header.target.retainedThreadIds).toEqual([]); expect(recovered.header.sourceFailures).toEqual([])
  expect(recovered.events.filter(event => event.sourceThreadId === childId)).toHaveLength(4)
})

it("retains the old proof when captured child bytes change and preserves valid root continuation", async () => {
  await stage("running"); const before = await capture()
  await write(nativeRoot, nativeChild.replace("Read child.txt once", "Read wrong.txt once"))
  const current = await capture(resume(before))
  expect(current.header.target.retainedThreadIds).toEqual([childId])
  expect(current.header.sourceFailures).toEqual([{ source: childFile, reason: "changed" }])
  expect(JSON.parse(current.header.sourceCheckpoint).streams.find((stream: Row) => stream.threadId === childId))
    .toEqual(JSON.parse(before.header.sourceCheckpoint).streams.find((stream: Row) => stream.threadId === childId))
  expect(current.events.at(-1)?.update).toMatchObject({ content: { text: expect.stringContaining("ATAPE_BG_PARENT_AFTER_FINAL") } })
})

it("withdraws a background child after parent rewind while retaining its full physical Raw eligibility", async () => {
  await write(); const before = await capture({ rawEnabled: false })
  const original = decode(local(nativeRoot)).find(row => row.type === "user")!
  await appendFile(file, JSON.stringify({ type: "last-prompt", sessionId: proof.sessionId, explicit: true, rewound: true, leafUuid: original.uuid }) + "\n")
  const after = await capture(resume(before))
  expect(after.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root"])
  expect(after.header.target.retainedThreadIds).toEqual([]); expect(after.events).toHaveLength(1); expect(after.usage).toEqual([])
  expect(after.header.sourceFailures).toEqual([])
  expect(rawText(after.frames, childId)).toBe(local(nativeChild))
  expect(rawText(after.frames)).toBe(await readFile(file, "utf8"))
})

it("defers an incomplete launch receipt without reading its proposed child", async () => {
  const lines = local(nativeRoot).split("\n"), receipt = lines[proof.call.receiptLine - 1]!
  await writeFile(childFile, "unadmitted invalid child\n")
  await writeFile(file, lines.slice(0, proof.call.receiptLine - 1).join("\n") + "\n" + receipt.slice(0, -1))
  const before = await capture()
  expect(before.header.threads).toHaveLength(1); expect(before.header.sourceFailures).toEqual([])
  await appendFile(file, receipt.slice(-1) + "\n"); await writeFile(childFile, local(nativeChild))
  const after = await capture(resume(before))
  expect(after.header.threads).toHaveLength(2); expect(after.header.sourceFailures).toEqual([])
})

it("defers incomplete child LF bytes without advancing its proof or losing the launch relationship", async () => {
  await stage("running"); const before = await capture()
  const final = Buffer.from(local(nativeChild)).subarray(Buffer.byteLength(await readFile(childFile, "utf8")))
  await appendFile(childFile, final.subarray(0, -2))
  const pending = await capture(resume(before))
  expect(pending.events).toEqual(before.events); expect(pending.usage).toEqual(before.usage)
  expect(pending.header.sourceCheckpoint).toBe(before.header.sourceCheckpoint)
  expect(rawText(pending.frames, childId)).toBe(rawText(before.frames, childId))
  await appendFile(childFile, final.subarray(-2))
  const completed = await capture(resume(pending))
  expect(completed.events).toHaveLength(before.events.length + 1); expect(completed.usage).toHaveLength(before.usage.length + 1)
  expect(completed.header.sourceFailures).toEqual([])
})

it("keeps capturing child thoughts and API usage after the first completion notification", async () => {
  await write(); const before = await capture(), original = decode(local(nativeChild)), last = original.at(-1)!
  const common = { sessionId: proof.sessionId, cwd: directory, agentId: proof.agentId, isSidechain: true, version: proof.nativeVersion }
  await appendFile(childFile, encode([
    { ...common, type: "user", uuid: "generated-child-followup", parentUuid: last.uuid, timestamp: "2026-10-09T12:00:00Z",
      message: { role: "user", content: "Generated child followup" } },
    { ...common, type: "assistant", uuid: "generated-child-answer", parentUuid: "generated-child-followup", timestamp: "2026-10-09T12:00:01Z",
      message: { role: "assistant", id: "generated-child-followup-api", model: "generated-model", usage: {
        input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      content: [{ type: "thinking", thinking: "Generated resumed child thought", signature: "raw-signature" }, { type: "text", text: "Generated child answer" }] } }
  ]))
  const after = await capture(resume(before))
  expect(after.events.filter(event => event.sourceThreadId === "root")).toEqual(before.events.filter(event => event.sourceThreadId === "root"))
  expect(after.events.filter(event => event.childSourceThreadId).map(event => event.sourceEventId)).toEqual([launchId])
  expect(after.events.at(-2)?.update).toMatchObject({ sessionUpdate: "agent_thought_chunk", content: { text: "Generated resumed child thought" } })
  expect(after.usage.at(-1)).toMatchObject({ sourceUsageId: "generated-child-followup-api", sourceThreadId: childId,
    inputTokens: 12, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 })
  expect(after.header.sourceFailures).toEqual([])
})

it.each(["session", "cwd", "agent", "sidechain"])("does not admit a child with generated conflicting %s ownership", async kind => {
  const child = decode(local(nativeChild))
  if (kind === "session") child[0]!.sessionId = "foreign-session"
  if (kind === "cwd") child[0]!.cwd = "/foreign-original"
  if (kind === "agent") child[0]!.agentId = "foreign-agent"
  if (kind === "sidechain") child[0]!.isSidechain = false
  await write(nativeRoot, encode(child)); const actual = await capture()
  expect(actual.header.threads.map(thread => thread.sourceThreadId)).toEqual(["root"])
  expect(actual.events.every(event => event.childSourceThreadId === undefined)).toBe(true)
  expect(actual.header.sourceFailures).toEqual([{ source: childFile, reason: "unsupported" }])
  expect(rawText(actual.frames, childId)).toBe("")
})

it.each(["not requested", "false request", "missing async", "false async", "top-level false async", "wrong status", "tool error", "missing call proof"])(
  "does not admit a generated unproved background receipt: %s", async kind => {
    const root = decode(local(nativeRoot)).slice(0, 18), call = root[proof.call.assistantLine - 1]!, receipt = root[proof.call.receiptLine - 1]!
    if (kind === "not requested") delete call.message.content[0].input.run_in_background
    if (kind === "false request") call.message.content[0].input.run_in_background = false
    if (kind === "missing async") delete receipt.toolUseResult.isAsync
    if (kind === "false async") receipt.toolUseResult.isAsync = false
    if (kind === "top-level false async") receipt.isAsync = false
    if (kind === "wrong status") receipt.toolUseResult.status = "completed"
    if (kind === "tool error") receipt.message.content[0].is_error = true
    if (kind === "missing call proof") delete receipt.sourceToolAssistantUUID
    await writeFile(file, encode(root)); await writeFile(childFile, "unadmitted invalid child\n")
    const actual = await capture()
    expect(actual.header.threads).toHaveLength(1); expect(actual.events).toHaveLength(8)
    expect(actual.header.sourceFailures).toEqual([{ source: file, reason: "unsupported" }])
    expect(actual.events.every(event => event.childSourceThreadId === undefined)).toBe(true)
    expect(rawText(actual.frames)).toBe(encode(root))
  })

it.each(["wrong type", "wrong role", "missing queue flag", "false queue flag", "tool result", "stale known parent", "unknown parent", "metadata",
  "missing UUID", "invalid UUID", "foreign session", "relative cwd", "foreign sidechain", "foreign agent", "meta", "blank body"])(
  "rejects malformed typed task notification rather than hiding it: %s", async kind => {
    const root = decode(local(nativeRoot)), notification = root[proof.notification.line - 1]!
    if (kind === "wrong type") notification.type = "assistant"
    if (kind === "wrong role") notification.message.role = "assistant"
    if (kind === "missing queue flag") delete notification.queueSkipAttachments
    if (kind === "false queue flag") notification.queueSkipAttachments = false
    if (kind === "tool result") notification.message.content = [{ type: "tool_result", tool_use_id: proof.call.toolCallId, content: "mixed" }]
    if (kind === "stale known parent") notification.parentUuid = root.find(row => row.type === "user")!.uuid
    if (kind === "unknown parent") notification.parentUuid = "unknown-parent"
    if (kind === "metadata") notification.toolUseResult = { agentId: proof.agentId }
    if (kind === "missing UUID") delete notification.uuid
    if (kind === "invalid UUID") notification.uuid = 123
    if (kind === "foreign session") notification.sessionId = "foreign-session"
    if (kind === "relative cwd") notification.cwd = "relative/cwd"
    if (kind === "foreign sidechain") notification.isSidechain = true
    if (kind === "foreign agent") notification.agentId = "foreign-agent"
    if (kind === "meta") notification.isMeta = true
    if (kind === "blank body") notification.message.content = " \n\t "
    await write(encode(root)); await expect(capture()).rejects.toMatchObject({ reason: "unsupported" })
  })

it.each([undefined, "invalid timestamp"])("rejects a typed notification with invalid timestamp=%s", async value => {
  const root = decode(local(nativeRoot)); root[proof.notification.line - 1]!.timestamp = value
  await write(encode(root)); await expect(capture()).rejects.toMatchObject({ reason: "format" })
})

it("allows a notification's absolute current CWD without changing creation attribution", async () => {
  const root = decode(local(nativeRoot)); root[proof.notification.line - 1]!.cwd = "/different-current-cwd"
  await write(encode(root)); const actual = await capture()
  expect(actual.header.origin.cwd).toBe(directory); expect(actual.events).toHaveLength(15)
})

it("keeps user-pasted task XML and does not rely on XML identifiers or output-file locators", async () => {
  const root = decode(local(nativeRoot)), notification = root[proof.notification.line - 1]!
  notification.message.content = notification.message.content.replace(proof.agentId, "unknown-task")
  root[proof.call.receiptLine - 1]!.toolUseResult.outputFile = "/untrusted/never-read.output"
  await write(encode(root)); expect((await capture()).events).toHaveLength(15)
  delete notification.origin; delete notification.queueSkipAttachments
  await write(encode(root)); const pasted = await capture()
  expect(pasted.events).toHaveLength(16)
  expect(pasted.events.find(event => event.sourceEventId === `${notification.uuid}:0`)?.update)
    .toMatchObject({ sessionUpdate: "user_message_chunk", content: { text: notification.message.content } })
})

it("validates a genuine legacy pending notification slot before v2 hides the generated long control body", async () => {
  // Only the long body is generated. The opaque pending cursor is emitted by
  // the genuine f609353 public collect factory, whose projection exposed it.
  const root = decode(local(nativeRoot)).slice(0, proof.notification.line)
  root.at(-1)!.message.content += "\n" + "generated control body ".repeat(20000)
  await write(encode(root))
  const old = await historical.createAtapeAdapter(context)
  let cursor: string | null = null, pending: Row | undefined
  try {
    for (let i = 0; i < 30; i++) {
      const page = await old.collect({ protocolVersion: "atape.adapter.v1alpha1", cursor, rawCaptureEnabled: false, rawProgress: [],
        limits: { ...AdapterCollectionLimits, eventsPerObservation: 1 }, signal: context.signal }) as Row
      cursor = page.nextCursor
      const checkpoint = JSON.parse(cursor!.startsWith("z3:") ? inflateRawSync(Buffer.from(cursor!.slice(3), "base64url")).toString("utf8") : cursor!).sessions[0].checkpoint
      if (page.observations.some((observation: Row) => observation.events.some((event: Row) => event.sourceEventId.startsWith(proof.notification.uuid))) && checkpoint.stream.eventSkip > 0) {
        pending = page; break
      }
    }
  } finally { await old.close?.() }
  expect(pending).toBeDefined()
  const actual = await capture({ legacyCheckpoint: pending!.nextCursor })
  expect(actual.events).toHaveLength(12); expect(actual.events.some(event => event.sourceEventId.startsWith(proof.notification.uuid))).toBe(false)
  expect(actual.header.sourceFailures).toEqual([])
})
