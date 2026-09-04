CREATE TABLE canonical_projection_changes (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES canonical_events(id) ON DELETE RESTRICT,
    event_ingest_seq BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    lease_owner TEXT,
    lease_until TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    processed_at TIMESTAMPTZ,
    UNIQUE (event_id, event_ingest_seq)
);

CREATE INDEX canonical_projection_changes_pending_idx
    ON canonical_projection_changes (id)
    WHERE processed_at IS NULL;

CREATE TABLE project_search_documents (
    event_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_title TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_path_ids TEXT[] NOT NULL,
    thread_path_labels TEXT[] NOT NULL,
    author TEXT NOT NULL,
    harness TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    text TEXT NOT NULL,
    tool_label TEXT NOT NULL,
    ingest_seq BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    search_text TEXT NOT NULL,
    search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('simple'::regconfig, search_text)
    ) STORED
);

CREATE INDEX project_search_documents_project_time_idx
    ON project_search_documents (project_id, occurred_at DESC, event_id);

CREATE INDEX project_search_documents_vector_idx
    ON project_search_documents USING GIN (search_vector);

CREATE TABLE project_search_checkpoints (
    project_id TEXT PRIMARY KEY,
    indexed_through TIMESTAMPTZ NOT NULL
);

-- Existing Canonical Events must become searchable when this migration is
-- applied to an established installation.
INSERT INTO canonical_projection_changes (event_id, event_ingest_seq, observed_at)
SELECT id, ingest_seq, observed_at
FROM canonical_events
ON CONFLICT (event_id, event_ingest_seq) DO NOTHING;
