package authentication

import (
	"context"
	"crypto/hmac"
	"encoding/base64"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	authdb "github.com/SingleMai/ATape/server/internal/authentication/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type webAuthenticationState struct {
	principal  Principal
	user       User
	session    WebSession
	generation int64
	csrfToken  string
}

func (m *Module) AuthenticateWeb(ctx context.Context, sessionSecret string) (AuthenticatedWebSession, error) {
	return m.authenticateWeb(ctx, sessionSecret, false)
}

// AuthenticateFreshWeb is the uniform 15-minute sensitive-operation guard.
// Callers do not calculate freshness or inspect persistence timestamps.
func (m *Module) AuthenticateFreshWeb(ctx context.Context, sessionSecret string) (AuthenticatedWebSession, error) {
	return m.authenticateWeb(ctx, sessionSecret, true)
}

func (m *Module) authenticateWeb(
	ctx context.Context,
	sessionSecret string,
	requireFresh bool,
) (AuthenticatedWebSession, error) {
	if err := ctx.Err(); err != nil {
		return AuthenticatedWebSession{}, err
	}
	if !validateOpaqueSecret(sessionSecret, "ats_v1_") {
		return AuthenticatedWebSession{}, domainError(CodeUnauthenticated)
	}
	state, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (webAuthenticationState, error) {
		return m.authenticateWebInTransaction(ctx, tx, sessionSecret, requireFresh, true)
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return AuthenticatedWebSession{}, err
		}
		return AuthenticatedWebSession{}, unavailable("authenticate Web Session", err)
	}
	return AuthenticatedWebSession{
		Principal: state.principal, User: state.user, Session: state.session,
		CSRFToken: state.csrfToken,
	}, nil
}

func (m *Module) authenticateWebInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	sessionSecret string,
	requireFresh bool,
	touch bool,
) (webAuthenticationState, error) {
	queries := authdb.New(tx)
	digest := highEntropyDigest("web-session-secret", sessionSecret)
	row, err := queries.GetWebAuthenticationForUpdate(ctx, digest[:])
	if errors.Is(err, pgx.ErrNoRows) {
		return webAuthenticationState{}, domainError(CodeUnauthenticated)
	}
	if err != nil {
		return webAuthenticationState{}, err
	}
	now, err := queries.DatabaseTime(ctx)
	if err != nil {
		return webAuthenticationState{}, err
	}
	state := webStateFromAuthenticationRow(row)
	if row.UserStatus != "active" {
		return webAuthenticationState{}, domainError(CodeUserDisabled)
	}
	switch row.SessionStatus {
	case "revoked":
		return webAuthenticationState{}, domainError(CodeSessionRevoked)
	case "idle_expired":
		return webAuthenticationState{}, domainError(CodeSessionIdleExpired)
	case "absolute_expired":
		return webAuthenticationState{}, commitWithError(domainError(CodeSessionAbsoluteExpired))
	case "active":
	default:
		return webAuthenticationState{}, domainError(CodeMisconfigured)
	}
	if !now.Before(row.AbsoluteExpiresAt) {
		if err := terminalizeWebSession(ctx, queries, row.ID, "absolute_expired", "absolute_lifetime"); err != nil {
			return webAuthenticationState{}, err
		}
		return webAuthenticationState{}, domainError(CodeSessionAbsoluteExpired)
	}
	idleDeadline := row.LastUsedAt.Add(m.policy.WebSessionIdleTTL + m.policy.LastUsedWriteInterval)
	if !now.Before(idleDeadline) {
		if err := terminalizeWebSession(ctx, queries, row.ID, "idle_expired", "idle_timeout"); err != nil {
			return webAuthenticationState{}, err
		}
		return webAuthenticationState{}, commitWithError(domainError(CodeSessionIdleExpired))
	}
	if requireFresh && now.Sub(row.ReauthenticatedAt) > m.policy.FreshAuthenticationTTL {
		return webAuthenticationState{}, domainError(CodeFreshAuthenticationRequired)
	}
	csrfToken := deriveCSRFToken(sessionSecret)
	csrfDigest := highEntropyDigest("csrf-token", csrfToken)
	if !hmac.Equal(row.CsrfDigest, csrfDigest[:]) {
		return webAuthenticationState{}, domainError(CodeMisconfigured)
	}
	state.csrfToken = csrfToken
	state.principal.AuthenticatedAt = now
	if touch {
		if touchedAt, touchErr := queries.TouchWebSession(ctx, authdb.TouchWebSessionParams{
			ID: row.ID, WriteIntervalSeconds: mustDurationSeconds(m.policy.LastUsedWriteInterval),
		}); touchErr == nil {
			state.session.LastUsedAt = touchedAt
		} else if !errors.Is(touchErr, pgx.ErrNoRows) {
			return webAuthenticationState{}, touchErr
		}
	}
	return state, nil
}

func webStateFromAuthenticationRow(row authdb.GetWebAuthenticationForUpdateRow) webAuthenticationState {
	userID := domainUUID(row.UserID)
	sessionID := domainUUID(row.ID)
	return webAuthenticationState{
		principal: Principal{
			UserID: userID, Method: WebAuthentication, WebSessionID: sessionID,
		},
		user: User{
			ID: userID, DisplayName: row.DisplayName, AvatarURL: row.AvatarUrl,
			CreatedAt: row.UserCreatedAt,
		},
		session: WebSession{
			ID: sessionID, UserID: userID, CreatedAt: row.CreatedAt,
			LastUsedAt: row.LastUsedAt, ReauthenticatedAt: row.ReauthenticatedAt,
			AbsoluteExpiresAt: row.AbsoluteExpiresAt,
		},
		generation: row.Generation,
	}
}

func terminalizeWebSession(
	ctx context.Context,
	queries *authdb.Queries,
	sessionID pgtype.UUID,
	status string,
	reason string,
) error {
	if err := queries.TerminalWebSession(ctx, authdb.TerminalWebSessionParams{
		ID: sessionID, Status: status, TerminalReason: reason,
	}); err != nil {
		return err
	}
	return appendAudit(ctx, queries, auditRecord{
		initiatorKind: "system", action: "web_session.expire",
		targetKind: "web_session", targetID: domainUUID(sessionID),
		outcome: "succeeded", reason: reason, webSessionID: domainUUID(sessionID),
	})
}

func deriveCSRFToken(sessionSecret string) string {
	material := highEntropyDigest("csrf-material", sessionSecret)
	return "atx_v1_" + base64.RawURLEncoding.EncodeToString(material[:])
}

func (m *Module) newWebSessionInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	user User,
	requestID string,
	providerRegistrationID string,
	initiatorKind string,
	initiatorID string,
) (WebSessionGrant, error) {
	queries := authdb.New(tx)
	sessionID, err := newID()
	if err != nil {
		return WebSessionGrant{}, err
	}
	sessionSecret, err := m.newSecret("ats_v1_")
	if err != nil {
		return WebSessionGrant{}, err
	}
	userID, err := databaseUUID(user.ID)
	if err != nil {
		return WebSessionGrant{}, errors.New("invalid internal User identity")
	}
	row, err := queries.InsertWebSession(ctx, authdb.InsertWebSessionParams{
		ID: mustDatabaseUUID(sessionID), UserID: userID,
		AbsoluteTtlSeconds: mustDurationSeconds(m.policy.WebSessionAbsoluteTTL),
	})
	if err != nil {
		return WebSessionGrant{}, err
	}
	csrfToken := deriveCSRFToken(sessionSecret)
	secretDigest := highEntropyDigest("web-session-secret", sessionSecret)
	csrfDigest := highEntropyDigest("csrf-token", csrfToken)
	if _, err := queries.InsertWebSessionSecret(ctx, authdb.InsertWebSessionSecretParams{
		SessionID: mustDatabaseUUID(sessionID), Generation: 1,
		SecretDigest: secretDigest[:], CsrfDigest: csrfDigest[:],
	}); err != nil {
		return WebSessionGrant{}, err
	}
	if err := appendAudit(ctx, queries, auditRecord{
		initiatorKind: initiatorKind, initiatorID: initiatorID,
		action: "web_session.create", targetKind: "web_session", targetID: sessionID,
		outcome: "succeeded", requestID: requestID,
		providerRegistrationID: providerRegistrationID, webSessionID: sessionID,
	}); err != nil {
		return WebSessionGrant{}, err
	}
	return WebSessionGrant{
		User: user,
		Session: WebSession{
			ID: sessionID, UserID: user.ID, CreatedAt: row.CreatedAt,
			LastUsedAt: row.LastUsedAt, ReauthenticatedAt: row.ReauthenticatedAt,
			AbsoluteExpiresAt: row.AbsoluteExpiresAt,
		},
		SessionSecret: sessionSecret, CSRFToken: csrfToken,
	}, nil
}

func (m *Module) rotateWebSessionInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	user User,
	sessionID string,
	reauthenticate bool,
	requestID string,
	providerRegistrationID string,
	initiatorKind string,
	initiatorID string,
) (WebSessionGrant, error) {
	queries := authdb.New(tx)
	databaseSessionID, err := databaseUUID(sessionID)
	if err != nil {
		return WebSessionGrant{}, errors.New("invalid internal Web Session identity")
	}
	generation, err := queries.GetCurrentWebSecretGenerationForUpdate(ctx, databaseSessionID)
	if err != nil {
		return WebSessionGrant{}, err
	}
	if err := queries.SupersedeWebSessionSecret(ctx, databaseSessionID); err != nil {
		return WebSessionGrant{}, err
	}
	sessionSecret, err := m.newSecret("ats_v1_")
	if err != nil {
		return WebSessionGrant{}, err
	}
	csrfToken := deriveCSRFToken(sessionSecret)
	secretDigest := highEntropyDigest("web-session-secret", sessionSecret)
	csrfDigest := highEntropyDigest("csrf-token", csrfToken)
	if _, err := queries.InsertWebSessionSecret(ctx, authdb.InsertWebSessionSecretParams{
		SessionID: databaseSessionID, Generation: generation + 1,
		SecretDigest: secretDigest[:], CsrfDigest: csrfDigest[:],
	}); err != nil {
		return WebSessionGrant{}, err
	}
	row, err := queries.GetWebSessionForUpdate(ctx, databaseSessionID)
	if err != nil {
		return WebSessionGrant{}, err
	}
	session := WebSession{
		ID: sessionID, UserID: user.ID, CreatedAt: row.CreatedAt,
		LastUsedAt: row.LastUsedAt, ReauthenticatedAt: row.ReauthenticatedAt,
		AbsoluteExpiresAt: row.AbsoluteExpiresAt,
	}
	action := "web_session.rotate"
	if reauthenticate {
		refreshed, err := queries.ReauthenticateWebSession(ctx, authdb.ReauthenticateWebSessionParams{
			ID:                 databaseSessionID,
			AbsoluteTtlSeconds: mustDurationSeconds(m.policy.WebSessionAbsoluteTTL),
		})
		if err != nil {
			return WebSessionGrant{}, err
		}
		session.CreatedAt = refreshed.CreatedAt
		session.LastUsedAt = refreshed.LastUsedAt
		session.ReauthenticatedAt = refreshed.ReauthenticatedAt
		session.AbsoluteExpiresAt = refreshed.AbsoluteExpiresAt
		action = "web_session.reauthenticate"
	}
	if err := appendAudit(ctx, queries, auditRecord{
		initiatorKind: initiatorKind, initiatorID: initiatorID,
		action: action, targetKind: "web_session", targetID: sessionID,
		outcome: "succeeded", requestID: requestID,
		providerRegistrationID: providerRegistrationID, webSessionID: sessionID,
	}); err != nil {
		return WebSessionGrant{}, err
	}
	return WebSessionGrant{
		User: user, Session: session, SessionSecret: sessionSecret, CSRFToken: csrfToken,
	}, nil
}

func (m *Module) RevokeWebSessions(ctx context.Context, input RevokeWebSessionsInput) error {
	if (!input.All && input.SessionID == "") ||
		!validateRequestID(input.RequestID) || !validAuditReason(input.Reason) {
		return domainError(CodeInvalidRequest)
	}
	_, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		queries := authdb.New(tx)
		principal, _, err := m.validateWebPrincipalInTransaction(ctx, queries, input.Principal)
		if err != nil {
			return struct{}{}, err
		}
		var affected int64
		if input.All {
			affected, err = queries.RevokeAllWebSessionsForUser(ctx, authdb.RevokeAllWebSessionsForUserParams{
				UserID: principal.UserID, TerminalReason: boundedReason(input.Reason, "user_revoked_all"),
			})
		} else {
			sessionID, parseErr := databaseUUID(input.SessionID)
			if parseErr != nil {
				return struct{}{}, parseErr
			}
			affected, err = queries.RevokeWebSessionForUser(ctx, authdb.RevokeWebSessionForUserParams{
				ID: sessionID, UserID: principal.UserID,
				TerminalReason: boundedReason(input.Reason, "user_revoked"),
			})
		}
		if err != nil {
			return struct{}{}, err
		}
		if affected > 0 {
			targetID := input.SessionID
			if input.All {
				targetID = domainUUID(principal.UserID)
			}
			if err := appendAudit(ctx, queries, auditRecord{
				initiatorKind: "principal", initiatorID: input.Principal.UserID,
				action: "web_session.revoke", targetKind: "web_session", targetID: targetID,
				outcome: "succeeded", reason: boundedReason(input.Reason, "user_revoked"),
				requestID: input.RequestID, webSessionID: input.Principal.WebSessionID,
			}); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return err
		}
		return unavailable("revoke Web Session", err)
	}
	return nil
}

func boundedReason(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func validAuditReason(value string) bool {
	return utf8.ValidString(value) && len(value) <= 100 && !strings.ContainsAny(value, "\x00\r\n")
}

func mustDurationSeconds(value time.Duration) int32 {
	seconds, err := durationSeconds(value)
	if err != nil {
		panic("validated authentication duration became invalid")
	}
	return seconds
}
