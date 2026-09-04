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
           events.occurred_at, events.text, events.tool_label,
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
       requested.event_id, requested.author, requested.harness,
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

-- name: UpsertSearchDocument :exec
INSERT INTO project_search_documents (
    event_id, project_id, session_id, session_title, thread_id,
    thread_path_ids, thread_path_labels, author, harness, occurred_at,
    text, tool_label, ingest_seq, observed_at, search_text
) VALUES (
    sqlc.arg(event_id), sqlc.arg(project_id), sqlc.arg(session_id),
    sqlc.arg(session_title), sqlc.arg(thread_id), sqlc.arg(thread_path_ids),
    sqlc.arg(thread_path_labels), sqlc.arg(author), sqlc.arg(harness),
    sqlc.arg(occurred_at), sqlc.arg(text), sqlc.arg(tool_label),
    sqlc.arg(ingest_seq), sqlc.arg(observed_at),
    lower(
        sqlc.arg(session_title)::text || ' ' ||
        array_to_string(sqlc.arg(thread_path_labels)::text[], ' ') || ' ' ||
        sqlc.arg(author)::text || ' ' || sqlc.arg(harness)::text || ' ' ||
        sqlc.arg(text)::text || ' ' || sqlc.arg(tool_label)::text
    )
)
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
    indexed_at = clock_timestamp(),
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
SELECT indexed_through
FROM project_search_checkpoints
WHERE project_id = $1;

-- name: SearchDocuments :many
WITH terms AS (
    SELECT lower(sqlc.arg(term)::text) AS literal,
           websearch_to_tsquery('simple'::regconfig, sqlc.arg(term)::text) AS parsed
), matches AS (
    SELECT documents.event_id, documents.project_id, documents.session_id,
           documents.session_title, documents.thread_id,
           documents.thread_path_ids, documents.thread_path_labels,
           documents.author, documents.harness, documents.occurred_at,
           documents.text, documents.tool_label, documents.ingest_seq,
           documents.observed_at,
           (strpos(documents.search_text, terms.literal) > 0) AS literal_match,
           ts_rank_cd(documents.search_vector, terms.parsed) AS text_rank
    FROM project_search_documents documents
    CROSS JOIN terms
    WHERE documents.project_id = sqlc.arg(project_id)
      AND (
          strpos(documents.search_text, terms.literal) > 0
          OR documents.search_vector @@ terms.parsed
      )
), ranked AS (
    SELECT matches.*, count(*) OVER ()::bigint AS total_count
    FROM matches
)
SELECT event_id, project_id, session_id, session_title, thread_id,
       thread_path_ids, thread_path_labels, author, harness, occurred_at,
       text, tool_label, ingest_seq, observed_at, total_count
FROM ranked
ORDER BY literal_match DESC, text_rank DESC, occurred_at DESC, event_id
LIMIT sqlc.arg(result_limit)
OFFSET sqlc.arg(result_offset);
