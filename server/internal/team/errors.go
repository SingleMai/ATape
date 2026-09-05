package team

import (
	"errors"
	"fmt"
)

type ErrorCode string

const (
	CodeInvalidRequest              ErrorCode = "invalid_request"
	CodeNotFound                    ErrorCode = "not_found"
	CodeMembershipRoleDenied        ErrorCode = "membership_role_denied"
	CodeCredentialCapabilityDenied  ErrorCode = "credential_capability_denied"
	CodeFreshAuthenticationRequired ErrorCode = "fresh_authentication_required"
	CodeInvalidJoinCode             ErrorCode = "invalid_join_code"
	CodeTooManyJoinCodeAttempts     ErrorCode = "too_many_join_code_attempts"
	CodeLastOwnerRequired           ErrorCode = "last_owner_required"
	CodeResourceStateConflict       ErrorCode = "resource_state_conflict"
	CodeIdempotencyConflict         ErrorCode = "idempotency_conflict"
	CodeUserDisabled                ErrorCode = "user_disabled"
	CodeMisconfigured               ErrorCode = "misconfigured"
	CodeServiceUnavailable          ErrorCode = "service_unavailable"
	CodeOutcomeUnknown              ErrorCode = "outcome_unknown"
)

// Error carries a stable, data-poor domain category. It never includes a Team
// Join Code, hidden Resource identity, SQL argument, or credential.
type Error struct {
	Code       ErrorCode
	RetryAfter int
	cause      error
}

func (e *Error) Error() string {
	switch e.Code {
	case CodeInvalidRequest:
		return "team request is invalid"
	case CodeNotFound:
		return "resource was not found"
	case CodeMembershipRoleDenied:
		return "membership role does not allow this action"
	case CodeCredentialCapabilityDenied:
		return "credential capability does not allow this action"
	case CodeFreshAuthenticationRequired:
		return "fresh authentication is required"
	case CodeInvalidJoinCode:
		return "team join code is invalid"
	case CodeTooManyJoinCodeAttempts:
		return "too many invalid team join code attempts"
	case CodeLastOwnerRequired:
		return "team must retain an active owner"
	case CodeResourceStateConflict:
		return "resource state conflicts with this action"
	case CodeIdempotencyConflict:
		return "operation key was reused with different input"
	case CodeUserDisabled:
		return "user is disabled"
	case CodeMisconfigured:
		return "team authorization is misconfigured"
	case CodeOutcomeUnknown:
		return "team operation commit outcome is unknown"
	default:
		return "team operation is unavailable"
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
	return &Error{Code: CodeServiceUnavailable, cause: fmt.Errorf("%s: %w", operation, err)}
}
