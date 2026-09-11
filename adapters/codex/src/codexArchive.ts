import type {
  AdapterCollectRequest,
  AdapterCollectionPage,
  AdapterEvent,
  AdapterObservation,
  AdapterOpenContext,
  AdapterRawSegment,
  AdapterSourceProgress,
  AdapterThread,
  AdapterUsage,
  AcpSessionUpdate
} from "@atape/domain"
import { createHash } from "node:crypto"
import { AdapterThread as AdapterThreadSchema, GitAttributionVersion, MaxSourceFailures, type AdapterSourceFailure } from "@atape/domain"
import { open, opendir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { codexHome as resolveCodexHome } from "@atape/adapter-catalog/node"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import { Effect, Option, Schema } from "effect"

const CursorVersion = 5 as const
const MaxCursorBytes = 1024 * 1024
const MaxDecodedCursorBytes = 16 * 1024 * 1024
const CompressedCursorPrefix = "z1:"
const MaxMetadataBytes = 1024 * 1024
const MaxJsonlRecordBytes = 16 * 1024 * 1024
const MaxSessionIndexBytes = 16 * 1024 * 1024
const MaxTitleScanBytes = 4 * 1024 * 1024
const MaxTitleCharacters = 80
const ReadBlockBytes = 64 * 1024
const MaxFilesPerSession = 100
const CanonicalProjectionRevisionOffset = 8

export class CodexArchiveError extends Schema.TaggedError<CodexArchiveError>()("CodexArchiveError", {
  reason: Schema.Literals(["configuration", "io", "format", "cursor", "limit"]),
  message: Schema.String
}) {}

type CodexArchive = {
  readonly context: AdapterOpenContext
  readonly codexHome: string
  readonly projectRoot: string
  projectionCache?: { readonly key: string; readonly value: CanonicalProjection }
  inventory?: ReadonlyArray<CodexSession>
  activeSessionCache?: CodexSession
  inventoryPages?: number
  inventoryTitleStamp?: string
  inventoryFailures?: ReadonlyArray<AdapterSourceFailure>
  inventoryFailuresTruncated?: boolean
}

type RolloutMetadata = {
  readonly threadId: string
  readonly paginated: boolean
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
  readonly providerTitle?: SessionTitle
}

type SessionTitle = {
  readonly value: string
  readonly modifiedMs: number
}

type CursorFile = {
  readonly sourceObjectId: string
  readonly sourceName: string
  readonly generation: string
  readonly size: number
  readonly archived: boolean
  readonly threadId: string
  readonly startOffset?: number
  readonly modifiedMs?: number
}

type ActiveCursor = {
  readonly frozenThreads?: ReadonlyArray<AdapterThread>
  readonly frozenBranch?: string
  readonly quantum?: number
  readonly phase: "canonical" | "raw"
  readonly sessionId: string
  readonly selectedModifiedMs: number
  readonly revision: number
  readonly providerTitle?: string
  readonly resolvedTitle?: string
  readonly files: ReadonlyArray<CursorFile>
  readonly spawnOffset: number
  readonly eventFileIndex: number
  readonly eventOffset: number
  readonly emitted: boolean
  readonly step: number
}

type CodexCursor = {
  readonly v: typeof CursorVersion
  readonly eventProjectionVersion?: number
  readonly usageVersion?: number
  readonly watermarkModifiedMs: number
  readonly watermarkSessionId: string
  readonly commitSequence?: number
  readonly lastCanonicalSessionId?: string
  readonly lastCanonicalSourceKey?: string
  readonly active?: ActiveCursor
  readonly failed?: ReadonlyArray<{ sessionId: string; fingerprint: string; retryAt: number; reason: "io" | "format" | "limit" }>
  readonly pending?: ReadonlyArray<ActiveCursor>
  readonly lastSessionId?: string
  readonly canonicalTurns?: number
  readonly lastPhase?: "canonical" | "raw"
  readonly baselineModifiedMs?: number
  readonly baselineSessionId?: string
  readonly canonicalProgress?: ReadonlyArray<{ readonly sessionId: string; readonly modifiedMs: number; readonly revision?: number; readonly files: ReadonlyArray<CursorFile> }>
}

const CursorFileSchema = Schema.Struct({
  sourceObjectId: Schema.String,
  sourceName: Schema.String,
  generation: Schema.String,
  size: Schema.Number,
  archived: Schema.Boolean,
  threadId: Schema.String,
  startOffset: Schema.optionalKey(Schema.Number),
  modifiedMs: Schema.optionalKey(Schema.Number)
})

const ActiveCursorSchema = Schema.Struct({
  frozenThreads: Schema.optionalKey(Schema.Array(AdapterThreadSchema)),
  frozenBranch: Schema.optionalKey(Schema.String),
  quantum: Schema.optionalKey(Schema.Number),
  phase: Schema.Literals(["canonical", "raw"]),
  sessionId: Schema.String,
  selectedModifiedMs: Schema.Number,
  revision: Schema.Number,
  providerTitle: Schema.optionalKey(Schema.String),
  resolvedTitle: Schema.optionalKey(Schema.String),
  files: Schema.Array(CursorFileSchema),
  spawnOffset: Schema.Number,
  eventFileIndex: Schema.Number,
  eventOffset: Schema.Number,
  emitted: Schema.Boolean,
  step: Schema.Number
})

const CursorSchema = Schema.Struct({
  eventProjectionVersion: Schema.optionalKey(Schema.Number),
  usageVersion: Schema.optionalKey(Schema.Literal(1)),
  v: Schema.Literal(CursorVersion),
  watermarkModifiedMs: Schema.Number,
  watermarkSessionId: Schema.String,
  commitSequence: Schema.optionalKey(Schema.Number),
  lastCanonicalSessionId: Schema.optionalKey(Schema.String),
  lastCanonicalSourceKey: Schema.optionalKey(Schema.String),
  active: Schema.optionalKey(ActiveCursorSchema),
  pending: Schema.optionalKey(Schema.Array(ActiveCursorSchema)),
  failed: Schema.optionalKey(Schema.Array(Schema.Struct({ sessionId: Schema.String, fingerprint: Schema.String,
    retryAt: Schema.Number, reason: Schema.Literals(["io", "format", "limit"]) }))),
  lastSessionId: Schema.optionalKey(Schema.String),
  canonicalTurns: Schema.optionalKey(Schema.Number),
  lastPhase: Schema.optionalKey(Schema.Literals(["canonical", "raw"])),
  baselineModifiedMs: Schema.optionalKey(Schema.Number),
  baselineSessionId: Schema.optionalKey(Schema.String),
  canonicalProgress: Schema.optionalKey(Schema.Array(Schema.Struct({ sessionId: Schema.String, modifiedMs: Schema.Number, revision: Schema.optionalKey(Schema.Number), files: Schema.Array(CursorFileSchema) })))
})

const PreviousActiveCursorSchema = Schema.Struct({
  sessionId: Schema.String,
  selectedModifiedMs: Schema.Number,
  revision: Schema.Number,
  providerTitle: Schema.optionalKey(Schema.String),
  files: Schema.Array(CursorFileSchema),
  spawnOffset: Schema.Number,
  eventFileIndex: Schema.Number,
  eventOffset: Schema.Number,
  emitted: Schema.Boolean,
  step: Schema.Number
})

const PreviousCursorSchema = Schema.Struct({
  v: Schema.Literal(4),
  watermarkModifiedMs: Schema.Number,
  watermarkSessionId: Schema.String,
  commitSequence: Schema.optionalKey(Schema.Number),
  active: Schema.optionalKey(PreviousActiveCursorSchema)
})

const LegacyCursorSchema = Schema.Struct({
  v: Schema.Literals([1, 2, 3]),
  watermarkModifiedMs: Schema.Number,
  watermarkSessionId: Schema.String,
  commitSequence: Schema.optionalKey(Schema.Number),
  active: Schema.optionalKey(PreviousActiveCursorSchema)
})

const SessionTitleIndexRecordSchema = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.String,
  updated_at: Schema.String
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
    history_mode: Schema.optionalKey(Schema.Unknown),
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

const ResponseItemEnvelopeSchema = Schema.Struct({
  timestamp: Schema.String,
  type: Schema.Literal("response_item"),
  payload: Schema.Unknown
})

const EventMessageEnvelopeSchema = Schema.Struct({
  timestamp: Schema.String,
  type: Schema.Literal("event_msg"),
  payload: Schema.Unknown
})

export const openCodexArchive = (
  context: AdapterOpenContext
): Effect.Effect<CodexArchive, CodexArchiveError> => Effect.tryPromise({
  try: async () => {
    const configuredHome = resolveCodexHome(process.env, homedir())
    if (context.project.type === "git" && context.gitAttribution?.version !== GitAttributionVersion) {
      throw new CodexArchiveError({ reason: "configuration", message: "Upgrade the ATape CLI to collect Git Projects with shared attribution." })
    }
    const [codexHome, projectRoot] = await Promise.all([
      realpath(configuredHome),
      context.project.type === "git" ? Promise.resolve(context.project.path) : realpath(context.project.path)
    ])
    return { context, codexHome, projectRoot }
  },
  catch: (cause) => archiveError("configuration", "Could not open the Codex archive", cause)
})

export const collectCodexPage = (
  archive: CodexArchive,
  request: AdapterCollectRequest
): Effect.Effect<AdapterCollectionPage, CodexArchiveError> => Effect.tryPromise({
  try: async () => {
    const diagnostics: { failures: AdapterSourceFailure[]; truncated: boolean } = { failures: [], truncated: false }
    const page = await collectPage(archive, request, diagnostics)
    const inventory = archive.inventory ?? []
    const next = decodeCursor(page.nextCursor)
    const acknowledged = new Map(request.rawProgress.map(item => [`${item.sourceSessionId}:${item.sourceObjectId}:${item.sourceGeneration}`, item.sourceOffset]))
    for (const observation of page.observations) for (const raw of observation.rawSegments)
      acknowledged.set(`${observation.session.sourceSessionId}:${raw.sourceObjectId}:${raw.sourceGeneration}`, raw.sourceOffset + Buffer.byteLength(raw.content))
    const pendingBytes = (session: CodexSession) => session.files.reduce((bytes, file) => bytes +
      Math.max(0, file.size - (acknowledged.get(`${session.id}:${file.sourceObjectId}:${file.generation}`) ?? 0)), 0)
    const progress = {
      phase: !page.hasMore ? "idle" as const : page.observations.some(o => o.events.length) ? "canonical" as const : "raw" as const,
      sourceFiles: inventory.reduce((sum, session) => sum + session.files.length, 0),
      pendingCanonicalSessions: inventory.filter(session => isAfterWatermark(session, next) || next.active?.sessionId === session.id && next.active.phase === "canonical" || next.pending?.some(item => item.sessionId === session.id && item.phase === "canonical") ||
        archive.context.project.type === "git" && !next.canonicalProgress?.some(item => item.sessionId === session.id) && pendingBytes(session) > 0).length,
      pendingRawBytes: request.rawCaptureEnabled === false ? 0 : inventory.reduce((sum, session) => sum + pendingBytes(session), 0)
    }
    return { ...page, progress, ...(diagnostics.failures.length ? { sourceFailures: diagnostics.failures } : {}),
      ...(diagnostics.truncated ? { sourceFailuresTruncated: true } : {}) }
  },
  catch: (cause) => cause instanceof CodexArchiveError
    ? cause
    : archiveError("io", "Could not collect Codex sessions", cause)
})

const collectPage = async (
  archive: CodexArchive,
  request: AdapterCollectRequest,
  diagnostics: { failures: AdapterSourceFailure[]; truncated: boolean }
): Promise<AdapterCollectionPage> => {
  throwIfAborted(request.signal)
  archive.inventoryPages = (archive.inventoryPages ?? 0) + 1
  const decoded = decodeCursor(request.cursor)
  const projectionUpgrade = decoded.eventProjectionVersion !== 3 || decoded.usageVersion !== 1
  const rewindCanonical = (active: ActiveCursor): ActiveCursor => active.phase !== "canonical" ? active : {
    ...active, spawnOffset: 0, eventFileIndex: 0, eventOffset: 0, emitted: false, step: 0, quantum: 0,
    files: active.files.map(({ startOffset: _start, ...file }) => file)
  }
  let cursor: CodexCursor = { ...decoded,
    eventProjectionVersion: 3,
    usageVersion: 1,
    ...(projectionUpgrade ? { pending: decoded.pending?.map(rewindCanonical) ?? [],
      ...(decoded.active ? { active: rewindCanonical(decoded.active) } : {}) } : {}),
    ...(decoded.active?.emitted && decoded.canonicalProgress === undefined
      ? { active: { ...(projectionUpgrade ? rewindCanonical(decoded.active) : decoded.active), revision: decoded.active.revision + 2 } } : {}),
    baselineModifiedMs: projectionUpgrade ? 0 : decoded.baselineModifiedMs ?? decoded.watermarkModifiedMs,
    baselineSessionId: projectionUpgrade ? "" : decoded.baselineSessionId ?? decoded.watermarkSessionId,
    canonicalProgress: projectionUpgrade ? [] : decoded.canonicalProgress ?? [] }
  if (request.rawCaptureEnabled === false) {
    const { active, ...rest } = cursor
    cursor = { ...rest, ...(active?.phase === "canonical" ? { active } : {}),
      pending: (cursor.pending ?? []).filter(item => item.phase !== "raw") }
  }
  if (cursor.active !== undefined && archive.activeSessionCache?.id === cursor.active.sessionId) {
    let refreshed
    try { refreshed = await refreshActiveSession(archive, archive.activeSessionCache, request.signal) }
    catch (cause) { return quarantineSession(request, cursor, archive.activeSessionCache, diagnostics, cause) }
    if (refreshed !== undefined) {
      archive.activeSessionCache = refreshed.session
      diagnostics.failures.push(...refreshed.failures)
      diagnostics.truncated = refreshed.truncated
      return collectSafeSession(archive, request, { ...cursor, active: cursor.active }, refreshed.session, diagnostics)
    }
  }
  const titleStat = await stat(join(archive.codexHome, "session_index.jsonl")).catch(cause => {
    if (hasCode(cause, "ENOENT")) return undefined
    throw cause
  })
  const titleStamp = titleStat ? `${titleStat.size}:${titleStat.mtimeMs}:${titleStat.ctimeMs}` : "missing"
  const reuseInventory = titleStamp === archive.inventoryTitleStamp && cursor.active === undefined && !(cursor.failed?.length) && archive.inventory !== undefined && (archive.inventoryPages ?? 4) < 4
  const discovered = reuseInventory ? archive.inventory! : await discoverSessions(archive, request.signal, diagnostics)
  archive.inventory = discovered
  if (!reuseInventory) {
    archive.inventoryPages = 0
    archive.inventoryTitleStamp = titleStamp
    archive.inventoryFailures = [...diagnostics.failures]
    archive.inventoryFailuresTruncated = diagnostics.truncated
  } else {
    for (const failure of archive.inventoryFailures ?? []) addSourceFailure(diagnostics, failure.source, failure.reason)
    diagnostics.truncated ||= archive.inventoryFailuresTruncated ?? false
  }
  const sessions = discovered.filter(session => {
    const failed = cursor.failed?.find(item => item.sessionId === session.id)
    if (!failed || failed.fingerprint !== sessionFingerprint(session) || failed.retryAt <= Date.now()) return true
    addSourceFailure(diagnostics, session.files[0]?.path ?? session.id, failed.reason)
    return false
  })
  const byId = new Map(sessions.map((session) => [session.id, session]))

  if (cursor.active !== undefined) {
    const active = cursor.active
    const activeSession = byId.get(active.sessionId)
    if (activeSession === undefined) {
      return pageWithRemainingSessions(
        emptyPage(advanceWatermark(cursor, active.selectedModifiedMs, active.sessionId)),
        sessions
      )
    }
    archive.activeSessionCache = activeSession
    return pageWithRemainingSessions(
      await collectSafeSession(archive, request, { ...cursor, active }, activeSession, diagnostics),
      sessions
    )
  }

  const selected = await selectSession(sessions, cursor, request.rawProgress, request.signal, archive.context.project.type === "git", request.rawCaptureEnabled !== false)

  if (selected === undefined) {
    if (reuseInventory) {
      delete archive.inventory
      diagnostics.failures.length = 0
      diagnostics.truncated = false
      return collectPage(archive, request, diagnostics)
    }
    if (request.cursor !== null) return emptyPage(cursor)
    return emptyPage({
      ...cursor,
      watermarkModifiedMs: Date.now(),
      watermarkSessionId: ""
    })
  }

  let chosen: { session: CodexSession; phase: ActiveCursor["phase"] } = selected
  if (reuseInventory) {
    // Inventory is discovery evidence only. Authorization and source stats are
    // refreshed before every chosen Session is opened or resumed.
    let refreshed
    try { refreshed = await refreshActiveSession(archive, chosen.session, request.signal) }
    catch (cause) { return quarantineSession(request, cursor, chosen.session, diagnostics, cause) }
    if (refreshed === undefined) {
      delete archive.inventory
      diagnostics.failures.length = 0
      diagnostics.truncated = false
      return collectPage(archive, request, diagnostics)
    }
    for (const failure of refreshed.failures) addSourceFailure(diagnostics, failure.source, failure.reason)
    diagnostics.truncated ||= refreshed.truncated
    chosen = { ...chosen, session: refreshed.session,
      phase: chosen.phase === "raw" && isAfterWatermark(refreshed.session, cursor) ? "canonical" : chosen.phase }
    archive.inventory = discovered.map(session => session.id === refreshed.session.id ? refreshed.session : session)
  }

  const priorFailure = cursor.failed?.find(item => item.sessionId === chosen.session.id)
  const resumed = priorFailure && priorFailure.fingerprint !== sessionFingerprint(chosen.session) ? undefined
    : cursor.pending?.find(item => item.sessionId === chosen.session.id && item.phase === chosen.phase)
  let active: ActiveCursor
  try { active = resumed ? { ...resumed, quantum: 0 } : await startSession(chosen.session, chosen.phase, request.signal) }
  catch (cause) { return quarantineSession(request, cursor, chosen.session, diagnostics, cause) }
  const completed = cursor.canonicalProgress?.find(item => item.sessionId === chosen.session.id)
  if (!resumed && completed?.revision !== undefined) {
    active = { ...active, revision: Math.max(active.revision, completed.revision + (active.phase === "canonical" ? 1 : 0)) }
  }
  if (!resumed && active.phase === "canonical" && completed && canonicalSourceKey(completed.files) === canonicalSourceKey(active.files)) {
    active = { ...active, files: active.files.map(file => {
      const previous = completed.files.find(item => item.sourceObjectId === file.sourceObjectId)
      return { ...file, startOffset: previous && previous.generation === file.generation && (previous.size < file.size || previous.size === file.size && previous.modifiedMs === file.modifiedMs) ? previous.size : 0 }
    }) }
  }
  archive.activeSessionCache = chosen.session
  return pageWithRemainingSessions(
    await collectSafeSession(archive, request, { ...cursor, active, pending: cursor.pending?.filter(item => item.sessionId !== chosen.session.id || item.phase !== chosen.phase) ?? [] }, chosen.session, diagnostics),
    sessions
  )
}

const addSourceFailure = (diagnostics: { failures: AdapterSourceFailure[]; truncated: boolean }, source: string, reason: AdapterSourceFailure["reason"]) => {
  if (diagnostics.failures.some(item => item.source === source && item.reason === reason)) return
  if (diagnostics.failures.length < MaxSourceFailures) diagnostics.failures.push({ source, reason })
  else diagnostics.truncated = true
}
const sessionFingerprint = (session: CodexSession) => digest(JSON.stringify(session.files.map(file => [file.sourceObjectId, file.generation, file.size, file.modifiedMs])))
const quarantineSession = (request: AdapterCollectRequest, cursor: CodexCursor, session: CodexSession,
  diagnostics: { failures: AdapterSourceFailure[]; truncated: boolean }, cause: unknown): AdapterCollectionPage => {
  throwIfAborted(request.signal)
  const reason = cause instanceof CodexArchiveError && ["io", "format", "limit"].includes(cause.reason)
    ? cause.reason as "io" | "format" | "limit"
    : ["EACCES", "EPERM", "EIO", "ESTALE"].some(code => hasCode(cause, code)) ? "io" as const : undefined
  if (!reason) throw cause
  addSourceFailure(diagnostics, session.files[0]?.path ?? session.id, reason)
  const { active, ...rest } = cursor
  return { ...emptyPage({ ...rest, commitSequence: (cursor.commitSequence ?? 0) + 1,
    pending: [...(rest.pending ?? []).filter(item => item.sessionId !== active?.sessionId || item.phase !== active?.phase), ...(active ? [active] : [])],
    failed: [...(rest.failed ?? []).filter(item => item.sessionId !== session.id),
      { sessionId: session.id, fingerprint: sessionFingerprint(session), retryAt: Date.now() + 60_000, reason }] }), hasMore: true }
}
const collectSafeSession = async (archive: CodexArchive, request: AdapterCollectRequest,
  cursor: CodexCursor & { readonly active: ActiveCursor }, session: CodexSession,
  diagnostics: { failures: AdapterSourceFailure[]; truncated: boolean }) => {
  try { return await collectActiveSession(archive, request, { ...cursor, failed: cursor.failed?.filter(item => item.sessionId !== session.id) ?? [] }, session) }
  catch (cause) { return quarantineSession(request, cursor, session, diagnostics, cause) }
}

const refreshActiveSession = async (archive: CodexArchive, session: CodexSession, signal: AbortSignal) => {
  const diagnostics: { failures: AdapterSourceFailure[]; truncated: boolean } = { failures: [], truncated: false }
  const files: RolloutFile[] = []
  for (const previous of session.files) {
    throwIfAborted(signal)
    let file
    try { file = await inspectRollout(archive, previous.path, signal, diagnostics) }
    catch (cause) {
      if (hasCode(cause, "ENOENT")) return undefined
      throw cause
    }
    if (file !== undefined && file.metadata.sessionId === session.id) files.push(file)
  }
  if (files.length === 0) return undefined
  return { ...diagnostics, session: { ...session, files,
    modifiedMs: Math.max(...files.map(file => file.modifiedMs), session.providerTitle?.modifiedMs ?? 0)
  } }
}

const pageWithRemainingSessions = (
  page: AdapterCollectionPage,
  sessions: ReadonlyArray<CodexSession>
): AdapterCollectionPage => {
  if (page.hasMore) return page
  const nextCursor = decodeCursor(page.nextCursor)
  return sessions.some((session) => isAfterWatermark(session, nextCursor))
    ? { ...page, hasMore: true }
    : page
}

const collectActiveSession = async (
  archive: CodexArchive,
  request: AdapterCollectRequest,
  cursor: CodexCursor & { readonly active: ActiveCursor },
  currentSession: CodexSession
): Promise<AdapterCollectionPage> => {
  const active = cursor.active
  const currentFiles = new Map(currentSession.files.map((file) => [file.sourceObjectId, file]))
  const selectedFiles = currentSession.files.filter(file => active.files.some(snapshot => snapshot.sourceObjectId === file.sourceObjectId))
  const threads = active.frozenThreads ?? buildThreads({ ...currentSession, files: selectedFiles }, active.revision)
  if (threads.length > request.limits.threadsPerObservation) {
    throw new CodexArchiveError({
      reason: "limit",
      message: `Codex session ${active.sessionId} has ${threads.length} Threads; the Host limit is ${request.limits.threadsPerObservation}.`
    })
  }

  const observedAt = new Date(active.selectedModifiedMs).toISOString()
  const childCount = threads.length - 1
  const projection = active.phase === "canonical" || active.resolvedTitle === undefined
    ? await sessionProjection(archive, active, currentFiles, request.signal)
    : undefined
  const title = active.resolvedTitle ?? await deriveSessionTitle(
    active,
    currentFiles,
    // A missing cached title is the only Raw-phase path that reaches this call.
    projection as CanonicalProjection,
    request.signal
  )
  const session: AdapterObservation["session"] = {
    sourceSessionId: active.sessionId,
    revision: active.revision,
    title,
    summary: childCount === 0 ? "" : `${childCount} subagent Thread${childCount === 1 ? "" : "s"}`,
    insight: "",
    actor: { name: "User", harness: "Codex" },
    branch: active.frozenBranch ?? selectedFiles.find((file) => file.metadata.branch)?.metadata.branch ?? "",
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
  const eventPage = active.phase === "canonical"
    ? await collectEvents(
      active,
      threads,
      currentFiles,
      projection as CanonicalProjection,
      request.limits.eventsPerObservation,
      request.limits.canonicalBytesPerObservation - canonicalBaseBytes,
      request.signal
    )
    : completedEventPage(active)
  const rawPage = active.phase === "raw" && request.rawCaptureEnabled !== false
    ? await collectRaw(
      active,
      currentFiles,
      request.rawProgress,
      request.limits.rawSegmentsPerObservation,
      request.limits.rawSegmentBytes,
      request.limits.rawBytesPerObservation,
      request.signal
    )
    : { segments: [], complete: true }
  const shouldEmit = eventPage.events.length > 0 || eventPage.usage.length > 0 || rawPage.segments.length > 0 || !active.emitted
  const complete = eventPage.complete && rawPage.complete
  let nextCursor: CodexCursor = complete
    ? completeActive(cursor, active)
    : {
        ...cursor,
        active: {
          ...active,
          frozenThreads: threads,
          frozenBranch: session.branch,
          quantum: (active.quantum ?? 0) + 1,
          spawnOffset: eventPage.spawnOffset,
          eventFileIndex: eventPage.fileIndex,
          eventOffset: eventPage.offset,
          resolvedTitle: title,
          emitted: active.emitted || shouldEmit,
          step: active.step + (shouldEmit ? 1 : 0)
        }
      }

  if (nextCursor.active && (nextCursor.active.quantum ?? 0) >= 4) {
    const { active: paused, ...rest } = nextCursor
    nextCursor = { ...rest, lastSessionId: paused.sessionId, lastPhase: paused.phase,
      canonicalTurns: paused.phase === "canonical" ? (rest.canonicalTurns ?? 0) + 1 : 0,
      pending: [...(rest.pending ?? []), { ...paused, quantum: 0 }] }
  }

  if (!shouldEmit) {
    const page = emptyPage(nextCursor)
    return complete ? { ...page, hasMore: true } : page
  }

  const root = threads.find((thread) => thread.parentSourceThreadId === undefined)
  const observation: AdapterObservation = {
    observationId: `codex-${digest(JSON.stringify({
      phase: active.phase,
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
    usage: eventPage.usage,
    rawSegments: rawPage.segments
  }
  return {
    protocolVersion: request.protocolVersion,
    nextCursor: encodeCursor(nextCursor),
    // A completed phase may expose another Canonical Session or Raw backlog.
    // Let the Host ask once more; an actually idle selection returns hasMore=false.
    hasMore: true,
    observations: [observation]
  }
}

const completedEventPage = (active: ActiveCursor): EventPage => ({
  events: [],
  usage: [],
  spawnOffset: active.spawnOffset,
  fileIndex: active.eventFileIndex,
  offset: active.eventOffset,
  complete: true
})

const startSession = async (
  session: CodexSession,
  phase: ActiveCursor["phase"],
  signal: AbortSignal
): Promise<ActiveCursor> => {
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
      modifiedMs: file.modifiedMs,
      archived: file.archived,
      threadId: file.metadata.threadId
    })
  }
  const allArchived = files.length > 0 && files.every((file) => file.archived)
  const modifiedMicros = Math.max(1, Math.floor(session.modifiedMs * 1_000))
  return {
    phase,
    sessionId: session.id,
    selectedModifiedMs: session.modifiedMs,
    revision: modifiedMicros * 2 + CanonicalProjectionRevisionOffset + (allArchived ? 1 : 0),
    ...(session.providerTitle === undefined ? {} : { providerTitle: session.providerTitle.value }),
    files,
    spawnOffset: 0,
    eventFileIndex: 0,
    eventOffset: 0,
    emitted: false,
    step: 0
  }
}

const discoverSessions = async (archive: CodexArchive, signal: AbortSignal, diagnostics: { failures: AdapterSourceFailure[]; truncated: boolean }): Promise<ReadonlyArray<CodexSession>> => {
  const [activePaths, archivedPaths, titles] = await Promise.all([
    listJsonl(join(archive.codexHome, "sessions"), signal),
    listJsonl(join(archive.codexHome, "archived_sessions"), signal),
    readSessionTitles(join(archive.codexHome, "session_index.jsonl"), signal)
  ])
  const paths = [...activePaths, ...archivedPaths]
  const groups = new Map<string, Array<RolloutFile>>()
  let nextPath = 0
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
    while (nextPath < paths.length) {
    const path = paths[nextPath++]!
    throwIfAborted(signal)
    let file
    try {
      file = await inspectRollout(archive, path, signal, diagnostics)
    } catch (cause) {
      if (hasCode(cause, "ENOENT")) continue
      if (["EACCES", "EPERM", "EIO", "ESTALE"].some(code => hasCode(cause, code))) { addSourceFailure(diagnostics, path, "io"); continue }
      throw cause
    }
    if (file === undefined) continue
    const group = groups.get(file.metadata.sessionId) ?? []
    group.push(file)
    groups.set(file.metadata.sessionId, group)
    }
  }))
  return [...groups.entries()].map(([id, files]) => {
    const providerTitle = titles.get(id)
    return {
      id,
      files: files.sort((left, right) =>
        left.metadata.timestamp.localeCompare(right.metadata.timestamp) || left.relativePath.localeCompare(right.relativePath)),
      modifiedMs: Math.max(...files.map((file) => file.modifiedMs), providerTitle?.modifiedMs ?? 0),
      ...(providerTitle === undefined ? {} : { providerTitle })
    }
  })
}

const readSessionTitles = async (
  path: string,
  signal: AbortSignal
): Promise<ReadonlyMap<string, SessionTitle>> => {
  let details
  try {
    details = await stat(path)
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return new Map()
    throw cause
  }
  if (!details.isFile() || details.size === 0) return new Map()

  const start = Math.max(0, details.size - MaxSessionIndexBytes)
  let skipPartialFirstLine = start > 0
  const titles = new Map<string, SessionTitle>()
  for await (const line of readLines(path, start, details.size, signal)) {
    if (skipPartialFirstLine) {
      skipPartialFirstLine = false
      continue
    }
    if (line.content.at(-1) !== 0x0a) continue
    const decoded = Schema.decodeUnknownOption(SessionTitleIndexRecordSchema)(parseJSON(line.content))
    if (Option.isNone(decoded)) continue
    const value = normalizeTitle(decoded.value.thread_name)
    const modifiedMs = Date.parse(decoded.value.updated_at)
    if (value === "" || Number.isNaN(modifiedMs)) continue
    titles.set(decoded.value.id, { value, modifiedMs })
  }
  return titles
}

const inspectRollout = async (
  archive: CodexArchive,
  path: string,
  signal: AbortSignal,
  diagnostics: { failures: AdapterSourceFailure[]; truncated: boolean }
): Promise<RolloutFile | undefined> => {
  const first = await readFirstLine(path, signal)
  if (first === undefined) return undefined
  const metadata = decodeMetadata(first)
  if (metadata === undefined) return undefined
  const decision = await matchesProject(archive, metadata, path, signal)
  if (decision === "unknown") {
    if (diagnostics.failures.length < MaxSourceFailures) diagnostics.failures.push({ source: path, reason: "attribution" })
    else diagnostics.truncated = true
  }
  if (decision !== "included") return undefined
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
    paginated: payload.history_mode === "paginated",
    sessionId: payload.session_id ?? (parentThreadId === undefined ? payload.id : parentThreadId),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(nickname === undefined ? {} : { nickname }),
    cwd: payload.cwd,
    timestamp: payload.timestamp ?? envelope.timestamp,
    ...(stringValue(git?.repository_url) === undefined ? {} : { repository: stringValue(git?.repository_url) as string }),
    ...(stringValue(git?.branch) === undefined ? {} : { branch: stringValue(git?.branch) as string })
  }
}

const matchesProject = async (archive: CodexArchive, metadata: RolloutMetadata, path: string, signal: AbortSignal) => {
  if (!isAbsolute(metadata.cwd)) return "unknown" as const
  if (archive.context.project.type === "git") {
    return archive.context.gitAttribution!.resolve({
      sourceId: metadata.paginated ? `rollout-${digest(basename(path)).slice(0, 32)}` : metadata.threadId,
      originKey: JSON.stringify([metadata.sessionId, metadata.timestamp]),
      cwd: metadata.cwd,
      ...(metadata.repository === undefined ? {} : { repositoryRemote: metadata.repository })
    }, signal)
  }
  const workingDirectory = await realpath(metadata.cwd).catch(() => resolve(metadata.cwd))
  return isPathInside(archive.projectRoot, workingDirectory) ? "included" as const : "excluded" as const
}

const buildThreads = (session: CodexSession, revision: number): ReadonlyArray<AdapterThread> => {
  const metadataByThread = new Map<string, RolloutMetadata>()
  for (const file of session.files) {
    if (!metadataByThread.has(file.metadata.threadId)) metadataByThread.set(file.metadata.threadId, file.metadata)
  }
  if (!metadataByThread.has(session.id)) {
    metadataByThread.set(session.id, {
      threadId: session.id,
      paginated: false,
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
  readonly usage: ReadonlyArray<AdapterUsage>
  readonly spawnOffset: number
  readonly fileIndex: number
  readonly offset: number
  readonly complete: boolean
}

type ProjectionFormat = "item_completed" | "event_msg" | "response_item"

type CanonicalProjection = {
  readonly usageByCoordinate: ReadonlyMap<string, AdapterUsage>
  readonly completedItemOwnerById: ReadonlyMap<string, { sourceObjectId: string; offset: number; order: number }>
  readonly formatBySourceObjectId: ReadonlyMap<string, ProjectionFormat>
  readonly responseItemOwnerById: ReadonlyMap<string, { sourceObjectId: string; offset: number }>
  readonly legacyMessageOwnerById: ReadonlyMap<string, { sourceObjectId: string; offset: number }>
}

const sessionProjection = async (
  archive: CodexArchive,
  active: ActiveCursor,
  currentFiles: ReadonlyMap<string, RolloutFile>,
  signal: AbortSignal
): Promise<CanonicalProjection> => {
  const key = JSON.stringify([active.sessionId, active.files, active.files.map(file => {
    const current = currentFiles.get(file.sourceObjectId)
    return current === undefined ? null : [current.generation, current.size, current.modifiedMs]
  })])
  if (archive.projectionCache?.key === key) return archive.projectionCache.value
  const value = await inspectCanonicalProjection(active, currentFiles, signal)
  archive.projectionCache = { key, value }
  return value
}

const inspectCanonicalProjection = async (
  active: ActiveCursor,
  currentFiles: ReadonlyMap<string, RolloutFile>,
  signal: AbortSignal
): Promise<CanonicalProjection> => {
  const legacyMessageOwnerById = new Map<string, { sourceObjectId: string; offset: number }>()
  const usageByCoordinate = new Map<string, AdapterUsage>()
  const usageByIdentity = new Map<string, string>()
  const completedItemOwnerById = new Map<string, { sourceObjectId: string; offset: number; order: number }>()
  const inspected: Array<{
    readonly sourceObjectId: string
    readonly threadId: string
    readonly hasSupportedCompletedItem: boolean
    readonly hasLegacyMessage: boolean
    readonly responseItemIds: ReadonlyArray<[string, number]>
    readonly legacySupplementIds: ReadonlyArray<[string, number]>
  }> = []
  for (const snapshot of active.files) {
    const current = currentFiles.get(snapshot.sourceObjectId)
    if (current === undefined || current.generation !== snapshot.generation) continue
    let hasSupportedCompletedItem = false
    let hasLegacyMessage = false
    let acceptsLegacySupplements = false
    const responseItemIds: Array<[string, number]> = []
    const legacySupplementIds: Array<[string, number]> = []
    const models = new Map<string, string>()
    for await (const line of readLines(current.path, 0, snapshot.size, signal)) {
      const completed = mapCompletedItem(line.content, line.start, snapshot, active.sessionId)
      if (completed !== undefined) {
        hasSupportedCompletedItem = true
        const key = `${completed.sourceThreadId}\0${completed.sourceEventId}`
        const previous = completedItemOwnerById.get(key)
        if (!previous || completed.sourceOrder > previous.order || previous.sourceObjectId === snapshot.sourceObjectId) {
          completedItemOwnerById.set(key, { sourceObjectId: snapshot.sourceObjectId, offset: line.start, order: completed.sourceOrder })
        }
      }
      const parsed = record(parseJSON(line.content))
      const topLevelType = stringValue(parsed?.type)
      const payload = record(parsed?.payload)
      if (topLevelType === "turn_context" && typeof payload?.turn_id === "string" && typeof payload.model === "string") {
        models.set(payload.turn_id, payload.model)
      }
      if (topLevelType === "token_usage_record" && payload?.thread_id === snapshot.threadId) {
        const value = record(payload.usage)
        const id = stringValue(payload.response_id), at = stringValue(parsed?.timestamp)
        const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
        if (value && id && id.length <= 500 && at && Number.isFinite(Date.parse(at)) &&
          integer(value.input_tokens) && integer(value.output_tokens) && integer(value.cached_input_tokens) &&
          integer(value.cache_write_input_tokens ?? 0) &&
          value.cached_input_tokens + Number(value.cache_write_input_tokens ?? 0) <= value.input_tokens &&
          (value.reasoning_output_tokens === undefined || integer(value.reasoning_output_tokens) && value.reasoning_output_tokens <= value.output_tokens) &&
          integer(value.total_tokens) && value.total_tokens === value.input_tokens + value.output_tokens) {
          const sample: AdapterUsage = { sourceUsageId: id, sourceThreadId: snapshot.threadId,
            revision: 1, occurredAt: new Date(at).toISOString(), model: (models.get(stringValue(payload.turn_id) ?? "") ?? "").slice(0, 200),
            inputTokens: value.input_tokens, outputTokens: value.output_tokens,
            cacheReadTokens: value.cached_input_tokens, cacheWriteTokens: Number(value.cache_write_input_tokens ?? 0) }
          const identity = `${sample.sourceThreadId}\0${id}`
          const content = JSON.stringify({ ...sample, occurredAt: undefined })
          const previous = usageByIdentity.get(identity)
          if (previous !== undefined && previous !== content) {
            throw new CodexArchiveError({ reason: "format", message: "Codex response usage has conflicting source records." })
          }
          if (previous === undefined) {
            usageByIdentity.set(identity, content)
            usageByCoordinate.set(`${snapshot.sourceObjectId}:${line.start}`, sample)
          }
        }
      }
      const eventType = topLevelType === "event_msg" ? stringValue(payload?.type) : undefined
      if (topLevelType === "session_meta" || eventType === "task_started") acceptsLegacySupplements = false
      if (topLevelType === "turn_context") acceptsLegacySupplements = true
      if ((eventType === "user_message" || eventType === "agent_message") && itemText(payload?.message) !== "") {
        hasLegacyMessage = true
        const legacy = mapLegacyMessage(line.content, line.start, snapshot, active.sessionId)
        if (legacy) legacyMessageOwnerById.set(`${legacy.sourceThreadId}\0${legacy.sourceEventId}`, { sourceObjectId: snapshot.sourceObjectId, offset: line.start })
      }
      const item = decodeResponseItem(line.content)
      const itemId = stringValue(item?.id)
      if (item !== undefined && itemId !== undefined && mapResponseItemUpdate(item, itemId) !== undefined) {
        responseItemIds.push([itemId, line.start])
      }
      if (acceptsLegacySupplements && item !== undefined && itemId !== undefined &&
        mapResponseSupplementUpdate(item, itemId) !== undefined) {
        legacySupplementIds.push([itemId, line.start])
      }
    }
    inspected.push({
      sourceObjectId: snapshot.sourceObjectId,
      threadId: snapshot.threadId,
      hasSupportedCompletedItem,
      hasLegacyMessage,
      responseItemIds,
      legacySupplementIds
    })
  }

  const formatBySourceObjectId = new Map<string, ProjectionFormat>()
  const responseItemOwnerById = new Map<string, { sourceObjectId: string; offset: number }>()
  const rootFirst = [...inspected].sort((left, right) =>
    Number(right.threadId === active.sessionId) - Number(left.threadId === active.sessionId))
  for (const file of rootFirst) {
    const format = file.hasSupportedCompletedItem
      ? "item_completed"
      : file.hasLegacyMessage ? "event_msg" : "response_item"
    formatBySourceObjectId.set(file.sourceObjectId, format)
    const ownedIds = format === "response_item"
      ? file.responseItemIds
      : format === "event_msg" ? file.legacySupplementIds : []
    for (const [itemId, offset] of ownedIds) {
      if (!responseItemOwnerById.has(itemId)) responseItemOwnerById.set(itemId, { sourceObjectId: file.sourceObjectId, offset })
    }
  }
  return { formatBySourceObjectId, responseItemOwnerById, completedItemOwnerById, legacyMessageOwnerById, usageByCoordinate }
}

const collectEvents = async (
  active: ActiveCursor,
  threads: ReadonlyArray<AdapterThread>,
  currentFiles: ReadonlyMap<string, RolloutFile>,
  projection: CanonicalProjection,
  limit: number,
  byteLimit: number,
  signal: AbortSignal
): Promise<EventPage> => {
  const events: Array<AdapterEvent> = []
  const usage: Array<AdapterUsage> = []
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
      revision: active.revision,
      projectionRevision: 3,
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
    offset = Math.max(offset, snapshot.startOffset ?? 0)
    let reachedEnd = true
    for await (const line of readLines(current.path, offset, snapshot.size, signal)) {
      const sample = projection.usageByCoordinate.get(`${snapshot.sourceObjectId}:${line.start}`)
      if (sample) {
        const bytes = Buffer.byteLength(JSON.stringify(sample)) + 1
        if (usage.length >= limit || eventBytes + bytes > byteLimit) { reachedEnd = false; break }
        usage.push(sample); eventBytes += bytes
      }
      const mapped = mapProjectedItem(line.content, line.start, snapshot, active.sessionId, projection)
      const event = mapped ? { ...mapped, revision: active.revision } : undefined
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
    usage,
    spawnOffset,
    fileIndex,
    offset,
    complete: spawnOffset >= children.length && fileIndex >= active.files.length
  }
}

const mapProjectedItem = (
  line: Buffer,
  byteOffset: number,
  file: CursorFile,
  sessionId: string,
  projection: CanonicalProjection
): AdapterEvent | undefined => {
  switch (projection.formatBySourceObjectId.get(file.sourceObjectId)) {
    case "response_item":
      return mapResponseItem(
        line,
        byteOffset,
        file,
        sessionId,
        projection.responseItemOwnerById,
        mapResponseItemUpdate,
        false
      )
    case "event_msg": {
      const legacy = mapLegacyMessage(line, byteOffset, file, sessionId)
      if (legacy) {
        const owner = projection.legacyMessageOwnerById.get(`${legacy.sourceThreadId}\0${legacy.sourceEventId}`)
        return owner?.sourceObjectId === file.sourceObjectId && owner.offset === byteOffset ? legacy : undefined
      }
      return mapResponseItem(
        line,
        byteOffset,
        file,
        sessionId,
        projection.responseItemOwnerById,
        mapResponseSupplementUpdate,
        true
      )
    }
    default: {
      const event = mapCompletedItem(line, byteOffset, file, sessionId)
      if (!event) return undefined
      const owner = projection.completedItemOwnerById.get(`${event.sourceThreadId}\0${event.sourceEventId}`)
      return owner?.sourceObjectId === file.sourceObjectId && owner.offset === byteOffset ? event : undefined
    }
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
    projectionRevision: 3,
    sourceOrder: timestampOrder(envelope.timestamp),
    eventIndex: byteOffset,
    orderFidelity: "native",
    fidelity: "native",
    rawRef: { _tag: "object", sourceObjectId: file.sourceObjectId, fragment: `#byte=${byteOffset}` },
    occurredAt: validTimestamp(envelope.timestamp) ? envelope.timestamp : new Date(0).toISOString(),
    update
  }
}

const mapResponseItem = (
  line: Buffer,
  byteOffset: number,
  file: CursorFile,
  sessionId: string,
  ownerById: ReadonlyMap<string, { sourceObjectId: string; offset: number }>,
  mapUpdate: (item: Record<string, unknown>, fallbackId: string) => AcpSessionUpdate | undefined,
  requireOwnedId: boolean
): AdapterEvent | undefined => {
  const envelope = Schema.decodeUnknownOption(ResponseItemEnvelopeSchema)(parseJSON(line))
  if (Option.isNone(envelope)) return undefined
  const item = record(envelope.value.payload)
  if (item === undefined) return undefined
  const explicitId = stringValue(item.id)
  if (requireOwnedId && explicitId === undefined) return undefined
  if (explicitId !== undefined) {
    const owner = ownerById.get(explicitId)
    if (owner?.sourceObjectId !== file.sourceObjectId || owner.offset !== byteOffset) return undefined
  }
  const itemId = explicitId ?? `${file.sourceObjectId}-${byteOffset}`
  const update = mapUpdate(item, itemId)
  if (update === undefined) return undefined
  return {
    sourceEventId: truncateUtf8(itemId, 500),
    sourceThreadId: file.threadId || sessionId,
    revision: 1,
    projectionRevision: 3,
    sourceOrder: timestampOrder(envelope.value.timestamp),
    eventIndex: byteOffset,
    orderFidelity: "native",
    fidelity: "native",
    rawRef: { _tag: "object", sourceObjectId: file.sourceObjectId, fragment: `#byte=${byteOffset}` },
    occurredAt: validTimestamp(envelope.value.timestamp) ? envelope.value.timestamp : new Date(0).toISOString(),
    update
  }
}

const mapLegacyMessage = (
  line: Buffer,
  byteOffset: number,
  file: CursorFile,
  sessionId: string
): AdapterEvent | undefined => {
  const envelope = Schema.decodeUnknownOption(EventMessageEnvelopeSchema)(parseJSON(line))
  if (Option.isNone(envelope)) return undefined
  const payload = record(envelope.value.payload)
  const type = stringValue(payload?.type)
  if (type !== "user_message" && type !== "agent_message") return undefined
  const text = itemText(payload?.message)
  if (text === "") return undefined
  const itemId = stringValue(payload?.client_id) ?? stringValue(payload?.id) ??
    `${file.sourceObjectId}-${byteOffset}`
  const update: AcpSessionUpdate = {
    sessionUpdate: type === "user_message" ? "user_message_chunk" : "agent_message_chunk",
    messageId: truncateUtf8(itemId, 500),
    content: { type: "text", text: truncateUtf8(text, 1024 * 1024) }
  }
  return {
    sourceEventId: truncateUtf8(itemId, 500),
    sourceThreadId: file.threadId || sessionId,
    revision: 1,
    projectionRevision: 3,
    sourceOrder: timestampOrder(envelope.value.timestamp),
    eventIndex: byteOffset,
    orderFidelity: "native",
    fidelity: "native",
    rawRef: { _tag: "object", sourceObjectId: file.sourceObjectId, fragment: `#byte=${byteOffset}` },
    occurredAt: validTimestamp(envelope.value.timestamp) ? envelope.value.timestamp : new Date(0).toISOString(),
    update
  }
}

const decodeResponseItem = (line: Buffer): Record<string, unknown> | undefined => {
  const decoded = Schema.decodeUnknownOption(ResponseItemEnvelopeSchema)(parseJSON(line))
  return Option.isNone(decoded) ? undefined : record(decoded.value.payload)
}

const deriveSessionTitle = async (
  active: ActiveCursor,
  currentFiles: ReadonlyMap<string, RolloutFile>,
  projection: CanonicalProjection,
  signal: AbortSignal
) => {
  if (active.providerTitle !== undefined) return active.providerTitle
  let remaining = MaxTitleScanBytes
  for (const snapshot of active.files) {
    if (snapshot.threadId !== active.sessionId || remaining <= 0) continue
    const current = currentFiles.get(snapshot.sourceObjectId)
    if (current === undefined || current.generation !== snapshot.generation) continue
    const end = Math.min(snapshot.size, remaining)
    for await (const line of readLines(current.path, 0, end, signal)) {
      const event = mapProjectedItem(line.content, line.start, snapshot, active.sessionId, projection)
      if (event?.update.sessionUpdate !== "user_message_chunk" || event.update.content.type !== "text") continue
      const title = normalizeTitle(event.update.content.text)
      if (title !== "") return title
    }
    remaining -= end
  }
  return "Untitled Codex conversation"
}

const normalizeTitle = (value: string) => {
  const normalized = value.replace(/\s+/gu, " ").trim()
  const characters = [...normalized]
  if (characters.length <= MaxTitleCharacters) return normalized
  return `${characters.slice(0, MaxTitleCharacters - 1).join("")}…`
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

const mapResponseItemUpdate = (
  item: Record<string, unknown>,
  fallbackId: string
): AcpSessionUpdate | undefined => {
  const type = stringValue(item.type)
  const id = truncateUtf8(stringValue(item.id) ?? fallbackId, 500)
  if (type === "message") {
    const text = itemText(item.content)
    if (text === "") return undefined
    if (item.role === "user") {
      return {
        sessionUpdate: "user_message_chunk",
        messageId: id,
        content: { type: "text", text: truncateUtf8(text, 1024 * 1024) }
      }
    }
    if (item.role === "assistant") {
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: id,
        content: { type: "text", text: truncateUtf8(text, 1024 * 1024) }
      }
    }
    return undefined
  }
  return mapResponseSupplementUpdate(item, fallbackId)
}

const mapResponseSupplementUpdate = (
  item: Record<string, unknown>,
  fallbackId: string
): AcpSessionUpdate | undefined => {
  const type = stringValue(item.type)
  const id = truncateUtf8(stringValue(item.id) ?? fallbackId, 500)
  if (type === "agent_message") {
    const text = itemText(item.content)
    return text === "" ? undefined : {
      sessionUpdate: "agent_message_chunk",
      messageId: id,
      content: { type: "text", text: truncateUtf8(text, 1024 * 1024) }
    }
  }
  if (type === "reasoning") {
    const text = itemText(item.summary)
    return text === "" ? undefined : {
      sessionUpdate: "agent_thought_chunk",
      messageId: id,
      content: { type: "text", text: truncateUtf8(text, 1024 * 1024) }
    }
  }
  if (type === "custom_tool_call" || type === "function_call") {
    const label = stringValue(item.name) ?? "Codex tool"
    return toolUpdate(id, label, responseToolKind(label), item.status ?? "completed")
  }
  return undefined
}

const responseToolKind = (label: string): "read" | "edit" | "search" | "execute" | "fetch" | "other" => {
  const normalized = label.toLowerCase()
  if (/apply|edit|patch|write/.test(normalized)) return "edit"
  if (/read|view/.test(normalized)) return "read"
  if (/search|find|grep|rg/.test(normalized)) return "search"
  if (/fetch|web|open_url|browser/.test(normalized)) return "fetch"
  if (/exec|command|shell|terminal/.test(normalized)) return "execute"
  return "other"
}

const toolUpdate = (
  id: string,
  title: string,
  kind: "read" | "edit" | "search" | "execute" | "fetch" | "other",
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
  signal: AbortSignal,
  recoverGitHistory = false,
  rawCaptureEnabled = true
) => {
  const ordered = [...sessions].sort(compareSessions)
  const rotated = [...ordered.filter(session => session.id !== cursor.lastSessionId), ...ordered.filter(session => session.id === cursor.lastSessionId)]
  const canonical = rotated.filter(session => isAfterWatermark(session, cursor) || cursor.pending?.some(item => item.sessionId === session.id && item.phase === "canonical"))
  // Give newly changed work priority after yielding a large Session; the immutable
  // baseline and completed per-Session checkpoints retain older unfinished work.
  const recent = cursor.lastSessionId ? canonical.filter(session => session.id !== cursor.lastSessionId).at(-1) : undefined
  const changed = (cursor.canonicalTurns ?? 0) % 4 === 3 ? canonical[0] : recent ?? canonical[0]
  const preferRaw = (cursor.canonicalTurns ?? 0) >= 4
  if (changed && !preferRaw) return { session: changed, phase: "canonical" as const }
  for (const session of rawCaptureEnabled ? rotated : []) {
    if (cursor.pending?.some(item => item.sessionId === session.id && item.phase === "raw") || await sessionNeedsRaw(session, progress, signal)) {
      const saved = cursor.canonicalProgress?.find(item => item.sessionId === session.id)
      // Only completed, current Canonical snapshots are eligible for Raw service.
      if (saved && !isAfterWatermark(session, cursor)) return { session, phase: "raw" as const }
      if (!changed && recoverGitHistory && !saved) return { session, phase: "canonical" as const }
      if (!changed && !recoverGitHistory) return { session, phase: "raw" as const }
    }
  }
  if (changed) return { session: changed, phase: "canonical" as const }
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
      try {
        const availableSize = await completeJsonlSize(file.path, file.size, file.archived, signal)
        if (saved.sourceOffset < availableSize) return true
      } catch (cause) {
        throwIfAborted(signal)
        if (cause instanceof CodexArchiveError || ["EACCES", "EPERM", "EIO", "ESTALE", "ENOENT"].some(code => hasCode(cause, code))) return true
        throw cause
      }
    }
  }
  return false
}

const isAfterWatermark = (session: CodexSession, cursor: CodexCursor) => {
  const previous = cursor.canonicalProgress?.find(item => item.sessionId === session.id)
  if (previous) return session.modifiedMs > previous.modifiedMs || canonicalSourceKey(previous.files) !== canonicalSourceKey(session.files) ||
    session.files.some(file => previous.files.find(item => item.sourceObjectId === file.sourceObjectId)?.size! > file.size)
  const modifiedMs = cursor.baselineModifiedMs ?? cursor.watermarkModifiedMs
  const sessionId = cursor.baselineSessionId ?? cursor.watermarkSessionId
  return session.modifiedMs > modifiedMs || session.modifiedMs === modifiedMs && session.id > sessionId
}

const compareSessions = (left: CodexSession, right: CodexSession) =>
  left.modifiedMs - right.modifiedMs || left.id.localeCompare(right.id)

const canonicalSourceKey = (files: ReadonlyArray<Pick<CursorFile, "sourceObjectId" | "generation">>) =>
  digest(JSON.stringify(files.map(file => [file.sourceObjectId, file.generation] as const).sort(([a], [b]) => a.localeCompare(b))))

const advanceWatermark = (cursor: CodexCursor, modifiedMs: number, sessionId: string): CodexCursor => {
  const advances = modifiedMs > cursor.watermarkModifiedMs ||
    modifiedMs === cursor.watermarkModifiedMs && sessionId > cursor.watermarkSessionId
  const { active: _active, ...rest } = cursor
  return {
    ...rest,
    v: CursorVersion,
    watermarkModifiedMs: advances ? modifiedMs : cursor.watermarkModifiedMs,
    watermarkSessionId: advances ? sessionId : cursor.watermarkSessionId,
    commitSequence: (cursor.commitSequence ?? 0) + 1,
    ...(cursor.lastCanonicalSessionId ? { lastCanonicalSessionId: cursor.lastCanonicalSessionId } : {}),
    ...(cursor.lastCanonicalSourceKey ? { lastCanonicalSourceKey: cursor.lastCanonicalSourceKey } : {})
  }
}

const completeActive = (cursor: CodexCursor, active: ActiveCursor): CodexCursor => {
  if (active.phase === "canonical") {
    return { ...advanceWatermark(cursor, active.selectedModifiedMs, active.sessionId),
      lastCanonicalSessionId: active.sessionId, lastCanonicalSourceKey: canonicalSourceKey(active.files),
      lastSessionId: active.sessionId, lastPhase: active.phase, canonicalTurns: (cursor.canonicalTurns ?? 0) + 1,
      canonicalProgress: [...(cursor.canonicalProgress ?? []).filter(item => item.sessionId !== active.sessionId),
        { sessionId: active.sessionId, modifiedMs: active.selectedModifiedMs, revision: active.revision, files: active.files }] }
  }
  const { active: _active, ...rest } = cursor
  return {
    ...rest,
    lastSessionId: active.sessionId, lastPhase: active.phase, canonicalTurns: 0,
    v: CursorVersion,
    watermarkModifiedMs: cursor.watermarkModifiedMs,
    watermarkSessionId: cursor.watermarkSessionId,
    commitSequence: (cursor.commitSequence ?? 0) + 1,
    ...(cursor.lastCanonicalSessionId ? { lastCanonicalSessionId: cursor.lastCanonicalSessionId } : {}),
    ...(cursor.lastCanonicalSourceKey ? { lastCanonicalSourceKey: cursor.lastCanonicalSourceKey } : {})
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
    if (Buffer.byteLength(value) > MaxCursorBytes) throw new Error("oversized cursor")
    const contents = value.startsWith(CompressedCursorPrefix)
      ? inflateRawSync(Buffer.from(value.slice(CompressedCursorPrefix.length), "base64url"), {
        maxOutputLength: MaxDecodedCursorBytes
      })
      : Buffer.from(value, "base64url")
    const parsed = JSON.parse(contents.toString("utf8")) as unknown
    const decoded = Schema.decodeUnknownOption(CursorSchema)(parsed)
    if (Option.isSome(decoded) && validCursor(decoded.value)) return decoded.value
    const previous = Schema.decodeUnknownOption(PreviousCursorSchema)(parsed)
    if (Option.isSome(previous)) {
      const { active, ...rest } = previous.value
      const migrated: CodexCursor = {
        ...rest,
        v: CursorVersion,
        ...(active === undefined
          ? {}
          : { active: { ...active, phase: "canonical" } })
      }
      if (validCursor(migrated)) return migrated
    }
    const legacy = Schema.decodeUnknownOption(LegacyCursorSchema)(parsed)
    if (Option.isSome(legacy)) {
      const { active, ...rest } = legacy.value
      const migrated: CodexCursor = {
        ...rest,
        v: CursorVersion,
        ...(active === undefined ? {} : { active: { ...active, phase: "canonical" } })
      }
      if (validCursor(migrated)) {
        return { v: CursorVersion, watermarkModifiedMs: 0, watermarkSessionId: "", commitSequence: 0 }
      }
    }
    throw new Error("invalid cursor fields")
  } catch (cause) {
    throw archiveError("cursor", "The Codex Adapter cursor is invalid", cause)
  }
}

const nonNegative = (value: number) => Number.isSafeInteger(value) && value >= 0
const validFile = (file: CursorFile) => nonNegative(file.size) && file.sourceObjectId.length <= 500 && file.sourceName.length <= 4096 &&
  file.generation.length <= 500 && file.threadId.length <= 500 && (file.modifiedMs === undefined || Number.isFinite(file.modifiedMs) && file.modifiedMs >= 0) && (file.startOffset === undefined || nonNegative(file.startOffset) && file.startOffset <= file.size)
const validActive = (active: ActiveCursor) => nonNegative(active.revision) && active.revision >= 1 &&
  nonNegative(active.spawnOffset) && nonNegative(active.eventFileIndex) && nonNegative(active.eventOffset) && nonNegative(active.step) &&
  (active.quantum === undefined || nonNegative(active.quantum)) && active.sessionId.length <= 500 &&
  active.files.length <= 10_000 && active.files.every(validFile) && active.eventFileIndex <= active.files.length &&
  (active.frozenThreads === undefined || active.frozenThreads.length <= 100)
const validCursor = (cursor: CodexCursor) => (cursor.eventProjectionVersion === undefined || cursor.eventProjectionVersion === 2 || cursor.eventProjectionVersion === 3) && Number.isFinite(cursor.watermarkModifiedMs) &&
  cursor.watermarkModifiedMs >= 0 && cursor.watermarkSessionId.length <= 500 &&
  (cursor.lastCanonicalSessionId === undefined || cursor.lastCanonicalSessionId.length <= 500) &&
  (cursor.lastCanonicalSourceKey === undefined || /^[a-f0-9]{64}$/.test(cursor.lastCanonicalSourceKey)) &&
  (cursor.commitSequence === undefined || nonNegative(cursor.commitSequence)) &&
  (cursor.active === undefined || validActive(cursor.active)) &&
  (cursor.baselineModifiedMs === undefined || Number.isFinite(cursor.baselineModifiedMs) && cursor.baselineModifiedMs >= 0) &&
  (cursor.canonicalTurns === undefined || nonNegative(cursor.canonicalTurns)) &&
  (cursor.pending === undefined || cursor.pending.length <= 10_000 && cursor.pending.every(validActive)) &&
  (cursor.failed === undefined || cursor.failed.length <= 10_000 && cursor.failed.every(item => item.sessionId.length <= 500 && /^[a-f0-9]{64}$/.test(item.fingerprint) && nonNegative(item.retryAt))) &&
  (cursor.canonicalProgress === undefined || cursor.canonicalProgress.length <= 10_000 && cursor.canonicalProgress.every(item =>
    item.sessionId.length <= 500 && Number.isFinite(item.modifiedMs) && item.modifiedMs >= 0 && (item.revision === undefined || nonNegative(item.revision) && item.revision >= 1) && item.files.length <= 10_000 && item.files.every(validFile)))

const encodeCursor = (cursor: CodexCursor) => {
  const contents = Buffer.from(JSON.stringify(cursor), "utf8")
  if (contents.byteLength > MaxDecodedCursorBytes) {
    throw new CodexArchiveError({ reason: "cursor", message: "The Codex Adapter cursor exceeds its decoded size limit." })
  }
  const plain = contents.toString("base64url")
  const encoded = Buffer.byteLength(plain) <= 16_000
    ? plain
    : CompressedCursorPrefix + deflateRawSync(contents).toString("base64url")
  if (Buffer.byteLength(encoded) > MaxCursorBytes) {
    throw new CodexArchiveError({
      reason: "cursor",
      message: `The Codex Adapter cursor exceeds ${MaxCursorBytes} bytes.`
    })
  }
  return encoded
}

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
