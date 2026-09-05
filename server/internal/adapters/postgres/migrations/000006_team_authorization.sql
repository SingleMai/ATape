ALTER TABLE workspace_teams
    ADD COLUMN slug TEXT,
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    ADD CONSTRAINT workspace_teams_slug_check CHECK (
        slug IS NULL OR (
            octet_length(slug) BETWEEN 2 AND 63 AND
            slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
        )
    ),
    ADD CONSTRAINT workspace_teams_name_length_check
        CHECK (octet_length(name) BETWEEN 1 AND 200);

-- Legacy Teams remain without a slug until the explicit v0.2 cutover maps an
-- Owner. All Teams created by the authenticated control plane have one.
CREATE UNIQUE INDEX workspace_teams_slug_unique_idx
    ON workspace_teams (slug)
    WHERE slug IS NOT NULL;

ALTER TABLE canonical_projects
    DROP CONSTRAINT canonical_projects_type_check,
    ADD CONSTRAINT canonical_projects_type_check
        CHECK (project_type IN ('git', 'directory')),
    ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'archived', 'deleted')),
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN archived_at TIMESTAMPTZ,
    ADD COLUMN deleted_at TIMESTAMPTZ,
    ADD CONSTRAINT canonical_projects_state_time_check CHECK (
        (state = 'active' AND archived_at IS NULL AND deleted_at IS NULL) OR
        (state = 'archived' AND archived_at IS NOT NULL AND deleted_at IS NULL) OR
        (state = 'deleted' AND deleted_at IS NOT NULL)
    ),
    ADD CONSTRAINT canonical_projects_id_team_unique UNIQUE (id, team_id);

CREATE INDEX canonical_projects_team_state_idx
    ON canonical_projects (team_id, state, lower(name), id);

CREATE TABLE team_memberships (
    team_id TEXT NOT NULL REFERENCES workspace_teams(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    removed_at TIMESTAMPTZ,
    PRIMARY KEY (team_id, user_id),
    CHECK (
        (status = 'active' AND removed_at IS NULL) OR
        (status = 'removed' AND removed_at IS NOT NULL)
    )
);

CREATE INDEX team_memberships_user_active_idx
    ON team_memberships (user_id, team_id)
    WHERE status = 'active';

CREATE INDEX team_memberships_team_active_idx
    ON team_memberships (team_id, role, user_id)
    WHERE status = 'active';

CREATE TABLE team_join_codes (
    id UUID PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES workspace_teams(id) ON DELETE RESTRICT,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    pepper_key_id TEXT NOT NULL CHECK (octet_length(pepper_key_id) BETWEEN 1 AND 100),
    code_digest BYTEA NOT NULL CHECK (octet_length(code_digest) = 32),
    digest_version TEXT NOT NULL CHECK (digest_version = 'hmac-sha256-v1'),
    status TEXT NOT NULL CHECK (status IN ('enabled', 'retired', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    retired_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ,
    UNIQUE (team_id, generation),
    UNIQUE (pepper_key_id, code_digest),
    CHECK (
        (status = 'enabled' AND retired_at IS NULL AND disabled_at IS NULL) OR
        (status = 'retired' AND retired_at IS NOT NULL AND disabled_at IS NULL) OR
        (status = 'disabled' AND retired_at IS NULL AND disabled_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX team_join_codes_current_idx
    ON team_join_codes (team_id)
    WHERE status = 'enabled';

CREATE TABLE team_join_code_attempt_windows (
    user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
    window_start TIMESTAMPTZ NOT NULL,
    failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 0 AND 100000),
    blocked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, window_start)
);

CREATE INDEX team_join_code_attempt_cleanup_idx
    ON team_join_code_attempt_windows (window_start, user_id);

CREATE TABLE team_project_repository_aliases (
    project_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    remote_identity TEXT NOT NULL CHECK (octet_length(remote_identity) BETWEEN 3 AND 2048),
    current BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, remote_identity),
    FOREIGN KEY (project_id, team_id)
        REFERENCES canonical_projects(id, team_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX team_project_repository_alias_current_idx
    ON team_project_repository_aliases (project_id)
    WHERE current;

CREATE UNIQUE INDEX team_project_repository_alias_identity_idx
    ON team_project_repository_aliases (team_id, remote_identity);

CREATE TABLE team_operation_receipts (
    user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (action IN ('team.create', 'project.create')),
    operation_key TEXT NOT NULL CHECK (octet_length(operation_key) BETWEEN 16 AND 128),
    request_digest BYTEA NOT NULL CHECK (octet_length(request_digest) = 32),
    resource_id TEXT NOT NULL CHECK (octet_length(resource_id) BETWEEN 1 AND 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, action, operation_key),
    CHECK (expires_at > created_at)
);

CREATE INDEX team_operation_receipts_expiry_idx
    ON team_operation_receipts (expires_at, user_id, action, operation_key);

ALTER TABLE canonical_sessions
    ADD COLUMN captured_by_user_id UUID REFERENCES auth_users(id) ON DELETE RESTRICT;

CREATE INDEX canonical_sessions_captured_by_idx
    ON canonical_sessions (captured_by_user_id, updated_at DESC, id)
    WHERE captured_by_user_id IS NOT NULL;
