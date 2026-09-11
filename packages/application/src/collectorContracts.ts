import type {
  SourceCaptureLimits, SourceProjectionLimits, SourceDiscoveryPage, GitSource, GitSourceDecision,
  AdapterCollectionPage, AdapterCollectionProgress, AdapterCollectionLimitValues, AdapterInstallation,
  CanonicalApplyReceipt, CollectorCheckpoint, LocalProject, RawAppendReceipt
} from "@atape/domain"
import { AdapterObservation, AdapterProtocolVersion, AdapterSourceFailure } from "@atape/domain"
import { Context, Effect, Schema, Scope } from "effect"
import type { PublicationDraftView } from "./publicationPreparation.ts"

export class CollectorConfigurationError extends Schema.TaggedError<CollectorConfigurationError>()("CollectorConfigurationError", {
  reason: Schema.Literals(["identity", "project", "limits", "unauthenticated"]),
  message: Schema.String
}) {}

export class CollectorStateError extends Schema.TaggedError<CollectorStateError>()("CollectorStateError", {
  reason: Schema.Literals(["io", "decode", "conflict"]),
  message: Schema.String
}) {}

export class AdapterRuntimeError extends Schema.TaggedError<AdapterRuntimeError>()("AdapterRuntimeError", {
  reason: Schema.Literals(["load", "contract", "collect", "close", "unauthenticated", "transport"]),
  sourceFailureReason: Schema.optionalKey(AdapterSourceFailure.fields.reason),
  adapterId: Schema.String,
  retryable: Schema.Boolean,
  message: Schema.String
}) {}

export class CollectionContractError extends Schema.TaggedError<CollectionContractError>()("CollectionContractError", {
  adapterId: Schema.String,
  message: Schema.String
}) {}

export class CollectionTransportError extends Schema.TaggedError<CollectionTransportError>()("CollectionTransportError", {
  reason: Schema.Literals(["network", "unauthenticated", "rejected", "invalid_response", "raw_disabled"]),
  operation: Schema.Literals(["canonical", "raw", "policy"]),
  status: Schema.optionalKey(Schema.Number),
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  retryable: Schema.Boolean,
  message: Schema.String
}) {}

export type CollectorStateSnapshot = {
  readonly installationId: string
  readonly checkpoint?: CollectorCheckpoint
}

export type CapturedCollectorScope = Pick<CollectorCheckpoint,
  "instanceOrigin" | "userId" | "projectId" | "projectCreatedAt" | "adapterId">

export class CollectorStateStore extends Context.Service<CollectorStateStore, {
  /** One consistent, compact read for console inspection, without private cursors or Raw receipts. */
  capturedScopes(): Effect.Effect<ReadonlyArray<CapturedCollectorScope>, CollectorStateError>
  snapshot(
    instanceOrigin: string,
    userId: string,
    projectId: string,
    adapterId: string
  ): Effect.Effect<CollectorStateSnapshot, CollectorStateError>
  commit(input: {
    readonly instanceOrigin: string
    readonly userId: string
    readonly projectId: string
    readonly adapterId: string
    readonly expectedRevision: number
    readonly checkpoint: CollectorCheckpoint
  }): Effect.Effect<void, CollectorStateError>
}>()("atape/application/CollectorStateStore") {}

export type HostedCollectRequest = {
  readonly rawCaptureEnabled?: boolean
  readonly protocolVersion: typeof AdapterProtocolVersion
  readonly cursor: string | null
  readonly previousAdapterVersion?: string
  readonly limits: AdapterCollectionLimitValues
  readonly rawProgress: ReadonlyArray<{
    readonly sourceSessionId: string
    readonly sourceObjectId: string
    readonly sourceGeneration: string
    readonly sourceOffset: number
    readonly finalized: boolean
  }>
}

export type HostedSourceCapture = {
  readonly discover: (request: { readonly cursor: string | null; readonly limits: SourceCaptureLimits }) => Effect.Effect<SourceDiscoveryPage, AdapterRuntimeError>
  readonly open: (request: { readonly sourceId: string; readonly rawEnabled: boolean; readonly limits: SourceCaptureLimits; readonly projection: SourceProjectionLimits }) =>
    Effect.Effect<PublicationDraftView<AdapterRuntimeError>, AdapterRuntimeError, Scope.Scope>
}
export type HostedAdapter = {
  readonly collect: (request: HostedCollectRequest) => Effect.Effect<AdapterCollectionPage, AdapterRuntimeError>
} | {
  readonly sourceCapture: HostedSourceCapture
  /** Host-owned ownership check after discovery has released its source view. */
  readonly attribute: (source: GitSource) => Effect.Effect<GitSourceDecision, AdapterRuntimeError>
}

export class AdapterRuntimes extends Context.Service<AdapterRuntimes, {
  open(
    project: LocalProject,
    adapter: AdapterInstallation
  ): Effect.Effect<HostedAdapter, AdapterRuntimeError, Scope.Scope>
}>()("atape/application/AdapterRuntimes") {}

export type CanonicalSubmission = {
  readonly instanceOrigin: string
  readonly userId: string
  readonly installationId: string
  readonly projectId: string
  readonly adapterId: string
  readonly adapterVersion: string
  readonly observation: Pick<AdapterObservation, "observedAt" | "session" | "threads" | "events" | "usage">
}

export type RawSubmission = {
  readonly instanceOrigin: string
  readonly userId: string
  readonly installationId: string
  readonly adapterId: string
  readonly adapterVersion: string
  readonly serverSessionId: string
  readonly observedAt: string
  readonly sourceChunkId: string
  readonly sourceObjectId: string
  readonly sourceName: string
  readonly mediaType: string
  readonly content: string
  readonly final: boolean
  readonly serverGeneration: number
  readonly serverOffset: number
}

export type CollectorTransportService = {
  rawCaptureEnabled(project: Pick<LocalProject, "instanceOrigin" | "userId" | "id">): Effect.Effect<boolean, CollectionTransportError>
  submitCanonical(submission: CanonicalSubmission): Effect.Effect<CanonicalApplyReceipt, CollectionTransportError>
  appendRaw(submission: RawSubmission): Effect.Effect<RawAppendReceipt, CollectionTransportError>
}

export class CollectorTransport extends Context.Service<CollectorTransport, CollectorTransportService>()(
  "atape/application/CollectorTransport"
) {}

export type RedactedText = {
  readonly value: string
  readonly replacements: number
}

export type SecretRedactorService = {
  redact(value: string): RedactedText
}

export class SecretRedactor extends Context.Service<SecretRedactor, SecretRedactorService>()(
  "atape/application/SecretRedactor"
) {}

export type AdapterCollectionReport = {
  readonly progress?: AdapterCollectionProgress
  readonly canonicalEvents?: number
  readonly rawBytes?: number
  readonly durationMs?: number
  readonly sourceFailures?: ReadonlyArray<AdapterSourceFailure>
  readonly sourceFailuresTruncated?: boolean
  readonly projectId: string
  readonly adapterId: string
  readonly pages: number
  readonly observations: number
  readonly canonicalBatches: number
  readonly rawChunks: number
  readonly redactions: number
  readonly hasMore: boolean
}

export type AdapterCollectionFailure = {
  readonly projectId: string
  readonly adapterId: string
  readonly reason: "unauthenticated" | "transport" | "adapter" | "state" | "contract"
  readonly retryable: boolean
  readonly message: string
}

export type CollectionCycleReport = {
  readonly startedAt: string
  readonly completedAt: string
  readonly jobs: ReadonlyArray<AdapterCollectionReport>
  readonly failures: ReadonlyArray<AdapterCollectionFailure>
}

export type CollectionJobError = CollectorStateError | AdapterRuntimeError | CollectionContractError | CollectionTransportError
