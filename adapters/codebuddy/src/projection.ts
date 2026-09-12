import { isBoundedToolValue, type AcpSessionUpdate, type SourceCaptureFrame, type SourceCaptureHeader, type SourceOpenRequest } from "@atape/domain"
import { fail, id, identity, object, type Row, type snapshot } from "./source.ts"

const iso = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail("format", "CodeBuddy timestamp is invalid.")
  return new Date(value as number).toISOString()
}
const text = (value: unknown) => { if (typeof value !== "string") fail("format", "CodeBuddy text is invalid."); return value as string }
const enclosed = (value: unknown, tag: string) => {
  if (typeof value !== "string") return undefined
  const content = value.trim(), start = `<${tag}>`, end = `</${tag}>`
  return content.startsWith(start) && content.endsWith(end) ? content.slice(start.length, -end.length).trim() || undefined : undefined
}
const counter = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("format", "CodeBuddy usage counter is invalid.")
  return value as number
}

/** Provider interpretation only. Host assigns revisions, provenance, redaction and publication identity. */
export const project = (source: Awaited<ReturnType<typeof snapshot>>, request: SourceOpenRequest) => {
  const sourceId = source.origin.sourceId, frames: SourceCaptureFrame[] = []
  const seen = new Map<string, string>(), calls = new Map<string, string>(), usages = new Map<string, string>()
  let nativeSession: string | undefined, ownUserSeen = false
  let manualCompact = false, hasCompaction = false
  let previous: string | undefined, events = 0, usageCount = 0, partial = false, latest = 0, title = "CodeBuddy session", active = false
  let frameBytes = 0
  const started = performance.now()
  for (const { row, json } of source.records) {
    request.signal.throwIfAborted()
    if (performance.now() - started > request.limits.durationMs) fail("limit", "CodeBuddy projection exceeded its deadline.")
    const rowId = id(row.id), provider = object(row.providerData)
    if (seen.has(rowId)) {
      if (seen.get(rowId) !== json) fail("unsupported", "CodeBuddy repeated record revisions require a wider source profile.")
      continue
    }
    seen.set(rowId, json)
    let compactCommand: string | undefined, contextOnly = false
    const compactAgent = provider.agent === "compact"
    const marked = provider.isCompactInternal === true || provider.isSummary === true || provider.isCompacted === true || provider.compactType != null
    if (compactAgent) {
      hasCompaction = true
      if (!manualCompact && row.type === "message" && row.role === "user" && !marked) {
        const content = Array.isArray(row.content) && row.content.length === 1 ? object(row.content[0]) : {}
        const command = object(content.providerData).content
        if (content.type !== "input_text" || typeof command !== "string" || !/^\/compact(?:\s|$)/.test(command) || !previous)
          fail("unsupported", "CodeBuddy compact command lacks its original user input.")
        compactCommand = command as string; manualCompact = true
      } else if (manualCompact && row.type === "reasoning" && !marked) {
        // Native reasoning belongs to the user's explicit compact turn.
      } else if (manualCompact && row.type === "message" && row.role === "assistant" &&
        provider.isCompactInternal === true && provider.isSummary === true && provider.isCompacted === true && provider.compactType === "user-command") {
        if (row.status !== "completed") fail("format", "CodeBuddy compaction has not completed; retry.")
        const content = Array.isArray(row.content) && row.content.length === 1 ? object(row.content[0]) : {}
        if (content.type !== "output_text" || !enclosed(enclosed(content.text, "conversation_history_summary"), "summary"))
          fail("unsupported", "CodeBuddy compact output has no complete native summary.")
        manualCompact = false
      } else fail("unsupported", "CodeBuddy compact history has an unsupported transition.")
    } else if (manualCompact && row.type !== "file-history-snapshot") {
      fail("unsupported", "CodeBuddy compact history was interrupted before its summary.")
    } else if (marked) {
      const content = Array.isArray(row.content) && row.content.length === 1 ? object(row.content[0]) : {}
      if (row.type !== "message" || row.role !== "user" || provider.compactType !== "pre-message-auto" ||
        provider.isCompactInternal !== true || provider.isCompacted !== true || provider.isSummary !== false || provider.skipRun !== false ||
        row.parentId != null || row.logicalParentId == null || content.type !== "input_text" || !enclosed(content.text, "cb_summary"))
        fail("unsupported", "CodeBuddy automatic compaction requires a wider source profile.")
      contextOnly = true; hasCompaction = true
    }
    if (row.logicalParentId != null && !contextOnly || /compact|rewind|revert|resend|separator/i.test(String(row.type)))
      fail("unsupported", "CodeBuddy branched history is not supported by this profile.")
    const projected = ["message", "reasoning", "function_call", "function_call_result"].includes(String(row.type))
    if (projected) {
      const currentSession = id(row.sessionId)
      if (!source.forkedFrom && currentSession !== sourceId || currentSession.startsWith("agent-") ||
        ownUserSeen && currentSession !== sourceId && currentSession !== source.forkedFrom)
        fail("unsupported", "CodeBuddy history contains a foreign Session identity.")
      if (nativeSession !== currentSession && (row.type !== "message" || row.role !== "user"))
        fail("unsupported", "CodeBuddy Session identity changes outside a user turn.")
      nativeSession = currentSession
      if (((contextOnly ? row.logicalParentId : row.parentId) ?? undefined) !== previous) fail("unsupported", "CodeBuddy history is not one complete parent chain.")
      if (provider.agent != null && provider.agent !== "cli" && !compactAgent) fail("unsupported", "CodeBuddy non-CLI agents require a wider source profile.")
      previous = rowId
    } else if (row.parentId != null) fail("unsupported", "CodeBuddy has an unsupported parent-linked record.")
    else if (row.sessionId != null && row.sessionId !== nativeSession) fail("unsupported", "CodeBuddy history contains a foreign Session identity.")
    latest = Math.max(latest, Date.parse(iso(row.timestamp)))
    const output: SourceCaptureFrame["events"][number][] = [], usage: SourceCaptureFrame["usage"][number][] = []
    const emit = (slot: string, update: AcpSessionUpdate, fidelity: "native" | "partial" = "native") => {
      output.push({ sourceEventId: identity("event", sourceId, rowId, slot), sourceThreadId: sourceId,
        sourceOrder: events, eventIndex: events++, orderFidelity: "derived", fidelity, occurredAt: iso(row.timestamp), update })
    }
    const blocks = (value: unknown, thought = false) => {
      if (!Array.isArray(value)) fail("format", "CodeBuddy content must be an array.")
      for (const [index, content] of (value as unknown[]).entries()) {
        const block = object(content)
        if (["input_text", "output_text", "reasoning_text"].includes(String(block.type))) {
          const contentText = compactCommand ?? text(block.text)
          if (contentText) emit(`block:${index}`, { sessionUpdate: thought ? "agent_thought_chunk" : row.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            messageId: rowId, content: { type: "text", text: contentText } })
        } else partial = true // Images/blobs and unknown blocks remain in Raw only.
      }
    }
    if (row.type === "message") {
      if (row.role !== "user" && row.role !== "assistant") fail("unsupported", "CodeBuddy message role is unsupported.")
      if (!contextOnly) blocks(row.content)
      if (!ownUserSeen && row.role === "user" && row.sessionId === sourceId) {
        ownUserSeen = true
        const candidate = output.map(e => "content" in e.update && e.update.content.type === "text" ? e.update.content.text : "").join(" ")
        // Never cut a token before the Host can redact the complete value.
        if (candidate && Buffer.byteLength(candidate) <= 200) title = candidate
      }
      if (!contextOnly) active = row.role === "user" || row.status !== "completed"
    } else if (row.type === "reasoning") {
      blocks(Array.isArray(row.rawContent) && row.rawContent.length ? row.rawContent : row.content, true)
      active = true
    } else if (row.type === "function_call") {
      const callId = id(row.callId), name = id(row.name)
      if (["Agent", "Task"].includes(name)) fail("unsupported", "CodeBuddy child-agent calls require a wider source profile.")
      if (calls.has(callId)) fail("format", "CodeBuddy tool call identity is duplicated.")
      calls.set(callId, name)
      let input: unknown
      try { input = JSON.parse(text(row.arguments)) } catch { fail("format", "CodeBuddy tool arguments are invalid JSON.") }
      const bounded = isBoundedToolValue(input)
      if (!bounded) partial = true
      emit("call", { sessionUpdate: "tool_call", toolCallId: identity("tool", sourceId, callId), title: name,
        kind: name === "Read" ? "read" : "other", status: "in_progress", ...(bounded ? { rawInput: input } : {}) }, bounded ? "native" : "partial")
      active = true
    } else if (row.type === "function_call_result") {
      const callId = id(row.callId)
      if (calls.get(callId) !== row.name) fail("format", "CodeBuddy tool result has no matching call.")
      if (!["completed", "failed", "error"].includes(String(row.status))) fail("unsupported", "CodeBuddy tool result status is unsupported.")
      const toolResult = object(provider.toolResult)
      const failed = row.status !== "completed" || toolResult.error != null || object(toolResult.rawResponse).is_error === true
      const bounded = row.output !== undefined && isBoundedToolValue(row.output)
      const spilled = JSON.stringify(row.output)?.includes("<persisted-output>") === true
      if (!bounded || spilled) partial = true
      emit("result", { sessionUpdate: "tool_call_update", title: calls.get(callId)!, toolCallId: identity("tool", sourceId, callId),
        status: failed ? "failed" : "completed", ...(bounded ? { rawOutput: row.output } : {}) }, bounded && !spilled ? "native" : "partial")
    } else if (row.type !== "file-history-snapshot") partial = true

    // Native normalized message.usage includes cached input and reasoning output.
    // Several tool calls may carry the same model response: count that response once.
    const normalized = object(object(row.message).usage)
    if (Object.keys(normalized).length) {
      const modelMessage = id(provider.messageId), key = identity("usage", sourceId, modelMessage)
      const inputTokens = counter(normalized.input_tokens), outputTokens = counter(normalized.output_tokens)
      const cacheReadTokens = counter(normalized.cache_read_input_tokens), cacheWriteTokens = counter(normalized.cache_creation_input_tokens)
      const counts = { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) }
      if (Object.keys(counts).length) {
        const value = { model: id(provider.model), ...counts }, fingerprint = JSON.stringify(value)
        if (usages.has(key) && usages.get(key) !== fingerprint) fail("unsupported", "CodeBuddy model response has conflicting usage counters.")
        if (!usages.has(key)) { usages.set(key, fingerprint); usageCount++; usage.push({ sourceUsageId: key, sourceThreadId: sourceId, occurredAt: iso(row.timestamp), ...value }) }
      }
    } else if (provider.usage != null || provider.rawUsage != null) partial = true
    if (events > request.projection.events || usageCount > request.projection.usage || output.length > 500) fail("limit", "CodeBuddy projection exceeds its event or usage limit.")
    const frame: SourceCaptureFrame = { recordKey: identity("record", sourceId, rowId), events: output, usage,
      ...(request.rawEnabled ? { raw: { format: "codebuddy.jsonl.v1", sourceSessionId: sourceId, recordId: rowId, json,
        ...(rowId === source.records[0]!.row.id && source.forkedFrom ? { sidecar: { format: "codebuddy.meta.v1", json: source.metadataJson } } : {}) } } : {}) }
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    frameBytes += bytes
    if (bytes + Buffer.byteLength(JSON.stringify({ frames: [], done: false })) > request.projection.pageBytes || frameBytes > 64 * 1024 * 1024)
      fail("limit", "CodeBuddy projection exceeds its page or 64 MiB snapshot budget.")
    frames.push(frame)
  }
  if (manualCompact) fail("format", "CodeBuddy compaction has not completed; retry.")
  const captureStatus = partial ? "partial" as const : "healthy" as const
  const profile = hasCompaction ? source.forkedFrom ? "fork.compaction" : "compaction" : source.forkedFrom ? "fork" : "linear"
  const header: SourceCaptureHeader = { profile: `codebuddy.cli.jsonl.${profile}.1`, origin: source.origin,
    session: { sourceSessionId: sourceId, title, summary: "", insight: "", actor: { name: "User", harness: "codebuddy-code" }, branch: "",
      status: active ? "active" : "idle", captureStatus, updatedAt: new Date(latest).toISOString(), reportedEventCount: events },
    threads: [{ sourceThreadId: sourceId, label: title, summary: "", captureStatus }], target: { events, usage: usageCount, threads: 1 } }
  if (Buffer.byteLength(JSON.stringify(header)) > request.projection.pageBytes) fail("limit", "CodeBuddy header exceeds its page budget.")
  return { header, frames }
}
