import type { AcpSessionUpdate, AdapterCollectRequest, AdapterCollectionPage, AdapterEvent, AdapterObservation, AdapterOpenContext } from "@atape/domain"
import { Effect, Schema } from "effect"
import { isBoundedToolValue, MaxSourceFailures, type AdapterSourceFailure } from "@atape/domain"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { open, readdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"

const MaxSnapshotBytes = 4 * 1024 * 1024
const MaxRecords = 10_000
const MaxDiscoveryEntries = 10_000
const MaxHeaderBytes = 256 * 1024
const MaxCursorBytes = 16_000
const RecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeRecord = Schema.decodeUnknownSync(RecordSchema)
const CursorSchema = Schema.Struct({
  v: Schema.Literal(1), sessionId: Schema.String, bytes: Schema.Number,
  digest: Schema.String, origin: Schema.String,
  projectionRevision: Schema.optionalKey(Schema.Literal(2))
})
type Cursor = typeof CursorSchema.Type
const DiscoveryCursorSchema = Schema.Struct({
  v: Schema.Literal(2), after: Schema.String,
  sessions: Schema.Array(Schema.Struct({ file: Schema.String, checkpoint: CursorSchema }))
})
type DiscoveryCursor = typeof DiscoveryCursorSchema.Type
type RecordValue = Record<string, unknown>
type Archive = { readonly context: AdapterOpenContext; readonly file: string | undefined; readonly projects: string; readonly project: string }
type Candidate = { readonly file: string; readonly sessionId: string }

// Diagnostics do not acknowledge source bytes and are rebuilt on every scan.
class SourceDiagnostics {
  private readonly failures: AdapterSourceFailure[] = []
  private truncated = false
  add(source: string, reason: AdapterSourceFailure["reason"]) {
    if (this.failures.length < MaxSourceFailures) this.failures.push({ source, reason })
    else this.truncated = true
  }
  capture(source: string, cause: unknown, signal: AbortSignal) {
    signal.throwIfAborted()
    if (cause instanceof ClaudeArchiveError && ["io", "format", "unsupported", "changed", "limit"].includes(cause.reason)) {
      this.add(source, cause.reason as AdapterSourceFailure["reason"])
    } else if (["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR", "EIO", "ESTALE"].includes(string(object(cause)?.code) ?? "")) {
      this.add(source, "io")
    } else throw cause // Configuration, cursor errors and defects are job failures.
  }
  attach(page: AdapterCollectionPage): AdapterCollectionPage {
    return { ...page, ...(this.failures.length ? { sourceFailures: this.failures } : {}),
      ...(this.truncated ? { sourceFailuresTruncated: true } : {}) }
  }
}

export class ClaudeArchiveError extends Schema.TaggedError<ClaudeArchiveError>()("ClaudeArchiveError", {
  reason: Schema.Literals(["configuration", "io", "format", "unsupported", "changed", "cursor", "limit"]),
  message: Schema.String
}) {}
function fail(reason: ClaudeArchiveError["reason"], message: string): never { throw new ClaudeArchiveError({ reason, message }) }
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const timestamp = (value: unknown): string | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined

export const openClaudeArchive = (context: AdapterOpenContext): Effect.Effect<Archive, ClaudeArchiveError> => Effect.tryPromise({
  try: async () => {
    const file = process.env.ATAPE_CLAUDE_SESSION_FILE || undefined
    const home = process.env.ATAPE_CLAUDE_HOME || join(homedir(), ".claude")
    if (file && !isAbsolute(file) || !isAbsolute(home)) fail("configuration", "Claude source overrides must be absolute paths.")
    return { context, file, projects: join(home, "projects"), project: await realpath(context.project.path) }
  },
  catch: cause => cause instanceof ClaudeArchiveError ? cause : new ClaudeArchiveError({ reason: "configuration", message: "Could not open the selected Claude Project." })
})

export const collectClaudePage = (archive: Archive, request: AdapterCollectRequest): Effect.Effect<AdapterCollectionPage, ClaudeArchiveError> => Effect.tryPromise({
  try: () => collect(archive, request),
  catch: cause => cause instanceof ClaudeArchiveError ? cause : new ClaudeArchiveError({ reason: "io", message: "Could not read the selected Claude session." })
})

async function collect(archive: Archive, request: AdapterCollectRequest): Promise<AdapterCollectionPage> {
  request.signal.throwIfAborted()
  const state = decodeDiscoveryCursor(request.cursor)
  const diagnostics = new SourceDiagnostics()
  if (request.previousAdapterVersion && request.previousAdapterVersion !== archive.context.adapter.version) {
    fail("unsupported", "Claude Adapter version changed; existing checkpoint needs an explicit upgrade path.")
  }
  const selected = archive.file ? await readHeader(archive.file, request.signal) : undefined
  const candidates = archive.file
    ? [{ file: archive.file, sessionId: string(selected?.sessionId) ?? "" }]
    : await discover(archive, state, request.signal, diagnostics)
  // Resume after the last publication so a busy Session cannot monopolize pages.
  const pivot = candidates.findIndex(c => c.sessionId === state.after)
  const ordered = [...candidates.slice(pivot + 1), ...candidates.slice(0, pivot + 1)]
  for (const candidate of ordered) {
    request.signal.throwIfAborted()
    const previous = state.sessions.find(s => s.file === candidate.file)
      ?? state.sessions.find(s => s.checkpoint.sessionId === candidate.sessionId)
      ?? (archive.file && state.sessions.length === 1 && state.sessions[0]!.file === "" ? state.sessions[0] : undefined)
    let page: AdapterCollectionPage
    try {
      page = await collectSession(archive, candidate.file, { ...request, cursor: previous ? JSON.stringify(previous.checkpoint) : null })
    } catch (cause) {
      if (archive.file) throw cause // Explicit single-source diagnostics stay fail-fast.
      diagnostics.capture(candidate.file, cause, request.signal)
      continue
    }
    if (page.observations.length === 0) continue
    const checkpoint = decodeCursor(page.nextCursor)!
    // Keep missing sources' checkpoints: deletion never deletes captured history
    // and a reappearing file must still satisfy the committed prefix.
    const sessions = state.sessions.filter(s => s !== previous)
    sessions.push({ file: candidate.file, checkpoint })
    sessions.sort((a, b) => a.checkpoint.sessionId.localeCompare(b.checkpoint.sessionId))
    const nextCursor = JSON.stringify({ v: 2, after: checkpoint.sessionId, sessions } satisfies DiscoveryCursor)
    if (Buffer.byteLength(nextCursor) > MaxCursorBytes) fail("limit", "Claude discovery checkpoint exceeds 16 KB; no session progress was discarded.")
    return diagnostics.attach({ ...page, nextCursor, hasMore: !archive.file && candidates.length > 1 })
  }
  return diagnostics.attach(empty(request.cursor))
}

async function collectSession(archive: Archive, file: string, request: AdapterCollectRequest): Promise<AdapterCollectionPage> {
  const cursor = decodeCursor(request.cursor)
  // A fixed upper bound and one complete segment preserve Host redaction units.
  // No payload spool, multi-page projection, or silent truncation of a session.
  const bytes = await snapshot(file, request.signal)
  const end = bytes.lastIndexOf(10) + 1
  const source = bytes.subarray(0, end)
  if (cursor && (source.length < cursor.bytes || digest(source.subarray(0, cursor.bytes)) !== cursor.digest)) {
    fail("changed", "The captured Claude prefix changed or was truncated; append-only collection stopped.")
  }
  if (end === 0) return empty(request.cursor)
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(source) }
  catch { return fail("format", "Claude source contains invalid UTF-8.") }
  const lines = text.split("\n").filter(line => line.trim().length > 0)
  if (lines.length > MaxRecords) fail("limit", "Claude snapshot exceeds the record limit.")
  const records = lines.map(line => {
    try { return decodeRecord(JSON.parse(line)) }
    catch { return fail("format", "Claude source contains a malformed complete JSONL record.") }
  })
  const graph = records.filter(r => typeof r.uuid === "string")
  const root = graph[0]
  if (!root || root.type !== "user" || root.parentUuid !== null || root.isMeta === true || typeof root.cwd !== "string" || typeof root.sessionId !== "string") {
    fail("unsupported", "Claude session has no supported original user root and CWD.")
  }
  const sessionId = root.sessionId as string, origin = root.cwd as string
  if (cursor && (cursor.sessionId !== sessionId || cursor.origin !== origin)) fail("changed", "Claude session identity or original CWD changed.")
  if (!await belongsToProject(archive, origin, request.signal)) return empty(request.cursor)
  // Refuse ambiguity instead of publishing branches that v1 cannot withdraw.
  let previous: string | null = null
  const seen = new Set<string>()
  for (const record of records) {
    request.signal.throwIfAborted()
    if (record.sessionId !== undefined && record.sessionId !== sessionId) fail("unsupported", "Mixed Claude session identities are not supported.")
    if (record.isSidechain === true || record.type === "system" && (record.subtype === "compact_boundary" || record.compactMetadata !== undefined)) {
      fail("unsupported", "Claude subagent or compaction history requires a later Adapter capability.")
    }
    if (typeof record.uuid !== "string") continue
    if (seen.has(record.uuid) || record.parentUuid !== previous) fail("unsupported", "Claude history is not a single unambiguous append-only chain.")
    seen.add(record.uuid); previous = record.uuid
  }
  const hash = digest(source)
  if (cursor?.digest === hash && cursor.projectionRevision === 2) return empty(request.cursor)
  const sourceObjectId = `claude-snapshot-${sessionId}-${hash}`
  const events: AdapterEvent[] = []
  const calls = new Map<string, { name: string; uuid: string }>()
  let partial = false
  for (const [order, record] of records.entries()) {
    if (!record.uuid || record.isMeta === true) continue
    const message = object(record.message)
    if (record.type !== "user" && record.type !== "assistant") continue
    if (!message || message.role !== record.type) { partial = true; continue }
    const occurredAt = timestamp(record.timestamp)
    if (!occurredAt) fail("format", "Claude message has no valid timestamp.")
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
    if (!Array.isArray(content)) { partial = true; continue }
    for (const [slot, value] of content.entries()) {
      const block = object(value)
      let update: AcpSessionUpdate | undefined
      let fidelity: AdapterEvent["fidelity"] = "native"
      if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        // Source command envelopes need a provider mapping, not fake user prose.
        if (record.type === "user" && /^<(?:command-name|local-command|bash-input)/.test(block.text.trimStart())) { partial = true; continue }
        update = { sessionUpdate: record.type === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: block.text } }
      } else if (block?.type === "tool_use" && record.type === "assistant" && typeof block.id === "string" && typeof block.name === "string") {
        if (calls.has(block.id)) fail("unsupported", "Claude tool IDs are ambiguous in this session.")
        calls.set(block.id, { name: block.name, uuid: record.uuid as string })
        update = { sessionUpdate: "tool_call", toolCallId: block.id, title: block.name, status: "pending", kind: toolKind(block.name),
          ...(isBoundedToolValue(block.input) ? { rawInput: block.input } : {}) }
        partial = true; fidelity = "partial"
      } else if (block?.type === "tool_result" && record.type === "user" && typeof block.tool_use_id === "string") {
        const call = calls.get(block.tool_use_id)
        if (!call || record.sourceToolAssistantUUID !== undefined && record.sourceToolAssistantUUID !== call.uuid) fail("unsupported", "Claude tool result has no unambiguous call.")
        update = { sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, title: call.name, status: block.is_error === true ? "failed" : "completed", kind: toolKind(call.name),
          ...(isBoundedToolValue(block.content) ? { rawOutput: block.content } : {}) }
        partial = true; fidelity = "partial"
      } else if (block?.type === "thinking" && block.thinking === "") {
        continue
      } else { partial = true; continue }
      if (!update) continue
      events.push({
        sourceEventId: `${record.uuid}:${slot}`, sourceThreadId: "root",
        revision: source.length, projectionRevision: 2, sourceOrder: order, eventIndex: slot,
        orderFidelity: "native", fidelity, occurredAt,
        rawRef: { _tag: "object", sourceObjectId, fragment: `record=${record.uuid}&block=${slot}` }, update
      })
    }
  }
  if (events.length === 0) fail("unsupported", "Claude snapshot has no supported conversation events.")
  const updatedAt = events.at(-1)!.occurredAt
  const firstUser = events.find(e => e.update.sessionUpdate === "user_message_chunk")
  const title = firstUser && "content" in firstUser.update && firstUser.update.content.type === "text"
    ? firstUser.update.content.text.replace(/\s+/g, " ").trim().slice(0, 80) : "Untitled Claude conversation"
  const progress = request.rawProgress.find(p => p.sourceSessionId === sessionId && p.sourceObjectId === sourceObjectId)
  if (progress && (progress.sourceGeneration !== hash || progress.sourceOffset !== source.length || !progress.finalized)) fail("changed", "Claude Raw snapshot progress is inconsistent.")
  const observation: AdapterObservation = {
    observationId: `claude-${hash}`, observedAt: updatedAt,
    session: {
      sourceSessionId: sessionId, revision: source.length, title, summary: "Claude Code conversation", insight: "",
      actor: { name: "User", harness: "Claude Code" }, branch: string(root.gitBranch) ?? "",
      status: "active", captureStatus: partial ? "partial" : "healthy", updatedAt, reportedEventCount: events.length
    },
    threads: [{ sourceThreadId: "root", revision: source.length, label: "Main", summary: "", captureStatus: partial ? "partial" : "healthy" }],
    events,
    rawSegments: progress ? [] : [{ sourceObjectId, sourceGeneration: hash, sourceOffset: 0,
      sourceName: `${sessionId}.jsonl`, mediaType: "application/x-ndjson", content: text, final: true }]
  }
  const limits = request.limits
  if (limits.observations < 1 || limits.threadsPerObservation < 1 || events.length > limits.eventsPerObservation ||
    Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] })) > limits.canonicalBytesPerObservation ||
    !progress && (limits.rawSegmentsPerObservation < 1 || source.length > Math.min(limits.rawSegmentBytes, limits.rawBytesPerObservation))) {
    fail("limit", "Claude snapshot exceeds the current single-observation Host limits.")
  }
  return {
    protocolVersion: request.protocolVersion, hasMore: false, observations: [observation],
    nextCursor: JSON.stringify({ v: 1, sessionId, bytes: source.length, digest: hash, origin, projectionRevision: 2 } satisfies Cursor)
  }
}

const empty = (cursor: string | null): AdapterCollectionPage => ({ protocolVersion: "atape.adapter.v1alpha1", nextCursor: cursor, hasMore: false, observations: [] })
function decodeDiscoveryCursor(value: string | null): DiscoveryCursor {
  if (value === null) return { v: 2, after: "", sessions: [] }
  try {
    if (Buffer.byteLength(value) > MaxCursorBytes) throw new Error()
    const parsed: unknown = JSON.parse(value)
    if (object(parsed)?.v === 1) {
      const checkpoint = decodeCursor(value)!
      return { v: 2, after: checkpoint.sessionId, sessions: [{ file: "", checkpoint }] }
    }
    const state = Schema.decodeUnknownSync(DiscoveryCursorSchema)(parsed)
    const ids = new Set<string>(), files = new Set<string>()
    for (const session of state.sessions) {
      decodeCursor(JSON.stringify(session.checkpoint))
      if (ids.has(session.checkpoint.sessionId) || files.has(session.file) || session.file !== "" && !isAbsolute(session.file)) throw new Error()
      ids.add(session.checkpoint.sessionId); files.add(session.file)
    }
    if (state.sessions.length === 0 || !ids.has(state.after)) throw new Error()
    return state
  } catch { return fail("cursor", "Claude checkpoint is invalid; it was not reset.") }
}
function decodeCursor(value: string | null): Cursor | undefined {
  if (value === null) return undefined
  try {
    if (Buffer.byteLength(value) > MaxCursorBytes) throw new Error()
    const c = Schema.decodeUnknownSync(CursorSchema)(JSON.parse(value))
    if (!c.sessionId || !isAbsolute(c.origin) || !Number.isSafeInteger(c.bytes) || c.bytes < 1 || c.bytes > MaxSnapshotBytes || !/^[a-f0-9]{64}$/.test(c.digest)) throw new Error()
    return c
  } catch { return fail("cursor", "Claude checkpoint is invalid; it was not reset.") }
}

async function discover(archive: Archive, state: DiscoveryCursor, signal: AbortSignal, diagnostics: SourceDiagnostics): Promise<Candidate[]> {
  let projects: string
  try { projects = await realpath(archive.projects) }
  catch (cause) { if (object(cause)?.code === "ENOENT") return []; throw cause }
  const folders = await readdir(projects, { withFileTypes: true })
  let entries = folders.length
  if (entries > MaxDiscoveryEntries) fail("limit", "Claude discovery exceeds 10,000 directory entries.")
  const candidates: Candidate[] = []
  const ids = new Map<string, number>()
  for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
    signal.throwIfAborted()
    if (!folder.isDirectory()) continue // No recursive subagent or symlink traversal.
    const directory = join(projects, folder.name)
    const files = await (async () => {
      try {
        if (await realpath(directory) !== directory) fail("changed", "Claude discovery directory changed during scanning.")
        return await readdir(directory, { withFileTypes: true })
      } catch (cause) { diagnostics.capture(directory, cause, signal); return [] }
    })()
    entries += files.length
    if (entries > MaxDiscoveryEntries) fail("limit", "Claude discovery exceeds 10,000 directory entries.")
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      signal.throwIfAborted()
      if (!entry.name.endsWith(".jsonl")) continue
      const file = join(directory, entry.name)
      const known = state.sessions.find(s => s.file === file)
      if (!entry.isFile()) {
        if (known) diagnostics.add(file, "changed")
        continue
      }
      try {
        let sessionId = known?.checkpoint.sessionId
        if (!sessionId) {
          // Unattributable headers produce local diagnostics, never uploads.
          const header = await readHeader(file, signal)
          if (!header || typeof header.sessionId !== "string" || !header.sessionId || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) {
            diagnostics.add(file, "format"); continue
          }
          if (!await belongsToProject(archive, header.cwd, signal)) continue
          sessionId = header.sessionId
        }
        ids.set(sessionId, (ids.get(sessionId) ?? 0) + 1)
        candidates.push({ file, sessionId })
      } catch (cause) {
        diagnostics.capture(file, cause, signal)
      }
    }
  }
  return candidates.filter(candidate => {
    if (ids.get(candidate.sessionId) === 1) return true
    diagnostics.add(candidate.file, "duplicate")
    return false // Neither copy may win by filename or discovery order.
  })
}

async function readHeader(file: string, signal: AbortSignal): Promise<RecordValue | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) fail("format", "Claude source is not a regular file.")
    const bytes = Buffer.alloc(MaxHeaderBytes)
    let at = 0, start = 0
    while (at < bytes.length) {
      signal.throwIfAborted()
      const read = await handle.read(bytes, at, Math.min(16384, bytes.length - at), at)
      if (!read.bytesRead) break
      at += read.bytesRead
      let end: number
      while ((end = bytes.subarray(0, at).indexOf(10, start)) !== -1) {
        const line = bytes.subarray(start, end); start = end + 1
        if (line.toString("utf8").trim().length === 0) continue
        let record: RecordValue
        try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))) }
        catch { return undefined }
        if (typeof record.uuid === "string") return record
      }
    }
    return undefined
  } finally { await handle.close() }
}

async function snapshot(file: string, signal: AbortSignal): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > MaxSnapshotBytes) fail("limit", "Claude source must be a regular file no larger than 4 MiB.")
    const bytes = Buffer.alloc(before.size)
    let at = 0
    while (at < bytes.length) {
      signal.throwIfAborted()
      const read = await handle.read(bytes, at, Math.min(65536, bytes.length - at), at)
      if (!read.bytesRead) fail("changed", "Claude source changed during reading.")
      at += read.bytesRead
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("changed", "Claude source changed during reading.")
    return bytes
  } finally { await handle.close() }
}
async function belongsToProject(archive: Archive, origin: string, signal: AbortSignal): Promise<boolean> {
  if (!isAbsolute(origin)) fail("format", "Claude original CWD must be absolute.")
  if (archive.context.project.type === "git") {
    const common = (cwd: string) => new Promise<string>((resolve, reject) => execFile("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { signal, timeout: 5000 }, (error, out) => error ? reject(error) : resolve(out.trim())))
    try { return await realpath(await common(origin)) === await realpath(await common(archive.project)) }
    catch { signal.throwIfAborted(); return false }
  }
  let resolved: string
  try { resolved = await realpath(origin) }
  catch (cause) { if (object(cause)?.code === "ENOENT") return false; throw cause }
  const child = relative(archive.project, resolved)
  return child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)
}
const toolKind = (name: string): "read" | "edit" | "execute" | "search" | "other" =>
  name === "Read" ? "read" : ["Write", "Edit", "MultiEdit"].includes(name) ? "edit" : name === "Bash" ? "execute" : ["Grep", "Glob"].includes(name) ? "search" : "other"
