import { Schema } from "effect"

export const SearchThreadPathItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String
})
export type SearchThreadPathItem = typeof SearchThreadPathItem.Type

export const SearchResult = Schema.Struct({
  eventId: Schema.String,
  sessionId: Schema.String,
  sessionTitle: Schema.String,
  threadId: Schema.String,
  threadPath: Schema.Array(SearchThreadPathItem),
  author: Schema.String,
  harness: Schema.String,
  occurredAt: Schema.String,
  text: Schema.String,
  toolLabel: Schema.optionalKey(Schema.String)
})
export type SearchResult = typeof SearchResult.Type

export const SearchPage = Schema.Struct({
  projectId: Schema.String,
  query: Schema.String,
  indexedThrough: Schema.optionalKey(Schema.String),
  results: Schema.Array(SearchResult),
  nextCursor: Schema.optionalKey(Schema.String)
})
export type SearchPage = typeof SearchPage.Type
