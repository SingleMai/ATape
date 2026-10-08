package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
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

func assertClaudeCollectorContract(t *testing.T, h *Handler, modules Modules, pool *pgxpool.Pool) {
	t.Helper()
	project, grant, credential := nativeCollectorActor(t, modules, pool, "claude")
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
	repository, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	home, artifacts := t.TempDir(), t.TempDir()
	pack := func(directory string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "npm", "pack", "--json", "--pack-destination", artifacts)
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
	tarball, cliTarball := pack("adapters/claude"), pack("apps/cli")
	type snapshot struct {
		InstallationID   string                    `json:"installationId"`
		Cursor           string                    `json:"cursor"`
		RawObjects       json.RawMessage           `json:"rawObjects"`
		Observations     int                       `json:"observations"`
		CanonicalEvents  int                       `json:"canonicalEvents"`
		CanonicalBatches int                       `json:"canonicalBatches"`
		RawChunks        int                       `json:"rawChunks"`
		SourceFailures   []struct{ Reason string } `json:"sourceFailures"`
		Progress         *struct {
			PendingCanonicalSessions int   `json:"pendingCanonicalSessions"`
			PendingRawBytes          int64 `json:"pendingRawBytes"`
		} `json:"progress"`
	}
	run := func(phase string) snapshot {
		t.Helper()
		input, err := json.Marshal(map[string]any{"phase": phase, "origin": origin, "credential": credential,
			"userId": grant.User.ID, "home": home, "tarball": tarball, "cliTarball": cliTarball, "projectId": project.ID, "teamId": project.TeamID})
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
			// head/page contract is not enabled by this additive Adapter profile.
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
			time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
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
			for n := 0; n < 20; n++ {
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
	if initial.CanonicalEvents != 27 || initial.RawChunks != 7 {
		t.Fatalf("Claude initial installed capture: %+v", initial)
	}
	var memory conversation.ProjectMemory
	decodeResponse(t, send(http.MethodGet, "/api/v1/projects/"+project.ID+"/memory", ""), &memory)
	if len(memory.Trail) != 6 {
		t.Fatal("Claude included a foreign source or split its foreground family")
	}
	familySession, compactSession, tailSession, autoSession := "", "", "", ""
	pairToolSession, pairPlanSession := "", ""
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
	}
	if familySession == "" || compactSession == "" || tailSession == "" || autoSession == "" || pairToolSession == "" || pairPlanSession == "" {
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
	// Keep its staged daemon restarts independent of the original single-tail
	// assertions below, so broader evidence cannot weaken the first profile.
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
		phase                 string
		events, usage, added  int
		input, output         int64
		searchTerm            string
		expectedSearchResults int
	}{
		{"tail-compact", 7, 3, 0, 93, 47, "", 0},
		{"tail-continued", 9, 4, 2, 122, 60, "ATAPE_MANUAL_TEXT_CONTINUE:", 2},
		{"tail-continued-again", 11, 5, 2, 151, 73, "ATAPE_MANUAL_TEXT_SECONDCONTINUE:", 1},
	} {
		tailLatest = run(stage.phase)
		if tailLatest.InstallationID != initial.InstallationID || tailLatest.CanonicalEvents != stage.added || tailLatest.RawChunks != 1 {
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
	// This fourth native Session repeats the strict automatic U/G-copy profile
	// across three appends. All cuts are complete prefixes of native snapshots;
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
		summary := run(prefix + "summary")
		assertAutoProgress(prefix+"summary", summary, 1)
		if summary.CanonicalEvents != 0 || summary.RawChunks != 1 {
			t.Fatalf("Claude automatic round %d U/G copies or B/S events=%d Raw=%d", round, summary.CanonicalEvents, summary.RawChunks)
		}
		assertAutoView(prefix+"summary", events+1, count, input, output)
		assertAutoIdle(prefix+"summary-idle", summary, 1, events+1, count, input, output)
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
	// Retain the previous 32 source stages and add independently restarted
	// call/result boundaries for both native exact-two Read response layouts.
	type pairRetention struct {
		sessionID, sourceID string
		events, count       int
		input, output       int64
		archive             rawarchive.SessionArchive
		contents            map[string]string
	}
	var pairRetained []pairRetention
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
			{"r0", 4, 1, 1, 1, 31, 7}, {"r1", 5, 1, 1, 0, 31, 7},
			{"final", 6, 2, 1, 0, 72, 18}, {"resume", 8, 3, 2, 0, 101, 31},
		}},
		{"pair-plan-", pairPlanSession, pairPlanID, "call_manual_read_", "ATAPE_NATIVE_READ_", 4, 2, 52, 24, []struct {
			phase                         string
			events, count, added, pending int
			input, output                 int64
		}{
			{"plan", 6, 3, 2, 0, 89, 41}, {"call0", 7, 3, 1, 0, 89, 41}, {"call1", 8, 3, 1, 0, 89, 41},
			{"r0", 9, 3, 1, 1, 89, 41}, {"r1", 10, 3, 1, 0, 89, 41},
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
		pairRetained = append(pairRetained, pairRetention{fixtureCase.sessionID, fixtureCase.sourceID, last.events, last.count, last.input, last.output, archive, contents})
	}
	compact := run("compact")
	if compact.CanonicalEvents != 0 || compact.RawChunks != 1 {
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
	if continued.CanonicalEvents != 2 || continued.RawChunks != 1 {
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
	retainedArchive, retainedRaw := readRaw(compactSession)
	tailRetainedArchive, tailRetainedRaw := readRaw(tailSession)
	autoRetainedArchive, autoRetainedRaw := readRaw(autoSession)
	deleted := run("delete")
	if deleted.Cursor != repaired.Cursor || deleted.InstallationID != initial.InstallationID || !bytes.Equal(deleted.RawObjects, repaired.RawObjects) || deleted.CanonicalBatches != 0 || deleted.RawChunks != 0 {
		t.Fatal("Claude source deletion discarded checkpoints or history")
	}
	read(familySession, "root", 4)
	read(familySession, childID, 4)
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
	for _, retained := range pairRetained {
		read(retained.sessionID, "root", retained.events)
		usage(retained.sessionID, retained.count, retained.input, retained.output)
		archive, contents := readRaw(retained.sessionID)
		previousJSON, _ := json.Marshal(retained.archive)
		currentJSON, _ := json.Marshal(archive)
		if !bytes.Equal(previousJSON, currentJSON) || retained.contents[retained.sourceID+".jsonl"] != contents[retained.sourceID+".jsonl"] {
			t.Fatal("Claude source deletion changed Read-pair captured Raw")
		}
	}
}
