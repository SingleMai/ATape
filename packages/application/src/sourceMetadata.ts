import { Effect, Schema } from "effect"
import { AdapterSourceFailure, SourceCapturePriorThread, SourceCaptureCheckpoint } from "@atape/domain"
import { CaptureJournal, type CaptureOwner } from "./captureJournal.ts"
import { PublicationPreparationError, type PublicationDraftView } from "./canonicalSourceProjection.ts"
import { SecretRedactor } from "./collectorContracts.ts"

const Metadata = Schema.Struct({
  threads: Schema.Array(SourceCapturePriorThread).check(Schema.isMaxLength(1000)),
  sourceCheckpoint: Schema.optionalKey(SourceCaptureCheckpoint),
  retainedThreadIds: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(1000))),
  sourceFailures: Schema.optionalKey(Schema.Array(AdapterSourceFailure).check(Schema.isMaxLength(32))),
  sourceFailuresTruncated: Schema.optionalKey(Schema.Boolean)
})
type Metadata = typeof Metadata.Type
const invalid = () => new PublicationPreparationError({ reason: "invalid", message: "Frozen source metadata is invalid or exceeds its bound." })
export const decodeSourceMetadata = (json: string | null) => json === null ? Effect.succeed<Metadata>({ threads: [] }) : Effect.try({
  try: () => { if (new TextEncoder().encode(json).byteLength > 2 * 1024 * 1024) throw new Error(); return JSON.parse(json) as unknown },
  catch: invalid
}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Metadata)), Effect.mapError(invalid))

/** The current selected header is small provider metadata, never transcript text.
 * Adoption supplies the same Thread shape from the authenticated Server baseline. */
export const currentSourceMetadata = (owner: CaptureOwner) => Effect.gen(function*() {
  const journal = yield* CaptureJournal, coverage = yield* journal.coverage(owner)
  return yield* decodeSourceMetadata(yield* journal.sourceMetadata(owner, coverage.canonicalCaptureId))
})
/** Diagnostics are local content too. Mask before freezing metadata as well as
 * before rendering a report; receipt recovery never rewrites frozen metadata. */
export const maskSourceFailures = (failures: ReadonlyArray<typeof AdapterSourceFailure.Type>) => Effect.gen(function*() {
  const redactor = yield* SecretRedactor
  return failures.map(failure => ({ ...failure,
    source: (redactor.redactDiagnostic?.(failure.source) ?? redactor.redact(failure.source)).value.slice(0, 4096) }))
})
export const sourceMetadataJson = (view: PublicationDraftView<unknown, unknown>, threads: Metadata["threads"]) => Effect.gen(function*() {
  const sourceFailures = yield* maskSourceFailures(view.sourceFailures ?? [])
  return JSON.stringify({ threads,
    ...(view.sourceCheckpoint === undefined ? {} : { sourceCheckpoint: view.sourceCheckpoint, retainedThreadIds: view.target.retainedThreadIds ?? [],
      sourceFailures, sourceFailuresTruncated: view.sourceFailuresTruncated ?? false }) })
})
