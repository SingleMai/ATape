import { Schema } from "effect"

export const PublicationProtocol = "atape.publication.v1"
export const PublicationTargetProfile = "atape.publication-target.v1"
const count = (maximum = Number.MAX_SAFE_INTEGER, minimum = 0) => Schema.Number.check(
  Schema.isInt(), Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isPattern(/^[^\u0000]+$/))
const head = Schema.String.check(Schema.isMaxLength(200))
const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const timestamp = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/))
export const PublicationBinding = Schema.Struct({ instanceOrigin: text, userId: text, installationId: text })
export const PublicationScope = Schema.Struct({ projectId: text, installationId: text, adapterId: text, sourceSessionId: text, originKey: text })
export const PublicationReservation = Schema.Struct({ id: text, sessionId: text, expiresAt: timestamp })
export const PublicationBegin = Schema.Struct({ reservationId: text, captureId: text, baseHead: head, transformVersion: text })
export const PublicationPart = Schema.Struct({ ordinal: count(4095), bytes: count(4 * 1024 * 1024, 1), sha256: sha })
export const PublicationManifest = Schema.Struct({ parts: count(4096, 1), bytes: count(1024 * 1024 * 1024, 1), sha256: sha })
export const PublicationActivation = Schema.Struct({
  head: text, sessionId: text, captureId: text, baseHead: head, fence: count(Number.MAX_SAFE_INTEGER, 1),
  transformVersion: text, manifest: PublicationManifest, activatedAt: timestamp
})
export const PublicationAttempt = Schema.Struct({
  id: text, sessionId: text, captureId: text, baseHead: head, transformVersion: text,
  fence: count(Number.MAX_SAFE_INTEGER, 1), leaseUntil: timestamp, expiresAt: timestamp,
  state: Schema.Literals(["open", "sealed", "validating", "validated", "activated", "rejected", "expired", "superseded"]),
  parts: count(4096), retainedBytes: count(1024 * 1024 * 1024), seal: Schema.NullOr(PublicationManifest),
  validatedParts: count(4096), candidateEvents: count(), candidateUsage: count(), activation: Schema.NullOr(PublicationActivation)
})
export const PublicationPage = Schema.Struct({ attempt: PublicationAttempt,
  parts: Schema.NullOr(Schema.Array(PublicationPart).check(Schema.isMaxLength(100))) })
export const PublicationCapabilities = Schema.Struct({
  protocol: Schema.Literal(PublicationProtocol), targetProfile: Schema.Literal(PublicationTargetProfile),
  limits: Schema.Struct({ partBytes: count(4 * 1024 * 1024, 1), targetBytes: count(1024 * 1024 * 1024, 1),
    userPendingBytes: count(16 * 1024 * 1024 * 1024, 1), parts: count(4096, 1), reservations: count(128, 1),
    reservationLifetimeMs: count(24 * 60 * 60 * 1000, 1), leaseLifetimeMs: count(60 * 60 * 1000, 1) }),
  statusPageSize: Schema.Literal(100), reclaimPageSize: Schema.Literal(32)
})
export type PublicationBinding = typeof PublicationBinding.Type
export type PublicationScope = typeof PublicationScope.Type
export type PublicationBegin = typeof PublicationBegin.Type
export type PublicationPart = typeof PublicationPart.Type
export type PublicationManifest = typeof PublicationManifest.Type
export type PublicationActivation = typeof PublicationActivation.Type
export type PublicationAttempt = typeof PublicationAttempt.Type
export type PublicationCapabilities = typeof PublicationCapabilities.Type
