-- name: ListAnalyticsThreads :many
SELECT session_id,id,source_key,revision,digest,label,summary,parent_thread_id,capture_status
FROM visible_canonical_threads WHERE session_id=$1 ORDER BY id LIMIT $2;

-- name: ListAnalyticsNativeEvents :many
SELECT id,session_id,thread_id,source_key,revision,projection_revision,
 source_order,event_index,order_fidelity,fidelity,kind,author,occurred_at,tool_label,child_thread_id,
 encode(sha256(convert_to(text,'UTF8')),'hex')::text AS text_digest,
 encode(sha256(convert_to(tool_update_json,'UTF8')),'hex')::text AS tool_digest,
 CASE WHEN tool_update_json='' THEN '' ELSE (tool_update_json::jsonb - 'rawInput' - 'rawOutput')::text END::text AS tool_update_json
FROM canonical_events WHERE session_id=$1 ORDER BY id LIMIT $2;

-- name: AnalyticsNativeBytes :one
SELECT COALESCE(sum(octet_length(text)::bigint+octet_length(tool_update_json)+octet_length(tool_label)+256),0)::bigint AS source_bytes
FROM canonical_events WHERE session_id=$1;

-- name: ListAnalyticsNativeUsage :many
SELECT * FROM canonical_usage WHERE session_id=$1 ORDER BY source_key LIMIT $2;

-- name: ListAnalyticsPublicationMembers :many
SELECT kind,record_id,source_key,part_ordinal,entry_index
FROM canonical_publication_members
WHERE attempt_id=$1 AND kind IN ('event','usage')
ORDER BY part_ordinal,kind,entry_index LIMIT $2;

-- name: AnalyticsPublicationBytes :one
SELECT COALESCE(sum(p.stored_bytes),0)::bigint AS stored_bytes
FROM canonical_publication_parts p
WHERE p.attempt_id=$1 AND EXISTS (
 SELECT 1 FROM canonical_publication_members m WHERE m.attempt_id=p.attempt_id AND m.part_ordinal=p.ordinal AND m.kind IN ('event','usage')
);
