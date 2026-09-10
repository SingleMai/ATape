-- name: GetPublicationSource :one
SELECT * FROM canonical_publication_sources WHERE session_id=$1;

-- name: InsertPublicationSource :exec
INSERT INTO canonical_publication_sources(session_id,source_key,project_id,captured_by_user_id,installation_id,adapter_id,source_session_id,origin_key)
VALUES($1,$2,$3,$4,$5,$6,$7,$8);

-- name: PublicationUsage :one
SELECT (SELECT count(*) FROM canonical_publication_reservations r
 JOIN canonical_publication_sources s ON s.session_id=r.session_id
 WHERE s.captured_by_user_id=$1 AND r.expires_at>clock_timestamp())::bigint AS reservations,
 (SELECT coalesce(sum(a.retained_bytes),0)::bigint FROM canonical_publication_attempts a
 JOIN canonical_publication_sources s ON s.session_id=a.session_id
 WHERE s.captured_by_user_id=$1)::bigint AS retained_bytes;

-- name: CreatePublicationReservation :one
INSERT INTO canonical_publication_reservations(id,session_id,expires_at)
VALUES($1,$2,clock_timestamp()+sqlc.arg(lifetime_ms)::bigint*interval '1 millisecond')
RETURNING *;

-- name: GetPublicationReservation :one
SELECT r.id,r.session_id,r.expires_at,r.expires_at>clock_timestamp() AS valid
FROM canonical_publication_reservations r WHERE r.id=$1;

-- name: NextPublicationFence :one
UPDATE canonical_publication_sources SET writer_fence=writer_fence+1
WHERE session_id=$1 RETURNING writer_fence;

-- name: CreatePublicationAttempt :one
INSERT INTO canonical_publication_attempts(id,session_id,capture_id,base_head,transform_version,fence,lease_until)
SELECT $1,$2,$3,$4,$5,$6,LEAST(sqlc.arg(expires_at)::timestamptz,clock_timestamp()+sqlc.arg(lease_ms)::bigint*interval '1 millisecond')
WHERE sqlc.arg(expires_at)::timestamptz>clock_timestamp()
RETURNING *;

-- name: GetPublicationAttempt :one
SELECT a.*,r.expires_at,
 CASE WHEN a.state='rejected' THEN 'rejected'
 WHEN a.fence<>s.writer_fence OR a.base_head IS DISTINCT FROM s.current_head THEN 'superseded'
 WHEN a.lease_until<=clock_timestamp() OR r.expires_at<=clock_timestamp() THEN 'expired'
 ELSE a.state END::text AS effective_state
FROM canonical_publication_attempts a
JOIN canonical_publication_reservations r ON r.id=a.id
JOIN canonical_publication_sources s ON s.session_id=a.session_id
WHERE a.id=$1;

-- name: GetPublicationPart :one
SELECT ordinal,digest,byte_count FROM canonical_publication_parts WHERE attempt_id=$1 AND ordinal=$2;

-- name: InsertPublicationPart :exec
INSERT INTO canonical_publication_parts(attempt_id,ordinal,digest,byte_count,body) VALUES($1,$2,$3,$4,$5);

-- name: AddPublicationBytes :exec
UPDATE canonical_publication_attempts SET retained_bytes=retained_bytes+$2,part_count=part_count+1 WHERE id=$1;

-- name: ListPublicationParts :many
SELECT ordinal,digest,byte_count FROM canonical_publication_parts
WHERE attempt_id=$1 AND ordinal>sqlc.arg(after_ordinal) ORDER BY ordinal LIMIT sqlc.arg(page_limit);

-- name: SealPublicationAttempt :exec
UPDATE canonical_publication_attempts SET state='sealed',seal_json=$2 WHERE id=$1;

-- name: RenewPublicationAttempt :one
UPDATE canonical_publication_attempts SET lease_until=GREATEST(lease_until,
 LEAST(sqlc.arg(expires_at)::timestamptz,clock_timestamp()+sqlc.arg(lease_ms)::bigint*interval '1 millisecond'))
WHERE id=$1 AND lease_until>clock_timestamp() AND sqlc.arg(expires_at)::timestamptz>clock_timestamp()
RETURNING lease_until;

-- name: RejectPublicationAttempt :exec
UPDATE canonical_publication_attempts SET state='rejected' WHERE id=$1;

-- name: PublicationReclaimParts :many
SELECT p.attempt_id,p.ordinal,p.byte_count FROM canonical_publication_parts p
JOIN canonical_publication_attempts a ON a.id=p.attempt_id
JOIN canonical_publication_reservations r ON r.id=a.id
JOIN canonical_publication_sources s ON s.session_id=a.session_id
WHERE s.captured_by_user_id=$1 AND (a.state='rejected' OR a.fence<>s.writer_fence
 OR a.base_head IS DISTINCT FROM s.current_head OR a.lease_until<=clock_timestamp() OR r.expires_at<=clock_timestamp())
ORDER BY p.attempt_id,p.ordinal LIMIT sqlc.arg(page_limit);

-- name: DeletePublicationPart :exec
DELETE FROM canonical_publication_parts WHERE attempt_id=$1 AND ordinal=$2;

-- name: SubtractPublicationBytes :exec
UPDATE canonical_publication_attempts SET retained_bytes=retained_bytes-$2,part_count=part_count-1 WHERE id=$1;

-- name: DeleteExpiredPublicationReservations :many
DELETE FROM canonical_publication_reservations WHERE id IN (
 SELECT r.id FROM canonical_publication_reservations r
 JOIN canonical_publication_sources s ON s.session_id=r.session_id
 LEFT JOIN canonical_publication_attempts a ON a.id=r.id
 WHERE s.captured_by_user_id=$1 AND r.expires_at<=clock_timestamp()
 AND (a.id IS NULL OR a.part_count=0)
 ORDER BY r.id LIMIT sqlc.arg(page_limit)
) RETURNING id;
