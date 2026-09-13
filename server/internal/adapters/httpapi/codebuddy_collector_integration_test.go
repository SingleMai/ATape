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
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
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
	// Manual and pre-message compaction keep the captured transcript and its Origin.
	compactCreate := jsonRequest(t, http.MethodPost, "/api/v1/teams/acme/projects", map[string]string{"type": "folder", "name": "CodeBuddy compaction"})
	compactCreate.Header.Set("Authorization", "Bearer "+credential)
	compactCreate.Header.Set("Idempotency-Key", "codebuddy-compaction-project-21240")
	compactCreated := httptest.NewRecorder()
	h.ServeHTTP(compactCreated, compactCreate)
	if compactCreated.Code != http.StatusCreated {
		t.Fatalf("create compaction Project: %d %s", compactCreated.Code, compactCreated.Body.String())
	}
	var compactProject projectDTO
	decodeResponse(t, compactCreated, &compactProject)
	projectID = compactProject.ID
	compactInitial := run("compact-initial")
	_, compactBefore := read(compactInitial.SessionID, 3)
	compactManual := run("compact-manual")
	_, compactEvents := read(compactManual.SessionID, 6)
	encoded, _ = json.Marshal(compactEvents)
	if compactManual.SessionID != compactInitial.SessionID || compactManual.Head == compactInitial.Head ||
		!bytes.Contains(encoded, []byte("/compact Keep the summary short")) || bytes.Contains(encoded, []byte("IMPORTANT CONSTRAINTS")) ||
		!bytes.Contains(encoded, []byte("conversation_history_summary")) {
		t.Fatal("CodeBuddy manual compaction lost its Session, original command or summary")
	}
	compactResume := run("compact-resume")
	read(compactResume.SessionID, 8)
	compactAuto := run("compact-auto")
	_, compactEvents = read(compactAuto.SessionID, 10)
	beforePrefix, _ := json.Marshal(compactBefore)
	afterPrefix, _ := json.Marshal(compactEvents[:3])
	encoded, _ = json.Marshal(compactEvents)
	if compactAuto.SessionID != compactInitial.SessionID || !bytes.Equal(beforePrefix, afterPrefix) ||
		bytes.Contains(encoded, []byte("cb_summary")) || !bytes.Contains(encoded, []byte("ATAPE_AUTO_COMPACT_21240")) {
		t.Fatal("CodeBuddy automatic compaction changed the prefix or fabricated a user context turn")
	}
	provenance, found, err = store.ConversationPage(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, compactAuto.SessionID, "root", canonical.ConversationPageRequest{Limit: 100})
	if err != nil || !found || len(provenance.Events) != 10 {
		t.Fatalf("CodeBuddy compact provenance: %v", err)
	}
	objectID, _, valid = strings.Cut(provenance.Events[9].RawRef, "/records/")
	if !valid {
		t.Fatal("CodeBuddy compact lacks native Raw provenance")
	}
	decodeResponse(t, send("GET", "/api/v1/raw-objects/"+objectID+"/content?generation=1&limit=1", ""), &raw)
	if len(raw.Chunks) != 1 || raw.NextCursor != "" {
		t.Fatal("CodeBuddy compact Raw page exceeded its bound")
	}
	content, err = base64.StdEncoding.DecodeString(raw.Chunks[0].ContentBase64)
	if err != nil || !bytes.Contains(content, []byte("logicalParentId")) || !bytes.Contains(content, []byte("cb_summary")) {
		t.Fatal("CodeBuddy omitted context was not preserved in Raw")
	}
	if pending := run("compact-pending"); pending.Head != compactAuto.Head || !bytes.Equal(pending.Records, compactAuto.Records) {
		t.Fatal("CodeBuddy unfinished compaction replaced visible history")
	}
	if fixed := run("compact-repair"); fixed.Head != compactAuto.Head || fixed.Observations != 0 {
		t.Fatal("CodeBuddy repaired compaction replayed unchanged content")
	}
	setRaw(false)
	compactOff := run("compact-edit")
	if compactOff.Head == compactAuto.Head {
		t.Fatal("CodeBuddy compact Raw-off stopped Canonical updates")
	}
	setRaw(true)
	compactOn := run("compact-reenable")
	if compactOn.Head != compactOff.Head || !bytes.Equal(compactOn.Records, compactOff.Records) {
		t.Fatal("CodeBuddy compact Raw re-enable changed Canonical provenance")
	}
	if lost := run("compact-raw-only"); lost.Pending == 0 || lost.Head != compactOn.Head {
		t.Fatal("CodeBuddy context-only Raw response loss changed Canonical or lost recovery")
	}
	recoveredCompact := run("compact-recover")
	read(recoveredCompact.SessionID, 10)
	if recoveredCompact.Pending != 0 || recoveredCompact.Head != compactOn.Head || !bytes.Equal(recoveredCompact.Records, compactOn.Records) {
		t.Fatal("CodeBuddy compact Raw recovery failed after source deletion")
	}
	if len(search("CodeBuddyCompactFinalNeedle").Results) != 1 || len(search("CodeBuddyCompactRawOnlyNeedle").Results) != 0 || len(search("IMPORTANT CONSTRAINTS").Results) != 0 {
		t.Fatal("CodeBuddy compact Search lost Canonical or indexed internal context")
	}
	usageSnapshot, err = store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	usageCount, inputTokens, outputTokens, cachedTokens = 0, 0, 0, 0
	for _, usage := range usageSnapshot.Usage {
		if usage.SessionID == compactInitial.SessionID {
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
	if usageCount != 4 || inputTokens != 20757 || outputTokens != 1079 || cachedTokens != 6656 {
		t.Fatalf("CodeBuddy compaction usage: records=%d input=%d output=%d cache=%d", usageCount, inputTokens, outputTokens, cachedTokens)
	}
	// One root owns its completed Agent histories, even when child CWD names another Project.
	familyCreate := jsonRequest(t, http.MethodPost, "/api/v1/teams/acme/projects", map[string]string{"type": "folder", "name": "CodeBuddy children"})
	familyCreate.Header.Set("Authorization", "Bearer "+credential)
	familyCreate.Header.Set("Idempotency-Key", "codebuddy-family-project-21240")
	familyCreated := httptest.NewRecorder()
	h.ServeHTTP(familyCreated, familyCreate)
	if familyCreated.Code != http.StatusCreated {
		t.Fatalf("create family Project: %d %s", familyCreated.Code, familyCreated.Body.String())
	}
	var familyProject projectDTO
	decodeResponse(t, familyCreated, &familyProject)
	projectID = familyProject.ID
	links := func(events []conversation.Event) []conversation.ChildThreadRef {
		var result []conversation.ChildThreadRef
		for _, event := range events {
			if event.ChildThread != nil {
				result = append(result, *event.ChildThread)
			}
		}
		return result
	}
	family := run("family-initial")
	_, parentEvents := read(family.SessionID, 5)
	initialLinks := links(parentEvents)
	if len(initialLinks) != 1 || initialLinks[0].EventCount != 3 {
		t.Fatal("CodeBuddy parent lost its completed child")
	}
	childID := initialLinks[0].ID
	_, childBefore := read(family.SessionID, 3, childID)
	familyResume := run("family-resume")
	_, parentEvents = read(familyResume.SessionID, 9)
	resumedLinks := links(parentEvents)
	if familyResume.SessionID != family.SessionID || len(resumedLinks) != 2 || resumedLinks[0].ID != childID || resumedLinks[1].ID != childID {
		t.Fatal("CodeBuddy Agent resume created another child or Session")
	}
	_, childAfter := read(family.SessionID, 6, childID)
	beforePrefix, _ = json.Marshal(childBefore)
	afterPrefix, _ = json.Marshal(childAfter[:3])
	if !bytes.Equal(beforePrefix, afterPrefix) {
		t.Fatal("CodeBuddy child resume rewrote captured prefix")
	}
	familyNested := run("family-nested")
	_, parentEvents = read(familyNested.SessionID, 13)
	nestedLinks := links(parentEvents)
	if len(nestedLinks) != 3 {
		t.Fatal("CodeBuddy nested parent link missing")
	}
	middleID := nestedLinks[2].ID
	_, middleEvents := read(family.SessionID, 6, middleID)
	leafLinks := links(middleEvents)
	if len(leafLinks) != 1 {
		t.Fatal("CodeBuddy nested leaf link missing")
	}
	leafID := leafLinks[0].ID
	read(family.SessionID, 2, leafID)
	var leafPage conversation.Conversation
	decodeResponse(t, send("GET", "/api/v1/sessions/"+family.SessionID+"?thread="+url.QueryEscape(leafID), ""), &leafPage)
	if leafPage.Thread.ParentThreadID == nil || *leafPage.Thread.ParentThreadID != middleID || len(leafPage.ThreadPath) != 3 {
		t.Fatal("CodeBuddy nested child lost its parent path")
	}
	familyCompact := run("family-compact")
	_, parentEvents = read(familyCompact.SessionID, 15)
	encoded, _ = json.Marshal(parentEvents)
	if len(links(parentEvents)) != 3 || !bytes.Contains(encoded, []byte("/compact Keep the summary short")) {
		t.Fatal("CodeBuddy root compaction lost its child family")
	}
	familyDefault := run("family-default")
	_, parentEvents = read(familyDefault.SessionID, 20)
	defaultLinks := links(parentEvents)
	if len(defaultLinks) != 4 {
		t.Fatal("CodeBuddy built-in Agent link missing")
	}
	defaultID := defaultLinks[3].ID
	read(family.SessionID, 3, defaultID)
	rootBeforeEdit, _ := json.Marshal(parentEvents)
	leafSearch := search("ATAPE_LEAF_21240")
	if len(leafSearch.Results) == 0 {
		t.Fatal("CodeBuddy child missing from Search")
	}
	leafHits := 0
	for _, result := range leafSearch.Results {
		if result.SessionID != family.SessionID {
			t.Fatal("CodeBuddy child Search escaped its owning family")
		}
		// The native parent compact summary also mentions this marker.
		if result.ThreadID != leafID {
			continue
		}
		leafHits++
		var anchored conversation.Conversation
		decodeResponse(t, send("GET", "/api/v1/sessions/"+family.SessionID+"?thread="+url.QueryEscape(result.ThreadID)+"&at="+url.QueryEscape(result.EventID)+"&limit=2", ""), &anchored)
		matched := false
		for _, event := range anchored.Events {
			matched = matched || event.ID == result.EventID
		}
		if !matched {
			t.Fatal("CodeBuddy child Search anchor did not open its Event")
		}
	}
	if leafHits == 0 {
		t.Fatal("CodeBuddy native leaf Event missing from Search")
	}
	usageSnapshot, err = store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	usageCount, inputTokens, outputTokens, cachedTokens = 0, 0, 0, 0
	threadUsage := map[string]int{}
	for _, usage := range usageSnapshot.Usage {
		if usage.SessionID != family.SessionID {
			continue
		}
		usageCount++
		threadUsage[usage.ThreadID]++
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
	if usageCount != 15 || inputTokens != 108859 || outputTokens != 2886 || cachedTokens != 57664 ||
		threadUsage[childID] != 2 || threadUsage[middleID] != 2 || threadUsage[leafID] != 1 || threadUsage[defaultID] != 1 {
		t.Fatalf("CodeBuddy family usage ownership: records=%d input=%d output=%d cache=%d threads=%v", usageCount, inputTokens, outputTokens, cachedTokens, threadUsage)
	}
	provenance, found, err = store.ConversationPage(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, family.SessionID, childID, canonical.ConversationPageRequest{Limit: 100})
	if err != nil || !found || len(provenance.Events) != 6 {
		t.Fatalf("CodeBuddy child provenance: %v", err)
	}
	objectID, key, valid = strings.Cut(provenance.Events[5].RawRef, "/records/")
	if !valid {
		t.Fatal("CodeBuddy child lacks exact Raw provenance")
	}
	decodeResponse(t, send("GET", "/api/v1/raw-objects/"+objectID+"/content?generation=1&limit=1", ""), &raw)
	if len(raw.Chunks) != 1 || raw.NextCursor != "" {
		t.Fatal("CodeBuddy child Raw page exceeded its bound")
	}
	content, err = base64.StdEncoding.DecodeString(raw.Chunks[0].ContentBase64)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(content, &object); err != nil || !bytes.Contains(object.Records[key].Row, []byte("agent-6b64fa37")) || !bytes.Contains(object.Records[key].Row, []byte("5bf17864-6951-4c7a-824a-6cd13283227d")) {
		t.Fatal("CodeBuddy child Raw lost its storage or native Session identity")
	}
	for _, phase := range []string{"family-invalid", "family-missing"} {
		if invalid := run(phase); invalid.Head != familyDefault.Head || !bytes.Equal(invalid.Records, familyDefault.Records) {
			t.Fatal("CodeBuddy incomplete child replaced the visible family")
		}
		read(family.SessionID, 6, childID)
	}
	if fixed := run("family-repair"); fixed.Head != familyDefault.Head || fixed.Observations != 0 {
		t.Fatal("CodeBuddy family repair replayed unchanged content")
	}
	setRaw(false)
	familyOff := run("family-edit")
	if familyOff.Head == familyDefault.Head {
		t.Fatal("CodeBuddy child Raw-off stopped Canonical")
	}
	setRaw(true)
	familyOn := run("family-reenable")
	if familyOn.Head != familyOff.Head || !bytes.Equal(familyOn.Records, familyOff.Records) {
		t.Fatal("CodeBuddy child Raw re-enable changed Canonical provenance")
	}
	if lost := run("family-lost"); lost.Pending == 0 {
		t.Fatal("CodeBuddy child activation loss did not retain frozen recovery")
	}
	recoveredFamily := run("family-recover")
	if recoveredFamily.Pending != 0 {
		t.Fatal("CodeBuddy family did not recover after all source files were deleted")
	}
	_, childAfter = read(family.SessionID, 6, childID)
	encoded, _ = json.Marshal(childAfter)
	if !bytes.Contains(encoded, []byte("CodeBuddyChildFrozenNeedle")) {
		t.Fatal("CodeBuddy child recovery lost frozen bytes")
	}
	_, parentEvents = read(family.SessionID, 20)
	encoded, _ = json.Marshal(parentEvents)
	if !bytes.Equal(encoded, rootBeforeEdit) {
		t.Fatal("CodeBuddy child edit changed its parent Events")
	}
	read(family.SessionID, 6, middleID)
	read(family.SessionID, 2, leafID)
	read(family.SessionID, 3, defaultID)
	if len(search("CodeBuddyChildFrozenNeedle").Results) != 1 {
		t.Fatal("CodeBuddy recovered child missing from Search")
	}
	// Independent provider contracts share a test User and the real deployment
	// quota (32 reservations for 15 minutes). Advance only this completed fixture's
	// reservation clock before the next provider runs; never enlarge that quota.
	expireReservations := func() {
		expired, err := pool.Exec(t.Context(), `UPDATE canonical_publication_reservations r
			SET expires_at=clock_timestamp()-interval '1 second'
			FROM canonical_publication_sources s
			WHERE s.session_id=r.session_id AND s.captured_by_user_id=$1 AND s.adapter_id='codebuddy'`, userID)
		if err != nil || expired.RowsAffected() == 0 {
			t.Fatalf("expire completed CodeBuddy fixture reservations: %v", err)
		}
	}
	expireReservations()
	if afterExpiry, _ := read(family.SessionID, 20); afterExpiry != recoveredFamily.Head {
		t.Fatal("CodeBuddy reservation expiry changed selected history")
	}
	read(family.SessionID, 6, childID)
	read(family.SessionID, 6, middleID)
	read(family.SessionID, 2, leafID)
	read(family.SessionID, 3, defaultID)
	backgroundCreate := jsonRequest(t, http.MethodPost, "/api/v1/teams/acme/projects", map[string]string{"type": "folder", "name": "CodeBuddy background"})
	backgroundCreate.Header.Set("Authorization", "Bearer "+credential)
	backgroundCreate.Header.Set("Idempotency-Key", "codebuddy-background-project-21240")
	backgroundCreated := httptest.NewRecorder()
	h.ServeHTTP(backgroundCreated, backgroundCreate)
	if backgroundCreated.Code != http.StatusCreated {
		t.Fatalf("create background Project: %d %s", backgroundCreated.Code, backgroundCreated.Body.String())
	}
	var backgroundProject projectDTO
	decodeResponse(t, backgroundCreated, &backgroundProject)
	projectID = backgroundProject.ID
	background := run("background-initial")
	_, parentEvents = read(background.SessionID, 8)
	backgroundLinks := links(parentEvents)
	if len(backgroundLinks) != 1 || backgroundLinks[0].EventCount != 3 {
		t.Fatal("CodeBuddy background spawn did not link its complete child")
	}
	backgroundChildID := backgroundLinks[0].ID
	_, childBefore = read(background.SessionID, 3, backgroundChildID)
	beforePrefix, _ = json.Marshal(childBefore)
	if pending := run("background-pending"); pending.Head != background.Head || !bytes.Equal(pending.Records, background.Records) {
		t.Fatal("CodeBuddy pending background child replaced the selected family")
	}
	read(background.SessionID, 8)
	read(background.SessionID, 3, backgroundChildID)
	completeBackground := run("background-complete")
	_, parentEvents = read(background.SessionID, 13)
	backgroundLinks = links(parentEvents)
	if completeBackground.SessionID != background.SessionID || len(backgroundLinks) != 2 || backgroundLinks[0].ID != backgroundChildID {
		t.Fatal("CodeBuddy second background launch changed prior membership")
	}
	reporterID := backgroundLinks[1].ID
	_, reporterEvents := read(background.SessionID, 6, reporterID)
	encoded, _ = json.Marshal(reporterEvents)
	if !bytes.Contains(encoded, []byte("SendMessage")) || !bytes.Contains(encoded, []byte("ATAPE_BACKGROUND_REPORTED_21240")) {
		t.Fatal("CodeBuddy background reporting tool or final answer missing")
	}
	resumedBackground := run("background-resume")
	_, parentEvents = read(background.SessionID, 15)
	rootBeforeEdit, _ = json.Marshal(parentEvents)
	if resumedBackground.SessionID != background.SessionID || bytes.Contains(rootBeforeEdit, []byte("teammate-message")) || bytes.Count(rootBeforeEdit, []byte(`"author":"User"`)) != 3 {
		t.Fatal("CodeBuddy parent resume invented an inbox turn or another Session")
	}
	_, childAfter = read(background.SessionID, 3, backgroundChildID)
	afterPrefix, _ = json.Marshal(childAfter)
	if !bytes.Equal(beforePrefix, afterPrefix) {
		t.Fatal("CodeBuddy background completion/resume changed the previous child")
	}
	var reporterPage conversation.Conversation
	decodeResponse(t, send("GET", "/api/v1/sessions/"+background.SessionID+"?thread="+url.QueryEscape(reporterID), ""), &reporterPage)
	if reporterPage.Thread.ParentThreadID == nil || *reporterPage.Thread.ParentThreadID != "root" || len(reporterPage.ThreadPath) != 2 {
		t.Fatal("CodeBuddy background child lost its parent path")
	}
	reporterHits := 0
	for _, result := range search("ATAPE_BACKGROUND_REPORTED_21240").Results {
		if result.SessionID != background.SessionID {
			t.Fatal("CodeBuddy background Search escaped the original Project")
		}
		if result.ThreadID != reporterID {
			continue
		}
		reporterHits++
		var anchored conversation.Conversation
		decodeResponse(t, send("GET", "/api/v1/sessions/"+background.SessionID+"?thread="+url.QueryEscape(reporterID)+"&at="+url.QueryEscape(result.EventID)+"&limit=2", ""), &anchored)
		matched := false
		for _, event := range anchored.Events {
			matched = matched || event.ID == result.EventID
		}
		if !matched {
			t.Fatal("CodeBuddy background Search anchor did not open its Event")
		}
	}
	if reporterHits == 0 {
		t.Fatal("CodeBuddy background child missing from Search")
	}
	usageSnapshot, err = store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	usageCount, inputTokens, outputTokens, cachedTokens = 0, 0, 0, 0
	threadUsage = map[string]int{}
	for _, usage := range usageSnapshot.Usage {
		if usage.SessionID != background.SessionID {
			continue
		}
		usageCount++
		threadUsage[usage.ThreadID]++
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
	if usageCount != 9 || inputTokens != 74371 || outputTokens != 1162 || cachedTokens != 43072 || threadUsage["root"] != 6 || threadUsage[backgroundChildID] != 1 || threadUsage[reporterID] != 2 {
		t.Fatalf("CodeBuddy background usage ownership: records=%d input=%d output=%d cache=%d threads=%v", usageCount, inputTokens, outputTokens, cachedTokens, threadUsage)
	}
	provenance, found, err = store.ConversationPage(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, background.SessionID, backgroundChildID, canonical.ConversationPageRequest{Limit: 100})
	if err != nil || !found || len(provenance.Events) != 3 {
		t.Fatalf("CodeBuddy background provenance: %v", err)
	}
	objectID, key, valid = strings.Cut(provenance.Events[0].RawRef, "/records/")
	if !valid {
		t.Fatal("CodeBuddy background child lacks exact Raw provenance")
	}
	decodeResponse(t, send("GET", "/api/v1/raw-objects/"+objectID+"/content?generation=1&limit=1", ""), &raw)
	if len(raw.Chunks) != 1 || raw.NextCursor != "" {
		t.Fatal("CodeBuddy background Raw page exceeded its bound")
	}
	content, err = base64.StdEncoding.DecodeString(raw.Chunks[0].ContentBase64)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(content, &object); err != nil || !bytes.Contains(object.Records[key].Row, []byte("teammate-message")) ||
		!bytes.Contains(object.Records[key].Row, []byte("agent-aeb3d60f")) || !bytes.Contains(object.Records[key].Row, []byte("f8ac30c1-d2eb-4ceb-8f78-51b8223fd568")) {
		t.Fatal("CodeBuddy background Raw lost its native wrapper or child identities")
	}
	if missing := run("background-missing"); missing.Head != resumedBackground.Head || !bytes.Equal(missing.Records, resumedBackground.Records) {
		t.Fatal("CodeBuddy missing background child replaced the visible family")
	}
	read(background.SessionID, 15)
	read(background.SessionID, 3, backgroundChildID)
	read(background.SessionID, 6, reporterID)
	if fixed := run("background-repair"); fixed.Head != resumedBackground.Head || fixed.Observations != 0 {
		t.Fatal("CodeBuddy background repair replayed unchanged content")
	}
	setRaw(false)
	backgroundOff := run("background-edit")
	if backgroundOff.Head == resumedBackground.Head || len(search("CodeBuddyBackgroundPolicyNeedle").Results) != 1 {
		t.Fatal("CodeBuddy background Raw-off stopped Canonical")
	}
	setRaw(true)
	backgroundOn := run("background-reenable")
	if backgroundOn.Head != backgroundOff.Head || !bytes.Equal(backgroundOn.Records, backgroundOff.Records) {
		t.Fatal("CodeBuddy background Raw re-enable changed Canonical provenance")
	}
	if lost := run("background-lost"); lost.Pending == 0 {
		t.Fatal("CodeBuddy background activation loss did not retain frozen recovery")
	}
	recoveredBackground := run("background-recover")
	if recoveredBackground.Pending != 0 {
		t.Fatal("CodeBuddy background recovery left pending work")
	}
	_, childAfter = read(background.SessionID, 3, backgroundChildID)
	encoded, _ = json.Marshal(childAfter)
	if !bytes.Contains(encoded, []byte("CodeBuddyBackgroundFrozenNeedle")) || strings.HasPrefix(childAfter[0].Text, "<teammate-message") || len(search("CodeBuddyBackgroundFrozenNeedle").Results) != 1 {
		t.Fatal("CodeBuddy background recovery lost frozen content or exposed its internal wrapper")
	}
	expireReservations()
	if afterExpiry, events := read(background.SessionID, 15); afterExpiry != recoveredBackground.Head {
		t.Fatal("CodeBuddy background reservation expiry changed selected history")
	} else if encoded, _ := json.Marshal(events); !bytes.Equal(encoded, rootBeforeEdit) {
		t.Fatal("CodeBuddy background child edit changed parent Events")
	}
	read(background.SessionID, 3, backgroundChildID)
	read(background.SessionID, 6, reporterID)

	// A delivered follow-up and ordinary foreground resume append to the same background Thread.
	turnsCreate := jsonRequest(t, http.MethodPost, "/api/v1/teams/acme/projects", map[string]string{"type": "folder", "name": "CodeBuddy continuation"})
	turnsCreate.Header.Set("Authorization", "Bearer "+credential)
	turnsCreate.Header.Set("Idempotency-Key", "codebuddy-turns-project-21240")
	turnsCreated := httptest.NewRecorder()
	h.ServeHTTP(turnsCreated, turnsCreate)
	if turnsCreated.Code != http.StatusCreated {
		t.Fatalf("create continuation Project: %d %s", turnsCreated.Code, turnsCreated.Body.String())
	}
	var turnsProject projectDTO
	decodeResponse(t, turnsCreated, &turnsProject)
	projectID = turnsProject.ID
	turns := run("turns-initial")
	_, parentEvents = read(turns.SessionID, 5)
	turnsLinks := links(parentEvents)
	if len(turnsLinks) != 1 {
		t.Fatal("CodeBuddy continuing child launch missing")
	}
	turnsChildID := turnsLinks[0].ID
	_, childBefore = read(turns.SessionID, 3, turnsChildID)
	if pending := run("turns-pending"); pending.Head != turns.Head || !bytes.Equal(pending.Records, turns.Records) {
		t.Fatal("CodeBuddy delivered but unfinished child replaced the visible family")
	}
	read(turns.SessionID, 5)
	read(turns.SessionID, 3, turnsChildID)
	messageTurns := run("turns-message")
	_, parentEvents = read(turns.SessionID, 9)
	turnsLinks = links(parentEvents)
	if messageTurns.SessionID != turns.SessionID || len(turnsLinks) != 2 || turnsLinks[0].ID != turnsChildID || turnsLinks[1].ID != turnsChildID {
		t.Fatal("CodeBuddy SendMessage created another child or lost its link")
	}
	_, childAfter = read(turns.SessionID, 6, turnsChildID)
	beforePrefix, _ = json.Marshal(childBefore)
	afterPrefix, _ = json.Marshal(childAfter[:3])
	if !bytes.Equal(beforePrefix, afterPrefix) || strings.HasPrefix(childAfter[3].Text, "<teammate-message") {
		t.Fatal("CodeBuddy follow-up changed prior Events or exposed its wrapper")
	}
	humanTurns := func(events []conversation.Event) int {
		count := 0
		for _, event := range events {
			if event.Author == "User" {
				count++
			}
		}
		return count
	}
	run("turns-notices")
	_, parentEvents = read(turns.SessionID, 11)
	encoded, _ = json.Marshal(parentEvents)
	if bytes.Contains(encoded, []byte("Framework Auto-Notification")) || humanTurns(parentEvents) != 2 {
		t.Fatal("CodeBuddy framework inbox notices became human turns")
	}
	resumedTurns := run("turns-resume")
	_, parentEvents = read(turns.SessionID, 15)
	rootBeforeEdit, _ = json.Marshal(parentEvents)
	turnsLinks = links(parentEvents)
	if resumedTurns.SessionID != turns.SessionID || len(turnsLinks) != 3 || humanTurns(parentEvents) != 3 {
		t.Fatal("CodeBuddy resumed background family lost its root turns")
	}
	for _, link := range turnsLinks {
		if link.ID != turnsChildID || link.EventCount != 9 {
			t.Fatal("CodeBuddy continuation links do not share the same complete Thread")
		}
	}
	_, childBefore = read(turns.SessionID, 9, turnsChildID)
	beforePrefix, _ = json.Marshal(childAfter)
	afterPrefix, _ = json.Marshal(childBefore[:6])
	if !bytes.Equal(beforePrefix, afterPrefix) || childBefore[0].Text != "Reply exactly ATAPE_BG_FIRST_21240. Do not use tools." ||
		childBefore[3].Text != "Reply exactly ATAPE_BG_SECOND_21240. Do not use tools." || childBefore[6].Text != "Reply exactly ATAPE_BG_RESUME_21240. Do not use tools." {
		t.Fatal("CodeBuddy foreground resume changed prior turns or delegated prompts")
	}
	turnsHits := 0
	for _, result := range search("ATAPE_BG_RESUME_21240").Results {
		if result.SessionID != turns.SessionID {
			t.Fatal("CodeBuddy continuation escaped its original Project")
		}
		if result.ThreadID != turnsChildID {
			continue
		}
		turnsHits++
		var anchored conversation.Conversation
		decodeResponse(t, send("GET", "/api/v1/sessions/"+turns.SessionID+"?thread="+url.QueryEscape(turnsChildID)+"&at="+url.QueryEscape(result.EventID)+"&limit=2", ""), &anchored)
		matched := false
		for _, event := range anchored.Events {
			matched = matched || event.ID == result.EventID
		}
		if !matched || len(anchored.ThreadPath) != 2 || anchored.Thread.ParentThreadID == nil || *anchored.Thread.ParentThreadID != "root" {
			t.Fatal("CodeBuddy continuation Search anchor or parent path missing")
		}
	}
	if turnsHits == 0 {
		t.Fatal("CodeBuddy continued child missing from Search")
	}
	provenance, found, err = store.ConversationPage(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, turns.SessionID, turnsChildID, canonical.ConversationPageRequest{Limit: 100})
	if err != nil || !found || len(provenance.Events) != 9 {
		t.Fatalf("CodeBuddy continuing child provenance: %v", err)
	}
	objectID, key, valid = strings.Cut(provenance.Events[3].RawRef, "/records/")
	if !valid {
		t.Fatal("CodeBuddy continuing child lacks exact Raw provenance")
	}
	decodeResponse(t, send("GET", "/api/v1/raw-objects/"+objectID+"/content?generation=1&limit=1", ""), &raw)
	if len(raw.Chunks) != 1 || raw.NextCursor != "" {
		t.Fatal("CodeBuddy continuing child Raw page exceeded its bound")
	}
	content, err = base64.StdEncoding.DecodeString(raw.Chunks[0].ContentBase64)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(content, &object); err != nil || !bytes.Contains(object.Records[key].Row, []byte("teammate-message")) ||
		!bytes.Contains(object.Records[key].Row, []byte("agent-6004ad24")) || !bytes.Contains(object.Records[key].Row, []byte("c1782681-ecb5-4124-83e6-4b12c4a8b743")) {
		t.Fatal("CodeBuddy follow-up Raw lost its wrapper or child identities")
	}
	if invalid := run("turns-invalid"); invalid.Head != resumedTurns.Head || !bytes.Equal(invalid.Records, resumedTurns.Records) {
		t.Fatal("CodeBuddy unproven delivery replaced the visible family")
	}
	read(turns.SessionID, 15)
	read(turns.SessionID, 9, turnsChildID)
	if fixed := run("turns-repair"); fixed.Head != resumedTurns.Head || fixed.Observations != 0 {
		t.Fatal("CodeBuddy repaired delivery replayed unchanged content")
	}
	setRaw(false)
	turnsOff := run("turns-edit")
	if turnsOff.Head == resumedTurns.Head || len(search("CodeBuddyContinuingPolicyNeedle").Results) != 1 {
		t.Fatal("CodeBuddy continuation Raw-off stopped Canonical")
	}
	setRaw(true)
	turnsOn := run("turns-reenable")
	if turnsOn.Head != turnsOff.Head || !bytes.Equal(turnsOn.Records, turnsOff.Records) {
		t.Fatal("CodeBuddy continuation Raw re-enable changed Canonical provenance")
	}
	if lost := run("turns-raw-only"); lost.Pending == 0 || lost.Head != turnsOn.Head {
		t.Fatal("CodeBuddy framework-only Raw response loss changed Canonical or lost recovery")
	}
	recoveredTurnsRaw := run("turns-raw-recover")
	if recoveredTurnsRaw.Pending != 0 || recoveredTurnsRaw.Head != turnsOn.Head || !bytes.Equal(recoveredTurnsRaw.Records, turnsOn.Records) {
		t.Fatal("CodeBuddy framework Raw recovery failed after all source files were deleted")
	}
	if len(search("Framework Auto-Notification").Results) != 0 || len(search("902s").Results) != 0 {
		t.Fatal("CodeBuddy framework-only Raw entered Search")
	}
	var turnsArchive rawarchive.SessionArchive
	decodeResponse(t, send("GET", "/api/v1/sessions/"+turns.SessionID+"/raw", ""), &turnsArchive)
	var noticesRaw strings.Builder
	for _, archived := range turnsArchive.Objects {
		var page rawarchive.ContentPage
		decodeResponse(t, send("GET", "/api/v1/raw-objects/"+archived.ObjectID+"/content?limit=1", ""), &page)
		if !page.Finalized || page.Generation != 1 || page.NextCursor != "" || len(page.Chunks) != 1 {
			t.Fatal("CodeBuddy continuation Raw was not a bounded immutable upload")
		}
		decoded, err := base64.StdEncoding.DecodeString(page.Chunks[0].ContentBase64)
		if err != nil {
			t.Fatal(err)
		}
		noticesRaw.Write(decoded)
	}
	for _, native := range []string{"Duration: 902s", "73a4fcbf-a1a2-481e-b083-378345b2f73e", "53b33b51-ecf7-4abb-b935-d7bc99d31e5e", "teammateMessage"} {
		if !strings.Contains(noticesRaw.String(), native) {
			t.Fatalf("CodeBuddy framework Raw recovery lost %s", native)
		}
	}
	if lost := run("turns-lost"); lost.Pending == 0 {
		t.Fatal("CodeBuddy continuation activation loss did not retain frozen recovery")
	}
	recoveredTurns := run("turns-recover")
	if recoveredTurns.Pending != 0 {
		t.Fatal("CodeBuddy continuation recovery left pending work")
	}
	_, childAfter = read(turns.SessionID, 9, turnsChildID)
	beforePrefix, _ = json.Marshal(childBefore[:6])
	afterPrefix, _ = json.Marshal(childAfter[:6])
	if !bytes.Equal(beforePrefix, afterPrefix) || childAfter[8].Text != "CodeBuddyContinuingFrozenNeedle" || len(search("CodeBuddyContinuingFrozenNeedle").Results) != 1 {
		t.Fatal("CodeBuddy continuation recovery changed earlier turns or lost frozen content")
	}
	usageSnapshot, err = store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	usageCount, inputTokens, outputTokens, cachedTokens = 0, 0, 0, 0
	threadUsage = map[string]int{}
	for _, usage := range usageSnapshot.Usage {
		if usage.SessionID != turns.SessionID {
			continue
		}
		usageCount++
		threadUsage[usage.ThreadID]++
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
	if usageCount != 10 || inputTokens != 100306 || outputTokens != 801 || cachedTokens != 74880 || threadUsage["root"] != 7 || threadUsage[turnsChildID] != 3 {
		t.Fatalf("CodeBuddy continuation usage ownership: records=%d input=%d output=%d cache=%d threads=%v", usageCount, inputTokens, outputTokens, cachedTokens, threadUsage)
	}
	expireReservations()
	if afterExpiry, events := read(turns.SessionID, 15); afterExpiry != recoveredTurns.Head {
		t.Fatal("CodeBuddy continuation reservation expiry changed selected history")
	} else if encoded, _ := json.Marshal(events); !bytes.Equal(encoded, rootBeforeEdit) {
		t.Fatal("CodeBuddy continuing child edit changed parent Events")
	}
	read(turns.SessionID, 9, turnsChildID)
	// Emergency compaction appends internal context inside the existing delegated turn.
	emergencyCreate := jsonRequest(t, http.MethodPost, "/api/v1/teams/acme/projects", map[string]string{"type": "folder", "name": "CodeBuddy emergency compaction"})
	emergencyCreate.Header.Set("Authorization", "Bearer "+credential)
	emergencyCreate.Header.Set("Idempotency-Key", "codebuddy-emergency-project-21240")
	emergencyCreated := httptest.NewRecorder()
	h.ServeHTTP(emergencyCreated, emergencyCreate)
	if emergencyCreated.Code != http.StatusCreated {
		t.Fatalf("create emergency Project: %d %s", emergencyCreated.Code, emergencyCreated.Body.String())
	}
	var emergencyProject projectDTO
	decodeResponse(t, emergencyCreated, &emergencyProject)
	projectID = emergencyProject.ID
	emergency := run("emergency-initial")
	_, parentEvents = read(emergency.SessionID, 5)
	emergencyLinks := links(parentEvents)
	if len(emergencyLinks) != 1 {
		t.Fatal("CodeBuddy emergency fixture lost its child launch")
	}
	emergencyChildID := emergencyLinks[0].ID
	_, childBefore = read(emergency.SessionID, 3, emergencyChildID)
	emergencyRoot := run("emergency-root")
	_, parentEvents = read(emergency.SessionID, 10)
	if emergencyRoot.SessionID != emergency.SessionID || humanTurns(parentEvents) != 2 {
		t.Fatal("CodeBuddy root emergency created an internal user turn")
	}
	_, childAfter = read(emergency.SessionID, 8, emergencyChildID)
	beforePrefix, _ = json.Marshal(childBefore)
	afterPrefix, _ = json.Marshal(childAfter[:3])
	if !bytes.Equal(beforePrefix, afterPrefix) {
		t.Fatal("CodeBuddy root emergency changed the earlier child")
	}
	if pending := run("emergency-pending"); pending.Head != emergencyRoot.Head || !bytes.Equal(pending.Records, emergencyRoot.Records) {
		t.Fatal("CodeBuddy unfinished child emergency replaced the visible family")
	}
	read(emergency.SessionID, 10)
	read(emergency.SessionID, 8, emergencyChildID)
	run("emergency-child")
	_, parentEvents = read(emergency.SessionID, 15)
	_, childBefore = read(emergency.SessionID, 16, emergencyChildID)
	beforePrefix, _ = json.Marshal(childAfter)
	afterPrefix, _ = json.Marshal(childBefore[:8])
	encoded, _ = json.Marshal(childBefore)
	if humanTurns(parentEvents) != 3 || humanTurns(childBefore) != 3 || !bytes.Equal(beforePrefix, afterPrefix) ||
		!bytes.Contains(encoded, []byte("persisted-output")) {
		t.Fatal("CodeBuddy child emergency lost its original transcript or exposed internal context")
	}
	for _, event := range childBefore {
		if event.Author == "User" && strings.HasPrefix(event.Text, "Please continue based on the summarized context") {
			t.Fatal("CodeBuddy internal emergency continuation became a human turn")
		}
	}
	emergencyResumed := run("emergency-resume")
	_, parentEvents = read(emergency.SessionID, 19)
	rootBeforeEdit, _ = json.Marshal(parentEvents)
	emergencyLinks = links(parentEvents)
	if emergencyResumed.SessionID != emergency.SessionID || len(emergencyLinks) != 4 || humanTurns(parentEvents) != 4 {
		t.Fatal("CodeBuddy post-emergency resume lost its parent turns")
	}
	for _, link := range emergencyLinks {
		if link.ID != emergencyChildID || link.EventCount != 19 {
			t.Fatal("CodeBuddy post-emergency resume created another child")
		}
	}
	_, childAfter = read(emergency.SessionID, 19, emergencyChildID)
	beforePrefix, _ = json.Marshal(childBefore)
	afterPrefix, _ = json.Marshal(childAfter[:16])
	if !bytes.Equal(beforePrefix, afterPrefix) || childAfter[18].Text != "ATAPE_CHILD_AFTER_COMPACT_21240" || humanTurns(childAfter) != 4 {
		t.Fatal("CodeBuddy post-emergency resume changed earlier child turns")
	}
	emergencyHits := 0
	for _, result := range search("ATAPE_CHILD_AFTER_COMPACT_21240").Results {
		if result.SessionID != emergency.SessionID {
			t.Fatal("CodeBuddy emergency Search escaped its original Project")
		}
		if result.ThreadID != emergencyChildID {
			continue
		}
		emergencyHits++
		var anchored conversation.Conversation
		decodeResponse(t, send("GET", "/api/v1/sessions/"+emergency.SessionID+"?thread="+url.QueryEscape(emergencyChildID)+"&at="+url.QueryEscape(result.EventID)+"&limit=2", ""), &anchored)
		matched := false
		for _, event := range anchored.Events {
			matched = matched || event.ID == result.EventID
		}
		if !matched || len(anchored.ThreadPath) != 2 {
			t.Fatal("CodeBuddy post-emergency Search anchor or path missing")
		}
	}
	if emergencyHits == 0 {
		t.Fatal("CodeBuddy post-emergency child missing from Search")
	}
	if invalid := run("emergency-invalid"); invalid.Head != emergencyResumed.Head || !bytes.Equal(invalid.Records, emergencyResumed.Records) {
		t.Fatal("CodeBuddy unproven emergency context replaced the visible family")
	}
	read(emergency.SessionID, 19)
	read(emergency.SessionID, 19, emergencyChildID)
	if fixed := run("emergency-repair"); fixed.Head != emergencyResumed.Head || fixed.Observations != 0 {
		t.Fatal("CodeBuddy emergency repair replayed unchanged data")
	}
	setRaw(false)
	emergencyOff := run("emergency-edit")
	if emergencyOff.Head == emergencyResumed.Head || len(search("CodeBuddyEmergencyPolicyNeedle").Results) != 1 {
		t.Fatal("CodeBuddy emergency Raw-off stopped Canonical")
	}
	setRaw(true)
	emergencyOn := run("emergency-reenable")
	if emergencyOn.Head != emergencyOff.Head || !bytes.Equal(emergencyOn.Records, emergencyOff.Records) {
		t.Fatal("CodeBuddy emergency Raw re-enable changed Canonical provenance")
	}
	if lost := run("emergency-raw-only"); lost.Pending == 0 || lost.Head != emergencyOn.Head {
		t.Fatal("CodeBuddy child compact Raw-only response loss changed Canonical or lost recovery")
	}
	emergencyRawRecovered := run("emergency-raw-recover")
	if emergencyRawRecovered.Pending != 0 || emergencyRawRecovered.Head != emergencyOn.Head || !bytes.Equal(emergencyRawRecovered.Records, emergencyOn.Records) {
		t.Fatal("CodeBuddy child compact Raw recovery failed after both source files were deleted")
	}
	if len(search("CodeBuddyEmergencyRawOnlyNeedle").Results) != 0 {
		t.Fatal("CodeBuddy child compact Raw entered Search")
	}
	var emergencyArchive rawarchive.SessionArchive
	decodeResponse(t, send("GET", "/api/v1/sessions/"+emergency.SessionID+"/raw", ""), &emergencyArchive)
	var emergencyRaw strings.Builder
	for _, archived := range emergencyArchive.Objects {
		var page rawarchive.ContentPage
		decodeResponse(t, send("GET", "/api/v1/raw-objects/"+archived.ObjectID+"/content?limit=1", ""), &page)
		if !page.Finalized || page.Generation != 1 || page.NextCursor != "" || len(page.Chunks) != 1 {
			t.Fatal("CodeBuddy emergency Raw exceeded its immutable object bound")
		}
		decoded, err := base64.StdEncoding.DecodeString(page.Chunks[0].ContentBase64)
		if err != nil {
			t.Fatal(err)
		}
		emergencyRaw.Write(decoded)
	}
	for _, native := range []string{"CodeBuddyEmergencyRawOnlyNeedle", "6e979b7f-a116-4516-9b69-0cd54b94dacd", "e5d053d3-035d-4c1d-b9bd-72fcb5caf234",
		"cd73d706-d20c-45ab-bba1-63906b49021f", "547a547a-3484-4e85-b7cd-f64fef7decc4", "agent-1fc648c0", "5167c3b9-23a8-4593-8ba2-4dd5185a574e"} {
		if !strings.Contains(emergencyRaw.String(), native) {
			t.Fatalf("CodeBuddy emergency Raw recovery lost native provenance %s", native)
		}
	}
	if lost := run("emergency-lost"); lost.Pending == 0 {
		t.Fatal("CodeBuddy emergency activation loss did not retain frozen recovery")
	}
	recoveredEmergency := run("emergency-recover")
	if recoveredEmergency.Pending != 0 {
		t.Fatal("CodeBuddy emergency recovery left pending work")
	}
	_, childAfter = read(emergency.SessionID, 19, emergencyChildID)
	beforePrefix, _ = json.Marshal(childBefore)
	afterPrefix, _ = json.Marshal(childAfter[:16])
	if !bytes.Equal(beforePrefix, afterPrefix) || childAfter[18].Text != "CodeBuddyEmergencyFrozenNeedle" || len(search("CodeBuddyEmergencyFrozenNeedle").Results) != 1 {
		t.Fatal("CodeBuddy emergency recovery lost the original transcript or frozen continuation")
	}
	usageSnapshot, err = store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	usageCount, inputTokens, outputTokens, cachedTokens = 0, 0, 0, 0
	threadUsage = map[string]int{}
	for _, usage := range usageSnapshot.Usage {
		if usage.SessionID != emergency.SessionID {
			continue
		}
		usageCount++
		threadUsage[usage.ThreadID]++
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
	if usageCount != 15 || inputTokens != 151085 || outputTokens != 1795 || cachedTokens != 75840 || threadUsage["root"] != 8 || threadUsage[emergencyChildID] != 7 {
		t.Fatalf("CodeBuddy emergency usage ownership: records=%d input=%d output=%d cache=%d threads=%v", usageCount, inputTokens, outputTokens, cachedTokens, threadUsage)
	}
	expireReservations()
	if afterExpiry, events := read(emergency.SessionID, 19); afterExpiry != recoveredEmergency.Head {
		t.Fatal("CodeBuddy emergency reservation expiry changed selected history")
	} else if encoded, _ := json.Marshal(events); !bytes.Equal(encoded, rootBeforeEdit) {
		t.Fatal("CodeBuddy emergency child edit changed parent Events")
	}
	read(emergency.SessionID, 19, emergencyChildID)
	// Ordinary native tools share one row ID, but each call/result and Raw frame is distinct.
	multiCreate := jsonRequest(t, http.MethodPost, "/api/v1/teams/acme/projects", map[string]string{"type": "folder", "name": "CodeBuddy ordinary tools"})
	multiCreate.Header.Set("Authorization", "Bearer "+credential)
	multiCreate.Header.Set("Idempotency-Key", "codebuddy-multitool-project-21240")
	multiCreated := httptest.NewRecorder()
	h.ServeHTTP(multiCreated, multiCreate)
	if multiCreated.Code != http.StatusCreated {
		t.Fatalf("create multi-tool Project: %d %s", multiCreated.Code, multiCreated.Body.String())
	}
	var multiProject projectDTO
	decodeResponse(t, multiCreated, &multiProject)
	projectID = multiProject.ID
	multiInitial := run("multi-initial")
	_, multiBefore := read(multiInitial.SessionID, 3)
	if pending := run("multi-pending"); pending.Head != multiInitial.Head || !bytes.Equal(pending.Records, multiInitial.Records) {
		t.Fatal("CodeBuddy incomplete tool group replaced visible history")
	}
	multiComplete := run("multi-complete")
	_, multiEvents := read(multiComplete.SessionID, 9)
	beforePrefix, _ = json.Marshal(multiBefore)
	afterPrefix, _ = json.Marshal(multiEvents[:3])
	if !bytes.Equal(beforePrefix, afterPrefix) {
		t.Fatal("CodeBuddy tool group changed the existing prefix")
	}
	multiResumed := run("multi-resume")
	_, multiEvents = read(multiResumed.SessionID, 11)
	if multiResumed.SessionID != multiInitial.SessionID || humanTurns(multiEvents) != 3 {
		t.Fatal("CodeBuddy tool group resume lost its Session or turns")
	}
	for index := 4; index < 6; index++ {
		call, result := multiEvents[index], multiEvents[index+2]
		if call.Tool == nil || result.Tool == nil || call.Tool.ToolCallID != result.Tool.ToolCallID || result.Tool.Status == nil || *result.Tool.Status != "completed" {
			t.Fatal("CodeBuddy tool group result does not match its call")
		}
	}
	if multiEvents[4].Tool.ToolCallID == multiEvents[5].Tool.ToolCallID {
		t.Fatal("CodeBuddy sibling tool calls collided")
	}
	provenance, found, err = store.ConversationPage(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, multiResumed.SessionID, "root", canonical.ConversationPageRequest{Limit: 100})
	if err != nil || !found || len(provenance.Events) != 11 {
		t.Fatalf("CodeBuddy tool group provenance: %v", err)
	}
	if provenance.Events[4].RawRef == provenance.Events[5].RawRef {
		t.Fatal("CodeBuddy sibling calls share one Raw record reference")
	}
	for index, nativeCall := range []string{"chatcmpl-tool-9c26c1f2d46c37d5", "chatcmpl-tool-9271197b571a0a23"} {
		objectID, recordKey, valid := strings.Cut(provenance.Events[4+index].RawRef, "/records/")
		if !valid {
			t.Fatal("CodeBuddy sibling lacks a Raw reference")
		}
		var page rawarchive.ContentPage
		decodeResponse(t, send("GET", "/api/v1/raw-objects/"+objectID+"/content?generation=1&limit=1", ""), &page)
		if len(page.Chunks) != 1 || page.NextCursor != "" {
			t.Fatal("CodeBuddy sibling Raw page exceeded its bound")
		}
		decoded, err := base64.StdEncoding.DecodeString(page.Chunks[0].ContentBase64)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(decoded, &object); err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(object.Records[recordKey].Row, []byte(nativeCall)) || !bytes.Contains(object.Records[recordKey].Row, []byte("7b50079b29654d3684c42cafc72ed0ef")) {
			t.Fatal("CodeBuddy sibling Raw reference resolves to another native call")
		}
	}
	if invalid := run("multi-invalid"); invalid.Head != multiResumed.Head || !bytes.Equal(invalid.Records, multiResumed.Records) {
		t.Fatal("CodeBuddy mixed model responses replaced the selected head")
	}
	if fixed := run("multi-repair"); fixed.Head != multiResumed.Head || fixed.Observations != 0 {
		t.Fatal("CodeBuddy tool group repair replayed unchanged content")
	}
	usageSnapshot, err = store.Overview(t.Context(), authentication.Principal{UserID: userID, Method: authentication.WebAuthentication}, teamID,
		time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC), canonical.OverviewFilter{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	usageCount, inputTokens, outputTokens, cachedTokens = 0, 0, 0, 0
	for _, usage := range usageSnapshot.Usage {
		if usage.SessionID != multiResumed.SessionID {
			continue
		}
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
	if usageCount != 4 || inputTokens != 28477 || outputTokens != 145 || cachedTokens != 21376 {
		t.Fatalf("CodeBuddy tool group usage: %d %d %d %d", usageCount, inputTokens, outputTokens, cachedTokens)
	}
	setRaw(false)
	multiOff := run("multi-edit")
	if multiOff.Head == multiResumed.Head || len(search("CodeBuddyMultiPolicyNeedle").Results) != 1 {
		t.Fatal("CodeBuddy tool group Raw-off stopped Canonical")
	}
	setRaw(true)
	multiOn := run("multi-reenable")
	if multiOn.Head != multiOff.Head || !bytes.Equal(multiOn.Records, multiOff.Records) {
		t.Fatal("CodeBuddy tool group Raw-on changed Canonical provenance")
	}
	if lost := run("multi-raw-only"); lost.Pending == 0 || lost.Head != multiOn.Head {
		t.Fatal("CodeBuddy sibling-only Raw response loss lost recovery")
	}
	multiRawRecovered := run("multi-raw-recover")
	if multiRawRecovered.Pending != 0 || multiRawRecovered.Head != multiOn.Head || !bytes.Equal(multiRawRecovered.Records, multiOn.Records) {
		t.Fatal("CodeBuddy sibling-only Raw recovery failed after source deletion")
	}
	var multiArchive rawarchive.SessionArchive
	decodeResponse(t, send("GET", "/api/v1/sessions/"+multiResumed.SessionID+"/raw", ""), &multiArchive)
	var multiRaw strings.Builder
	for _, archived := range multiArchive.Objects {
		var page rawarchive.ContentPage
		decodeResponse(t, send("GET", "/api/v1/raw-objects/"+archived.ObjectID+"/content?limit=1", ""), &page)
		if !page.Finalized || page.Generation != 1 || page.NextCursor != "" || len(page.Chunks) != 1 {
			t.Fatal("CodeBuddy multi-tool Raw exceeded its object bound")
		}
		decoded, err := base64.StdEncoding.DecodeString(page.Chunks[0].ContentBase64)
		if err != nil {
			t.Fatal(err)
		}
		multiRaw.Write(decoded)
	}
	for _, native := range []string{"CodeBuddyMultiRawOnlyNeedle", "7b50079b29654d3684c42cafc72ed0ef", "chatcmpl-tool-9c26c1f2d46c37d5", "chatcmpl-tool-9271197b571a0a23", "ATAPE_MULTITOOL_ALPHA_21240", "ATAPE_MULTITOOL_BETA_21240"} {
		if !strings.Contains(multiRaw.String(), native) {
			t.Fatalf("CodeBuddy sibling Raw lost %s", native)
		}
	}
	if len(search("CodeBuddyMultiRawOnlyNeedle").Results) != 0 {
		t.Fatal("CodeBuddy sibling Raw entered Search")
	}
	if lost := run("multi-lost"); lost.Pending == 0 {
		t.Fatal("CodeBuddy multi-tool activation loss lost recovery")
	}
	recoveredMulti := run("multi-recover")
	_, multiEvents = read(recoveredMulti.SessionID, 11)
	if recoveredMulti.Pending != 0 || multiEvents[10].Text != "CodeBuddyMultiFrozenNeedle" || len(search("CodeBuddyMultiFrozenNeedle").Results) != 1 {
		t.Fatal("CodeBuddy multi-tool frozen recovery failed after source deletion")
	}
	expireReservations()
	read(recoveredMulti.SessionID, 11)
	// Optional local acceptance: keep the real server alive while inspecting its Web reader.
	if review := os.Getenv("ATAPE_CODEBUDDY_REVIEW_FILE"); review != "" {
		payload, err := json.Marshal(map[string]any{"origin": origin, "projectId": projectID, "teamId": teamID, "sessionId": recoveredMulti.SessionID, "cookieName": cookie.Name, "cookieValue": cookie.Value})
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
