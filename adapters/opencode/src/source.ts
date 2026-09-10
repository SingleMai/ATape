import { lstat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Schema } from "effect"

export class OpenCodeSourceError extends Schema.TaggedError<OpenCodeSourceError>()("OpenCodeSourceError", {
  reason: Schema.Literals(["missing", "io", "format", "unsupported", "attribution", "limit", "closed"]),
  message: Schema.String
}) {}
export type OpenCodeSourceLimits = {
  readonly rowBytes: number
  readonly pageBytes: number
  readonly pageRows: number
  readonly records: number
  readonly threads: number
  readonly durationMs: number
}
export type OpenCodeSession = {
  readonly id: string
  readonly projectId: string
  readonly parentId: string | null
  readonly directory: string
  readonly title: string
  readonly version: string
  readonly timeCreated: number
  readonly timeUpdated: number
  readonly archivedAt: number | null
  readonly revert: { readonly messageID: string; readonly partID?: string } | null
}
export type OpenCodeSourceRecord = {
  readonly table: "session" | "message" | "part"
  readonly id: string
  readonly sessionId: string
  readonly messageId?: string
  readonly timeCreated: number
  readonly timeUpdated: number
  /** Only fields used by the Adapter projection. No unrecognized provider metadata. */
  readonly data: Readonly<Record<string, unknown>>
  /** Complete actual row columns, only when Raw was enabled for this view. JSON TEXT stays text. */
  readonly raw?: Readonly<Record<string, string | number | null>>
}
export type OpenCodeSourceView = {
  readonly root: OpenCodeSession
  readonly threads: ReadonlyArray<OpenCodeSession>
  /** One coherent read transaction. A view is single-consumer and cannot be resumed after close. */
  readonly read: () => Effect.Effect<{ readonly records: ReadonlyArray<OpenCodeSourceRecord>; readonly done: boolean }, OpenCodeSourceError>
}

const fail = (reason: OpenCodeSourceError["reason"], message: string) => new OpenCodeSourceError({ reason, message })
const error = (cause: unknown) => cause instanceof OpenCodeSourceError ? cause : fail("io", "OpenCode history could not be read.")
const attempt = <A>(work: () => A) => Effect.try({ try: work, catch: error })
const identifier = (value: unknown, maximum = 500): string => {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > maximum)
    throw fail("format", "OpenCode identity or metadata is invalid or exceeds its bounds.")
  return value
}
const count = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw fail("format", "OpenCode count or timestamp is invalid.")
  return value
}
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail("format", "OpenCode JSON must contain an object.")
  return value as Record<string, unknown>
}
const json = (value: unknown) => {
  if (typeof value !== "string") throw fail("format", "OpenCode JSON column is not text.")
  try { return object(JSON.parse(value)) } catch { throw fail("format", "OpenCode JSON column is invalid.") }
}
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`
const required = {
  session: ["id", "project_id", "parent_id", "directory", "title", "version", "time_created", "time_updated", "time_archived", "revert"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"]
} as const
type Table = keyof typeof required
type Row = Record<string, unknown>

function probe(db: DatabaseSync) {
  const columns = {} as Record<Table, string[]>
  const hasIndex = (table: string, expected: string[]) => {
    const indexes = db.prepare("SELECT * FROM pragma_index_list(?) LIMIT 65").all(table)
    if (indexes.length > 64) throw fail("unsupported", "OpenCode table has an unsupported index layout.")
    return indexes.some(index => {
      if (index.partial !== 0) return false
      const keys = db.prepare("SELECT * FROM pragma_index_info(?) LIMIT 16").all(identifier(index.name, 128)).map(key => key.name)
      return expected.every((key, n) => keys[n] === key)
    })
  }
  for (const table of ["session", "message", "part"] as const) {
    if (db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(table)?.type !== "table")
      throw fail("unsupported", "OpenCode v1 SQLite history tables are unavailable.")
    const info = db.prepare("SELECT * FROM pragma_table_info(?) LIMIT 101").all(table)
    if (info.length > 100 || required[table].some(key => !info.some(column => column.name === key)) ||
      info.filter(column => Number(column.pk) > 0).length !== 1 ||
      !info.some(column => column.name === "id" && column.pk === 1)) throw fail("unsupported", "OpenCode history columns are unsupported.")
    columns[table] = info.map(column => identifier(column.name, 128))
  }
  for (const [table, keys] of [["session", ["parent_id"]], ["message", ["session_id", "time_created", "id"]],
    ["part", ["message_id", "id"]], ["part", ["session_id"]]] as const)
    if (!hasIndex(table, [...keys])) throw fail("unsupported", "OpenCode history lacks an indexed bounded read path.")
  const v2 = db.prepare("SELECT type FROM sqlite_schema WHERE name='session_message'").get()
  if (v2 && (v2.type !== "table" || !hasIndex("session_message", ["session_id"])))
    throw fail("unsupported", "OpenCode v2 history cannot be safely probed.")
  return { columns, v2: v2 !== undefined }
}

const open = (path: string) => Effect.acquireRelease(Effect.tryPromise({
  try: async () => {
    if (!isAbsolute(path)) throw fail("format", "OpenCode history requires an absolute database path.")
    const stat = await lstat(path).catch(cause => {
      if (cause.code === "ENOENT") throw fail("missing", "OpenCode history database is missing.")
      throw cause
    })
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail("unsupported", "OpenCode history must be a regular database file.")
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false })
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250; PRAGMA cache_size=-2048; BEGIN")
      const schema = probe(db)
      return { db, schema, closed: false }
    } catch (cause) { db.close(); throw cause }
  }, catch: error
}), handle => Effect.sync(() => { handle.closed = true; handle.db.close() }))

const sessionColumns = "id,project_id,parent_id,directory,title,version,time_created,time_updated,time_archived,revert"
// Check SQLite byte lengths before returning variable-sized columns to JavaScript.
const sessionBytes = "coalesce(length(cast(id as blob)),0)+coalesce(length(cast(project_id as blob)),0)+coalesce(length(cast(parent_id as blob)),0)+coalesce(length(cast(directory as blob)),0)+coalesce(length(cast(title as blob)),0)+coalesce(length(cast(version as blob)),0)+coalesce(length(cast(revert as blob)),0)"
const session = (db: DatabaseSync, id: string): OpenCodeSession => {
  const size = db.prepare(`SELECT ${sessionBytes} bytes FROM session WHERE id=?`).get(identifier(id))
  if (!size) throw fail("missing", "An OpenCode Session or its parent is missing.")
  if (count(size.bytes) > 16 * 1024) throw fail("limit", "OpenCode Session metadata exceeds its bounds.")
  const row = db.prepare(`SELECT ${sessionColumns} FROM session WHERE id=?`).get(id)!
  const rev = row.revert === null ? null : json(row.revert)
  const directory = identifier(row.directory, 4096)
  if (!isAbsolute(directory)) throw fail("attribution", "OpenCode Session has no absolute Origin directory.")
  if (typeof row.title !== "string" || Buffer.byteLength(row.title) > 4096) throw fail("limit", "OpenCode title exceeds its bounds.")
  return { id: identifier(row.id), projectId: identifier(row.project_id), parentId: row.parent_id === null ? null : identifier(row.parent_id),
    directory, title: row.title, version: identifier(row.version, 128), timeCreated: count(row.time_created), timeUpdated: count(row.time_updated),
    archivedAt: row.time_archived === null ? null : count(row.time_archived),
    revert: rev === null ? null : { messageID: identifier(rev.messageID), ...(rev.partID === undefined ? {} : { partID: identifier(rev.partID) }) } }
}

/** Discovery returns native Session IDs, including children. Capture resolves their proven root.
 * Every call opens/closes its own read transaction; missing/unsupported is never empty history.
 */
export const discoverOpenCodeSessions = (path: string, page: { readonly afterId?: string; readonly limit: number }) => Effect.scoped(Effect.gen(function*() {
  const handle = yield* open(path)
  return yield* attempt(() => {
    if (page.limit < 1 || count(page.limit, 100) !== page.limit) throw fail("limit", "Discovery page is outside its bounds.")
    if (page.afterId !== undefined) identifier(page.afterId)
    const rows = page.afterId === undefined
      ? handle.db.prepare("SELECT CASE WHEN length(cast(id as blob))<=500 THEN id END id FROM session ORDER BY id LIMIT ?").all(page.limit)
      : handle.db.prepare("SELECT CASE WHEN length(cast(id as blob))<=500 THEN id END id FROM session WHERE id>? ORDER BY id LIMIT ?").all(page.afterId, page.limit)
    return rows.map(row => identifier(row.id))
  })
}))

const messageProjection = `json_object('role',json_extract(data,'$.role'),'time',json_extract(data,'$.time'),
  'parentID',json_extract(data,'$.parentID'),'modelID',json_extract(data,'$.modelID'),'providerID',json_extract(data,'$.providerID'),
  'agent',json_extract(data,'$.agent'),'summary',json(CASE json_type(data,'$.summary') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE 'null' END),'tokens',json_extract(data,'$.tokens'),
  'finish',json_extract(data,'$.finish'),'error',json_extract(data,'$.error'))`
const partProjection = `json_object('type',json_extract(data,'$.type'),'text',json_extract(data,'$.text'),
  'time',json_extract(data,'$.time'),'ignored',data -> '$.ignored','synthetic',data -> '$.synthetic',
  'callID',json_extract(data,'$.callID'),'tool',json_extract(data,'$.tool'),
  'state',json_object('status',json_extract(data,'$.state.status'),'input',json_extract(data,'$.state.input'),
    'output',json_extract(data,'$.state.output'),'error',json_extract(data,'$.state.error'),'title',json_extract(data,'$.state.title'),
    'time',json_extract(data,'$.state.time'),'sessionId',json_extract(data,'$.state.metadata.sessionId'),
    'attachments',json_extract(data,'$.state.attachments')),
  'mime',json_extract(data,'$.mime'),'filename',json_extract(data,'$.filename'),'url',json_extract(data,'$.url'),
  'auto',data -> '$.auto','prompt',json_extract(data,'$.prompt'),'description',json_extract(data,'$.description'),
  'agent',json_extract(data,'$.agent'),'name',json_extract(data,'$.name'),'files',json_extract(data,'$.files'),
  'reason',json_extract(data,'$.reason'))`

/** Holds one scoped SQLite snapshot until all records are read or the Effect scope exits.
 * No network, provider executable, source migration, or payload persistence is performed.
 */
export const openOpenCodeSource = (options: { readonly path: string; readonly sessionId: string; readonly rawEnabled: boolean; readonly limits: OpenCodeSourceLimits }) => Effect.gen(function*() {
  const limits = options.limits
  yield* attempt(() => {
    for (const [key, maximum] of [["rowBytes", 16 * 1024 * 1024], ["pageBytes", 32 * 1024 * 1024], ["pageRows", 100],
      ["records", 1_000_000], ["threads", 1000], ["durationMs", 300_000]] as const)
      if (count(limits[key], maximum) < 1) throw fail("limit", "Source admission requires positive explicit limits.")
    if (limits.pageBytes < limits.rowBytes || typeof options.rawEnabled !== "boolean") throw fail("limit", "Source page or Raw policy is invalid.")
  })
  const handle = yield* open(options.path)
  return yield* attempt((): OpenCodeSourceView => {
    const { db, schema } = handle, started = performance.now()
    const check = () => {
      if (handle.closed) throw fail("closed", "OpenCode source view is closed.")
      if (performance.now() - started > limits.durationMs) throw fail("limit", "OpenCode source view exceeded its deadline.")
    }
    let root = session(db, options.sessionId)
    const ancestors = new Set([root.id])
    while (root.parentId !== null) {
      check()
      if (ancestors.has(root.parentId) || ancestors.size >= limits.threads) throw fail("attribution", "OpenCode parent chain is cyclic or exceeds the family bound.")
      ancestors.add(root.parentId); root = session(db, root.parentId)
    }
    const family = [root], visited = new Set([root.id])
    let admitted = 0
    for (let n = 0; n < family.length; n++) {
      check()
      const current = family[n]!
      if (++admitted > limits.records) throw fail("limit", "OpenCode family exceeds its record admission bound.")
      for (const table of ["message", "part"] as const) {
        const amount = db.prepare(`SELECT count(*) amount FROM (SELECT 1 FROM ${table} WHERE session_id=? LIMIT ?)`)
          .get(current.id, limits.records - admitted + 1)?.amount
        admitted += count(amount)
        if (admitted > limits.records) throw fail("limit", "OpenCode family exceeds its record admission bound.")
      }
      if (schema.v2 && db.prepare("SELECT 1 FROM session_message WHERE session_id=? LIMIT 1").get(current.id))
        throw fail("unsupported", "OpenCode v2 or mixed message history is not supported by this source profile.")
      if (db.prepare("SELECT 1 FROM part p LEFT JOIN message m ON m.id=p.message_id WHERE p.session_id=? AND (m.id IS NULL OR m.session_id<>p.session_id) LIMIT 1").get(current.id))
        throw fail("format", "OpenCode part relationships are incomplete or inconsistent.")
      if (current.revert !== null) {
        if (!db.prepare("SELECT 1 FROM message WHERE session_id=? AND id=?").get(current.id, current.revert.messageID) ||
          current.revert.partID !== undefined && !db.prepare("SELECT 1 FROM part WHERE session_id=? AND message_id=? AND id=?").get(current.id, current.revert.messageID, current.revert.partID))
          throw fail("format", "OpenCode revert boundary cannot be resolved in this source view.")
      }
      const children = db.prepare("SELECT CASE WHEN length(cast(id as blob))<=500 THEN id END id FROM session WHERE parent_id=? LIMIT ?")
        .all(current.id, limits.threads - family.length + 1)
      if (children.length > limits.threads - family.length) throw fail("limit", "OpenCode family exceeds its Thread bound.")
      for (const id of children.map(child => identifier(child.id)).sort()) {
        if (visited.has(id)) throw fail("attribution", "OpenCode family contains a repeated Session identity.")
        visited.add(id); family.push(session(db, id))
      }
    }
    let threadIndex = 0, phase: Table = "session", messageId = "", messageTime = -1, partId = "", consumed = 0
    let pending: { record: OpenCodeSourceRecord; bytes: number } | undefined
    let failed = false, done = false
    const row = (table: Table, id: string): OpenCodeSourceRecord => {
      const columns = options.rawEnabled ? schema.columns[table] : [...required[table]]
      const sizeExpression = columns.map(column => `coalesce(length(cast(${quoted(column)} as blob)),0)`).join("+")
      const size = db.prepare(`SELECT ${sizeExpression} bytes FROM ${quoted(table)} WHERE id=?`).get(id)
      if (!size) throw fail("format", "OpenCode row disappeared inside its read view.")
      if (count(size.bytes) > limits.rowBytes) throw fail("limit", "OpenCode row exceeds its admitted byte bound.")
      if (table !== "session" && db.prepare(`SELECT CASE WHEN typeof(data)='text' AND json_valid(data) THEN json_type(data) END shape FROM ${quoted(table)} WHERE id=?`).get(id)?.shape !== "object")
        throw fail("format", "OpenCode JSON column is invalid.")
      const fields = table === "session" ? sessionColumns : "id,session_id,time_created,time_updated" + (table === "part" ? ",message_id" : "")
      const select = options.rawEnabled ? "*" : fields + (table === "session" ? "" : `,${table === "message" ? messageProjection : partProjection} projected`)
      const stored: Row = db.prepare(`SELECT ${select} FROM ${quoted(table)} WHERE id=?`).get(id)!
      const data = table === "session" ? { ...session(db, id) } :
        options.rawEnabled ? json(db.prepare(`SELECT ${table === "message" ? messageProjection : partProjection} projected FROM ${quoted(table)} WHERE id=?`).get(id)?.projected) : json(stored.projected)
      let raw: Record<string, string | number | null> | undefined
      if (options.rawEnabled) {
        raw = Object.create(null) as Record<string, string | number | null>
        for (const [key, value] of Object.entries(stored)) {
          if (value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))
            throw fail("unsupported", "OpenCode Raw row contains an unsupported SQLite value.")
          raw[key] = value as string | number | null
        }
      }
      return { table, id: identifier(stored.id), sessionId: table === "session" ? id : identifier(stored.session_id),
        ...(table === "part" ? { messageId: identifier(stored.message_id) } : {}), timeCreated: count(stored.time_created), timeUpdated: count(stored.time_updated),
        data, ...(raw === undefined ? {} : { raw }) }
    }
    const next = (): OpenCodeSourceRecord | undefined => {
      while (threadIndex < family.length) {
        check()
        const current = family[threadIndex]!
        if (phase === "session") { phase = "message"; return row("session", current.id) }
        if (phase === "part") {
          const part = db.prepare("SELECT CASE WHEN length(cast(id as blob))<=500 THEN id END id FROM part WHERE message_id=? AND id>? ORDER BY id LIMIT 1").get(messageId, partId)
          if (part) { partId = identifier(part.id); const result = row("part", partId)
            if (result.sessionId !== current.id) throw fail("format", "OpenCode part belongs to another Session.")
            return result }
          phase = "message"
        }
        const message = db.prepare("SELECT CASE WHEN length(cast(id as blob))<=500 THEN id END id,time_created FROM message WHERE session_id=? AND (time_created,id)>(?,?) ORDER BY time_created,id LIMIT 1")
          .get(current.id, messageTime, messageId)
        if (message) { messageId = identifier(message.id); messageTime = count(message.time_created); partId = ""; phase = "part"
          const result = row("message", messageId)
          if (result.sessionId !== current.id) throw fail("format", "OpenCode message belongs to another Session.")
          return result }
        threadIndex++; phase = "session"; messageId = ""; messageTime = -1
      }
      return undefined
    }
    return { root, threads: family, read: () => attempt(() => {
      check()
      if (failed) throw fail("closed", "A failed source view must be abandoned and reopened.")
      if (done) return { records: [], done: true }
      try {
        const records: OpenCodeSourceRecord[] = []
        let bytes = 2
        while (records.length < limits.pageRows) {
          if (!pending) {
            const record = next()
            if (!record) {
              if (consumed !== admitted) throw fail("format", "OpenCode traversal did not cover every admitted source row.")
              done = true; break
            }
            if (++consumed > limits.records) throw fail("limit", "OpenCode capture exceeds its record bound.")
            const size = Buffer.byteLength(JSON.stringify(record))
            if (size + 2 > limits.pageBytes) throw fail("limit", "Encoded OpenCode record exceeds the page byte bound.")
            pending = { record, bytes: size }
          }
          const separator = records.length === 0 ? 0 : 1
          if (pending.bytes + separator > limits.pageBytes - bytes) break
          records.push(pending.record); bytes += pending.bytes + separator; pending = undefined
        }
        check()
        return { records, done }
      } catch (cause) { failed = true; throw cause }
    }) }
  })
})
