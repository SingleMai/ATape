import { Context, Effect, Schema } from "effect"

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
export type CaptureClaim = CaptureOwner & { readonly checkpoint: string | null }
export type CaptureUnitKind = "canonical" | "raw"
export type CaptureReservation = {
  readonly id: string
  readonly expectedCheckpoint: string | null
  readonly beginJson: string
  readonly rawEnabled: boolean
}
export type CaptureSeal = {
  readonly canonicalUnits: number
  readonly rawUnits: number
  readonly nextCheckpoint: string
  readonly manifestJson: string
}
export type CaptureSummary = CaptureReservation & {
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
  | { readonly _tag: "RawCanceled"; readonly reason: string }
  | { readonly _tag: "AbandonUnsealed" }
  /** Workflow-verified terminal remote rejection; timeout/unknown outcome is insufficient. */
  | { readonly _tag: "Rejected"; readonly receiptJson: string }

export class CaptureJournalError extends Schema.TaggedError<CaptureJournalError>()("CaptureJournalError", {
  reason: Schema.Literals(["invalid", "binding", "missing", "conflict", "state", "capacity", "corrupt", "io"]),
  message: Schema.String
}) {}

export class CaptureJournal extends Context.Service<CaptureJournal, {
  readonly binding: CaptureBinding
  /** A new owner fences every earlier owner for this source, including reads/GC. */
  claim(scope: CaptureScope): Effect.Effect<CaptureClaim, CaptureJournalError>
  reserve(owner: CaptureOwner, capture: CaptureReservation): Effect.Effect<void, CaptureJournalError>
  append(owner: CaptureOwner, id: string, unit: {
    readonly kind: CaptureUnitKind; readonly ordinal: number; readonly bytes: Uint8Array
  }): Effect.Effect<void, CaptureJournalError>
  seal(owner: CaptureOwner, id: string, manifest: CaptureSeal): Effect.Effect<void, CaptureJournalError>
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
}>()("atape/application/CaptureJournal") {}
