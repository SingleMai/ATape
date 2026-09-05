package authentication

import (
	"errors"
	"fmt"
)

type ErrorCode string

const (
	CodeInvalidRequest              ErrorCode = "invalid_request"
	CodeMisconfigured               ErrorCode = "misconfigured"
	CodeServiceUnavailable          ErrorCode = "service_unavailable"
	CodeLoginExpired                ErrorCode = "login_expired"
	CodeLoginStateMismatch          ErrorCode = "login_state_mismatch"
	CodeLoginAlreadyConsumed        ErrorCode = "login_already_consumed"
	CodeProviderAccessDenied        ErrorCode = "provider_access_denied"
	CodeProviderUnavailable         ErrorCode = "provider_unavailable"
	CodeProviderInvalidResponse     ErrorCode = "provider_invalid_response"
	CodeExternalIdentityConflict    ErrorCode = "external_identity_conflict"
	CodeFreshAuthenticationRequired ErrorCode = "fresh_authentication_required"
	CodeUnauthenticated             ErrorCode = "unauthenticated"
	CodeSessionIdleExpired          ErrorCode = "session_idle_expired"
	CodeSessionAbsoluteExpired      ErrorCode = "session_absolute_expired"
	CodeSessionRevoked              ErrorCode = "session_revoked"
	CodeUserDisabled                ErrorCode = "user_disabled"
	CodeInvalidUserCode             ErrorCode = "invalid_user_code"
	CodeTooManyCodeAttempts         ErrorCode = "too_many_code_attempts"
	CodeGrantAlreadyDecided         ErrorCode = "grant_already_decided"
	CodeAuthorizationPending        ErrorCode = "authorization_pending"
	CodeSlowDown                    ErrorCode = "slow_down"
	CodeAccessDenied                ErrorCode = "access_denied"
	CodeExpiredToken                ErrorCode = "expired_token"
	CodeInvalidDeviceCode           ErrorCode = "invalid_device_code"
	CodeGrantConsumed               ErrorCode = "grant_consumed"
	CodeCredentialRevoked           ErrorCode = "credential_revoked"
	CodeOutcomeUnknown              ErrorCode = "outcome_unknown"
)

// Error is deliberately data-poor. It carries a stable domain category and
// optional retry delay, never a submitted Secret, code, Provider payload, SQL
// argument, or hidden identity.
type Error struct {
	Code       ErrorCode
	RetryAfter int
	cause      error
}

func (e *Error) Error() string {
	switch e.Code {
	case CodeInvalidRequest:
		return "authentication request is invalid"
	case CodeMisconfigured:
		return "authentication is misconfigured"
	case CodeServiceUnavailable:
		return "authentication is unavailable"
	case CodeLoginExpired:
		return "federated login has expired"
	case CodeLoginStateMismatch:
		return "federated login proof is invalid"
	case CodeLoginAlreadyConsumed:
		return "federated login was already consumed"
	case CodeProviderAccessDenied:
		return "identity provider access was denied"
	case CodeProviderUnavailable:
		return "identity provider is unavailable"
	case CodeProviderInvalidResponse:
		return "identity provider response is invalid"
	case CodeExternalIdentityConflict:
		return "external identity belongs to another user"
	case CodeFreshAuthenticationRequired:
		return "fresh authentication is required"
	case CodeUnauthenticated:
		return "authentication credential is invalid"
	case CodeSessionIdleExpired:
		return "web session expired after inactivity"
	case CodeSessionAbsoluteExpired:
		return "web session reached its absolute lifetime"
	case CodeSessionRevoked:
		return "web session was revoked"
	case CodeUserDisabled:
		return "user is disabled"
	case CodeInvalidUserCode:
		return "user code is invalid"
	case CodeTooManyCodeAttempts:
		return "too many invalid user code attempts"
	case CodeGrantAlreadyDecided:
		return "CLI authorization was already decided"
	case CodeAuthorizationPending:
		return "CLI authorization is pending"
	case CodeSlowDown:
		return "CLI authorization polling must slow down"
	case CodeAccessDenied:
		return "CLI authorization was denied"
	case CodeExpiredToken:
		return "CLI authorization expired"
	case CodeInvalidDeviceCode:
		return "device code is invalid"
	case CodeGrantConsumed:
		return "CLI authorization was already claimed"
	case CodeCredentialRevoked:
		return "CLI credential was revoked"
	case CodeOutcomeUnknown:
		return "authentication commit outcome is unknown"
	default:
		return "authentication operation failed"
	}
}

func (e *Error) Unwrap() error { return e.cause }

func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	return ok && e.Code == other.Code
}

func ErrorCodeOf(err error) ErrorCode {
	var typed *Error
	if errors.As(err, &typed) {
		return typed.Code
	}
	return ""
}

func domainError(code ErrorCode) error { return &Error{Code: code} }

func retryError(code ErrorCode, retryAfter int) error {
	return &Error{Code: code, RetryAfter: retryAfter}
}

func unavailable(operation string, err error) error {
	if err == nil {
		return &Error{Code: CodeServiceUnavailable}
	}
	// The wrapped message contains only a developer-authored operation label.
	// pgx errors are retained for errors.Is/As but never formatted here.
	return &Error{Code: CodeServiceUnavailable, cause: fmt.Errorf("%s: %w", operation, err)}
}
