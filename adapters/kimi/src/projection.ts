import { isBoundedToolValue, type AcpSessionUpdate, type SourceCaptureFrame, type SourceCaptureHeader, type SourceOpenRequest } from "@atape/domain"
import { fail, id, identity, object, timestamp, type Row, type snapshot } from "./source.ts"

const text = (value: unknown): string => { if (typeof value !== "string") fail("format", "Kimi content must be text."); return value as string }
const list = (value: unknown): unknown[] => { if (!Array.isArray(value)) fail("format", "Kimi content must be an array."); return value as unknown[] }
const counter = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("format", "Kimi token counter is invalid.")
  return value as number
}
const rawOnlyTypes = new Set(["metadata", "runtime.set_binding", "profile.bind", "permission.set_mode", "plugin.session_start", "llm.tools_snapshot", "token_counting.measured", "token_counting.turn_recorded", "prompt.completed"])

/** A complete native step is the admission boundary; streamed or interrupted attempts never replace a target. */
export const project = (source: Awaited<ReturnType<typeof snapshot>>, request: SourceOpenRequest) => {
  const { sourceId } = source.origin, started = performance.now()
  const first = source.records[0]?.row
  if (first?.type !== "metadata" || first.protocol_version !== "1.5") fail("unsupported", "Kimi requires Wire protocol 1.5.")
  timestamp(first!.created_at)
  const frames: SourceCaptureFrame[] = [], keys = new Set<string>(), prompts = new Map<string, Row>(), messages = new Set<string>(), steps = new Set<string>()
  let events = 0, usageCount = 0, bytes = 0, partial = false, active = false, title = "Kimi session", latest = timestamp(source.meta.createdAt)
  let step: { uuid: string; turnId: string; number: number; model?: string; calls: Map<string, { uuid: string; name: string; done: boolean }> } | undefined
  const add = (key: string, output: SourceCaptureFrame["events"], usage: SourceCaptureFrame["usage"], raw: unknown) => {
    const recordKey = identity("record", sourceId, key)
    if (keys.has(recordKey)) fail("unsupported", "Kimi record identity is duplicated.")
    keys.add(recordKey)
    const frame: SourceCaptureFrame = { recordKey, events: output, usage, ...(request.rawEnabled ? { raw } : {}) }
    const size = Buffer.byteLength(JSON.stringify(frame)); bytes += size
    if (size + Buffer.byteLength(JSON.stringify({ frames: [], done: false })) > request.projection.pageBytes || bytes > 64 * 1024 * 1024)
      fail("limit", "Kimi projection exceeds its page or 64 MiB snapshot budget.")
    if (events > request.projection.events || usageCount > request.projection.usage || output.length > 500) fail("limit", "Kimi projection exceeds its Event or usage budget.")
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
    if (row.type === "turn.prompt") {
      const promptId = id(row.promptId)
      if (prompts.has(promptId) || object(row.origin).kind !== "user") fail("unsupported", "Kimi requires unique user prompts.")
      prompts.set(promptId, row); key = `prompt:${promptId}`; active = true
    } else if (row.type === "context.append_message") {
      const message = object(row.message), origin = object(message.origin)
      if (origin.kind === "user") {
        const messageId = id(message.id), prompt = prompts.get(messageId)
        if (step || !prompt || messages.has(messageId) || message.role !== "user" || list(message.toolCalls).length ||
          JSON.stringify(message.content) !== JSON.stringify(prompt.input)) fail("unsupported", "Kimi user message has no unique matching prompt.")
        messages.add(messageId); key = `message:${messageId}`
        const parts = list(message.content)
        for (const [slot, value] of parts.entries()) {
          const part = object(value)
          if (part.type === "text") {
            const value = text(part.text)
            if (value) emit(`message:${messageId}:${slot}`, { sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text: value } })
          } else partial = true
        }
        if (messages.size === 1) {
          const value = output.map(event => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join(" ")
          if (value && Buffer.byteLength(value) <= 200) title = value
        }
      } else if (origin.kind === "injection") {
        // Native context maintenance is not an additional human turn.
        if (!["date_change", "permission_mode"].includes(String(origin.variant))) partial = true
      } else fail("unsupported", "Kimi message origin requires a wider source profile.")
    } else if (row.type === "llm.request") {
      if (!step || row.kind !== "loop" || row.turnStep !== `${step.turnId}.${step.number}` || step.model !== undefined)
        fail("unsupported", "Kimi model request has an unsupported step or retry boundary.")
      step!.model = id(row.model)
    } else if (row.type === "usage.record") {
      // step.end owns the same response counters and a stable native UUID.
      if (row.usageScope !== "turn") partial = true
    } else if (row.type === "context.append_loop_event") {
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
            const counters = object(event.usage)
            if (event.usage !== undefined) {
              if (!current.model) fail("format", "Kimi usage has no model request.")
              const inputOther = counter(counters.inputOther), outputTokens = counter(counters.output), cacheReadTokens = counter(counters.inputCacheRead), cacheWriteTokens = counter(counters.inputCacheCreation)
              const inputTokens = inputOther === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined ? undefined : counter(inputOther + cacheReadTokens + cacheWriteTokens)
              const counts = { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
                ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) }
              if (Object.keys(counts).length) { usageCount++; usage.push({ sourceUsageId: identity("usage", sourceId, current.uuid), sourceThreadId: sourceId, model: current.model!, occurredAt, ...counts }) }
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
      if (step) fail("format", "Kimi turn ended before its complete step.")
      if (row.reason !== "completed") fail("unsupported", "Kimi non-completed turns require a wider source profile.")
      active = false
    } else if (String(row.type).startsWith("context.") || ["turn.steer", "turn.cancel"].includes(String(row.type))) {
      fail("unsupported", "Kimi compaction, undo, clear and steering require a wider source profile.")
    } else if (!rawOnlyTypes.has(String(row.type))) partial = true
    add(key, output, usage, { format: "kimi.wire.v1.5", sourceSessionId: sourceId, json })
  }
  if (step) fail("format", "Kimi has an incomplete model step; retry after it finishes.")
  if (messages.size !== prompts.size || !messages.size) fail("format", "Kimi user prompt has not reached its context record; retry.")
  if (typeof source.meta.title === "string" && source.meta.title && Buffer.byteLength(source.meta.title) <= 200) title = source.meta.title
  const captureStatus = partial ? "partial" : "healthy"
  const header: SourceCaptureHeader = { profile: "kimi.code.wire.linear.1", origin: source.origin,
    session: { sourceSessionId: sourceId, title, summary: "", insight: "", actor: { name: "User", harness: "kimi-code" }, branch: "",
      status: active ? "active" : "idle", captureStatus, updatedAt: new Date(latest).toISOString(), reportedEventCount: events },
    threads: [{ sourceThreadId: sourceId, label: title, summary: "", captureStatus }], target: { events, usage: usageCount, threads: 1 } }
  if (Buffer.byteLength(JSON.stringify(header)) > request.projection.pageBytes) fail("limit", "Kimi header exceeds its page budget.")
  return { header, frames }
}
