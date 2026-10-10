import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AdapterOpenContext, type ConfirmedCreationReceipt, type CreationReceiptAttempt, type CreationReceiptAttemptInput,
  type CreationReceiptPrefix, type NewSessionStartRequest, type SourceCaptureFrame, type SourceOpenRequestV2 } from "@atape/domain"
import { Schema } from "effect"
import { SourceDiscoveryPage, SourceCapturePage, SourceCaptureHeaderV2 } from "@atape/domain"
import { createAtapeAdapter } from "./runtime.ts"

const limits = { rowBytes: 1024 * 1024, pageBytes: 256 * 1024, pageRows: 2, records: 100_000, threads: 20, durationMs: 10_000 }
const projection = { events: 100_000, usage: 100, pageItems: 1, pageBytes: 256 * 1024 }
const user = (text: string) => ({ role: "user", message: { content: [{ type: "text", text }] } })
const rows = [user(" entire\nuser text "), { role: "assistant", message: { content: [{ type: "text", text: "answer" }, { type: "tool_use", name: "write_file", input: { text: "quoted \"value\"\n保持" } }] } }, { type: "turn_ended", status: "success" }]
const lines = (values: readonly unknown[]) => values.map(row => JSON.stringify(row) + "\n").join("")
const prefix = (content: string): CreationReceiptPrefix => ({ bytes: Buffer.byteLength(content), rows: content.split("\n").length - 1, sha256: createHash("sha256").update(content).digest("hex") })
const slug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
// Exercise the foreign SDK boundary with the same shared decoders as its Host caller.
const decodedFactory = async (context: Parameters<typeof createAtapeAdapter>[0]) => {
  const runtime = await createAtapeAdapter(context)
  return { ...runtime, close: async () => { await runtime.close() }, sourceCapture: { ...runtime.sourceCapture,
    discover: async (request: Parameters<typeof runtime.sourceCapture.discover>[0]) => Schema.decodeUnknownSync(SourceDiscoveryPage)(await runtime.sourceCapture.discover(request)),
    open: async (request: SourceOpenRequestV2) => { const view = await runtime.sourceCapture.open(request); Schema.decodeUnknownSync(SourceCaptureHeaderV2)(view)
      return { ...view, close: async () => { await view.close() }, read: async (signal: AbortSignal) => Schema.decodeUnknownSync(SourceCapturePage)(await view.read(signal)) } }
  } }
}
const cleanup: Array<() => Promise<unknown>> = []
const waitFor = async <A>(read: () => Promise<A | undefined>, duration = 5000): Promise<A> => {
  const deadline = Date.now() + duration
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error("Synthetic process barrier was not reached")
}
const json = async (path: string): Promise<Record<string, unknown> | undefined> => { try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> } catch { return undefined } }
const fixture = async (content = lines(rows), exists = true) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "atape-cursor-runtime-")))
  cleanup.push(() => rm(base, { recursive: true, force: true }))
  const root = join(base, "cursor"), cwd = join(base, "workspace"); await mkdir(cwd)
  if (exists) await mkdir(root)
  vi.stubEnv("CURSOR_CONFIG_DIR", root); vi.stubEnv("CURSOR_DATA_DIR", root)
  const sourceId = randomUUID(), path = join(root, "projects", slug(cwd), "agent-transcripts", sourceId, sourceId + ".jsonl")
  const receipts = new Map<string, ConfirmedCreationReceipt>()
  const makeReceipt = (id = sourceId, text = content): ConfirmedCreationReceipt => ({ protocolVersion: "atape.creation-receipt.v1", attemptId: randomUUID(), adapterId: "cursor", sourceId: id,
    stateDirectory: root, profile: "cursor.cli.jsonl.2026-10-01.v1", sourcePath: join(root, "projects", slug(cwd), "agent-transcripts", id, id + ".jsonl"),
    origin: { sourceId: id, originKey: "origin-" + id, cwd }, recordedAt: "2026-10-10T00:00:00Z", confirmedAt: "2026-10-10T00:00:01Z", prefix: prefix(text) })
  const context: AdapterOpenContext & { signal: AbortSignal } = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "cursor", version: "0.5.5" },
    project: { id: "project", type: "directory", path: cwd }, signal: new AbortController().signal,
    creationReceipts: { readConfirmed: async ({ sourceId: id }) => receipts.get(id) } }
  const runtime = await decodedFactory(context); cleanup.push(() => runtime.close())
  const signal = new AbortController().signal
  const request: SourceOpenRequestV2 = { sourceId, rawEnabled: true, limits, projection, signal, priorThreads: [] }
  const put = async (id = sourceId, text = content) => { const p = join(root, "projects", slug(cwd), "agent-transcripts", id, id + ".jsonl"); await mkdir(dirname(p), { recursive: true }); await writeFile(p, text); return p }
  return { base, root, cwd, sourceId, path, receipts, makeReceipt, context, runtime, request, put, signal }
}
const drain = async (view: Awaited<ReturnType<Awaited<ReturnType<typeof decodedFactory>>["sourceCapture"]["open"]>>) => {
  const frames: SourceCaptureFrame[] = []
  for (let pages = 0; pages < 200; pages++) { const page = await view.read(new AbortController().signal); frames.push(...page.frames); if (page.done) return frames }
  throw new Error("Source did not finish")
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

describe("Cursor public sourceCapture factory", () => {
  it("keeps missing roots read-only and requires the creation receipt capability", async () => {
    const f = await fixture(undefined, false)
    expect(await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: f.signal })).toMatchObject({ sources: [], done: true })
    await expect(readFile(f.root)).rejects.toMatchObject({ code: "ENOENT" })
    const { creationReceipts: _, ...legacy } = f.context
    await expect(createAtapeAdapter(legacy)).rejects.toMatchObject({ reason: "unsupported" })
  })
  it.each(["relative", "split", "symlink"])("rejects unsupported %s roots without guessing native state", async mode => {
    const f = await fixture(); await f.runtime.close()
    if (mode === "relative") vi.stubEnv("CURSOR_DATA_DIR", "relative")
    if (mode === "split") { const other = join(f.base, "other"); await mkdir(other); vi.stubEnv("CURSOR_CONFIG_DIR", other) }
    if (mode === "symlink") { const linked = join(f.base, "linked"); await symlink(f.root, linked); vi.stubEnv("CURSOR_DATA_DIR", linked); vi.stubEnv("CURSOR_CONFIG_DIR", linked) }
    const runtime = await decodedFactory(f.context); cleanup.push(() => runtime.close())
    await expect(runtime.sourceCapture.discover({ cursor: null, limits, signal: f.signal })).rejects.toMatchObject({ reason: "unsupported" })
  })
  it("isolates unattributed and mismatched receipts while retaining healthy immutable Origins", async () => {
    const f = await fixture(); await f.put(); f.receipts.set(f.sourceId, f.makeReceipt())
    const history = randomUUID(), mismatch = randomUUID(); await f.put(history); await f.put(mismatch)
    f.receipts.set(mismatch, { ...f.makeReceipt(mismatch), profile: "unsupported-profile" })
    const page = await f.runtime.sourceCapture.discover({ cursor: null, limits: { ...limits, pageRows: 100 }, signal: f.signal })
    expect(page.sources).toEqual([f.makeReceipt().origin])
    expect(page.sourceFailures?.map(value => value.reason)).toEqual(["attribution", "attribution"])
    await expect(f.runtime.sourceCapture.open({ ...f.request, sourceId: mismatch })).rejects.toMatchObject({ reason: "attribution" })
    vi.spyOn(f.context.creationReceipts!, "readConfirmed").mockRejectedValue(new Error("Host receipt IO failed"))
    await expect(f.runtime.sourceCapture.discover({ cursor: null, limits, signal: f.signal })).rejects.toThrow("Host receipt IO failed")
  })
  it("preserves unknown times, derived IDs and complete structured Raw rows with bounded pages", async () => {
    const f = await fixture(); await f.put(); f.receipts.set(f.sourceId, f.makeReceipt())
    const view = await f.runtime.sourceCapture.open(f.request)
    expect(view).toMatchObject({ canonicalProfileVersion: "atape.acp-centered.v3", session: { updatedAt: null, title: " entire\nuser text ", status: "idle", captureStatus: "partial" }, target: { events: 3, usage: 0, threads: 1 } })
    const frames: SourceCaptureFrame[] = []
    for (let pages = 0; pages < 10; pages++) {
      const page = await view.read(f.signal)
      expect(page.frames.length).toBeLessThanOrEqual(projection.pageItems)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(projection.pageBytes)
      frames.push(...page.frames); if (page.done) break
    }
    const events = frames.flatMap(frame => frame.events)
    expect(events.map(event => event.sourceEventId)).toEqual(["row:1:part:0", "row:2:part:0", "row:2:part:1"])
    expect(events.map(event => event.eventIndex)).toEqual([0, 1, 2])
    expect(events.every(event => event.occurredAt === null && event.fidelity === "partial" && event.orderFidelity === "derived")).toBe(true)
    expect(events[2]!.update).toEqual({ sessionUpdate: "tool_call", toolCallId: "tool:2:1", title: "write_file", rawInput: { text: "quoted \"value\"\n保持" } })
    expect(frames.map(frame => frame.raw)).toEqual(rows.map((record, index) => ({ format: "cursor.jsonl.v1", sourceSessionId: f.sourceId, recordIndex: index, record })))
    expect(frames[2]!.events).toEqual([]); expect(frames.every(frame => frame.usage.length === 0)).toBe(true)
    await view.close()
    const noRaw = await f.runtime.sourceCapture.open({ ...f.request, rawEnabled: false }); expect((await drain(noRaw)).every(frame => frame.raw === undefined)).toBe(true); await noRaw.close()
  })
  it("uses a fixed title instead of truncating long multi-line text before Host redaction", async () => {
    const text = "multiline-secret-start\n" + "长".repeat(200)
    const f = await fixture(lines([user(text)])); await f.put(); f.receipts.set(f.sourceId, f.makeReceipt())
    const view = await f.runtime.sourceCapture.open(f.request)
    expect(view.session.title).toBe("Cursor conversation")
    const event = (await drain(view))[0]!.events[0]!
    expect(event.update).toEqual({ sessionUpdate: "user_message_chunk", content: { type: "text", text } })
    await view.close()
  })
  it("preserves IDs over repeated appends and identical rewrites, then rejects changed acknowledged bytes", async () => {
    const initial = lines([user("first")]), f = await fixture(initial); await f.put(); f.receipts.set(f.sourceId, f.makeReceipt())
    let checkpoint: string | undefined, prior: SourceCaptureFrame[] = []
    for (let round = 0; round < 5; round++) {
      if (round > 0) { const bytes = await readFile(f.path); await writeFile(f.path, bytes); await appendFile(f.path, lines([user("repeat")])) }
      const view = await f.runtime.sourceCapture.open({ ...f.request, ...(checkpoint === undefined ? {} : { priorCheckpoint: checkpoint }) })
      const frames = await drain(view); expect(frames.slice(0, prior.length)).toEqual(prior)
      checkpoint = view.sourceCheckpoint; expect(Buffer.byteLength(checkpoint)).toBeLessThan(512)
      prior = frames; await view.close()
    }
    const acknowledged = checkpoint
    await writeFile(f.path, initial)
    await expect(f.runtime.sourceCapture.open({ ...f.request, priorCheckpoint: checkpoint! })).rejects.toMatchObject({ reason: "changed" })
    expect(checkpoint).toBe(acknowledged)
    await writeFile(f.path, lines([user("transplanted")]))
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "changed" })
  })
  it("reports children unsupported and incomplete live tails as changed without losing other sources", async () => {
    const f = await fixture(); await f.put(); f.receipts.set(f.sourceId, f.makeReceipt())
    const child = join(dirname(f.path), "subagents", "child.jsonl"); await mkdir(dirname(child)); await writeFile(child, lines([user("child")]))
    const view = await f.runtime.sourceCapture.open(f.request)
    expect(view.sourceFailures).toEqual([{ source: child, reason: "unsupported" }]); await view.close()
    await appendFile(f.path, '{"role":')
    await expect(f.runtime.sourceCapture.open(f.request)).rejects.toMatchObject({ reason: "changed" })
  })
  it("enforces wire byte bounds and closes views on cancellation and runtime close", async () => {
    const f = await fixture(); await f.put(); f.receipts.set(f.sourceId, f.makeReceipt())
    const small = await f.runtime.sourceCapture.open({ ...f.request, projection: { ...projection, pageBytes: 20 } })
    await expect(small.read(f.signal)).rejects.toMatchObject({ reason: "limit" }); await small.close()
    const view = await f.runtime.sourceCapture.open(f.request), controller = new AbortController(); controller.abort()
    await expect(view.read(controller.signal)).rejects.toBeDefined()
    await f.runtime.close(); await expect(view.read(f.signal)).rejects.toMatchObject({ reason: "closed" })
  })
})

const native = async (mode: string, hold = false, options: Record<string, unknown> = {}) => {
  const f = await fixture(undefined, false), control = { mode, hold, cwd: f.cwd, rows, ready: join(f.base, "ready.json"), exited: join(f.base, "exited.json"), command: join(f.base, "command"), ...options }
  const controlPath = join(f.base, "control.json"); await writeFile(controlPath, JSON.stringify(control))
  const executable = join(f.base, "cursor-agent"); await copyFile(new URL("../fixtures/native-synthetic/agent.mjs", import.meta.url), executable); await chmod(executable, 0o700)
  vi.stubEnv("ATAPE_CURSOR_EXECUTABLE", executable); vi.stubEnv("CURSOR_TEST_CONTROL", controlPath)
  await f.runtime.close(); const runtime = await decodedFactory(f.context); cleanup.push(() => runtime.close())
  let attempt: CreationReceiptAttempt | undefined, confirmed: ConfirmedCreationReceipt | undefined, abandoned = 0
  const creation = { recordAttempt: async (input: CreationReceiptAttemptInput) => attempt = { protocolVersion: "atape.creation-receipt.v1", attemptId: randomUUID(), adapterId: "cursor", ...input, origin: { cwd: f.cwd, sourceId: input.sourceId, originKey: "origin-" + input.sourceId }, recordedAt: "2026-10-10T00:00:00Z" },
    confirm: async ({ prefix }: { prefix: CreationReceiptPrefix }) => { if (!attempt) throw new Error("No attempt"); confirmed = { ...attempt, confirmedAt: "2026-10-10T00:00:01Z", prefix }; f.receipts.set(attempt.sourceId, confirmed); return confirmed },
    abandon: async () => { abandoned++ } }
  const controller = new AbortController()
  const request: NewSessionStartRequest = { origin: { cwd: f.cwd }, signal: controller.signal, creation, ...(typeof options.prompt === "string" ? { initialPrompt: options.prompt } : {}) }
  const start = () => Promise.resolve(runtime.newSession.start(request))
  return { ...f, runtime, control, controller, start, state: () => ({ attempt, confirmed, abandoned }) }
}

describe("Cursor public controlled newSession", () => {
  it("uses exclusive native IDs and safe positional prompt, then confirms the successful final snapshot", async () => {
    const f = await native("complete", false, { prompt: "--literal 中文" })
    const result = await f.start()
    expect(result).toMatchObject({ creation: "confirmed", exitCode: 0 })
    const ready = await json(f.control.ready), state = f.state()
    expect(ready?.args).toEqual(["--disable-auto-update", "--new-session-id", state.attempt?.sourceId, "--", "--literal 中文"])
    expect(state.confirmed?.prefix).toEqual(prefix(lines(rows)))
    expect(state.abandoned).toBe(0)
    expect((await f.runtime.sourceCapture.discover({ cursor: null, limits, signal: f.signal })).sources).toEqual([state.confirmed!.origin])
  })
  it.each(["empty", "failed"])("leaves %s native exit unconfirmed", async mode => {
    const f = await native(mode)
    expect(await f.start()).toMatchObject({ creation: "unconfirmed", exitCode: mode === "failed" ? 7 : 0 })
    expect(f.state().confirmed).toBeUndefined(); expect(f.state().abandoned).toBeGreaterThan(0)
  })
  it("retries an incomplete tail while owning a live child, then keeps confirmation after later failure", async () => {
    const f = await native("partial", true, { exitCode: 7 }), pending = f.start(); let settled = false
    void pending.finally(() => { settled = true })
    await waitFor(() => json(f.control.ready)); expect(f.state().confirmed).toBeUndefined(); expect(settled).toBe(false)
    await writeFile(f.control.command, "complete")
    await waitFor(async () => f.state().confirmed)
    expect(settled).toBe(false); await writeFile(f.control.command, "finish")
    expect(await pending).toMatchObject({ creation: "confirmed", exitCode: 7 }); expect(f.state().abandoned).toBe(0)
  })
  it("stops permanent proof failures without killing the interactive chat", async () => {
    const f = await native("malformed", true), pending = f.start(); const outcome = pending.catch(error => error); let settled = false
    void outcome.then(() => { settled = true })
    await waitFor(() => json(f.control.ready)); await waitFor(async () => f.state().abandoned || undefined)
    expect(settled).toBe(false); expect(await json(f.control.exited)).toBeUndefined()
    await writeFile(f.control.command, "finish")
    expect(await outcome).toMatchObject({ reason: "format" }); expect(f.state().confirmed).toBeUndefined()
  })
  it("joins the native child before runtime close resolves and never confirms a cancelled launch", async () => {
    const f = await native("empty", true), pending = f.start().catch(error => error)
    await waitFor(() => json(f.control.ready)); await f.runtime.close()
    expect(await pending).toBeDefined(); expect(await json(f.control.exited)).toMatchObject({ code: 143 }); expect(f.state().confirmed).toBeUndefined()
  })
  it("rejects an unexpected same-ID native locator instead of confirming arbitrary workspace contents", async () => {
    const f = await native("wrong-location")
    await expect(f.start()).rejects.toMatchObject({ reason: "attribution" }); expect(f.state().confirmed).toBeUndefined()
  })
  it("rejects unsupported versions before root initialization or any creation attempt", async () => {
    const f = await native("complete", false, { version: "future-version" })
    await expect(f.start()).rejects.toMatchObject({ reason: "unsupported" }); expect(f.state().attempt).toBeUndefined()
    await expect(readFile(f.root)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
