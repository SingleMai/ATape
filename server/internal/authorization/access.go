package authorization

import "fmt"

// AccessError preserves a policy decision across Module and Adapter boundaries
// without exposing the resource facts used to make it.
type AccessError struct {
	Decision Decision
	Denial   Denial
}

func (e *AccessError) Error() string {
	return fmt.Sprintf("authorization denied (decision=%d, reason=%d)", e.Decision, e.Denial)
}

// Enforce turns a pure policy Outcome into an error suitable for a use-case
// boundary. Allow is the only outcome that succeeds.
func Enforce(outcome Outcome) error {
	if outcome.Decision == Allow {
		return nil
	}
	return &AccessError{Decision: outcome.Decision, Denial: outcome.Denial}
}
