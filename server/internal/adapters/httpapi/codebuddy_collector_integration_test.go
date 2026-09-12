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
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC))
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
		time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC))
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
	expired, err := pool.Exec(t.Context(), `UPDATE canonical_publication_reservations r
		SET expires_at=clock_timestamp()-interval '1 second'
		FROM canonical_publication_sources s
		WHERE s.session_id=r.session_id AND s.captured_by_user_id=$1 AND s.adapter_id='codebuddy'`, userID)
	if err != nil || expired.RowsAffected() == 0 {
		t.Fatalf("expire completed CodeBuddy fixture reservations: %v", err)
	}
	if afterExpiry, _ := read(family.SessionID, 20); afterExpiry != recoveredFamily.Head {
		t.Fatal("CodeBuddy reservation expiry changed selected history")
	}
	read(family.SessionID, 6, childID)
	read(family.SessionID, 6, middleID)
	read(family.SessionID, 2, leafID)
	read(family.SessionID, 3, defaultID)
	// Optional local acceptance: keep the real server alive while inspecting its Web reader.
	if review := os.Getenv("ATAPE_CODEBUDDY_REVIEW_FILE"); review != "" {
		payload, err := json.Marshal(map[string]any{"origin": origin, "projectId": projectID, "teamId": teamID, "sessionId": recoveredFamily.SessionID, "cookieName": cookie.Name, "cookieValue": cookie.Value})
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
