package authentication_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/authentication"
	authgithub "github.com/SingleMai/ATape/server/internal/authentication/github"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestAuthenticationPostgresContract(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1 to run PostgreSQL integration tests")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx,
		"postgres:17-alpine",
		postgrescontainer.WithDatabase("atape_auth_test"),
		postgrescontainer.WithUsername("atape"),
		postgrescontainer.WithPassword("atape"),
		postgrescontainer.BasicWaitStrategies(),
		testcontainers.WithTmpfs(map[string]string{"/var/lib/postgresql/data": "rw"}),
	)
	if err != nil {
		t.Fatalf("start PostgreSQL container: %v", err)
	}
	testcontainers.CleanupContainer(t, container)
	databaseURL, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("PostgreSQL connection string: %v", err)
	}
	trace := &queryTrace{}
	poolA := tracedPool(t, databaseURL, trace)
	if err := postgresadapter.Prepare(ctx, poolA); err != nil {
		t.Fatalf("prepare PostgreSQL: %v", err)
	}
	poolB := tracedPool(t, databaseURL, trace)
	if err := poolB.Ping(ctx); err != nil {
		t.Fatalf("ping second PostgreSQL pool: %v", err)
	}

	t.Run("cutover gate fails closed", func(t *testing.T) {
		resetAuthentication(t, poolA)
		adapter := &contractIdentityAdapter{}
		module := newContractModule(t, poolA, adapter, authentication.DefaultPolicy(),
			keySpec{active: "pepper-1", keys: map[string]byte{"pepper-1": 1}},
			keySpec{active: "private-1", keys: map[string]byte{"private-1": 2}}, true,
		)
		if err := module.Prepare(ctx); authentication.ErrorCodeOf(err) != authentication.CodeMisconfigured {
			t.Fatalf("pending cutover error = %v, want misconfigured", err)
		}
		if _, err := poolA.Exec(ctx, `
UPDATE auth_cutover_ledger
SET status = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE protocol_version = 'auth-v1'`); err != nil {
			t.Fatalf("complete test cutover: %v", err)
		}
		if err := module.Prepare(ctx); err != nil {
			t.Fatalf("prepare after completed cutover: %v", err)
		}
	})

	t.Run("federated identity and Web Session are replica safe", func(t *testing.T) {
		resetAuthentication(t, poolA)
		trace.Reset()
		adapter := &contractIdentityAdapter{}
		moduleA := newContractModule(t, poolA, adapter, authentication.DefaultPolicy(), defaultPepper(), defaultPrivate(), false)
		moduleB := newContractModule(t, poolB, adapter, authentication.DefaultPolicy(), defaultPepper(), defaultPrivate(), false)
		if err := moduleA.Prepare(ctx); err != nil {
			t.Fatalf("prepare module A: %v", err)
		}
		if err := moduleB.Prepare(ctx); err != nil {
			t.Fatalf("prepare module B: %v", err)
		}

		first := beginFederated(t, moduleA, authentication.SignInIntent, "", "/teams/alpha")
		second := beginFederated(t, moduleB, authentication.SignInIntent, "", "/teams/beta")
		var grants [2]authentication.WebSessionGrant
		var failures [2]error
		start := make(chan struct{})
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			grants[0], failures[0] = completeFederated(moduleB, first, "person-a")
		}()
		go func() {
			defer workers.Done()
			<-start
			grants[1], failures[1] = completeFederated(moduleA, second, "person-a")
		}()
		close(start)
		workers.Wait()
		for index, failure := range failures {
			if failure != nil {
				t.Fatalf("concurrent completion %d: %s", index, errorChain(failure))
			}
		}
		if grants[0].User.ID == "" || grants[0].User.ID != grants[1].User.ID {
			t.Fatalf("concurrent first identity created different Users: %q / %q", grants[0].User.ID, grants[1].User.ID)
		}
		if grants[0].Session.ID == grants[1].Session.ID {
			t.Fatalf("independent sign-ins reused Web Session %q", grants[0].Session.ID)
		}
		var userCount, identityCount int
		if err := poolA.QueryRow(ctx, "SELECT COUNT(*) FROM auth_users").Scan(&userCount); err != nil {
			t.Fatalf("count Users: %v", err)
		}
		if err := poolA.QueryRow(ctx, "SELECT COUNT(*) FROM auth_external_identities").Scan(&identityCount); err != nil {
			t.Fatalf("count External Identities: %v", err)
		}
		if userCount != 1 || identityCount != 1 {
			t.Fatalf("concurrent identity counts = users %d, identities %d; want 1/1", userCount, identityCount)
		}

		authenticated, err := moduleA.AuthenticateWeb(ctx, grants[0].SessionSecret)
		if err != nil || authenticated.Principal.UserID != grants[0].User.ID || authenticated.CSRFToken != grants[0].CSRFToken {
			t.Fatalf("authenticate Web Session = %+v, %v", authenticated, err)
		}
		sessions, err := moduleB.ListWebSessions(ctx, authenticated.Principal)
		if err != nil {
			t.Fatalf("list Web Sessions: %v", err)
		}
		if len(sessions) != 2 {
			t.Fatalf("listed Web Sessions = %+v, want two", sessions)
		}
		current := 0
		for _, session := range sessions {
			if session.Current {
				current++
				if session.ID != grants[0].Session.ID {
					t.Fatalf("current Session = %q, want %q", session.ID, grants[0].Session.ID)
				}
			}
		}
		if current != 1 {
			t.Fatalf("current Session markers = %d, want one", current)
		}
		if _, err := completeFederated(moduleA, first, "person-a"); authentication.ErrorCodeOf(err) != authentication.CodeLoginAlreadyConsumed {
			t.Fatalf("callback replay error = %v, want login_already_consumed", err)
		}

		rotation := beginFederated(t, moduleB, authentication.ReauthenticateIntent, grants[0].SessionSecret, "/teams/alpha")
		rotated, err := completeFederated(moduleA, rotation, "person-a")
		if err != nil {
			t.Fatalf("rotate Web Session through reauthentication: %v", err)
		}
		if rotated.Session.ID != grants[0].Session.ID || rotated.SessionSecret == grants[0].SessionSecret {
			t.Fatalf("unexpected rotated Session: %+v", rotated.Session)
		}
		if _, err := moduleA.AuthenticateWeb(ctx, grants[0].SessionSecret); authentication.ErrorCodeOf(err) != authentication.CodeUnauthenticated {
			t.Fatalf("superseded secret error = %v, want unauthenticated", err)
		}
		rotatedAuthentication, err := moduleA.AuthenticateWeb(ctx, rotated.SessionSecret)
		if err != nil {
			t.Fatalf("authenticate rotated secret: %v", err)
		}
		if err := moduleA.RevokeWebSessions(ctx, authentication.RevokeWebSessionsInput{
			Principal: rotatedAuthentication.Principal, SessionID: rotated.Session.ID,
			Reason: "test_revoke", RequestID: "request-revoke",
		}); err != nil {
			t.Fatalf("revoke Web Session: %v", err)
		}
		if _, err := moduleB.AuthenticateWeb(ctx, rotated.SessionSecret); authentication.ErrorCodeOf(err) != authentication.CodeSessionRevoked {
			t.Fatalf("revoked Session error = %v, want session_revoked", err)
		}
		if _, err := moduleB.AuthenticateWeb(ctx, grants[1].SessionSecret); err != nil {
			t.Fatalf("revoking one Session affected another: %v", err)
		}
		remainingAuthentication, err := moduleA.AuthenticateWeb(ctx, grants[1].SessionSecret)
		if err != nil {
			t.Fatalf("authenticate remaining Session: %v", err)
		}
		remaining, err := moduleA.ListWebSessions(ctx, remainingAuthentication.Principal)
		if err != nil || len(remaining) != 1 || remaining[0].ID != grants[1].Session.ID || !remaining[0].Current {
			t.Fatalf("remaining Web Sessions = %+v, %v", remaining, err)
		}

		assertNoRawSecrets(t, poolA, trace, []string{
			first.state, first.challenge.BrowserBinding,
			second.state, second.challenge.BrowserBinding,
			grants[0].SessionSecret, grants[0].CSRFToken,
			grants[1].SessionSecret, grants[1].CSRFToken,
			rotated.SessionSecret, rotated.CSRFToken, providerPrivateStateCanary,
		})
	})

	t.Run("federated callback proofs and terminal failures fail closed", func(t *testing.T) {
		resetAuthentication(t, poolA)
		adapter := &contractIdentityAdapter{}
		module := newContractModule(t, poolA, adapter, authentication.DefaultPolicy(), defaultPepper(), defaultPrivate(), false)
		attempt := beginFederated(t, module, authentication.SignInIntent, "", "/")
		validInput := authentication.CompleteFederatedLoginInput{
			ProviderRegistrationID: "contract", State: attempt.state,
			BrowserBinding:    attempt.challenge.BrowserBinding,
			AuthorizationCode: "proof-identity", RequestID: "request-proof",
		}

		wrongState := validInput
		wrongState.State = contractOpaqueSecret("atf_v1_", 91)
		if _, err := module.CompleteFederatedLogin(ctx, wrongState); authentication.ErrorCodeOf(err) != authentication.CodeLoginStateMismatch {
			t.Fatalf("wrong state error = %v, want login_state_mismatch", err)
		}
		wrongBinding := validInput
		wrongBinding.BrowserBinding = contractOpaqueSecret("atb_v1_", 92)
		if _, err := module.CompleteFederatedLogin(ctx, wrongBinding); authentication.ErrorCodeOf(err) != authentication.CodeLoginStateMismatch {
			t.Fatalf("wrong browser binding error = %v, want login_state_mismatch", err)
		}
		wrongProvider := validInput
		wrongProvider.ProviderRegistrationID = "other-provider"
		if _, err := module.CompleteFederatedLogin(ctx, wrongProvider); authentication.ErrorCodeOf(err) != authentication.CodeLoginStateMismatch {
			t.Fatalf("wrong Provider error = %v, want login_state_mismatch", err)
		}
		if adapter.completeCalls.Load() != 0 {
			t.Fatalf("invalid callback proof reached Provider Adapter %d times", adapter.completeCalls.Load())
		}

		callbackMismatch := newModuleWithRegistration(t, poolB, authentication.ProviderRegistration{
			ID: "contract", Revision: "contract-r1", ExpectedIssuer: "https://identity.example",
			CallbackURI: "https://api.example.test/api/v1/auth/providers/contract/other-callback",
			Active:      true, Adapter: adapter,
		})
		if _, err := callbackMismatch.CompleteFederatedLogin(ctx, validInput); authentication.ErrorCodeOf(err) != authentication.CodeMisconfigured {
			t.Fatalf("callback registration mismatch error = %v, want misconfigured", err)
		}
		revisionMismatch := newModuleWithRegistration(t, poolB, authentication.ProviderRegistration{
			ID: "contract", Revision: "contract-r2", ExpectedIssuer: "https://identity.example",
			CallbackURI: "https://api.example.test/api/v1/auth/providers/contract/callback",
			Active:      true, Adapter: adapter,
		})
		if _, err := revisionMismatch.CompleteFederatedLogin(ctx, validInput); authentication.ErrorCodeOf(err) != authentication.CodeMisconfigured {
			t.Fatalf("registration revision mismatch error = %v, want misconfigured", err)
		}

		denied := validInput
		denied.AuthorizationCode = ""
		denied.AuthorizationError = "access_denied"
		if _, err := module.CompleteFederatedLogin(ctx, denied); authentication.ErrorCodeOf(err) != authentication.CodeProviderAccessDenied {
			t.Fatalf("Provider denial error = %v, want provider_access_denied", err)
		}
		if _, err := module.CompleteFederatedLogin(ctx, denied); authentication.ErrorCodeOf(err) != authentication.CodeLoginAlreadyConsumed {
			t.Fatalf("denied callback replay error = %v, want login_already_consumed", err)
		}

		resetAuthentication(t, poolA)
		wrongIssuerAdapter := &contractIdentityAdapter{issuer: "https://attacker.example"}
		wrongIssuerModule := newContractModule(t, poolA, wrongIssuerAdapter, authentication.DefaultPolicy(), defaultPepper(), defaultPrivate(), false)
		wrongIssuerAttempt := beginFederated(t, wrongIssuerModule, authentication.SignInIntent, "", "/")
		if _, err := completeFederated(wrongIssuerModule, wrongIssuerAttempt, "wrong-issuer"); authentication.ErrorCodeOf(err) != authentication.CodeProviderInvalidResponse {
			t.Fatalf("wrong issuer error = %v, want provider_invalid_response", err)
		}

		resetAuthentication(t, poolA)
		disabledAdapter := &contractIdentityAdapter{}
		disabledModule := newContractModule(t, poolA, disabledAdapter, authentication.DefaultPolicy(), defaultPepper(), defaultPrivate(), false)
		first := beginFederated(t, disabledModule, authentication.SignInIntent, "", "/")
		grant, err := completeFederated(disabledModule, first, "disabled-user")
		if err != nil {
			t.Fatalf("establish User before disable: %v", err)
		}
		if _, err := poolA.Exec(ctx, `
UPDATE auth_users SET status = 'disabled', disabled_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE id = $1`, grant.User.ID); err != nil {
			t.Fatalf("disable test User: %v", err)
		}
		if _, err := disabledModule.AuthenticateWeb(ctx, grant.SessionSecret); authentication.ErrorCodeOf(err) != authentication.CodeUserDisabled {
			t.Fatalf("disabled User Session error = %v, want user_disabled", err)
		}
		signInAgain := beginFederated(t, disabledModule, authentication.SignInIntent, "", "/")
		if _, err := completeFederated(disabledModule, signInAgain, "disabled-user"); authentication.ErrorCodeOf(err) != authentication.CodeUserDisabled {
			t.Fatalf("disabled User sign-in error = %v, want user_disabled", err)
		}

		resetAuthentication(t, poolA)
		crashAdapter := &contractIdentityAdapter{}
		crashModule := newContractModule(t, poolA, crashAdapter, authentication.DefaultPolicy(), defaultPepper(), defaultPrivate(), false)
		crashed := beginFederated(t, crashModule, authentication.SignInIntent, "", "/")
		if _, err := poolA.Exec(ctx, `UPDATE auth_federated_login_transactions SET status = 'completing' WHERE id = $1`, crashed.challenge.LoginTransactionID); err != nil {
			t.Fatalf("simulate post-claim process crash: %v", err)
		}
		if _, err := completeFederated(crashModule, crashed, "must-not-redeem"); authentication.ErrorCodeOf(err) != authentication.CodeLoginAlreadyConsumed {
			t.Fatalf("post-crash callback error = %v, want login_already_consumed", err)
		}
		if crashAdapter.completeCalls.Load() != 0 {
			t.Fatalf("post-crash callback called Provider Adapter %d times", crashAdapter.completeCalls.Load())
		}
	})

	t.Run("GitHub Adapter crosses the Module only as verified identity", func(t *testing.T) {
		resetAuthentication(t, poolA)
		trace.Reset()
		const (
			clientSecret  = "github-client-secret-sql-canary"
			providerToken = "gho_provider-token-sql-canary"
			refreshToken  = "ghr_provider-refresh-sql-canary"
			rawEmail      = "raw-claim-sql-canary@example.test"
			code          = "github-code-sql-canary"
		)
		var tokenCalls atomic.Int32
		var userCalls atomic.Int32
		client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			var body string
			switch request.URL.String() {
			case "https://github.com/login/oauth/access_token":
				tokenCalls.Add(1)
				encoded, err := io.ReadAll(request.Body)
				if err != nil {
					t.Errorf("read GitHub token request: %v", err)
				}
				form, err := url.ParseQuery(string(encoded))
				if err != nil || form.Get("client_secret") != clientSecret || form.Get("code") != code || form.Get("code_verifier") == "" {
					t.Errorf("unexpected GitHub token request")
				}
				body = `{"access_token":"` + providerToken + `","token_type":"bearer","refresh_token":"` + refreshToken + `"}`
			case "https://api.github.com/user":
				userCalls.Add(1)
				if request.Header.Get("Authorization") != "Bearer "+providerToken {
					t.Errorf("GitHub profile request omitted ephemeral token")
				}
				body = `{"id":424242,"login":"singlemai","name":"Single Mai","avatar_url":"https://avatars.githubusercontent.com/u/424242?v=4","email":"` + rawEmail + `"}`
			default:
				t.Errorf("unexpected GitHub request: %s", request.URL.String())
				return &http.Response{
					StatusCode: http.StatusNotFound, Header: make(http.Header),
					Body: io.NopCloser(strings.NewReader("")), Request: request,
				}, nil
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(body)), Request: request,
			}, nil
		})}
		githubAdapter, err := authgithub.New(authgithub.Config{
			ClientID: "Iv1.integration-client", ClientSecret: clientSecret, HTTPClient: client,
		})
		if err != nil {
			t.Fatalf("construct GitHub Adapter: %v", err)
		}
		module := newModule(t, poolA, authentication.Config{
			ProviderRegistrations: []authentication.ProviderRegistration{{
				ID: authgithub.RegistrationID, Revision: authgithub.RegistrationRevision,
				ExpectedIssuer: authgithub.Issuer,
				CallbackURI:    "https://api.example.test/api/v1/auth/providers/github/callback",
				Active:         true, Adapter: githubAdapter,
			}},
			PepperKeys:       buildKeyRing(t, defaultPepper()),
			PrivateStateKeys: buildKeyRing(t, defaultPrivate()),
			Policy:           authentication.DefaultPolicy(),
		})
		challenge, err := module.BeginFederatedLogin(ctx, authentication.BeginFederatedLoginInput{
			Intent: authentication.SignInIntent, ProviderRegistrationID: authgithub.RegistrationID,
			ReturnTo: "/projects", RequestID: "request-github-begin",
		})
		if err != nil {
			t.Fatalf("begin GitHub login: %v", err)
		}
		authorization, err := url.Parse(challenge.AuthorizationURI)
		if err != nil || authorization.Host != "github.com" {
			t.Fatalf("GitHub authorization URI = %q, %v", challenge.AuthorizationURI, err)
		}
		state := authorization.Query().Get("state")
		grant, err := module.CompleteFederatedLogin(ctx, authentication.CompleteFederatedLoginInput{
			ProviderRegistrationID: authgithub.RegistrationID,
			State:                  state, BrowserBinding: challenge.BrowserBinding,
			AuthorizationCode: code, RequestID: "request-github-complete",
		})
		if err != nil {
			t.Fatalf("complete GitHub login: %s", errorChain(err))
		}
		if grant.User.DisplayName != "Single Mai" || grant.ReturnTo != "/projects" {
			t.Fatalf("GitHub login grant = %+v", grant)
		}
		var issuer, subject string
		if err := poolA.QueryRow(ctx, `SELECT issuer, subject FROM auth_external_identities`).Scan(&issuer, &subject); err != nil {
			t.Fatalf("read normalized GitHub identity: %v", err)
		}
		if issuer != authgithub.Issuer || subject != "424242" || tokenCalls.Load() != 1 || userCalls.Load() != 1 {
			t.Fatalf("normalized identity = %q/%q, calls token=%d user=%d", issuer, subject, tokenCalls.Load(), userCalls.Load())
		}
		assertNoRawSecrets(t, poolA, trace, []string{
			clientSecret, providerToken, refreshToken, rawEmail, code, state,
			challenge.BrowserBinding, grant.SessionSecret, grant.CSRFToken,
		})
	})

	t.Run("Provider outage or disable leaves existing Sessions authoritative", func(t *testing.T) {
		resetAuthentication(t, poolA)
		adapter := &contractIdentityAdapter{}
		module := newContractModule(t, poolA, adapter, authentication.DefaultPolicy(), defaultPepper(), defaultPrivate(), false)
		login := beginFederated(t, module, authentication.SignInIntent, "", "/")
		grant, err := completeFederated(module, login, "provider-outage-user")
		if err != nil {
			t.Fatalf("establish Session before Provider outage: %v", err)
		}

		adapter.failure = authentication.ProviderUnavailable
		outage := beginFederated(t, module, authentication.SignInIntent, "", "/")
		if _, err := completeFederated(module, outage, "provider-outage-user"); authentication.ErrorCodeOf(err) != authentication.CodeProviderUnavailable {
			t.Fatalf("Provider outage error = %v, want provider_unavailable", err)
		}
		if _, err := module.AuthenticateWeb(ctx, grant.SessionSecret); err != nil {
			t.Fatalf("Provider outage invalidated existing Session: %v", err)
		}

		disabledModule := newModuleWithRegistration(t, poolB, authentication.ProviderRegistration{
			ID: "contract", Revision: "contract-r1", ExpectedIssuer: "https://identity.example",
			CallbackURI: "https://api.example.test/api/v1/auth/providers/contract/callback",
			Active:      false, Adapter: adapter,
		})
		if _, err := disabledModule.BeginFederatedLogin(ctx, authentication.BeginFederatedLoginInput{
			Intent: authentication.SignInIntent, ProviderRegistrationID: "contract",
			ReturnTo: "/", RequestID: "request-disabled-provider",
		}); authentication.ErrorCodeOf(err) != authentication.CodeMisconfigured {
			t.Fatalf("disabled Provider begin error = %v, want misconfigured", err)
		}
		if _, err := disabledModule.AuthenticateWeb(ctx, grant.SessionSecret); err != nil {
			t.Fatalf("disabled Provider invalidated existing Session: %v", err)
		}
	})

	t.Run("short User Code collisions retry under a cross-replica lock", func(t *testing.T) {
		resetAuthentication(t, poolA)
		module := newContractModule(
			t, poolA, &contractIdentityAdapter{}, authentication.DefaultPolicy(),
			defaultPepper(), defaultPrivate(), false,
		)
		sequence := make([]byte, 0, 32+8+32+8+8)
		sequence = append(sequence, bytes.Repeat([]byte{1}, 32)...)
		sequence = append(sequence, bytes.Repeat([]byte{0}, 8)...)
		sequence = append(sequence, bytes.Repeat([]byte{2}, 32)...)
		sequence = append(sequence, bytes.Repeat([]byte{0}, 8)...)
		sequence = append(sequence, bytes.Repeat([]byte{1}, 8)...)
		authentication.SetRandomSourceForContractTest(module, bytes.NewReader(sequence))
		first, err := module.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create deterministic authorization: %v", err)
		}
		second, err := module.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("retry colliding User Code: %v", err)
		}
		if first.UserCode != "AAAA-AAAA" || second.UserCode != "BBBB-BBBB" {
			t.Fatalf("collision sequence produced %q then %q", first.UserCode, second.UserCode)
		}
	})

	t.Run("identity binding and reauthentication preserve account boundaries", func(t *testing.T) {
		resetAuthentication(t, poolA)
		policy := authentication.DefaultPolicy()
		policy.FreshAuthenticationTTL = 500 * time.Millisecond
		adapter := &contractIdentityAdapter{}
		moduleA := newContractModule(t, poolA, adapter, policy, defaultPepper(), defaultPrivate(), false)
		moduleB := newContractModule(t, poolB, adapter, policy, defaultPepper(), defaultPrivate(), false)

		primaryLogin := beginFederated(t, moduleA, authentication.SignInIntent, "", "/account")
		primary, err := completeFederated(moduleB, primaryLogin, "identity-primary")
		if err != nil {
			t.Fatalf("establish primary identity: %v", err)
		}
		binding := beginFederated(t, moduleA, authentication.BindIdentityIntent, primary.SessionSecret, "/account")
		bound, err := completeFederated(moduleB, binding, "identity-secondary")
		if err != nil {
			t.Fatalf("bind second identity: %v", err)
		}
		if bound.User.ID != primary.User.ID || bound.Session.ID != primary.Session.ID || bound.SessionSecret == primary.SessionSecret {
			t.Fatalf("identity binding changed account/session semantics: primary=%+v bound=%+v", primary, bound)
		}
		if _, err := moduleA.AuthenticateWeb(ctx, primary.SessionSecret); authentication.ErrorCodeOf(err) != authentication.CodeUnauthenticated {
			t.Fatalf("binding did not supersede old Session secret: %v", err)
		}

		secondaryLogin := beginFederated(t, moduleA, authentication.SignInIntent, "", "/")
		secondarySignIn, err := completeFederated(moduleB, secondaryLogin, "identity-secondary")
		if err != nil || secondarySignIn.User.ID != primary.User.ID {
			t.Fatalf("bound identity resolved wrong User: %+v, %v", secondarySignIn.User, err)
		}
		otherLogin := beginFederated(t, moduleA, authentication.SignInIntent, "", "/")
		other, err := completeFederated(moduleB, otherLogin, "identity-other")
		if err != nil {
			t.Fatalf("establish conflicting User: %v", err)
		}
		if other.User.ID == primary.User.ID {
			t.Fatal("different External Identity unexpectedly merged by profile")
		}
		conflictingBinding := beginFederated(t, moduleA, authentication.BindIdentityIntent, bound.SessionSecret, "/account")
		if _, err := completeFederated(moduleB, conflictingBinding, "identity-other"); authentication.ErrorCodeOf(err) != authentication.CodeExternalIdentityConflict {
			t.Fatalf("identity bind conflict error = %v, want external_identity_conflict", err)
		}

		reauthentication := beginFederated(t, moduleA, authentication.ReauthenticateIntent, bound.SessionSecret, "/account")
		refreshed, err := completeFederated(moduleB, reauthentication, "identity-primary")
		if err != nil {
			t.Fatalf("reauthenticate primary identity: %v", err)
		}
		if refreshed.User.ID != primary.User.ID || refreshed.Session.ID != primary.Session.ID || refreshed.SessionSecret == bound.SessionSecret {
			t.Fatalf("unexpected reauthentication result: %+v", refreshed)
		}
		time.Sleep(600 * time.Millisecond)
		if _, err := moduleA.BeginFederatedLogin(ctx, authentication.BeginFederatedLoginInput{
			Intent: authentication.BindIdentityIntent, ProviderRegistrationID: "contract",
			ReturnTo: "/account", CurrentWebSessionSecret: refreshed.SessionSecret,
			RequestID: "request-stale-bind",
		}); authentication.ErrorCodeOf(err) != authentication.CodeFreshAuthenticationRequired {
			t.Fatalf("stale identity binding error = %v, want fresh_authentication_required", err)
		}
		staleReauthentication := beginFederated(t, moduleA, authentication.ReauthenticateIntent, refreshed.SessionSecret, "/account")
		if _, err := completeFederated(moduleB, staleReauthentication, "identity-secondary"); err != nil {
			t.Fatalf("reauthentication should remain available when freshness elapsed: %v", err)
		}
	})

	t.Run("Web Session idle and absolute deadlines fail closed", func(t *testing.T) {
		resetAuthentication(t, poolA)
		adapter := &contractIdentityAdapter{}
		idlePolicy := authentication.DefaultPolicy()
		idlePolicy.WebSessionIdleTTL = 500 * time.Millisecond
		idlePolicy.LastUsedWriteInterval = 100 * time.Millisecond
		idlePolicy.FreshAuthenticationTTL = 100 * time.Millisecond
		idlePolicy.WebSessionAbsoluteTTL = 5 * time.Second
		idleModule := newContractModule(t, poolA, adapter, idlePolicy, defaultPepper(), defaultPrivate(), false)
		idleLogin := beginFederated(t, idleModule, authentication.SignInIntent, "", "/")
		idleSession, err := completeFederated(idleModule, idleLogin, "identity-idle")
		if err != nil {
			t.Fatalf("establish idle-boundary Session: %v", err)
		}
		if _, err := poolA.Exec(ctx, `
UPDATE auth_web_sessions
SET last_used_at = clock_timestamp() - interval '2 seconds'
WHERE id = $1
`, idleSession.Session.ID); err != nil {
			t.Fatalf("move Session beyond idle deadline: %v", err)
		}
		if _, err := idleModule.AuthenticateWeb(ctx, idleSession.SessionSecret); authentication.ErrorCodeOf(err) != authentication.CodeSessionIdleExpired {
			t.Fatalf("idle deadline error = %v, want session_idle_expired", err)
		}

		resetAuthentication(t, poolA)
		absolutePolicy := authentication.DefaultPolicy()
		absolutePolicy.WebSessionIdleTTL = 5 * time.Second
		absolutePolicy.LastUsedWriteInterval = 100 * time.Millisecond
		absolutePolicy.FreshAuthenticationTTL = 100 * time.Millisecond
		absolutePolicy.WebSessionAbsoluteTTL = time.Second
		absoluteModule := newContractModule(t, poolA, adapter, absolutePolicy, defaultPepper(), defaultPrivate(), false)
		absoluteLogin := beginFederated(t, absoluteModule, authentication.SignInIntent, "", "/")
		absoluteSession, err := completeFederated(absoluteModule, absoluteLogin, "identity-absolute")
		if err != nil {
			t.Fatalf("establish absolute-boundary Session: %v", err)
		}
		if _, err := poolA.Exec(ctx, `
UPDATE auth_web_sessions
SET created_at = clock_timestamp() - interval '2 seconds',
    last_used_at = clock_timestamp() - interval '2 seconds',
    reauthenticated_at = clock_timestamp() - interval '2 seconds',
    absolute_expires_at = clock_timestamp() - interval '1 second'
WHERE id = $1
`, absoluteSession.Session.ID); err != nil {
			t.Fatalf("move Session beyond absolute deadline: %v", err)
		}
		if _, err := absoluteModule.AuthenticateWeb(ctx, absoluteSession.SessionSecret); authentication.ErrorCodeOf(err) != authentication.CodeSessionAbsoluteExpired {
			t.Fatalf("absolute deadline error = %v, want session_absolute_expired", err)
		}
	})

	t.Run("CLI approval and claim are exactly once", func(t *testing.T) {
		resetAuthentication(t, poolA)
		trace.Reset()
		policy := authentication.DefaultPolicy()
		policy.MaximumCodeFailures = 3
		adapter := &contractIdentityAdapter{}
		moduleA := newContractModule(t, poolA, adapter, policy, defaultPepper(), defaultPrivate(), false)
		moduleB := newContractModule(t, poolB, adapter, policy, defaultPepper(), defaultPrivate(), false)
		login := beginFederated(t, moduleA, authentication.SignInIntent, "", "/")
		webGrant, err := completeFederated(moduleB, login, "person-cli")
		if err != nil {
			t.Fatalf("establish Web Session: %s", errorChain(err))
		}
		web, err := moduleA.AuthenticateWeb(ctx, webGrant.SessionSecret)
		if err != nil {
			t.Fatalf("authenticate Web principal: %v", err)
		}

		authorization, err := moduleA.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create CLI Device Authorization: %v", err)
		}
		lowercaseCode := strings.ToLower(strings.ReplaceAll(authorization.UserCode, "-", ""))
		view, err := moduleB.ResolveCLIDeviceAuthorization(ctx, web.Principal, lowercaseCode, "request-resolve")
		if err != nil || view.ID != authorization.ID || view.UserCode != authorization.UserCode {
			t.Fatalf("resolve case-insensitive User Code = %+v, %v", view, err)
		}
		if view.ClientLabel != authentication.CLIClientLabel || view.Capability != authentication.CLICapabilityVersion {
			t.Fatalf("grant view capability = %+v", view)
		}
		viewType := reflect.TypeOf(view)
		for _, forbidden := range []string{"DeviceCode", "Credential", "CredentialSecret"} {
			if _, exposed := viewType.FieldByName(forbidden); exposed {
				t.Fatalf("browser grant view exposes %s", forbidden)
			}
		}
		var credentialsBeforeApproval int
		if err := poolA.QueryRow(ctx, "SELECT COUNT(*) FROM auth_cli_credentials WHERE authorization_id = $1", authorization.ID).Scan(&credentialsBeforeApproval); err != nil {
			t.Fatalf("count Credentials before approval: %v", err)
		}
		if credentialsBeforeApproval != 0 {
			t.Fatalf("pending grant created %d Credentials", credentialsBeforeApproval)
		}
		if err := moduleA.DecideCLIDeviceAuthorization(ctx, web.Principal, view.ID, authentication.ApproveCLI, "request-approve"); err != nil {
			t.Fatalf("approve CLI Device Authorization: %v", err)
		}
		if err := moduleB.DecideCLIDeviceAuthorization(ctx, web.Principal, view.ID, authentication.ApproveCLI, "request-approve-replay"); err != nil {
			t.Fatalf("same approval was not idempotent: %v", err)
		}
		if err := poolA.QueryRow(ctx, "SELECT COUNT(*) FROM auth_cli_credentials WHERE authorization_id = $1", authorization.ID).Scan(&credentialsBeforeApproval); err != nil {
			t.Fatalf("count Credentials after approval: %v", err)
		}
		if credentialsBeforeApproval != 0 {
			t.Fatalf("browser approval created %d Credentials", credentialsBeforeApproval)
		}

		var credentials [2]authentication.CLICredentialGrant
		var pollErrors [2]error
		start := make(chan struct{})
		var workers sync.WaitGroup
		workers.Add(2)
		for index, module := range []*authentication.Module{moduleA, moduleB} {
			go func(index int, module *authentication.Module) {
				defer workers.Done()
				<-start
				credentials[index], pollErrors[index] = module.PollCLIDeviceAuthorization(ctx, authorization.DeviceCode, fmt.Sprintf("request-poll-%d", index))
			}(index, module)
		}
		close(start)
		workers.Wait()
		successes := 0
		consumed := 0
		var credential authentication.CLICredentialGrant
		for index, pollErr := range pollErrors {
			if pollErr == nil {
				successes++
				credential = credentials[index]
			} else if authentication.ErrorCodeOf(pollErr) == authentication.CodeGrantConsumed {
				consumed++
			} else {
				t.Fatalf("unexpected concurrent poll error: %v", pollErr)
			}
		}
		if successes != 1 || consumed != 1 || credential.CredentialSecret == "" {
			t.Fatalf("claim outcomes = success %d, consumed %d, credential %+v", successes, consumed, credential)
		}
		cli, err := moduleB.AuthenticateCLI(ctx, credential.CredentialSecret)
		if err != nil || cli.Principal.UserID != web.Principal.UserID {
			t.Fatalf("authenticate CLI Credential = %+v, %v", cli, err)
		}
		listedCredentials, err := moduleA.ListCLICredentials(ctx, web.Principal)
		if err != nil || len(listedCredentials) != 1 || listedCredentials[0].ID != credential.CredentialID ||
			listedCredentials[0].Capability != authentication.CLICapabilityVersion {
			t.Fatalf("listed CLI Credentials = %+v, %v", listedCredentials, err)
		}
		if err := moduleA.RevokeCLICredentials(ctx, authentication.RevokeCLICredentialsInput{
			Principal: cli.Principal, CredentialID: credential.CredentialID,
			Reason: "test_revoke", RequestID: "request-cli-revoke",
		}); err != nil {
			t.Fatalf("revoke CLI Credential: %v", err)
		}
		if _, err := moduleB.AuthenticateCLI(ctx, credential.CredentialSecret); authentication.ErrorCodeOf(err) != authentication.CodeCredentialRevoked {
			t.Fatalf("revoked CLI Credential error = %v, want credential_revoked", err)
		}
		listedCredentials, err = moduleA.ListCLICredentials(ctx, web.Principal)
		if err != nil || len(listedCredentials) != 0 {
			t.Fatalf("revoked CLI Credential remained listed: %+v, %v", listedCredentials, err)
		}

		uncertainAuthorization, err := moduleA.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create commit-uncertain authorization: %v", err)
		}
		uncertainView, err := moduleA.ResolveCLIDeviceAuthorization(ctx, web.Principal, uncertainAuthorization.UserCode, "request-uncertain-resolve")
		if err != nil {
			t.Fatalf("resolve commit-uncertain authorization: %v", err)
		}
		if err := moduleA.DecideCLIDeviceAuthorization(ctx, web.Principal, uncertainView.ID, authentication.ApproveCLI, "request-uncertain-approve"); err != nil {
			t.Fatalf("approve commit-uncertain authorization: %v", err)
		}
		controller := &commitDropController{}
		faultPool := commitDroppingPool(t, databaseURL, trace, controller)
		faultModule := newContractModule(t, faultPool, adapter, policy, defaultPepper(), defaultPrivate(), false)
		if err := faultModule.Prepare(ctx); err != nil {
			t.Fatalf("prepare fault-injected replica: %v", err)
		}
		controller.Arm()
		uncertainCredential, err := faultModule.PollCLIDeviceAuthorization(ctx, uncertainAuthorization.DeviceCode, "request-uncertain-poll")
		if err != nil {
			t.Fatalf("reconcile committed Credential after lost COMMIT response: %s", errorChain(err))
		}
		if !controller.triggered.Load() {
			t.Fatal("commit-response fault was not triggered")
		}
		if uncertainCredential.CredentialSecret == "" {
			t.Fatal("reconciled Credential omitted its one-time secret")
		}
		if _, err := moduleB.PollCLIDeviceAuthorization(ctx, uncertainAuthorization.DeviceCode, "request-uncertain-replay"); authentication.ErrorCodeOf(err) != authentication.CodeGrantConsumed {
			t.Fatalf("commit-uncertain replay error = %v, want grant_consumed", err)
		}
		var uncertainCredentialCount int
		if err := poolA.QueryRow(ctx, "SELECT COUNT(*) FROM auth_cli_credentials WHERE authorization_id = $1", uncertainAuthorization.ID).Scan(&uncertainCredentialCount); err != nil {
			t.Fatalf("count reconciled Credential: %v", err)
		}
		if uncertainCredentialCount != 1 {
			t.Fatalf("commit-uncertain claim created %d Credentials, want 1", uncertainCredentialCount)
		}
		if err := moduleA.RevokeCurrentCLICredential(ctx, uncertainCredential.CredentialSecret, "request-current-revoke"); err != nil {
			t.Fatalf("revoke current CLI Credential: %v", err)
		}
		if err := moduleB.RevokeCurrentCLICredential(ctx, uncertainCredential.CredentialSecret, "request-current-revoke-replay"); err != nil {
			t.Fatalf("repeat current CLI Credential revoke: %v", err)
		}
		if err := moduleB.RevokeCurrentCLICredential(ctx, contractOpaqueSecret("atc_v1_", 93), "request-current-revoke-unknown"); err != nil {
			t.Fatalf("unknown current CLI Credential revoke: %v", err)
		}
		if err := moduleB.RevokeCurrentCLICredential(ctx, "", "request-current-revoke-missing"); err != nil {
			t.Fatalf("missing current CLI Credential revoke: %v", err)
		}
		if _, err := moduleB.AuthenticateCLI(ctx, uncertainCredential.CredentialSecret); authentication.ErrorCodeOf(err) != authentication.CodeCredentialRevoked {
			t.Fatalf("current-revoked Credential error = %v, want credential_revoked", err)
		}

		pending, err := moduleA.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create pending authorization: %v", err)
		}
		_, firstSlowDown := moduleB.PollCLIDeviceAuthorization(ctx, pending.DeviceCode, "request-too-fast-1")
		assertRetryOutcome(t, firstSlowDown, authentication.CodeSlowDown, 10)
		_, secondSlowDown := moduleA.PollCLIDeviceAuthorization(ctx, pending.DeviceCode, "request-too-fast-2")
		assertRetryOutcome(t, secondSlowDown, authentication.CodeSlowDown, 15)
		if _, err := poolA.Exec(ctx, `UPDATE auth_cli_device_authorizations SET next_poll_at = clock_timestamp() - interval '1 second' WHERE id = $1`, pending.ID); err != nil {
			t.Fatalf("advance pending poll clock: %v", err)
		}
		_, pendingOutcome := moduleB.PollCLIDeviceAuthorization(ctx, pending.DeviceCode, "request-pending-on-time")
		assertRetryOutcome(t, pendingOutcome, authentication.CodeAuthorizationPending, 15)
		_, thirdSlowDown := moduleA.PollCLIDeviceAuthorization(ctx, pending.DeviceCode, "request-too-fast-3")
		assertRetryOutcome(t, thirdSlowDown, authentication.CodeSlowDown, 20)

		race, err := moduleA.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create decision race authorization: %v", err)
		}
		raceView, err := moduleA.ResolveCLIDeviceAuthorization(ctx, web.Principal, race.UserCode, "request-race-resolve")
		if err != nil {
			t.Fatalf("resolve decision race: %v", err)
		}
		var decisionErrors [2]error
		start = make(chan struct{})
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			decisionErrors[0] = moduleA.DecideCLIDeviceAuthorization(ctx, web.Principal, raceView.ID, authentication.ApproveCLI, "request-race-approve")
		}()
		go func() {
			defer workers.Done()
			<-start
			decisionErrors[1] = moduleB.DecideCLIDeviceAuthorization(ctx, web.Principal, raceView.ID, authentication.DenyCLI, "request-race-deny")
		}()
		close(start)
		workers.Wait()
		decisionSuccesses := 0
		decisionConflicts := 0
		for _, decisionErr := range decisionErrors {
			if decisionErr == nil {
				decisionSuccesses++
			} else if authentication.ErrorCodeOf(decisionErr) == authentication.CodeGrantAlreadyDecided {
				decisionConflicts++
			} else {
				t.Fatalf("unexpected decision race error: %v", decisionErr)
			}
		}
		if decisionSuccesses != 1 || decisionConflicts != 1 {
			t.Fatalf("decision race outcomes = success %d, conflict %d", decisionSuccesses, decisionConflicts)
		}

		for attempt := 1; attempt <= policy.MaximumCodeFailures; attempt++ {
			_, err := moduleA.ResolveCLIDeviceAuthorization(ctx, web.Principal, "AAAA-AAAA", fmt.Sprintf("request-invalid-%d", attempt))
			want := authentication.CodeInvalidUserCode
			if attempt == policy.MaximumCodeFailures {
				want = authentication.CodeTooManyCodeAttempts
			}
			if authentication.ErrorCodeOf(err) != want {
				t.Fatalf("invalid code attempt %d error = %v, want %s", attempt, err, want)
			}
		}

		assertNoRawSecrets(t, poolA, trace, []string{
			login.state, login.challenge.BrowserBinding,
			webGrant.SessionSecret, webGrant.CSRFToken,
			authorization.DeviceCode, authorization.UserCode,
			credential.CredentialSecret, pending.DeviceCode, pending.UserCode,
			uncertainAuthorization.DeviceCode, uncertainAuthorization.UserCode,
			uncertainCredential.CredentialSecret,
			race.DeviceCode, race.UserCode, providerPrivateStateCanary,
		})
	})

	t.Run("CLI denied expired and inactive-User grants are terminal", func(t *testing.T) {
		resetAuthentication(t, poolA)
		trace.Reset()
		moduleA := newContractModule(t, poolA, &contractIdentityAdapter{}, authentication.DefaultPolicy(), defaultPepper(), defaultPrivate(), false)
		moduleB := newContractModule(t, poolB, &contractIdentityAdapter{}, authentication.DefaultPolicy(), defaultPepper(), defaultPrivate(), false)
		login := beginFederated(t, moduleA, authentication.SignInIntent, "", "/")
		webGrant, err := completeFederated(moduleB, login, "cli-terminal-user")
		if err != nil {
			t.Fatalf("establish CLI terminal-test User: %v", err)
		}
		web, err := moduleA.AuthenticateWeb(ctx, webGrant.SessionSecret)
		if err != nil {
			t.Fatalf("authenticate terminal-test User: %v", err)
		}

		denied, err := moduleA.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create denied authorization: %v", err)
		}
		deniedView, err := moduleB.ResolveCLIDeviceAuthorization(ctx, web.Principal, denied.UserCode, "request-denied-resolve")
		if err != nil {
			t.Fatalf("resolve denied authorization: %v", err)
		}
		if err := moduleA.DecideCLIDeviceAuthorization(ctx, web.Principal, deniedView.ID, authentication.DenyCLI, "request-deny"); err != nil {
			t.Fatalf("deny authorization: %v", err)
		}
		if err := moduleB.DecideCLIDeviceAuthorization(ctx, web.Principal, deniedView.ID, authentication.DenyCLI, "request-deny-replay"); err != nil {
			t.Fatalf("same deny was not idempotent: %v", err)
		}
		if err := moduleB.DecideCLIDeviceAuthorization(ctx, web.Principal, deniedView.ID, authentication.ApproveCLI, "request-deny-reverse"); authentication.ErrorCodeOf(err) != authentication.CodeGrantAlreadyDecided {
			t.Fatalf("reverse denied decision error = %v, want grant_already_decided", err)
		}
		if _, err := moduleB.PollCLIDeviceAuthorization(ctx, denied.DeviceCode, "request-denied-poll"); authentication.ErrorCodeOf(err) != authentication.CodeAccessDenied {
			t.Fatalf("denied poll error = %v, want access_denied", err)
		}

		expired, err := moduleA.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create expiring authorization: %v", err)
		}
		if _, err := poolA.Exec(ctx, `
UPDATE auth_cli_device_authorizations
SET created_at = clock_timestamp() - interval '2 seconds',
    expires_at = clock_timestamp() - interval '1 second'
WHERE id = $1`, expired.ID); err != nil {
			t.Fatalf("expire authorization clock: %v", err)
		}
		if _, err := moduleB.PollCLIDeviceAuthorization(ctx, expired.DeviceCode, "request-expired-poll"); authentication.ErrorCodeOf(err) != authentication.CodeExpiredToken {
			t.Fatalf("expired poll error = %v, want expired_token", err)
		}
		if _, err := moduleA.PollCLIDeviceAuthorization(ctx, expired.DeviceCode, "request-expired-replay"); authentication.ErrorCodeOf(err) != authentication.CodeExpiredToken {
			t.Fatalf("expired poll replay error = %v, want expired_token", err)
		}

		inactive, err := moduleA.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create inactive-User authorization: %v", err)
		}
		inactiveView, err := moduleB.ResolveCLIDeviceAuthorization(ctx, web.Principal, inactive.UserCode, "request-inactive-resolve")
		if err != nil {
			t.Fatalf("resolve inactive-User authorization: %v", err)
		}
		if err := moduleA.DecideCLIDeviceAuthorization(ctx, web.Principal, inactiveView.ID, authentication.ApproveCLI, "request-inactive-approve"); err != nil {
			t.Fatalf("approve inactive-User authorization: %v", err)
		}
		var credentialCount int
		if err := poolA.QueryRow(ctx, "SELECT COUNT(*) FROM auth_cli_credentials WHERE authorization_id = $1", inactive.ID).Scan(&credentialCount); err != nil {
			t.Fatalf("count pre-disable Credentials: %v", err)
		}
		if credentialCount != 0 {
			t.Fatalf("approval generated %d Credentials before poll", credentialCount)
		}
		if _, err := poolA.Exec(ctx, `
UPDATE auth_users SET status = 'disabled', disabled_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE id = $1`, web.Principal.UserID); err != nil {
			t.Fatalf("disable approving User: %v", err)
		}
		if _, err := moduleB.PollCLIDeviceAuthorization(ctx, inactive.DeviceCode, "request-inactive-poll"); authentication.ErrorCodeOf(err) != authentication.CodeAccessDenied {
			t.Fatalf("inactive-User poll error = %v, want access_denied", err)
		}
		if err := poolA.QueryRow(ctx, "SELECT COUNT(*) FROM auth_cli_credentials WHERE authorization_id = $1", inactive.ID).Scan(&credentialCount); err != nil {
			t.Fatalf("count post-disable Credentials: %v", err)
		}
		if credentialCount != 0 {
			t.Fatalf("inactive approving User received %d Credentials", credentialCount)
		}
		var status string
		if err := poolA.QueryRow(ctx, "SELECT status FROM auth_cli_device_authorizations WHERE id = $1", inactive.ID).Scan(&status); err != nil {
			t.Fatalf("read inactive authorization status: %v", err)
		}
		if status != "expired" {
			t.Fatalf("inactive authorization status = %q, want expired", status)
		}
		assertNoRawSecrets(t, poolA, trace, []string{
			webGrant.SessionSecret, webGrant.CSRFToken,
			denied.DeviceCode, denied.UserCode,
			expired.DeviceCode, expired.UserCode,
			inactive.DeviceCode, inactive.UserCode,
		})
	})

	t.Run("rolling key rings preserve live operations and reject missing keys", func(t *testing.T) {
		resetAuthentication(t, poolA)
		adapter := &contractIdentityAdapter{}
		oldPepper := keySpec{active: "pepper-old", keys: map[string]byte{"pepper-old": 11}}
		oldPrivate := keySpec{active: "private-old", keys: map[string]byte{"private-old": 12}}
		rollingPepper := keySpec{active: "pepper-new", keys: map[string]byte{"pepper-old": 11, "pepper-new": 21}}
		rollingPrivate := keySpec{active: "private-new", keys: map[string]byte{"private-old": 12, "private-new": 22}}
		newPepper := keySpec{active: "pepper-new", keys: map[string]byte{"pepper-new": 21}}
		newPrivate := keySpec{active: "private-new", keys: map[string]byte{"private-new": 22}}

		oldModule := newContractModule(t, poolA, adapter, authentication.DefaultPolicy(), oldPepper, oldPrivate, false)
		login := beginFederated(t, oldModule, authentication.SignInIntent, "", "/")
		device, err := oldModule.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create old-key CLI authorization: %v", err)
		}
		newOnly := newContractModule(t, poolB, adapter, authentication.DefaultPolicy(), newPepper, newPrivate, false)
		if err := newOnly.Prepare(ctx); authentication.ErrorCodeOf(err) != authentication.CodeMisconfigured {
			t.Fatalf("missing old keys Prepare error = %v, want misconfigured", err)
		}
		missingRegistration, err := authentication.New(poolB, authentication.Config{
			PepperKeys: buildKeyRing(t, rollingPepper), PrivateStateKeys: buildKeyRing(t, rollingPrivate),
			Policy: authentication.DefaultPolicy(),
		})
		if err != nil {
			t.Fatalf("construct missing-registration Module: %v", err)
		}
		if err := missingRegistration.Prepare(ctx); authentication.ErrorCodeOf(err) != authentication.CodeMisconfigured {
			t.Fatalf("missing live Provider Registration error = %v, want misconfigured", err)
		}

		rolling := newContractModule(t, poolB, adapter, authentication.DefaultPolicy(), rollingPepper, rollingPrivate, false)
		if err := rolling.Prepare(ctx); err != nil {
			t.Fatalf("rolling ring Prepare: %v", err)
		}
		webGrant, err := completeFederated(rolling, login, "person-rolling")
		if err != nil {
			t.Fatalf("complete old PrivateState with rolling ring: %s", errorChain(err))
		}
		web, err := rolling.AuthenticateWeb(ctx, webGrant.SessionSecret)
		if err != nil {
			t.Fatalf("authenticate rolling User: %v", err)
		}
		view, err := rolling.ResolveCLIDeviceAuthorization(ctx, web.Principal, device.UserCode, "request-old-code")
		if err != nil {
			t.Fatalf("resolve old-pepper User Code: %v", err)
		}
		if err := rolling.DecideCLIDeviceAuthorization(ctx, web.Principal, view.ID, authentication.ApproveCLI, "request-old-code-approve"); err != nil {
			t.Fatalf("approve old-pepper authorization: %v", err)
		}
		if _, err := rolling.PollCLIDeviceAuthorization(ctx, device.DeviceCode, "request-old-code-claim"); err != nil {
			t.Fatalf("claim old-pepper authorization: %v", err)
		}
		if err := newOnly.Prepare(ctx); err != nil {
			t.Fatalf("new-only ring rejected after old live references ended: %v", err)
		}

		newLogin := beginFederated(t, rolling, authentication.SignInIntent, "", "/")
		newDevice, err := rolling.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create new-key authorization: %v", err)
		}
		_ = newLogin
		_ = newDevice
		if err := oldModule.Prepare(ctx); authentication.ErrorCodeOf(err) != authentication.CodeMisconfigured {
			t.Fatalf("old-only ring accepted new live references: %v", err)
		}
	})

	t.Run("maintenance is bounded and idempotent", func(t *testing.T) {
		resetAuthentication(t, poolA)
		policy := authentication.DefaultPolicy()
		policy.FederatedLoginTTL = time.Second
		policy.CLIAuthorizationTTL = time.Second
		policy.TerminalRetention = time.Second
		policy.CodeWindowRetention = time.Second
		policy.InitialPollInterval = time.Second
		adapter := &contractIdentityAdapter{}
		module := newContractModule(t, poolA, adapter, policy, defaultPepper(), defaultPrivate(), false)
		_ = beginFederated(t, module, authentication.SignInIntent, "", "/")
		if _, err := module.CreateCLIDeviceAuthorization(ctx); err != nil {
			t.Fatalf("create expiring CLI authorization: %v", err)
		}
		lockTx, err := poolB.Begin(ctx)
		if err != nil {
			t.Fatalf("begin competing maintenance transaction: %v", err)
		}
		if _, err := lockTx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", authentication.MaintenanceLockIDForContractTest()); err != nil {
			_ = lockTx.Rollback(context.Background())
			t.Fatalf("hold maintenance lock: %v", err)
		}
		contended, err := module.Maintain(ctx)
		if err != nil {
			_ = lockTx.Rollback(context.Background())
			t.Fatalf("contended maintenance pass: %v", err)
		}
		if contended.Acquired {
			_ = lockTx.Rollback(context.Background())
			t.Fatal("second replica acquired an already-held maintenance lock")
		}
		if err := lockTx.Rollback(ctx); err != nil {
			t.Fatalf("release maintenance lock: %v", err)
		}
		time.Sleep(1500 * time.Millisecond)
		first, err := module.Maintain(ctx)
		if err != nil {
			t.Fatalf("first maintenance pass: %v", err)
		}
		if !first.Acquired || first.ExpiredFederatedLogins != 1 || first.ExpiredCLIAuthorizations != 1 {
			t.Fatalf("first maintenance result = %+v", first)
		}
		time.Sleep(1500 * time.Millisecond)
		second, err := module.Maintain(ctx)
		if err != nil {
			t.Fatalf("second maintenance pass: %v", err)
		}
		if second.DeletedFederatedLogins != 1 || second.DeletedCLIAuthorizations != 1 {
			t.Fatalf("second maintenance result = %+v", second)
		}
		third, err := module.Maintain(ctx)
		if err != nil {
			t.Fatalf("idempotent maintenance pass: %v", err)
		}
		if third.ExpiredFederatedLogins != 0 || third.ExpiredCLIAuthorizations != 0 ||
			third.DeletedFederatedLogins != 0 || third.DeletedCLIAuthorizations != 0 {
			t.Fatalf("third maintenance repeated work: %+v", third)
		}

		resetAuthentication(t, poolA)
		sessionPolicy := policy
		sessionPolicy.WebSessionIdleTTL = 500 * time.Millisecond
		sessionPolicy.LastUsedWriteInterval = 500 * time.Millisecond
		sessionPolicy.FreshAuthenticationTTL = 100 * time.Millisecond
		sessionPolicy.WebSessionAbsoluteTTL = 10 * time.Second
		sessionModule := newContractModule(t, poolA, adapter, sessionPolicy, defaultPepper(), defaultPrivate(), false)
		expiringLogin := beginFederated(t, sessionModule, authentication.SignInIntent, "", "/")
		expiringSession, err := completeFederated(sessionModule, expiringLogin, "maintenance-expiry-user")
		if err != nil {
			t.Fatalf("establish maintenance-expiry Session: %v", err)
		}
		time.Sleep(1500 * time.Millisecond)
		sessionExpiry, err := sessionModule.Maintain(ctx)
		if err != nil || sessionExpiry.ExpiredWebSessions != 1 {
			t.Fatalf("expire abandoned Web Session = %+v, %v", sessionExpiry, err)
		}
		if _, err := sessionModule.AuthenticateWeb(ctx, expiringSession.SessionSecret); authentication.ErrorCodeOf(err) != authentication.CodeSessionIdleExpired {
			t.Fatalf("maintained idle Session error = %v, want session_idle_expired", err)
		}
		time.Sleep(1500 * time.Millisecond)
		sessionCleanup, err := sessionModule.Maintain(ctx)
		if err != nil || sessionCleanup.DeletedWebSessionSecrets != 1 || sessionCleanup.DeletedWebSessions != 1 {
			t.Fatalf("clean maintained Web Session = %+v, %v", sessionCleanup, err)
		}

		resetAuthentication(t, poolA)
		login := beginFederated(t, module, authentication.SignInIntent, "", "/")
		webGrant, err := completeFederated(module, login, "cleanup-user")
		if err != nil {
			t.Fatalf("establish cleanup User: %v", err)
		}
		web, err := module.AuthenticateWeb(ctx, webGrant.SessionSecret)
		if err != nil {
			t.Fatalf("authenticate cleanup User: %v", err)
		}
		device, err := module.CreateCLIDeviceAuthorization(ctx)
		if err != nil {
			t.Fatalf("create cleanup authorization: %v", err)
		}
		view, err := module.ResolveCLIDeviceAuthorization(ctx, web.Principal, device.UserCode, "request-cleanup-resolve")
		if err != nil {
			t.Fatalf("resolve cleanup authorization: %v", err)
		}
		if err := module.DecideCLIDeviceAuthorization(ctx, web.Principal, view.ID, authentication.ApproveCLI, "request-cleanup-approve"); err != nil {
			t.Fatalf("approve cleanup authorization: %v", err)
		}
		credential, err := module.PollCLIDeviceAuthorization(ctx, device.DeviceCode, "request-cleanup-poll")
		if err != nil {
			t.Fatalf("claim cleanup Credential: %v", err)
		}
		cli, err := module.AuthenticateCLI(ctx, credential.CredentialSecret)
		if err != nil {
			t.Fatalf("authenticate cleanup Credential: %v", err)
		}
		if err := module.RevokeCLICredentials(ctx, authentication.RevokeCLICredentialsInput{
			Principal: cli.Principal, CredentialID: credential.CredentialID,
			Reason: "cleanup_test", RequestID: "request-cleanup-cli-revoke",
		}); err != nil {
			t.Fatalf("revoke cleanup Credential: %v", err)
		}
		if err := module.RevokeWebSessions(ctx, authentication.RevokeWebSessionsInput{
			Principal: web.Principal, SessionID: webGrant.Session.ID,
			Reason: "cleanup_test", RequestID: "request-cleanup-web-revoke",
		}); err != nil {
			t.Fatalf("revoke cleanup Web Session: %v", err)
		}
		time.Sleep(1500 * time.Millisecond)
		terminalCleanup, err := module.Maintain(ctx)
		if err != nil {
			t.Fatalf("terminal credential cleanup: %v", err)
		}
		if terminalCleanup.DeletedFederatedLogins != 1 ||
			terminalCleanup.DeletedCLIAuthorizations != 1 ||
			terminalCleanup.DeletedWebSessionSecrets != 1 ||
			terminalCleanup.DeletedWebSessions != 1 ||
			terminalCleanup.DeletedCLICredentials != 1 {
			t.Fatalf("terminal cleanup result = %+v", terminalCleanup)
		}
		var auditCount int
		if err := poolA.QueryRow(ctx, "SELECT COUNT(*) FROM security_audit_events").Scan(&auditCount); err != nil {
			t.Fatalf("count retained Security Audit Events: %v", err)
		}
		if auditCount == 0 {
			t.Fatal("terminal cleanup removed Security Audit Events")
		}
	})
}

const providerPrivateStateCanary = "provider-private-state-CANARY"

type contractIdentityAdapter struct {
	completeCalls atomic.Int64
	issuer        string
	failure       authentication.ProviderFailureCode
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func (a *contractIdentityAdapter) Begin(
	_ context.Context,
	request authentication.ProviderBeginRequest,
) (authentication.ProviderBeginResult, error) {
	uri := "https://identity.example/authorize?state=" + url.QueryEscape(request.State)
	return authentication.ProviderBeginResult{
		AuthorizationURI: uri, PrivateState: []byte(providerPrivateStateCanary),
		StateSchema: "contract.v1",
	}, nil
}

func (a *contractIdentityAdapter) Complete(
	_ context.Context,
	request authentication.ProviderCompleteRequest,
) (authentication.VerifiedExternalIdentity, error) {
	a.completeCalls.Add(1)
	if a.failure != "" {
		return authentication.VerifiedExternalIdentity{}, &authentication.ProviderFailure{Code: a.failure}
	}
	if request.AuthorizationError == "access_denied" {
		return authentication.VerifiedExternalIdentity{}, &authentication.ProviderFailure{Code: authentication.ProviderAccessDenied}
	}
	if string(request.PrivateState) != providerPrivateStateCanary || request.PrivateStateSchema != "contract.v1" || request.AuthorizationCode == "" {
		return authentication.VerifiedExternalIdentity{}, &authentication.ProviderFailure{Code: authentication.ProviderProtocolViolation}
	}
	issuer := a.issuer
	if issuer == "" {
		issuer = "https://identity.example"
	}
	return authentication.VerifiedExternalIdentity{
		Issuer: issuer, Subject: request.AuthorizationCode,
		DisplayName: "Person " + request.AuthorizationCode,
		AvatarURL:   "https://identity.example/avatar.png",
	}, nil
}

type federatedAttempt struct {
	challenge authentication.FederatedLoginChallenge
	state     string
}

func beginFederated(
	t *testing.T,
	module *authentication.Module,
	intent authentication.LoginIntent,
	currentSecret string,
	returnTo string,
) federatedAttempt {
	t.Helper()
	challenge, err := module.BeginFederatedLogin(context.Background(), authentication.BeginFederatedLoginInput{
		Intent: intent, ProviderRegistrationID: "contract", ReturnTo: returnTo,
		CurrentWebSessionSecret: currentSecret, RequestID: "request-begin",
	})
	if err != nil {
		t.Fatalf("begin federated login: %v", err)
	}
	parsed, err := url.Parse(challenge.AuthorizationURI)
	if err != nil {
		t.Fatalf("parse authorization URI: %v", err)
	}
	state := parsed.Query().Get("state")
	if state == "" {
		t.Fatal("authorization URI has no state")
	}
	return federatedAttempt{challenge: challenge, state: state}
}

func completeFederated(
	module *authentication.Module,
	attempt federatedAttempt,
	code string,
) (authentication.WebSessionGrant, error) {
	return module.CompleteFederatedLogin(context.Background(), authentication.CompleteFederatedLoginInput{
		ProviderRegistrationID: "contract", State: attempt.state,
		BrowserBinding:    attempt.challenge.BrowserBinding,
		AuthorizationCode: code, RequestID: "request-complete",
	})
}

type keySpec struct {
	active string
	keys   map[string]byte
}

func defaultPepper() keySpec {
	return keySpec{active: "pepper-1", keys: map[string]byte{"pepper-1": 41}}
}

func defaultPrivate() keySpec {
	return keySpec{active: "private-1", keys: map[string]byte{"private-1": 51}}
}

func newContractModule(
	t *testing.T,
	pool *pgxpool.Pool,
	adapter authentication.FederatedIdentityAdapter,
	policy authentication.Policy,
	pepper keySpec,
	private keySpec,
	requireCutover bool,
) *authentication.Module {
	t.Helper()
	return newModule(t, pool, authentication.Config{
		ProviderRegistrations: []authentication.ProviderRegistration{{
			ID: "contract", Revision: "contract-r1", ExpectedIssuer: "https://identity.example",
			CallbackURI: "https://api.example.test/api/v1/auth/providers/contract/callback",
			Active:      true, Adapter: adapter,
		}},
		PepperKeys: buildKeyRing(t, pepper), PrivateStateKeys: buildKeyRing(t, private),
		Policy: policy, RequireCompletedCutover: requireCutover,
	})
}

func newModuleWithRegistration(
	t *testing.T,
	pool *pgxpool.Pool,
	registration authentication.ProviderRegistration,
) *authentication.Module {
	t.Helper()
	return newModule(t, pool, authentication.Config{
		ProviderRegistrations: []authentication.ProviderRegistration{registration},
		PepperKeys:            buildKeyRing(t, defaultPepper()),
		PrivateStateKeys:      buildKeyRing(t, defaultPrivate()),
		Policy:                authentication.DefaultPolicy(),
	})
}

func newModule(t *testing.T, pool *pgxpool.Pool, config authentication.Config) *authentication.Module {
	t.Helper()
	module, err := authentication.New(pool, config)
	if err != nil {
		t.Fatalf("construct Authentication Module: %v", err)
	}
	return module
}

func contractOpaqueSecret(prefix string, fill byte) string {
	return prefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{fill}, 32))
}

func assertRetryOutcome(t *testing.T, err error, code authentication.ErrorCode, retryAfter int) {
	t.Helper()
	var outcome *authentication.Error
	if !errors.As(err, &outcome) || outcome.Code != code || outcome.RetryAfter != retryAfter {
		t.Fatalf("retry outcome = %#v (%v), want %s after %d seconds", outcome, err, code, retryAfter)
	}
}

func buildKeyRing(t *testing.T, spec keySpec) authentication.KeyRing {
	t.Helper()
	entries := make([]authentication.KeyMaterial, 0, len(spec.keys))
	for id, value := range spec.keys {
		entries = append(entries, authentication.KeyMaterial{ID: id, Material: bytes.Repeat([]byte{value}, 32)})
	}
	ring, err := authentication.NewKeyRing(spec.active, entries)
	if err != nil {
		t.Fatalf("construct key ring: %v", err)
	}
	return ring
}

func resetAuthentication(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
TRUNCATE security_audit_events,
         team_operation_receipts, team_join_code_attempt_windows,
         team_join_codes, team_memberships,
         auth_user_code_attempt_windows,
         auth_cli_credentials, auth_cli_device_authorizations,
         auth_federated_login_transactions, auth_web_session_secrets,
         auth_web_sessions, auth_external_identities, auth_users CASCADE;
UPDATE auth_cutover_ledger
SET status = 'pending', completed_at = NULL, updated_at = clock_timestamp()
WHERE protocol_version = 'auth-v1'`); err != nil {
		t.Fatalf("reset Authentication state: %v", err)
	}
}

func assertNoRawSecrets(
	t *testing.T,
	pool *pgxpool.Pool,
	trace *queryTrace,
	secrets []string,
) {
	t.Helper()
	tables := []string{
		"auth_users", "auth_external_identities", "auth_federated_login_transactions",
		"auth_web_sessions", "auth_web_session_secrets", "auth_cli_device_authorizations",
		"auth_cli_credentials", "auth_user_code_attempt_windows", "security_audit_events",
	}
	var persisted strings.Builder
	for _, table := range tables {
		var content string
		query := "SELECT COALESCE(string_agg(row_to_json(t)::text, ''), '') FROM " + table + " t"
		if err := pool.QueryRow(context.Background(), query).Scan(&content); err != nil {
			t.Fatalf("scan %s for canaries: %v", table, err)
		}
		persisted.WriteString(content)
	}
	traced := trace.String()
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if strings.Contains(persisted.String(), secret) {
			t.Fatalf("raw secret was persisted: %q", secret)
		}
		if strings.Contains(traced, secret) {
			t.Fatalf("raw secret entered a PostgreSQL query or argument: %q", secret)
		}
	}
}

type queryTrace struct {
	mu      sync.Mutex
	entries strings.Builder
}

func (t *queryTrace) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	t.mu.Lock()
	fmt.Fprintf(&t.entries, "%s %#v\n", data.SQL, data.Args)
	t.mu.Unlock()
	return ctx
}

func (*queryTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (t *queryTrace) Reset() {
	t.mu.Lock()
	t.entries.Reset()
	t.mu.Unlock()
}

func (t *queryTrace) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.entries.String()
}

func tracedPool(t *testing.T, databaseURL string, trace pgx.QueryTracer) *pgxpool.Pool {
	t.Helper()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse PostgreSQL configuration: %v", err)
	}
	config.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatalf("create PostgreSQL pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type commitDropController struct {
	armed     atomic.Bool
	triggered atomic.Bool
}

func (c *commitDropController) Arm() {
	c.armed.Store(true)
}

type commitDropConn struct {
	net.Conn
	controller *commitDropController
	dropReply  bool
	failed     bool
}

func (c *commitDropConn) Write(payload []byte) (int, error) {
	written, err := c.Conn.Write(payload)
	if err == nil && written == len(payload) && containsCommit(payload) && c.controller.armed.CompareAndSwap(true, false) {
		c.controller.triggered.Store(true)
		c.dropReply = true
	}
	return written, err
}

func (c *commitDropConn) Read(target []byte) (int, error) {
	if c.failed {
		return 0, io.ErrUnexpectedEOF
	}
	if !c.dropReply {
		return c.Conn.Read(target)
	}
	buffer := make([]byte, 4096)
	accumulated := make([]byte, 0, 4096)
	for {
		count, err := c.Conn.Read(buffer)
		if count > 0 {
			accumulated = append(accumulated, buffer[:count]...)
			if containsReadyForQuery(accumulated) {
				c.failed = true
				return 0, io.ErrUnexpectedEOF
			}
		}
		if err != nil {
			c.failed = true
			return 0, err
		}
	}
}

func containsCommit(payload []byte) bool {
	return bytes.Contains(bytes.ToLower(payload), []byte("commit"))
}

func containsReadyForQuery(payload []byte) bool {
	for len(payload) >= 5 {
		length := int(binary.BigEndian.Uint32(payload[1:5]))
		if length < 4 {
			return false
		}
		frameLength := 1 + length
		if len(payload) < frameLength {
			return false
		}
		if payload[0] == 'Z' && length == 5 {
			return true
		}
		payload = payload[frameLength:]
	}
	return false
}

func commitDroppingPool(
	t *testing.T,
	databaseURL string,
	trace pgx.QueryTracer,
	controller *commitDropController,
) *pgxpool.Pool {
	t.Helper()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse fault-injected PostgreSQL configuration: %v", err)
	}
	config.ConnConfig.Tracer = trace
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		connection, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &commitDropConn{Conn: connection, controller: controller}, nil
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatalf("create fault-injected PostgreSQL pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func configureDockerHost(t *testing.T) {
	t.Helper()
	if os.Getenv("DOCKER_HOST") != "" {
		return
	}
	output, err := exec.Command("docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}").Output()
	if err != nil {
		return
	}
	host := strings.TrimSpace(string(output))
	if host != "" {
		t.Setenv("DOCKER_HOST", host)
	}
}

func errorChain(err error) string {
	parts := make([]string, 0, 4)
	for current := err; current != nil; current = errors.Unwrap(current) {
		parts = append(parts, fmt.Sprintf("%T: %v", current, current))
	}
	return strings.Join(parts, " <- ")
}
