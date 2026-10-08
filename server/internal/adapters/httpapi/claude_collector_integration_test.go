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
	if initial.CanonicalEvents != 12 || initial.RawChunks != 3 {
		t.Fatalf("Claude initial installed capture: %+v", initial)
	}
	var memory conversation.ProjectMemory
	decodeResponse(t, send(http.MethodGet, "/api/v1/projects/"+project.ID+"/memory", ""), &memory)
	if len(memory.Trail) != 2 {
		t.Fatal("Claude included a foreign source or split its foreground family")
	}
	familySession, compactSession := "", ""
	for _, session := range memory.Trail {
		if strings.HasPrefix(session.Title, "ATAPE_NATIVE_FOREGROUND_ROOT") {
			familySession = session.ID
		}
		if strings.HasPrefix(session.Title, "ATAPE_NATIVE_COMPACT_SEED") {
			compactSession = session.ID
		}
	}
	if familySession == "" || compactSession == "" {
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
	deleted := run("delete")
	if deleted.Cursor != repaired.Cursor || deleted.InstallationID != initial.InstallationID || !bytes.Equal(deleted.RawObjects, repaired.RawObjects) || deleted.CanonicalBatches != 0 || deleted.RawChunks != 0 {
		t.Fatal("Claude source deletion discarded checkpoints or history")
	}
	read(familySession, "root", 4)
	read(familySession, childID, 4)
	read(compactSession, "root", 7)
	deletedArchive, deletedRaw := readRaw(compactSession)
	retainedJSON, _ := json.Marshal(retainedArchive)
	deletedJSON, _ := json.Marshal(deletedArchive)
	if !bytes.Equal(retainedJSON, deletedJSON) || retainedRaw[compactID+".jsonl"] != deletedRaw[compactID+".jsonl"] {
		t.Fatal("Claude source deletion changed captured Raw")
	}
	usage(compactSession, 3, 81, 37)
}
