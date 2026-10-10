import { CanonicalProfileVersion3, ConfirmedCreationReceipt, SourceCaptureLimits, SourceProjectionLimits,
  type AdapterOpenContext, type ConfirmedCreationReceipt as Receipt, type SourceCaptureFrame, type SourceOpenRequestV2,
  type SourceDiscoverRequest, type SourceCaptureHeaderV2, type AdapterSourceFailure } from "@atape/domain"
import { join, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { discoverCursorSources, readCursorSource, CursorSourcePrefix, type CursorSourceSnapshot } from "./cursorSource.ts"
import { CursorNativeProfile, cursorLimits, cursorRoot, problem, workspaceSlug } from "./cursorProfile.ts"

const Checkpoint = Schema.Struct({ v: Schema.Literal(1), sourceId: Schema.String, originKey: Schema.String, ...CursorSourcePrefix.fields })
const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
  Effect.mapError(() => problem("format", "Cursor capture metadata is invalid.")))
const receipt = (context: AdapterOpenContext, root: string, sourceId: string, signal: AbortSignal) => Effect.gen(function*() {
  if (!context.creationReceipts) return yield* problem("unsupported", "Cursor requires a Host with creation receipts.")
  const raw = yield* Effect.tryPromise({ try: () => context.creationReceipts!.readConfirmed({ stateDirectory: root, sourceId }, signal), catch: cause => cause })
  if (raw === undefined) return undefined
  const r = yield* decode(ConfirmedCreationReceipt, raw)
  const slug = workspaceSlug(r.origin.cwd)
  if (r.adapterId !== "cursor" || r.sourceId !== sourceId || r.origin.sourceId !== sourceId || !r.origin.originKey ||
    r.stateDirectory !== root || r.profile !== CursorNativeProfile || !slug || resolve(r.origin.cwd) !== r.origin.cwd ||
    r.sourcePath !== join(root, "projects", slug, "agent-transcripts", sourceId, `${sourceId}.jsonl`))
    return yield* problem("attribution", "Cursor creation receipt does not match this native source.")
  return r
})
export const discover = (context: AdapterOpenContext, environment: NodeJS.ProcessEnv, request: SourceDiscoverRequest) => Effect.gen(function*() {
  yield* decode(SourceCaptureLimits, request.limits)
  const root = yield* cursorRoot(environment), page = yield* discoverCursorSources({ stateDirectory: root, cursor: request.cursor, limits: cursorLimits(request.limits) })
  const sources: Receipt["origin"][] = [], failures: AdapterSourceFailure[] = [...page.sourceFailures]
  let truncated = page.sourceFailuresTruncated
  const diagnostic = (source: string, reason: "attribution") => { if (failures.length < 32) failures.push({ source, reason }); else truncated = true }
  for (const source of page.sources) {
    const r = yield* receipt(context, root, source.sourceId, request.signal).pipe(Effect.catch(error => {
      if (typeof error === "object" && error !== null && "reason" in error && error.reason === "attribution") return Effect.succeed(undefined)
      return Effect.fail(error)
    }))
    if (r === undefined || r.sourcePath !== source.transcriptPath) { diagnostic(source.transcriptPath, "attribution"); continue }
    sources.push(r.origin)
  }
  return { sources, cursor: page.cursor, done: page.done, sourceFailures: failures, sourceFailuresTruncated: truncated }
})
const project = (snapshot: CursorSourceSnapshot, r: Receipt, request: SourceOpenRequestV2): { header: SourceCaptureHeaderV2; frames: SourceCaptureFrame[] } => {
  const frames: SourceCaptureFrame[] = []
  let eventIndex = 0
  let title = "Cursor conversation", foundUser = false
  for (const row of snapshot.records) {
    const events: SourceCaptureFrame["events"][number][] = []
    if (row.kind === "message") for (const [partIndex, part] of row.content.entries()) {
      if (row.role === "user" && part.type === "text" && !foundUser) {
        foundUser = true
        if (part.text.length > 0 && Buffer.byteLength(part.text) <= 500) title = part.text
      }
      if (part.type === "tool_use" && Buffer.byteLength(JSON.stringify(part.input)) > 64 * 1024)
        throw problem("limit", "Cursor tool input exceeds its capture bound.")
      if (part.type === "tool_use" && Buffer.byteLength(part.name) > 500) throw problem("limit", "Cursor tool name exceeds its capture bound.")
      events.push({ sourceEventId: `row:${row.line}:part:${partIndex}`, sourceThreadId: r.sourceId,
        sourceOrder: eventIndex, eventIndex: eventIndex++, orderFidelity: "derived", fidelity: "partial", occurredAt: null,
        update: part.type === "text" ? { sessionUpdate: row.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: part.text } }
          : { sessionUpdate: "tool_call", toolCallId: `tool:${row.line}:${partIndex}`, title: part.name, rawInput: part.input } })
    }
    if (events.length > 500 || eventIndex > request.projection.events) throw problem("limit", "Cursor event projection exceeds its capture bound.")
    frames.push({ recordKey: `row:${row.line}`, events, usage: [], ...(request.rawEnabled ? {
      raw: { format: "cursor.jsonl.v1", sourceSessionId: r.sourceId, recordIndex: row.line - 1, record: row.raw }
    } : {}) })
  }
  const failures = [...snapshot.sourceFailures]
  let truncated = snapshot.sourceFailuresTruncated
  for (const child of snapshot.subagentCandidates) {
    if (failures.length < 32) failures.push({ source: child.transcriptPath, reason: "unsupported" })
    else truncated = true
  }
  return { frames, header: { profile: CursorNativeProfile, origin: r.origin, canonicalProfileVersion: CanonicalProfileVersion3,
    session: { sourceSessionId: r.sourceId, title, summary: "", insight: "", actor: { name: "Cursor", harness: "cursor" }, branch: "",
      status: "idle", captureStatus: "partial", updatedAt: null, reportedEventCount: eventIndex },
    threads: [{ sourceThreadId: r.sourceId, label: "Cursor", summary: "", captureStatus: "partial" }],
    target: { events: eventIndex, usage: 0, threads: 1, retainedThreadIds: [] },
    sourceCheckpoint: JSON.stringify({ v: 1, sourceId: r.sourceId, originKey: r.origin.originKey, ...snapshot.currentFullPrefix }),
    sourceFailures: failures, sourceFailuresTruncated: truncated } }
}
export const openCapture = (context: AdapterOpenContext, environment: NodeJS.ProcessEnv, request: SourceOpenRequestV2) => Effect.gen(function*() {
  yield* decode(SourceCaptureLimits, request.limits); yield* decode(SourceProjectionLimits, request.projection)
  const root = yield* cursorRoot(environment), r = yield* receipt(context, root, request.sourceId, request.signal)
  if (r === undefined) return yield* problem("attribution", "Cursor source lacks confirmed creation evidence.")
  const requiredPrefixes = [r.prefix]
  if (request.priorCheckpoint !== undefined) {
    const value = yield* Effect.try({ try: () => {
      if (Buffer.byteLength(request.priorCheckpoint!) > 2048) throw new Error()
      return JSON.parse(request.priorCheckpoint!) as unknown
    }, catch: () => problem("format", "Cursor checkpoint is invalid.") }).pipe(Effect.flatMap(value => decode(Checkpoint, value)))
    if (value.sourceId !== r.sourceId || value.originKey !== r.origin.originKey) return yield* problem("attribution", "Cursor checkpoint belongs to a different source origin.")
    requiredPrefixes.push(value)
  }
  const snapshot = yield* readCursorSource({ stateDirectory: root, sourceId: request.sourceId, limits: cursorLimits(request.limits), requiredPrefixes })
  if (snapshot.source.transcriptPath !== r.sourcePath) return yield* problem("attribution", "Cursor source moved outside its confirmed native locator.")
  return yield* Effect.try({ try: () => project(snapshot, r, request), catch: cause => cause instanceof Error ? cause : problem("format", "Cursor projection failed.") })
})
