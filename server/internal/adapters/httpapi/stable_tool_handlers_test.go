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

const stableToolAccept = "application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json"

func TestStableToolHTTPGroupKeysAndConditionalReader(t *testing.T) {
	store := canonical.NewMemoryStoreWithControlPlane(canonicalcontract.MemoryControlPlane())
	batch := canonicalcontract.ValidBatch()
	batch.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
	first := batch.Events[1]
	first.Kind = "tool_call"
	first.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"first","title":"ls private-title","kind":"execute","_meta":{"atape.dev/tool-identity":{"type":"tool","name":"exec_command"}},"rawInput":{"secret":"private-input"}}`
	final := first
	final.SourceEventID, final.SourceOrder, final.Kind = "first-final", 3, "tool_result"
	final.ToolUpdateJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"first","title":"final first command","status":"completed"}`
	second := first
	second.SourceEventID, second.SourceOrder = "second", 4
	second.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"second","title":"cat private-title","kind":"execute","_meta":{"atape.dev/tool-identity":{"type":"tool","name":"exec_command"}}}`
	unknown := first
	unknown.SourceEventID, unknown.SourceOrder = "unknown", 5
	unknown.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"unknown","title":"exec_command","kind":"execute"}`
	otherUnknown := unknown
	otherUnknown.SourceEventID, otherUnknown.SourceOrder = "other-unknown", 6
	otherUnknown.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"other-unknown","title":"other unknown command","kind":"execute"}`
	batch.Events = []ingestion.Event{batch.Events[0], first, final, second, unknown, otherUnknown}
	batch.Session.ReportedEventCount = len(batch.Events)
	writer := ingestion.NewIngestor(store)
	created, err := writer.ApplyBatch(t.Context(), canonicalcontract.CLIPrincipal(), batch)
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
	response := read(route, 200)
	var initial sessionanalytics.Result
	decodeResponse(t, response, &initial)
	if initial.AnalyticsVersion != 4 || len(initial.Tools) != 2 || *initial.Summary.IdentifiedToolCalls != 2 || *initial.Summary.UnidentifiedToolCalls != 2 || initial.Tools[0].Name != "exec_command" || initial.Tools[0].Completed != 1 || initial.Tools[0].Unknown != 1 || initial.Capabilities.UnclassifiedCalls != 4 {
		t.Fatalf("stable HTTP facts: %+v", initial)
	}
	if strings.Contains(response.Body.String(), "private-input") || !strings.Contains(response.Body.String(), `"identity":null`) {
		t.Fatal("payload leaked or null identity omitted")
	}
	query := url.Values{"tool": {initial.Tools[0].Key}, "limit": {"1"}, "snapshot": {initial.Snapshot}}
	var page sessionanalytics.Result
	decodeResponse(t, read(route+"/evidence?"+query.Encode(), 200), &page)
	if len(page.Evidence.Items) != 1 || page.Evidence.NextCursor == "" || page.Evidence.Items[0].ClockQuality != "recorded" || page.Evidence.Items[0].Label != "final first command" {
		t.Fatalf("stable evidence: %+v", page)
	}
	item := page.Evidence.Items[0]
	readerPath := "/api/v1/sessions/" + created.SessionID + "?" + url.Values{"thread": {item.ThreadID}, "at": {item.EventID}, "limit": {"1"}, "snapshot": {page.Snapshot}}.Encode()
	var original conversation.Conversation
	decodeResponse(t, read(readerPath, 200), &original)
	if original.Events[1].Tool.Meta.Identity.Name != "exec_command" || original.Events[2].ID != item.EventID || *original.Events[2].Tool.Title != item.Label {
		t.Fatalf("Reader lost admitted identity: %+v", original)
	}
	query.Set("cursor", page.Evidence.NextCursor)
	var next sessionanalytics.Result
	decodeResponse(t, read(route+"/evidence?"+query.Encode(), 200), &next)
	if len(next.Evidence.Items) != 1 || next.Evidence.Items[0].EventID == item.EventID || next.Evidence.Items[0].Label != "cat private-title" {
		t.Fatal("stable evidence continuation lost distinct title or duplicated anchor")
	}
	var unknownPage sessionanalytics.Result
	decodeResponse(t, read(route+"?tool="+url.QueryEscape(initial.Tools[1].Key), 200), &unknownPage)
	if len(unknownPage.Evidence.Items) != 2 || unknownPage.Evidence.Items[0].Label != "exec_command" || unknownPage.Evidence.Items[1].Label != "other unknown command" {
		t.Fatalf("unknown HTTP group lost display titles: %+v", unknownPage.Evidence)
	}
	assertProblemEnvelope(t, read(route+"?tool=exec_command", 422), "validation_failed")
	assertProblemEnvelope(t, read(route+"?tool=tool:"+strings.Repeat("0", 64), 422), "validation_failed")
	// Independent native Event identity changes invalidate both conditional paths.
	batch.BatchID = "identity-source-change"
	batch.Events[1].Revision++
	batch.Events[1].ToolUpdateJSON = strings.Replace(batch.Events[1].ToolUpdateJSON, `"name":"exec_command"`, `"name":"new_command"`, 1)
	if _, e := writer.ApplyBatch(t.Context(), canonicalcontract.CLIPrincipal(), batch); e != nil {
		t.Fatal(e)
	}
	assertProblemEnvelope(t, read(route+"/evidence?"+query.Encode(), 409), "refresh_required")
	assertProblemEnvelope(t, read(readerPath, 409), "refresh_required")
	// Default JSON retains label grouping, without adding opt-in fields.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, route, nil))
	var old map[string]any
	if e := json.Unmarshal(w.Body.Bytes(), &old); e != nil || old["analyticsVersion"] != float64(2) || strings.Contains(w.Body.String(), "identifiedToolCalls") || strings.Contains(w.Body.String(), `"identity"`) {
		t.Fatalf("default response changed: %s %v", w.Body.String(), e)
	}
}
