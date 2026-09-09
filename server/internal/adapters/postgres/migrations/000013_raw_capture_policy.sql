ALTER TABLE workspace_teams ADD COLUMN raw_capture_policy TEXT NOT NULL DEFAULT 'personal'
    CHECK (raw_capture_policy IN ('force', 'personal', 'close'));
ALTER TABLE auth_users ADD COLUMN raw_capture_preference TEXT NOT NULL DEFAULT 'disable'
    CHECK (raw_capture_preference IN ('enable', 'disable'));
