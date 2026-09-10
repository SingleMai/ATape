import { createHash } from "node:crypto"
import type { AdapterEvent, AdapterSession, AdapterThread, AdapterUsage, AcpSessionUpdate } from "@atape/domain"
import { Effect } from "effect"
import { openOpenCodeSource, OpenCodeSourceError, type OpenCodeSourceLimits, type OpenCodeSourceRecord, type OpenCodeSession } from "./source.ts"

export const OpenCodeProjectionVersion = "opencode.v1.sqlite.1"
export type OpenCodeEventDraft = Omit<AdapterEvent, "revision" | "projectionRevision" | "rawRef">
export type OpenCodeUsageDraft = Omit<AdapterUsage, "revision">
export type OpenCodeCaptureFrame = {
  /** Stable actual row identity; the Host assigns versions and Raw provenance. */
  readonly recordKey: string
  readonly events: ReadonlyArray<OpenCodeEventDraft>
  readonly usage: ReadonlyArray<OpenCodeUsageDraft>
  readonly raw?: OpenCodeSourceRecord["raw"]
}
export type OpenCodeProjectionLimits = {
  readonly events: number
  readonly usage: number
  readonly pageItems: number
  readonly pageBytes: number
}

const fail = (message: string, reason: OpenCodeSourceError["reason"] = "format") => new OpenCodeSourceError({ reason, message })
const attempt = <A>(f: () => A) => Effect.try({ try: f, catch: cause => cause instanceof OpenCodeSourceError ? cause : fail("OpenCode projection data is invalid.") })
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw fail("OpenCode projection requires an object.")
  return value as Record<string, unknown>
}
const optionalObject = (value: unknown) => value == null ? {} : object(value)
const text = (value: unknown, maximum = 16 * 1024 * 1024): string => {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum) throw fail("OpenCode text is invalid or exceeds its bound.")
  return value
}
const id = (value: unknown) => { const result = text(value, 500); if (!result || result.includes("\0")) throw fail("OpenCode identity is invalid."); return result }
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw fail("OpenCode count is invalid.")
  return value
}
const iso = (value: unknown) => { const n = count(value); if (n > 8_640_000_000_000_000) throw fail("OpenCode timestamp is invalid."); return new Date(n).toISOString() }
const identity = (...keys: string[]) => "oc_" + createHash("sha256").update(JSON.stringify(keys)).digest("hex")
const key = (row: OpenCodeSourceRecord) => identity("row", row.table, row.sessionId, row.id)
type ThreadState = { partial: boolean; active: boolean; latestTime: number }

/** Plans counts and headers, then streams deterministic drafts in the same scoped source view.
 * Host callers must close the scope before sealing/delivering their journal. No revision,
 * Raw object, redaction policy, encoded upload or persistent checkpoint is owned here.
 */
export const openOpenCodeCapture = (options: {
  readonly path: string
  readonly sessionId: string
  readonly rawEnabled: boolean
  readonly limits: OpenCodeSourceLimits
  readonly projection: OpenCodeProjectionLimits
}) => Effect.gen(function*() {
  let closed = false
  const started = performance.now()
  yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true }))
  yield* attempt(() => {
    for (const [name, maximum] of [["events", 2_000_000], ["usage", 1_000_000], ["pageItems", 100], ["pageBytes", 32 * 1024 * 1024]] as const)
      if (count(options.projection[name]) < 1 || options.projection[name] > maximum) throw fail("OpenCode projection requires explicit bounded admission.", "limit")
  })
  const source = yield* openOpenCodeSource(options)
  const creation = yield* source.origin()
  const check = () => {
    if (closed) throw fail("OpenCode capture is closed.", "closed")
    if (performance.now() - started > options.limits.durationMs) throw fail("OpenCode capture exceeded its deadline.", "limit")
  }
  const family = new Map(source.threads.map(thread => [thread.id, thread]))
  const stats = new Map<string, ThreadState>(source.threads.map(thread => [thread.id, { partial: false, active: false, latestTime: thread.timeUpdated }]))
  let session: OpenCodeSession = source.root, message: OpenCodeSourceRecord | undefined
  let pastRevert = false, activeMessage = true, partBoundary: string | undefined, eventCount = 0, usageCount = 0
  const reset = () => { session = source.root; message = undefined; pastRevert = false; activeMessage = true; partBoundary = undefined; eventCount = 0; usageCount = 0 }
  const project = (row: OpenCodeSourceRecord): OpenCodeCaptureFrame => {
    check()
    const events: OpenCodeEventDraft[] = [], usage: OpenCodeUsageDraft[] = []
    const frame = () => ({ recordKey: key(row), events, usage, ...(row.raw === undefined ? {} : { raw: row.raw }) })
    if (row.table === "session") {
      session = family.get(row.id)!; message = undefined; pastRevert = false; activeMessage = true; partBoundary = undefined
      return frame()
    }
    const state = stats.get(session.id)!
    if (row.table === "message") {
      message = row; activeMessage = !pastRevert; partBoundary = undefined
      if (row.id === session.revert?.messageID) {
        pastRevert = true; partBoundary = session.revert.partID; activeMessage = partBoundary !== undefined
      }
      if (activeMessage) {
        if (row.data.role !== "user" && row.data.role !== "assistant") throw fail("OpenCode message role is unsupported.", "unsupported")
        const time = optionalObject(row.data.time)
        // Native shell assistants can complete without a finish string.
        state.active = row.data.role === "assistant" && time.completed == null
        if (time.completed != null) iso(time.completed)
        iso(time.created ?? row.timeCreated)
        state.latestTime = Math.max(state.latestTime, row.timeUpdated)
      }
      return frame()
    }
    if (!message || row.messageId !== message.id || row.sessionId !== session.id) throw fail("OpenCode projection lost its source message relationship.")
    if (row.id === partBoundary) activeMessage = false
    if (!activeMessage) return frame()
    const data = row.data, messageTime = optionalObject(message.data.time)
    const baseTime = messageTime.created ?? message.timeCreated
    const emit = (slot: string, update: AcpSessionUpdate, occurredAt: unknown, fidelity: OpenCodeEventDraft["fidelity"] = "native", child?: string) => {
      if (++eventCount > options.projection.events) throw fail("OpenCode projection exceeds its event bound.", "limit")
      events.push({ sourceEventId: identity("event", session.id, message!.id, row.id, slot), sourceThreadId: session.id,
        sourceOrder: eventCount - 1, eventIndex: eventCount - 1, orderFidelity: "derived", fidelity, occurredAt: iso(occurredAt), update,
        ...(child === undefined ? {} : { childSourceThreadId: child }) })
    }
    const content = (value: { type: "text"; text: string } | { type: "resource_link"; name: string; uri: string; mimeType?: string }, thought = false, fidelity: OpenCodeEventDraft["fidelity"] = "native") => {
      emit("content", { sessionUpdate: thought ? "agent_thought_chunk" : message!.data.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content: value, messageId: message!.id }, optionalObject(data.time).start ?? baseTime, fidelity)
    }
    switch (data.type) {
      case "text": case "reasoning": {
        if (data.ignored != null && typeof data.ignored !== "boolean" || data.synthetic != null && typeof data.synthetic !== "boolean") throw fail("OpenCode text flags are invalid.")
        const value = text(data.text)
        if (data.ignored === true || value.length === 0) break
        if (data.type === "reasoning" && message.data.role !== "assistant") throw fail("OpenCode reasoning belongs to a non-assistant message.")
        content({ type: "text", text: value }, data.type === "reasoning", data.synthetic === true || message.data.summary === true ? "derived" : "native")
        break
      }
      case "tool": {
        if (message.data.role !== "assistant") throw fail("OpenCode tool belongs to a non-assistant message.")
        const tool = id(data.tool), toolState = object(data.state), time = optionalObject(toolState.time)
        const status = toolState.status
        if (status !== "pending" && status !== "running" && status !== "completed" && status !== "error") throw fail("OpenCode tool status is unsupported.", "unsupported")
        const toolCallId = identity("tool", session.id, message.id, row.id, id(data.callID))
        const partialOutput = toolState.partialOutput == null ? undefined : text(toolState.partialOutput)
        if (toolState.interrupted != null && typeof toolState.interrupted !== "boolean") throw fail("OpenCode tool interruption flag is invalid.")
        const child = typeof toolState.sessionId === "string" && family.get(toolState.sessionId)?.parentId === session.id ? toolState.sessionId : undefined
        emit("call", { sessionUpdate: "tool_call", toolCallId, title: tool, kind: "other", status: status === "pending" ? "pending" : "in_progress",
          ...(status === "running" && partialOutput !== undefined ? { rawOutput: partialOutput } : {}),
          ...(toolState.input == null ? {} : { rawInput: object(toolState.input) }) }, time.start ?? baseTime, "native", child)
        if (status === "completed" || status === "error") {
          emit("result", { sessionUpdate: "tool_call_update", toolCallId, status: status === "completed" ? "completed" : "failed",
            rawOutput: status === "completed" ? text(toolState.output) : partialOutput === undefined ? text(toolState.error) :
              { output: partialOutput, error: text(toolState.error), ...(toolState.interrupted === true ? { interrupted: true } : {}) } }, time.end ?? time.start ?? baseTime)
        }
        if (toolState.attachmentsShape != null && toolState.attachmentsShape !== "null") {
          if (toolState.attachmentsShape !== "array") throw fail("OpenCode tool attachments are invalid.")
          if (count(toolState.attachmentCount) > 0) state.partial = true
        }
        break
      }
      case "step-finish": {
        if (message.data.role !== "assistant") throw fail("OpenCode usage belongs to a non-assistant message.")
        const tokens = optionalObject(data.tokens), cache = optionalObject(tokens.cache)
        const get = (value: unknown) => value == null ? undefined : count(value)
        const input = get(tokens.input), output = get(tokens.output), reasoning = get(tokens.reasoning), read = get(cache.read), write = get(cache.write)
        const sum = (...values: Array<number | undefined>) => values.some(value => value === undefined) ? undefined : count(values.reduce<number>((a, b) => a + b!, 0))
        const totalInput = sum(input, read, write), totalOutput = sum(output, reasoning)
        // An absent sample represents wholly unknown usage. The shared Canonical
        // contract requires at least one actual counter in a usage record.
        if ([totalInput, totalOutput, read, write].every(value => value === undefined)) break
        if (++usageCount > options.projection.usage) throw fail("OpenCode projection exceeds its usage bound.", "limit")
        usage.push({ sourceUsageId: identity("usage", session.id, message.id, row.id), sourceThreadId: session.id,
          occurredAt: iso(optionalObject(data.time).end ?? row.timeCreated),
          model: message.data.modelID == null ? "unknown" : id(message.data.modelID),
          ...(totalInput === undefined ? {} : { inputTokens: totalInput }), ...(totalOutput === undefined ? {} : { outputTokens: totalOutput }),
          ...(read === undefined ? {} : { cacheReadTokens: read }), ...(write === undefined ? {} : { cacheWriteTokens: write }) })
        break
      }
      case "file": {
        const uri = text(data.url), name = data.filename == null ? "Attachment" : text(data.filename, 4096)
        // Inline bytes remain source-only until a content/redaction contract supports them.
        if (/^data:/i.test(uri)) { state.partial = true; break }
        if (!/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.length > 8192) throw fail("OpenCode attachment URI is invalid.")
        content({ type: "resource_link", name, uri, ...(data.mime == null ? {} : { mimeType: text(data.mime, 256) }) })
        break
      }
      case "compaction": case "step-start": case "snapshot": case "patch": case "agent": case "subtask": case "retry":
        // Source lifecycle records do not masquerade as user/assistant messages.
        break
      default: state.partial = true
    }
    state.latestTime = Math.max(state.latestTime, row.timeUpdated)
    return frame()
  }
  // First pass validates all projected values and admits final counts before any draft escapes.
  for (;;) {
    const page = yield* source.read()
    yield* attempt(() => { for (const row of page.records) {
      const frame = project(row)
      if (Buffer.byteLength(JSON.stringify(frame)) + 2 > options.projection.pageBytes) throw fail("OpenCode projection frame exceeds the page bound.", "limit")
    } })
    if (page.done) break
  }
  const target = { events: eventCount, usage: usageCount, threads: source.threads.length }
  const threads: ReadonlyArray<Omit<AdapterThread, "revision">> = source.threads.map(thread => ({
    sourceThreadId: thread.id, ...(thread.parentId === null ? {} : { parentSourceThreadId: thread.parentId }),
    label: thread.title, summary: "", captureStatus: stats.get(thread.id)!.partial ? "partial" : "healthy"
  }))
  const header = yield* attempt((): Omit<AdapterSession, "revision"> => ({
    sourceSessionId: source.root.id, title: source.root.title, summary: "", insight: "", actor: { name: "User", harness: "OpenCode" }, branch: "",
    status: source.root.archivedAt !== null ? "ended" : [...stats.values()].some(state => state.active) ? "active" : "idle",
    captureStatus: [...stats.values()].some(state => state.partial) ? "partial" : "healthy",
    updatedAt: iso(Math.max(...[...stats.values()].map(state => state.latestTime))), reportedEventCount: target.events
  }))
  yield* source.rewind()
  reset()
  let buffered: ReadonlyArray<OpenCodeSourceRecord> = [], cursor = 0, sourceDone = false, failed = false
  let pending: { frame: OpenCodeCaptureFrame; bytes: number } | undefined
  return {
    profile: OpenCodeProjectionVersion,
    origin: { sourceId: source.root.id, originKey: identity("origin", source.root.id, creation.eventId), cwd: creation.directory },
    session: header, threads, target,
    read: () => Effect.gen(function*() {
      if (failed || closed) return yield* Effect.fail(fail("A failed or closed capture must be abandoned.", "closed"))
      yield* attempt(check)
      const frames: OpenCodeCaptureFrame[] = []
      let bytes = 2
      while (frames.length < options.projection.pageItems) {
        if (!pending) {
          if (cursor === buffered.length && !sourceDone) {
            const page = yield* source.read(); buffered = page.records; cursor = 0; sourceDone = page.done
          }
          if (cursor === buffered.length) break
          pending = yield* attempt(() => {
            const frame = project(buffered[cursor++]!), size = Buffer.byteLength(JSON.stringify(frame))
            if (size + 2 > options.projection.pageBytes) throw fail("OpenCode projection frame exceeds the page bound.", "limit")
            return { frame, bytes: size }
          })
        }
        const size = pending.bytes + (frames.length === 0 ? 0 : 1)
        if (size > options.projection.pageBytes - bytes) break
        frames.push(pending.frame); bytes += size; pending = undefined
      }
      const done = sourceDone && cursor === buffered.length && pending === undefined
      if (done && (eventCount !== target.events || usageCount !== target.usage)) return yield* Effect.fail(fail("OpenCode projection passes disagree."))
      return { frames, done }
    }).pipe(Effect.tapError(() => Effect.sync(() => { failed = true })))
  }
})
