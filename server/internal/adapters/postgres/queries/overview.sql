-- name: OverviewTeam :one
SELECT t.id,t.name,COALESCE(m.role,'')::text AS role,COALESCE(m.status,'')::text AS membership_status
FROM workspace_teams t LEFT JOIN team_memberships m ON m.team_id=t.id AND m.user_id=sqlc.arg(user_id)
WHERE t.id=sqlc.arg(team_id);

-- name: OverviewMembers :many
SELECT m.user_id::text AS id,u.display_name AS name,(m.status='active')::boolean AS current
FROM team_memberships m JOIN auth_users u ON u.id=m.user_id
WHERE m.team_id=$1 ORDER BY u.display_name,m.user_id LIMIT 100001;

-- name: OverviewProjects :many
SELECT id,team_id,name,project_type,state FROM canonical_projects WHERE team_id=$1 AND state<>'deleted' ORDER BY name,id LIMIT 100001;

-- name: OverviewSessions :many
SELECT s.id,s.project_id,s.captured_by_user_id,s.title,s.actor_name,s.actor_harness
FROM canonical_sessions s JOIN canonical_projects p ON p.id=s.project_id
WHERE p.team_id=$1 AND p.state<>'deleted' AND s.record_state='active' ORDER BY s.id LIMIT 100001;

-- name: OverviewEvents :many
-- Only uncovered parts decode bodies. Every validated part carries the same
-- complete topology, so mixed covered/uncovered parts need no header-body read.
WITH selected_parts AS MATERIALIZED (
 SELECT source.session_id,p.ordinal,convert_from(p.validated_body,'UTF8')::jsonb AS body
 FROM canonical_publication_sources source
 JOIN canonical_publication_parts p ON p.attempt_id=source.current_head::uuid AND p.format_version=1
 WHERE source.session_id=ANY(sqlc.arg(session_ids)::text[]) AND p.overview_version IS DISTINCT FROM 1
), fallback_events AS MATERIALIZED (
 SELECT (j.value->>'ID')::text AS id,p.session_id,p.ordinal,(j.value->>'ThreadID')::text AS thread_id,
 (j.value->>'Author')::text AS author,(j.value->>'OccurredAt')::timestamptz AS occurred_at,
 (j.value->>'SourceOrder')::bigint AS source_order,(j.value->>'EventIndex')::bigint AS event_index
 FROM selected_parts p CROSS JOIN LATERAL jsonb_array_elements(p.body->'Events') AS j(value)
 WHERE j.value->>'Kind'='message' AND (j.value->>'OccurredAt')::timestamptz>=sqlc.arg(from_time)::timestamptz
 AND (j.value->>'OccurredAt')::timestamptz<sqlc.arg(until_time)::timestamptz
), fallback_threads AS MATERIALIZED (
 SELECT p.session_id,p.ordinal,(j.value->>'ID')::text AS id,(j.value->>'ParentThreadID')::text AS parent_thread_id
 FROM selected_parts p CROSS JOIN LATERAL jsonb_array_elements(p.body->'Threads') AS j(value)
), events AS (
 SELECT e.id,e.session_id,e.author,e.occurred_at,e.source_order,e.event_index,(t.parent_thread_id IS NULL)::boolean AS root
 FROM canonical_events e JOIN canonical_threads t ON t.session_id=e.session_id AND t.id=e.thread_id
 WHERE e.session_id=ANY(sqlc.arg(session_ids)::text[]) AND e.kind='message'
 AND e.occurred_at>=sqlc.arg(from_time)::timestamptz AND e.occurred_at<sqlc.arg(until_time)::timestamptz
 UNION ALL
 SELECT m.event_id,source.session_id,m.author,m.occurred_at,m.source_order,m.event_index,m.root
 FROM canonical_publication_sources source
 JOIN overview_publication_messages m ON m.attempt_id=source.current_head::uuid
 JOIN canonical_publication_parts p ON p.attempt_id=m.attempt_id AND p.ordinal=m.part_ordinal AND p.overview_version=1
 WHERE source.session_id=ANY(sqlc.arg(session_ids)::text[])
 AND m.occurred_at>=sqlc.arg(from_time)::timestamptz AND m.occurred_at<sqlc.arg(until_time)::timestamptz
 UNION ALL
 SELECT e.id,e.session_id,e.author,e.occurred_at,e.source_order,e.event_index,(t.parent_thread_id IS NULL)::boolean
 FROM fallback_events e JOIN fallback_threads t ON t.session_id=e.session_id AND t.ordinal=e.ordinal AND t.id=e.thread_id
)
SELECT e.id,e.session_id,e.author,e.occurred_at,e.source_order,e.event_index,e.root
FROM events e WHERE NOT sqlc.arg(model_filtered)::boolean
 OR (e.occurred_at>=sqlc.arg(period_from)::timestamptz AND e.session_id=ANY(sqlc.arg(current_model_sessions)::text[]))
 OR (e.occurred_at<sqlc.arg(period_from)::timestamptz AND e.session_id=ANY(sqlc.arg(previous_model_sessions)::text[]))
LIMIT 100001;

-- name: OverviewUsage :many
WITH selected_parts AS MATERIALIZED (
 SELECT source.session_id,convert_from(p.validated_body,'UTF8')::jsonb AS body
 FROM canonical_publication_sources source
 JOIN canonical_publication_parts p ON p.attempt_id=source.current_head::uuid AND p.format_version=1
 WHERE source.session_id=ANY(sqlc.arg(session_ids)::text[]) AND p.overview_version IS DISTINCT FROM 1
), usage AS (
 SELECT session_id,thread_id,occurred_at,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens
 FROM canonical_usage WHERE session_id=ANY(sqlc.arg(session_ids)::text[])
 UNION ALL
 SELECT source.session_id,u.thread_id,u.occurred_at,u.model,u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_write_tokens
 FROM canonical_publication_sources source JOIN overview_publication_usage u ON u.attempt_id=source.current_head::uuid
 JOIN canonical_publication_parts p ON p.attempt_id=u.attempt_id AND p.ordinal=u.part_ordinal AND p.overview_version=1
 WHERE source.session_id=ANY(sqlc.arg(session_ids)::text[])
 UNION ALL
 SELECT p.session_id,j."ThreadID",j."OccurredAt",j."Model",j."InputTokens",j."OutputTokens",j."CacheReadTokens",j."CacheWriteTokens"
 FROM selected_parts p CROSS JOIN LATERAL jsonb_to_recordset(p.body->'Usage')
 AS j("ThreadID" text,"OccurredAt" timestamptz,"Model" text,"InputTokens" bigint,"OutputTokens" bigint,"CacheReadTokens" bigint,"CacheWriteTokens" bigint)
)
SELECT session_id,thread_id,occurred_at,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens
FROM usage WHERE occurred_at>=sqlc.arg(from_time)::timestamptz AND occurred_at<sqlc.arg(until_time)::timestamptz
AND (NOT sqlc.arg(model_filtered)::boolean OR model=sqlc.arg(model_name)::text)
LIMIT 100001;

-- name: OverviewModels :many
-- The option directory retains models outside the active dimensions without
-- transferring their usage records to the application.
SELECT DISTINCT model FROM (
 SELECT u.model FROM canonical_usage u JOIN canonical_sessions s ON s.id=u.session_id
 JOIN canonical_projects p ON p.id=s.project_id
 WHERE p.team_id=sqlc.arg(team_id) AND p.state<>'deleted' AND s.record_state='active'
 AND u.occurred_at>=sqlc.arg(from_time)::timestamptz AND u.occurred_at<sqlc.arg(until_time)::timestamptz
 UNION ALL
 SELECT u.model FROM canonical_publication_sources source
 JOIN canonical_sessions s ON s.id=source.session_id JOIN canonical_projects p ON p.id=s.project_id
 JOIN overview_publication_usage u ON u.attempt_id=source.current_head::uuid
 JOIN canonical_publication_parts part ON part.attempt_id=u.attempt_id AND part.ordinal=u.part_ordinal AND part.overview_version=1
 WHERE p.team_id=sqlc.arg(team_id) AND p.state<>'deleted' AND s.record_state='active'
 AND u.occurred_at>=sqlc.arg(from_time)::timestamptz AND u.occurred_at<sqlc.arg(until_time)::timestamptz
 UNION ALL
 SELECT j."Model" AS model FROM canonical_publication_sources source
 JOIN canonical_sessions s ON s.id=source.session_id JOIN canonical_projects p ON p.id=s.project_id
 JOIN canonical_publication_parts part ON part.attempt_id=source.current_head::uuid AND part.format_version=1 AND part.overview_version IS DISTINCT FROM 1
 CROSS JOIN LATERAL jsonb_to_recordset(convert_from(part.validated_body,'UTF8')::jsonb->'Usage') AS j("Model" text,"OccurredAt" timestamptz)
 WHERE p.team_id=sqlc.arg(team_id) AND p.state<>'deleted' AND s.record_state='active'
 AND j."OccurredAt">=sqlc.arg(from_time)::timestamptz AND j."OccurredAt"<sqlc.arg(until_time)::timestamptz
) models ORDER BY model LIMIT 100001;

-- name: OverviewUnknownTimes :one
-- Indexed facts and a narrow fallback retain Team-wide disclosure.
SELECT count(DISTINCT session_id)::bigint FROM (
 SELECT e.session_id FROM canonical_events e
 JOIN canonical_sessions s ON s.id=e.session_id JOIN canonical_projects p ON p.id=s.project_id
 WHERE p.team_id=sqlc.arg(team_id) AND p.state<>'deleted' AND s.record_state='active'
 AND e.kind='message' AND e.occurred_at<'2000-01-01'::timestamptz
 UNION ALL
 SELECT source.session_id FROM canonical_publication_sources source
 JOIN canonical_sessions s ON s.id=source.session_id JOIN canonical_projects p ON p.id=s.project_id
 JOIN overview_publication_messages m ON m.attempt_id=source.current_head::uuid
 JOIN canonical_publication_parts part ON part.attempt_id=m.attempt_id AND part.ordinal=m.part_ordinal AND part.overview_version=1
 WHERE p.team_id=sqlc.arg(team_id) AND p.state<>'deleted' AND s.record_state='active'
 AND m.occurred_at<'2000-01-01'::timestamptz
 UNION ALL
 SELECT source.session_id FROM canonical_publication_sources source
 JOIN canonical_sessions s ON s.id=source.session_id JOIN canonical_projects p ON p.id=s.project_id
 JOIN canonical_publication_parts part ON part.attempt_id=source.current_head::uuid AND part.format_version=1 AND part.overview_version IS DISTINCT FROM 1
 CROSS JOIN LATERAL jsonb_to_recordset(convert_from(part.validated_body,'UTF8')::jsonb->'Events')
 AS j("Kind" text,"OccurredAt" timestamptz)
 WHERE p.team_id=sqlc.arg(team_id) AND p.state<>'deleted' AND s.record_state='active'
 AND j."Kind"='message' AND j."OccurredAt"<'2000-01-01'::timestamptz
) unknown_messages;

-- name: OverviewPreviews :many
-- Membership locates exact current-head parts before decoding any body. A part
-- containing several selected Events is decoded once, then indexed directly.
WITH selected_members AS MATERIALIZED (
 SELECT m.attempt_id,m.part_ordinal,m.entry_index,m.record_id,s.actor_name
 FROM canonical_publication_sources source
 JOIN canonical_sessions s ON s.id=source.session_id
 JOIN canonical_publication_members m ON m.attempt_id=source.current_head::uuid AND m.kind='event'
 WHERE source.session_id=ANY(sqlc.arg(session_ids)::text[])
 AND m.record_id=ANY(sqlc.arg(event_ids)::text[])
), selected_parts AS MATERIALIZED (
 SELECT p.attempt_id,p.ordinal,convert_from(p.validated_body,'UTF8')::jsonb AS body
 FROM canonical_publication_parts p
 JOIN (SELECT DISTINCT attempt_id,part_ordinal FROM selected_members) selected
 ON selected.attempt_id=p.attempt_id AND selected.part_ordinal=p.ordinal
 WHERE p.format_version=1
)
SELECT e.id,CASE WHEN e.author=s.actor_name THEN left(e.text,1500) ELSE right(e.text,1500) END::text AS text
FROM canonical_events e JOIN canonical_sessions s ON s.id=e.session_id
WHERE e.id=ANY(sqlc.arg(event_ids)::text[]) AND e.session_id=ANY(sqlc.arg(session_ids)::text[])
UNION ALL
SELECT m.record_id AS id,
CASE WHEN p.body->'Events'->m.entry_index->>'Author'=m.actor_name
 THEN left(p.body->'Events'->m.entry_index->>'Text',1500)
 ELSE right(p.body->'Events'->m.entry_index->>'Text',1500) END::text AS text
FROM selected_members m JOIN selected_parts p ON p.attempt_id=m.attempt_id AND p.ordinal=m.part_ordinal;
