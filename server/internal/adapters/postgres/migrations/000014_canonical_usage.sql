CREATE TABLE canonical_usage (
    source_key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    digest TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    model TEXT NOT NULL,
    input_tokens BIGINT CHECK (input_tokens >= 0),
    output_tokens BIGINT CHECK (output_tokens >= 0),
    cache_read_tokens BIGINT CHECK (cache_read_tokens >= 0),
    cache_write_tokens BIGINT CHECK (cache_write_tokens >= 0),
    FOREIGN KEY (session_id, thread_id) REFERENCES canonical_threads(session_id, id) ON DELETE CASCADE,
    CHECK (input_tokens IS NULL OR COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) <= input_tokens)
);
CREATE INDEX canonical_usage_session_time_idx ON canonical_usage(session_id, occurred_at);
CREATE INDEX canonical_events_activity_idx ON canonical_events(session_id, occurred_at) WHERE kind = 'message';
