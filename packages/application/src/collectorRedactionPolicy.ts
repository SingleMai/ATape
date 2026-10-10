import { Context, Effect, Schema } from "effect"
import { CollectorConfigurationError, SecretRedactor, type SecretRedactorService } from "./collectorContracts.ts"
import type { RedactionConfigurationDescriptor } from "@atape/domain"

export type CollectorRedactionSnapshot = {
  readonly redactor: SecretRedactorService
  readonly descriptor: RedactionConfigurationDescriptor
}

/** Node resolves configuration and environment once per job. The pinned value is
 * also the content admission authority for recovery of immutable captures. */
export class CollectorRedactionPolicies extends Context.Service<CollectorRedactionPolicies, {
  snapshot(): Effect.Effect<CollectorRedactionSnapshot, CollectorConfigurationError>
}>()("atape/application/CollectorRedactionPolicies") {}

export const redactionTransformVersion = (policyId?: string) => policyId === undefined
  ? "atape.host-redaction.v1" : `atape.host-redaction.v2:${policyId}`

/** Historical callers without a policy identity preserve their original
 * Interface. Production jobs provide an immutable keyed policy identity. */
export const currentRedactionTransform = Effect.serviceOption(SecretRedactor).pipe(Effect.map(redactor =>
  redactor._tag === "Some" && redactor.value.policyId !== undefined
    ? redactionTransformVersion(redactor.value.policyId) : undefined))

export class CapturePolicyError extends Schema.TaggedError<CapturePolicyError>()("CapturePolicyError", {
  reason: Schema.Literal("policy"), message: Schema.String
}) {}

/** Metadata-only reconciliation may use an older policy; fresh preparation and
 * content delivery must remain bound to the current job's immutable snapshot. */
export const admitRedactionTransform = (transformVersion: string) => Effect.gen(function*() {
  const current = yield* currentRedactionTransform
  if (current === undefined && transformVersion.startsWith("atape.host-redaction.v2:") ||
    current !== undefined && transformVersion !== current)
    return yield* new CapturePolicyError({ reason: "policy", message: "Redaction policy changed; this capture must be reconciled before fresh preparation or content delivery." })
})
