ALTER TABLE canonical_publication_attempts
 DROP CONSTRAINT canonical_publication_attempts_state_check,
 ADD CONSTRAINT canonical_publication_attempts_state_check CHECK(state IN ('open','sealed','validating','validated','rejected')),
 ADD COLUMN validated_parts INTEGER NOT NULL DEFAULT 0 CHECK(validated_parts>=0),
 ADD COLUMN candidate_events INTEGER NOT NULL DEFAULT 0 CHECK(candidate_events>=0),
 ADD COLUMN candidate_usage INTEGER NOT NULL DEFAULT 0 CHECK(candidate_usage>=0),
 ADD COLUMN header_digest TEXT,
 ADD COLUMN target_json TEXT;

-- The original wire receipt stays immutable. Validated bytes replace, rather
-- than duplicate, the pending body. Recovery never needs to rerun a converter.
ALTER TABLE canonical_publication_parts
 ALTER COLUMN body DROP NOT NULL,
 DROP CONSTRAINT canonical_publication_parts_check,
 ADD COLUMN validated_body BYTEA,
 ADD COLUMN format_version INTEGER,
 ADD COLUMN stored_bytes BIGINT GENERATED ALWAYS AS
  (coalesce(octet_length(body),octet_length(validated_body))) STORED NOT NULL,
 ADD CONSTRAINT publication_part_body_check CHECK(
  (body IS NOT NULL AND validated_body IS NULL AND format_version IS NULL AND octet_length(body)=byte_count)
  OR (body IS NULL AND validated_body IS NOT NULL AND format_version IS NOT NULL AND format_version=1 AND octet_length(validated_body)>0)
 );

CREATE TABLE canonical_publication_members (
 attempt_id UUID NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('session','thread','event','usage')),
 record_id TEXT NOT NULL,
 source_key TEXT NOT NULL,
 part_ordinal INTEGER NOT NULL,
 entry_index INTEGER NOT NULL CHECK(entry_index>=0),
 thread_id TEXT NOT NULL,
 source_order BIGINT NOT NULL DEFAULT 0 CHECK(source_order>=0),
 event_index BIGINT NOT NULL DEFAULT 0 CHECK(event_index>=0),
 search_descriptor TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(attempt_id,kind,record_id),
 UNIQUE(attempt_id,kind,source_key),
 FOREIGN KEY(attempt_id,part_ordinal) REFERENCES canonical_publication_parts(attempt_id,ordinal) ON DELETE CASCADE
);
CREATE INDEX publication_members_thread_order ON canonical_publication_members(attempt_id,kind,thread_id,source_order,event_index,record_id);

-- Body-free source-version identities survive candidate reclamation. Retrying
-- the same source version must not silently replace its meaning.
CREATE TABLE canonical_publication_record_versions (
 session_id TEXT NOT NULL REFERENCES canonical_publication_sources(session_id),
 kind TEXT NOT NULL,
 source_key TEXT NOT NULL,
 record_id TEXT NOT NULL,
 thread_id TEXT NOT NULL,
 projection_revision BIGINT NOT NULL CHECK(projection_revision>=0),
 revision BIGINT NOT NULL CHECK(revision>0),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
 PRIMARY KEY(kind,source_key,projection_revision,revision)
);
CREATE INDEX publication_record_identity ON canonical_publication_record_versions(session_id,kind,record_id);
