package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/jackc/pgx/v5/pgxpool"
)

type nativeCollectorSnapshot struct {
	SessionID     string          `json:"sessionId"`
	Head          string          `json:"head"`
	ForkSessionID string          `json:"forkSessionId"`
	Checkpoint    string          `json:"checkpoint"`
	RawCaptureID  string          `json:"rawCaptureId"`
	Observations  int             `json:"observations"`
	Pending       int             `json:"pending"`
	RawComplete   bool            `json:"rawComplete"`
	Records       json.RawMessage `json:"records"`
}

// The fixture varies only the external native source and network response loss.
// Collection, authentication, publication, storage and all reads are production.
func assertOpenCodeCollectorContract(t *testing.T, h *Handler, modules Modules, pool *pgxpool.Pool, projectID, userID, credential string, cookie *http.Cookie, csrf string) {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	handler, err := NewHandler(Config{InstanceOrigin: origin, WebOrigin: origin, APIOrigin: origin, DevelopmentAllowHTTP: true}, modules)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	server.Config.Handler = handler
	server.Start()
	defer server.Close()
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(t.TempDir(), "collector.sqlite")
	batch := canonicalcontract.ValidBatch()
	batch.ProjectID = projectID
	run := func(phase string) nativeCollectorSnapshot {
		t.Helper()
		input, err := json.Marshal(map[string]any{"phase": phase, "origin": origin, "credential": credential, "userId": userID, "journal": journal, "batch": batch})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "node", "apps/cli/src/runtime/fixtures/opencode-collector-contract.ts")
		command.Dir = root
		command.Stdin = bytes.NewReader(input)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Fatalf("native Collector %s: %v\n%s", phase, err, stderr.String())
		}
		var snapshot nativeCollectorSnapshot
		if err := json.Unmarshal(output, &snapshot); err != nil {
			t.Fatalf("native Collector %s output: %v", phase, err)
		}
		if snapshot.SessionID == "" || snapshot.Head == "" || snapshot.Checkpoint == "" {
			t.Fatalf("native Collector %s did not retain activation identity", phase)
		}
		return snapshot
	}
	send := func(method, path, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		addWebProof(request, cookie, csrf)
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("native Collector read %s: %d want %d: %s", path, response.Code, want, response.Body.String())
		}
		return response
	}
	setRaw := func(enabled bool) {
		preference := "disable"
		if enabled {
			preference = "enable"
		}
		send("PUT", "/api/v1/users/me/raw-capture", `{"preference":"`+preference+`"}`, 200)
	}
	search := func(term string) projectsearch.Page {
		t.Helper()
		var page projectsearch.Page
		decodeResponse(t, send("GET", "/api/v1/projects/"+projectID+"/search?q="+url.QueryEscape(term), "", 200), &page)
		return page
	}
	store := postgresadapter.NewStore(pool)
	// Conversation presentation omits Raw references. Verify the stored Event
	// through the same bounded Snapshot Interface consumed by that reader.
	firstReference := func(sessionID string) string {
		t.Helper()
		snapshot, found, err := store.ConversationPage(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, sessionID, "root", canonical.ConversationPageRequest{Limit: 1})
		if err != nil || !found || len(snapshot.Events) != 1 {
			t.Fatalf("native Event provenance read: found=%v, %v", found, err)
		}
		return snapshot.Events[0].RawRef
	}
	rawMember := func(reference string) []byte {
		t.Helper()
		objectID, key, valid := strings.Cut(reference, "/records/")
		if !valid || objectID == "" || key == "" {
			t.Fatal("native Event did not retain an exact Raw object/member reference")
		}
		var page rawarchive.ContentPage
		decodeResponse(t, send("GET", "/api/v1/raw-objects/"+objectID+"/content?generation=1&limit=1", "", 200), &page)
		if len(page.Chunks) != 1 || page.NextCursor != "" || page.Generation != 1 {
			t.Fatal("referenced native Raw object violated its immutable bound")
		}
		content, err := base64.StdEncoding.DecodeString(page.Chunks[0].ContentBase64)
		if err != nil {
			t.Fatal(err)
		}
		var object struct {
			Records map[string]struct {
				Row json.RawMessage `json:"row"`
			} `json:"records"`
		}
		if err := json.Unmarshal(content, &object); err != nil {
			t.Fatal(err)
		}
		member, found := object.Records[key]
		if !found {
			t.Fatal("native Event Raw fragment did not resolve to its actual member")
		}
		return member.Row
	}
	projectSearch := func() {
		t.Helper()
		for n := 0; n < 10; n++ {
			count, err := projectsearch.NewProjector(store, store).ProjectOnce(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if count == 0 {
				return
			}
		}
		t.Fatal("native Search projection did not drain its bounded fixture")
	}
	read := func(sessionID string, expected int) (string, []conversation.Event) {
		t.Helper()
		head, after := "", ""
		var events []conversation.Event
		for n := 0; n < 10; n++ {
			query := url.Values{"limit": {"2"}}
			if head != "" {
				query.Set("head", head)
			}
			if after != "" {
				query.Set("after", after)
			}
			var page conversation.Conversation
			decodeResponse(t, send("GET", "/api/v1/sessions/"+sessionID+"?"+query.Encode(), "", 200), &page)
			if len(page.Events) > 2 || head != "" && page.Head != head {
				t.Fatal("native conversation crossed a page or head bound")
			}
			head, after = page.Head, page.NextEventID
			events = append(events, page.Events...)
			if after == "" {
				if len(events) != expected {
					t.Fatalf("native root Events = %d want %d", len(events), expected)
				}
				return head, events
			}
		}
		t.Fatal("native conversation did not finish its bounded fixture")
		return "", nil
	}
	setRaw(true)
	defer setRaw(false)
	initial := run("initial")
	if initial.Observations != 1 || initial.Pending != 0 || !initial.RawComplete || initial.ForkSessionID != "" {
		t.Fatal("initial native collection did not publish exactly the attributed root")
	}
	head, events := read(initial.SessionID, 5)
	encoded, _ := json.Marshal(events)
	if head != initial.Head || !bytes.Contains(encoded, []byte("CollectorToolNeedle")) || !bytes.Contains(encoded, []byte("No real model was called")) || bytes.Contains(encoded, []byte("SENSITIVE_TEST_TOKEN")) {
		t.Fatal("native tool, compaction, masking or actual head was lost")
	}
	initialReference := firstReference(initial.SessionID)
	initialRow := rawMember(initialReference)
	if !bytes.Contains(initialRow, []byte("CollectorInitialNeedle")) || bytes.Contains(initialRow, []byte("SENSITIVE_TEST_TOKEN")) {
		t.Fatal("native Event provenance did not resolve to its own masked source row")
	}
	projectSearch()
	children := search("CollectorChildNeedle").Results
	if len(children) != 1 || children[0].SessionID != initial.SessionID || children[0].ThreadID == "root" {
		t.Fatal("native child did not retain a separate Thread in Search")
	}
	var child conversation.Conversation
	decodeResponse(t, send("GET", "/api/v1/sessions/"+initial.SessionID+"?limit=2&thread="+children[0].ThreadID+"&at="+children[0].EventID, "", 200), &child)
	if len(child.Events) != 1 || child.Events[0].Text != "CollectorChildNeedle" {
		t.Fatal("native child Search anchor did not open the actual Thread")
	}
	noop := run("noop")
	if noop.Head != initial.Head || noop.RawCaptureID != initial.RawCaptureID || !bytes.Equal(noop.Records, initial.Records) {
		t.Fatal("unchanged native source allocated another visible version")
	}
	edited := run("edit")
	if edited.Head == initial.Head || len(search("CollectorInitialNeedle").Results) != 0 {
		t.Fatal("native rewrite retained stale selected content or Search eligibility")
	}
	send("GET", "/api/v1/sessions/"+initial.SessionID+"?limit=2&head="+initial.Head, "", 409)
	projectSearch()
	if editedMatches, summaryMatches := len(search("CollectorEditedNeedle").Results), len(search("CollectorSummaryNeedle").Results); editedMatches != 1 || summaryMatches != 1 {
		t.Fatalf("native rewrite did not reach Search: edited=%d summary=%d", editedMatches, summaryMatches)
	}
	rewound := run("rewind")
	read(rewound.SessionID, 1)
	if len(search("CollectorSummaryNeedle").Results) != 0 {
		t.Fatal("rewind did not immediately withdraw the root suffix from Search")
	}
	decodeResponse(t, send("GET", "/api/v1/sessions/"+rewound.SessionID+"?limit=2&thread="+children[0].ThreadID, "", 200), &child)
	if len(child.Events) != 1 || child.Events[0].Text != "CollectorChildNeedle" {
		t.Fatal("rewind changed the native child membership")
	}
	projectSearch()
	if len(search("CollectorChildNeedle").Results) != 1 {
		t.Fatal("rewound target did not retain its child's Search eligibility after indexing")
	}
	unreverted := run("unrevert")
	read(unreverted.SessionID, 5)
	projectSearch()
	if len(search("CollectorSummaryNeedle").Results) != 1 {
		t.Fatal("unrevert did not restore native summary Search eligibility")
	}
	forked := run("fork")
	if forked.ForkSessionID == "" || forked.ForkSessionID == forked.SessionID || forked.Head != unreverted.Head || forked.Observations != 1 {
		t.Fatal("native fork did not become an independent attributed Session")
	}
	read(forked.ForkSessionID, 4)
	setRaw(false)
	off := run("raw-off")
	offReference := firstReference(off.SessionID)
	if !strings.HasPrefix(offReference, "unavailable:") {
		t.Fatal("Canonical captured under Raw-off claimed an archive reference")
	}
	setRaw(true)
	on := run("raw-on")
	if on.Head != off.Head || on.Checkpoint != off.Checkpoint || !bytes.Equal(on.Records, off.Records) || on.RawCaptureID == off.RawCaptureID || !on.RawComplete {
		t.Fatal("fresh Raw after off/on altered historical Canonical provenance")
	}
	if firstReference(on.SessionID) != offReference {
		t.Fatal("fresh Raw mutated the stored Canonical Event reference")
	}
	lost := run("lose-activation")
	actualHead, _ := read(lost.SessionID, 5)
	if actualHead == lost.Head || lost.Pending == 0 {
		t.Fatal("committed activation loss did not retain uncertain local progress")
	}
	recovered := run("recover-activation")
	if recovered.Head != actualHead || recovered.Pending != 0 || !recovered.RawComplete {
		t.Fatal("source-free restart did not recover actual activation and independent Raw")
	}
	observed := run("raw-only")
	if observed.Head != recovered.Head || !bytes.Equal(observed.Records, recovered.Records) || observed.RawCaptureID == recovered.RawCaptureID || observed.Pending == 0 {
		t.Fatal("Raw-only response loss altered Canonical or lost its independent obligation")
	}
	finished := run("recover-raw")
	if finished.Head != recovered.Head || finished.Checkpoint != recovered.Checkpoint || !finished.RawComplete || finished.Pending != 0 {
		t.Fatal("deleted-source Raw recovery did not retain the selected Canonical head")
	}
	read(finished.SessionID, 5)
	if !bytes.Equal(rawMember(initialReference), initialRow) {
		t.Fatal("later source observations changed an existing Event's archived row")
	}
	projectSearch()
	if len(search("CollectorFinalNeedle").Results) != 1 || len(search("CollectorFreshRawNeedle").Results) != 0 {
		t.Fatal("native Canonical/Search and Raw observation concerns were mixed")
	}
	var archive rawarchive.SessionArchive
	decodeResponse(t, send("GET", "/api/v1/sessions/"+finished.SessionID+"/raw", "", 200), &archive)
	var content strings.Builder
	for _, object := range archive.Objects {
		var page rawarchive.ContentPage
		decodeResponse(t, send("GET", "/api/v1/raw-objects/"+object.ObjectID+"/content?limit=1", "", 200), &page)
		if !page.Finalized || page.Generation != 1 || page.NextCursor != "" || len(page.Chunks) != 1 {
			t.Fatal("native Raw object was not one bounded immutable upload")
		}
		decoded, err := base64.StdEncoding.DecodeString(page.Chunks[0].ContentBase64)
		if err != nil {
			t.Fatal(err)
		}
		content.Write(decoded)
	}
	if strings.Contains(content.String(), "SENSITIVE_TEST_TOKEN") || !strings.Contains(content.String(), "CollectorFreshRawNeedle") || !strings.Contains(content.String(), "CollectorInitialNeedle") {
		t.Fatal("Raw recovery lost an observation or bypassed Host masking")
	}
}
