package authentication

import (
	"testing"
	"time"
)

func TestDefaultWebSessionPolicy(t *testing.T) {
	policy := DefaultPolicy()
	if policy.WebSessionAbsoluteTTL != 180*24*time.Hour ||
		policy.WebSessionIdleTTL != 30*24*time.Hour ||
		policy.FreshAuthenticationTTL != 15*time.Minute {
		t.Fatalf("unexpected default Web Session policy: %+v", policy)
	}
}
