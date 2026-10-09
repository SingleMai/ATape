package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The genuine previous package creates its own opaque checkpoints and accepted
// legacy data. No cursor/version relabelling or direct private store seeding.
func assertClaudeRewindCollectorContract(t *testing.T, modules Modules, pool *pgxpool.Pool) {
	t.Helper()
	legacyTarball := os.Getenv("ATAPE_CLAUDE_LEGACY_TARBALL")
	info, err := os.Stat(legacyTarball)
	if !filepath.IsAbs(legacyTarball) || err != nil || !info.Mode().IsRegular() {
		t.Fatal("ATAPE_CLAUDE_LEGACY_TARBALL must identify the genuine f609353 projection5 package")
	}
	legacyBytes, err := os.ReadFile(legacyTarball)
	if err != nil {
		t.Fatal(err)
	}
	legacyHash := sha256.Sum256(legacyBytes)
	t.Logf("Claude rewind genuine legacy artifact: %s SHA256=%x", legacyTarball, legacyHash)
	project, grant, credential := nativeCollectorActor(t, modules, pool, "claude-rewind")
	cookie := &http.Cookie{Name: "atape_session_dev", Value: grant.SessionSecret}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	handler, err := NewHandler(Config{InstanceOrigin: origin, WebOrigin: origin, APIOrigin: origin, DevelopmentAllowHTTP: true}, modules)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	var faults sync.Mutex
	loseActivation, lostActivations, wireLeak, redactedThought := false, 0, false, false
	adoptions := map[string]publication.Adoption{}
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/publications/adopt-legacy" {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, r)
			if response.Code == http.StatusOK {
				var receipt publication.Adoption
				if json.Unmarshal(response.Body.Bytes(), &receipt) == nil {
					faults.Lock()
					adoptions[receipt.SessionID] = receipt
					faults.Unlock()
				}
			}
			for key, values := range response.Header() {
				w.Header()[key] = values
			}
			w.WriteHeader(response.Code)
			_, _ = w.Write(response.Body.Bytes())
			return
		}
		if r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/parts/") {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "read publication contract body", 500)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			faults.Lock()
			wireLeak = wireLeak || bytes.Contains(body, []byte("SENSITIVE_TEST_TOKEN")) || bytes.Contains(body, []byte("ATAPE_PRIVATE_SIGNATURE"))
			redactedThought = redactedThought || bytes.Contains(body, []byte("ATAPE_GENERATED_THOUGHT_")) && bytes.Contains(body, []byte("[REDACTED]"))
			faults.Unlock()
		}
		faults.Lock()
		lose := loseActivation && r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/activate")
		faults.Unlock()
		if lose {
			// Commit through the authenticated public handler, then lose its ACK.
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, r)
			if response.Code == http.StatusOK {
				faults.Lock()
				lostActivations++
				faults.Unlock()
				connection, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					_ = connection.Close()
				}
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
			t.Fatalf("pack rewind %s: %v %s", directory, err, stderr.String())
		}
		var packed []struct{ Filename string }
		if err := json.Unmarshal(output, &packed); err != nil || len(packed) != 1 {
			t.Fatalf("decode rewind artifact %s: %v %s", directory, err, output)
		}
		return filepath.Join(artifacts, packed[0].Filename)
	}
	tarball, cliTarball := pack("adapters/claude"), pack("apps/cli")
	type pendingCapture struct {
		SourceID       string `json:"sourceId"`
		State          string `json:"state"`
		Activated      bool   `json:"activated"`
		CanonicalUnits int    `json:"canonicalUnits"`
		RawUnits       int    `json:"rawUnits"`
	}
	type snapshot struct {
		InstallationID     string                            `json:"installationId"`
		CheckpointDigest   string                            `json:"checkpointDigest"`
		FrozenLegacyDigest string                            `json:"frozenLegacyDigest"`
		Pending            []pendingCapture                  `json:"pending"`
		Observations       int                               `json:"observations"`
		CanonicalEvents    int                               `json:"canonicalEvents"`
		CanonicalBatches   int                               `json:"canonicalBatches"`
		RawChunks          int                               `json:"rawChunks"`
		SourceFailures     []struct{ Source, Reason string } `json:"sourceFailures"`
		State              string                            `json:"state"`
	}
	runs := 0
	run := func(phase string) snapshot {
		t.Helper()
		input, err := json.Marshal(map[string]any{"phase": phase, "origin": origin, "credential": credential, "userId": grant.User.ID,
			"home": home, "tarball": tarball, "legacyTarball": legacyTarball, "cliTarball": cliTarball, "projectId": project.ID, "teamId": project.TeamID})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "node", "apps/cli/src/runtime/fixtures/claude-rewind-contract.ts")
		command.Dir, command.Stdin = repository, bytes.NewReader(input)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Fatalf("installed Claude rewind %s: %v\n%s", phase, err, stderr.String())
		}
		var value snapshot
		if err := json.Unmarshal(output, &value); err != nil || value.InstallationID == "" || len(value.CheckpointDigest) != 64 {
			t.Fatalf("decode rewind %s: %v %s", phase, err, output)
		}
		runs++
		t.Logf("Claude rewind installed %s PASS: observations=%d events=%d batches=%d Raw=%d pending=%d failures=%d", phase,
			value.Observations, value.CanonicalEvents, value.CanonicalBatches, value.RawChunks, len(value.Pending), len(value.SourceFailures))
		return value
	}
	send := func(method, path, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		addWebProof(request, cookie, grant.CSRFToken)
		request.Header.Set("Origin", origin)
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("rewind HTTP %s %s: %d want=%d %s", method, path, response.Code, want, response.Body.String())
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
	read := func(sessionID, threadID string, expected int) conversation.Conversation {
		t.Helper()
		var result conversation.Conversation
		head, after := "", ""
		for n := 0; n < 100; n++ {
			query := url.Values{"thread": {threadID}, "limit": {"2"}}
			if after != "" {
				query.Set("head", head)
				query.Set("after", after)
			}
			var page conversation.Conversation
			decodeResponse(t, send("GET", "/api/v1/sessions/"+sessionID+"?"+query.Encode(), "", 200), &page)
			if page.Session.ID != sessionID || page.Thread.ID != threadID || n > 0 && page.Head != head {
				t.Fatal("rewind Reader crossed a Session, Thread or selected head")
			}
			if n == 0 {
				result = page
				result.Events = nil
			}
			result.Events = append(result.Events, page.Events...)
			head, after = page.Head, page.NextEventID
			if after == "" {
				if len(result.Events) != expected {
					t.Fatalf("rewind %s/%s events=%d want=%d", sessionID, threadID, len(result.Events), expected)
				}
				return result
			}
		}
		t.Fatal("rewind Reader pagination failed to finish")
		return result
	}
	store := postgresadapter.NewStore(pool)
	principal := authentication.Principal{UserID: grant.User.ID, Method: authentication.WebAuthentication}
	search := func(term string) projectsearch.Page {
		t.Helper()
		for n := 0; n < 100; n++ {
			count, err := projectsearch.NewProjector(store, store).ProjectOnce(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if count == 0 {
				break
			}
		}
		var page projectsearch.Page
		decodeResponse(t, send("GET", "/api/v1/projects/"+project.ID+"/search?q="+url.QueryEscape(term), "", 200), &page)
		return page
	}
	usage := func(sessionID string, count int, input, output int64) {
		t.Helper()
		view, err := store.Overview(t.Context(), principal, project.TeamID, time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		n, in, out := 0, int64(0), int64(0)
		for _, row := range view.Usage {
			if row.SessionID != sessionID {
				continue
			}
			n++
			if row.InputTokens != nil {
				in += *row.InputTokens
			}
			if row.OutputTokens != nil {
				out += *row.OutputTokens
			}
		}
		if n != count || in != input || out != output {
			t.Fatalf("rewind usage %s count=%d input=%d output=%d want %d/%d/%d", sessionID, n, in, out, count, input, output)
		}
	}
	manifest := func(sessionID string) []rawarchive.ObjectSummary {
		t.Helper()
		objects := []rawarchive.ObjectSummary{}
		cursor := ""
		for n := 0; n < 100; n++ {
			query := url.Values{"limit": {"2"}}
			if cursor != "" {
				query.Set("cursor", cursor)
			}
			var page rawarchive.SessionArchive
			decodeResponse(t, send("GET", "/api/v1/sessions/"+sessionID+"/raw?"+query.Encode(), "", 200), &page)
			objects = append(objects, page.Objects...)
			cursor = page.NextCursor
			if cursor == "" {
				return objects
			}
		}
		t.Fatal("rewind Raw manifest pagination failed to finish")
		return nil
	}
	content := func(object rawarchive.ObjectSummary) string {
		t.Helper()
		cursor, offset := "", int64(0)
		var result strings.Builder
		for n := 0; n < 100; n++ {
			query := url.Values{"generation": {fmt.Sprint(object.CurrentGeneration)}, "limit": {"1"}}
			if cursor != "" {
				query.Set("cursor", cursor)
			}
			var page rawarchive.ContentPage
			decodeResponse(t, send("GET", "/api/v1/raw-objects/"+object.ObjectID+"/content?"+query.Encode(), "", 200), &page)
			for _, chunk := range page.Chunks {
				body, err := base64.StdEncoding.DecodeString(chunk.ContentBase64)
				if err != nil || chunk.Offset != offset || chunk.SizeBytes != int64(len(body)) {
					t.Fatal("rewind Raw content has a gap")
				}
				result.Write(body)
				offset += chunk.SizeBytes
			}
			cursor = page.NextCursor
			if cursor == "" {
				if offset != object.CurrentSizeBytes {
					t.Fatal("rewind Raw omitted accepted bytes")
				}
				return result.String()
			}
		}
		t.Fatal("rewind Raw content pagination failed to finish")
		return ""
	}
	setRaw(true)
	defer setRaw(false)
	seed := run("legacy-seed")
	if len(seed.SourceFailures) != 0 || seed.RawChunks != 4 {
		t.Fatalf("genuine legacy seed %+v", seed)
	}
	var memory conversation.ProjectMemory
	decodeResponse(t, send("GET", "/api/v1/projects/"+project.ID+"/memory", "", 200), &memory)
	if len(memory.Trail) != 3 {
		t.Fatalf("legacy sources=%d want 3", len(memory.Trail))
	}
	sessions := map[string]string{}
	for _, value := range memory.Trail {
		for _, name := range []string{"ATAPE_CONTROL_FIRST", "ATAPE_REWIND_FIRST", "ATAPE_NATIVE_THINKING_ROOT"} {
			if strings.HasPrefix(value.Title, name) {
				sessions[name] = value.ID
			}
		}
	}
	controlSession, resumeSession, familySession := sessions["ATAPE_CONTROL_FIRST"], sessions["ATAPE_REWIND_FIRST"], sessions["ATAPE_NATIVE_THINKING_ROOT"]
	if controlSession == "" || resumeSession == "" || familySession == "" {
		t.Fatal("legacy Session identity missing")
	}
	assertMemoryCount := func(sessionID string, events, children int) {
		t.Helper()
		var current conversation.ProjectMemory
		decodeResponse(t, send("GET", "/api/v1/projects/"+project.ID+"/memory", "", 200), &current)
		for _, session := range append(current.Active, current.Trail...) {
			if session.ID == sessionID {
				if session.EventCount != events || session.ChildThreadCount != children {
					t.Fatalf("selected memory counts=%d/%d want=%d/%d", session.EventCount, session.ChildThreadCount, events, children)
				}
				return
			}
		}
		t.Fatal("selected memory omitted a stable Session")
	}
	oldControl, oldResume, oldFamily := read(controlSession, "root", 6), read(resumeSession, "root", 6), read(familySession, "root", 6)
	childID := ""
	for _, event := range oldFamily.Events {
		if event.ChildThread != nil {
			childID = event.ChildThread.ID
		}
	}
	if childID == "" {
		t.Fatal("legacy native foreground link missing")
	}
	oldChild := read(familySession, childID, 6)
	oldChildStore, ok, err := store.Conversation(t.Context(), principal, familySession, childID)
	if err != nil || !ok {
		t.Fatal("legacy child canonical snapshot missing", err)
	}
	oldRaw := map[string]string{}
	oldObjects := map[string][]rawarchive.ObjectSummary{}
	for _, session := range []string{controlSession, resumeSession, familySession} {
		oldObjects[session] = manifest(session)
		for _, object := range oldObjects[session] {
			oldRaw[object.ObjectID] = content(object)
		}
	}
	for _, session := range []string{controlSession, resumeSession} {
		usage(session, 2, 34, 18)
	}
	usage(familySession, 4, 68, 36)
	if len(search("ATAPE_CONTROL_DISCARDED").Results) != 1 || len(search("ATAPE_REWIND_DISCARDED").Results) != 1 {
		t.Fatal("legacy discarded-branch seed was not searchable")
	}
	setRaw(false)
	faults.Lock()
	loseActivation = true
	faults.Unlock()
	lost := run("migration-lost-activate")
	faults.Lock()
	loseActivation = false
	losses := lostActivations
	faults.Unlock()
	if losses != 3 || len(lost.Pending) != 3 || lost.InstallationID != seed.InstallationID || lost.FrozenLegacyDigest == "" {
		t.Fatalf("lost Activate did not leave all 3 durable sealed obligations: losses=%d snapshot=%+v", losses, lost)
	}
	for _, capture := range lost.Pending {
		if capture.State != "sealed" || capture.Activated || capture.CanonicalUnits == 0 || capture.RawUnits != 0 {
			t.Fatalf("lost response obligation %+v", capture)
		}
	}
	selectedControl, selectedResume, selectedFamily := read(controlSession, "root", 3), read(resumeSession, "root", 6), read(familySession, "root", 8)
	for _, value := range []conversation.Conversation{selectedControl, selectedResume, selectedFamily} {
		if value.Head == "" {
			t.Fatal("committed lost Activate did not atomically select the new head")
		}
	}
	for _, session := range []string{controlSession, resumeSession, familySession} {
		faults.Lock()
		adoption, exists := adoptions[session]
		faults.Unlock()
		if !exists || adoption.RevisionFloor <= 5 || len(adoption.BaselineThreads) == 0 {
			t.Fatal("installed migration omitted the authenticated legacy baseline/floor")
		}
		selected, found, err := store.ConversationPage(t.Context(), principal, session, "root", canonical.ConversationPageRequest{Limit: 100})
		if err != nil || !found || selected.Session.Revision <= adoption.RevisionFloor || selected.Thread.Revision <= adoption.RevisionFloor {
			t.Fatal("fresh Session/Thread reused a legacy version", err)
		}
		for _, event := range selected.Events {
			if event.Revision <= adoption.RevisionFloor || event.ProjectionRevision <= adoption.RevisionFloor {
				t.Fatal("fresh Event reused a legal old source/projection version pair")
			}
		}
	}
	if !reflect.DeepEqual(read(familySession, childID, 6).Events, oldChild.Events) {
		t.Fatal("first legacy adoption did not retain exact child Events")
	}
	assertMemoryCount(familySession, 14, 1)
	retainedStore, ok, err := store.ConversationPage(t.Context(), principal, familySession, childID, canonical.ConversationPageRequest{Limit: 100})
	if err != nil || !ok || !canonicalcontract.EqualEvents(retainedStore.Events, oldChildStore.Events) {
		t.Fatal("adoption changed inherited child versions/provenance/Raw refs", err)
	}
	if len(search("ATAPE_CONTROL_DISCARDED").Results) != 0 || len(search("ATAPE_REWIND_DISCARDED").Results) != 0 {
		t.Fatal("atomic selected head retained abandoned Search membership")
	}
	assertSelected := func(controlCount, resumeCount, familyCount int) {
		t.Helper()
		read(controlSession, "root", controlCount)
		read(resumeSession, "root", resumeCount)
		read(familySession, "root", familyCount)
		for _, term := range []string{"ATAPE_NATIVE_THOUGHT", "ATAPE_GENERATED_THOUGHT", "ATAPE_CHILD_READ_CONTENT", "SENSITIVE_TEST_TOKEN"} {
			if len(search(term).Results) != 0 {
				t.Fatalf("thought/tool/secret became Search message: %s", term)
			}
		}
	}
	assertSelected(3, 6, 8)
	usage(controlSession, 1, 17, 9)
	usage(resumeSession, 2, 34, 18)
	usage(familySession, 5, 87, 47)
	recovered := run("recover-deleted")
	if len(recovered.Pending) != 0 || recovered.InstallationID != seed.InstallationID || recovered.FrozenLegacyDigest != lost.FrozenLegacyDigest {
		t.Fatalf("source-free journal recovery failed %+v", recovered)
	}
	assertSelected(3, 6, 8)
	if read(controlSession, "root", 3).Head != selectedControl.Head || read(familySession, "root", 8).Head != selectedFamily.Head {
		t.Fatal("journal recovery reread or republished deleted source")
	}
	restored := run("restored-idle")
	if restored.Observations != 0 || restored.RawChunks != 0 || len(restored.SourceFailures) != 1 || restored.SourceFailures[0].Reason != "io" {
		t.Fatalf("retained missing child diagnostic/idle %+v", restored)
	}
	retained := run("retained-progress")
	if len(retained.SourceFailures) != 1 || retained.RawChunks != 0 {
		t.Fatal("missing captured child blocked current root")
	}
	assertSelected(3, 6, 10)
	assertMemoryCount(familySession, 16, 1)
	if !reflect.DeepEqual(read(familySession, childID, 6).Events, oldChild.Events) {
		t.Fatal("later selected head lost retained child")
	}
	usage(familySession, 6, 106, 58)
	repair := run("repair-child")
	if len(repair.SourceFailures) != 0 {
		t.Fatalf("restored child could not be recaptured %+v", repair)
	}
	assertSelected(3, 6, 10)
	read(familySession, childID, 6)
	usage(familySession, 6, 106, 58)
	run("native-continue")
	assertSelected(6, 9, 10)
	usage(controlSession, 2, 34, 18)
	usage(resumeSession, 3, 51, 27)
	beforeInvalid := read(controlSession, "root", 6)
	invalid := run("root-invalid")
	if len(invalid.SourceFailures) != 1 || invalid.Observations != 0 || read(controlSession, "root", 6).Head != beforeInvalid.Head {
		t.Fatalf("unproved root selector did not fail closed %+v", invalid)
	}
	repaired := run("root-repair")
	if len(repaired.SourceFailures) != 0 || repaired.Observations != 0 {
		t.Fatalf("repair changed acknowledged selected target %+v", repaired)
	}
	for _, session := range []string{controlSession, resumeSession, familySession} {
		if !reflect.DeepEqual(manifest(session), oldObjects[session]) {
			t.Fatal("Raw-off migration changed old Raw owner/generation/manifest")
		}
		for _, object := range oldObjects[session] {
			if content(object) != oldRaw[object.ObjectID] {
				t.Fatal("usable old Raw link changed after migration")
			}
		}
	}
	setRaw(true)
	backfill := run("raw-backfill")
	if backfill.RawChunks == 0 || len(backfill.SourceFailures) != 0 {
		t.Fatalf("Raw backfill failed %+v", backfill)
	}
	assertSelected(6, 9, 10)
	usage(familySession, 6, 106, 58)
	// Reconstruct physical Raw by native byte locators in the host-packed archive.
	assertPhysicalRaw := func(sessionID string, expected map[string]string) {
		t.Helper()
		type piece struct {
			SourceThreadID string `json:"sourceThreadId"`
			RecordStart    int    `json:"recordStart"`
			RecordEnd      int    `json:"recordEnd"`
			JSONL          string `json:"jsonl"`
			Format         string `json:"format"`
		}
		found := map[string]map[int]piece{}
		for _, object := range manifest(sessionID) {
			if object.SourceName != "source-records.json" {
				continue
			}
			var envelope struct {
				Records map[string]struct {
					Row piece `json:"row"`
				} `json:"records"`
			}
			if err := json.Unmarshal([]byte(content(object)), &envelope); err != nil {
				t.Fatal(err)
			}
			for _, record := range envelope.Records {
				row := record.Row
				if row.Format != "claude.jsonl.v1" {
					continue
				}
				if found[row.SourceThreadID] == nil {
					found[row.SourceThreadID] = map[int]piece{}
				}
				if previous, exists := found[row.SourceThreadID][row.RecordStart]; exists && previous != row {
					t.Fatal("same native Raw locator changed")
				}
				found[row.SourceThreadID][row.RecordStart] = row
			}
		}
		for thread, path := range expected {
			source, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			starts := []int{}
			for start := range found[thread] {
				starts = append(starts, start)
			}
			sort.Ints(starts)
			nativeOffset := 0
			for _, start := range starts {
				row := found[thread][start]
				// Locators address original physical bytes; redaction may shorten
				// the archived JSONL string without changing those native offsets.
				if start != nativeOffset || row.RecordEnd <= start || row.RecordEnd > len(source) {
					t.Fatal("native Raw gap/overlap")
				}
				original := string(source[start:row.RecordEnd])
				masked := strings.ReplaceAll(original, "SENSITIVE_TEST_TOKEN", "[REDACTED]")
				if original == masked {
					if row.JSONL != original {
						t.Fatal("Raw changed an unredacted native record")
					}
				} else {
					// Client masking may re-encode the changed JSON TEXT, including
					// insignificant whitespace. Its entire value must still match.
					var got, want any
					if json.Unmarshal([]byte(row.JSONL), &got) != nil || json.Unmarshal([]byte(masked), &want) != nil || !reflect.DeepEqual(got, want) {
						t.Fatal("Raw omitted or changed a masked source record")
					}
				}
				nativeOffset = row.RecordEnd
			}
			if nativeOffset != len(source) {
				t.Fatalf("Raw did not retain complete physical history %s/%s: %d/%d", sessionID, thread, nativeOffset, len(source))
			}
		}
	}
	directory := filepath.Join(home, "source", "projects", "opaque-native-project")
	familyID := "4e028c9c-9c9f-4d2b-afb5-f58d1950b6ac"
	childSourceID := "claude-agent:aa2bb7928384f99e7"
	familyFiles := map[string]string{"root": filepath.Join(directory, familyID+".jsonl"), childSourceID: filepath.Join(directory, familyID, "subagents", "agent-aa2bb7928384f99e7.jsonl")}
	if !reflect.DeepEqual(manifest(familySession), oldObjects[familySession]) {
		t.Fatal("offline family was unexpectedly archived before the abandoned-child backfill")
	}
	assertPhysicalRaw(controlSession, map[string]string{"root": filepath.Join(directory, "739c7fd0-4b82-46e6-b77a-ca836df2294d.jsonl")})
	assertPhysicalRaw(resumeSession, map[string]string{"root": filepath.Join(directory, "3a13403f-ab2d-4eed-9f2f-392e0dfe2a83.jsonl")})
	setRaw(false)
	run("abandon-child-and-empty")
	assertSelected(0, 9, 1)
	assertMemoryCount(familySession, 1, 0)
	assertMemoryCount(controlSession, 0, 0)
	usage(controlSession, 0, 0, 0)
	usage(familySession, 0, 0, 0)
	send("GET", "/api/v1/sessions/"+familySession+"?thread="+url.QueryEscape(childID), "", 404)
	for _, event := range read(familySession, "root", 1).Events {
		if event.ChildThread != nil {
			t.Fatal("rewind guessed/retained an abandoned child link")
		}
	}
	if len(search("ATAPE_CHILD_FINAL").Results) != 0 || len(search("ATAPE_ROOT_FINAL").Results) != 0 || len(search("ATAPE_CONTROL_CURRENT").Results) != 0 {
		t.Fatal("empty/abandoned target leaked old membership into Search")
	}
	setRaw(true)
	abandonedBackfill := run("abandoned-raw-backfill")
	if abandonedBackfill.RawChunks == 0 || len(abandonedBackfill.SourceFailures) != 0 {
		t.Fatalf("abandoned child physical Raw did not backfill %+v", abandonedBackfill)
	}
	assertSelected(0, 9, 1)
	assertPhysicalRaw(familySession, familyFiles)
	for _, object := range oldObjects[familySession] {
		if content(object) != oldRaw[object.ObjectID] {
			t.Fatal("abandoned child rewind invalidated old Raw link")
		}
	}
	emptyHead := read(controlSession, "root", 0).Head
	emptyIdle := run("empty-idle")
	if emptyIdle.Observations != 0 || emptyIdle.RawChunks != 0 || read(controlSession, "root", 0).Head != emptyHead {
		t.Fatal("empty active path did not remain idle")
	}
	run("fresh-after-empty")
	fresh := read(controlSession, "root", 3)
	if fresh.Head == emptyHead || fresh.Events[1].Kind != "thought" || fresh.Events[2].Kind != "message" || !strings.Contains(fresh.Events[1].Text, "[REDACTED]") {
		t.Fatal("fresh root after explicit empty rewind lost thinking/message order")
	}
	usage(controlSession, 1, 12, 6)
	hits := search("ATAPE_GENERATED_AFTER_EMPTY_VISIBLE")
	if len(hits.Results) != 1 || hits.Results[0].SessionID != controlSession || hits.Results[0].EventID != fresh.Events[2].ID {
		t.Fatal("Reader/Search lost stable fresh message anchor")
	}
	final := run("final-idle")
	if final.Observations != 0 || final.RawChunks != 0 || len(final.SourceFailures) != 0 || len(final.Pending) != 0 || final.InstallationID != seed.InstallationID || final.FrozenLegacyDigest != lost.FrozenLegacyDigest {
		t.Fatalf("final migration idle/recovery %+v", final)
	}
	assertSelected(3, 9, 1)
	usage(controlSession, 1, 12, 6)
	usage(resumeSession, 3, 51, 27)
	usage(familySession, 0, 0, 0)
	compactSeed := run("native-compact-seed")
	if len(compactSeed.SourceFailures) != 0 {
		t.Fatal("new source after legacy migration failed")
	}
	decodeResponse(t, send("GET", "/api/v1/projects/"+project.ID+"/memory", "", 200), &memory)
	compactSession := ""
	for _, session := range append(memory.Active, memory.Trail...) {
		if strings.HasPrefix(session.Title, "ATAPE_NATIVE_COMPACT_SEED") {
			compactSession = session.ID
		}
	}
	if compactSession == "" {
		t.Fatal("native compaction Session missing")
	}
	compactBefore := read(compactSession, "root", 4)
	usage(compactSession, 2, 52, 24)
	run("native-compact-continue")
	compactAfter := read(compactSession, "root", 6)
	if !reflect.DeepEqual(compactBefore.Events, compactAfter.Events[:4]) {
		t.Fatal("sourceCapture native compaction changed surviving Reader anchors")
	}
	usage(compactSession, 3, 81, 37)
	for _, term := range []string{"ATAPE_COMPACT_SUMMARY", "No response requested", "local-command", "command-name"} {
		if len(search(term).Results) != 0 {
			t.Fatalf("native compaction control became Search content: %s", term)
		}
		for _, event := range compactAfter.Events {
			if strings.Contains(event.Text, term) {
				t.Fatal("native compaction control became a Reader Event")
			}
		}
	}
	compactHits := search("ATAPE_AFTER_COMPACT")
	if len(compactHits.Results) != 1 || compactHits.Results[0].SessionID != compactSession || compactHits.Results[0].EventID != compactAfter.Events[5].ID {
		t.Fatal("native compaction continuation lost its Search anchor")
	}
	assertPhysicalRaw(compactSession, map[string]string{"root": filepath.Join(directory, "2197a21d-e447-4ce2-bb24-4ae0c75b2c9d.jsonl")})
	compactIdle := run("native-compact-idle")
	if compactIdle.Observations != 0 || compactIdle.RawChunks != 0 || len(compactIdle.SourceFailures) != 0 || len(compactIdle.Pending) != 0 || read(compactSession, "root", 6).Head != compactAfter.Head {
		t.Fatal("native compaction continuation did not settle idle")
	}
	// Direct background lifecycle uses literal LF prefixes of one retained native
	// capture. Missing files and the final rewind are explicit test mutations.
	const backgroundSource = "2a7f13b3-532e-40ec-a959-41210525d00f"
	const backgroundAgent = "a8722069f7a6392c3"
	backgroundRootFile := filepath.Join(directory, backgroundSource+".jsonl")
	backgroundChildFile := filepath.Join(directory, backgroundSource, "subagents", "agent-"+backgroundAgent+".jsonl")
	setRaw(false)
	backgroundRunning := run("background-running")
	if backgroundRunning.Observations != 1 || backgroundRunning.RawChunks != 0 || len(backgroundRunning.SourceFailures) != 0 || len(backgroundRunning.Pending) != 0 {
		t.Fatalf("background launch/running did not publish Raw-off: %+v", backgroundRunning)
	}
	// The Adapter reports its authenticated physical path. Resolve while the
	// fixture exists so macOS /var and /private/var aliases do not weaken the
	// later exact missing-child diagnostic assertion.
	backgroundChildSource, err := filepath.EvalSymlinks(backgroundChildFile)
	if err != nil {
		t.Fatal(err)
	}
	decodeResponse(t, send("GET", "/api/v1/projects/"+project.ID+"/memory", "", 200), &memory)
	backgroundSession := ""
	for _, session := range append(memory.Active, memory.Trail...) {
		if strings.HasPrefix(session.Title, "ATAPE_BG_90fceeec_LAUNCH") {
			backgroundSession = session.ID
		}
	}
	if backgroundSession == "" {
		t.Fatal("installed background Session missing")
	}
	backgroundRoot := read(backgroundSession, "root", 4)
	if backgroundRoot.Events[2].ChildThread == nil || backgroundRoot.Events[2].Tool == nil || backgroundRoot.Events[2].Tool.ToolCallID != "call_bg_90fceeec_agent" {
		t.Fatal("background launch receipt lost its proved child relationship/tool")
	}
	backgroundThread := backgroundRoot.Events[2].ChildThread.ID
	backgroundLaunchID := backgroundRoot.Events[2].ID
	backgroundChild := read(backgroundSession, backgroundThread, 3)
	if len(backgroundChild.ThreadPath) != 2 || backgroundChild.ThreadPath[0].ID != "root" || backgroundChild.Events[1].Tool == nil || backgroundChild.Events[1].Tool.ToolCallID != "call_bg_90fceeec_child_read" || backgroundChild.Events[2].Kind != "tool_result" {
		t.Fatal("running background child lost native parent path/Read tool")
	}
	assertMemoryCount(backgroundSession, 7, 1)
	usage(backgroundSession, 3, 93, 51)
	if len(manifest(backgroundSession)) != 0 {
		t.Fatal("Raw-off background launch archived source bodies")
	}
	storedBackgroundEvents := func(thread string) []canonical.EventRecord {
		t.Helper()
		value, found, err := store.ConversationPage(t.Context(), principal, backgroundSession, thread, canonical.ConversationPageRequest{Limit: 100})
		if err != nil || !found {
			t.Fatal("background Canonical snapshot missing", err)
		}
		return value.Events
	}
	runningRootEvents := storedBackgroundEvents("root")
	runningChildEvents := storedBackgroundEvents(backgroundThread)
	assertFreshBackgroundEvents := func(label string, before, after []canonical.EventRecord) {
		t.Helper()
		if len(before) != len(after) {
			t.Fatalf("background %s Events before=%d after=%d", label, len(before), len(after))
		}
		// Explicit Events belong to a fresh publication observation. Their native
		// content, source/projection versions and Raw references remain stable;
		// Server capture provenance advances independently of those versions.
		stable := append([]canonical.EventRecord(nil), after...)
		for n, previous := range before {
			current := after[n]
			if !current.ObservedAt.After(previous.ObservedAt) || !current.ReceivedAt.After(previous.ReceivedAt) || current.IngestSeq <= previous.IngestSeq {
				t.Fatalf("background %s Event=%s did not advance all three fresh observation fields", label, previous.ID)
			}
			stable[n].ObservedAt, stable[n].ReceivedAt, stable[n].IngestSeq = previous.ObservedAt, previous.ReceivedAt, previous.IngestSeq
		}
		if !canonicalcontract.EqualEvents(before, stable) {
			t.Fatalf("background %s changed native content, versions, identity, order or Raw references", label)
		}
	}
	beforeChildOnly, err := os.ReadFile(backgroundRootFile)
	if err != nil {
		t.Fatal(err)
	}
	childOnly := run("background-child-only")
	afterChildOnly, err := os.ReadFile(backgroundRootFile)
	if err != nil || !bytes.Equal(beforeChildOnly, afterChildOnly) || childOnly.Observations != 1 || childOnly.RawChunks != 0 || len(childOnly.SourceFailures) != 0 {
		t.Fatalf("root-unchanged background child append failed: %+v %v", childOnly, err)
	}
	assertFreshBackgroundEvents("child-only root", runningRootEvents, storedBackgroundEvents("root"))
	completedChildEvents := storedBackgroundEvents(backgroundThread)
	if len(completedChildEvents) != 4 {
		t.Fatal("child-only append lost the final child Event")
	}
	assertFreshBackgroundEvents("child-only child-prefix", runningChildEvents, completedChildEvents[:3])
	backgroundChild = read(backgroundSession, backgroundThread, 4)
	if backgroundChild.Events[3].Text != "ATAPE_BG_CHILD_FINAL_90fceeec: cobalt heron 482 read once." {
		t.Fatal("root-unchanged background child final reply missing")
	}
	assertMemoryCount(backgroundSession, 8, 1)
	usage(backgroundSession, 4, 124, 68)
	retainedBackground := run("background-retained-progress")
	if retainedBackground.Observations != 1 || retainedBackground.RawChunks != 0 || len(retainedBackground.SourceFailures) != 1 || retainedBackground.SourceFailures[0].Source != backgroundChildSource || retainedBackground.SourceFailures[0].Reason != "io" {
		t.Fatalf("missing background child blocked native root progress: %+v", retainedBackground)
	}
	retainedRoot := read(backgroundSession, "root", 8)
	if retainedRoot.Events[2].ID != backgroundLaunchID || retainedRoot.Events[2].ChildThread == nil || retainedRoot.Events[2].ChildThread.ID != backgroundThread || retainedRoot.Events[7].Text != "ATAPE_BG_PARENT_DURING_FINAL_90fceeec: amber lynx 204 read while child running." {
		t.Fatal("root progress changed launch anchor or lost later ordinary reply")
	}
	if !canonicalcontract.EqualEvents(storedBackgroundEvents(backgroundThread), completedChildEvents) || !reflect.DeepEqual(read(backgroundSession, backgroundThread, 4).Events, backgroundChild.Events) {
		t.Fatal("background retention changed inherited Event versions/provenance/Raw refs")
	}
	assertMemoryCount(backgroundSession, 12, 1)
	usage(backgroundSession, 6, 186, 102)
	retainedBackgroundIdle := run("background-retained-idle")
	if retainedBackgroundIdle.Observations != 0 || retainedBackgroundIdle.RawChunks != 0 || !reflect.DeepEqual(retainedBackgroundIdle.SourceFailures, retainedBackground.SourceFailures) || read(backgroundSession, "root", 8).Head != retainedRoot.Head {
		t.Fatalf("background retention/diagnostic did not survive idle restart: %+v", retainedBackgroundIdle)
	}
	backgroundCompleted := run("background-completed")
	if backgroundCompleted.Observations != 1 || backgroundCompleted.RawChunks != 0 || len(backgroundCompleted.SourceFailures) != 0 || len(backgroundCompleted.Pending) != 0 {
		t.Fatalf("native background completion/followup failed: %+v", backgroundCompleted)
	}
	finalBackgroundRoot := read(backgroundSession, "root", 11)
	finalBackgroundChild := read(backgroundSession, backgroundThread, 4)
	if finalBackgroundRoot.Events[2].ID != backgroundLaunchID || finalBackgroundRoot.Events[2].ChildThread == nil || finalBackgroundRoot.Events[2].ChildThread.ID != backgroundThread || finalBackgroundRoot.Events[8].Text != "ATAPE_BG_NOTIFICATION_ACK_90fceeec: child completion received." || finalBackgroundRoot.Events[10].Text != "ATAPE_BG_PARENT_AFTER_FINAL_90fceeec: background completion acknowledged; parent continues." {
		t.Fatal("completion changed original background relationship or blocked parent continuation")
	}
	for n, event := range finalBackgroundChild.Events {
		if event.ID != backgroundChild.Events[n].ID || event.Text != backgroundChild.Events[n].Text {
			t.Fatal("background completion moved stable child Reader anchors")
		}
	}
	assertMemoryCount(backgroundSession, 15, 1)
	usage(backgroundSession, 8, 248, 136)
	for _, term := range []string{"task-notification", "task-id", "output-file", "ATAPE_BG_CHILD_DISK_90fceeec", "ATAPE_BG_PARENT_DISK_90fceeec"} {
		if len(search(term).Results) != 0 {
			t.Fatalf("background control/tool data became Search content: %s", term)
		}
		for _, event := range finalBackgroundRoot.Events {
			if strings.Contains(event.Text, term) {
				t.Fatalf("background control/tool data became Reader message: %s", term)
			}
		}
	}
	for _, expected := range []struct{ term, thread, event string }{
		{"ATAPE_BG_CHILD_FINAL_90fceeec: cobalt heron 482", backgroundThread, finalBackgroundChild.Events[3].ID},
		{"ATAPE_BG_PARENT_AFTER_FINAL_90fceeec", "root", finalBackgroundRoot.Events[10].ID},
	} {
		found := search(expected.term)
		if len(found.Results) != 1 || found.Results[0].SessionID != backgroundSession || found.Results[0].ThreadID != expected.thread || found.Results[0].EventID != expected.event {
			t.Fatalf("background Reader/Search anchor missing: %s", expected.term)
		}
	}
	beforeBackfillRoot, beforeBackfillChild := storedBackgroundEvents("root"), storedBackgroundEvents(backgroundThread)
	setRaw(true)
	backgroundBackfill := run("background-raw-backfill")
	if backgroundBackfill.RawChunks == 0 || len(backgroundBackfill.SourceFailures) != 0 {
		t.Fatalf("background Raw backfill failed: %+v", backgroundBackfill)
	}
	backgroundFiles := map[string]string{"root": backgroundRootFile, "claude-agent:" + backgroundAgent: backgroundChildFile}
	assertPhysicalRaw(backgroundSession, backgroundFiles)
	backgroundObjects, backgroundRaw := manifest(backgroundSession), map[string]string{}
	for _, object := range backgroundObjects {
		backgroundRaw[object.ObjectID] = content(object)
	}
	if !canonicalcontract.EqualEvents(storedBackgroundEvents("root"), beforeBackfillRoot) || !canonicalcontract.EqualEvents(storedBackgroundEvents(backgroundThread), beforeBackfillChild) {
		t.Fatal("Raw-only background backfill changed Canonical versions/provenance/Raw refs")
	}
	usage(backgroundSession, 8, 248, 136)
	setRaw(false)
	run("background-rewind")
	rewoundBackground := read(backgroundSession, "root", 1)
	if rewoundBackground.Events[0].ID != backgroundRoot.Events[0].ID || rewoundBackground.Events[0].ChildThread != nil {
		t.Fatal("rewind before launch changed original user anchor or retained guessed child")
	}
	send("GET", "/api/v1/sessions/"+backgroundSession+"?thread="+url.QueryEscape(backgroundThread), "", 404)
	assertMemoryCount(backgroundSession, 1, 0)
	usage(backgroundSession, 0, 0, 0)
	for _, term := range []string{"ATAPE_BG_CHILD_FINAL_90fceeec", "ATAPE_BG_PARENT_AFTER_FINAL_90fceeec", "ATAPE_BG_NOTIFICATION_ACK_90fceeec"} {
		if len(search(term).Results) != 0 {
			t.Fatalf("background rewind retained abandoned Search membership: %s", term)
		}
	}
	backgroundIdle := run("background-rewind-idle")
	if backgroundIdle.Observations != 0 || backgroundIdle.RawChunks != 0 || len(backgroundIdle.SourceFailures) != 0 || len(backgroundIdle.Pending) != 0 || read(backgroundSession, "root", 1).Head != rewoundBackground.Head {
		t.Fatalf("background rewind did not remain idle: %+v", backgroundIdle)
	}
	if !reflect.DeepEqual(manifest(backgroundSession), backgroundObjects) {
		t.Fatal("background rewind changed existing Raw ownership/generation")
	}
	for _, object := range backgroundObjects {
		if content(object) != backgroundRaw[object.ObjectID] {
			t.Fatal("background rewind invalidated available historical Raw content links")
		}
	}
	faults.Lock()
	leaked, redacted := wireLeak, redactedThought
	faults.Unlock()
	if leaked || !redacted {
		t.Fatal("Host did not redact generated thought before publication HTTP")
	}
	// Surviving native message IDs remain the legacy anchors across the migration.
	for _, pair := range [][2]conversation.Conversation{{oldControl, selectedControl}, {oldResume, selectedResume}} {
		for _, event := range pair[1].Events {
			for _, old := range pair[0].Events {
				if event.Kind == old.Kind && event.Text == old.Text && event.ID != old.ID {
					t.Fatal("migration moved surviving legacy Reader anchor")
				}
			}
		}
	}
	if runs != 26 {
		t.Fatalf("installed rewind/background stages=%d want=26", runs)
	}
	t.Logf("Claude rewind installed contract PASS: %d independently restarted stages; genuine legacy SHA256=%s; no skips", runs, hex.EncodeToString(legacyHash[:]))
}
