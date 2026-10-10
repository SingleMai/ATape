import { Schema } from "effect"

// Frozen from f67ad67, before v3. Do not derive these compatibility decoders
// from current Domain schemas: they represent the old Host's closed contract.
const count = (maximum = Number.MAX_SAFE_INTEGER, minimum = 0) => Schema.Number.check(
  Schema.isInt(), Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isPattern(/^[^\u0000]+$/))
const head = Schema.String.check(Schema.isMaxLength(200))
const Binding = Schema.Struct({ instanceOrigin: text, userId: text, installationId: text })
const Scope = Schema.Struct({ projectId: text, installationId: text, adapterId: text, sourceSessionId: text, originKey: text })
const Begin = Schema.Struct({ reservationId: text, captureId: text, baseHead: head, transformVersion: text })
const RawAuthority = Schema.Struct({ protocol: Schema.Literal("atape.raw-publication.v1"),
  teamRevision: count(Number.MAX_SAFE_INTEGER, 1), userRevision: count() })

export const FrozenOldPublicationCapabilities = Schema.Struct({
  protocol: Schema.Literal("atape.publication.v1"), targetProfile: Schema.Literal("atape.publication-target.v1"),
  targetProfiles: Schema.optionalKey(Schema.Array(Schema.Literals([
    "atape.publication-target.v1", "atape.publication-target.v2"
  ])).check(Schema.isMaxLength(2))),
  legacyAdoption: Schema.optionalKey(Schema.Boolean),
  limits: Schema.Struct({
    partBytes: count(4 * 1024 * 1024, 1), targetBytes: count(1024 * 1024 * 1024, 1),
    userPendingBytes: count(16 * 1024 * 1024 * 1024, 1), parts: count(4096, 1), reservations: count(128, 1),
    reservationLifetimeMs: count(24 * 60 * 60 * 1000, 1), leaseLifetimeMs: count(60 * 60 * 1000, 1)
  }),
  statusPageSize: Schema.Literal(100), reclaimPageSize: Schema.Literal(32)
})

export const FrozenOldPublicationIntent = Schema.Struct({
  protocol: Schema.Literal("atape.publication.v1"), binding: Binding, scope: Scope,
  sessionId: Schema.String, begin: Begin, capabilities: FrozenOldPublicationCapabilities,
  adoption: Schema.optionalKey(Schema.Struct({ revisionFloor: count(Number.MAX_SAFE_INTEGER - 1) })),
  rawAuthority: Schema.optionalKey(RawAuthority)
})
