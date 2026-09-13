import { isBoundedToolValue, type AcpSessionUpdate, type SourceCaptureFrame, type SourceCaptureHeader, type SourceOpenRequest } from "@atape/domain"
import { fail, id, identity, object, timestamp, type Row, type snapshot } from "./source.ts"

const text = (value: unknown): string => { if (typeof value !== "string") fail("format", "Kimi content must be text."); return value as string }
const list = (value: unknown): unknown[] => { if (!Array.isArray(value)) fail("format", "Kimi content must be an array."); return value as unknown[] }
const counter = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("format", "Kimi token counter is invalid.")
  return value as number
}
const counts = (value: unknown) => {
  const usage = object(value), inputOther = counter(usage.inputOther), outputTokens = counter(usage.output)
  const cacheReadTokens = counter(usage.inputCacheRead), cacheWriteTokens = counter(usage.inputCacheCreation)
  const inputTokens = inputOther === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined ? undefined : counter(inputOther + cacheReadTokens + cacheWriteTokens)
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) }
}
const rawOnlyTypes = new Set(["metadata", "runtime.set_binding", "profile.bind", "permission.set_mode", "plugin.session_start", "llm.tools_snapshot", "token_counting.measured", "token_counting.turn_recorded", "token_counting.truncated", "token_counting.rebased", "prompt.accepted", "prompt.completed"])

/** A complete native step is the admission boundary; streamed or interrupted attempts never replace a target. */
export const project = (source: Awaited<ReturnType<typeof snapshot>>, request: SourceOpenRequest) => {
  const { sourceId } = source.origin, started = performance.now()
  const first = source.records[0]?.row
  if (first?.type !== "metadata" || first.protocol_version !== "1.5") fail("unsupported", "Kimi requires Wire protocol 1.5.")
  timestamp(first!.created_at)
  const frames: SourceCaptureFrame[] = [], keys = new Set<string>(), prompts = new Map<string, Row>(), messages = new Set<string>(), steps = new Set<string>()
  let events = 0, usageCount = 0, bytes = 0, partial = false, active = false, title = "Kimi session", latest = timestamp(source.meta.createdAt)
  let step: { uuid: string; turnId: string; number: number; model?: string; calls: Map<string, { uuid: string; name: string; done: boolean }> } | undefined
  const turns: number[] = [], visibleFrames: number[] = []
  let undoFloor = 0, compactedThrough = 0, contextHistory = false
  let compaction: { line: number; model?: string; alias?: string; used: boolean; applied: boolean } | undefined
  const add = (key: string, output: SourceCaptureFrame["events"], usage: SourceCaptureFrame["usage"], raw: unknown) => {
    const recordKey = identity("record", sourceId, key)
    if (keys.has(recordKey)) fail("unsupported", "Kimi record identity is duplicated.")
    keys.add(recordKey)
    const frame: SourceCaptureFrame = { recordKey, events: output, usage, ...(request.rawEnabled ? { raw } : {}) }
    const size = Buffer.byteLength(JSON.stringify(frame)); bytes += size
    if (size + Buffer.byteLength(JSON.stringify({ frames: [], done: false })) > request.projection.pageBytes || bytes > 64 * 1024 * 1024)
      fail("limit", "Kimi projection exceeds its page or 64 MiB snapshot budget.")
    if (events > request.projection.events || usageCount > request.projection.usage || output.length > 500) fail("limit", "Kimi projection exceeds its Event or usage budget.")
    if (output.length) visibleFrames.push(frames.length)
    frames.push(frame)
  }
  add("state", [], [], { format: "kimi.state.v2", sourceSessionId: sourceId, json: source.metadataJson })
  for (const [index, { row, json }] of source.records.entries()) {
    request.signal.throwIfAborted()
    if (performance.now() - started > request.limits.durationMs) fail("limit", "Kimi projection exceeded its deadline.")
    if (row.agentId !== undefined && row.agentId !== "main") fail("unsupported", "Kimi main Wire contains another agent.")
    if (row.type === "metadata" && index !== 0) fail("unsupported", "Kimi Wire contains a second metadata boundary.")
    const at = row.type === "metadata" ? timestamp(row.created_at) : timestamp(row.time)
    latest = Math.max(latest, at)
    const occurredAt = new Date(at).toISOString(), output: SourceCaptureFrame["events"][number][] = [], usage: SourceCaptureFrame["usage"][number][] = []
    let key = `line:${index}`
    const emit = (eventId: string, update: AcpSessionUpdate, fidelity: "native" | "partial" = "native") => {
      output.push({ sourceEventId: identity("event", sourceId, eventId), sourceThreadId: sourceId, sourceOrder: events, eventIndex: events++,
        orderFidelity: "derived", fidelity, occurredAt, update })
    }
    const emitUsage = (usageId: string, model: string, value: unknown) => {
      const tokens = counts(value)
      if (Object.keys(tokens).length) {
        usageCount++; usage.push({ sourceUsageId: identity("usage", sourceId, usageId), sourceThreadId: sourceId, model, occurredAt, ...tokens })
      }
    }
    if (row.type === "turn.prompt") {
      const promptId = id(row.promptId)
      if (active || compaction || prompts.has(promptId) || object(row.origin).kind !== "user") fail("unsupported", "Kimi requires non-overlapping unique user prompts.")
      prompts.set(promptId, row); key = `prompt:${promptId}`; active = true
    } else if (row.type === "context.append_message") {
      const message = object(row.message), origin = object(message.origin)
      if (origin.kind === "user") {
        const messageId = id(message.id), prompt = prompts.get(messageId)
        if (step || compaction || !prompt || messages.has(messageId) || message.role !== "user" || list(message.toolCalls).length ||
          JSON.stringify(message.content) !== JSON.stringify(prompt.input)) fail("unsupported", "Kimi user message has no unique matching prompt.")
        messages.add(messageId); turns.push(frames.length); key = `message:${messageId}`
        const parts = list(message.content)
        for (const [slot, value] of parts.entries()) {
          const part = object(value)
          if (part.type === "text") {
            const value = text(part.text)
            if (value) emit(`message:${messageId}:${slot}`, { sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text: value } })
          } else partial = true
        }
      } else if (origin.kind === "injection") {
        // Native context maintenance is not an additional human turn.
        if (!["date_change", "permission_mode"].includes(String(origin.variant))) partial = true
      } else fail("unsupported", "Kimi message origin requires a wider source profile.")
    } else if (row.type === "llm.request") {
      if (compaction) {
        if (row.kind !== "compaction" || compaction.model !== undefined) fail("unsupported", "Kimi compaction retries require a wider source profile.")
        compaction.model = id(row.model); compaction.alias = id(row.modelAlias)
      } else {
        if (!step || row.kind !== "loop" || row.turnStep !== `${step.turnId}.${step.number}` || step.model !== undefined)
          fail("unsupported", "Kimi model request has an unsupported step or retry boundary.")
        step!.model = id(row.model)
      }
    } else if (row.type === "usage.record") {
      if (compaction) {
        if (!compaction.model || compaction.used || compaction.applied || row.usageScope !== "session" || row.model !== compaction.alias)
          fail("unsupported", "Kimi compaction usage has no unique matching request.")
        compaction.used = true
        // Native compaction has no UUID; its append-only Wire boundary is stable across resume and undo.
        emitUsage(`compaction:${compaction.line}`, compaction.model!, row.usage)
      } else if (row.usageScope !== "turn") partial = true // step.end owns turn response counters.
    } else if (row.type === "full_compaction.begin") {
      if (step || compaction || !turns.length || !["manual", "auto"].includes(String(row.source)) || row.source === "manual" && active)
        fail("unsupported", "Kimi compaction has an unsupported boundary.")
      compaction = { line: index, used: false, applied: false }; contextHistory = true
    } else if (row.type === "context.apply_compaction") {
      const range = object(row.wireLines)
      if (!compaction?.model || compaction.applied || range.start !== compactedThrough + 1 || range.end !== index ||
        counter(row.compactedCount) === undefined || counter(row.keptUserMessageCount) === undefined || row.legacyTail !== undefined)
        fail("unsupported", "Kimi compaction has no matching modern context boundary.")
      text(row.summary); text(row.contextSummary)
      for (const name of ["tokensBefore", "tokensAfter", "summaryOutputTokens", "droppedMessageCount"]) counter(row[name])
      compaction!.applied = true; compactedThrough = index; undoFloor = turns.length
    } else if (row.type === "full_compaction.complete") {
      if (!compaction?.applied) fail("format", "Kimi compaction completed without its context boundary.")
      compaction = undefined
    } else if (String(row.type).startsWith("full_compaction.")) {
      fail("unsupported", "Kimi incomplete or cancelled compaction requires a wider source profile.")
    } else if (row.type === "context.undo") {
      const count = counter(row.count)
      if (active || step || compaction || !count || count > turns.length - undoFloor)
        fail("unsupported", "Kimi undo is incomplete or crosses a compaction boundary.")
      const removed = turns.splice(turns.length - count!), start = removed[0]!
      // Usage is session expenditure and is not undoable in the native CLI. Raw remains an exact source archive.
      while (visibleFrames.length && visibleFrames.at(-1)! >= start) {
        const slot = visibleFrames.pop()!
        events -= frames[slot]!.events.length; frames[slot] = { ...frames[slot]!, events: [] }
      }
      contextHistory = true
    } else if (row.type === "context.append_loop_event") {
      if (compaction) fail("unsupported", "Kimi loop overlaps an unfinished compaction.")
      const event = object(row.event), kind = id(event.type)
      if (kind === "step.begin") {
        const uuid = id(event.uuid)
        if (step || steps.has(uuid) || !messages.size || typeof event.step !== "number" || !Number.isSafeInteger(event.step) || event.step < 1)
          fail("unsupported", "Kimi step is overlapping, duplicated or lacks its user root.")
        steps.add(uuid); step = { uuid, turnId: id(event.turnId), number: event.step as number, calls: new Map() }; active = true
        key = `begin:${uuid}`
      } else {
        if (!step) fail("format", "Kimi loop event has no open step.")
        const current = step!
        if (kind === "tool.result") {
          const callId = id(event.toolCallId), call = current.calls.get(callId), result = object(event.result)
          if (!call || call.done || event.parentUuid !== call.uuid) fail("format", "Kimi tool result has no unique matching call.")
          if (result.isError !== undefined && typeof result.isError !== "boolean") fail("format", "Kimi tool outcome is invalid.")
          call!.done = true; key = `result:${current.uuid}:${callId}`
          const bounded = result.output !== undefined && isBoundedToolValue(result.output)
          const native = bounded && (typeof result.output === "string" || Array.isArray(result.output) && result.output.every(part => object(part).type === "text"))
          if (!native) partial = true
          emit(key, { sessionUpdate: "tool_call_update", toolCallId: identity("tool", sourceId, current.uuid, callId), title: call!.name,
            status: result.isError === true ? "failed" : "completed", ...(native ? { rawOutput: result.output } : {}) }, native ? "native" : "partial")
        } else {
          if (event.turnId !== current.turnId || event.step !== current.number) fail("format", "Kimi loop event changed its step identity.")
          if (kind === "step.end") {
            if (event.uuid !== current.uuid || [...current.calls.values()].some(call => !call.done)) fail("format", "Kimi step or tool result is incomplete; retry.")
            if (!["end_turn", "tool_use"].includes(String(event.finishReason))) fail("unsupported", "Kimi interrupted, failed or retried steps require a wider source profile.")
            key = `end:${current.uuid}`
            if (event.usage !== undefined) {
              if (!current.model) fail("format", "Kimi usage has no model request.")
              emitUsage(current.uuid, current.model!, event.usage)
            }
            step = undefined
          } else {
            if (event.stepUuid !== current.uuid) fail("format", "Kimi content changed its step identity.")
            const uuid = id(event.uuid); key = `${kind}:${uuid}`
            if (kind === "content.part") {
              const part = object(event.part)
              if (part.type === "text" || part.type === "think") {
                const value = text(part.type === "think" ? part.think : part.text)
                if (value) emit(key, { sessionUpdate: part.type === "think" ? "agent_thought_chunk" : "agent_message_chunk",
                  messageId: current.uuid, content: { type: "text", text: value } })
                if (part.encrypted !== undefined) partial = true
              } else partial = true
            } else if (kind === "tool.call") {
              const callId = id(event.toolCallId), name = id(event.name)
              if (["Agent", "AgentSwarm"].includes(name)) fail("unsupported", "Kimi delegated agents require a wider source profile.")
              if (current.calls.has(callId)) fail("format", "Kimi tool call identity is duplicated.")
              current.calls.set(callId, { uuid, name, done: false })
              const bounded = event.args !== undefined && isBoundedToolValue(event.args)
              if (!bounded) partial = true
              emit(key, { sessionUpdate: "tool_call", toolCallId: identity("tool", sourceId, current.uuid, callId), title: name, kind: name === "Read" ? "read" : "other",
                status: "in_progress", ...(bounded ? { rawInput: event.args } : {}) }, bounded ? "native" : "partial")
            } else fail("unsupported", "Kimi loop event requires a wider source profile.")
          }
        }
      }
    } else if (row.type === "turn.ended") {
      if (step || compaction) fail("format", "Kimi turn ended before its complete step or compaction.")
      if (row.reason !== "completed") fail("unsupported", "Kimi non-completed turns require a wider source profile.")
      active = false
    } else if (String(row.type).startsWith("context.") || ["turn.steer", "turn.cancel"].includes(String(row.type))) {
      fail("unsupported", "Kimi context operation or steering requires a wider source profile.")
    } else if (!rawOnlyTypes.has(String(row.type))) partial = true
    add(key, output, usage, { format: "kimi.wire.v1.5", sourceSessionId: sourceId, json })
  }
  if (step || compaction) fail("format", "Kimi has an incomplete model step or compaction; retry after it finishes.")
  if (messages.size !== prompts.size || !messages.size) fail("format", "Kimi user prompt has not reached its context record; retry.")
  const firstVisible = turns.length ? frames[turns[0]!]!.events : []
  const firstText = firstVisible.map(event => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join(" ")
  if (firstText && Buffer.byteLength(firstText) <= 200) title = firstText
  if (typeof source.meta.title === "string" && source.meta.title && Buffer.byteLength(source.meta.title) <= 200) title = source.meta.title
  const captureStatus = partial ? "partial" : "healthy"
  const header: SourceCaptureHeader = { profile: contextHistory ? "kimi.code.wire.context.1" : "kimi.code.wire.linear.1", origin: source.origin,
    session: { sourceSessionId: sourceId, title, summary: "", insight: "", actor: { name: "User", harness: "kimi-code" }, branch: "",
      status: active ? "active" : "idle", captureStatus, updatedAt: new Date(latest).toISOString(), reportedEventCount: events },
    threads: [{ sourceThreadId: sourceId, label: title, summary: "", captureStatus }], target: { events, usage: usageCount, threads: 1 } }
  if (Buffer.byteLength(JSON.stringify(header)) > request.projection.pageBytes) fail("limit", "Kimi header exceeds its page budget.")
  return { header, frames }
}
