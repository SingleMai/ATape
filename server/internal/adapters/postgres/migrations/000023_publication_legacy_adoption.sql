-- Explicit adoption fences legacy writers without changing the selected read view.
ALTER TABLE canonical_publication_sources
 ADD COLUMN legacy_adopted BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN revision_floor BIGINT NOT NULL DEFAULT 0 CHECK(revision_floor>=0),
 ADD COLUMN baseline_threads_json TEXT;
CREATE INDEX canonical_thread_revision ON canonical_threads(session_id,revision DESC);
CREATE INDEX canonical_event_revision ON canonical_events(session_id,revision DESC);
CREATE INDEX canonical_event_projection_revision ON canonical_events(session_id,projection_revision DESC);
CREATE INDEX canonical_usage_revision ON canonical_usage(session_id,revision DESC);
-- Derived retention units never alter the frozen upload manifest or wire receipts.
ALTER TABLE canonical_publication_parts ADD COLUMN derived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE canonical_publication_attempts
 ADD COLUMN derived_parts INTEGER NOT NULL DEFAULT 0 CHECK(derived_parts>=0),
 ADD COLUMN retention_cursor TEXT NOT NULL DEFAULT '';
CREATE OR REPLACE VIEW visible_canonical_events AS
 SELECT id, session_id, thread_id, source_key, revision, projection_revision, digest, source_order, event_index, order_fidelity, fidelity, raw_ref, adapter_version, schema_version, observed_at, received_at, ingest_seq, kind, author, occurred_at, text, tool_label, child_thread_id, tool_update_json FROM canonical_events legacy
 WHERE NOT EXISTS (SELECT 1 FROM canonical_publication_sources selected WHERE selected.session_id=legacy.session_id AND selected.current_head IS NOT NULL)
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

CREATE OR REPLACE VIEW visible_canonical_threads AS
 SELECT session_id, id, source_key, revision, digest, label, summary, parent_thread_id, capture_status FROM canonical_threads legacy
 WHERE NOT EXISTS (SELECT 1 FROM canonical_publication_sources selected WHERE selected.session_id=legacy.session_id AND selected.current_head IS NOT NULL)
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

CREATE OR REPLACE VIEW visible_canonical_usage AS
 SELECT source_key, session_id, thread_id, revision, digest, occurred_at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM canonical_usage legacy
 WHERE NOT EXISTS (SELECT 1 FROM canonical_publication_sources selected WHERE selected.session_id=legacy.session_id AND selected.current_head IS NOT NULL)
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
