/** THROWAWAY Node source Adapter. Each collect has a NEW SQLite view.
 * No pending payload spool, target publication, cross-page snapshot, or source ACK.
 * Derived timestamp order is stable across pages, but same-ms ties do NOT prove
 * native part-ID ordering; that requires an ordinal/ordering-tuple contract.
 * Raw covers part rows only; Active Path, usage/media and v2 are not implemented.
 * ledgerPath MUST be a caller-owned scratch path, never an OpenCode database.
 */
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Effect, Schema } from "effect"
import { AdapterCollectionPage, AdapterProtocolVersion, type AdapterEvent, type AdapterRawReference,
  type AdapterRawSegment, type AcpSessionUpdate } from "@atape/domain"

export type NativePageInput = {
  dbPath: string; rootID: string; originCwd?: string; projectPath: string; ledgerPath: string
  cursor: string | null; rawEnabled: boolean; pageSize?: number; maxRecordBytes?: number; observedAt: string
}
export class NativeReaderError extends Schema.TaggedError<NativeReaderError>()("NativeReaderError", {
  reason: Schema.Literals(["io", "format"]), message: Schema.String
}) {}
export type ReaderMetrics = {
  sourceQueries: number; projectedRows: number; wholeDataReads: number
  largestSourceRecordBytes: number; sourceReadOnly: boolean; rawEnabled: boolean
}
let metrics: ReaderMetrics = freshMetrics(false)
function freshMetrics(rawEnabled: boolean): ReaderMetrics {
  return { sourceQueries: 0, projectedRows: 0, wholeDataReads: 0,
    largestSourceRecordBytes: 0, sourceReadOnly: true, rawEnabled }
}
/** Per-process probe instrumentation; take after the sequential read has completed. */
export function takeReaderMetrics(): ReaderMetrics { return { ...metrics } }
type Row = Record<string, any>
type Cursor = { scan: number; after: [number, string, string] | null; done: boolean }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const iso = (value: unknown) => new Date(Number(value)).toISOString()
const eventKey = (session: string, message: string, part: string, slot: string) =>
  `oc_${hash([session, message, part, slot])}`

export const readNativePage = (input: NativePageInput): Effect.Effect<AdapterCollectionPage, NativeReaderError> =>
  Effect.scoped(Effect.gen(function*() {
    metrics = freshMetrics(input.rawEnabled)
    const diagnostic = (reason: "unsupported" | "attribution" | "format" | "limit") => ({
      protocolVersion: AdapterProtocolVersion, nextCursor: input.cursor, hasMore: false, observations: [],
      sourceFailures: [{ source: `opencode:${input.rootID}`, reason }]
    } satisfies AdapterCollectionPage)
    const originMatches = yield* Effect.try({ try: () => Boolean(input.originCwd) &&
      realpathSync(input.originCwd!) === realpathSync(input.projectPath),
      catch: () => new NativeReaderError({ reason: "io", message: "Controlled Origin path cannot be resolved." }) })
    if (!originMatches) return diagnostic("attribution")
    if (resolve(input.ledgerPath) === resolve(input.dbPath)) return yield* new NativeReaderError({ reason: "io", message: "Scratch ledger must not be the source database." })
    const db = yield* Effect.acquireRelease(
      Effect.try({ try: () => new DatabaseSync(input.dbPath, { readOnly: true }),
        catch: () => new NativeReaderError({ reason: "io", message: "Could not open controlled source read-only." }) }),
      db => Effect.sync(() => db.close())
    )
    return yield* Effect.try({ try: () => {
      const query = (sql: string, ...params: SQLInputValue[]): Row[] => {
        metrics.sourceQueries++
        return db.prepare(sql).all(...params) as Row[]
      }
      db.exec("BEGIN")
      try {
        for (const [table, needed] of Object.entries({
          session: ["id", "parent_id", "title", "time_created", "time_updated"],
          message: ["id", "session_id", "data", "time_created", "time_updated"],
          part: ["id", "message_id", "session_id", "data", "time_created", "time_updated"]
        })) {
          const columns = new Set(query(`PRAGMA table_info(${table})`).map(row => row.name))
          if (needed.some(column => !columns.has(column))) return diagnostic("unsupported")
        }
        const root = query("SELECT id,parent_id,title,time_created,time_updated FROM session WHERE id=?", input.rootID)[0]
        if (!root || root.parent_id) return diagnostic("attribution")
        // UNION prevents cyclic recursion. The complete tree must fit the real Host bound.
        const family = query(`WITH RECURSIVE family(id) AS (
          SELECT id FROM session WHERE id=? UNION SELECT s.id FROM session s JOIN family f ON s.parent_id=f.id
        ) SELECT s.id,s.parent_id,s.title,s.time_created,s.time_updated FROM session s JOIN family f ON s.id=f.id LIMIT 101`, input.rootID)
        if (family.length > 100) return diagnostic("limit")
        const ids = family.map(row => String(row.id)); const members = new Set(ids)
        if (family.some(row => row.id !== input.rootID && !members.has(row.parent_id))) return diagnostic("attribution")
        const cursor: Cursor = input.cursor === null ? { scan: 0, after: null, done: false } : JSON.parse(input.cursor)
        if (!Number.isSafeInteger(cursor.scan) || typeof cursor.done !== "boolean" ||
          (cursor.after !== null && (!Array.isArray(cursor.after) || cursor.after.length !== 3 ||
            !Number.isSafeInteger(cursor.after[0]) || typeof cursor.after[1] !== "string" || typeof cursor.after[2] !== "string"))) {
          throw new Error("Invalid probe cursor")
        }
        const scan = cursor.scan + (cursor.done ? 1 : 0)
        const after = cursor.done ? null : cursor.after
        const pageSize = Math.min(8, Math.max(1, Math.floor(input.pageSize ?? 2)))
        const maxBytes = Math.min(64 * 1024, Math.max(1, Math.floor(input.maxRecordBytes ?? 64 * 1024)))
        const placeholders = ids.map(() => "?").join(",")
        const boundary = after ? "AND (m.time_created,m.id,p.id) > (?,?,?)" : ""
        const candidates = query(`SELECT p.id,p.message_id,p.session_id,p.time_created,p.time_updated,
          m.time_created AS message_created,length(CAST(p.data AS BLOB)) AS part_bytes,
          length(CAST(m.data AS BLOB)) AS message_bytes
          FROM part p JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
          WHERE p.session_id IN (${placeholders}) ${boundary}
          ORDER BY m.time_created,m.id,p.id LIMIT ?`, ...ids, ...(after ?? []), pageSize + 1)
        const selected = candidates.slice(0, pageSize)
        for (const row of selected) {
          metrics.largestSourceRecordBytes = Math.max(metrics.largestSourceRecordBytes, row.part_bytes, row.message_bytes)
          if (row.part_bytes > maxBytes || row.message_bytes > maxBytes) return diagnostic("limit")
        }
        const ledger = new DatabaseSync(input.ledgerPath)
        try {
          ledger.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS versions(key TEXT PRIMARY KEY,digest TEXT NOT NULL,revision INTEGER NOT NULL,
              observed_at TEXT NOT NULL,raw_ref TEXT); BEGIN IMMEDIATE`)
          const version = (key: string, value: unknown, ref?: AdapterRawReference) => {
            const digest = hash(value)
            const old = ledger.prepare("SELECT digest,revision,observed_at,raw_ref FROM versions WHERE key=?").get(key) as Row | undefined
            if (old && old.digest === digest) return { revision: Number(old.revision), observedAt: String(old.observed_at),
              rawRef: old.raw_ref ? JSON.parse(old.raw_ref) as AdapterRawReference : undefined }
            const revision = Number(old?.revision ?? 0) + 1
            ledger.prepare(`INSERT INTO versions VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
              digest=excluded.digest,revision=excluded.revision,observed_at=excluded.observed_at,raw_ref=excluded.raw_ref`)
              .run(key, digest, revision, input.observedAt, ref ? JSON.stringify(ref) : null)
            return { revision, observedAt: input.observedAt, rawRef: ref }
          }
          const events: AdapterEvent[] = []; const rawSegments: AdapterRawSegment[] = []
          for (const row of selected) {
            // Never SELECT data in Raw-off mode: only projection fields cross SQLite→JS.
            const projected = query(`SELECT json_extract(p.data,'$.type') AS type,
              json_extract(p.data,'$.text') AS text,json_extract(p.data,'$.callID') AS call_id,
              json_extract(p.data,'$.tool') AS tool,json_extract(p.data,'$.state.status') AS status,
              json_quote(json_extract(p.data,'$.state.input')) AS tool_input,
              json_quote(json_extract(p.data,'$.state.output')) AS tool_output,
              json_extract(p.data,'$.state.error') AS tool_error,
              json_extract(p.data,'$.state.metadata.sessionId') AS child_id,
              json_extract(m.data,'$.role') AS role
              FROM part p JOIN message m ON m.id=p.message_id WHERE p.id=?`, row.id)[0]
            metrics.projectedRows++
            let rawRef: AdapterRawReference = { _tag: "unavailable", reason: "Raw disabled for this captured version" }
            if (input.rawEnabled) {
              const original = query("SELECT data FROM part WHERE id=?", row.id)[0]
              metrics.wholeDataReads++
              const source = { table: "part", id: row.id, messageID: row.message_id, sessionID: row.session_id,
                timeCreated: row.time_created, timeUpdated: row.time_updated, data: original.data }
              const rawVersion = version(`raw:${input.rootID}:${row.id}`, source)
              const objectID = `oc_raw_${hash([input.rootID, row.id, rawVersion.revision])}`
              // data remains the native legal JSON text, not a parse/stringify reconstruction.
              const envelope = JSON.stringify({ format: "atape.opencode.observation.prototype.v1", observationID: objectID,
                observedAt: rawVersion.observedAt, operation: "row-observed", table: "part", rowID: row.id,
                messageID: row.message_id, sessionID: row.session_id, timeCreated: row.time_created, timeUpdated: row.time_updated })
              rawSegments.push({ sourceObjectId: objectID, sourceGeneration: "1", sourceOffset: 0,
                sourceName: "opencode-observation.jsonl", mediaType: "application/x-ndjson",
                content: `${envelope.slice(0, -1)},"data":${original.data}}\n`, final: true })
              rawRef = { _tag: "object", sourceObjectId: objectID, fragment: `part:${row.id}` }
            }
            const updates: Array<[string, AcpSessionUpdate]> = []
            if (projected.type === "text" && typeof projected.text === "string") {
              updates.push(["text", { sessionUpdate: projected.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                messageId: row.message_id, content: { type: "text", text: projected.text } }])
            } else if (projected.type === "reasoning" && typeof projected.text === "string") {
              updates.push(["reasoning", { sessionUpdate: "agent_thought_chunk", messageId: row.message_id,
                content: { type: "text", text: projected.text } }])
            } else if (projected.type === "tool" && typeof projected.call_id === "string") {
              const callID = `${row.session_id}:${projected.call_id}`
              const title = String(projected.tool ?? "tool")
              updates.push(["call", { sessionUpdate: "tool_call", toolCallId: callID, title,
                kind: "other", status: "pending", rawInput: JSON.parse(projected.tool_input) }])
              if (projected.status === "completed" || projected.status === "error") updates.push(["result", {
                sessionUpdate: "tool_call_update", toolCallId: callID, title, kind: "other",
                status: projected.status === "error" ? "failed" : "completed",
                rawOutput: projected.status === "error" ? projected.tool_error : JSON.parse(projected.tool_output)
              }])
            }
            for (const [slot, update] of updates) {
              const id = eventKey(row.session_id, row.message_id, row.id, slot)
              const child = slot === "call" && members.has(projected.child_id) && projected.child_id !== row.session_id
                ? projected.child_id as string : undefined
              const occurredAt = iso(row.time_created)
              const sourceOrder = Number(row.message_created)
              const eventIndex = Number(row.time_created) * 2 + (slot === "result" ? 1 : 0)
              const state = version(`event:${id}`, { update, child, occurredAt, sourceOrder, eventIndex }, rawRef)
              events.push({ sourceEventId: id, sourceThreadId: row.session_id, revision: state.revision, projectionRevision: 1,
                sourceOrder, eventIndex, orderFidelity: "derived", fidelity: "native",
                rawRef: state.rawRef!, occurredAt, update,
                ...(child ? { childSourceThreadId: child } : {}) })
            }
          }
          const threads = family.sort((a, b) => String(a.id).localeCompare(String(b.id))).map(row => {
            const shape = { sourceThreadId: String(row.id), label: String(row.title ?? ""), summary: "",
              captureStatus: "partial" as const, ...(row.parent_id ? { parentSourceThreadId: String(row.parent_id) } : {}) }
            return { ...shape, revision: version(`thread:${input.rootID}:${row.id}`, shape).revision }
          })
          const sessionShape = { sourceSessionId: input.rootID, title: String(root.title ?? ""), summary: "", insight: "",
            actor: { name: "Controlled fixture", harness: "OpenCode" }, branch: "", status: "idle" as const,
            captureStatus: "partial" as const, updatedAt: iso(root.time_updated), reportedEventCount: 0 }
          const sessionRevision = version(`session:${input.rootID}`, { ...sessionShape, threads }).revision
          const last = selected.at(-1)
          const hasMore = candidates.length > pageSize
          const nextCursor = JSON.stringify({ scan, after: last ? [last.message_created, last.message_id, last.id] : after, done: !hasMore })
          const page: AdapterCollectionPage = { protocolVersion: AdapterProtocolVersion, nextCursor, hasMore,
            observations: selected.length ? [{ observationId: `oc_page_${hash([input.rootID, scan, after, events.map(e => [e.sourceEventId, e.revision])])}`,
              observedAt: input.observedAt, session: { ...sessionShape, revision: sessionRevision }, threads, events, rawSegments }] : [] }
          const valid = Schema.decodeUnknownSync(AdapterCollectionPage)(page)
          ledger.exec("COMMIT")
          return valid
        } catch (error) { if (ledger.isTransaction) ledger.exec("ROLLBACK"); throw error }
        finally { ledger.close() }
      } finally { db.exec("ROLLBACK") }
    }, catch: () => new NativeReaderError({ reason: "format", message: "Controlled native read, cursor or scratch ledger failed validation." }) })
  }))
