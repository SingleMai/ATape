import type { AcpSessionUpdate, AdapterCollectRequest, AdapterCollectionPage, AdapterEvent, AdapterObservation, AdapterOpenContext, AdapterUsage } from "@atape/domain"
import { Effect, Schema } from "effect"
import { GitAttributionVersion, isBoundedToolValue, MaxSourceFailures, type AdapterSourceFailure } from "@atape/domain"
import { createHash, type Hash } from "node:crypto"
import { constants } from "node:fs"
import { open, readdir, realpath, stat } from "node:fs/promises"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import { homedir } from "node:os"
import { claudeHome } from "@atape/adapter-catalog/node"
import { isAbsolute, join, relative, sep } from "node:path"

const MaxRecordBytes = 16 * 1024 * 1024
const MaxDiscoveryEntries = 10_000
const MaxHeaderBytes = 64 * 1024 * 1024
const MaxCursorBytes = 1024 * 1024
const MaxDecodedCursorBytes = 16 * 1024 * 1024
const RecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeRecord = Schema.decodeUnknownSync(RecordSchema)
const CursorSchema = Schema.Struct({
  v: Schema.Literal(1), sessionId: Schema.String, bytes: Schema.Number,
  digest: Schema.String, origin: Schema.String,
  projectionRevision: Schema.optionalKey(Schema.Number),
  usageVersion: Schema.optionalKey(Schema.Literal(1)),
  observedAt: Schema.optionalKey(Schema.String),
  publication: Schema.optionalKey(Schema.Number),
  stream: Schema.optionalKey(Schema.Struct({
    lastUuid: Schema.NullOr(Schema.String), seen: Schema.Array(Schema.String),
    calls: Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
    order: Schema.Number, eventSkip: Schema.Number, title: Schema.String
  }))
})
type Cursor = typeof CursorSchema.Type
const DiscoveryCursorSchema = Schema.Struct({
  v: Schema.Literal(2), after: Schema.String,
  sessions: Schema.Array(Schema.Struct({ file: Schema.String, checkpoint: CursorSchema }))
})
type DiscoveryCursor = typeof DiscoveryCursorSchema.Type
type RecordValue = Record<string, unknown>
type Archive = { readonly context: AdapterOpenContext; readonly file: string | undefined; readonly projects: string; readonly project: string; inventory?: Candidate[]; hashCache?: { file: string; stamp: string; bytes: number; digest: string; hash: Hash } }
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
    if (cause instanceof ClaudeArchiveError && ["io", "format", "unsupported", "changed", "limit", "attribution"].includes(cause.reason)) {
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
  reason: Schema.Literals(["configuration", "io", "format", "unsupported", "changed", "cursor", "limit", "attribution"]),
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
    const home = claudeHome(process.env, homedir())
    if (file && !isAbsolute(file) || !isAbsolute(home)) fail("configuration", "Claude source overrides must be absolute paths.")
    if (context.project.type === "git" && context.gitAttribution?.version !== GitAttributionVersion) {
      fail("configuration", "Upgrade the ATape CLI to collect Git Projects with shared attribution.")
    }
    return { context, file, projects: join(home, "projects"),
      project: context.project.type === "git" ? context.project.path : await realpath(context.project.path) }
  },
  catch: cause => cause instanceof ClaudeArchiveError ? cause : new ClaudeArchiveError({ reason: "configuration", message: "Could not open the selected Claude Project." })
})

export const collectClaudePage = (archive: Archive, request: AdapterCollectRequest): Effect.Effect<AdapterCollectionPage, ClaudeArchiveError> => Effect.tryPromise({
  try: async () => {
    const page = await collect(archive, request)
    const state = decodeDiscoveryCursor(page.nextCursor)
    const inventory = archive.inventory ?? []
    const acknowledged = new Map(request.rawProgress.filter(item => item.sourceObjectId.startsWith("claude-rollout-")).map(item => [item.sourceSessionId, item.sourceOffset]))
    for (const observation of page.observations) for (const raw of observation.rawSegments)
      acknowledged.set(observation.session.sourceSessionId, raw.sourceOffset + Buffer.byteLength(raw.content))
    let pendingRawBytes = 0, pendingCanonicalSessions = 0
    for (let start = 0; start < inventory.length; start += 8) {
      const sizes = await Promise.all(inventory.slice(start, start + 8).map(async candidate => {
        try { return { candidate, size: (await stat(candidate.file)).size } }
        catch { return { candidate, size: undefined } }
      }))
      for (const { candidate, size } of sizes) {
        if (size === undefined) continue
        if (request.rawCaptureEnabled !== false) pendingRawBytes += Math.max(0, size - (acknowledged.get(candidate.sessionId) ?? 0))
        const checkpoint = state.sessions.find(item => item.checkpoint.sessionId === candidate.sessionId)?.checkpoint
        if (!checkpoint?.stream || checkpoint.usageVersion !== 1 || checkpoint.bytes < size || checkpoint.stream.eventSkip > 0) pendingCanonicalSessions++
      }
    }
    return { ...page, progress: { sourceFiles: inventory.length, pendingRawBytes, pendingCanonicalSessions,
      phase: !page.hasMore ? "idle" as const : page.observations.some(o => o.events.length) ? "canonical" as const : "raw" as const } }
  },
  catch: cause => cause instanceof ClaudeArchiveError ? cause : new ClaudeArchiveError({ reason: "io", message: "Could not read the selected Claude session." })
})

async function collect(archive: Archive, request: AdapterCollectRequest): Promise<AdapterCollectionPage> {
  request.signal.throwIfAborted()
  const state = decodeDiscoveryCursor(request.cursor)
  const diagnostics = new SourceDiagnostics()
  // The supported cursor schema owns recovery compatibility, not the package
  // version. Unknown schemas and changed captured prefixes still fail closed.
  const selected = archive.file ? await readHeader(archive.file, request.signal) : undefined
  const candidates = archive.file
    ? [{ file: archive.file, sessionId: string(selected?.sessionId) ?? "" }]
    : await discover(archive, state, request.signal, diagnostics)
  archive.inventory = candidates
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
      if (archive.file && !(cause instanceof ClaudeArchiveError && cause.reason === "attribution")) throw cause // Other explicit-source errors stay fail-fast.
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
    const nextCursor = encodeDiscoveryCursor({ v: 2, after: checkpoint.sessionId, sessions } satisfies DiscoveryCursor)
    if (Buffer.byteLength(nextCursor) > MaxCursorBytes) fail("limit", "Claude discovery checkpoint exceeds its bounded metadata capacity; no session progress was discarded.")
    return diagnostics.attach({ ...page, nextCursor, hasMore: page.hasMore || !archive.file && candidates.length > 1 })
  }
  return diagnostics.attach(empty(request.cursor))
}

async function collectSession(archive: Archive, file: string, request: AdapterCollectRequest): Promise<AdapterCollectionPage> {
  const cursor = decodeCursor(request.cursor)
  const root = await readHeader(file, request.signal)
  if (!root || root.type !== "user" || root.parentUuid !== null || root.isMeta === true || typeof root.cwd !== "string" || typeof root.sessionId !== "string") {
    if (cursor) fail("changed", "The captured Claude prefix changed or was truncated.")
    fail("unsupported", "Claude session has no supported original user root and CWD.")
  }
  const sessionId = root.sessionId as string, origin = root.cwd as string
  if (cursor && (cursor.sessionId !== sessionId || cursor.origin !== origin)) fail("changed", "Claude session identity or original CWD changed.")
  if (!await belongsToProject(archive, root, request.signal)) return empty(request.cursor)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) fail("format", "Claude source is not a regular file.")
    if (cursor && before.size < cursor.bytes) fail("changed", "The captured Claude prefix changed or was truncated.")
    const stamp = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`
    let hash = createHash("sha256")
    if (cursor) {
      const cached = archive.hashCache
      if (cached?.file === file && cached.stamp === stamp && cached.bytes === cursor.bytes && cached.digest === cursor.digest) hash = cached.hash.copy()
      else {
        const block = Buffer.alloc(256 * 1024)
        for (let at = 0; at < cursor.bytes;) {
          request.signal.throwIfAborted()
          const read = await handle.read(block, 0, Math.min(block.length, cursor.bytes - at), at)
          if (!read.bytesRead) fail("changed", "The captured Claude prefix changed or was truncated.")
          hash.update(block.subarray(0, read.bytesRead)); at += read.bytesRead
        }
        if (hash.copy().digest("hex") !== cursor.digest) fail("changed", "The captured Claude prefix changed or was truncated.")
      }
    }
    const resume = cursor?.projectionRevision === 3 && cursor.usageVersion === 1 && cursor.observedAt ? cursor.stream : undefined
    let at = resume ? cursor!.bytes : 0
    if (!resume) hash = createHash("sha256")
    let state: NonNullable<Cursor["stream"]> = resume ?? { lastUuid: null, seen: [], calls: [], order: 0, eventSkip: 0, title: rootTitle(root) }
    const seen = new Set(state.seen)
    let calls = new Map(state.calls.map(([id, name, uuid]) => [id, { name, uuid }]))
    const sourceObjectId = `claude-rollout-${digest(Buffer.from(JSON.stringify([sessionId, origin, root.uuid])))}`
    const generation = digest(Buffer.from(JSON.stringify([sessionId, origin, root.uuid])))
    const events: AdapterEvent[] = []
    const usage = new Map<string, AdapterUsage>()
    const rawProgress = request.rawProgress.find(p => p.sourceSessionId === sessionId && p.sourceObjectId === sourceObjectId && p.sourceGeneration === generation)
    const acknowledged = rawProgress?.sourceOffset ?? 0
    let rawBytes = 0, eventBytes = 0, partial = false, hasMore = false
    for await (const line of readRecords(handle, at, before.size, request.signal)) {
      if (line.content.length + rawBytes > Math.min(request.limits.rawSegmentBytes, request.limits.rawBytesPerObservation)) {
        if (rawBytes === 0 && events.length === 0) fail("limit", "A Claude JSONL record exceeds the requested Raw page limit.")
        hasMore = true; break
      }
      if (line.content.toString("utf8").trim() === "") {
        hash.update(line.content); rawBytes += line.content.length; at = line.end
        continue
      }
      let record: RecordValue
      try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.content))) }
      catch { fail("format", "Claude source contains a malformed complete JSONL record.") }
      if (record.sessionId !== undefined && record.sessionId !== sessionId) fail("unsupported", "Mixed Claude session identities are not supported.")
      if (record.isSidechain === true || record.type === "system" && (record.subtype === "compact_boundary" || record.compactMetadata !== undefined)) fail("unsupported", "Claude subagent or compaction history requires a later Adapter capability.")
      if (typeof record.uuid === "string" && (seen.has(record.uuid) || record.parentUuid !== state.lastUuid)) fail("unsupported", "Claude history is not a single unambiguous append-only chain.")
      const nextCalls = new Map(calls)
      const projected = projectRecord(record, state.order, line.end, sourceObjectId, nextCalls)
      partial ||= projected.partial
      let skip = state.eventSkip
      if (skip > projected.events.length) fail("cursor", "Claude record checkpoint exceeds its event count.")
      while (skip < projected.events.length) {
        const event = projected.events[skip]!
        const size = Buffer.byteLength(JSON.stringify(event))
        // Reserve bounded Session/Thread metadata headroom in each observation.
        if (size > request.limits.canonicalBytesPerObservation - 8192) fail("limit", "A Claude event exceeds the Canonical observation limit.")
        if (events.length === request.limits.eventsPerObservation || eventBytes + size > request.limits.canonicalBytesPerObservation - 8192) break
        events.push(event); eventBytes += size; skip++
      }
      if (skip < projected.events.length) { state = { ...state, eventSkip: skip }; hasMore = true; break }
      const sample = projectUsage(record, line.end)
      if (sample) {
        const bytes = Buffer.byteLength(JSON.stringify(sample))
        if (usage.size >= request.limits.eventsPerObservation || eventBytes + bytes > request.limits.canonicalBytesPerObservation - 8192) {
          state = { ...state, eventSkip: skip }; hasMore = true; break
        }
        usage.set(sample.sourceUsageId, sample); eventBytes += bytes
      }
      if (!state.title) {
        const first = projected.events.find(e => e.update.sessionUpdate === "user_message_chunk")
        if (first && "content" in first.update && first.update.content.type === "text") state = { ...state, title: first.update.content.text.replace(/\s+/g, " ").trim().slice(0, 80) }
      }
      if (typeof record.uuid === "string") seen.add(record.uuid)
      calls = nextCalls
      state = { ...state, lastUuid: typeof record.uuid === "string" ? record.uuid : state.lastUuid, order: state.order + 1, eventSkip: 0 }
      hash.update(line.content); rawBytes += line.content.length; at = line.end
      if (events.length === request.limits.eventsPerObservation) { hasMore = at < before.size; break }
    }
    if (events.length === 0 && rawBytes === 0 && (request.rawCaptureEnabled === false || acknowledged >= at)) return empty(request.cursor)
    const capturedRaw = request.rawCaptureEnabled === false || acknowledged >= at ? undefined
      : await readRawPrefix(handle, acknowledged, at, Math.min(request.limits.rawSegmentBytes, request.limits.rawBytesPerObservation), request.signal)
    hasMore ||= capturedRaw !== undefined && acknowledged + Buffer.byteLength(capturedRaw) < at
    const after = await handle.stat()
    if (after.size < before.size || after.ino !== before.ino || after.size === before.size && after.mtimeMs !== before.mtimeMs) fail("changed", "Claude source changed during reading.")
    const prefixDigest = hash.copy().digest("hex")
    archive.hashCache = { file, stamp, bytes: at, digest: prefixDigest, hash: hash.copy() }
    const observedAt = events.at(-1)?.occurredAt ?? cursor?.observedAt ?? timestamp(root.timestamp) ?? new Date(before.mtimeMs).toISOString()
    const next: Cursor = { v: 1, sessionId, origin, bytes: at, digest: prefixDigest, projectionRevision: 3, usageVersion: 1, observedAt,
      publication: (cursor?.publication ?? 0) + 1,
      stream: { ...state, seen: [...seen], calls: [...calls].map(([id, call]) => [id, call.name, call.uuid]) } }
    const revision = Math.max(at, events.at(-1)?.revision ?? 1) * 2 + 3
    return { protocolVersion: request.protocolVersion, nextCursor: JSON.stringify(next), hasMore,
      observations: [{ observationId: `claude-${digest(Buffer.from(JSON.stringify([next, events.map(e => e.sourceEventId)])))}`, observedAt,
        session: { sourceSessionId: sessionId, revision, title: state.title || "Untitled Claude conversation", summary: "Claude Code conversation", insight: "",
          actor: { name: "User", harness: "Claude Code" }, branch: string(root.gitBranch) ?? "", status: "active", captureStatus: "partial", updatedAt: observedAt, reportedEventCount: 0 },
        threads: [{ sourceThreadId: "root", revision: 1, label: "Main", summary: "", captureStatus: "partial" }], events,
        usage: [...usage.values()],
        rawSegments: capturedRaw !== undefined ? [{ sourceObjectId, sourceGeneration: generation, sourceOffset: acknowledged,
          sourceName: `${sessionId}.jsonl`, mediaType: "application/x-ndjson", content: capturedRaw, final: false }] : []
      }] }
  } finally { await handle.close() }
}

function projectUsage(record: RecordValue, revision: number): AdapterUsage | undefined {
  if (record.type !== "assistant") return undefined
  const message = object(record.message), source = object(message?.usage)
  const sourceUsageId = string(message?.id), occurredAt = timestamp(record.timestamp)
  if (!source || !sourceUsageId || sourceUsageId.length > 500 || !occurredAt) return undefined
  const count = (key: string): number | undefined => {
    const value = source[key]
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  const input = count("input_tokens"), outputTokens = count("output_tokens")
  const cacheReadTokens = count("cache_read_input_tokens"), cacheWriteTokens = count("cache_creation_input_tokens")
  // Claude input_tokens excludes cache hits and writes. Unknown cache counters
  // must not be silently replaced with zero when constructing inclusive input.
  const inputTokens = input !== undefined && cacheReadTokens !== undefined && cacheWriteTokens !== undefined
    ? input + cacheReadTokens + cacheWriteTokens : undefined
  if ((inputTokens === undefined || !Number.isSafeInteger(inputTokens)) && outputTokens === undefined) return undefined
  return { sourceUsageId, sourceThreadId: "root", revision, occurredAt, model: (string(message?.model) ?? "").slice(0, 200),
    ...(inputTokens === undefined || !Number.isSafeInteger(inputTokens) ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) }
}

async function readRawPrefix(handle: Awaited<ReturnType<typeof open>>, start: number, end: number, limit: number, signal: AbortSignal): Promise<string> {
  const bytes = Buffer.alloc(Math.min(end - start, limit))
  let count = 0
  while (count < bytes.length) {
    signal.throwIfAborted()
    const read = await handle.read(bytes, count, bytes.length - count, start + count)
    if (!read.bytesRead) fail("changed", "Claude Raw source was truncated during reading.")
    count += read.bytesRead
  }
  // A transport boundary can bisect a UTF-8 code point. Leave its bytes for
  // the next Raw page without changing the independent Canonical checkpoint.
  for (let trim = 0; trim <= 3 && count - trim > 0; trim++) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count - trim)) }
    catch { /* try the preceding complete code point */ }
  }
  return fail("format", "Claude Raw source contains invalid UTF-8.")
}

async function* readRecords(handle: Awaited<ReturnType<typeof open>>, start: number, end: number, signal: AbortSignal) {
  let at = start, pending = Buffer.alloc(0), lineStart = start
  while (at < end) {
    signal.throwIfAborted()
    const block = Buffer.alloc(Math.min(64 * 1024, end - at))
    const read = await handle.read(block, 0, block.length, at)
    if (!read.bytesRead) fail("changed", "Claude source changed during reading.")
    at += read.bytesRead
    pending = Buffer.concat([pending, block.subarray(0, read.bytesRead)])
    let newline: number
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline + 1 > MaxRecordBytes) fail("limit", "Claude JSONL record exceeds 16 MiB.")
      const content = pending.subarray(0, newline + 1)
      yield { content, end: lineStart + newline + 1 }
      pending = pending.subarray(newline + 1); lineStart += newline + 1
    }
    if (pending.length > MaxRecordBytes) fail("limit", "Claude JSONL record exceeds 16 MiB.")
  }
}

function rootTitle(root: RecordValue): string {
  const content = object(root.message)?.content
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.map(block => object(block)?.type === "text" ? string(object(block)?.text) ?? "" : "").join(" ") : ""
  return text.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled Claude conversation"
}

function projectRecord(record: RecordValue, order: number, revision: number, sourceObjectId: string,
  calls: Map<string, { name: string; uuid: string }>): { events: AdapterEvent[]; partial: boolean } {
  const events: AdapterEvent[] = []
  let partial = false
  if (!record.uuid || record.isMeta === true || record.type !== "user" && record.type !== "assistant") return { events, partial }
  const message = object(record.message)
  if (!message || message.role !== record.type) return { events, partial: true }
  const occurredAt = timestamp(record.timestamp)
  if (!occurredAt) fail("format", "Claude message has no valid timestamp.")
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
  if (!Array.isArray(content)) return { events, partial: true }
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
      const message = update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk" ? update : undefined
      const chunks = message?.content.type === "text" ? splitText(message.content.text) : [undefined]
      for (const [part, text] of chunks.entries()) events.push({
        sourceEventId: `${record.uuid}:${slot}${chunks.length > 1 ? `:${part}` : ""}`, sourceThreadId: "root",
        revision, projectionRevision: 3, sourceOrder: order, eventIndex: slot * 128 + part,
        orderFidelity: "native", fidelity, occurredAt,
        rawRef: { _tag: "object", sourceObjectId, fragment: `record=${record.uuid}&block=${slot}` },
        update: message && text !== undefined ? { ...message, messageId: `${record.uuid}:${slot}`, content: { type: "text", text } } : update
      })
    }
  return { events, partial }
}

function splitText(text: string): string[] {
  const bytes = Buffer.from(text), chunks: string[] = []
  for (let at = 0; at < bytes.length;) {
    let end = Math.min(at + 256 * 1024, bytes.length)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    chunks.push(bytes.subarray(at, end).toString("utf8")); at = end
  }
  return chunks
}

function encodeDiscoveryCursor(state: DiscoveryCursor): string {
  const json = JSON.stringify(state)
  if (Buffer.byteLength(json) > MaxDecodedCursorBytes) fail("limit", "Claude checkpoint exceeds its bounded decoded metadata capacity.")
  return Buffer.byteLength(json) <= 16000 ? json : "z3:" + deflateRawSync(Buffer.from(json)).toString("base64url")
}

const empty = (cursor: string | null): AdapterCollectionPage => ({ protocolVersion: "atape.adapter.v1alpha1", nextCursor: cursor, hasMore: false, observations: [] })
function decodeDiscoveryCursor(value: string | null): DiscoveryCursor {
  if (value === null) return { v: 2, after: "", sessions: [] }
  try {
    if (Buffer.byteLength(value) > MaxCursorBytes) throw new Error()
    const parsed: unknown = JSON.parse(value.startsWith("z3:") ? inflateRawSync(Buffer.from(value.slice(3), "base64url"), { maxOutputLength: MaxDecodedCursorBytes }).toString("utf8") : value)
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
    if (Buffer.byteLength(value) > MaxDecodedCursorBytes) throw new Error()
    const c = Schema.decodeUnknownSync(CursorSchema)(JSON.parse(value))
    if (!c.sessionId || !isAbsolute(c.origin) || !Number.isSafeInteger(c.bytes) || c.bytes < 0 || !/^[a-f0-9]{64}$/.test(c.digest)) throw new Error()
    if (c.projectionRevision !== undefined && ![2, 3].includes(c.projectionRevision)) throw new Error()
    if (c.stream && (!Number.isSafeInteger(c.stream.order) || c.stream.order < c.stream.seen.length ||
      !Number.isSafeInteger(c.stream.eventSkip) || c.stream.eventSkip < 0 ||
      new Set(c.stream.seen).size !== c.stream.seen.length ||
      c.stream.lastUuid !== null && !c.stream.seen.includes(c.stream.lastUuid) ||
      c.stream.title.length > 500 || c.stream.calls.some(call => call.some(value => value.length > 4096)))) throw new Error()
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
          if (!await belongsToProject(archive, header, signal)) continue
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
    const details = await handle.stat()
    if (!details.isFile()) fail("format", "Claude source is not a regular file.")
    let records = 0
    for await (const line of readRecords(handle, 0, Math.min(details.size, MaxHeaderBytes), signal)) {
      if (++records > 256) return undefined
      if (line.content.toString("utf8").trim().length === 0) continue
      let record: RecordValue
      try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.content))) }
      catch { return undefined }
      if (typeof record.uuid === "string") return record
    }
    return undefined
  } finally { await handle.close() }
}
async function belongsToProject(archive: Archive, root: RecordValue, signal: AbortSignal): Promise<boolean> {
  const origin = string(root.cwd)
  if (!origin || !isAbsolute(origin)) fail("format", "Claude original CWD must be absolute.")
  if (archive.context.project.type === "git") {
    if (root.type !== "user" || root.parentUuid !== null || root.isMeta === true || typeof root.uuid !== "string" || typeof root.sessionId !== "string") {
      fail("attribution", "Claude source has no trustworthy original user root.")
    }
    const decision = await archive.context.gitAttribution!.resolve({
      sourceId: root.sessionId, originKey: root.uuid, cwd: origin
    }, signal)
    if (decision === "unknown") fail("attribution", "The original Git repository could not be established for this Claude source.")
    return decision === "included"
  }
  let resolved: string
  try { resolved = await realpath(origin) }
  catch (cause) { if (object(cause)?.code === "ENOENT") return false; throw cause }
  const child = relative(archive.project, resolved)
  return child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)
}
const toolKind = (name: string): "read" | "edit" | "execute" | "search" | "other" =>
  name === "Read" ? "read" : ["Write", "Edit", "MultiEdit"].includes(name) ? "edit" : name === "Bash" ? "execute" : ["Grep", "Glob"].includes(name) ? "search" : "other"
