CREATE TABLE auth_cutover_ledger (
    protocol_version TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    CHECK ((status = 'pending' AND completed_at IS NULL) OR
           (status = 'completed' AND completed_at IS NOT NULL))
);

INSERT INTO auth_cutover_ledger (protocol_version, status)
VALUES ('auth-v1', 'pending');

CREATE TABLE auth_users (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    display_name TEXT NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 200),
    avatar_url TEXT NOT NULL DEFAULT '' CHECK (octet_length(avatar_url) <= 2048),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    disabled_at TIMESTAMPTZ,
    CHECK ((status = 'active' AND disabled_at IS NULL) OR
           (status = 'disabled' AND disabled_at IS NOT NULL))
);

CREATE TABLE auth_external_identities (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
    issuer TEXT NOT NULL CHECK (octet_length(issuer) BETWEEN 1 AND 2048),
    subject TEXT NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 512),
    status TEXT NOT NULL CHECK (status IN ('active', 'unlinked')),
    display_name TEXT NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 200),
    avatar_url TEXT NOT NULL DEFAULT '' CHECK (octet_length(avatar_url) <= 2048),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    unlinked_at TIMESTAMPTZ,
    UNIQUE (issuer, subject),
    CHECK ((status = 'active' AND unlinked_at IS NULL) OR
           (status = 'unlinked' AND unlinked_at IS NOT NULL))
);

CREATE INDEX auth_external_identities_user_idx
    ON auth_external_identities (user_id, created_at, id);

CREATE TABLE auth_web_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'idle_expired', 'absolute_expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    reauthenticated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    terminal_at TIMESTAMPTZ,
    terminal_reason TEXT NOT NULL DEFAULT '' CHECK (octet_length(terminal_reason) <= 100),
    CHECK (absolute_expires_at > created_at),
    CHECK ((status = 'active' AND terminal_at IS NULL) OR
           (status <> 'active' AND terminal_at IS NOT NULL))
);

CREATE INDEX auth_web_sessions_user_active_idx
    ON auth_web_sessions (user_id, created_at DESC, id)
    WHERE status = 'active';

CREATE INDEX auth_web_sessions_absolute_expiry_idx
    ON auth_web_sessions (absolute_expires_at, id)
    WHERE status = 'active';

CREATE INDEX auth_web_sessions_idle_expiry_idx
    ON auth_web_sessions (last_used_at, id)
    WHERE status = 'active';

CREATE TABLE auth_web_session_secrets (
    session_id UUID NOT NULL REFERENCES auth_web_sessions(id) ON DELETE RESTRICT,
    generation BIGINT NOT NULL CHECK (generation >= 1),
    secret_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(secret_digest) = 32),
    csrf_digest BYTEA NOT NULL CHECK (octet_length(csrf_digest) = 32),
    digest_version TEXT NOT NULL CHECK (digest_version = 'sha256-v1'),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    superseded_at TIMESTAMPTZ,
    PRIMARY KEY (session_id, generation)
);

CREATE UNIQUE INDEX auth_web_session_current_secret_idx
    ON auth_web_session_secrets (session_id)
    WHERE superseded_at IS NULL;

CREATE TABLE auth_federated_login_transactions (
    id UUID PRIMARY KEY,
    intent TEXT NOT NULL CHECK (intent IN ('sign_in', 'bind_identity', 'reauthenticate')),
    state_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(state_digest) = 32),
    browser_binding_digest BYTEA NOT NULL CHECK (octet_length(browser_binding_digest) = 32),
    digest_version TEXT NOT NULL CHECK (digest_version = 'sha256-v1'),
    provider_registration_id TEXT NOT NULL CHECK (octet_length(provider_registration_id) BETWEEN 1 AND 100),
    provider_registration_revision TEXT NOT NULL CHECK (octet_length(provider_registration_revision) BETWEEN 1 AND 200),
    expected_issuer TEXT NOT NULL CHECK (octet_length(expected_issuer) BETWEEN 1 AND 2048),
    callback_uri TEXT NOT NULL CHECK (octet_length(callback_uri) BETWEEN 1 AND 2048),
    return_to TEXT NOT NULL CHECK (octet_length(return_to) BETWEEN 1 AND 2048),
    private_state_key_id TEXT CHECK (private_state_key_id IS NULL OR octet_length(private_state_key_id) BETWEEN 1 AND 100),
    private_state_nonce BYTEA CHECK (private_state_nonce IS NULL OR octet_length(private_state_nonce) = 12),
    private_state_ciphertext BYTEA CHECK (private_state_ciphertext IS NULL OR octet_length(private_state_ciphertext) BETWEEN 16 AND 16400),
    private_state_schema TEXT NOT NULL CHECK (octet_length(private_state_schema) BETWEEN 1 AND 100),
    initiating_user_id UUID REFERENCES auth_users(id) ON DELETE RESTRICT,
    initiating_web_session_id UUID REFERENCES auth_web_sessions(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completing', 'completed', 'denied', 'failed', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    terminal_at TIMESTAMPTZ,
    failure_code TEXT NOT NULL DEFAULT '' CHECK (octet_length(failure_code) <= 100),
    CHECK (expires_at > created_at),
    CHECK (
        (intent = 'sign_in' AND initiating_user_id IS NULL AND initiating_web_session_id IS NULL) OR
        (intent IN ('bind_identity', 'reauthenticate') AND initiating_user_id IS NOT NULL AND initiating_web_session_id IS NOT NULL)
    ),
    CHECK (
        (status IN ('pending', 'completing') AND terminal_at IS NULL) OR
        (status IN ('completed', 'denied', 'failed', 'expired') AND terminal_at IS NOT NULL)
    ),
    CHECK (
        (status IN ('pending', 'completing') AND private_state_key_id IS NOT NULL AND private_state_nonce IS NOT NULL AND private_state_ciphertext IS NOT NULL) OR
        (status IN ('completed', 'denied', 'failed', 'expired') AND private_state_key_id IS NULL AND private_state_nonce IS NULL AND private_state_ciphertext IS NULL)
    )
);

CREATE INDEX auth_federated_logins_expiry_idx
    ON auth_federated_login_transactions (expires_at, id)
    WHERE status IN ('pending', 'completing');

CREATE TABLE auth_cli_device_authorizations (
    id UUID PRIMARY KEY,
    device_code_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(device_code_digest) = 32),
    user_code_key_id TEXT NOT NULL CHECK (octet_length(user_code_key_id) BETWEEN 1 AND 100),
    user_code_digest BYTEA NOT NULL CHECK (octet_length(user_code_digest) = 32),
    digest_version TEXT NOT NULL CHECK (digest_version = 'sha256-v1'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved_unclaimed', 'denied', 'claimed', 'expired')),
    poll_interval_seconds INTEGER NOT NULL CHECK (poll_interval_seconds BETWEEN 1 AND 300),
    next_poll_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    review_web_session_id UUID REFERENCES auth_web_sessions(id) ON DELETE RESTRICT,
    reviewed_at TIMESTAMPTZ,
    approving_user_id UUID REFERENCES auth_users(id) ON DELETE RESTRICT,
    decision_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    issued_credential_id UUID UNIQUE,
    terminal_at TIMESTAMPTZ,
    CHECK (expires_at > created_at),
    CHECK ((review_web_session_id IS NULL AND reviewed_at IS NULL) OR
           (review_web_session_id IS NOT NULL AND reviewed_at IS NOT NULL)),
    CHECK (
        (status = 'pending' AND approving_user_id IS NULL AND decision_at IS NULL AND claimed_at IS NULL AND issued_credential_id IS NULL AND terminal_at IS NULL) OR
        (status = 'approved_unclaimed' AND approving_user_id IS NOT NULL AND decision_at IS NOT NULL AND claimed_at IS NULL AND issued_credential_id IS NULL AND terminal_at IS NULL) OR
        (status = 'denied' AND approving_user_id IS NOT NULL AND decision_at IS NOT NULL AND claimed_at IS NULL AND issued_credential_id IS NULL AND terminal_at IS NOT NULL) OR
        (status = 'claimed' AND approving_user_id IS NOT NULL AND decision_at IS NOT NULL AND claimed_at IS NOT NULL AND issued_credential_id IS NOT NULL AND terminal_at IS NOT NULL) OR
        (status = 'expired' AND claimed_at IS NULL AND issued_credential_id IS NULL AND terminal_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX auth_cli_device_live_user_code_idx
    ON auth_cli_device_authorizations (user_code_key_id, user_code_digest)
    WHERE status IN ('pending', 'approved_unclaimed') AND terminal_at IS NULL;

CREATE INDEX auth_cli_device_expiry_idx
    ON auth_cli_device_authorizations (expires_at, id)
    WHERE status IN ('pending', 'approved_unclaimed');

CREATE TABLE auth_cli_credentials (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
    authorization_id UUID NOT NULL UNIQUE,
    secret_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(secret_digest) = 32),
    digest_version TEXT NOT NULL CHECK (digest_version = 'sha256-v1'),
    capability_version TEXT NOT NULL CHECK (capability_version = 'atape-cli.v1'),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    revoked_at TIMESTAMPTZ,
    revoke_reason TEXT NOT NULL DEFAULT '' CHECK (octet_length(revoke_reason) <= 100),
    CHECK ((status = 'active' AND revoked_at IS NULL) OR
           (status = 'revoked' AND revoked_at IS NOT NULL))
);

ALTER TABLE auth_cli_device_authorizations
    ADD CONSTRAINT auth_cli_device_issued_credential_fk
    FOREIGN KEY (issued_credential_id) REFERENCES auth_cli_credentials(id) ON DELETE RESTRICT;

CREATE INDEX auth_cli_credentials_user_active_idx
    ON auth_cli_credentials (user_id, created_at DESC, id)
    WHERE status = 'active';

CREATE TABLE auth_user_code_attempt_windows (
    web_session_id UUID NOT NULL REFERENCES auth_web_sessions(id) ON DELETE RESTRICT,
    window_start TIMESTAMPTZ NOT NULL,
    failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 0 AND 100000),
    blocked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (web_session_id, window_start)
);

CREATE INDEX auth_user_code_attempt_cleanup_idx
    ON auth_user_code_attempt_windows (window_start, web_session_id);

CREATE TABLE security_audit_events (
    id UUID PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    initiator_kind TEXT NOT NULL CHECK (initiator_kind IN ('principal', 'federated_login', 'anonymous_request', 'system')),
    initiator_id TEXT NOT NULL DEFAULT '' CHECK (octet_length(initiator_id) <= 200),
    action TEXT NOT NULL CHECK (octet_length(action) BETWEEN 1 AND 100),
    target_kind TEXT NOT NULL CHECK (octet_length(target_kind) BETWEEN 1 AND 100),
    target_id TEXT NOT NULL DEFAULT '' CHECK (octet_length(target_id) <= 200),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
    reason TEXT NOT NULL DEFAULT '' CHECK (octet_length(reason) <= 100),
    request_id TEXT NOT NULL DEFAULT '' CHECK (octet_length(request_id) <= 200),
    provider_registration_id TEXT NOT NULL DEFAULT '' CHECK (octet_length(provider_registration_id) <= 100),
    web_session_id UUID,
    cli_credential_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 2048)
);

CREATE INDEX security_audit_events_occurred_idx
    ON security_audit_events (occurred_at DESC, id);

CREATE INDEX security_audit_events_target_idx
    ON security_audit_events (target_kind, target_id, occurred_at DESC, id);
