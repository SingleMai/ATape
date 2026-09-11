import { Context, Effect, Schema, Scope } from "effect"
import type { AdapterRawReference } from "@atape/domain"

/** Private local storage for already validated, redacted, final delivery bytes.
 * The publication workflow owns remote authority and receipt verification.
 * This Interface never reads a provider or transmits content.
 */
export type CaptureScope = {
  readonly projectId: string
  readonly adapterId: string
  readonly sourceSessionId: string
  readonly originKey: string
}
export type CaptureOwner = { readonly scope: CaptureScope; readonly epoch: number }
export type CaptureBinding = { readonly instanceOrigin: string; readonly userId: string; readonly installationId: string }
export type CaptureJournalLimits = {
  readonly unitBytes: number; readonly targetBytes: number; readonly pendingBytes: number
  readonly unitsPerTarget: number; readonly recordsPerTarget?: number
  /** Account-wide retained metadata rows; exhausted admission never blocks existing recovery. */
  readonly metadataEntries: number
}
export type CaptureClaim = CaptureOwner & { readonly checkpoint: string | null }
export type CaptureUnitKind = "canonical" | "raw"
export type CapturePurpose = "publication" | "raw-observation"
export type CaptureRecordKind = "session" | "thread" | "event" | "usage" | "raw"
export type CaptureRecordKey = { readonly kind: CaptureRecordKind; readonly key: string }
export type CaptureRecordInput = CaptureRecordKey & {
  readonly fingerprint: string
  readonly projectionVersion: string
  /** Proposed immutable Event provenance, adopted only with a new version. */
  readonly rawReference?: AdapterRawReference
}
export type CaptureRecordVersion = CaptureRecordInput & { readonly revision: number }
export type CaptureRecordBinding =
  | { readonly _tag: "Unit"; readonly ordinal: number; readonly captureId?: string }
  | { readonly _tag: "Unavailable"; readonly reason: "limit" | "redaction" }
export type CaptureRecordManifest = {
  readonly canonical?: { readonly session: number; readonly thread: number; readonly event: number; readonly usage: number }
  readonly raw?: { readonly records: number; readonly scopeComplete: boolean; readonly admission?: string }
}
export type CaptureRecordSummary = CaptureRecordVersion & {
  readonly disposition: "unbound" | "pending" | "published" | "acknowledged" | "canceled" | "unavailable" | "abandoned"
  readonly unit: { readonly captureId: string; readonly ordinal: number } | null
  readonly unavailableReason: "limit" | "redaction" | null
}
export type CaptureCoverage = {
  readonly canonicalCaptureId: string | null
  readonly observedCanonicalCaptureId: string | null
  readonly observedRawCaptureId: string | null
}
export type CaptureReservation = {
  /** Explicit capability. Requires configured record admission and a tracked source. */
  readonly trackRecords?: boolean
  /** Existing callers default to publication. Raw observations cannot advance Canonical coverage. */
  readonly purpose?: CapturePurpose
  readonly id: string
  readonly expectedCheckpoint: string | null
  readonly beginJson: string
  readonly rawEnabled: boolean
}
export type CaptureSeal = {
  readonly records?: CaptureRecordManifest
  readonly canonicalUnits: number
  readonly rawUnits: number
  readonly nextCheckpoint: string
  readonly manifestJson: string
}
export type CaptureSummary = CaptureReservation & {
  /** Historical membership retired; record reads/replays fail explicitly. Proofs remain. */
  readonly recordsRetired: boolean
  readonly purpose: CapturePurpose
  readonly trackRecords: boolean
  readonly state: "preparing" | "sealed" | "activated" | "completed" | "abandoned"
  readonly seal: CaptureSeal | null
  readonly activationReceipt: string | null
  readonly retainedBytes: number
  readonly rawCancelReason: string | null
  readonly rejectionReceipt: string | null
}
export type CaptureUnitSummary = {
  readonly ordinal: number
  readonly byteCount: number
  readonly digest: string
  readonly disposition: "pending" | "acknowledged" | "canceled"
  readonly receiptJson: string | null
  readonly retained: boolean
}
export type CaptureSettlement =
  | { readonly _tag: "Activated"; readonly receiptJson: string }
  /** A verified part receipt advances delivery only, never coverage or reclamation. */
  | { readonly _tag: "CanonicalAcknowledged"; readonly ordinal: number; readonly receiptJson: string }
  | { readonly _tag: "RawAcknowledged"; readonly ordinal: number; readonly receiptJson: string }
  /** Persist intent before reconciling receipts; re-enabling cannot resume these uploads. */
  | { readonly _tag: "RawCancellationStarted"; readonly reason: string }
  | { readonly _tag: "RawUnitCanceled"; readonly ordinal: number }
  | { readonly _tag: "RawCanceled"; readonly reason: string }
  | { readonly _tag: "AbandonUnsealed" }
  /** Workflow-verified terminal remote rejection; timeout/unknown outcome is insufficient. */
  | { readonly _tag: "Rejected"; readonly receiptJson: string }

export class CaptureJournalError extends Schema.TaggedError<CaptureJournalError>()("CaptureJournalError", {
  reason: Schema.Literals(["invalid", "binding", "missing", "conflict", "state", "capacity", "corrupt", "io"]),
  message: Schema.String
}) {}

/** Opens account-bound journals under the existing Collector installation.
 * Initialization is local and versioned; missing established state is an error.
 * Every returned journal lives in the caller's Scope. */
export class CaptureJournals extends Context.Service<CaptureJournals, {
  open(account: Pick<CaptureBinding, "instanceOrigin" | "userId">, limits: CaptureJournalLimits):
    Effect.Effect<CaptureJournal["Service"], CaptureJournalError, Scope.Scope>
}>()("atape/application/CaptureJournals") {}

export class CaptureJournal extends Context.Service<CaptureJournal, {
  readonly binding: CaptureBinding
  /** A new owner fences every earlier owner for this source, including reads/GC. */
  claim(scope: CaptureScope): Effect.Effect<CaptureClaim, CaptureJournalError>
  /** Known local scopes remain recoverable after the provider deletes a source. */
  sources(projectId: string, adapterId: string, page: { readonly afterSessionId?: string; readonly limit?: number }): Effect.Effect<ReadonlyArray<CaptureScope>, CaptureJournalError>
  reserve(owner: CaptureOwner, capture: CaptureReservation): Effect.Effect<void, CaptureJournalError>
  append(owner: CaptureOwner, id: string, unit: {
    readonly kind: CaptureUnitKind; readonly ordinal: number; readonly bytes: Uint8Array
  }): Effect.Effect<void, CaptureJournalError>
  /** Reserve monotonic observed versions; this is not publication or Raw coverage. */
  record(owner: CaptureOwner, id: string, record: CaptureRecordInput): Effect.Effect<CaptureRecordVersion, CaptureJournalError>
  bindRecord(owner: CaptureOwner, id: string, record: CaptureRecordKey, binding: CaptureRecordBinding): Effect.Effect<void, CaptureJournalError>
  /** Indexed metadata lookup for chronological source observations and receipt-aware reuse. */
  recordStatus(owner: CaptureOwner, id: string, record: CaptureRecordKey): Effect.Effect<CaptureRecordSummary | null, CaptureJournalError>
  records(owner: CaptureOwner, id: string, page: { readonly kind: CaptureRecordKind; readonly afterKey?: string; readonly limit?: number }): Effect.Effect<ReadonlyArray<CaptureRecordSummary>, CaptureJournalError>
  /** Pointers only; page the immutable record membership to inspect actual outcomes. */
  coverage(owner: CaptureOwner): Effect.Effect<CaptureCoverage, CaptureJournalError>
  seal(owner: CaptureOwner, id: string, manifest: CaptureSeal): Effect.Effect<void, CaptureJournalError>
  /** At most one preparing/sealed capture, independently of older Raw obligations. */
  unactivated(owner: CaptureOwner): Effect.Effect<CaptureSummary | null, CaptureJournalError>
  /** Metadata only: unresolved captures or terminal captures awaiting reclamation. At most 100 entries. */
  pending(owner: CaptureOwner, afterId?: string, limit?: number): Effect.Effect<ReadonlyArray<CaptureSummary>, CaptureJournalError>
  /** Bounded metadata and receipts, including terminal/reclaimed captures. No payloads. */
  inspect(owner: CaptureOwner, id: string, page: {
    readonly kind: CaptureUnitKind; readonly afterOrdinal?: number; readonly limit?: number; readonly pendingOnly?: boolean
  }): Effect.Effect<{ readonly capture: CaptureSummary; readonly units: ReadonlyArray<CaptureUnitSummary> }, CaptureJournalError>
  /** One bounded unit. Canonical requires seal; Raw additionally requires activation. */
  read(owner: CaptureOwner, id: string, kind: CaptureUnitKind, ordinal: number): Effect.Effect<Uint8Array, CaptureJournalError>
  /** Actual activation and source checkpoint commit together. Cancellation is not an ACK. */
  settle(owner: CaptureOwner, id: string, settlement: CaptureSettlement): Effect.Effect<void, CaptureJournalError>
  /** Drops at most 32 resolved payloads, retaining identity/receipt metadata for replay. */
  reclaim(owner: CaptureOwner, id: string, limit?: number): Effect.Effect<number, CaptureJournalError>
  /** Retires at most 100 superseded terminal membership rows; keeps all current
   * coverage, pending work, version identities and unit/activation receipts. */
  pruneRecords(owner: CaptureOwner, limit?: number): Effect.Effect<number, CaptureJournalError>
}>()("atape/application/CaptureJournal") {}
