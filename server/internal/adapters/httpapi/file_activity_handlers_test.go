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

func TestFileActivityHTTPFiltersAndConditionalReader(t *testing.T) {
	store := canonical.NewMemoryStoreWithControlPlane(canonicalcontract.MemoryControlPlane())
	b := canonicalcontract.ValidBatch()
	b.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
	first := b.Events[1]
	first.SourceEventID, first.SourceOrder, first.Kind = "file-first", 2, "tool_call"
	first.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"one","title":"Read display","_meta":{"atape.dev/tool-identity":null,"atape.dev/file-activity":[{"operation":"read","path":"src/a.go"},{"operation":"edit","path":"src/a.go"},{"operation":"search","path":"src"}]},"rawInput":{"private":"excluded-input"},"rawOutput":"excluded-output"}`
	last := first
	last.SourceEventID, last.SourceOrder, last.Kind = "file-final", 3, "tool_result"
	last.ToolUpdateJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"one","title":"Final display","status":"completed"}`
	second := first
	second.SourceEventID, second.SourceOrder = "file-second", 4
	second.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"two","title":"Read other display","_meta":{"atape.dev/tool-identity":null,"atape.dev/file-activity":[{"operation":"read","path":"src/a.go"}]}}`
	unknown := first
	unknown.SourceEventID, unknown.SourceOrder = "file-unknown", 5
	unknown.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"unknown","title":"Read src/fake.go","kind":"read"}`
	b.Events = []ingestion.Event{b.Events[0], first, last, second, unknown}
	b.Session.ReportedEventCount = len(b.Events)
	writer := ingestion.NewIngestor(store)
	created, err := writer.ApplyBatch(t.Context(), canonicalcontract.CLIPrincipal(), b)
	if err != nil {
		t.Fatal(err)
	}
	principal := canonicalcontract.WebPrincipal()
	h := testHandlerWithConfig(t, Config{InstanceOrigin: "http://127.0.0.1:8080", WebOrigin: "http://127.0.0.1:8080", APIOrigin: "http://127.0.0.1:8080", DevelopmentAllowHTTP: true, DevelopmentPrincipal: &principal})
	h.analytics, h.memory = sessionanalytics.New(store), conversation.NewMemory(store)
	read := func(path string, status int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Accept", stableToolAccept)
		h.ServeHTTP(w, r)
		if w.Code != status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		return w
	}
	route := "/api/v1/sessions/" + created.SessionID + "/analytics"
	response := read(route+"?metric=files", 200)
	var initial sessionanalytics.Result
	decodeResponse(t, response, &initial)
	f := initial.FileActivity
	if f == nil || f.CallsWithActivity != 2 || f.CallsWithoutActivity != 1 || f.ReadCalls != 2 || f.EditCalls != 1 || f.SearchCalls != 1 || f.UniquePaths != 2 || f.Paths[0].Path != "src/a.go" || f.Paths[0].Calls != 2 || len(initial.Evidence.Items) != 2 || initial.Evidence.Items[0].Label != "Final display" {
		t.Fatalf("file HTTP facts: %+v", initial)
	}
	if strings.Contains(response.Body.String(), "excluded-") || strings.Contains(response.Body.String(), "fake.go") || strings.Contains(response.Body.String(), "rawInput") {
		t.Fatal("file report inferred a title path or exposed a payload")
	}
	q := url.Values{"metric": {"files"}, "file": {f.Paths[0].Key}, "operation": {"read"}, "snapshot": {initial.Snapshot}, "limit": {"1"}}
	var page sessionanalytics.Result
	decodeResponse(t, read(route+"/evidence?"+q.Encode(), 200), &page)
	if len(page.Evidence.Items) != 1 || page.Evidence.NextCursor == "" || page.Evidence.Items[0].Label != "Final display" {
		t.Fatalf("file evidence: %+v", page.Evidence)
	}
	item := page.Evidence.Items[0]
	readerURL := "/api/v1/sessions/" + created.SessionID + "?" + url.Values{"thread": {item.ThreadID}, "at": {item.EventID}, "limit": {"1"}, "snapshot": {initial.Snapshot}}.Encode()
	var original conversation.Conversation
	decodeResponse(t, read(readerURL, 200), &original)
	if original.Snapshot != initial.Snapshot || original.Events[2].ID != item.EventID || *original.Events[2].Tool.Title != item.Label || original.Events[1].Tool.Meta.FileActivity == nil {
		t.Fatalf("file original Reader target: %+v", original)
	}
	q.Set("cursor", page.Evidence.NextCursor)
	var next sessionanalytics.Result
	decodeResponse(t, read(route+"/evidence?"+q.Encode(), 200), &next)
	if len(next.Evidence.Items) != 1 || next.Evidence.Items[0].Label != "Read other display" {
		t.Fatalf("file continuation: %+v", next.Evidence)
	}
	q.Set("operation", "edit")
	assertProblemEnvelope(t, read(route+"/evidence?"+q.Encode(), 422), "validation_failed")
	q.Set("operation", "read")
	for _, query := range []string{"file=x", "operation=read", "metric=files&file=src%2Fa.go", "metric=files&operation=delete", "metric=files&tool=Read", "metric=files&range=x", "metric=files&capability=read"} {
		assertProblemEnvelope(t, read(route+"?"+query, 422), "validation_failed")
	}
	for _, query := range []string{"metric=files&operation=", "metric=files&file=x&file=x", "metric=files&file=%ff"} {
		assertProblemEnvelope(t, read(route+"?"+query, 400), "invalid_request")
	}
	for _, accept := range []string{"application/json", "application/vnd.atape.session-analytics.v3+json"} {
		w := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, route, nil)
		request.Header.Set("Accept", accept)
		h.ServeHTTP(w, request)
		var old map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &old); err != nil || old["fileActivity"] != nil {
			t.Fatalf("legacy response changed: %s %v", w.Body.String(), err)
		}
		w = httptest.NewRecorder()
		request = httptest.NewRequest(http.MethodGet, route+"?file=x", nil)
		request.Header.Set("Accept", accept)
		h.ServeHTTP(w, request)
		if w.Code != 400 {
			t.Fatalf("legacy query allowlist changed: %d", w.Code)
		}
	}
	// A path-only source edit changes both analysis and Reader conditional tokens.
	b.BatchID = "file-source-change"
	b.Events[1].Revision++
	b.Events[1].ToolUpdateJSON = strings.ReplaceAll(b.Events[1].ToolUpdateJSON, "src/a.go", "src/b.go")
	if _, err := writer.ApplyBatch(t.Context(), canonicalcontract.CLIPrincipal(), b); err != nil {
		t.Fatal(err)
	}
	assertProblemEnvelope(t, read(route+"/evidence?"+q.Encode(), 409), "refresh_required")
	assertProblemEnvelope(t, read(readerURL, 409), "refresh_required")
	outsider := canonicalcontract.WebPrincipal()
	outsider.UserID = "outside-member"
	denied := testHandlerWithConfig(t, Config{InstanceOrigin: "http://127.0.0.1:8080", WebOrigin: "http://127.0.0.1:8080", APIOrigin: "http://127.0.0.1:8080", DevelopmentAllowHTTP: true, DevelopmentPrincipal: &outsider})
	denied.analytics, denied.memory = sessionanalytics.New(store), conversation.NewMemory(store)
	for _, path := range []string{route + "?metric=files", route + "/evidence?" + q.Encode(), readerURL} {
		w := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Accept", stableToolAccept)
		denied.ServeHTTP(w, request)
		if w.Code != 404 {
			t.Fatalf("file token bypassed current membership: %d %s", w.Code, w.Body.String())
		}
		assertProblemEnvelope(t, w, "not_found")
	}
}
