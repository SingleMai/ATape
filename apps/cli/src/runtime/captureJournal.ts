import {
  CaptureJournal, CaptureJournalError, type CaptureScope, type CaptureOwner,
  type CaptureSeal, type CaptureSummary, type CaptureRecordKind, type CaptureRecordVersion, type CaptureRecordInput, type CaptureRecordManifest, type CaptureRecordSummary, type CaptureJournalLimits
} from "@atape/application"
import { createHash } from "node:crypto"
import { lstat, mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Effect, Layer, Schema } from "effect"

export type CaptureJournalOptions = {
  readonly path: string
  /** Creation is an explicit bootstrap action. Opening never recreates lost state. */
  readonly mode: "create" | "open"
  readonly binding: { readonly instanceOrigin: string; readonly userId: string; readonly installationId: string }
  readonly limits: CaptureJournalLimits
}
const MetadataBytes = 32 * 1024
const failure = (reason: CaptureJournalError["reason"], message: string) => new CaptureJournalError({ reason, message })
const text = (value: unknown, maximum = 500): string => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maximum || value.includes("\0"))
    throw failure("invalid", "Journal text exceeds its declared bounds.")
  return value
}
const integer = (value: number, min: number, max: number) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw failure("invalid", "Journal count is outside its declared bounds.")
  return value
}
const json = (value: string) => {
  text(value, MetadataBytes)
  try { JSON.parse(value) } catch { throw failure("invalid", "Journal metadata must be JSON.") }
  return value
}
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const scopeKey = (scope: CaptureScope) => JSON.stringify([text(scope.projectId), text(scope.adapterId), text(scope.sourceSessionId)])
const RecordCounts = Schema.Struct({ session: Schema.Number, thread: Schema.Number, event: Schema.Number, usage: Schema.Number })
const RecordManifest = Schema.Struct({ canonical: Schema.optionalKey(RecordCounts),
  raw: Schema.optionalKey(Schema.Struct({ records: Schema.Number, scopeComplete: Schema.Boolean, admission: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))) })) })
const SealSchema = Schema.Struct({ records: Schema.optionalKey(RecordManifest), canonicalUnits: Schema.Number, rawUnits: Schema.Number,
  nextCheckpoint: Schema.String, manifestJson: Schema.String })
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const CaptureRow = Schema.Struct({ track_records: Schema.Literals([0, 1]), record_count: Count, purpose: Schema.Literals(["publication", "raw-observation"]), id: Schema.String, expected_checkpoint: Schema.NullOr(Schema.String), begin_json: Schema.String,
  raw_enabled: Schema.Literals([0, 1]), state: Schema.Literals(["preparing", "sealed", "activated", "completed", "abandoned"]),
  seal_json: Schema.NullOr(Schema.String), activation_receipt: Schema.NullOr(Schema.String), retained_bytes: Count,
  raw_cancel_reason: Schema.NullOr(Schema.String), rejection_receipt: Schema.NullOr(Schema.String) })
const ScopeRow = Schema.Struct({ records_initialized: Schema.Literals([0, 1]), canonical_coverage: Schema.NullOr(Schema.String),
  observed_canonical: Schema.NullOr(Schema.String), observed_raw: Schema.NullOr(Schema.String), epoch: Count, checkpoint: Schema.NullOr(Schema.String), origin_key: Schema.String })
const UnitDisposition = Schema.Literals(["pending", "acknowledged", "canceled"])
const UnitRow = Schema.Struct({ ordinal: Count, byte_count: Count, digest: Schema.String,
  disposition: UnitDisposition, receipt_json: Schema.NullOr(Schema.String) })

const RecordKind = Schema.Literals(["session", "thread", "event", "usage", "raw"])
const RecordRow = Schema.Struct({ kind: RecordKind, record_key: Schema.String, fingerprint: Schema.String, projection_version: Schema.String,
  revision: Count, raw_reference: Schema.NullOr(Schema.String), version_capture: Schema.String })
const RecordBindingRow = Schema.Struct({ unit_capture: Schema.NullOr(Schema.String), unit_kind: Schema.NullOr(Schema.String),
  unit_ordinal: Schema.NullOr(Count), unavailable_reason: Schema.NullOr(Schema.Literals(["limit", "redaction"])) })

const storageError = (cause: unknown): CaptureJournalError => {
  if (cause instanceof CaptureJournalError) return cause
  const code = (cause as { errcode?: number; code?: string })?.errcode
  return failure(code === 13 ? "capacity" : code === 11 || code === 26 ? "corrupt" : "io", "Capture journal storage operation failed.")
}

export const makeCaptureJournalLayer = (options: CaptureJournalOptions) => Layer.effect(CaptureJournal, openCaptureJournal(options))

export const openCaptureJournal = (options: CaptureJournalOptions) =>
  Effect.acquireRelease(Effect.tryPromise({
    try: async () => {
      const { limits, binding } = options
      text(binding.instanceOrigin); text(binding.userId); text(binding.installationId)
      integer(limits.unitBytes, 1, 16 * 1024 * 1024)
      integer(limits.targetBytes, limits.unitBytes, Number.MAX_SAFE_INTEGER)
      integer(limits.pendingBytes, limits.targetBytes, Number.MAX_SAFE_INTEGER)
      integer(limits.unitsPerTarget, 1, 1_000_000)
      integer(limits.metadataEntries, 1, 1_000_000)
      if (limits.recordsPerTarget !== undefined) integer(limits.recordsPerTarget, 1, 1_000_000)
      const identity = JSON.stringify([binding.instanceOrigin, binding.userId, binding.installationId])
      if (options.mode === "create") {
        await mkdir(dirname(options.path), { recursive: true, mode: 0o700 })
        const file = await open(options.path, "wx", 0o600).catch(cause => {
          if (cause.code === "EEXIST") throw failure("conflict", "Capture journal already exists; open its existing binding.")
          throw cause
        })
        await file.close()
      } else {
        const stat = await lstat(options.path).catch(cause => {
          if (cause.code === "ENOENT") throw failure("missing", "Capture journal is missing; recovery must not create a new one.")
          throw cause
        })
        if (!stat.isFile() || stat.isSymbolicLink()) throw failure("binding", "Capture journal must be an existing regular file.")
      }
      const db = new DatabaseSync(options.path)
      try {
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256")
        if (options.mode === "create") {
          db.exec(`BEGIN IMMEDIATE;
            CREATE TABLE binding(identity TEXT NOT NULL, retained_bytes INTEGER NOT NULL CHECK(retained_bytes>=0));
            CREATE TABLE scopes(scope_key TEXT PRIMARY KEY, origin_key TEXT NOT NULL, epoch INTEGER NOT NULL, checkpoint TEXT);
            CREATE TABLE captures(scope_key TEXT NOT NULL REFERENCES scopes, id TEXT NOT NULL,
              expected_checkpoint TEXT, begin_json TEXT NOT NULL, raw_enabled INTEGER NOT NULL,
              state TEXT NOT NULL, seal_json TEXT, activation_receipt TEXT, raw_cancel_reason TEXT, rejection_receipt TEXT, retained_bytes INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY(scope_key,id));
            CREATE TABLE units(scope_key TEXT NOT NULL, capture_id TEXT NOT NULL, kind TEXT NOT NULL, ordinal INTEGER NOT NULL,
              byte_count INTEGER NOT NULL, digest TEXT NOT NULL, body BLOB, disposition TEXT NOT NULL DEFAULT 'pending', receipt_json TEXT,
              PRIMARY KEY(scope_key,capture_id,kind,ordinal), FOREIGN KEY(scope_key,capture_id) REFERENCES captures(scope_key,id));
            CREATE INDEX live_captures ON captures(scope_key,id) WHERE state IN ('preparing','sealed','activated') OR retained_bytes>0;
            CREATE INDEX retained_unit_size ON units(byte_count) WHERE body IS NOT NULL;
            PRAGMA user_version=1;`)
          db.prepare("INSERT INTO binding VALUES(?,0)").run(identity)
          db.exec("COMMIT")
        }
        const version = db.prepare("PRAGMA user_version").get()
        if (version?.user_version !== 1 && version?.user_version !== 2 && version?.user_version !== 3 && version?.user_version !== 4 && version?.user_version !== 5 && version?.user_version !== 6) throw failure("corrupt", "Capture journal format is unsupported or incomplete.")
        const stored = db.prepare("SELECT identity,retained_bytes FROM binding").all()
        if (stored.length !== 1 || stored[0]?.identity !== identity) throw failure("binding", "Capture journal belongs to a different account or installation.")
        // Upgrade only a verified binding. Concurrent openers serialize and recheck.
        db.exec("BEGIN IMMEDIATE")
        if (db.prepare("PRAGMA user_version").get()?.user_version === 1) {
          db.exec("CREATE INDEX pending_units ON units(scope_key,capture_id,kind,ordinal) WHERE disposition='pending'; PRAGMA user_version=2")
        }
        if (db.prepare("PRAGMA user_version").get()?.user_version === 2) {
          db.exec("ALTER TABLE captures ADD COLUMN purpose TEXT NOT NULL DEFAULT 'publication' CHECK(purpose IN ('publication','raw-observation')); PRAGMA user_version=3")
        }
        if (db.prepare("PRAGMA user_version").get()?.user_version === 3) {
          db.exec(`ALTER TABLE captures ADD COLUMN track_records INTEGER NOT NULL DEFAULT 0 CHECK(track_records IN (0,1));
            ALTER TABLE captures ADD COLUMN record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count>=0);
            ALTER TABLE scopes ADD COLUMN records_initialized INTEGER NOT NULL DEFAULT 0 CHECK(records_initialized IN (0,1));
            ALTER TABLE scopes ADD COLUMN canonical_coverage TEXT;
            ALTER TABLE scopes ADD COLUMN observed_canonical TEXT;
            ALTER TABLE scopes ADD COLUMN observed_raw TEXT;
            CREATE TABLE source_record_versions(scope_key TEXT NOT NULL, kind TEXT NOT NULL, record_key TEXT NOT NULL,
              fingerprint TEXT NOT NULL, projection_version TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
              raw_reference TEXT, version_capture TEXT NOT NULL, comparison_capture TEXT,
              PRIMARY KEY(scope_key,kind,record_key), FOREIGN KEY(scope_key,version_capture) REFERENCES captures(scope_key,id));
            CREATE TABLE capture_records(scope_key TEXT NOT NULL, capture_id TEXT NOT NULL, kind TEXT NOT NULL, record_key TEXT NOT NULL,
              fingerprint TEXT NOT NULL, projection_version TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
              raw_reference TEXT, version_capture TEXT NOT NULL,
              unit_capture TEXT, unit_kind TEXT, unit_ordinal INTEGER, unavailable_reason TEXT CHECK(unavailable_reason IN ('limit','redaction')),
              PRIMARY KEY(scope_key,capture_id,kind,record_key), FOREIGN KEY(scope_key,capture_id) REFERENCES captures(scope_key,id),
              FOREIGN KEY(scope_key,unit_capture,unit_kind,unit_ordinal) REFERENCES units(scope_key,capture_id,kind,ordinal));
            CREATE INDEX unbound_capture_records ON capture_records(scope_key,capture_id) WHERE unit_capture IS NULL AND unavailable_reason IS NULL;
            CREATE INDEX known_source_scopes ON scopes(json_extract(scope_key,'$[0]'),json_extract(scope_key,'$[1]'),json_extract(scope_key,'$[2]'));
            PRAGMA user_version=4;`)
        }
        if (db.prepare("PRAGMA user_version").get()?.user_version === 4) {
          db.exec("CREATE UNIQUE INDEX unactivated_source_capture ON captures(scope_key) WHERE state IN ('preparing','sealed'); PRAGMA user_version=5")
        }
        if (db.prepare("PRAGMA user_version").get()?.user_version === 5) {
          const tables = ["scopes", "captures", "units", "source_record_versions", "capture_records"]
          db.exec("ALTER TABLE binding ADD COLUMN metadata_entries INTEGER NOT NULL DEFAULT 0 CHECK(metadata_entries >= 0 AND metadata_entries <= 9007199254740991)")
          db.exec(`UPDATE binding SET metadata_entries=${tables.map(table => `(SELECT count(*) FROM ${table})`).join("+")}`)
          for (const table of tables) db.exec(`
            CREATE TRIGGER metadata_${table}_insert AFTER INSERT ON ${table} BEGIN UPDATE binding SET metadata_entries=metadata_entries+1; END;
            CREATE TRIGGER metadata_${table}_delete AFTER DELETE ON ${table} BEGIN UPDATE binding SET metadata_entries=metadata_entries-1; END;`)
          db.exec("PRAGMA user_version=6")
        }
        db.exec("COMMIT")
        return db
      } catch (cause) {
        if (db.isTransaction) db.exec("ROLLBACK")
        db.close()
        throw cause
      }
    }, catch: storageError
  }), db => Effect.sync(() => db.close())).pipe(Effect.map(db => implementation(db, options)))
function implementation(db: DatabaseSync, options: CaptureJournalOptions): CaptureJournal["Service"] {
  const { limits } = options
  // Called only inside the existing write transaction, after idempotent replay
  // checks. No quota gate on settlement or body reclamation of admitted rows.
  const admitMetadata = (entries: number) => {
    const used = db.prepare("SELECT metadata_entries FROM binding").get()?.metadata_entries
    if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0)
      throw failure("corrupt", "Capture journal metadata accounting is invalid.")
    if (entries > limits.metadataEntries - used)
      throw failure("capacity", `Capture journal metadata admission exhausted: used ${used}, limit ${limits.metadataEntries}, required ${entries} new entries. Existing deliveries remain recoverable; increase metadataEntries to admit more history.`)
  }
  const one = (sql: string, ...parameters: SQLInputValue[]) => db.prepare(sql).get(...parameters)
  const update = (sql: string, ...parameters: SQLInputValue[]) => db.prepare(sql).run(...parameters)
  const transaction = <A>(work: () => A) => Effect.try({ try: () => {
    db.exec("BEGIN IMMEDIATE")
    try { const result = work(); db.exec("COMMIT"); return result }
    catch (cause) { db.exec("ROLLBACK"); throw cause }
  }, catch: storageError })
  const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A => {
    try { return Schema.decodeUnknownSync(schema)(value) }
    catch { throw failure("corrupt", "Capture journal metadata failed validation.") }
  }
  const ownerScope = (owner: CaptureOwner) => {
    const key = scopeKey(owner.scope), row = one("SELECT * FROM scopes WHERE scope_key=?",key)
    if (!row) throw failure("missing", "Capture scope does not exist.")
    const state = decode(ScopeRow,row)
    if (state.origin_key !== owner.scope.originKey) throw failure("binding", "Capture Origin binding changed.")
    if (state.epoch !== owner.epoch) throw failure("conflict", "Capture owner was superseded.")
    return { key, ...state }
  }
  const capture = (key: string, id: string) => {
    text(id)
    const row = one("SELECT * FROM captures WHERE scope_key=? AND id=?",key,id)
    if (!row) throw failure("missing", "Capture does not exist.")
    return decode(CaptureRow,row)
  }
  const parsedSeal = (value: string): CaptureSeal => {
    try { return decode(SealSchema,JSON.parse(value)) } catch { throw failure("corrupt","Capture seal failed validation.") }
  }
  const summary = (row: typeof CaptureRow.Type): CaptureSummary => ({
    trackRecords: row.track_records === 1, purpose: row.purpose, id: row.id, expectedCheckpoint: row.expected_checkpoint, beginJson: row.begin_json,
    rawEnabled: row.raw_enabled === 1, state: row.state, seal: row.seal_json === null ? null : parsedSeal(row.seal_json),
    activationReceipt: row.activation_receipt, retainedBytes: row.retained_bytes,
    rawCancelReason: row.raw_cancel_reason, rejectionReceipt: row.rejection_receipt
  })
  const complete = (key: string, id: string) => {
    update(`UPDATE captures SET state='completed' WHERE scope_key=? AND id=? AND activation_receipt IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM units WHERE scope_key=? AND capture_id=? AND kind='raw' AND disposition='pending')`,key,id,key,id)
  }
  const kind = (value: string) => {
    if (value !== "canonical" && value !== "raw") throw failure("invalid","Unknown capture unit kind.")
    return value
  }
  const recordKind = (value: CaptureRecordKind) => {
    if (!["session","thread","event","usage","raw"].includes(value)) throw failure("invalid","Unknown source record kind.")
    return value
  }
  const reference = (value: CaptureRecordInput["rawReference"]) => {
    if (value === undefined) return null
    if (value._tag === "unavailable") return JSON.stringify({ _tag: value._tag, reason: text(value.reason) })
    if (value._tag === "object") return JSON.stringify({ _tag: value._tag, sourceObjectId: text(value.sourceObjectId),
      ...(value.fragment === undefined ? {} : { fragment: text(value.fragment) }) })
    throw failure("invalid","Unknown Raw reference provenance.")
  }
  const recordVersion = (row: typeof RecordRow.Type): CaptureRecordVersion => {
    let rawReference: CaptureRecordInput["rawReference"]
    if (row.raw_reference !== null) {
      try { rawReference = JSON.parse(row.raw_reference); reference(rawReference) }
      catch { throw failure("corrupt","Stored record provenance is invalid.") }
    }
    return { kind: row.kind, key: row.record_key, fingerprint: row.fingerprint, projectionVersion: row.projection_version,
      revision: row.revision, ...(rawReference === undefined ? {} : { rawReference }) }
  }
  const getRecord = (key: string, id: string, kind: CaptureRecordKind, recordKey: string) => {
    recordKind(kind); text(recordKey)
    const row = one("SELECT * FROM capture_records WHERE scope_key=? AND capture_id=? AND kind=? AND record_key=?",key,id,kind,recordKey)
    if (!row) throw failure("missing","Captured source record does not exist.")
    return { ...decode(RecordRow,row), ...decode(RecordBindingRow,row) }
  }
  const recordSummary = (row: typeof CaptureRow.Type, value: unknown): CaptureRecordSummary => {
    const record = decode(RecordRow,value), binding = decode(RecordBindingRow,value)
    const disposition = row.state === "abandoned" ? "abandoned" : binding.unavailable_reason !== null ? "unavailable" :
      binding.unit_capture === null ? "unbound" : record.kind !== "raw" ? row.activation_receipt === null ? "pending" : "published" :
      decode(UnitDisposition,(value as { disposition: unknown }).disposition)
    return { ...recordVersion(record), disposition, unavailableReason:binding.unavailable_reason,
      unit:binding.unit_capture === null ? null : {captureId:binding.unit_capture,ordinal:binding.unit_ordinal!} }
  }
  const recordManifest = (key: string, id: string, row: typeof CaptureRow.Type, value: CaptureRecordManifest | undefined) => {
    if (row.track_records === 0) {
      if (value !== undefined) throw failure("state","An untracked capture cannot assert record coverage.")
      return undefined
    }
    if (value === undefined || limits.recordsPerTarget === undefined) throw failure("state","Tracked capture requires an explicit complete record manifest.")
    const result = decode(RecordManifest,value)
    if (row.purpose === "publication" && result.canonical === undefined || row.purpose === "raw-observation" && result.canonical !== undefined)
      throw failure("state","Record manifest does not match capture purpose.")
    if (result.raw !== undefined && row.raw_enabled !== 1 || row.purpose === "raw-observation" && result.raw === undefined)
      throw failure("state","Raw record manifest does not match capture policy.")
    const counts = new Map(db.prepare("SELECT kind,count(*) total FROM capture_records WHERE scope_key=? AND capture_id=? GROUP BY kind").all(key,id)
      .map(entry => [String(entry.kind), Number(entry.total)]))
    for (const kind of ["session","thread","event","usage"] as const) {
      const expected = result.canonical?.[kind] ?? 0
      integer(expected,0,limits.recordsPerTarget)
      if (expected !== (counts.get(kind) ?? 0)) throw failure("state","Source record manifest is incomplete.")
    }
    if (result.canonical !== undefined && (result.canonical.session !== 1 || result.canonical.thread < 1))
      throw failure("state","A Canonical source manifest requires one Session and its Thread topology.")
    const rawCount = result.raw?.records ?? 0
    integer(rawCount,0,limits.recordsPerTarget)
    if (row.purpose === "raw-observation" && rawCount === 0 && !result.raw?.scopeComplete)
      throw failure("state","An empty Raw observation must prove a complete source comparison.")
    if (rawCount !== (counts.get("raw") ?? 0)) throw failure("state","Raw record manifest is incomplete.")
    if (one("SELECT record_key FROM capture_records WHERE scope_key=? AND capture_id=? AND unit_capture IS NULL AND unavailable_reason IS NULL LIMIT 1",key,id))
      throw failure("state","Every observed record needs frozen content or an explicit Raw gap.")
    return result
  }
  return {
    binding: Object.freeze({ ...options.binding }),
    claim: scope => transaction(() => {
      const key=scopeKey(scope); text(scope.originKey)
      const row=one("SELECT * FROM scopes WHERE scope_key=?",key)
      if (row) {
        const old=decode(ScopeRow,row)
        if (old.origin_key !== scope.originKey) throw failure("binding","A source cannot change its immutable Origin binding.")
        integer(old.epoch+1,1,Number.MAX_SAFE_INTEGER)
        update("UPDATE scopes SET epoch=epoch+1 WHERE scope_key=?",key)
        return { scope, epoch:old.epoch+1, checkpoint:old.checkpoint }
      }
      admitMetadata(1)
      update("INSERT INTO scopes(scope_key,origin_key,epoch,checkpoint) VALUES(?,?,1,NULL)",key,scope.originKey)
      return { scope, epoch:1, checkpoint:null }
    }),
    sources: (projectId,adapterId,page) => transaction(() => {
      text(projectId); text(adapterId); integer(page.limit ?? 20,1,100)
      if (page.afterSessionId !== undefined) text(page.afterSessionId)
      return db.prepare("SELECT scope_key,origin_key FROM scopes WHERE json_extract(scope_key,'$[0]')=? AND json_extract(scope_key,'$[1]')=? AND json_extract(scope_key,'$[2]')>? ORDER BY json_extract(scope_key,'$[2]') LIMIT ?")
        .all(projectId,adapterId,page.afterSessionId ?? "",page.limit ?? 20).map(row => {
          const identity: unknown = JSON.parse(String(row.scope_key))
          if (!Array.isArray(identity) || identity.length !== 3) throw failure("corrupt","Stored source identity is invalid.")
          return { projectId: text(identity[0]), adapterId: text(identity[1]), sourceSessionId: text(identity[2]), originKey: text(row.origin_key) }
        })
    }),
    reserve: (owner,input) => transaction(() => {
      const scope=ownerScope(owner); text(input.id); json(input.beginJson)
      if (input.expectedCheckpoint !== null) text(input.expectedCheckpoint,MetadataBytes)
      if (typeof input.rawEnabled !== "boolean") throw failure("invalid","Raw policy must be explicit.")
      const purpose = input.purpose ?? "publication"
      if (purpose !== "publication" && purpose !== "raw-observation") throw failure("invalid","Unknown capture purpose.")
      if (purpose === "raw-observation" && (!input.rawEnabled || input.expectedCheckpoint === null))
        throw failure("state","A Raw observation requires Raw permission and existing Canonical coverage.")
      const track = input.trackRecords ?? false
      if (typeof track !== "boolean") throw failure("invalid","Source tracking must be explicit.")
      if (track && limits.recordsPerTarget === undefined) throw failure("capacity","Source record admission is not configured.")
      const old=one("SELECT * FROM captures WHERE scope_key=? AND id=?",scope.key,input.id)
      if (old) {
        const previous=decode(CaptureRow,old)
        if (previous.track_records !== Number(track) || previous.purpose !== purpose || previous.expected_checkpoint !== input.expectedCheckpoint || previous.begin_json !== input.beginJson || previous.raw_enabled !== Number(input.rawEnabled))
          throw failure("conflict","Capture reservation identity was reused with different content.")
        return
      }
      if (scope.checkpoint !== input.expectedCheckpoint) throw failure("conflict","Source checkpoint advanced before reservation.")
      if (track && scope.records_initialized === 0 && scope.checkpoint !== null)
        throw failure("state","Existing untracked coverage cannot silently initialize source versions.")
      if (!track && purpose === "publication" && scope.records_initialized === 1)
        throw failure("state","A tracked source cannot publish without its record manifest.")
      if (track) update("UPDATE scopes SET records_initialized=1 WHERE scope_key=?",scope.key)
      if (one("SELECT id FROM captures WHERE scope_key=? AND state IN ('preparing','sealed') LIMIT 1",scope.key))
        throw failure("conflict","Resolve the existing unactivated capture before reserving another.")
      admitMetadata(1)
      update("INSERT INTO captures(scope_key,id,expected_checkpoint,begin_json,raw_enabled,state,purpose,track_records) VALUES(?,?,?,?,?,'preparing',?,?)",
        scope.key,input.id,input.expectedCheckpoint,input.beginJson,Number(input.rawEnabled),purpose,Number(track))
    }),
    append: (owner,id,unit) => transaction(() => {
      const {key}=ownerScope(owner), row=capture(key,id)
      kind(unit.kind); integer(unit.ordinal,0,limits.unitsPerTarget-1)
      if (row.purpose === "raw-observation" && unit.kind !== "raw") throw failure("state","Raw observations cannot contain Canonical units.")
      if (!(unit.bytes instanceof Uint8Array)) throw failure("invalid","Prepared content must be bytes.")
      integer(unit.bytes.byteLength,1,limits.unitBytes)
      if (unit.kind === "raw" && row.raw_enabled !== 1) throw failure("state","Raw was disabled for this capture.")
      const fingerprint=digest(unit.bytes)
      const old=one("SELECT ordinal,byte_count,digest,disposition,receipt_json FROM units WHERE scope_key=? AND capture_id=? AND kind=? AND ordinal=?",key,id,unit.kind,unit.ordinal)
      if (old) {
        const previous=decode(UnitRow,old)
        if (previous.digest !== fingerprint || previous.byte_count !== unit.bytes.byteLength)
          throw failure("conflict","Prepared unit identity cannot be replaced with different bytes.")
        return
      }
      if (row.state !== "preparing") throw failure("state","A sealed capture cannot acquire new content.")
      if (unit.kind === "raw" && row.raw_cancel_reason !== null) throw failure("state","Raw was canceled for this capture.")
      const last = (channel: string) => Number(one("SELECT ordinal FROM units WHERE scope_key=? AND capture_id=? AND kind=? ORDER BY ordinal DESC LIMIT 1",key,id,channel)?.ordinal ?? -1) + 1
      const canonicalCount = last("canonical"), rawCount = last("raw")
      const counts = { total: canonicalCount + rawCount, channel: unit.kind === "canonical" ? canonicalCount : rawCount }
      if (counts.channel !== unit.ordinal) throw failure("state","Prepared units must be appended contiguously.")
      const total=one("SELECT retained_bytes FROM binding")?.retained_bytes
      if (typeof total !== "number" || total<0 || !Number.isSafeInteger(total)) throw failure("corrupt","Journal byte accounting is invalid.")
      if (Number(counts.total)>=limits.unitsPerTarget || unit.bytes.byteLength>limits.targetBytes-row.retained_bytes || unit.bytes.byteLength>limits.pendingBytes-total)
        throw failure("capacity","Pending capture capacity is exhausted; unacknowledged content was retained.")
      admitMetadata(1)
      update("INSERT INTO units(scope_key,capture_id,kind,ordinal,byte_count,digest,body) VALUES(?,?,?,?,?,?,?)",
        key,id,unit.kind,unit.ordinal,unit.bytes.byteLength,fingerprint,Buffer.from(unit.bytes))
      update("UPDATE captures SET retained_bytes=retained_bytes+? WHERE scope_key=? AND id=?",unit.bytes.byteLength,key,id)
      update("UPDATE binding SET retained_bytes=retained_bytes+?",unit.bytes.byteLength)
    }),
    record: (owner,id,input) => transaction(() => {
      const scope = ownerScope(owner), row = capture(scope.key,id), kind = recordKind(input.kind)
      text(input.key); text(input.projectionVersion)
      if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw failure("invalid","A source fingerprint must be SHA-256 metadata.")
      const proposedReference = reference(input.rawReference)
      if ((kind === "event") !== (proposedReference !== null)) throw failure("invalid","Only Events carry required Raw reference provenance.")
      if (row.track_records !== 1 || limits.recordsPerTarget === undefined) throw failure("state","Capture is not tracking source records.")
      if (row.purpose === "raw-observation" && kind !== "raw" || kind === "raw" && row.raw_enabled !== 1)
        throw failure("state","Record observation is outside this capture purpose or Raw policy.")
      const existing = one("SELECT * FROM capture_records WHERE scope_key=? AND capture_id=? AND kind=? AND record_key=?",scope.key,id,kind,input.key)
      if (existing) {
        const previous = decode(RecordRow,existing)
        if (previous.fingerprint !== input.fingerprint || previous.projection_version !== input.projectionVersion)
          throw failure("conflict","A capture cannot stitch different source observations under one record identity.")
        return recordVersion(previous)
      }
      if (row.state !== "preparing") throw failure("state","Source observations require an unsealed capture.")
      if (row.record_count >= limits.recordsPerTarget) throw failure("capacity","Source record capacity is exhausted.")
      const old = one("SELECT * FROM source_record_versions WHERE scope_key=? AND kind=? AND record_key=?",scope.key,kind,input.key)
      admitMetadata(old === undefined ? 2 : 1)
      const previous = old === undefined ? undefined : decode(RecordRow,old)
      const lastComplete = kind === "raw" ? scope.observed_raw : scope.observed_canonical
      const comparison = old === undefined ? null : decode(Schema.Struct({ comparison_capture: Schema.NullOr(Schema.String) }),old).comparison_capture
      const wasAbsent = lastComplete !== null && lastComplete !== comparison && !one("SELECT 1 FROM capture_records WHERE scope_key=? AND capture_id=? AND kind=? AND record_key=?",scope.key,lastComplete,kind,input.key)
      const orphanedReference = previous?.raw_reference !== null && previous?.raw_reference !== undefined &&
        recordVersion(previous).rawReference?._tag === "object" && capture(scope.key,previous.version_capture).activation_receipt === null
      const changed = previous === undefined || previous.fingerprint !== input.fingerprint || previous.projection_version !== input.projectionVersion || wasAbsent || orphanedReference
      const revision = changed ? integer((previous?.revision ?? 0)+1,1,Number.MAX_SAFE_INTEGER) : previous.revision
      const actualReference = changed ? proposedReference : previous.raw_reference
      if (changed && row.raw_enabled !== 1 && input.rawReference?._tag === "object")
        throw failure("state","A new Raw-off Event version cannot acquire a Raw object reference.")
      const versionCapture = changed ? id : previous.version_capture
      if (changed) update(`INSERT INTO source_record_versions(scope_key,kind,record_key,fingerprint,projection_version,revision,raw_reference,version_capture,comparison_capture)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,kind,record_key) DO UPDATE SET fingerprint=excluded.fingerprint,projection_version=excluded.projection_version,
        revision=excluded.revision,raw_reference=excluded.raw_reference,version_capture=excluded.version_capture,comparison_capture=excluded.comparison_capture`,scope.key,kind,input.key,input.fingerprint,input.projectionVersion,revision,actualReference,versionCapture,lastComplete)
      update("INSERT INTO capture_records(scope_key,capture_id,kind,record_key,fingerprint,projection_version,revision,raw_reference,version_capture) VALUES(?,?,?,?,?,?,?,?,?)",
        scope.key,id,kind,input.key,input.fingerprint,input.projectionVersion,revision,actualReference,versionCapture)
      update("UPDATE captures SET record_count=record_count+1 WHERE scope_key=? AND id=?",scope.key,id)
      return recordVersion({ kind,record_key:input.key,fingerprint:input.fingerprint,projection_version:input.projectionVersion,
        revision,raw_reference:actualReference,version_capture:versionCapture })
    }),
    bindRecord: (owner,id,identity,binding) => transaction(() => {
      const {key} = ownerScope(owner), row = capture(key,id), record = getRecord(key,id,identity.kind,identity.key)
      let unitCapture: string | null = null, unitOrdinal: number | null = null, unitKind: string | null = null, unavailable: string | null = null
      if (binding._tag === "Unavailable") {
        if (identity.kind !== "raw" || !["limit","redaction"].includes(binding.reason)) throw failure("invalid","Only Raw can declare an explicit record gap.")
        unavailable = binding.reason
      } else if (binding._tag === "Unit") {
        integer(binding.ordinal,0,1_000_000); unitCapture = binding.captureId ?? id; unitOrdinal = binding.ordinal
        unitKind = identity.kind === "raw" ? "raw" : "canonical"
        if (unitCapture !== id) {
          if (identity.kind !== "raw") throw failure("state","Canonical replacement requires its own frozen units.")
          const previous = getRecord(key,unitCapture,"raw",identity.key)
          if (previous.revision !== record.revision || previous.fingerprint !== record.fingerprint || previous.projection_version !== record.projection_version ||
            previous.unit_capture === null || previous.unit_ordinal !== binding.ordinal || capture(key,unitCapture).activation_receipt === null)
            throw failure("conflict","Raw reuse requires the same observed version and an activated owning capture.")
          unitCapture = previous.unit_capture; unitOrdinal = previous.unit_ordinal
        }
        const unit = one("SELECT disposition,body IS NOT NULL AS retained FROM units WHERE scope_key=? AND capture_id=? AND kind=? AND ordinal=?",key,unitCapture,unitKind,unitOrdinal)
        if (!unit) throw failure("missing","The record's prepared unit does not exist.")
        if (unitCapture !== id && (capture(key,unitCapture).activation_receipt === null || unit.disposition === "canceled" || unit.disposition === "pending" && unit.retained !== 1))
          throw failure("state","Raw reuse cannot reconstruct canceled or missing content.")
      } else throw failure("invalid","Unknown record binding.")
      if (record.unit_capture !== null || record.unavailable_reason !== null) {
        if (record.unit_capture !== unitCapture || record.unit_ordinal !== unitOrdinal || record.unit_kind !== unitKind || record.unavailable_reason !== unavailable)
          throw failure("conflict","Source record binding is immutable.")
        return
      }
      if (row.state !== "preparing") throw failure("state","Only an unsealed record can acquire content.")
      update("UPDATE capture_records SET unit_capture=?,unit_kind=?,unit_ordinal=?,unavailable_reason=? WHERE scope_key=? AND capture_id=? AND kind=? AND record_key=?",
        unitCapture,unitKind,unitOrdinal,unavailable,key,id,identity.kind,identity.key)
    }),
    recordStatus: (owner,id,identity) => transaction(() => {
      const {key} = ownerScope(owner), row = capture(key,id)
      recordKind(identity.kind); text(identity.key)
      const value = one(`SELECT r.*,u.disposition FROM capture_records r LEFT JOIN units u
        ON u.scope_key=r.scope_key AND u.capture_id=r.unit_capture AND u.kind=r.unit_kind AND u.ordinal=r.unit_ordinal
        WHERE r.scope_key=? AND r.capture_id=? AND r.kind=? AND r.record_key=?`,key,id,identity.kind,identity.key)
      return value === undefined ? null : recordSummary(row,value)
    }),
    records: (owner,id,page) => transaction(() => {
      const {key} = ownerScope(owner), row = capture(key,id)
      recordKind(page.kind); integer(page.limit ?? 32,1,100)
      if (page.afterKey !== undefined) text(page.afterKey)
      return db.prepare(`SELECT r.*,u.disposition FROM capture_records r LEFT JOIN units u
        ON u.scope_key=r.scope_key AND u.capture_id=r.unit_capture AND u.kind=r.unit_kind AND u.ordinal=r.unit_ordinal
        WHERE r.scope_key=? AND r.capture_id=? AND r.kind=? AND r.record_key>? ORDER BY r.record_key LIMIT ?`)
        .all(key,id,page.kind,page.afterKey ?? "",page.limit ?? 32).map(value => recordSummary(row,value))
    }),
    coverage: owner => transaction(() => {
      const scope = ownerScope(owner)
      return {canonicalCaptureId:scope.canonical_coverage,observedCanonicalCaptureId:scope.observed_canonical,observedRawCaptureId:scope.observed_raw}
    }),
    seal: (owner,id,manifest) => transaction(() => {
      const {key}=ownerScope(owner), row=capture(key,id)
      integer(manifest.canonicalUnits,row.purpose === "publication" ? 1 : 0,row.purpose === "publication" ? limits.unitsPerTarget : 0)
      integer(manifest.rawUnits,row.purpose === "raw-observation" && row.track_records === 0 ? 1 : 0,limits.unitsPerTarget)
      if (row.purpose === "raw-observation" && manifest.nextCheckpoint !== row.expected_checkpoint)
        throw failure("state","A Raw observation cannot change Canonical coverage.")
      text(manifest.nextCheckpoint,MetadataBytes); json(manifest.manifestJson)
      const records = recordManifest(key,id,row,manifest.records)
      const encoded=JSON.stringify({canonicalUnits:manifest.canonicalUnits,rawUnits:manifest.rawUnits,nextCheckpoint:manifest.nextCheckpoint,manifestJson:manifest.manifestJson,
        ...(records === undefined ? {} : { records })})
      if (row.seal_json !== null) {
        if (row.seal_json !== encoded) throw failure("conflict","Sealed manifest identity cannot change.")
        return
      }
      if (row.state !== "preparing") throw failure("state","Capture is not preparing.")
      const counts=one("SELECT count(*) FILTER(WHERE kind='canonical') canonical,count(*) FILTER(WHERE kind='raw') raw FROM units WHERE scope_key=? AND capture_id=?",key,id)!
      if (counts.canonical !== manifest.canonicalUnits || counts.raw !== manifest.rawUnits)
        throw failure("state","A capture cannot seal with missing or extra prepared units.")
      update("UPDATE captures SET state='sealed',seal_json=? WHERE scope_key=? AND id=?",encoded,key,id)
      if (records?.canonical !== undefined) update("UPDATE scopes SET observed_canonical=? WHERE scope_key=?",id,key)
      if (records?.raw?.scopeComplete) update("UPDATE scopes SET observed_raw=? WHERE scope_key=?",id,key)
    }),
    unactivated: (owner) => transaction(() => {
      const {key} = ownerScope(owner)
      const row = one("SELECT * FROM captures WHERE scope_key=? AND state IN ('preparing','sealed') LIMIT 1",key)
      return row === undefined ? null : summary(decode(CaptureRow,row))
    }),
    pending: (owner,afterId,limit=20) => transaction(() => {
      const {key}=ownerScope(owner); integer(limit,1,100)
      if (afterId !== undefined) text(afterId)
      return db.prepare("SELECT * FROM captures WHERE scope_key=? AND id>? AND (state IN ('preparing','sealed','activated') OR retained_bytes>0) ORDER BY id LIMIT ?")
        .all(key,afterId ?? "",limit).map(row=>summary(decode(CaptureRow,row)))
    }),
    inspect: (owner,id,page) => transaction(() => {
      const {key}=ownerScope(owner), row=capture(key,id)
      kind(page.kind); integer(page.afterOrdinal ?? -1,-1,1_000_000); integer(page.limit ?? 32,1,100)
      const units=db.prepare(`SELECT ordinal,byte_count,digest,disposition,receipt_json,body IS NOT NULL AS retained
        FROM units WHERE scope_key=? AND capture_id=? AND kind=? AND ordinal>? ${page.pendingOnly ? "AND disposition='pending'" : ""} ORDER BY ordinal LIMIT ?`)
        .all(key,id,page.kind,page.afterOrdinal ?? -1,page.limit ?? 32)
        .map(record => {
          const unit=decode(UnitRow,record)
          return {ordinal:unit.ordinal,byteCount:unit.byte_count,digest:unit.digest,
            disposition:unit.disposition,receiptJson:unit.receipt_json,retained:record.retained === 1}
        })
      return { capture:summary(row), units }
    }),
    read: (owner,id,channel,ordinal) => transaction(() => {
      const {key}=ownerScope(owner), row=capture(key,id); kind(channel); integer(ordinal,0,1_000_000)
      if (row.state !== "sealed" && row.state !== "activated") throw failure("state","Capture content is not available for delivery.")
      if (channel === "raw" && row.activation_receipt === null) throw failure("state","Raw delivery requires actual activation.")
      const record=one("SELECT ordinal,byte_count,digest,disposition,receipt_json FROM units WHERE scope_key=? AND capture_id=? AND kind=? AND ordinal=?",key,id,channel,ordinal)
      if (!record) throw failure("missing","Prepared unit does not exist.")
      const unit=decode(UnitRow,record)
      if (channel === "raw" && unit.disposition !== "pending") throw failure("state","Raw obligation has already ended.")
      if (!Number.isSafeInteger(unit.byte_count) || unit.byte_count<1 || unit.byte_count>limits.unitBytes)
        throw failure("capacity","Prepared unit exceeds the current read budget.")
      const body=one("SELECT body FROM units WHERE scope_key=? AND capture_id=? AND kind=? AND ordinal=?",key,id,channel,ordinal)?.body
      if (body === null) throw failure("state","Resolved content was reclaimed.")
      if (!(body instanceof Uint8Array) || body.byteLength !== unit.byte_count || digest(body) !== unit.digest)
        throw failure("corrupt","Prepared content failed its length or digest check.")
      return new Uint8Array(body)
    }),
    settle: (owner,id,settlement) => transaction(() => {
      const scope=ownerScope(owner), {key}=scope, row=capture(key,id)
      switch (settlement._tag) {
        case "CanonicalAcknowledged": {
          json(settlement.receiptJson); integer(settlement.ordinal,0,1_000_000)
          const found=one("SELECT ordinal,byte_count,digest,disposition,receipt_json FROM units WHERE scope_key=? AND capture_id=? AND kind='canonical' AND ordinal=?",key,id,settlement.ordinal)
          if (!found) throw failure("missing","Canonical unit does not exist.")
          const unit=decode(UnitRow,found)
          if (unit.receipt_json !== null) {
            if (unit.receipt_json !== settlement.receiptJson) throw failure("conflict","Canonical receipt identity changed.")
            return
          }
          if (row.state !== "sealed") throw failure("state","Canonical receipts require a sealed pending capture.")
          update("UPDATE units SET disposition='acknowledged',receipt_json=? WHERE scope_key=? AND capture_id=? AND kind='canonical' AND ordinal=?",settlement.receiptJson,key,id,settlement.ordinal)
          return
        }
        case "Activated": {
          json(settlement.receiptJson)
          if (row.activation_receipt !== null) {
            if (row.activation_receipt !== settlement.receiptJson) throw failure("conflict","Activation receipt identity changed.")
            return // Never restore an old checkpoint when replaying a known activation.
          }
          if (row.state !== "sealed" || row.seal_json === null) throw failure("state","Only a sealed capture can activate.")
          if (scope.checkpoint !== row.expected_checkpoint) throw failure("conflict","Source checkpoint changed before activation.")
          const manifest=parsedSeal(row.seal_json)
          update("UPDATE captures SET state='activated',activation_receipt=? WHERE scope_key=? AND id=?",settlement.receiptJson,key,id)
          if (row.purpose === "publication") {
            update("UPDATE scopes SET checkpoint=? WHERE scope_key=?",manifest.nextCheckpoint,key)
            if (row.track_records === 1) update("UPDATE scopes SET canonical_coverage=? WHERE scope_key=?",id,key)
          }
          complete(key,id)
          return
        }
        case "RawAcknowledged": {
          json(settlement.receiptJson); integer(settlement.ordinal,0,1_000_000)
          if (row.activation_receipt === null) throw failure("state","Raw receipts require an activated capture.")
          const found=one("SELECT ordinal,byte_count,digest,disposition,receipt_json FROM units WHERE scope_key=? AND capture_id=? AND kind='raw' AND ordinal=?",key,id,settlement.ordinal)
          if (!found) throw failure("missing","Raw unit does not exist.")
          const unit=decode(UnitRow,found)
          if (unit.receipt_json !== null && unit.receipt_json !== settlement.receiptJson) throw failure("conflict","Raw receipt identity changed.")
          update("UPDATE units SET disposition='acknowledged',receipt_json=? WHERE scope_key=? AND capture_id=? AND kind='raw' AND ordinal=?",settlement.receiptJson,key,id,settlement.ordinal)
          complete(key,id)
          return
        }
        case "RawUnitCanceled": {
          integer(settlement.ordinal,0,1_000_000)
          if (row.activation_receipt === null || row.raw_cancel_reason === null)
            throw failure("state","Per-unit cancellation requires activation and a durable cancellation intent.")
          const found=one("SELECT disposition FROM units WHERE scope_key=? AND capture_id=? AND kind='raw' AND ordinal=?",key,id,settlement.ordinal)
          if (!found) throw failure("missing","Raw unit does not exist.")
          // An actual receipt always wins over cancellation, including retries.
          update("UPDATE units SET disposition='canceled' WHERE scope_key=? AND capture_id=? AND kind='raw' AND ordinal=? AND disposition='pending'",key,id,settlement.ordinal)
          complete(key,id)
          return
        }
        case "RawCancellationStarted":
        case "RawCanceled": {
          text(settlement.reason,MetadataBytes)
          update("UPDATE captures SET raw_cancel_reason=COALESCE(raw_cancel_reason,?) WHERE scope_key=? AND id=?",settlement.reason,key,id)
          if (settlement._tag === "RawCanceled") update("UPDATE units SET disposition='canceled' WHERE scope_key=? AND capture_id=? AND kind='raw' AND disposition='pending'",key,id)
          complete(key,id)
          return
        }
        case "Rejected": {
          json(settlement.receiptJson)
          if (row.rejection_receipt !== null) {
            if (row.rejection_receipt !== settlement.receiptJson) throw failure("conflict","Rejection receipt identity changed.")
            return
          }
          if (row.state !== "sealed") throw failure("state","Only a sealed, unactivated capture can be rejected.")
          update("UPDATE captures SET state='abandoned',rejection_receipt=? WHERE scope_key=? AND id=?",settlement.receiptJson,key,id)
          return
        }
        case "AbandonUnsealed": {
          if (row.state === "abandoned") return
          if (row.state !== "preparing") throw failure("state","Only an unsealed source view can be abandoned locally.")
          update("UPDATE captures SET state='abandoned' WHERE scope_key=? AND id=?",key,id)
          return
        }
      }
    }),
    reclaim: (owner,id,limit=32) => transaction(() => {
      const {key}=ownerScope(owner), row=capture(key,id); integer(limit,1,32)
      const eligible=db.prepare(`SELECT kind,ordinal,byte_count FROM units WHERE scope_key=? AND capture_id=? AND body IS NOT NULL
        AND (?='abandoned' OR (kind='canonical' AND ? IS NOT NULL) OR (kind='raw' AND disposition!='pending'))
        ORDER BY kind,ordinal LIMIT ?`).all(key,id,row.state,row.activation_receipt,limit)
      let removed=0
      for (const unit of eligible) {
        if (typeof unit.byte_count !== "number" || !Number.isSafeInteger(unit.byte_count) || unit.byte_count<1)
          throw failure("corrupt","Reclamation byte accounting is invalid.")
        update("UPDATE units SET body=NULL WHERE scope_key=? AND capture_id=? AND kind=? AND ordinal=?",key,id,unit.kind!,unit.ordinal!)
        removed+=unit.byte_count
      }
      if (removed>row.retained_bytes) throw failure("corrupt","Reclamation exceeds retained capture bytes.")
      update("UPDATE captures SET retained_bytes=retained_bytes-? WHERE scope_key=? AND id=?",removed,key,id)
      update("UPDATE binding SET retained_bytes=retained_bytes-?",removed)
      return eligible.length
    })
  }
}
