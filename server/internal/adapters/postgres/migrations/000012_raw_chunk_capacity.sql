-- Keep persisted Raw chunks aligned with the Archive Interface (3 MiB).
-- Replacing the old constraint also upgrades installations created before ADR-0022.
ALTER TABLE raw_chunks DROP CONSTRAINT raw_chunks_size_bytes_check;
ALTER TABLE raw_chunks ADD CONSTRAINT raw_chunks_size_bytes_check
    CHECK (size_bytes >= 0 AND size_bytes <= 3145728);
