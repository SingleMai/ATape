-- A Canonical Event may need to be projected again when its Session metadata
-- changes even though the Event's own ingest sequence remains unchanged.
ALTER TABLE canonical_projection_changes
DROP CONSTRAINT canonical_projection_changes_event_id_event_ingest_seq_key;
