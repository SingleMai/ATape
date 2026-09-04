-- name: AcquireCanonicalLock :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(lock_key)::text, 0));

-- name: GetBatchReceipt :one
SELECT batch_key, digest, session_id, session_created, inserted_events,
       updated_events, unchanged_events, stale_events
FROM canonical_batch_receipts
WHERE batch_key = $1;

-- name: InsertBatchReceipt :exec
INSERT INTO canonical_batch_receipts (
    batch_key, digest, session_id, session_created, inserted_events,
    updated_events, unchanged_events, stale_events
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: InsertProject :exec
INSERT INTO canonical_projects (id, team_id, name, project_type)
VALUES ($1, $2, $3, $4)
ON CONFLICT (id) DO NOTHING;

-- name: RegisterTeam :exec
INSERT INTO workspace_teams (id, name, name_reported)
VALUES ($1, $2, TRUE)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    name_reported = TRUE
WHERE workspace_teams.name_reported = FALSE;

-- name: GetTeam :one
SELECT id, name
FROM workspace_teams
WHERE id = $1;

-- name: GetProject :one
SELECT id, team_id, name, captured_through, project_type
FROM canonical_projects
WHERE id = $1;

-- name: AdvanceProjectCapture :exec
UPDATE canonical_projects
SET captured_through = GREATEST(captured_through, sqlc.arg(observed_at)::timestamptz)
WHERE id = sqlc.arg(project_id);

-- name: GetSessionForUpdate :one
SELECT id, project_id, source_key, revision, digest, title, summary, insight,
       actor_name, actor_harness, branch, status, capture_status, updated_at,
       reported_event_count
FROM canonical_sessions
WHERE id = $1
FOR UPDATE;

-- name: InsertSession :exec
INSERT INTO canonical_sessions (
    id, project_id, source_key, revision, digest, title, summary, insight,
    actor_name, actor_harness, branch, status, capture_status, updated_at,
    reported_event_count
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8,
    $9, $10, $11, $12, $13, $14, $15
);

-- name: UpdateSession :exec
UPDATE canonical_sessions
SET revision = $2,
    digest = $3,
    title = $4,
    summary = $5,
    insight = $6,
    actor_name = $7,
    actor_harness = $8,
    branch = $9,
    status = $10,
    capture_status = $11,
    updated_at = $12,
    reported_event_count = $13
WHERE id = $1 AND revision < $2;

-- name: GetThreadForUpdate :one
SELECT session_id, id, source_key, revision, digest, label, summary,
       parent_thread_id, capture_status
FROM canonical_threads
WHERE session_id = $1 AND id = $2
FOR UPDATE;

-- name: InsertThread :exec
INSERT INTO canonical_threads (
    session_id, id, source_key, revision, digest, label, summary,
    parent_thread_id, capture_status
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- name: UpdateThread :exec
UPDATE canonical_threads
SET revision = $3,
    digest = $4,
    label = $5,
    summary = $6,
    capture_status = $7
WHERE session_id = $1 AND id = $2 AND revision < $3;

-- name: GetEventBySourceForUpdate :one
SELECT id, session_id, thread_id, source_key, revision, projection_revision,
       digest, source_order, event_index, order_fidelity, fidelity, raw_ref,
       adapter_version, schema_version, observed_at, received_at, ingest_seq,
       kind, author, occurred_at, text, tool_label, child_thread_id
FROM canonical_events
WHERE source_key = $1
FOR UPDATE;

-- name: GetEventByIDForUpdate :one
SELECT id, session_id, thread_id, source_key, revision, projection_revision,
       digest, source_order, event_index, order_fidelity, fidelity, raw_ref,
       adapter_version, schema_version, observed_at, received_at, ingest_seq,
       kind, author, occurred_at, text, tool_label, child_thread_id
FROM canonical_events
WHERE id = $1
FOR UPDATE;

-- name: NextIngestMetadata :one
SELECT nextval('canonical_ingest_seq')::bigint AS ingest_seq,
       clock_timestamp()::timestamptz AS received_at;

-- name: InsertEvent :exec
INSERT INTO canonical_events (
    id, session_id, thread_id, source_key, revision, projection_revision,
    digest, source_order, event_index, order_fidelity, fidelity, raw_ref,
    adapter_version, schema_version, observed_at, received_at, ingest_seq,
    kind, author, occurred_at, text, tool_label, child_thread_id
) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10, $11, $12,
    $13, $14, $15, $16, $17,
    $18, $19, $20, $21, $22, $23
);

-- name: UpdateEvent :exec
UPDATE canonical_events
SET revision = $2,
    projection_revision = $3,
    digest = $4,
    source_order = $5,
    event_index = $6,
    order_fidelity = $7,
    fidelity = $8,
    raw_ref = $9,
    adapter_version = $10,
    schema_version = $11,
    observed_at = $12,
    received_at = $13,
    ingest_seq = $14,
    kind = $15,
    author = $16,
    occurred_at = $17,
    text = $18,
    tool_label = $19,
    child_thread_id = $20
WHERE id = $1;

-- name: InsertEventVersion :exec
INSERT INTO canonical_event_versions (
    source_key, projection_revision, revision, event_id, session_id, thread_id,
    digest, source_order, event_index, order_fidelity, fidelity, raw_ref,
    adapter_version, schema_version, observed_at, received_at, ingest_seq,
    kind, author, occurred_at, text, tool_label, child_thread_id
) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10, $11, $12,
    $13, $14, $15, $16, $17,
    $18, $19, $20, $21, $22, $23
);

-- name: InsertProjectionChange :exec
INSERT INTO canonical_projection_changes (event_id, event_ingest_seq, observed_at)
VALUES ($1, $2, $3);

-- name: GetProjectForRead :one
SELECT id, team_id, name, captured_through, project_type
FROM canonical_projects
WHERE id = $1;

-- name: ListProjectSessions :many
SELECT s.id, s.project_id, s.source_key, s.revision, s.digest, s.title,
       s.summary, s.insight, s.actor_name, s.actor_harness, s.branch,
       s.status, s.capture_status, s.updated_at, s.reported_event_count,
       GREATEST(
           s.reported_event_count,
           (SELECT COUNT(*) FROM canonical_events e WHERE e.session_id = s.id)
       )::bigint AS event_count,
       (
           SELECT COUNT(*)
           FROM canonical_threads child
           WHERE child.session_id = s.id AND child.parent_thread_id IS NOT NULL
       )::bigint AS child_thread_count
FROM canonical_sessions s
WHERE s.project_id = $1
ORDER BY s.updated_at DESC, s.id;

-- name: GetSessionForRead :one
SELECT id, project_id, source_key, revision, digest, title, summary, insight,
       actor_name, actor_harness, branch, status, capture_status, updated_at,
       reported_event_count
FROM canonical_sessions
WHERE id = $1;

-- name: GetThreadForRead :one
SELECT session_id, id, source_key, revision, digest, label, summary,
       parent_thread_id, capture_status
FROM canonical_threads
WHERE session_id = $1 AND id = $2;

-- name: ListSessionThreads :many
SELECT t.session_id, t.id, t.source_key, t.revision, t.digest, t.label,
       t.summary, t.parent_thread_id, t.capture_status,
       COUNT(e.id)::bigint AS event_count
FROM canonical_threads t
LEFT JOIN canonical_events e
       ON e.session_id = t.session_id AND e.thread_id = t.id
WHERE t.session_id = $1
GROUP BY t.session_id, t.id
ORDER BY t.id;

-- name: ListThreadEvents :many
SELECT id, session_id, thread_id, source_key, revision, projection_revision,
       digest, source_order, event_index, order_fidelity, fidelity, raw_ref,
       adapter_version, schema_version, observed_at, received_at, ingest_seq,
       kind, author, occurred_at, text, tool_label, child_thread_id
FROM canonical_events
WHERE session_id = $1 AND thread_id = $2
ORDER BY source_order, event_index, id;
