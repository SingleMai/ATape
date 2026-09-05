package github

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/testsupport/federatedidentitycontract"
)

const (
	testClientID     = "Iv1.atape-contract-client"
	testClientSecret = "github-client-secret-contract-canary"
	testToken        = "gho_provider-token-contract-canary"
)

var expectedIdentity = authentication.VerifiedExternalIdentity{
	Issuer: Issuer, Subject: "583231", DisplayName: "Mona Lisa",
	AvatarURL: "https://avatars.githubusercontent.com/u/583231?v=4",
}

func TestAdapterConformance(t *testing.T) {
	federatedidentitycontract.Run(t, federatedidentitycontract.Contract{
		Factory:           contractPair,
		ExpectedIdentity:  expectedIdentity,
		CallbackURI:       "https://api.example.test/api/v1/auth/providers/github/callback",
		State:             "atf_contract_state_0123456789abcdefghijklmnop",
		AuthorizationCode: "github-authorization-code-contract-canary",
	})
}

func contractPair(t *testing.T, scenario federatedidentitycontract.Scenario) federatedidentitycontract.Pair {
	t.Helper()
	provider := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/token":
			switch scenario {
			case federatedidentitycontract.Timeout:
				select {
				case <-request.Context().Done():
				case <-time.After(250 * time.Millisecond):
				}
				return
			case federatedidentitycontract.Unavailable:
				response.WriteHeader(http.StatusServiceUnavailable)
				_, _ = response.Write([]byte(`{"error":"temporarily_unavailable"}`))
				return
			case federatedidentitycontract.MalformedResponse:
				_, _ = response.Write([]byte(`{"access_token":`))
				return
			default:
				_ = json.NewEncoder(response).Encode(map[string]string{
					"access_token": testToken, "token_type": "bearer", "scope": "",
				})
			}
		case "/user":
			if scenario == federatedidentitycontract.OversizedResponse {
				_, _ = response.Write([]byte(`{"padding":"` + strings.Repeat("x", maximumUserResponseBytes) + `"}`))
				return
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"id": 583231, "login": "octocat", "name": "Mona Lisa",
				"avatar_url": "https://avatars.githubusercontent.com/u/583231?v=4",
				"email":      "must-not-cross-the-provider-seam@example.test",
			})
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(provider.Close)
	endpoints := endpointSet{
		authorization: "https://github.example.test/login/oauth/authorize",
		token:         provider.URL + "/token", user: provider.URL + "/user",
	}
	newForTest := func(seed byte) *adapter {
		value, err := newAdapter(Config{
			ClientID: testClientID, ClientSecret: testClientSecret,
		}, endpoints, bytes.NewReader(bytes.Repeat([]byte{seed}, 64)), true)
		if err != nil {
			t.Fatalf("construct GitHub Adapter: %v", err)
		}
		return value
	}
	return federatedidentitycontract.Pair{
		BeginAdapter: newForTest(1), CompleteAdapter: newForTest(2),
		SensitiveValues: []string{testClientSecret, testToken},
	}
}

func TestAuthorizationCodeProtocol(t *testing.T) {
	var tokenCalls atomic.Int32
	var userCalls atomic.Int32
	callbackURI := "https://api.atape.test/api/v1/auth/providers/github/callback"
	state := "atf_v1_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"
	code := "github-code-protocol-canary"
	provider := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json; charset=utf-8")
		switch request.URL.Path {
		case "/token":
			tokenCalls.Add(1)
			if request.Method != http.MethodPost || request.URL.RawQuery != "" {
				t.Errorf("token request = %s %s, want POST without query", request.Method, request.URL.String())
			}
			if request.Header.Get("Accept") != "application/json" ||
				request.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
				t.Errorf("unexpected token headers: %+v", request.Header)
			}
			if err := request.ParseForm(); err != nil {
				t.Errorf("parse token form: %v", err)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			for key, want := range map[string]string{
				"client_id": testClientID, "client_secret": testClientSecret,
				"code": code, "redirect_uri": callbackURI,
			} {
				if got := request.PostForm.Get(key); got != want {
					t.Errorf("token form %s = %q, want %q", key, got, want)
				}
			}
			if !validVerifier([]byte(request.PostForm.Get("code_verifier"))) {
				t.Errorf("token form has invalid PKCE verifier")
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"access_token": testToken, "token_type": "Bearer", "scope": "",
				"expires_in": 28800, "refresh_token": "ignored-provider-refresh-token",
			})
		case "/user":
			userCalls.Add(1)
			if request.Method != http.MethodGet || request.URL.RawQuery != "" {
				t.Errorf("user request = %s %s, want GET without query", request.Method, request.URL.String())
			}
			if got := request.Header.Get("Authorization"); got != "Bearer "+testToken {
				t.Errorf("Authorization = %q", got)
			}
			if request.Header.Get("X-GitHub-Api-Version") != "2022-11-28" ||
				request.Header.Get("Accept") != "application/vnd.github+json" {
				t.Errorf("unexpected GitHub API headers: %+v", request.Header)
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"id": 583231, "login": "octocat", "name": "Mona Lisa",
				"avatar_url": expectedIdentity.AvatarURL,
			})
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(provider.Close)
	endpoints := endpointSet{
		authorization: "https://github.example.test/login/oauth/authorize",
		token:         provider.URL + "/token", user: provider.URL + "/user",
	}
	randomMaterial := bytes.Repeat([]byte{0x7b}, 32)
	adapter, err := newAdapter(Config{
		ClientID: testClientID, ClientSecret: testClientSecret,
	}, endpoints, bytes.NewReader(randomMaterial), true)
	if err != nil {
		t.Fatalf("construct Adapter: %v", err)
	}

	begin, err := adapter.Begin(context.Background(), authentication.ProviderBeginRequest{
		CallbackURI: callbackURI, State: state,
	})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	authorization, err := url.Parse(begin.AuthorizationURI)
	if err != nil {
		t.Fatalf("parse authorization URI: %v", err)
	}
	query := authorization.Query()
	for key, want := range map[string]string{
		"client_id": testClientID, "redirect_uri": callbackURI, "state": state,
		"code_challenge_method": "S256",
	} {
		if got := query.Get(key); got != want {
			t.Fatalf("authorization parameter %s = %q, want %q", key, got, want)
		}
	}
	verifier := base64.RawURLEncoding.EncodeToString(randomMaterial)
	challenge := sha256.Sum256([]byte(verifier))
	if got, want := query.Get("code_challenge"), base64.RawURLEncoding.EncodeToString(challenge[:]); got != want {
		t.Fatalf("PKCE challenge = %q, want %q", got, want)
	}
	if query.Has("scope") {
		t.Fatalf("identity-only authorization unexpectedly requested scope %q", query.Get("scope"))
	}
	if string(begin.PrivateState) != verifier || strings.Contains(begin.AuthorizationURI, verifier) {
		t.Fatal("PKCE verifier did not remain opaque PrivateState")
	}

	identity, err := adapter.Complete(context.Background(), authentication.ProviderCompleteRequest{
		CallbackURI: callbackURI, AuthorizationCode: code,
		PrivateState: begin.PrivateState, PrivateStateSchema: begin.StateSchema,
	})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if identity != expectedIdentity {
		t.Fatalf("identity = %+v, want %+v", identity, expectedIdentity)
	}
	if tokenCalls.Load() != 1 || userCalls.Load() != 1 {
		t.Fatalf("remote calls = token %d, user %d; want 1/1", tokenCalls.Load(), userCalls.Load())
	}
	for _, rendered := range []string{fmt.Sprintf("%v", adapter), fmt.Sprintf("%#v", adapter), fmt.Sprintf("%+v", Config{
		ClientID: testClientID, ClientSecret: testClientSecret,
	})} {
		if strings.Contains(rendered, testClientSecret) || strings.Contains(rendered, testToken) {
			t.Fatalf("diagnostic rendering exposed credential: %s", rendered)
		}
	}
}

func TestAdapterRefusesCredentialBearingRedirect(t *testing.T) {
	var redirected atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/token" {
			response.Header().Set("Location", "/leak")
			response.WriteHeader(http.StatusTemporaryRedirect)
			return
		}
		redirected.Store(true)
		response.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(provider.Close)
	value, err := newAdapter(Config{
		ClientID: testClientID, ClientSecret: testClientSecret,
	}, endpointSet{
		authorization: "https://github.example.test/authorize",
		token:         provider.URL + "/token", user: provider.URL + "/user",
	}, bytes.NewReader(bytes.Repeat([]byte{1}, 32)), true)
	if err != nil {
		t.Fatalf("construct Adapter: %v", err)
	}
	begin, err := value.Begin(context.Background(), authentication.ProviderBeginRequest{
		CallbackURI: "https://api.example.test/callback",
		State:       "redirect-state-contract-canary-0123456789",
	})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	_, err = value.Complete(context.Background(), authentication.ProviderCompleteRequest{
		CallbackURI: "https://api.example.test/callback", AuthorizationCode: "redirect-code",
		PrivateState: begin.PrivateState, PrivateStateSchema: begin.StateSchema,
	})
	var failure *authentication.ProviderFailure
	if !errors.As(err, &failure) || failure.Code != authentication.ProviderInvalidResponse {
		t.Fatalf("redirect failure = %v, want invalid response", err)
	}
	if redirected.Load() {
		t.Fatal("Adapter followed a credential-bearing redirect")
	}
}

func TestNewRejectsInvalidCredentials(t *testing.T) {
	for _, config := range []Config{
		{},
		{ClientID: "client", ClientSecret: ""},
		{ClientID: " client", ClientSecret: "secret"},
		{ClientID: "client", ClientSecret: "secret\n"},
	} {
		if _, err := New(config); err == nil {
			t.Fatalf("New(%v) unexpectedly succeeded", config)
		}
	}
}
