import { Context, Effect, Schema } from "effect"
import type { PublicationBinding, RawChunkIdentity, RawPublicationPolicy, RawPublicationReceipt } from "@atape/domain"

export class RawPublicationError extends Schema.TaggedError<RawPublicationError>()("RawPublicationError", {
  reason: Schema.Literals(["invalid", "binding", "invalid_response", "unauthenticated", "network", "unknown", "disabled", "authority_changed", "conflict", "unavailable"]),
  message: Schema.String,
  retryAfterSeconds: Schema.optionalKey(Schema.Number)
}) {}

/** Owned remote Seam. Receipts are metadata-only and remain readable when Raw is off. */
export class RawPublicationTransport extends Context.Service<RawPublicationTransport, {
  policy(binding: PublicationBinding, projectId: string): Effect.Effect<RawPublicationPolicy, RawPublicationError>
  receipt(binding: PublicationBinding, identity: RawChunkIdentity): Effect.Effect<RawPublicationReceipt, RawPublicationError>
  append(binding: PublicationBinding, bytes: Uint8Array): Effect.Effect<RawPublicationReceipt, RawPublicationError>
}>()("atape/application/RawPublicationTransport") {}
