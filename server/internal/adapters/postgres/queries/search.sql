-- name: ClaimProjectionChanges :many
WITH candidates AS (
    SELECT id
    FROM canonical_projection_changes
    WHERE processed_at IS NULL
      AND (lease_until IS NULL OR lease_until <= clock_timestamp())
    ORDER BY id
    LIMIT sqlc.arg(batch_limit)
    FOR UPDATE SKIP LOCKED
)
UPDATE canonical_projection_changes AS changes
SET lease_owner = sqlc.arg(lease_owner),
    lease_until = sqlc.arg(lease_until),
    attempts = attempts + 1
FROM candidates
WHERE changes.id = candidates.id
RETURNING changes.id;

-- name: LoadProjectionChanges :many
WITH RECURSIVE requested AS (
    SELECT changes.id AS change_id, events.id AS event_id,
           events.session_id, events.thread_id, events.author,
           events.occurred_at, events.text, events.tool_label, events.kind,
           events.ingest_seq, events.observed_at,
           sessions.project_id, sessions.title AS session_title,
           sessions.actor_harness AS harness
    FROM canonical_projection_changes changes
    JOIN canonical_events events ON events.id = changes.event_id
    JOIN canonical_sessions sessions ON sessions.id = events.session_id
    WHERE changes.id = ANY(sqlc.arg(change_ids)::bigint[])
      AND changes.lease_owner = sqlc.arg(lease_owner)
), lineage AS (
    SELECT requested.change_id, threads.session_id, threads.id,
           threads.label, threads.parent_thread_id, 0 AS depth
    FROM requested
    JOIN canonical_threads threads
      ON threads.session_id = requested.session_id
     AND threads.id = requested.thread_id
    UNION ALL
    SELECT lineage.change_id, parent.session_id, parent.id,
           parent.label, parent.parent_thread_id, lineage.depth + 1
    FROM lineage
    JOIN canonical_threads parent
      ON parent.session_id = lineage.session_id
     AND parent.id = lineage.parent_thread_id
), paths AS (
    SELECT change_id,
           array_agg(id ORDER BY depth DESC)::text[] AS thread_path_ids,
           array_agg(label ORDER BY depth DESC)::text[] AS thread_path_labels
    FROM lineage
    GROUP BY change_id
)
SELECT requested.change_id, requested.project_id, requested.session_id,
       requested.session_title, requested.thread_id,
       paths.thread_path_ids, paths.thread_path_labels,
       requested.event_id, requested.author, requested.harness, requested.kind,
       requested.occurred_at, requested.text, requested.tool_label,
       requested.ingest_seq, requested.observed_at
FROM requested
JOIN paths ON paths.change_id = requested.change_id
ORDER BY requested.change_id;

-- name: AckProjectionChanges :exec
UPDATE canonical_projection_changes
SET processed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_until = NULL
WHERE id = ANY(sqlc.arg(change_ids)::bigint[])
  AND lease_owner = sqlc.arg(lease_owner);

-- name: UpsertSearchDocument :execrows
INSERT INTO project_search_documents (
    event_id, project_id, session_id, session_title, thread_id,
    thread_path_ids, thread_path_labels, author, harness, occurred_at,
    text, tool_label, ingest_seq, observed_at, publication_head, publication_descriptor, event_kind, search_text
) SELECT
    sqlc.arg(event_id), sqlc.arg(project_id), sqlc.arg(session_id),
    sqlc.arg(session_title), sqlc.arg(thread_id), sqlc.arg(thread_path_ids),
    sqlc.arg(thread_path_labels), sqlc.arg(author), sqlc.arg(harness),
    sqlc.arg(occurred_at), CASE WHEN sqlc.arg(event_kind)::text='message' THEN sqlc.arg(text)::text ELSE '' END, '',
    sqlc.arg(ingest_seq), sqlc.arg(observed_at), sqlc.arg(publication_head), sqlc.arg(publication_descriptor),
    sqlc.arg(event_kind),
    CASE WHEN sqlc.arg(event_kind)::text='message' THEN lower(sqlc.arg(text)::text) ELSE '' END
WHERE (sqlc.arg(publication_head)::text='' AND NOT EXISTS(
 SELECT 1 FROM canonical_publication_sources WHERE session_id=sqlc.arg(session_id)))
 OR EXISTS(SELECT 1 FROM canonical_publication_sources s
 JOIN canonical_publication_members m ON m.attempt_id=s.current_head::uuid AND m.kind='event'
 JOIN canonical_sessions cs ON cs.id=s.session_id AND cs.record_state='active'
 WHERE s.session_id=sqlc.arg(session_id) AND s.current_head=sqlc.arg(publication_head)
 AND m.record_id=sqlc.arg(event_id) AND m.search_descriptor=sqlc.arg(publication_descriptor))
ON CONFLICT (event_id) DO UPDATE
SET project_id = EXCLUDED.project_id,
    session_id = EXCLUDED.session_id,
    session_title = EXCLUDED.session_title,
    thread_id = EXCLUDED.thread_id,
    thread_path_ids = EXCLUDED.thread_path_ids,
    thread_path_labels = EXCLUDED.thread_path_labels,
    author = EXCLUDED.author,
    harness = EXCLUDED.harness,
    occurred_at = EXCLUDED.occurred_at,
    text = EXCLUDED.text,
    tool_label = EXCLUDED.tool_label,
    ingest_seq = EXCLUDED.ingest_seq,
    observed_at = EXCLUDED.observed_at,
    publication_head = EXCLUDED.publication_head,
    publication_descriptor = EXCLUDED.publication_descriptor,
    indexed_at = clock_timestamp(),
    event_kind = EXCLUDED.event_kind,
    search_text = EXCLUDED.search_text
WHERE project_search_documents.ingest_seq <= EXCLUDED.ingest_seq;

-- name: AdvanceSearchCheckpoint :exec
INSERT INTO project_search_checkpoints (project_id, indexed_through)
VALUES ($1, $2)
ON CONFLICT (project_id) DO UPDATE
SET indexed_through = GREATEST(
    project_search_checkpoints.indexed_through,
    EXCLUDED.indexed_through
);

-- name: GetSearchCheckpoint :one
SELECT CASE WHEN EXISTS(
 SELECT 1 FROM canonical_publication_sources s
 JOIN canonical_sessions cs ON cs.id=s.session_id AND cs.record_state='active'
 JOIN canonical_publication_members m ON m.attempt_id=s.current_head::uuid AND m.kind='event'
 WHERE s.project_id=$1 AND NOT EXISTS(SELECT 1 FROM project_search_documents d
  WHERE d.event_id=m.record_id AND d.publication_descriptor=m.search_descriptor)
) THEN '0001-01-01T00:00:00Z'::timestamptz ELSE GREATEST(
 coalesce((SELECT indexed_through FROM project_search_checkpoints WHERE project_id=$1),'0001-01-01T00:00:00Z'::timestamptz),
 coalesce((SELECT max(a.published_observed_at) FROM canonical_publication_sources s
  JOIN canonical_publication_attempts a ON a.id=s.current_head::uuid
  JOIN canonical_sessions cs ON cs.id=s.session_id AND cs.record_state='active'
  WHERE s.project_id=$1),'0001-01-01T00:00:00Z'::timestamptz)
) END::timestamptz AS indexed_through;

-- name: AdvanceCompletedPublicationSearchCheckpoints :exec
INSERT INTO project_search_checkpoints(project_id,indexed_through)
SELECT s.project_id,max(a.published_observed_at)
FROM canonical_publication_sources s
JOIN canonical_publication_attempts a ON a.id=s.current_head::uuid AND a.state='activated'
JOIN canonical_sessions cs ON cs.id=s.session_id AND cs.record_state='active'
WHERE s.project_id=ANY(sqlc.arg(project_ids)::text[])
 AND NOT EXISTS(SELECT 1 FROM canonical_publication_sources pending
  JOIN canonical_sessions pcs ON pcs.id=pending.session_id AND pcs.record_state='active'
  JOIN canonical_publication_members m ON m.attempt_id=pending.current_head::uuid AND m.kind='event'
  WHERE pending.project_id=s.project_id AND NOT EXISTS(SELECT 1 FROM project_search_documents d
   WHERE d.event_id=m.record_id AND d.publication_descriptor=m.search_descriptor))
GROUP BY s.project_id
ON CONFLICT(project_id) DO UPDATE SET indexed_through=GREATEST(project_search_checkpoints.indexed_through,EXCLUDED.indexed_through);

-- name: ConfigureSearchQuery :exec
SELECT set_config('jit','off',true), set_config('plan_cache_mode','force_custom_plan',true);

-- name: SearchDocuments :many
WITH terms AS (
 SELECT lower(sqlc.arg(term)::text) AS literal,
 search_body_grams(lower(sqlc.arg(term)::text), least(3,length(lower(sqlc.arg(term)::text))),3) AS grams
), selected AS MATERIALIZED (
 SELECT d.event_id, d.occurred_at
 FROM project_search_documents d CROSS JOIN terms
 WHERE d.project_id=sqlc.arg(project_id) AND d.event_kind='message'
 AND d.body_grams @> terms.grams AND strpos(d.search_text,terms.literal)>0
 AND (NOT sqlc.arg(has_after)::boolean OR
      (d.occurred_at,d.event_id)<(sqlc.arg(after_time)::timestamptz,sqlc.arg(after_id)::text))
 AND EXISTS(SELECT 1 FROM canonical_sessions s WHERE s.id=d.session_id AND s.record_state='active')
 AND (NOT EXISTS(SELECT 1 FROM canonical_publication_sources s WHERE s.session_id=d.session_id)
  OR EXISTS(SELECT 1 FROM canonical_publication_sources s
   JOIN canonical_publication_members m ON m.attempt_id=s.current_head::uuid AND m.kind='event'
   WHERE s.session_id=d.session_id AND m.record_id=d.event_id AND m.search_descriptor=d.publication_descriptor))
 ORDER BY d.occurred_at DESC,d.event_id DESC
 LIMIT sqlc.arg(result_limit)
)
SELECT d.event_id,d.project_id,d.session_id,d.session_title,d.thread_id,
 d.thread_path_ids,d.thread_path_labels,d.author,d.harness,d.occurred_at,
 substring(d.text FROM greatest(1,strpos(d.search_text,terms.literal)-120) FOR 640)::text AS text,
 d.ingest_seq,d.observed_at
FROM selected JOIN project_search_documents d USING(event_id) CROSS JOIN terms
ORDER BY selected.occurred_at DESC,selected.event_id DESC;
