-- Additive, body-free projection. NULL includes parts prepared by older writers.
-- Empty parts also get a version; row counts cannot establish completeness.
ALTER TABLE canonical_publication_parts ADD COLUMN overview_version INTEGER
 CHECK(overview_version IS NULL OR (overview_version=1 AND format_version IS NOT NULL AND format_version=1));
CREATE INDEX publication_overview_backfill ON canonical_publication_parts(attempt_id,ordinal)
 WHERE format_version=1 AND overview_version IS DISTINCT FROM 1;

CREATE TABLE overview_publication_messages (
 attempt_id UUID NOT NULL,
 part_ordinal INTEGER NOT NULL,
 entry_index INTEGER NOT NULL CHECK(entry_index>=0),
 event_id TEXT NOT NULL,
 thread_id TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL,
 author TEXT NOT NULL,
 root BOOLEAN NOT NULL,
 source_order BIGINT NOT NULL,
 event_index BIGINT NOT NULL,
 PRIMARY KEY(attempt_id,part_ordinal,entry_index),
 FOREIGN KEY(attempt_id,part_ordinal) REFERENCES canonical_publication_parts(attempt_id,ordinal) ON DELETE CASCADE
);
CREATE INDEX overview_publication_messages_time ON overview_publication_messages(attempt_id,occurred_at);

CREATE TABLE overview_publication_usage (
 attempt_id UUID NOT NULL,
 part_ordinal INTEGER NOT NULL,
 entry_index INTEGER NOT NULL CHECK(entry_index>=0),
 source_key TEXT NOT NULL,
 thread_id TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL,
 model TEXT NOT NULL,
 input_tokens BIGINT,
 output_tokens BIGINT,
 cache_read_tokens BIGINT,
 cache_write_tokens BIGINT,
 PRIMARY KEY(attempt_id,part_ordinal,entry_index),
 FOREIGN KEY(attempt_id,part_ordinal) REFERENCES canonical_publication_parts(attempt_id,ordinal) ON DELETE CASCADE
);
CREATE INDEX overview_publication_usage_time ON overview_publication_usage(attempt_id,occurred_at);
CREATE INDEX overview_publication_usage_model_time ON overview_publication_usage(attempt_id,model,occurred_at);
