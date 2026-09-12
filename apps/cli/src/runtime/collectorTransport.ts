import { CollectionTransportError, CollectorTransport, projectCanonicalSubmission, type CanonicalSubmission, type RawSubmission } from "@atape/application"
import { CanonicalApplyReceipt as CanonicalApplyReceiptSchema, RawAppendReceipt as RawAppendReceiptSchema,
  RawIngestionProtocolVersion, type CanonicalBatch, type RawUploadChunk } from "@atape/domain"
import { createHash } from "node:crypto"
import { Effect, Layer, Schema } from "effect"
import { AuthenticatedHTTPClient, AuthenticatedHTTPError } from "./authenticatedHTTPClient.ts"

export const makeCollectorTransportLayer = () => Layer.effect(
  CollectorTransport,
  Effect.gen(function*() {
    const client = yield* AuthenticatedHTTPClient
    return CollectorTransport.of({
    rawCaptureEnabled: project => client.request({
      instanceOrigin: project.instanceOrigin, expectedUserId: project.userId,
      path: `/api/v1/projects/${encodeURIComponent(project.id)}/raw-capture`, method: "GET"
    }).pipe(
      Effect.mapError(error => transportError("policy", error)),
      Effect.flatMap(response => response.status === 200
        ? Schema.decodeUnknownEffect(Schema.Struct({ teamPolicy: Schema.Literals(["force", "personal", "close"]),
            userPreference: Schema.Literals(["enable", "disable"]), enabled: Schema.Boolean }))(response.body).pipe(
              Effect.mapError(() => new CollectionTransportError({ reason: "invalid_response", operation: "policy", retryable: false,
                message: "ATape returned an invalid Raw capture policy." })),
              Effect.map(policy => policy.enabled))
        : Effect.fail(new CollectionTransportError({ reason: response.status === 401 ? "unauthenticated" : "rejected",
            operation: "policy", status: response.status, retryable: response.status === 429 || response.status >= 500,
            ...(response.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.retryAfterSeconds }),
            message: `ATape Raw capture policy returned ${response.status}; update the server if this endpoint is unavailable.` })))
    ),
    submitCanonical: (submission) => {
      const batch = canonicalBatch(submission)
      return postJSON(
        client,
        submission.instanceOrigin,
        submission.userId,
        "/api/v1/ingestion/canonical/batches",
        batch,
        "canonical",
        CanonicalApplyReceiptSchema
      )
    },
    appendRaw: (submission) => {
      const chunk = rawChunk(submission)
      return postJSON(
        client,
        submission.instanceOrigin,
        submission.userId,
        "/api/v1/ingestion/raw/chunks",
        chunk,
        "raw",
        RawAppendReceiptSchema
      )
    }
    })
  })
)

const canonicalBatch = (submission: CanonicalSubmission): CanonicalBatch => {
  const base = projectCanonicalSubmission(submission)
  return { ...base, batchId: `b_${digest(JSON.stringify(base))}` }
}

const rawChunk = (submission: RawSubmission): RawUploadChunk => {
  const content = Buffer.from(submission.content, "utf8")
  const sha256 = digest(content)
  const base = {
    protocolVersion: RawIngestionProtocolVersion,
    sourceObjectId: submission.sourceObjectId,
    sessionId: submission.serverSessionId,
    installationId: submission.installationId,
    generation: submission.serverGeneration,
    offset: submission.serverOffset,
    sourceName: submission.sourceName,
    mediaType: submission.mediaType,
    adapterId: submission.adapterId,
    adapterVersion: submission.adapterVersion,
    capturedAt: submission.observedAt,
    clientRedacted: true as const,
    final: submission.final,
    contentBase64: content.toString("base64"),
    sha256
  }
  return { ...base, sourceChunkId: submission.sourceChunkId }
}

const postJSON = <A, I>(
  client: AuthenticatedHTTPClient["Service"],
  instanceOrigin: string,
  userId: string,
  path: `/${string}`,
  body: unknown,
  operation: "canonical" | "raw",
  schema: Schema.Codec<A, I>
): Effect.Effect<A, CollectionTransportError> => client.request({
  instanceOrigin,
  expectedUserId: userId,
  path,
  method: "POST",
  body
}).pipe(
  Effect.mapError((error) => transportError(operation, error)),
  Effect.flatMap((response) => response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(new CollectionTransportError({
      reason: operation === "raw" && response.status === 403 && typeof response.body === "object" && response.body !== null &&
        "code" in response.body && response.body.code === "raw_capture_disabled" ? "raw_disabled"
        : response.status === 401 ? "unauthenticated" : "rejected",
      operation,
      status: response.status,
      ...(response.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.retryAfterSeconds }),
      retryable: response.status !== 401 &&
        (response.status === 408 || response.status === 429 || response.status >= 500),
      message: response.status === 401
        ? `ATape ${operation} authentication failed; open ATape and sign in again.`
        : `ATape ${operation} endpoint returned ${response.status}.${problemIdentity(response.body)}`
    }))),
  Effect.flatMap((response) => Schema.decodeUnknownEffect(schema)(response.body)),
  Effect.mapError((error) => error instanceof CollectionTransportError
    ? error
    : new CollectionTransportError({
      reason: "invalid_response",
      operation,
      retryable: false,
      message: `ATape ${operation} endpoint returned an invalid receipt: ${String(error)}`
    }))
)

const problemIdentity = (body: unknown): string => {
  if (typeof body !== "object" || body === null) return ""
  const problem = body as Record<string, unknown>
  const code = typeof problem.code === "string" && /^[a-z_]{1,80}$/.test(problem.code) ? problem.code : undefined
  const requestId = typeof problem.requestId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(problem.requestId) ? problem.requestId : undefined
  return [code, requestId === undefined ? undefined : `request ${requestId}`].filter(Boolean).map(value => ` ${value}`).join("")
}

const transportError = (
  operation: "canonical" | "raw" | "policy",
  error: AuthenticatedHTTPError
) => new CollectionTransportError({
  reason: error.reason === "unauthenticated" || error.reason === "identity_changed"
    ? "unauthenticated"
    : error.reason === "network" ? "network" : "invalid_response",
  operation,
  ...(error.status === undefined ? {} : { status: error.status }),
  retryable: error.reason === "network",
  message: error.message
})

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
