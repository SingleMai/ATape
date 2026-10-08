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
const MaxWitnessRecordBytes = 64 * 1024
const MaxAutoGroupBytes = 256 * 1024
const MaxProofTailBytes = 256 * 1024
const MaxReadReplayTailBytes = 512 * 1024
const MaxReadReplayGroupBytes = 640 * 1024
const MaxRepeatedReadTailBytes = 4 * 1024 * 1024
const MaxRepeatedReadTailRecords = 64
const MaxManualReadReceiptBytes = 2 * 1024 * 1024
const MaxManualReadFileBytes = 1024 * 1024
const MaxManualReadFileGroupBytes = 2 * MaxManualReadFileBytes
const MaxManualReadBridgeGroupBytes = 2 * MaxWitnessRecordBytes
const MaxAutoTailRecords = 16
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
const StreamCursorSchema = Schema.Struct({
  v: Schema.Literal(1), sessionId: Schema.String, bytes: Schema.Number,
  digest: Schema.String, origin: Schema.String,
  projectionRevision: Schema.optionalKey(Schema.Number),
  usageVersion: Schema.optionalKey(Schema.Literal(1)),
  observedAt: Schema.optionalKey(Schema.String),
  publication: Schema.optionalKey(Schema.Number),
  stream: Schema.optionalKey(Schema.Struct({
    lastUuid: Schema.NullOr(Schema.String), seen: Schema.Array(Schema.String),
    calls: Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
    order: Schema.Number, eventSkip: Schema.Number, title: Schema.String,
    compaction: Schema.optionalKey(CompactionSchema), autoText: Schema.optionalKey(AutoTextSchema), readPair: Schema.optionalKey(ReadPairSchema)
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
        if (!checkpoint?.stream || checkpoint.usageVersion !== 1 || checkpoint.bytes < size || checkpoint.stream.eventSkip > 0 ||
          checkpoint.stream.compaction && checkpoint.stream.compaction.phase !== "resume" || checkpoint?.stream?.autoText || checkpoint?.stream?.readPair) pendingCanonicalSessions++
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
const childFile = (file: string, sessionId: string, agentId: string) => {
  if (!/^[A-Za-z0-9_-]{1,500}$/.test(sessionId)) fail("unsupported", "Claude family identity is not a safe source path component.")
  return join(dirname(file), sessionId, "subagents", `agent-${agentId}.jsonl`)
}
const familyThreads = (children: ReadonlyArray<Child>) => [
  { sourceThreadId: "root", revision: 1, label: "Main", summary: "", captureStatus: "partial" as const },
  ...children.map(child => ({ sourceThreadId: childThreadId(child.agentId), parentSourceThreadId: "root", revision: 1,
    label: `Agent ${child.agentId}`, summary: "", captureStatus: "partial" as const }))
]

async function collectFamily(archive: Archive, candidate: Candidate, previous: Cursor | undefined, request: AdapterCollectRequest,
  diagnostics: SourceDiagnostics): Promise<AdapterCollectionPage> {
  const page = await collectSession(archive, candidate.file, { ...request, cursor: previous ? JSON.stringify(previous) : null })
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
    return { ...page, nextCursor: JSON.stringify(next), hasMore: page.hasMore || children.some(child => !child.checkpoint),
      observations: [captured] }
  }
  if (page.observations.length) return publish(page, decodeCursor(page.nextCursor)!)
  if (!previous?.children?.length) return page
  const root = await readHeader(candidate.file, request.signal)
  if (!root) fail("changed", "The captured Claude root disappeared.")
  const children = previous.children, pivot = children.findIndex(child => child.agentId === previous.childAfter)
  for (const child of [...children.slice(pivot + 1), ...children.slice(0, pivot + 1)]) {
    const file = childFile(candidate.file, candidate.sessionId, child.agentId)
    try {
      for (const directory of [dirname(dirname(file)), dirname(file)]) {
        const details = await lstat(directory)
        if (!details.isDirectory() || details.isSymbolicLink()) fail("unsupported", "Claude subagent directories must not be symlinks.")
      }
      const selected = await collectSession(archive, file, { ...request, cursor: child.checkpoint ? JSON.stringify(child.checkpoint) : null },
        { child, root, children })
      if (!selected.observations.length) continue
      const checkpoint = decodeCursor(selected.nextCursor)!
      return publish({ ...selected, hasMore: selected.hasMore || children.length > 1 }, { ...previous, childAfter: child.agentId,
        children: children.map(value => value === child ? { ...value, checkpoint } : value) })
    } catch (cause) {
      if (child.checkpoint && object(cause)?.code === "ENOENT") continue // Deleting captured sources does not delete history.
      diagnostics.capture(file, cause, request.signal)
    }
  }
  return page
}

async function collectSession(archive: Archive, file: string, request: AdapterCollectRequest,
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
    const resume = cursor?.projectionRevision === 4 && cursor.usageVersion === 1 && cursor.observedAt ? cursor.stream : undefined
    let at = resume ? cursor!.bytes : 0
    if (!resume) hash = createHash("sha256")
    let state: NonNullable<Cursor["stream"]> = resume ?? { lastUuid: null, seen: [], calls: [], order: 0, eventSkip: 0, title: rootTitle(root) }
    const seen = new Set(state.seen)
    const children = new Map((cursor?.children ?? []).map(child => [child.agentId, child]))
    // Family headers are repeated on root and child pages. Reserve their actual
    // encoded size as well as the Session and array-envelope headroom.
    const payloadLimit = (family: ReadonlyArray<Child>) => request.limits.canonicalBytesPerObservation - 8192
      - Buffer.byteLength(JSON.stringify(familyThreads(family)))
    let canonicalLimit = payloadLimit(delegated?.children ?? [...children.values()])
    let calls = new Map(state.calls.map(([id, name, uuid]) => [id, { name, uuid }]))
    let adoptedPair = false
    const reversePending = state.readPair && (state.readPair.secondCallUuid === state.seen.at(-3) ||
      currentReadCalls([...seen].slice(0, -1), calls) && await plannedReadHint(handle, at, true, request.signal))
    if (reversePending)
      await reverseReadPair(handle, at, hash.copy().digest("hex"), root, [...seen], calls, request.signal, state.readPair)
    else if (!delegated && !state.readPair && !state.compaction && !state.autoText &&
      currentReadCalls([...seen].slice(0, -1), calls) && await plannedReadHint(handle, at, true, request.signal)) {
      if (state.eventSkip !== 0) fail("cursor", "Claude reverse Read checkpoint contains uncommitted Event progress.")
      state = { ...state, readPair: await reverseReadPair(handle, at, hash.copy().digest("hex"), root, [...seen], calls, request.signal) }
      adoptedPair = true
    }
    if (state.autoText && state.lastUuid !== state.autoText.summaryUuid)
      await repeatedReadWitness(handle, at, hash.copy().digest("hex"), root, [...seen], calls, "file", request.signal, state.autoText)
    const generation = digest(Buffer.from(JSON.stringify(delegated ? [sessionId, origin, root.uuid, delegated.child.agentId] : [sessionId, origin, root.uuid])))
    const sourceObjectId = `${delegated ? "claude-agent-rollout" : "claude-rollout"}-${generation}`
    const events: AdapterEvent[] = []
    const usage = new Map<string, AdapterUsage>()
    const rawProgress = request.rawProgress.find(p => p.sourceSessionId === sessionId && p.sourceObjectId === sourceObjectId && p.sourceGeneration === generation)
    const acknowledged = rawProgress?.sourceOffset ?? 0
    let rawBytes = 0, eventBytes = 0, partial = false, hasMore = adoptedPair && at < before.size, approvedFileAnswer = false
    // A previous producer may have ACKed the linear first reverse result. Its
    // adoption publishes only pending metadata, then validates the next result
    // on a separate page, including when that next record is already present.
    for await (const line of readRecords(handle, at, adoptedPair ? at : before.size, request.signal)) {
      if (line.content.length + rawBytes > Math.min(request.limits.rawSegmentBytes, request.limits.rawBytesPerObservation)) {
        if (rawBytes === 0 && events.length === 0) fail("limit", "A Claude JSONL record exceeds the requested Raw page limit.")
        hasMore = true; break
      }
      if (line.content.toString("utf8").trim() === "") {
        if (state.autoText && state.lastUuid !== state.autoText.summaryUuid && state.eventSkip !== 0)
          fail("cursor", "Claude automatic file checkpoint has no complete pending answer.")
        if (state.autoText) fail("unsupported", "Claude automatic compaction requires its first real answer.")
        if (state.readPair) fail("unsupported", "Claude Read pair requires its second result.")
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
      if (state.autoText) {
        const fileCommitted = state.lastUuid !== state.autoText.summaryUuid
        const witness = await repeatedReadWitness(handle, at, hash.copy().digest("hex"), root, [...seen], calls,
          fileCommitted ? "file" : "summary", request.signal, state.autoText)
        if (record.type === "attachment") {
          if (fileCommitted || !witness) fail("unsupported", "Claude automatic replay has no supported prior file continuation.")
          if (state.eventSkip !== 0) fail("cursor", "Claude automatic file checkpoint contains uncommitted Event progress.")
          if (line.content.length > MaxWitnessRecordBytes) fail("limit", "A Claude automatic prior-file record exceeds 64 KiB.")
          verifyRepeatedReadFile(record, root, witness, state.autoText.summaryUuid, [...seen])
          // The added frame must still fit the proof needed after a restart.
          // Validate the proposed prefix before publishing its opaque ACK.
          await repeatedReadWitness(handle, line.end, hash.copy().update(line.content).digest("hex"), root,
            [...seen, record.uuid as string], calls, "file", request.signal, state.autoText)
          seen.add(record.uuid as string)
          state = { ...state, lastUuid: record.uuid as string, order: state.order + 1, eventSkip: 0 }
          hash.update(line.content); rawBytes += line.content.length; at = line.end; hasMore = at < before.size
          break
        }
        if (witness && !fileCommitted) fail("unsupported", "Claude repeated Read requires its proved prior-file attachment.")
        if (witness && (witness.apiIds.includes(string(object(record.message)?.id) ?? "") || object(record.message)?.stop_reason !== "end_turn"))
          fail("unsupported", "Claude repeated Read requires a fresh completed answer API response.")
        verifyAutoTextAnswer(record, root, state.autoText, state.lastUuid)
        if (fileCommitted) {
          const occurredAt = timestamp(record.timestamp)
          if (!occurredAt) fail("unsupported", "Claude repeated Read answer requires a valid timestamp.")
          // A producer updates observedAt when it admits an Event fragment.
          // This is checkpoint self-consistency, not proof against forgery.
          if (state.eventSkip !== 0 && cursor?.observedAt !== occurredAt)
            fail("cursor", "Claude automatic file checkpoint has no admitted answer Event timestamp.")
          approvedFileAnswer = true
        }
      }
      const sourceBlocks = object(record.message)?.content
      const firstBlock = Array.isArray(sourceBlocks) ? object(sourceBlocks[0]) : undefined
      let nextReadPair: ReadPair | undefined
      if (state.readPair) {
        verifyReadReceipt(record, root, state.readPair.secondCallUuid, state.readPair.secondToolId, state.readPair.secondFilePath, state.readPair.promptId)
      } else if (!delegated && !state.compaction && !state.autoText && record.type === "user" && record.parentUuid === state.lastUuid &&
        firstBlock?.type === "tool_result" && currentReadCalls([...seen], calls) && await plannedReadHint(handle, at, false, request.signal)) {
        if (state.eventSkip !== 0) fail("cursor", "Claude reverse Read checkpoint contains uncommitted Event progress.")
        const pair = await readPairCalls(handle, at, hash.copy().digest("hex"), root, [...seen], calls, request.signal)
        verifyReadReceipt(record, root, pair[1].uuid, pair[1].toolId, pair[1].filePath)
        if (line.content.length > MaxWitnessRecordBytes) fail("limit", "A Claude first reverse Read receipt exceeds 64 KiB.")
        nextReadPair = await reverseReadPair(handle, line.end, hash.copy().update(line.content).digest("hex"), root,
          [...seen, record.uuid as string], calls, request.signal)
      } else if (record.type === "user" && record.parentUuid !== state.lastUuid && firstBlock?.type === "tool_result") {
        if (delegated || state.compaction || state.autoText) fail("unsupported", "Claude Read pair requires an unblocked root Thread.")
        if (state.eventSkip !== 0) fail("cursor", "Claude Read pair checkpoint contains uncommitted Event progress.")
        const pair = await readPairCalls(handle, at, hash.copy().digest("hex"), root, [...seen], calls, request.signal)
        verifyReadReceipt(record, root, pair[0].uuid, pair[0].toolId, pair[0].filePath)
        nextReadPair = { v: 1, firstResultUuid: record.uuid as string, secondCallUuid: pair[1].uuid,
          secondToolId: pair[1].toolId, secondFilePath: pair[1].filePath, promptId: record.promptId as string }
      }
      if (record.type === "user" && typeof record.uuid === "string" && seen.has(record.uuid)) {
        if (delegated || state.compaction || state.autoText || state.readPair)
          fail("unsupported", "Claude automatic replay requires an unblocked root Thread.")
        if (state.eventSkip !== 0) fail("cursor", "Claude replay checkpoint contains uncommitted Event progress.")
        const group = await readAutoGroup(handle, line, record, at, before.size, hash.copy().digest("hex"), root, [...seen], calls, request.signal)
        if (!group) break // An incomplete witness has no immediate continuation page or acknowledged copy bytes.
        const bytes = group.contents.reduce((total, content) => total + content.length, 0)
        const limit = Math.min(request.limits.rawSegmentBytes, request.limits.rawBytesPerObservation)
        if (bytes > limit) fail("limit", "A Claude automatic replay group exceeds the requested Raw page limit.")
        if (rawBytes + bytes > limit) { hasMore = true; break }
        if (group.requiresFile) {
          const proposedHash = hash.copy()
          for (const content of group.contents) proposedHash.update(content)
          const nextWitness = await repeatedReadWitness(handle, group.end, proposedHash.digest("hex"), root,
            [...seen, group.stage.boundaryUuid, group.stage.summaryUuid], calls, "summary", request.signal, group.stage)
          if (!nextWitness) fail("unsupported", "Claude repeated Read has no resumable summary witness.")
        }
        for (const content of group.contents) hash.update(content)
        seen.add(group.stage.boundaryUuid); seen.add(group.stage.summaryUuid)
        state = { ...state, autoText: group.stage, lastUuid: group.stage.summaryUuid, order: state.order + group.contents.length, eventSkip: 0 }
        rawBytes += bytes; at = group.end; hasMore = at < before.size
        break // The answer starts a fresh page; lookahead never consumes prefetched ordinary records.
      }
      if (state.compaction?.phase === "resume" && (object(record.attachment)?.type === "file" || record.isMeta === true)) {
        if (delegated || state.autoText || state.readPair) fail("unsupported", "Claude manual Read reinjection requires an unblocked root Thread.")
        if (state.eventSkip !== 0) fail("cursor", "Claude manual Read checkpoint contains uncommitted Event progress.")
        const group = await readManualGroup(handle, line, record, at, before.size, hash.copy().digest("hex"), root, state.compaction, [...seen], calls, request.signal)
        if (!group) break
        const bytes = group.contents.reduce((total, content) => total + content.length, 0)
        const limit = Math.min(request.limits.rawSegmentBytes, request.limits.rawBytesPerObservation)
        if (bytes > limit) fail("limit", "A Claude manual Read group exceeds the requested Raw page limit.")
        if (rawBytes + bytes > limit) { hasMore = true; break }
        for (const content of group.contents) hash.update(content)
        for (const uuid of group.uuids) seen.add(uuid)
        const { compaction: _completedCompaction, ...committed } = state
        state = { ...committed, ...(group.keepStage ? { compaction: state.compaction } : {}),
          lastUuid: group.uuids[1], order: state.order + 2, eventSkip: 0 }
        rawBytes += bytes; at = group.end; hasMore = at < before.size
        break
      }
      if (state.compaction?.phase === "resume" && record.type === "assistant") {
        await verifyManualBridgeLeaf(handle, at, hash.copy().digest("hex"), root, state.lastUuid, state.compaction.promptId, request.signal)
      }
      let fileBookkeeping: ReturnType<typeof compactionTransition> | undefined
      if (state.compaction?.phase === "resume" && record.uuid === undefined) {
        const leaf = await manualPrefixLeaf(handle, at, hash.copy().digest("hex"), root, request.signal)
        if (object(leaf?.attachment)?.type === "file") {
          await manualReadWitness(handle, at, hash.copy().digest("hex"), root, state.compaction, [...seen], calls, true, request.signal)
          if (!manualBookkeeping(record, root, state.lastUuid))
            fail("unsupported", "Claude manual Read bookkeeping identity or graph changed.")
          fileBookkeeping = { next: state.compaction, rawOnly: true }
        }
      }
      const transition = fileBookkeeping ?? compactionTransition(record, state.lastUuid, state.compaction, delegated !== undefined)
      if (transition.textTail) {
        await verifyPreservedTextTail(handle, at, hash.copy().digest("hex"), root, transition.textTail, request.signal)
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
      if (transition.boundary && transition.next && seen.has(transition.next.summaryUuid))
        fail("unsupported", "Claude manual compaction summary identity already belongs to captured history.")
      if (typeof record.uuid === "string" && (seen.has(record.uuid) || record.parentUuid !== state.lastUuid && !transition.boundary && !state.readPair && !nextReadPair))
        fail("unsupported", "Claude history is not a single unambiguous append-only chain.")
      const nextCalls = new Map(calls)
      const projected = transition.rawOnly ? { events: [] as AdapterEvent[], partial: true }
        : projectRecord(record, state.order, line.end, sourceObjectId, nextCalls)
      const child = bindChild(record, nextCalls, delegated !== undefined)
      if (child) {
        childFile(file, sessionId, child.agentId) // Validate before publishing the relation.
        const pinned = children.get(child.agentId)
        if (pinned && (pinned.toolCallId !== child.toolCallId || pinned.toolUuid !== child.toolUuid) ||
          [...children.values()].some(value => value.toolCallId === child.toolCallId && value.agentId !== child.agentId))
          fail("unsupported", "Claude subagent has conflicting parent evidence.")
        // The native foreground receipt is one tool-result Event. Commit its
        // relation only with that complete record's captured prefix, never when
        // a full page defers the receipt to the next request.
        if (projected.events.length !== 1) fail("unsupported", "Claude subagent receipt requires a single native tool result.")
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
      if (typeof record.uuid === "string") seen.add(record.uuid)
      if (child && !children.has(child.agentId)) { children.set(child.agentId, child); canonicalLimit = recordLimit }
      calls = nextCalls
      const readReceipt = state.readPair !== undefined || nextReadPair !== undefined
      const { compaction: _previousCompaction, autoText: _answeredAutoText, readPair: _previousReadPair, ...committed } = state
      state = { ...committed, ...(transition.next ? { compaction: transition.next } : {}), ...(nextReadPair ? { readPair: nextReadPair } : {}),
        lastUuid: typeof record.uuid === "string" ? record.uuid : state.lastUuid, order: state.order + 1, eventSkip: 0 }
      hash.update(line.content); rawBytes += line.content.length; at = line.end
      if (readReceipt || events.length === request.limits.eventsPerObservation) { hasMore = at < before.size; break }
    }
    if (state.autoText && state.lastUuid !== state.autoText.summaryUuid && state.eventSkip !== 0 && !approvedFileAnswer)
      fail("cursor", "Claude automatic file checkpoint has no complete pending answer.")
    if (!adoptedPair && events.length === 0 && rawBytes === 0 && (request.rawCaptureEnabled === false || acknowledged >= at)) return empty(request.cursor)
    const capturedRaw = request.rawCaptureEnabled === false || acknowledged >= at ? undefined
      : await readRawPrefix(handle, acknowledged, at, Math.min(request.limits.rawSegmentBytes, request.limits.rawBytesPerObservation), request.signal)
    hasMore ||= capturedRaw !== undefined && acknowledged + Buffer.byteLength(capturedRaw) < at
    const after = await handle.stat()
    if (after.size < before.size || after.ino !== before.ino || after.size === before.size && after.mtimeMs !== before.mtimeMs) fail("changed", "Claude source changed during reading.")
    const prefixDigest = hash.copy().digest("hex")
    archive.hashCache = { file, stamp, bytes: at, digest: prefixDigest, hash: hash.copy() }
    const observedAt = events.at(-1)?.occurredAt ?? cursor?.observedAt ?? timestamp(root.timestamp) ?? new Date(before.mtimeMs).toISOString()
    const next: Cursor = { v: 1, sessionId, origin, bytes: at, digest: prefixDigest, projectionRevision: 4, usageVersion: 1, observedAt,
      publication: (cursor?.publication ?? 0) + 1,
      ...(!delegated && children.size ? { children: [...children.values()], ...(cursor?.childAfter ? { childAfter: cursor.childAfter } : {}) } : {}),
      stream: { ...state, seen: [...seen], calls: [...calls].map(([id, call]) => [id, call.name, call.uuid]) } }
    const revision = Math.max(at, events.at(-1)?.revision ?? 1) * 2 + 3
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

/** Only the sampled append-only manual command changes the physical parent
 * chain. Its bounded state commits with each complete record's prefix; none of
 * these native control records becomes a fabricated conversation message. */
function compactionTransition(record: RecordValue, lastUuid: string | null, stage: Compaction | undefined, delegated: boolean):
  { readonly boundary?: boolean; readonly rawOnly?: boolean; readonly next?: Compaction; readonly textTail?: readonly [string, string] } {
  const marked = record.subtype === "compact_boundary" || record.compactMetadata !== undefined
  const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 500 && !value.includes("\0")
  if (marked) {
    const metadata = object(record.compactMetadata), segment = object(metadata?.preservedSegment), messages = object(metadata?.preservedMessages)
    const anchor = segment?.anchorUuid, head = segment?.headUuid
    const singleton = (value: unknown) => Array.isArray(value) && value.length === 1 && value[0] === lastUuid
    const pair = (value: unknown) => Array.isArray(value) && value.length === 2 && value[0] === head && value[1] === lastUuid
    const singleTail = head === lastUuid && singleton(messages?.uuids) && singleton(messages?.allUuids)
    const textTail = validId(head) && head !== lastUuid && pair(messages?.uuids) && pair(messages?.allUuids)
    if (delegated || stage || record.version !== "2.1.263" || record.type !== "system" || record.subtype !== "compact_boundary" ||
      record.isSidechain !== false || record.isMeta !== false || record.parentUuid !== null || !lastUuid || record.logicalParentUuid !== lastUuid ||
      !validId(record.uuid) || metadata?.trigger !== "manual" || segment?.tailUuid !== lastUuid ||
      !validId(anchor) || anchor === record.uuid || messages?.anchorUuid !== anchor || !singleTail && !textTail)
      fail("unsupported", "Claude manual compaction has no supported append-only root evidence.")
    return { boundary: true, rawOnly: true, next: { v: 1, boundaryUuid: record.uuid, summaryUuid: anchor, phase: "summary" },
      ...(textTail && validId(head) ? { textTail: [head, lastUuid] as const } : {}) }
  }
  if (record.logicalParentUuid != null) fail("unsupported", "Claude logical parent requires supported compaction evidence.")
  if (!stage) {
    if (record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true)
      fail("unsupported", "Claude summary has no admitted manual compaction boundary.")
    return {}
  }
  if (typeof record.uuid !== "string") {
    if (!["queue-operation", "last-prompt", "file-history-snapshot"].includes(string(record.type) ?? "") ||
      record.message !== undefined || record.isCompactSummary !== undefined || record.isVisibleInTranscriptOnly !== undefined ||
      record.logicalParentUuid != null || record.parentUuid != null || record.type === "last-prompt" && record.leafUuid !== lastUuid)
      fail("unsupported", "Claude manual compaction bookkeeping contains unsupported conversation data.")
    return { next: stage, rawOnly: true } // Native bookkeeping cannot create Events or usage or advance the control chain.
  }
  const message = object(record.message), content = message?.content
  if (record.version !== "2.1.263" || record.isSidechain !== false)
    fail("unsupported", "Claude manual compaction control identity changed.")
  if (stage.phase !== "summary" && (record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true))
    fail("unsupported", "Claude manual compaction summary appears outside its admitted slot.")
  if (stage.phase === "resume") {
    const usage = object(message?.usage), blocks = message?.content
    if (record.type !== "assistant" || message?.role !== "assistant" || message.model !== "<synthetic>" ||
      message.stop_reason !== "stop_sequence" || !Array.isArray(blocks) || blocks.length !== 1 ||
      object(blocks[0])?.type !== "text" || object(blocks[0])?.text !== "No response requested." ||
      !usage || ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].some(key => usage[key] !== 0))
      fail("unsupported", "Claude manual compaction resume has no supported synthetic bridge.")
    return { rawOnly: true }
  }
  if (record.type !== "user" || message?.role !== "user" || typeof content !== "string" ||
    stage.phase !== "summary" && record.promptId !== stage.promptId)
    fail("unsupported", "Claude manual compaction control sequence changed.")
  switch (stage.phase) {
    case "summary":
      if (record.uuid !== stage.summaryUuid || record.parentUuid !== stage.boundaryUuid || record.isMeta === true ||
        record.isCompactSummary !== true || record.isVisibleInTranscriptOnly !== true || !validId(record.promptId) || !content.trim())
        fail("unsupported", "Claude manual compaction summary does not match its boundary.")
      return { rawOnly: true, next: { ...stage, phase: "caveat", promptId: record.promptId } }
    case "caveat":
      if (record.isMeta !== true || !/^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/.test(content)) break
      return { rawOnly: true, next: { ...stage, phase: "command" } }
    case "command":
      if (record.isMeta === true || !/^<command-name>\/compact<\/command-name>\n\s*<command-message>compact<\/command-message>\n\s*<command-args>[\s\S]*<\/command-args>$/.test(content)) break
      return { rawOnly: true, next: { ...stage, phase: "stdout" } }
    case "stdout":
      if (record.isMeta === true || content !== "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>") break
      return { rawOnly: true, next: { ...stage, phase: "resume" } }
  }
  return fail("unsupported", "Claude manual compaction control sequence changed.")
}

const autoId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 500 && !value.includes("\0")
const autoRoot = (record: RecordValue, root: RecordValue) => record.version === "2.1.263" && record.sessionId === root.sessionId &&
  record.cwd === root.cwd && record.isSidechain === false && record.agentId === undefined && autoId(record.uuid)
/** These are parsed, byte-capped JSON values. An explicit worklist preserves
 * all unknown values without making source nesting consume the JS call stack. */
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
function autoAssistant(record: RecordValue, root: RecordValue, index = 0): boolean {
  const message = object(record.message), blocks = message?.content, model = string(message?.model)
  const block = Array.isArray(blocks) && blocks.length === 1 ? object(blocks[0]) : undefined
  return autoRoot(record, root) && record.type === "assistant" && record.apiBlockIndex === index &&
    (record.isMeta === undefined || record.isMeta === false) && record.isCompactSummary === undefined && record.isVisibleInTranscriptOnly === undefined &&
    message?.role === "assistant" && autoId(message.id) && !!model?.trim() && model.length <= 200 && model !== "<synthetic>" &&
    block?.type === "text" && typeof block.text === "string" && block.text.length > 0
}
function verifyAutoTextAnswer(record: RecordValue, root: RecordValue, stage: AutoText, parent: unknown = stage.summaryUuid): void {
  if (!autoAssistant(record, root) || record.parentUuid !== parent || record.slug !== stage.slug ||
    record.logicalParentUuid != null || record.subtype === "compact_boundary" || record.compactMetadata !== undefined)
    fail("unsupported", "Claude automatic compaction requires its first real answer.")
}

/** Hash the current committed bytes and retain only a bounded, LF-framed tail.
 * Old cursors and newly committed same-page originals use this same proof;
 * emitted fragments never enter it before their usage and bytes commit. */
async function autoTextOriginals(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, seen: ReadonlyArray<string>, signal: AbortSignal): Promise<readonly [RecordValue, RecordValue, RecordValue]> {
  if (seen.length < 3) fail("unsupported", "Claude automatic replay has no current three-record tail.")
  if (seen[0] !== root.uuid) fail("changed", "Claude original identity changed during replay validation.")
  const expected = seen.slice(-3)
  const { tail, ends, tailStart } = await committedTail(handle, committed, expectedDigest, MaxAutoTailRecords, signal)
  const originals: RecordValue[] = []
  for (let index = ends.length - 1; index > 0; index--) {
    const start = ends[index - 1]!, end = ends[index]!
    if (start < tailStart || end - start > MaxWitnessRecordBytes)
      fail("limit", "Claude automatic replay originals exceed the bounded tail proof.")
    const content = tail.subarray(start - tailStart, end - tailStart)
    let record: RecordValue
    try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content))) }
    catch { fail("unsupported", "Claude automatic replay tail contains an unsupported physical record.") }
    if (originals.length < 2) {
      if (record.uuid !== expected[2 - originals.length]) fail("unsupported", "Claude automatic replay requires adjacent current user and attachment records.")
      originals.push(record)
    } else if (record.uuid !== undefined) {
      if (record.uuid !== expected[0]) fail("unsupported", "Claude automatic replay has an intervening UUID record.")
      originals.push(record); break
    } else if (!["last-prompt", "mode", "atis-latch", "queue-operation"].includes(string(record.type) ?? "") ||
      record.message !== undefined || record.parentUuid != null || record.logicalParentUuid != null || record.agentId !== undefined ||
      record.isSidechain !== undefined && record.isSidechain !== false || record.sessionId !== undefined && record.sessionId !== root.sessionId ||
      record.isCompactSummary !== undefined || record.isVisibleInTranscriptOnly !== undefined) {
      fail("unsupported", "Claude automatic replay tail contains unsupported bookkeeping.")
    }
  }
  if (originals.length !== 3) fail("limit", "Claude automatic replay originals exceed the bounded tail proof.")
  const [g, u, a] = originals as [RecordValue, RecordValue, RecordValue]
  const user = object(u.message), attachment = object(g.attachment)
  if (!autoAssistant(a, root) || !autoRoot(u, root) || !autoRoot(g, root) ||
    u.type !== "user" || u.userType !== "external" || user?.role !== "user" || typeof user.content !== "string" || !user.content.length || !autoId(u.promptId) ||
    u.isMeta !== undefined && u.isMeta !== false || u.isCompactSummary !== undefined || u.isVisibleInTranscriptOnly !== undefined ||
    u.parentUuid !== a.uuid || g.parentUuid !== u.uuid || g.type !== "attachment" || g.message !== undefined ||
    attachment?.type !== "total_tokens_reminder" || typeof attachment.text !== "string" || !attachment.text.length ||
    g.isMeta !== undefined && g.isMeta !== false || g.isCompactSummary !== undefined || g.isVisibleInTranscriptOnly !== undefined)
    fail("unsupported", "Claude automatic replay has no supported assistant/user/reminder tail.")
  return [a, u, g]
}

/** Both native profiles authenticate their retained LF frames from the same
 * current-prefix bytes; no separately read tail borrows a prior hash proof. */
async function committedTail(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  records: number, signal: AbortSignal, retainedBytes = MaxProofTailBytes): Promise<{ tail: Buffer; ends: number[]; tailStart: number }> {
  const proofHash = createHash("sha256"), block = Buffer.alloc(64 * 1024)
  const ends = [0]
  let tail = Buffer.alloc(0), bytes = 0
  while (bytes < committed) {
    signal.throwIfAborted()
    const read = await handle.read(block, 0, Math.min(block.length, committed - bytes), bytes)
    if (!read.bytesRead) fail("changed", "The committed Claude prefix changed during replay validation.")
    const content = block.subarray(0, read.bytesRead)
    proofHash.update(content)
    for (let at = content.indexOf(10); at !== -1; at = content.indexOf(10, at + 1)) {
      ends.push(bytes + at + 1)
      if (ends.length > records + 1) ends.shift()
    }
    tail = Buffer.from(Buffer.concat([tail, content]).subarray(-retainedBytes))
    bytes += read.bytesRead
  }
  if (bytes !== committed || proofHash.digest("hex") !== expectedDigest || ends.at(-1) !== committed)
    fail("changed", "The committed Claude prefix changed during tail validation.")
  return { tail, ends, tailStart: committed - tail.length }
}

type ReadCall = { readonly uuid: string; readonly toolId: string; readonly filePath: string }
const currentReadCalls = (seen: ReadonlyArray<string>, calls: ReadonlyMap<string, { name: string; uuid: string }>) =>
  seen.length >= 3 && seen.slice(-2).every(uuid => [...calls.values()].some(call => call.uuid === uuid && call.name === "Read"))
const readPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= 64 * 1024
const readRoot = (record: RecordValue, root: RecordValue) => autoRoot(record, root) && record.isMeta === undefined &&
  record.isCompactSummary === undefined && record.isVisibleInTranscriptOnly === undefined && record.logicalParentUuid === undefined &&
  record.compactMetadata === undefined && record.subtype === undefined

function readResponse(record: RecordValue, root: RecordValue): RecordValue {
  const message = object(record.message), model = string(message?.model)
  if (!readRoot(record, root) || record.type !== "assistant" || message?.role !== "assistant" || !autoId(message.id) ||
    !model?.trim() || model.length > 200 || model === "<synthetic>" || message.stop_reason !== "tool_use")
    fail("unsupported", "Claude Read has no supported assistant response.")
  return message
}

function readCall(record: RecordValue, message: RecordValue, calls: ReadonlyMap<string, { name: string; uuid: string }>): ReadCall {
  const blocks = message.content, block = Array.isArray(blocks) && blocks.length === 1 ? object(blocks[0]) : undefined
  const path = object(block?.input)?.file_path
  if (block?.type !== "tool_use" || block.name !== "Read" || !autoId(block.id) || !readPath(path) ||
    calls.get(block.id)?.name !== "Read" || calls.get(block.id)?.uuid !== record.uuid)
    fail("unsupported", "Claude Read differs from its committed call metadata.")
  return { uuid: record.uuid as string, toolId: block.id, filePath: path }
}

function verifyReadReceipt(record: RecordValue, root: RecordValue, callUuid: string, toolId: string, filePath: string, promptId?: string): void {
  const message = object(record.message), blocks = message?.content
  const block = Array.isArray(blocks) && blocks.length === 1 ? object(blocks[0]) : undefined
  const receipt = object(record.toolUseResult), file = object(receipt?.file)
  const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1
  if (!readRoot(record, root) || record.type !== "user" || message?.role !== "user" || record.parentUuid !== callUuid ||
    record.sourceToolAssistantUUID !== callUuid || !autoId(record.promptId) || promptId !== undefined && record.promptId !== promptId ||
    block?.type !== "tool_result" || block.tool_use_id !== toolId || block.is_error !== undefined || typeof block.content !== "string" || !block.content.length ||
    receipt?.type !== "text" || receipt.isAsync !== undefined || receipt.status !== undefined || receipt.agentId !== undefined ||
    file?.filePath !== filePath || typeof file.content !== "string" || !count(file.numLines) || !count(file.startLine) || !count(file.totalLines) ||
    file.startLine > file.totalLines || file.numLines > file.totalLines - file.startLine + 1)
    fail("unsupported", "Claude Read pair has no supported successful own-call receipt.")
}

async function readPairCalls(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, seen: ReadonlyArray<string>, calls: ReadonlyMap<string, { name: string; uuid: string }>, signal: AbortSignal): Promise<readonly [ReadCall, ReadCall]> {
  if (seen.length < 3) fail("unsupported", "Claude Read pair has no current committed calls.")
  const { tail, ends, tailStart } = await committedTail(handle, committed, expectedDigest, 3, signal)
  const recordAt = (back: number): RecordValue => {
    const end = ends[ends.length - 1 - back], start = ends[ends.length - 2 - back]
    if (start === undefined || end === undefined || start < tailStart || end - start > MaxWitnessRecordBytes)
      fail("limit", "Claude Read pair exceeds the bounded call proof.")
    try { return decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(tail.subarray(start - tailStart, end - tailStart)))) }
    catch { return fail("unsupported", "Claude Read pair has an unsupported physical call record.") }
  }
  const c1 = recordAt(0), c0 = recordAt(1)
  return verifyReadPairCalls(c0, c1, c0.apiBlockIndex === 1 && c1.apiBlockIndex === 2 ? recordAt(2) : undefined, root, seen, calls)
}

function verifyReadPairCalls(c0: RecordValue, c1: RecordValue, plan: RecordValue | undefined, root: RecordValue,
  seen: ReadonlyArray<string>, calls: ReadonlyMap<string, { name: string; uuid: string }>): readonly [ReadCall, ReadCall] {
  const m0 = readResponse(c0, root), m1 = readResponse(c1, root)
  const first = readCall(c0, m0, calls), second = readCall(c1, m1, calls)
  if (first.uuid === second.uuid || first.toolId === second.toolId || seen.at(-2) !== first.uuid || seen.at(-1) !== second.uuid ||
    c1.parentUuid !== c0.uuid || m0.id !== m1.id || m0.model !== m1.model)
    fail("unsupported", "Claude Read pair has no adjacent same-response calls.")
  if (c0.apiBlockIndex === 1 && c1.apiBlockIndex === 2) {
    if (!plan) fail("unsupported", "Claude Read pair has no preceding text plan.")
    const message = readResponse(plan, root), blocks = message.content
    const block = Array.isArray(blocks) && blocks.length === 1 ? object(blocks[0]) : undefined
    if (seen.at(-3) !== plan.uuid || c0.parentUuid !== plan.uuid || plan.apiBlockIndex !== 0 || message.id !== m0.id || message.model !== m0.model ||
      block?.type !== "text" || typeof block.text !== "string" || !block.text.length)
      fail("unsupported", "Claude Read pair has no supported preceding text plan.")
  } else if (c0.apiBlockIndex !== 0 || c1.apiBlockIndex !== 1) {
    fail("unsupported", "Claude Read pair has unsupported API block indices.")
  }
  return [first, second]
}

/** A bounded shape hint only selects the new planned reverse profile. It cannot
 * authorize receipt parents, and does not turn ordinary single, mixed or
 * tool-only linear results into a pending pair. Fully selected bad evidence
 * fails the authenticated proof rather than falling back to linear capture. */
async function plannedReadHint(handle: Awaited<ReturnType<typeof open>>, committed: number, receipt: boolean, signal: AbortSignal): Promise<boolean> {
  const bytes = Buffer.alloc(Math.min(committed, MaxProofTailBytes)), offset = committed - bytes.length
  for (let at = 0; at < bytes.length;) {
    signal.throwIfAborted()
    const read = await handle.read(bytes, at, bytes.length - at, offset + at)
    if (!read.bytesRead) fail("changed", "Claude Read classification prefix changed.")
    at += read.bytesRead
  }
  const ends = [0]
  for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) ends.push(at + 1)
  const count = receipt ? 4 : 3
  if (ends.length < count + 1 || ends.at(-1) !== bytes.length) return false
  let firstComplete = offset === 0
  if (!firstComplete && ends.length === count + 1) {
    const preceding = Buffer.alloc(1), read = await handle.read(preceding, 0, 1, offset - 1)
    firstComplete = read.bytesRead === 1 && preceding[0] === 10
  }
  const frames: RecordValue[] = []
  for (let index = ends.length - count - 1; index < ends.length - 1; index++) {
    // A clipped first frame cannot classify another production profile.
    if (index === 0 && !firstComplete) return false
    try { frames.push(decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(ends[index]!, ends[index + 1]!))))) }
    catch { return false }
  }
  const [p, c0, c1, r] = frames as [RecordValue, RecordValue, RecordValue, RecordValue | undefined]
  const block = (record: RecordValue) => {
    const contents = object(record.message)?.content
    return Array.isArray(contents) && contents.length === 1 ? object(contents[0]) : undefined
  }
  // Exact tool-only indices retain their older ordinary first-result behavior.
  // Once a plan-shaped candidate is selected, invalid indices/API/identity are
  // failures of the authoritative proof, rather than a linear fallback.
  return !(c0.apiBlockIndex === 0 && c1.apiBlockIndex === 1) && block(p)?.type === "text" &&
    block(c0)?.type === "tool_use" && block(c0)?.name === "Read" && block(c1)?.type === "tool_use" && block(c1)?.name === "Read" &&
    (!receipt || r?.type === "user" && r.parentUuid === c1.uuid && block(r)?.type === "tool_result")
}

/** The first reverse receipt is part of the authenticated local batch, including
 * on old producers' no-stage ACKs and pending EOF polls. Its proposed ACK is
 * checked with the same four-frame policy before any Event/bytes are committed. */
async function reverseReadPair(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string, root: RecordValue,
  seen: ReadonlyArray<string>, calls: ReadonlyMap<string, { name: string; uuid: string }>, signal: AbortSignal, expected?: ReadPair): Promise<ReadPair> {
  const { tail, ends, tailStart } = await committedTail(handle, committed, expectedDigest, 4, signal)
  const frames: RecordValue[] = []
  for (let index = ends.length - 5; index < ends.length - 1; index++) {
    const start = ends[index], end = ends[index + 1]
    if (start === undefined || end === undefined || start < tailStart || end - start > MaxWitnessRecordBytes)
      fail("limit", "Claude reverse Read exceeds its four-frame proof capacity.")
    try { frames.push(decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(tail.subarray(start - tailStart, end - tailStart))))) }
    catch { fail("unsupported", "Claude reverse Read has an unsupported committed record.") }
  }
  const [plan, c0, c1, first] = frames as [RecordValue, RecordValue, RecordValue, RecordValue]
  if (expected && (expected.firstResultUuid !== first.uuid || expected.secondCallUuid !== c0.uuid || first.parentUuid !== c1.uuid))
    fail("cursor", "Claude reverse Read checkpoint differs from its committed result order.")
  if (c0.apiBlockIndex !== 1 || c1.apiBlockIndex !== 2 || seen.at(-1) !== first.uuid || seen.at(-4) !== plan.uuid)
    fail("unsupported", "Claude reverse Read has no current planned call/result suffix.")
  const pair = verifyReadPairCalls(c0, c1, plan, root, seen.slice(0, -1), calls)
  verifyReadReceipt(first, root, pair[1].uuid, pair[1].toolId, pair[1].filePath)
  const stage: ReadPair = { v: 1, firstResultUuid: first.uuid as string, secondCallUuid: pair[0].uuid,
    secondToolId: pair[0].toolId, secondFilePath: pair[0].filePath, promptId: first.promptId as string }
  if (expected && !equalJson(stage, expected)) fail("cursor", "Claude reverse Read checkpoint differs from its committed source.")
  return stage
}

/** Tool originals are a complete current turn, rather than a global known-call
 * lookup. Read2 must have committed both own-call receipts before its final
 * reminder can enter this authenticated physical suffix. */
async function autoReadOriginals(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, seen: ReadonlyArray<string>, count: 6 | 8, calls: ReadonlyMap<string, { name: string; uuid: string }>, signal: AbortSignal): Promise<ReadonlyArray<RecordValue>> {
  if (seen.length <= count) fail("unsupported", "Claude Read replay has no complete current turn.")
  if (seen[0] !== root.uuid) fail("changed", "Claude original identity changed during replay validation.")
  const { tail, ends, tailStart } = await committedTail(handle, committed, expectedDigest, count, signal, MaxReadReplayTailBytes)
  const originals: RecordValue[] = [], expected = seen.slice(-count)
  for (let index = 0; index < count; index++) {
    const end = ends[ends.length - count + index], start = ends[ends.length - count - 1 + index]
    if (start === undefined || end === undefined || start < tailStart || end - start > MaxWitnessRecordBytes)
      fail("limit", "Claude Read replay originals exceed the bounded tail proof.")
    let record: RecordValue
    try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(tail.subarray(start - tailStart, end - tailStart)))) }
    catch { fail("unsupported", "Claude Read replay has an unsupported physical original record.") }
    if (record.uuid !== expected[index] || !readRoot(record, root))
      fail("unsupported", "Claude Read replay has no adjacent current root turn.")
    originals.push(record)
  }
  verifyAutoReadTurn(originals, root, seen.at(-count - 1), calls)
  return originals
}

function verifyAutoReadTurn(originals: ReadonlyArray<RecordValue>, root: RecordValue, predecessor: unknown,
  calls: ReadonlyMap<string, { name: string; uuid: string }>): void {
  const [u, g, p] = originals as [RecordValue, RecordValue, RecordValue], user = object(u.message)
  if (![6, 8].includes(originals.length) || originals.some(record => !readRoot(record, root)) ||
    new Set(originals.map(record => record.uuid)).size !== originals.length)
    fail("unsupported", "Claude Read replay has no adjacent current root turn.")
  if (u.type !== "user" || u.userType !== "external" || user?.role !== "user" || typeof user.content !== "string" || !user.content.length ||
    !autoId(u.promptId) || u.parentUuid !== predecessor)
    fail("unsupported", "Claude Read replay has no supported original user.")
  const reminder = (record: RecordValue, parent: unknown) => {
    const attachment = object(record.attachment)
    if (record.type !== "attachment" || record.message !== undefined || record.parentUuid !== parent ||
      attachment?.type !== "total_tokens_reminder" || typeof attachment.text !== "string" || !attachment.text.length)
      fail("unsupported", "Claude Read replay has no supported token reminder.")
  }
  reminder(g, u.uuid)
  const plan = readResponse(p, root), blocks = plan.content, block = Array.isArray(blocks) && blocks.length === 1 ? object(blocks[0]) : undefined
  if (p.apiBlockIndex !== 0 || p.parentUuid !== g.uuid || block?.type !== "text" || typeof block.text !== "string" || !block.text.length)
    fail("unsupported", "Claude Read replay has no supported text plan.")
  const reads = originals.length === 6 ? 1 : 2, ids = new Set<string>(), selectedCalls: ReadCall[] = []
  for (let index = 0; index < reads; index++) {
    const record = originals[3 + index]!, message = readResponse(record, root), call = readCall(record, message, calls)
    if (record.apiBlockIndex !== index + 1 || record.parentUuid !== originals[2 + index]!.uuid ||
      message.id !== plan.id || message.model !== plan.model || ids.has(call.toolId))
      fail("unsupported", "Claude Read replay has no supported same-response calls.")
    ids.add(call.toolId)
    selectedCalls.push(call)
  }
  const receipts = originals.slice(3 + reads, 3 + 2 * reads)
  const ordered = receipts[0]!.parentUuid === selectedCalls[0]!.uuid
  const receiptCalls = ordered ? selectedCalls : [...selectedCalls].reverse()
  for (let index = 0; index < reads; index++) {
    const call = receiptCalls[index]!
    verifyReadReceipt(receipts[index]!, root, call.uuid, call.toolId, call.filePath, u.promptId as string)
  }
  reminder(originals.at(-1)!, originals.at(-2)!.uuid)
}

function verifyAutoCopy(value: RecordValue, original: RecordValue, root: RecordValue, slug: string, absent: boolean): void {
  const { slug: _newSlug, ...withoutSlug } = value
  if (!autoRoot(value, root) || value.slug !== slug || !(absent ? equalJson(withoutSlug, original) : equalJson(value, original)))
    fail("unsupported", "Claude automatic replay differs from its complete original record.")
}
function verifyAutoBoundary(record: RecordValue, root: RecordValue, retained: ReadonlyArray<RecordValue>,
  promptId: string, slug: string, known: ReadonlySet<string>): AutoText {
  const metadata = object(record.compactMetadata), segment = object(metadata?.preservedSegment), messages = object(metadata?.preservedMessages)
  const anchor = segment?.anchorUuid, ids = retained.map(record => record.uuid)
  const equalIds = (value: unknown) => Array.isArray(value) && value.length === ids.length && value.every((id, index) => id === ids[index])
  if (!autoRoot(record, root) || record.type !== "system" || record.subtype !== "compact_boundary" || record.isMeta !== undefined ||
    record.isCompactSummary !== undefined || record.isVisibleInTranscriptOnly !== undefined ||
    record.message !== undefined || record.parentUuid !== null || record.logicalParentUuid !== retained.at(-1)!.uuid || record.slug !== slug ||
    metadata?.trigger !== "auto" || segment?.headUuid !== retained[0]!.uuid || segment?.tailUuid !== retained.at(-1)!.uuid || !autoId(anchor) ||
    anchor === record.uuid || messages?.anchorUuid !== anchor || !equalIds(messages?.uuids) || !equalIds(messages?.allUuids) ||
    known.has(record.uuid as string) || known.has(anchor))
    fail("unsupported", "Claude automatic replay boundary has no current-tail witness.")
  return { v: 1, boundaryUuid: record.uuid as string, summaryUuid: anchor, promptId, slug }
}
function verifyAutoSummary(record: RecordValue, root: RecordValue, stage: AutoText): void {
  const message = object(record.message)
  if (!autoRoot(record, root) || record.uuid !== stage.summaryUuid || record.parentUuid !== stage.boundaryUuid ||
    record.type !== "user" || record.isMeta !== undefined || record.promptId !== stage.promptId || record.slug !== stage.slug ||
    record.isCompactSummary !== true || record.isVisibleInTranscriptOnly !== true || record.logicalParentUuid != null ||
    record.subtype !== undefined || record.compactMetadata !== undefined ||
    message?.role !== "user" || typeof message.content !== "string" || !message.content.trim())
    fail("unsupported", "Claude automatic replay summary does not match its boundary.")
}

async function readAutoGroup(handle: Awaited<ReturnType<typeof open>>, first: { content: Buffer; end: number }, copy: RecordValue,
  committed: number, sampledEnd: number, expectedDigest: string, root: RecordValue, seen: ReadonlyArray<string>, calls: ReadonlyMap<string, { name: string; uuid: string }>, signal: AbortSignal):
  Promise<{ readonly contents: ReadonlyArray<Buffer>; readonly end: number; readonly stage: AutoText; readonly requiresFile?: true } | undefined> {
  // The unknown first line was read by the ordinary 16 MiB parser. Enforce the
  // smaller profile admission limit only now that a complete duplicate is known.
  if (first.content.length > MaxWitnessRecordBytes) fail("limit", "A Claude automatic replay record exceeds 64 KiB.")
  // Tail identity only selects a profile. A failed selected tool proof never
  // falls back to text or general duplicate suppression.
  const toolCount = copy.uuid === seen.at(-6) ? 6 : copy.uuid === seen.at(-8) ? 8 : undefined
  const originals = toolCount ? await autoReadOriginals(handle, committed, expectedDigest, root, seen, toolCount, calls, signal)
    : await autoTextOriginals(handle, committed, expectedDigest, root, seen, signal)
  const copies = toolCount ? originals : originals.slice(1), retained = toolCount ? originals.slice(2) : originals
  const u = toolCount ? originals[0]! : originals[1]!, slug = copy.slug, groupLimit = toolCount ? MaxReadReplayGroupBytes : MaxAutoGroupBytes
  const absent = originals.every(record => !Object.hasOwn(record, "slug"))
  if (!autoId(slug) || !Object.hasOwn(copy, "slug") || toolCount === 8 && !absent || !absent && !originals.every(record => record.slug === slug))
    fail("unsupported", "Claude automatic replay has conflicting slug evidence.")
  if (toolCount === 6 && !absent)
    await repeatedReadWitness(handle, committed, expectedDigest, root, seen, calls, "originals", signal)
  verifyAutoCopy(copy, copies[0]!, root, slug, absent)
  const contents = [first.content], known = new Set(seen)
  let stage: AutoText | undefined
  for await (const line of readRecords(handle, first.end, Math.min(sampledEnd, committed + groupLimit), signal, MaxWitnessRecordBytes)) {
    if (!line.content.toString("utf8").trim()) fail("unsupported", "Claude automatic replay group is not physically adjacent.")
    let record: RecordValue
    try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.content))) }
    catch { fail("format", "Claude automatic replay contains a malformed complete record.") }
    if (contents.length < copies.length) verifyAutoCopy(record, copies[contents.length]!, root, slug, absent)
    else if (contents.length === copies.length) {
      stage = verifyAutoBoundary(record, root, retained, u.promptId as string, slug, known)
    } else {
      if (!stage) fail("unsupported", "Claude automatic replay has no boundary.")
      verifyAutoSummary(record, root, stage)
      contents.push(line.content)
      return { contents, end: line.end, stage, ...(toolCount === 6 && !absent ? { requiresFile: true } : {}) }
    }
    contents.push(line.content)
  }
  if (sampledEnd - committed >= groupLimit)
    fail("limit", "A Claude automatic replay group exceeds its bounded source capacity.")
  return undefined
}

type RepeatedReadWitness = { readonly receipt: RecordValue; readonly filePath: string; readonly slug: string; readonly apiIds: ReadonlyArray<string> }

/** Classification only: keep old text/dual/first-slug answers out of the larger
 * historical proof. A selected existing-slug candidate never falls back after
 * its authenticated proof fails. The existing prefix/stat concurrency limits
 * apply to this bounded peek; it cannot authorize a file on its own. */
async function existingSingleRead(handle: Awaited<ReturnType<typeof open>>, committed: number, stage: AutoText,
  signal: AbortSignal): Promise<boolean> {
  const peek = async (count: number) => {
    const bytes = Buffer.alloc(Math.min(committed, count * MaxWitnessRecordBytes)), offset = committed - bytes.length
    for (let at = 0; at < bytes.length;) {
      signal.throwIfAborted()
      const read = await handle.read(bytes, at, bytes.length - at, offset + at)
      if (!read.bytesRead) fail("changed", "Claude automatic replay classification prefix changed.")
      at += read.bytesRead
    }
    const ends = [0]
    for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) ends.push(at + 1)
    if (ends.length < count + 1 || ends.at(-1) !== bytes.length) fail("unsupported", "Claude automatic replay has no complete current group.")
    const frames: RecordValue[] = []
    for (let index = ends.length - count - 1; index < ends.length - 1; index++) {
      try { frames.push(decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(ends[index]!, ends[index + 1]!))))) }
      catch { fail("unsupported", "Claude automatic replay has an unsupported current group.") }
    }
    return frames
  }
  const controls = await peek(2)
  if (controls[0]!.uuid !== stage.boundaryUuid || controls[1]!.uuid !== stage.summaryUuid)
    fail("unsupported", "Claude automatic single Read checkpoint does not match its source.")
  const retained = object(object(controls[0]!.compactMetadata)?.preservedMessages)?.uuids
  if (!Array.isArray(retained) || retained.length !== 4) return false
  const frames = await peek(14)
  if (frames.slice(0, 6).every(record => !Object.hasOwn(record, "slug"))) return false
  if (!frames.slice(0, 6).every(record => Object.hasOwn(record, "slug") && record.slug === stage.slug))
    fail("unsupported", "Claude repeated Read originals have conflicting slug evidence.")
  return true
}

/** Reconstruct the sampled two consecutive single-Read rounds from the same
 * bytes being hashed. Only selected frames are decoded/capped; unrelated large
 * prehistory can fall outside the bounded physical window. No history lookup
 * by file name or remembered tool ID can replace this ordered witness. */
async function repeatedReadWitness(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, seen: ReadonlyArray<string>, calls: ReadonlyMap<string, { name: string; uuid: string }>,
  mode: "originals" | "summary" | "file", signal: AbortSignal, active?: AutoText): Promise<RepeatedReadWitness | undefined> {
  if (mode === "summary" && (!active || !await existingSingleRead(handle, committed, active, signal))) return undefined
  if (seen.length <= (mode === "originals" ? 6 : mode === "summary" ? 8 : 9) + 10)
    fail("unsupported", "Claude repeated Read has no first completed added-slug round.")
  const { tail, ends, tailStart } = await committedTail(handle, committed, expectedDigest, MaxRepeatedReadTailRecords, signal, MaxRepeatedReadTailBytes)
  const last = ends.length - 2, currentSize = mode === "originals" ? 6 : mode === "summary" ? 14 : 15
  const currentStart = last - currentSize + 1, parsed = new Map<number, RecordValue>()
  const frame = (index: number): RecordValue => {
    const cached = parsed.get(index)
    if (cached) return cached
    const start = ends[index], end = ends[index + 1]
    if (start === undefined || end === undefined || start < tailStart || end - start > MaxWitnessRecordBytes)
      fail("limit", "Claude repeated Read exceeds its bounded historical witness.")
    let record: RecordValue
    try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(tail.subarray(start - tailStart, end - tailStart)))) }
    catch { fail("unsupported", "Claude repeated Read witness has an unsupported physical record.") }
    parsed.set(index, record); return record
  }
  const second = Array.from({ length: 6 }, (_, index) => frame(currentStart + index)), slug = second[0]!.slug
  if (!autoId(slug) || second.some(record => !Object.hasOwn(record, "slug") || record.slug !== slug))
    fail("unsupported", "Claude repeated Read requires an unchanged common existing slug.")
  let priorFinal = currentStart - 1
  const gap: RecordValue[] = []
  while (frame(priorFinal).uuid === undefined) { gap.push(frame(priorFinal)); priorFinal-- }
  const firstStart = priorFinal - 15, first = Array.from({ length: 16 }, (_, index) => frame(firstStart + index))
  const firstOriginals = first.slice(0, 6), currentSeenStart = seen.length - (mode === "originals" ? 6 : mode === "summary" ? 8 : 9)
  const firstSeenStart = currentSeenStart - 10
  const expected = [...firstOriginals, ...first.slice(12), ...second,
    ...(mode === "originals" ? [] : [frame(currentStart + 12), frame(currentStart + 13)]), ...(mode === "file" ? [frame(last)] : [])]
    .map(record => record.uuid)
  if (firstSeenStart < 1 || seen[0] !== root.uuid || !equalJson(seen.slice(firstSeenStart), expected))
    fail("unsupported", "Claude repeated Read witness does not match its committed current identities.")
  verifyAutoReadTurn(firstOriginals, root, seen[firstSeenStart - 1], calls)
  verifyAutoReadTurn(second, root, first[15]!.uuid, calls)
  if (firstOriginals.some(record => Object.hasOwn(record, "slug")))
    fail("unsupported", "Claude repeated Read requires its first added-slug round.")
  const group = (originals: ReadonlyArray<RecordValue>, start: number, absent: boolean, known: ReadonlyArray<string>) => {
    for (let index = 0; index < 6; index++) verifyAutoCopy(frame(start + 6 + index), originals[index]!, root, slug, absent)
    const stage = verifyAutoBoundary(frame(start + 12), root, originals.slice(2), originals[0]!.promptId as string, slug, new Set(known))
    verifyAutoSummary(frame(start + 13), root, stage); return stage
  }
  const firstStage = group(firstOriginals, firstStart, true, seen.slice(0, firstSeenStart + 6))
  const a0 = first[14]!, a1 = first[15]!, m0 = object(a0.message), m1 = object(a1.message)
  verifyAutoTextAnswer(a0, root, firstStage)
  if (!readRoot(a0, root) || !readRoot(a1, root) || !autoAssistant(a1, root, 1) || a1.parentUuid !== a0.uuid || a1.slug !== slug ||
    a0.isApiErrorMessage !== undefined || a1.isApiErrorMessage !== undefined || m0?.id !== m1?.id || m0?.model !== m1?.model ||
    m0?.id === object(firstOriginals[2]!.message)?.id || m0?.stop_reason !== "end_turn" || m1?.stop_reason !== "end_turn")
    fail("unsupported", "Claude repeated Read requires its first real complete answer pair.")
  for (const record of gap) if (!manualBookkeeping(record, root, record.leafUuid) ||
    record.type === "last-prompt" && record.leafUuid !== a1.uuid && record.leafUuid !== second[5]!.uuid)
    fail("unsupported", "Claude repeated Read has unsupported inter-round bookkeeping.")
  const oldCall = readCall(firstOriginals[3]!, object(firstOriginals[3]!.message)!, calls)
  const newCall = readCall(second[3]!, object(second[3]!.message)!, calls)
  if (oldCall.filePath === newCall.filePath) fail("unsupported", "Claude repeated Read requires distinct literal file paths.")
  const apiIds = [object(firstOriginals[2]!.message)!.id, m0!.id, object(second[2]!.message)!.id] as string[]
  if (new Set(apiIds).size !== 3) fail("unsupported", "Claude repeated Read requires fresh tool-response API identities.")
  const witness = { receipt: object(firstOriginals[4]!.toolUseResult)!, filePath: oldCall.filePath, slug, apiIds }
  if (mode !== "originals") {
    const secondStage = group(second, currentStart, false, seen.slice(0, currentSeenStart + 6))
    if (!active || !equalJson(secondStage, active)) fail("unsupported", "Claude repeated Read checkpoint does not match its second group.")
    if (mode === "file") verifyRepeatedReadFile(frame(last), root, witness, active.summaryUuid, seen.slice(0, -1))
  }
  return witness
}

function verifyRepeatedReadFile(record: RecordValue, root: RecordValue, witness: RepeatedReadWitness, parent: unknown, known: ReadonlyArray<string>): void {
  const attachment = object(record.attachment)
  if (!readRoot(record, root) || record.type !== "attachment" || record.userType !== "external" || record.message !== undefined ||
    record.promptId !== undefined || record.sourceToolAssistantUUID !== undefined || record.toolUseResult !== undefined || record.isApiErrorMessage !== undefined ||
    record.isAsync !== undefined || record.status !== undefined ||
    record.parentUuid !== parent || record.slug !== witness.slug || known.includes(record.uuid as string) || attachment?.type !== "file" ||
    attachment.filename !== witness.filePath || !readPath(attachment.displayPath) || attachment.isAsync !== undefined ||
    attachment.status !== undefined || attachment.agentId !== undefined || !equalJson(attachment.content, witness.receipt))
    fail("unsupported", "Claude automatic prior file differs from its proved first successful Read receipt.")
}

/** Reconstruct only the last two UUID records from the exact bytes that are
 * already fully committed. Re-reading on the same handle supplies old cursors
 * and same-page appends without replaying any Canonical or Raw projection. */
async function verifyPreservedTextTail(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, expected: readonly [string, string], signal: AbortSignal): Promise<void> {
  type TextRecord = { uuid: string; parent: unknown; apiId: string; model: string; block: unknown; physical: number }
  const validId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 500 && !value.includes("\0")
  const textRecord = (record: RecordValue, physical: number): TextRecord | undefined => {
    const message = object(record.message), content = message?.content, model = string(message?.model)
    const body = Array.isArray(content) && content.length === 1 ? object(content[0]) : undefined, text = body?.text
    if (record.type !== "assistant" || record.version !== "2.1.263" || record.sessionId !== root.sessionId ||
      record.isSidechain !== false || record.agentId !== undefined || record.isMeta === true ||
      record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true ||
      !validId(record.uuid) || !validId(message?.id) || message.role !== "assistant" || !model || model.length > 200 || model === "<synthetic>" ||
      body?.type !== "text" || typeof text !== "string" || !text.length) return undefined
    return { uuid: record.uuid, parent: record.parentUuid, apiId: message.id, model, block: record.apiBlockIndex, physical }
  }
  const proofHash = createHash("sha256")
  let head: TextRecord | undefined, tail: TextRecord | undefined, physical = 0, bytes = 0, originalRoot = false
  for await (const line of readRecords(handle, 0, committed, signal)) {
    proofHash.update(line.content); bytes = line.end; physical++
    if (!line.content.toString("utf8").trim()) continue
    let record: RecordValue
    try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.content))) }
    catch { fail("format", "Claude committed prefix contains a malformed JSONL record.") }
    if (!originalRoot && typeof record.uuid === "string") {
      if (record.uuid !== root.uuid || record.type !== "user" || record.parentUuid !== null || record.sessionId !== root.sessionId || record.cwd !== root.cwd)
        fail("changed", "Claude original identity changed during preserved-tail validation.")
      originalRoot = true
    }
    if (record.uuid !== undefined) { head = tail; tail = textRecord(record, physical) }
  }
  if (bytes !== committed || proofHash.digest("hex") !== expectedDigest)
    fail("changed", "The committed Claude prefix changed during preserved-tail validation.")
  if (!originalRoot || !head || !tail || head.uuid !== expected[0] || tail.uuid !== expected[1] ||
    tail.physical !== head.physical + 1 || tail.parent !== head.uuid || head.apiId !== tail.apiId || head.model !== tail.model ||
    head.block !== 0 || tail.block !== 1)
    fail("unsupported", "Claude manual compaction has no supported same-response text tail.")
}

/** Hash and recover semantics from the same committed bytes. Candidate rings
 * can discard oversized unrelated records without borrowing a separate read. */
async function scanManualPrefix(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, signal: AbortSignal, visit: (record: RecordValue | undefined, physical: number, bytes: number) => void): Promise<void> {
  const hash = createHash("sha256")
  let at = 0, physical = 0, first = false, original = false
  for await (const line of readRecords(handle, 0, committed, signal)) {
    hash.update(line.content); at = line.end; physical++
    let record: RecordValue | undefined
    if (line.content.toString("utf8").trim()) {
      try { record = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.content))) }
      catch { fail("format", "Claude committed prefix contains a malformed JSONL record.") }
      if (!first && record.uuid !== undefined) {
        first = true
        original = record.uuid === root.uuid && record.type === "user" && record.parentUuid === null &&
          record.sessionId === root.sessionId && record.cwd === root.cwd && record.isMeta !== true
      }
    }
    visit(record, physical, line.content.length)
  }
  if (at !== committed || hash.digest("hex") !== expectedDigest)
    fail("changed", "The committed Claude prefix changed during manual Read validation.")
  if (!original) fail("changed", "Claude original identity changed during manual Read validation.")
}

async function manualPrefixLeaf(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, signal: AbortSignal): Promise<RecordValue | undefined> {
  let leaf: RecordValue | undefined
  await scanManualPrefix(handle, committed, expectedDigest, root, signal, record => {
    if (record?.uuid !== undefined) leaf = record
  })
  return leaf
}

async function verifyManualBridgeLeaf(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, lastUuid: string | null, promptId: string | undefined, signal: AbortSignal): Promise<void> {
  const leaf = await manualPrefixLeaf(handle, committed, expectedDigest, root, signal)
  // Old no-file profiles retain ordinary record limits, including large final
  // text/unknown values; only their actual last UUID must be the stdout slot.
  const message = object(leaf?.message)
  if (leaf?.uuid !== lastUuid || leaf?.type !== "user" || leaf.isMeta === true || leaf.promptId !== promptId ||
    message?.role !== "user" || message.content !== "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>")
    fail("unsupported", "Claude manual compaction bridge requires its admitted stdout leaf.")
}

const manualIdentity = (record: RecordValue, root: RecordValue) => autoRoot(record, root) && record.userType === "external" &&
  record.agentId === undefined && record.sourceToolAssistantUUID === undefined && record.toolUseResult === undefined && record.attachment === undefined
const manualBookkeeping = (record: RecordValue | undefined, root: RecordValue, leaf: unknown) => record !== undefined &&
  ["queue-operation", "last-prompt", "mode", "atis-latch"].includes(string(record.type) ?? "") &&
  record.sessionId === root.sessionId && record.uuid === undefined && record.message === undefined && record.parentUuid === undefined &&
  record.logicalParentUuid === undefined && record.compactMetadata === undefined && record.isCompactSummary === undefined &&
  record.isVisibleInTranscriptOnly === undefined && record.agentId === undefined && record.sourceToolAssistantUUID === undefined &&
  record.toolUseResult === undefined && record.isSidechain === undefined && record.isMeta === undefined &&
  record.cwd === undefined && record.version === undefined &&
  record.subtype === undefined && record.isApiErrorMessage === undefined && record.attachment === undefined &&
  (record.type !== "last-prompt" || record.leafUuid === leaf)

// Candidate classification limits retained storage; only the selected slots and
// their complete graph proof can admit these records as Read receipts or files.
const manualReceiptCandidate = (record: RecordValue) => {
  const blocks = object(record.message)?.content
  return record.type === "user" && object(record.toolUseResult)?.type === "text" &&
    Array.isArray(blocks) && blocks.length === 1 && object(blocks[0])?.type === "tool_result"
}
const manualFileCandidate = (record: RecordValue) => record.type === "attachment" && object(record.attachment)?.type === "file"
type ManualFrame = { readonly uuid: unknown; readonly physical: number; readonly bytes: number; readonly record: RecordValue | undefined }
async function manualReadWitness(handle: Awaited<ReturnType<typeof open>>, committed: number, expectedDigest: string,
  root: RecordValue, stage: Compaction, seen: ReadonlyArray<string>, calls: ReadonlyMap<string, { name: string; uuid: string }>,
  filesCommitted: boolean, signal: AbortSignal): Promise<{ readonly receipts: readonly [RecordValue, RecordValue]; readonly paths: readonly [string, string]; readonly slug: string }> {
  const ring: ManualFrame[] = [], controls: ManualFrame[] = []
  let originals: ManualFrame[] | undefined, prior: unknown = null, gap = true, originalGap = false, repeatedBoundary = false, excess = false
  await scanManualPrefix(handle, committed, expectedDigest, root, signal, (record, physical, bytes) => {
    if (record?.uuid === undefined) { gap &&= manualBookkeeping(record, root, prior); return }
    if (record.uuid === stage.boundaryUuid) {
      if (originals) repeatedBoundary = true
      else { originals = [...ring]; originalGap = gap }
    }
    const limit = originals
      ? controls.length >= 5 && manualFileCandidate(record) ? MaxManualReadFileBytes : MaxWitnessRecordBytes
      : manualReceiptCandidate(record) ? MaxManualReadReceiptBytes : MaxWitnessRecordBytes
    const frame = { uuid: record.uuid, physical, bytes, record: bytes <= limit ? record : undefined }
    if (originals) {
      if (controls.length < 7) controls.push(frame)
      else excess = true
    } else {
      ring.push(frame); if (ring.length > 10) ring.shift()
    }
    prior = record.uuid; gap = true
  })
  const count = filesCommitted ? 7 : 5, boundaryIndex = seen.indexOf(stage.boundaryUuid)
  if (!originals || originals.length !== 10 || controls.length !== count || repeatedBoundary || excess || !originalGap || !gap || boundaryIndex <= 10 ||
    originals.some((frame, index) => frame.uuid !== seen[boundaryIndex - 10 + index] || index > 0 && frame.physical !== originals![index - 1]!.physical + 1) ||
    controls.some((frame, index) => frame.uuid !== seen[boundaryIndex + index] || index > 0 && frame.physical !== controls[index - 1]!.physical + 1) ||
    seen.length !== boundaryIndex + count)
    fail("unsupported", "Claude manual Read has no current adjacent original/control witness.")
  if (originals.some((frame, index) => !frame.record || frame.bytes > (index === 5 || index === 6 ? MaxManualReadReceiptBytes : MaxWitnessRecordBytes)) ||
    controls.some((frame, index) => !frame.record || frame.bytes > (index >= 5 ? MaxManualReadFileBytes : MaxWitnessRecordBytes)))
    fail("limit", "A selected Claude manual Read witness exceeds its record limit.")
  const original = originals.map(frame => frame.record!), sequence = controls.map(frame => frame.record!)
  if (original.some(record => !readRoot(record, root) || record.userType !== "external" || record.slug !== undefined || record.isApiErrorMessage !== undefined))
    fail("unsupported", "Claude manual Read original identity or markers changed.")
  const [u, g, p, c0, c1, r0, r1, reminder, a0, a1] = original as [RecordValue, RecordValue, RecordValue, RecordValue, RecordValue, RecordValue, RecordValue, RecordValue, RecordValue, RecordValue]
  const user = object(u.message), token = (record: RecordValue, parent: unknown) => record.type === "attachment" && record.message === undefined &&
    record.parentUuid === parent && object(record.attachment)?.type === "total_tokens_reminder" &&
    typeof object(record.attachment)?.text === "string" && (object(record.attachment)!.text as string).length > 0
  if (u.type !== "user" || user?.role !== "user" || typeof user.content !== "string" || !user.content.length || !autoId(u.promptId) ||
    u.parentUuid !== seen[boundaryIndex - 11] || !token(g, u.uuid) || !token(reminder, r1.uuid))
    fail("unsupported", "Claude manual Read has no supported user/reminder turn.")
  const plan = readResponse(p, root), content = plan.content, text = Array.isArray(content) && content.length === 1 ? object(content[0]) : undefined
  if (p.parentUuid !== g.uuid || p.apiBlockIndex !== 0 || text?.type !== "text" || typeof text.text !== "string" || !text.text.length)
    fail("unsupported", "Claude manual Read has no supported text plan.")
  const firstMessage = readResponse(c0, root), secondMessage = readResponse(c1, root)
  const first = readCall(c0, firstMessage, calls), second = readCall(c1, secondMessage, calls)
  if (c0.parentUuid !== p.uuid || c1.parentUuid !== c0.uuid || c0.apiBlockIndex !== 1 || c1.apiBlockIndex !== 2 ||
    firstMessage.id !== plan.id || secondMessage.id !== plan.id || firstMessage.model !== plan.model || secondMessage.model !== plan.model ||
    first.toolId === second.toolId || first.filePath === second.filePath)
    fail("unsupported", "Claude manual Read has no supported same-response distinct calls.")
  verifyReadReceipt(r0, root, first.uuid, first.toolId, first.filePath, u.promptId)
  verifyReadReceipt(r1, root, second.uuid, second.toolId, second.filePath, u.promptId)
  const m0 = object(a0.message), m1 = object(a1.message)
  const finalText = (message: RecordValue | undefined) => message?.role === "assistant" && autoId(message.id) && typeof message.model === "string" &&
    message.model.trim().length > 0 && message.model.length <= 200 && message.model !== "<synthetic>" && message.stop_reason === "end_turn" &&
    Array.isArray(message.content) && message.content.length === 1 && object(message.content[0])?.type === "text" &&
    typeof object(message.content[0])?.text === "string" && (object(message.content[0])!.text as string).length > 0
  if (a0.type !== "assistant" || a1.type !== "assistant" || !finalText(m0) || !finalText(m1) ||
    a0.parentUuid !== reminder.uuid || a1.parentUuid !== a0.uuid || a0.apiBlockIndex !== 0 || a1.apiBlockIndex !== 1 ||
    m0!.id === plan.id || m0!.id !== m1!.id || m0!.model !== m1!.model)
    fail("unsupported", "Claude manual Read has no supported final text pair.")
  const slug = sequence[0]!.slug
  if (!autoId(slug)) fail("unsupported", "Claude manual Read has no compact slug.")
  let active: Compaction | undefined, leaf: string | null = a1.uuid as string
  for (const [index, record] of sequence.slice(0, 5).entries()) {
    if (!manualIdentity(record, root) || record.slug !== slug || record.isApiErrorMessage !== undefined ||
      record.parentUuid !== leaf && index !== 0 || record.isMeta !== (index === 0 ? false : index === 2 ? true : undefined) ||
      record.isCompactSummary !== (index === 1 ? true : undefined) || record.isVisibleInTranscriptOnly !== (index === 1 ? true : undefined) ||
      index !== 0 && (record.subtype !== undefined || record.compactMetadata !== undefined || record.logicalParentUuid !== undefined) ||
      index === 0 && record.message !== undefined)
      fail("unsupported", "Claude manual Read control identity or markers changed.")
    const transition = compactionTransition(record, leaf, active, false)
    if (index === 0 && (!transition.textTail || transition.textTail[0] !== a0.uuid || transition.textTail[1] !== a1.uuid))
      fail("unsupported", "Claude manual Read retained endpoints changed.")
    active = transition.next; leaf = record.uuid as string
  }
  if (!active || active.phase !== "resume" || active.boundaryUuid !== stage.boundaryUuid || active.summaryUuid !== stage.summaryUuid || active.promptId !== stage.promptId)
    fail("unsupported", "Claude manual Read checkpoint does not match its current controls.")
  const witness = { receipts: [object(r1.toolUseResult)!, object(r0.toolUseResult)!] as const, paths: [second.filePath, first.filePath] as const, slug }
  if (filesCommitted) {
    verifyManualFile(sequence[5]!, root, witness, 0, leaf, seen.slice(0, boundaryIndex + 5))
    verifyManualFile(sequence[6]!, root, witness, 1, sequence[5]!.uuid, seen.slice(0, boundaryIndex + 6))
  }
  return witness
}

function verifyManualFile(record: RecordValue, root: RecordValue,
  witness: { readonly receipts: readonly [RecordValue, RecordValue]; readonly paths: readonly [string, string]; readonly slug: string },
  index: 0 | 1, parent: unknown, known: ReadonlyArray<string>): void {
  const attachment = object(record.attachment)
  if (!readRoot(record, root) || record.type !== "attachment" || record.userType !== "external" || record.message !== undefined ||
    record.promptId !== undefined || record.sourceToolAssistantUUID !== undefined || record.toolUseResult !== undefined || record.isApiErrorMessage !== undefined ||
    record.parentUuid !== parent || record.slug !== witness.slug || known.includes(record.uuid as string) || attachment?.type !== "file" ||
    attachment.filename !== witness.paths[index] || !readPath(attachment.displayPath) || attachment.isAsync !== undefined ||
    attachment.status !== undefined || attachment.agentId !== undefined || !equalJson(attachment.content, witness.receipts[index]))
    fail("unsupported", "Claude manual Read file differs from its complete successful receipt.")
}

async function readManualGroup(handle: Awaited<ReturnType<typeof open>>, first: { content: Buffer; end: number }, record: RecordValue,
  committed: number, sampledEnd: number, expectedDigest: string, root: RecordValue, stage: Compaction,
  seen: ReadonlyArray<string>, calls: ReadonlyMap<string, { name: string; uuid: string }>, signal: AbortSignal):
  Promise<{ readonly contents: readonly [Buffer, Buffer]; readonly end: number; readonly uuids: readonly [string, string]; readonly keepStage: boolean } | undefined> {
  const files = manualFileCandidate(record)
  const recordLimit = files ? MaxManualReadFileBytes : MaxWitnessRecordBytes
  const groupLimit = files ? MaxManualReadFileGroupBytes : MaxManualReadBridgeGroupBytes
  if (first.content.length > recordLimit) fail("limit", "A Claude manual Read record exceeds its selected record limit.")
  const witness = await manualReadWitness(handle, committed, expectedDigest, root, stage, seen, calls, !files, signal)
  if (files) verifyManualFile(record, root, witness, 0, seen.at(-1), seen)
  else {
    const message = object(record.message), blocks = message?.content
    if (!manualIdentity(record, root) || record.type !== "user" || record.isMeta !== true || record.isCompactSummary !== undefined ||
      record.isVisibleInTranscriptOnly !== undefined || record.compactMetadata !== undefined || record.logicalParentUuid !== undefined || record.subtype !== undefined ||
      record.isApiErrorMessage !== undefined || record.slug !== witness.slug || record.parentUuid !== seen.at(-1) || seen.includes(record.uuid as string) ||
      !autoId(record.promptId) || record.promptId === stage.promptId || message?.role !== "user" || !Array.isArray(blocks) || blocks.length !== 1 ||
      object(blocks[0])?.type !== "text" || object(blocks[0])?.text !== "Continue from where you left off.")
      fail("unsupported", "Claude manual Read has no supported internal Continue control.")
  }
  for await (const line of readRecords(handle, first.end, Math.min(sampledEnd, committed + groupLimit), signal, recordLimit)) {
    if (!line.content.toString("utf8").trim()) fail("unsupported", "Claude manual Read group is not physically adjacent.")
    let next: RecordValue
    try { next = decodeRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.content))) }
    catch { return fail("format", "Claude manual Read group contains a malformed complete record.") }
    if (files) verifyManualFile(next, root, witness, 1, record.uuid, [...seen, record.uuid as string])
    else {
      const message = object(next.message)
      if (!manualIdentity(next, root) || next.isMeta !== undefined || next.isCompactSummary !== undefined || next.isVisibleInTranscriptOnly !== undefined ||
        next.compactMetadata !== undefined || next.logicalParentUuid !== undefined || next.subtype !== undefined || next.promptId !== undefined ||
        next.slug !== witness.slug || next.parentUuid !== record.uuid || next.uuid === record.uuid || seen.includes(next.uuid as string) ||
        next.apiBlockIndex !== undefined || next.isApiErrorMessage !== false || !autoId(message?.id) || message?.stop_sequence !== "")
        fail("unsupported", "Claude manual Read synthetic bridge identity changed.")
      compactionTransition(next, record.uuid as string, stage, false)
    }
    return { contents: [first.content, line.content], end: line.end, uuids: [record.uuid as string, next.uuid as string], keepStage: files }
  }
  if (sampledEnd - committed >= groupLimit) fail("limit", "A Claude manual Read group exceeds its bounded source capacity.")
  return undefined
}

function bindChild(record: RecordValue, calls: Map<string, { name: string; uuid: string }>, delegated: boolean): Child | undefined {
  const content = object(record.message)?.content
  if (delegated && Array.isArray(content) && content.some(value => {
    const block = object(value)
    return block?.type === "tool_use" && ["Agent", "Task"].includes(string(block.name) ?? "")
  })) fail("unsupported", "Nested Claude subagents require a wider native profile.")
  const result = object(record.toolUseResult), agentId = string(result?.agentId)
  if (!agentId) return undefined
  if (!Array.isArray(content)) fail("unsupported", "Claude subagent result has no proven tool call.")
  const links = content.map(object).filter(block => block?.type === "tool_result" && typeof block.tool_use_id === "string" &&
    ["Agent", "Task"].includes(calls.get(block.tool_use_id)?.name ?? ""))
  if (links.length !== 1) fail("unsupported", "Claude subagent result has no unique parent tool call.")
  const block = links[0]!, toolCallId = block.tool_use_id as string, call = calls.get(toolCallId)!
  if (delegated || result?.status !== "completed" || result.isAsync === true || block.is_error === true || record.sourceToolAssistantUUID !== call.uuid)
    fail("unsupported", "Claude subagent requires a completed foreground result with explicit parent evidence.")
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) fail("format", "Claude subagent identity is invalid.")
  return { agentId, toolCallId, toolUuid: call.uuid }
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
        recordLimit === MaxManualReadFileBytes ? "A Claude manual Read file record exceeds 1 MiB." : "A Claude automatic replay record exceeds 64 KiB.")
      const content = pending.subarray(0, newline + 1)
      yield { content, end: lineStart + newline + 1 }
      pending = pending.subarray(newline + 1); lineStart += newline + 1
    }
    if (pending.length > recordLimit || recordLimit !== MaxRecordBytes && pending.length === recordLimit)
      fail("limit", recordLimit === MaxRecordBytes ? "Claude JSONL record exceeds 16 MiB." :
        recordLimit === MaxManualReadFileBytes ? "A Claude manual Read file record exceeds 1 MiB." : "A Claude automatic replay record exceeds 64 KiB.")
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
        revision, projectionRevision: 4, sourceOrder: order, eventIndex: slot * 128 + part,
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
    if (c.projectionRevision !== undefined && ![2, 3, 4].includes(c.projectionRevision)) throw new Error()
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
      c.stream!.seen.at(-3) === auto.boundaryUuid && c.stream!.seen.at(-2) === auto.summaryUuid && c.stream!.seen.at(-1) === c.stream!.lastUuid &&
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
