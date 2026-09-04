CREATE TABLE workspace_teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_reported BOOLEAN NOT NULL DEFAULT TRUE
);

-- Installations upgraded from the pre-Workspace schema retain their Team IDs.
-- The next accepted observation may replace this placeholder name once.
INSERT INTO workspace_teams (id, name, name_reported)
SELECT DISTINCT team_id, team_id, FALSE
FROM canonical_projects;

ALTER TABLE canonical_projects
    ADD COLUMN project_type TEXT NOT NULL DEFAULT 'git';

ALTER TABLE canonical_projects
    ADD CONSTRAINT canonical_projects_type_check
        CHECK (project_type IN ('git', 'directory')),
    ADD CONSTRAINT canonical_projects_team_fk
        FOREIGN KEY (team_id) REFERENCES workspace_teams(id) ON DELETE RESTRICT;

ALTER TABLE canonical_projects
    ALTER COLUMN project_type DROP DEFAULT;

CREATE INDEX canonical_projects_team_name_idx
    ON canonical_projects (team_id, name, id);
