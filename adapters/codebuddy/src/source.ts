import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
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

export const origin = (row: Row, file: string): GitSource => {
  if (row.type !== "message" || row.role !== "user" || row.parentId != null || row.logicalParentId != null)
    fail("unsupported", "CodeBuddy requires an original, unbranched user root.")
  const sourceId = id(row.sessionId)
  if (basename(file, ".jsonl") !== sourceId || sourceId.startsWith("agent-")) fail("unsupported", "CodeBuddy copied or subagent histories are not supported.")
  if (typeof row.cwd !== "string" || !isAbsolute(row.cwd)) fail("attribution", "CodeBuddy original CWD is unavailable.")
  return { sourceId, originKey: identity("origin", sourceId, id(row.id)), cwd: row.cwd as string }
}

const readHeader = async (file: string, limits: SourceCaptureLimits, signal: AbortSignal) => {
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
    if (stamp(s) !== stamp(await handle.stat())) fail("format", "CodeBuddy source changed during discovery; retry.")
    return origin(parse(utf8(buffer.subarray(0, end))), file)
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
export const snapshot = async (home: string, sourceId: string, limits: SourceCaptureLimits, signal: AbortSignal) => {
  const files = (await inventory(home, signal)).filter(file => basename(file, ".jsonl") === sourceId)
  if (files.length !== 1) fail("format", "CodeBuddy source is missing or has duplicate identities.")
  const file = files[0]!, metaFile = file.replace(/\.jsonl$/, ".meta.json")
  const started = performance.now()
  const check = () => { signal.throwIfAborted(); if (performance.now() - started > limits.durationMs) fail("limit", "CodeBuddy snapshot exceeded its deadline.") }
  const metadata = async () => {
    try {
      const handle = await open(metaFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size > 64 * 1024) fail("limit", "CodeBuddy metadata exceeds its bound.")
        const buffer = Buffer.alloc(before.size)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (bytesRead !== buffer.length || stamp(before) !== stamp(await handle.stat())) fail("format", "CodeBuddy metadata changed; retry.")
        return { stamp: stamp(before), row: parse(utf8(buffer)) }
      } finally { await handle.close() }
    } catch (e) { if (missing(e)) return { stamp: "absent", row: {} as Row }; throw e }
  }
  const meta = await metadata()
  if (meta.row.forkedFrom != null || meta.row.parentSessionId != null || meta.row.isForkedCompactionSession === true)
    fail("unsupported", "CodeBuddy fork, compaction and child sessions require a wider source profile.")
  if (Object.keys(meta.row).length) fail("unsupported", "CodeBuddy sidecar-dependent histories require a wider source profile.")
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) fail("format", "CodeBuddy source is not a regular file.")
    if (before.size > maxSnapshotBytes) fail("limit", "CodeBuddy session exceeds the 16 MiB snapshot limit.")
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
    if (stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await lstat(file)) || meta.stamp !== (await metadata()).stamp)
      fail("format", "CodeBuddy source changed while reading; retry with a fresh snapshot.")
    return { records, origin: origin(records[0]!.row, file) }
  } finally { await handle.close() }
}
