package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
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
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/jackc/pgx/v5/pgxpool"
)

func assertGrokCollectorContract(t *testing.T, h *Handler, modules Modules, pool *pgxpool.Pool) {
	t.Helper()
	project, grant, credential := nativeCollectorActor(t, modules, pool, "grok")
	projectID, teamID, userID, csrf := project.ID, project.TeamID, grant.User.ID, grant.CSRFToken
	cookie := &http.Cookie{Name: "__Secure-atape_session", Value: grant.SessionSecret}
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
	tarball, cliTarball := pack("adapters/grok"), pack("apps/cli")
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
		command := exec.CommandContext(ctx, "node", "apps/cli/src/runtime/fixtures/grok-collector-contract.ts")
		command.Dir = root
		command.Stdin = bytes.NewReader(input)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Fatalf("Grok %s: %v\n%s", phase, err, stderr.String())
		}
		var result snapshot
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatalf("Grok %s output: %v: %s", phase, err, output)
		}
		if result.SessionID == "" || result.Head == "" || result.Checkpoint == "" {
			t.Fatalf("Grok %s lost durable activation", phase)
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
			t.Fatalf("Grok %s: %d %s", path, response.Code, response.Body.String())
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
	read := func(sessionID string, expected int, threadID ...string) (string, []conversation.Event) {
		t.Helper()
		head, after := "", ""
		var events []conversation.Event
		for n := 0; n < 20; n++ {
			query := url.Values{"limit": {"2"}}
			if len(threadID) != 0 {
				query.Set("thread", threadID[0])
			}
			if head != "" {
				query.Set("head", head)
			}
			if after != "" {
				query.Set("after", after)
			}
			var page conversation.Conversation
			decodeResponse(t, send("GET", "/api/v1/sessions/"+sessionID+"?"+query.Encode(), ""), &page)
			if len(page.Events) > 2 || head != "" && page.Head != head {
				t.Fatal("Grok reader crossed a head or page bound")
			}
			head, after = page.Head, page.NextEventID
			events = append(events, page.Events...)
			if after == "" {
				if len(events) != expected {
					t.Fatalf("Grok events=%d want=%d", len(events), expected)
				}
				return head, events
			}
		}
		t.Fatal("Grok reader did not finish")
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
		t.Fatal("Grok did not capture exactly the included source")
	}
	head, events := read(initial.SessionID, 10)
	encoded, _ := json.Marshal(events)
	if head != initial.Head || !bytes.Contains(encoded, []byte("ATAPE_GROK_RESUMED_20260913")) || !bytes.Contains(encoded, []byte("failed")) {
		t.Fatal("Grok native text or tool status did not reach the reader")
	}
	if len(search("ATAPE_GROK_RESUMED_20260913").Results) == 0 {
		t.Fatal("Grok native marker did not reach Search")
	}
	noop := run("noop")
	if noop.Head != initial.Head || noop.Observations != 0 || !bytes.Equal(noop.Records, initial.Records) {
		t.Fatal("Grok unchanged polling changed identity or provenance")
	}
	upgraded := run("upgrade")
	if upgraded.Head != initial.Head || upgraded.Observations > 1 || upgraded.Checkpoint != initial.Checkpoint || !bytes.Equal(upgraded.Records, initial.Records) {
		t.Fatalf("Grok installed replacement reset progress: head=%t checkpoint=%t observations=%d records=%t", upgraded.Head == initial.Head, upgraded.Checkpoint == initial.Checkpoint, upgraded.Observations, bytes.Equal(upgraded.Records, initial.Records))
	}
	edited := run("edit")
	_, events = read(edited.SessionID, 15)
	encoded, _ = json.Marshal(events)
	if edited.Head == initial.Head || bytes.Contains(encoded, []byte("SENSITIVE_TEST_TOKEN")) || !bytes.Contains(encoded, []byte("GrokResumeNeedle")) {
		t.Fatal("Grok resume or shared redaction failed")
	}
	usageSnapshot, err := store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
		time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	var inputTokens, outputTokens, cachedTokens int64
	for _, usage := range usageSnapshot.Usage {
		if usage.SessionID != edited.SessionID {
			continue
		}
		count++
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
	if count != 3 || inputTokens != 82054 || outputTokens != 1169 || cachedTokens != 68096 {
		t.Fatalf("Grok native usage mismatch: count=%d input=%d output=%d cache=%d", count, inputTokens, outputTokens, cachedTokens)
	}
	setRaw(false)
	off := run("raw-off")
	if off.Head == edited.Head || len(search("GrokPolicyNeedle").Results) != 1 {
		t.Fatal("Grok Raw-off stopped Canonical")
	}
	setRaw(true)
	on := run("raw-on")
	if on.Head != off.Head || !bytes.Equal(on.Records, off.Records) {
		t.Fatal("Grok Raw re-enable rewrote Canonical provenance")
	}
	lost := run("lose-activation")
	if lost.Pending == 0 {
		t.Fatal("Grok lost activation did not retain pending recovery")
	}
	recovered := run("recover-activation")
	if recovered.Pending != 0 {
		t.Fatal("Grok activation did not recover after source deletion")
	}
	_, events = read(recovered.SessionID, 15)
	encoded, _ = json.Marshal(events)
	if !bytes.Contains(encoded, []byte("GrokFinalNeedle")) {
		t.Fatal("Grok recovery did not select frozen bytes")
	}
	run("restore")
	rawLost := run("raw-only")
	if rawLost.Pending == 0 {
		t.Fatal("Grok lost Raw receipt did not retain recovery")
	}
	rawRecovered := run("recover-raw")
	if rawRecovered.Head != recovered.Head || rawRecovered.Pending != 0 {
		t.Fatal("Grok Raw recovery changed Canonical or remained pending")
	}
	run("restore")
	malformed := run("malformed")
	if malformed.Head != recovered.Head {
		t.Fatal("Grok incomplete line replaced the previous view")
	}
	repaired := run("repair")
	if repaired.Head != recovered.Head {
		t.Fatal("Grok repaired source changed unchanged content")
	}
	if len(search("GrokFinalNeedle").Results) != 1 || len(search("GrokRawOnlyNeedle").Results) != 0 {
		t.Fatal("Grok Search mixed Raw with Canonical")
	}
	setRaw(false)
	toolCapture := run("tools-initial")
	_, toolEvents := read(toolCapture.SessionID, 11)
	toolJSON, _ := json.Marshal(toolEvents)
	if toolCapture.Observations != 1 || !bytes.Contains(toolJSON, []byte("GrokSearchOutputNeedle")) || bytes.Contains(toolJSON, []byte("SENSITIVE_TEST_TOKEN")) ||
		!bytes.Contains(toolJSON, []byte(`"stdout":"`)) || !bytes.Contains(toolJSON, []byte("version=before")) || !bytes.Contains(toolJSON, []byte("version=after")) {
		t.Fatal("Grok native search/edit details or byte-output masking did not reach Reader with Raw off")
	}
	if matches := len(search("ATAPE_GROK_EDIT_DONE_20260913").Results); matches != 2 || len(search("GrokSearchOutputNeedle").Results) != 0 {
		t.Fatalf("Grok Search must locate the native prompt/reply pair; matches=%d want=2", matches)
	}
	toolNoop := run("tools-noop")
	if toolNoop.Head != toolCapture.Head || toolNoop.Observations != 0 || !bytes.Equal(toolNoop.Records, toolCapture.Records) {
		t.Fatal("Grok search/edit polling changed Event identity or provenance")
	}
	setRaw(true)
	toolRaw := run("tools-raw-on")
	if toolRaw.Head != toolCapture.Head || !bytes.Equal(toolRaw.Records, toolCapture.Records) {
		t.Fatal("Grok search/edit Raw enablement changed Canonical provenance")
	}

	for _, fork := range []struct {
		prefix, marker                          string
		initialEvents, resumedEvents, usageRows int
		input, output, cache                    int64
	}{
		{"fork", "ATAPE_GROK_FORK_BRANCH_20260914", 10, 12, 3, 31366, 806, 19072},
		{"nested", "ATAPE_GROK_NESTED_FORK_20260914", 14, 16, 5, 44309, 835, 25664},
		{"modern-fork", "ATAPE_GROK_1030_FORK", 9, 11, 4, 32324, 406, 13312},
		{"modern-nested", "ATAPE_GROK_1030_NESTED", 13, 15, 6, 46056, 441, 14656},
		{"compact", "ATAPE_GROK_PINNED_CONTEXT_4_20260915", 13, 21, 9, 102493, 8161, 38016},
	} {
		t.Run(fork.prefix, func(t *testing.T) {
			capture := func(phase string) snapshot { t.Helper(); return run(fork.prefix + "-" + phase) }
			setRaw(true)
			initial := capture("initial")
			_, original := read(initial.SessionID, fork.initialEvents)
			if initial.Observations != 1 || initial.Pending != 0 || len(search(fork.marker).Results) == 0 {
				t.Fatal("Grok fork original attribution, copied history or Search failed")
			}
			for _, phase := range []string{"noop", "upgrade"} {
				next := capture(phase)
				if next.Head != initial.Head || next.Checkpoint != initial.Checkpoint || !bytes.Equal(next.Records, initial.Records) {
					t.Fatalf("Grok fork %s changed stable progress or provenance", phase)
				}
			}
			resumed := capture("edit")
			_, events := read(resumed.SessionID, fork.resumedEvents)
			for i, event := range original {
				if events[i].ID != event.ID || events[i].OccurredAt != event.OccurredAt {
					t.Fatal("Grok fork resume changed copied Event identity or native time")
				}
			}
			if fork.prefix == "compact" {
				var page conversation.Conversation
				decodeResponse(t, send("GET", "/api/v1/sessions/"+resumed.SessionID+"?limit=2", ""), &page)
				commands := 0
				for _, event := range events {
					if strings.HasPrefix(event.Text, "/compact ") {
						commands++
					}
				}
				if page.Session.CaptureStatus != "partial" || page.Thread.CaptureStatus != "partial" || commands != 3 {
					t.Fatal("Grok compaction lost host commands or failed-command partial status")
				}
			}
			encoded, _ := json.Marshal(events)
			if resumed.Head == initial.Head || bytes.Contains(encoded, []byte("SENSITIVE_TEST_TOKEN")) || bytes.Contains(encoded, []byte("ATAPE_GROK_PARENT_LATER_20260914")) {
				t.Fatal("Grok fork resume mixed secrets or later parent history")
			}
			usage, err := store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
				time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
			if err != nil {
				t.Fatal(err)
			}
			count := 0
			var input, output, cache int64
			for _, row := range usage.Usage {
				if row.SessionID != resumed.SessionID {
					continue
				}
				count++
				if row.InputTokens != nil {
					input += *row.InputTokens
				}
				if row.OutputTokens != nil {
					output += *row.OutputTokens
				}
				if row.CacheReadTokens != nil {
					cache += *row.CacheReadTokens
				}
			}
			if count != fork.usageRows || input != fork.input || output != fork.output || cache != fork.cache {
				t.Fatalf("Grok fork history usage mismatch: count=%d input=%d output=%d cache=%d", count, input, output, cache)
			}
			// The established fork profile exercises all frozen-delivery faults.
			// Modern forks share that Interface; this increment adds native compatibility.
			if strings.HasPrefix(fork.prefix, "modern-") {
				return
			}
			setRaw(false)
			off := capture("raw-off")
			if off.Head == resumed.Head {
				t.Fatal("Grok fork Raw-off stopped Canonical")
			}
			setRaw(true)
			on := capture("raw-on")
			if on.Head != off.Head || !bytes.Equal(on.Records, off.Records) {
				t.Fatal("Grok fork Raw re-enable changed provenance")
			}
			lost := capture("lose-activation")
			if lost.Pending == 0 {
				t.Fatal("Grok fork lost activation discarded recovery")
			}
			recovered := capture("recover-activation")
			_, finalEvents := read(recovered.SessionID, fork.resumedEvents)
			if recovered.Pending != 0 || finalEvents[len(finalEvents)-1].Text != "GrokFinalNeedle" {
				t.Fatal("Grok fork frozen activation did not recover after source deletion")
			}
			capture("restore")
			rawLost := capture("raw-only")
			if rawLost.Pending == 0 {
				t.Fatal("Grok fork lost Raw receipt discarded recovery")
			}
			rawRecovered := capture("recover-raw")
			if rawRecovered.Head != recovered.Head || rawRecovered.Pending != 0 {
				t.Fatal("Grok fork Raw recovery changed Canonical")
			}
			capture("restore")
			invalid := capture("unsupported")
			if invalid.Head != recovered.Head {
				t.Fatal("Grok inconsistent fork lineage replaced captured history")
			}
			if repaired := capture("repair"); repaired.Head != recovered.Head {
				t.Fatal("Grok fork repair changed unchanged history")
			}
			if len(search("GrokRawOnlyNeedle").Results) != 0 {
				t.Fatal("Grok fork Search included Raw-only content")
			}
		})
	}

	if review := os.Getenv("ATAPE_GROK_REVIEW_FILE"); review != "" {
		payload, err := json.Marshal(map[string]any{"origin": origin, "projectId": projectID, "teamId": teamID, "sessionId": recovered.SessionID, "toolsSessionId": toolCapture.SessionID, "cookieName": cookie.Name, "cookieValue": cookie.Value})
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
				t.Fatal("Grok browser review canceled")
			case <-deadline.C:
				t.Fatal("Grok browser review timed out")
			case <-tick.C:
				if _, err := os.Stat(review + ".done"); err == nil {
					os.Remove(review + ".done")
					break reviewLoop
				}
			}
		}
	}

	createGit := jsonRequest(t, http.MethodPost, "/api/v1/teams/grok-contract/projects", map[string]string{"type": "git", "remote": "https://github.com/atape-fixtures/grok-native.git"})
	addWebProof(createGit, cookie, csrf)
	createGit.Header.Set("Idempotency-Key", "grok-worktree-project-103")
	gitResponse := httptest.NewRecorder()
	h.ServeHTTP(gitResponse, createGit)
	if gitResponse.Code != http.StatusCreated {
		t.Fatalf("Grok Git project: %d %s", gitResponse.Code, gitResponse.Body.String())
	}
	var gitProject projectDTO
	decodeResponse(t, gitResponse, &gitProject)
	projectID = gitProject.ID
	gitCapture := run("git-initial")
	_, gitEvents := read(gitCapture.SessionID, 2)
	if gitCapture.Observations != 1 || gitEvents[1].Text != "ATAPE_GROK_WORKTREE_20260913" || len(search("ATAPE_GROK_WORKTREE_20260913").Results) != 2 {
		t.Fatal("Grok native worktree attribution or Reader/Search failed")
	}
	gitNoop := run("git-noop")
	if gitNoop.Head != gitCapture.Head || gitNoop.Observations != 0 {
		t.Fatal("Grok Git duplicate collection changed history")
	}
	moved := run("git-relocated")
	if moved.Head == gitCapture.Head || len(search("GrokGitMovedNeedle").Results) != 1 {
		t.Fatal("Grok lost durable original attribution after checkout/worktree deletion")
	}
}
