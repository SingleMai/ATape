package authcutover

import (
	"errors"
	"fmt"
)

type ErrorCode string

const (
	CodeInvalidMapping    ErrorCode = "invalid_mapping"
	CodeInvalidPlan       ErrorCode = "invalid_plan"
	CodeStateConflict     ErrorCode = "cutover_state_conflict"
	CodePlanNotApplicable ErrorCode = "cutover_plan_not_applicable"
	CodePlanStale         ErrorCode = "cutover_plan_stale"
	CodeNotReady          ErrorCode = "cutover_not_ready"
	CodeUnavailable       ErrorCode = "cutover_unavailable"
)

type Error struct {
	Code  ErrorCode
	cause error
}

func (e *Error) Error() string {
	if e.cause == nil {
		return string(e.Code)
	}
	return fmt.Sprintf("%s: %v", e.Code, e.cause)
}

func (e *Error) Unwrap() error { return e.cause }

func ErrorCodeOf(err error) ErrorCode {
	var cutover *Error
	if errors.As(err, &cutover) {
		return cutover.Code
	}
	return ""
}

func domainError(code ErrorCode) error { return &Error{Code: code} }

func unavailable(operation string, err error) error {
	return &Error{Code: CodeUnavailable, cause: fmt.Errorf("%s: %w", operation, err)}
}
