-- name: GetUsageForUpdate :one
SELECT * FROM canonical_usage WHERE source_key = $1 FOR UPDATE;

-- name: UpsertUsage :exec
INSERT INTO canonical_usage (source_key, session_id, thread_id, revision, digest, occurred_at, model,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (source_key) DO UPDATE SET revision=EXCLUDED.revision, digest=EXCLUDED.digest,
    occurred_at=EXCLUDED.occurred_at, model=EXCLUDED.model, input_tokens=EXCLUDED.input_tokens,
    output_tokens=EXCLUDED.output_tokens, cache_read_tokens=EXCLUDED.cache_read_tokens,
    cache_write_tokens=EXCLUDED.cache_write_tokens
WHERE EXCLUDED.revision > canonical_usage.revision;
