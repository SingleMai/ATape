package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
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
	"github.com/jackc/pgx/v5/pgxpool"
)

func assertCodeBuddyCollectorContract(t *testing.T, h *Handler, modules Modules, pool *pgxpool.Pool, projectID, teamID, userID, credential string, cookie *http.Cookie, csrf string) {
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
	home, artifacts := t.TempDir(), t.TempDir()
	pack := func(directory string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "npm", "pack", "--json", "--pack-destination", artifacts)
		command.Dir = filepath.Join(root, directory)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Fatalf("pack %s: %v\n%s", directory, err, stderr.String())
		}
		var packed []struct {
			Filename string `json:"filename"`
		}
		if err := json.Unmarshal(output, &packed); err != nil || len(packed) != 1 {
			t.Fatalf("decode %s artifact: %v", directory, err)
		}
		return filepath.Join(artifacts, packed[0].Filename)
	}
	tarball, cliTarball := pack("adapters/codebuddy"), pack("apps/cli")
	type snapshot struct {
		SessionID    string          `json:"sessionId"`
		Head         string          `json:"head"`
		Checkpoint   string          `json:"checkpoint"`
		Observations int             `json:"observations"`
		Pending      int             `json:"pending"`
		Records      json.RawMessage `json:"records"`
	}
	run := func(phase string) snapshot {
		t.Helper()
		input, err := json.Marshal(map[string]any{"phase": phase, "origin": origin, "credential": credential, "userId": userID, "home": home, "tarball": tarball, "cliTarball": cliTarball, "projectId": projectID, "teamId": teamID})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "node", "apps/cli/src/runtime/fixtures/codebuddy-collector-contract.ts")
		command.Dir = root
		command.Stdin = bytes.NewReader(input)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Fatalf("CodeBuddy %s: %v\n%s", phase, err, stderr.String())
		}
		var result snapshot
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatalf("CodeBuddy %s output: %v: %s", phase, err, output)
		}
		if result.SessionID == "" || result.Head == "" || result.Checkpoint == "" {
			t.Fatalf("CodeBuddy %s lost durable activation", phase)
		}
		return result
	}
	send := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		addWebProof(request, cookie, csrf)
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != 200 {
			t.Fatalf("CodeBuddy %s: %d %s", path, response.Code, response.Body.String())
		}
		return response
	}
	setRaw := func(enabled bool) {
		preference := "disable"
		if enabled {
			preference = "enable"
		}
		send("PUT", "/api/v1/users/me/raw-capture", `{"preference":"`+preference+`"}`)
	}
	read := func(sessionID string, expected int) (string, []conversation.Event) {
		t.Helper()
		head, after := "", ""
		var events []conversation.Event
		for n := 0; n < 20; n++ {
			query := url.Values{"limit": {"2"}}
			if head != "" {
				query.Set("head", head)
			}
			if after != "" {
				query.Set("after", after)
			}
			var page conversation.Conversation
			decodeResponse(t, send("GET", "/api/v1/sessions/"+sessionID+"?"+query.Encode(), ""), &page)
			if len(page.Events) > 2 || head != "" && page.Head != head {
				t.Fatal("CodeBuddy reader crossed a head or page bound")
			}
			head, after = page.Head, page.NextEventID
			events = append(events, page.Events...)
			if after == "" {
				if len(events) != expected {
					t.Fatalf("CodeBuddy events=%d want=%d", len(events), expected)
				}
				return head, events
			}
		}
		t.Fatal("CodeBuddy reader did not finish")
		return "", nil
	}
	store := postgresadapter.NewStore(pool)
	search := func(term string) projectsearch.Page {
		t.Helper()
		for n := 0; n < 10; n++ {
			count, err := projectsearch.NewProjector(store, store).ProjectOnce(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if count == 0 {
				break
			}
		}
		var page projectsearch.Page
		decodeResponse(t, send("GET", "/api/v1/projects/"+projectID+"/search?q="+url.QueryEscape(term), ""), &page)
		return page
	}
	setRaw(true)
	defer setRaw(false)
	initial := run("initial")
	if initial.Observations != 1 || initial.Pending != 0 {
		t.Fatal("CodeBuddy did not capture exactly the included source")
	}
	head, events := read(initial.SessionID, 12)
	encoded, _ := json.Marshal(events)
	if head != initial.Head || !bytes.Contains(encoded, []byte("ATAPE_CODEBUDDY_TOOL_MARKER_21240")) || !bytes.Contains(encoded, []byte("failed")) {
		t.Fatal("CodeBuddy native text or tool status did not reach the reader")
	}
	if len(search("ATAPE_CODEBUDDY_TOOL_MARKER_21240").Results) == 0 {
		t.Fatal("CodeBuddy native marker did not reach Search")
	}
	noop := run("noop")
	if noop.Head != initial.Head || noop.Observations != 0 || !bytes.Equal(noop.Records, initial.Records) {
		t.Fatal("CodeBuddy unchanged polling changed identity or provenance")
	}
	upgraded := run("upgrade")
	if upgraded.Head != initial.Head || upgraded.Observations > 1 || upgraded.Checkpoint != initial.Checkpoint || !bytes.Equal(upgraded.Records, initial.Records) {
		t.Fatalf("CodeBuddy installed replacement reset progress: head=%t checkpoint=%t observations=%d records=%t", upgraded.Head == initial.Head, upgraded.Checkpoint == initial.Checkpoint, upgraded.Observations, bytes.Equal(upgraded.Records, initial.Records))
	}
	edited := run("edit")
	_, events = read(edited.SessionID, 14)
	encoded, _ = json.Marshal(events)
	if edited.Head == initial.Head || bytes.Contains(encoded, []byte("SENSITIVE_TEST_TOKEN")) || !bytes.Contains(encoded, []byte("CodeBuddyResumeNeedle")) {
		t.Fatal("CodeBuddy resume or shared redaction failed")
	}
	setRaw(false)
	off := run("raw-off")
	if off.Head == edited.Head || len(search("CodeBuddyPolicyNeedle").Results) != 1 {
		t.Fatal("CodeBuddy Raw-off stopped Canonical")
	}
	setRaw(true)
	on := run("raw-on")
	if on.Head != off.Head || !bytes.Equal(on.Records, off.Records) {
		t.Fatal("CodeBuddy Raw re-enable rewrote Canonical provenance")
	}
	lost := run("lose-activation")
	if lost.Pending == 0 {
		t.Fatal("CodeBuddy lost activation did not retain pending recovery")
	}
	recovered := run("recover-activation")
	if recovered.Pending != 0 {
		t.Fatal("CodeBuddy activation did not recover after source deletion")
	}
	_, events = read(recovered.SessionID, 14)
	encoded, _ = json.Marshal(events)
	if !bytes.Contains(encoded, []byte("CodeBuddyFinalNeedle")) {
		t.Fatal("CodeBuddy recovery did not select frozen bytes")
	}
	run("restore")
	rawLost := run("raw-only")
	if rawLost.Pending == 0 {
		t.Fatal("CodeBuddy lost Raw receipt did not retain recovery")
	}
	rawRecovered := run("recover-raw")
	if rawRecovered.Head != recovered.Head || rawRecovered.Pending != 0 {
		t.Fatal("CodeBuddy Raw recovery changed Canonical or remained pending")
	}
	run("restore")
	malformed := run("malformed")
	if malformed.Head != recovered.Head {
		t.Fatal("CodeBuddy incomplete line replaced the previous view")
	}
	repaired := run("repair")
	if repaired.Head != recovered.Head {
		t.Fatal("CodeBuddy repaired source changed unchanged content")
	}
	if len(search("CodeBuddyFinalNeedle").Results) != 1 || len(search("CodeBuddyRawOnlyNeedle").Results) != 0 {
		t.Fatal("CodeBuddy Search mixed Raw with Canonical")
	}
	// A copied root CWD cannot authorize a fork created in another directory.
	foreign := run("fork-foreign")
	if foreign.Head != repaired.Head || foreign.Observations != 0 {
		t.Fatal("CodeBuddy fork was attributed using its copied prefix")
	}
	create := jsonRequest(t, http.MethodPost, "/api/v1/teams/acme/projects", map[string]string{"type": "folder", "name": "CodeBuddy fork"})
	create.Header.Set("Authorization", "Bearer "+credential)
	create.Header.Set("Idempotency-Key", "codebuddy-fork-project-21240")
	created := httptest.NewRecorder()
	h.ServeHTTP(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("create fork Project: %d %s", created.Code, created.Body.String())
	}
	var forkProject projectDTO
	decodeResponse(t, created, &forkProject)
	projectID = forkProject.ID
	fork := run("fork-initial")
	if fork.SessionID == initial.SessionID || fork.Observations != 1 || fork.Pending != 0 {
		t.Fatal("CodeBuddy fork did not receive its own publication identity")
	}
	_, forkEvents := read(fork.SessionID, 16)
	encoded, _ = json.Marshal(forkEvents)
	if !bytes.Contains(encoded, []byte("ATAPE_CODEBUDDY_TOOL_MARKER_21240")) || !bytes.Contains(encoded, []byte("ATAPE_NESTED_FORK_MARKER_21240")) {
		t.Fatal("CodeBuddy fork lost its copied prefix or fork-owned message")
	}
	forkSearch := search("ATAPE_NESTED_FORK_MARKER_21240")
	if len(forkSearch.Results) == 0 {
		t.Fatal("CodeBuddy fork did not reach its own Project Search")
	}
	for _, result := range forkSearch.Results {
		if result.SessionID != fork.SessionID {
			t.Fatal("CodeBuddy fork Search returned another Session")
		}
	}
	resumed := run("fork-resume")
	_, forkEvents = read(resumed.SessionID, 18)
	if resumed.SessionID != fork.SessionID || resumed.Head == fork.Head {
		t.Fatal("CodeBuddy native resume lost the fork's storage identity")
	}
	invalid := run("fork-invalid")
	if invalid.Head != resumed.Head || !bytes.Equal(invalid.Records, resumed.Records) {
		t.Fatal("CodeBuddy invalid fork metadata replaced captured history")
	}
	if fixed := run("fork-repair"); fixed.Head != resumed.Head || fixed.Observations != 0 {
		t.Fatal("CodeBuddy fork metadata repair replayed unchanged content")
	}
	if lost := run("fork-lost"); lost.Pending == 0 {
		t.Fatal("CodeBuddy fork did not retain lost activation recovery")
	}
	recoveredFork := run("fork-recover")
	_, forkEvents = read(recoveredFork.SessionID, 18)
	encoded, _ = json.Marshal(forkEvents)
	if recoveredFork.Pending != 0 || !bytes.Contains(encoded, []byte("CodeBuddyForkFrozenNeedle")) {
		t.Fatal("CodeBuddy fork did not recover after history and metadata deletion")
	}
	if originalHead, _ := read(initial.SessionID, 14); originalHead != repaired.Head {
		t.Fatal("CodeBuddy fork changed the original Session")
	}
	usageSnapshot, err := store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	usageCount := 0
	var inputTokens, outputTokens, cachedTokens int64
	for _, usage := range usageSnapshot.Usage {
		if usage.SessionID == fork.SessionID {
			usageCount++
			if usage.InputTokens != nil {
				inputTokens += *usage.InputTokens
			}
			if usage.OutputTokens != nil {
				outputTokens += *usage.OutputTokens
			}
			if usage.CacheReadTokens != nil {
				cachedTokens += *usage.CacheReadTokens
			}
		}
	}
	if usageCount != 8 || inputTokens != 55032 || outputTokens != 417 || cachedTokens != 22144 {
		t.Fatalf("CodeBuddy copied and resumed usage: records=%d input=%d output=%d cache=%d", usageCount, inputTokens, outputTokens, cachedTokens)
	}
	provenance, found, err := store.ConversationPage(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, fork.SessionID, "root", canonical.ConversationPageRequest{Limit: 1})
	if err != nil || !found || len(provenance.Events) != 1 {
		t.Fatalf("CodeBuddy fork provenance: %v", err)
	}
	objectID, key, valid := strings.Cut(provenance.Events[0].RawRef, "/records/")
	if !valid {
		t.Fatal("CodeBuddy fork lacks exact Raw provenance")
	}
	var raw rawarchive.ContentPage
	decodeResponse(t, send("GET", "/api/v1/raw-objects/"+objectID+"/content?generation=1&limit=1", ""), &raw)
	if len(raw.Chunks) != 1 || raw.NextCursor != "" {
		t.Fatal("CodeBuddy fork Raw page exceeded its bound")
	}
	content, err := base64.StdEncoding.DecodeString(raw.Chunks[0].ContentBase64)
	if err != nil {
		t.Fatal(err)
	}
	var object struct {
		Records map[string]struct {
			Row json.RawMessage `json:"row"`
		} `json:"records"`
	}
	if err := json.Unmarshal(content, &object); err != nil || !bytes.Contains(object.Records[key].Row, []byte("forkedFrom")) {
		t.Fatal("CodeBuddy fork Raw did not retain its native metadata")
	}
	if len(search("CodeBuddyForkFrozenNeedle").Results) == 0 {
		t.Fatal("CodeBuddy recovered fork did not reach Search")
	}
	// Optional local acceptance: keep the real server alive while inspecting its Web reader.
	if review := os.Getenv("ATAPE_CODEBUDDY_REVIEW_FILE"); review != "" {
		payload, err := json.Marshal(map[string]any{"origin": origin, "projectId": projectID, "teamId": teamID, "sessionId": recoveredFork.SessionID, "cookieName": cookie.Name, "cookieValue": cookie.Value})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(review, payload, 0600); err != nil {
			t.Fatal(err)
		}
		defer os.Remove(review)
		deadline := time.NewTimer(3 * time.Minute)
		defer deadline.Stop()
		tick := time.NewTicker(200 * time.Millisecond)
		defer tick.Stop()
	reviewLoop:
		for {
			select {
			case <-t.Context().Done():
				t.Fatal("CodeBuddy browser review canceled")
			case <-deadline.C:
				t.Fatal("CodeBuddy browser review timed out")
			case <-tick.C:
				if _, err := os.Stat(review + ".done"); err == nil {
					os.Remove(review + ".done")
					break reviewLoop
				}
			}
		}
	}

}
