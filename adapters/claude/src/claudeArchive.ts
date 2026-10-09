import type { AcpSessionUpdate, AdapterEvent, AdapterOpenContext, AdapterUsage,
  SourceCaptureFrame, SourceCaptureLimits, SourceDiscoveryPage, SourceOpenRequestV2, SourceCaptureViewV2, SourceLegacyMigrationRequest } from "@atape/domain"
import { Effect, Schema } from "effect"
import { GitAttributionVersion, isBoundedToolValue, MaxSourceFailures, type AdapterSourceFailure } from "@atape/domain"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { inflateRawSync } from "node:zlib"
import { homedir } from "node:os"
import { claudeHome } from "@atape/adapter-catalog/node"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

const MaxRecordBytes = 16 * 1024 * 1024
const MaxDiscoveryEntries = 10_000
const MaxHeaderBytes = 64 * 1024 * 1024
const MaxCursorBytes = 1024 * 1024
const MaxDecodedCursorBytes = 16 * 1024 * 1024
const ProjectionRevision = 5
const RecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeRecord = Schema.decodeUnknownSync(RecordSchema)
const CompactionSchema = Schema.Struct({
  v: Schema.Literal(1), boundaryUuid: Schema.String, summaryUuid: Schema.String,
  phase: Schema.Literals(["summary", "caveat", "command", "stdout", "resume"]),
  promptId: Schema.optionalKey(Schema.String)
})
const AutoTextSchema = Schema.Struct({
  v: Schema.Literal(1), boundaryUuid: Schema.String, summaryUuid: Schema.String,
  promptId: Schema.String, slug: Schema.String
})
const ReadPairSchema = Schema.Struct({
  v: Schema.Literal(1), firstResultUuid: Schema.String, secondCallUuid: Schema.String,
  secondToolId: Schema.String, secondFilePath: Schema.String, promptId: Schema.String
})
const ContinuationSchema = Schema.Struct({
  phase: Schema.Literals(["copies", "summary", "resume"]),
  boundaryUuid: Schema.optionalKey(Schema.String), summaryUuid: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(Schema.Literals(["manual", "auto"])),
  slug: Schema.optionalKey(Schema.String), promptId: Schema.optionalKey(Schema.String)
})
type Continuation = typeof ContinuationSchema.Type
const StreamCursorSchema = Schema.Struct({
  v: Schema.Literal(1), sessionId: Schema.String, bytes: Schema.Number,
  digest: Schema.String, origin: Schema.String,
  projectionRevision: Schema.optionalKey(Schema.Number),
  usageVersion: Schema.optionalKey(Schema.Literal(1)),
  normalizationVersion: Schema.optionalKey(Schema.Literal(1)),
  observedAt: Schema.optionalKey(Schema.String),
  publication: Schema.optionalKey(Schema.Number),
  stream: Schema.optionalKey(Schema.Struct({
    lastUuid: Schema.NullOr(Schema.String), seen: Schema.Array(Schema.String),
    calls: Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
    order: Schema.Number, eventSkip: Schema.Number, title: Schema.String,
    compaction: Schema.optionalKey(CompactionSchema), autoText: Schema.optionalKey(AutoTextSchema), readPair: Schema.optionalKey(ReadPairSchema),
    continuation: Schema.optionalKey(ContinuationSchema)
  }))
})
const ChildSchema = Schema.Struct({
  agentId: Schema.String, toolCallId: Schema.String, toolUuid: Schema.String,
  checkpoint: Schema.optionalKey(StreamCursorSchema)
})
type Child = typeof ChildSchema.Type
const CursorSchema = Schema.Struct({ ...StreamCursorSchema.fields,
  children: Schema.optionalKey(Schema.Array(ChildSchema)),
  childAfter: Schema.optionalKey(Schema.String),
  familyRevision: Schema.optionalKey(Schema.Number),
  familyObservedAt: Schema.optionalKey(Schema.String)
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
    if (this.failures.some(failure => failure.source === source && failure.reason === reason)) return
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
  snapshot() {
    return { sourceFailures: this.failures, sourceFailuresTruncated: this.truncated }
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

const childThreadId = (agentId: string) => `claude-agent:${agentId}`
const childFile = (file: string, sessionId: string, agentId: string) => {
  if (!/^[A-Za-z0-9_-]{1,500}$/.test(sessionId)) fail("unsupported", "Claude family identity is not a safe source path component.")
  return join(dirname(file), sessionId, "subagents", `agent-${agentId}.jsonl`)
}
async function validateChildDirectories(file: string): Promise<void> {
  for (const directory of [dirname(dirname(file)), dirname(file)]) {
    const details = await lstat(directory)
    if (!details.isDirectory() || details.isSymbolicLink()) fail("unsupported", "Claude subagent directories must not be symlinks.")
  }
}
const autoId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 500 && !value.includes("\0")
const readPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= 64 * 1024

/** Unknown JSON values are compared without consuming the JavaScript stack. */
function equalJson(a: unknown, b: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[a, b]]
  while (pending.length) {
    const [left, right] = pending.pop()!
    if (Object.is(left, right)) continue
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
      for (let index = 0; index < left.length; index++) pending.push([left[index], right[index]])
    } else {
      const x = left as RecordValue, y = right as RecordValue, keys = Object.keys(x)
      if (keys.length !== Object.keys(y).length) return false
      for (const key of keys) {
        if (!Object.hasOwn(y, key)) return false
        pending.push([x[key], y[key]])
      }
    }
  }
  return true
}

type RecordRef = { readonly start: number; readonly end: number; readonly digest: string }
type ControlKind = "ordinary" | "boundary" | "summary" | "file" | "meta" | "caveat" | "command" | "stdout" | "synthetic"
type IndexedRecord = { readonly first: RecordRef; value: RecordRef; readonly kind: ControlKind }
type SourceCall = { readonly uuid: string; readonly name: string; readonly path?: string; readonly backgroundRequested?: true }
const sourceCall = (uuid: string, block: RecordValue): SourceCall => ({ uuid, name: block.name as string,
  ...(typeof object(block.input)?.file_path === "string" ? { path: object(block.input)!.file_path as string } : {}),
  ...(object(block.input)?.run_in_background === true ? { backgroundRequested: true as const } : {}) })
type ToolResponse = { readonly id: string; readonly model: unknown; readonly pending: Map<string, SourceCall> }
type Normalization = {
  readonly records: Map<string, IndexedRecord>; readonly calls: Map<string, SourceCall>
  leaf: string | null; order: number; continuation: Continuation | undefined; response: ToolResponse | undefined
}
type NormalizedRecord = { readonly rawOnly: boolean; readonly copy?: true; readonly kind: ControlKind; readonly continuation: Continuation | undefined }
const recordRef = (start: number, content: Buffer): RecordRef => ({ start, end: start + content.length, digest: digest(content) })
function parseSourceRecord(content: Buffer): RecordValue {
  try { return decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content))) }
  catch { return fail("format", "Claude source contains a malformed complete JSONL record.") }
}

/** An offset is only a locator. Its bytes must still match the digest recorded
 * while the same committed-prefix bytes were being hashed. */
async function indexedRecord(handle: Awaited<ReturnType<typeof open>>, ref: RecordRef, signal: AbortSignal): Promise<RecordValue> {
  const bytes = Buffer.alloc(ref.end - ref.start)
  for (let at = 0; at < bytes.length;) {
    signal.throwIfAborted()
    const read = await handle.read(bytes, at, bytes.length - at, ref.start + at)
    if (!read.bytesRead) fail("changed", "The indexed Claude record was truncated.")
    at += read.bytesRead
  }
  if (digest(bytes) !== ref.digest) fail("changed", "The indexed Claude source changed during normalization.")
  return parseSourceRecord(bytes)
}
const sourceVersion = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const controlIdentity = (record: RecordValue, root: RecordValue) => sourceVersion(record.version) &&
  record.sessionId === root.sessionId && record.cwd === root.cwd && autoId(record.uuid) &&
  (root.isSidechain === true ? record.isSidechain === true && record.agentId === root.agentId
    : record.isSidechain === false && record.agentId === undefined)
const plainControl = (record: RecordValue) => record.sourceToolAssistantUUID === undefined && record.toolUseResult === undefined &&
  record.isAsync === undefined && record.status === undefined && record.isApiErrorMessage === undefined
function controlText(message: RecordValue | undefined): string | undefined {
  if (typeof message?.content === "string") return message.content
  const blocks = message?.content
  return Array.isArray(blocks) && blocks.length === 1 && object(blocks[0])?.type === "text" ? string(object(blocks[0])?.text) : undefined
}
function zeroSyntheticUsage(value: unknown): boolean {
  const usage = object(value)
  if (!usage || ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].some(key => usage[key] !== 0)) return false
  const pending: unknown[] = [usage]
  while (pending.length) {
    const next = pending.pop()
    if (typeof next === "number" && next !== 0) return false
    if (next !== null && typeof next === "object") for (const value of Object.values(next)) pending.push(value)
  }
  return true
}
function sourceBookkeeping(record: RecordValue, root: RecordValue): boolean {
  return ["queue-operation", "last-prompt", "mode", "atis-latch", "file-history-snapshot"].includes(string(record.type) ?? "") &&
    (record.sessionId === undefined || record.sessionId === root.sessionId) && record.message === undefined && record.uuid === undefined &&
    record.parentUuid == null && record.logicalParentUuid == null && record.agentId === undefined && record.attachment === undefined &&
    record.compactMetadata === undefined && record.subtype === undefined && record.isCompactSummary === undefined &&
    record.isVisibleInTranscriptOnly === undefined && record.isMeta === undefined && plainControl(record) &&
    (record.cwd === undefined || record.cwd === root.cwd) && (record.version === undefined || sourceVersion(record.version)) &&
    (record.isSidechain === undefined || record.isSidechain === root.isSidechain)
}
function sourceBoundary(record: RecordValue, root: RecordValue, context: Normalization): Continuation {
  const metadata = object(record.compactMetadata), segment = object(metadata?.preservedSegment), messages = object(metadata?.preservedMessages)
  const ids = messages?.uuids, all = messages?.allUuids, anchor = segment?.anchorUuid
  const knownIds = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 &&
    value.every(id => autoId(id) && context.records.has(id)) && new Set(value).size === value.length
  if (!controlIdentity(record, root) || !plainControl(record) || record.type !== "system" || record.subtype !== "compact_boundary" ||
    record.message !== undefined || record.attachment !== undefined || record.isMeta !== undefined && record.isMeta !== false ||
    record.isCompactSummary !== undefined || record.isVisibleInTranscriptOnly !== undefined || record.parentUuid !== null ||
    !context.leaf || record.logicalParentUuid !== context.leaf || !["manual", "auto"].includes(string(metadata?.trigger) ?? "") ||
    !knownIds(ids) || !knownIds(all) || ids.some(id => !all.includes(id)) || segment?.headUuid !== ids[0] ||
    segment?.tailUuid !== ids.at(-1) || !autoId(anchor) || messages?.anchorUuid !== anchor || anchor === record.uuid ||
    context.records.has(anchor)) fail("unsupported", "Claude compaction boundary has no valid current source identities.")
  return { phase: "summary", boundaryUuid: record.uuid as string, summaryUuid: anchor,
    trigger: metadata!.trigger as "manual" | "auto", ...(record.slug === undefined ? {} : { slug: checkedSlug(record.slug) }) }
}
function checkedSlug(value: unknown): string {
  if (!autoId(value)) fail("unsupported", "Claude source has an invalid compaction slug.")
  return value
}
function toolResults(record: RecordValue): RecordValue[] {
  const blocks = object(record.message)?.content
  return Array.isArray(blocks) ? blocks.flatMap(block => object(block)?.type === "tool_result" ? [object(block)!] : []) : []
}
function verifyOrdinaryParent(record: RecordValue, context: Normalization): void {
  const results = toolResults(record)
  if (results.length) {
    if (record.type !== "user" || !context.response || new Set(results.map(block => block.tool_use_id)).size !== results.length ||
      results.some(block => !context.response!.pending.has(string(block.tool_use_id) ?? "")))
      fail("unsupported", "Claude tool result does not belong to its current open response.")
    for (const block of results) {
      const call = context.response.pending.get(block.tool_use_id as string)!
      if (record.sourceToolAssistantUUID !== undefined && record.sourceToolAssistantUUID !== call.uuid ||
        record.parentUuid !== context.leaf && record.parentUuid !== call.uuid)
        fail("unsupported", "Claude tool result does not follow its current leaf or own call.")
      if (call.name === "Read" && call.path !== undefined && block.is_error !== true && record.toolUseResult !== undefined) {
        const receipt = object(record.toolUseResult), file = object(receipt?.file)
        if (receipt?.type !== "text" || receipt.isAsync !== undefined || receipt.status !== undefined || receipt.agentId !== undefined ||
          file?.filePath !== call.path || typeof file.content !== "string")
          fail("unsupported", "Claude Read receipt differs from its current call.")
      }
    }
  } else if (record.parentUuid !== context.leaf) fail("unsupported", "Claude history is not a single unambiguous append-only chain.")
}

/** A source record is classified before projection, then committed only after
 * its Events, usage and bytes have all been admitted. There is no round state. */
async function normalizeSourceRecord(handle: Awaited<ReturnType<typeof open>>, record: RecordValue, root: RecordValue,
  context: Normalization, signal: AbortSignal): Promise<NormalizedRecord> {
  const stage = context.continuation, uuid = record.uuid, message = object(record.message)
  if (record.sessionId !== undefined && record.sessionId !== root.sessionId) fail("unsupported", "Mixed Claude session identities are not supported.")
  const identified = uuid !== undefined || record.type === "user" || record.type === "assistant" ||
    record.subtype === "compact_boundary" || record.compactMetadata !== undefined || record.isCompactSummary !== undefined ||
    record.isVisibleInTranscriptOnly !== undefined
  if (identified && (root.isSidechain === true ? record.isSidechain !== true || record.agentId !== root.agentId
    : record.isSidechain !== undefined && record.isSidechain !== false || record.agentId !== undefined))
    fail("unsupported", "Claude record does not belong to its selected Thread.")
  if (identified && !autoId(uuid)) fail("unsupported", "Claude identified record has no valid UUID.")
  if (uuid === undefined) {
    if (stage && !sourceBookkeeping(record, root)) fail("unsupported", "Claude compaction bookkeeping contains conflicting source data.")
    return { rawOnly: true, kind: "ordinary", continuation: stage }
  }
  const indexed = context.records.get(uuid as string)
  if (indexed) {
    if (stage?.phase === "summary") fail("unsupported", "Claude compaction requires its declared summary.")
    const original = await indexedRecord(handle, indexed.value, signal)
    const { slug, ...withoutSlug } = record
    if (!(Object.hasOwn(original, "slug") ? equalJson(record, original)
      : Object.hasOwn(record, "slug") ? autoId(slug) && equalJson(withoutSlug, original) : equalJson(record, original)))
      fail("unsupported", "Claude replay differs from its complete previously committed record.")
    return { rawOnly: true, copy: true, kind: indexed.kind, continuation: { phase: "copies" } }
  }
  if (stage?.phase === "summary" && (record.subtype === "compact_boundary" || record.compactMetadata !== undefined))
    fail("unsupported", "Claude compaction requires its declared summary before another boundary.")
  if (record.subtype === "compact_boundary" || record.compactMetadata !== undefined)
    return { rawOnly: true, kind: "boundary", continuation: sourceBoundary(record, root, context) }
  if (stage?.phase === "copies") fail("unsupported", "Claude replay requires a following compaction boundary.")
  if (stage?.phase === "summary") {
    if (!controlIdentity(record, root) || !plainControl(record) || record.uuid !== stage.summaryUuid || record.parentUuid !== stage.boundaryUuid ||
      record.type !== "user" || record.isMeta === true || record.isCompactSummary !== true || record.isVisibleInTranscriptOnly !== true ||
      record.attachment !== undefined || record.logicalParentUuid != null || record.subtype !== undefined || message?.role !== "user" ||
      typeof message.content !== "string" || !message.content.trim() || !autoId(record.promptId) ||
      stage.slug !== undefined && record.slug !== stage.slug)
      fail("unsupported", "Claude summary does not match its admitted boundary.")
    return { rawOnly: true, kind: "summary", continuation: { ...stage, phase: "resume", promptId: record.promptId as string } }
  }
  if (record.logicalParentUuid != null || record.isCompactSummary !== undefined || record.isVisibleInTranscriptOnly !== undefined)
    fail("unsupported", "Claude summary or logical-parent controls have no admitted boundary.")
  verifyOrdinaryParent(record, context)
  if (stage?.phase === "resume") {
    if (record.type === "attachment") {
      const attachment = object(record.attachment)
      if (!controlIdentity(record, root) || !plainControl(record) || record.message !== undefined || record.isMeta !== undefined || !attachment ||
        attachment.isAsync !== undefined || attachment.status !== undefined || attachment.agentId !== undefined)
        fail("unsupported", "Claude continuation attachment has conflicting source data.")
      if (attachment.type === "file" && (typeof attachment.filename !== "string" || !attachment.filename.length || !object(attachment.content)))
        fail("unsupported", "Claude continuation file has no typed source content.")
      if (!["file", "total_tokens_reminder", "agent_listing_delta"].includes(string(attachment.type) ?? ""))
        fail("unsupported", "Claude continuation attachment has an unsupported kind.")
      return { rawOnly: true, kind: attachment.type === "file" ? "file" : "ordinary", continuation: stage }
    }
    const text = controlText(message)
    if (record.isMeta === true || record.type === "user" && typeof text === "string" && /^<(?:command-name|local-command)/.test(text.trimStart())) {
      if (!controlIdentity(record, root) || !plainControl(record) || record.type !== "user" || message?.role !== "user" ||
        !text?.trim() || record.attachment !== undefined)
        fail("unsupported", "Claude compaction command or metadata mixes conversation data.")
      const kind = record.isMeta === true ? /^<local-command-caveat>/.test(text) ? "caveat" : "meta"
        : /^<command-name>\/compact<\/command-name>/.test(text) ? "command"
          : /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(text) ? "stdout" : undefined
      if (!kind) fail("unsupported", "Claude continuation has an unsupported local command.")
      return { rawOnly: true, kind, continuation: stage }
    }
    if (message?.model === "<synthetic>") {
      const previous = context.leaf ? context.records.get(context.leaf)?.kind : undefined
      if (!controlIdentity(record, root) || record.type !== "assistant" || message.role !== "assistant" ||
        record.isMeta === true || record.attachment !== undefined || record.sourceToolAssistantUUID !== undefined || record.toolUseResult !== undefined ||
        record.isAsync !== undefined || record.status !== undefined || record.isApiErrorMessage !== undefined && record.isApiErrorMessage !== false ||
        message.stop_reason !== "stop_sequence" || text !== "No response requested." || !zeroSyntheticUsage(message.usage) ||
        !["stdout", "meta"].includes(previous ?? "")) fail("unsupported", "Claude synthetic scaffolding has no valid zero-usage source context.")
      return { rawOnly: true, kind: "synthetic", continuation: stage }
    }
  } else if (message?.model === "<synthetic>") fail("unsupported", "Claude synthetic scaffolding has no compaction context.")
  const ordinary = record.type === "user" || record.type === "assistant"
  if (ordinary && (!message || message.role !== record.type)) fail("unsupported", "Claude conversation has a conflicting message role.")
  return { rawOnly: record.isMeta === true, kind: "ordinary", continuation: ordinary && record.isMeta !== true ? undefined : stage }
}

function commitNormalizedRecord(context: Normalization, record: RecordValue, ref: RecordRef, action: NormalizedRecord): void {
  const uuid = string(record.uuid)
  if (uuid) {
    if (action.copy) context.records.get(uuid)!.value = ref
    else { context.records.set(uuid, { first: ref, value: ref, kind: action.kind }); context.leaf = uuid }
  }
  context.continuation = action.continuation; context.order++
  if (action.kind === "boundary") context.response = undefined
  if (action.rawOnly) return
  const message = object(record.message), blocks = message?.content
  if (record.type === "assistant" && message) {
    const id = string(message.id) ?? uuid!, model = message.model
    if (!context.response || context.response.id !== id || context.response.model !== model)
      context.response = { id, model, pending: new Map() }
    if (Array.isArray(blocks)) for (const blockValue of blocks) {
      const block = object(blockValue)
      if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue
      if (context.calls.has(block.id)) fail("unsupported", "Claude tool IDs are ambiguous in this Session.")
      const call = sourceCall(uuid!, block)
      context.calls.set(block.id, call); context.response.pending.set(block.id, call)
    }
  } else if (record.type === "user") {
    const results = toolResults(record)
    if (results.length) for (const block of results) context.response?.pending.delete(block.tool_use_id as string)
    else context.response = undefined
  }
}

/** Cold recovery rebuilds only source facts, never old Events or usage. All
 * index references come from the bytes included in the verified prefix hash. */
async function restoreNormalization(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, state: NonNullable<Cursor["stream"]> | undefined, signal: AbortSignal,
  onOrdinaryRecord?: (record: RecordValue, calls: ReadonlyMap<string, SourceCall>) => void,
  admit: () => void = () => {}, recordLimit = MaxRecordBytes): Promise<Normalization> {
  const context: Normalization = { records: new Map(), calls: new Map(), leaf: null, order: 0, continuation: undefined, response: undefined }
  const hash = createHash("sha256")
  let at = 0
  for await (const line of readRecords(handle, 0, committed, signal, recordLimit)) {
    admit()
    hash.update(line.content)
    if (line.content.toString("utf8").trim()) {
      const record = parseSourceRecord(line.content)
      if (record.uuid !== undefined && context.records.size === 0 && (record.uuid !== root.uuid || record.type !== "user" ||
        record.parentUuid !== null || record.isMeta === true || record.sessionId !== root.sessionId || record.cwd !== root.cwd))
        fail("changed", "Claude original identity changed during collection.")
      const action = await normalizeSourceRecord(handle, record, root, context, signal)
      commitNormalizedRecord(context, record, recordRef(at, line.content), action)
      if (!action.rawOnly) onOrdinaryRecord?.(record, context.calls)
    }
    at = line.end
  }
  if (at !== committed || hash.digest("hex") !== expectedDigest) fail("changed", "The committed Claude source changed during normalization.")
  if (state && (state.lastUuid !== context.leaf || state.order !== context.order || !equalJson(state.seen, [...context.records.keys()]) ||
    !equalJson(state.calls, [...context.calls].map(([id, call]) => [id, call.name, call.uuid]))))
    fail("cursor", "Claude checkpoint source facts do not match its committed prefix.")
  if (state?.continuation && !equalJson(state.continuation, context.continuation))
    fail("cursor", "Claude checkpoint continuation does not match its committed source.")
  if (state?.compaction) {
    const stage = state.compaction, current = context.continuation, leafKind = context.leaf ? context.records.get(context.leaf)?.kind : undefined
    const kinds = { summary: "boundary", caveat: "summary", command: "caveat", stdout: "command", resume: "stdout" } as const
    if (!current || current.trigger !== "manual" || current.boundaryUuid !== stage.boundaryUuid || current.summaryUuid !== stage.summaryUuid ||
      stage.phase === "summary" && current.phase !== "summary" || stage.phase !== "summary" && current.phase !== "resume" ||
      stage.promptId !== undefined && current.promptId !== stage.promptId ||
      leafKind !== kinds[stage.phase] && !(stage.phase === "resume" && leafKind === "file"))
      fail("cursor", "Claude legacy manual checkpoint does not match its source controls.")
  }
  if (state?.autoText && (!context.continuation || context.continuation.phase !== "resume" ||
    context.continuation.boundaryUuid !== state.autoText.boundaryUuid || context.continuation.summaryUuid !== state.autoText.summaryUuid ||
    context.continuation.promptId !== state.autoText.promptId || context.continuation.slug !== state.autoText.slug))
    fail("cursor", "Claude legacy automatic checkpoint does not match its source controls.")
  if (state?.readPair) {
    const pair = state.readPair, call = context.response?.pending.get(pair.secondToolId)
    if (context.leaf !== pair.firstResultUuid || !call || call.uuid !== pair.secondCallUuid || call.name !== "Read" || call.path !== pair.secondFilePath)
      fail("cursor", "Claude legacy Read checkpoint does not match its current response.")
  }
  return context
}

/** An upgrade reprojects from zero, but cannot use that reset to legitimize an
 * old partial page. Its skip belongs to that checkpoint's visible projection. */
async function validatePendingProjection(handle: Awaited<ReturnType<typeof open>>, size: number, cursor: Cursor,
  root: RecordValue, context: Normalization, sourceObjectId: string, signal: AbortSignal,
  delegated: boolean, children: ReadonlyArray<Child>, admit: () => void = () => {}, recordLimit = MaxRecordBytes): Promise<void> {
  const skip = cursor.stream?.eventSkip ?? 0
  if (skip === 0) return
  for await (const line of readRecords(handle, cursor.bytes, size, signal, recordLimit)) {
    admit()
    if (!line.content.toString("utf8").trim()) fail("cursor", "Claude checkpoint has no complete pending conversation record.")
    const record = parseSourceRecord(line.content)
    const transition = await normalizeSourceRecord(handle, record, root, context, signal)
    if (transition.rawOnly || cursor.observedAt !== undefined && timestamp(record.timestamp) !== cursor.observedAt)
      fail("cursor", "Claude checkpoint has no admitted pending conversation record.")
    const calls = new Map(context.calls)
    const projected = projectRecord(record, context.order, line.end, sourceObjectId, calls,
      cursor.projectionRevision === ProjectionRevision ? ProjectionRevision : 4)
    bindChild(record, calls, delegated, children, cursor.sessionId)
    if (skip > projected.events.length) fail("cursor", "Claude record checkpoint exceeds its event count.")
    return
  }
  fail("cursor", "Claude checkpoint has no complete pending conversation record.")
}

type ChildBinding = { readonly child?: Child; readonly unlinked: boolean }
const userCommandText = (text: string) => /^<(?:command-name|local-command|bash-input)/.test(text.trimStart())
// Host JavaScript and Server Go both require text with a nonblank body. Go's
// Unicode whitespace also includes NEL, which JavaScript's \s does not.
const hasThoughtBody = (text: string) => /[^\s\u0085]/u.test(text)
/** A child relation needs one projected result Event. Unknown Raw-only
 * blocks do not add Events; real text or another result does. */
function singleResultEvent(record: RecordValue): boolean {
  const message = object(record.message), content = message?.content
  return record.type === "user" && record.isMeta !== true && message?.role === "user" && Array.isArray(content) &&
    toolResults(record).length === 1 && !content.some(value => {
      const block = object(value)
      return block?.type === "text" && typeof block.text === "string" && block.text.length > 0 && !userCommandText(block.text)
    })
}

/** Source identity and ordinary call correlation have already been checked.
 * A valid current-Thread record can carry an unproved child relationship. */
function bindChild(record: RecordValue, calls: ReadonlyMap<string, SourceCall>, delegated: boolean,
  children: ReadonlyArray<Child>, sessionId: string): ChildBinding {
  const content = object(record.message)?.content
  const result = object(record.toolUseResult), agentId = string(result?.agentId)
  const links = (Array.isArray(content) ? content : []).map(object).filter(block => block?.type === "tool_result" && typeof block.tool_use_id === "string" &&
    ["Agent", "Task"].includes(calls.get(block.tool_use_id)?.name ?? ""))
  if (!links.length) return { unlinked: false }
  // Check every declared Agent edge before the soft eligibility decision.
  // Nested call IDs have their own namespace; their reuse cannot contradict a
  // root call, but claiming an already root-owned Agent would reparent it.
  const pinned = agentId === undefined ? undefined : children.find(child => child.agentId === agentId)
  if (pinned && (delegated || links.some(block => block!.tool_use_id !== pinned.toolCallId ||
    calls.get(block!.tool_use_id as string)!.uuid !== pinned.toolUuid) ||
    record.sourceToolAssistantUUID !== undefined && record.sourceToolAssistantUUID !== pinned.toolUuid) ||
    !delegated && agentId !== undefined && links.some(block => children.some(child =>
      child.toolCallId === block!.tool_use_id && child.agentId !== agentId)))
    fail("unsupported", "Claude subagent has conflicting parent evidence.")
  if (links.length !== 1 || delegated || !agentId || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId) ||
    !/^[A-Za-z0-9_-]{1,500}$/.test(sessionId) || !singleResultEvent(record)) return { unlinked: true }
  const block = links[0]!, toolCallId = block.tool_use_id as string, call = calls.get(toolCallId)!
  const foreground = result?.status === "completed" && (result.isAsync === undefined || result.isAsync === false) &&
    (record.isAsync === undefined || record.isAsync === false)
  const background = call.backgroundRequested === true && result?.status === "async_launched" && result.isAsync === true &&
    (record.isAsync === undefined || record.isAsync === true)
  if (!foreground && !background || block.is_error !== undefined && block.is_error !== false ||
    record.sourceToolAssistantUUID !== call.uuid) return { unlinked: true }
  return { child: { agentId, toolCallId, toolUuid: call.uuid }, unlinked: false }
}

/** This is a v2 projection rule. The legacy normalizer must still validate old
 * pending slots where the same provider notification was a visible user Event. */
function taskNotification(record: RecordValue, root: RecordValue): boolean {
  if (object(record.origin)?.kind !== "task-notification") return false
  const message = object(record.message)
  if (record.type !== "user" || message?.role !== "user" || typeof message.content !== "string" || !message.content.trim() ||
    record.queueSkipAttachments !== true || record.isMeta !== undefined && record.isMeta !== false ||
    !autoId(record.uuid) || !sourceVersion(record.version) || record.sessionId !== root.sessionId || typeof record.cwd !== "string" || !isAbsolute(record.cwd) ||
    record.attachment !== undefined || record.subtype !== undefined || record.compactMetadata !== undefined ||
    record.isCompactSummary !== undefined || record.isVisibleInTranscriptOnly !== undefined || !plainControl(record))
    fail("unsupported", "Claude typed task notification has conflicting source data.")
  if (!timestamp(record.timestamp)) fail("format", "Claude task notification has no valid timestamp.")
  return true
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

async function* readRecords(handle: Awaited<ReturnType<typeof open>>, start: number, end: number, signal: AbortSignal, recordLimit = MaxRecordBytes) {
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
      if (newline + 1 > recordLimit) fail("limit", recordLimit === MaxRecordBytes ? "Claude JSONL record exceeds 16 MiB." :
        "Claude JSONL record exceeds its bounded source capacity.")
      const content = pending.subarray(0, newline + 1)
      yield { content, end: lineStart + newline + 1 }
      pending = pending.subarray(newline + 1); lineStart += newline + 1
    }
    if (pending.length > recordLimit || recordLimit !== MaxRecordBytes && pending.length === recordLimit)
      fail("limit", recordLimit === MaxRecordBytes ? "Claude JSONL record exceeds 16 MiB." :
        "Claude JSONL record exceeds its bounded source capacity.")
  }
}

function rootTitle(root: RecordValue): string {
  const content = object(root.message)?.content
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.map(block => object(block)?.type === "text" ? string(object(block)?.text) ?? "" : "").join(" ") : ""
  return text.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled Claude conversation"
}

function projectRecord(record: RecordValue, order: number, revision: number, sourceObjectId: string,
  calls: Map<string, SourceCall>, projectionRevision: 4 | 5 = ProjectionRevision): { events: AdapterEvent[]; partial: boolean } {
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
        if (record.type === "user" && userCommandText(block.text)) { partial = true; continue }
        update = { sessionUpdate: record.type === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: block.text } }
      } else if (projectionRevision === ProjectionRevision && block?.type === "thinking" && record.type === "assistant" &&
        typeof block.thinking === "string" && block.thinking.length > 0) {
        update = { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } }
      } else if (block?.type === "tool_use" && record.type === "assistant" && typeof block.id === "string" && typeof block.name === "string") {
        if (calls.has(block.id)) fail("unsupported", "Claude tool IDs are ambiguous in this session.")
        calls.set(block.id, sourceCall(record.uuid as string, block))
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
      const message = update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk" ? update : undefined
      const chunks = message?.content.type === "text" ? splitText(message.content.text) : [undefined]
      const thought = update.sessionUpdate === "agent_thought_chunk"
      if (thought && chunks.some(text => text !== undefined && !hasThoughtBody(text))) { partial = true; fidelity = "partial" }
      for (const [part, text] of chunks.entries()) {
        if (thought && text !== undefined && !hasThoughtBody(text)) continue
        events.push({
          sourceEventId: `${record.uuid}:${slot}${chunks.length > 1 ? `:${part}` : ""}`, sourceThreadId: "root",
          revision, projectionRevision, sourceOrder: order, eventIndex: slot * 128 + part,
          orderFidelity: "native", fidelity, occurredAt,
          rawRef: { _tag: "object", sourceObjectId, fragment: `record=${record.uuid}&block=${slot}` },
          update: message && text !== undefined ? { ...message, messageId: `${record.uuid}:${slot}`, content: { type: "text", text } } : update
        })
      }
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
    if (c.projectionRevision !== undefined && ![2, 3, 4, ProjectionRevision].includes(c.projectionRevision)) throw new Error()
    if (c.familyRevision !== undefined && (!Number.isSafeInteger(c.familyRevision) || c.familyRevision < 1)) throw new Error()
    if (c.familyObservedAt !== undefined && timestamp(c.familyObservedAt) !== c.familyObservedAt) throw new Error()
    if (c.children) {
      const agents = new Set<string>(), tools = new Set<string>()
      for (const child of c.children) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(child.agentId) || !child.toolCallId || child.toolCallId.length > 4096 ||
          !child.toolUuid || child.toolUuid.length > 4096 || agents.has(child.agentId) || tools.has(child.toolCallId)) throw new Error()
        agents.add(child.agentId); tools.add(child.toolCallId)
        if (child.checkpoint) {
          const checkpoint = decodeCursor(JSON.stringify(child.checkpoint))!
          if (checkpoint.sessionId !== c.sessionId || checkpoint.origin !== c.origin || checkpoint.stream?.autoText || checkpoint.stream?.readPair) throw new Error()
        }
      }
      if (c.childAfter !== undefined && !agents.has(c.childAfter)) throw new Error()
    } else if (c.childAfter !== undefined) throw new Error()
    if (c.stream && (!Number.isSafeInteger(c.stream.order) || c.stream.order < c.stream.seen.length ||
      !Number.isSafeInteger(c.stream.eventSkip) || c.stream.eventSkip < 0 ||
      new Set(c.stream.seen).size !== c.stream.seen.length ||
      c.stream.lastUuid !== null && !c.stream.seen.includes(c.stream.lastUuid) ||
      c.stream.title.length > 500 || c.stream.calls.some(call => call.some(value => value.length > 4096)))) throw new Error()
    const stage = c.stream?.compaction
    if (stage && (c.stream!.eventSkip !== 0 || !stage.boundaryUuid || stage.boundaryUuid.length > 500 || !stage.summaryUuid || stage.summaryUuid.length > 500 ||
      stage.boundaryUuid === stage.summaryUuid || !c.stream!.seen.includes(stage.boundaryUuid) ||
      (stage.phase === "summary" ? c.stream!.lastUuid !== stage.boundaryUuid || c.stream!.seen.includes(stage.summaryUuid)
        : !stage.promptId || stage.promptId.length > 500 || !c.stream!.seen.includes(stage.summaryUuid)))) throw new Error()
    const auto = c.stream?.autoText
    const autoSummaryTail = auto && c.stream!.lastUuid === auto.summaryUuid && c.stream!.seen.at(-2) === auto.boundaryUuid && c.stream!.seen.at(-1) === auto.summaryUuid
    const autoFileTail = auto && autoId(c.stream!.lastUuid) && c.stream!.lastUuid !== auto.summaryUuid &&
      [1, 2].some(files => c.stream!.seen.at(-files - 2) === auto.boundaryUuid && c.stream!.seen.at(-files - 1) === auto.summaryUuid) &&
      c.stream!.seen.at(-1) === c.stream!.lastUuid &&
      new Set(c.stream!.calls.map(call => call[0])).size === c.stream!.calls.length
    if (auto && (stage || c.projectionRevision !== 4 || c.usageVersion !== 1 || !c.observedAt || timestamp(c.observedAt) !== c.observedAt ||
      ![auto.boundaryUuid, auto.summaryUuid, auto.promptId, auto.slug].every(autoId) || auto.boundaryUuid === auto.summaryUuid ||
      new Set(c.stream!.calls.map(call => call[0])).size !== c.stream!.calls.length || !autoSummaryTail && !autoFileTail)) throw new Error()
    const pair = c.stream?.readPair
    if (pair) {
      const c0 = c.stream!.seen.at(-3), c1 = c.stream!.seen.at(-2)
      const firstCallUuid = pair.secondCallUuid === c0 ? c1 : c0, first = c.stream!.calls.filter(call => call[2] === firstCallUuid)
      const second = c.stream!.calls.filter(call => call[2] === pair.secondCallUuid)
      if (stage || auto || c.projectionRevision !== 4 || c.usageVersion !== 1 || !c.observedAt || timestamp(c.observedAt) !== c.observedAt ||
        c.stream!.eventSkip !== 0 || ![pair.firstResultUuid, pair.secondCallUuid, pair.secondToolId, pair.promptId, firstCallUuid].every(autoId) ||
        !readPath(pair.secondFilePath) || c.stream!.lastUuid !== pair.firstResultUuid || c.stream!.seen.at(-1) !== pair.firstResultUuid ||
        pair.secondCallUuid !== c0 && pair.secondCallUuid !== c1 || new Set([c0, c1, pair.firstResultUuid]).size !== 3 ||
        new Set(c.stream!.calls.map(call => call[0])).size !== c.stream!.calls.length ||
        first.length !== 1 || !autoId(first[0]![0]) || first[0]![1] !== "Read" || first[0]![0] === pair.secondToolId || second.length !== 1 ||
        second[0]![0] !== pair.secondToolId || second[0]![1] !== "Read") throw new Error()
    }
    const continuation = c.stream?.continuation
    if (c.normalizationVersion === 1) {
      if (!c.stream || !c.observedAt ||
        timestamp(c.observedAt) !== c.observedAt || stage || auto || pair ||
        new Set(c.stream.calls.map(call => call[0])).size !== c.stream.calls.length) throw new Error()
      if (continuation) {
        if (continuation.phase === "copies") {
          if (c.stream.eventSkip !== 0 || continuation.boundaryUuid !== undefined || continuation.summaryUuid !== undefined ||
            continuation.trigger !== undefined || continuation.slug !== undefined || continuation.promptId !== undefined) throw new Error()
        } else if (![continuation.boundaryUuid, continuation.summaryUuid].every(autoId) ||
          continuation.boundaryUuid === continuation.summaryUuid || !continuation.trigger ||
          continuation.slug !== undefined && !autoId(continuation.slug) || continuation.promptId !== undefined && !autoId(continuation.promptId) ||
          !c.stream.seen.includes(continuation.boundaryUuid!) ||
          (continuation.phase === "summary" ? c.stream.eventSkip !== 0 || c.stream.lastUuid !== continuation.boundaryUuid ||
            c.stream.seen.includes(continuation.summaryUuid!) || continuation.promptId !== undefined
            : !c.stream.seen.includes(continuation.summaryUuid!) || !continuation.promptId)) throw new Error()
      }
    } else if (continuation) throw new Error()
    return c
  } catch { return fail("cursor", "Claude checkpoint is invalid; it was not reset.") }
}

async function discover(archive: Archive, signal: AbortSignal, diagnostics: SourceDiagnostics): Promise<Candidate[]> {
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
      if (!entry.isFile()) continue
      try {
        // Unattributable headers produce local diagnostics, never uploads.
        const header = await readHeader(file, signal)
        if (!header || typeof header.sessionId !== "string" || !header.sessionId || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) {
          diagnostics.add(file, "format"); continue
        }
        if (!await belongsToProject(archive, header, signal)) continue
        const sessionId = header.sessionId
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
    return await readOpenedHeader(handle, details.size, signal)
  } finally { await handle.close() }
}
async function readOpenedHeader(handle: Awaited<ReturnType<typeof open>>, size: number, signal: AbortSignal): Promise<RecordValue | undefined> {
  let records = 0
  for await (const line of readRecords(handle, 0, Math.min(size, MaxHeaderBytes), signal)) {
    if (++records > 256) return undefined
    if (line.content.toString("utf8").trim().length === 0) continue
    let record: RecordValue
    try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.content))) }
    catch { return undefined }
    if (typeof record.uuid === "string") return record
  }
  return undefined
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

// The legacy cursor remains a migration input, not a second publication writer.
// These private indexes contain locators and source facts, never transcript bodies.
type SourceProof = { threadId: string; bytes: number; digest: string; rootUuid: string }
type CaptureCheckpoint = { v: 1; sessionId: string; origin: string; rootUuid: string; streams: SourceProof[] }
type CaptureNode = { ref: RecordRef; predecessor: string | null; rawOnly: boolean; kind: ControlKind; child?: Child; unlinked: boolean }
type CaptureStream = {
  file: string; threadId: string; root: RecordValue; refs: RecordRef[]; nodes: Map<string, CaptureNode>; selected: Set<number>
  latestUsage: Map<string, number>; children: Child[]; proof: SourceProof; events: number; usage: number; observedAt: string
}
const captureProfile = "claude.jsonl.active-path.1"
const emptyNormalization = (): Normalization => ({ records: new Map(), calls: new Map(), leaf: null, order: 0, continuation: undefined, response: undefined })
const captureFailure = (cause: unknown) => cause instanceof ClaudeArchiveError ? cause : new ClaudeArchiveError({ reason: "io", message: "Could not read the selected Claude source view." })
function captureCheckpoint(value: string | undefined): CaptureCheckpoint | undefined {
  if (value === undefined) return undefined
  try {
    if (Buffer.byteLength(value) > MaxCursorBytes) throw new Error()
    const c = JSON.parse(value) as CaptureCheckpoint
    if (c.v !== 1 || !autoId(c.sessionId) || !autoId(c.rootUuid) || !isAbsolute(c.origin) || !Array.isArray(c.streams) || c.streams.length > 1000 ||
      !c.streams.some(stream => stream.threadId === "root" && stream.rootUuid === c.rootUuid && stream.bytes > 0) ||
      new Set(c.streams.map(stream => stream.threadId)).size !== c.streams.length || c.streams.some(stream => !autoId(stream.threadId) || !autoId(stream.rootUuid) ||
        stream.threadId !== "root" && !/^claude-agent:[A-Za-z0-9_-]{1,128}$/.test(stream.threadId) ||
        !Number.isSafeInteger(stream.bytes) || stream.bytes < 0 || !/^[a-f0-9]{64}$/.test(stream.digest))) throw new Error()
    return c
  } catch { return fail("cursor", "Claude source checkpoint is invalid; it was not reset.") }
}
function sourceOrigin(root: RecordValue) {
  if (root.type !== "user" || root.parentUuid !== null || root.isMeta === true || object(root.origin)?.kind === "task-notification" ||
    !autoId(root.uuid) || !autoId(root.sessionId) || typeof root.cwd !== "string" || !isAbsolute(root.cwd))
    fail("unsupported", "Claude source has no trustworthy original user root.")
  return { sourceId: root.sessionId as string, originKey: root.uuid as string, cwd: root.cwd as string }
}
async function sourceCandidates(archive: Archive, signal: AbortSignal, diagnostics: SourceDiagnostics): Promise<Candidate[]> {
  const candidates = archive.file ? [{ file: archive.file, sessionId: string((await readHeader(archive.file, signal))?.sessionId) ?? "" }]
    : await discover(archive, signal, diagnostics)
  return candidates
}
export const discoverClaudeSources = (archive: Archive, request: { cursor: string | null; limits: SourceCaptureLimits; signal: AbortSignal }): Effect.Effect<SourceDiscoveryPage, ClaudeArchiveError> => Effect.tryPromise({
  try: async () => {
    const diagnostics = new SourceDiagnostics(), candidates = await sourceCandidates(archive, request.signal, diagnostics)
    const sources: SourceDiscoveryPage["sources"][number][] = []
    for (const candidate of candidates.sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)) {
      if (request.cursor !== null && candidate.sessionId <= request.cursor) continue
      try { const root = await readHeader(candidate.file, request.signal); if (!root) fail("format", "Claude source has no complete original record."); sources.push(sourceOrigin(root)) }
      catch (cause) { diagnostics.capture(candidate.file, cause, request.signal) }
      if (sources.length === request.limits.pageRows) break
    }
    const last = sources.at(-1)?.sourceId, done = last === undefined || !candidates.some(candidate => candidate.sessionId > last)
    return { sources, cursor: done ? null : last!, done, ...diagnostics.snapshot() }
  }, catch: captureFailure
})
export const migrateClaudeSources = (archive: Archive, request: SourceLegacyMigrationRequest): Effect.Effect<SourceDiscoveryPage, ClaudeArchiveError> => Effect.tryPromise({
  try: async () => {
    const state = decodeDiscoveryCursor(request.checkpointCursor), diagnostics = new SourceDiagnostics()
    for (const { checkpoint } of state.sessions) if (!autoId(checkpoint.sessionId) || !isAbsolute(checkpoint.origin) ||
      checkpoint.stream?.seen[0] !== undefined && !autoId(checkpoint.stream.seen[0]))
      fail("cursor", "Claude legacy checkpoint has invalid creation identity facts.")
    const sessions = [...state.sessions].sort((a, b) => a.checkpoint.sessionId < b.checkpoint.sessionId ? -1 : a.checkpoint.sessionId > b.checkpoint.sessionId ? 1 : 0)
    const page = sessions.filter(({ checkpoint }) => request.cursor === null || checkpoint.sessionId > request.cursor).slice(0, request.limits.pageRows)
    const sources: SourceDiscoveryPage["sources"][number][] = []
    const started = performance.now(), check = () => {
      request.signal.throwIfAborted()
      if (performance.now() - started >= request.limits.durationMs) fail("limit", "Claude legacy Origin resolution exceeded its deadline.")
    }
    let candidates: Candidate[] | undefined
    for (const session of page) {
      check()
      const { checkpoint } = session, first = checkpoint.stream?.seen[0]
      if (first !== undefined) {
        sources.push({ sourceId: checkpoint.sessionId, originKey: first, cwd: checkpoint.origin }); continue
      }
      let source = session.file || checkpoint.sessionId
      try {
        // A legacy first-record partial page (or an older cursor without a
        // stream) has no acknowledged root UUID. Resolve only that page's
        // source, authenticating every byte the old cursor actually committed.
        candidates ??= await sourceCandidates(archive, request.signal, diagnostics)
        check()
        const candidate = candidates.find(candidate => candidate.sessionId === checkpoint.sessionId)
        if (!candidate) fail("io", "The legacy Claude source is unavailable or ambiguous.")
        source = candidate.file
        const handle = await open(candidate.file, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const before = await handle.stat()
          if (!before.isFile()) fail("format", "Claude source is not a regular file.")
          const root = await readOpenedHeader(handle, before.size, request.signal)
          if (!root) fail("format", "Claude source has no complete original record.")
          const origin = sourceOrigin(root)
          if (origin.sourceId !== checkpoint.sessionId || origin.cwd !== checkpoint.origin)
            fail("changed", "Claude legacy source identity changed.")
          if (root.isSidechain !== undefined && root.isSidechain !== false || root.agentId !== undefined)
            fail("unsupported", "Claude legacy source is not an original root Thread.")
          if (!await belongsToProject(archive, root, request.signal)) fail("attribution", "Claude legacy source is outside the selected Project.")
          await validateLegacyStream(handle, before.size, root, checkpoint, false, checkpoint.children ?? [], request.signal, request.limits, check)
          const after = await handle.stat()
          if (after.ino !== before.ino || after.size < before.size || after.size === before.size && after.mtimeMs !== before.mtimeMs)
            fail("changed", "Claude source changed while resolving its legacy Origin.")
          check(); sources.push(origin)
        } finally { await handle.close() }
      } catch (cause) { diagnostics.capture(source, cause, request.signal) }
    }
    // Failed entries also advance this bounded page, so a missing source cannot
    // prevent healthy legacy Sessions from being considered on later pages.
    const last = page.at(-1)?.checkpoint.sessionId, done = last === undefined || !sessions.some(({ checkpoint }) => checkpoint.sessionId > last)
    return { sources, cursor: done ? null : last!, done, ...diagnostics.snapshot() }
  }, catch: captureFailure
})
async function authenticateSource(handle: Awaited<ReturnType<typeof open>>, proof: SourceProof, size: number, signal: AbortSignal): Promise<void> {
  if (size < proof.bytes) fail("changed", "The captured Claude prefix changed or was truncated.")
  const hash = createHash("sha256"), block = Buffer.alloc(256 * 1024)
  for (let at = 0; at < proof.bytes;) {
    signal.throwIfAborted()
    const read = await handle.read(block, 0, Math.min(block.length, proof.bytes - at), at)
    if (!read.bytesRead) fail("changed", "The captured Claude prefix changed or was truncated.")
    hash.update(block.subarray(0, read.bytesRead)); at += read.bytesRead
  }
  if (hash.digest("hex") !== proof.digest) fail("changed", "The captured Claude prefix changed or was truncated.")
}
async function validateLegacyStream(handle: Awaited<ReturnType<typeof open>>, size: number, root: RecordValue, cursor: Cursor | undefined,
  delegated: boolean, pins: ReadonlyArray<Child>, signal: AbortSignal, limits?: SourceCaptureLimits, check: () => void = () => {}): Promise<void> {
  if (!cursor) return
  if (cursor.sessionId !== root.sessionId || cursor.origin !== root.cwd || cursor.stream?.seen[0] !== undefined && cursor.stream.seen[0] !== root.uuid)
    fail("changed", "Claude legacy creation Origin changed.")
  let records = 0
  const admit = () => { check(); if (limits && ++records > limits.records) fail("limit", "Claude legacy source exceeds its record admission.") }
  const previous = await restoreNormalization(handle, cursor.bytes, cursor.digest, root, cursor.stream, signal,
    (record, calls) => { bindChild(record, calls, delegated, pins, cursor.sessionId) }, admit, limits?.rowBytes)
  if (cursor.normalizationVersion === 1 && !equalJson(cursor.stream?.continuation, previous.continuation))
    fail("cursor", "Claude checkpoint continuation does not match its committed source.")
  await validatePendingProjection(handle, size, cursor, root, previous, "migration-validation", signal, delegated, pins, admit, limits?.rowBytes)
}
async function indexCaptureStream(file: string, rootIdentity: RecordValue | undefined, threadId: string, limits: SourceCaptureLimits,
  signal: AbortSignal, diagnostics: SourceDiagnostics, pins: Map<string, Child>, proof: SourceProof | undefined,
  legacy: Cursor | undefined, check: () => void): Promise<CaptureStream> {
  const root = await readHeader(file, signal)
  if (!root) fail("format", "Claude source has no complete original record.")
  sourceOrigin(root)
  const delegated = rootIdentity !== undefined
  if (delegated ? root.isSidechain !== true || root.agentId !== threadId.slice("claude-agent:".length) || root.sessionId !== rootIdentity.sessionId || root.cwd !== rootIdentity.cwd
    : root.isSidechain !== undefined && root.isSidechain !== false || root.agentId !== undefined)
    fail("unsupported", "Claude source does not belong to its proved Thread.")
  if (proof && proof.rootUuid !== root.uuid) fail("changed", "Claude Thread creation identity changed.")
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) fail("format", "Claude source is not a regular file.")
    if (proof) await authenticateSource(handle, proof, before.size, signal)
    await validateLegacyStream(handle, before.size, root, legacy, delegated, [...pins.values()], signal, limits, check)
    const nodes = new Map<string, CaptureNode>(), refs: RecordRef[] = [], originals = new Map<string, RecordRef>(), hash = createHash("sha256")
    let context = emptyNormalization(), bytes = 0, explicitEmpty = false
    const restore = async (leaf: string | null) => {
      const chain: CaptureNode[] = [], visited = new Set<string>()
      for (let uuid = leaf; uuid !== null;) {
        const node = nodes.get(uuid)
        if (!node || visited.has(uuid)) fail("unsupported", "Claude selected leaf has no complete source ancestry.")
        visited.add(uuid); chain.push(node); uuid = node.predecessor
      }
      const restored = emptyNormalization()
      for (const node of chain.reverse()) {
        check(); const record = await indexedRecord(handle, node.ref, signal)
        const action = await normalizeSourceRecord(handle, record, root, restored, signal)
        commitNormalizedRecord(restored, record, node.ref, action)
      }
      return restored
    }
    for await (const line of readRecords(handle, 0, before.size, signal, limits.rowBytes)) {
      check(); if (refs.length === limits.records) fail("limit", "Claude source exceeds its record admission.")
      const ref = recordRef(bytes, line.content); refs.push(ref); hash.update(line.content); bytes = line.end
      if (!line.content.toString("utf8").trim()) continue
      const record = parseSourceRecord(line.content), uuid = string(record.uuid), notification = taskNotification(record, root)
      if (record.sessionId !== undefined && record.sessionId !== root.sessionId) fail("unsupported", "Mixed Claude Session identities are not supported.")
      if (record.type === "last-prompt") {
        if (!sourceBookkeeping(record, root) || record.explicit !== undefined && typeof record.explicit !== "boolean" || record.rewound !== undefined && typeof record.rewound !== "boolean")
          fail("unsupported", "Claude leaf selector contains conflicting source evidence.")
        const leaf = record.leafUuid
        if (record.explicit === true) {
          if (leaf !== null && (!autoId(leaf) || !nodes.has(leaf))) fail("unsupported", "Claude leaf selector names an unknown source entry.")
          if (delegated) fail("unsupported", "Claude child leaf replacement is not admitted.")
          context = await restore(leaf === null ? null : leaf as string); explicitEmpty = leaf === null
        }
        // Ordinary last-prompt bookkeeping can precede its named UUID during
        // compaction. Only an explicit selector changes the active source path.
        continue
      }
      if (uuid && originals.has(uuid)) {
        if (!context.records.has(uuid)) fail("unsupported", "Claude replay cannot resurrect an abandoned sibling path.")
        const action = await normalizeSourceRecord(handle, record, root, context, signal)
        if (!action.copy) fail("unsupported", "Claude source UUID is ambiguous.")
        commitNormalizedRecord(context, record, ref, action); originals.set(uuid, ref); continue
      }
      const genuineUser = record.type === "user" && record.isMeta !== true && !notification && toolResults(record).length === 0 && record.isCompactSummary === undefined && record.isVisibleInTranscriptOnly === undefined
      if (genuineUser && record.parentUuid !== context.leaf) {
        if (delegated || !autoId(record.parentUuid) || !nodes.has(record.parentUuid)) fail("unsupported", "Claude branch has no known original anchor.")
        context = await restore(record.parentUuid)
      }
      if (genuineUser && record.parentUuid === null && nodes.size > 0 && !explicitEmpty)
        fail("unsupported", "Claude new root has no explicit empty rewind.")
      const predecessor = context.leaf, action = await normalizeSourceRecord(handle, record, root, context, signal)
      if (!uuid) { commitNormalizedRecord(context, record, ref, action); continue }
      if (nodes.size === 0 && (uuid !== root.uuid || record.sessionId !== root.sessionId || record.cwd !== root.cwd))
        fail("changed", "Claude original identity changed while opening its view.")
      const rawOnly = action.rawOnly || notification
      const calls = new Map(context.calls), projected = rawOnly ? undefined : projectRecord(record, context.order, ref.end, "source-view", calls)
      const relationship = rawOnly ? { unlinked: false } : bindChild(record, calls, delegated, [...pins.values()], root.sessionId as string)
      if (relationship.child) { childFile(file, root.sessionId as string, relationship.child.agentId); pins.set(relationship.child.agentId, relationship.child) }
      // Projection is validated even for a branch later abandoned by this view.
      void projected
      nodes.set(uuid, { ref, predecessor, rawOnly, kind: action.kind, ...relationship })
      originals.set(uuid, ref); commitNormalizedRecord(context, record, ref, action); explicitEmpty = false
    }
    const selected = new Set<number>(), latestUsage = new Map<string, number>(), children: Child[] = [], chain: CaptureNode[] = []
    for (let uuid = context.leaf; uuid !== null;) { const node = nodes.get(uuid)!; chain.push(node); uuid = node.predecessor }
    let eventCount = 0, observedAt = timestamp(root.timestamp) ?? new Date(before.mtimeMs).toISOString()
    const calls = new Map<string, SourceCall>()
    for (const node of chain.reverse()) {
      check(); selected.add(node.ref.start)
      if (node.unlinked) diagnostics.add(file, "unsupported")
      if (node.child) children.push(node.child)
      if (node.rawOnly) continue
      const record = await indexedRecord(handle, node.ref, signal), projected = projectRecord(record, 0, node.ref.end, "source-view", calls)
      eventCount += projected.events.length
      if (projected.events.length) observedAt = projected.events.at(-1)!.occurredAt
      const usage = projectUsage(record, node.ref.end)
      if (usage) latestUsage.set(usage.sourceUsageId, node.ref.start)
    }
    const after = await handle.stat()
    if (after.ino !== before.ino || after.size < before.size || after.size === before.size && after.mtimeMs !== before.mtimeMs)
      fail("changed", "Claude source changed while planning its view.")
    return { file, root, threadId, refs, nodes, selected, latestUsage, children, events: eventCount, usage: latestUsage.size, observedAt,
      proof: { threadId, bytes, digest: hash.digest("hex"), rootUuid: root.uuid as string } }
  } finally { await handle.close() }
}

/** One complete source view. The Host owns redaction, versions, Raw packing and
 * publication. Provider branch selection and source integrity stay here. */
export const openClaudeCapture = (archive: Archive, request: SourceOpenRequestV2): Effect.Effect<SourceCaptureViewV2, ClaudeArchiveError> => Effect.tryPromise({
  try: async () => {
    let readSignal: AbortSignal | undefined
    const started = performance.now(), check = () => {
      request.signal.throwIfAborted()
      readSignal?.throwIfAborted()
      if (performance.now() - started >= request.limits.durationMs) fail("limit", "Claude source view exceeded its deadline.")
    }
    const diagnostics = new SourceDiagnostics(), candidates = await sourceCandidates(archive, request.signal, diagnostics)
    const candidate = candidates.find(candidate => candidate.sessionId === request.sourceId)
    if (!candidate) fail("io", "The selected Claude source is unavailable or ambiguous.")
    const previous = captureCheckpoint(request.priorCheckpoint)
    const legacy = request.legacyCheckpoint === undefined ? undefined : decodeDiscoveryCursor(request.legacyCheckpoint).sessions.find(item => item.checkpoint.sessionId === request.sourceId)?.checkpoint
    if (request.legacyCheckpoint !== undefined && !legacy) fail("cursor", "The selected source is absent from its Claude legacy checkpoint.")
    const pins = new Map((legacy?.children ?? []).map(child => [child.agentId, child]))
    const root = await indexCaptureStream(candidate.file, undefined, "root", request.limits, request.signal, diagnostics, pins,
      previous?.streams.find(stream => stream.threadId === "root"), legacy, check)
    const origin = sourceOrigin(root.root)
    if (previous && (previous.sessionId !== origin.sourceId || previous.rootUuid !== origin.originKey || previous.origin !== origin.cwd))
      fail("changed", "Claude source creation Origin changed.")
    const streams = [root], attemptedChildren = new Set<string>(), retainedThreadIds: string[] = [], threads: SourceCaptureViewV2["threads"][number][] = [
      { sourceThreadId: "root", label: "Main", summary: "", captureStatus: "partial" }
    ]
    for (const child of root.children) {
      check()
      if (attemptedChildren.has(child.agentId)) continue
      attemptedChildren.add(child.agentId)
      if (threads.length === request.limits.threads) fail("limit", "Claude family exceeds its Thread admission.")
      const threadId = childThreadId(child.agentId), file = childFile(candidate.file, origin.sourceId, child.agentId)
      const prior = request.priorThreads.find(thread => thread.sourceThreadId === threadId)
      const fallback = { sourceThreadId: threadId, parentSourceThreadId: "root", label: `Agent ${child.agentId}`, summary: "", captureStatus: "partial" as const }
      if (prior && prior.parentSourceThreadId !== "root") fail("unsupported", "Claude retained child has conflicting parent metadata.")
      try {
        await validateChildDirectories(file)
        const remaining = request.limits.records - streams.reduce((count, stream) => count + stream.refs.length, 0)
        if (remaining < 1) fail("limit", "Claude family exceeds its complete source record admission.")
        const selected = await indexCaptureStream(file, root.root, threadId, { ...request.limits, records: remaining }, request.signal, diagnostics, pins,
          previous?.streams.find(stream => stream.threadId === threadId), legacy?.children?.find(value => value.agentId === child.agentId)?.checkpoint, check)
        streams.push(selected); threads.push(fallback)
      } catch (cause) {
        diagnostics.capture(file, cause, request.signal)
        if (prior) { retainedThreadIds.push(threadId); threads.push(prior) }
      }
    }
    if (request.rawEnabled) for (const node of root.nodes.values()) {
      const child = node.child
      if (!child || attemptedChildren.has(child.agentId)) continue
      attemptedChildren.add(child.agentId); check()
      const threadId = childThreadId(child.agentId), file = childFile(candidate.file, origin.sourceId, child.agentId)
      try {
        await validateChildDirectories(file)
        const remaining = request.limits.records - streams.reduce((count, stream) => count + stream.refs.length, 0)
        if (remaining < 1) fail("limit", "Claude family exceeds its complete source record admission.")
        const historical = await indexCaptureStream(file, root.root, threadId, { ...request.limits, records: remaining }, request.signal, diagnostics, pins,
          previous?.streams.find(stream => stream.threadId === threadId), legacy?.children?.find(value => value.agentId === child.agentId)?.checkpoint, check)
        // An abandoned receipt still proves its physical child source for Raw
        // backfill. It grants no current Thread, link, Event or usage membership.
        streams.push({ ...historical, selected: new Set(), latestUsage: new Map(), events: 0, usage: 0 })
      } catch (cause) { diagnostics.capture(file, cause, request.signal) }
    }
    const linkedThreads = new Set(threads.map(thread => thread.sourceThreadId))
    const eventCount = streams.reduce((count, stream) => count + stream.events, 0), usageCount = streams.reduce((count, stream) => count + stream.usage, 0)
    if (eventCount > request.projection.events || usageCount > request.projection.usage) fail("limit", "Claude complete projection exceeds its admission.")
    const proofs = new Map((previous?.streams ?? []).map(proof => [proof.threadId, proof]))
    // Preserve proofs for formerly captured children even when their receipt is
    // outside this selected path. Reappearance does not legitimize changed bytes.
    for (const stream of streams) proofs.set(stream.threadId, stream.proof)
    for (const child of legacy?.children ?? []) if (child.checkpoint?.stream?.seen[0] && !proofs.has(childThreadId(child.agentId))) proofs.set(childThreadId(child.agentId), {
      threadId: childThreadId(child.agentId), bytes: child.checkpoint.bytes, digest: child.checkpoint.digest, rootUuid: child.checkpoint.stream.seen[0]
    })
    if (proofs.size > 1000) fail("limit", "Claude source proof exceeds its Thread capacity.")
    const sourceCheckpoint = JSON.stringify({ v: 1, sessionId: origin.sourceId, origin: origin.cwd, rootUuid: origin.originKey, streams: [...proofs.values()] } satisfies CaptureCheckpoint)
    if (Buffer.byteLength(sourceCheckpoint) > MaxCursorBytes) fail("limit", "Claude source checkpoint exceeds its metadata capacity.")
    const observedAt = streams.filter(stream => linkedThreads.has(stream.threadId)).map(stream => stream.observedAt).sort().at(-1)!
    const header = { profile: captureProfile, origin, sourceCheckpoint,
      session: { sourceSessionId: origin.sourceId, title: rootTitle(root.root), summary: "Claude Code conversation", insight: "",
        actor: { name: "User", harness: "Claude Code" }, branch: string(root.root.gitBranch) ?? "", status: "active" as const,
        captureStatus: "partial" as const, updatedAt: observedAt, reportedEventCount: eventCount },
      threads, target: { events: eventCount, usage: usageCount, threads: threads.length, retainedThreadIds },
      ...diagnostics.snapshot() }
    if (Buffer.byteLength(JSON.stringify(header)) > request.projection.pageBytes) fail("limit", "Claude source metadata exceeds its page admission.")
    let disposed = false, failed = false, streamIndex = 0, refIndex = 0, order = 0, emittedUsage = 0, frameCount = 0
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let calls = new Map<string, SourceCall>()
    let pending: { frames: SourceCaptureFrame[]; at: number } | undefined
    const close = async () => { disposed = true; const current = handle; handle = undefined; if (current) await current.close() }
    const byStart = streams.map(stream => new Map([...stream.nodes.values()].map(node => [node.ref.start, node])))
    const envelope = Buffer.byteLength(JSON.stringify({ frames: [], done: false }))
    const makeFrames = async (stream: CaptureStream, ref: RecordRef): Promise<SourceCaptureFrame[]> => {
      const bytes = Buffer.alloc(ref.end - ref.start)
      for (let at = 0; at < bytes.length;) {
        check(); const read = await handle!.read(bytes, at, bytes.length - at, ref.start + at)
        if (!read.bytesRead) fail("changed", "Claude source was truncated while reading its view.")
        at += read.bytesRead
      }
      if (digest(bytes) !== ref.digest) fail("changed", "Claude source changed while reading its view.")
      const node = byStart[streamIndex]!.get(ref.start)
      let events: SourceCaptureFrame["events"][number][] = [], usage: SourceCaptureFrame["usage"][number][] = []
      if (node && stream.selected.has(ref.start) && !node.rawOnly) {
        const record = parseSourceRecord(bytes), projected = projectRecord(record, 0, ref.end, "source-view", calls)
        events = projected.events.map(event => {
          const { revision: _revision, projectionRevision: _projection, rawRef: _raw, ...draft } = event
          return { ...draft, sourceThreadId: stream.threadId, sourceOrder: order, eventIndex: order++, orderFidelity: "derived" as const,
            ...(node.child && linkedThreads.has(childThreadId(node.child.agentId)) ? { childSourceThreadId: childThreadId(node.child.agentId) } : {}) }
        })
        const sample = projectUsage(record, ref.end)
        if (sample && stream.latestUsage.get(sample.sourceUsageId) === ref.start) {
          const { revision: _revision, ...draft } = sample
          usage = [{ ...draft, sourceThreadId: stream.threadId }]; emittedUsage++
        }
      }
      const frames: SourceCaptureFrame[] = []
      let atEvent = 0, atUsage = 0, part = 0
      const physicalKey = `claude_${digest(Buffer.from(JSON.stringify([stream.threadId, ref.start, ref.end, 0])))}`
      do {
        // Give the Host the complete physical record before redaction. Splitting
        // unmasked strings could hide a credential across transport boundaries.
        const raw = request.rawEnabled ? { format: part === 0 ? "claude.jsonl.v1" : "claude.record-reference.v1", sourceThreadId: stream.threadId,
          sourceName: stream.threadId === "root" ? `${origin.sourceId}.jsonl` : `agent-${stream.threadId.slice("claude-agent:".length)}.jsonl`,
          recordStart: ref.start, recordEnd: ref.end, ...(part === 0 ? { jsonl: new TextDecoder("utf-8", { fatal: true }).decode(bytes) } : { recordKey: physicalKey }) } : undefined
        const frameEvents: SourceCaptureFrame["events"][number][] = [], frameUsage: SourceCaptureFrame["usage"][number][] = []
        const frame: SourceCaptureFrame = { recordKey: `claude_${digest(Buffer.from(JSON.stringify([stream.threadId, ref.start, ref.end, part])))}`,
          events: frameEvents, usage: frameUsage, ...(raw === undefined ? {} : { raw }) }
        const fits = () => { check(); return Buffer.byteLength(JSON.stringify(frame)) + envelope <= request.projection.pageBytes }
        if (!fits()) fail("limit", "Claude Raw fragment exceeds its page admission.")
        while (atEvent < events.length && frame.events.length < 500) {
          frameEvents.push(events[atEvent]!); if (!fits()) { frameEvents.pop(); break } atEvent++
        }
        while (atUsage < usage.length && frame.usage.length < 500) {
          frameUsage.push(usage[atUsage]!); if (!fits()) { frameUsage.pop(); break } atUsage++
        }
        if (part > 0 && !frame.events.length && !frame.usage.length && (atEvent < events.length || atUsage < usage.length))
          fail("limit", "Claude projected record cannot fit its page admission.")
        frames.push(frame); part++
      } while (atEvent < events.length || atUsage < usage.length)
      return frames
    }
    return { ...header, close,
      read: async signal => {
        try {
          if (disposed || failed) fail("unsupported", "A closed or failed Claude source view must be abandoned.")
          readSignal = signal; signal.throwIfAborted(); check()
          const frames: SourceCaptureFrame[] = []; let bytes = envelope
          while (frames.length < request.projection.pageItems) {
            if (!pending) {
              const stream = streams[streamIndex]
              if (!stream) break
              if (!handle) {
                handle = await open(stream.file, constants.O_RDONLY | constants.O_NOFOLLOW)
                await authenticateSource(handle, stream.proof, (await handle.stat()).size, signal)
              }
              const ref = stream.refs[refIndex]
              if (!ref) {
                await authenticateSource(handle, stream.proof, (await handle.stat()).size, signal)
                await handle.close(); handle = undefined; streamIndex++; refIndex = 0; calls = new Map(); continue
              }
              pending = { frames: await makeFrames(stream, ref), at: 0 }; refIndex++
            }
            const frame = pending.frames[pending.at]!, size = Buffer.byteLength(JSON.stringify(frame)) + (frames.length ? 1 : 0)
            if (bytes + size > request.projection.pageBytes) break
            if (++frameCount > request.limits.records) fail("limit", "Claude source frames exceed their record admission.")
            frames.push(frame); bytes += size; pending.at++
            if (pending.at === pending.frames.length) pending = undefined
          }
          const done = streamIndex === streams.length && pending === undefined
          if (done && (order !== eventCount || emittedUsage !== usageCount)) fail("format", "Claude source projection passes disagree.")
          return { frames, done }
        } catch (cause) { failed = true; await close(); throw captureFailure(cause) }
      }
    }
  }, catch: captureFailure
})
