import type { DatabaseSync } from "node:sqlite"

/** Reproduce a genuine pre-migration schema for persisted-state upgrade tests. */
export const downgradeJournalToV7 = (db: DatabaseSync) => {
  db.exec(`DROP INDEX retained_source_metadata;
    DROP TRIGGER metadata_legacy_migrations_insert;
    DROP TRIGGER metadata_legacy_migrations_delete;
    DROP TRIGGER source_metadata_update;
    DROP TRIGGER adoption_metadata_update;
    DROP TABLE legacy_migrations;
    ALTER TABLE captures DROP COLUMN source_metadata;
    ALTER TABLE captures DROP COLUMN source_metadata_sha;
    ALTER TABLE captures DROP COLUMN source_metadata_bytes;
    ALTER TABLE scopes DROP COLUMN revision_floor;
    ALTER TABLE scopes DROP COLUMN adoption_metadata;
    ALTER TABLE scopes DROP COLUMN adoption_metadata_sha;
    ALTER TABLE scopes DROP COLUMN adoption_metadata_bytes;
    ALTER TABLE binding DROP COLUMN metadata_bytes;
    PRAGMA user_version=7`)
}
