// Package federatedidentitycontract verifies the observable Begin/Complete
// guarantees shared by production Federated Identity Adapters. It deliberately
// knows nothing about ATape User, Team, Session, HTTP routes, or Provider token
// response types.
package federatedidentitycontract

import (
	"context"
	"errors"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
)

type Scenario string

const (
	Success           Scenario = "success"
	Unavailable       Scenario = "unavailable"
	MalformedResponse Scenario = "malformed_response"
	OversizedResponse Scenario = "oversized_response"
	Timeout           Scenario = "timeout"
)

// Pair must contain separately constructed Adapters backed by the same fake
// Provider. The contract begins on one instance and completes on the other to
// prove that resumable state crosses only through opaque PrivateState.
type Pair struct {
	BeginAdapter    authentication.FederatedIdentityAdapter
	CompleteAdapter authentication.FederatedIdentityAdapter
	SensitiveValues []string
}

type Factory func(*testing.T, Scenario) Pair

type Contract struct {
	Factory                   Factory
	ExpectedIdentity          authentication.VerifiedExternalIdentity
	CallbackURI               string
	AuthorizationServerIssuer string
	State                     string
	AuthorizationCode         string
}

func Run(t *testing.T, contract Contract) {
	t.Helper()
	if contract.CallbackURI == "" {
		contract.CallbackURI = "https://api.example.test/api/v1/auth/provider/callback"
	}
	if contract.State == "" {
		contract.State = "federated-state-contract-canary-0123456789"
	}
	if contract.AuthorizationServerIssuer == "" {
		contract.AuthorizationServerIssuer = "https://identity.example.test/oauth"
	}
	if contract.AuthorizationCode == "" {
		contract.AuthorizationCode = "authorization-code-contract-canary"
	}

	t.Run("round trips opaque state across Adapter instances", func(t *testing.T) {
		pair := contract.Factory(t, Success)
		begin := begin(t, pair.BeginAdapter, contract)
		parsed, err := url.Parse(begin.AuthorizationURI)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
			t.Fatalf("authorization URI = %q, want absolute HTTPS", begin.AuthorizationURI)
		}
		if begin.StateSchema == "" || len(begin.StateSchema) > 100 || len(begin.PrivateState) == 0 || len(begin.PrivateState) > 16<<10 {
			t.Fatalf("invalid opaque Provider state: schema=%q bytes=%d", begin.StateSchema, len(begin.PrivateState))
		}
		if strings.Contains(begin.AuthorizationURI, string(begin.PrivateState)) {
			t.Fatal("authorization URI exposed opaque PrivateState")
		}
		identity, err := pair.CompleteAdapter.Complete(context.Background(), authentication.ProviderCompleteRequest{
			CallbackURI: contract.CallbackURI, AuthorizationServerIssuer: contract.AuthorizationServerIssuer,
			AuthorizationCode: contract.AuthorizationCode,
			PrivateState:      append([]byte(nil), begin.PrivateState...), PrivateStateSchema: begin.StateSchema,
		})
		if err != nil {
			t.Fatalf("complete on a fresh Adapter instance: %v", err)
		}
		if !reflect.DeepEqual(identity, contract.ExpectedIdentity) {
			t.Fatalf("identity = %+v, want %+v", identity, contract.ExpectedIdentity)
		}
	})

	t.Run("maps user denial without remote details", func(t *testing.T) {
		pair := contract.Factory(t, Success)
		begin := begin(t, pair.BeginAdapter, contract)
		_, err := pair.CompleteAdapter.Complete(context.Background(), authentication.ProviderCompleteRequest{
			CallbackURI: contract.CallbackURI, AuthorizationServerIssuer: contract.AuthorizationServerIssuer,
			AuthorizationError: "access_denied",
			PrivateState:       begin.PrivateState, PrivateStateSchema: begin.StateSchema,
		})
		assertFailure(t, err, authentication.ProviderAccessDenied, sensitive(contract, pair, begin)...)
	})

	t.Run("rejects invalid resumable state", func(t *testing.T) {
		pair := contract.Factory(t, Success)
		begin := begin(t, pair.BeginAdapter, contract)
		_, err := pair.CompleteAdapter.Complete(context.Background(), authentication.ProviderCompleteRequest{
			CallbackURI: contract.CallbackURI, AuthorizationServerIssuer: contract.AuthorizationServerIssuer,
			AuthorizationCode: contract.AuthorizationCode,
			PrivateState:      begin.PrivateState, PrivateStateSchema: begin.StateSchema + "-unknown",
		})
		assertFailure(t, err, authentication.ProviderProtocolViolation, sensitive(contract, pair, begin)...)
	})

	t.Run("rejects an authorization server mix-up", func(t *testing.T) {
		pair := contract.Factory(t, Success)
		begin := begin(t, pair.BeginAdapter, contract)
		_, err := pair.CompleteAdapter.Complete(context.Background(), authentication.ProviderCompleteRequest{
			CallbackURI: contract.CallbackURI, AuthorizationServerIssuer: "https://attacker.example/oauth",
			AuthorizationCode: contract.AuthorizationCode, PrivateState: begin.PrivateState,
			PrivateStateSchema: begin.StateSchema,
		})
		assertFailure(t, err, authentication.ProviderProtocolViolation, sensitive(contract, pair, begin)...)
	})

	for _, test := range []struct {
		name     string
		scenario Scenario
		code     authentication.ProviderFailureCode
	}{
		{name: "maps Provider outage", scenario: Unavailable, code: authentication.ProviderUnavailable},
		{name: "rejects malformed response", scenario: MalformedResponse, code: authentication.ProviderInvalidResponse},
		{name: "rejects oversized response", scenario: OversizedResponse, code: authentication.ProviderInvalidResponse},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			pair := contract.Factory(t, test.scenario)
			begin := begin(t, pair.BeginAdapter, contract)
			_, err := pair.CompleteAdapter.Complete(context.Background(), authentication.ProviderCompleteRequest{
				CallbackURI: contract.CallbackURI, AuthorizationServerIssuer: contract.AuthorizationServerIssuer,
				AuthorizationCode: contract.AuthorizationCode,
				PrivateState:      begin.PrivateState, PrivateStateSchema: begin.StateSchema,
			})
			assertFailure(t, err, test.code, sensitive(contract, pair, begin)...)
		})
	}

	t.Run("bounds remote timeout", func(t *testing.T) {
		pair := contract.Factory(t, Timeout)
		begin := begin(t, pair.BeginAdapter, contract)
		ctx, cancel := context.WithTimeout(context.Background(), 75*time.Millisecond)
		defer cancel()
		_, err := pair.CompleteAdapter.Complete(ctx, authentication.ProviderCompleteRequest{
			CallbackURI: contract.CallbackURI, AuthorizationServerIssuer: contract.AuthorizationServerIssuer,
			AuthorizationCode: contract.AuthorizationCode,
			PrivateState:      begin.PrivateState, PrivateStateSchema: begin.StateSchema,
		})
		assertFailure(t, err, authentication.ProviderUnavailable, sensitive(contract, pair, begin)...)
	})
}

func begin(t *testing.T, adapter authentication.FederatedIdentityAdapter, contract Contract) authentication.ProviderBeginResult {
	t.Helper()
	result, err := adapter.Begin(context.Background(), authentication.ProviderBeginRequest{
		CallbackURI: contract.CallbackURI, State: contract.State,
	})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	return result
}

func sensitive(contract Contract, pair Pair, begin authentication.ProviderBeginResult) []string {
	values := []string{contract.State, contract.AuthorizationCode, string(begin.PrivateState)}
	return append(values, pair.SensitiveValues...)
}

func assertFailure(
	t *testing.T,
	err error,
	want authentication.ProviderFailureCode,
	sensitiveValues ...string,
) {
	t.Helper()
	var failure *authentication.ProviderFailure
	if !errors.As(err, &failure) || failure.Code != want {
		t.Fatalf("failure = %T %v, want ProviderFailure(%s)", err, err, want)
	}
	message := err.Error()
	for _, value := range sensitiveValues {
		if value != "" && strings.Contains(message, value) {
			t.Fatalf("failure exposed sensitive value %q", value)
		}
	}
}
