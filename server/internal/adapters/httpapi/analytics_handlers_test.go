package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
)

func TestSessionAnalyticsHTTPContractAndConditionalReader(t *testing.T) {
	handler := testHandler(t)
	handler.analytics = sessionanalytics.New(canonical.NewDemoStore())
	read := func(path string, status int) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: status=%d cache=%q body=%s", path, response.Code, response.Header().Get("Cache-Control"), response.Body.String())
		}
		return response
	}
	const route = "/api/v1/sessions/checkout/analytics"
	var first, evidence sessionanalytics.Result
	decodeResponse(t, read(route, 200), &first)
	if first.Snapshot == "" || first.AnalyticsVersion != 1 || first.SessionID != "checkout" || first.Tools == nil || first.Threads == nil || first.Usage.Models == nil || first.Evidence.Items == nil {
		t.Fatalf("incomplete analysis representation: %+v", first)
	}
	decodeResponse(t, read(route+"/evidence?snapshot="+url.QueryEscape(first.Snapshot)+"&metric=thoughts&limit=1", 200), &evidence)
	if !reflect.DeepEqual(first.Summary, evidence.Summary) || !reflect.DeepEqual(first.Usage, evidence.Usage) || first.Snapshot != evidence.Snapshot {
		t.Fatal("evidence filters changed statistics or snapshot")
	}
	reader := read("/api/v1/sessions/checkout?limit=1&snapshot="+url.QueryEscape(first.Snapshot), 200)
	var body map[string]any
	if err := json.Unmarshal(reader.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["snapshot"] != first.Snapshot {
		t.Fatal("conditional reader did not return the selected snapshot")
	}
	for _, path := range []string{route + "?snapshot=stale", "/api/v1/sessions/checkout?limit=1&snapshot=stale"} {
		assertProblemEnvelope(t, read(path, 409), "refresh_required")
	}
	for _, path := range []string{
		route + "?unknown=1", route + "?snapshot=", route + "?metric=tools&metric=thoughts", route + "?limit=broken", route + "/evidence",
		"/api/v1/sessions/checkout?snapshot=token", "/api/v1/sessions/checkout?limit=1&snapshot=", "/api/v1/sessions/checkout?limit=1&snapshot=one&snapshot=two",
		"/api/v1/sessions/checkout?limit=1&snapshot=%ff",
		"/api/v1/sessions/checkout?limit=1&snapshot=" + strings.Repeat("x", 201),
	} {
		assertProblemEnvelope(t, read(path, 400), "invalid_request")
	}
	for _, path := range []string{route + "?limit=101", route + "?limit=0", route + "?limit=-1", route + "?metric=unsupported", route + "?cursor=invalid", route + "?snapshot=" + strings.Repeat("x", 201)} {
		assertProblemEnvelope(t, read(path, 422), "validation_failed")
	}
	assertProblemEnvelope(t, read("/api/v1/sessions/unknown/analytics", 404), "not_found")
}

// This test Adapter exercises the same snapshot Seam used by production. It
// supplies terminal dependency outcomes without replacing HTTP orchestration.
type analyticsFailureStore struct{ err error }

func (s analyticsFailureStore) SessionAnalytics(context.Context, authentication.Principal, string, string) (canonical.AnalyticsSnapshot, bool, error) {
	return canonical.AnalyticsSnapshot{}, false, s.err
}

func TestSessionAnalyticsHTTPFailureClassification(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"capacity", sessionanalytics.ErrCapacity, 422, "analytics_capacity"},
		{"snapshot capacity", canonical.ErrAnalyticsCapacity, 422, "analytics_capacity"},
		{"refresh", &canonical.RefreshRequiredError{}, 409, "refresh_required"},
		{"deadline", context.DeadlineExceeded, 503, "service_unavailable"},
		{"internal", errors.New("private storage detail"), 500, "internal_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := testHandler(t)
			handler.analytics = sessionanalytics.New(analyticsFailureStore{test.err})
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/sessions/checkout/analytics", nil))
			if response.Code != test.status {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
			assertProblemEnvelope(t, response, test.code)
			if strings.Contains(response.Body.String(), "private storage detail") {
				t.Fatal("storage error leaked")
			}
		})
	}
}

func TestSessionAnalyticsConcealsUnauthorizedSession(t *testing.T) {
	principal := authentication.Principal{UserID: "outsider", Method: authentication.WebAuthentication}
	handler := testHandlerWithConfig(t, Config{
		InstanceOrigin: "http://127.0.0.1:8080", WebOrigin: "http://127.0.0.1:8080", APIOrigin: "http://127.0.0.1:8080",
		DevelopmentAllowHTTP: true, DevelopmentPrincipal: &principal,
	})
	handler.analytics = sessionanalytics.New(canonical.NewDemoStore())
	for _, path := range []string{"/api/v1/sessions/checkout/analytics", "/api/v1/sessions/checkout/analytics/evidence?snapshot=stale"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("unauthorized analysis = %d: %s", response.Code, response.Body.String())
		}
		assertProblemEnvelope(t, response, "not_found")
	}
}
