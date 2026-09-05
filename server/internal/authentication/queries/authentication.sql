-- name: AcquireAuthenticationLock :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(lock_key)::text, 0));

-- name: GetAuthenticationCutoverStatus :one
SELECT status
FROM auth_cutover_ledger
WHERE protocol_version = 'auth-v1';

-- name: ListLivePrivateStateKeyIDs :many
SELECT DISTINCT private_state_key_id
FROM auth_federated_login_transactions
WHERE status IN ('pending', 'completing')
  AND expires_at > clock_timestamp()
  AND private_state_key_id IS NOT NULL;

-- name: ListLiveUserCodeKeyIDs :many
SELECT DISTINCT user_code_key_id
FROM auth_cli_device_authorizations
WHERE status IN ('pending', 'approved_unclaimed')
  AND expires_at > clock_timestamp();

-- name: ListLiveProviderRegistrations :many
SELECT DISTINCT provider_registration_id, provider_registration_revision,
       expected_issuer, callback_uri
FROM auth_federated_login_transactions
WHERE status IN ('pending', 'completing')
  AND expires_at > clock_timestamp();

-- name: InsertFederatedLogin :exec
INSERT INTO auth_federated_login_transactions (
    id, intent, state_digest, browser_binding_digest, digest_version,
    provider_registration_id, provider_registration_revision, expected_issuer,
    callback_uri, return_to, private_state_key_id, private_state_nonce,
    private_state_ciphertext, private_state_schema, initiating_user_id,
    initiating_web_session_id, status, expires_at
) VALUES (
    $1, $2, $3, $4, 'sha256-v1',
    $5, $6, $7, $8, $9, $10, $11, $12, $13,
    $14, $15, 'pending', sqlc.arg(expires_at)::timestamptz
);

-- name: GetFederatedLoginByStateForUpdate :one
SELECT id, intent, provider_registration_id, provider_registration_revision,
       expected_issuer, callback_uri, return_to, private_state_key_id,
       private_state_nonce, private_state_ciphertext, private_state_schema,
       browser_binding_digest, initiating_user_id, initiating_web_session_id,
       status, created_at, expires_at
FROM auth_federated_login_transactions
WHERE state_digest = $1
FOR UPDATE;

-- name: DatabaseTime :one
SELECT clock_timestamp()::timestamptz AS now;

-- name: ClaimFederatedLogin :one
UPDATE auth_federated_login_transactions
SET status = 'completing'
WHERE id = $1 AND status = 'pending' AND expires_at > clock_timestamp()
RETURNING created_at, expires_at;

-- name: ExpireFederatedLogin :exec
UPDATE auth_federated_login_transactions
SET status = 'expired', terminal_at = clock_timestamp(), failure_code = 'login_expired',
    private_state_key_id = NULL, private_state_nonce = NULL, private_state_ciphertext = NULL
WHERE id = $1 AND status IN ('pending', 'completing');

-- name: FinishFederatedLogin :exec
UPDATE auth_federated_login_transactions
SET status = sqlc.arg(status), terminal_at = clock_timestamp(), failure_code = sqlc.arg(failure_code),
    private_state_key_id = NULL, private_state_nonce = NULL, private_state_ciphertext = NULL
WHERE id = sqlc.arg(id) AND status = 'completing';

-- name: GetExternalIdentityForUpdate :one
SELECT id, user_id, status, display_name, avatar_url, created_at, last_verified_at
FROM auth_external_identities
WHERE issuer = $1 AND subject = $2
FOR UPDATE;

-- name: InsertUser :one
INSERT INTO auth_users (id, status, display_name, avatar_url)
VALUES ($1, 'active', $2, $3)
RETURNING created_at;

-- name: GetUserForUpdate :one
SELECT id, status, display_name, avatar_url, created_at, updated_at, disabled_at
FROM auth_users
WHERE id = $1
FOR UPDATE;

-- name: InsertExternalIdentity :exec
INSERT INTO auth_external_identities (
    id, user_id, issuer, subject, status, display_name, avatar_url
) VALUES ($1, $2, $3, $4, 'active', $5, $6);

-- name: RefreshExternalIdentity :exec
UPDATE auth_external_identities
SET status = 'active', display_name = $2, avatar_url = $3,
    last_verified_at = clock_timestamp(), unlinked_at = NULL
WHERE id = $1;

-- name: InsertWebSession :one
INSERT INTO auth_web_sessions (
    id, user_id, status, absolute_expires_at
) VALUES ($1, $2, 'active', clock_timestamp() + sqlc.arg(absolute_ttl_seconds)::integer * interval '1 second')
RETURNING created_at, last_used_at, reauthenticated_at, absolute_expires_at;

-- name: InsertWebSessionSecret :one
INSERT INTO auth_web_session_secrets (
    session_id, generation, secret_digest, csrf_digest, digest_version
) VALUES ($1, $2, $3, $4, 'sha256-v1')
RETURNING issued_at;

-- name: GetCurrentWebSecretGenerationForUpdate :one
SELECT generation
FROM auth_web_session_secrets
WHERE session_id = $1 AND superseded_at IS NULL
FOR UPDATE;

-- name: GetWebAuthenticationForUpdate :one
SELECT s.id, s.user_id, s.status AS session_status, s.created_at,
       s.last_used_at, s.reauthenticated_at, s.absolute_expires_at,
       u.status AS user_status, u.display_name, u.avatar_url, u.created_at AS user_created_at,
       ss.generation, ss.csrf_digest
FROM auth_web_session_secrets ss
JOIN auth_web_sessions s ON s.id = ss.session_id
JOIN auth_users u ON u.id = s.user_id
WHERE ss.secret_digest = $1 AND ss.superseded_at IS NULL
FOR UPDATE OF s, ss
FOR SHARE OF u;

-- name: GetWebSessionForUpdate :one
SELECT s.id, s.user_id, s.status AS session_status, s.created_at,
       s.last_used_at, s.reauthenticated_at, s.absolute_expires_at,
       u.status AS user_status, u.display_name, u.avatar_url, u.created_at AS user_created_at
FROM auth_web_sessions s
JOIN auth_users u ON u.id = s.user_id
WHERE s.id = $1
FOR UPDATE OF s
FOR SHARE OF u;

-- name: TouchWebSession :one
UPDATE auth_web_sessions
SET last_used_at = clock_timestamp()
WHERE id = $1
  AND status = 'active'
  AND last_used_at <= clock_timestamp() - sqlc.arg(write_interval_seconds)::integer * interval '1 second'
RETURNING last_used_at;

-- name: TerminalWebSession :exec
UPDATE auth_web_sessions
SET status = $2, terminal_at = clock_timestamp(), terminal_reason = $3
WHERE id = $1 AND status = 'active';

-- name: SupersedeWebSessionSecret :exec
UPDATE auth_web_session_secrets
SET superseded_at = clock_timestamp()
WHERE session_id = $1 AND superseded_at IS NULL;

-- name: ReauthenticateWebSession :one
UPDATE auth_web_sessions
SET reauthenticated_at = clock_timestamp(),
    last_used_at = clock_timestamp(),
    absolute_expires_at = clock_timestamp() + sqlc.arg(absolute_ttl_seconds)::integer * interval '1 second'
WHERE id = $1 AND status = 'active'
RETURNING created_at, last_used_at, reauthenticated_at, absolute_expires_at;

-- name: RevokeWebSessionForUser :execrows
UPDATE auth_web_sessions
SET status = 'revoked', terminal_at = clock_timestamp(), terminal_reason = $3
WHERE id = $1 AND user_id = $2 AND status = 'active';

-- name: RevokeAllWebSessionsForUser :execrows
UPDATE auth_web_sessions
SET status = 'revoked', terminal_at = clock_timestamp(), terminal_reason = $2
WHERE user_id = $1 AND status = 'active';

-- name: ListActiveWebSessionsForUser :many
SELECT id, created_at, last_used_at, reauthenticated_at, absolute_expires_at
FROM auth_web_sessions
WHERE user_id = sqlc.arg(user_id)
  AND status = 'active'
  AND absolute_expires_at > clock_timestamp()
  AND last_used_at + sqlc.arg(idle_deadline_seconds)::integer * interval '1 second' > clock_timestamp()
ORDER BY last_used_at DESC, created_at DESC, id DESC;

-- name: InsertCLIDeviceAuthorization :one
INSERT INTO auth_cli_device_authorizations (
    id, device_code_digest, user_code_key_id, user_code_digest, digest_version,
    status, poll_interval_seconds, next_poll_at, expires_at
) VALUES (
    $1, $2, $3, $4, 'sha256-v1', 'pending', $5,
    clock_timestamp() + sqlc.arg(initial_poll_seconds)::integer * interval '1 second',
    clock_timestamp() + sqlc.arg(ttl_seconds)::integer * interval '1 second'
)
RETURNING created_at, expires_at;

-- name: LiveCLICodeExists :one
SELECT EXISTS (
    SELECT 1 FROM auth_cli_device_authorizations
    WHERE user_code_key_id = $1 AND user_code_digest = $2
      AND status IN ('pending', 'approved_unclaimed')
) AS found;

-- name: GetCLIAuthorizationByUserCodeForUpdate :one
SELECT id, status, user_code_key_id, expires_at, review_web_session_id,
       approving_user_id, decision_at
FROM auth_cli_device_authorizations
WHERE user_code_key_id = $1 AND user_code_digest = $2
FOR UPDATE;

-- name: BindCLIReviewSession :one
UPDATE auth_cli_device_authorizations
SET review_web_session_id = $2, reviewed_at = clock_timestamp()
WHERE id = $1 AND status = 'pending' AND review_web_session_id IS NULL
RETURNING reviewed_at;

-- name: GetCodeAttemptWindowForUpdate :one
SELECT failure_count, blocked_until
FROM auth_user_code_attempt_windows
WHERE web_session_id = $1 AND window_start = $2
FOR UPDATE;

-- name: UpsertCodeAttemptFailure :one
INSERT INTO auth_user_code_attempt_windows (
    web_session_id, window_start, failure_count, blocked_until
) VALUES (
    $1, $2, 1,
    CASE WHEN sqlc.arg(maximum_failures)::integer <= 1
         THEN sqlc.arg(window_end)::timestamptz ELSE NULL END
)
ON CONFLICT (web_session_id, window_start) DO UPDATE
SET failure_count = auth_user_code_attempt_windows.failure_count + 1,
    blocked_until = CASE
        WHEN auth_user_code_attempt_windows.failure_count + 1 >= sqlc.arg(maximum_failures)::integer
        THEN sqlc.arg(window_end)::timestamptz
        ELSE auth_user_code_attempt_windows.blocked_until
    END,
    updated_at = clock_timestamp()
RETURNING failure_count, blocked_until;

-- name: GetCLIAuthorizationForDecision :one
SELECT id, status, expires_at, review_web_session_id, approving_user_id
FROM auth_cli_device_authorizations
WHERE id = $1
FOR UPDATE;

-- name: ApproveCLIAuthorization :exec
UPDATE auth_cli_device_authorizations
SET status = 'approved_unclaimed', approving_user_id = $2, decision_at = clock_timestamp()
WHERE id = $1 AND status = 'pending';

-- name: DenyCLIAuthorization :exec
UPDATE auth_cli_device_authorizations
SET status = 'denied', approving_user_id = $2, decision_at = clock_timestamp(),
    terminal_at = clock_timestamp()
WHERE id = $1 AND status = 'pending';

-- name: ExpireCLIAuthorization :exec
UPDATE auth_cli_device_authorizations
SET status = 'expired', terminal_at = clock_timestamp()
WHERE id = $1 AND status IN ('pending', 'approved_unclaimed');

-- name: GetCLIAuthorizationByDeviceCodeForUpdate :one
SELECT id, status, poll_interval_seconds, next_poll_at, created_at, expires_at,
       approving_user_id, issued_credential_id
FROM auth_cli_device_authorizations
WHERE device_code_digest = $1
FOR UPDATE;

-- name: AdvanceCLIPoll :one
UPDATE auth_cli_device_authorizations
SET next_poll_at = clock_timestamp() + sqlc.arg(interval_seconds)::integer * interval '1 second',
    poll_interval_seconds = sqlc.arg(interval_seconds)::integer
WHERE id = $1 AND status = 'pending'
RETURNING next_poll_at;

-- name: InsertCLICredential :one
INSERT INTO auth_cli_credentials (
    id, user_id, authorization_id, secret_digest, digest_version,
    capability_version, status
) VALUES ($1, $2, $3, $4, 'sha256-v1', $5, 'active')
RETURNING created_at, last_used_at;

-- name: ClaimCLIAuthorization :exec
UPDATE auth_cli_device_authorizations
SET status = 'claimed', claimed_at = clock_timestamp(), issued_credential_id = $2,
    terminal_at = clock_timestamp()
WHERE id = $1 AND status = 'approved_unclaimed';

-- name: ReconcileCLICredentialClaim :one
SELECT c.id, c.secret_digest, c.capability_version, c.created_at,
       u.id AS user_id, u.display_name, u.avatar_url, u.created_at AS user_created_at
FROM auth_cli_device_authorizations a
JOIN auth_cli_credentials c ON c.id = a.issued_credential_id
JOIN auth_users u ON u.id = c.user_id
WHERE a.id = $1 AND a.status = 'claimed' AND c.id = $2;

-- name: GetCLIAuthenticationForUpdate :one
SELECT c.id, c.user_id, c.status AS credential_status, c.capability_version,
       c.created_at, c.last_used_at, u.status AS user_status,
       u.display_name, u.avatar_url, u.created_at AS user_created_at
FROM auth_cli_credentials c
JOIN auth_users u ON u.id = c.user_id
WHERE c.secret_digest = $1
FOR UPDATE OF c
FOR SHARE OF u;

-- name: GetCLICredentialForPrincipal :one
SELECT id, user_id, status
FROM auth_cli_credentials
WHERE id = $1
FOR UPDATE;

-- name: TouchCLICredential :one
UPDATE auth_cli_credentials
SET last_used_at = clock_timestamp()
WHERE id = $1 AND status = 'active'
  AND last_used_at <= clock_timestamp() - sqlc.arg(write_interval_seconds)::integer * interval '1 second'
RETURNING last_used_at;

-- name: RevokeCLICredentialForUser :execrows
UPDATE auth_cli_credentials
SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = $3
WHERE id = $1 AND user_id = $2 AND status = 'active';

-- name: RevokeAllCLICredentialsForUser :execrows
UPDATE auth_cli_credentials
SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = $2
WHERE user_id = $1 AND status = 'active';

-- name: InsertSecurityAuditEvent :exec
INSERT INTO security_audit_events (
    id, initiator_kind, initiator_id, action, target_kind, target_id,
    outcome, reason, request_id, provider_registration_id,
    web_session_id, cli_credential_id, metadata
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);

-- name: TryMaintenanceLock :one
SELECT pg_try_advisory_xact_lock(sqlc.arg(lock_id)::bigint) AS acquired;

-- name: ExpireFederatedLoginBatch :execrows
WITH candidates AS (
    SELECT id FROM auth_federated_login_transactions
    WHERE status IN ('pending', 'completing') AND expires_at <= clock_timestamp()
    ORDER BY expires_at, id LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE SKIP LOCKED
)
UPDATE auth_federated_login_transactions f
SET status = 'expired', terminal_at = clock_timestamp(), failure_code = 'login_expired',
    private_state_key_id = NULL, private_state_nonce = NULL, private_state_ciphertext = NULL
FROM candidates c WHERE f.id = c.id;

-- name: ExpireCLIAuthorizationBatch :execrows
WITH candidates AS (
    SELECT id FROM auth_cli_device_authorizations
    WHERE status IN ('pending', 'approved_unclaimed') AND expires_at <= clock_timestamp()
    ORDER BY expires_at, id LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE SKIP LOCKED
)
UPDATE auth_cli_device_authorizations a
SET status = 'expired', terminal_at = clock_timestamp()
FROM candidates c WHERE a.id = c.id;

-- name: ExpireWebSessionBatch :many
WITH candidates AS (
    SELECT id,
           CASE WHEN absolute_expires_at <= clock_timestamp()
                THEN 'absolute_expired' ELSE 'idle_expired' END AS expired_status,
           CASE WHEN absolute_expires_at <= clock_timestamp()
                THEN 'absolute_lifetime' ELSE 'idle_timeout' END AS expired_reason
    FROM auth_web_sessions
    WHERE status = 'active'
      AND (absolute_expires_at <= clock_timestamp()
           OR last_used_at + sqlc.arg(idle_deadline_seconds)::integer * interval '1 second' <= clock_timestamp())
    ORDER BY LEAST(
        absolute_expires_at,
        last_used_at + sqlc.arg(idle_deadline_seconds)::integer * interval '1 second'
    ), id
    LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE SKIP LOCKED
)
UPDATE auth_web_sessions s
SET status = c.expired_status, terminal_at = clock_timestamp(), terminal_reason = c.expired_reason
FROM candidates c WHERE s.id = c.id
RETURNING s.id, s.status, s.terminal_reason;

-- name: DeleteFederatedLoginBatch :execrows
WITH candidates AS (
    SELECT id FROM auth_federated_login_transactions
    WHERE terminal_at <= clock_timestamp() - sqlc.arg(retention_seconds)::integer * interval '1 second'
    ORDER BY terminal_at, id LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE SKIP LOCKED
)
DELETE FROM auth_federated_login_transactions f USING candidates c WHERE f.id = c.id;

-- name: DeleteCLIAuthorizationBatch :execrows
WITH candidates AS (
    SELECT a.id FROM auth_cli_device_authorizations a
    WHERE a.terminal_at <= clock_timestamp() - sqlc.arg(retention_seconds)::integer * interval '1 second'
    ORDER BY a.terminal_at, a.id LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE OF a SKIP LOCKED
)
DELETE FROM auth_cli_device_authorizations a USING candidates c WHERE a.id = c.id;

-- name: DeleteWebSessionSecretBatch :execrows
WITH candidates AS (
    SELECT ss.session_id, ss.generation
    FROM auth_web_session_secrets ss
    JOIN auth_web_sessions s ON s.id = ss.session_id
    WHERE ss.superseded_at <= clock_timestamp() - sqlc.arg(retention_seconds)::integer * interval '1 second'
       OR s.terminal_at <= clock_timestamp() - sqlc.arg(retention_seconds)::integer * interval '1 second'
    ORDER BY COALESCE(ss.superseded_at, s.terminal_at), ss.session_id, ss.generation
    LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE OF ss SKIP LOCKED
)
DELETE FROM auth_web_session_secrets s USING candidates c
WHERE s.session_id = c.session_id AND s.generation = c.generation;

-- name: DeleteWebSessionBatch :execrows
WITH candidates AS (
    SELECT s.id FROM auth_web_sessions s
    WHERE s.terminal_at <= clock_timestamp() - sqlc.arg(retention_seconds)::integer * interval '1 second'
      AND NOT EXISTS (SELECT 1 FROM auth_web_session_secrets ss WHERE ss.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM auth_user_code_attempt_windows w WHERE w.web_session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM auth_cli_device_authorizations a WHERE a.review_web_session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM auth_federated_login_transactions f WHERE f.initiating_web_session_id = s.id)
    ORDER BY s.terminal_at, s.id LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE OF s SKIP LOCKED
)
DELETE FROM auth_web_sessions s USING candidates c WHERE s.id = c.id;

-- name: DeleteCLICredentialBatch :execrows
WITH candidates AS (
    SELECT c.id FROM auth_cli_credentials c
    WHERE c.revoked_at <= clock_timestamp() - sqlc.arg(retention_seconds)::integer * interval '1 second'
      AND NOT EXISTS (SELECT 1 FROM auth_cli_device_authorizations a WHERE a.issued_credential_id = c.id)
    ORDER BY c.revoked_at, c.id LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE OF c SKIP LOCKED
)
DELETE FROM auth_cli_credentials c USING candidates x WHERE c.id = x.id;

-- name: DeleteCodeAttemptWindowBatch :execrows
WITH candidates AS (
    SELECT web_session_id, window_start FROM auth_user_code_attempt_windows
    WHERE window_start <= clock_timestamp() - sqlc.arg(retention_seconds)::integer * interval '1 second'
    ORDER BY window_start, web_session_id LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE SKIP LOCKED
)
DELETE FROM auth_user_code_attempt_windows w USING candidates c
WHERE w.web_session_id = c.web_session_id AND w.window_start = c.window_start;
