import { Schema } from "effect"

export const RawObject = Schema.Struct({
  objectId: Schema.String,
  projectId: Schema.String,
  sessionId: Schema.String,
  sourceName: Schema.String,
  mediaType: Schema.String,
  adapterId: Schema.String,
  adapterVersion: Schema.String,
  capturedAt: Schema.String,
  clientRedacted: Schema.Boolean,
  currentGeneration: Schema.Number,
  generationCount: Schema.Number,
  currentSizeBytes: Schema.Number,
  currentFinalized: Schema.Boolean
})
export type RawObject = typeof RawObject.Type

export const SessionRawArchive = Schema.Struct({
  sessionId: Schema.String,
  objects: Schema.Array(RawObject)
})
export type SessionRawArchive = typeof SessionRawArchive.Type

export const RawContentChunk = Schema.Struct({
  offset: Schema.Number,
  sizeBytes: Schema.Number,
  sha256: Schema.String,
  contentBase64: Schema.String
})
export type RawContentChunk = typeof RawContentChunk.Type

export const RawContentPage = Schema.Struct({
  objectId: Schema.String,
  generation: Schema.Number,
  sizeBytes: Schema.Number,
  finalized: Schema.Boolean,
  chunks: Schema.Array(RawContentChunk),
  nextCursor: Schema.optionalKey(Schema.String)
})
export type RawContentPage = typeof RawContentPage.Type
