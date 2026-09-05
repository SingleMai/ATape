-- name: AcquireRawLock :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(lock_key)::text, 1));

-- name: GetRawCanonicalSessionProject :one
SELECT project_id
FROM canonical_sessions
WHERE id = $1 AND record_state = 'active';

-- name: GetRawChunkForReplay :one
SELECT c.chunk_id, c.object_id, c.generation, c.ordinal, c.byte_offset,
       c.size_bytes, c.adapter_version AS chunk_adapter_version,
       c.captured_at AS chunk_captured_at, c.final, c.sha256, c.storage_key,
       o.project_id, o.session_id, o.source_name, o.media_type, o.adapter_id,
       o.client_redacted
FROM raw_chunks c
JOIN raw_objects o ON o.id = c.object_id
WHERE c.chunk_id = $1;

-- name: GetRawObjectForUpdate :one
SELECT id, project_id, session_id, source_name, media_type, adapter_id,
       adapter_version, captured_at, client_redacted, current_generation,
       generation_count
FROM raw_objects
WHERE id = $1
FOR UPDATE;

-- name: GetRawObjectForRead :one
SELECT o.id, o.project_id, o.session_id, o.source_name, o.media_type,
       o.adapter_id, o.adapter_version, o.captured_at, o.client_redacted,
       o.current_generation, o.generation_count,
       g.size_bytes AS current_size_bytes, g.finalized AS current_finalized
FROM raw_objects o
JOIN raw_generations g
  ON g.object_id = o.id AND g.generation = o.current_generation
WHERE o.id = $1;

-- name: ListRawSessionObjects :many
SELECT o.id, o.project_id, o.session_id, o.source_name, o.media_type,
       o.adapter_id, o.adapter_version, o.captured_at, o.client_redacted,
       o.current_generation, o.generation_count,
       g.size_bytes AS current_size_bytes, g.finalized AS current_finalized
FROM raw_objects o
JOIN raw_generations g
  ON g.object_id = o.id AND g.generation = o.current_generation
WHERE o.session_id = $1
ORDER BY o.captured_at DESC, o.id;

-- name: InsertRawObject :exec
INSERT INTO raw_objects (
    id, project_id, session_id, source_name, media_type, adapter_id,
    adapter_version, captured_at, client_redacted,
    current_generation, generation_count
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1);

-- name: InsertRawGeneration :exec
INSERT INTO raw_generations (object_id, generation)
VALUES ($1, $2);

-- name: GetRawGenerationForUpdate :one
SELECT object_id, generation, size_bytes, chunk_count, finalized
FROM raw_generations
WHERE object_id = $1 AND generation = $2
FOR UPDATE;

-- name: GetRawGenerationForRead :one
SELECT object_id, generation, size_bytes, chunk_count, finalized
FROM raw_generations
WHERE object_id = $1 AND generation = $2;

-- name: InsertRawChunk :exec
INSERT INTO raw_chunks (
    chunk_id, object_id, generation, ordinal, byte_offset, size_bytes,
    adapter_version, captured_at, final, sha256, storage_key
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);

-- name: CommitRawGeneration :exec
UPDATE raw_generations
SET size_bytes = sqlc.arg(size_bytes),
    chunk_count = sqlc.arg(chunk_count),
    finalized = sqlc.arg(finalized),
    updated_at = clock_timestamp()
WHERE object_id = sqlc.arg(object_id) AND generation = sqlc.arg(generation);

-- name: CommitRawObject :exec
UPDATE raw_objects
SET adapter_version = sqlc.arg(adapter_version),
    captured_at = GREATEST(captured_at, sqlc.arg(captured_at)::timestamptz),
    current_generation = sqlc.arg(current_generation),
    generation_count = sqlc.arg(generation_count),
    updated_at = clock_timestamp()
WHERE id = sqlc.arg(id);

-- name: ListRawChunksAfter :many
SELECT chunk_id, object_id, generation, ordinal, byte_offset, size_bytes,
       adapter_version, captured_at, final, sha256, storage_key
FROM raw_chunks
WHERE object_id = sqlc.arg(object_id)
  AND generation = sqlc.arg(generation)
  AND ordinal > sqlc.arg(after_ordinal)
ORDER BY ordinal
LIMIT sqlc.arg(result_limit);
