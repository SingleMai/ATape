import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { Schema } from "effect"
import type { GitSource, SourceCaptureLimits, SourceDiscoveryPage } from "@atape/domain"

export class CodeBuddySourceError extends Schema.TaggedError<CodeBuddySourceError>()("CodeBuddySourceError", {
  reason: Schema.Literals(["io", "format", "unsupported", "attribution", "limit", "closed"]), message: Schema.String
}) {}
export const fail = (reason: CodeBuddySourceError["reason"], message: string): never => { throw new CodeBuddySourceError({ reason, message }) }
export const sourceError = (cause: unknown) => cause instanceof CodeBuddySourceError ? cause : new CodeBuddySourceError({ reason: "io", message: "CodeBuddy source could not be read." })
export const identity = (...parts: string[]) => "cb_" + createHash("sha256").update(JSON.stringify(parts)).digest("hex")
const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
export type Row = Record<string, unknown>
export const object = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
export const id = (value: unknown): string => {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 500 || value.includes("\0")) fail("format", "CodeBuddy record identity is invalid.")
  return value as string
}
const utf8 = (bytes: Uint8Array): string => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return fail("format", "CodeBuddy source is not valid UTF-8.") }
}
export const parse = (line: string): Row => {
  try { return decode(JSON.parse(line)) } catch { return fail("format", "CodeBuddy JSONL contains an invalid record.") }
}
export const failedTool = (row: Row) => {
  const result = object(object(row.providerData).toolResult)
  return row.status !== "completed" || result.error != null || object(result.rawResponse).is_error === true
}
const maxFiles = 10_000
export const maxSnapshotBytes = 16 * 1024 * 1024
const stamp = (s: Awaited<ReturnType<typeof lstat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
const missing = (e: unknown) => object(e).code === "ENOENT"
export const checkDirectory = async (path: string) => {
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink()) fail("format", "CodeBuddy source directories must not be symlinks.")
}

/** Bounded, non-recursive inventory. File names locate data; they never establish Project ownership. */
export const inventory = async (home: string, signal: AbortSignal): Promise<string[]> => {
  if (!isAbsolute(home)) fail("format", "CodeBuddy home must be an absolute path.")
  const files: string[] = []
  let entries = 0
  const count = () => { signal.throwIfAborted(); if (++entries > maxFiles) fail("limit", "CodeBuddy discovery exceeds 10000 entries.") }
  try {
    await checkDirectory(home); await checkDirectory(join(home, "projects"))
  } catch (e) { if (missing(e)) return []; throw e }
  const projects = await opendir(join(home, "projects"))
  for await (const project of projects) {
    count(); if (!project.isDirectory() || project.isSymbolicLink()) continue
    const path = join(home, "projects", project.name)
    await checkDirectory(path)
    for await (const file of await opendir(path)) {
      count()
      if (file.isFile() && !file.isSymbolicLink() && file.name.endsWith(".jsonl")) files.push(join(path, file.name))
    }
  }
  return files.sort()
}

const origin = (rows: ReadonlyArray<Row>, file: string, meta: Row): GitSource => {
  const row = rows[0]!
  if (row.type !== "message" || row.role !== "user" || row.parentId != null || row.logicalParentId != null)
    fail("unsupported", "CodeBuddy requires an original, unbranched user root.")
  const sourceId = id(basename(file, ".jsonl")), rootId = id(row.sessionId)
  if (sourceId.startsWith("agent-") || rootId.startsWith("agent-")) fail("unsupported", "CodeBuddy subagent histories require a wider source profile.")
  let first = row
  if (meta.forkedFrom !== undefined) {
    if (id(meta.forkedFrom) !== rootId || rootId === sourceId) fail("unsupported", "CodeBuddy fork metadata does not match its copied root.")
    // 2.124.0 resumes with the copied root's sessionId and the fork's storeId.
    // Its first fork-owned user record anchors storage identity and creation CWD.
    first = rows.find(row => row.sessionId === sourceId) ?? {}
    if (first.type !== "message" || first.role !== "user" || first.parentId == null)
      fail("attribution", "CodeBuddy fork has no original fork-owned user record.")
  } else if (rootId !== sourceId) fail("unsupported", "CodeBuddy copied histories require native fork metadata.")
  if (typeof first.cwd !== "string" || !isAbsolute(first.cwd)) fail("attribution", "CodeBuddy original CWD is unavailable.")
  return { sourceId, originKey: identity("origin", sourceId, id(first.id)), cwd: first.cwd as string }
}

const metadata = async (file: string, signal: AbortSignal) => {
  const path = file.replace(/\.jsonl$/, ".meta.json")
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > 64 * 1024) fail("limit", "CodeBuddy metadata exceeds its bound.")
      const buffer = Buffer.alloc(before.size)
      for (let at = 0; at < buffer.length;) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, at, buffer.length - at, at)
        if (!bytesRead) fail("format", "CodeBuddy metadata changed; retry.")
        at += bytesRead
      }
      if (stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await lstat(path))) fail("format", "CodeBuddy metadata changed; retry.")
      const json = utf8(buffer), row = parse(json)
      if (Object.keys(row).some(key => key !== "forkedFrom")) fail("unsupported", "CodeBuddy metadata requires a wider source profile.")
      if (row.forkedFrom !== undefined) id(row.forkedFrom)
      return { stamp: stamp(before), row, json }
    } finally { await handle.close() }
  } catch (e) { if (missing(e)) return { stamp: "absent", row: {} as Row, json: undefined }; throw e }
}

const readHeader = async (file: string, limits: SourceCaptureLimits, signal: AbortSignal) => {
  const meta = await metadata(file, signal)
  // A copied prefix cannot attribute a fork. Find its own first record within
  // the same bounded, stamp-checked snapshot used by open.
  if (meta.row.forkedFrom !== undefined) return (await snapshotFile(file, limits, signal)).origin
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = await handle.stat()
    if (!s.isFile()) fail("format", "CodeBuddy history must be a regular file.")
    const buffer = Buffer.alloc(Math.min(s.size, limits.rowBytes + 1))
    let offset = 0
    while (offset < buffer.length) {
      signal.throwIfAborted()
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const end = buffer.subarray(0, offset).indexOf(10)
    if (end < 0) fail(offset > limits.rowBytes ? "limit" : "format", "CodeBuddy original record is oversized or incomplete.")
    if (stamp(s) !== stamp(await handle.stat()) || meta.stamp !== (await metadata(file, signal)).stamp) fail("format", "CodeBuddy source changed during discovery; retry.")
    return origin([parse(utf8(buffer.subarray(0, end)))], file, meta.row)
  } finally { await handle.close() }
}

export const discover = async (home: string, cursor: string | null, limits: SourceCaptureLimits, signal: AbortSignal): Promise<SourceDiscoveryPage> => {
  const files = await inventory(home, signal)
  // Cursor is a stable file-path digest; changed inventory restarts safely on the next traversal.
  const at = cursor === null ? -1 : files.findIndex(file => identity("file", file) === cursor)
  const selected = files.slice(at + 1, at + 1 + Math.min(limits.pageRows, 32))
  const sources: GitSource[] = [], sourceFailures: SourceDiscoveryPage["sourceFailures"][number][] = []
  const names = new Map<string, number>()
  for (const file of files) names.set(basename(file), (names.get(basename(file)) ?? 0) + 1)
  for (const file of selected) {
    signal.throwIfAborted()
    if (names.get(basename(file))! > 1) { sourceFailures.push({ source: file, reason: "duplicate" }); continue }
    try { sources.push(await readHeader(file, limits, signal)) }
    catch (e) { signal.throwIfAborted(); sourceFailures.push({ source: file, reason: sourceError(e).reason === "closed" ? "io" : sourceError(e).reason as "io" | "format" | "unsupported" | "attribution" | "limit" }) }
  }
  const done = at + 1 + selected.length >= files.length
  const page = { sources, cursor: done ? null : identity("file", selected.at(-1)!), done, sourceFailures, sourceFailuresTruncated: false }
  if (Buffer.byteLength(JSON.stringify(page)) > limits.pageBytes) fail("limit", "CodeBuddy discovery page exceeds its byte budget.")
  return page
}

/** Freeze a bounded, complete UTF-8 view, then verify file and sidecar stamps. No source handle survives this operation. */
type History = Awaited<ReturnType<typeof readHistory>>
type ChildCall = { callId: string; prompt: string } & (
  { mode: "foreground"; afterId?: string; lastId: string } |
  { mode: "background"; summary: string } |
  { mode: "message"; summary: string; sentAt: number }
)
type ChildReference = { agent: string; label: string; calls: ChildCall[]; backgroundName?: string; backgroundDescription?: string; hasMessages?: true }
type ChildSnapshot = { id: string; parentId: string; nativeSessionId: string; agent: string; label: string; background: boolean; continuing: boolean; delegatedPrompts: Map<string, string>; history: History; callChildren: Map<string, string | undefined> }
const segment = (value: unknown) => {
  const name = id(value)
  if (name === "." || name === ".." || /[\\/]/.test(name)) fail("format", "CodeBuddy child identity is not a file segment.")
  return name
}

const teammateMessage = (from: string, summary: string, content: string) =>
  `<teammate-message teammate_id="${from}" summary="${summary}">\n${content}\n</teammate-message>`

// Only these observed framework notifications are context, not human turns.
// Unknown inbox messages keep the previous publication until their meaning is proven.
const internalNotice = (row: Row, children: Map<string, ChildReference>, names: Map<string, string | undefined>) => {
  const meta = object(object(row.providerData).teammateMessage)
  const block = Array.isArray(row.content) && row.content.length === 1 ? object(row.content[0]) : {}
  if (Object.keys(meta).some(key => !["from", "summary", "color", "timestamp"].includes(key)) || block.type !== "input_text" ||
    typeof meta.timestamp !== "string" || !Number.isFinite(Date.parse(meta.timestamp)) || typeof block.text !== "string" || typeof meta.summary !== "string")
    fail("unsupported", "CodeBuddy inbox notification metadata is unproven.")
  const name = meta.from === "system" ? (meta.summary as string).split(" ", 1)[0]! : meta.from
  const childId = typeof name === "string" ? names.get(name) : undefined, ref = childId === undefined ? undefined : children.get(childId)
  if (!ref || ref.backgroundName !== name) fail("unsupported", "CodeBuddy inbox notification has no unique background child.")
  if (meta.from === name && ref!.hasMessages && meta.summary === `${name} reactivated — processing new messages` &&
    block.text === teammateMessage(name as string, meta.summary as string, `Teammate "${name}" has been reactivated to process new message(s) from team-lead.`)) return
  if (meta.from === "system") {
    for (const description of new Set([ref!.backgroundDescription, ...(ref!.hasMessages ? [name] : [])])) {
      if (description === undefined || meta.summary !== `${name} completed: ${description}`) continue
      const prefix = `<teammate-message teammate_id="system" summary="${meta.summary}">\n[Framework Auto-Notification]\nTeammate "${name}" completed successfully.${description ? `\nTask: ${description}` : ""}\nDuration: `
      if ((block.text as string).startsWith(prefix) && /^(?:\d+m )?\d+s\n<\/teammate-message>$/.test((block.text as string).slice(prefix.length))) return
    }
  }
  fail("unsupported", "CodeBuddy inbox notification requires a wider source profile.")
}

// Only completed, structured native Agent receipts authorize child-file reads.
const references = (history: History, root = false) => {
  const children = new Map<string, ChildReference>(), callChildren = new Map<string, string | undefined>(), names = new Map<string, string | undefined>()
  const calls = new Map<string, { args: Row; name: string; sentAt: unknown; childId?: string }>(), seen = new Map<string, string>(), internalMessages = new Set<string>()
  for (const { row, json } of history.records) {
    const rowId = id(row.id)
    if (seen.has(rowId)) {
      if (seen.get(rowId) !== json) fail("unsupported", "CodeBuddy repeated record revisions require a wider source profile.")
      continue
    }
    seen.set(rowId, json)
    if (root && row.type === "message" && row.role === "user" && (object(row.providerData).teammateMessage != null || Array.isArray(row.content) &&
      row.content.some(block => typeof object(block).text === "string" && /^\s*<teammate-message(?:\s|>)/.test(object(block).text as string)))) {
      internalNotice(row, children, names); internalMessages.add(rowId)
    }
    const sendsToChild = root && row.name === "SendMessage" && names.size > 0
    if (row.type === "function_call" && (row.name === "Agent" || sendsToChild)) {
      const callId = id(row.callId)
      if (calls.has(callId)) fail("format", "CodeBuddy delegation call identity is duplicated.")
      if (typeof row.arguments !== "string") fail("format", "CodeBuddy delegation arguments are invalid.")
      const args = parse(row.arguments as string)
      if (sendsToChild) {
        const childId = typeof args.recipient === "string" ? names.get(args.recipient) : undefined
        if (args.type !== "message" || typeof args.content !== "string" || typeof args.summary !== "string" || childId === undefined)
          fail("unsupported", "CodeBuddy follow-up message has no unique supported background recipient.")
        calls.set(callId, { args, name: "SendMessage", sentAt: row.timestamp, childId: childId! }); continue
      }
      if (args.name != null || args.team_name != null || args.subagent_type === "fork" ||
        args.run_in_background === true && (!root || args.resume != null))
        fail("unsupported", "CodeBuddy named, nested background, resumed background and fork subagents require a wider source profile.")
      if (typeof args.prompt !== "string") fail("format", "CodeBuddy Agent prompt is unavailable.")
      calls.set(callId, { args, name: "Agent", sentAt: row.timestamp })
    } else if (row.type === "function_call_result" && (row.name === "Agent" || sendsToChild)) {
      const callId = id(row.callId), call = calls.get(callId), args = call?.args
      if (!args || callChildren.has(callId)) fail("format", "CodeBuddy Agent receipt has no unique call.")
      if (call!.name !== row.name) fail("format", "CodeBuddy delegation receipt changed tool name.")
      const result = object(object(row.providerData).toolResult), receipt = object(result.subAgent)
      if (call!.name === "SendMessage") {
        if (failedTool(row)) { callChildren.set(callId, undefined); continue }
        const renderer = object(result.renderer)
        if (renderer.type !== "send-message" || typeof renderer.value !== "string" || typeof result.content !== "string")
          fail("unsupported", "CodeBuddy follow-up message has no supported delivery receipt.")
        const delivered = parse(result.content as string), routing = object(delivered.routing), rendered = parse(renderer.value as string)
        if (delivered.success !== true || delivered.notice != null || routing.sender !== "team-lead" || routing.target !== `@${args!.recipient}` ||
          routing.content !== args!.content || routing.summary !== args!.summary || rendered.type !== "message" || rendered.sender !== "team-lead" ||
          rendered.recipient !== args!.recipient || rendered.summary !== args!.summary || rendered.resultMessage !== "Delivered")
          fail("unsupported", "CodeBuddy follow-up delivery and parent call disagree.")
        if (typeof call!.sentAt !== "number" || !Number.isSafeInteger(call!.sentAt)) fail("format", "CodeBuddy follow-up timestamp is invalid.")
        children.get(call!.childId!)!.hasMessages = true
        children.get(call!.childId!)!.calls.push({ mode: "message", callId, prompt: args!.content as string, summary: args!.summary as string, sentAt: call!.sentAt as number })
        callChildren.set(callId, call!.childId!); continue
      }
      if (args!.run_in_background === true) {
        // 2.124.0 launches background Agents as automatic team members. A durable
        // structured spawn receipt, not human output or transient team files,
        // authorizes this one-shot child's storage ID and delegated prompt.
        const renderer = object(result.renderer)
        if (failedTool(row) || receipt.sessionId != null || renderer.type !== "team-member-spawned")
          fail("unsupported", "CodeBuddy background Agent has no supported successful spawn receipt.")
        if (typeof renderer.value !== "string") fail("format", "CodeBuddy background spawn receipt is incomplete.")
        const spawn = parse(renderer.value as string), childId = segment(spawn.taskId)
        if (Object.keys(spawn).some(key => !["name", "description", "teamName", "color", "taskId", "prompt"].includes(key)) ||
          !/^agent-[a-zA-Z0-9_-]+$/.test(childId) || typeof spawn.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(spawn.name) ||
          spawn.teamName !== `_auto_${history.records[0]!.row.sessionId}` || spawn.prompt !== args!.prompt || spawn.description !== args!.description)
          fail("unsupported", "CodeBuddy background spawn identity or prompt is unproven.")
        if (children.has(childId)) fail("unsupported", "CodeBuddy background child has multiple launch calls.")
        const agent = args!.subagent_type == null ? "general-purpose" : id(args!.subagent_type)
        const label = typeof spawn.description === "string" && spawn.description && Buffer.byteLength(spawn.description) <= 200 ? spawn.description : "CodeBuddy child"
        children.set(childId, { agent, label, backgroundName: spawn.name as string, ...(typeof spawn.description === "string" ? { backgroundDescription: spawn.description } : {}), calls: [{ mode: "background", callId, prompt: args!.prompt as string, summary: `Initial task assignment for ${spawn.name}` }] })
        names.set(spawn.name as string, names.has(spawn.name as string) ? undefined : childId)
        callChildren.set(callId, childId); continue
      }
      if (receipt.sessionId == null && failedTool(row)) { callChildren.set(callId, undefined); continue }
      if (receipt.sessionId == null) fail("format", "CodeBuddy Agent receipt is incomplete; retry.")
      if (Object.keys(receipt).some(key => !["sessionId", "afterId", "lastId"].includes(key))) fail("unsupported", "CodeBuddy Agent receipt requires a wider source profile.")
      const childId = segment(receipt.sessionId)
      if (!/^agent-[a-zA-Z0-9_-]+$/.test(childId)) fail("unsupported", "CodeBuddy Agent storage identity is unsupported.")
      if (args!.resume != null && args!.resume !== childId || args!.resume == null && receipt.afterId != null)
        fail("unsupported", "CodeBuddy Agent resume identity is unproven.")
      const agent = args!.subagent_type == null ? "general-purpose" : id(args!.subagent_type)
      const prior = children.get(childId)
      if (prior && prior.agent !== agent) fail("unsupported", "CodeBuddy resumed Agent changed its type.")
      const label = typeof args!.description === "string" && args!.description && Buffer.byteLength(args!.description) <= 200 ? args!.description : "CodeBuddy child"
      const ref = prior ?? { agent, label, calls: [] }
      ref.calls.push({ mode: "foreground", callId, prompt: args!.prompt as string, ...(receipt.afterId == null ? {} : { afterId: id(receipt.afterId) }), lastId: id(receipt.lastId) })
      children.set(childId, ref); callChildren.set(callId, childId)
    }
  }
  if (calls.size !== callChildren.size) fail("format", "CodeBuddy Agent call has not completed; retry.")
  return { children, callChildren, internalMessages }
}

const validateChild = (history: History, ref: ChildReference) => {
  if (Object.keys(history.meta).length) fail("unsupported", "CodeBuddy child metadata requires a wider source profile.")
  const records = [...new Map(history.records.map(record => [record.row.id, record])).values()].filter(({ row }) => ["message", "reasoning", "function_call", "function_call_result"].includes(String(row.type)))
  const first = records[0]?.row ?? {}, nativeSessionId = segment(first.sessionId)
  if (first.type !== "message" || first.role !== "user" || first.parentId != null || first.logicalParentId != null || object(first.providerData).agent !== ref.agent)
    fail("unsupported", "CodeBuddy child has no original delegated user root.")
  const users: number[] = [], delegatedPrompts = new Map<string, string>()
  for (const [index, { row }] of records.entries()) {
    if (row.sessionId !== nativeSessionId) fail("unsupported", "CodeBuddy child changed its native Session identity.")
    if (row.type === "message" && row.role === "user") users.push(index)
  }
  if (users.length !== ref.calls.length) fail("format", "CodeBuddy child turns and completed parent calls disagree; retry.")
  for (const [index, at] of users.entries()) {
    const call = ref.calls[index]!, user = records[at]!.row, turn = records.slice(at, users[index + 1])
    const content = Array.isArray(user.content) && user.content.length === 1 ? object(user.content[0]) : {}
    const prompt = call.mode === "foreground" ? call.prompt : teammateMessage("team-lead", call.summary, call.prompt)
    const previous = records[at - 1]?.row
    const afterId = call.mode === "foreground" ? call.afterId : previous?.id
    if (content.type !== "input_text" || content.text !== prompt || (user.parentId ?? undefined) !== afterId)
      fail("unsupported", "CodeBuddy child prompt or resume boundary does not match its parent call.")
    if (call.mode === "message" && (previous?.type !== "message" || previous.role !== "assistant" || previous.status !== "completed" ||
      typeof previous.timestamp !== "number" || call.sentAt < previous.timestamp))
      fail("unsupported", "CodeBuddy overlapping background messages require a wider source profile.")
    if (call.mode !== "foreground") delegatedPrompts.set(id(user.id), call.prompt)
    const last = turn.at(-1)!.row
    // Native lastId can precede the final assistant; it is evidence, not a cutoff.
    if (call.mode === "foreground" && !turn.some(({ row }) => row.id === call.lastId) || last.type !== "message" || last.role !== "assistant" || last.status !== "completed")
      fail("format", "CodeBuddy child result has not fully reached its history; retry.")
  }
  return { nativeSessionId, delegatedPrompts }
}

export const snapshot = async (home: string, sourceId: string, limits: SourceCaptureLimits, signal: AbortSignal) => {
  const started = performance.now()
  const check = () => { signal.throwIfAborted(); if (performance.now() - started > limits.durationMs) fail("limit", "CodeBuddy family snapshot exceeded its deadline.") }
  const files = (await inventory(home, signal)).filter(file => basename(file, ".jsonl") === sourceId)
  if (files.length !== 1) fail("format", "CodeBuddy source is missing or has duplicate identities.")
  const root = await snapshotFile(files[0]!, limits, signal), children: ChildSnapshot[] = []
  const rootRefs = references(root, true), histories: History[] = [root], used = new Set<string>(), nativeIds = new Set([segment(root.records[0]!.row.sessionId)])
  if (root.forkedFrom && rootRefs.children.size) fail("unsupported", "CodeBuddy forked child families require a proven copied-child frontier.")
  let bytes = root.bytes, records = root.records.length
  const pending = [{ id: sourceId, nativeSessionId: segment(root.records[0]!.row.sessionId), refs: rootRefs }]
  for (let at = 0; at < pending.length; at++) {
    const parent = pending[at]!
    for (const [childId, ref] of parent.refs.children) {
      check()
      if (used.has(childId)) fail("unsupported", "CodeBuddy child has multiple parents or a cycle.")
      used.add(childId)
      if (used.size + 1 > limits.threads || records >= limits.records) fail("limit", "CodeBuddy family exceeds its thread or record budget.")
      const parentDirectory = join(dirname(files[0]!), parent.nativeSessionId), childDirectory = join(parentDirectory, "subagents")
      await checkDirectory(parentDirectory); await checkDirectory(childDirectory)
      const child = await readHistory(join(childDirectory, `${childId}.jsonl`), { ...limits, records: limits.records - records }, signal, maxSnapshotBytes - bytes)
      bytes += child.bytes; records += child.records.length
      const { nativeSessionId, delegatedPrompts } = validateChild(child, ref), refs = references(child)
      if (ref.backgroundName !== undefined && refs.children.size) fail("unsupported", "CodeBuddy background child delegation requires a wider source profile.")
      if (nativeIds.has(nativeSessionId)) fail("unsupported", "CodeBuddy child native Session identity is duplicated.")
      nativeIds.add(nativeSessionId)
      children.push({ id: childId, parentId: parent.id, nativeSessionId, agent: ref.agent, label: ref.label, background: ref.backgroundName !== undefined, continuing: ref.backgroundName !== undefined && ref.calls.length > 1, delegatedPrompts, history: child, callChildren: refs.callChildren })
      histories.push(child); pending.push({ id: childId, nativeSessionId, refs })
    }
  }
  // Every member stays unchanged across the final member's read; no file survives open.
  for (const history of histories) {
    check()
    await checkDirectory(dirname(history.file))
    if (history !== root) await checkDirectory(dirname(dirname(history.file)))
    if (history.fileStamp !== stamp(await lstat(history.file)) || history.metaStamp !== (await metadata(history.file, signal)).stamp)
      fail("format", "CodeBuddy family changed while reading; retry with a fresh snapshot.")
  }
  return { ...root, children, callChildren: rootRefs.callChildren, internalMessages: rootRefs.internalMessages }
}

const snapshotFile = async (file: string, limits: SourceCaptureLimits, signal: AbortSignal) => {
  const history = await readHistory(file, limits, signal)
  return { ...history, origin: origin(history.records.map(record => record.row), file, history.meta), forkedFrom: history.meta.forkedFrom as string | undefined }
}

const readHistory = async (file: string, limits: SourceCaptureLimits, signal: AbortSignal, byteLimit = maxSnapshotBytes) => {
  const started = performance.now()
  const check = () => { signal.throwIfAborted(); if (performance.now() - started > limits.durationMs) fail("limit", "CodeBuddy snapshot exceeded its deadline.") }
  const meta = await metadata(file, signal)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) fail("format", "CodeBuddy source is not a regular file.")
    if (before.size + Buffer.byteLength(meta.json ?? "") > byteLimit) fail("limit", "CodeBuddy family exceeds the 16 MiB snapshot limit.")
    const buffer = Buffer.alloc(before.size)
    for (let offset = 0; offset < buffer.length;) {
      check()
      const { bytesRead } = await handle.read(buffer, offset, Math.min(256 * 1024, buffer.length - offset), offset)
      if (!bytesRead) fail("format", "CodeBuddy source was truncated; retry.")
      offset += bytesRead
    }
    if (!buffer.length || buffer.at(-1) !== 10) fail("format", "CodeBuddy has an incomplete final JSONL record; retry after writing finishes.")
    const records: { row: Row; json: string }[] = []
    let offset = 0
    while (offset < buffer.length) {
      check()
      const end = buffer.indexOf(10, offset)
      if (end - offset + 1 > limits.rowBytes) fail("limit", "CodeBuddy record exceeds the source row limit.")
      const json = utf8(buffer.subarray(offset, end))
      records.push({ row: parse(json), json }); offset = end + 1
      if (records.length > limits.records) fail("limit", "CodeBuddy session exceeds the source record limit.")
    }
    if (stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await lstat(file)) || meta.stamp !== (await metadata(file, signal)).stamp)
      fail("format", "CodeBuddy source changed while reading; retry with a fresh snapshot.")
    return { records, file, fileStamp: stamp(before), metaStamp: meta.stamp, meta: meta.row, metadataJson: meta.json, bytes: buffer.length + Buffer.byteLength(meta.json ?? "") }
  } finally { await handle.close() }
}
