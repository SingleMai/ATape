ALTER TABLE canonical_events
    ADD COLUMN tool_update_json TEXT NOT NULL DEFAULT '';
ALTER TABLE canonical_event_versions
    ADD COLUMN tool_update_json TEXT NOT NULL DEFAULT '';
