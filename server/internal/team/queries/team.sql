-- name: DatabaseTime :one
SELECT clock_timestamp()::timestamptz;

-- name: AcquireTeamAdvisoryLock :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(lock_key)::text, 0));

-- name: GetPrincipalUserForShare :one
SELECT id, status
FROM auth_users
WHERE id = $1
FOR SHARE;

-- name: GetTeamBySlug :one
SELECT id, slug, name, created_at, updated_at
FROM workspace_teams
WHERE slug = $1;

-- name: GetTeamBySlugForUpdate :one
SELECT id, slug, name, created_at, updated_at
FROM workspace_teams
WHERE slug = $1
FOR UPDATE;

-- name: GetTeamByIDForUpdate :one
SELECT id, slug, name, created_at, updated_at
FROM workspace_teams
WHERE id = $1
FOR UPDATE;

-- name: GetTeamByID :one
SELECT id, slug, name, created_at, updated_at
FROM workspace_teams
WHERE id = $1;

-- name: InsertTeam :one
INSERT INTO workspace_teams (id, slug, name, name_reported)
VALUES ($1, $2, $3, TRUE)
RETURNING id, slug, name, created_at, updated_at;

-- name: UpdateTeamDisplayName :one
UPDATE workspace_teams
SET name = $2, updated_at = clock_timestamp()
WHERE id = $1
RETURNING id, slug, name, created_at, updated_at;

-- name: GetMembership :one
SELECT team_id, user_id, role, status, created_at, updated_at, removed_at
FROM team_memberships
WHERE team_id = $1 AND user_id = $2;

-- name: GetMembershipForUpdate :one
SELECT team_id, user_id, role, status, created_at, updated_at, removed_at
FROM team_memberships
WHERE team_id = $1 AND user_id = $2
FOR UPDATE;

-- name: InsertOwnerMembership :one
INSERT INTO team_memberships (team_id, user_id, role, status)
VALUES ($1, $2, 'owner', 'active')
RETURNING team_id, user_id, role, status, created_at, updated_at, removed_at;

-- name: InsertMemberMembership :one
INSERT INTO team_memberships (team_id, user_id, role, status)
VALUES ($1, $2, 'member', 'active')
RETURNING team_id, user_id, role, status, created_at, updated_at, removed_at;

-- name: ReactivateMemberMembership :one
UPDATE team_memberships
SET role = 'member', status = 'active', updated_at = clock_timestamp(), removed_at = NULL
WHERE team_id = $1 AND user_id = $2 AND status = 'removed'
RETURNING team_id, user_id, role, status, created_at, updated_at, removed_at;

-- name: SetMembershipRole :one
UPDATE team_memberships
SET role = $3, updated_at = clock_timestamp()
WHERE team_id = $1 AND user_id = $2 AND status = 'active'
RETURNING team_id, user_id, role, status, created_at, updated_at, removed_at;

-- name: RemoveMembership :one
UPDATE team_memberships
SET status = 'removed', updated_at = clock_timestamp(), removed_at = clock_timestamp()
WHERE team_id = $1 AND user_id = $2 AND status = 'active'
RETURNING team_id, user_id, role, status, created_at, updated_at, removed_at;

-- name: CountOtherActiveOwners :one
SELECT COUNT(*)::bigint
FROM team_memberships memberships
JOIN auth_users users ON users.id = memberships.user_id
WHERE memberships.team_id = $1
  AND memberships.status = 'active'
  AND memberships.role = 'owner'
  AND users.status = 'active'
  AND memberships.user_id <> $2;

-- name: ListTeamMembers :many
SELECT memberships.team_id, memberships.user_id, memberships.role,
       memberships.created_at, memberships.updated_at,
       users.display_name, users.avatar_url
FROM team_memberships memberships
JOIN auth_users users ON users.id = memberships.user_id
WHERE memberships.team_id = $1
  AND memberships.status = 'active'
  AND users.status = 'active'
ORDER BY lower(users.display_name), memberships.user_id;

-- name: ListVisibleTeams :many
SELECT teams.id, teams.slug, teams.name, teams.created_at, teams.updated_at,
       memberships.role, memberships.created_at AS membership_created_at,
       memberships.updated_at AS membership_updated_at
FROM team_memberships memberships
JOIN workspace_teams teams ON teams.id = memberships.team_id
WHERE memberships.user_id = $1
  AND memberships.status = 'active'
  AND teams.slug IS NOT NULL
ORDER BY lower(teams.name), teams.id;

-- name: GetOperationReceiptForUpdate :one
SELECT request_digest, resource_id, expires_at
FROM team_operation_receipts
WHERE user_id = $1 AND action = $2 AND operation_key = $3
FOR UPDATE;

-- name: InsertOperationReceipt :exec
INSERT INTO team_operation_receipts (
    user_id, action, operation_key, request_digest, resource_id, expires_at
) VALUES (
    $1, $2, $3, $4, $5,
    clock_timestamp() + sqlc.arg(ttl_seconds)::integer * interval '1 second'
);

-- name: LatestJoinCodeForTeam :one
SELECT id, team_id, generation, pepper_key_id, code_digest, status,
       created_at, retired_at, disabled_at
FROM team_join_codes
WHERE team_id = $1
ORDER BY generation DESC
LIMIT 1;

-- name: CurrentJoinCodeForTeamForUpdate :one
SELECT id, team_id, generation, pepper_key_id, code_digest, status,
       created_at, retired_at, disabled_at
FROM team_join_codes
WHERE team_id = $1 AND status = 'enabled'
FOR UPDATE;

-- name: RetireCurrentJoinCode :execrows
UPDATE team_join_codes
SET status = 'retired', retired_at = clock_timestamp()
WHERE team_id = $1 AND status = 'enabled';

-- name: DisableCurrentJoinCode :execrows
UPDATE team_join_codes
SET status = 'disabled', disabled_at = clock_timestamp()
WHERE team_id = $1 AND status = 'enabled';

-- name: InsertJoinCode :one
INSERT INTO team_join_codes (
    id, team_id, generation, pepper_key_id, code_digest, digest_version, status
) VALUES ($1, $2, $3, $4, $5, 'hmac-sha256-v1', 'enabled')
RETURNING id, team_id, generation, pepper_key_id, code_digest, status,
          created_at, retired_at, disabled_at;

-- name: JoinCodeDigestExists :one
SELECT EXISTS (
    SELECT 1
    FROM team_join_codes
    WHERE pepper_key_id = $1 AND code_digest = $2
)::boolean;

-- name: FindEnabledJoinCode :one
SELECT id, team_id, generation, pepper_key_id, code_digest
FROM team_join_codes
WHERE pepper_key_id = $1 AND code_digest = $2 AND status = 'enabled';

-- name: GetJoinCodeByIDForUpdate :one
SELECT id, team_id, generation, pepper_key_id, code_digest, status,
       created_at, retired_at, disabled_at
FROM team_join_codes
WHERE id = $1
FOR UPDATE;

-- name: GetJoinCodeAttemptWindowForUpdate :one
SELECT failure_count, blocked_until
FROM team_join_code_attempt_windows
WHERE user_id = $1 AND window_start = $2
FOR UPDATE;

-- name: RecordJoinCodeFailure :one
INSERT INTO team_join_code_attempt_windows (
    user_id, window_start, failure_count, blocked_until
) VALUES ($1, $2, 1, NULL)
ON CONFLICT (user_id, window_start) DO UPDATE
SET failure_count = team_join_code_attempt_windows.failure_count + 1,
    blocked_until = CASE
        WHEN team_join_code_attempt_windows.failure_count + 1 >= sqlc.arg(maximum_failures)::integer
        THEN sqlc.arg(window_end)::timestamptz
        ELSE team_join_code_attempt_windows.blocked_until
    END,
    updated_at = clock_timestamp()
RETURNING failure_count, blocked_until;

-- name: ClearJoinCodeAttemptWindow :exec
DELETE FROM team_join_code_attempt_windows
WHERE user_id = $1 AND window_start = $2;

-- name: InsertProject :one
INSERT INTO canonical_projects (id, team_id, name, project_type, state)
VALUES ($1, $2, $3, $4, 'active')
RETURNING id, team_id, name, project_type, state, captured_through,
          created_at, updated_at, archived_at, deleted_at;

-- name: GetProject :one
SELECT projects.id, projects.team_id, projects.name, projects.project_type,
       projects.state, projects.captured_through, projects.created_at,
       projects.updated_at, projects.archived_at, projects.deleted_at,
       aliases.remote_identity
FROM canonical_projects projects
LEFT JOIN team_project_repository_aliases aliases
       ON aliases.project_id = projects.id AND aliases.current
WHERE projects.id = $1;

-- name: GetProjectForUpdate :one
SELECT projects.id, projects.team_id, projects.name, projects.project_type,
       projects.state, projects.captured_through, projects.created_at,
       projects.updated_at, projects.archived_at, projects.deleted_at,
       aliases.remote_identity
FROM canonical_projects projects
LEFT JOIN team_project_repository_aliases aliases
       ON aliases.project_id = projects.id AND aliases.current
WHERE projects.id = $1
FOR UPDATE OF projects;

-- name: ListVisibleProjects :many
SELECT projects.id, projects.team_id, projects.name, projects.project_type,
       projects.state, projects.captured_through, projects.created_at,
       projects.updated_at, projects.archived_at, projects.deleted_at,
       aliases.remote_identity
FROM canonical_projects projects
JOIN team_memberships memberships
     ON memberships.team_id = projects.team_id
    AND memberships.user_id = sqlc.arg(user_id)
    AND memberships.status = 'active'
LEFT JOIN team_project_repository_aliases aliases
       ON aliases.project_id = projects.id AND aliases.current
WHERE projects.state <> 'deleted'
ORDER BY projects.team_id, lower(projects.name), projects.id;

-- name: ListProjectsForTeam :many
SELECT projects.id, projects.team_id, projects.name, projects.project_type,
       projects.state, projects.captured_through, projects.created_at,
       projects.updated_at, projects.archived_at, projects.deleted_at,
       aliases.remote_identity
FROM canonical_projects projects
LEFT JOIN team_project_repository_aliases aliases
       ON aliases.project_id = projects.id AND aliases.current
WHERE projects.team_id = $1 AND projects.state <> 'deleted'
ORDER BY lower(projects.name), projects.id;

-- name: InsertRepositoryAlias :exec
INSERT INTO team_project_repository_aliases (
    project_id, team_id, remote_identity, current
) VALUES ($1, $2, $3, $4);

-- name: MarkRepositoryAliasesNonCurrent :exec
UPDATE team_project_repository_aliases
SET current = FALSE
WHERE project_id = $1 AND current;

-- name: DeleteRepositoryAliases :exec
DELETE FROM team_project_repository_aliases
WHERE project_id = $1;

-- name: MakeRepositoryAliasCurrent :execrows
UPDATE team_project_repository_aliases
SET current = TRUE
WHERE project_id = $1 AND remote_identity = $2;

-- name: FindProjectByRepositoryIdentity :one
SELECT projects.id, projects.team_id, projects.name, projects.project_type,
       projects.state, projects.captured_through, projects.created_at,
       projects.updated_at, projects.archived_at, projects.deleted_at,
       current_alias.remote_identity
FROM team_project_repository_aliases matched_alias
JOIN canonical_projects projects ON projects.id = matched_alias.project_id
LEFT JOIN team_project_repository_aliases current_alias
       ON current_alias.project_id = projects.id AND current_alias.current
WHERE matched_alias.team_id = $1
  AND matched_alias.remote_identity = $2
  AND projects.state = 'active';

-- name: RenameFolderProject :one
UPDATE canonical_projects
SET name = $2, updated_at = clock_timestamp()
WHERE id = $1 AND project_type = 'directory' AND state <> 'deleted'
RETURNING id, team_id, name, project_type, state, captured_through,
          created_at, updated_at, archived_at, deleted_at;

-- name: RenameGitProject :exec
UPDATE canonical_projects
SET name = $2, updated_at = clock_timestamp()
WHERE id = $1 AND project_type = 'git' AND state <> 'deleted';

-- name: ArchiveProject :one
UPDATE canonical_projects
SET state = 'archived', archived_at = COALESCE(archived_at, clock_timestamp()),
    updated_at = CASE WHEN state = 'active' THEN clock_timestamp() ELSE updated_at END
WHERE id = $1 AND state IN ('active', 'archived')
RETURNING id, team_id, name, project_type, state, captured_through,
          created_at, updated_at, archived_at, deleted_at;

-- name: SoftDeleteProject :one
UPDATE canonical_projects
SET state = 'deleted', deleted_at = COALESCE(deleted_at, clock_timestamp()),
    updated_at = CASE WHEN state <> 'deleted' THEN clock_timestamp() ELSE updated_at END
WHERE id = $1
RETURNING id, team_id, name, project_type, state, captured_through,
          created_at, updated_at, archived_at, deleted_at;

-- name: InsertSecurityAuditEvent :exec
INSERT INTO security_audit_events (
    id, initiator_kind, initiator_id, action, target_kind, target_id,
    outcome, reason, request_id, provider_registration_id,
    web_session_id, cli_credential_id, metadata
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '', $10, $11, $12);
