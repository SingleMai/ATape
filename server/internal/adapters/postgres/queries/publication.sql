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
 WHERE s.captured_by_user_id=$1 AND a.state<>'activated')::bigint AS retained_bytes;

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
 CASE WHEN a.state='activated' THEN 'activated'
 WHEN a.state='rejected' THEN 'rejected'
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
SELECT p.attempt_id,p.ordinal,p.stored_bytes AS byte_count FROM canonical_publication_parts p
JOIN canonical_publication_attempts a ON a.id=p.attempt_id
JOIN canonical_publication_reservations r ON r.id=a.id
JOIN canonical_publication_sources s ON s.session_id=a.session_id
WHERE s.captured_by_user_id=$1 AND (
 (a.state='activated' AND s.current_head IS DISTINCT FROM a.id::text)
 OR (a.state<>'activated' AND (a.state='rejected' OR a.fence<>s.writer_fence
 OR a.base_head IS DISTINCT FROM s.current_head OR a.lease_until<=clock_timestamp() OR r.expires_at<=clock_timestamp())))
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
 AND (a.id IS NULL OR (a.part_count=0 AND a.state<>'activated'))
 ORDER BY r.id LIMIT sqlc.arg(page_limit)
) RETURNING id;

-- name: GetPublicationPartBody :one
SELECT body,validated_body,format_version,stored_bytes FROM canonical_publication_parts WHERE attempt_id=$1 AND ordinal=$2;

-- name: StoreValidatedPublicationPart :exec
UPDATE canonical_publication_parts SET body=NULL,validated_body=$3,format_version=1 WHERE attempt_id=$1 AND ordinal=$2;

-- name: AdvancePublicationValidation :exec
UPDATE canonical_publication_attempts SET validated_parts=validated_parts+1,
 candidate_events=candidate_events+sqlc.arg(events),candidate_usage=candidate_usage+sqlc.arg(usage),
 retained_bytes=retained_bytes+sqlc.arg(byte_delta),header_digest=sqlc.arg(header_digest),target_json=sqlc.arg(target_json),state=sqlc.arg(state)
WHERE id=sqlc.arg(id);

-- name: GetPublicationMember :one
SELECT source_key FROM canonical_publication_members WHERE attempt_id=$1 AND kind=$2 AND record_id=$3;

-- name: InsertPublicationMember :exec
INSERT INTO canonical_publication_members(attempt_id,kind,record_id,source_key,part_ordinal,entry_index,thread_id,source_order,event_index,search_descriptor)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);

-- name: GetPublicationRecordIdentity :one
SELECT source_key,thread_id FROM canonical_publication_record_versions WHERE session_id=$1 AND kind=$2 AND record_id=$3 LIMIT 1;

-- name: GetPublicationRecordVersion :one
SELECT fingerprint FROM canonical_publication_record_versions WHERE kind=$1 AND source_key=$2 AND projection_revision=$3 AND revision=$4;

-- name: InsertPublicationRecordVersion :exec
INSERT INTO canonical_publication_record_versions(session_id,kind,source_key,record_id,thread_id,projection_revision,revision,fingerprint)
VALUES($1,$2,$3,$4,$5,$6,$7,$8);

-- name: GetPublicationPartStorage :one
SELECT stored_bytes,format_version FROM canonical_publication_parts WHERE attempt_id=$1 AND ordinal=$2;

-- name: ActivatePublicationSource :execrows
UPDATE canonical_publication_sources s SET current_head=sqlc.arg(head)
FROM canonical_publication_attempts a JOIN canonical_publication_reservations r ON r.id=a.id
WHERE a.id=sqlc.arg(attempt_id) AND s.session_id=a.session_id AND a.state='activated'
 AND a.validated_parts=a.part_count AND a.fence=s.writer_fence
 AND a.base_head IS NOT DISTINCT FROM s.current_head
 AND a.lease_until>clock_timestamp() AND r.expires_at>clock_timestamp();

-- name: RecordPublicationActivation :exec
UPDATE canonical_publication_attempts SET state='activated',activation_json=$2,published_observed_at=$3 WHERE id=$1;

-- name: ConfirmPublicationActivationAuthority :one
SELECT a.lease_until>clock_timestamp() AND r.expires_at>clock_timestamp()
 AND a.fence=s.writer_fence AND s.current_head=a.id::text AS valid
FROM canonical_publication_attempts a JOIN canonical_publication_reservations r ON r.id=a.id
JOIN canonical_publication_sources s ON s.session_id=a.session_id WHERE a.id=$1;

-- name: InsertPublicationProjectionChange :exec
INSERT INTO canonical_publication_projection_changes(attempt_id,event_id) VALUES($1,$2);

-- name: ClaimPublicationProjectionChanges :many
WITH candidates AS (
 SELECT c.id FROM canonical_publication_projection_changes c
 JOIN canonical_publication_attempts a ON a.id=c.attempt_id AND a.state='activated'
 JOIN canonical_publication_sources s ON s.session_id=a.session_id AND s.current_head::uuid=c.attempt_id
 JOIN canonical_sessions cs ON cs.id=s.session_id AND cs.record_state='active'
 WHERE c.processed_at IS NULL AND (c.lease_until IS NULL OR c.lease_until<=clock_timestamp())
 ORDER BY c.id LIMIT sqlc.arg(batch_limit) FOR UPDATE OF c SKIP LOCKED
), claimed AS (
 UPDATE canonical_publication_projection_changes c SET lease_owner=sqlc.arg(lease_owner),lease_until=sqlc.arg(lease_until)
 FROM candidates WHERE c.id=candidates.id RETURNING c.*
)
SELECT c.id,c.attempt_id,c.event_id,m.part_ordinal,m.entry_index,m.search_descriptor
FROM claimed c JOIN canonical_publication_members m ON m.attempt_id=c.attempt_id AND m.kind='event' AND m.record_id=c.event_id
ORDER BY c.id;

-- name: AckPublicationProjectionChanges :exec
UPDATE canonical_publication_projection_changes SET processed_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL
WHERE id=ANY(sqlc.arg(change_ids)::bigint[]) AND lease_owner=sqlc.arg(lease_owner);

-- name: GetPublicationEventPosition :one
SELECT source_order,event_index,record_id FROM canonical_publication_members
WHERE attempt_id=$1 AND kind='event' AND thread_id=$2 AND record_id=$3;

-- name: ListPublicationThreadMembers :many
SELECT record_id,part_ordinal,entry_index FROM canonical_publication_members
WHERE attempt_id=$1 AND kind='event' AND thread_id=$2
 AND (source_order,event_index,record_id)>=(sqlc.arg(after_order)::bigint,sqlc.arg(after_index)::bigint,sqlc.arg(after_id)::text)
 AND (sqlc.arg(include_anchor)::boolean OR record_id<>sqlc.arg(after_id)::text)
ORDER BY source_order,event_index,record_id LIMIT sqlc.arg(page_limit);
