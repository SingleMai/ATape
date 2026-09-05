-- Resource authorization queries deliberately join the current Membership.
-- A missing resource and a resource outside the Principal's visible Teams
-- therefore have the same no-row result.

-- name: ResolveProjectAccess :one
SELECT projects.id, projects.team_id, projects.name, projects.project_type,
       projects.state, projects.captured_through,
       membership.user_id, membership.role, membership.status
FROM canonical_projects projects
JOIN team_memberships membership
  ON membership.team_id = projects.team_id
 AND membership.user_id = sqlc.arg(user_id)
JOIN auth_users users
  ON users.id = membership.user_id
 AND users.status = 'active'
WHERE projects.id = sqlc.arg(project_id)
  AND projects.state <> 'deleted';

-- name: ResolveProjectAccessForIngest :one
SELECT projects.id, projects.team_id, projects.name, projects.project_type,
       projects.state, projects.captured_through,
       membership.user_id, membership.role, membership.status
FROM canonical_projects projects
JOIN team_memberships membership
  ON membership.team_id = projects.team_id
 AND membership.user_id = sqlc.arg(user_id)
JOIN auth_users users
  ON users.id = membership.user_id
 AND users.status = 'active'
WHERE projects.id = sqlc.arg(project_id)
  AND projects.state <> 'deleted'
FOR UPDATE OF projects
FOR SHARE OF membership, users;

-- name: ResolveSessionAccess :one
SELECT sessions.id, sessions.project_id, sessions.captured_by_user_id,
       projects.team_id, projects.state,
       membership.user_id, membership.role, membership.status
FROM canonical_sessions sessions
JOIN canonical_projects projects ON projects.id = sessions.project_id
JOIN team_memberships membership
  ON membership.team_id = projects.team_id
 AND membership.user_id = sqlc.arg(user_id)
JOIN auth_users users
  ON users.id = membership.user_id
 AND users.status = 'active'
WHERE sessions.id = sqlc.arg(session_id)
  AND sessions.record_state = 'active'
  AND projects.state <> 'deleted';

-- name: ResolveSessionAccessForShare :one
SELECT sessions.id, sessions.project_id, sessions.captured_by_user_id,
       projects.team_id, projects.state,
       membership.user_id, membership.role, membership.status
FROM canonical_sessions sessions
JOIN canonical_projects projects ON projects.id = sessions.project_id
JOIN team_memberships membership
  ON membership.team_id = projects.team_id
 AND membership.user_id = sqlc.arg(user_id)
JOIN auth_users users
  ON users.id = membership.user_id
 AND users.status = 'active'
WHERE sessions.id = sqlc.arg(session_id)
  AND sessions.record_state = 'active'
  AND projects.state <> 'deleted'
FOR SHARE OF sessions, projects, membership, users;

-- name: ResolveRawObjectAccess :one
SELECT objects.id, objects.project_id, objects.session_id,
       sessions.captured_by_user_id, projects.team_id, projects.state,
       membership.user_id, membership.role, membership.status
FROM raw_objects objects
JOIN canonical_sessions sessions ON sessions.id = objects.session_id
JOIN canonical_projects projects ON projects.id = objects.project_id
JOIN team_memberships membership
  ON membership.team_id = projects.team_id
 AND membership.user_id = sqlc.arg(user_id)
JOIN auth_users users
  ON users.id = membership.user_id
 AND users.status = 'active'
WHERE objects.id = sqlc.arg(object_id)
  AND sessions.record_state = 'active'
  AND projects.state <> 'deleted';

-- name: ResolveCapturedSessionDeleteForUpdate :one
SELECT sessions.id, sessions.project_id, sessions.captured_by_user_id, sessions.record_state,
       projects.team_id, projects.state,
       membership.user_id, membership.role, membership.status
FROM canonical_sessions sessions
JOIN canonical_projects projects ON projects.id = sessions.project_id
JOIN team_memberships membership
  ON membership.team_id = projects.team_id
 AND membership.user_id = sqlc.arg(user_id)
JOIN auth_users users
  ON users.id = membership.user_id
 AND users.status = 'active'
WHERE sessions.id = sqlc.arg(session_id)
  AND projects.state <> 'deleted'
FOR UPDATE OF sessions, projects
FOR SHARE OF membership, users;

-- name: TombstoneCapturedSession :execrows
UPDATE canonical_sessions
SET record_state = 'deleted', deleted_at = clock_timestamp(), deleted_by_user_id = $2
WHERE id = $1 AND record_state = 'active';

-- name: DeleteSessionBatchReceipts :exec
DELETE FROM canonical_batch_receipts WHERE session_id = $1;

-- name: DeleteSessionProjectionChanges :exec
DELETE FROM canonical_projection_changes
WHERE event_id IN (SELECT id FROM canonical_events WHERE session_id = $1);

-- name: DeleteSessionSearchDocuments :exec
DELETE FROM project_search_documents WHERE session_id = $1;

-- name: InsertResourceSecurityAuditEvent :exec
INSERT INTO security_audit_events (
    id, initiator_kind, initiator_id, action, target_kind, target_id,
    outcome, reason, request_id, web_session_id, cli_credential_id, metadata
) VALUES (
    $1, 'principal', $2, $3, $4, $5,
    'succeeded', $6, $7, $8, $9, '{}'::jsonb
);
