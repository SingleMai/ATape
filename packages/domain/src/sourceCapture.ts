import { Schema } from "effect"
import { SourceCaptureVersion } from "./client.ts"
import { AdapterEvent, AdapterSession, AdapterThread, AdapterUsage, AdapterSourceFailure, MaxSourceFailures, GitSource } from "./collector.ts"

const count = (maximum: number, minimum = 1) => Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))
const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isPattern(/^[^\u0000]+$/))
/** Admission is explicit. These ceilings describe the protocol, not release defaults. */
export const SourceCaptureLimits = Schema.Struct({
  rowBytes: count(16 * 1024 * 1024), pageBytes: count(32 * 1024 * 1024), pageRows: count(100),
  records: count(1_000_000), threads: count(1000), durationMs: count(300_000)
})
export type SourceCaptureLimits = typeof SourceCaptureLimits.Type
export const SourceProjectionLimits = Schema.Struct({ events: count(2_000_000), usage: count(1_000_000), pageItems: count(100), pageBytes: count(32 * 1024 * 1024) })
export type SourceProjectionLimits = typeof SourceProjectionLimits.Type
const { revision: _eventRevision, projectionRevision: _projectionRevision, rawRef: _rawRef, ...eventFields } = AdapterEvent.fields
const { revision: _sessionRevision, ...sessionFields } = AdapterSession.fields
const { revision: _threadRevision, ...threadFields } = AdapterThread.fields
const { revision: _usageRevision, ...usageFields } = AdapterUsage.fields
export const SourceCaptureFrame = Schema.Struct({
  recordKey: identity,
  events: Schema.Array(Schema.Struct(eventFields)).check(Schema.isMaxLength(500)),
  usage: Schema.Array(Schema.Struct(usageFields)).check(Schema.isMaxLength(500)),
  raw: Schema.optionalKey(Schema.Unknown)
})
export type SourceCaptureFrame = typeof SourceCaptureFrame.Type
export const SourceCaptureHeader = Schema.Struct({
  profile: identity, origin: GitSource, session: Schema.Struct(sessionFields),
  threads: Schema.Array(Schema.Struct(threadFields)).check(Schema.isMaxLength(1000)),
  target: Schema.Struct({ events: count(2_000_000, 0), usage: count(1_000_000, 0), threads: count(1000) })
})
export type SourceCaptureHeader = typeof SourceCaptureHeader.Type
export const SourceCapturePage = Schema.Struct({ frames: Schema.Array(SourceCaptureFrame).check(Schema.isMaxLength(100)), done: Schema.Boolean })
export type SourceCapturePage = typeof SourceCapturePage.Type
export const SourceDiscoveryPage = Schema.Struct({
  sources: Schema.Array(GitSource).check(Schema.isMaxLength(100)),
  cursor: Schema.NullOr(identity), done: Schema.Boolean,
  sourceFailures: Schema.Array(AdapterSourceFailure).check(Schema.isMaxLength(MaxSourceFailures)), sourceFailuresTruncated: Schema.Boolean
})
export type SourceDiscoveryPage = typeof SourceDiscoveryPage.Type
export type SourceDiscoverRequest = { readonly cursor: string | null; readonly limits: SourceCaptureLimits; readonly signal: AbortSignal }
export type SourceOpenRequest = {
  readonly sourceId: string; readonly rawEnabled: boolean; readonly limits: SourceCaptureLimits
  readonly projection: SourceProjectionLimits; readonly signal: AbortSignal
}
/** Foreign package boundary: Host owns Effect Scope, validates metadata/pages,
 * assigns revisions and Raw references, and freezes the final delivery bytes. */
export type SourceCaptureView = SourceCaptureHeader & {
  readonly read: (signal: AbortSignal) => unknown | PromiseLike<unknown>
  readonly close: () => unknown | PromiseLike<unknown>
}
export type SourceCaptureRuntime = {
  readonly protocolVersion: typeof SourceCaptureVersion
  readonly discover: (request: SourceDiscoverRequest) => unknown | PromiseLike<unknown>
  readonly open: (request: SourceOpenRequest) => SourceCaptureView | PromiseLike<SourceCaptureView>
}
