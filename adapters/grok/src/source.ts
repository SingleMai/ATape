import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { Schema } from "effect"
import type { GitSource, SourceCaptureLimits, SourceDiscoveryPage } from "@atape/domain"

export class GrokSourceError extends Schema.TaggedError<GrokSourceError>()("GrokSourceError", {
  reason: Schema.Literals(["io", "format", "unsupported", "attribution", "limit", "closed"]), message: Schema.String
}) {}
export const fail = (reason: GrokSourceError["reason"], message: string): never => { throw new GrokSourceError({ reason, message }) }
export const sourceError = (cause: unknown) => cause instanceof GrokSourceError ? cause : new GrokSourceError({ reason: "io", message: "Grok source could not be read." })
export type Row = Record<string, unknown>
export const object = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {}
export const identity = (...parts: string[]) => "grok_" + createHash("sha256").update(JSON.stringify(parts)).digest("hex")
export const id = (v: unknown): string => {
  if (typeof v !== "string" || !v || Buffer.byteLength(v) > 500 || v.includes("\0")) fail("format", "Grok identity is invalid.")
  return v as string
}
export const time = (v: unknown): string => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT/.test(v) || !Number.isFinite(Date.parse(v))) fail("format", "Grok timestamp is invalid.")
  return new Date(v as string).toISOString()
}
const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
export const parse = (text: string): Row => { try { return decode(JSON.parse(text)) } catch { return fail("format", "Grok source contains invalid JSON.") } }
const utf8 = (bytes: Uint8Array) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return fail("format", "Grok source is not valid UTF-8.") } }
const stamp = (s: Awaited<ReturnType<typeof lstat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
const missing = (e: unknown) => object(e).code === "ENOENT"
const directory = async (path: string) => { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) fail("format", "Grok source directories must not be symlinks."); return stamp(s) }
const maxEntries = 10_000, maxBytes = 16 * 1024 * 1024

/** Names only locate Sessions. Metadata establishes their native identity and Origin. */
const inventory = async (home: string, signal: AbortSignal) => {
  if (!isAbsolute(home)) fail("format", "Grok home must be absolute.")
  const files: string[] = []; let count = 0
  const check = () => { signal.throwIfAborted(); if (++count > maxEntries) fail("limit", "Grok discovery exceeds 10000 entries.") }
  try { await directory(home); await directory(join(home, "sessions")) } catch (e) { if (missing(e)) return []; throw e }
  for await (const group of await opendir(join(home, "sessions"))) {
    check(); if (!group.isDirectory() || group.isSymbolicLink()) continue
    const path = join(home, "sessions", group.name); await directory(path)
    for await (const session of await opendir(path)) {
      check(); if (session.isDirectory() && !session.isSymbolicLink()) files.push(join(path, session.name))
    }
  }
  return files.sort()
}

const readFile = async (path: string, budget: number, signal: AbortSignal) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) fail("format", "Grok source must be a regular file.")
    if (before.size > budget) fail("limit", "Grok source exceeds its snapshot byte budget.")
    const bytes = Buffer.alloc(before.size)
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) fail("format", "Grok source changed during capture; retry.")
      offset += bytesRead
    }
    if (stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await lstat(path))) fail("format", "Grok source changed during capture; retry.")
    return { path, stamp: stamp(before), bytes: bytes.length, json: utf8(bytes) }
  } finally { await handle.close() }
}

const origin = (summary: Row, path: string): GitSource => {
  const info = object(summary.info), sourceId = id(info.id)
  if (sourceId !== basename(path)) fail("format", "Grok directory and native Session identity disagree.")
  if (typeof info.cwd !== "string" || !isAbsolute(info.cwd) || Buffer.byteLength(info.cwd) > 4096 || info.cwd.includes("\0")) fail("attribution", "Grok original CWD is unavailable.")
  if (summary.parent_session_id != null || summary.forked_at != null || summary.session_kind != null && summary.session_kind !== "primary")
    fail("unsupported", "Grok forks and child Sessions require a wider native profile.")
  if (summary.chat_format_version !== 1) fail("unsupported", "Grok chat format is unsupported.")
  time(summary.created_at)
  return { sourceId, originKey: identity("origin", sourceId, summary.created_at as string), cwd: info.cwd as string }
}

export const discover = async (home: string, cursor: string | null, limits: SourceCaptureLimits, signal: AbortSignal): Promise<SourceDiscoveryPage> => {
  const started = performance.now(), files = await inventory(home, signal)
  const at = cursor === null ? -1 : files.findIndex(path => identity("path", path) === cursor)
  const selected = files.slice(at + 1, at + 1 + Math.min(limits.pageRows, 32))
  const names = new Map<string, number>(); for (const path of files) names.set(basename(path), (names.get(basename(path)) ?? 0) + 1)
  const sources: GitSource[] = [], sourceFailures: SourceDiscoveryPage["sourceFailures"][number][] = []
  for (const path of selected) {
    signal.throwIfAborted()
    if (performance.now() - started > limits.durationMs) fail("limit", "Grok discovery exceeded its deadline.")
    if (names.get(basename(path))! > 1) { sourceFailures.push({ source: path, reason: "duplicate" }); continue }
    try {
      await directory(path)
      const summary = await readFile(join(path, "summary.json"), Math.min(limits.rowBytes, 65536), signal)
      sources.push(origin(parse(summary.json), path))
    } catch (e) { signal.throwIfAborted(); const reason = sourceError(e).reason; sourceFailures.push({ source: path, reason: reason === "closed" ? "io" : reason }) }
  }
  const done = at + 1 + selected.length >= files.length
  const page = { sources, cursor: done ? null : identity("path", selected.at(-1)!), done, sourceFailures, sourceFailuresTruncated: false }
  if (Buffer.byteLength(JSON.stringify(page)) > limits.pageBytes) fail("limit", "Grok discovery page exceeds its byte budget.")
  return page
}

/** Read a bounded complete view and recheck every member before any frame escapes. */
export const snapshot = async (home: string, sourceId: string, limits: SourceCaptureLimits, signal: AbortSignal) => {
  const started = performance.now(), paths = (await inventory(home, signal)).filter(path => basename(path) === sourceId)
  if (paths.length !== 1) fail("format", "Grok source is missing or duplicated.")
  const path = paths[0]!, dirs = [home, join(home, "sessions"), dirname(path), path]
  const dirStamps: string[] = []; for (const d of dirs) dirStamps.push(await directory(d))
  const summary = await readFile(join(path, "summary.json"), Math.min(limits.rowBytes, 65536), signal)
  const signals = await readFile(join(path, "signals.json"), Math.min(limits.rowBytes, 65536), signal)
  const updates = await readFile(join(path, "updates.jsonl"), maxBytes - summary.bytes - signals.bytes, signal)
  for (const member of [summary, signals, updates]) if (member.stamp !== stamp(await lstat(member.path))) fail("format", "Grok source changed during capture; retry.")
  for (const [index, d] of dirs.entries()) if (dirStamps[index] !== await directory(d)) fail("format", "Grok source directory changed during capture; retry.")
  const metadata = parse(summary.json), state = parse(signals.json), evidence = origin(metadata, path)
  if (state.hasReverted !== false || state.compactionCount !== 0 || state.regenerationCount !== 0 || state.editAndRetryCount !== 0)
    fail("unsupported", "Grok rewind, compaction and regeneration require a wider native profile.")
  if (!updates.json.endsWith("\n")) fail("format", "Grok update stream is incomplete; retry.")
  const records: { row: Row; json: string }[] = []
  for (const json of updates.json.slice(0, -1).split("\n")) {
    signal.throwIfAborted()
    if (performance.now() - started > limits.durationMs) fail("limit", "Grok capture exceeded its deadline.")
    if (Buffer.byteLength(json) > limits.rowBytes || records.length >= limits.records) fail("limit", "Grok update stream exceeds its record budget.")
    records.push({ row: parse(json), json })
  }
  if (metadata.num_messages !== records.length || !records.length) fail("format", "Grok summary and update stream are incomplete or inconsistent; retry.")
  return { origin: evidence, metadata, state, records, summaryJson: summary.json, signalsJson: signals.json }
}
