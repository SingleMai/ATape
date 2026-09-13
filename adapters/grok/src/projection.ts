import { isBoundedToolValue, type AcpSessionUpdate, type SourceCaptureFrame, type SourceCaptureHeader, type SourceOpenRequest } from "@atape/domain"
import { fail, id, identity, object, time, type Row, type snapshot } from "./source.ts"

type Source = Awaited<ReturnType<typeof snapshot>>
const text = (v: unknown) => { if (typeof v !== "string") fail("format", "Grok text is invalid."); return v as string }
const counter = (v: unknown) => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail("format", "Grok usage counter is invalid."); return v as number }
const occurred = (row: Row) => {
  const n = object(object(row.params)._meta).agentTimestampMs
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 8_640_000_000_000_000) fail("format", "Grok event timestamp is unavailable.")
  return new Date(n as number).toISOString()
}

/** Completed native turns supply both the identity namespace and the redaction boundary. */
export const project = (source: Source, request: SourceOpenRequest) => {
  const started = performance.now(), sourceId = source.origin.sourceId
  const frames: SourceCaptureFrame[] = [], prompts = new Set<string>(), tools = new Set<string>()
  let at = 0, events = 0, usages = 0, turns = 0, bytes = 0, partial = false, title = "Grok Build session"
  const admit = (frame: SourceCaptureFrame) => {
    if (frame.events.length > 500 || frame.usage.length > 500) fail("limit", "Grok frame exceeds its event or usage bound.")
    const size = Buffer.byteLength(JSON.stringify(frame)); bytes += size
    if (size + Buffer.byteLength(JSON.stringify({ frames: [], done: false })) > request.projection.pageBytes || bytes > 64 * 1024 * 1024)
      fail("limit", "Grok projection exceeds its page or 64 MiB snapshot budget.")
    if (events > request.projection.events || usages > request.projection.usage) fail("limit", "Grok projection exceeds its event or usage budget.")
    frames.push(frame)
  }
  while (at < source.records.length) {
    request.signal.throwIfAborted()
    if (performance.now() - started > request.limits.durationMs) fail("limit", "Grok projection exceeded its deadline.")
    let end = at
    while (end < source.records.length && object(object(source.records[end]!.row.params).update).sessionUpdate !== "turn_completed") end++
    if (end === source.records.length) fail("format", "Grok turn has not completed; retry.")
    const terminal = source.records[end]!, completed = object(object(terminal.row.params).update), prompt = id(completed.prompt_id)
    if (terminal.row.method !== "_x.ai/session/update" || completed.stop_reason !== "end_turn" || prompts.has(prompt))
      fail("unsupported", "Grok turn completion is unsupported or duplicated.")
    prompts.add(prompt)
    const own = source.records.slice(at, end + 1), seen = new Set<string>(), calls = new Map<string, { done: boolean; name: string }>()
    let user = false, assistant = false
    for (let index = 0; index < own.length; index++) {
      const { row, json } = own[index]!, params = object(row.params), update = object(params.update), meta = object(params._meta), eventId = id(meta.eventId)
      if (params.sessionId !== sourceId || !eventId.startsWith(sourceId + "-") || seen.has(eventId)) fail("unsupported", "Grok update has a foreign or duplicated identity.")
      seen.add(eventId)
      if (meta.promptId != null && meta.promptId !== prompt) fail("unsupported", "Grok turn contains a foreign prompt identity.")
      const kind = update.sessionUpdate, output: SourceCaptureFrame["events"][number][] = [], usage: SourceCaptureFrame["usage"][number][] = []
      const emit = (value: AcpSessionUpdate, fidelity: "native" | "partial" = "native") => {
        output.push({ sourceEventId: identity("event", sourceId, prompt, eventId), sourceThreadId: sourceId, sourceOrder: events, eventIndex: events++,
          orderFidelity: "derived", fidelity, occurredAt: occurred(row), update: value })
      }
      const rawRecords = [json]
      if (kind === "turn_completed") {
        if (!user || !assistant || [...calls.values()].some(call => !call.done)) fail("format", "Grok completed turn lacks its complete conversation or tool results.")
        const native = object(completed.usage), models = object(native.modelUsage)
        if (!Object.keys(models).length) partial = true
        let totalInput = 0, totalOutput = 0
        for (const [model, value] of Object.entries(models)) {
          id(model); const counts = object(value)
          const inputTokens = counter(counts.inputTokens), outputTokens = counter(counts.outputTokens)
          const cacheReadTokens = counts.cachedReadTokens === undefined ? undefined : counter(counts.cachedReadTokens)
          const cacheWriteTokens = counts.cacheCreationTokens === undefined ? undefined : counter(counts.cacheCreationTokens)
          const reasoningTokens = counts.reasoningTokens === undefined ? undefined : counter(counts.reasoningTokens)
          if ((cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) > inputTokens || (reasoningTokens ?? 0) > outputTokens || counts.totalTokens !== inputTokens + outputTokens)
            fail("unsupported", "Grok usage has an unsupported token accounting profile.")
          totalInput += inputTokens; totalOutput += outputTokens
          usage.push({ sourceUsageId: identity("usage", sourceId, prompt, model), sourceThreadId: sourceId, occurredAt: occurred(row), model, inputTokens, outputTokens,
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) })
          usages++
        }
        if (Object.keys(models).length && (native.inputTokens !== totalInput || native.outputTokens !== totalOutput || native.totalTokens !== totalInput + totalOutput))
          fail("unsupported", "Grok per-model usage does not match its turn totals.")
      } else if (kind === "hook_execution" && row.method === "_x.ai/session/update") {
        // Native hook telemetry is preserved only in Raw.
      } else {
        if (row.method !== "session/update") fail("unsupported", "Grok update method is unsupported.")
        if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
          if (kind === "user_message_chunk") {
            if (index !== 0 || user || object(update._meta).promptIndex !== turns) fail("unsupported", "Grok user prompt has an unsupported turn position.")
            user = true
          } else if (!user) fail("format", "Grok assistant update has no user turn.")
          const content = object(update.content)
          if (content.type !== "text") fail("unsupported", "Grok non-text messages require a wider native profile.")
          let contentText = text(content.text)
          // Join adjacent persisted text units before the Host masks them. Streaming
          // fragments cannot create separate redaction boundaries or message identities.
          while (index + 1 < own.length && object(object(own[index + 1]!.row.params).update).sessionUpdate === kind) {
            const next = own[++index]!, p = object(next.row.params), u = object(p.update), m = object(p._meta), nextId = id(m.eventId)
            if (next.row.method !== "session/update" || kind === "user_message_chunk" && object(u._meta).promptIndex !== turns || p.sessionId !== sourceId || !nextId.startsWith(sourceId + "-") || seen.has(nextId) || m.promptId != null && m.promptId !== prompt || object(u.content).type !== "text")
              fail("unsupported", "Grok message fragments have inconsistent identity or content.")
            occurred(next.row); seen.add(nextId); rawRecords.push(next.json); contentText += text(object(u.content).text)
          }
          if (kind === "user_message_chunk" && turns === 0 && contentText && Buffer.byteLength(contentText) <= 200) title = contentText
          emit({ sessionUpdate: kind, messageId: identity("message", sourceId, prompt, eventId), content: { type: "text", text: contentText } })
          if (kind === "agent_message_chunk") assistant = true
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          if (!user) fail("format", "Grok tool has no user turn.")
          if (object(update.rawInput).is_background === true || object(update.rawOutput).truncated === true) fail("unsupported", "Grok background or spilled tool output requires a wider native profile.")
          const nativeId = id(update.toolCallId), toolCallId = identity("tool", sourceId, prompt, nativeId)
          if (kind === "tool_call") {
            const name = id(update.title)
            if (name !== "read_file" && name !== "run_terminal_command") fail("unsupported", "Grok tool requires a wider native profile than file reads and foreground commands.")
            if (tools.has(toolCallId)) fail("format", "Grok tool identity is duplicated.")
            tools.add(toolCallId); calls.set(nativeId, { done: false, name })
            const bounded = isBoundedToolValue(update.rawInput); partial ||= !bounded
            emit({ sessionUpdate: "tool_call", toolCallId, title: name, kind: name === "read_file" ? "read" : "execute", status: "pending", ...(bounded ? { rawInput: update.rawInput } : {}) }, bounded ? "native" : "partial")
          } else {
            const call = calls.get(nativeId)
            if (!call || call.done) fail("format", "Grok tool update has no open call.")
            const status = update.status
            if (status != null && status !== "completed" && status !== "failed" && status !== "in_progress" && status !== "pending") fail("unsupported", "Grok tool status is unsupported.")
            call!.done = status === "completed" || status === "failed"
            const result = call!.name === "run_terminal_command" && update.rawOutput !== undefined ? object(update.rawOutput).output_for_prompt : update.rawOutput
            const inputBounded = update.rawInput === undefined || isBoundedToolValue(update.rawInput)
            const outputBounded = update.rawOutput === undefined || result !== undefined && isBoundedToolValue(result)
            const bounded = inputBounded && outputBounded; partial ||= !bounded
            emit({ sessionUpdate: "tool_call_update", toolCallId, title: typeof update.title === "string" ? update.title : call!.name,
              ...(status == null ? {} : { status: status as "completed" | "failed" | "in_progress" | "pending" }),
              ...(inputBounded && update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
              ...(outputBounded && update.rawOutput !== undefined ? { rawOutput: result } : {}) }, bounded ? "native" : "partial")
          }
        } else fail("unsupported", "Grok update requires a wider native profile.")
      }
      admit({ recordKey: identity("record", sourceId, prompt, eventId), events: output, usage,
        ...(request.rawEnabled ? { raw: { format: "grok.updates.v1", sourceSessionId: sourceId, promptId: prompt, records: rawRecords } } : {}) })
    }
    turns++; at = end + 1
  }
  if (source.state.turnCount !== turns || source.state.userMessageCount !== turns) fail("format", "Grok signals and completed turns are inconsistent; retry.")
  if (request.rawEnabled) admit({ recordKey: identity("metadata", sourceId), events: [], usage: [], raw: { format: "grok.metadata.v1", sourceSessionId: sourceId, summary: source.summaryJson, signals: source.signalsJson } })
  const captureStatus = partial ? "partial" as const : "healthy" as const
  const header: SourceCaptureHeader = { profile: "grok.build.updates.linear.1", origin: source.origin,
    session: { sourceSessionId: sourceId, title, summary: "", insight: "", actor: { name: "User", harness: "grok-build" }, branch: "", status: "idle", captureStatus,
      updatedAt: occurred(source.records.at(-1)!.row), reportedEventCount: events },
    threads: [{ sourceThreadId: sourceId, label: title, summary: "", captureStatus }], target: { events, usage: usages, threads: 1 } }
  time(source.metadata.updated_at)
  if (Buffer.byteLength(JSON.stringify(header)) > request.projection.pageBytes) fail("limit", "Grok header exceeds its page budget.")
  return { header, frames }
}
