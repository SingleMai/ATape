import { createHash } from "node:crypto"
import { constants, type BigIntStats, type Dirent } from "node:fs"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"

export class CursorSourceError extends Schema.TaggedError<CursorSourceError>()("CursorSourceError", {
  reason: Schema.Literals(["invalid_input", "missing", "io", "format", "unsupported", "limit", "duplicate", "changed"]),
  message: Schema.String
}) {}

const count = (maximum: number) => Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(maximum))
/** Explicit admission, not defaults or a measured physical memory ceiling.
 * sourceBytes covers the transcript plus all metadata candidate bytes together. */
export const CursorSourceLimits = Schema.Struct({
  inventoryEntries: count(100_000), pageSources: count(100), rowBytes: count(16 * 1024 * 1024),
  sourceBytes: count(64 * 1024 * 1024), records: count(1_000_000), subagents: count(1000), durationMs: count(300_000)
})
export type CursorSourceLimits = typeof CursorSourceLimits.Type

export type CursorSourceCandidate = {
  readonly sourceId: string
  readonly workspaceSlug: string
  readonly transcriptPath: string
}
export type CursorDiscoveryPage = {
  readonly sources: ReadonlyArray<CursorSourceCandidate>
  readonly cursor: string | null
  readonly done: boolean
}
export type CursorContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly name: string; readonly input: Readonly<Record<string, unknown>>; /** Not interpreted by this profile; raw fields remain intact. */ readonly toolCallId: null }
type CursorRecordBase = {
  readonly line: number
  readonly rawJson: string
  readonly raw: Readonly<Record<string, unknown>>
  /** This profile establishes no event time or native event identity. Extra raw fields remain uninterpreted. */
  readonly eventTime: null
  readonly nativeEventId: null
}
export type CursorSourceRecord = CursorRecordBase & (
  | { readonly kind: "message"; readonly role: "user" | "assistant"; readonly content: ReadonlyArray<CursorContentPart> }
  | { readonly kind: "turn_ended"; readonly status: string }
)
export type CursorMetadataCandidate = {
  readonly path: string
  readonly title: string | null
  readonly cwd: string | null
  readonly createdAtMs: number | null
  readonly raw: Readonly<Record<string, unknown>>
}
export type CursorSubagentCandidate = { readonly sourceId: string; readonly transcriptPath: string }
export type CursorSourceSnapshot = {
  readonly source: CursorSourceCandidate
  readonly origin: { readonly status: "unknown"; readonly reason: "creation_evidence_unavailable" }
  readonly records: ReadonlyArray<CursorSourceRecord>
  readonly metadataCandidates: ReadonlyArray<CursorMetadataCandidate>
  /** Directory membership is a discovery hint, not a proved parent/call graph. */
  readonly subagentCandidates: ReadonlyArray<CursorSubagentCandidate>
  readonly fileObservation: {
    readonly sizeBytes: number
    readonly sha256: string
    readonly modifiedAt: string
    readonly modifiedAtMeaning: "filesystem_observation"
  }
}

type DiscoveryRequest = { readonly stateDirectory: string; readonly cursor: string | null; readonly limits: CursorSourceLimits }
type ReadRequest = { readonly stateDirectory: string; readonly sourceId: string; readonly limits: CursorSourceLimits }
type Proof = { readonly path: string; readonly stat: BigIntStats }
type Context = { readonly root: string; readonly limits: CursorSourceLimits; readonly proofs: Map<string, Proof>; entries: number; bytes: number }
type Bytes = { readonly bytes: Buffer; readonly proof: Proof }

const sourceIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isPattern(/^[A-Za-z0-9_-]+$/))
const statePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096), Schema.isPattern(/^[^\u0000]+$/))
const discoveryCursor = Schema.NullOr(Schema.String.check(Schema.isPattern(/^cursor-native-v1:[a-f0-9]{64}$/)))
const ObjectRow = Schema.Record(Schema.String, Schema.Unknown)
const textPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const toolPart = Schema.Struct({ type: Schema.Literal("tool_use"), name: Schema.String.check(Schema.isMinLength(1)), input: ObjectRow })
const Message = Schema.Struct({ role: Schema.Literals(["user", "assistant"]), message: Schema.Struct({ content: Schema.Array(Schema.Union([textPart, toolPart])) }) })
const TurnEnded = Schema.Struct({ type: Schema.Literal("turn_ended"), status: Schema.String.check(Schema.isMinLength(1)) })
const Metadata = Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)), cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))))
})

const failure = (reason: CursorSourceError["reason"], message: string) => new CursorSourceError({ reason, message })
const fail = (reason: CursorSourceError["reason"], message: string) => Effect.fail(failure(reason, message))
const errorCode = (error: unknown) => typeof error === "object" && error !== null && "code" in error ? error.code : undefined
const io = <A>(operation: () => Promise<A>): Effect.Effect<A, CursorSourceError> => Effect.tryPromise({
  try: operation,
  catch: error => failure(errorCode(error) === "ENOENT" ? "missing" : errorCode(error) === "ELOOP" ? "unsupported" : "io", "Cursor source filesystem operation failed.")
})
const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown, reason: CursorSourceError["reason"], message: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => failure(reason, message)))
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
  a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const contained = (root: string, path: string) => {
  const child = relative(root, path)
  return child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)
}
const optionalStat = (path: string) => io(() => lstat(path, { bigint: true })).pipe(
  Effect.catch(error => error.reason === "missing" ? Effect.succeed(undefined) : Effect.fail(error))
)
const pathIdentity = (context: Context, path: string) => Effect.gen(function*() {
  if (!contained(context.root, path)) return yield* fail("unsupported", "Cursor source path escaped its selected state directory.")
  const resolved = yield* io(() => realpath(path))
  if (resolved !== path || !contained(context.root, resolved)) return yield* fail("unsupported", "Cursor source symlinks are unsupported.")
})
const remember = (context: Context, path: string, stat: BigIntStats) => {
  const old = context.proofs.get(path)
  if (old !== undefined && !same(old.stat, stat)) return fail("changed", "Cursor source changed during observation; retry.")
  context.proofs.set(path, { path, stat })
  return Effect.void
}
const directory = (context: Context, path: string, optional = false) => Effect.gen(function*() {
  const stat = yield* optionalStat(path)
  if (stat === undefined) {
    if (optional) return false
    return yield* fail("missing", "Cursor source directory is missing.")
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return yield* fail("unsupported", "Cursor source directory must be a real directory.")
  yield* pathIdentity(context, path)
  yield* remember(context, path, stat)
  return true
})
const verify = (context: Context) => Effect.gen(function*() {
  for (const proof of context.proofs.values()) {
    yield* Effect.yieldNow
    const current = yield* optionalStat(proof.path)
    if (current === undefined || !same(proof.stat, current)) return yield* fail("changed", "Cursor source changed during observation; retry.")
    yield* pathIdentity(context, proof.path)
  }
})

const list = (context: Context, path: string): Effect.Effect<ReadonlyArray<Dirent>, CursorSourceError> =>
  Effect.acquireUseRelease(io(() => opendir(path)), handle => Effect.gen(function*() {
    const entries: Dirent[] = []
    while (true) {
      const entry = yield* io(() => handle.read())
      if (entry === null) break
      if (++context.entries > context.limits.inventoryEntries) return yield* fail("limit", "Cursor source inventory exceeds its entry budget.")
      if (entry.isSymbolicLink()) return yield* fail("unsupported", "Cursor source symlinks are unsupported.")
      entries.push(entry)
    }
    return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  }), handle => io(() => handle.close()))

const inventory = (context: Context): Effect.Effect<ReadonlyArray<CursorSourceCandidate>, CursorSourceError> => Effect.gen(function*() {
  const projects = join(context.root, "projects")
  if (!(yield* directory(context, projects, true))) return []
  const candidates: CursorSourceCandidate[] = [], ids = new Set<string>()
  for (const workspace of yield* list(context, projects)) {
    if (!workspace.isDirectory()) continue
    const project = join(projects, workspace.name)
    yield* directory(context, project)
    const transcripts = join(project, "agent-transcripts")
    if (!(yield* directory(context, transcripts, true))) continue
    for (const entry of yield* list(context, transcripts)) {
      if (!entry.isDirectory()) continue
      const sourceDirectory = join(transcripts, entry.name)
      yield* directory(context, sourceDirectory)
      const transcriptPath = join(sourceDirectory, `${entry.name}.jsonl`)
      const stat = yield* optionalStat(transcriptPath)
      if (stat === undefined) continue
      if (stat.isSymbolicLink() || !stat.isFile()) return yield* fail("unsupported", "Cursor transcript must be a regular file.")
      yield* pathIdentity(context, transcriptPath)
      yield* decode(sourceIdentity, entry.name, "unsupported", "Cursor source identity is unsupported.")
      if (ids.has(entry.name)) return yield* fail("duplicate", "Cursor source identity occurs in multiple workspace directories.")
      ids.add(entry.name)
      candidates.push({ sourceId: entry.name, workspaceSlug: workspace.name, transcriptPath })
    }
  }
  return candidates
})

const withContext = <A>(stateDirectory: string, limits: CursorSourceLimits, missing: () => Effect.Effect<A, CursorSourceError>,
  use: (context: Context) => Effect.Effect<A, CursorSourceError>): Effect.Effect<A, CursorSourceError> => Effect.gen(function*() {
  yield* decode(statePath, stateDirectory, "invalid_input", "Cursor state directory is invalid.")
  yield* decode(CursorSourceLimits, limits, "invalid_input", "Cursor source limits are invalid.")
  if (!isAbsolute(stateDirectory)) return yield* fail("invalid_input", "Cursor state directory must be absolute.")
  return yield* Effect.gen(function*() {
    // Strip trailing separators/dot segments before lstat, which can otherwise
    // follow a final symlink when the supplied directory ends in a separator.
    const selected = resolve(stateDirectory)
    const stat = yield* optionalStat(selected)
    if (stat === undefined) return yield* missing()
    if (stat.isSymbolicLink() || !stat.isDirectory()) return yield* fail("unsupported", "Cursor state directory must be a real directory.")
    const root = yield* io(() => realpath(selected))
    const context: Context = { root, limits, proofs: new Map(), entries: 0, bytes: 0 }
    yield* remember(context, root, stat)
    const value = yield* use(context)
    yield* verify(context)
    return value
  }).pipe(Effect.timeoutOrElse({ duration: limits.durationMs, orElse: () => fail("limit", "Cursor source operation exceeded its deadline.") }))
})
const cursorFor = (source: CursorSourceCandidate) => "cursor-native-v1:" + createHash("sha256").update(JSON.stringify([source.workspaceSlug, source.sourceId])).digest("hex")

/** Read-only bounded inventory. Slugs and current paths never establish Project Origin. */
export const discoverCursorSources = (request: DiscoveryRequest): Effect.Effect<CursorDiscoveryPage, CursorSourceError> => Effect.gen(function*() {
  yield* decode(discoveryCursor, request.cursor, "invalid_input", "Cursor discovery cursor is invalid.")
  return yield* withContext(request.stateDirectory, request.limits,
    () => Effect.succeed({ sources: [], cursor: null, done: true }),
    context => Effect.gen(function*() {
      const all = yield* inventory(context)
      const previous = request.cursor === null ? -1 : all.findIndex(source => cursorFor(source) === request.cursor)
      if (request.cursor !== null && previous < 0) return yield* fail("changed", "Cursor discovery position is no longer present; restart discovery.")
      const sources = all.slice(previous + 1, previous + 1 + request.limits.pageSources)
      const done = previous + 1 + sources.length >= all.length
      return { sources, cursor: done ? null : cursorFor(sources.at(-1)!), done }
    }))
})

const readBytes = (context: Context, path: string, maximum: number): Effect.Effect<Bytes, CursorSourceError> => Effect.gen(function*() {
  const pathBefore = yield* io(() => lstat(path, { bigint: true }))
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return yield* fail("unsupported", "Cursor source must be a regular file.")
  yield* pathIdentity(context, path)
  return yield* Effect.acquireUseRelease(io(() => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)), handle => Effect.gen(function*() {
    const before = yield* io(() => handle.stat({ bigint: true }))
    if (!before.isFile() || !same(pathBefore, before)) return yield* fail("changed", "Cursor source changed before reading; retry.")
    const remaining = Math.min(maximum, context.limits.sourceBytes - context.bytes)
    if (before.size > BigInt(remaining)) return yield* fail("limit", "Cursor source files exceed their aggregate byte budget.")
    yield* pathIdentity(context, path)
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const part = yield* io(() => handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead))
      if (part.bytesRead === 0) break
      bytesRead += part.bytesRead
    }
    const after = yield* io(() => handle.stat({ bigint: true }))
    const pathAfter = yield* optionalStat(path)
    if (pathAfter === undefined || !same(before, after) || !same(before, pathAfter) || bytesRead !== Number(before.size))
      return yield* fail("changed", "Cursor source changed during reading; retry.")
    yield* pathIdentity(context, path)
    yield* remember(context, path, after)
    context.bytes += bytesRead
    return { bytes: buffer.subarray(0, bytesRead), proof: { path, stat: after } }
  }), handle => io(() => handle.close()))
})

// Bound structural parsing as well as bytes. These are hard profile ceilings;
// source admission can be smaller. No recursive walk or schema consumes raw tool input.
const parseJson = (json: string): unknown => {
  let depth = 0, quoted = false, escaped = false
  for (const character of json) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === "{" || character === "[") {
      if (++depth > 64) throw failure("limit", "Cursor JSON exceeds the structural depth ceiling.")
    } else if (character === "}" || character === "]") depth--
  }
  const value: unknown = JSON.parse(json)
  const pending: unknown[] = [value]
  let nodes = 0
  while (pending.length > 0) {
    if (++nodes > 100_000) throw failure("limit", "Cursor JSON exceeds the structural node ceiling.")
    const node = pending.pop()
    if (node !== null && typeof node === "object") {
      const children = Object.values(node)
      if (nodes + pending.length + children.length > 100_000) throw failure("limit", "Cursor JSON exceeds the structural node ceiling.")
      for (const child of children) pending.push(child)
    }
  }
  return value
}
const jsonObject = (bytes: Buffer) => Effect.gen(function*() {
  const rawJson = yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: () => failure("format", "Cursor source contains invalid UTF-8.") })
  const json = yield* Effect.try({ try: () => parseJson(rawJson), catch: error => error instanceof CursorSourceError ? error : failure("format", "Cursor source contains invalid JSON.") })
  const raw = yield* decode(ObjectRow, json, "format", "Cursor source record must be a JSON object.")
  return { rawJson, raw }
})
const records = (bytes: Buffer, limits: CursorSourceLimits) => Effect.gen(function*() {
  if (bytes.length > 0 && bytes.at(-1) !== 10) return yield* fail("format", "Cursor transcript has an incomplete trailing record; retry after a complete newline.")
  const output: CursorSourceRecord[] = []
  let offset = 0
  while (offset < bytes.length) {
    yield* Effect.yieldNow
    if (output.length >= limits.records) return yield* fail("limit", "Cursor transcript exceeds its record budget.")
    const end = bytes.indexOf(10, offset)
    if (end - offset > limits.rowBytes) return yield* fail("limit", "Cursor transcript record exceeds its byte budget.")
    const { rawJson, raw } = yield* jsonObject(bytes.subarray(offset, end))
    const base: CursorRecordBase = { line: output.length + 1, rawJson, raw, eventTime: null, nativeEventId: null }
    if (raw.role === "user" || raw.role === "assistant") {
      // Unknown content kinds fail the whole observation, even though Raw is preserved.
      const message = typeof raw.message === "object" && raw.message !== null ? raw.message as Record<string, unknown> : {}
      if (Array.isArray(message.content)) for (const part of message.content) {
        const type = typeof part === "object" && part !== null && "type" in part ? part.type : undefined
        if (type !== "text" && type !== "tool_use") return yield* fail("unsupported", "Cursor message content kind is unsupported.")
      }
      const value = yield* decode(Message, raw, "format", "Cursor message record is malformed.")
      const content: CursorContentPart[] = value.message.content.map(part => part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "tool_use", name: part.name, input: part.input, toolCallId: null })
      output.push({ ...base, kind: "message", role: value.role, content })
    } else if (raw.type === "turn_ended") {
      const value = yield* decode(TurnEnded, raw, "format", "Cursor turn-ended record is malformed.")
      output.push({ ...base, kind: "turn_ended", status: value.status })
    } else return yield* fail("unsupported", "Cursor transcript record kind is unsupported.")
    offset = end + 1
  }
  return output
})

const metadata = (context: Context, sourceId: string) => Effect.gen(function*() {
  const chats = join(context.root, "chats"), candidates: CursorMetadataCandidate[] = []
  if (!(yield* directory(context, chats, true))) return candidates
  for (const bucket of yield* list(context, chats)) {
    if (!bucket.isDirectory()) continue
    const bucketPath = join(chats, bucket.name)
    yield* directory(context, bucketPath)
    const sessionPath = join(bucketPath, sourceId)
    if (!(yield* directory(context, sessionPath, true))) continue
    const path = join(sessionPath, "meta.json"), stat = yield* optionalStat(path)
    if (stat === undefined) continue
    const file = yield* readBytes(context, path, Math.min(context.limits.rowBytes, 64 * 1024))
    const { raw } = yield* jsonObject(file.bytes)
    const value = yield* decode(Metadata, raw, "format", "Cursor metadata candidate is malformed.")
    candidates.push({ path, title: value.title ?? null, cwd: value.cwd ?? null, createdAtMs: value.createdAtMs ?? null, raw })
  }
  return candidates
})
const subagents = (context: Context, source: CursorSourceCandidate) => Effect.gen(function*() {
  const path = join(dirname(source.transcriptPath), "subagents"), candidates: CursorSubagentCandidate[] = []
  if (!(yield* directory(context, path, true))) return candidates
  for (const entry of yield* list(context, path)) {
    if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue
    const sourceId = entry.name.slice(0, -6), transcriptPath = join(path, entry.name)
    yield* decode(sourceIdentity, sourceId, "unsupported", "Cursor subagent candidate identity is unsupported.")
    const stat = yield* io(() => lstat(transcriptPath, { bigint: true }))
    if (stat.isSymbolicLink() || !stat.isFile()) return yield* fail("unsupported", "Cursor subagent candidate must be a regular file.")
    yield* pathIdentity(context, transcriptPath)
    if (candidates.length >= context.limits.subagents) return yield* fail("limit", "Cursor subagent candidates exceed their count budget.")
    candidates.push({ sourceId, transcriptPath })
  }
  return candidates
})

/** One complete, stable observation; no cross-observation continuity or attribution is claimed. */
export const readCursorSource = (request: ReadRequest): Effect.Effect<CursorSourceSnapshot, CursorSourceError> => Effect.gen(function*() {
  yield* decode(sourceIdentity, request.sourceId, "invalid_input", "Cursor source identity is invalid.")
  return yield* withContext(request.stateDirectory, request.limits,
    () => fail("missing", "Cursor state directory is missing."),
    context => Effect.gen(function*() {
      const source = (yield* inventory(context)).find(candidate => candidate.sourceId === request.sourceId)
      if (source === undefined) return yield* fail("missing", "Cursor source is missing.")
      const file = yield* readBytes(context, source.transcriptPath, context.limits.sourceBytes)
      const content = yield* records(file.bytes, context.limits)
      const metadataCandidates = yield* metadata(context, source.sourceId)
      const subagentCandidates = yield* subagents(context, source)
      const modifiedAt = yield* Effect.try({ try: () => new Date(Number(file.proof.stat.mtimeMs)).toISOString(),
        catch: () => failure("format", "Cursor filesystem observation timestamp is invalid.") })
      return {
        source, origin: { status: "unknown" as const, reason: "creation_evidence_unavailable" as const },
        records: content, metadataCandidates, subagentCandidates,
        fileObservation: { sizeBytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex"),
          modifiedAt, modifiedAtMeaning: "filesystem_observation" as const }
      }
    }))
})
