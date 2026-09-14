-- Native facts need the same body-free read path as publication facts. INCLUDE
-- columns let vacuumed history answer statistics without fetching Event bodies.
-- The ingestion Interface bounds author/model to 200 bytes and generates IDs.
CREATE INDEX canonical_events_overview_idx
 ON canonical_events(session_id, occurred_at)
 INCLUDE (id, thread_id, author, source_order, event_index)
 WHERE kind = 'message';

CREATE INDEX canonical_usage_overview_idx
 ON canonical_usage(session_id, occurred_at)
 INCLUDE (thread_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens);

-- The replacement indexes retain the original keys and predicates. Keep one
-- index per access path, rather than charging ingestion for redundant indexes.
DROP INDEX canonical_events_activity_idx;
DROP INDEX canonical_usage_session_time_idx;
