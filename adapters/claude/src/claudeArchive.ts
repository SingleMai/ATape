import type { AcpSessionUpdate, AdapterCollectRequest, AdapterCollectionPage, AdapterEvent, AdapterObservation, AdapterOpenContext, AdapterUsage } from "@atape/domain"
import { Effect, Schema } from "effect"
import { GitAttributionVersion, isBoundedToolValue, MaxSourceFailures, type AdapterSourceFailure } from "@atape/domain"
import { createHash, type Hash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath, stat } from "node:fs/promises"
import { deflateRawSync, inflateRawSync } from "node:zlib"
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
type Compaction = typeof CompactionSchema.Type
const AutoTextSchema = Schema.Struct({
  v: Schema.Literal(1), boundaryUuid: Schema.String, summaryUuid: Schema.String,
  promptId: Schema.String, slug: Schema.String
})
type AutoText = typeof AutoTextSchema.Type
const ReadPairSchema = Schema.Struct({
  v: Schema.Literal(1), firstResultUuid: Schema.String, secondCallUuid: Schema.String,
  secondToolId: Schema.String, secondFilePath: Schema.String, promptId: Schema.String
})
type ReadPair = typeof ReadPairSchema.Type
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
type Archive = { readonly context: AdapterOpenContext; readonly file: string | undefined; readonly projects: string; readonly project: string; inventory?: Candidate[]; hashCache?: { file: string; stamp: string; bytes: number; digest: string; hash: Hash } }
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
    const acknowledged = new Map(request.rawProgress.map(item => [item.sourceObjectId, item.sourceOffset]))
    for (const observation of page.observations) for (const raw of observation.rawSegments)
      acknowledged.set(raw.sourceObjectId, raw.sourceOffset + Buffer.byteLength(raw.content))
    const streams = inventory.flatMap(candidate => {
      const checkpoint = state.sessions.find(item => item.checkpoint.sessionId === candidate.sessionId)?.checkpoint
      return [{ ...candidate, checkpoint, agentId: undefined as string | undefined }, ...(checkpoint?.children ?? []).map(child => ({
        file: childFile(candidate.file, candidate.sessionId, child.agentId), sessionId: candidate.sessionId, checkpoint: child.checkpoint, agentId: child.agentId
      }))]
    })
    let pendingRawBytes = 0, pendingCanonicalSessions = 0
    for (let start = 0; start < streams.length; start += 8) {
      const sizes = await Promise.all(streams.slice(start, start + 8).map(async candidate => {
        try { return { candidate, size: (await stat(candidate.file)).size } }
        catch { return { candidate, size: undefined } }
      }))
      for (const { candidate, size } of sizes) {
        if (size === undefined) continue
        const checkpoint = candidate.checkpoint, first = checkpoint?.stream?.seen[0]
        const generation = checkpoint && first ? digest(Buffer.from(JSON.stringify(candidate.agentId
          ? [candidate.sessionId, checkpoint.origin, first, candidate.agentId] : [candidate.sessionId, checkpoint.origin, first]))) : undefined
        const sourceObjectId = `${candidate.agentId ? "claude-agent-rollout" : "claude-rollout"}-${generation}`
        if (request.rawCaptureEnabled !== false) pendingRawBytes += Math.max(0, size - (acknowledged.get(sourceObjectId) ?? 0))
        if (!checkpoint?.stream || checkpoint.projectionRevision !== ProjectionRevision || checkpoint.usageVersion !== 1 || !checkpoint.observedAt ||
          checkpoint.bytes < size || checkpoint.stream.eventSkip > 0 ||
          checkpoint.stream.continuation && checkpoint.stream.continuation.phase !== "resume" ||
          !checkpoint.normalizationVersion && (checkpoint.stream.compaction && checkpoint.stream.compaction.phase !== "resume" ||
            checkpoint.stream.autoText || checkpoint.stream.readPair)) pendingCanonicalSessions++
      }
    }
    return { ...page, progress: { sourceFiles: streams.length, pendingRawBytes, pendingCanonicalSessions,
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
      page = await collectFamily(archive, candidate, previous?.checkpoint, request, diagnostics)
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

const childThreadId = (agentId: string) => `claude-agent:${agentId}`
const currentStream = (cursor: Cursor | undefined) =>
  cursor?.projectionRevision === ProjectionRevision && cursor.usageVersion === 1 && cursor.observedAt ? cursor.stream : undefined
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
const familyThreads = (children: ReadonlyArray<Child>) => [
  { sourceThreadId: "root", revision: 1, label: "Main", summary: "", captureStatus: "partial" as const },
  ...children.map(child => ({ sourceThreadId: childThreadId(child.agentId), parentSourceThreadId: "root", revision: 1,
    label: `Agent ${child.agentId}`, summary: "", captureStatus: "partial" as const }))
]

async function collectFamily(archive: Archive, candidate: Candidate, previous: Cursor | undefined, request: AdapterCollectRequest,
  diagnostics: SourceDiagnostics): Promise<AdapterCollectionPage> {
  const page = await collectSession(archive, candidate.file, { ...request, cursor: previous ? JSON.stringify(previous) : null }, diagnostics)
  const publish = (page: AdapterCollectionPage, checkpoint: Cursor): AdapterCollectionPage => {
    const observation = page.observations[0]!
    const children = checkpoint.children ?? []
    const revision = children.length ? Math.max(previous?.familyRevision ?? (previous ? previous.bytes * 2 + 3 : 0), observation.session.revision) + 1
      : observation.session.revision
    if (!Number.isSafeInteger(revision)) fail("limit", "Claude family revision exceeds its safe capacity.")
    if (children.length + 1 > request.limits.threadsPerObservation) fail("limit", "Claude family exceeds the requested Thread limit.")
    const updatedAt = [previous?.familyObservedAt, checkpoint.observedAt, observation.session.updatedAt].filter((at): at is string => at !== undefined).sort().at(-1)!
    const next = { ...checkpoint, ...(children.length ? { familyRevision: revision, familyObservedAt: updatedAt } : {}) }
    const captured = { ...observation, observationId: `claude-${digest(Buffer.from(JSON.stringify([observation.observationId, next])))}`,
      session: { ...observation.session, revision, updatedAt, title: checkpoint.stream?.title || observation.session.title }, threads: familyThreads(children) }
    if (Buffer.byteLength(JSON.stringify({ ...captured, rawSegments: [] })) > request.limits.canonicalBytesPerObservation)
      fail("limit", "Claude family metadata exceeds the requested Canonical page limit.")
    return { ...page, nextCursor: JSON.stringify(next), hasMore: page.hasMore || children.some(child => !currentStream(child.checkpoint)),
      observations: [captured] }
  }
  if (page.observations.length) {
    const checkpoint = decodeCursor(page.nextCursor)!
    await restoreCapturedChildDiagnostics(candidate.file, checkpoint, request.signal, diagnostics)
    return publish(page, checkpoint)
  }
  if (!previous?.children?.length) return page
  const root = await readHeader(candidate.file, request.signal)
  if (!root) fail("changed", "The captured Claude root disappeared.")
  const children = previous.children, pivot = children.findIndex(child => child.agentId === previous.childAfter)
  const visitedChildren = new Set<string>()
  for (const child of [...children.slice(pivot + 1), ...children.slice(0, pivot + 1)]) {
    const file = childFile(candidate.file, candidate.sessionId, child.agentId)
    visitedChildren.add(child.agentId)
    try {
      await validateChildDirectories(file)
      const selected = await collectSession(archive, file, { ...request, cursor: child.checkpoint ? JSON.stringify(child.checkpoint) : null }, diagnostics,
        { child, root, children })
      if (!selected.observations.length) continue
      const checkpoint = decodeCursor(selected.nextCursor)!
      const next = { ...previous, childAfter: child.agentId,
        children: children.map(value => value === child ? { ...value, checkpoint } : value) }
      await restoreCapturedChildDiagnostics(candidate.file, next, request.signal, diagnostics, visitedChildren)
      return publish({ ...selected, hasMore: selected.hasMore || children.length > 1 }, next)
    } catch (cause) {
      if (child.checkpoint && object(cause)?.code === "ENOENT") continue // Deleting captured sources does not delete history.
      diagnostics.capture(file, cause, request.signal)
    }
  }
  return page
}

/** A root page must not hide already committed child diagnostics. Inspect only
 * authenticated captured prefixes, never a proposed child or pending suffix. */
async function restoreCapturedChildDiagnostics(rootFile: string, family: Cursor, signal: AbortSignal,
  diagnostics: SourceDiagnostics, visited: ReadonlySet<string> = new Set()): Promise<void> {
  const children = family.children ?? []
  for (const child of children) {
    const checkpoint = child.checkpoint
    if (!checkpoint || visited.has(child.agentId)) continue
    signal.throwIfAborted()
    const file = childFile(rootFile, family.sessionId, child.agentId)
    try {
      await validateChildDirectories(file)
      const root = await readHeader(file, signal)
      if (!root || root.type !== "user" || root.parentUuid !== null || root.isMeta === true ||
        typeof root.cwd !== "string" || typeof root.sessionId !== "string")
        fail("changed", "The captured Claude prefix changed or was truncated.")
      if (root.isSidechain !== true || root.agentId !== child.agentId || root.sessionId !== family.sessionId || root.cwd !== family.origin)
        fail("unsupported", "Claude subagent identity or original CWD does not match its proven parent.")
      if (root.sessionId !== checkpoint.sessionId || root.cwd !== checkpoint.origin)
        fail("changed", "Claude session identity or original CWD changed.")
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        if (!before.isFile()) fail("format", "Claude source is not a regular file.")
        if (before.size < checkpoint.bytes) fail("changed", "The captured Claude prefix changed or was truncated.")
        let unlinked = false
        await restoreNormalization(handle, checkpoint.bytes, checkpoint.digest, root, checkpoint.stream, signal, (record, calls) => {
          const relationship = bindChild(record, calls, true, children, family.sessionId)
          unlinked ||= relationship.unlinked
        })
        const after = await handle.stat()
        if (after.size < before.size || after.ino !== before.ino || after.size === before.size && after.mtimeMs !== before.mtimeMs)
          fail("changed", "Claude source changed during reading.")
        if (unlinked) diagnostics.add(file, "unsupported")
      } finally { await handle.close() }
    } catch (cause) {
      if (object(cause)?.code === "ENOENT") continue
      diagnostics.capture(file, cause, signal)
    }
  }
}

async function collectSession(archive: Archive, file: string, request: AdapterCollectRequest, diagnostics: SourceDiagnostics,
  delegated?: { readonly child: Child; readonly root: RecordValue; readonly children: ReadonlyArray<Child> }): Promise<AdapterCollectionPage> {
  const cursor = decodeCursor(request.cursor)
  const root = await readHeader(file, request.signal)
  if (!root || root.type !== "user" || root.parentUuid !== null || root.isMeta === true || typeof root.cwd !== "string" || typeof root.sessionId !== "string") {
    if (cursor) fail("changed", "The captured Claude prefix changed or was truncated.")
    fail("unsupported", "Claude session has no supported original user root and CWD.")
  }
  const sessionId = root.sessionId as string, origin = root.cwd as string
  if (delegated && (root.isSidechain !== true || root.agentId !== delegated.child.agentId || sessionId !== delegated.root.sessionId || origin !== delegated.root.cwd)) {
    fail("unsupported", "Claude subagent identity or original CWD does not match its proven parent.")
  }
  if (cursor && (cursor.sessionId !== sessionId || cursor.origin !== origin)) fail("changed", "Claude session identity or original CWD changed.")
  if (!delegated && !await belongsToProject(archive, root, request.signal)) return empty(request.cursor)
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
    const resume = currentStream(cursor)
    const generation = digest(Buffer.from(JSON.stringify(delegated ? [sessionId, origin, root.uuid, delegated.child.agentId] : [sessionId, origin, root.uuid])))
    const sourceObjectId = `${delegated ? "claude-agent-rollout" : "claude-rollout"}-${generation}`
    // Normalization and Event projection are independent versions. Validate
    // already-normalized source facts before the existing projection/usage
    // backfill path starts again at byte zero.
    const children = new Map((cursor?.children ?? []).map(child => [child.agentId, child]))
    let restoredUnlinked = false
    const restoreRelationships = (record: RecordValue, calls: ReadonlyMap<string, { name: string; uuid: string }>) => {
      const relationship = bindChild(record, calls, delegated !== undefined, delegated?.children ?? [...children.values()], sessionId)
      restoredUnlinked ||= relationship.unlinked
    }
    if (cursor && !resume) {
      const previous = await restoreNormalization(handle, cursor.bytes, cursor.digest, root, cursor.stream, request.signal, restoreRelationships)
      if (cursor.normalizationVersion === 1 && !equalJson(cursor.stream?.continuation, previous.continuation))
        fail("cursor", "Claude checkpoint continuation does not match its committed source.")
      await validatePendingProjection(handle, before.size, cursor, root, previous, sourceObjectId, request.signal,
        delegated !== undefined, delegated?.children ?? [...children.values()])
    }
    let at = resume ? cursor!.bytes : 0
    if (!resume) hash = createHash("sha256")
    let state: NonNullable<Cursor["stream"]> = resume ?? { lastUuid: null, seen: [], calls: [], order: 0, eventSkip: 0, title: rootTitle(root) }
    const seen = new Set(state.seen)
    // Family headers are repeated on root and child pages. Reserve their actual
    // encoded size as well as the Session and array-envelope headroom.
    const payloadLimit = (family: ReadonlyArray<Child>) => request.limits.canonicalBytesPerObservation - 8192
      - Buffer.byteLength(JSON.stringify(familyThreads(family)))
    let canonicalLimit = payloadLimit(delegated?.children ?? [...children.values()])
    let calls = new Map(state.calls.map(([id, name, uuid]) => [id, { name, uuid }]))
    const normalization = await restoreNormalization(handle, at, hash.copy().digest("hex"), root, resume, request.signal, restoreRelationships)
    if (cursor?.normalizationVersion === 1 && !equalJson(state.continuation, normalization.continuation))
      fail("cursor", "Claude checkpoint continuation does not match its committed source.")
    // Report only after the complete restored prefix has authenticated. These
    // source-derived diagnostics remain visible on idle scans after restart.
    if (restoredUnlinked) diagnostics.add(file, "unsupported")
    const adoptedNormalization = !!resume && cursor?.normalizationVersion !== 1
    const { compaction: _legacyManual, autoText: _legacyAuto, readPair: _legacyPair, continuation: _oldContinuation, ...normalizedState } = state
    state = { ...normalizedState, ...(normalization.continuation ? { continuation: normalization.continuation } : {}) }
    const events: AdapterEvent[] = []
    const usage = new Map<string, AdapterUsage>()
    const rawProgress = request.rawProgress.find(p => p.sourceSessionId === sessionId && p.sourceObjectId === sourceObjectId && p.sourceGeneration === generation)
    const acknowledged = rawProgress?.sourceOffset ?? 0
    let rawBytes = 0, eventBytes = 0, partial = false, hasMore = false, approvedPendingRecord = false
    for await (const line of readRecords(handle, at, before.size, request.signal)) {
      if (line.content.length + rawBytes > Math.min(request.limits.rawSegmentBytes, request.limits.rawBytesPerObservation)) {
        if (rawBytes === 0 && events.length === 0) fail("limit", "A Claude JSONL record exceeds the requested Raw page limit.")
        hasMore = true; break
      }
      if (line.content.toString("utf8").trim() === "") {
        if (state.eventSkip !== 0) fail("cursor", "Claude checkpoint has no complete pending conversation record.")
        hash.update(line.content); rawBytes += line.content.length; at = line.end
        continue
      }
      let record: RecordValue
      try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.content))) }
      catch { fail("format", "Claude source contains a malformed complete JSONL record.") }
      if (record.sessionId !== undefined && record.sessionId !== sessionId) fail("unsupported", "Mixed Claude session identities are not supported.")
      const conversation = record.type === "user" || record.type === "assistant"
      const identified = record.uuid !== undefined || conversation
      const wrongThread = delegated ? identified && (record.isSidechain !== true || record.agentId !== delegated.child.agentId)
        : record.isSidechain === true || identified && (record.isSidechain !== undefined && record.isSidechain !== false || record.agentId !== undefined)
      if (wrongThread)
        fail("unsupported", "Claude record does not belong to its selected Thread.")
      const transition = await normalizeSourceRecord(handle, record, root, normalization, request.signal)
      if (!transition.rawOnly) approvedPendingRecord = true
      if (state.eventSkip !== 0) {
        if (transition.rawOnly || timestamp(record.timestamp) !== cursor?.observedAt)
          fail("cursor", "Claude checkpoint has no admitted pending conversation record.")
        approvedPendingRecord = true
      }
      // Events and usage share the same admitted conversation identity. Native
      // UUID-less bookkeeping stays Raw-only; it cannot stand in for a turn.
      if (conversation && (typeof record.uuid !== "string" || !record.uuid.trim() || record.uuid.length > 500 || record.uuid.includes("\0")))
        fail("unsupported", "Claude conversation record has no valid UUID.")
      // Attribution selects the original identity before this handle is opened.
      // Compare that identity with the actual first committed UUID record; its
      // bytes subsequently participate in the current-prefix proof as usual.
      if (typeof record.uuid === "string" && seen.size === 0 && (record.uuid !== root.uuid || record.type !== "user" ||
        record.parentUuid !== null || record.isMeta === true || record.sessionId !== sessionId || record.cwd !== origin))
        fail("changed", "Claude original identity changed during collection.")
      const nextCalls = new Map(calls)
      const projected = transition.rawOnly ? { events: [] as AdapterEvent[], partial: true }
        : projectRecord(record, state.order, line.end, sourceObjectId, nextCalls)
      const relationship = transition.rawOnly ? undefined
        : bindChild(record, nextCalls, delegated !== undefined, delegated?.children ?? [...children.values()], sessionId)
      const child = relationship?.child
      if (child) {
        childFile(file, sessionId, child.agentId) // Validate before publishing the relation.
        // The native foreground receipt is one tool-result Event. Commit its
        // relation only with that complete record's captured prefix, never when
        // a full page defers the receipt to the next request.
        projected.events = projected.events.map(event => "toolCallId" in event.update && event.update.toolCallId === child.toolCallId
          ? { ...event, childSourceThreadId: childThreadId(child.agentId) } : event)
      }
      if (delegated) projected.events = projected.events.map(event => ({ ...event, sourceThreadId: childThreadId(delegated.child.agentId) }))
      // A new receipt needs room for its proposed header before any Event is
      // admitted. A deferred record must leave the pinned family unchanged.
      const recordLimit = child && !children.has(child.agentId) ? payloadLimit([...children.values(), child]) : canonicalLimit
      partial ||= projected.partial
      let skip = state.eventSkip
      if (skip > projected.events.length) fail("cursor", "Claude record checkpoint exceeds its event count.")
      while (skip < projected.events.length) {
        const event = projected.events[skip]!
        const size = Buffer.byteLength(JSON.stringify(event))
        if (size > recordLimit) fail("limit", "A Claude event exceeds the Canonical observation limit.")
        if (events.length === request.limits.eventsPerObservation || eventBytes + size > recordLimit) break
        events.push(event); eventBytes += size; skip++
      }
      if (skip < projected.events.length) { state = { ...state, eventSkip: skip }; hasMore = true; break }
      const originalSample = transition.rawOnly ? undefined : projectUsage(record, line.end)
      const sample = originalSample && delegated ? { ...originalSample, sourceThreadId: childThreadId(delegated.child.agentId) } : originalSample
      if (sample) {
        const bytes = Buffer.byteLength(JSON.stringify(sample))
        if (bytes > recordLimit) fail("limit", "A Claude usage sample exceeds the Canonical observation limit.")
        if (usage.size >= request.limits.eventsPerObservation || eventBytes + bytes > recordLimit) {
          state = { ...state, eventSkip: skip }; hasMore = true; break
        }
        usage.set(sample.sourceUsageId, sample); eventBytes += bytes
      }
      if (!state.title) {
        const first = projected.events.find(e => e.update.sessionUpdate === "user_message_chunk")
        if (first && "content" in first.update && first.update.content.type === "text") state = { ...state, title: first.update.content.text.replace(/\s+/g, " ").trim().slice(0, 80) }
      }
      commitNormalizedRecord(normalization, record, recordRef(at, line.content), transition)
      if (relationship?.unlinked) diagnostics.add(file, "unsupported")
      if (typeof record.uuid === "string") seen.add(record.uuid)
      if (child && !children.has(child.agentId)) { children.set(child.agentId, child); canonicalLimit = recordLimit }
      calls = nextCalls
      const { continuation: _previousContinuation, ...committedState } = state
      state = { ...committedState, ...(normalization.continuation ? { continuation: normalization.continuation } : {}),
        lastUuid: normalization.leaf, order: normalization.order, eventSkip: 0 }
      hash.update(line.content); rawBytes += line.content.length; at = line.end
      if (transition.copy || transition.kind !== "ordinary" || events.length === request.limits.eventsPerObservation) {
        hasMore = at < before.size; break
      }
    }
    if (state.eventSkip !== 0 && !approvedPendingRecord)
      fail("cursor", "Claude checkpoint has no complete pending conversation record.")
    if (!adoptedNormalization && events.length === 0 && rawBytes === 0 && (request.rawCaptureEnabled === false || acknowledged >= at)) return empty(request.cursor)
    const capturedRaw = request.rawCaptureEnabled === false || acknowledged >= at ? undefined
      : await readRawPrefix(handle, acknowledged, at, Math.min(request.limits.rawSegmentBytes, request.limits.rawBytesPerObservation), request.signal)
    hasMore ||= capturedRaw !== undefined && acknowledged + Buffer.byteLength(capturedRaw) < at
    const after = await handle.stat()
    if (after.size < before.size || after.ino !== before.ino || after.size === before.size && after.mtimeMs !== before.mtimeMs) fail("changed", "Claude source changed during reading.")
    const prefixDigest = hash.copy().digest("hex")
    archive.hashCache = { file, stamp, bytes: at, digest: prefixDigest, hash: hash.copy() }
    const observedAt = events.at(-1)?.occurredAt ?? cursor?.observedAt ?? timestamp(root.timestamp) ?? new Date(before.mtimeMs).toISOString()
    const next: Cursor = { v: 1, sessionId, origin, bytes: at, digest: prefixDigest, projectionRevision: ProjectionRevision, usageVersion: 1, normalizationVersion: 1, observedAt,
      publication: (cursor?.publication ?? 0) + 1,
      ...(!delegated && children.size ? { children: [...children.values()], ...(cursor?.childAfter ? { childAfter: cursor.childAfter } : {}) } : {}),
      stream: { ...state, seen: [...seen], calls: [...calls].map(([id, call]) => [id, call.name, call.uuid]) } }
    // Thinking can advance updatedAt at the same captured bytes as projection 4.
    // Its Session snapshot needs a newer revision even though Event bytes stay fixed.
    const revision = Math.max(at, events.at(-1)?.revision ?? 1) * 2 + 4
    return { protocolVersion: request.protocolVersion, nextCursor: JSON.stringify(next), hasMore,
      observations: [{ observationId: `claude-${digest(Buffer.from(JSON.stringify([next, events.map(e => e.sourceEventId)])))}`, observedAt,
        session: { sourceSessionId: sessionId, revision, title: state.title || "Untitled Claude conversation", summary: "Claude Code conversation", insight: "",
          actor: { name: "User", harness: "Claude Code" }, branch: string((delegated?.root ?? root).gitBranch) ?? "", status: "active", captureStatus: "partial", updatedAt: observedAt, reportedEventCount: 0 },
        threads: [{ sourceThreadId: "root", revision: 1, label: "Main", summary: "", captureStatus: "partial" }], events,
        usage: [...usage.values()],
        rawSegments: capturedRaw !== undefined ? [{ sourceObjectId, sourceGeneration: generation, sourceOffset: acknowledged,
          sourceName: delegated ? `agent-${delegated.child.agentId}.jsonl` : `${sessionId}.jsonl`, mediaType: "application/x-ndjson", content: capturedRaw, final: false }] : []
      }] }
  } finally { await handle.close() }
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
type SourceCall = { readonly uuid: string; readonly name: string; readonly path?: string }
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
      const call = { uuid: uuid!, name: block.name, ...(typeof object(block.input)?.file_path === "string" ? { path: object(block.input)!.file_path as string } : {}) }
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
  onOrdinaryRecord?: (record: RecordValue, calls: ReadonlyMap<string, SourceCall>) => void): Promise<Normalization> {
  const context: Normalization = { records: new Map(), calls: new Map(), leaf: null, order: 0, continuation: undefined, response: undefined }
  const hash = createHash("sha256")
  let at = 0
  for await (const line of readRecords(handle, 0, committed, signal)) {
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
  delegated: boolean, children: ReadonlyArray<Child>): Promise<void> {
  const skip = cursor.stream?.eventSkip ?? 0
  if (skip === 0) return
  for await (const line of readRecords(handle, cursor.bytes, size, signal)) {
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
/** The foreground relation needs one projected result Event. Unknown Raw-only
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
function bindChild(record: RecordValue, calls: ReadonlyMap<string, { name: string; uuid: string }>, delegated: boolean,
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
  if (result?.status !== "completed" || result.isAsync !== undefined && result.isAsync !== false ||
    record.isAsync !== undefined && record.isAsync !== false || block.is_error !== undefined && block.is_error !== false ||
    record.sourceToolAssistantUUID !== call.uuid) return { unlinked: true }
  return { child: { agentId, toolCallId, toolUuid: call.uuid }, unlinked: false }
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
  calls: Map<string, { name: string; uuid: string }>, projectionRevision: 4 | 5 = ProjectionRevision): { events: AdapterEvent[]; partial: boolean } {
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
