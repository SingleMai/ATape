ALTER TABLE canonical_sessions
    ADD CONSTRAINT canonical_sessions_id_project_unique UNIQUE (id, project_id);

CREATE TABLE raw_objects (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    client_redacted BOOLEAN NOT NULL CHECK (client_redacted),
    current_generation BIGINT NOT NULL CHECK (current_generation >= 1),
    generation_count BIGINT NOT NULL CHECK (generation_count >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT raw_objects_session_project_fk
        FOREIGN KEY (session_id, project_id)
        REFERENCES canonical_sessions (id, project_id)
        ON DELETE RESTRICT
);

CREATE INDEX raw_objects_session_captured_idx
    ON raw_objects (session_id, captured_at DESC, id);

CREATE TABLE raw_generations (
    object_id TEXT NOT NULL REFERENCES raw_objects(id) ON DELETE RESTRICT,
    generation BIGINT NOT NULL CHECK (generation >= 1),
    size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    chunk_count BIGINT NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    finalized BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (object_id, generation)
);

CREATE TABLE raw_chunks (
    chunk_id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL,
    generation BIGINT NOT NULL,
    ordinal BIGINT NOT NULL CHECK (ordinal >= 1),
    byte_offset BIGINT NOT NULL CHECK (byte_offset >= 0),
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 262144),
    adapter_version TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    final BOOLEAN NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    storage_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT raw_chunks_generation_fk
        FOREIGN KEY (object_id, generation)
        REFERENCES raw_generations (object_id, generation)
        ON DELETE RESTRICT,
    UNIQUE (object_id, generation, ordinal)
);

CREATE INDEX raw_chunks_content_order_idx
    ON raw_chunks (object_id, generation, ordinal);
