import type {
  AdapterCollectRequest,
  AdapterCollectionPage,
  AdapterEvent,
  AdapterObservation,
  AdapterOpenContext,
  AdapterRawSegment,
  AdapterSourceProgress,
  AdapterThread,
  AcpSessionUpdate
} from "@atape/domain"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { open, opendir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect, Option, Schema } from "effect"

const CursorVersion = 1 as const
const MaxCursorBytes = 16_000
const MaxMetadataBytes = 1024 * 1024
const MaxJsonlRecordBytes = 4 * 1024 * 1024
const ReadBlockBytes = 64 * 1024
const MaxFilesPerSession = 100

export class CodexArchiveError extends Schema.TaggedError<CodexArchiveError>()("CodexArchiveError", {
  reason: Schema.Literals(["configuration", "io", "format", "cursor", "limit"]),
  message: Schema.String
}) {}

type CodexArchive = {
  readonly context: AdapterOpenContext
  readonly codexHome: string
  readonly projectRoot: string
  readonly projectRepository?: string
}

type RolloutMetadata = {
  readonly threadId: string
  readonly sessionId: string
  readonly parentThreadId?: string
  readonly nickname?: string
  readonly cwd: string
  readonly timestamp: string
  readonly repository?: string
  readonly branch?: string
}

type RolloutFile = {
  readonly path: string
  readonly relativePath: string
  readonly sourceObjectId: string
  readonly sourceName: string
  readonly generation: string
  readonly size: number
  readonly modifiedMs: number
  readonly archived: boolean
  readonly metadata: RolloutMetadata
}

type CodexSession = {
  readonly id: string
  readonly files: ReadonlyArray<RolloutFile>
  readonly modifiedMs: number
}

type CursorFile = {
  readonly sourceObjectId: string
  readonly sourceName: string
  readonly generation: string
  readonly size: number
  readonly archived: boolean
  readonly threadId: string
}

type ActiveCursor = {
  readonly sessionId: string
  readonly selectedModifiedMs: number
  readonly revision: number
  readonly files: ReadonlyArray<CursorFile>
  readonly spawnOffset: number
  readonly eventFileIndex: number
  readonly eventOffset: number
  readonly emitted: boolean
  readonly step: number
}

type CodexCursor = {
  readonly v: typeof CursorVersion
  readonly watermarkModifiedMs: number
  readonly watermarkSessionId: string
  readonly commitSequence?: number
  readonly active?: ActiveCursor
}

const CursorFileSchema = Schema.Struct({
  sourceObjectId: Schema.String,
  sourceName: Schema.String,
  generation: Schema.String,
  size: Schema.Number,
  archived: Schema.Boolean,
  threadId: Schema.String
})

const ActiveCursorSchema = Schema.Struct({
  sessionId: Schema.String,
  selectedModifiedMs: Schema.Number,
  revision: Schema.Number,
  files: Schema.Array(CursorFileSchema),
  spawnOffset: Schema.Number,
  eventFileIndex: Schema.Number,
  eventOffset: Schema.Number,
  emitted: Schema.Boolean,
  step: Schema.Number
})

const CursorSchema = Schema.Struct({
  v: Schema.Literal(CursorVersion),
  watermarkModifiedMs: Schema.Number,
  watermarkSessionId: Schema.String,
  commitSequence: Schema.optionalKey(Schema.Number),
  active: Schema.optionalKey(ActiveCursorSchema)
})

const SessionMetaEnvelopeSchema = Schema.Struct({
  timestamp: Schema.String,
  type: Schema.Literal("session_meta"),
  payload: Schema.Struct({
    id: Schema.String,
    session_id: Schema.optionalKey(Schema.String),
    timestamp: Schema.optionalKey(Schema.String),
    cwd: Schema.String,
    thread_source: Schema.optionalKey(Schema.Unknown),
    source: Schema.optionalKey(Schema.Unknown),
    parent_thread_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    agent_nickname: Schema.optionalKey(Schema.NullOr(Schema.String)),
    git: Schema.optionalKey(Schema.Unknown)
  })
})

const CompletedItemEnvelopeSchema = Schema.Struct({
  timestamp: Schema.String,
  type: Schema.Literal("event_msg"),
  payload: Schema.Struct({
    type: Schema.Literal("item_completed"),
    thread_id: Schema.String,
    item: Schema.Unknown
  })
})

export const openCodexArchive = (
  context: AdapterOpenContext
): Effect.Effect<CodexArchive, CodexArchiveError> => Effect.tryPromise({
  try: async () => {
    const configuredHome = process.env.ATAPE_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex")
    const [codexHome, projectRoot, projectRepository] = await Promise.all([
      realpath(configuredHome),
      realpath(context.project.path),
      context.project.type === "git" ? readGitOrigin(context.project.path) : Promise.resolve(undefined)
    ])
    return {
      context,
      codexHome,
      projectRoot,
      ...(projectRepository === undefined ? {} : { projectRepository: normalizeRepository(projectRepository) })
    }
  },
  catch: (cause) => archiveError("configuration", "Could not open the Codex archive", cause)
})

export const collectCodexPage = (
  archive: CodexArchive,
  request: AdapterCollectRequest
): Effect.Effect<AdapterCollectionPage, CodexArchiveError> => Effect.tryPromise({
  try: () => collectPage(archive, request),
  catch: (cause) => cause instanceof CodexArchiveError
    ? cause
    : archiveError("io", "Could not collect Codex sessions", cause)
})

const collectPage = async (
  archive: CodexArchive,
  request: AdapterCollectRequest
): Promise<AdapterCollectionPage> => {
  throwIfAborted(request.signal)
  const cursor = decodeCursor(request.cursor)
  const sessions = await discoverSessions(archive, request.signal)
  const byId = new Map(sessions.map((session) => [session.id, session]))

  if (cursor.active !== undefined) {
    const active = cursor.active
    const activeSession = byId.get(active.sessionId)
    if (activeSession === undefined) {
      return emptyPage(advanceWatermark(cursor, active.selectedModifiedMs, active.sessionId))
    }
    return collectActiveSession(archive, request, { ...cursor, active }, activeSession)
  }

  const selected = await selectSession(sessions, cursor, request.rawProgress, request.signal)

  if (selected === undefined) {
    if (request.cursor !== null) return emptyPage(cursor)
    return emptyPage({
      ...cursor,
      watermarkModifiedMs: Date.now(),
      watermarkSessionId: ""
    })
  }

  const active = await startSession(selected, request.signal)
  return collectActiveSession(archive, request, { ...cursor, active }, selected)
}

const collectActiveSession = async (
  archive: CodexArchive,
  request: AdapterCollectRequest,
  cursor: CodexCursor & { readonly active: ActiveCursor },
  currentSession: CodexSession
): Promise<AdapterCollectionPage> => {
  const active = cursor.active
  const currentFiles = new Map(currentSession.files.map((file) => [file.sourceObjectId, file]))
  const threads = buildThreads(currentSession, active.revision)
  if (threads.length > request.limits.threadsPerObservation) {
    throw new CodexArchiveError({
      reason: "limit",
      message: `Codex session ${active.sessionId} has ${threads.length} Threads; the Host limit is ${request.limits.threadsPerObservation}.`
    })
  }

  const observedAt = new Date(active.selectedModifiedMs).toISOString()
  const childCount = threads.length - 1
  const session: AdapterObservation["session"] = {
    sourceSessionId: active.sessionId,
    revision: active.revision,
    title: `Codex session ${active.sessionId.slice(0, 8)}`,
    summary: childCount === 0 ? "" : `${childCount} subagent Thread${childCount === 1 ? "" : "s"}`,
    insight: "",
    actor: { name: archive.context.user.id, harness: "Codex" },
    branch: currentSession.files.find((file) => file.metadata.branch)?.metadata.branch ?? "",
    status: active.files.every((file) => file.archived) ? "ended" : "active",
    captureStatus: active.files.every((file) => file.archived) ? "complete" : "healthy",
    updatedAt: observedAt,
    reportedEventCount: 0
  }
  const canonicalBaseBytes = Buffer.byteLength(JSON.stringify({ session, threads, events: [] }))
  if (canonicalBaseBytes > request.limits.canonicalBytesPerObservation) {
    throw new CodexArchiveError({
      reason: "limit",
      message: `Codex session ${active.sessionId} metadata exceeds the Canonical byte limit.`
    })
  }
  const eventPage = await collectEvents(
    active,
    threads,
    currentFiles,
    request.limits.eventsPerObservation,
    request.limits.canonicalBytesPerObservation - canonicalBaseBytes,
    request.signal
  )
  const rawPage = await collectRaw(
    active,
    currentFiles,
    request.rawProgress,
    request.limits.rawSegmentsPerObservation,
    request.limits.rawSegmentBytes,
    request.limits.rawBytesPerObservation,
    request.signal
  )
  const shouldEmit = eventPage.events.length > 0 || rawPage.segments.length > 0 || !active.emitted
  const complete = eventPage.complete && rawPage.complete
  const nextCursor = complete
    ? advanceWatermark(cursor, active.selectedModifiedMs, active.sessionId)
    : {
        ...cursor,
        active: {
          ...active,
          spawnOffset: eventPage.spawnOffset,
          eventFileIndex: eventPage.fileIndex,
          eventOffset: eventPage.offset,
          emitted: active.emitted || shouldEmit,
          step: active.step + (shouldEmit ? 1 : 0)
        }
      }

  if (!shouldEmit) return emptyPage(nextCursor)

  const root = threads.find((thread) => thread.parentSourceThreadId === undefined)
  const observation: AdapterObservation = {
    observationId: `codex-${digest(JSON.stringify({
      sessionId: active.sessionId,
      revision: active.revision,
      step: active.step,
      events: eventPage.events.map((event) => event.sourceEventId),
      raw: rawPage.segments.map((segment) => [segment.sourceObjectId, segment.sourceGeneration, segment.sourceOffset])
    })).slice(0, 40)}`,
    observedAt,
    session,
    threads: root === undefined ? synthesizeRootThread(active.sessionId, active.revision, threads) : threads,
    events: eventPage.events,
    rawSegments: rawPage.segments
  }
  return {
    protocolVersion: request.protocolVersion,
    nextCursor: encodeCursor(nextCursor),
    hasMore: !complete,
    observations: [observation]
  }
}

const startSession = async (session: CodexSession, signal: AbortSignal): Promise<ActiveCursor> => {
  if (session.files.length > MaxFilesPerSession) {
    throw new CodexArchiveError({
      reason: "limit",
      message: `Codex session ${session.id} has more than ${MaxFilesPerSession} rollout files.`
    })
  }
  const files: Array<CursorFile> = []
  for (const file of session.files) {
    throwIfAborted(signal)
    const completeSize = await completeJsonlSize(file.path, file.size, file.archived, signal)
    files.push({
      sourceObjectId: file.sourceObjectId,
      sourceName: file.sourceName,
      generation: file.generation,
      size: completeSize,
      archived: file.archived,
      threadId: file.metadata.threadId
    })
  }
  const allArchived = files.length > 0 && files.every((file) => file.archived)
  const modifiedMicros = Math.max(1, Math.floor(session.modifiedMs * 1_000))
  return {
    sessionId: session.id,
    selectedModifiedMs: session.modifiedMs,
    revision: modifiedMicros * 2 + (allArchived ? 1 : 0),
    files,
    spawnOffset: 0,
    eventFileIndex: 0,
    eventOffset: 0,
    emitted: false,
    step: 0
  }
}

const discoverSessions = async (archive: CodexArchive, signal: AbortSignal): Promise<ReadonlyArray<CodexSession>> => {
  const paths = [
    ...(await listJsonl(join(archive.codexHome, "sessions"), signal)),
    ...(await listJsonl(join(archive.codexHome, "archived_sessions"), signal))
  ]
  const groups = new Map<string, Array<RolloutFile>>()
  for (const path of paths) {
    throwIfAborted(signal)
    let file
    try {
      file = await inspectRollout(archive, path, signal)
    } catch (cause) {
      if (hasCode(cause, "ENOENT")) continue
      throw cause
    }
    if (file === undefined) continue
    const group = groups.get(file.metadata.sessionId) ?? []
    group.push(file)
    groups.set(file.metadata.sessionId, group)
  }
  return [...groups.entries()].map(([id, files]) => ({
    id,
    files: files.sort((left, right) =>
      left.metadata.timestamp.localeCompare(right.metadata.timestamp) || left.relativePath.localeCompare(right.relativePath)),
    modifiedMs: Math.max(...files.map((file) => file.modifiedMs))
  }))
}

const inspectRollout = async (
  archive: CodexArchive,
  path: string,
  signal: AbortSignal
): Promise<RolloutFile | undefined> => {
  const first = await readFirstLine(path, signal)
  if (first === undefined) return undefined
  const metadata = decodeMetadata(first)
  if (metadata === undefined || !(await matchesProject(archive, metadata))) return undefined
  const details = await stat(path)
  if (!details.isFile()) return undefined
  const relativePath = relative(archive.codexHome, path)
  return {
    path,
    relativePath,
    sourceObjectId: `rollout-${digest(basename(path)).slice(0, 32)}`,
    sourceName: basename(path),
    generation: `${details.dev}-${details.ino}-${Math.floor(details.birthtimeMs)}`,
    size: details.size,
    modifiedMs: details.mtimeMs,
    archived: relativePath === "archived_sessions" || relativePath.startsWith(`archived_sessions${sep}`),
    metadata
  }
}

const decodeMetadata = (line: Buffer): RolloutMetadata | undefined => {
  const parsed = parseJSON(line)
  const decoded = Schema.decodeUnknownOption(SessionMetaEnvelopeSchema)(parsed)
  if (Option.isNone(decoded)) return undefined
  const envelope = decoded.value
  const payload = envelope.payload
  const source = record(payload.source)
  const subagent = record(source?.subagent)
  const spawn = record(subagent?.thread_spawn)
  const git = record(payload.git)
  const parentThreadId = stringValue(spawn?.parent_thread_id) ?? stringValue(payload.parent_thread_id)
  const nickname = stringValue(spawn?.agent_nickname) ?? stringValue(payload.agent_nickname)
  return {
    threadId: payload.id,
    sessionId: payload.session_id ?? (parentThreadId === undefined ? payload.id : parentThreadId),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(nickname === undefined ? {} : { nickname }),
    cwd: payload.cwd,
    timestamp: payload.timestamp ?? envelope.timestamp,
    ...(stringValue(git?.repository_url) === undefined ? {} : { repository: stringValue(git?.repository_url) as string }),
    ...(stringValue(git?.branch) === undefined ? {} : { branch: stringValue(git?.branch) as string })
  }
}

const matchesProject = async (archive: CodexArchive, metadata: RolloutMetadata) => {
  const workingDirectory = await realpath(metadata.cwd).catch(() => resolve(metadata.cwd))
  if (isPathInside(archive.projectRoot, workingDirectory)) return true
  return archive.context.project.type === "git" && archive.projectRepository !== undefined &&
    metadata.repository !== undefined && normalizeRepository(metadata.repository) === archive.projectRepository
}

const buildThreads = (session: CodexSession, revision: number): ReadonlyArray<AdapterThread> => {
  const metadataByThread = new Map<string, RolloutMetadata>()
  for (const file of session.files) {
    if (!metadataByThread.has(file.metadata.threadId)) metadataByThread.set(file.metadata.threadId, file.metadata)
  }
  if (!metadataByThread.has(session.id)) {
    metadataByThread.set(session.id, {
      threadId: session.id,
      sessionId: session.id,
      cwd: session.files[0]?.metadata.cwd ?? "",
      timestamp: session.files[0]?.metadata.timestamp ?? new Date(session.modifiedMs).toISOString()
    })
  }
  return [...metadataByThread.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.threadId.localeCompare(right.threadId))
    .map((metadata) => ({
      sourceThreadId: metadata.threadId,
      ...(metadata.threadId === session.id
        ? {}
        : { parentSourceThreadId: metadataByThread.has(metadata.parentThreadId ?? "") ? metadata.parentThreadId : session.id }),
      revision,
      label: metadata.threadId === session.id ? "Main" : metadata.nickname || `Subagent ${metadata.threadId.slice(0, 8)}`,
      summary: "",
      captureStatus: "healthy"
    }))
}

const synthesizeRootThread = (
  sessionId: string,
  revision: number,
  threads: ReadonlyArray<AdapterThread>
): ReadonlyArray<AdapterThread> => [{
  sourceThreadId: sessionId,
  revision,
  label: "Main",
  summary: "",
  captureStatus: "healthy"
}, ...threads]

type EventPage = {
  readonly events: ReadonlyArray<AdapterEvent>
  readonly spawnOffset: number
  readonly fileIndex: number
  readonly offset: number
  readonly complete: boolean
}

const collectEvents = async (
  active: ActiveCursor,
  threads: ReadonlyArray<AdapterThread>,
  currentFiles: ReadonlyMap<string, RolloutFile>,
  limit: number,
  byteLimit: number,
  signal: AbortSignal
): Promise<EventPage> => {
  const events: Array<AdapterEvent> = []
  let eventBytes = 0
  const appendEvent = (event: AdapterEvent) => {
    const additionalBytes = Buffer.byteLength(JSON.stringify(event)) + (events.length === 0 ? 0 : 1)
    if (additionalBytes > byteLimit - eventBytes) {
      if (events.length === 0) {
        throw new CodexArchiveError({
          reason: "limit",
          message: `Codex Event ${event.sourceEventId} exceeds the Canonical byte limit.`
        })
      }
      return false
    }
    events.push(event)
    eventBytes += additionalBytes
    return true
  }
  const children = threads.filter((thread) => thread.parentSourceThreadId !== undefined)
  let spawnOffset = active.spawnOffset
  while (spawnOffset < children.length && events.length < limit) {
    const child = children[spawnOffset]
    if (child === undefined || child.parentSourceThreadId === undefined) break
    const metadata = [...currentFiles.values()].find((file) => file.metadata.threadId === child.sourceThreadId)?.metadata
    const occurredAt = metadata?.timestamp ?? new Date(active.selectedModifiedMs).toISOString()
    const spawnEvent: AdapterEvent = {
      sourceEventId: `spawn-${child.sourceThreadId}`,
      sourceThreadId: child.parentSourceThreadId,
      revision: 1,
      projectionRevision: 1,
      sourceOrder: timestampOrder(occurredAt),
      eventIndex: 0,
      orderFidelity: "native",
      fidelity: "derived",
      rawRef: { _tag: "unavailable", reason: "Derived from Codex session metadata" },
      occurredAt,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `spawn-${child.sourceThreadId}`,
        title: `Spawn ${child.label}`,
        kind: "think",
        status: "completed"
      },
      childSourceThreadId: child.sourceThreadId
    }
    if (!appendEvent(spawnEvent)) break
    spawnOffset++
  }

  let fileIndex = active.eventFileIndex
  let offset = active.eventOffset
  const eventIds = new Set(events.map((event) => `${event.sourceThreadId}\0${event.sourceEventId}`))
  while (spawnOffset >= children.length && fileIndex < active.files.length && events.length < limit) {
    const snapshot = active.files[fileIndex]
    if (snapshot === undefined) break
    const current = currentFiles.get(snapshot.sourceObjectId)
    if (current === undefined || current.generation !== snapshot.generation) {
      fileIndex++
      offset = 0
      continue
    }
    let reachedEnd = true
    for await (const line of readLines(current.path, offset, snapshot.size, signal)) {
      const event = mapCompletedItem(line.content, line.start, snapshot, active.sessionId)
      if (event === undefined) {
        offset = line.end
        continue
      }
      const key = `${event.sourceThreadId}\0${event.sourceEventId}`
      if (!eventIds.has(key)) {
        if (!appendEvent(event)) {
          reachedEnd = false
          break
        }
        eventIds.add(key)
      }
      offset = line.end
      if (events.length >= limit) {
        reachedEnd = offset >= snapshot.size
        break
      }
    }
    if (!reachedEnd || (events.length >= limit && offset < snapshot.size)) break
    fileIndex++
    offset = 0
  }
  return {
    events,
    spawnOffset,
    fileIndex,
    offset,
    complete: spawnOffset >= children.length && fileIndex >= active.files.length
  }
}

const mapCompletedItem = (
  line: Buffer,
  byteOffset: number,
  file: CursorFile,
  sessionId: string
): AdapterEvent | undefined => {
  const parsed = parseJSON(line)
  const decoded = Schema.decodeUnknownOption(CompletedItemEnvelopeSchema)(parsed)
  if (Option.isNone(decoded) || decoded.value.payload.thread_id !== file.threadId) return undefined
  const envelope = decoded.value
  const item = record(envelope.payload.item)
  if (item === undefined) return undefined
  const itemId = stringValue(item.id) ?? `${file.sourceObjectId}-${byteOffset}`
  const update = mapItemUpdate(item, itemId)
  if (update === undefined) return undefined
  return {
    sourceEventId: truncateUtf8(itemId, 500),
    sourceThreadId: file.threadId || sessionId,
    revision: 1,
    projectionRevision: 1,
    sourceOrder: timestampOrder(envelope.timestamp),
    eventIndex: byteOffset,
    orderFidelity: "native",
    fidelity: "native",
    rawRef: { _tag: "object", sourceObjectId: file.sourceObjectId, fragment: `#byte=${byteOffset}` },
    occurredAt: validTimestamp(envelope.timestamp) ? envelope.timestamp : new Date(0).toISOString(),
    update
  }
}

const mapItemUpdate = (item: Record<string, unknown>, fallbackId: string): AcpSessionUpdate | undefined => {
  const type = stringValue(item.type)
  const id = truncateUtf8(stringValue(item.id) ?? fallbackId, 500)
  switch (type) {
    case "UserMessage": {
      const text = itemText(item.content)
      return text === "" ? undefined : {
        sessionUpdate: "user_message_chunk",
        messageId: id,
        content: { type: "text", text: truncateUtf8(text, 1024 * 1024) }
      }
    }
    case "AgentMessage": {
      const text = itemText(item.content)
      return text === "" ? undefined : {
        sessionUpdate: "agent_message_chunk",
        messageId: id,
        content: { type: "text", text: truncateUtf8(text, 1024 * 1024) }
      }
    }
    case "Reasoning": {
      const text = itemText(item.summary_text)
      return text === "" ? undefined : {
        sessionUpdate: "agent_thought_chunk",
        messageId: id,
        content: { type: "text", text: truncateUtf8(text, 1024 * 1024) }
      }
    }
    case "CommandExecution": {
      const command = itemText(item.command) || "Shell command"
      return toolUpdate(id, command, "execute", item.status, item.exit_code)
    }
    case "McpToolCall": {
      const label = [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join("/") || "MCP tool"
      return toolUpdate(id, label, "other", item.status)
    }
    case "FileChange":
      return toolUpdate(id, "Apply file changes", "edit", item.status)
    case "ImageView":
      return toolUpdate(id, `View image ${basename(stringValue(item.path) ?? "image")}`, "read", "completed")
    case "Extension":
      return toolUpdate(id, stringValue(item.kind) || "Extension", "other", "completed")
    default:
      return undefined
  }
}

const toolUpdate = (
  id: string,
  title: string,
  kind: "read" | "edit" | "execute" | "other",
  providerStatus: unknown,
  exitCode?: unknown
): AcpSessionUpdate => {
  const status = typeof exitCode === "number"
    ? exitCode === 0 ? "completed" as const : "failed" as const
    : mapToolStatus(providerStatus)
  return {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: truncateUtf8(title, 500),
    kind,
    status
  }
}

const mapToolStatus = (value: unknown): "pending" | "in_progress" | "completed" | "failed" => {
  switch (value) {
    case "pending": return "pending"
    case "in_progress":
    case "running": return "in_progress"
    case "completed":
    case "success": return "completed"
    default: return "failed"
  }
}

type RawPage = {
  readonly segments: ReadonlyArray<AdapterRawSegment>
  readonly complete: boolean
}

const collectRaw = async (
  active: ActiveCursor,
  currentFiles: ReadonlyMap<string, RolloutFile>,
  progress: ReadonlyArray<AdapterSourceProgress>,
  segmentLimit: number,
  segmentBytes: number,
  totalBytes: number,
  signal: AbortSignal
): Promise<RawPage> => {
  const segments: Array<AdapterRawSegment> = []
  const positions = new Map<string, { generation: string; offset: number; finalized: boolean }>()
  for (const file of active.files) {
    const current = currentFiles.get(file.sourceObjectId)
    if (current === undefined || current.generation !== file.generation) continue
    const saved = progress.find((item) => item.sourceSessionId === active.sessionId &&
      item.sourceObjectId === file.sourceObjectId)
    positions.set(file.sourceObjectId, saved?.sourceGeneration === file.generation
      ? { generation: file.generation, offset: saved.sourceOffset, finalized: saved.finalized }
      : { generation: file.generation, offset: 0, finalized: false })
  }

  let usedBytes = 0
  for (const file of active.files) {
    throwIfAborted(signal)
    const current = currentFiles.get(file.sourceObjectId)
    const position = positions.get(file.sourceObjectId)
    if (current === undefined || current.generation !== file.generation || position === undefined) continue
    if (position.finalized || position.offset > file.size) continue

    if (file.archived && position.offset === file.size && segments.length < segmentLimit) {
      segments.push(rawSegment(file, position.offset, "", true))
      positions.set(file.sourceObjectId, { ...position, finalized: true })
      continue
    }

    while (position.offset < file.size && segments.length < segmentLimit && usedBytes < totalBytes) {
      const allowance = Math.min(segmentBytes, totalBytes - usedBytes)
      const chunk = await readRawRecordChunk(
        current.path,
        position.offset,
        file.size,
        allowance,
        usedBytes > 0,
        signal
      )
      if (chunk === undefined) break
      const final = file.archived && chunk.end === file.size
      segments.push(rawSegment(file, position.offset, chunk.content, final))
      usedBytes += chunk.content.byteLength
      position.offset = chunk.end
      position.finalized = final
    }
  }

  const complete = active.files.every((file) => {
    const current = currentFiles.get(file.sourceObjectId)
    if (current === undefined || current.generation !== file.generation) return true
    const position = positions.get(file.sourceObjectId)
    if (position === undefined || position.offset < file.size) return false
    return !file.archived || position.finalized
  })
  return { segments, complete }
}

const rawSegment = (file: CursorFile, offset: number, content: Uint8Array | string, final: boolean): AdapterRawSegment => ({
  sourceObjectId: file.sourceObjectId,
  sourceGeneration: file.generation,
  sourceOffset: offset,
  sourceName: file.sourceName,
  mediaType: "application/x-ndjson",
  content: typeof content === "string" ? content : Buffer.from(content).toString("utf8"),
  final
})

const readRawRecordChunk = async (
  path: string,
  start: number,
  end: number,
  limit: number,
  pageAlreadyHasBytes: boolean,
  signal: AbortSignal
): Promise<{ readonly content: Uint8Array; readonly end: number } | undefined> => {
  if (limit <= 0 || start >= end) return undefined
  const handle = await open(path, "r")
  try {
    throwIfAborted(signal)
    const length = Math.min(limit, end - start)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    if (bytesRead === 0) return undefined
    let accepted = bytesRead
    if (start + bytesRead < end) {
      accepted = buffer.lastIndexOf(0x0a, bytesRead - 1) + 1
      if (accepted === 0) {
        if (pageAlreadyHasBytes) return undefined
        throw new CodexArchiveError({
          reason: "limit",
          message: `Codex rollout ${basename(path)} contains a JSONL record larger than ${limit} bytes.`
        })
      }
    }
    return { content: buffer.subarray(0, accepted), end: start + accepted }
  } finally {
    await handle.close()
  }
}

type Line = { readonly start: number; readonly end: number; readonly content: Buffer }

async function* readLines(
  path: string,
  start: number,
  end: number,
  signal: AbortSignal
): AsyncGenerator<Line> {
  const handle = await open(path, "r")
  let position = start
  let pending = Buffer.alloc(0)
  let pendingStart = start
  try {
    while (position < end) {
      throwIfAborted(signal)
      const length = Math.min(ReadBlockBytes, end - position)
      const block = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(block, 0, length, position)
      if (bytesRead === 0) break
      position += bytesRead
      pending = pending.length === 0
        ? block.subarray(0, bytesRead)
        : Buffer.concat([pending, block.subarray(0, bytesRead)])
      let newline = pending.indexOf(0x0a)
      while (newline >= 0) {
        const lineEnd = pendingStart + newline + 1
        yield { start: pendingStart, end: lineEnd, content: pending.subarray(0, newline + 1) }
        pending = pending.subarray(newline + 1)
        pendingStart = lineEnd
        newline = pending.indexOf(0x0a)
      }
      if (pending.length > MaxJsonlRecordBytes) {
        throw new CodexArchiveError({
          reason: "limit",
          message: `Codex rollout ${basename(path)} contains a JSONL record larger than ${MaxJsonlRecordBytes} bytes.`
        })
      }
    }
    if (pending.length > 0 && position >= end) {
      yield { start: pendingStart, end: position, content: pending }
    }
  } finally {
    await handle.close()
  }
}

const readFirstLine = async (path: string, signal: AbortSignal): Promise<Buffer | undefined> => {
  const handle = await open(path, "r")
  let pending = Buffer.alloc(0)
  let position = 0
  try {
    while (pending.length <= MaxMetadataBytes) {
      throwIfAborted(signal)
      const block = Buffer.allocUnsafe(ReadBlockBytes)
      const { bytesRead } = await handle.read(block, 0, block.length, position)
      if (bytesRead === 0) return pending.length === 0 ? undefined : pending
      position += bytesRead
      pending = pending.length === 0
        ? block.subarray(0, bytesRead)
        : Buffer.concat([pending, block.subarray(0, bytesRead)])
      const newline = pending.indexOf(0x0a)
      if (newline >= 0) return pending.subarray(0, newline + 1)
    }
    return undefined
  } finally {
    await handle.close()
  }
}

const completeJsonlSize = async (
  path: string,
  size: number,
  archived: boolean,
  signal: AbortSignal
): Promise<number> => {
  if (archived || size === 0) return size
  const handle = await open(path, "r")
  try {
    throwIfAborted(signal)
    const length = Math.min(size, MaxJsonlRecordBytes + 1)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, size - length)
    const newline = buffer.lastIndexOf(0x0a, bytesRead - 1)
    if (newline >= 0) return size - length + newline + 1
    if (size <= length) return 0
    throw new CodexArchiveError({
      reason: "limit",
      message: `Codex rollout ${basename(path)} has an incomplete JSONL record larger than ${MaxJsonlRecordBytes} bytes.`
    })
  } finally {
    await handle.close()
  }
}

const listJsonl = async (root: string, signal: AbortSignal): Promise<ReadonlyArray<string>> => {
  const paths: Array<string> = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || paths.length >= 100_000) return
    let entries
    try {
      entries = await opendir(directory)
    } catch (cause) {
      if (hasCode(cause, "ENOENT")) return
      throw cause
    }
    for await (const entry of entries) {
      throwIfAborted(signal)
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path, depth + 1)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path)
    }
  }
  await visit(root, 0)
  return paths.sort()
}

const selectSession = async (
  sessions: ReadonlyArray<CodexSession>,
  cursor: CodexCursor,
  progress: ReadonlyArray<AdapterSourceProgress>,
  signal: AbortSignal
) => {
  const ordered = [...sessions].sort(compareSessions)
  const changed = ordered.find((session) => isAfterWatermark(session, cursor))
  if (changed !== undefined) return changed
  for (const session of ordered) {
    if (await sessionNeedsRaw(session, progress, signal)) return session
  }
  return undefined
}

const sessionNeedsRaw = async (
  session: CodexSession,
  progress: ReadonlyArray<AdapterSourceProgress>,
  signal: AbortSignal
) => {
  for (const file of session.files) {
    throwIfAborted(signal)
    const saved = progress.find((item) => item.sourceSessionId === session.id &&
      item.sourceObjectId === file.sourceObjectId)
    if (saved === undefined || saved.sourceGeneration !== file.generation) return true
    if (file.archived && !saved.finalized) return true
    if (saved.sourceOffset < file.size) {
      const availableSize = await completeJsonlSize(file.path, file.size, file.archived, signal)
      if (saved.sourceOffset < availableSize) return true
    }
  }
  return false
}

const isAfterWatermark = (session: CodexSession, cursor: CodexCursor) =>
  session.modifiedMs > cursor.watermarkModifiedMs ||
  session.modifiedMs === cursor.watermarkModifiedMs && session.id > cursor.watermarkSessionId

const compareSessions = (left: CodexSession, right: CodexSession) =>
  left.modifiedMs - right.modifiedMs || left.id.localeCompare(right.id)

const advanceWatermark = (cursor: CodexCursor, modifiedMs: number, sessionId: string): CodexCursor => {
  const advances = modifiedMs > cursor.watermarkModifiedMs ||
    modifiedMs === cursor.watermarkModifiedMs && sessionId > cursor.watermarkSessionId
  return {
    v: CursorVersion,
    watermarkModifiedMs: advances ? modifiedMs : cursor.watermarkModifiedMs,
    watermarkSessionId: advances ? sessionId : cursor.watermarkSessionId,
    commitSequence: (cursor.commitSequence ?? 0) + 1
  }
}

const emptyPage = (cursor: CodexCursor): AdapterCollectionPage => ({
  protocolVersion: "atape.adapter.v1alpha1",
  nextCursor: encodeCursor(cursor),
  hasMore: false,
  observations: []
})

const decodeCursor = (value: string | null): CodexCursor => {
  if (value === null) {
    return { v: CursorVersion, watermarkModifiedMs: 0, watermarkSessionId: "", commitSequence: 0 }
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown
    const decoded = Schema.decodeUnknownOption(CursorSchema)(parsed)
    if (Option.isNone(decoded) || !validCursor(decoded.value)) throw new Error("invalid cursor fields")
    return decoded.value
  } catch (cause) {
    throw archiveError("cursor", "The Codex Adapter cursor is invalid", cause)
  }
}

const validCursor = (cursor: CodexCursor) => Number.isFinite(cursor.watermarkModifiedMs) &&
  cursor.watermarkModifiedMs >= 0 && cursor.watermarkSessionId.length <= 500 &&
  (cursor.commitSequence === undefined ||
    (Number.isSafeInteger(cursor.commitSequence) && cursor.commitSequence >= 0)) &&
  (cursor.active === undefined || (
    Number.isSafeInteger(cursor.active.revision) && cursor.active.revision >= 1 &&
    Number.isSafeInteger(cursor.active.spawnOffset) && cursor.active.spawnOffset >= 0 &&
    Number.isSafeInteger(cursor.active.eventFileIndex) && cursor.active.eventFileIndex >= 0 &&
    Number.isSafeInteger(cursor.active.eventOffset) && cursor.active.eventOffset >= 0 &&
    Number.isSafeInteger(cursor.active.step) && cursor.active.step >= 0 &&
    cursor.active.files.length <= 100 &&
    cursor.active.files.every((file) => Number.isSafeInteger(file.size) && file.size >= 0)
  ))

const encodeCursor = (cursor: CodexCursor) => {
  const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
  if (Buffer.byteLength(encoded) > MaxCursorBytes) {
    throw new CodexArchiveError({
      reason: "cursor",
      message: `The Codex Adapter cursor exceeds ${MaxCursorBytes} bytes.`
    })
  }
  return encoded
}

const readGitOrigin = (projectPath: string): Promise<string | undefined> => new Promise((resolveOrigin) => {
  execFile("git", ["-C", projectPath, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  }, (error, stdout) => resolveOrigin(error === null && stdout.trim() !== "" ? stdout.trim() : undefined))
})

const normalizeRepository = (value: string) => value.trim().toLowerCase()
  .replace(/^ssh:\/\//, "")
  .replace(/^git@([^:]+):/, "$1/")
  .replace(/^git@/, "")
  .replace(/^https?:\/\//, "")
  .replace(/\.git$/, "")
  .replace(/\/$/, "")

const isPathInside = (root: string, candidate: string) => {
  if (!isAbsolute(candidate)) return false
  const child = relative(root, resolve(candidate))
  return child === "" || child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

const itemText = (value: unknown): string => {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value.flatMap((item) => {
    if (typeof item === "string") return [item]
    const entry = record(item)
    return typeof entry?.text === "string" ? [entry.text] : []
  }).filter((text) => text.trim() !== "").join("\n")
}

const parseJSON = (line: Buffer): unknown => {
  try {
    return JSON.parse(line.toString("utf8")) as unknown
  } catch {
    return undefined
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const stringValue = (value: unknown) => typeof value === "string" && value !== "" ? value : undefined
const timestampOrder = (value: string) => Math.max(0, Number.isNaN(Date.parse(value)) ? 0 : Date.parse(value))
const validTimestamp = (value: string) => !Number.isNaN(Date.parse(value))
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

const truncateUtf8 = (value: string, maxBytes: number) => {
  const encoded = Buffer.from(value, "utf8")
  if (encoded.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--
  return encoded.subarray(0, end).toString("utf8")
}

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Codex collection was cancelled")
}

const archiveError = (
  reason: "configuration" | "io" | "format" | "cursor" | "limit",
  prefix: string,
  cause: unknown
) => new CodexArchiveError({
  reason,
  message: `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
})

const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code
