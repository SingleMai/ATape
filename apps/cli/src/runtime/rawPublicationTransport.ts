import { RawPublicationError, RawPublicationTransport } from "@atape/application"
import { RawPublicationPolicy, RawPublicationReceipt, type PublicationBinding } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { AuthenticatedHTTPClient, type AuthenticatedHTTPRequest } from "./authenticatedHTTPClient.ts"

type WithoutBinding<A> = A extends unknown ? Omit<A, "instanceOrigin" | "expectedUserId"> : never
const Append = Schema.Struct({ receipt: RawPublicationReceipt })
export const makeRawPublicationTransportLayer = () => Layer.effect(RawPublicationTransport, Effect.gen(function*() {
  const http = yield* AuthenticatedHTTPClient
  const request = <A>(binding: PublicationBinding, input: WithoutBinding<AuthenticatedHTTPRequest>, schema: Schema.ConstraintDecoder<A>) =>
    http.request({ ...input, instanceOrigin: binding.instanceOrigin, expectedUserId: binding.userId }).pipe(
      Effect.mapError(error => new RawPublicationError({
        reason: error.reason === "network" ? "network" : error.reason === "unauthenticated" ? "unauthenticated" :
          error.reason === "identity_changed" || error.reason === "metadata_drift" ? "binding" : "invalid_response",
        message: "Authenticated Raw request failed.",
        ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds })
      })),
      Effect.flatMap(response => {
        if (response.status === 204 && input.path === "/api/v1/ingestion/raw/receipts/lookup")
          return Effect.fail(new RawPublicationError({ reason: "unknown", message: "Authorized lookup found no committed chunk." }))
        if (response.status !== 200 && !(response.status === 201 && input.path === "/api/v1/ingestion/raw/chunks")) {
          const code = typeof response.body === "object" && response.body !== null && "code" in response.body ? response.body.code : undefined
          const reason = response.status === 409 && code === "raw_authority_changed" ? "authority_changed" :
            response.status === 403 && code === "raw_capture_disabled" ? "disabled" :
            response.status === 401 || response.status === 403 ? "unauthenticated" :
            response.status === 404 ? "unauthenticated" : response.status === 409 ? "conflict" : response.status >= 500 ? "unavailable" : "invalid_response"
          return Effect.fail(new RawPublicationError({ reason, message: "Raw request was not accepted; frozen obligations require reconciliation.",
            ...(response.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.retryAfterSeconds }) }))
        }
        return Schema.decodeUnknownEffect(schema)(response.body).pipe(Effect.mapError(() =>
          new RawPublicationError({ reason: "invalid_response", message: "Raw response failed wire validation." })))
      }))
  return RawPublicationTransport.of({
    policy: (binding, projectId) => request(binding, { method: "GET", path: `/api/v1/projects/${encodeURIComponent(projectId)}/raw-capture` }, RawPublicationPolicy),
    receipt: (binding, identity) => request(binding, { method: "POST", path: "/api/v1/ingestion/raw/receipts/lookup", body: identity }, RawPublicationReceipt),
    append: (binding, bytes) => request(binding, { method: "POST", path: "/api/v1/ingestion/raw/chunks", encodedJson: bytes }, Append).pipe(Effect.map(value => value.receipt))
  })
}))
