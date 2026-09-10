-- Activated receipts survive expiry and subsequent heads. The selected head
-- retains its body; unreachable old bodies are reclaimed in bounded parts.
ALTER TABLE canonical_publication_attempts
 DROP CONSTRAINT canonical_publication_attempts_state_check,
 ADD CONSTRAINT canonical_publication_attempts_state_check CHECK(state IN ('open','sealed','validating','validated','activated','rejected')),
 ADD COLUMN activation_json TEXT,
 ADD COLUMN published_observed_at TIMESTAMPTZ;
ALTER TABLE project_search_documents ADD COLUMN publication_head TEXT NOT NULL DEFAULT '',
 ADD COLUMN publication_descriptor TEXT NOT NULL DEFAULT '';
CREATE INDEX publication_sources_project ON canonical_publication_sources(project_id,session_id);
CREATE TABLE canonical_publication_projection_changes (
 id BIGINT PRIMARY KEY DEFAULT nextval('canonical_projection_changes_id_seq'),
 attempt_id UUID NOT NULL,
 event_id TEXT NOT NULL,
 kind TEXT NOT NULL DEFAULT 'event' CHECK(kind='event'),
 lease_owner TEXT,
 lease_until TIMESTAMPTZ,
 processed_at TIMESTAMPTZ,
 FOREIGN KEY(attempt_id,kind,event_id) REFERENCES canonical_publication_members(attempt_id,kind,record_id) ON DELETE CASCADE,
 UNIQUE(attempt_id,event_id)
);
CREATE INDEX publication_projection_pending ON canonical_publication_projection_changes(id) WHERE processed_at IS NULL;
CREATE INDEX publication_projection_attempt_pending ON canonical_publication_projection_changes(attempt_id,id) WHERE processed_at IS NULL;
-- Already validated candidates also acquire durable, still-invisible work.
INSERT INTO canonical_publication_projection_changes(attempt_id,event_id)
 SELECT attempt_id,record_id FROM canonical_publication_members WHERE kind='event';

-- These views are the selected-head read boundary. Fixed normalized format 1
-- is decoded without rerunning the ingestion converter or joining Raw data.
CREATE VIEW visible_canonical_events AS
 SELECT id, session_id, thread_id, source_key, revision, projection_revision, digest, source_order, event_index, order_fidelity, fidelity, raw_ref, adapter_version, schema_version, observed_at, received_at, ingest_seq, kind, author, occurred_at, text, tool_label, child_thread_id, tool_update_json FROM canonical_events
 UNION ALL
 SELECT j."ID" AS id,
 s.session_id AS session_id,
 j."ThreadID" AS thread_id,
 j."SourceKey" AS source_key,
 j."Revision" AS revision,
 j."ProjectionRevision" AS projection_revision,
 j."Digest" AS digest,
 j."SourceOrder" AS source_order,
 j."EventIndex" AS event_index,
 j."OrderFidelity" AS order_fidelity,
 j."Fidelity" AS fidelity,
 j."RawRef" AS raw_ref,
 j."AdapterVersion" AS adapter_version,
 j."SchemaVersion" AS schema_version,
 j."ObservedAt" AS observed_at,
 j."ReceivedAt" AS received_at,
 j."IngestSeq" AS ingest_seq,
 j."Kind" AS kind,
 j."Author" AS author,
 j."OccurredAt" AS occurred_at,
 j."Text" AS text,
 j."ToolLabel" AS tool_label,
 j."ChildThreadID" AS child_thread_id,
 coalesce(j."ToolUpdateJSON",'') AS tool_update_json
 FROM canonical_publication_sources s
 JOIN canonical_publication_parts p ON p.attempt_id=s.current_head::uuid AND p.format_version=1
 CROSS JOIN LATERAL jsonb_array_elements(convert_from(p.validated_body,'UTF8')::jsonb -> 'Events') WITH ORDINALITY AS item(value,entry_number)
 CROSS JOIN LATERAL jsonb_to_record(item.value)
 AS j("ID" text, "SessionID" text, "ThreadID" text, "SourceKey" text, "Revision" bigint, "ProjectionRevision" bigint, "Digest" text, "SourceOrder" bigint, "EventIndex" bigint, "OrderFidelity" text, "Fidelity" text, "RawRef" text, "AdapterVersion" text, "SchemaVersion" text, "ObservedAt" timestamptz, "ReceivedAt" timestamptz, "IngestSeq" bigint, "Kind" text, "Author" text, "OccurredAt" timestamptz, "Text" text, "ToolLabel" text, "ChildThreadID" text, "ToolUpdateJSON" text);

CREATE VIEW visible_canonical_threads AS
 SELECT session_id, id, source_key, revision, digest, label, summary, parent_thread_id, capture_status FROM canonical_threads
 UNION ALL
 SELECT s.session_id AS session_id,
 j."ID" AS id,
 j."SourceKey" AS source_key,
 j."Revision" AS revision,
 j."Digest" AS digest,
 j."Label" AS label,
 j."Summary" AS summary,
 j."ParentThreadID" AS parent_thread_id,
 j."CaptureStatus" AS capture_status
 FROM canonical_publication_sources s
 JOIN canonical_publication_parts p ON p.attempt_id=s.current_head::uuid AND p.ordinal=0 AND p.format_version=1
 CROSS JOIN LATERAL jsonb_to_recordset(convert_from(p.validated_body,'UTF8')::jsonb -> 'Threads')
 AS j("SessionID" text, "ID" text, "SourceKey" text, "Revision" bigint, "Digest" text, "Label" text, "Summary" text, "ParentThreadID" text, "CaptureStatus" text);

CREATE VIEW visible_canonical_usage AS
 SELECT source_key, session_id, thread_id, revision, digest, occurred_at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM canonical_usage
 UNION ALL
 SELECT j."SourceKey" AS source_key,
 s.session_id AS session_id,
 j."ThreadID" AS thread_id,
 j."Revision" AS revision,
 j."Digest" AS digest,
 j."OccurredAt" AS occurred_at,
 j."Model" AS model,
 j."InputTokens" AS input_tokens,
 j."OutputTokens" AS output_tokens,
 j."CacheReadTokens" AS cache_read_tokens,
 j."CacheWriteTokens" AS cache_write_tokens
 FROM canonical_publication_sources s
 JOIN canonical_publication_parts p ON p.attempt_id=s.current_head::uuid AND p.format_version=1
 CROSS JOIN LATERAL jsonb_array_elements(convert_from(p.validated_body,'UTF8')::jsonb -> 'Usage') WITH ORDINALITY AS item(value,entry_number)
 CROSS JOIN LATERAL jsonb_to_record(item.value)
 AS j("SourceKey" text, "SessionID" text, "ThreadID" text, "Revision" bigint, "Digest" text, "OccurredAt" timestamptz, "Model" text, "InputTokens" bigint, "OutputTokens" bigint, "CacheReadTokens" bigint, "CacheWriteTokens" bigint);
