import {
  CaptureJournal, CaptureJournalError, type CaptureScope, type CaptureOwner,
  type CaptureSeal, type CaptureSummary
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
  readonly limits: { readonly unitBytes: number; readonly targetBytes: number; readonly pendingBytes: number; readonly unitsPerTarget: number }
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
const SealSchema = Schema.Struct({ canonicalUnits: Schema.Number, rawUnits: Schema.Number,
  nextCheckpoint: Schema.String, manifestJson: Schema.String })
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const CaptureRow = Schema.Struct({ id: Schema.String, expected_checkpoint: Schema.NullOr(Schema.String), begin_json: Schema.String,
  raw_enabled: Schema.Literals([0, 1]), state: Schema.Literals(["preparing", "sealed", "activated", "completed", "abandoned"]),
  seal_json: Schema.NullOr(Schema.String), activation_receipt: Schema.NullOr(Schema.String), retained_bytes: Count,
  raw_cancel_reason: Schema.NullOr(Schema.String), rejection_receipt: Schema.NullOr(Schema.String) })
const ScopeRow = Schema.Struct({ epoch: Count, checkpoint: Schema.NullOr(Schema.String), origin_key: Schema.String })
const UnitRow = Schema.Struct({ ordinal: Count, byte_count: Count, digest: Schema.String,
  disposition: Schema.Literals(["pending", "acknowledged", "canceled"]), receipt_json: Schema.NullOr(Schema.String) })

const storageError = (cause: unknown): CaptureJournalError => {
  if (cause instanceof CaptureJournalError) return cause
  const code = (cause as { errcode?: number; code?: string })?.errcode
  return failure(code === 13 ? "capacity" : code === 11 || code === 26 ? "corrupt" : "io", "Capture journal storage operation failed.")
}

export const makeCaptureJournalLayer = (options: CaptureJournalOptions) => Layer.effect(CaptureJournal,
  Effect.acquireRelease(Effect.tryPromise({
    try: async () => {
      const { limits, binding } = options
      text(binding.instanceOrigin); text(binding.userId); text(binding.installationId)
      integer(limits.unitBytes, 1, 16 * 1024 * 1024)
      integer(limits.targetBytes, limits.unitBytes, Number.MAX_SAFE_INTEGER)
      integer(limits.pendingBytes, limits.targetBytes, Number.MAX_SAFE_INTEGER)
      integer(limits.unitsPerTarget, 1, 1_000_000)
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
        if (version?.user_version !== 1 && version?.user_version !== 2) throw failure("corrupt", "Capture journal format is unsupported or incomplete.")
        const stored = db.prepare("SELECT identity,retained_bytes FROM binding").all()
        if (stored.length !== 1 || stored[0]?.identity !== identity) throw failure("binding", "Capture journal belongs to a different account or installation.")
        // Upgrade only a verified binding. Concurrent openers serialize and recheck.
        db.exec("BEGIN IMMEDIATE")
        if (db.prepare("PRAGMA user_version").get()?.user_version === 1) {
          db.exec("CREATE INDEX pending_units ON units(scope_key,capture_id,kind,ordinal) WHERE disposition='pending'; PRAGMA user_version=2")
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
)

function implementation(db: DatabaseSync, options: CaptureJournalOptions): CaptureJournal["Service"] {
  const { limits } = options
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
    id: row.id, expectedCheckpoint: row.expected_checkpoint, beginJson: row.begin_json,
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
      update("INSERT INTO scopes VALUES(?,?,1,NULL)",key,scope.originKey)
      return { scope, epoch:1, checkpoint:null }
    }),
    reserve: (owner,input) => transaction(() => {
      const scope=ownerScope(owner); text(input.id); json(input.beginJson)
      if (input.expectedCheckpoint !== null) text(input.expectedCheckpoint,MetadataBytes)
      if (typeof input.rawEnabled !== "boolean") throw failure("invalid","Raw policy must be explicit.")
      const old=one("SELECT * FROM captures WHERE scope_key=? AND id=?",scope.key,input.id)
      if (old) {
        const previous=decode(CaptureRow,old)
        if (previous.expected_checkpoint !== input.expectedCheckpoint || previous.begin_json !== input.beginJson || previous.raw_enabled !== Number(input.rawEnabled))
          throw failure("conflict","Capture reservation identity was reused with different content.")
        return
      }
      if (scope.checkpoint !== input.expectedCheckpoint) throw failure("conflict","Source checkpoint advanced before reservation.")
      if (one("SELECT id FROM captures WHERE scope_key=? AND state IN ('preparing','sealed') LIMIT 1",scope.key))
        throw failure("conflict","Resolve the existing unactivated capture before reserving another.")
      update("INSERT INTO captures(scope_key,id,expected_checkpoint,begin_json,raw_enabled,state) VALUES(?,?,?,?,?,'preparing')",
        scope.key,input.id,input.expectedCheckpoint,input.beginJson,Number(input.rawEnabled))
    }),
    append: (owner,id,unit) => transaction(() => {
      const {key}=ownerScope(owner), row=capture(key,id)
      kind(unit.kind); integer(unit.ordinal,0,limits.unitsPerTarget-1)
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
      const counts=one("SELECT count(*) total,count(*) FILTER(WHERE kind=?) channel FROM units WHERE scope_key=? AND capture_id=?",unit.kind,key,id)!
      if (counts.channel !== unit.ordinal) throw failure("state","Prepared units must be appended contiguously.")
      const total=one("SELECT retained_bytes FROM binding")?.retained_bytes
      if (typeof total !== "number" || total<0 || !Number.isSafeInteger(total)) throw failure("corrupt","Journal byte accounting is invalid.")
      if (Number(counts.total)>=limits.unitsPerTarget || unit.bytes.byteLength>limits.targetBytes-row.retained_bytes || unit.bytes.byteLength>limits.pendingBytes-total)
        throw failure("capacity","Pending capture capacity is exhausted; unacknowledged content was retained.")
      update("INSERT INTO units(scope_key,capture_id,kind,ordinal,byte_count,digest,body) VALUES(?,?,?,?,?,?,?)",
        key,id,unit.kind,unit.ordinal,unit.bytes.byteLength,fingerprint,Buffer.from(unit.bytes))
      update("UPDATE captures SET retained_bytes=retained_bytes+? WHERE scope_key=? AND id=?",unit.bytes.byteLength,key,id)
      update("UPDATE binding SET retained_bytes=retained_bytes+?",unit.bytes.byteLength)
    }),
    seal: (owner,id,manifest) => transaction(() => {
      const {key}=ownerScope(owner), row=capture(key,id)
      integer(manifest.canonicalUnits,1,limits.unitsPerTarget); integer(manifest.rawUnits,0,limits.unitsPerTarget)
      text(manifest.nextCheckpoint,MetadataBytes); json(manifest.manifestJson)
      const encoded=JSON.stringify({canonicalUnits:manifest.canonicalUnits,rawUnits:manifest.rawUnits,nextCheckpoint:manifest.nextCheckpoint,manifestJson:manifest.manifestJson})
      if (row.seal_json !== null) {
        if (row.seal_json !== encoded) throw failure("conflict","Sealed manifest identity cannot change.")
        return
      }
      if (row.state !== "preparing") throw failure("state","Capture is not preparing.")
      const counts=one("SELECT count(*) FILTER(WHERE kind='canonical') canonical,count(*) FILTER(WHERE kind='raw') raw FROM units WHERE scope_key=? AND capture_id=?",key,id)!
      if (counts.canonical !== manifest.canonicalUnits || counts.raw !== manifest.rawUnits)
        throw failure("state","A capture cannot seal with missing or extra prepared units.")
      update("UPDATE captures SET state='sealed',seal_json=? WHERE scope_key=? AND id=?",encoded,key,id)
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
          update("UPDATE scopes SET checkpoint=? WHERE scope_key=?",manifest.nextCheckpoint,key)
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
