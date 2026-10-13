package httpapi

import (
	"encoding/json"
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

const tokenActivityAccept = "application/vnd.atape.session-analytics.v4+json;v=5, " + activityAccept

func TestTokenAcceptWorksWithExistingSplitOriginCORS(t *testing.T) {
	if len(tokenActivityAccept) > 128 {
		t.Fatal("Token negotiation would trigger a browser CORS preflight")
	}
	h, route := activityHTTPFixture(t, true)
	r := httptest.NewRequest(http.MethodGet, route, nil)
	r.Header.Set("Origin", "https://web.example.com")
	r.Header.Set("Accept", tokenActivityAccept)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var result sessionanalytics.Result
	decodeResponse(t, w, &result)
	if w.Code != 200 || result.AnalyticsVersion != 5 || w.Header().Get("Access-Control-Allow-Origin") != "https://web.example.com" || w.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("Token split-origin request: %d %+v", w.Code, w.Header())
	}
}

func TestTokenActivityHTTPIntervalsCoverageAndConditionalReader(t *testing.T) {
	store := canonical.NewMemoryStoreWithControlPlane(canonicalcontract.MemoryControlPlane())
	batch := canonicalcontract.ValidBatch()
	batch.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
	first, second, last := batch.Events[0], batch.Events[1], batch.Events[1]
	first.OccurredAt, second.OccurredAt = "2026-10-13T00:00:00Z", "2026-10-13T00:00:00Z"
	last.SourceEventID, last.SourceOrder, last.OccurredAt = "last", 3, "2026-10-13T00:01:00Z"
	unknown := last
	unknown.SourceEventID, unknown.SourceOrder, unknown.OccurredAt, unknown.OccurredAtUnknown = "unknown-clock", 4, "", true
	batch.Events = []ingestion.Event{first, second, last, unknown}
	batch.Session.ReportedEventCount = len(batch.Events)
	counter := func(n int64) *int64 { return &n }
	usage := func(id, model, at string, input, output, read, write *int64) ingestion.Usage {
		return ingestion.Usage{SourceUsageID: id, SourceThreadID: "provider-root", Revision: 1, Model: model, OccurredAt: at,
			InputTokens: input, OutputTokens: output, CacheReadTokens: read, CacheWriteTokens: write}
	}
	batch.Usage = []ingestion.Usage{
		usage("one", "alpha", first.OccurredAt, counter(100), counter(20), counter(60), counter(10)),
		usage("partial", "alpha", first.OccurredAt, counter(50), nil, counter(10), counter(0)),
		usage("three", "alpha", last.OccurredAt, counter(200), counter(40), nil, counter(0)),
		usage("outside-events", "beta", "2026-10-13T00:02:00Z", counter(300), counter(50), counter(0), counter(0)),
		usage("unknown-model", "", first.OccurredAt, counter(10), counter(5), counter(0), counter(0)),
	}
	writer := ingestion.NewIngestor(store)
	created, err := writer.ApplyBatch(t.Context(), canonicalcontract.CLIPrincipal(), batch)
	if err != nil {
		t.Fatal(err)
	}
	principal := canonicalcontract.WebPrincipal()
	h := testHandlerWithConfig(t, Config{InstanceOrigin: "https://web.example.com", WebOrigin: "https://web.example.com", APIOrigin: "https://web.example.com", DevelopmentPrincipal: &principal})
	h.analytics, h.memory = sessionanalytics.New(store), conversation.NewMemory(store)
	read := func(path, accept string, status int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Accept", accept)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		return w
	}
	route := "/api/v1/sessions/" + created.SessionID + "/analytics"
	var initial sessionanalytics.Result
	w := read(route, tokenActivityAccept, 200)
	decodeResponse(t, w, &initial)
	a := initial.TokenActivity
	if initial.AnalyticsVersion != 5 || a == nil || a.Samples != 5 || a.TimedSamples != 5 || len(a.Buckets) != 60 || len(a.Models) != 3 || a.Cache.EligibleSamples != 4 || a.Cache.MissingSamples != 1 {
		t.Fatalf("Token HTTP report: %+v", a)
	}
	if initial.Usage.Tokens.Total != nil || a.Tokens.Total.KnownSubtotal == nil || *a.Tokens.Total.KnownSubtotal != 725 || a.Tokens.Total.ReportedSamples != 4 || a.Tokens.Total.MissingSamples != 1 || *a.Cache.InputTokens != 460 {
		t.Fatalf("coverage or old total semantics: %+v / %+v", a, initial.Usage)
	}
	if strings.Contains(w.Body.String(), "The retry needs") || strings.Contains(w.Body.String(), "sourceUsageId") {
		t.Fatal("analysis exposed source contents or unneeded Usage identity")
	}
	firstBucket, lastBucket := a.Buckets[0], a.Buckets[len(a.Buckets)-1]
	if firstBucket.Samples != 3 || firstBucket.Records != 2 || lastBucket.Samples != 1 || lastBucket.Records != 0 || !lastBucket.IncludesEnd {
		t.Fatalf("Usage span confused with Event span: first=%+v last=%+v", firstBucket, lastBucket)
	}
	query := url.Values{"metric": {"token_records"}, "snapshot": {initial.Snapshot}, "tokenRange": {firstBucket.Range}, "limit": {"1"}}
	var page sessionanalytics.Result
	decodeResponse(t, read(route+"/evidence?"+query.Encode(), tokenActivityAccept, 200), &page)
	if len(page.Evidence.Items) != 1 || page.Evidence.NextCursor == "" || page.Evidence.Items[0].ClockQuality != "recorded" {
		t.Fatalf("first interval page: %+v", page.Evidence)
	}
	item := page.Evidence.Items[0]
	reader := "/api/v1/sessions/" + created.SessionID + "?" + url.Values{"thread": {item.ThreadID}, "at": {item.EventID}, "snapshot": {initial.Snapshot}, "limit": {"1"}}.Encode()
	read(reader, tokenActivityAccept, 200)
	query.Set("cursor", page.Evidence.NextCursor)
	var next sessionanalytics.Result
	decodeResponse(t, read(route+"/evidence?"+query.Encode(), tokenActivityAccept, 200), &next)
	if len(next.Evidence.Items) != 1 || next.Evidence.Items[0].EventID == item.EventID || next.Evidence.NextCursor != "" {
		t.Fatalf("interval continuation: %+v", next.Evidence)
	}
	var empty sessionanalytics.Result
	decodeResponse(t, read(route+"?"+url.Values{"metric": {"token_records"}, "snapshot": {initial.Snapshot}, "tokenRange": {lastBucket.Range}}.Encode(), tokenActivityAccept, 200), &empty)
	if len(empty.Evidence.Items) != 0 {
		t.Fatal("fabricated an original record for a Usage-only interval")
	}
	for _, path := range []string{route + "?metric=token_records", route + "?model=model:" + strings.Repeat("0", 64), route + "?metric=token_records&snapshot=" + url.QueryEscape(initial.Snapshot) + "&tokenRange=bad", route + "?" + query.Encode() + "&range=bad"} {
		assertProblemEnvelope(t, read(path, tokenActivityAccept, 422), "validation_failed")
	}
	for _, path := range []string{route + "?tokenRange=", route + "?model=one&model=two", route + "?model=one"} {
		accept := tokenActivityAccept
		if path == route+"?model=one" {
			accept = stableToolAccept
		}
		assertProblemEnvelope(t, read(path, accept, 400), "invalid_request")
	}
	for _, accept := range []string{"application/json", activityAccept, stableToolAccept} {
		old := read(route, accept, 200)
		var fields map[string]any
		if err := json.Unmarshal(old.Body.Bytes(), &fields); err != nil {
			t.Fatal(err)
		}
		if _, exists := fields["tokenActivity"]; exists {
			t.Fatal("changed older analytics representation")
		}
	}
	// Usage can change independently of Event and Session revisions.
	batch.BatchID = "usage-only-change"
	batch.Usage[0].Revision++
	batch.Usage[0].InputTokens = counter(101)
	if _, err := writer.ApplyBatch(t.Context(), canonicalcontract.CLIPrincipal(), batch); err != nil {
		t.Fatal(err)
	}
	assertProblemEnvelope(t, read(route+"/evidence?"+query.Encode(), tokenActivityAccept, 409), "refresh_required")
	assertProblemEnvelope(t, read(reader, tokenActivityAccept, 409), "refresh_required")
}
