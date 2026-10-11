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
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
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
	if first.Snapshot == "" || first.AnalyticsVersion != sessionanalytics.Version || first.SessionID != "checkout" || first.Tools == nil || first.Threads == nil || first.Usage.Models == nil || first.Evidence.Items == nil || first.Capabilities.MCP == nil || first.Capabilities.Skills == nil {
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

func TestSessionAnalyticsCapabilityHTTPFiltersAndReader(t *testing.T) {
	store := canonical.NewMemoryStoreWithControlPlane(canonicalcontract.MemoryControlPlane())
	batch := canonicalcontract.ValidBatch()
	batch.CanonicalProfileVersion = ingestion.ToolIdentityCanonicalProfileVersion
	batch.Events[1].Kind = "tool_call"
	batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Tool","status":"completed","_meta":{"atape.dev/tool-identity":{"type":"mcp","server":"mail","name":"send"}}}`
	created, err := ingestion.NewIngestor(store).ApplyBatch(t.Context(), canonicalcontract.CLIPrincipal(), batch)
	if err != nil {
		t.Fatal(err)
	}
	principal := canonicalcontract.WebPrincipal()
	h := testHandlerWithConfig(t, Config{InstanceOrigin: "http://127.0.0.1:8080", WebOrigin: "http://127.0.0.1:8080", APIOrigin: "http://127.0.0.1:8080", DevelopmentAllowHTTP: true, DevelopmentPrincipal: &principal})
	h.analytics, h.memory = sessionanalytics.New(store), conversation.NewMemory(store)
	read := func(path string, status int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		return w
	}
	route := "/api/v1/sessions/" + created.SessionID + "/analytics"
	var analysis sessionanalytics.Result
	decodeResponse(t, read(route+"?metric=mcp_tools&capability=send&server=mail", 200), &analysis)
	if analysis.Capabilities.MCPCalls != 1 || len(analysis.Evidence.Items) != 1 {
		t.Fatalf("capability HTTP result: %+v", analysis)
	}
	item := analysis.Evidence.Items[0]
	var page conversation.Conversation
	query := url.Values{"thread": {item.ThreadID}, "limit": {"1"}, "at": {item.EventID}, "snapshot": {analysis.Snapshot}}
	decodeResponse(t, read("/api/v1/sessions/"+created.SessionID+"?"+query.Encode(), 200), &page)
	if len(page.Events) != 2 || page.Events[1].Tool.Meta.Identity.Name != "send" {
		t.Fatalf("legacy conditional capability Reader: %+v", page)
	}
	for _, query := range []string{"capability=", "server=mail&server=mail", "metric=mcp_tools&capability=%ff"} {
		assertProblemEnvelope(t, read(route+"?"+query, 400), "invalid_request")
	}
	for _, query := range []string{"capability=send", "metric=skills&server=mail", "metric=mcp_tools&tool=Tool", "metric=mcp_tools&server=missing", "metric=mcp_tools&capability=" + strings.Repeat("界", 167)} {
		assertProblemEnvelope(t, read(route+"?"+query, 422), "validation_failed")
	}
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
