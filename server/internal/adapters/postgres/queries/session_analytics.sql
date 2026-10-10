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
SELECT COALESCE(sum(source_bytes),0)::bigint AS source_bytes FROM (
 SELECT sum(octet_length(e.id)::bigint+octet_length(e.session_id)+octet_length(e.thread_id)+octet_length(e.source_key)
  +octet_length(e.order_fidelity)+octet_length(e.fidelity)+octet_length(e.kind)+octet_length(e.author)
  +octet_length(e.text)+octet_length(e.tool_update_json)+octet_length(e.tool_label)
  +octet_length(COALESCE(e.child_thread_id,''))+256) AS source_bytes
 FROM canonical_events e WHERE e.session_id=$1
 UNION ALL
 SELECT sum(octet_length(u.source_key)::bigint+octet_length(u.session_id)+octet_length(u.thread_id)+octet_length(u.model)+128)
 FROM canonical_usage u WHERE u.session_id=$1
 UNION ALL
 SELECT sum(octet_length(t.id)::bigint+octet_length(t.session_id)+octet_length(t.source_key)+octet_length(t.label)
  +octet_length(t.summary)+octet_length(COALESCE(t.parent_thread_id,''))+octet_length(t.capture_status)+128)
 FROM canonical_threads t WHERE t.session_id=$1
 UNION ALL
 SELECT sum(octet_length(s.id)::bigint+octet_length(s.project_id)+octet_length(COALESCE(s.captured_by_user_id::text,''))
  +octet_length(s.source_key)+octet_length(s.title)+octet_length(s.summary)+octet_length(s.insight)
  +octet_length(s.actor_name)+octet_length(s.actor_harness)+octet_length(s.branch)+octet_length(s.status)+octet_length(s.capture_status)+256)
 FROM canonical_sessions s WHERE s.id=$1
) AS facts;

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
