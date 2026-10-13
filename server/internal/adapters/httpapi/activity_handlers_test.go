package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
)

const activityAccept = "application/vnd.atape.session-analytics.v3+json, application/json"

func activityHTTPFixture(t *testing.T, split bool) (*Handler, string) {
	t.Helper()
	store := canonical.NewMemoryStoreWithControlPlane(canonicalcontract.MemoryControlPlane())
	batch := canonicalcontract.ValidBatch()
	batch.CanonicalProfileVersion = ingestion.UnknownTimeCanonicalProfileVersion
	batch.Events[0].OccurredAt = "2026-10-12T00:00:00.000000001Z"
	batch.Events[1].OccurredAt = "2026-10-12T00:00:00.000000003Z"
	created, err := ingestion.NewIngestor(store).ApplyBatch(t.Context(), canonicalcontract.CLIPrincipal(), batch)
	if err != nil {
		t.Fatal(err)
	}
	principal := canonicalcontract.WebPrincipal()
	config := Config{InstanceOrigin: "https://web.example.com", WebOrigin: "https://web.example.com", APIOrigin: "https://web.example.com", DevelopmentPrincipal: &principal}
	if split {
		config.APIOrigin = "https://api.example.com"
		config.CookieDomain = "example.com"
	}
	h := testHandlerWithConfig(t, config)
	h.analytics = sessionanalytics.New(store)
	h.memory = conversation.NewMemory(store)
	return h, "/api/v1/sessions/" + url.PathEscape(created.SessionID) + "/analytics"
}

func TestActivityAcceptOptsInWithoutChangingDefaultJSON(t *testing.T) {
	h, route := activityHTTPFixture(t, false)
	for _, test := range []struct {
		accept          string
		version, status int
	}{
		{"", 2, 200}, {"application/json", 2, 200}, {activityAccept, 3, 200},
		{"application/vnd.atape.session-analytics.v3+json;q=0, application/json", 2, 200},
		{"application/vnd.atape.session-analytics.v3+json;q=0.001, application/json", 3, 200},
		{"text/html", 2, 200}, {"application/vnd.atape.session-analytics.v4+json", 4, 200},
		{"application/vnd.atape.session-analytics.v4+json, " + activityAccept, 4, 200},
		{"application/vnd.atape.session-analytics.v4+json;q=0, " + activityAccept, 3, 200},
		{"application/vnd.atape.session-analytics.v4+json;q=bad", 0, 400},
		{"application/vnd.atape.session-analytics.v5+json", 5, 200},
		{"application/vnd.atape.session-analytics.v5+json, " + stableToolAccept, 5, 200},
		{"application/vnd.atape.session-analytics.v5+json;q=0, " + stableToolAccept, 4, 200},
		{"application/vnd.atape.session-analytics.v5+json;q=bad", 0, 400},
		{"application/vnd.atape.session-analytics.v6+json", 2, 200},
		{"application/vnd.atape.session-analytics.v3+json;q=broken", 0, 400},
		{"application/vnd.atape.session-analytics.v3+json;q=NaN", 0, 400},
		{"application/vnd.atape.session-analytics.v3+json;q=1.1", 0, 400},
		{"application/vnd.atape.session-analytics.v3+json;q=0.0001", 0, 400},
		{strings.Repeat("x", 4097), 0, 400},
	} {
		t.Run(test.accept, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, route, nil)
			if test.accept != "" {
				req.Header.Set("Accept", test.accept)
			}
			res := httptest.NewRecorder()
			h.ServeHTTP(res, req)
			if res.Code != test.status || res.Header().Get("Cache-Control") != "no-store" || !strings.Contains(strings.Join(res.Header().Values("Vary"), ","), "Accept") {
				t.Fatalf("negotiation: %d %+v %s", res.Code, res.Header(), res.Body.String())
			}
			if test.status != 200 {
				assertProblemEnvelope(t, res, "invalid_request")
				return
			}
			var body sessionanalytics.Result
			decodeResponse(t, res, &body)
			if body.AnalyticsVersion != test.version || (body.Activity != nil) != (test.version >= 3) || res.Header().Get("Content-Type") != "application/json; charset=utf-8" {
				t.Fatalf("wire: %+v", body)
			}
			if test.version == 2 && (strings.Contains(res.Body.String(), "activity") || strings.Contains(res.Body.String(), "clockQuality")) {
				t.Fatal("changed default v2 JSON")
			}
		})
	}
}

func TestActivityHTTPRangesRetainSnapshotAndConditionalReader(t *testing.T) {
	h, route := activityHTTPFixture(t, false)
	read := func(path string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Accept", activityAccept)
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		if res.Code != status {
			t.Fatalf("%s: %d %s", path, res.Code, res.Body.String())
		}
		return res
	}
	var initial sessionanalytics.Result
	decodeResponse(t, read(route+"?metric=records", 200), &initial)
	if len(initial.Activity.Buckets) != 2 || len(initial.Evidence.Items) != 2 || initial.Evidence.Items[1].ClockQuality != "recorded" || *initial.Evidence.Items[1].OccurredAt != "2026-10-12T00:00:00.000000003Z" {
		t.Fatalf("records: %+v", initial)
	}
	query := "?metric=records&snapshot=" + url.QueryEscape(initial.Snapshot) + "&range=" + url.QueryEscape(initial.Activity.Buckets[1].Range)
	var selected sessionanalytics.Result
	decodeResponse(t, read(route+"/evidence"+query, 200), &selected)
	if len(selected.Evidence.Items) != 1 || selected.Evidence.Items[0].EventID != initial.Evidence.Items[1].EventID || *selected.Evidence.Items[0].OccurredAt != selected.Activity.Buckets[1].To {
		t.Fatalf("range: %+v", selected)
	}
	item := selected.Evidence.Items[0]
	reader := strings.TrimSuffix(route, "/analytics") + "?limit=100&thread=" + url.QueryEscape(item.ThreadID) + "&at=" + url.QueryEscape(item.EventID) + "&snapshot=" + url.QueryEscape(initial.Snapshot)
	read(reader, 200)
	for _, path := range []string{route + "?metric=records&range=bad", route + query + "&tool=Tool", route + "?metric=records&snapshot=" + url.QueryEscape(initial.Snapshot) + "&range=bad"} {
		assertProblemEnvelope(t, read(path, 422), "validation_failed")
	}
	assertProblemEnvelope(t, read(route+"?metric=records&snapshot=stale", 409), "refresh_required")
	for _, path := range []string{route + "?range=", route + query + "&range=duplicate"} {
		assertProblemEnvelope(t, read(path, 400), "invalid_request")
	}
	defaultRequest := httptest.NewRequest(http.MethodGet, route+"?metric=records", nil)
	res := httptest.NewRecorder()
	h.ServeHTTP(res, defaultRequest)
	if res.Code != 422 {
		t.Fatalf("records without opt-in: %d", res.Code)
	}
}

func TestActivityAcceptWorksWithSplitOriginWithoutCustomHeaderAllowlisting(t *testing.T) {
	h, route := activityHTTPFixture(t, true)
	preflight := httptest.NewRequest(http.MethodOptions, route, nil)
	preflight.Header.Set("Origin", "https://web.example.com")
	preflight.Header.Set("Access-Control-Request-Method", http.MethodGet)
	// A safelisted Accept value is not in the browser's requested header list.
	res := httptest.NewRecorder()
	h.ServeHTTP(res, preflight)
	if res.Code != 204 || res.Header().Get("Access-Control-Allow-Headers") != "" {
		t.Fatalf("preflight: %d %+v", res.Code, res.Header())
	}
	req := httptest.NewRequest(http.MethodGet, route, nil)
	req.Header.Set("Origin", "https://web.example.com")
	req.Header.Set("Accept", activityAccept)
	res = httptest.NewRecorder()
	h.ServeHTTP(res, req)
	var body sessionanalytics.Result
	decodeResponse(t, res, &body)
	if res.Code != 200 || body.AnalyticsVersion != 3 || res.Header().Get("Access-Control-Allow-Origin") != "https://web.example.com" || res.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("actual CORS: %d %+v", res.Code, res.Header())
	}
	preflight.Header.Set("Access-Control-Request-Headers", "ATape-Accept-Analytics-Version")
	res = httptest.NewRecorder()
	h.ServeHTTP(res, preflight)
	if res.Code != 403 {
		t.Fatalf("unadvertised custom header accepted: %d", res.Code)
	}
}
