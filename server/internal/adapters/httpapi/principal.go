package httpapi

import (
	"context"

	"github.com/SingleMai/ATape/server/internal/authentication"
)

type principalContextKey struct{}

// WithPrincipal is the narrow hand-off used by the authentication middleware.
// Business Modules still receive the Principal explicitly and own every
// resource authorization decision.
func WithPrincipal(ctx context.Context, principal authentication.Principal) context.Context {
	return context.WithValue(ctx, principalContextKey{}, principal)
}

func principalFromContext(ctx context.Context) authentication.Principal {
	principal, _ := ctx.Value(principalContextKey{}).(authentication.Principal)
	return principal
}
