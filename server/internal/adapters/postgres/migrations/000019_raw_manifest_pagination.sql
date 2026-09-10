CREATE INDEX raw_objects_session_created_page_idx ON raw_objects (session_id, created_at DESC, id DESC);
