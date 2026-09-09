ALTER TABLE auth_cli_credentials
    ADD COLUMN device_metadata bytea,
    ADD COLUMN device_sync bytea,
    ADD COLUMN device_reported_at timestamptz;
