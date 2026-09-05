package httpapi

import (
	"context"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/google/uuid"
)

type authenticationContextKey struct{}
type requestIDContextKey struct{}
type requestBodyPolicyContextKey struct{}

type requestAuthentication struct {
	principal authentication.Principal
	user      authentication.User
	web       *authentication.AuthenticatedWebSession
	cli       *authentication.AuthenticatedCLICredential
	webSecret string
	cliSecret string
}

func principalFromContext(ctx context.Context) authentication.Principal {
	return requestAuthenticationFromContext(ctx).principal
}

func withRequestAuthentication(ctx context.Context, value requestAuthentication) context.Context {
	return context.WithValue(ctx, authenticationContextKey{}, value)
}

func requestAuthenticationFromContext(ctx context.Context) requestAuthentication {
	value, _ := ctx.Value(authenticationContextKey{}).(requestAuthentication)
	return value
}

func withRequestID(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, requestIDContextKey{}, requestID)
}

func requestIDFromContext(ctx context.Context) string {
	value, _ := ctx.Value(requestIDContextKey{}).(string)
	return value
}

func newRequestID() string {
	value, err := uuid.NewV7()
	if err != nil {
		return uuid.NewString()
	}
	return value.String()
}

func withRequestBodyPolicy(ctx context.Context, policy requestBodyPolicy) context.Context {
	return context.WithValue(ctx, requestBodyPolicyContextKey{}, policy)
}

func requestBodyPolicyFromContext(ctx context.Context) requestBodyPolicy {
	value, _ := ctx.Value(requestBodyPolicyContextKey{}).(requestBodyPolicy)
	return value
}
