-- Unknown occurrence time is an explicit v3 fact, independent of observed and
-- received clocks. Other historical sentinels retain their recorded values.
ALTER TABLE canonical_sessions ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE canonical_events ALTER COLUMN occurred_at DROP NOT NULL;
ALTER TABLE canonical_event_versions ALTER COLUMN occurred_at DROP NOT NULL;
ALTER TABLE project_search_documents ALTER COLUMN occurred_at DROP NOT NULL;
ALTER TABLE overview_publication_messages ALTER COLUMN occurred_at DROP NOT NULL;

-- Older profiles could admit Go zero (or a sub-microsecond value which storage
-- truncated to zero). Normalize only that internal unknown marker, so persisted
-- Search ordering and its nullable cursor use the same meaning. Frozen bodies,
-- source digests, Usage and observation clocks remain unchanged.
UPDATE canonical_sessions SET updated_at=NULL
 WHERE updated_at='0001-01-01T00:00:00Z'::timestamptz;
UPDATE canonical_events SET occurred_at=NULL
 WHERE occurred_at='0001-01-01T00:00:00Z'::timestamptz;
UPDATE canonical_event_versions SET occurred_at=NULL
 WHERE occurred_at='0001-01-01T00:00:00Z'::timestamptz;
UPDATE project_search_documents SET occurred_at=NULL
 WHERE occurred_at='0001-01-01T00:00:00Z'::timestamptz;
UPDATE overview_publication_messages SET occurred_at=NULL
 WHERE occurred_at='0001-01-01T00:00:00Z'::timestamptz;

DROP INDEX project_search_message_page_idx;
CREATE INDEX project_search_message_page_idx
 ON project_search_documents(project_id,occurred_at DESC NULLS LAST,event_id DESC)
 WHERE event_kind='message';
