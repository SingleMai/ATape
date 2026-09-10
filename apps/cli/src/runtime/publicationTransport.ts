import { PublicationError, PublicationTransport } from "@atape/application"
import {
  PublicationActivation, PublicationAttempt, PublicationCapabilities, PublicationPage, PublicationPart, PublicationReservation,
  type PublicationBinding
} from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { AuthenticatedHTTPClient, type AuthenticatedHTTPRequest } from "./authenticatedHTTPClient.ts"

type WithoutBinding<A> = A extends unknown ? Omit<A, "instanceOrigin" | "expectedUserId"> : never

export const makePublicationTransportLayer = () => Layer.effect(PublicationTransport, Effect.gen(function*() {
  const http = yield* AuthenticatedHTTPClient
  const request = <A>(binding: PublicationBinding, input: WithoutBinding<AuthenticatedHTTPRequest>,
    schema: Schema.ConstraintDecoder<A>): Effect.Effect<A, PublicationError> => http.request({ ...input,
      instanceOrigin: binding.instanceOrigin, expectedUserId: binding.userId
    }).pipe(
      Effect.mapError(error => new PublicationError({
        reason: error.reason === "network" ? "network" : error.reason === "unauthenticated" ? "unauthenticated" :
          error.reason === "identity_changed" || error.reason === "metadata_drift" ? "binding" : "invalid_response",
        message: "Authenticated publication request failed.",
        ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds })
      })),
      Effect.flatMap(response => {
        if (response.status !== 200) {
          const body = response.body as { code?: unknown } | undefined
          const code = body?.code
          const reason = response.status === 401 || response.status === 403 ? "unauthenticated" :
            code === "publication_unknown" ? "unknown" : code === "publication_expired" ? "expired" :
            code === "publication_superseded" ? "superseded" : code === "publication_capacity" ? "capacity" :
            code === "publication_conflict" ? "conflict" : response.status >= 500 ? "unavailable" : "invalid_response"
          return Effect.fail(new PublicationError({ reason, message: "Publication request was not accepted; retained capture requires reconciliation.",
            ...(response.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.retryAfterSeconds }) }))
        }
        return Schema.decodeUnknownEffect(schema)(response.body).pipe(Effect.mapError(() =>
          new PublicationError({ reason: "invalid_response", message: "Publication response failed wire validation." })))
      })
    )
  const attemptPath = (id: string) => `/api/v1/publications/attempts/${encodeURIComponent(id)}` as const
  return PublicationTransport.of({
    capabilities: binding => request(binding, { method: "GET", path: "/api/v1/publications/capabilities" }, PublicationCapabilities),
    reserve: (binding, scope) => request(binding, { method: "POST", path: "/api/v1/publications/reservations", body: scope }, PublicationReservation),
    begin: (binding, begin) => request(binding, { method: "POST", path: "/api/v1/publications/attempts", body: begin }, PublicationAttempt),
    status: (binding, id) => request(binding, { method: "GET", path: `${attemptPath(id)}?after=-1&limit=1` }, PublicationPage).pipe(Effect.map(page => page.attempt)),
    put: (binding, id, part, bytes) => request(binding, { method: "PUT",
      path: `${attemptPath(id)}/parts/${part.ordinal}?sha256=${part.sha256}`, encodedJson: bytes }, PublicationPart),
    seal: (binding, id, manifest) => request(binding, { method: "POST", path: `${attemptPath(id)}/seal`, body: manifest }, PublicationAttempt),
    validate: (binding, id) => request(binding, { method: "POST", path: `${attemptPath(id)}/validate` }, PublicationAttempt),
    renew: (binding, id) => request(binding, { method: "POST", path: `${attemptPath(id)}/renew` }, PublicationAttempt),
    reject: (binding, id) => request(binding, { method: "POST", path: `${attemptPath(id)}/reject` }, PublicationAttempt),
    activate: (binding, id) => request(binding, { method: "POST", path: `${attemptPath(id)}/activate` }, PublicationActivation)
  })
}))
