import { Schema } from "effect"
import type {
  ContentBlock as OfficialAcpContentBlock,
  SessionUpdate as OfficialAcpSessionUpdate
} from "@agentclientprotocol/sdk"
import { AdapterProtocolVersion } from "./client.ts"

export const CanonicalIngestionProtocolVersion = "atape.canonical.v1alpha1" as const
export const CanonicalProfileVersion = "atape.acp-centered.v1alpha1" as const
export const RawIngestionProtocolVersion = "atape.raw.v1alpha1" as const
export const RawTransportChunkBytes = 256 * 1024
export const CollectorStateVersion = 1 as const
export const CollectorRunStateVersion = 1 as const

export type AdapterCollectionLimitValues = {
  readonly observations: number
  readonly threadsPerObservation: number
  readonly eventsPerObservation: number
  readonly canonicalBytesPerObservation: number
  readonly rawSegmentsPerObservation: number
  readonly rawSegmentBytes: number
  readonly rawBytesPerObservation: number
  readonly pagesPerCycle: number
}

export const AdapterCollectionLimits = {
  observations: 10,
  threadsPerObservation: 100,
  eventsPerObservation: 500,
  canonicalBytesPerObservation: 3 * 1024 * 1024,
  rawSegmentsPerObservation: 16,
  rawSegmentBytes: 4 * 1024 * 1024,
  rawBytesPerObservation: 4 * 1024 * 1024,
  pagesPerCycle: 20
} as const satisfies AdapterCollectionLimitValues

export const AdapterActor = Schema.Struct({
  name: Schema.String,
  harness: Schema.String
})
export type AdapterActor = typeof AdapterActor.Type

export const AdapterSession = Schema.Struct({
  sourceSessionId: Schema.String,
  revision: Schema.Number,
  title: Schema.String,
  summary: Schema.String,
  insight: Schema.String,
  actor: AdapterActor,
  branch: Schema.String,
  status: Schema.Literals(["active", "idle", "ended"]),
  captureStatus: Schema.Literals(["healthy", "partial", "complete", "degraded"]),
  updatedAt: Schema.String,
  reportedEventCount: Schema.Number
})
export type AdapterSession = typeof AdapterSession.Type

export const AdapterThread = Schema.Struct({
  sourceThreadId: Schema.String,
  parentSourceThreadId: Schema.optionalKey(Schema.String),
  revision: Schema.Number,
  label: Schema.String,
  summary: Schema.String,
  captureStatus: Schema.Literals(["healthy", "partial", "complete", "degraded"])
})
export type AdapterThread = typeof AdapterThread.Type

export const AdapterObjectRawReference = Schema.Struct({
  _tag: Schema.Literal("object"),
  sourceObjectId: Schema.String,
  fragment: Schema.optionalKey(Schema.String)
})

export const AdapterUnavailableRawReference = Schema.Struct({
  _tag: Schema.Literal("unavailable"),
  reason: Schema.String
})

export const AdapterRawReference = Schema.Union([
  AdapterObjectRawReference,
  AdapterUnavailableRawReference
])
export type AdapterRawReference = typeof AdapterRawReference.Type

const AcpTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

const AcpImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
  uri: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const AcpAudioContent = Schema.Struct({
  type: Schema.Literal("audio"),
  data: Schema.String,
  mimeType: Schema.String
})

const AcpResourceLink = Schema.Struct({
  type: Schema.Literal("resource_link"),
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  mimeType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  size: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  title: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const AcpTextResource = Schema.Struct({
  uri: Schema.String,
  text: Schema.String,
  mimeType: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const AcpBlobResource = Schema.Struct({
  uri: Schema.String,
  blob: Schema.String,
  mimeType: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const AcpEmbeddedResource = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: Schema.Union([AcpTextResource, AcpBlobResource])
})

export const AcpContentBlock = Schema.Union([
  AcpTextContent,
  AcpImageContent,
  AcpAudioContent,
  AcpResourceLink,
  AcpEmbeddedResource
])
export type AcpContentBlock = typeof AcpContentBlock.Type

const AcpToolKind = Schema.Literals([
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"
])
const AcpToolStatus = Schema.Literals(["pending", "in_progress", "completed", "failed"])

const AcpUserMessageChunk = Schema.Struct({
  sessionUpdate: Schema.Literal("user_message_chunk"),
  content: AcpContentBlock,
  messageId: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const AcpAgentMessageChunk = Schema.Struct({
  sessionUpdate: Schema.Literal("agent_message_chunk"),
  content: AcpContentBlock,
  messageId: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const AcpAgentThoughtChunk = Schema.Struct({
  sessionUpdate: Schema.Literal("agent_thought_chunk"),
  content: AcpContentBlock,
  messageId: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const AcpToolCall = Schema.Struct({
  sessionUpdate: Schema.Literal("tool_call"),
  toolCallId: Schema.String,
  title: Schema.String,
  kind: Schema.optionalKey(AcpToolKind),
  status: Schema.optionalKey(AcpToolStatus)
})

const AcpToolCallUpdate = Schema.Struct({
  sessionUpdate: Schema.Literal("tool_call_update"),
  toolCallId: Schema.String,
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  kind: Schema.optionalKey(Schema.NullOr(AcpToolKind)),
  status: Schema.optionalKey(Schema.NullOr(AcpToolStatus))
})

export const AcpSessionUpdate = Schema.Union([
  AcpUserMessageChunk,
  AcpAgentMessageChunk,
  AcpAgentThoughtChunk,
  AcpToolCall,
  AcpToolCallUpdate
])
export type AcpSessionUpdate = typeof AcpSessionUpdate.Type

// Compile-time checks keep this accepted ATape profile structurally inside
// stable ACP v1 instead of growing a parallel Message or ContentBlock model.
type EnsureAcpCompatibility<Official, Profile extends Official> = Profile
export type AcpContentBlockCompatibility = EnsureAcpCompatibility<OfficialAcpContentBlock, AcpContentBlock>
export type AcpSessionUpdateCompatibility = EnsureAcpCompatibility<OfficialAcpSessionUpdate, AcpSessionUpdate>

export const AdapterEvent = Schema.Struct({
  sourceEventId: Schema.String,
  sourceThreadId: Schema.String,
  revision: Schema.Number,
  projectionRevision: Schema.Number,
  sourceOrder: Schema.Number,
  eventIndex: Schema.Number,
  orderFidelity: Schema.Literals(["native", "derived"]),
  fidelity: Schema.Literals(["native", "derived", "partial", "redacted"]),
  rawRef: AdapterRawReference,
  occurredAt: Schema.String,
  update: AcpSessionUpdate,
  childSourceThreadId: Schema.optionalKey(Schema.String)
})
export type AdapterEvent = typeof AdapterEvent.Type

export const AdapterRawSegment = Schema.Struct({
  sourceObjectId: Schema.String,
  sourceGeneration: Schema.String,
  sourceOffset: Schema.Number,
  sourceName: Schema.String,
  mediaType: Schema.String,
  content: Schema.String,
  final: Schema.Boolean
})
export type AdapterRawSegment = typeof AdapterRawSegment.Type

export const AdapterObservation = Schema.Struct({
  observationId: Schema.String,
  observedAt: Schema.String,
  session: AdapterSession,
  threads: Schema.Array(AdapterThread),
  events: Schema.Array(AdapterEvent),
  rawSegments: Schema.Array(AdapterRawSegment)
})
export type AdapterObservation = typeof AdapterObservation.Type

export const AdapterCollectionPage = Schema.Struct({
  protocolVersion: Schema.Literal(AdapterProtocolVersion),
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
  observations: Schema.Array(AdapterObservation)
})
export type AdapterCollectionPage = typeof AdapterCollectionPage.Type

export type AdapterOpenContext = {
  readonly protocolVersion: typeof AdapterProtocolVersion
  readonly adapter: {
    readonly id: string
    readonly version: string
  }
  readonly user: {
    readonly id: string
  }
  readonly project: {
    readonly id: string
    readonly type: "git" | "directory"
    readonly path: string
  }
}

export type AdapterSourceProgress = {
  readonly sourceSessionId: string
  readonly sourceObjectId: string
  readonly sourceGeneration: string
  readonly sourceOffset: number
  readonly finalized: boolean
}

export type AdapterCollectRequest = {
  readonly protocolVersion: typeof AdapterProtocolVersion
  readonly cursor: string | null
  readonly previousAdapterVersion?: string
  readonly limits: AdapterCollectionLimitValues
  readonly rawProgress: ReadonlyArray<AdapterSourceProgress>
  readonly signal: AbortSignal
}

export type AtapeAdapterRuntime = {
  readonly collect: (request: AdapterCollectRequest) => unknown | PromiseLike<unknown>
  readonly close?: () => unknown | PromiseLike<unknown>
}

export type AtapeAdapterModule = {
  readonly createAtapeAdapter: (
    context: AdapterOpenContext & { readonly signal: AbortSignal }
  ) => AtapeAdapterRuntime | PromiseLike<AtapeAdapterRuntime>
}

export const CollectorRawObjectProgress = Schema.Struct({
  sourceSessionId: Schema.String,
  sourceObjectId: Schema.String,
  sourceName: Schema.String,
  mediaType: Schema.String,
  sourceGeneration: Schema.String,
  sourceOffset: Schema.Number,
  serverGeneration: Schema.Number,
  serverOffset: Schema.Number,
  finalized: Schema.Boolean
})
export type CollectorRawObjectProgress = typeof CollectorRawObjectProgress.Type

export const CollectorCheckpoint = Schema.Struct({
  projectId: Schema.String,
  projectCreatedAt: Schema.String,
  adapterId: Schema.String,
  adapterVersion: Schema.String,
  revision: Schema.Number,
  cursor: Schema.NullOr(Schema.String),
  rawObjects: Schema.Array(CollectorRawObjectProgress),
  updatedAt: Schema.String
})
export type CollectorCheckpoint = typeof CollectorCheckpoint.Type

export const CollectorState = Schema.Struct({
  version: Schema.Literal(CollectorStateVersion),
  installationId: Schema.String,
  checkpoints: Schema.Array(CollectorCheckpoint)
})
export type CollectorState = typeof CollectorState.Type

export const emptyCollectorState = (installationId: string): CollectorState => ({
  version: CollectorStateVersion,
  installationId,
  checkpoints: []
})

export const CollectorJobRunStatus = Schema.Struct({
  projectId: Schema.String,
  adapterId: Schema.String,
  lastAttemptAt: Schema.String,
  lastSuccessAt: Schema.optionalKey(Schema.String),
  lastFailureAt: Schema.optionalKey(Schema.String),
  failureMessage: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
  pages: Schema.optionalKey(Schema.Number),
  observations: Schema.optionalKey(Schema.Number),
  canonicalBatches: Schema.optionalKey(Schema.Number),
  rawChunks: Schema.optionalKey(Schema.Number),
  redactions: Schema.optionalKey(Schema.Number),
  hasMore: Schema.optionalKey(Schema.Boolean)
})
export type CollectorJobRunStatus = typeof CollectorJobRunStatus.Type

export const CollectorRunFailure = Schema.Struct({
  occurredAt: Schema.String,
  message: Schema.String
})
export type CollectorRunFailure = typeof CollectorRunFailure.Type

export const CollectorRunState = Schema.Struct({
  version: Schema.Literal(CollectorRunStateVersion),
  lastCycleStartedAt: Schema.optionalKey(Schema.String),
  lastCycleCompletedAt: Schema.optionalKey(Schema.String),
  collectorFailure: Schema.optionalKey(CollectorRunFailure),
  jobs: Schema.Array(CollectorJobRunStatus)
})
export type CollectorRunState = typeof CollectorRunState.Type

export const emptyCollectorRunState = (): CollectorRunState => ({
  version: CollectorRunStateVersion,
  jobs: []
})

export const CanonicalSource = Schema.Struct({
  adapterId: Schema.String,
  adapterVersion: Schema.String,
  userId: Schema.String,
  installationId: Schema.String
})

export const CanonicalProject = Schema.Struct({
  id: Schema.String,
  teamId: Schema.String,
  teamName: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["git", "directory"])
})

export const CanonicalIngestionEvent = Schema.Struct({
  sourceEventId: Schema.String,
  sourceThreadId: Schema.String,
  revision: Schema.Number,
  projectionRevision: Schema.Number,
  sourceOrder: Schema.Number,
  eventIndex: Schema.Number,
  orderFidelity: Schema.Literals(["native", "derived"]),
  fidelity: Schema.Literals(["native", "derived", "partial", "redacted"]),
  rawRef: Schema.String,
  kind: Schema.Literals(["message", "thought", "tool_call", "tool_result", "artifact", "spawn", "lifecycle"]),
  author: Schema.String,
  occurredAt: Schema.String,
  text: Schema.String,
  toolLabel: Schema.optionalKey(Schema.String),
  childSourceThreadId: Schema.optionalKey(Schema.String)
})

export const CanonicalBatch = Schema.Struct({
  protocolVersion: Schema.Literal(CanonicalIngestionProtocolVersion),
  canonicalProfileVersion: Schema.Literal(CanonicalProfileVersion),
  batchId: Schema.String,
  observedAt: Schema.String,
  source: CanonicalSource,
  project: CanonicalProject,
  session: AdapterSession,
  threads: Schema.Array(AdapterThread),
  events: Schema.Array(CanonicalIngestionEvent)
})
export type CanonicalBatch = typeof CanonicalBatch.Type

export const CanonicalApplyReceipt = Schema.Struct({
  sessionId: Schema.String,
  sessionCreated: Schema.Boolean,
  insertedEvents: Schema.Number,
  updatedEvents: Schema.Number,
  unchangedEvents: Schema.Number,
  staleEvents: Schema.Number,
  replayed: Schema.Boolean
})
export type CanonicalApplyReceipt = typeof CanonicalApplyReceipt.Type

export const RawUploadChunk = Schema.Struct({
  protocolVersion: Schema.Literal(RawIngestionProtocolVersion),
  chunkId: Schema.String,
  objectId: Schema.String,
  projectId: Schema.String,
  sessionId: Schema.String,
  generation: Schema.Number,
  offset: Schema.Number,
  sourceName: Schema.String,
  mediaType: Schema.String,
  adapterId: Schema.String,
  adapterVersion: Schema.String,
  capturedAt: Schema.String,
  clientRedacted: Schema.Literal(true),
  final: Schema.Boolean,
  contentBase64: Schema.String,
  sha256: Schema.String
})
export type RawUploadChunk = typeof RawUploadChunk.Type

export const RawAppendReceipt = Schema.Struct({
  objectId: Schema.String,
  generation: Schema.Number,
  sizeBytes: Schema.Number,
  finalized: Schema.Boolean,
  replayed: Schema.Boolean
})
export type RawAppendReceipt = typeof RawAppendReceipt.Type
