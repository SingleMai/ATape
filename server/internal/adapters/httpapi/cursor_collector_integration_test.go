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
	"sync/atomic"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The native executable and its JSONL are explicitly synthetic. Start, receipt
// creation, installed factory/daemon, HTTP, PostgreSQL and reads are production.
func assertCursorCollectorContract(t *testing.T, modules Modules, pool *pgxpool.Pool) {
	t.Helper()
	project, grant, credential := nativeCollectorActor(t, modules, pool, "cursor")
	cookie := &http.Cookie{Name: "atape_session_dev", Value: grant.SessionSecret}
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	home, artifacts := t.TempDir(), t.TempDir()
	home, err = filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	lossMarker := filepath.Join(home, "committed-activation.json")
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	handler, err := NewHandler(Config{InstanceOrigin: origin, WebOrigin: origin, APIOrigin: origin, DevelopmentAllowHTTP: true}, modules)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	var puts, rawUploads atomic.Int64
	var loseActivation, committed atomic.Bool
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/publications/attempts/") {
			puts.Add(1)
		}
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ingestion/raw/chunks") {
			rawUploads.Add(1)
		}
		if loseActivation.Load() && committed.Load() && strings.Contains(r.URL.Path, "/publications/") {
			http.Error(w, "Controlled unavailable activation receipt", http.StatusServiceUnavailable)
			return
		}
		if loseActivation.Load() && r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/activate") {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, r)
			if response.Code == http.StatusOK && committed.CompareAndSwap(false, true) {
				var proof publication.Activation
				if err := json.Unmarshal(response.Body.Bytes(), &proof); err != nil || proof.Head == "" {
					t.Errorf("committed Cursor activation: %s %v", response.Body.String(), err)
				}
				markerTemporary := lossMarker + ".tmp"
				if err := os.WriteFile(markerTemporary, response.Body.Bytes(), 0600); err != nil {
					t.Error(err)
				}
				if err := os.Rename(markerTemporary, lossMarker); err != nil {
					t.Error(err)
				}
				connection, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				_ = connection.Close() // Actual commit succeeded; no response reaches the installed CLI.
				return
			}
			for key, values := range response.Header() {
				w.Header()[key] = values
			}
			w.WriteHeader(response.Code)
			_, _ = w.Write(response.Body.Bytes())
			return
		}
		handler.ServeHTTP(w, r)
	})
	server.Start()
	defer server.Close()
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
		var result []struct {
			Filename string `json:"filename"`
		}
		if err := json.Unmarshal(output, &result); err != nil || len(result) != 1 {
			t.Fatalf("pack %s output: %s %v", directory, output, err)
		}
		return filepath.Join(artifacts, result[0].Filename)
	}
	tarball, cliTarball := os.Getenv("ATAPE_CURSOR_CONTRACT_TARBALL"), os.Getenv("ATAPE_CURSOR_CONTRACT_CLI_TARBALL")
	if tarball == "" && cliTarball == "" {
		tarball, cliTarball = pack("adapters/cursor"), pack("apps/cli")
	} else {
		for _, artifact := range []string{tarball, cliTarball} {
			info, err := os.Stat(artifact)
			if !filepath.IsAbs(artifact) || err != nil || !info.Mode().IsRegular() {
				t.Fatalf("Cursor contract requires both absolute regular packed artifacts: %s %v", artifact, err)
			}
		}
	}
	type snapshot struct {
		SessionID   string          `json:"sessionId"`
		Head        string          `json:"head"`
		SourceID    string          `json:"sourceId"`
		Checkpoint  string          `json:"checkpoint"`
		Pending     int             `json:"pending"`
		Records     json.RawMessage `json:"records"`
		RawComplete bool            `json:"rawComplete"`
		Job         struct {
			State          string `json:"state"`
			SourceFailures []struct {
				Reason string `json:"reason"`
			} `json:"sourceFailures"`
		} `json:"job"`
		PTYResults []struct {
			ExitCode          int  `json:"exitCode"`
			TerminalRestored  bool `json:"terminalRestored"`
			ChildJoined       bool `json:"childJoined"`
			ManagedDelegation bool `json:"managedDelegation"`
		} `json:"ptyResults"`
	}
	invoke := func(phase string) ([]byte, error) {
		input, err := json.Marshal(map[string]any{"phase": phase, "origin": origin, "credential": credential, "userId": grant.User.ID,
			"home": home, "tarball": tarball, "cliTarball": cliTarball, "projectId": project.ID, "projectCreatedAt": project.CreatedAt, "teamId": project.TeamID, "lossMarker": lossMarker})
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "node", "apps/cli/scripts/cursor-collector-contract.ts")
		command.Dir, command.Stdin = root, bytes.NewReader(input)
		// The composition helper's os.homedir() must be isolated too. Passing a
		// different HOME only to installed children is insufficient for OS Layers.
		command.Env = append(os.Environ(), "HOME="+filepath.Join(home, "user"), "XDG_CONFIG_HOME="+filepath.Join(home, "xdg-config"),
			"XDG_DATA_HOME="+filepath.Join(home, "xdg-data"), "XDG_STATE_HOME="+filepath.Join(home, "xdg-state"))
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			return nil, &cursorFixtureError{phase: phase, cause: err, output: stderr.String()}
		}
		return output, nil
	}
	t.Cleanup(func() {
		if _, err := invoke("cleanup"); err != nil {
			t.Error(err)
		}
	})
	run := func(phase string) snapshot {
		t.Helper()
		output, err := invoke(phase)
		if err != nil {
			t.Fatal(err)
		}
		var result snapshot
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatalf("Cursor %s output: %s %v", phase, output, err)
		}
		if result.SessionID == "" || result.Head == "" || result.Checkpoint == "" {
			t.Fatalf("Cursor %s lost durable identity: %s", phase, output)
		}
		return result
	}
	send := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		addWebProof(request, cookie, grant.CSRFToken)
		request.Header.Set("Origin", origin)
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 200 {
			t.Fatalf("Cursor %s %s: %d %s", method, path, response.Code, response.Body.String())
		}
		return response
	}
	setRaw := func(enabled bool) {
		value := "disable"
		if enabled {
			value = "enable"
		}
		send("PUT", "/api/v1/users/me/raw-capture", `{"preference":"`+value+`"}`)
	}
	store := postgresadapter.NewStore(pool)
	read := func(sessionID string, expected int) (string, []conversation.Event) {
		t.Helper()
		head, after := "", ""
		var events []conversation.Event
		for range 20 {
			query := url.Values{"limit": {"2"}}
			if head != "" {
				query.Set("head", head)
			}
			if after != "" {
				query.Set("after", after)
			}
			response := send("GET", "/api/v1/sessions/"+sessionID+"?"+query.Encode(), "")
			var page conversation.Conversation
			decodeResponse(t, response, &page)
			if page.Session.UpdatedAt != nil || !bytes.Contains(response.Body.Bytes(), []byte(`"updatedAt":null`)) {
				t.Fatal("Cursor invented Session source time")
			}
			if page.Session.Status != "idle" || page.Session.CaptureStatus != "partial" || page.Thread.ParentThreadID != nil || len(page.ThreadPath) != 1 {
				t.Fatalf("Cursor invented lifecycle/topology: %+v", page)
			}
			if head != "" && head != page.Head {
				t.Fatal("Cursor reader crossed publication heads")
			}
			head, after = page.Head, page.NextEventID
			for _, event := range page.Events {
				if event.OccurredAt != nil || event.ChildThread != nil {
					t.Fatal("Cursor invented Event time/child")
				}
				if event.Tool != nil && (event.Tool.Status != nil || event.Tool.RawOutput != nil) {
					t.Fatal("Cursor invented tool outcome")
				}
			}
			if len(page.Events) > 0 && bytes.Count(response.Body.Bytes(), []byte(`"occurredAt":null`)) != len(page.Events) {
				t.Fatal("Cursor Reader omitted explicit null Event clocks")
			}
			events = append(events, page.Events...)
			if after == "" {
				if len(events) != expected {
					t.Fatalf("Cursor Events=%d want=%d", len(events), expected)
				}
				return head, events
			}
		}
		t.Fatal("Cursor reader pagination did not finish")
		return "", nil
	}
	search := func(term string) projectsearch.Page {
		t.Helper()
		for range 20 {
			n, err := projectsearch.NewProjector(store, store).ProjectOnce(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if n == 0 {
				break
			}
		}
		response := send("GET", "/api/v1/projects/"+project.ID+"/search?q="+url.QueryEscape(term), "")
		var page projectsearch.Page
		decodeResponse(t, response, &page)
		for _, result := range page.Results {
			if result.OccurredAt != nil {
				t.Fatal("Cursor Search invented source time")
			}
		}
		if bytes.Count(response.Body.Bytes(), []byte(`"occurredAt":null`)) != len(page.Results) {
			t.Fatal("Cursor Search omitted explicit null clocks")
		}
		return page
	}
	assertRaw := func(sessionID, needle string) {
		t.Helper()
		var archive rawarchive.SessionArchive
		decodeResponse(t, send("GET", "/api/v1/sessions/"+sessionID+"/raw?limit=100", ""), &archive)
		if len(archive.Objects) == 0 || archive.NextCursor != "" {
			t.Fatal("Cursor Raw fixture inventory was empty or unexpectedly paginated")
		}
		var content []byte
		for _, object := range archive.Objects {
			cursor := ""
			for range 20 {
				path := "/api/v1/raw-objects/" + object.ObjectID + "/content?generation=1&limit=8"
				if cursor != "" {
					path += "&cursor=" + url.QueryEscape(cursor)
				}
				var page rawarchive.ContentPage
				decodeResponse(t, send("GET", path, ""), &page)
				for _, chunk := range page.Chunks {
					decoded, err := base64.StdEncoding.DecodeString(chunk.ContentBase64)
					if err != nil {
						t.Fatal(err)
					}
					if !json.Valid(decoded) {
						t.Fatal("Cursor Raw is not structured JSON")
					}
					content = append(content, decoded...)
				}
				cursor = page.NextCursor
				if cursor == "" {
					break
				}
			}
			if cursor != "" {
				t.Fatal("Cursor Raw content pagination did not finish")
			}
		}
		if !bytes.Contains(content, []byte(needle)) || bytes.Contains(content, []byte("CursorPrivateFixtureToken_0115")) || !bytes.Contains(content, []byte("REDACTED")) {
			t.Fatalf("Cursor HTTP Raw fidelity/redaction failed: %s", content)
		}
	}
	setRaw(true)
	defer setRaw(false)
	initial := run("initial")
	if len(initial.PTYResults) != 4 {
		t.Fatal("Cursor installed PTY cases missing")
	}
	for i, result := range initial.PTYResults {
		expected := []int{0, 7, 130, 130}[i]
		if result.ExitCode != expected || !result.TerminalRestored || !result.ChildJoined || result.ManagedDelegation != (i == 3) {
			t.Fatalf("Cursor PTY %d: %+v", i, result)
		}
	}
	if initial.Pending != 0 || !initial.RawComplete {
		t.Fatal("Cursor initial capture did not settle")
	}
	_, events := read(initial.SessionID, 3)
	original := append([]conversation.Event(nil), events...)
	encoded, _ := json.Marshal(events)
	preservedWrapper := false
	for _, event := range events {
		preservedWrapper = preservedWrapper || strings.Contains(event.Text, "<user_query>\nCursorStartNeedle 中文 ") && strings.Contains(event.Text, "\n</user_query>")
	}
	if bytes.Contains(encoded, []byte("CursorPrivateFixtureToken_0115")) || !preservedWrapper {
		t.Fatalf("Cursor Canonical fidelity/redaction: %s", encoded)
	}
	if len(search("CursorStartNeedle").Results) != 1 || len(search("UnattributedCursorHistoryNeedle").Results) != 0 {
		t.Fatal("Cursor unknown-time Search/history attribution failed")
	}
	assertRaw(initial.SessionID, "CursorRawFutureNeedle")
	for _, phase := range []string{"noop", "rewrite"} {
		beforePuts, beforeRaw := puts.Load(), rawUploads.Load()
		current := run(phase)
		if current.Head != initial.Head || current.Checkpoint != initial.Checkpoint || !bytes.Equal(current.Records, initial.Records) || puts.Load() != beforePuts || rawUploads.Load() != beforeRaw {
			t.Fatalf("Cursor %s changed acknowledged identity", phase)
		}
	}
	one := run("append-one")
	_, events = read(one.SessionID, 5)
	two := run("append-two")
	_, events = read(two.SessionID, 7)
	for i, event := range original {
		if events[i].ID != event.ID || events[i].OccurredAt != nil || events[i].Text != event.Text {
			t.Fatal("Cursor append changed prefix identity")
		}
	}
	setRaw(false)
	beforeRaw := rawUploads.Load()
	off := run("raw-off")
	if rawUploads.Load() != beforeRaw || off.Head == two.Head {
		t.Fatal("Cursor Raw-off blocked Canonical or uploaded Raw")
	}
	read(off.SessionID, 9)
	setRaw(true)
	beforePuts := puts.Load()
	on := run("raw-on")
	if on.Head != off.Head || on.Checkpoint != off.Checkpoint || puts.Load() != beforePuts || rawUploads.Load() == beforeRaw || !on.RawComplete {
		t.Fatal("Cursor v3 Raw-only changed Canonical or failed to attach")
	}
	assertRaw(on.SessionID, "CursorRawOffNeedle")
	changed := run("changed")
	if changed.Head != on.Head || changed.Checkpoint != on.Checkpoint {
		t.Fatal("Cursor nonprefix rewrite replaced published head")
	}
	foundChanged := false
	for _, failure := range changed.Job.SourceFailures {
		foundChanged = foundChanged || failure.Reason == "changed"
	}
	if !foundChanged {
		t.Fatal("Cursor nonprefix rewrite lacked changed diagnostic")
	}
	loseActivation.Store(true)
	lost := run("loss")
	if !committed.Load() || lost.Pending == 0 || lost.Checkpoint != on.Checkpoint {
		t.Fatal("Cursor committed response loss did not retain old checkpoint/pending")
	}
	var proof publication.Activation
	body, err := os.ReadFile(lossMarker)
	if err != nil || json.Unmarshal(body, &proof) != nil || proof.Head == on.Head {
		t.Fatalf("Cursor committed head proof: %s %v", body, err)
	}
	loseActivation.Store(false)
	beforePuts = puts.Load()
	recovered := run("recover")
	if recovered.Pending != 0 || recovered.Head != proof.Head || recovered.Checkpoint == on.Checkpoint || puts.Load() != beforePuts {
		t.Fatal("Cursor frozen recovery changed committed head or retransmitted Canonical")
	}
	read(recovered.SessionID, 11)
	if len(search("CursorFrozenRecoveryNeedle").Results) != 1 {
		t.Fatal("Cursor frozen content was not searchable after source deletion")
	}
	assertRaw(recovered.SessionID, "CursorFrozenRecoveryNeedle")
	overview, err := store.Overview(t.Context(), authentication.Principal{UserID: grant.User.ID, Method: authentication.WebAuthentication}, project.TeamID, time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
	if err != nil || len(overview.Usage) != 0 || overview.UnknownTimeSessions != 1 {
		t.Fatalf("Cursor fabricated usage or lost unknown disclosure: %+v %v", overview, err)
	}
}

type cursorFixtureError struct {
	phase  string
	cause  error
	output string
}

func (e *cursorFixtureError) Error() string {
	return "Cursor " + e.phase + ": " + e.cause.Error() + "\n" + e.output
}
