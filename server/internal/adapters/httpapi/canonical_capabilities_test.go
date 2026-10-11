package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
)

func TestCanonicalCapabilitiesWithoutPublicationAffirmAcceptedProfiles(t *testing.T) {
	handler := testHandler(t)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/ingestion/canonical/capabilities", nil))
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("capabilities: %d %s", response.Code, response.Body.String())
	}
	var capabilities ingestion.Capabilities
	if err := json.Unmarshal(response.Body.Bytes(), &capabilities); err != nil {
		t.Fatal(err)
	}
	if capabilities.Protocol != ingestion.CapabilitiesProtocolVersion || !reflect.DeepEqual(capabilities.CanonicalProfiles,
		[]string{ingestion.CanonicalProfileVersion, ingestion.UnknownTimeCanonicalProfileVersion, ingestion.ToolIdentityCanonicalProfileVersion}) {
		t.Fatalf("capabilities: %+v", capabilities)
	}
	// The admitted Canonical path does not require advertising unsupported
	// Publication on the legacy-only demo store.
	publication := httptest.NewRecorder()
	handler.ServeHTTP(publication, httptest.NewRequest(http.MethodGet, "/api/v1/publications/capabilities", nil))
	if publication.Code != http.StatusServiceUnavailable {
		t.Fatalf("publication unexpectedly advertised: %d", publication.Code)
	}
	for index, profile := range capabilities.CanonicalProfiles {
		t.Run(profile, func(t *testing.T) {
			unknown := profile != ingestion.CanonicalProfileVersion
			batch := ingestion.Batch{
				ProtocolVersion: ingestion.ProtocolVersion, CanonicalProfileVersion: profile,
				BatchID: fmt.Sprintf("capability-batch-%d", index), ObservedAt: "2026-10-11T00:00:00Z",
				Source:    ingestion.Source{AdapterID: "capability-test", AdapterVersion: "1", InstallationID: "capability-test"},
				ProjectID: "payments-api",
				Session: ingestion.Session{SourceSessionID: fmt.Sprintf("capability-session-%d", index), Revision: 1,
					Title: "Clock capabilities", Actor: ingestion.Actor{Name: "User", Harness: "Test"},
					Status: "ended", CaptureStatus: "complete", UpdatedAt: "2026-10-11T00:00:00Z",
					UpdatedAtUnknown: unknown, ReportedEventCount: 1},
				Threads: []ingestion.Thread{{SourceThreadID: "root", Revision: 1, Label: "Root", CaptureStatus: "complete"}},
				Events: []ingestion.Event{{SourceEventID: "record-1", SourceThreadID: "root", Revision: 1,
					ProjectionRevision: 1, SourceOrder: 1, EventIndex: 1, OrderFidelity: "native", Fidelity: "native",
					RawRef: ingestion.RawReference{Type: "unavailable", UnavailableReason: "Raw disabled"},
					Kind:   "message", Author: "User", Text: "Retained clock record", OccurredAt: "2026-10-11T00:00:00Z", OccurredAtUnknown: unknown}},
			}
			if unknown {
				batch.Session.UpdatedAt, batch.Events[0].OccurredAt = "", ""
			}
			body, err := json.Marshal(batch)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/api/v1/ingestion/canonical/batches", bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			applied := httptest.NewRecorder()
			handler.ServeHTTP(applied, request)
			if applied.Code != http.StatusCreated {
				t.Fatalf("advertised profile rejected: %d %s", applied.Code, applied.Body.String())
			}
			var receipt canonical.ApplyResult
			if err := json.Unmarshal(applied.Body.Bytes(), &receipt); err != nil {
				t.Fatal(err)
			}
			read := httptest.NewRecorder()
			handler.ServeHTTP(read, httptest.NewRequest(http.MethodGet, "/api/v1/sessions/"+receipt.SessionID, nil))
			if read.Code != http.StatusOK {
				t.Fatalf("reader: %d %s", read.Code, read.Body.String())
			}
			var view conversation.Conversation
			if err := json.Unmarshal(read.Body.Bytes(), &view); err != nil {
				t.Fatal(err)
			}
			if len(view.Events) != 1 || (view.Events[0].OccurredAt == nil) != unknown {
				t.Fatalf("clock or record lost: %s", read.Body.String())
			}
		})
	}
}

func TestCanonicalCapabilitiesRejectQueryParameters(t *testing.T) {
	response := httptest.NewRecorder()
	testHandler(t).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/ingestion/canonical/capabilities?profile=guessed", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("query: %d %s", response.Code, response.Body.String())
	}
}
