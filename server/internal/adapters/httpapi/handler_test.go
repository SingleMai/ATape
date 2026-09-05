package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/adapters/memoryraw"
	"github.com/SingleMai/ATape/server/internal/adapters/memorysearch"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/sourceidentity"
	"github.com/SingleMai/ATape/server/internal/workspace"
)

func TestRawChunkEndpointIsIdempotent(t *testing.T) {
	handler := testHandler(t)
	content := []byte("{\"token\":\"[REDACTED]\"}\n")
	digest := sha256.Sum256(content)
	upload := rawarchive.UploadChunk{
		ProtocolVersion: rawarchive.ProtocolVersion, SourceChunkID: "http-raw-chunk-1", SourceObjectID: "http-raw-object",
		SessionID: "checkout", InstallationID: "http-installation", Generation: 1, Offset: 0,
		SourceName: "http-session.jsonl", MediaType: "application/x-ndjson", AdapterID: "atape-adapter-test",
		AdapterVersion: "0.1.0", CapturedAt: "2026-09-04T11:30:00+08:00", ClientRedacted: true,
		Final: true, ContentBase64: base64.StdEncoding.EncodeToString(content), SHA256: hex.EncodeToString(digest[:]),
	}
	body, err := json.Marshal(upload)
	if err != nil {
		t.Fatalf("marshal Raw chunk: %v", err)
	}
	for attempt, want := range []int{http.StatusCreated, http.StatusOK} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/ingestion/raw/chunks", bytes.NewReader(body))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("attempt %d status = %d, want %d: %s", attempt+1, response.Code, want, response.Body.String())
		}
	}
}

func TestIngestionEndpointsRejectClientDeclaredAuthority(t *testing.T) {
	handler := testHandler(t)
	for _, test := range []struct {
		name string
		path string
		body string
	}{
		{
			name: "Canonical source User",
			path: "/api/v1/ingestion/canonical/batches",
			body: `{"protocolVersion":"atape.canonical.v1","source":{"userId":"spoofed-user"}}`,
		},
		{
			name: "Canonical Team",
			path: "/api/v1/ingestion/canonical/batches",
			body: `{"protocolVersion":"atape.canonical.v1","teamId":"spoofed-team"}`,
		},
		{
			name: "Raw Project",
			path: "/api/v1/ingestion/raw/chunks",
			body: `{"protocolVersion":"atape.raw.v1","projectId":"spoofed-project"}`,
		},
		{
			name: "Raw object identity",
			path: "/api/v1/ingestion/raw/chunks",
			body: `{"protocolVersion":"atape.raw.v1","objectId":"spoofed-object","chunkId":"spoofed-chunk"}`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusBadRequest, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), `"code":"invalid_request"`) {
				t.Fatalf("response does not contain a data-poor decode error: %s", response.Body.String())
			}
		})
	}
}

func TestProjectSearchEndpointReturnsExactEventAnchor(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/payments-api/search?q=merchant_id", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if got, want := response.Code, http.StatusOK; got != want {
		t.Fatalf("status = %d, want %d: %s", got, want, response.Body.String())
	}
	for _, expected := range []string{`"eventId":"c6"`, `"threadId":"schema-review"`, `"indexedThrough"`} {
		if !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("response does not contain %s: %s", expected, response.Body.String())
		}
	}
}

func TestProjectSearchEndpointRejectsEmptyQuery(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/payments-api/search", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if got, want := response.Code, http.StatusBadRequest; got != want {
		t.Fatalf("status = %d, want %d: %s", got, want, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"code":"invalid_search"`) {
		t.Fatalf("response does not contain typed Search error: %s", response.Body.String())
	}
}

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	store := canonical.NewDemoStore()
	index := memorysearch.New(store)
	raw, err := memoryraw.NewDemoArchive(store)
	if err != nil {
		t.Fatalf("seed demo Raw archive: %v", err)
	}
	projector := projectsearch.NewProjector(store, index)
	if _, err := projector.ProjectOnce(t.Context()); err != nil {
		t.Fatalf("project demo Search index: %v", err)
	}
	handler := NewHandler(
		conversation.NewMemory(store), ingestion.NewIngestor(store),
		projectsearch.NewSearcher(index), workspace.NewDirectory(store), raw,
	)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		method := authentication.WebAuthentication
		if request.Method == http.MethodPost {
			method = authentication.CLIAuthentication
		}
		principal := authentication.Principal{UserID: canonical.DemoUserID, Method: method}
		handler.ServeHTTP(response, request.WithContext(WithPrincipal(request.Context(), principal)))
	})
}

func TestRawSessionAndContentEndpointsAreSeparateAndBounded(t *testing.T) {
	handler := testHandler(t)
	listingRequest := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/checkout/raw", nil)
	listingResponse := httptest.NewRecorder()
	handler.ServeHTTP(listingResponse, listingRequest)
	if got, want := listingResponse.Code, http.StatusOK; got != want {
		t.Fatalf("listing status = %d, want %d: %s", got, want, listingResponse.Body.String())
	}
	demoObjectID := sourceidentity.RawObjectID(
		canonical.DemoUserID, "checkout", "demo-installation", "atape-adapter-codex", "demo-checkout-codex-jsonl",
	)
	for _, expected := range []string{`"objectId":"` + demoObjectID + `"`, `"clientRedacted":true`, `"contentBase64"`} {
		contains := strings.Contains(listingResponse.Body.String(), expected)
		if expected == `"contentBase64"` {
			contains = !contains
		}
		if !contains {
			t.Fatalf("unexpected Raw listing for %s: %s", expected, listingResponse.Body.String())
		}
	}

	contentRequest := httptest.NewRequest(http.MethodGet, "/api/v1/raw-objects/"+demoObjectID+"/content?limit=1", nil)
	contentResponse := httptest.NewRecorder()
	handler.ServeHTTP(contentResponse, contentRequest)
	if got, want := contentResponse.Code, http.StatusOK; got != want {
		t.Fatalf("content status = %d, want %d: %s", got, want, contentResponse.Body.String())
	}
	if !strings.Contains(contentResponse.Body.String(), `"contentBase64"`) {
		t.Fatalf("Raw content is missing bytes: %s", contentResponse.Body.String())
	}
}

func TestProjectMemoryEndpoint(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/payments-api/memory", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if got, want := response.Code, http.StatusOK; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	if !strings.Contains(response.Body.String(), `"capturedThrough"`) {
		t.Fatalf("response does not contain project memory: %s", response.Body.String())
	}
}

func TestWorkspaceEndpointReturnsTypedProjects(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/workspace", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if got, want := response.Code, http.StatusOK; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	for _, expected := range []string{`"name":"Acme Engineering"`, `"id":"payments-api"`, `"type":"git"`, `"type":"directory"`} {
		if !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("Workspace response does not contain %s: %s", expected, response.Body.String())
		}
	}
}

func TestUnknownConversationIsNotFound(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/unknown?thread=root", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if got, want := response.Code, http.StatusNotFound; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	if !strings.Contains(response.Body.String(), `"code":"not_found"`) {
		t.Fatalf("response does not contain typed error: %s", response.Body.String())
	}
}

func TestCanonicalBatchEndpointIsReadableAndReplaySafe(t *testing.T) {
	handler := testHandler(t)
	batch := ingestion.Batch{
		ProtocolVersion:         ingestion.ProtocolVersion,
		CanonicalProfileVersion: ingestion.CanonicalProfileVersion,
		BatchID:                 "http-batch-1",
		ObservedAt:              "2026-09-04T11:30:00+08:00",
		Source:                  ingestion.Source{AdapterID: "atape-adapter-test", AdapterVersion: "0.1.0", InstallationID: "test-host"},
		ProjectID:               "payments-api",
		Session: ingestion.Session{
			SourceSessionID: "http-session", Revision: 1, Title: "Captured through HTTP",
			Summary: "A real ingestion request.", Insight: "The reader sees the committed batch.",
			Actor: ingestion.Actor{Name: "Test user", Harness: "Test harness"}, Status: "active",
			CaptureStatus: "healthy", UpdatedAt: "2026-09-04T11:29:00+08:00", ReportedEventCount: 1,
		},
		Threads: []ingestion.Thread{{SourceThreadID: "root-source", Revision: 1, Label: "Root thread", CaptureStatus: "healthy"}},
		Events: []ingestion.Event{{
			SourceEventID: "event-1", SourceThreadID: "root-source", Revision: 1, ProjectionRevision: 1,
			SourceOrder: 1, EventIndex: 0, OrderFidelity: "native", Fidelity: "native", RawRef: ingestion.RawReference{Type: "object", SourceObjectID: "http-session", Fragment: "#event-1"},
			Kind: "message", Author: "Test user", OccurredAt: "2026-09-04T11:29:00+08:00", Text: "The batch arrived.",
		}},
	}
	body, err := json.Marshal(batch)
	if err != nil {
		t.Fatalf("marshal batch: %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/v1/ingestion/canonical/batches", bytes.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got, want := response.Code, http.StatusCreated; got != want {
		t.Fatalf("first status = %d, want %d: %s", got, want, response.Body.String())
	}

	replayRequest := httptest.NewRequest(http.MethodPost, "/api/v1/ingestion/canonical/batches", bytes.NewReader(body))
	replayResponse := httptest.NewRecorder()
	handler.ServeHTTP(replayResponse, replayRequest)
	if got, want := replayResponse.Code, http.StatusOK; got != want {
		t.Fatalf("replay status = %d, want %d: %s", got, want, replayResponse.Body.String())
	}
	if !strings.Contains(replayResponse.Body.String(), `"replayed":true`) {
		t.Fatalf("replay response does not report replay: %s", replayResponse.Body.String())
	}

	projectRequest := httptest.NewRequest(http.MethodGet, "/api/v1/projects/payments-api/memory", nil)
	projectResponse := httptest.NewRecorder()
	handler.ServeHTTP(projectResponse, projectRequest)
	if !strings.Contains(projectResponse.Body.String(), `"title":"Captured through HTTP"`) {
		t.Fatalf("ingested session is not readable: %s", projectResponse.Body.String())
	}
}
