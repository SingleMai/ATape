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

func assertKimiCollectorContract(t *testing.T, h *Handler, modules Modules, pool *pgxpool.Pool, projectID, teamID, userID, credential string, cookie *http.Cookie, csrf string) {
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
	tarball, cliTarball := pack("adapters/kimi"), pack("apps/cli")
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
		command := exec.CommandContext(ctx, "node", "apps/cli/src/runtime/fixtures/kimi-collector-contract.ts")
		command.Dir = root
		command.Stdin = bytes.NewReader(input)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Fatalf("Kimi %s: %v\n%s", phase, err, stderr.String())
		}
		var result snapshot
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatalf("Kimi %s output: %v: %s", phase, err, output)
		}
		if result.SessionID == "" || result.Head == "" || result.Checkpoint == "" {
			t.Fatalf("Kimi %s lost durable activation", phase)
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
			t.Fatalf("Kimi %s: %d %s", path, response.Code, response.Body.String())
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
				t.Fatal("Kimi reader crossed a head or page bound")
			}
			head, after = page.Head, page.NextEventID
			events = append(events, page.Events...)
			if after == "" {
				if len(events) != expected {
					t.Fatalf("Kimi events=%d want=%d", len(events), expected)
				}
				return head, events
			}
		}
		t.Fatal("Kimi reader did not finish")
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
		t.Fatal("Kimi did not capture exactly the included source")
	}
	head, events := read(initial.SessionID, 13)
	encoded, _ := json.Marshal(events)
	if head != initial.Head || !bytes.Contains(encoded, []byte("ATAPE_KIMI_TOOL_MARKER_0420")) || !bytes.Contains(encoded, []byte("failed")) {
		t.Fatal("Kimi native text or tool status did not reach the reader")
	}
	if len(search("ATAPE_KIMI_TOOL_MARKER_0420").Results) == 0 {
		t.Fatal("Kimi native marker did not reach Search")
	}
	noop := run("noop")
	if noop.Head != initial.Head || noop.Observations != 0 || !bytes.Equal(noop.Records, initial.Records) {
		t.Fatal("Kimi unchanged polling changed identity or provenance")
	}
	upgraded := run("upgrade")
	if upgraded.Head != initial.Head || upgraded.Observations > 1 || upgraded.Checkpoint != initial.Checkpoint || !bytes.Equal(upgraded.Records, initial.Records) {
		t.Fatalf("Kimi installed replacement reset progress: head=%t checkpoint=%t observations=%d records=%t", upgraded.Head == initial.Head, upgraded.Checkpoint == initial.Checkpoint, upgraded.Observations, bytes.Equal(upgraded.Records, initial.Records))
	}
	edited := run("edit")
	_, events = read(edited.SessionID, 15)
	encoded, _ = json.Marshal(events)
	if edited.Head == initial.Head || bytes.Contains(encoded, []byte("SENSITIVE_TEST_TOKEN")) || !bytes.Contains(encoded, []byte("KimiResumeNeedle")) {
		t.Fatal("Kimi resume or shared redaction failed")
	}
	setRaw(false)
	off := run("raw-off")
	if off.Head == edited.Head || len(search("KimiPolicyNeedle").Results) != 1 {
		t.Fatal("Kimi Raw-off stopped Canonical")
	}
	setRaw(true)
	on := run("raw-on")
	if on.Head != off.Head || !bytes.Equal(on.Records, off.Records) {
		t.Fatal("Kimi Raw re-enable rewrote Canonical provenance")
	}
	lost := run("lose-activation")
	if lost.Pending == 0 {
		t.Fatal("Kimi lost activation did not retain pending recovery")
	}
	recovered := run("recover-activation")
	if recovered.Pending != 0 {
		t.Fatal("Kimi activation did not recover after source deletion")
	}
	_, events = read(recovered.SessionID, 15)
	encoded, _ = json.Marshal(events)
	if !bytes.Contains(encoded, []byte("KimiFinalNeedle")) {
		t.Fatal("Kimi recovery did not select frozen bytes")
	}
	run("restore")
	rawLost := run("raw-only")
	if rawLost.Pending == 0 {
		t.Fatal("Kimi lost Raw receipt did not retain recovery")
	}
	rawRecovered := run("recover-raw")
	if rawRecovered.Head != recovered.Head || rawRecovered.Pending != 0 {
		t.Fatal("Kimi Raw recovery changed Canonical or remained pending")
	}
	run("restore")
	malformed := run("malformed")
	if malformed.Head != recovered.Head {
		t.Fatal("Kimi incomplete line replaced the previous view")
	}
	repaired := run("repair")
	if repaired.Head != recovered.Head {
		t.Fatal("Kimi repaired source changed unchanged content")
	}
	if len(search("KimiFinalNeedle").Results) != 1 || len(search("KimiRawOnlyNeedle").Results) != 0 {
		t.Fatal("Kimi Search mixed Raw with Canonical")
	}
	unsupported := run("unsupported")
	if unsupported.Head != recovered.Head || unsupported.Checkpoint != repaired.Checkpoint {
		t.Fatal("Kimi unsupported source replaced history or progress")
	}
	run("repair")
	usageSnapshot, err := store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	usageCount := 0
	var inputTokens, outputTokens, cachedTokens int64
	for _, usage := range usageSnapshot.Usage {
		if usage.SessionID == initial.SessionID {
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
	if usageCount != 5 || inputTokens != 540 || outputTokens != 54 || cachedTokens != 100 {
		t.Fatalf("Kimi native usage: records=%d input=%d output=%d cache=%d", usageCount, inputTokens, outputTokens, cachedTokens)
	}
	provenance, found, err := store.ConversationPage(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, initial.SessionID, "root", canonical.ConversationPageRequest{Limit: 1})
	if err != nil || !found || len(provenance.Events) != 1 {
		t.Fatalf("Kimi fork provenance: %v", err)
	}
	objectID, key, valid := strings.Cut(provenance.Events[0].RawRef, "/records/")
	if !valid {
		t.Fatal("Kimi fork lacks exact Raw provenance")
	}
	var raw rawarchive.ContentPage
	decodeResponse(t, send("GET", "/api/v1/raw-objects/"+objectID+"/content?generation=1&limit=1", ""), &raw)
	if len(raw.Chunks) != 1 || raw.NextCursor != "" {
		t.Fatal("Kimi fork Raw page exceeded its bound")
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
	if err := json.Unmarshal(content, &object); err != nil || !bytes.Contains(object.Records[key].Row, []byte("context.append_message")) {
		t.Fatal("Kimi Raw did not retain its native message")
	}
	assertUsage := func(sessionID string, count int, input, output, cache int64) {
		t.Helper()
		snapshot, err := store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
			time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		n, in, out, cached := 0, int64(0), int64(0), int64(0)
		for _, usage := range snapshot.Usage {
			if usage.SessionID != sessionID {
				continue
			}
			n++
			if usage.Model != "atape-context-model" {
				t.Fatalf("Kimi compaction attributed to model alias: %s", usage.Model)
			}
			if usage.InputTokens != nil {
				in += *usage.InputTokens
			}
			if usage.OutputTokens != nil {
				out += *usage.OutputTokens
			}
			if usage.CacheReadTokens != nil {
				cached += *usage.CacheReadTokens
			}
		}
		if n != count || in != input || out != output || cached != cache {
			t.Fatalf("Kimi context usage: records=%d input=%d output=%d cache=%d", n, in, out, cached)
		}
	}
	seed := run("context-seed")
	_, seedEvents := read(seed.SessionID, 4)
	if len(search("KimiContextReply2").Results) != 1 {
		t.Fatal("Kimi pre-undo reply missing from Search")
	}
	undoLost := run("context-undo")
	if undoLost.Pending == 0 {
		t.Fatal("Kimi undo activation loss did not remain recoverable")
	}
	undo := run("context-recover")
	undoHead, undoEvents := read(seed.SessionID, 2)
	if undo.Pending != 0 || undo.Head != undoHead || undo.Head == seed.Head {
		t.Fatal("Kimi undo failed to recover after source deletion")
	}
	beforeJSON, _ := json.Marshal(seedEvents[:2])
	afterJSON, _ := json.Marshal(undoEvents)
	if !bytes.Equal(beforeJSON, afterJSON) {
		t.Fatal("Kimi undo changed retained message identity or provenance")
	}
	if len(search("KimiContextReply2").Results) != 0 {
		t.Fatal("Kimi undone reply remained searchable")
	}
	assertUsage(seed.SessionID, 2, 203, 23, 40)
	run("context-restore")
	compact := run("context-compact")
	_, compactEvents := read(seed.SessionID, 4)
	assertUsage(seed.SessionID, 4, 410, 50, 80)
	if len(search("KimiContextReply3").Results) != 1 || len(search("KimiContextReply4").Results) != 0 {
		t.Fatal("Kimi compaction changed reader history or indexed its internal summary")
	}
	postUndo := run("context-afterundo")
	_, postEvents := read(seed.SessionID, 4)
	beforeJSON, _ = json.Marshal(compactEvents)
	afterJSON, _ = json.Marshal(postEvents)
	if !bytes.Equal(beforeJSON, afterJSON) || postUndo.Head == compact.Head {
		t.Fatal("Kimi post-compaction undo changed retained messages or lost new expenditure")
	}
	assertUsage(seed.SessionID, 5, 515, 65, 100)
	setRaw(false)
	finalContext := run("context-final")
	_, finalEvents := read(seed.SessionID, 6)
	assertUsage(seed.SessionID, 7, 728, 98, 140)
	encoded, _ = json.Marshal(finalEvents)
	for _, absent := range []string{"KimiUndoBefore", "KimiUndoAfter", "KimiContextReply2", "KimiContextReply4", "KimiContextReply5", "KimiContextReply7"} {
		if bytes.Contains(encoded, []byte(absent)) {
			t.Fatalf("Kimi hidden context became a visible Event: %s", absent)
		}
	}
	if len(search("KimiContextReply6").Results) != 1 || len(search("KimiContextReply7").Results) != 0 {
		t.Fatal("Kimi second compaction or Raw-off search failed")
	}
	setRaw(true)
	contextOn := run("context-raw-on")
	if contextOn.Head != finalContext.Head || !bytes.Equal(contextOn.Records, finalContext.Records) {
		t.Fatal("Kimi context Raw-on changed Canonical provenance")
	}
	incomplete := run("context-incomplete")
	if incomplete.Head != finalContext.Head || incomplete.Checkpoint != contextOn.Checkpoint {
		t.Fatal("Kimi unfinished compaction replaced the published target")
	}
	run("context-final")
	contextRawLost := run("context-raw-loss")
	if contextRawLost.Pending == 0 {
		t.Fatal("Kimi compaction Raw response loss was not recoverable")
	}
	contextRawRecovered := run("context-recover-raw")
	if contextRawRecovered.Pending != 0 || contextRawRecovered.Head != finalContext.Head {
		t.Fatal("Kimi compaction Raw recovery changed history")
	}
	if len(search("KimiCompactionRawOnly").Results) != 0 {
		t.Fatal("Kimi compaction Raw leaked into Search")
	}
	auto := run("auto")
	read(auto.SessionID, 4)
	assertUsage(auto.SessionID, 3, 190205, 36, 60)
	clear := run("clear")
	if clear.SessionID == seed.SessionID || clear.SessionID == auto.SessionID {
		t.Fatal("Kimi /clear reused another Session identity")
	}
	read(clear.SessionID, 2)
	assertUsage(clear.SessionID, 1, 108, 18, 20)
	retainedHead, _ := read(seed.SessionID, 6)
	if retainedHead != finalContext.Head || len(search("KimiKeepAfter").Results) == 0 || len(search("KimiNewAfterClear").Results) == 0 {
		t.Fatal("Kimi /clear or source deletion removed captured history")
	}
	// Optional local acceptance: keep the real server alive while inspecting its Web reader.
	if review := os.Getenv("ATAPE_KIMI_REVIEW_FILE"); review != "" {
		payload, err := json.Marshal(map[string]any{"origin": origin, "projectId": projectID, "teamId": teamID, "sessionId": seed.SessionID, "autoSessionId": auto.SessionID, "clearSessionId": clear.SessionID, "cookieName": cookie.Name, "cookieValue": cookie.Value})
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
				t.Fatal("Kimi browser review canceled")
			case <-deadline.C:
				t.Fatal("Kimi browser review timed out")
			case <-tick.C:
				if _, err := os.Stat(review + ".done"); err == nil {
					os.Remove(review + ".done")
					break reviewLoop
				}
			}
		}
	}

}
