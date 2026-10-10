package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Uses the authenticated HTTP fixture and its real database. Invalid requests
// must fail before a Session is created; source nulls must survive the wire and
// Search projection without becoming an observation or zero-date clock.
func assertHTTPUnknownTimeContract(t *testing.T, h *Handler, pool *pgxpool.Pool, projectID, credential string, cookie *http.Cookie, csrf string) {
	t.Helper()
	send := func(method, path string, body []byte, web bool, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		if body != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		if web {
			addWebProof(r, cookie, csrf)
		} else {
			r.Header.Set("Authorization", "Bearer "+credential)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s: %d want %d: %s", method, path, w.Code, want, w.Body.String())
		}
		return w
	}
	encode := func(value any) []byte {
		t.Helper()
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	for _, negotiation := range []struct {
		name    string
		headers []string
		v3      bool
	}{
		{name: "legacy default"},
		{name: "empty", headers: []string{""}},
		{name: "v2 only", headers: []string{publication.RetentionTargetProfile}},
		{name: "future unknown", headers: []string{"atape.publication-target.v4"}},
		{name: "unknown syntax", headers: []string{publication.UnknownTimeTargetProfile + ";q=1"}},
		{name: "exact v3", headers: []string{publication.UnknownTimeTargetProfile}, v3: true},
		{name: "token list", headers: []string{"atape.publication-target.v4, " + publication.UnknownTimeTargetProfile}, v3: true},
		{name: "empty list tokens", headers: []string{" , " + publication.UnknownTimeTargetProfile + " , , "}, v3: true},
		{name: "duplicate header fields", headers: []string{"atape.publication-target.v4", publication.UnknownTimeTargetProfile}, v3: true},
	} {
		r := httptest.NewRequest("GET", "/api/v1/publications/capabilities", nil)
		r.Header.Set("Authorization", "Bearer "+credential)
		for _, field := range negotiation.headers {
			r.Header.Add("ATape-Accept-Publication-Target", field)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s capabilities: %d %s", negotiation.name, w.Code, w.Body.String())
		}
		var caps publication.Capabilities
		decodeResponse(t, w, &caps)
		want := []string{publication.TargetProfile, publication.RetentionTargetProfile}
		if negotiation.v3 {
			want = append(want, publication.UnknownTimeTargetProfile)
		}
		if !slices.Equal(caps.TargetProfiles, want) || caps.TargetProfile != publication.TargetProfile || strings.Contains(w.Body.String(), "atape.publication-target.v4") {
			t.Fatalf("%s capabilities: %s", negotiation.name, w.Body.String())
		}
	}
	// The opt-in changes no credential boundary: Web sessions cannot discover
	// publication capabilities even when they request the new profile.
	r := httptest.NewRequest("GET", "/api/v1/publications/capabilities", nil)
	r.AddCookie(cookie)
	r.Header.Set("ATape-Accept-Publication-Target", publication.UnknownTimeTargetProfile)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("Web capabilities opt-in: %d %s", w.Code, w.Body.String())
	}
	batch := canonicalcontract.ValidBatch()
	batch.ProjectID = projectID
	batch.CanonicalProfileVersion = ingestion.UnknownTimeCanonicalProfileVersion
	batch.Session.SourceSessionID, batch.BatchID = "http-explicit-unknown-time", "http-explicit-unknown-time"
	batch.Session.UpdatedAt, batch.Session.UpdatedAtUnknown = "", true
	batch.Events = batch.Events[:1]
	batch.Session.ReportedEventCount = 1
	batch.Events[0].OccurredAt, batch.Events[0].OccurredAtUnknown = "", true
	batch.Events[0].Text = "http-unknown-time-needle"
	body := encode(batch)
	for _, profile := range []string{ingestion.LegacyCanonicalProfileVersion, ingestion.CanonicalProfileVersion, ingestion.UnknownTimeCanonicalProfileVersion} {
		for _, field := range []string{"updatedAt", "occurredAt"} {
			for _, defect := range []string{"null", "missing", "empty", "invalid", "zero", "zero-fraction", "zero-offset", "number"} {
				if defect == "null" && profile == ingestion.UnknownTimeCanonicalProfileVersion {
					continue
				}
				var value map[string]any
				if err := json.Unmarshal(body, &value); err != nil {
					t.Fatal(err)
				}
				value["canonicalProfileVersion"] = profile
				// Keep the other required source clock known so each rejection
				// specifically exercises the selected field/profile combination.
				session := value["session"].(map[string]any)
				event := value["events"].([]any)[0].(map[string]any)
				session["updatedAt"], event["occurredAt"] = "2026-09-04T10:00:00Z", "2026-09-04T10:00:00Z"
				object := session
				if field == "occurredAt" {
					object = event
				}
				want := 422
				switch defect {
				case "null":
					object[field] = nil
				case "missing":
					delete(object, field)
				case "empty":
					object[field] = ""
				case "invalid":
					object[field] = "not-a-clock"
				case "zero":
					object[field] = "0001-01-01T00:00:00Z"
				case "zero-fraction":
					object[field] = "0001-01-01T00:00:00.000000001Z"
				case "zero-offset":
					object[field] = "0001-01-01T01:00:00.000000999+01:00"
				case "number":
					object[field], want = 17, 400
				}
				send("POST", "/api/v1/ingestion/canonical/batches", encode(value), false, want)
			}
		}
	}
	var applied canonical.ApplyResult
	decodeResponse(t, send("POST", "/api/v1/ingestion/canonical/batches", body, false, 201), &applied)
	send("POST", "/api/v1/ingestion/canonical/batches", body, false, 200)
	path := "/api/v1/sessions/" + applied.SessionID
	var opened conversation.Conversation
	response := send("GET", path, nil, true, 200)
	decodeResponse(t, response, &opened)
	if opened.Session.UpdatedAt != nil || len(opened.Events) != 1 || opened.Events[0].OccurredAt != nil || !strings.Contains(response.Body.String(), `"updatedAt":null`) || !strings.Contains(response.Body.String(), `"occurredAt":null`) || strings.Contains(response.Body.String(), "0001-01-01") {
		t.Fatalf("nullable reader wire: %s", response.Body.String())
	}
	store := postgresadapter.NewStore(pool)
	projector := projectsearch.NewProjector(store, store)
	drain := func() {
		t.Helper()
		for range 10 {
			n, err := projector.ProjectOnce(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if n == 0 {
				return
			}
		}
		t.Fatal("Search projection did not finish")
	}
	drain()
	var page projectsearch.Page
	decodeResponse(t, send("GET", "/api/v1/projects/"+projectID+"/search?q=http-unknown-time-needle", nil, true, 200), &page)
	if len(page.Results) != 1 || page.Results[0].OccurredAt != nil {
		t.Fatalf("nullable HTTP Search: %+v", page)
	}
	// This helper shares the larger authentication fixture. Use its public
	// deletion Interface and drain the tombstone before subsequent contracts.
	send("DELETE", path, nil, true, 204)
	drain()
}
