import { Schema } from "effect"

export const RawPublicationProtocol = "atape.raw-publication.v1"
export const RawPublicationWireBytes = 5 * 1024 * 1024
const count = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Schema.Number.check(
  Schema.isInt(), Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512), Schema.isPattern(/^[^\u0000]+$/))
export const RawAuthority = Schema.Struct({ protocol: Schema.Literal(RawPublicationProtocol), teamRevision: count(1), userRevision: count() })
export const RawPublicationProof = Schema.Struct({ head: text, authority: RawAuthority })
export const RawPublicationPolicy = Schema.Struct({ enabled: Schema.Boolean, authority: RawAuthority })
export const RawChunkIdentity = Schema.Struct({ sessionId: text, installationId: text, adapterId: text, sourceObjectId: text, sourceChunkId: text })
// Host timestamps are UTC with at most the database's microsecond precision.
const timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/))
const metadata = {
  ...RawChunkIdentity.fields, protocolVersion: Schema.Literal("atape.raw.v1"), sourceName: text, mediaType: text,
  adapterVersion: text, capturedAt: timestamp, clientRedacted: Schema.Literal(true), generation: Schema.Literal(1),
  offset: count(), sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)), final: Schema.Boolean,
  publication: RawPublicationProof
}
export const RawPublicationChunk = Schema.Struct({ ...metadata,
  contentBase64: Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)) })
export const RawPublicationReceipt = Schema.Struct({ ...metadata, objectId: text, sizeBytes: count(0, 3 * 1024 * 1024) })
export type RawAuthority = typeof RawAuthority.Type
export type RawChunkIdentity = typeof RawChunkIdentity.Type
export type RawPublicationPolicy = typeof RawPublicationPolicy.Type
export type RawPublicationChunk = typeof RawPublicationChunk.Type
export type RawPublicationReceipt = typeof RawPublicationReceipt.Type
export const sameRawAuthority = (a: RawAuthority, b: RawAuthority) =>
  a.protocol === b.protocol && a.teamRevision === b.teamRevision && a.userRevision === b.userRevision
