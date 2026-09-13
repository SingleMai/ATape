import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
import { Schema } from "effect"
import type { GitSource, SourceCaptureLimits, SourceDiscoveryPage } from "@atape/domain"

export class KimiSourceError extends Schema.TaggedError<KimiSourceError>()("KimiSourceError", {
  reason: Schema.Literals(["io", "format", "unsupported", "attribution", "limit", "closed"]), message: Schema.String
}) {}
export const fail = (reason: KimiSourceError["reason"], message: string): never => { throw new KimiSourceError({ reason, message }) }
export const sourceError = (cause: unknown) => cause instanceof KimiSourceError ? cause : new KimiSourceError({ reason: "io", message: "Kimi source could not be read." })
export const identity = (...parts: string[]) => "kimi_" + createHash("sha256").update(JSON.stringify(parts)).digest("hex")
export type Row = Record<string, unknown>
export const object = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
export const id = (value: unknown): string => {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 500 || value.includes("\0")) fail("format", "Kimi record identity is invalid.")
  return value as string
}
const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const parse = (json: string): Row => { try { return decode(JSON.parse(json)) } catch { return fail("format", "Kimi source contains invalid JSON.") } }
const utf8 = (bytes: Uint8Array): string => { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return fail("format", "Kimi source is not valid UTF-8.") } }
export const timestamp = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail("format", "Kimi timestamp is invalid.")
  return value as number
}
const stamp = (s: Awaited<ReturnType<typeof lstat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
const missing = (cause: unknown) => object(cause).code === "ENOENT"
const deadline = (signal: AbortSignal, durationMs: number) => {
  const started = performance.now()
  return () => { signal.throwIfAborted(); if (performance.now() - started > durationMs) fail("limit", "Kimi source exceeded its deadline.") }
}
const directory = async (path: string) => {
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink()) fail("format", "Kimi source directories must not be symlinks.")
  return stamp(s)
}
const inventory = async (home: string, check: () => void) => {
  if (!isAbsolute(home)) fail("format", "Kimi home must be an absolute path.")
  const sessions = join(home, "sessions"), paths: string[] = []
  try { await directory(home); await directory(sessions) } catch (e) { if (missing(e)) return paths; throw e }
  let count = 0
  const entry = () => { check(); if (++count > 10000) fail("limit", "Kimi discovery exceeds 10000 entries.") }
  for await (const bucket of await opendir(sessions)) {
    entry(); if (!bucket.isDirectory() || bucket.isSymbolicLink()) continue
    const path = join(sessions, bucket.name); await directory(path)
    for await (const session of await opendir(path)) {
      entry(); if (session.isDirectory() && !session.isSymbolicLink()) paths.push(join(path, session.name))
    }
  }
  return paths.sort()
}
const readFile = async (path: string, bound: number, check: () => void) => {
  check()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile()) fail("format", "Kimi source must be a regular file.")
    if (before.size > bound) fail("limit", "Kimi source exceeds its snapshot byte budget.")
    const buffer = Buffer.alloc(before.size)
    for (let at = 0; at < buffer.length;) {
      check()
      const { bytesRead } = await handle.read(buffer, at, Math.min(65536, buffer.length - at), at)
      if (!bytesRead) fail("format", "Kimi source was truncated; retry.")
      at += bytesRead
    }
    if (stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await lstat(path))) fail("format", "Kimi source changed while reading; retry.")
    return { path, stamp: stamp(before), buffer }
  } finally { await handle.close() }
}
const metadata = async (path: string, check: () => void) => {
  await directory(path)
  const file = await readFile(join(path, "state.json"), 65536, check), json = utf8(file.buffer), row = parse(json)
  const sourceId = id(row.id)
  if (row.version !== 2) fail("unsupported", "Kimi requires version 2 Session metadata.")
  if (sourceId !== basename(path)) fail("format", "Kimi Session metadata disagrees with its storage identity.")
  if (row.forkedFrom != null && id(row.forkedFrom) === sourceId) fail("format", "Kimi Session cannot be its own fork parent.")
  const agents = object(row.agents), main = object(agents.main)
  if (Object.keys(agents).length !== 1 || main.type !== "main" || main.parentAgentId != null || main.forkedFrom != null)
    fail("unsupported", "Kimi child or independent agents require a wider source profile.")
  if (typeof row.cwd !== "string" || !isAbsolute(row.cwd)) fail("attribution", "Kimi original CWD is unavailable.")
  const createdAt = timestamp(row.createdAt)
  const origin: GitSource = { sourceId, originKey: identity("origin", sourceId, String(createdAt)), cwd: row.cwd as string }
  return { ...file, json, row, origin }
}

export const discover = async (home: string, cursor: string | null, limits: SourceCaptureLimits, signal: AbortSignal): Promise<SourceDiscoveryPage> => {
  const check = deadline(signal, limits.durationMs), paths = await inventory(home, check)
  const at = cursor === null ? -1 : paths.findIndex(path => identity("path", path) === cursor)
  const selected = paths.slice(at + 1, at + 1 + Math.min(limits.pageRows, 32))
  const names = new Map<string, number>()
  for (const path of paths) names.set(basename(path), (names.get(basename(path)) ?? 0) + 1)
  const sources: GitSource[] = [], sourceFailures: SourceDiscoveryPage["sourceFailures"][number][] = []
  for (const path of selected) {
    check()
    if (names.get(basename(path))! > 1) { sourceFailures.push({ source: path, reason: "duplicate" }); continue }
    try { sources.push((await metadata(path, check)).origin) }
    catch (e) { signal.throwIfAborted(); const reason = sourceError(e).reason; sourceFailures.push({ source: path, reason: reason === "closed" ? "io" : reason }) }
  }
  const done = at + 1 + selected.length >= paths.length
  const page = { sources, cursor: done ? null : identity("path", selected.at(-1)!), done, sourceFailures, sourceFailuresTruncated: false }
  if (Buffer.byteLength(JSON.stringify(page)) > limits.pageBytes) fail("limit", "Kimi discovery page exceeds its byte budget.")
  return page
}

/** Files are bounded and rechecked as one view before any projection can escape. */
export const snapshot = async (home: string, sourceId: string, limits: SourceCaptureLimits, signal: AbortSignal) => {
  const check = deadline(signal, limits.durationMs), paths = (await inventory(home, check)).filter(path => basename(path) === sourceId)
  if (paths.length !== 1) fail("format", "Kimi source is missing or has duplicate identities.")
  const path = paths[0]!, meta = await metadata(path, check)
  if (meta.buffer.length > limits.rowBytes) fail("limit", "Kimi Session metadata exceeds its row budget.")
  const directories = [home, join(home, "sessions"), join(path, ".."), path, join(path, "agents"), join(path, "agents", "main")]
  const stamps: string[] = []
  for (const path of directories) { check(); stamps.push(await directory(path)) }
  // New storage engines must not fall back to a stale v2 Wire file.
  try { await lstat(join(path, "trees")); fail("unsupported", "Kimi tree storage requires a wider source profile.") } catch (e) { if (!missing(e)) throw e }
  const wire = await readFile(join(path, "agents", "main", "wire.jsonl"), 16 * 1024 * 1024 - meta.buffer.length, check)
  if (!wire.buffer.length || wire.buffer.at(-1) !== 10) fail("format", "Kimi Wire has an incomplete final record; retry after writing finishes.")
  const records: { row: Row; json: string }[] = []
  for (let at = 0; at < wire.buffer.length;) {
    check()
    const end = wire.buffer.indexOf(10, at)
    if (end - at + 1 > limits.rowBytes) fail("limit", "Kimi Wire record exceeds its row budget.")
    const json = utf8(wire.buffer.subarray(at, end)); records.push({ row: parse(json), json }); at = end + 1
    if (records.length + 1 > limits.records) fail("limit", "Kimi snapshot exceeds its record budget.")
  }
  if (meta.stamp !== stamp(await lstat(meta.path)) || wire.stamp !== stamp(await lstat(wire.path))) fail("format", "Kimi Session changed while reading; retry.")
  for (const [index, path] of directories.entries()) { check(); if (stamps[index] !== await directory(path)) fail("format", "Kimi source directories changed while reading; retry.") }
  return { origin: meta.origin, meta: meta.row, metadataJson: meta.json, records }
}
