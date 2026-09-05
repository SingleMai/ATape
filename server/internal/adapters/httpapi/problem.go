package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/team"
)

type problemCode string

const (
	problemInvalidRequest             problemCode = "invalid_request"
	problemInvalidUserCode            problemCode = "invalid_user_code"
	problemInvalidJoinCode            problemCode = "invalid_join_code"
	problemInvalidDeviceCode          problemCode = "invalid_device_code"
	problemUnsupportedProtocol        problemCode = "unsupported_protocol_version"
	problemAmbiguousCredentials       problemCode = "ambiguous_credentials"
	problemUnauthenticated            problemCode = "unauthenticated"
	problemSessionExpired             problemCode = "session_expired"
	problemSessionRevoked             problemCode = "session_revoked"
	problemFreshAuthentication        problemCode = "fresh_authentication_required"
	problemOriginRejected             problemCode = "origin_rejected"
	problemCSRFRejected               problemCode = "csrf_rejected"
	problemAccessDenied               problemCode = "access_denied"
	problemMembershipRoleDenied       problemCode = "membership_role_denied"
	problemCredentialCapabilityDenied problemCode = "credential_capability_denied"
	problemNotFound                   problemCode = "not_found"
	problemMethodNotAllowed           problemCode = "method_not_allowed"
	problemExternalIdentityConflict   problemCode = "external_identity_conflict"
	problemLastOwnerRequired          problemCode = "last_owner_required"
	problemGrantAlreadyDecided        problemCode = "grant_already_decided"
	problemGrantConsumed              problemCode = "grant_consumed"
	problemIdempotencyConflict        problemCode = "idempotency_conflict"
	problemIdempotencyInProgress      problemCode = "idempotency_in_progress"
	problemResourceStateConflict      problemCode = "resource_state_conflict"
	problemLoginExpired               problemCode = "login_expired"
	problemExpiredToken               problemCode = "expired_token"
	problemRequestTooLarge            problemCode = "request_too_large"
	problemUnsupportedMediaType       problemCode = "unsupported_media_type"
	problemValidationFailed           problemCode = "validation_failed"
	problemSlowDown                   problemCode = "slow_down"
	problemTooManyCodeAttempts        problemCode = "too_many_code_attempts"
	problemInternal                   problemCode = "internal_error"
	problemProviderUnavailable        problemCode = "provider_unavailable"
	problemServiceUnavailable         problemCode = "service_unavailable"
)

type problemDefinition struct {
	status int
	title  string
	detail string
}

var problemRegistry = map[problemCode]problemDefinition{
	problemInvalidRequest:             {400, "The request is invalid", "The request could not be understood."},
	problemInvalidUserCode:            {400, "The user code is invalid", "The user code is invalid or no longer available."},
	problemInvalidJoinCode:            {400, "The join code is invalid", "The join code is invalid or no longer available."},
	problemInvalidDeviceCode:          {400, "The device code is invalid", "The device authorization cannot be used."},
	problemUnsupportedProtocol:        {400, "The protocol version is unsupported", "Use a protocol version supported by this ATape instance."},
	problemAmbiguousCredentials:       {400, "The credentials are ambiguous", "Send exactly one supported authentication credential."},
	problemUnauthenticated:            {401, "Authentication is required", "Sign in or provide a valid CLI credential."},
	problemSessionExpired:             {401, "The session has expired", "Sign in again to continue."},
	problemSessionRevoked:             {401, "The session was revoked", "Sign in again to continue."},
	problemFreshAuthentication:        {401, "Recent authentication is required", "Reauthenticate before performing this action."},
	problemOriginRejected:             {403, "The request origin is not allowed", "Send the request from the configured ATape Web origin."},
	problemCSRFRejected:               {403, "The CSRF proof is invalid", "Refresh the session and try the action again."},
	problemAccessDenied:               {403, "The action is not allowed", "The authenticated account cannot perform this action."},
	problemMembershipRoleDenied:       {403, "The action is not allowed", "Your Team role does not allow this action."},
	problemCredentialCapabilityDenied: {403, "The credential cannot perform this action", "Use an authentication method with the required capability."},
	problemNotFound:                   {404, "The resource was not found", "The requested resource was not found."},
	problemMethodNotAllowed:           {405, "The method is not allowed", "Use a supported method for this resource."},
	problemExternalIdentityConflict:   {409, "The identity is already connected", "That external identity belongs to another account."},
	problemLastOwnerRequired:          {409, "The Team needs an owner", "Promote another owner before completing this action."},
	problemGrantAlreadyDecided:        {409, "The authorization was already decided", "The opposite decision cannot be applied."},
	problemGrantConsumed:              {409, "The authorization was already claimed", "Start a new CLI authorization."},
	problemIdempotencyConflict:        {409, "The idempotency key conflicts", "Reuse the key only with the same request."},
	problemIdempotencyInProgress:      {409, "The operation is still in progress", "Retry this operation after the indicated delay."},
	problemResourceStateConflict:      {409, "The resource state conflicts", "The resource cannot perform this action in its current state."},
	problemLoginExpired:               {410, "The login has expired", "Start a new sign-in attempt."},
	problemExpiredToken:               {410, "The authorization has expired", "Start a new CLI authorization."},
	problemRequestTooLarge:            {413, "The request is too large", "Reduce the request body size."},
	problemUnsupportedMediaType:       {415, "The media type is unsupported", "Send the request as application/json."},
	problemValidationFailed:           {422, "The request failed validation", "Correct the indicated fields and try again."},
	problemSlowDown:                   {429, "Polling is too frequent", "Wait for the indicated interval before polling again."},
	problemTooManyCodeAttempts:        {429, "Too many code attempts", "Wait before trying another code."},
	problemInternal:                   {500, "The request could not be completed", "An internal error occurred."},
	problemProviderUnavailable:        {503, "The identity provider is unavailable", "Start a new login after the provider recovers."},
	problemServiceUnavailable:         {503, "The service is unavailable", "Try the operation again later if it is safe to retry."},
}

type fieldProblem struct {
	Field string `json:"field"`
	Code  string `json:"code"`
}

type problemDocument struct {
	Type      string         `json:"type"`
	Title     string         `json:"title"`
	Status    int            `json:"status"`
	Code      problemCode    `json:"code"`
	Detail    string         `json:"detail"`
	Instance  string         `json:"instance"`
	RequestID string         `json:"requestId"`
	Errors    []fieldProblem `json:"errors,omitempty"`
}

func writeProblem(
	response http.ResponseWriter,
	request *http.Request,
	code problemCode,
	retryAfter int,
	fields []fieldProblem,
) {
	definition, ok := problemRegistry[code]
	if !ok {
		code = problemInternal
		definition = problemRegistry[code]
	}
	requestID := requestIDFromContext(request.Context())
	if requestID == "" {
		requestID = newRequestID()
		response.Header().Set("X-Request-ID", requestID)
	}
	if retryAfter <= 0 {
		switch definition.status {
		case http.StatusTooManyRequests:
			retryAfter = 1
		case http.StatusServiceUnavailable:
			retryAfter = 5
		}
	}
	if retryAfter > 0 {
		response.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	}
	setNoStore(response.Header())
	response.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	response.WriteHeader(definition.status)
	_ = json.NewEncoder(response).Encode(problemDocument{
		Type: "https://atape.dev/problems/v1/" + string(code), Title: definition.title,
		Status: definition.status, Code: code, Detail: definition.detail,
		Instance: "urn:atape:request:" + requestID, RequestID: requestID, Errors: fields,
	})
}

func writeError(response http.ResponseWriter, request *http.Request, err error) {
	code, retryAfter, fields := classifyError(err)
	if code == problemInternal {
		slog.ErrorContext(request.Context(), "HTTP request failed", "request_id", requestIDFromContext(request.Context()),
			"method", request.Method, "path", request.URL.Path, "error_type", errorType(err))
	}
	writeProblem(response, request, code, retryAfter, fields)
}

func classifyError(err error) (problemCode, int, []fieldProblem) {
	var authError *authentication.Error
	if errors.As(err, &authError) {
		return classifyAuthenticationError(authError)
	}
	var teamError *team.Error
	if errors.As(err, &teamError) {
		return classifyTeamError(teamError)
	}
	var access *authorization.AccessError
	if errors.As(err, &access) {
		switch access.Denial {
		case authorization.ResourceConcealed:
			return problemNotFound, 0, nil
		case authorization.MembershipRoleDenied:
			return problemMembershipRoleDenied, 0, nil
		case authorization.CredentialCapabilityDenied:
			return problemCredentialCapabilityDenied, 0, nil
		case authorization.FreshAuthenticationRequired:
			return problemFreshAuthentication, 0, nil
		default:
			return problemInternal, 0, nil
		}
	}
	var canonicalValidation *ingestion.ValidationError
	if errors.As(err, &canonicalValidation) {
		if canonicalValidation.Field == "protocolVersion" {
			return problemUnsupportedProtocol, 0, nil
		}
		return problemValidationFailed, 0, []fieldProblem{{Field: canonicalValidation.Field, Code: "invalid"}}
	}
	var rawValidation *rawarchive.ValidationError
	if errors.As(err, &rawValidation) {
		if rawValidation.Field == "protocolVersion" {
			return problemUnsupportedProtocol, 0, nil
		}
		return problemValidationFailed, 0, []fieldProblem{{Field: rawValidation.Field, Code: "invalid"}}
	}
	var searchValidation *projectsearch.InvalidQueryError
	if errors.As(err, &searchValidation) {
		return problemValidationFailed, 0, []fieldProblem{{Field: searchValidation.Field, Code: "invalid"}}
	}
	var canonicalConflict *canonical.ConflictError
	var rawConflict *rawarchive.ConflictError
	if errors.As(err, &canonicalConflict) || errors.As(err, &rawConflict) {
		return problemIdempotencyConflict, 0, nil
	}
	var canonicalState *canonical.ProjectStateError
	var rawState *rawarchive.ProjectStateError
	if errors.As(err, &canonicalState) || errors.As(err, &rawState) {
		return problemResourceStateConflict, 0, nil
	}
	var conversationNotFound *conversation.NotFoundError
	var rawNotFound *rawarchive.NotFoundError
	if errors.As(err, &conversationNotFound) || errors.As(err, &rawNotFound) {
		return problemNotFound, 0, nil
	}
	var rawUnavailable *rawarchive.UnavailableError
	if errors.As(err, &rawUnavailable) {
		return problemServiceUnavailable, 0, nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return problemServiceUnavailable, 0, nil
	}
	return problemInternal, 0, nil
}

func classifyAuthenticationError(err *authentication.Error) (problemCode, int, []fieldProblem) {
	switch err.Code {
	case authentication.CodeInvalidRequest:
		return problemInvalidRequest, err.RetryAfter, nil
	case authentication.CodeNotFound:
		return problemNotFound, err.RetryAfter, nil
	case authentication.CodeLoginExpired:
		return problemLoginExpired, err.RetryAfter, nil
	case authentication.CodeProviderAccessDenied, authentication.CodeAccessDenied:
		return problemAccessDenied, err.RetryAfter, nil
	case authentication.CodeProviderUnavailable:
		return problemProviderUnavailable, err.RetryAfter, nil
	case authentication.CodeExternalIdentityConflict:
		return problemExternalIdentityConflict, err.RetryAfter, nil
	case authentication.CodeFreshAuthenticationRequired:
		return problemFreshAuthentication, err.RetryAfter, nil
	case authentication.CodeUnauthenticated:
		return problemUnauthenticated, err.RetryAfter, nil
	case authentication.CodeSessionIdleExpired, authentication.CodeSessionAbsoluteExpired:
		return problemSessionExpired, err.RetryAfter, nil
	case authentication.CodeSessionRevoked, authentication.CodeCredentialRevoked, authentication.CodeUserDisabled:
		return problemSessionRevoked, err.RetryAfter, nil
	case authentication.CodeInvalidUserCode:
		return problemInvalidUserCode, err.RetryAfter, nil
	case authentication.CodeTooManyCodeAttempts:
		return problemTooManyCodeAttempts, err.RetryAfter, nil
	case authentication.CodeGrantAlreadyDecided:
		return problemGrantAlreadyDecided, err.RetryAfter, nil
	case authentication.CodeAuthorizationPending:
		return problemInvalidRequest, err.RetryAfter, nil
	case authentication.CodeSlowDown:
		return problemSlowDown, err.RetryAfter, nil
	case authentication.CodeExpiredToken:
		return problemExpiredToken, err.RetryAfter, nil
	case authentication.CodeInvalidDeviceCode:
		return problemInvalidDeviceCode, err.RetryAfter, nil
	case authentication.CodeGrantConsumed:
		return problemGrantConsumed, err.RetryAfter, nil
	case authentication.CodeLastOwnerRequired:
		return problemLastOwnerRequired, err.RetryAfter, nil
	case authentication.CodeServiceUnavailable, authentication.CodeOutcomeUnknown:
		return problemServiceUnavailable, err.RetryAfter, nil
	default:
		return problemInternal, 0, nil
	}
}

func classifyTeamError(err *team.Error) (problemCode, int, []fieldProblem) {
	switch err.Code {
	case team.CodeInvalidRequest:
		return problemInvalidRequest, err.RetryAfter, nil
	case team.CodeNotFound:
		return problemNotFound, err.RetryAfter, nil
	case team.CodeMembershipRoleDenied:
		return problemMembershipRoleDenied, err.RetryAfter, nil
	case team.CodeCredentialCapabilityDenied:
		return problemCredentialCapabilityDenied, err.RetryAfter, nil
	case team.CodeFreshAuthenticationRequired:
		return problemFreshAuthentication, err.RetryAfter, nil
	case team.CodeInvalidJoinCode:
		return problemInvalidJoinCode, err.RetryAfter, nil
	case team.CodeTooManyJoinCodeAttempts:
		return problemTooManyCodeAttempts, err.RetryAfter, nil
	case team.CodeLastOwnerRequired:
		return problemLastOwnerRequired, err.RetryAfter, nil
	case team.CodeResourceStateConflict:
		return problemResourceStateConflict, err.RetryAfter, nil
	case team.CodeIdempotencyConflict:
		return problemIdempotencyConflict, err.RetryAfter, nil
	case team.CodeIdempotencyInProgress:
		return problemIdempotencyInProgress, err.RetryAfter, nil
	case team.CodeUserDisabled:
		return problemSessionRevoked, err.RetryAfter, nil
	case team.CodeServiceUnavailable, team.CodeOutcomeUnknown:
		return problemServiceUnavailable, err.RetryAfter, nil
	default:
		return problemInternal, 0, nil
	}
}

func errorType(err error) string {
	if err == nil {
		return "nil"
	}
	return fmt.Sprintf("%T", err)
}
