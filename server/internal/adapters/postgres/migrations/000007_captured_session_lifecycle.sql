ALTER TABLE canonical_sessions
    ADD COLUMN record_state TEXT NOT NULL DEFAULT 'active'
        CHECK (record_state IN ('active', 'deleted')),
    ADD COLUMN deleted_at TIMESTAMPTZ,
    ADD COLUMN deleted_by_user_id UUID REFERENCES auth_users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT canonical_sessions_deletion_state_check CHECK (
        (record_state = 'active' AND deleted_at IS NULL AND deleted_by_user_id IS NULL) OR
        (record_state = 'deleted' AND deleted_at IS NOT NULL AND deleted_by_user_id IS NOT NULL)
    );

CREATE INDEX canonical_sessions_active_project_updated_idx
    ON canonical_sessions (project_id, updated_at DESC, id)
    WHERE record_state = 'active';
