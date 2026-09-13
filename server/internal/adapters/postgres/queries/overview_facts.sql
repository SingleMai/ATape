-- name: CopyOverviewMessages :copyfrom
INSERT INTO overview_publication_messages(attempt_id,part_ordinal,entry_index,event_id,thread_id,occurred_at,author,root,source_order,event_index)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);

-- name: CopyOverviewUsage :copyfrom
INSERT INTO overview_publication_usage(attempt_id,part_ordinal,entry_index,source_key,thread_id,occurred_at,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11);

-- name: CompleteOverviewPart :execrows
UPDATE canonical_publication_parts SET overview_version=1
WHERE attempt_id=$1 AND ordinal=$2 AND format_version=1 AND overview_version IS DISTINCT FROM 1;

-- name: ClaimOverviewBackfillPart :one
-- Lock only a part; never acquire an account, source or attempt lock afterward.
-- This cannot invert validation/reclamation's existing lock order.
SELECT attempt_id,ordinal,stored_bytes FROM canonical_publication_parts
WHERE format_version=1 AND overview_version IS DISTINCT FROM 1
ORDER BY attempt_id,ordinal LIMIT 1 FOR UPDATE SKIP LOCKED;

-- name: OverviewFactCoverage :one
SELECT count(*)::bigint AS retained_parts,
 count(*) FILTER(WHERE p.overview_version IS DISTINCT FROM 1)::bigint AS missing_parts,
 count(*) FILTER(WHERE p.overview_version IS DISTINCT FROM 1 AND s.current_head=p.attempt_id::text)::bigint AS current_head_missing_parts
FROM canonical_publication_parts p
JOIN canonical_publication_attempts a ON a.id=p.attempt_id
JOIN canonical_publication_sources s ON s.session_id=a.session_id
WHERE p.format_version=1;
