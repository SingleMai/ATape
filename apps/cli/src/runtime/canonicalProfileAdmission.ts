import { CollectionTransportError } from "@atape/application"
import { CanonicalCapabilities, CanonicalProfileVersion3, PublicationCapabilities, PublicationTargetProfile3 } from "@atape/domain"
import { Effect, Schema } from "effect"
import { type AuthenticatedHTTPClient, type AuthenticatedHTTPError, type AuthenticatedHTTPResponse } from "./authenticatedHTTPClient.ts"

/** Admit direct Canonical ingestion independently from Publication deployment.
 * An older Server's real target-v3 support is a compatibility proof only when
 * the direct capability route explicitly does not exist or is unimplemented. */
export const ensureCanonicalProfile = (
  http: AuthenticatedHTTPClient["Service"], binding: { readonly instanceOrigin: string; readonly userId: string },
  profile: typeof CanonicalProfileVersion3
): Effect.Effect<void, AuthenticatedHTTPError | CollectionTransportError> => Effect.gen(function*() {
  const request = { instanceOrigin: binding.instanceOrigin, expectedUserId: binding.userId, method: "GET" as const }
  const response = yield* http.request({ ...request, path: "/api/v1/ingestion/canonical/capabilities" })
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    const fallback = yield* http.request({ ...request, path: "/api/v1/publications/capabilities",
      acceptPublicationTarget: PublicationTargetProfile3 })
    if (fallback.status !== 200) return yield* statusFailure(fallback, profile)
    const capabilities = yield* Schema.decodeUnknownEffect(PublicationCapabilities)(fallback.body).pipe(
      Effect.mapError(() => invalidCapabilities()))
    if (!capabilities.targetProfiles?.includes(PublicationTargetProfile3)) return yield* unsupportedProfile(profile)
    return
  }
  if (response.status !== 200) return yield* statusFailure(response, profile)
  const capabilities = yield* Schema.decodeUnknownEffect(CanonicalCapabilities)(response.body).pipe(
    Effect.mapError(() => invalidCapabilities()))
  if (!capabilities.canonicalProfiles.includes(profile)) return yield* unsupportedProfile(profile)
})

const unsupportedProfile = (profile: typeof CanonicalProfileVersion3) => new CollectionTransportError({
  reason: "rejected", operation: "canonical", retryable: false,
  message: `ATape did not affirm support for ${profile}; update the Server before collecting this Adapter.`
})
const invalidCapabilities = () => new CollectionTransportError({
  reason: "invalid_response", operation: "canonical", retryable: false,
  message: "ATape returned invalid Canonical profile capabilities."
})
const statusFailure = (response: AuthenticatedHTTPResponse, profile: typeof CanonicalProfileVersion3) =>
  new CollectionTransportError({ operation: "canonical", status: response.status,
    reason: response.status === 401 || response.status === 403 ? "unauthenticated" : "rejected",
    retryable: response.status === 429 || response.status >= 500,
    message: unsupportedProfile(profile).message,
    ...(response.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.retryAfterSeconds }) })
