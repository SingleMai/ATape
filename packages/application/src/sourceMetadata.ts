import { Effect, Schema } from "effect"
import { AdapterSourceFailure, SourceCapturePriorThread, SourceCaptureCheckpoint } from "@atape/domain"
import { CaptureJournal, type CaptureOwner } from "./captureJournal.ts"
import { PublicationPreparationError, type PublicationDraftView } from "./canonicalSourceProjection.ts"

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
export const sourceMetadataJson = (view: PublicationDraftView<unknown, unknown>, threads: Metadata["threads"]) => JSON.stringify({ threads,
  ...(view.sourceCheckpoint === undefined ? {} : { sourceCheckpoint: view.sourceCheckpoint, retainedThreadIds: view.target.retainedThreadIds ?? [],
    sourceFailures: view.sourceFailures ?? [], sourceFailuresTruncated: view.sourceFailuresTruncated ?? false }) })
