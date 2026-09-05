package authentication

import (
	"context"
	"crypto/hmac"
	"errors"
	"io"
	"math"
	"strings"
	"time"

	authdb "github.com/SingleMai/ATape/server/internal/authentication/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	deviceUserCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	deviceUserCodeLength   = 6
)

// CLIClientLabel is the stable client identity shown on browser approval views.
const CLIClientLabel = "atape-cli"

// CLICapabilityVersion is the maximum authority carried by a CLI Credential.
const CLICapabilityVersion = "atape-cli.v1"

func (m *Module) CreateCLIDeviceAuthorization(ctx context.Context) (CLIDeviceAuthorization, error) {
	if err := ctx.Err(); err != nil {
		return CLIDeviceAuthorization{}, err
	}
	deviceCode, err := m.newSecret("atd_v1_")
	if err != nil {
		return CLIDeviceAuthorization{}, err
	}
	deviceDigest := highEntropyDigest("cli-device-code", deviceCode)
	result, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (CLIDeviceAuthorization, error) {
		queries := authdb.New(tx)
		if err := queries.AcquireAuthenticationLock(ctx, "cli-user-code-generation"); err != nil {
			return CLIDeviceAuthorization{}, err
		}
		keyID, root, err := m.pepperKeys.active()
		if err != nil {
			return CLIDeviceAuthorization{}, domainError(CodeMisconfigured)
		}
		var normalizedCode string
		var codeDigest [32]byte
		selected := false
		for attempt := 0; attempt < m.policy.ShortCodeAttempts; attempt++ {
			normalizedCode, err = m.randomDeviceUserCode()
			if err != nil {
				return CLIDeviceAuthorization{}, err
			}
			collision, collisionErr := m.liveCodeCollision(ctx, queries, normalizedCode)
			if collisionErr != nil {
				return CLIDeviceAuthorization{}, collisionErr
			}
			if collision {
				continue
			}
			codeDigest, err = keyedCodeDigest(root, "device-user-code", normalizedCode)
			if err != nil {
				return CLIDeviceAuthorization{}, err
			}
			selected = true
			break
		}
		if !selected {
			return CLIDeviceAuthorization{}, domainError(CodeServiceUnavailable)
		}
		id, err := newID()
		if err != nil {
			return CLIDeviceAuthorization{}, err
		}
		row, err := queries.InsertCLIDeviceAuthorization(ctx, authdb.InsertCLIDeviceAuthorizationParams{
			ID: mustDatabaseUUID(id), DeviceCodeDigest: deviceDigest[:],
			UserCodeKeyID: keyID, UserCodeDigest: codeDigest[:],
			PollIntervalSeconds: mustDurationSeconds(m.policy.InitialPollInterval),
			InitialPollSeconds:  mustDurationSeconds(m.policy.InitialPollInterval),
			TtlSeconds:          mustDurationSeconds(m.policy.CLIAuthorizationTTL),
		})
		if err != nil {
			return CLIDeviceAuthorization{}, err
		}
		return CLIDeviceAuthorization{
			ID: id, DeviceCode: deviceCode, UserCode: displayDeviceUserCode(normalizedCode),
			ExpiresAt:           row.ExpiresAt,
			PollIntervalSeconds: int(mustDurationSeconds(m.policy.InitialPollInterval)),
		}, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return CLIDeviceAuthorization{}, err
		}
		return CLIDeviceAuthorization{}, unavailable("create CLI Device Authorization", err)
	}
	return result, nil
}

func (m *Module) randomDeviceUserCode() (string, error) {
	random := make([]byte, deviceUserCodeLength)
	if _, err := io.ReadFull(m.random, random); err != nil {
		return "", errors.New("secure random source failed")
	}
	var builder strings.Builder
	builder.Grow(deviceUserCodeLength)
	for _, value := range random {
		builder.WriteByte(deviceUserCodeAlphabet[int(value)&(len(deviceUserCodeAlphabet)-1)])
	}
	return builder.String(), nil
}

func normalizeDeviceUserCode(value string) (string, bool) {
	var builder strings.Builder
	for _, character := range strings.ToUpper(strings.TrimSpace(value)) {
		switch character {
		case ' ':
			continue
		}
		if character > 127 || !strings.ContainsRune(deviceUserCodeAlphabet, character) {
			return "", false
		}
		builder.WriteRune(character)
	}
	normalized := builder.String()
	return normalized, len(normalized) == deviceUserCodeLength
}

func displayDeviceUserCode(normalized string) string {
	if len(normalized) != deviceUserCodeLength {
		return ""
	}
	return normalized
}

func (m *Module) liveCodeCollision(
	ctx context.Context,
	queries *authdb.Queries,
	normalized string,
) (bool, error) {
	for _, id := range m.acceptedPepperIDs() {
		root, ok := m.pepperKeys.get(id)
		if !ok {
			return false, domainError(CodeMisconfigured)
		}
		digest, err := keyedCodeDigest(root, "device-user-code", normalized)
		if err != nil {
			return false, err
		}
		found, err := queries.LiveCLICodeExists(ctx, authdb.LiveCLICodeExistsParams{
			UserCodeKeyID: id, UserCodeDigest: digest[:],
		})
		if err != nil {
			return false, err
		}
		if found {
			return true, nil
		}
	}
	return false, nil
}

type resolveCLIResult struct {
	view      CLIAuthorizationView
	domainErr error
}

func (m *Module) ResolveCLIDeviceAuthorization(
	ctx context.Context,
	principal Principal,
	userCode string,
	requestID string,
) (CLIAuthorizationView, error) {
	if !validateRequestID(requestID) {
		return CLIAuthorizationView{}, domainError(CodeInvalidRequest)
	}
	result, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (resolveCLIResult, error) {
		queries := authdb.New(tx)
		session, now, err := m.validateWebPrincipalInTransaction(ctx, queries, principal)
		if err != nil {
			return resolveCLIResult{}, err
		}
		windowStart := now.Truncate(m.policy.CodeAttemptWindow)
		windowEnd := windowStart.Add(m.policy.CodeAttemptWindow)
		window, err := queries.GetCodeAttemptWindowForUpdate(ctx, authdb.GetCodeAttemptWindowForUpdateParams{
			WebSessionID: session.ID, WindowStart: windowStart,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return resolveCLIResult{}, err
		}
		if err == nil && (window.FailureCount >= int32(m.policy.MaximumCodeFailures) ||
			(window.BlockedUntil.Valid && now.Before(window.BlockedUntil.Time))) {
			return resolveCLIResult{domainErr: retryError(
				CodeTooManyCodeAttempts, positiveCeilingSeconds(windowEnd.Sub(now)),
			)}, nil
		}

		normalized, valid := normalizeDeviceUserCode(userCode)
		var matches []authdb.GetCLIAuthorizationByUserCodeForUpdateRow
		if valid {
			for _, id := range m.acceptedPepperIDs() {
				root, ok := m.pepperKeys.get(id)
				if !ok {
					return resolveCLIResult{}, domainError(CodeMisconfigured)
				}
				digest, digestErr := keyedCodeDigest(root, "device-user-code", normalized)
				if digestErr != nil {
					return resolveCLIResult{}, digestErr
				}
				match, queryErr := queries.GetCLIAuthorizationByUserCodeForUpdate(
					ctx, authdb.GetCLIAuthorizationByUserCodeForUpdateParams{
						UserCodeKeyID: id, UserCodeDigest: digest[:],
					},
				)
				if queryErr == nil {
					matches = append(matches, match)
				} else if !errors.Is(queryErr, pgx.ErrNoRows) {
					return resolveCLIResult{}, queryErr
				}
			}
		}
		if len(matches) != 1 {
			if len(matches) > 1 {
				if err := appendAudit(ctx, queries, auditRecord{
					initiatorKind: "principal", initiatorID: principal.UserID,
					action: "cli_authorization.resolve", targetKind: "cli_authorization",
					outcome: "failed", reason: "ambiguous_user_code_digest",
					requestID: requestID, webSessionID: principal.WebSessionID,
				}); err != nil {
					return resolveCLIResult{}, err
				}
				return resolveCLIResult{domainErr: domainError(CodeMisconfigured)}, nil
			}
			return m.recordInvalidUserCode(ctx, queries, session.ID, session.UserID, windowStart, windowEnd, now, requestID)
		}
		grant := matches[0]
		if !now.Before(grant.ExpiresAt) {
			if err := queries.ExpireCLIAuthorization(ctx, grant.ID); err != nil {
				return resolveCLIResult{}, err
			}
			return m.recordInvalidUserCode(ctx, queries, session.ID, session.UserID, windowStart, windowEnd, now, requestID)
		}
		if grant.ReviewWebSessionID.Valid && grant.ReviewWebSessionID.Bytes != session.ID.Bytes {
			return m.recordInvalidUserCode(ctx, queries, session.ID, session.UserID, windowStart, windowEnd, now, requestID)
		}
		if grant.Status != "pending" && grant.Status != "approved_unclaimed" && grant.Status != "denied" {
			return m.recordInvalidUserCode(ctx, queries, session.ID, session.UserID, windowStart, windowEnd, now, requestID)
		}
		if !grant.ReviewWebSessionID.Valid {
			if _, err := queries.BindCLIReviewSession(ctx, authdb.BindCLIReviewSessionParams{
				ID: grant.ID, ReviewWebSessionID: session.ID,
			}); err != nil {
				return resolveCLIResult{}, err
			}
		}
		return resolveCLIResult{view: CLIAuthorizationView{
			ID: domainUUID(grant.ID), UserCode: displayDeviceUserCode(normalized),
			ExpiresAt: grant.ExpiresAt, ClientLabel: CLIClientLabel,
			Capability: CLICapabilityVersion, Status: grant.Status,
		}}, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return CLIAuthorizationView{}, err
		}
		return CLIAuthorizationView{}, unavailable("resolve CLI Device Authorization", err)
	}
	if result.domainErr != nil {
		return CLIAuthorizationView{}, result.domainErr
	}
	return result.view, nil
}

func (m *Module) recordInvalidUserCode(
	ctx context.Context,
	queries *authdb.Queries,
	webSessionID pgtype.UUID,
	userID pgtype.UUID,
	windowStart time.Time,
	windowEnd time.Time,
	now time.Time,
	requestID string,
) (resolveCLIResult, error) {
	window, err := queries.UpsertCodeAttemptFailure(ctx, authdb.UpsertCodeAttemptFailureParams{
		WebSessionID: webSessionID, WindowStart: windowStart,
		MaximumFailures: int32(m.policy.MaximumCodeFailures), WindowEnd: windowEnd,
	})
	if err != nil {
		return resolveCLIResult{}, err
	}
	if window.FailureCount >= int32(m.policy.MaximumCodeFailures) {
		if err := appendAudit(ctx, queries, auditRecord{
			initiatorKind: "principal", initiatorID: domainUUID(userID),
			action: "cli_authorization.user_code_block", targetKind: "web_session",
			targetID: domainUUID(webSessionID), outcome: "denied", reason: "failure_budget",
			requestID: requestID, webSessionID: domainUUID(webSessionID),
		}); err != nil {
			return resolveCLIResult{}, err
		}
		return resolveCLIResult{domainErr: retryError(
			CodeTooManyCodeAttempts, positiveCeilingSeconds(windowEnd.Sub(now)),
		)}, nil
	}
	return resolveCLIResult{domainErr: domainError(CodeInvalidUserCode)}, nil
}

func (m *Module) DecideCLIDeviceAuthorization(
	ctx context.Context,
	principal Principal,
	authorizationID string,
	decision CLIDecision,
	requestID string,
) error {
	if (decision != ApproveCLI && decision != DenyCLI) || !validateRequestID(requestID) {
		return domainError(CodeInvalidRequest)
	}
	databaseAuthorizationID, err := databaseUUID(authorizationID)
	if err != nil {
		return err
	}
	_, err = withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		queries := authdb.New(tx)
		session, now, err := m.validateWebPrincipalInTransaction(ctx, queries, principal)
		if err != nil {
			return struct{}{}, err
		}
		grant, err := queries.GetCLIAuthorizationForDecision(ctx, databaseAuthorizationID)
		if errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, domainError(CodeInvalidUserCode)
		}
		if err != nil {
			return struct{}{}, err
		}
		if !grant.ReviewWebSessionID.Valid || grant.ReviewWebSessionID.Bytes != session.ID.Bytes {
			return struct{}{}, domainError(CodeInvalidUserCode)
		}
		if !now.Before(grant.ExpiresAt) && grant.Status != "claimed" && grant.Status != "denied" {
			if err := queries.ExpireCLIAuthorization(ctx, grant.ID); err != nil {
				return struct{}{}, err
			}
			return struct{}{}, commitWithError(domainError(CodeExpiredToken))
		}
		switch grant.Status {
		case "pending":
			if decision == ApproveCLI {
				err = queries.ApproveCLIAuthorization(ctx, authdb.ApproveCLIAuthorizationParams{
					ID: grant.ID, ApprovingUserID: session.UserID,
				})
			} else {
				err = queries.DenyCLIAuthorization(ctx, authdb.DenyCLIAuthorizationParams{
					ID: grant.ID, ApprovingUserID: session.UserID,
				})
			}
			if err != nil {
				return struct{}{}, err
			}
		case "approved_unclaimed":
			if decision != ApproveCLI || !grant.ApprovingUserID.Valid || grant.ApprovingUserID.Bytes != session.UserID.Bytes {
				return struct{}{}, domainError(CodeGrantAlreadyDecided)
			}
			return struct{}{}, nil
		case "denied":
			if decision != DenyCLI || !grant.ApprovingUserID.Valid || grant.ApprovingUserID.Bytes != session.UserID.Bytes {
				return struct{}{}, domainError(CodeGrantAlreadyDecided)
			}
			return struct{}{}, nil
		case "claimed":
			return struct{}{}, domainError(CodeGrantConsumed)
		case "expired":
			return struct{}{}, domainError(CodeExpiredToken)
		default:
			return struct{}{}, domainError(CodeMisconfigured)
		}
		return struct{}{}, appendAudit(ctx, queries, auditRecord{
			initiatorKind: "principal", initiatorID: principal.UserID,
			action: "cli_authorization." + string(decision), targetKind: "cli_authorization",
			targetID: authorizationID, outcome: "succeeded", requestID: requestID,
			webSessionID: principal.WebSessionID,
		})
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return err
		}
		return unavailable("decide CLI Device Authorization", err)
	}
	return nil
}

type issuedCredentialAttempt struct {
	authorizationID string
	credentialID    string
	secret          string
	digest          [32]byte
	grant           CLICredentialGrant
}

func (m *Module) PollCLIDeviceAuthorization(
	ctx context.Context,
	deviceCode string,
	requestID string,
) (CLICredentialGrant, error) {
	if !validateOpaqueSecret(deviceCode, "atd_v1_") || !validateRequestID(requestID) {
		return CLICredentialGrant{}, domainError(CodeInvalidDeviceCode)
	}
	digest := highEntropyDigest("cli-device-code", deviceCode)
	var issued issuedCredentialAttempt
	grant, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (CLICredentialGrant, error) {
		issued = issuedCredentialAttempt{}
		queries := authdb.New(tx)
		authorization, err := queries.GetCLIAuthorizationByDeviceCodeForUpdate(ctx, digest[:])
		if errors.Is(err, pgx.ErrNoRows) {
			return CLICredentialGrant{}, domainError(CodeInvalidDeviceCode)
		}
		if err != nil {
			return CLICredentialGrant{}, err
		}
		now, err := queries.DatabaseTime(ctx)
		if err != nil {
			return CLICredentialGrant{}, err
		}
		if !now.Before(authorization.ExpiresAt) && authorization.Status != "claimed" && authorization.Status != "denied" {
			if err := queries.ExpireCLIAuthorization(ctx, authorization.ID); err != nil {
				return CLICredentialGrant{}, err
			}
			return CLICredentialGrant{}, commitWithError(domainError(CodeExpiredToken))
		}
		switch authorization.Status {
		case "pending":
			interval := time.Duration(authorization.PollIntervalSeconds) * time.Second
			code := CodeAuthorizationPending
			if now.Before(authorization.NextPollAt) {
				interval += 5 * time.Second
				if interval > m.policy.MaximumPollInterval {
					interval = m.policy.MaximumPollInterval
				}
				code = CodeSlowDown
			}
			if _, err := queries.AdvanceCLIPoll(ctx, authdb.AdvanceCLIPollParams{
				ID: authorization.ID, IntervalSeconds: mustDurationSeconds(interval),
			}); err != nil {
				return CLICredentialGrant{}, err
			}
			return CLICredentialGrant{}, commitWithError(retryError(code, int(mustDurationSeconds(interval))))
		case "denied":
			return CLICredentialGrant{}, domainError(CodeAccessDenied)
		case "expired":
			return CLICredentialGrant{}, domainError(CodeExpiredToken)
		case "claimed":
			return CLICredentialGrant{}, domainError(CodeGrantConsumed)
		case "approved_unclaimed":
		default:
			return CLICredentialGrant{}, domainError(CodeMisconfigured)
		}
		if !authorization.ApprovingUserID.Valid {
			return CLICredentialGrant{}, domainError(CodeMisconfigured)
		}
		user, err := queries.GetUserForUpdate(ctx, authorization.ApprovingUserID)
		if err != nil {
			return CLICredentialGrant{}, err
		}
		if user.Status != "active" {
			if err := queries.ExpireCLIAuthorization(ctx, authorization.ID); err != nil {
				return CLICredentialGrant{}, err
			}
			return CLICredentialGrant{}, commitWithError(domainError(CodeAccessDenied))
		}
		credentialID, err := newID()
		if err != nil {
			return CLICredentialGrant{}, err
		}
		credentialSecret, err := m.newSecret("atc_v1_")
		if err != nil {
			return CLICredentialGrant{}, err
		}
		credentialDigest := highEntropyDigest("cli-credential-secret", credentialSecret)
		created, err := queries.InsertCLICredential(ctx, authdb.InsertCLICredentialParams{
			ID: mustDatabaseUUID(credentialID), UserID: user.ID,
			AuthorizationID: authorization.ID, SecretDigest: credentialDigest[:],
			CapabilityVersion: CLICapabilityVersion,
		})
		if err != nil {
			return CLICredentialGrant{}, err
		}
		if err := queries.ClaimCLIAuthorization(ctx, authdb.ClaimCLIAuthorizationParams{
			ID: authorization.ID, IssuedCredentialID: mustDatabaseUUID(credentialID),
		}); err != nil {
			return CLICredentialGrant{}, err
		}
		result := CLICredentialGrant{
			CredentialID: credentialID, CredentialSecret: credentialSecret,
			Capability: CLICapabilityVersion, CreatedAt: created.CreatedAt,
			User: userFromRow(user),
		}
		issued = issuedCredentialAttempt{
			authorizationID: domainUUID(authorization.ID), credentialID: credentialID,
			secret: credentialSecret, digest: credentialDigest, grant: result,
		}
		if err := appendAudit(ctx, queries, auditRecord{
			initiatorKind: "anonymous_request", action: "cli_credential.issue",
			targetKind: "cli_credential", targetID: credentialID, outcome: "succeeded",
			requestID: requestID, cliCredentialID: credentialID,
		}); err != nil {
			return CLICredentialGrant{}, err
		}
		return result, nil
	})
	if err == nil {
		return grant, nil
	}
	var domain *Error
	if errors.As(err, &domain) {
		return CLICredentialGrant{}, err
	}
	var uncertain *uncertainCommitError
	if issued.credentialID != "" && errors.As(err, &uncertain) {
		if reconciled, ok := m.reconcileCLICredentialClaim(ctx, issued); ok {
			return reconciled, nil
		}
		return CLICredentialGrant{}, domainError(CodeOutcomeUnknown)
	}
	return CLICredentialGrant{}, unavailable("poll CLI Device Authorization", err)
}

func (m *Module) reconcileCLICredentialClaim(
	ctx context.Context,
	issued issuedCredentialAttempt,
) (CLICredentialGrant, bool) {
	row, err := authdb.New(m.pool).ReconcileCLICredentialClaim(ctx, authdb.ReconcileCLICredentialClaimParams{
		ID: mustDatabaseUUID(issued.authorizationID), ID_2: mustDatabaseUUID(issued.credentialID),
	})
	if err != nil || !hmac.Equal(row.SecretDigest, issued.digest[:]) || row.CapabilityVersion != CLICapabilityVersion {
		return CLICredentialGrant{}, false
	}
	result := issued.grant
	result.CreatedAt = row.CreatedAt
	result.User = User{
		ID: domainUUID(row.UserID), DisplayName: row.DisplayName,
		AvatarURL: row.AvatarUrl, CreatedAt: row.UserCreatedAt,
	}
	return result, true
}

func (m *Module) AuthenticateCLI(
	ctx context.Context,
	credentialSecret string,
) (AuthenticatedCLICredential, error) {
	if !validateOpaqueSecret(credentialSecret, "atc_v1_") {
		return AuthenticatedCLICredential{}, domainError(CodeUnauthenticated)
	}
	digest := highEntropyDigest("cli-credential-secret", credentialSecret)
	result, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (AuthenticatedCLICredential, error) {
		queries := authdb.New(tx)
		row, err := queries.GetCLIAuthenticationForUpdate(ctx, digest[:])
		if errors.Is(err, pgx.ErrNoRows) {
			return AuthenticatedCLICredential{}, domainError(CodeUnauthenticated)
		}
		if err != nil {
			return AuthenticatedCLICredential{}, err
		}
		if row.UserStatus != "active" {
			return AuthenticatedCLICredential{}, domainError(CodeUserDisabled)
		}
		if row.CredentialStatus != "active" {
			return AuthenticatedCLICredential{}, domainError(CodeCredentialRevoked)
		}
		if row.CapabilityVersion != CLICapabilityVersion {
			return AuthenticatedCLICredential{}, domainError(CodeMisconfigured)
		}
		now, err := queries.DatabaseTime(ctx)
		if err != nil {
			return AuthenticatedCLICredential{}, err
		}
		lastUsed := row.LastUsedAt
		if touchedAt, touchErr := queries.TouchCLICredential(ctx, authdb.TouchCLICredentialParams{
			ID: row.ID, WriteIntervalSeconds: mustDurationSeconds(m.policy.LastUsedWriteInterval),
		}); touchErr == nil {
			lastUsed = touchedAt
		} else if !errors.Is(touchErr, pgx.ErrNoRows) {
			return AuthenticatedCLICredential{}, touchErr
		}
		userID := domainUUID(row.UserID)
		credentialID := domainUUID(row.ID)
		return AuthenticatedCLICredential{
			Principal: Principal{
				UserID: userID, Method: CLIAuthentication,
				CLICredentialID: credentialID, AuthenticatedAt: now,
			},
			User: User{
				ID: userID, DisplayName: row.DisplayName,
				AvatarURL: row.AvatarUrl, CreatedAt: row.UserCreatedAt,
			},
			Capability: row.CapabilityVersion, CreatedAt: row.CreatedAt, LastUsedAt: lastUsed,
		}, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return AuthenticatedCLICredential{}, err
		}
		return AuthenticatedCLICredential{}, unavailable("authenticate CLI Credential", err)
	}
	return result, nil
}

func (m *Module) ListCLICredentials(ctx context.Context, principal Principal) ([]CLICredentialView, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	views, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) ([]CLICredentialView, error) {
		queries := authdb.New(tx)
		validated, _, err := m.validateWebPrincipalInTransaction(ctx, queries, principal)
		if err != nil {
			return nil, err
		}
		rows, err := queries.ListActiveCLICredentialsForUser(ctx, validated.UserID)
		if err != nil {
			return nil, err
		}
		result := make([]CLICredentialView, 0, len(rows))
		for _, row := range rows {
			if row.CapabilityVersion != CLICapabilityVersion {
				return nil, domainError(CodeMisconfigured)
			}
			result = append(result, CLICredentialView{
				ID: domainUUID(row.ID), Capability: row.CapabilityVersion,
				CreatedAt: row.CreatedAt, LastUsedAt: row.LastUsedAt,
			})
		}
		return result, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return nil, err
		}
		return nil, unavailable("list CLI Credentials", err)
	}
	return views, nil
}

// RevokeCurrentCLICredential combines proof lookup and revocation for the
// dedicated CLI logout operation. Unknown, malformed, and already-revoked
// values are intentionally indistinguishable successful no-ops.
func (m *Module) RevokeCurrentCLICredential(
	ctx context.Context,
	credentialSecret string,
	requestID string,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !validateRequestID(requestID) {
		return domainError(CodeInvalidRequest)
	}
	if !validateOpaqueSecret(credentialSecret, "atc_v1_") {
		return nil
	}
	digest := highEntropyDigest("cli-credential-secret", credentialSecret)
	_, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		queries := authdb.New(tx)
		credential, err := queries.GetCLICredentialBySecretForRevoke(ctx, digest[:])
		if errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, nil
		}
		if err != nil {
			return struct{}{}, err
		}
		switch credential.Status {
		case "revoked":
			return struct{}{}, nil
		case "active":
		default:
			return struct{}{}, domainError(CodeMisconfigured)
		}
		affected, err := queries.RevokeCLICredentialForUser(ctx, authdb.RevokeCLICredentialForUserParams{
			ID: credential.ID, UserID: credential.UserID, RevokeReason: "cli_logout",
		})
		if err != nil {
			return struct{}{}, err
		}
		if affected != 1 {
			return struct{}{}, domainError(CodeMisconfigured)
		}
		credentialID := domainUUID(credential.ID)
		return struct{}{}, appendAudit(ctx, queries, auditRecord{
			initiatorKind: "principal", initiatorID: domainUUID(credential.UserID),
			action: "cli_credential.revoke", targetKind: "cli_credential",
			targetID: credentialID, outcome: "succeeded", reason: "cli_logout",
			requestID: requestID, cliCredentialID: credentialID,
		})
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return err
		}
		return unavailable("revoke current CLI Credential", err)
	}
	return nil
}

func (m *Module) RevokeCLICredentials(ctx context.Context, input RevokeCLICredentialsInput) error {
	if (!input.All && input.CredentialID == "") ||
		!validateRequestID(input.RequestID) || !validAuditReason(input.Reason) {
		return domainError(CodeInvalidRequest)
	}
	_, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		queries := authdb.New(tx)
		var userID pgtype.UUID
		var err error
		switch input.Principal.Method {
		case WebAuthentication:
			validated, _, validateErr := m.validateWebPrincipalInTransaction(ctx, queries, input.Principal)
			if validateErr != nil {
				return struct{}{}, validateErr
			}
			userID = validated.UserID
		case CLIAuthentication:
			if input.All || input.Principal.CLICredentialID == "" || input.CredentialID != input.Principal.CLICredentialID {
				return struct{}{}, domainError(CodeUnauthenticated)
			}
			credentialID, parseErr := databaseUUID(input.Principal.CLICredentialID)
			if parseErr != nil {
				return struct{}{}, domainError(CodeUnauthenticated)
			}
			credential, queryErr := queries.GetCLICredentialForPrincipal(ctx, credentialID)
			if queryErr != nil || credential.Status != "active" || domainUUID(credential.UserID) != input.Principal.UserID {
				if queryErr != nil && !errors.Is(queryErr, pgx.ErrNoRows) {
					return struct{}{}, queryErr
				}
				return struct{}{}, domainError(CodeUnauthenticated)
			}
			userID = credential.UserID
		default:
			return struct{}{}, domainError(CodeUnauthenticated)
		}
		var affected int64
		if input.All {
			affected, err = queries.RevokeAllCLICredentialsForUser(ctx, authdb.RevokeAllCLICredentialsForUserParams{
				UserID: userID, RevokeReason: boundedReason(input.Reason, "user_revoked_all"),
			})
		} else {
			credentialID, parseErr := databaseUUID(input.CredentialID)
			if parseErr != nil {
				// Keep proof-authorized revocation idempotent for opaque IDs that
				// cannot correspond to a stored CLI Credential.
				return struct{}{}, nil
			}
			affected, err = queries.RevokeCLICredentialForUser(ctx, authdb.RevokeCLICredentialForUserParams{
				ID: credentialID, UserID: userID,
				RevokeReason: boundedReason(input.Reason, "user_revoked"),
			})
		}
		if err != nil {
			return struct{}{}, err
		}
		if affected > 0 {
			targetID := input.CredentialID
			if input.All {
				targetID = domainUUID(userID)
			}
			return struct{}{}, appendAudit(ctx, queries, auditRecord{
				initiatorKind: "principal", initiatorID: input.Principal.UserID,
				action: "cli_credential.revoke", targetKind: "cli_credential", targetID: targetID,
				outcome: "succeeded", reason: boundedReason(input.Reason, "user_revoked"),
				requestID: input.RequestID, webSessionID: input.Principal.WebSessionID,
				cliCredentialID: input.Principal.CLICredentialID,
			})
		}
		return struct{}{}, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return err
		}
		return unavailable("revoke CLI Credential", err)
	}
	return nil
}

type validatedWebPrincipal struct {
	ID     pgtype.UUID
	UserID pgtype.UUID
}

func (m *Module) validateWebPrincipalInTransaction(
	ctx context.Context,
	queries *authdb.Queries,
	principal Principal,
) (validatedWebPrincipal, time.Time, error) {
	if principal.Method != WebAuthentication || principal.WebSessionID == "" || principal.UserID == "" {
		return validatedWebPrincipal{}, time.Time{}, domainError(CodeUnauthenticated)
	}
	sessionID, err := databaseUUID(principal.WebSessionID)
	if err != nil {
		return validatedWebPrincipal{}, time.Time{}, domainError(CodeUnauthenticated)
	}
	row, err := queries.GetWebSessionForUpdate(ctx, sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return validatedWebPrincipal{}, time.Time{}, domainError(CodeUnauthenticated)
	}
	if err != nil {
		return validatedWebPrincipal{}, time.Time{}, err
	}
	if domainUUID(row.UserID) != principal.UserID || row.SessionStatus != "active" {
		return validatedWebPrincipal{}, time.Time{}, domainError(CodeSessionRevoked)
	}
	if row.UserStatus != "active" {
		return validatedWebPrincipal{}, time.Time{}, domainError(CodeUserDisabled)
	}
	now, err := queries.DatabaseTime(ctx)
	if err != nil {
		return validatedWebPrincipal{}, time.Time{}, err
	}
	if !now.Before(row.AbsoluteExpiresAt) {
		return validatedWebPrincipal{}, time.Time{}, domainError(CodeSessionAbsoluteExpired)
	}
	if !now.Before(row.LastUsedAt.Add(m.policy.WebSessionIdleTTL + m.policy.LastUsedWriteInterval)) {
		return validatedWebPrincipal{}, time.Time{}, domainError(CodeSessionIdleExpired)
	}
	return validatedWebPrincipal{ID: row.ID, UserID: row.UserID}, now, nil
}

func positiveCeilingSeconds(duration time.Duration) int {
	if duration <= 0 {
		return 1
	}
	return int(math.Ceil(duration.Seconds()))
}
