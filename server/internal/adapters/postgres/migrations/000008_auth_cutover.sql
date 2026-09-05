ALTER TABLE auth_cutover_ledger
    DROP CONSTRAINT auth_cutover_ledger_status_check,
    DROP CONSTRAINT auth_cutover_ledger_check,
    ADD COLUMN installation_kind TEXT,
    ADD COLUMN mapping_protocol TEXT,
    ADD COLUMN mapping_digest TEXT,
    ADD COLUMN snapshot_digest TEXT,
    ADD COLUMN snapshot_schema_version BIGINT,
    ADD COLUMN prepared_at TIMESTAMPTZ,
    ADD COLUMN bootstrap_at TIMESTAMPTZ,
    ADD COLUMN normal_serving_started_at TIMESTAMPTZ;

-- The last additive migration can distinguish a genuinely empty installation
-- from an upgrade without trusting any client-supplied identity. Empty installs
-- are immediately usable; every installation with persisted account or product
-- data must complete the explicit mapped cutover.
UPDATE auth_cutover_ledger
SET installation_kind = CASE
        WHEN EXISTS (SELECT 1 FROM auth_users)
          OR EXISTS (SELECT 1 FROM workspace_teams)
          OR EXISTS (SELECT 1 FROM canonical_projects)
          OR EXISTS (SELECT 1 FROM canonical_sessions)
          OR EXISTS (SELECT 1 FROM raw_objects)
          OR EXISTS (SELECT 1 FROM project_search_documents)
        THEN 'mapped'
        ELSE 'fresh'
    END,
    status = CASE
        WHEN EXISTS (SELECT 1 FROM auth_users)
          OR EXISTS (SELECT 1 FROM workspace_teams)
          OR EXISTS (SELECT 1 FROM canonical_projects)
          OR EXISTS (SELECT 1 FROM canonical_sessions)
          OR EXISTS (SELECT 1 FROM raw_objects)
          OR EXISTS (SELECT 1 FROM project_search_documents)
        THEN 'prepared'
        ELSE 'completed'
    END,
    prepared_at = clock_timestamp(),
    completed_at = CASE
        WHEN EXISTS (SELECT 1 FROM auth_users)
          OR EXISTS (SELECT 1 FROM workspace_teams)
          OR EXISTS (SELECT 1 FROM canonical_projects)
          OR EXISTS (SELECT 1 FROM canonical_sessions)
          OR EXISTS (SELECT 1 FROM raw_objects)
          OR EXISTS (SELECT 1 FROM project_search_documents)
        THEN NULL
        ELSE clock_timestamp()
    END,
    updated_at = clock_timestamp()
WHERE protocol_version = 'auth-v1';

ALTER TABLE auth_cutover_ledger
    ALTER COLUMN installation_kind SET NOT NULL,
    ALTER COLUMN prepared_at SET NOT NULL,
    ADD CONSTRAINT auth_cutover_ledger_installation_kind_check
        CHECK (installation_kind IN ('fresh', 'mapped')),
    ADD CONSTRAINT auth_cutover_ledger_status_check
        CHECK (status IN ('prepared', 'bootstrap', 'completed')),
    ADD CONSTRAINT auth_cutover_ledger_mapping_protocol_check
        CHECK (mapping_protocol IS NULL OR mapping_protocol = 'atape.auth-cutover.v1'),
    ADD CONSTRAINT auth_cutover_ledger_mapping_digest_check
        CHECK (mapping_digest IS NULL OR length(mapping_digest) = 64),
    ADD CONSTRAINT auth_cutover_ledger_snapshot_digest_check
        CHECK (snapshot_digest IS NULL OR length(snapshot_digest) = 64),
    ADD CONSTRAINT auth_cutover_ledger_state_check CHECK (
        (
            installation_kind = 'fresh' AND status = 'completed' AND
            mapping_protocol IS NULL AND mapping_digest IS NULL AND
            snapshot_digest IS NULL AND snapshot_schema_version IS NULL AND
            bootstrap_at IS NULL AND completed_at IS NOT NULL
        ) OR (
            installation_kind = 'mapped' AND status = 'prepared' AND
            mapping_protocol IS NULL AND mapping_digest IS NULL AND
            snapshot_digest IS NULL AND snapshot_schema_version IS NULL AND
            bootstrap_at IS NULL AND completed_at IS NULL
        ) OR (
            installation_kind = 'mapped' AND status = 'bootstrap' AND
            mapping_protocol IS NULL AND mapping_digest IS NULL AND
            snapshot_digest IS NULL AND snapshot_schema_version IS NULL AND
            bootstrap_at IS NOT NULL AND completed_at IS NULL
        ) OR (
            installation_kind = 'mapped' AND status = 'completed' AND
            mapping_protocol = 'atape.auth-cutover.v1' AND
            mapping_digest IS NOT NULL AND snapshot_digest IS NOT NULL AND
            snapshot_schema_version IS NOT NULL AND
            bootstrap_at IS NOT NULL AND completed_at IS NOT NULL
        )
    );

ALTER TABLE canonical_sessions
    ADD COLUMN capture_lineage TEXT;

UPDATE canonical_sessions
SET capture_lineage = CASE
    WHEN captured_by_user_id IS NULL THEN 'legacy_anonymous'
    ELSE 'authenticated'
END;

ALTER TABLE canonical_sessions
    ALTER COLUMN capture_lineage SET NOT NULL,
    ADD CONSTRAINT canonical_sessions_capture_lineage_check
        CHECK (capture_lineage IN ('legacy_anonymous', 'authenticated')),
    ADD CONSTRAINT canonical_sessions_capture_identity_check CHECK (
        (capture_lineage = 'legacy_anonymous' AND captured_by_user_id IS NULL) OR
        (capture_lineage = 'authenticated' AND captured_by_user_id IS NOT NULL)
    );

CREATE INDEX canonical_sessions_legacy_lineage_idx
    ON canonical_sessions (project_id, updated_at DESC, id)
    WHERE capture_lineage = 'legacy_anonymous' AND record_state = 'active';

ALTER TABLE canonical_projects
    ADD COLUMN repository_link_state TEXT;

UPDATE canonical_projects AS projects
SET repository_link_state = CASE
    WHEN projects.project_type = 'directory' THEN 'not_applicable'
    WHEN EXISTS (
        SELECT 1
        FROM team_project_repository_aliases AS aliases
        WHERE aliases.project_id = projects.id AND aliases.current
    ) THEN 'linked'
    ELSE 'unknown'
END;

ALTER TABLE canonical_projects
    ALTER COLUMN repository_link_state SET NOT NULL,
    ADD CONSTRAINT canonical_projects_repository_link_state_check CHECK (
        (project_type = 'directory' AND repository_link_state = 'not_applicable') OR
        (project_type = 'git' AND repository_link_state IN ('unknown', 'linked'))
    );

CREATE INDEX canonical_projects_repository_link_state_idx
    ON canonical_projects (team_id, repository_link_state, id)
    WHERE state <> 'deleted';
