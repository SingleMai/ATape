import { isBoundedToolValue, type AcpSessionUpdate, type SourceCaptureFrame, type SourceCaptureHeader, type SourceOpenRequest } from "@atape/domain"
import { fail, failedTool, id, identity, object, type Row, type snapshot } from "./source.ts"

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
type Source = Awaited<ReturnType<typeof snapshot>>
const projectThread = (source: Source, request: SourceOpenRequest, started: number, byteBudget: number, child?: Source["children"][number]) => {
  const sourceId = source.origin.sourceId, threadId = child?.id ?? sourceId, namespace = child ? identity("child", sourceId, threadId) : sourceId
  const records = child?.history.records ?? source.records, callChildren = child?.callChildren ?? source.callChildren
  const frames: SourceCaptureFrame[] = [], turns: SourceCaptureFrame[][] = [[]]
  let userTurns = 0
  const seen = new Map<string, string>(), calls = new Map<string, string>(), usages = new Map<string, string>()
  let nativeSession: string | undefined, ownUserSeen = false
  let manualCompact = false, hasCompaction = false
  let previous: string | undefined, events = 0, usageCount = 0, partial = false, latest = 0, title = "CodeBuddy session", active = false
  let frameBytes = 0
  for (const { row, json } of records) {
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
    if (child && (compactAgent || marked || row.logicalParentId != null)) fail("unsupported", "CodeBuddy child compaction requires a wider source profile.")
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
      if (child ? currentSession !== child.nativeSessionId : !source.forkedFrom && currentSession !== sourceId || currentSession.startsWith("agent-") ||
        ownUserSeen && currentSession !== sourceId && currentSession !== source.forkedFrom)
        fail("unsupported", "CodeBuddy history contains a foreign Session identity.")
      if (nativeSession !== currentSession && (row.type !== "message" || row.role !== "user"))
        fail("unsupported", "CodeBuddy Session identity changes outside a user turn.")
      nativeSession = currentSession
      if (((contextOnly ? row.logicalParentId : row.parentId) ?? undefined) !== previous) fail("unsupported", "CodeBuddy history is not one complete parent chain.")
      if (provider.agent != null && provider.agent !== (child?.agent ?? "cli") && !compactAgent) fail("unsupported", "CodeBuddy non-CLI agents require a wider source profile.")
      previous = rowId
    } else if (row.parentId != null) fail("unsupported", "CodeBuddy has an unsupported parent-linked record.")
    else if (row.sessionId != null && row.sessionId !== nativeSession) fail("unsupported", "CodeBuddy history contains a foreign Session identity.")
    latest = Math.max(latest, Date.parse(iso(row.timestamp)))
    const output: SourceCaptureFrame["events"][number][] = [], usage: SourceCaptureFrame["usage"][number][] = []
    const emit = (slot: string, update: AcpSessionUpdate, fidelity: "native" | "partial" = "native", childThreadId?: string) => {
      output.push({ sourceEventId: identity("event", namespace, rowId, slot), sourceThreadId: threadId,
        sourceOrder: events, eventIndex: events++, orderFidelity: "derived", fidelity, occurredAt: iso(row.timestamp), update, ...(childThreadId === undefined ? {} : { childSourceThreadId: childThreadId }) })
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
      if (!ownUserSeen && row.role === "user" && row.sessionId === (child?.nativeSessionId ?? sourceId)) {
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
      if (name === "Task" || name === "Agent" && !callChildren.has(callId)) fail("unsupported", "CodeBuddy child-agent call has no supported receipt.")
      if (calls.has(callId)) fail("format", "CodeBuddy tool call identity is duplicated.")
      calls.set(callId, name)
      let input: unknown
      try { input = JSON.parse(text(row.arguments)) } catch { fail("format", "CodeBuddy tool arguments are invalid JSON.") }
      const bounded = isBoundedToolValue(input)
      if (!bounded) partial = true
      emit("call", { sessionUpdate: "tool_call", toolCallId: identity("tool", namespace, callId), title: name,
        kind: name === "Read" ? "read" : "other", status: "in_progress", ...(bounded ? { rawInput: input } : {}) }, bounded ? "native" : "partial", callChildren.get(callId))
      active = true
    } else if (row.type === "function_call_result") {
      const callId = id(row.callId)
      if (calls.get(callId) !== row.name) fail("format", "CodeBuddy tool result has no matching call.")
      if (!["completed", "failed", "error"].includes(String(row.status))) fail("unsupported", "CodeBuddy tool result status is unsupported.")
      const failed = failedTool(row)
      const bounded = row.output !== undefined && isBoundedToolValue(row.output)
      const spilled = JSON.stringify(row.output)?.includes("<persisted-output>") === true
      if (!bounded || spilled) partial = true
      emit("result", { sessionUpdate: "tool_call_update", title: calls.get(callId)!, toolCallId: identity("tool", namespace, callId),
        status: failed ? "failed" : "completed", ...(bounded ? { rawOutput: row.output } : {}) }, bounded && !spilled ? "native" : "partial")
    } else if (row.type !== "file-history-snapshot") partial = true

    // Native normalized message.usage includes cached input and reasoning output.
    // Several tool calls may carry the same model response: count that response once.
    const normalized = object(object(row.message).usage)
    if (Object.keys(normalized).length) {
      const modelMessage = id(provider.messageId), key = identity("usage", namespace, modelMessage)
      const inputTokens = counter(normalized.input_tokens), outputTokens = counter(normalized.output_tokens)
      const cacheReadTokens = counter(normalized.cache_read_input_tokens), cacheWriteTokens = counter(normalized.cache_creation_input_tokens)
      const counts = { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) }
      if (Object.keys(counts).length) {
        const value = { model: id(provider.model), ...counts }, fingerprint = JSON.stringify(value)
        if (usages.has(key) && usages.get(key) !== fingerprint) fail("unsupported", "CodeBuddy model response has conflicting usage counters.")
        if (!usages.has(key)) { usages.set(key, fingerprint); usageCount++; usage.push({ sourceUsageId: key, sourceThreadId: threadId, occurredAt: iso(row.timestamp), ...value }) }
      }
    } else if (provider.usage != null || provider.rawUsage != null) partial = true
    if (events > request.projection.events || usageCount > request.projection.usage || output.length > 500) fail("limit", "CodeBuddy projection exceeds its event or usage limit.")
    const frame: SourceCaptureFrame = { recordKey: identity("record", namespace, rowId), events: output, usage,
      ...(request.rawEnabled ? { raw: { format: "codebuddy.jsonl.v1", sourceSessionId: sourceId, ...(child ? { sourceThreadId: threadId } : {}), recordId: rowId, json,
        ...(!child && rowId === source.records[0]!.row.id && source.forkedFrom ? { sidecar: { format: "codebuddy.meta.v1", json: source.metadataJson } } : {}) } } : {}) }
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    frameBytes += bytes
    if (bytes + Buffer.byteLength(JSON.stringify({ frames: [], done: false })) > request.projection.pageBytes || frameBytes > byteBudget)
      fail("limit", "CodeBuddy projection exceeds its page or 64 MiB snapshot budget.")
    frames.push(frame)
    if (child && row.type === "message" && row.role === "user" && userTurns++ > 0) turns.push([])
    turns.at(-1)!.push(frame)
  }
  if (manualCompact) fail("format", "CodeBuddy compaction has not completed; retry.")
  const captureStatus = partial ? "partial" as const : "healthy" as const
  const profile = hasCompaction ? source.forkedFrom ? "fork.compaction" : "compaction" : source.forkedFrom ? "fork" : "linear"
  const header: SourceCaptureHeader = { profile: `codebuddy.cli.jsonl.${profile}.1`, origin: source.origin,
    session: { sourceSessionId: sourceId, title, summary: "", insight: "", actor: { name: "User", harness: "codebuddy-code" }, branch: "",
      status: active ? "active" : "idle", captureStatus, updatedAt: new Date(latest).toISOString(), reportedEventCount: events },
    threads: [{ sourceThreadId: threadId, ...(child ? { parentSourceThreadId: child.parentId } : {}), label: child?.label ?? title, summary: "", captureStatus }], target: { events, usage: usageCount, threads: 1 } }
  if (Buffer.byteLength(JSON.stringify(header)) > request.projection.pageBytes) fail("limit", "CodeBuddy header exceeds its page budget.")
  return { header, frames, turns, bytes: frameBytes }
}

/** Insert each delegated turn at its parent call, then assign the Host’s global event order. */
export const project = (source: Source, request: SourceOpenRequest) => {
  const started = performance.now(), root = projectThread(source, request, started, 64 * 1024 * 1024)
  const threads = [...root.header.threads], children = new Map<string, ReturnType<typeof projectThread>>()
  let bytes = root.bytes, events = root.header.target.events, usage = root.header.target.usage
  let latest = root.header.session.updatedAt, active = root.header.session.status === "active", partial = root.header.session.captureStatus === "partial"
  for (const child of source.children) {
    const planned = projectThread(source, { ...request, projection: { ...request.projection, events: request.projection.events - events, usage: request.projection.usage - usage } }, started, 64 * 1024 * 1024 - bytes, child)
    children.set(child.id, planned)
    threads.push(...planned.header.threads)
    bytes += planned.bytes; events += planned.header.target.events; usage += planned.header.target.usage
    latest = latest > planned.header.session.updatedAt ? latest : planned.header.session.updatedAt
    active ||= planned.header.session.status === "active"; partial ||= planned.header.session.captureStatus === "partial"
  }
  const frames: SourceCaptureFrame[] = [], cursors = new Map<string, number>()
  // An explicit stack keeps deeply nested native families within bounded memory.
  const pending = [...root.frames].reverse()
  let order = 0, orderedBytes = 0
  while (pending.length) {
    request.signal.throwIfAborted()
    if (performance.now() - started > request.limits.durationMs) fail("limit", "CodeBuddy family ordering exceeded its deadline.")
    const frame = pending.pop()!
    const ordered = { ...frame, events: frame.events.map(event => ({ ...event, sourceOrder: order, eventIndex: order++ })) }
    orderedBytes += Buffer.byteLength(JSON.stringify(ordered))
    if (orderedBytes > 64 * 1024 * 1024) fail("limit", "CodeBuddy ordered family exceeds its snapshot budget.")
    frames.push(ordered)
    const childId = frame.events.find(event => event.childSourceThreadId !== undefined)?.childSourceThreadId
    if (childId !== undefined) {
      const at = cursors.get(childId) ?? 0, turn = children.get(childId)?.turns[at]
      if (!turn) fail("format", "CodeBuddy parent call has no complete child turn.")
      cursors.set(childId, at + 1)
      for (let index = turn!.length - 1; index >= 0; index--) pending.push(turn![index]!)
    }
  }
  const header: SourceCaptureHeader = { ...root.header, ...(source.children.length ? { profile: "codebuddy.cli.jsonl.family.1" } : {}), threads,
    session: { ...root.header.session, reportedEventCount: events, updatedAt: latest, status: active ? "active" : "idle", captureStatus: partial ? "partial" : "healthy" },
    target: { events, usage, threads: threads.length } }
  if (Buffer.byteLength(JSON.stringify(header)) > request.projection.pageBytes) fail("limit", "CodeBuddy family header exceeds its page budget.")
  return { header, frames }
}
