package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/jackc/pgx/v5/pgxpool"
)

func assertClaudeCollectorContract(t *testing.T, h *Handler, modules Modules, pool *pgxpool.Pool) {
	t.Helper()
	const thinkingID = "generated-claude-thinking-contract"
	project, grant, credential := nativeCollectorActor(t, modules, pool, "claude")
	cookie := &http.Cookie{Name: "__Secure-atape_session", Value: grant.SessionSecret}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	handler, err := NewHandler(Config{InstanceOrigin: origin, WebOrigin: origin, APIOrigin: origin, DevelopmentAllowHTTP: true}, modules)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	var thinkingRequests []ingestion.Batch
	var thinkingWireLeak bool
	var thinkingWireMutex sync.Mutex
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/ingestion/canonical/batches" {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "read Canonical contract request", http.StatusInternalServerError)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			var batch ingestion.Batch
			if json.Unmarshal(body, &batch) == nil && batch.Session.SourceSessionID == thinkingID {
				thinkingWireMutex.Lock()
				thinkingRequests = append(thinkingRequests, batch)
				thinkingWireLeak = thinkingWireLeak || bytes.Contains(body, []byte("SENSITIVE_TEST_TOKEN")) ||
					bytes.Contains(body, []byte("ATAPE_THOUGHT_SIGNATURE")) || bytes.Contains(body, []byte("ATAPE_REDACTED_PAYLOAD"))
				thinkingWireMutex.Unlock()
			}
		}
		handler.ServeHTTP(w, r)
	})
	server.Start()
	defer server.Close()
	repository, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	home, artifacts := t.TempDir(), t.TempDir()
	pack := func(directory string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "npm", "pack", "--ignore-scripts", "--json", "--pack-destination", artifacts)
		command.Dir = filepath.Join(repository, directory)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Fatalf("pack Claude %s: %v\n%s", directory, err, stderr.String())
		}
		var packed []struct{ Filename string }
		if err := json.Unmarshal(output, &packed); err != nil || len(packed) != 1 {
			t.Fatalf("decode Claude %s artifact: %v", directory, err)
		}
		return filepath.Join(artifacts, packed[0].Filename)
	}
	tarball, cliTarball := os.Getenv("ATAPE_CLAUDE_LEGACY_TARBALL"), pack("apps/cli")
	info, err := os.Stat(tarball)
	if !filepath.IsAbs(tarball) || err != nil || !info.Mode().IsRegular() {
		t.Fatal("legacy Claude contract requires ATAPE_CLAUDE_LEGACY_TARBALL from scripts/freeze-claude-legacy.mjs (genuine f609353 sources)")
	}
	// Optional, explicitly supplied genuine previous artifact. This is not built
	// by relabelling the current package or mutating a current private cursor.
	previousTarball := os.Getenv("ATAPE_CLAUDE_PREVIOUS_TARBALL")
	if previousTarball != "" {
		info, err := os.Stat(previousTarball)
		if !filepath.IsAbs(previousTarball) || err != nil || !info.Mode().IsRegular() {
			t.Fatalf("Claude previous artifact must be an existing absolute tarball: %s error=%v", previousTarball, err)
		}
		t.Logf("Claude thinking upgrade uses explicitly supplied previous artifact %s", previousTarball)
	}
	type snapshot struct {
		InstallationID   string                            `json:"installationId"`
		Cursor           string                            `json:"cursor"`
		RawObjects       json.RawMessage                   `json:"rawObjects"`
		Observations     int                               `json:"observations"`
		CanonicalEvents  int                               `json:"canonicalEvents"`
		CanonicalBatches int                               `json:"canonicalBatches"`
		RawChunks        int                               `json:"rawChunks"`
		SourceFailures   []struct{ Source, Reason string } `json:"sourceFailures"`
		Progress         *struct {
			PendingCanonicalSessions int   `json:"pendingCanonicalSessions"`
			PendingRawBytes          int64 `json:"pendingRawBytes"`
		} `json:"progress"`
	}
	run := func(phase string) snapshot {
		t.Helper()
		input, err := json.Marshal(map[string]any{"phase": phase, "origin": origin, "credential": credential,
			"userId": grant.User.ID, "home": home, "tarball": tarball, "previousTarball": previousTarball, "cliTarball": cliTarball, "projectId": project.ID, "teamId": project.TeamID})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "node", "apps/cli/src/runtime/fixtures/claude-collector-contract.ts")
		command.Dir = repository
		command.Stdin = bytes.NewReader(input)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Fatalf("installed Claude Collector %s: %v\n%s", phase, err, stderr.String())
		}
		var result snapshot
		if err := json.Unmarshal(output, &result); err != nil || result.InstallationID == "" || result.Cursor == "" {
			t.Fatalf("Claude %s lost progress: %v %s", phase, err, output)
		}
		t.Logf("Claude installed %s: observations=%d events=%d batches=%d Raw=%d failures=%d progress=%+v", phase,
			result.Observations, result.CanonicalEvents, result.CanonicalBatches, result.RawChunks, len(result.SourceFailures), result.Progress)
		return result
	}
	send := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		addWebProof(request, cookie, grant.CSRFToken)
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("Claude HTTP %s: %d %s", path, response.Code, response.Body.String())
		}
		return response
	}
	setRaw := func(enabled bool) {
		preference := "disable"
		if enabled {
			preference = "enable"
		}
		send(http.MethodPut, "/api/v1/users/me/raw-capture", `{"preference":"`+preference+`"}`)
	}
	read := func(sessionID, threadID string, expected int) conversation.Conversation {
		t.Helper()
		var result conversation.Conversation
		after := ""
		for n := 0; n < 20; n++ {
			query := url.Values{"thread": {threadID}, "limit": {"2"}}
			if after != "" {
				query.Set("after", after)
			}
			var page conversation.Conversation
			decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+sessionID+"?"+query.Encode(), ""), &page)
			// Legacy Sessions intentionally retain full reads; the publication
			// head/page publication is not enabled by this Adapter contract.
			if page.Session.ID != sessionID || page.Thread.ID != threadID {
				t.Fatalf("Claude Reader crossed identity: session=%s want=%s thread=%s want=%s", page.Session.ID, sessionID, page.Thread.ID, threadID)
			}
			if n == 0 {
				result = page
				result.Events = nil
			}
			result.Events = append(result.Events, page.Events...)
			after = page.NextEventID
			if after == "" {
				if len(result.Events) != expected {
					t.Fatalf("Claude Reader events=%d want=%d", len(result.Events), expected)
				}
				return result
			}
		}
		t.Fatal("Claude Reader pagination did not finish")
		return result
	}
	store := postgresadapter.NewStore(pool)
	search := func(term string) projectsearch.Page {
		t.Helper()
		for n := 0; n < 20; n++ {
			count, err := projectsearch.NewProjector(store, store).ProjectOnce(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if count == 0 {
				break
			}
		}
		var page projectsearch.Page
		decodeResponse(t, send(http.MethodGet, "/api/v1/projects/"+project.ID+"/search?q="+url.QueryEscape(term), ""), &page)
		return page
	}
	usage := func(sessionID string, expected int, expectedInput, expectedOutput int64) {
		t.Helper()
		view, err := store.Overview(t.Context(), authentication.Principal{UserID: grant.User.ID, Method: authentication.WebAuthentication}, project.TeamID,
			time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		count, input, output := 0, int64(0), int64(0)
		for _, row := range view.Usage {
			if row.SessionID != sessionID {
				continue
			}
			count++
			if row.Model == "<synthetic>" {
				t.Fatal("Claude synthetic bridge became model usage")
			}
			if row.InputTokens != nil {
				input += *row.InputTokens
			}
			if row.OutputTokens != nil {
				output += *row.OutputTokens
			}
		}
		if count != expected || input != expectedInput || output != expectedOutput {
			t.Fatalf("Claude usage records=%d input=%d output=%d", count, input, output)
		}
	}
	readRaw := func(sessionID string) (rawarchive.SessionArchive, map[string]string) {
		t.Helper()
		var archive rawarchive.SessionArchive
		decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+sessionID+"/raw?limit=1", ""), &archive)
		if archive.NextCursor != "" {
			// The family has two objects; exercise the manifest cursor as well.
			var next rawarchive.SessionArchive
			decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+sessionID+"/raw?limit=1&cursor="+url.QueryEscape(archive.NextCursor), ""), &next)
			archive.Objects = append(archive.Objects, next.Objects...)
			if next.NextCursor != "" {
				t.Fatal("Claude Raw manifest exceeded the family bound")
			}
		}
		contents := map[string]string{}
		for _, object := range archive.Objects {
			if !object.ClientRedacted || object.CurrentGeneration != 1 {
				t.Fatal("Claude Raw lost redaction or generation identity")
			}
			cursor, offset := "", int64(0)
			var content strings.Builder
			for n := 0; n < 64; n++ {
				query := url.Values{"generation": {"1"}, "limit": {"1"}}
				if cursor != "" {
					query.Set("cursor", cursor)
				}
				var page rawarchive.ContentPage
				decodeResponse(t, send(http.MethodGet, "/api/v1/raw-objects/"+object.ObjectID+"/content?"+query.Encode(), ""), &page)
				if len(page.Chunks) > 1 || page.Generation != 1 {
					t.Fatal("Claude Raw exceeded its chunk bound")
				}
				for _, chunk := range page.Chunks {
					decoded, err := base64.StdEncoding.DecodeString(chunk.ContentBase64)
					if err != nil || chunk.Offset != offset || chunk.SizeBytes != int64(len(decoded)) {
						t.Fatal("Claude Raw has a gap or corrupt chunk")
					}
					content.Write(decoded)
					offset += chunk.SizeBytes
				}
				cursor = page.NextCursor
				if cursor == "" {
					break
				}
			}
			if cursor != "" || offset != object.CurrentSizeBytes {
				t.Fatal("Claude Raw pagination omitted source bytes")
			}
			contents[object.SourceName] = content.String()
		}
		return archive, contents
	}
	const familyID = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f"
	const compactID = "2197a21d-e447-4ce2-bb24-4ae0c75b2c9d"
	const tailID = "48656330-5cf7-4f7c-97d4-674c41750762"
	const autoID = "43526b2f-6f23-4f37-9627-c75f50bfb9b9"
	const pairToolID = "d0a2fe9a-191b-4666-9dfc-7edda5abc1e3"
	const pairPlanID = "cf19053f-9c3c-49b7-8fce-461ae05d8294"
	const autoReadSingleID = "611cd738-0d92-41ce-b1e3-64ba1a10a70a"
	const autoReadDualID = "bb9cf168-c9d3-4fea-9428-bd7fc8460755"
	const largeManualReadID = "b179ae84-44d8-4f32-adee-7f176edf363c"
	const repeatedAutoReadID = "f2479149-41f5-4f6c-a3e2-7d46eca6ff30"
	const reversedReadPairID = "979aa7c7-7bdb-4a9e-8aea-7d36f8cb5f1a"
	const agentID = "a5b93406db8c7fefd"
	sourceDirectory := filepath.Join(home, "source", "projects", "opaque-native-project")
	assertSourceRaw := func(sessionID string, expectedFiles map[string]string) rawarchive.SessionArchive {
		t.Helper()
		archive, contents := readRaw(sessionID)
		if len(contents) != len(expectedFiles) {
			t.Fatal("Claude Raw source count changed")
		}
		for name, path := range expectedFiles {
			source, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if contents[name] != strings.ReplaceAll(string(source), "SENSITIVE_TEST_TOKEN", "[REDACTED]") {
				t.Fatalf("Claude Raw lost complete %s bytes", name)
			}
		}
		return archive
	}
	setRaw(true)
	defer setRaw(false)
	initial := run("initial")
	if initial.CanonicalEvents != 41 || initial.RawChunks != 12 {
		t.Fatalf("Claude initial installed capture: %+v", initial)
	}
	var memory conversation.ProjectMemory
	decodeResponse(t, send(http.MethodGet, "/api/v1/projects/"+project.ID+"/memory", ""), &memory)
	if len(memory.Trail) != 11 {
		t.Fatal("Claude included a foreign source or split its foreground family")
	}
	familySession, compactSession, tailSession, autoSession := "", "", "", ""
	pairToolSession, pairPlanSession := "", ""
	autoReadSingleSession, autoReadDualSession := "", ""
	largeManualReadSession, repeatedAutoReadSession := "", ""
	reversedReadPairSession := ""
	for _, session := range memory.Trail {
		if strings.HasPrefix(session.Title, "ATAPE_NATIVE_FOREGROUND_ROOT") {
			familySession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_NATIVE_COMPACT_SEED") {
			compactSession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_MANUAL_TEXT_SEED") {
			tailSession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_AUTO_TEXT_SEED") {
			autoSession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_PARALLEL_REQUEST:") {
			pairToolSession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_MANUAL_SEED:") {
			pairPlanSession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_AUTO_SINGLE_SEED:") {
			autoReadSingleSession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_AUTO_SEED:") {
			autoReadDualSession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_REPEAT_82f63bfe_single_SEED:") {
			repeatedAutoReadSession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_REPEAT_82f63bfe_dual_SEED:") {
			reversedReadPairSession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_MANUAL_LARGE_SEED:") {
			largeManualReadSession = session.ID
		}
	}
	if familySession == "" || compactSession == "" || tailSession == "" || autoSession == "" || pairToolSession == "" || pairPlanSession == "" || autoReadSingleSession == "" || autoReadDualSession == "" || largeManualReadSession == "" || repeatedAutoReadSession == "" || reversedReadPairSession == "" {
		t.Fatal("Claude lost native Session identities")
	}
	root := read(familySession, "root", 4)
	childID := ""
	for _, event := range root.Events {
		if event.ChildThread != nil {
			childID = event.ChildThread.ID
		}
	}
	if childID == "" {
		t.Fatal("Claude foreground result lost child navigation")
	}
	child := read(familySession, childID, 4)
	if child.Thread.ParentThreadID == nil || *child.Thread.ParentThreadID != "root" || len(child.ThreadPath) != 2 {
		t.Fatal("Claude child Reader lost its root path")
	}
	hits := search("ATAPE_CHILD_FINAL:")
	if len(hits.Results) != 1 || hits.Results[0].SessionID != familySession || hits.Results[0].ThreadID != childID {
		t.Fatalf("Claude child Search lost its exact Thread: %+v want session=%s thread=%s", hits.Results, familySession, childID)
	}
	var anchored conversation.Conversation
	decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+familySession+"?thread="+url.QueryEscape(childID)+"&at="+url.QueryEscape(hits.Results[0].EventID)+"&limit=2", ""), &anchored)
	if len(anchored.ThreadPath) != 2 || len(anchored.Events) == 0 || !strings.Contains(anchored.Events[0].Text+anchored.Events[len(anchored.Events)-1].Text, "ATAPE_CHILD_FINAL") {
		t.Fatal("Claude child Search anchor did not resolve")
	}
	usage(familySession, 4, 68, 36)
	assertSourceRaw(familySession, map[string]string{familyID + ".jsonl": filepath.Join(sourceDirectory, familyID+".jsonl"),
		"agent-" + agentID + ".jsonl": filepath.Join(sourceDirectory, familyID, "subagents", "agent-"+agentID+".jsonl")})
	before := read(compactSession, "root", 4)
	usage(compactSession, 2, 52, 24)
	manualFiles := map[string]string{compactID + ".jsonl": filepath.Join(sourceDirectory, compactID+".jsonl")}
	beforeArchive := assertSourceRaw(compactSession, manualFiles)
	// This third native Session retains two text records from one response.
	// Verify its staged daemon restarts independently from the single-tail
	// source, retaining the exact same-API Event and usage identities.
	tailFiles := map[string]string{tailID + ".jsonl": filepath.Join(sourceDirectory, tailID+".jsonl")}
	tailHead := read(tailSession, "root", 6)
	usage(tailSession, 3, 93, 47)
	tailHeadArchive := assertSourceRaw(tailSession, tailFiles)
	tailBeforeCapture := run("tail-before")
	if tailBeforeCapture.InstallationID != initial.InstallationID || tailBeforeCapture.CanonicalEvents != 1 || tailBeforeCapture.RawChunks != 1 {
		t.Fatal("Claude same-API split text did not append across daemon checkpoints")
	}
	tailBefore := read(tailSession, "root", 7)
	tailHeadJSON, _ := json.Marshal(tailHead.Events)
	tailHeadPrefixJSON, _ := json.Marshal(tailBefore.Events[:len(tailHead.Events)])
	if !bytes.Equal(tailHeadJSON, tailHeadPrefixJSON) {
		t.Fatal("Claude same-API split text replayed its acknowledged head")
	}
	// Both blocks emit usage with different source-byte revisions. The real SQL
	// upsert must retain one sourceUsageId and must not add counters twice.
	usage(tailSession, 3, 93, 47)
	tailBeforeArchive := assertSourceRaw(tailSession, tailFiles)
	if len(tailHeadArchive.Objects) != 1 || len(tailBeforeArchive.Objects) != 1 || tailHeadArchive.Objects[0].ObjectID != tailBeforeArchive.Objects[0].ObjectID {
		t.Fatal("Claude same-API split text replaced its acknowledged Raw object")
	}
	for _, term := range []string{"ATAPE_MANUAL_TEXT_FINAL_A:", "ATAPE_MANUAL_TEXT_FINAL_B:"} {
		hits := search(term)
		if len(hits.Results) != 1 || hits.Results[0].SessionID != tailSession || hits.Results[0].ThreadID != "root" {
			t.Fatalf("Claude split text Search lost its Session/root: %s %+v", term, hits.Results)
		}
		var anchored conversation.Conversation
		decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+tailSession+"?thread=root&at="+url.QueryEscape(hits.Results[0].EventID)+"&limit=2", ""), &anchored)
		if anchored.Session.ID != tailSession || anchored.Thread.ID != "root" || len(anchored.Events) == 0 {
			t.Fatal("Claude split text Search anchor lost Reader identity")
		}
		found := false
		for _, event := range anchored.Events {
			found = found || event.ID == hits.Results[0].EventID && strings.Contains(event.Text, term)
		}
		if !found {
			t.Fatal("Claude split text Search anchor did not resolve its exact Event")
		}
	}
	tailPrevious, tailLatest := tailBefore, tailBeforeCapture
	for _, stage := range []struct {
		phase                     string
		events, usage, added, raw int
		input, output             int64
		searchTerm                string
		expectedSearchResults     int
	}{
		{"tail-compact", 7, 3, 0, 6, 93, 47, "", 0},
		{"tail-continued", 9, 4, 2, 2, 122, 60, "ATAPE_MANUAL_TEXT_CONTINUE:", 2},
		{"tail-continued-again", 11, 5, 2, 1, 151, 73, "ATAPE_MANUAL_TEXT_SECONDCONTINUE:", 1},
	} {
		tailLatest = run(stage.phase)
		if tailLatest.InstallationID != initial.InstallationID || tailLatest.CanonicalEvents != stage.added || tailLatest.RawChunks != stage.raw {
			t.Fatalf("Claude split text %s did not append the exact native increment: %+v", stage.phase, tailLatest)
		}
		current := read(tailSession, "root", stage.events)
		previousJSON, _ := json.Marshal(tailPrevious.Events)
		prefixJSON, _ := json.Marshal(current.Events[:len(tailPrevious.Events)])
		if !bytes.Equal(previousJSON, prefixJSON) {
			t.Fatalf("Claude split text %s replayed or re-keyed old Events", stage.phase)
		}
		usage(tailSession, stage.usage, stage.input, stage.output)
		archive := assertSourceRaw(tailSession, tailFiles)
		if len(tailBeforeArchive.Objects) != 1 || len(archive.Objects) != 1 || archive.Objects[0].ObjectID != tailBeforeArchive.Objects[0].ObjectID {
			t.Fatalf("Claude split text %s replaced its source Raw object", stage.phase)
		}
		for _, term := range []string{"ATAPE_MANUAL_TEXT_SUMMARY", "No response requested", "local-command", "command-name"} {
			if len(search(term).Results) != 0 {
				t.Fatalf("Claude split text internal control reached Search: %s", term)
			}
			for _, event := range current.Events {
				if strings.Contains(event.Text, term) {
					t.Fatalf("Claude split text %s projected internal control as a conversation Event", stage.phase)
				}
			}
		}
		if stage.searchTerm != "" {
			hits := search(stage.searchTerm)
			if len(hits.Results) != stage.expectedSearchResults {
				t.Fatalf("Claude split text %s Search lost continuation: %+v", stage.phase, hits.Results)
			}
			for _, hit := range hits.Results {
				if hit.SessionID != tailSession || hit.ThreadID != "root" {
					t.Fatal("Claude split text continuation Search crossed identity")
				}
			}
		}
		tailPrevious = current
	}
	tailNoop := run("tail-noop")
	if tailNoop.Cursor != tailLatest.Cursor || tailNoop.CanonicalBatches != 0 || tailNoop.RawChunks != 0 || !bytes.Equal(tailNoop.RawObjects, tailLatest.RawObjects) {
		t.Fatal("Claude split text unchanged polling replayed usage or changed Raw receipts")
	}
	usage(tailSession, 5, 151, 73)
	// This native Session exercises the same source-control rule repeatedly.
	// All cuts are complete prefixes of native snapshots;
	// every run starts a fresh installed daemon and uses the same HTTP/PG path.
	autoFiles := map[string]string{autoID + ".jsonl": filepath.Join(sourceDirectory, autoID+".jsonl")}
	autoPrevious := read(autoSession, "root", 4)
	usage(autoSession, 2, 190023, 24)
	autoInitialArchive := assertSourceRaw(autoSession, autoFiles)
	assertAutoProgress := func(phase string, capture snapshot, pending int) {
		t.Helper()
		if capture.InstallationID != initial.InstallationID || len(capture.SourceFailures) != 0 || capture.Progress == nil ||
			capture.Progress.PendingCanonicalSessions != pending || capture.Progress.PendingRawBytes != 0 {
			t.Fatalf("Claude automatic %s lost its caller progress: same installation=%t failures=%d progress=%+v want pending=%d",
				phase, capture.InstallationID == initial.InstallationID, len(capture.SourceFailures), capture.Progress, pending)
		}
	}
	assertAutoView := func(phase string, events, count int, input, output int64) {
		t.Helper()
		current := read(autoSession, "root", events)
		previousJSON, _ := json.Marshal(autoPrevious.Events)
		prefixJSON, _ := json.Marshal(current.Events[:len(autoPrevious.Events)])
		if !bytes.Equal(previousJSON, prefixJSON) {
			t.Fatalf("Claude automatic %s replayed or re-keyed acknowledged Events", phase)
		}
		ids := map[string]bool{}
		for _, event := range current.Events {
			if ids[event.ID] {
				t.Fatalf("Claude automatic %s duplicated an Event", phase)
			}
			ids[event.ID] = true
			for _, control := range []string{"ATAPE_AUTO_TEXT_SUMMARY", "15000000 tokens left"} {
				if strings.Contains(event.Text, control) {
					t.Fatalf("Claude automatic %s projected internal control as a conversation Event", phase)
				}
			}
		}
		usage(autoSession, count, input, output)
		archive := assertSourceRaw(autoSession, autoFiles)
		if len(autoInitialArchive.Objects) != 1 || len(archive.Objects) != 1 ||
			archive.Objects[0].ObjectID != autoInitialArchive.Objects[0].ObjectID {
			t.Fatalf("Claude automatic %s replaced its Raw source object", phase)
		}
		for _, control := range []string{"ATAPE_AUTO_TEXT_SUMMARY", "15000000 tokens left"} {
			if len(search(control).Results) != 0 {
				t.Fatalf("Claude automatic %s indexed internal control: %s", phase, control)
			}
		}
		autoPrevious = current
	}
	assertAutoIdle := func(phase string, previous snapshot, pending int, events, count int, input, output int64) {
		t.Helper()
		idle := run(phase)
		assertAutoProgress(phase, idle, pending)
		if idle.Cursor != previous.Cursor || idle.Observations != 0 || idle.CanonicalBatches != 0 || idle.RawChunks != 0 ||
			!bytes.Equal(idle.RawObjects, previous.RawObjects) {
			t.Fatalf("Claude automatic %s advanced a no-progress checkpoint or Raw receipt", phase)
		}
		assertAutoView(phase, events, count, input, output)
	}
	for round := 1; round <= 3; round++ {
		prefix := fmt.Sprintf("auto-%d-", round)
		events, count := 4+2*(round-1), 2+round-1
		input, output := int64(190023+190000*(round-1)), int64(24+13*(round-1))
		originals := run(prefix + "originals")
		assertAutoProgress(prefix+"originals", originals, 0)
		if originals.CanonicalEvents != 1 || originals.RawChunks != 1 {
			t.Fatalf("Claude automatic round %d original U/G events=%d Raw=%d", round, originals.CanonicalEvents, originals.RawChunks)
		}
		assertAutoView(prefix+"originals", events+1, count, input, output)
		assertAutoIdle(prefix+"originals-idle", originals, 0, events+1, count, input, output)
		for _, control := range []string{"copy-user", "copy-gap", "boundary"} {
			phase := prefix + control
			capture := run(phase)
			assertAutoProgress(phase, capture, 1)
			if capture.CanonicalEvents != 0 || capture.RawChunks != 1 {
				t.Fatalf("Claude automatic %s duplicated Canonical or omitted complete control Raw: events=%d Raw=%d", phase, capture.CanonicalEvents, capture.RawChunks)
			}
			assertAutoView(phase, events+1, count, input, output)
			assertAutoIdle(phase+"-idle", capture, 1, events+1, count, input, output)
		}
		summary := run(prefix + "summary")
		assertAutoProgress(prefix+"summary", summary, 0)
		if summary.CanonicalEvents != 0 || summary.RawChunks != 1 {
			t.Fatalf("Claude automatic round %d U/G copies or B/S events=%d Raw=%d", round, summary.CanonicalEvents, summary.RawChunks)
		}
		assertAutoView(prefix+"summary", events+1, count, input, output)
		assertAutoIdle(prefix+"summary-idle", summary, 0, events+1, count, input, output)
		answer := run(prefix + "answer")
		assertAutoProgress(prefix+"answer", answer, 0)
		if answer.CanonicalEvents != 1 || answer.RawChunks != 1 {
			t.Fatalf("Claude automatic round %d real answer events=%d Raw=%d", round, answer.CanonicalEvents, answer.RawChunks)
		}
		assertAutoView(prefix+"answer", events+2, count+1, input+190000, output+13)
		assertAutoIdle(prefix+"answer-idle", answer, 0, events+2, count+1, input+190000, output+13)
	}
	for _, expected := range []struct {
		term  string
		count int
	}{
		{"ATAPE_AUTO_TEXT_CONTINUE:", 2},
		{"ATAPE_AUTO_TEXT_SECOND_CONTINUE:", 1},
		{"ATAPE_AUTO_TEXT_SECONDCONTINUE:", 1},
		{"ATAPE_AUTO_TEXT_THIRD_CONTINUE:", 1},
		{"ATAPE_AUTO_TEXT_THIRDCONTINUE:", 1},
	} {
		hits := search(expected.term)
		if len(hits.Results) != expected.count {
			t.Fatalf("Claude automatic Search duplicated source copies or lost continuation: %s %+v", expected.term, hits.Results)
		}
		for _, hit := range hits.Results {
			if hit.SessionID != autoSession || hit.ThreadID != "root" {
				t.Fatal("Claude automatic Search crossed Session/root identity")
			}
			var anchored conversation.Conversation
			decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+autoSession+"?thread=root&at="+url.QueryEscape(hit.EventID)+"&limit=2", ""), &anchored)
			found := false
			for _, event := range anchored.Events {
				found = found || event.ID == hit.EventID && strings.Contains(event.Text, expected.term)
			}
			if anchored.Session.ID != autoSession || anchored.Thread.ID != "root" || !found {
				t.Fatal("Claude automatic Search anchor did not resolve its exact Event")
			}
		}
	}
	// Native call/result boundaries use independently restarted daemons. The
	// sampled pair sizes do not constrain the source-control reducer.
	type readRetention struct {
		sessionID, sourceID string
		events, count       int
		input, output       int64
		archive             rawarchive.SessionArchive
		contents            map[string]string
	}
	var readRetained []readRetention
	for _, fixtureCase := range []struct {
		prefix, sessionID, sourceID, callPrefix, markerPrefix string
		initialEvents, initialUsage                           int
		initialInput, initialOutput                           int64
		stages                                                []struct {
			phase                         string
			events, count, added, pending int
			input, output                 int64
		}
	}{
		{"pair-tool-", pairToolSession, pairToolID, "call_parallel_read_", "ATAPE_PARALLEL_READ_", 1, 0, 0, 0, []struct {
			phase                         string
			events, count, added, pending int
			input, output                 int64
		}{
			{"call0", 2, 1, 1, 0, 31, 7}, {"call1", 3, 1, 1, 0, 31, 7},
			{"r0", 4, 1, 1, 0, 31, 7}, {"r1", 5, 1, 1, 0, 31, 7},
			{"final", 6, 2, 1, 0, 72, 18}, {"resume", 8, 3, 2, 0, 101, 31},
		}},
		{"pair-plan-", pairPlanSession, pairPlanID, "call_manual_read_", "ATAPE_NATIVE_READ_", 4, 2, 52, 24, []struct {
			phase                         string
			events, count, added, pending int
			input, output                 int64
		}{
			{"plan", 6, 3, 2, 0, 89, 41}, {"call0", 7, 3, 1, 0, 89, 41}, {"call1", 8, 3, 1, 0, 89, 41},
			{"r0", 9, 3, 1, 0, 89, 41}, {"r1", 10, 3, 1, 0, 89, 41},
			{"final-a", 11, 4, 1, 0, 130, 64}, {"final", 12, 4, 1, 0, 130, 64},
		}},
	} {
		files := map[string]string{fixtureCase.sourceID + ".jsonl": filepath.Join(sourceDirectory, fixtureCase.sourceID+".jsonl")}
		previous := read(fixtureCase.sessionID, "root", fixtureCase.initialEvents)
		usage(fixtureCase.sessionID, fixtureCase.initialUsage, fixtureCase.initialInput, fixtureCase.initialOutput)
		initialArchive := assertSourceRaw(fixtureCase.sessionID, files)
		for _, stage := range fixtureCase.stages {
			phase := fixtureCase.prefix + stage.phase
			capture := run(phase)
			assertAutoProgress(phase, capture, stage.pending)
			if capture.CanonicalEvents != stage.added || capture.RawChunks != 1 {
				t.Fatalf("Claude Read-pair %s events=%d Raw=%d", phase, capture.CanonicalEvents, capture.RawChunks)
			}
			current := read(fixtureCase.sessionID, "root", stage.events)
			previousJSON, _ := json.Marshal(previous.Events)
			prefixJSON, _ := json.Marshal(current.Events[:len(previous.Events)])
			if !bytes.Equal(previousJSON, prefixJSON) {
				t.Fatalf("Claude Read-pair %s replayed or changed old Events", phase)
			}
			// Plan/calls and final text blocks expose later source revisions of
			// one API ID in different real HTTP/PG transactions and processes.
			usage(fixtureCase.sessionID, stage.count, stage.input, stage.output)
			archive := assertSourceRaw(fixtureCase.sessionID, files)
			if len(archive.Objects) != 1 || len(initialArchive.Objects) != 1 || archive.Objects[0].ObjectID != initialArchive.Objects[0].ObjectID {
				t.Fatalf("Claude Read-pair %s replaced its Raw source object", phase)
			}
			if stage.phase == "r0" || stage == fixtureCase.stages[len(fixtureCase.stages)-1] {
				idle := run(phase + "-idle")
				assertAutoProgress(phase+"-idle", idle, stage.pending)
				if idle.Cursor != capture.Cursor || idle.Observations != 0 || idle.CanonicalBatches != 0 || idle.RawChunks != 0 || !bytes.Equal(idle.RawObjects, capture.RawObjects) {
					t.Fatalf("Claude Read-pair %s no-progress restart changed cursor or Raw receipts", phase)
				}
				usage(fixtureCase.sessionID, stage.count, stage.input, stage.output)
			}
			previous = current
		}
		results := map[string]string{}
		for _, suffix := range []string{"a", "b"} {
			callID := fixtureCase.callPrefix + suffix
			calls, updates := 0, 0
			for _, event := range previous.Events {
				if event.Tool == nil || event.Tool.ToolCallID != callID {
					continue
				}
				if event.Tool.SessionUpdate == "tool_call" {
					calls++
					var input map[string]string
					if err := json.Unmarshal(event.Tool.RawInput, &input); err != nil || input["file_path"] != filepath.Join(home, "workspace", suffix+".txt") {
						t.Fatal("Claude Read-pair Reader lost its exact call input")
					}
				} else if event.Tool.SessionUpdate == "tool_call_update" {
					updates++
					var output string
					if event.Kind != "tool_result" || event.Tool.Status == nil || *event.Tool.Status != "completed" || json.Unmarshal(event.Tool.RawOutput, &output) != nil || !strings.Contains(output, fixtureCase.markerPrefix+strings.ToUpper(suffix)+":") {
						t.Fatal("Claude Read-pair own-call update lost its successful actual Read output")
					}
					results[event.ID] = callID
				}
			}
			if calls != 1 || updates != 1 {
				t.Fatal("Claude Read-pair duplicated or crossed its call/update associations")
			}
		}
		// Search admits message bodies only. Tool summaries/output are excluded;
		// their exact Event anchors remain available through the Reader Interface.
		found := 0
		for eventID, callID := range results {
			var anchored conversation.Conversation
			decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+fixtureCase.sessionID+"?thread=root&at="+url.QueryEscape(eventID)+"&limit=2", ""), &anchored)
			if anchored.Session.ID != fixtureCase.sessionID || anchored.Thread.ID != "root" {
				t.Fatal("Claude Read-pair result anchor crossed own-call Session/root")
			}
			for _, event := range anchored.Events {
				if event.ID == eventID && event.Tool != nil && event.Tool.ToolCallID == callID && event.Kind == "tool_result" &&
					event.Tool.Status != nil && *event.Tool.Status == "completed" {
					found++
				}
			}
		}
		if found != 2 {
			t.Fatal("Claude Read-pair Reader did not resolve both exact result anchors")
		}
		for _, hit := range search("completed").Results {
			if _, toolResult := results[hit.EventID]; toolResult {
				t.Fatal("Claude Read-pair tool result summary leaked into message-body Search")
			}
		}
		if len(search(fixtureCase.callPrefix).Results) != 0 {
			t.Fatal("Claude Read-pair tool identity leaked into message-body Search")
		}
		for _, suffix := range []string{"A:", "B:"} {
			if len(search(fixtureCase.markerPrefix+suffix).Results) != 0 {
				t.Fatal("Claude Read-pair raw tool output leaked into Search")
			}
		}
		terms := []string{"ATAPE_MANUAL_TOOLS:", "ATAPE_MANUAL_TOOL_PLAN:", "ATAPE_MANUAL_TOOL_FINAL_A:", "ATAPE_MANUAL_TOOL_FINAL_B:"}
		if fixtureCase.sourceID == pairToolID {
			terms = []string{"ATAPE_PARALLEL_REQUEST:", "ATAPE_PARALLEL_FINAL:", "ATAPE_PARALLEL_RESUME_REQUEST:", "ATAPE_PARALLEL_RESUMED:"}
		}
		for _, term := range terms {
			hits := search(term)
			if len(hits.Results) != 1 || hits.Results[0].SessionID != fixtureCase.sessionID || hits.Results[0].ThreadID != "root" {
				t.Fatalf("Claude Read-pair text Search lost or duplicated its continuation: %s %+v", term, hits.Results)
			}
			hit := hits.Results[0]
			var anchored conversation.Conversation
			decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+fixtureCase.sessionID+"?thread=root&at="+url.QueryEscape(hit.EventID)+"&limit=2", ""), &anchored)
			found := false
			for _, event := range anchored.Events {
				found = found || event.ID == hit.EventID && strings.Contains(event.Text, term)
			}
			if anchored.Session.ID != fixtureCase.sessionID || anchored.Thread.ID != "root" || !found {
				t.Fatal("Claude Read-pair text Search anchor did not resolve its exact Event")
			}
		}
		archive, contents := readRaw(fixtureCase.sessionID)
		last := fixtureCase.stages[len(fixtureCase.stages)-1]
		readRetained = append(readRetained, readRetention{fixtureCase.sessionID, fixtureCase.sourceID, last.events, last.count, last.input, last.output, archive, contents})
	}
	// Add 24 independently restarted native Read-turn automatic phases to the
	// previous 49 runs. Copied assistant/result records must not revise history
	// or usage; the two final text blocks update one actual API usage identity.
	type replayStage struct {
		phase                         string
		events, count, added, pending int
		input, output                 int64
	}
	for _, fixtureCase := range []struct {
		prefix, sessionID, sourceID, callPrefix, textPrefix string
		suffixes                                            []string
		summaryRaw                                          int
		stages                                              []replayStage
	}{
		{"auto-read-single-", autoReadSingleSession, autoReadSingleID, "call_auto_single_read_", "ATAPE_AUTO_SINGLE_", []string{"a"}, 8, []replayStage{
			{"plan", 6, 3, 2, 0, 190052, 41}, {"call0", 7, 3, 1, 0, 190052, 41}, {"r0", 8, 3, 1, 0, 190052, 41},
			{"originals", 8, 3, 0, 0, 190052, 41}, {"summary", 8, 3, 0, 0, 190052, 41},
			{"final-a", 9, 4, 1, 0, 190093, 64}, {"final", 10, 4, 1, 0, 190093, 64},
			{"continue", 12, 5, 2, 0, 190122, 77}, {"secondcontinue", 14, 6, 2, 0, 190151, 90},
		}},
		{"auto-read-dual-", autoReadDualSession, autoReadDualID, "call_auto_read_", "ATAPE_AUTO_", []string{"a", "b"}, 10, []replayStage{
			{"plan", 6, 3, 2, 0, 190052, 41}, {"call0", 7, 3, 1, 0, 190052, 41}, {"call1", 8, 3, 1, 0, 190052, 41},
			{"r0", 9, 3, 1, 0, 190052, 41}, {"r1", 10, 3, 1, 0, 190052, 41},
			{"originals", 10, 3, 0, 0, 190052, 41}, {"summary", 10, 3, 0, 0, 190052, 41},
			{"final-a", 11, 4, 1, 0, 190093, 64}, {"final", 12, 4, 1, 0, 190093, 64},
			{"continue", 14, 5, 2, 0, 190122, 77}, {"secondcontinue", 16, 6, 2, 0, 190151, 90},
		}},
	} {
		files := map[string]string{fixtureCase.sourceID + ".jsonl": filepath.Join(sourceDirectory, fixtureCase.sourceID+".jsonl")}
		previous := read(fixtureCase.sessionID, "root", 4)
		usage(fixtureCase.sessionID, 2, 52, 24)
		initialArchive := assertSourceRaw(fixtureCase.sessionID, files)
		for _, stage := range fixtureCase.stages {
			phase := fixtureCase.prefix + stage.phase
			capture := run(phase)
			assertAutoProgress(phase, capture, stage.pending)
			raw := 1
			if stage.phase == "summary" {
				raw = fixtureCase.summaryRaw
			}
			if capture.CanonicalEvents != stage.added || capture.RawChunks != raw {
				t.Fatalf("Claude automatic Read %s events=%d want=%d Raw=%d", phase, capture.CanonicalEvents, stage.added, capture.RawChunks)
			}
			current := read(fixtureCase.sessionID, "root", stage.events)
			oldJSON, _ := json.Marshal(previous.Events)
			prefixJSON, _ := json.Marshal(current.Events[:len(previous.Events)])
			if !bytes.Equal(oldJSON, prefixJSON) {
				t.Fatalf("Claude automatic Read %s replayed or changed old Reader Events", phase)
			}
			usage(fixtureCase.sessionID, stage.count, stage.input, stage.output)
			archive := assertSourceRaw(fixtureCase.sessionID, files)
			if len(archive.Objects) != 1 || len(initialArchive.Objects) != 1 || archive.Objects[0].ObjectID != initialArchive.Objects[0].ObjectID {
				t.Fatalf("Claude automatic Read %s replaced its Raw object", phase)
			}
			if stage.phase == "summary" || stage.phase == "secondcontinue" {
				idle := run(phase + "-idle")
				assertAutoProgress(phase+"-idle", idle, stage.pending)
				if idle.Cursor != capture.Cursor || idle.Observations != 0 || idle.CanonicalBatches != 0 || idle.RawChunks != 0 || !bytes.Equal(idle.RawObjects, capture.RawObjects) {
					t.Fatalf("Claude automatic Read %s idle restart advanced cursor or Raw", phase)
				}
				usage(fixtureCase.sessionID, stage.count, stage.input, stage.output)
			}
			previous = current
		}
		for _, suffix := range fixtureCase.suffixes {
			callID, calls, updates := fixtureCase.callPrefix+suffix, 0, 0
			for _, event := range previous.Events {
				if event.Tool == nil || event.Tool.ToolCallID != callID {
					continue
				}
				if event.Tool.SessionUpdate == "tool_call" {
					calls++
					var input map[string]string
					if json.Unmarshal(event.Tool.RawInput, &input) != nil || input["file_path"] != filepath.Join(home, "workspace", suffix+".txt") {
						t.Fatal("Claude automatic Read lost exact native input")
					}
				} else if event.Tool.SessionUpdate == "tool_call_update" {
					updates++
					var output string
					if event.Kind != "tool_result" || event.Tool.Status == nil || *event.Tool.Status != "completed" || json.Unmarshal(event.Tool.RawOutput, &output) != nil || !strings.Contains(output, "ATAPE_NATIVE_READ_"+strings.ToUpper(suffix)+":") {
						t.Fatal("Claude automatic Read changed actual native result")
					}
					var anchored conversation.Conversation
					decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+fixtureCase.sessionID+"?thread=root&at="+url.QueryEscape(event.ID)+"&limit=2", ""), &anchored)
					found := false
					for _, item := range anchored.Events {
						found = found || item.ID == event.ID && item.Tool != nil && item.Tool.ToolCallID == callID && item.Kind == "tool_result"
					}
					if anchored.Session.ID != fixtureCase.sessionID || anchored.Thread.ID != "root" || !found {
						t.Fatal("Claude automatic Read result anchor lost its own call")
					}
				}
			}
			if calls != 1 || updates != 1 {
				t.Fatal("Claude automatic replay duplicated a Read call or result")
			}
		}
		for _, expected := range []struct {
			suffix string
			count  int
		}{{"TOOLS:", 1}, {"TOOL_PLAN:", 1}, {"TOOL_FINAL_A:", 1}, {"TOOL_FINAL_B:", 1}, {"CONTINUE:", 2}, {"SECOND_CONTINUE:", 1}, {"SECONDCONTINUE:", 1}} {
			term := fixtureCase.textPrefix + expected.suffix
			hits := search(term)
			if len(hits.Results) != expected.count {
				t.Fatalf("Claude automatic Read Search duplicated copies or lost text: %s %+v", term, hits.Results)
			}
			for _, hit := range hits.Results {
				var anchored conversation.Conversation
				decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+fixtureCase.sessionID+"?thread=root&at="+url.QueryEscape(hit.EventID)+"&limit=2", ""), &anchored)
				found := false
				for _, event := range anchored.Events {
					found = found || event.ID == hit.EventID && strings.Contains(event.Text, term)
				}
				if hit.SessionID != fixtureCase.sessionID || hit.ThreadID != "root" || anchored.Session.ID != fixtureCase.sessionID || anchored.Thread.ID != "root" || !found {
					t.Fatal("Claude automatic Read Search anchor crossed identity")
				}
			}
		}
		for _, control := range []string{fixtureCase.callPrefix, "ATAPE_NATIVE_READ_A:", "ATAPE_NATIVE_READ_B:", fixtureCase.textPrefix + "SUMMARY:", "15000000 tokens left"} {
			if len(search(control).Results) != 0 {
				t.Fatalf("Claude automatic Read internal/tool value reached Search: %s", control)
			}
		}
		archive, contents := readRaw(fixtureCase.sessionID)
		last := fixtureCase.stages[len(fixtureCase.stages)-1]
		readRetained = append(readRetained, readRetention{fixtureCase.sessionID, fixtureCase.sourceID, last.events, last.count, last.input, last.output, archive, contents})
	}
	// Consecutive native single-Read compactions retain the same slug. Each
	// complete summary and file context is independently acknowledged.
	repeatedFiles := map[string]string{repeatedAutoReadID + ".jsonl": filepath.Join(sourceDirectory, repeatedAutoReadID+".jsonl")}
	repeatedPrevious := read(repeatedAutoReadSession, "root", 2)
	usage(repeatedAutoReadSession, 1, 23, 11)
	repeatedArchive := assertSourceRaw(repeatedAutoReadSession, repeatedFiles)
	for _, stage := range []struct {
		phase                         string
		events, count, added, pending int
		input, output                 int64
		idle                          bool
	}{
		{"warmup", 4, 2, 2, 0, 52, 24, false},
		{"r1-plan", 6, 3, 2, 0, 190052, 41, false}, {"r1-call", 7, 3, 1, 0, 190052, 41, false},
		{"r1-result", 8, 3, 1, 0, 190052, 41, false}, {"r1-originals", 8, 3, 0, 0, 190052, 41, false},
		{"r1-summary", 8, 3, 0, 0, 190052, 41, true}, {"r1-final-a", 9, 4, 1, 0, 190093, 64, false},
		{"r1-final", 10, 4, 1, 0, 190093, 64, true},
		{"r2-plan", 12, 5, 2, 0, 380093, 81, false}, {"r2-call", 13, 5, 1, 0, 380093, 81, false},
		{"r2-result", 14, 5, 1, 0, 380093, 81, false}, {"r2-originals", 14, 5, 0, 0, 380093, 81, false},
		{"r2-summary", 14, 5, 0, 0, 380093, 81, true}, {"r2-file", 14, 5, 0, 0, 380093, 81, true},
		{"r2-final-a", 15, 6, 1, 0, 380134, 104, false}, {"r2-final", 16, 6, 1, 0, 380134, 104, true},
		{"ordinary-resume", 18, 7, 2, 0, 380163, 117, true},
	} {
		phase := "repeated-auto-read-" + stage.phase
		capture := run(phase)
		assertAutoProgress(phase, capture, stage.pending)
		raw := 1
		if strings.HasSuffix(stage.phase, "summary") {
			raw = 8
		}
		if capture.CanonicalEvents != stage.added || capture.RawChunks != raw {
			t.Fatalf("Claude repeated automatic Read %s events=%d want=%d Raw=%d", phase, capture.CanonicalEvents, stage.added, capture.RawChunks)
		}
		current := read(repeatedAutoReadSession, "root", stage.events)
		oldJSON, _ := json.Marshal(repeatedPrevious.Events)
		prefixJSON, _ := json.Marshal(current.Events[:len(repeatedPrevious.Events)])
		if !bytes.Equal(oldJSON, prefixJSON) {
			t.Fatal("Claude repeated automatic Read changed acknowledged Reader Events")
		}
		usage(repeatedAutoReadSession, stage.count, stage.input, stage.output)
		archive := assertSourceRaw(repeatedAutoReadSession, repeatedFiles)
		if len(archive.Objects) != 1 || len(repeatedArchive.Objects) != 1 || archive.Objects[0].ObjectID != repeatedArchive.Objects[0].ObjectID {
			t.Fatal("Claude repeated automatic Read replaced its Raw source identity")
		}
		if stage.idle {
			idle := run(phase + "-idle")
			assertAutoProgress(phase+"-idle", idle, stage.pending)
			if idle.Cursor != capture.Cursor || idle.Observations != 0 || idle.CanonicalBatches != 0 || idle.RawChunks != 0 || !bytes.Equal(idle.RawObjects, capture.RawObjects) {
				t.Fatal("Claude repeated automatic Read idle advanced cursor or Raw receipts")
			}
			usage(repeatedAutoReadSession, stage.count, stage.input, stage.output)
		}
		repeatedPrevious = current
	}
	for round := 1; round <= 2; round++ {
		callID := fmt.Sprintf("call_82f63bfe_single_r%d_read_a", round)
		calls, results := 0, 0
		for _, event := range repeatedPrevious.Events {
			if event.Tool == nil || event.Tool.ToolCallID != callID {
				continue
			}
			if event.Tool.SessionUpdate == "tool_call" {
				calls++
				var input map[string]string
				if json.Unmarshal(event.Tool.RawInput, &input) != nil || input["file_path"] != filepath.Join(home, "workspace", fmt.Sprintf("r%d-a.txt", round)) {
					t.Fatal("Claude repeated automatic Read changed the literal call path")
				}
			} else if event.Tool.SessionUpdate == "tool_call_update" {
				results++
				var output string
				marker := fmt.Sprintf("ATAPE_REPEAT_DISK_82f63bfe_single_R%d_A:", round)
				if event.Kind != "tool_result" || event.Tool.Status == nil || *event.Tool.Status != "completed" || json.Unmarshal(event.Tool.RawOutput, &output) != nil || !strings.Contains(output, marker) {
					t.Fatal("Claude repeated automatic Read lost the actual disk receipt")
				}
				var anchored conversation.Conversation
				decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+repeatedAutoReadSession+"?thread=root&at="+url.QueryEscape(event.ID)+"&limit=2", ""), &anchored)
				found := false
				for _, item := range anchored.Events {
					found = found || item.ID == event.ID && item.Kind == "tool_result" && item.Tool != nil && item.Tool.ToolCallID == callID
				}
				if anchored.Session.ID != repeatedAutoReadSession || anchored.Thread.ID != "root" || !found {
					t.Fatal("Claude repeated Read result anchor crossed its own call")
				}
			}
		}
		if calls != 1 || results != 1 {
			t.Fatal("Claude repeated automatic replay duplicated a call or result")
		}
	}
	for _, term := range []string{"ATAPE_REPEAT_SINGLE_R1_PLAN:", "ATAPE_REPEAT_SINGLE_R2_PLAN:", "ATAPE_REPEAT_SINGLE_R1_FINAL_A:", "ATAPE_REPEAT_SINGLE_R1_FINAL_B:", "ATAPE_REPEAT_SINGLE_R2_FINAL_A:", "ATAPE_REPEAT_SINGLE_R2_FINAL_B:", "ATAPE_REPEAT_SINGLE_ORDINARY-RESUME:"} {
		hits := search(term)
		if len(hits.Results) != 1 {
			t.Fatalf("Claude repeated Read Search lost or duplicated %s", term)
		}
		hit := hits.Results[0]
		var anchored conversation.Conversation
		decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+repeatedAutoReadSession+"?thread=root&at="+url.QueryEscape(hit.EventID)+"&limit=2", ""), &anchored)
		found := false
		for _, event := range anchored.Events {
			found = found || event.ID == hit.EventID && strings.Contains(event.Text, term)
		}
		if hit.SessionID != repeatedAutoReadSession || hit.ThreadID != "root" || anchored.Session.ID != repeatedAutoReadSession || anchored.Thread.ID != "root" || !found {
			t.Fatal("Claude repeated Read Search anchor crossed identity")
		}
	}
	for _, internal := range []string{"ATAPE_REPEAT_SINGLE_R1_SUMMARY:", "ATAPE_REPEAT_SINGLE_R2_SUMMARY:", "ATAPE_REPEAT_DISK_82f63bfe_single_", "call_82f63bfe_single_"} {
		if len(search(internal).Results) != 0 {
			t.Fatalf("Claude repeated Read file/control reached Search: %s", internal)
		}
	}
	repeatedFinalArchive, repeatedRaw := readRaw(repeatedAutoReadSession)
	readRetained = append(readRetained, readRetention{repeatedAutoReadSession, repeatedAutoReadID, 18, 7, 380163, 117, repeatedFinalArchive, repeatedRaw})
	// The native planned pair completes B before A; keep that result order
	// through first-slug replay, control restarts and source deletion.
	reversedFiles := map[string]string{reversedReadPairID + ".jsonl": filepath.Join(sourceDirectory, reversedReadPairID+".jsonl")}
	reversedPrevious := read(reversedReadPairSession, "root", 2)
	usage(reversedReadPairSession, 1, 23, 11)
	reversedArchive := assertSourceRaw(reversedReadPairSession, reversedFiles)
	for _, stage := range []struct {
		phase                         string
		events, count, added, pending int
		input, output                 int64
		idle                          bool
	}{
		{"warmup", 4, 2, 2, 0, 52, 24, false}, {"plan", 6, 3, 2, 0, 190052, 41, false},
		{"call-a", 7, 3, 1, 0, 190052, 41, false}, {"call-b", 8, 3, 1, 0, 190052, 41, false},
		{"result-b", 9, 3, 1, 0, 190052, 41, true}, {"result-a", 10, 3, 1, 0, 190052, 41, false},
		{"originals", 10, 3, 0, 0, 190052, 41, false}, {"summary", 10, 3, 0, 0, 190052, 41, true},
		{"final-a", 11, 4, 1, 0, 190093, 64, false}, {"final", 12, 4, 1, 0, 190093, 64, true},
		{"ordinary-resume", 14, 5, 2, 0, 190122, 77, true},
	} {
		phase := "reversed-read-pair-" + stage.phase
		capture := run(phase)
		assertAutoProgress(phase, capture, stage.pending)
		raw := 1
		if strings.HasSuffix(stage.phase, "summary") {
			raw = 10
		}
		if capture.CanonicalEvents != stage.added || capture.RawChunks != raw {
			t.Fatalf("Claude reversed Read %s events=%d want=%d Raw=%d", phase, capture.CanonicalEvents, stage.added, capture.RawChunks)
		}
		current := read(reversedReadPairSession, "root", stage.events)
		oldJSON, _ := json.Marshal(reversedPrevious.Events)
		prefixJSON, _ := json.Marshal(current.Events[:len(reversedPrevious.Events)])
		if !bytes.Equal(oldJSON, prefixJSON) {
			t.Fatal("Claude reversed Read changed acknowledged Reader Events")
		}
		usage(reversedReadPairSession, stage.count, stage.input, stage.output)
		archive := assertSourceRaw(reversedReadPairSession, reversedFiles)
		if len(archive.Objects) != 1 || archive.Objects[0].ObjectID != reversedArchive.Objects[0].ObjectID {
			t.Fatal("Claude reversed Read changed Raw source identity")
		}
		if stage.idle {
			idle := run(phase + "-idle")
			assertAutoProgress(phase+"-idle", idle, stage.pending)
			if idle.Cursor != capture.Cursor || idle.Observations != 0 || idle.CanonicalBatches != 0 || idle.RawChunks != 0 || !bytes.Equal(idle.RawObjects, capture.RawObjects) {
				t.Fatal("Claude reversed Read idle advanced cursor or Raw receipts")
			}
			usage(reversedReadPairSession, stage.count, stage.input, stage.output)
		}
		reversedPrevious = current
	}
	resultOrder := make(map[string]int)
	for _, suffix := range []string{"a", "b"} {
		callID := "call_82f63bfe_dual_r1_read_" + suffix
		calls, results := 0, 0
		for index, event := range reversedPrevious.Events {
			if event.Tool == nil || event.Tool.ToolCallID != callID {
				continue
			}
			if event.Tool.SessionUpdate == "tool_call" {
				calls++
				var input map[string]string
				if json.Unmarshal(event.Tool.RawInput, &input) != nil || input["file_path"] != filepath.Join(home, "workspace", "r1-"+suffix+".txt") {
					t.Fatal("Claude reversed Read changed literal call path")
				}
			} else if event.Tool.SessionUpdate == "tool_call_update" {
				results++
				resultOrder[suffix] = index
				var output string
				if event.Kind != "tool_result" || event.Tool.Status == nil || *event.Tool.Status != "completed" || json.Unmarshal(event.Tool.RawOutput, &output) != nil || !strings.Contains(output, "ATAPE_REPEAT_DISK_82f63bfe_dual_R1_"+strings.ToUpper(suffix)+":") {
					t.Fatal("Claude reversed Read lost its successful own-call receipt")
				}
				var anchored conversation.Conversation
				decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+reversedReadPairSession+"?thread=root&at="+url.QueryEscape(event.ID)+"&limit=2", ""), &anchored)
				found := false
				for _, item := range anchored.Events {
					found = found || item.ID == event.ID && item.Kind == "tool_result" && item.Tool != nil && item.Tool.ToolCallID == callID
				}
				if anchored.Session.ID != reversedReadPairSession || anchored.Thread.ID != "root" || !found {
					t.Fatal("Claude reversed Read result anchor crossed its own call")
				}
			}
		}
		if calls != 1 || results != 1 {
			t.Fatal("Claude reversed Read replay duplicated a call or result")
		}
	}
	if resultOrder["b"] >= resultOrder["a"] {
		t.Fatal("Claude reversed Read sorted results into call order")
	}
	for _, term := range []string{"ATAPE_REPEAT_DUAL_R1_PLAN:", "ATAPE_REPEAT_DUAL_R1_FINAL_A:", "ATAPE_REPEAT_DUAL_R1_FINAL_B:", "ATAPE_REVERSED_READ_82f63bfe_dual_ORDINARY:", "ATAPE_REVERSED_READ_DUAL_ORDINARY:"} {
		hits := search(term)
		if len(hits.Results) != 1 {
			t.Fatalf("Claude reversed Read Search lost or duplicated %s", term)
		}
		hit := hits.Results[0]
		var anchored conversation.Conversation
		decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+reversedReadPairSession+"?thread=root&at="+url.QueryEscape(hit.EventID)+"&limit=2", ""), &anchored)
		found := false
		for _, event := range anchored.Events {
			found = found || event.ID == hit.EventID && strings.Contains(event.Text, term)
		}
		if hit.SessionID != reversedReadPairSession || hit.ThreadID != "root" || !found {
			t.Fatal("Claude reversed Read Search anchor crossed identity")
		}
	}
	for _, term := range []string{"ATAPE_REPEAT_DUAL_R1_SUMMARY:", "ATAPE_REPEAT_DISK_82f63bfe_dual_", "call_82f63bfe_dual_"} {
		if len(search(term).Results) != 0 {
			t.Fatalf("Claude reversed Read control/tool reached Search: %s", term)
		}
	}
	// The second native dual round continues this same source after its ordinary
	// turn. Each historical file has its own restartable Raw-only ACK.
	for _, stage := range []struct {
		phase                         string
		events, count, added, pending int
		input, output                 int64
		idle                          bool
	}{
		{"plan", 16, 6, 2, 0, 380122, 94, false}, {"call-a", 17, 6, 1, 0, 380122, 94, false},
		{"call-b", 18, 6, 1, 0, 380122, 94, false}, {"result-a", 19, 6, 1, 0, 380122, 94, true},
		{"result-b", 20, 6, 1, 0, 380122, 94, false}, {"originals", 20, 6, 0, 0, 380122, 94, false},
		{"summary", 20, 6, 0, 0, 380122, 94, true}, {"file-a", 20, 6, 0, 0, 380122, 94, true},
		{"files", 20, 6, 0, 0, 380122, 94, true}, {"final-a", 21, 7, 1, 0, 380163, 117, false},
		{"final", 22, 7, 1, 0, 380163, 117, true},
		{"ordinary-resume", 24, 8, 2, 0, 380192, 130, true},
	} {
		phase := "repeated-dual-read-" + stage.phase
		capture := run(phase)
		assertAutoProgress(phase, capture, stage.pending)
		raw := 1
		if strings.HasSuffix(stage.phase, "summary") {
			raw = 10
		}
		if capture.CanonicalEvents != stage.added || capture.RawChunks != raw {
			t.Fatalf("Claude repeated dual Read %s events=%d want=%d Raw=%d", phase, capture.CanonicalEvents, stage.added, capture.RawChunks)
		}
		current := read(reversedReadPairSession, "root", stage.events)
		oldJSON, _ := json.Marshal(reversedPrevious.Events)
		prefixJSON, _ := json.Marshal(current.Events[:len(reversedPrevious.Events)])
		if !bytes.Equal(oldJSON, prefixJSON) {
			t.Fatal("Claude repeated dual Read changed acknowledged Reader Events")
		}
		usage(reversedReadPairSession, stage.count, stage.input, stage.output)
		archive := assertSourceRaw(reversedReadPairSession, reversedFiles)
		if len(archive.Objects) != 1 || archive.Objects[0].ObjectID != reversedArchive.Objects[0].ObjectID {
			t.Fatal("Claude repeated dual Read replaced its Raw source")
		}
		if stage.idle {
			idle := run(phase + "-idle")
			assertAutoProgress(phase+"-idle", idle, stage.pending)
			if idle.Cursor != capture.Cursor || idle.Observations != 0 || idle.CanonicalBatches != 0 || idle.RawChunks != 0 || !bytes.Equal(idle.RawObjects, capture.RawObjects) {
				t.Fatal("Claude repeated dual Read idle advanced cursor or Raw receipts")
			}
			usage(reversedReadPairSession, stage.count, stage.input, stage.output)
		}
		reversedPrevious = current
	}
	r2ResultOrder := make(map[string]int)
	for _, suffix := range []string{"a", "b"} {
		callID := "call_atape_repeated_dual_4a0ecd53_r2_read_" + suffix
		calls, results := 0, 0
		for index, event := range reversedPrevious.Events {
			if event.Tool == nil || event.Tool.ToolCallID != callID {
				continue
			}
			if event.Tool.SessionUpdate == "tool_call" {
				calls++
				var input map[string]string
				if json.Unmarshal(event.Tool.RawInput, &input) != nil || input["file_path"] != filepath.Join(home, "workspace", "r2-"+suffix+".txt") {
					t.Fatal("Claude repeated dual Read changed its current literal path")
				}
			} else if event.Tool.SessionUpdate == "tool_call_update" {
				results++
				r2ResultOrder[suffix] = index
				var output string
				if event.Kind != "tool_result" || event.Tool.Status == nil || *event.Tool.Status != "completed" || json.Unmarshal(event.Tool.RawOutput, &output) != nil || !strings.Contains(output, "ATAPE_REPEAT_DISK_82f63bfe_dual_R2_"+strings.ToUpper(suffix)+":") {
					t.Fatal("Claude repeated dual Read lost its own-call receipt")
				}
				var anchored conversation.Conversation
				decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+reversedReadPairSession+"?thread=root&at="+url.QueryEscape(event.ID)+"&limit=2", ""), &anchored)
				found := false
				for _, item := range anchored.Events {
					found = found || item.ID == event.ID && item.Kind == "tool_result" && item.Tool != nil && item.Tool.ToolCallID == callID
				}
				if anchored.Session.ID != reversedReadPairSession || anchored.Thread.ID != "root" || !found {
					t.Fatal("Claude repeated dual Read anchor crossed its own call")
				}
			}
		}
		if calls != 1 || results != 1 {
			t.Fatal("Claude repeated dual Read duplicated a current call or result")
		}
	}
	if r2ResultOrder["a"] >= r2ResultOrder["b"] {
		t.Fatal("Claude repeated dual Read changed its current result order")
	}
	for _, term := range []string{"ATAPE_REPEATED_DUAL_4a0ecd53_R2_TOOLS:", "ATAPE_REPEATED_DUAL_4a0ecd53_R2_PLAN:", "ATAPE_REPEATED_DUAL_4a0ecd53_R2_FINAL_A:", "ATAPE_REPEATED_DUAL_4a0ecd53_R2_FINAL_B:", "ATAPE_REPEATED_DUAL_f9b20e67_ORDINARY: Confirm", "ATAPE_REPEATED_DUAL_f9b20e67_ORDINARY: both"} {
		hits := search(term)
		if len(hits.Results) != 1 {
			t.Fatalf("Claude repeated dual Read Search lost or duplicated %s", term)
		}
		hit := hits.Results[0]
		var anchored conversation.Conversation
		decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+reversedReadPairSession+"?thread=root&at="+url.QueryEscape(hit.EventID)+"&limit=2", ""), &anchored)
		found := false
		for _, event := range anchored.Events {
			found = found || event.ID == hit.EventID && strings.Contains(event.Text, term)
		}
		if hit.SessionID != reversedReadPairSession || hit.ThreadID != "root" || !found {
			t.Fatal("Claude repeated dual Read Search anchor crossed identity")
		}
	}
	for _, term := range []string{"ATAPE_REPEATED_DUAL_4a0ecd53_R2_SUMMARY:", "ATAPE_REPEAT_DISK_82f63bfe_dual_R2_", "call_atape_repeated_dual_4a0ecd53_r2_"} {
		if len(search(term).Results) != 0 {
			t.Fatalf("Claude repeated dual Read file/control reached Search: %s", term)
		}
	}
	reversedFinalArchive, reversedRaw := readRaw(reversedReadPairSession)
	readRetained = append(readRetained, readRetention{reversedReadPairSession, reversedReadPairID, 24, 8, 380192, 130, reversedFinalArchive, reversedRaw})
	// Exercise the same public Reader/Raw/usage Interfaces for small and large
	// native file context across independently restarted installed daemons.
	type manualReadStage struct {
		phase                              string
		events, count, added, pending, raw int
		input, output                      int64
		idle                               bool
	}
	verifyManualRead := func(sessionID, sourceID, phasePrefix, summaryMarker string, initialEvents int, stages []manualReadStage) {
		manualReadFiles := map[string]string{sourceID + ".jsonl": filepath.Join(sourceDirectory, sourceID+".jsonl")}
		manualReadPrevious := read(sessionID, "root", initialEvents)
		manualReadArchive := assertSourceRaw(sessionID, manualReadFiles)
		for _, stage := range stages {
			phase := phasePrefix + stage.phase
			capture := run(phase)
			source, err := os.ReadFile(manualReadFiles[sourceID+".jsonl"])
			if err != nil {
				t.Fatal(err)
			}
			assertProgress := func(current snapshot) {
				t.Helper()
				if current.InstallationID != initial.InstallationID || len(current.SourceFailures) != 0 || current.Progress == nil ||
					current.Progress.PendingCanonicalSessions != stage.pending || current.Progress.PendingRawBytes != 0 {
					t.Fatalf("Claude manual Read %s lost progress: %+v want pending=%d Raw=0", phase, current.Progress, stage.pending)
				}
			}
			assertProgress(capture)
			if capture.CanonicalEvents != stage.added || capture.RawChunks != stage.raw {
				t.Fatalf("Claude manual Read %s events=%d want=%d Raw=%d want=%d", phase, capture.CanonicalEvents, stage.added, capture.RawChunks, stage.raw)
			}
			current := read(sessionID, "root", stage.events)
			oldJSON, _ := json.Marshal(manualReadPrevious.Events)
			prefixJSON, _ := json.Marshal(current.Events[:len(manualReadPrevious.Events)])
			if !bytes.Equal(oldJSON, prefixJSON) {
				t.Fatalf("Claude manual Read %s replayed or changed old Reader Events", phase)
			}
			usage(sessionID, stage.count, stage.input, stage.output)
			archive, contents := readRaw(sessionID)
			if len(archive.Objects) != 1 || len(manualReadArchive.Objects) != 1 || archive.Objects[0].ObjectID != manualReadArchive.Objects[0].ObjectID ||
				contents[sourceID+".jsonl"] != string(source) {
				t.Fatalf("Claude manual Read %s changed Raw identity or acknowledged unproved bytes", phase)
			}
			for _, control := range []string{summaryMarker, "Continue from where you left off.", "No response requested.", "local-command", "command-name"} {
				for _, event := range current.Events {
					if strings.Contains(event.Text, control) {
						t.Fatalf("Claude manual Read %s emitted internal context as a conversation Event", phase)
					}
				}
				if len(search(control).Results) != 0 {
					t.Fatalf("Claude manual Read %s indexed internal context: %s", phase, control)
				}
			}
			if stage.idle {
				idle := run(phase + "-idle")
				assertProgress(idle)
				if idle.Cursor != capture.Cursor || idle.Observations != 0 || idle.CanonicalEvents != 0 || idle.CanonicalBatches != 0 || idle.RawChunks != 0 || !bytes.Equal(idle.RawObjects, capture.RawObjects) {
					t.Fatalf("Claude manual Read %s idle restart changed checkpoint or Raw receipts", phase)
				}
				usage(sessionID, stage.count, stage.input, stage.output)
			}
			manualReadPrevious = current
		}
	}
	verifyManualRead(pairPlanSession, pairPlanID, "manual-read-", "ATAPE_MANUAL_SUMMARY:", 12, []manualReadStage{
		{"boundary", 12, 4, 0, 1, 1, 130, 64, false},
		{"summary", 12, 4, 0, 0, 1, 130, 64, false},
		{"caveat", 12, 4, 0, 0, 1, 130, 64, false},
		{"command", 12, 4, 0, 0, 1, 130, 64, false},
		{"stdout", 12, 4, 0, 0, 1, 130, 64, true},
		{"file-first", 12, 4, 0, 0, 1, 130, 64, true},
		{"files", 12, 4, 0, 0, 1, 130, 64, true},
		{"bookkeeping", 12, 4, 0, 0, 1, 130, 64, false},
		{"meta", 12, 4, 0, 0, 1, 130, 64, true},
		{"bridge", 12, 4, 0, 0, 1, 130, 64, true},
		{"user", 13, 4, 1, 0, 1, 130, 64, false},
		{"continue", 14, 5, 1, 0, 1, 159, 77, false},
		{"secondcontinue", 16, 6, 2, 0, 1, 188, 90, true},
	})
	verifyManualRead(largeManualReadSession, largeManualReadID, "large-manual-read-", "ATAPE_MANUAL_LARGE_SUMMARY:", 2, []manualReadStage{
		{"warmup", 4, 2, 2, 0, 1, 52, 24, false},
		{"toolturn", 12, 4, 8, 0, 1, 130, 64, true},
		{"boundary", 12, 4, 0, 1, 1, 130, 64, false},
		{"summary", 12, 4, 0, 0, 1, 130, 64, false},
		{"caveat", 12, 4, 0, 0, 1, 130, 64, false},
		{"command", 12, 4, 0, 0, 1, 130, 64, false},
		{"stdout", 12, 4, 0, 0, 1, 130, 64, true},
		{"file-first", 12, 4, 0, 0, 1, 130, 64, true},
		{"files", 12, 4, 0, 0, 1, 130, 64, true},
		{"bookkeeping", 12, 4, 0, 0, 1, 130, 64, false},
		{"meta", 12, 4, 0, 0, 1, 130, 64, true},
		{"bridge", 12, 4, 0, 0, 1, 130, 64, false},
		{"user", 13, 4, 1, 0, 1, 130, 64, false},
		{"continue", 14, 5, 1, 0, 1, 159, 77, false},
		{"secondcontinue", 16, 6, 2, 0, 1, 188, 90, true},
	})
	for _, expected := range []struct {
		term  string
		count int
	}{{"ATAPE_MANUAL_TOOLS:", 1}, {"ATAPE_MANUAL_TOOL_PLAN:", 1}, {"ATAPE_MANUAL_TOOL_FINAL_A:", 1}, {"ATAPE_MANUAL_TOOL_FINAL_B:", 1},
		{"ATAPE_MANUAL_CONTINUE:", 2}, {"ATAPE_MANUAL_SECOND_CONTINUE:", 1}, {"ATAPE_MANUAL_SECONDCONTINUE:", 1}} {
		hits := search(expected.term)
		if len(hits.Results) != expected.count {
			t.Fatalf("Claude manual Read duplicated reinjected context or lost real text: %s %+v", expected.term, hits.Results)
		}
		for _, hit := range hits.Results {
			var anchored conversation.Conversation
			decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+pairPlanSession+"?thread=root&at="+url.QueryEscape(hit.EventID)+"&limit=2", ""), &anchored)
			found := false
			for _, event := range anchored.Events {
				found = found || event.ID == hit.EventID && strings.Contains(event.Text, expected.term)
			}
			if hit.SessionID != pairPlanSession || hit.ThreadID != "root" || anchored.Session.ID != pairPlanSession || anchored.Thread.ID != "root" || !found {
				t.Fatal("Claude manual Read Search anchor lost its exact real Event")
			}
		}
	}
	for _, term := range []string{"call_manual_read_", "ATAPE_NATIVE_READ_A:", "ATAPE_NATIVE_READ_B:"} {
		if len(search(term).Results) != 0 {
			t.Fatal("Claude manual file reinjection exposed tool values in Search")
		}
	}
	// The same source already had a retention entry before compact. Replace its
	// measured final state so deletion verifies the newly captured continuation.
	for i := range readRetained {
		if readRetained[i].sourceID == pairPlanID {
			archive, contents := readRaw(pairPlanSession)
			readRetained[i] = readRetention{pairPlanSession, pairPlanID, 16, 6, 188, 90, archive, contents}
		}
	}
	largeRead := read(largeManualReadSession, "root", 16)
	for _, suffix := range []string{"a", "b"} {
		callID := "call_manual_large_1_read_" + suffix
		calls, results := 0, 0
		for _, event := range largeRead.Events {
			if event.Tool == nil || event.Tool.ToolCallID != callID {
				continue
			}
			if event.Tool.SessionUpdate == "tool_call" {
				calls++
				var input map[string]string
				if err := json.Unmarshal(event.Tool.RawInput, &input); err != nil || input["file_path"] != filepath.Join(home, "workspace", suffix+".txt") {
					t.Fatal("Claude large Read lost its exact call input")
				}
			} else if event.Tool.SessionUpdate == "tool_call_update" {
				results++
				if event.Kind != "tool_result" || event.Tool.Status == nil || *event.Tool.Status != "completed" || len(event.Tool.RawOutput) != 0 {
					t.Fatal("Claude large Read lost its completed status or exceeded shared tool-detail bounds")
				}
				var anchored conversation.Conversation
				decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+largeManualReadSession+"?thread=root&at="+url.QueryEscape(event.ID)+"&limit=2", ""), &anchored)
				found := false
				for _, candidate := range anchored.Events {
					found = found || candidate.ID == event.ID && candidate.Tool != nil && candidate.Tool.ToolCallID == callID
				}
				if anchored.Session.ID != largeManualReadSession || anchored.Thread.ID != "root" || !found {
					t.Fatal("Claude large Read lost its exact own-call result anchor")
				}
			}
		}
		if calls != 1 || results != 1 {
			t.Fatal("Claude large Read duplicated or crossed its call/result association")
		}
	}
	for _, expected := range []struct {
		term  string
		count int
	}{{"ATAPE_MANUAL_LARGE_TOOLS:", 1}, {"ATAPE_MANUAL_LARGE_TOOL_PLAN:", 1}, {"ATAPE_MANUAL_LARGE_TOOL_FINAL_A:", 1}, {"ATAPE_MANUAL_LARGE_TOOL_FINAL_B:", 1},
		{"ATAPE_MANUAL_LARGE_CONTINUE:", 2}, {"ATAPE_MANUAL_LARGE_SECOND_CONTINUE:", 1}, {"ATAPE_MANUAL_LARGE_SECONDCONTINUE:", 1}} {
		hits := search(expected.term)
		if len(hits.Results) != expected.count {
			t.Fatalf("Claude large Read duplicated reinjected context or lost real text: %s %+v", expected.term, hits.Results)
		}
		for _, hit := range hits.Results {
			var anchored conversation.Conversation
			decodeResponse(t, send(http.MethodGet, "/api/v1/sessions/"+largeManualReadSession+"?thread=root&at="+url.QueryEscape(hit.EventID)+"&limit=2", ""), &anchored)
			found := false
			for _, event := range anchored.Events {
				found = found || event.ID == hit.EventID && strings.Contains(event.Text, expected.term)
			}
			if hit.SessionID != largeManualReadSession || hit.ThreadID != "root" || anchored.Session.ID != largeManualReadSession || anchored.Thread.ID != "root" || !found {
				t.Fatal("Claude large Read Search lost its exact real-message anchor")
			}
		}
	}
	for _, term := range []string{"call_manual_large_1_read_", "ATAPE_LARGE_READ_A_", "ATAPE_LARGE_READ_B_"} {
		if len(search(term).Results) != 0 {
			t.Fatal("Claude large Read exposed raw tool/file contents in Search")
		}
	}
	largeReadArchive, largeReadRaw := readRaw(largeManualReadSession)
	if len(largeReadRaw[largeManualReadID+".jsonl"]) <= 512*1024 {
		t.Fatal("Claude large Read corpus did not exercise actual larger source bytes")
	}
	readRetained = append(readRetained, readRetention{largeManualReadSession, largeManualReadID, 16, 6, 188, 90, largeReadArchive, largeReadRaw})
	compact := run("compact")
	if compact.CanonicalEvents != 0 || compact.RawChunks != 6 {
		t.Fatal("Claude compact controls created conversation Events or lost Raw")
	}
	afterCompact := read(compactSession, "root", 4)
	beforeJSON, _ := json.Marshal(before.Events)
	compactJSON, _ := json.Marshal(afterCompact.Events)
	if !bytes.Equal(beforeJSON, compactJSON) {
		t.Fatal("Claude compaction changed old Event identities")
	}
	usage(compactSession, 2, 52, 24)
	compactArchive := assertSourceRaw(compactSession, manualFiles)
	if len(beforeArchive.Objects) != 1 || len(compactArchive.Objects) != 1 || beforeArchive.Objects[0].ObjectID != compactArchive.Objects[0].ObjectID {
		t.Fatal("Claude compaction replaced its Raw object")
	}
	continued := run("continued")
	if continued.CanonicalEvents != 2 || continued.RawChunks != 2 {
		t.Fatal("Claude real continuation did not append two Events")
	}
	after := read(compactSession, "root", 6)
	afterJSON, _ := json.Marshal(after.Events[:4])
	if !bytes.Equal(beforeJSON, afterJSON) {
		t.Fatal("Claude resume replayed or re-keyed old Events")
	}
	usage(compactSession, 3, 81, 37)
	assertSourceRaw(compactSession, manualFiles)
	for _, term := range []string{"ATAPE_COMPACT_SUMMARY", "No response requested", "local-command", "command-name"} {
		if len(search(term).Results) != 0 {
			t.Fatalf("Claude internal control reached Search: %s", term)
		}
		for _, event := range after.Events {
			if strings.Contains(event.Text, term) {
				t.Fatal("Claude control became a user/assistant Event")
			}
		}
	}
	noop := run("noop")
	if noop.Cursor != continued.Cursor || noop.CanonicalBatches != 0 || noop.RawChunks != 0 || !bytes.Equal(noop.RawObjects, continued.RawObjects) {
		t.Fatal("Claude unchanged polling reset or duplicated capture")
	}
	setRaw(false)
	off := run("raw-off")
	if off.CanonicalEvents != 1 || off.RawChunks != 0 || !bytes.Equal(off.RawObjects, noop.RawObjects) {
		t.Fatal("Claude Raw-off stopped Canonical or advanced Raw receipts")
	}
	policy := read(compactSession, "root", 7)
	if strings.Contains(policy.Events[6].Text, "SENSITIVE_TEST_TOKEN") || !strings.Contains(policy.Events[6].Text, "[REDACTED]") {
		t.Fatal("Claude shared Canonical redaction failed")
	}
	setRaw(true)
	on := run("raw-on")
	if on.CanonicalEvents != 0 || on.RawChunks != 1 {
		t.Fatal("Claude Raw-on reprojected Canonical or omitted backfill")
	}
	assertSourceRaw(compactSession, manualFiles)
	if len(search("ClaudePolicyNeedle").Results) != 1 || len(search("SENSITIVE_TEST_TOKEN").Results) != 0 {
		t.Fatal("Claude Raw policy continuation or redaction failed in Search")
	}
	unsupported := run("unsupported")
	if unsupported.Cursor != on.Cursor || len(unsupported.SourceFailures) != 1 || unsupported.SourceFailures[0].Reason != "unsupported" || unsupported.RawChunks != 0 {
		t.Fatal("Claude unsupported append advanced acknowledged history")
	}
	repaired := run("repair")
	if repaired.Cursor != on.Cursor || len(repaired.SourceFailures) != 0 {
		t.Fatal("Claude exact source restoration reset capture")
	}
	// Generated mutations of the retained family test current Thread continuity,
	// without claiming native background/nested lifecycle acquisition. The proposed
	// child files exist and are otherwise plausible; only the current streams may
	// enter Reader, usage, Search or Raw.
	familyFiles := map[string]string{familyID + ".jsonl": filepath.Join(sourceDirectory, familyID+".jsonl"),
		"agent-" + agentID + ".jsonl": filepath.Join(sourceDirectory, familyID, "subagents", "agent-"+agentID+".jsonl")}
	familyBeforeArchive, familyBeforeRaw := readRaw(familySession)
	assertStablePrefix := func(phase string, previous, current []conversation.Event) {
		t.Helper()
		if len(current) < len(previous) {
			t.Fatalf("Claude %s removed acknowledged current Thread Events", phase)
		}
		for n, event := range previous {
			candidate := current[n]
			// A ChildThreadRef includes the live child Event count. Its identity is
			// checked separately below; the current stream's Event data stays exact.
			event.ChildThread, candidate.ChildThread = nil, nil
			left, _ := json.Marshal(event)
			right, _ := json.Marshal(candidate)
			if !bytes.Equal(left, right) {
				t.Fatalf("Claude %s replayed or re-keyed current Thread Event %d", phase, n)
			}
		}
	}
	assertUnlinkedView := func(phase string, rootEvents, childEvents, usageCount int, input, output int64) (conversation.Conversation, conversation.Conversation) {
		t.Helper()
		currentRoot, currentChild := read(familySession, "root", rootEvents), read(familySession, childID, childEvents)
		assertStablePrefix(phase, root.Events, currentRoot.Events)
		assertStablePrefix(phase, child.Events, currentChild.Events)
		links := 0
		for _, event := range currentRoot.Events {
			if event.ChildThread != nil {
				links++
				if event.ChildThread.ID != childID {
					t.Fatal("Claude unproved root receipt acquired child navigation")
				}
			}
		}
		if links != 1 {
			t.Fatal("Claude current root lost or invented child navigation")
		}
		for _, event := range currentChild.Events {
			if event.ChildThread != nil {
				t.Fatal("Claude unproved nested receipt acquired child navigation")
			}
		}
		stored, exists, err := store.Conversation(t.Context(), authentication.Principal{UserID: grant.User.ID, Method: authentication.WebAuthentication}, familySession, "root")
		if err != nil || !exists || len(stored.Threads) != 2 {
			t.Fatalf("Claude unproved delegation created a Thread: exists=%t threads=%d error=%v", exists, len(stored.Threads), err)
		}
		usage(familySession, usageCount, input, output)
		return currentRoot, currentChild
	}
	assertUnlinkedDiagnostics := func(phase string, capture snapshot, expected int) {
		t.Helper()
		pending := 0
		if phase == "unlinked-nested-partial" {
			pending = 1 // The incomplete line is known backlog, not an admitted record.
		}
		if capture.InstallationID != initial.InstallationID || len(capture.SourceFailures) != expected || capture.Progress == nil || capture.Progress.PendingCanonicalSessions != pending {
			t.Fatalf("Claude %s lost nonblocking diagnostics or current progress: %+v", phase, capture)
		}
		seen := map[string]bool{}
		for _, failure := range capture.SourceFailures {
			if failure.Reason != "unsupported" || failure.Source == "" || seen[failure.Source] {
				t.Fatalf("Claude %s lost bounded source/reason diagnostic identity: %+v", phase, capture.SourceFailures)
			}
			seen[failure.Source] = true
		}
	}
	setRaw(false)
	for n, slot := range []string{"async", "running", "error"} {
		phase := "unlinked-root-" + slot
		capture := run(phase)
		assertUnlinkedDiagnostics(phase, capture, 1)
		if capture.CanonicalEvents != 3 || capture.RawChunks != 0 || !bytes.Equal(capture.RawObjects, repaired.RawObjects) {
			t.Fatalf("Claude %s blocked ordinary records or advanced disabled Raw: %+v", phase, capture)
		}
		currentRoot, _ := assertUnlinkedView(phase, 7+3*n, 4, 6+2*n, int64(102+34*n), int64(54+18*n))
		call, result, reply := currentRoot.Events[4+3*n], currentRoot.Events[5+3*n], currentRoot.Events[6+3*n]
		callID := "call_generated_unlinked_" + slot
		if call.Kind != "tool_call" || call.Tool == nil || call.Tool.ToolCallID != callID || result.Kind != "tool_result" || result.Tool == nil ||
			result.Tool.ToolCallID != callID || result.Tool.Status == nil || (slot == "error" && *result.Tool.Status != "failed") ||
			(slot != "error" && *result.Tool.Status != "completed") || !strings.Contains(reply.Text, "ATAPE_CURRENT_THREAD_"+slot+":") {
			t.Fatalf("Claude %s changed ordinary tool/result/reply projection", phase)
		}
		hits := search("ATAPE_CURRENT_THREAD_" + slot + ":")
		if len(hits.Results) != 1 || hits.Results[0].SessionID != familySession || hits.Results[0].ThreadID != "root" || hits.Results[0].EventID != reply.ID {
			t.Fatal("Claude unlinked root continuation lost its exact Search anchor")
		}
	}
	nestedCall := run("unlinked-nested-call")
	assertUnlinkedDiagnostics("unlinked-nested-call", nestedCall, 1)
	if nestedCall.CanonicalEvents != 1 || nestedCall.RawChunks != 0 || !bytes.Equal(nestedCall.RawObjects, repaired.RawObjects) {
		t.Fatal("Claude pending nested call blocked the admitted child or invented receipt evidence")
	}
	_, nestedHead := assertUnlinkedView("unlinked-nested-call", 13, 5, 11, 187, 99)
	if nestedHead.Events[4].Kind != "tool_call" || nestedHead.Events[4].Tool == nil || nestedHead.Events[4].Tool.ToolCallID != "call_generated_unlinked_nested" {
		t.Fatal("Claude nested invocation did not remain a tool in its admitted child")
	}
	nestedPartial := run("unlinked-nested-partial")
	assertUnlinkedDiagnostics("unlinked-nested-partial", nestedPartial, 1)
	if nestedPartial.Cursor != nestedCall.Cursor || nestedPartial.Observations != 0 || nestedPartial.CanonicalBatches != 0 || nestedPartial.RawChunks != 0 || !bytes.Equal(nestedPartial.RawObjects, nestedCall.RawObjects) {
		t.Fatal("Claude partial nested receipt advanced accepted source progress")
	}
	assertUnlinkedView("unlinked-nested-partial", 13, 5, 11, 187, 99)
	nestedComplete := run("unlinked-nested-complete")
	assertUnlinkedDiagnostics("unlinked-nested-complete", nestedComplete, 2)
	if nestedComplete.CanonicalEvents != 2 || nestedComplete.RawChunks != 0 || !bytes.Equal(nestedComplete.RawObjects, repaired.RawObjects) {
		t.Fatal("Claude nested relationship failure blocked current child continuation")
	}
	unlinkedRoot, unlinkedChild := assertUnlinkedView("unlinked-nested-complete", 13, 7, 12, 204, 108)
	assertStablePrefix("unlinked-nested-complete", nestedHead.Events, unlinkedChild.Events)
	nestedResult, nestedReply := unlinkedChild.Events[5], unlinkedChild.Events[6]
	if nestedResult.Kind != "tool_result" || nestedResult.Tool == nil || nestedResult.Tool.ToolCallID != "call_generated_unlinked_nested" ||
		!strings.Contains(nestedReply.Text, "ATAPE_CURRENT_THREAD_nested:") {
		t.Fatal("Claude nested receipt/following reply did not remain in its admitted child")
	}
	nestedHits := search("ATAPE_CURRENT_THREAD_nested:")
	if len(nestedHits.Results) != 1 || nestedHits.Results[0].SessionID != familySession || nestedHits.Results[0].ThreadID != childID || nestedHits.Results[0].EventID != nestedReply.ID {
		t.Fatal("Claude nested current Thread reply lost its exact Search anchor")
	}
	for _, slot := range []string{"async", "running", "error", "nested"} {
		for _, term := range []string{"ATAPE_UNLINKED_TOOL_" + slot, "ATAPE_UNPROVED_HISTORY_" + slot} {
			if len(search(term).Results) != 0 {
				t.Fatalf("Claude unproved history or tool details reached Search: %s", term)
			}
		}
	}
	// A fresh root page returns before the child rotation. Already captured
	// child's diagnostic must remain visible even on this ordinary root append.
	rootResume := run("unlinked-root-resume")
	assertUnlinkedDiagnostics("unlinked-root-resume", rootResume, 2)
	if rootResume.CanonicalEvents != 1 || rootResume.RawChunks != 0 || !bytes.Equal(rootResume.RawObjects, repaired.RawObjects) {
		t.Fatal("Claude ordinary root append blocked or advanced disabled Raw after nested delegation")
	}
	resumedRoot, resumedChild := assertUnlinkedView("unlinked-root-resume", 14, 7, 13, 221, 117)
	assertStablePrefix("unlinked-root-resume", unlinkedRoot.Events, resumedRoot.Events)
	assertStablePrefix("unlinked-root-resume", unlinkedChild.Events, resumedChild.Events)
	resumeHits := search("ATAPE_CURRENT_THREAD_root_resume:")
	if len(resumeHits.Results) != 1 || resumeHits.Results[0].SessionID != familySession || resumeHits.Results[0].ThreadID != "root" || resumeHits.Results[0].EventID != resumedRoot.Events[13].ID {
		t.Fatal("Claude ordinary root append after nested delegation lost its exact Search anchor")
	}
	unlinkedRoot = resumedRoot
	assertUnlinkedIdle := func(phase string, previous snapshot) snapshot {
		t.Helper()
		idle := run(phase)
		assertUnlinkedDiagnostics(phase, idle, 2)
		oldFailures, _ := json.Marshal(previous.SourceFailures)
		newFailures, _ := json.Marshal(idle.SourceFailures)
		if idle.Cursor != previous.Cursor || idle.Observations != 0 || idle.CanonicalBatches != 0 || idle.RawChunks != 0 || !bytes.Equal(idle.RawObjects, previous.RawObjects) || !bytes.Equal(oldFailures, newFailures) {
			t.Fatal("Claude idle restart lost unlinked diagnostics or repeated accepted progress")
		}
		assertUnlinkedView(phase, 14, 7, 13, 221, 117)
		return idle
	}
	assertUnlinkedIdle("unlinked-idle", rootResume)
	familyStillArchive, familyStillRaw := readRaw(familySession)
	familyBeforeJSON, _ := json.Marshal(familyBeforeArchive)
	familyStillJSON, _ := json.Marshal(familyStillArchive)
	if !bytes.Equal(familyBeforeJSON, familyStillJSON) || familyBeforeRaw[familyID+".jsonl"] != familyStillRaw[familyID+".jsonl"] || familyBeforeRaw["agent-"+agentID+".jsonl"] != familyStillRaw["agent-"+agentID+".jsonl"] {
		t.Fatal("Claude Raw-off unlinked continuation changed acknowledged archives")
	}
	setRaw(true)
	unlinkedBackfill := run("unlinked-backfill")
	assertUnlinkedDiagnostics("unlinked-backfill", unlinkedBackfill, 2)
	// Legacy Raw observations repeat current Session/Thread headers; they must
	// add no Events or usage rather than promising zero header-only batches.
	if unlinkedBackfill.CanonicalEvents != 0 || unlinkedBackfill.RawChunks != 2 || unlinkedBackfill.Progress.PendingRawBytes != 0 {
		t.Fatal("Claude unlinked current Thread Raw backfill reprojected Events or omitted bytes")
	}
	backfilledFamily := assertSourceRaw(familySession, familyFiles)
	if len(backfilledFamily.Objects) != len(familyBeforeArchive.Objects) {
		t.Fatal("Claude unproved child acquired a Raw object")
	}
	for n, object := range backfilledFamily.Objects {
		if object.ObjectID != familyBeforeArchive.Objects[n].ObjectID || object.CurrentGeneration != familyBeforeArchive.Objects[n].CurrentGeneration {
			t.Fatal("Claude unlinked continuation changed root/child Raw identities")
		}
	}
	backfilledRoot, backfilledChild := assertUnlinkedView("unlinked-backfill", 14, 7, 13, 221, 117)
	assertStablePrefix("unlinked-backfill", unlinkedRoot.Events, backfilledRoot.Events)
	assertStablePrefix("unlinked-backfill", unlinkedChild.Events, backfilledChild.Events)
	unlinkedLatest := assertUnlinkedIdle("unlinked-backfill-idle", unlinkedBackfill)
	// A separate, explicitly selected generated Session isolates the actual
	// projection upgrade from the retained 197 installed stages. When supplied,
	// the previous artifact itself produces the persisted seed checkpoint/Raw.
	thinkingSeed := run("thinking-seed")
	seedEvents := 8
	if previousTarball != "" {
		seedEvents = 5
	}
	if thinkingSeed.CanonicalEvents != seedEvents || thinkingSeed.RawChunks != 1 || len(thinkingSeed.SourceFailures) != 0 {
		t.Fatalf("Claude mixed thinking seed did not use its actual installed projection: %+v", thinkingSeed)
	}
	var thinkingMemory conversation.ProjectMemory
	decodeResponse(t, send(http.MethodGet, "/api/v1/projects/"+project.ID+"/memory", ""), &thinkingMemory)
	thinkingSession := ""
	for _, session := range thinkingMemory.Trail {
		if strings.HasPrefix(session.Title, "ATAPE_GENERATED_THINKING_SEED:") {
			thinkingSession = session.ID
		}
	}
	if thinkingSession == "" {
		t.Fatal("Claude thinking seed lost its attributable Session")
	}
	parseThinkingTimestamp := func(value string) time.Time {
		t.Helper()
		instant, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			t.Fatalf("Claude thinking timestamp %q is not RFC3339: %v", value, err)
		}
		return instant
	}
	thinkingBefore := read(thinkingSession, "root", seedEvents)
	seedUpdatedAt := parseThinkingTimestamp("2026-10-08T13:00:04Z")
	if previousTarball != "" {
		seedUpdatedAt = parseThinkingTimestamp("2026-10-08T13:00:03Z")
	}
	beforeUpdatedAt := parseThinkingTimestamp(thinkingBefore.Session.UpdatedAt)
	if !beforeUpdatedAt.Equal(seedUpdatedAt) {
		t.Fatalf("Claude seed updatedAt=%s want old/new visible EOF=%s", thinkingBefore.Session.UpdatedAt, seedUpdatedAt)
	}
	thinkingStoredBefore, exists, err := store.Conversation(t.Context(), authentication.Principal{UserID: grant.User.ID, Method: authentication.WebAuthentication}, thinkingSession, "root")
	if err != nil || !exists || len(thinkingStoredBefore.Events) != seedEvents {
		t.Fatalf("Claude thinking seed did not persist its expected Canonical Events: exists=%t error=%v", exists, err)
	}
	seedProjection := int64(5)
	if previousTarball != "" {
		seedProjection = 4
	}
	for _, event := range thinkingStoredBefore.Events {
		if event.ProjectionRevision != seedProjection {
			t.Fatalf("Claude actual seed projection=%d want=%d", event.ProjectionRevision, seedProjection)
		}
	}
	usage(thinkingSession, 2, 34, 18)
	thinkingFiles := map[string]string{thinkingID + ".jsonl": filepath.Join(sourceDirectory, thinkingID+".jsonl")}
	thinkingArchive := assertSourceRaw(thinkingSession, thinkingFiles)
	if len(thinkingArchive.Objects) != 1 {
		t.Fatal("Claude thinking seed did not establish one Raw identity")
	}
	setRaw(false)
	thinkingUpgrade := run("thinking-upgrade")
	if thinkingUpgrade.InstallationID != thinkingSeed.InstallationID || thinkingUpgrade.RawChunks != 0 || !bytes.Equal(thinkingUpgrade.RawObjects, thinkingSeed.RawObjects) || len(thinkingUpgrade.SourceFailures) != 0 ||
		(previousTarball != "" && thinkingUpgrade.CanonicalEvents != 8) || (previousTarball == "" && thinkingUpgrade.CanonicalEvents != 0) {
		t.Fatalf("Claude installed thinking upgrade reset receipts or used the wrong projection: %+v", thinkingUpgrade)
	}
	thinkingProjected := read(thinkingSession, "root", 8)
	projectedUpdatedAt := parseThinkingTimestamp(thinkingProjected.Session.UpdatedAt)
	if !projectedUpdatedAt.Equal(parseThinkingTimestamp("2026-10-08T13:00:04Z")) || previousTarball != "" && !projectedUpdatedAt.After(beforeUpdatedAt) {
		t.Fatal("Claude thought-only EOF did not advance the upgraded Session's visible updatedAt")
	}
	// New thought slots can precede old text/tool slots. Compare identities and
	// complete Reader data by Event ID, not by their changed list positions.
	for _, previous := range thinkingBefore.Events {
		found := false
		for _, current := range thinkingProjected.Events {
			if current.ID == previous.ID {
				oldJSON, _ := json.Marshal(previous)
				newJSON, _ := json.Marshal(current)
				if !bytes.Equal(oldJSON, newJSON) {
					t.Fatal("Claude thinking upgrade changed an existing text/tool Event")
				}
				found = true
			}
		}
		if !found {
			t.Fatal("Claude thinking upgrade lost an existing text/tool Event identity")
		}
	}
	assertThinkingStored := func(phase string, expectedEvents int) {
		t.Helper()
		stored, exists, err := store.Conversation(t.Context(), authentication.Principal{UserID: grant.User.ID, Method: authentication.WebAuthentication}, thinkingSession, "root")
		if err != nil || !exists || len(stored.Events) != expectedEvents {
			t.Fatalf("Claude %s lost its Canonical projection: exists=%t events=%d error=%v", phase, exists, len(stored.Events), err)
		}
		if phase == "thinking-upgrade" && previousTarball != "" && (stored.Session.Revision <= thinkingStoredBefore.Session.Revision || !stored.Session.UpdatedAt.After(thinkingStoredBefore.Session.UpdatedAt)) {
			t.Fatalf("Claude thought-only EOF did not advance Session revision and updatedAt: before=%d/%s after=%d/%s",
				thinkingStoredBefore.Session.Revision, thinkingStoredBefore.Session.UpdatedAt, stored.Session.Revision, stored.Session.UpdatedAt)
		}
		byID := map[string]canonical.EventRecord{}
		for _, event := range stored.Events {
			if event.ProjectionRevision != 5 {
				t.Fatalf("Claude %s left active Event %s at projection %d", phase, event.ID, event.ProjectionRevision)
			}
			byID[event.ID] = event
		}
		for _, previous := range thinkingStoredBefore.Events {
			current, ok := byID[previous.ID]
			if !ok || current.Revision != previous.Revision || current.RawRef != previous.RawRef {
				t.Fatalf("Claude %s changed acknowledged source revision or Raw reference for Event %s", phase, previous.ID)
			}
		}
	}
	assertThinkingView := func(phase string, expectedEvents, expectedThoughts, expectedUsage int) conversation.Conversation {
		t.Helper()
		assertThinkingStored(phase, expectedEvents)
		current := read(thinkingSession, "root", expectedEvents)
		thoughts := 0
		for _, event := range current.Events {
			if strings.Contains(event.Text, "SENSITIVE_TEST_TOKEN") || strings.Contains(event.Text, "ATAPE_THOUGHT_SIGNATURE") || strings.Contains(event.Text, "ATAPE_REDACTED_PAYLOAD") {
				t.Fatalf("Claude %s exposed unredacted or opaque thinking data in Reader", phase)
			}
			if event.Kind == "thought" {
				thoughts++
				if event.Author != "Claude Code" || !strings.Contains(event.Text, "ATAPE_THOUGHT_ONLY_") || !strings.Contains(event.Text, "[REDACTED]") {
					t.Fatal("Claude persisted thinking did not arrive as a redacted assistant thought")
				}
			}
		}
		if thoughts != expectedThoughts {
			t.Fatalf("Claude %s thoughts=%d want=%d", phase, thoughts, expectedThoughts)
		}
		usage(thinkingSession, expectedUsage, int64(expectedUsage*17), int64(expectedUsage*9))
		for _, term := range []string{"ATAPE_THOUGHT_ONLY", "ATAPE_THOUGHT_SIGNATURE", "ATAPE_REDACTED_PAYLOAD", "ATAPE_THINKING_TOOL_OUTPUT"} {
			if len(search(term).Results) != 0 {
				t.Fatalf("Claude %s admitted thought/opaque/tool content into message Search: %s", phase, term)
			}
		}
		return current
	}
	assertThinkingView("thinking-upgrade", 8, 3, 2)
	for _, slot := range []string{"mixed", "final"} {
		hits := search("ATAPE_THINKING_MESSAGE_" + slot + ":")
		if len(hits.Results) != 1 || hits.Results[0].SessionID != thinkingSession || hits.Results[0].ThreadID != "root" {
			t.Fatal("Claude thinking upgrade lost a visible text Search anchor")
		}
		found := false
		for _, event := range thinkingBefore.Events {
			found = found || event.ID == hits.Results[0].EventID && strings.Contains(event.Text, "ATAPE_THINKING_MESSAGE_"+slot+":")
		}
		if !found {
			t.Fatal("Claude thinking upgrade moved the acknowledged text anchor")
		}
	}
	thinkingAppend := run("thinking-append")
	if thinkingAppend.CanonicalEvents != 2 || thinkingAppend.RawChunks != 0 || !bytes.Equal(thinkingAppend.RawObjects, thinkingSeed.RawObjects) || len(thinkingAppend.SourceFailures) != 0 {
		t.Fatal("Claude Raw-off thought/text append stopped Canonical or advanced Raw receipts")
	}
	thinkingCurrent := assertThinkingView("thinking-append", 10, 4, 3)
	assertStablePrefix("thinking-append", thinkingProjected.Events, thinkingCurrent.Events)
	appendHits := search("ATAPE_THINKING_MESSAGE_append:")
	if len(appendHits.Results) != 1 || appendHits.Results[0].SessionID != thinkingSession || appendHits.Results[0].ThreadID != "root" || appendHits.Results[0].EventID != thinkingCurrent.Events[9].ID {
		t.Fatal("Claude Raw-off visible text lost its exact Search anchor")
	}
	assertThinkingIdle := func(phase string, previous snapshot) snapshot {
		t.Helper()
		idle := run(phase)
		if idle.InstallationID != thinkingSeed.InstallationID || idle.Cursor != previous.Cursor || idle.Observations != 0 || idle.CanonicalBatches != 0 || idle.RawChunks != 0 || !bytes.Equal(idle.RawObjects, previous.RawObjects) || len(idle.SourceFailures) != 0 {
			t.Fatalf("Claude %s repeated thinking/usage or changed acknowledged receipts: %+v", phase, idle)
		}
		assertThinkingView(phase, 10, 4, 3)
		return idle
	}
	assertThinkingIdle("thinking-idle", thinkingAppend)
	thinkingStillArchive, _ := readRaw(thinkingSession)
	thinkingArchiveJSON, _ := json.Marshal(thinkingArchive)
	thinkingStillJSON, _ := json.Marshal(thinkingStillArchive)
	if !bytes.Equal(thinkingArchiveJSON, thinkingStillJSON) {
		t.Fatal("Claude Raw-off thinking projection/append changed its old archive")
	}
	setRaw(true)
	thinkingBackfill := run("thinking-backfill")
	if thinkingBackfill.CanonicalEvents != 0 || thinkingBackfill.RawChunks != 1 || len(thinkingBackfill.SourceFailures) != 0 {
		t.Fatal("Claude thinking Raw backfill duplicated Events or omitted retained bytes")
	}
	thinkingBackfilledArchive := assertSourceRaw(thinkingSession, thinkingFiles)
	if len(thinkingBackfilledArchive.Objects) != 1 || thinkingBackfilledArchive.Objects[0].ObjectID != thinkingArchive.Objects[0].ObjectID || thinkingBackfilledArchive.Objects[0].CurrentGeneration != thinkingArchive.Objects[0].CurrentGeneration {
		t.Fatal("Claude thinking upgrade/backfill changed the old Raw identity")
	}
	thinkingAfterBackfill := assertThinkingView("thinking-backfill", 10, 4, 3)
	assertStablePrefix("thinking-backfill", thinkingCurrent.Events, thinkingAfterBackfill.Events)
	assertThinkingIdle("thinking-backfill-idle", thinkingBackfill)
	thinkingWireMutex.Lock()
	wireRequests := append([]ingestion.Batch(nil), thinkingRequests...)
	wireLeaked := thinkingWireLeak
	thinkingWireMutex.Unlock()
	if wireLeaked {
		t.Fatal("Claude thought body was not redacted before authenticated HTTP ingestion")
	}
	wireThoughts := map[string]bool{}
	for _, request := range wireRequests {
		for _, event := range request.Events {
			if event.ProjectionRevision != 5 {
				continue
			}
			if event.Kind == "thought" {
				parts := strings.Split(event.SourceEventID, ":")
				blank := strings.TrimFunc(event.Text, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' }) == ""
				if blank || len(parts) != 2 || event.RawRef.Type != "object" || event.RawRef.Fragment != "record="+parts[0]+"&block="+parts[1] || !strings.Contains(event.Text, "[REDACTED]") {
					t.Fatal("Claude thought HTTP Event lost its exact source block or redaction")
				}
				wireThoughts[event.SourceEventID] = true
			}
		}
	}
	for _, sourceEventID := range []string{"generated-thinking-mixed:0", "generated-thinking-final:1", "generated-thinking-eof:0", "generated-thinking-append:0"} {
		if !wireThoughts[sourceEventID] {
			t.Fatalf("Claude HTTP did not deliver physical thought coordinate %s", sourceEventID)
		}
	}
	if len(wireThoughts) != 4 {
		t.Fatal("Claude opaque payload or signature became a Canonical thought")
	}
	retainedArchive, retainedRaw := readRaw(compactSession)
	tailRetainedArchive, tailRetainedRaw := readRaw(tailSession)
	autoRetainedArchive, autoRetainedRaw := readRaw(autoSession)
	deleted := run("delete")
	if deleted.Cursor != unlinkedLatest.Cursor || deleted.InstallationID != initial.InstallationID || !bytes.Equal(deleted.RawObjects, unlinkedLatest.RawObjects) || deleted.CanonicalBatches != 0 || deleted.RawChunks != 0 {
		t.Fatal("Claude source deletion discarded checkpoints or history")
	}
	read(familySession, "root", 14)
	read(familySession, childID, 7)
	assertThinkingView("delete", 10, 4, 3)
	thinkingDeletedArchive, _ := readRaw(thinkingSession)
	thinkingBackfilledJSON, _ := json.Marshal(thinkingBackfilledArchive)
	thinkingDeletedJSON, _ := json.Marshal(thinkingDeletedArchive)
	if !bytes.Equal(thinkingBackfilledJSON, thinkingDeletedJSON) {
		t.Fatal("Claude source deletion changed captured thinking Raw")
	}
	read(compactSession, "root", 7)
	read(tailSession, "root", 11)
	read(autoSession, "root", 10)
	deletedArchive, deletedRaw := readRaw(compactSession)
	retainedJSON, _ := json.Marshal(retainedArchive)
	deletedJSON, _ := json.Marshal(deletedArchive)
	if !bytes.Equal(retainedJSON, deletedJSON) || retainedRaw[compactID+".jsonl"] != deletedRaw[compactID+".jsonl"] {
		t.Fatal("Claude source deletion changed captured Raw")
	}
	usage(compactSession, 3, 81, 37)
	tailDeletedArchive, tailDeletedRaw := readRaw(tailSession)
	tailRetainedJSON, _ := json.Marshal(tailRetainedArchive)
	tailDeletedJSON, _ := json.Marshal(tailDeletedArchive)
	if !bytes.Equal(tailRetainedJSON, tailDeletedJSON) || tailRetainedRaw[tailID+".jsonl"] != tailDeletedRaw[tailID+".jsonl"] {
		t.Fatal("Claude source deletion changed split text captured Raw")
	}
	usage(tailSession, 5, 151, 73)
	autoDeletedArchive, autoDeletedRaw := readRaw(autoSession)
	autoRetainedJSON, _ := json.Marshal(autoRetainedArchive)
	autoDeletedJSON, _ := json.Marshal(autoDeletedArchive)
	if !bytes.Equal(autoRetainedJSON, autoDeletedJSON) || autoRetainedRaw[autoID+".jsonl"] != autoDeletedRaw[autoID+".jsonl"] {
		t.Fatal("Claude source deletion changed automatic replay captured Raw")
	}
	usage(autoSession, 5, 760023, 63)
	for _, retained := range readRetained {
		read(retained.sessionID, "root", retained.events)
		usage(retained.sessionID, retained.count, retained.input, retained.output)
		archive, contents := readRaw(retained.sessionID)
		previousJSON, _ := json.Marshal(retained.archive)
		currentJSON, _ := json.Marshal(archive)
		if !bytes.Equal(previousJSON, currentJSON) || retained.contents[retained.sourceID+".jsonl"] != contents[retained.sourceID+".jsonl"] {
			t.Fatal("Claude source deletion changed captured Read Raw")
		}
	}
}
