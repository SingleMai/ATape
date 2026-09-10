-- Candidate storage is separate from all ordinary Canonical and Search reads.
-- Reserving a source explicitly selects publication mode; it never migrates a
-- legacy Session. Stable binding/fence rows survive candidate cleanup.
CREATE TABLE canonical_publication_sources (
 session_id TEXT PRIMARY KEY,
 source_key TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL REFERENCES canonical_projects(id),
 captured_by_user_id UUID NOT NULL REFERENCES auth_users(id),
 installation_id TEXT NOT NULL,
 adapter_id TEXT NOT NULL,
 source_session_id TEXT NOT NULL,
 origin_key TEXT NOT NULL,
 writer_fence BIGINT NOT NULL DEFAULT 0 CHECK(writer_fence>=0),
 current_head TEXT
);
CREATE INDEX publication_sources_owner ON canonical_publication_sources(captured_by_user_id,session_id);
CREATE TABLE canonical_publication_reservations (
 id UUID PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES canonical_publication_sources(session_id),
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX publication_reservations_source ON canonical_publication_reservations(session_id,expires_at);
CREATE TABLE canonical_publication_attempts (
 id UUID PRIMARY KEY REFERENCES canonical_publication_reservations(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES canonical_publication_sources(session_id),
 capture_id TEXT NOT NULL,
 base_head TEXT,
 transform_version TEXT NOT NULL,
 fence BIGINT NOT NULL CHECK(fence>0),
 lease_until TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','sealed','rejected')),
 part_count INTEGER NOT NULL DEFAULT 0 CHECK(part_count>=0),
 retained_bytes BIGINT NOT NULL DEFAULT 0 CHECK(retained_bytes>=0),
 seal_json TEXT
);
CREATE INDEX publication_attempts_source ON canonical_publication_attempts(session_id);
CREATE TABLE canonical_publication_parts (
 attempt_id UUID NOT NULL REFERENCES canonical_publication_attempts(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 digest TEXT NOT NULL CHECK(length(digest)=64),
 byte_count BIGINT NOT NULL CHECK(byte_count>0),
 body BYTEA NOT NULL,
 PRIMARY KEY(attempt_id,ordinal),
 CHECK(octet_length(body)=byte_count)
);
