ALTER TABLE workspace_teams ADD COLUMN raw_capture_revision BIGINT NOT NULL DEFAULT 1 CHECK (raw_capture_revision > 0);
ALTER TABLE auth_users ADD COLUMN raw_capture_revision BIGINT NOT NULL DEFAULT 1 CHECK (raw_capture_revision > 0);

-- Raw retention is independent of Canonical body reclamation. These values are
-- verified against actual activation before commit and then remain immutable.
ALTER TABLE raw_objects ADD COLUMN publication_head UUID;
ALTER TABLE raw_objects ADD COLUMN raw_team_revision BIGINT;
ALTER TABLE raw_objects ADD COLUMN raw_user_revision BIGINT;
ALTER TABLE raw_objects ADD CONSTRAINT raw_publication_binding CHECK (
  (publication_head IS NULL AND raw_team_revision IS NULL AND raw_user_revision IS NULL)
  OR (publication_head IS NOT NULL AND raw_team_revision IS NOT NULL AND raw_user_revision IS NOT NULL AND raw_team_revision > 0 AND raw_user_revision >= 0)
);
