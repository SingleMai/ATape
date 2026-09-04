CREATE SEQUENCE canonical_ingest_seq AS BIGINT;

CREATE TABLE canonical_projects (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    name TEXT NOT NULL,
    captured_through TIMESTAMPTZ NOT NULL DEFAULT to_timestamp(0)
);

CREATE TABLE canonical_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES canonical_projects(id) ON DELETE RESTRICT,
    source_key TEXT NOT NULL UNIQUE,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    insight TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    actor_harness TEXT NOT NULL,
    branch TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'idle', 'ended')),
    capture_status TEXT NOT NULL CHECK (capture_status IN ('healthy', 'partial', 'complete', 'degraded')),
    updated_at TIMESTAMPTZ NOT NULL,
    reported_event_count BIGINT NOT NULL CHECK (reported_event_count >= 0)
);

CREATE INDEX canonical_sessions_project_updated_idx
    ON canonical_sessions (project_id, updated_at DESC, id);

CREATE TABLE canonical_threads (
    session_id TEXT NOT NULL REFERENCES canonical_sessions(id) ON DELETE RESTRICT,
    id TEXT NOT NULL,
    source_key TEXT NOT NULL UNIQUE,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    label TEXT NOT NULL,
    summary TEXT NOT NULL,
    parent_thread_id TEXT,
    capture_status TEXT NOT NULL CHECK (capture_status IN ('healthy', 'partial', 'complete', 'degraded')),
    PRIMARY KEY (session_id, id),
    CONSTRAINT canonical_threads_parent_fk
        FOREIGN KEY (session_id, parent_thread_id)
        REFERENCES canonical_threads(session_id, id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX canonical_threads_session_idx
    ON canonical_threads (session_id, id);

CREATE TABLE canonical_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    source_key TEXT NOT NULL UNIQUE,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    projection_revision BIGINT NOT NULL CHECK (projection_revision >= 1),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    source_order BIGINT NOT NULL CHECK (source_order >= 0),
    event_index BIGINT NOT NULL CHECK (event_index >= 0),
    order_fidelity TEXT NOT NULL CHECK (order_fidelity IN ('native', 'derived')),
    fidelity TEXT NOT NULL CHECK (fidelity IN ('native', 'derived', 'partial', 'redacted')),
    raw_ref TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    ingest_seq BIGINT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'thought', 'tool_call', 'tool_result', 'artifact', 'spawn', 'lifecycle')),
    author TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    text TEXT NOT NULL,
    tool_label TEXT NOT NULL,
    child_thread_id TEXT,
    CONSTRAINT canonical_events_thread_fk
        FOREIGN KEY (session_id, thread_id)
        REFERENCES canonical_threads(session_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT canonical_events_child_thread_fk
        FOREIGN KEY (session_id, child_thread_id)
        REFERENCES canonical_threads(session_id, id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX canonical_events_thread_order_idx
    ON canonical_events (session_id, thread_id, source_order, event_index, id);

CREATE TABLE canonical_event_versions (
    source_key TEXT NOT NULL,
    projection_revision BIGINT NOT NULL CHECK (projection_revision >= 1),
    revision BIGINT NOT NULL CHECK (revision >= 1),
    event_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    source_order BIGINT NOT NULL CHECK (source_order >= 0),
    event_index BIGINT NOT NULL CHECK (event_index >= 0),
    order_fidelity TEXT NOT NULL,
    fidelity TEXT NOT NULL,
    raw_ref TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    ingest_seq BIGINT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    author TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    text TEXT NOT NULL,
    tool_label TEXT NOT NULL,
    child_thread_id TEXT,
    PRIMARY KEY (source_key, projection_revision, revision)
);

CREATE INDEX canonical_event_versions_event_idx
    ON canonical_event_versions (event_id, ingest_seq);

CREATE TABLE canonical_batch_receipts (
    batch_key TEXT PRIMARY KEY,
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    session_id TEXT NOT NULL,
    session_created BOOLEAN NOT NULL,
    inserted_events INTEGER NOT NULL,
    updated_events INTEGER NOT NULL,
    unchanged_events INTEGER NOT NULL,
    stale_events INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
