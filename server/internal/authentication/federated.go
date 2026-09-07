package authentication

import (
	"context"
	"crypto/hmac"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	authdb "github.com/SingleMai/ATape/server/internal/authentication/internal/db"
	"github.com/jackc/pgx/v5"
)

func (m *Module) BeginFederatedLogin(
	ctx context.Context,
	input BeginFederatedLoginInput,
) (FederatedLoginChallenge, error) {
	if err := ctx.Err(); err != nil {
		return FederatedLoginChallenge{}, err
	}
	if !validateRequestID(input.RequestID) {
		return FederatedLoginChallenge{}, domainError(CodeInvalidRequest)
	}
	if input.Intent != SignInIntent && input.Intent != BindIdentityIntent && input.Intent != ReauthenticateIntent {
		return FederatedLoginChallenge{}, domainError(CodeInvalidRequest)
	}
	registration, ok := m.active[input.ProviderRegistrationID]
	if !ok {
		return FederatedLoginChallenge{}, domainError(CodeInvalidRequest)
	}
	returnTo, err := normalizeReturnTo(input.ReturnTo)
	if err != nil {
		return FederatedLoginChallenge{}, err
	}

	var initiatingUserID string
	var initiatingSessionID string
	if input.Intent == SignInIntent {
		if input.CurrentWebSessionSecret != "" {
			return FederatedLoginChallenge{}, domainError(CodeInvalidRequest)
		}
	} else {
		if input.CurrentWebSessionSecret == "" {
			return FederatedLoginChallenge{}, domainError(CodeUnauthenticated)
		}
		requireFresh := input.Intent == BindIdentityIntent
		authenticated, authErr := m.authenticateWeb(ctx, input.CurrentWebSessionSecret, requireFresh)
		if authErr != nil {
			return FederatedLoginChallenge{}, authErr
		}
		initiatingUserID = authenticated.Principal.UserID
		initiatingSessionID = authenticated.Principal.WebSessionID
	}

	now, err := authdb.New(m.pool).DatabaseTime(ctx)
	if err != nil {
		return FederatedLoginChallenge{}, unavailable("read database time", err)
	}
	expiresAt := now.Add(m.policy.FederatedLoginTTL)
	transactionID, err := newID()
	if err != nil {
		return FederatedLoginChallenge{}, err
	}
	state, err := m.newSecret("atf_v1_")
	if err != nil {
		return FederatedLoginChallenge{}, err
	}
	browserBinding, err := m.newSecret("atb_v1_")
	if err != nil {
		return FederatedLoginChallenge{}, err
	}
	providerResult, err := registration.Adapter.Begin(ctx, ProviderBeginRequest{
		CallbackURI: registration.CallbackURI, State: state,
	})
	if err != nil {
		return FederatedLoginChallenge{}, mapProviderFailure(err)
	}
	if err := validateProviderBeginResult(providerResult); err != nil {
		return FederatedLoginChallenge{}, err
	}
	keyID, nonce, ciphertext, err := m.encryptPrivateState(
		transactionID, input.Intent, registration, providerResult.StateSchema,
		expiresAt, providerResult.PrivateState,
	)
	if err != nil {
		return FederatedLoginChallenge{}, err
	}
	stateDigest := highEntropyDigest("federated-state", state)
	bindingDigest := highEntropyDigest("login-browser-binding", browserBinding)
	databaseUserID, err := optionalDatabaseUUID(initiatingUserID)
	if err != nil {
		return FederatedLoginChallenge{}, errors.New("invalid internal initiating User identity")
	}
	databaseSessionID, err := optionalDatabaseUUID(initiatingSessionID)
	if err != nil {
		return FederatedLoginChallenge{}, errors.New("invalid internal initiating Web Session identity")
	}

	_, err = withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		queries := authdb.New(tx)
		if err := queries.InsertFederatedLogin(ctx, authdb.InsertFederatedLoginParams{
			ID: mustDatabaseUUID(transactionID), Intent: string(input.Intent),
			StateDigest: stateDigest[:], BrowserBindingDigest: bindingDigest[:],
			ProviderRegistrationID:       registration.ID,
			ProviderRegistrationRevision: registration.Revision,
			ExpectedIssuer:               registration.ExpectedIssuer, CallbackUri: registration.CallbackURI,
			ReturnTo: returnTo, PrivateStateKeyID: &keyID,
			PrivateStateNonce: nonce, PrivateStateCiphertext: ciphertext,
			PrivateStateSchema: providerResult.StateSchema,
			InitiatingUserID:   databaseUserID, InitiatingWebSessionID: databaseSessionID,
			ExpiresAt: expiresAt,
		}); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, appendAudit(ctx, queries, auditRecord{
			initiatorKind: "anonymous_request", action: "federated_login.begin",
			targetKind: "federated_login", targetID: transactionID,
			outcome: "succeeded", requestID: input.RequestID,
			providerRegistrationID: registration.ID, webSessionID: initiatingSessionID,
		})
	})
	if err != nil {
		return FederatedLoginChallenge{}, unavailable("begin federated login", err)
	}
	return FederatedLoginChallenge{
		LoginTransactionID: transactionID, AuthorizationURI: providerResult.AuthorizationURI,
		BrowserBinding: browserBinding, ExpiresAt: expiresAt,
	}, nil
}

type claimedFederatedLogin struct {
	id                  string
	intent              LoginIntent
	registration        ProviderRegistration
	callbackURI         string
	returnTo            string
	privateState        []byte
	privateStateSchema  string
	initiatingUserID    string
	initiatingSessionID string
	expiresAt           time.Time
}

func (m *Module) CompleteFederatedLogin(
	ctx context.Context,
	input CompleteFederatedLoginInput,
) (WebSessionGrant, error) {
	if err := ctx.Err(); err != nil {
		return WebSessionGrant{}, err
	}
	if !validateOpaqueSecret(input.State, "atf_v1_") ||
		!validateOpaqueSecret(input.BrowserBinding, "atb_v1_") ||
		len(input.AuthorizationCode) > 4096 || len(input.AuthorizationError) > 100 ||
		!validateRequestID(input.RequestID) {
		return WebSessionGrant{}, domainError(CodeLoginStateMismatch)
	}
	if len(input.AuthorizationServerIssuer) > 2048 || !utf8.ValidString(input.AuthorizationServerIssuer) ||
		strings.ContainsAny(input.AuthorizationServerIssuer, "\x00\r\n") {
		return WebSessionGrant{}, domainError(CodeProviderInvalidResponse)
	}
	stateDigest := highEntropyDigest("federated-state", input.State)
	claimed, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (claimedFederatedLogin, error) {
		queries := authdb.New(tx)
		row, err := queries.GetFederatedLoginByStateForUpdate(ctx, stateDigest[:])
		if errors.Is(err, pgx.ErrNoRows) {
			return claimedFederatedLogin{}, domainError(CodeLoginStateMismatch)
		}
		if err != nil {
			return claimedFederatedLogin{}, err
		}
		bindingDigest := highEntropyDigest("login-browser-binding", input.BrowserBinding)
		if !hmac.Equal(row.BrowserBindingDigest, bindingDigest[:]) ||
			row.ProviderRegistrationID != input.ProviderRegistrationID {
			return claimedFederatedLogin{}, domainError(CodeLoginStateMismatch)
		}
		switch row.Status {
		case "pending":
		case "completing", "completed", "denied", "failed", "expired":
			return claimedFederatedLogin{}, domainError(CodeLoginAlreadyConsumed)
		default:
			return claimedFederatedLogin{}, domainError(CodeMisconfigured)
		}
		now, err := queries.DatabaseTime(ctx)
		if err != nil {
			return claimedFederatedLogin{}, err
		}
		if !now.Before(row.ExpiresAt) {
			if err := queries.ExpireFederatedLogin(ctx, row.ID); err != nil {
				return claimedFederatedLogin{}, err
			}
			if err := appendAudit(ctx, queries, auditRecord{
				initiatorKind: "federated_login", initiatorID: domainUUID(row.ID),
				action: "federated_login.expire", targetKind: "federated_login",
				targetID: domainUUID(row.ID), outcome: "failed", reason: "login_expired",
				requestID: input.RequestID, providerRegistrationID: row.ProviderRegistrationID,
			}); err != nil {
				return claimedFederatedLogin{}, err
			}
			return claimedFederatedLogin{}, commitWithError(domainError(CodeLoginExpired))
		}
		registration, ok := m.registration(row.ProviderRegistrationID, row.ProviderRegistrationRevision)
		if !ok || registration.ExpectedIssuer != row.ExpectedIssuer || registration.CallbackURI != row.CallbackUri {
			return claimedFederatedLogin{}, domainError(CodeMisconfigured)
		}
		if row.PrivateStateKeyID == nil {
			return claimedFederatedLogin{}, domainError(CodeMisconfigured)
		}
		privateState, err := m.decryptPrivateState(
			domainUUID(row.ID), LoginIntent(row.Intent), registration,
			row.PrivateStateSchema, row.ExpiresAt, *row.PrivateStateKeyID,
			row.PrivateStateNonce, row.PrivateStateCiphertext,
		)
		if err != nil {
			return claimedFederatedLogin{}, err
		}
		if _, err := queries.ClaimFederatedLogin(ctx, row.ID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return claimedFederatedLogin{}, domainError(CodeLoginAlreadyConsumed)
			}
			return claimedFederatedLogin{}, err
		}
		return claimedFederatedLogin{
			id: domainUUID(row.ID), intent: LoginIntent(row.Intent), registration: registration,
			callbackURI: row.CallbackUri, returnTo: row.ReturnTo,
			privateState: privateState, privateStateSchema: row.PrivateStateSchema,
			initiatingUserID:    domainUUID(row.InitiatingUserID),
			initiatingSessionID: domainUUID(row.InitiatingWebSessionID),
			expiresAt:           row.ExpiresAt,
		}, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return WebSessionGrant{}, err
		}
		return WebSessionGrant{}, unavailable("claim federated login", err)
	}

	identity, providerErr := claimed.registration.Adapter.Complete(ctx, ProviderCompleteRequest{
		CallbackURI: claimed.callbackURI, AuthorizationServerIssuer: input.AuthorizationServerIssuer,
		AuthorizationCode: input.AuthorizationCode, AuthorizationError: input.AuthorizationError,
		PrivateState: claimed.privateState, PrivateStateSchema: claimed.privateStateSchema,
	})
	clear(claimed.privateState)
	if providerErr != nil {
		mapped := mapProviderFailure(providerErr)
		m.finishFederatedFailure(ctx, claimed, ErrorCodeOf(mapped), input.RequestID)
		return WebSessionGrant{}, mapped
	}
	if err := validateProfile(identity); err != nil || identity.Issuer != claimed.registration.ExpectedIssuer {
		mapped := domainError(CodeProviderInvalidResponse)
		m.finishFederatedFailure(ctx, claimed, CodeProviderInvalidResponse, input.RequestID)
		return WebSessionGrant{}, mapped
	}

	grant, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (WebSessionGrant, error) {
		queries := authdb.New(tx)
		row, err := queries.GetFederatedLoginByStateForUpdate(ctx, stateDigest[:])
		if err != nil {
			return WebSessionGrant{}, err
		}
		if row.Status != "completing" || domainUUID(row.ID) != claimed.id {
			return WebSessionGrant{}, domainError(CodeLoginAlreadyConsumed)
		}
		now, err := queries.DatabaseTime(ctx)
		if err != nil {
			return WebSessionGrant{}, err
		}
		if !now.Before(row.ExpiresAt) {
			return m.failFederatedInTransaction(
				ctx, queries, claimed, CodeLoginExpired, input.RequestID,
			)
		}

		var result WebSessionGrant
		switch claimed.intent {
		case SignInIntent:
			user, resolveErr := m.resolveSignInIdentity(ctx, queries, identity)
			if resolveErr != nil {
				if ErrorCodeOf(resolveErr) == "" {
					return WebSessionGrant{}, resolveErr
				}
				return m.failFederatedInTransaction(ctx, queries, claimed, ErrorCodeOf(resolveErr), input.RequestID)
			}
			result, err = m.newWebSessionInTransaction(
				ctx, tx, user, input.RequestID, claimed.registration.ID,
				"federated_login", claimed.id,
			)
		case BindIdentityIntent:
			user, validateErr := m.validateInitiatingSession(ctx, queries, claimed, true, now)
			if validateErr != nil {
				if ErrorCodeOf(validateErr) == "" {
					return WebSessionGrant{}, validateErr
				}
				return m.failFederatedInTransaction(ctx, queries, claimed, ErrorCodeOf(validateErr), input.RequestID)
			}
			if bindErr := m.bindIdentity(ctx, queries, user.ID, identity); bindErr != nil {
				if ErrorCodeOf(bindErr) == "" {
					return WebSessionGrant{}, bindErr
				}
				return m.failFederatedInTransaction(ctx, queries, claimed, ErrorCodeOf(bindErr), input.RequestID)
			}
			result, err = m.rotateWebSessionInTransaction(
				ctx, tx, user, claimed.initiatingSessionID, false,
				input.RequestID, claimed.registration.ID, "federated_login", claimed.id,
			)
		case ReauthenticateIntent:
			user, validateErr := m.validateInitiatingSession(ctx, queries, claimed, false, now)
			if validateErr != nil {
				if ErrorCodeOf(validateErr) == "" {
					return WebSessionGrant{}, validateErr
				}
				return m.failFederatedInTransaction(ctx, queries, claimed, ErrorCodeOf(validateErr), input.RequestID)
			}
			if verifyErr := m.verifyIdentityForUser(ctx, queries, user.ID, identity); verifyErr != nil {
				if ErrorCodeOf(verifyErr) == "" {
					return WebSessionGrant{}, verifyErr
				}
				return m.failFederatedInTransaction(ctx, queries, claimed, ErrorCodeOf(verifyErr), input.RequestID)
			}
			result, err = m.rotateWebSessionInTransaction(
				ctx, tx, user, claimed.initiatingSessionID, true,
				input.RequestID, claimed.registration.ID, "federated_login", claimed.id,
			)
		default:
			return m.failFederatedInTransaction(ctx, queries, claimed, CodeMisconfigured, input.RequestID)
		}
		if err != nil {
			return WebSessionGrant{}, err
		}
		if err := queries.FinishFederatedLogin(ctx, authdb.FinishFederatedLoginParams{
			Status: "completed", FailureCode: "", ID: row.ID,
		}); err != nil {
			return WebSessionGrant{}, err
		}
		if err := appendAudit(ctx, queries, auditRecord{
			initiatorKind: "federated_login", initiatorID: claimed.id,
			action: "federated_login.complete", targetKind: "user", targetID: result.User.ID,
			outcome: "succeeded", requestID: input.RequestID,
			providerRegistrationID: claimed.registration.ID,
			webSessionID:           result.Session.ID,
		}); err != nil {
			return WebSessionGrant{}, err
		}
		result.ReturnTo = claimed.returnTo
		return result, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return WebSessionGrant{}, err
		}
		return WebSessionGrant{}, unavailable("complete federated login", err)
	}
	return grant, nil
}

func validateProviderBeginResult(result ProviderBeginResult) error {
	parsed, err := url.Parse(result.AuthorizationURI)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return domainError(CodeProviderInvalidResponse)
	}
	if len(result.AuthorizationURI) > 8192 || result.StateSchema == "" || len(result.StateSchema) > 100 ||
		len(result.PrivateState) > maxPrivateStateBytes {
		return domainError(CodeProviderInvalidResponse)
	}
	return nil
}

func mapProviderFailure(err error) error {
	var failure *ProviderFailure
	if !errors.As(err, &failure) {
		return domainError(CodeProviderUnavailable)
	}
	switch failure.Code {
	case ProviderAccessDenied:
		return domainError(CodeProviderAccessDenied)
	case ProviderUnavailable, ProviderMisconfigured:
		return domainError(CodeProviderUnavailable)
	case ProviderInvalidResponse, ProviderProtocolViolation:
		return domainError(CodeProviderInvalidResponse)
	default:
		return domainError(CodeProviderInvalidResponse)
	}
}

func (m *Module) encryptPrivateState(
	transactionID string,
	intent LoginIntent,
	registration ProviderRegistration,
	schema string,
	expiresAt time.Time,
	plaintext []byte,
) (string, []byte, []byte, error) {
	keyID, root, err := m.privateKeys.active()
	if err != nil {
		return "", nil, nil, domainError(CodeMisconfigured)
	}
	aead, err := newAEAD(root)
	if err != nil {
		return "", nil, nil, domainError(CodeMisconfigured)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(m.random, nonce); err != nil {
		return "", nil, nil, errors.New("secure random source failed")
	}
	aad := privateStateAAD(transactionID, intent, registration, schema, expiresAt)
	ciphertext := aead.Seal(nil, nonce, plaintext, aad)
	return keyID, nonce, ciphertext, nil
}

func (m *Module) decryptPrivateState(
	transactionID string,
	intent LoginIntent,
	registration ProviderRegistration,
	schema string,
	expiresAt time.Time,
	keyID string,
	nonce []byte,
	ciphertext []byte,
) ([]byte, error) {
	root, ok := m.privateKeys.get(keyID)
	if !ok {
		return nil, domainError(CodeMisconfigured)
	}
	aead, err := newAEAD(root)
	if err != nil || len(nonce) != aead.NonceSize() || len(ciphertext) > maxPrivateStateBytes+aead.Overhead() {
		return nil, domainError(CodeMisconfigured)
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, privateStateAAD(
		transactionID, intent, registration, schema, expiresAt,
	))
	if err != nil {
		return nil, domainError(CodeLoginStateMismatch)
	}
	return plaintext, nil
}

func privateStateAAD(
	transactionID string,
	intent LoginIntent,
	registration ProviderRegistration,
	schema string,
	expiresAt time.Time,
) []byte {
	return []byte(strings.Join([]string{
		"atape/private-state/v1", transactionID, string(intent), registration.ID,
		registration.Revision, schema, expiresAt.UTC().Format(time.RFC3339Nano),
	}, "\x00"))
}

func (m *Module) resolveSignInIdentity(
	ctx context.Context,
	queries *authdb.Queries,
	identity VerifiedExternalIdentity,
) (User, error) {
	if err := queries.AcquireAuthenticationLock(ctx, identityLockKey(identity)); err != nil {
		return User{}, err
	}
	row, err := queries.GetExternalIdentityForUpdate(ctx, authdb.GetExternalIdentityForUpdateParams{
		Issuer: identity.Issuer, Subject: identity.Subject,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		userID, idErr := newID()
		if idErr != nil {
			return User{}, idErr
		}
		identityID, idErr := newID()
		if idErr != nil {
			return User{}, idErr
		}
		createdAt, insertErr := queries.InsertUser(ctx, authdb.InsertUserParams{
			ID: mustDatabaseUUID(userID), DisplayName: strings.TrimSpace(identity.DisplayName),
			AvatarUrl: identity.AvatarURL,
		})
		if insertErr != nil {
			return User{}, insertErr
		}
		if insertErr := queries.InsertExternalIdentity(ctx, authdb.InsertExternalIdentityParams{
			ID: mustDatabaseUUID(identityID), UserID: mustDatabaseUUID(userID),
			Issuer: identity.Issuer, Subject: identity.Subject,
			DisplayName: strings.TrimSpace(identity.DisplayName), AvatarUrl: identity.AvatarURL,
		}); insertErr != nil {
			return User{}, insertErr
		}
		return User{ID: userID, DisplayName: strings.TrimSpace(identity.DisplayName), AvatarURL: identity.AvatarURL, CreatedAt: createdAt}, nil
	}
	if err != nil {
		return User{}, err
	}
	if row.Status != "active" {
		return User{}, domainError(CodeUnauthenticated)
	}
	user, err := queries.GetUserForUpdate(ctx, row.UserID)
	if err != nil {
		return User{}, err
	}
	if user.Status != "active" {
		return User{}, domainError(CodeUserDisabled)
	}
	if err := queries.RefreshExternalIdentity(ctx, authdb.RefreshExternalIdentityParams{
		ID: row.ID, DisplayName: strings.TrimSpace(identity.DisplayName), AvatarUrl: identity.AvatarURL,
	}); err != nil {
		return User{}, err
	}
	return userFromRow(user), nil
}

func (m *Module) validateInitiatingSession(
	ctx context.Context,
	queries *authdb.Queries,
	claimed claimedFederatedLogin,
	requireFresh bool,
	now time.Time,
) (User, error) {
	sessionID, err := databaseUUID(claimed.initiatingSessionID)
	if err != nil {
		return User{}, domainError(CodeLoginStateMismatch)
	}
	row, err := queries.GetWebSessionForUpdate(ctx, sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, domainError(CodeSessionRevoked)
	}
	if err != nil {
		return User{}, err
	}
	if domainUUID(row.UserID) != claimed.initiatingUserID || row.SessionStatus != "active" {
		return User{}, domainError(CodeSessionRevoked)
	}
	if row.UserStatus != "active" {
		return User{}, domainError(CodeUserDisabled)
	}
	if !now.Before(row.AbsoluteExpiresAt) {
		return User{}, domainError(CodeSessionAbsoluteExpired)
	}
	if !now.Before(row.LastUsedAt.Add(m.policy.WebSessionIdleTTL + m.policy.LastUsedWriteInterval)) {
		return User{}, domainError(CodeSessionIdleExpired)
	}
	if requireFresh && now.Sub(row.ReauthenticatedAt) > m.policy.FreshAuthenticationTTL {
		return User{}, domainError(CodeFreshAuthenticationRequired)
	}
	return User{
		ID: domainUUID(row.UserID), DisplayName: row.DisplayName,
		AvatarURL: row.AvatarUrl, CreatedAt: row.UserCreatedAt,
	}, nil
}

func (m *Module) bindIdentity(
	ctx context.Context,
	queries *authdb.Queries,
	userID string,
	identity VerifiedExternalIdentity,
) error {
	if err := queries.AcquireAuthenticationLock(ctx, identityLockKey(identity)); err != nil {
		return err
	}
	row, err := queries.GetExternalIdentityForUpdate(ctx, authdb.GetExternalIdentityForUpdateParams{
		Issuer: identity.Issuer, Subject: identity.Subject,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		identityID, idErr := newID()
		if idErr != nil {
			return idErr
		}
		return queries.InsertExternalIdentity(ctx, authdb.InsertExternalIdentityParams{
			ID: mustDatabaseUUID(identityID), UserID: mustDatabaseUUID(userID),
			Issuer: identity.Issuer, Subject: identity.Subject,
			DisplayName: strings.TrimSpace(identity.DisplayName), AvatarUrl: identity.AvatarURL,
		})
	}
	if err != nil {
		return err
	}
	if domainUUID(row.UserID) != userID {
		return domainError(CodeExternalIdentityConflict)
	}
	return queries.RefreshExternalIdentity(ctx, authdb.RefreshExternalIdentityParams{
		ID: row.ID, DisplayName: strings.TrimSpace(identity.DisplayName), AvatarUrl: identity.AvatarURL,
	})
}

func (m *Module) verifyIdentityForUser(
	ctx context.Context,
	queries *authdb.Queries,
	userID string,
	identity VerifiedExternalIdentity,
) error {
	if err := queries.AcquireAuthenticationLock(ctx, identityLockKey(identity)); err != nil {
		return err
	}
	row, err := queries.GetExternalIdentityForUpdate(ctx, authdb.GetExternalIdentityForUpdateParams{
		Issuer: identity.Issuer, Subject: identity.Subject,
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (row.Status != "active" || domainUUID(row.UserID) != userID)) {
		return domainError(CodeProviderInvalidResponse)
	}
	if err != nil {
		return err
	}
	return queries.RefreshExternalIdentity(ctx, authdb.RefreshExternalIdentityParams{
		ID: row.ID, DisplayName: strings.TrimSpace(identity.DisplayName), AvatarUrl: identity.AvatarURL,
	})
}

func userFromRow(row authdb.AuthUser) User {
	return User{
		ID: domainUUID(row.ID), DisplayName: row.DisplayName,
		AvatarURL: row.AvatarUrl, CreatedAt: row.CreatedAt,
	}
}

func identityLockKey(identity VerifiedExternalIdentity) string {
	return fmt.Sprintf("identity:%d:%s:%s", len(identity.Issuer), identity.Issuer, identity.Subject)
}

func (m *Module) failFederatedInTransaction(
	ctx context.Context,
	queries *authdb.Queries,
	claimed claimedFederatedLogin,
	code ErrorCode,
	requestID string,
) (WebSessionGrant, error) {
	status := "failed"
	outcome := "failed"
	if code == CodeProviderAccessDenied {
		status = "denied"
		outcome = "denied"
	}
	if code == CodeLoginExpired {
		status = "expired"
	}
	if code == "" {
		code = CodeServiceUnavailable
	}
	if err := queries.FinishFederatedLogin(ctx, authdb.FinishFederatedLoginParams{
		Status: status, FailureCode: string(code), ID: mustDatabaseUUID(claimed.id),
	}); err != nil {
		return WebSessionGrant{}, err
	}
	if err := appendAudit(ctx, queries, auditRecord{
		initiatorKind: "federated_login", initiatorID: claimed.id,
		action: "federated_login.complete", targetKind: "federated_login", targetID: claimed.id,
		outcome: outcome, reason: string(code), requestID: requestID,
		providerRegistrationID: claimed.registration.ID,
		webSessionID:           claimed.initiatingSessionID,
	}); err != nil {
		return WebSessionGrant{}, err
	}
	return WebSessionGrant{}, commitWithError(domainError(code))
}

func (m *Module) finishFederatedFailure(
	ctx context.Context,
	claimed claimedFederatedLogin,
	code ErrorCode,
	requestID string,
) {
	_, _ = withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		_, err := m.failFederatedInTransaction(ctx, authdb.New(tx), claimed, code, requestID)
		var committed *commitError
		if errors.As(err, &committed) {
			return struct{}{}, nil
		}
		return struct{}{}, err
	})
}
