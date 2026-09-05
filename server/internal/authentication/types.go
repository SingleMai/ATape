// Package authentication owns local User identity and revocable Web and CLI
// authentication. Its exported operations are use cases; persistence rows,
// secret digests, encryption, locks, and transaction sequencing are private.
package authentication

import (
	"context"
	"time"
)

// FederatedIdentityAdapter is the true external Seam between Authentication
// and a configured identity provider. Implementations must be stateless across
// Begin and Complete; all resumable provider state travels as opaque bytes.
type FederatedIdentityAdapter interface {
	Begin(context.Context, ProviderBeginRequest) (ProviderBeginResult, error)
	Complete(context.Context, ProviderCompleteRequest) (VerifiedExternalIdentity, error)
}

type ProviderBeginRequest struct {
	CallbackURI string
	State       string
}

type ProviderBeginResult struct {
	AuthorizationURI string
	PrivateState     []byte
	StateSchema      string
}

type ProviderCompleteRequest struct {
	CallbackURI        string
	AuthorizationCode  string
	AuthorizationError string
	PrivateState       []byte
	PrivateStateSchema string
}

type VerifiedExternalIdentity struct {
	Issuer      string
	Subject     string
	DisplayName string
	AvatarURL   string
}

type ProviderFailureCode string

const (
	ProviderAccessDenied      ProviderFailureCode = "access_denied"
	ProviderInvalidResponse   ProviderFailureCode = "invalid_response"
	ProviderUnavailable       ProviderFailureCode = "unavailable"
	ProviderMisconfigured     ProviderFailureCode = "misconfigured"
	ProviderProtocolViolation ProviderFailureCode = "protocol_violation"
)

// ProviderFailure contains only a stable category. Provider Adapters must not
// wrap token responses, authorization codes, raw claims, or remote bodies into
// an error returned across the Seam.
type ProviderFailure struct {
	Code ProviderFailureCode
}

func (e *ProviderFailure) Error() string {
	switch e.Code {
	case ProviderAccessDenied:
		return "identity provider access was denied"
	case ProviderInvalidResponse:
		return "identity provider returned an invalid response"
	case ProviderUnavailable:
		return "identity provider is unavailable"
	case ProviderMisconfigured:
		return "identity provider is misconfigured"
	case ProviderProtocolViolation:
		return "identity provider protocol validation failed"
	default:
		return "identity provider operation failed"
	}
}

type ProviderRegistration struct {
	ID             string
	Revision       string
	ExpectedIssuer string
	CallbackURI    string
	Active         bool
	Adapter        FederatedIdentityAdapter
}

type LoginIntent string

const (
	SignInIntent         LoginIntent = "sign_in"
	BindIdentityIntent   LoginIntent = "bind_identity"
	ReauthenticateIntent LoginIntent = "reauthenticate"
)

type BeginFederatedLoginInput struct {
	Intent                  LoginIntent
	ProviderRegistrationID  string
	ReturnTo                string
	CurrentWebSessionSecret string
	RequestID               string
}

type FederatedLoginChallenge struct {
	LoginTransactionID string
	AuthorizationURI   string
	BrowserBinding     string
	ExpiresAt          time.Time
}

type CompleteFederatedLoginInput struct {
	ProviderRegistrationID string
	State                  string
	BrowserBinding         string
	AuthorizationCode      string
	AuthorizationError     string
	RequestID              string
}

type User struct {
	ID          string
	DisplayName string
	AvatarURL   string
	CreatedAt   time.Time
}

type DisableUserInput struct {
	UserID    string
	Reason    string
	RequestID string
}

type AuthenticationMethod string

const (
	WebAuthentication AuthenticationMethod = "web_session"
	CLIAuthentication AuthenticationMethod = "cli_credential"
)

// Principal deliberately contains no Team, Membership, Role, or permission
// snapshot. Authorization resolves those facts independently per operation.
type Principal struct {
	UserID          string
	Method          AuthenticationMethod
	WebSessionID    string
	CLICredentialID string
	AuthenticatedAt time.Time
	Fresh           bool
}

type WebSession struct {
	ID                string
	UserID            string
	CreatedAt         time.Time
	LastUsedAt        time.Time
	ReauthenticatedAt time.Time
	AbsoluteExpiresAt time.Time
}

// WebSessionView is the non-secret shape exposed by the Session management
// use case. ATape deliberately does not infer or persist a browser/device name.
type WebSessionView struct {
	ID                string
	CreatedAt         time.Time
	LastUsedAt        time.Time
	ReauthenticatedAt time.Time
	AbsoluteExpiresAt time.Time
	Current           bool
}

type WebSessionGrant struct {
	User          User
	Session       WebSession
	SessionSecret string
	CSRFToken     string
	ReturnTo      string
}

type AuthenticatedWebSession struct {
	Principal Principal
	User      User
	Session   WebSession
	CSRFToken string
}

type RevokeWebSessionsInput struct {
	Principal Principal
	SessionID string
	All       bool
	Reason    string
	RequestID string
}

type CLIDeviceAuthorization struct {
	ID                  string
	DeviceCode          string
	UserCode            string
	ExpiresAt           time.Time
	PollIntervalSeconds int
}

type CLIAuthorizationView struct {
	ID          string
	UserCode    string
	ExpiresAt   time.Time
	ClientLabel string
	Capability  string
	Status      string
}

type CLIDecision string

const (
	ApproveCLI CLIDecision = "approve"
	DenyCLI    CLIDecision = "deny"
)

type CLICredentialGrant struct {
	CredentialID     string
	CredentialSecret string
	Capability       string
	CreatedAt        time.Time
	User             User
}

type CLICredentialView struct {
	ID         string
	Capability string
	CreatedAt  time.Time
	LastUsedAt time.Time
}

type AuthenticatedCLICredential struct {
	Principal  Principal
	User       User
	Capability string
	CreatedAt  time.Time
	LastUsedAt time.Time
}

type RevokeCLICredentialsInput struct {
	Principal    Principal
	CredentialID string
	All          bool
	Reason       string
	RequestID    string
}

type MaintenanceResult struct {
	Acquired                  bool
	ExpiredFederatedLogins    int64
	ExpiredWebSessions        int64
	ExpiredCLIAuthorizations  int64
	DeletedFederatedLogins    int64
	DeletedCLIAuthorizations  int64
	DeletedWebSessionSecrets  int64
	DeletedWebSessions        int64
	DeletedCLICredentials     int64
	DeletedCodeAttemptWindows int64
}
