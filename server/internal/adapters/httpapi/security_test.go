package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/authcutover"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/releaseinfo"
)

func TestRouteInventoryIsClosedAndUnique(t *testing.T) {
	handler := testHandler(t)
	routes := handler.RouteInventory()
	if len(routes) < 40 {
		t.Fatalf("route inventory has only %d entries", len(routes))
	}
	seen := make(map[string]RouteClass, len(routes))
	for _, route := range routes {
		key := route.Method + " " + route.Pattern
		if _, duplicate := seen[key]; duplicate {
			t.Fatalf("duplicate route %s", key)
		}
		switch route.Class {
		case PublicProtocol, AnyPrincipal, WebOnly, CLIOnly:
		default:
			t.Fatalf("route %s has no closed access class", key)
		}
		seen[key] = route.Class
	}
	for key, expected := range map[string]RouteClass{
		"GET /healthz":                                      PublicProtocol,
		"GET /readyz":                                       PublicProtocol,
		"GET /api/v1/instance":                              PublicProtocol,
		"GET /api/v1/workspace":                             AnyPrincipal,
		"GET /api/v1/projects/{projectId}/memory":           WebOnly,
		"POST /api/v1/ingestion/canonical/batches":          CLIOnly,
		"POST /api/v1/auth/federated/identity-bindings":     WebOnly,
		"POST /api/v1/auth/cli/device-grants":               PublicProtocol,
		"DELETE /api/v1/auth/cli/credentials/current":       CLIOnly,
		"POST /api/v1/teams/{teamSlug}/projects":            AnyPrincipal,
		"POST /api/v1/teams/{teamSlug}/join-code/rotations": WebOnly,
	} {
		if got := seen[key]; got != expected {
			t.Fatalf("route %s class = %q, want %q", key, got, expected)
		}
	}

	bare := &Handler{mux: http.NewServeMux(), routeKeys: make(map[string]struct{})}
	err := bare.register(route{
		RouteSpec: RouteSpec{Method: http.MethodGet, Pattern: "/unclassified"},
		handler:   func(http.ResponseWriter, *http.Request) {}, body: noRequestBody, cache: noStore,
	})
	if err == nil {
		t.Fatal("unclassified route registration unexpectedly succeeded")
	}
	err = bare.register(route{
		RouteSpec: RouteSpec{Method: http.MethodGet, Pattern: "/body-policy", Class: PublicProtocol},
		handler:   func(http.ResponseWriter, *http.Request) {}, cache: noStore,
	})
	if err == nil {
		t.Fatal("route without a request body policy unexpectedly succeeded")
	}
	for name, candidate := range map[string]route{
		"public action": {
			RouteSpec: RouteSpec{Method: http.MethodGet, Pattern: "/public-action", Class: PublicProtocol},
			handler:   func(http.ResponseWriter, *http.Request) {}, body: noRequestBody, cache: noStore,
			actions: []authorization.Action{authorization.UserReadSelf},
		},
		"unknown action": {
			RouteSpec: RouteSpec{Method: http.MethodGet, Pattern: "/unknown-action", Class: WebOnly},
			handler:   func(http.ResponseWriter, *http.Request) {}, body: noRequestBody, cache: noStore,
			actions: []authorization.Action{authorization.UnknownAction},
		},
		"duplicate action": {
			RouteSpec: RouteSpec{Method: http.MethodGet, Pattern: "/duplicate-action", Class: WebOnly},
			handler:   func(http.ResponseWriter, *http.Request) {}, body: noRequestBody, cache: noStore,
			actions: []authorization.Action{authorization.UserReadSelf, authorization.UserReadSelf},
		},
	} {
		if err := bare.register(candidate); err == nil {
			t.Fatalf("route with %s unexpectedly succeeded", name)
		}
	}
}

func TestBootstrapAllowlistIsClosedBeforeAuthenticationAndParsing(t *testing.T) {
	handler := testHandler(t)
	handler.config.cutoverMode = authcutover.BootstrapMode
	allowed := map[string]struct{}{
		"GET /healthz":         {},
		"GET /readyz":          {},
		"GET /api/v1/instance": {},
		"GET /api/v1/auth/provider-registrations":          {},
		"POST /api/v1/auth/federated/sign-ins":             {},
		"POST /api/v1/auth/federated/identity-bindings":    {},
		"POST /api/v1/auth/federated/reauthentications":    {},
		"GET /api/v1/auth/github/callback":                 {},
		"GET /api/v1/auth/session":                         {},
		"POST /api/v1/auth/logout":                         {},
		"GET /api/v1/users/me":                             {},
		"PATCH /api/v1/users/me":                           {},
		"GET /api/v1/users/me/external-identities":         {},
		"GET /api/v1/users/me/web-sessions":                {},
		"DELETE /api/v1/users/me/web-sessions/{sessionId}": {},
		"POST /api/v1/users/me/web-sessions/revoke-all":    {},
	}
	for _, registered := range handler.routes {
		key := registered.Method + " " + registered.Pattern
		_, expected := allowed[key]
		if registered.bootstrapAllowed != expected {
			t.Fatalf("bootstrap availability for %s = %t, want %t", key, registered.bootstrapAllowed, expected)
		}
		delete(allowed, key)
	}
	if len(allowed) != 0 {
		t.Fatalf("bootstrap allowlist references missing routes: %+v", allowed)
	}

	for _, target := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/v1/workspace", ""},
		{http.MethodPost, "/api/v1/auth/cli/device-grants", "not-json"},
		{http.MethodPost, "/api/v1/ingestion/canonical/batches", "not-json"},
	} {
		request := httptest.NewRequest(target.method, target.path, strings.NewReader(target.body))
		request.Header.Set("Origin", "https://attacker.example")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("bootstrap %s %s status = %d: %s", target.method, target.path, response.Code, response.Body.String())
		}
		assertProblemEnvelope(t, response, "cutover_incomplete")
	}

	account := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	accountResponse := httptest.NewRecorder()
	handler.ServeHTTP(accountResponse, account)
	if accountResponse.Code != http.StatusOK {
		t.Fatalf("bootstrap account status = %d: %s", accountResponse.Code, accountResponse.Body.String())
	}

	preflight := httptest.NewRequest(http.MethodOptions, "/api/v1/teams", nil)
	preflight.Header.Set("Origin", "http://127.0.0.1:8080")
	preflight.Header.Set("Access-Control-Request-Method", http.MethodPost)
	preflight.Header.Set("Access-Control-Request-Headers", "content-type")
	preflightResponse := httptest.NewRecorder()
	handler.ServeHTTP(preflightResponse, preflight)
	if preflightResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("bootstrap preflight status = %d: %s", preflightResponse.Code, preflightResponse.Body.String())
	}
	assertProblemEnvelope(t, preflightResponse, "cutover_incomplete")
}

func TestTopologyDerivesOneCookieShape(t *testing.T) {
	prepared, err := prepareConfig(Config{
		InstanceOrigin: "https://atape.dev", WebOrigin: "https://atape.dev",
		APIOrigin: "https://api.atape.dev", CookieDomain: "atape.dev",
	})
	if err != nil {
		t.Fatalf("prepare official topology: %v", err)
	}
	if prepared.sessionCookie != "__Secure-atape_session" ||
		prepared.loginCookie != "__Host-atape_login" || prepared.cookieDomain != "atape.dev" ||
		!prepared.splitOrigin || !prepared.secureCookies {
		t.Fatalf("unexpected official topology: %+v", prepared)
	}

	for name, config := range map[string]Config{
		"public suffix": {
			InstanceOrigin: "https://web.example.com", WebOrigin: "https://web.example.com",
			APIOrigin: "https://api.example.com", CookieDomain: "com",
		},
		"unrelated domain": {
			InstanceOrigin: "https://web.example.com", WebOrigin: "https://web.example.com",
			APIOrigin: "https://api.other.example", CookieDomain: "example.com",
		},
		"public HTTP": {
			InstanceOrigin: "http://example.com", WebOrigin: "http://example.com",
			APIOrigin: "http://example.com", DevelopmentAllowHTTP: true,
		},
		"pathful origin": {
			InstanceOrigin: "https://example.com/app", WebOrigin: "https://example.com",
			APIOrigin: "https://example.com",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := prepareConfig(config); err == nil {
				t.Fatal("unsafe topology unexpectedly succeeded")
			}
		})
	}
}

func TestPublicProtocolIgnoresAmbientCredentials(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/instance", nil)
	request.AddCookie(&http.Cookie{Name: "atape_session_dev", Value: "first"})
	request.AddCookie(&http.Cookie{Name: "atape_session_dev", Value: "second"})
	request.Header.Set("Authorization", "Bearer attacker-controlled")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"protocol":"atape.instance.v1"`) ||
		!strings.Contains(response.Body.String(), `"release_version":"`+releaseinfo.Version+`"`) ||
		!strings.Contains(response.Body.String(), `"auth_epoch":"`+releaseinfo.AuthEpoch+`"`) ||
		!strings.Contains(response.Body.String(), `"minimum_cli_version":"`+releaseinfo.MinimumCLIVersion+`"`) {
		t.Fatalf("public metadata changed by credentials: %d %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("public metadata cache policy = %q", got)
	}
}

func TestPublicMetadataSupportsWeakAndListedETagRevalidation(t *testing.T) {
	handler := testHandler(t)
	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/v1/instance", nil))
	etag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || etag == "" {
		t.Fatalf("initial metadata response = %d %#v", first.Code, first.Header())
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/instance", nil)
	request.Header.Set("If-None-Match", `"unrelated", W/`+etag)
	revalidated := httptest.NewRecorder()
	handler.ServeHTTP(revalidated, request)
	if revalidated.Code != http.StatusNotModified || revalidated.Body.Len() != 0 ||
		revalidated.Header().Get("ETag") != etag {
		t.Fatalf("metadata revalidation = %d %#v %q",
			revalidated.Code, revalidated.Header(), revalidated.Body.String())
	}
}

func TestPublicTopologyIgnoresHostAndForwardingHeaders(t *testing.T) {
	principal := authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.WebAuthentication}
	handler := testHandlerWithConfig(t, Config{
		InstanceOrigin: "https://atape.dev", WebOrigin: "https://atape.dev",
		APIOrigin: "https://api.atape.dev", CookieDomain: "atape.dev",
		DevelopmentPrincipal: &principal,
	})
	request := httptest.NewRequest(http.MethodGet, "https://attacker.invalid/api/v1/instance", nil)
	request.Host = "attacker.invalid"
	request.Header.Set("Forwarded", "host=attacker.invalid;proto=http")
	request.Header.Set("X-Forwarded-Host", "attacker.invalid")
	request.Header.Set("X-Forwarded-Proto", "http")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"instance_origin":"https://atape.dev"`) ||
		!strings.Contains(response.Body.String(), `"api_origin":"https://api.atape.dev"`) ||
		strings.Contains(response.Body.String(), "attacker.invalid") {
		t.Fatalf("request authority changed discovery: %s", response.Body.String())
	}
}

func TestCallbackFailureRedirectIsFixedAndDataPoor(t *testing.T) {
	handler := testHandler(t)
	secret := "sensitive-provider-code"
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/auth/github/callback?state=state-secret&code="+secret+"&error_description=do-not-reflect", nil)
	request.Host = "attacker.invalid"
	request.Header.Set("Forwarded", "host=attacker.invalid;proto=https")
	request.AddCookie(&http.Cookie{Name: "atape_login_dev", Value: "binding-secret"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusSeeOther {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	location := response.Header().Get("Location")
	if !strings.HasPrefix(location, "http://127.0.0.1:8080/auth/error?code=login_failed&incident=") ||
		strings.Contains(location, secret) || strings.Contains(location, "state-secret") ||
		strings.Contains(location, "attacker.invalid") || strings.Contains(location, "do-not-reflect") {
		t.Fatalf("unsafe callback failure redirect %q", location)
	}
	if response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("callback security headers = %#v", response.Header())
	}
}

func TestCallbackRejectsDuplicateLoginBindingCookies(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/auth/github/callback?state="+strings.Repeat("s", 32)+"&code=provider-code", nil)
	request.AddCookie(&http.Cookie{Name: "atape_login_dev", Value: "first-binding"})
	request.AddCookie(&http.Cookie{Name: "atape_login_dev", Value: "second-binding"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusSeeOther ||
		!strings.HasPrefix(response.Header().Get("Location"), "http://127.0.0.1:8080/auth/error?code=login_failed&incident=") {
		t.Fatalf("duplicate callback Cookie response = %d %q", response.Code, response.Header().Get("Location"))
	}
	if strings.Contains(response.Header().Get("Location"), "provider-code") ||
		strings.Contains(response.Header().Get("Location"), "first-binding") ||
		strings.Contains(response.Header().Get("Location"), "second-binding") {
		t.Fatalf("callback redirect reflected secret input: %q", response.Header().Get("Location"))
	}
}

func TestStrictJSONAndProblemEnvelope(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/ingestion/canonical/batches", strings.NewReader(`{}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("missing Content-Type status = %d: %s", response.Code, response.Body.String())
	}
	assertProblemEnvelope(t, response, "unsupported_media_type")

	duplicateContentType := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device-grants", strings.NewReader(`{}`))
	duplicateContentType.Header.Add("Content-Type", "application/json")
	duplicateContentType.Header.Add("Content-Type", "application/json")
	duplicateContentTypeResponse := httptest.NewRecorder()
	handler.ServeHTTP(duplicateContentTypeResponse, duplicateContentType)
	if duplicateContentTypeResponse.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("duplicate Content-Type status = %d: %s",
			duplicateContentTypeResponse.Code, duplicateContentTypeResponse.Body.String())
	}
	assertProblemEnvelope(t, duplicateContentTypeResponse, "unsupported_media_type")

	unknown := httptest.NewRequest(http.MethodPost, "/api/v1/ingestion/canonical/batches", strings.NewReader(`{"authority":"forged"}`))
	unknown.Header.Set("Content-Type", "application/json")
	unknownResponse := httptest.NewRecorder()
	handler.ServeHTTP(unknownResponse, unknown)
	if unknownResponse.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d: %s", unknownResponse.Code, unknownResponse.Body.String())
	}
	assertProblemEnvelope(t, unknownResponse, "invalid_request")

	tooLarge := httptest.NewRequest(
		http.MethodPost, "/api/v1/auth/cli/device-grants",
		strings.NewReader(`{}`+strings.Repeat(" ", int(authBodyLimit))),
	)
	tooLarge.Header.Set("Content-Type", "application/json")
	tooLargeResponse := httptest.NewRecorder()
	handler.ServeHTTP(tooLargeResponse, tooLarge)
	if tooLargeResponse.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d: %s", tooLargeResponse.Code, tooLargeResponse.Body.String())
	}
	assertProblemEnvelope(t, tooLargeResponse, "request_too_large")

	for _, body := range []string{"null", `[]`, `"value"`} {
		nonObject := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device-grants", strings.NewReader(body))
		nonObject.Header.Set("Content-Type", "application/json")
		nonObjectResponse := httptest.NewRecorder()
		handler.ServeHTTP(nonObjectResponse, nonObject)
		if nonObjectResponse.Code != http.StatusBadRequest {
			t.Fatalf("non-object body %q status = %d: %s", body, nonObjectResponse.Code, nonObjectResponse.Body.String())
		}
		assertProblemEnvelope(t, nonObjectResponse, "invalid_request")
	}
}

func TestBodylessRouteRejectsAnUnexpectedBody(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/healthz", strings.NewReader(`{}`))
	response := httptest.NewRecorder()
	testHandler(t).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("bodyless route status = %d: %s", response.Code, response.Body.String())
	}
	assertProblemEnvelope(t, response, "invalid_request")
}

func TestRetryableProblemsAlwaysCarryABoundedDelay(t *testing.T) {
	for _, code := range []problemCode{problemSlowDown, problemProviderUnavailable, problemServiceUnavailable} {
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		response := httptest.NewRecorder()
		writeProblem(response, request, code, 0, nil)
		if response.Header().Get("Retry-After") == "" {
			t.Fatalf("retryable Problem %q omitted Retry-After", code)
		}
	}
}

func TestUnsafeWebOriginPrecedesCredentialAndBodyParsing(t *testing.T) {
	handler := testHandlerWithConfig(t, Config{
		InstanceOrigin: "https://web.example.com", WebOrigin: "https://web.example.com",
		APIOrigin: "https://api.example.com", CookieDomain: "example.com",
		DevelopmentPrincipal: &authentication.Principal{
			UserID: canonical.DemoUserID, Method: authentication.WebAuthentication,
		},
	})
	for name, origins := range map[string][]string{
		"missing":   nil,
		"null":      {"null"},
		"wrong":     {"https://evil.example.com"},
		"duplicate": {"https://web.example.com", "https://web.example.com"},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", strings.NewReader("not-json"))
			for _, origin := range origins {
				request.Header.Add("Origin", origin)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("Origin rejection status = %d: %s", response.Code, response.Body.String())
			}
			assertProblemEnvelope(t, response, "origin_rejected")
		})
	}
}

func TestSplitOriginPreflightIsExactAndBounded(t *testing.T) {
	principal := authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.WebAuthentication}
	handler := testHandlerWithConfig(t, Config{
		InstanceOrigin: "https://web.example.com", WebOrigin: "https://web.example.com",
		APIOrigin: "https://api.example.com", CookieDomain: "example.com",
		DevelopmentPrincipal: &principal,
	})
	request := httptest.NewRequest(http.MethodOptions, "/api/v1/teams/example/projects", nil)
	request.Header.Set("Origin", "https://web.example.com")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	request.Header.Set("Access-Control-Request-Headers", "X-ATape-CSRF, Content-Type, Idempotency-Key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "https://web.example.com" ||
		response.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("preflight CORS headers = %#v", response.Header())
	}

	wrong := request.Clone(t.Context())
	wrong.Header = request.Header.Clone()
	wrong.Header.Set("Origin", "https://evil.example.com")
	wrongResponse := httptest.NewRecorder()
	handler.ServeHTTP(wrongResponse, wrong)
	if wrongResponse.Code != http.StatusForbidden {
		t.Fatalf("wrong-origin preflight status = %d", wrongResponse.Code)
	}
	assertProblemEnvelope(t, wrongResponse, "origin_rejected")
}

func TestSplitOriginActualResponseAlwaysVariesByOrigin(t *testing.T) {
	principal := authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.WebAuthentication}
	handler := testHandlerWithConfig(t, Config{
		InstanceOrigin: "https://web.example.com", WebOrigin: "https://web.example.com",
		APIOrigin: "https://api.example.com", CookieDomain: "example.com",
		DevelopmentPrincipal: &principal,
	})
	for name, origin := range map[string]string{
		"missing": "",
		"wrong":   "https://evil.example.com",
		"exact":   "https://web.example.com",
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/instance", nil)
			if origin != "" {
				request.Header.Set("Origin", origin)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK || !strings.Contains(response.Header().Get("Vary"), "Origin") {
				t.Fatalf("split-origin metadata response = %d %#v", response.Code, response.Header())
			}
			allowed := response.Header().Get("Access-Control-Allow-Origin")
			if origin == "https://web.example.com" && allowed != origin {
				t.Fatalf("exact Web Origin was not allowed: %#v", response.Header())
			}
			if origin == "https://web.example.com" &&
				response.Header().Get("Access-Control-Expose-Headers") != "ETag, Retry-After, X-Request-ID" {
				t.Fatalf("Web-required response headers were not exposed: %#v", response.Header())
			}
			if origin != "https://web.example.com" && allowed != "" {
				t.Fatalf("untrusted Origin was allowed: %#v", response.Header())
			}
		})
	}
}

func TestSameOriginResponsesDoNotEmitCORSHeaders(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/instance", nil)
	request.Header.Set("Origin", "http://127.0.0.1:8080")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("same-origin request status = %d: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "" ||
		response.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("same-origin response emitted CORS headers: %#v", response.Header())
	}
}

func TestCredentialParsingRejectsDuplicates(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.AddCookie(&http.Cookie{Name: "session", Value: "one"})
	request.AddCookie(&http.Cookie{Name: "session", Value: "two"})
	if _, problem := readCredentials(request, "session"); problem != problemAmbiguousCredentials {
		t.Fatalf("duplicate Cookie problem = %q", problem)
	}

	request = httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Add("Authorization", "Bearer one")
	request.Header.Add("Authorization", "Bearer two")
	if _, problem := readCredentials(request, "session"); problem != problemAmbiguousCredentials {
		t.Fatalf("duplicate Authorization problem = %q", problem)
	}
}

func TestCLIProofOnlyRejectsMixedCredentialMedia(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/cli/credentials/current", nil)
	request.AddCookie(&http.Cookie{Name: handler.config.sessionCookie, Value: "web-secret"})
	request.Header.Set("Authorization", "Bearer cli-secret")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("mixed credential status = %d: %s", response.Code, response.Body.String())
	}
	assertProblemEnvelope(t, response, "ambiguous_credentials")
}

func TestRequiredIdempotencyKeyRejectsMissingOrDuplicateHeaders(t *testing.T) {
	principal := authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.CLIAuthentication}
	handler := testHandlerWithConfig(t, Config{
		InstanceOrigin: "http://127.0.0.1:8080", WebOrigin: "http://127.0.0.1:8080",
		APIOrigin: "http://127.0.0.1:8080", DevelopmentAllowHTTP: true,
		DevelopmentPrincipal: &principal,
	})
	for name, values := range map[string][]string{
		"missing":   nil,
		"empty":     {""},
		"duplicate": {strings.Repeat("A", 22), strings.Repeat("A", 22)},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1/teams/example/projects", strings.NewReader(`{"type":"folder","name":"Example"}`))
			request.Header.Set("Content-Type", "application/json")
			for _, value := range values {
				request.Header.Add("Idempotency-Key", value)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("Idempotency-Key rejection = %d: %s", response.Code, response.Body.String())
			}
			assertProblemEnvelope(t, response, "invalid_request")
		})
	}
}

func TestCookieAttributesAreTopologyDerived(t *testing.T) {
	principal := authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.WebAuthentication}
	handler := testHandlerWithConfig(t, Config{
		InstanceOrigin: "https://atape.dev", WebOrigin: "https://atape.dev",
		APIOrigin: "https://api.atape.dev", CookieDomain: "atape.dev",
		DevelopmentPrincipal: &principal,
	})
	response := httptest.NewRecorder()
	handler.setSessionCookie(response, "ats_v1_secret", time.Now().Add(time.Hour))
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("Set-Cookie count = %d", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != "__Secure-atape_session" || cookie.Domain != "atape.dev" ||
		!cookie.Secure || !cookie.HttpOnly || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("unexpected Session Cookie: %+v", cookie)
	}
}

func TestUnknownRouteUsesDataPoorProblem(t *testing.T) {
	response := httptest.NewRecorder()
	testHandler(t).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/does-not-exist", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
	assertProblemEnvelope(t, response, "not_found")
}

func TestKnownPathWithWrongMethodUsesProblemAndAllow(t *testing.T) {
	response := httptest.NewRecorder()
	testHandler(t).ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/v1/instance", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Allow"); got != "GET, HEAD" {
		t.Fatalf("Allow = %q, want GET, HEAD", got)
	}
	assertProblemEnvelope(t, response, "method_not_allowed")
}

func TestSplitOriginUnmatchedProblemsRemainReadableByTheWebClient(t *testing.T) {
	principal := authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.WebAuthentication}
	handler := testHandlerWithConfig(t, Config{
		InstanceOrigin: "https://web.example.com", WebOrigin: "https://web.example.com",
		APIOrigin: "https://api.example.com", CookieDomain: "example.com",
		DevelopmentPrincipal: &principal,
	})
	request := httptest.NewRequest(http.MethodGet, "/missing", nil)
	request.Header.Set("Origin", "https://web.example.com")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound ||
		response.Header().Get("Access-Control-Allow-Origin") != "https://web.example.com" ||
		response.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("split-origin unmatched response = %d %#v: %s",
			response.Code, response.Header(), response.Body.String())
	}
	assertProblemEnvelope(t, response, "not_found")
}

func TestAPIRejectsNonCanonicalPathsWithoutRedirecting(t *testing.T) {
	for _, target := range []string{
		"/api/v1/../instance",
		"/api//v1/instance",
		"/api/v1/instance/",
		"/api/v1/%2e%2e/instance",
		`/api/v1/instance\\suffix`,
	} {
		t.Run(target, func(t *testing.T) {
			response := httptest.NewRecorder()
			testHandler(t).ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
			if response.Code != http.StatusNotFound {
				t.Fatalf("non-canonical path response = %d with Location %q: %s",
					response.Code, response.Header().Get("Location"), response.Body.String())
			}
			if response.Header().Get("Location") != "" {
				t.Fatalf("non-canonical path redirected to %q", response.Header().Get("Location"))
			}
			assertProblemEnvelope(t, response, "not_found")
		})
	}
}

func assertProblemEnvelope(t *testing.T, response *httptest.ResponseRecorder, code string) {
	t.Helper()
	body := response.Body.String()
	for _, expected := range []string{
		`"type":"https://atape.dev/problems/v1/` + code + `"`,
		`"code":"` + code + `"`, `"requestId":"`, `"instance":"urn:atape:request:`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("Problem does not contain %s: %s", expected, body)
		}
	}
	if response.Header().Get("Content-Type") != "application/problem+json; charset=utf-8" ||
		response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Request-ID") == "" {
		t.Fatalf("Problem headers = %#v", response.Header())
	}
}
