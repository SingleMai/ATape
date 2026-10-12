package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestToolIdentityPublicationContract(t *testing.T) {
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("tool_identity"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
	if err != nil {
		t.Fatal(err)
	}
	testcontainers.CleanupContainer(t, container)
	url, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := postgresadapter.NewPool(url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := postgresadapter.Prepare(ctx, pool); err != nil {
		t.Fatal(err)
	}
	seedControlPlane(t, pool)
	reader := postgresadapter.NewStore(pool)
	writer, err := postgresadapter.NewPublicationStore(pool, publication.Limits{PartBytes: 1 << 20, TargetBytes: 8 << 20, UserPendingBytes: 16 << 20, Parts: 16, Reservations: 64, ReservationLifetime: time.Minute, LeaseLifetime: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	cli, web := canonicalcontract.CLIPrincipal(), canonicalcontract.WebPrincipal()
	batch := func(source string) ingestion.Batch {
		b := canonicalcontract.ValidBatch()
		b.BatchID, b.Session.SourceSessionID = "identity-"+source, source
		b.CanonicalProfileVersion = ingestion.ToolIdentityCanonicalProfileVersion
		b.Session.UpdatedAt, b.Session.UpdatedAtUnknown = "", true
		first := b.Events[0]
		first.Kind, first.SourceEventID, first.SourceOrder = "tool_call", "mcp-start", 1
		first.OccurredAt, first.OccurredAtUnknown = "", true
		first.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"mcp","title":"MCP","status":"pending","_meta":{"atape.dev/tool-identity":{"type":"mcp","server":"docs","name":"read"}},"rawInput":{"secret":"source-only"}}`
		last := b.Events[1]
		last.Kind, last.SourceEventID, last.SourceOrder = "tool_result", "mcp-end", 2
		last.ToolUpdateJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"mcp","status":"completed","rawOutput":"source-only"}`
		skill := first
		skill.SourceEventID, skill.SourceOrder = "skill", 3
		skill.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"skill","title":"Skill","_meta":{"atape.dev/tool-identity":{"type":"skill","name":"review"}}}`
		b.Events = []ingestion.Event{first, last, skill}
		b.Session.ReportedEventCount = len(b.Events)
		return b
	}
	stage := func(b ingestion.Batch, target, base string) publication.Attempt {
		t.Helper()
		reservation, e := writer.Reserve(ctx, cli, publication.Scope{ProjectID: b.ProjectID, InstallationID: b.Source.InstallationID, AdapterID: b.Source.AdapterID, SourceSessionID: b.Session.SourceSessionID, OriginKey: "identity"})
		if e != nil {
			t.Fatal(e)
		}
		a, e := writer.Begin(ctx, cli, publication.Begin{ReservationID: reservation.ID, CaptureID: reservation.ID, BaseHead: base, TransformVersion: "identity-v4"})
		if e != nil {
			t.Fatal(e)
		}
		body, e := json.Marshal(publication.CanonicalPart{Target: publication.Target{Profile: target, Events: len(b.Events), Threads: len(b.Threads), RetainedThreadIDs: []string{}}, Batch: b})
		if e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256(body)
		part, e := writer.Put(ctx, cli, a.ID, 0, hex.EncodeToString(sum[:]), body)
		if e != nil {
			t.Fatal(e)
		}
		hash := publication.NewManifestHasher()
		hash.Add(part)
		a, e = writer.Seal(ctx, cli, a.ID, hash.Manifest())
		if e != nil {
			t.Fatal(e)
		}
		return a
	}
	assertView := func(session, head string) sessionanalytics.Result {
		t.Helper()
		view, e := sessionanalytics.New(reader).Open(ctx, web, session, sessionanalytics.Query{Metric: "mcp_tools"})
		if e != nil {
			t.Fatal(e)
		}
		if view.Head != head || view.AnalyticsVersion != 2 || view.Capabilities.MCPCalls != 1 || view.Capabilities.SkillCalls != 1 || view.Capabilities.UnclassifiedCalls != 0 || view.Capabilities.MCP[0].Completed != 1 || view.Capabilities.Skills[0].Unknown != 1 || len(view.Evidence.Items) != 1 {
			t.Fatalf("incorrect v4 view: %+v", view)
		}
		facts, ok, e := reader.SessionAnalytics(ctx, web, session, view.Snapshot)
		if e != nil || !ok || !facts.Session.UpdatedAt.IsZero() {
			t.Fatalf("v4 facts: %+v %v %v", facts, ok, e)
		}
		for _, event := range facts.Events {
			if event.Text != "" || strings.Contains(event.ToolUpdateJSON, "source-only") || strings.Contains(event.ToolUpdateJSON, "rawInput") || strings.Contains(event.ToolUpdateJSON, "rawOutput") {
				t.Fatal("analysis exposed tool bodies")
			}
		}
		item := view.Evidence.Items[0]
		page, ok, e := reader.ConversationPage(ctx, web, session, item.ThreadID, canonical.ConversationPageRequest{Limit: 1, Snapshot: view.Snapshot, AtEventID: item.EventID})
		if e != nil || !ok || page.SnapshotToken != view.Snapshot {
			t.Fatalf("conditional reader: %+v %v %v", page, ok, e)
		}
		return view
	}
	native, e := ingestion.NewIngestor(reader).ApplyBatch(ctx, cli, batch("identity-native"))
	if e != nil {
		t.Fatal(e)
	}
	assertView(native.SessionID, "")
	t.Run("file activity v5 native and publication", func(t *testing.T) {
		b := batch("file-native")
		b.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
		b.Events[0].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"one","title":"Read first display","_meta":{"atape.dev/tool-identity":{"type":"tool","name":"Read"},"atape.dev/file-activity":[{"operation":"read","path":"src/a.go"},{"operation":"read","path":"src/a.go"},{"operation":"edit","path":"src/a.go"},{"operation":"search","path":"src"}]},"rawInput":{"private":"source-only"}}`
		b.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"one","title":"Last first display","status":"completed"}`
		b.Events[2].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"two","title":"Read second display","_meta":{"atape.dev/tool-identity":null,"atape.dev/file-activity":[{"operation":"read","path":"src/a.go"}]}}`
		unknown := b.Events[0]
		unknown.SourceEventID, unknown.SourceOrder = "file-unknown", 4
		unknown.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"unknown","title":"Read secret-title.go","kind":"read"}`
		b.Events = append(b.Events, unknown)
		b.Session.ReportedEventCount = len(b.Events)
		module := sessionanalytics.New(reader)
		assertFiles := func(session, head string) sessionanalytics.Result {
			t.Helper()
			view, err := module.Open(ctx, web, session, sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files", Limit: 1})
			if err != nil {
				t.Fatal(err)
			}
			f := view.FileActivity
			if view.Head != head || f == nil || f.CallsWithActivity != 2 || f.CallsWithoutActivity != 1 || f.ReadCalls != 2 || f.EditCalls != 1 || f.SearchCalls != 1 || f.UniquePaths != 2 || f.Paths[0].Path != "src/a.go" || f.Paths[0].Calls != 2 || len(view.Evidence.Items) != 1 || view.Evidence.Items[0].Label != "Last first display" || view.Evidence.NextCursor == "" {
				t.Fatalf("file facts: %+v", view)
			}
			wire, _ := json.Marshal(view)
			if strings.Contains(string(wire), "source-only") || strings.Contains(string(wire), "secret-title.go") || strings.Contains(string(wire), "rawInput") {
				t.Fatal("file analysis inferred title path or exposed source body")
			}
			facts, ok, err := reader.SessionAnalytics(ctx, web, session, view.Snapshot)
			if err != nil || !ok {
				t.Fatalf("file snapshot: %v %v", ok, err)
			}
			found := false
			for _, event := range facts.Events {
				if event.Text != "" || strings.Contains(event.ToolUpdateJSON, "source-only") {
					t.Fatal("file snapshot exposed payload")
				}
				tool, err := canonical.ParseToolUpdate(event.ToolUpdateJSON)
				if err != nil {
					t.Fatal(err)
				}
				if tool.Meta != nil && tool.Meta.FileActivity != nil {
					found = true
				}
			}
			if !found {
				t.Fatal("snapshot stripped file namespace")
			}
			q := sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files", File: f.Paths[0].Key, Operation: "read", Limit: 1, Snapshot: view.Snapshot}
			first, err := module.Open(ctx, web, session, q)
			if err != nil || len(first.Evidence.Items) != 1 || first.Evidence.Items[0].Label != "Last first display" || first.Evidence.NextCursor == "" {
				t.Fatalf("file page: %+v %v", first.Evidence, err)
			}
			q.Cursor = first.Evidence.NextCursor
			last, err := module.Open(ctx, web, session, q)
			if err != nil || len(last.Evidence.Items) != 1 || last.Evidence.Items[0].Label != "Read second display" {
				t.Fatalf("file continuation: %+v %v", last.Evidence, err)
			}
			q.Operation = "edit"
			if _, err := module.Open(ctx, web, session, q); err == nil {
				t.Fatal("file cursor ignored changed operation")
			}
			item := first.Evidence.Items[0]
			page, ok, err := reader.ConversationPage(ctx, web, session, item.ThreadID, canonical.ConversationPageRequest{Limit: 1, Snapshot: view.Snapshot, AtEventID: item.EventID})
			if err != nil || !ok || page.SnapshotToken != view.Snapshot {
				t.Fatalf("file original target: %v %v", ok, err)
			}
			anchor := false
			for _, event := range page.Events {
				if event.ID == item.EventID && event.ToolLabel == item.Label {
					anchor = true
				}
			}
			if !anchor {
				t.Fatal("file evidence did not open original last update")
			}
			old, err := module.Open(ctx, web, session, sessionanalytics.Query{AnalyticsVersion: 3})
			if err != nil || old.FileActivity != nil {
				t.Fatalf("old file report appeared: %+v %v", old, err)
			}
			outsider := web
			outsider.UserID = "00000000-0000-4000-8000-000000000099"
			_, err = module.Open(ctx, outsider, session, sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files", Snapshot: view.Snapshot})
			var concealed *sessionanalytics.NotFoundError
			if !errors.As(err, &concealed) {
				t.Fatalf("file token bypassed membership: %v", err)
			}
			return view
		}
		nativeWriter := ingestion.NewIngestor(reader)
		native, err := nativeWriter.ApplyBatch(ctx, cli, b)
		if err != nil {
			t.Fatal(err)
		}
		nativeView := assertFiles(native.SessionID, "")
		b.BatchID = "native-file-change"
		b.Events[0].Revision++
		b.Events[0].ToolUpdateJSON = strings.ReplaceAll(b.Events[0].ToolUpdateJSON, "src/a.go", "src/changed.go")
		if _, err := nativeWriter.ApplyBatch(ctx, cli, b); err != nil {
			t.Fatal(err)
		}
		_, err = module.Open(ctx, web, native.SessionID, sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files", Snapshot: nativeView.Snapshot})
		var stale *canonical.RefreshRequiredError
		if !errors.As(err, &stale) {
			t.Fatalf("file-only native edit retained token: %v", err)
		}
		b.Events[0].ToolUpdateJSON = strings.ReplaceAll(b.Events[0].ToolUpdateJSON, "src/changed.go", "src/a.go")
		b.Session.SourceSessionID = "file-publication"
		a := stage(b, publication.StableToolTargetProfile, "")
		if _, err := writer.Validate(ctx, cli, a.ID); err != nil {
			t.Fatal(err)
		}
		active, err := writer.Activate(ctx, cli, a.ID)
		if err != nil {
			t.Fatal(err)
		}
		view := assertFiles(a.SessionID, active.Head)
		b.Events[0].Revision++
		b.Events[0].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"one","title":"Read first display","_meta":{"atape.dev/tool-identity":{"type":"tool","name":"Read"},"atape.dev/file-activity":null}}`
		replacement := stage(b, publication.StableToolTargetProfile, active.Head)
		if _, err := writer.Validate(ctx, cli, replacement.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Activate(ctx, cli, replacement.ID); err != nil {
			t.Fatal(err)
		}
		_, err = module.Open(ctx, web, a.SessionID, sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files", Snapshot: view.Snapshot})
		if !errors.As(err, &stale) {
			t.Fatalf("file head replacement retained token: %v", err)
		}
		fresh, err := module.Open(ctx, web, a.SessionID, sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files"})
		if err != nil || fresh.FileActivity.CallsWithActivity != 1 || fresh.FileActivity.CallsWithoutActivity != 2 || fresh.FileActivity.ReadCalls != 1 || fresh.FileActivity.EditCalls != 0 || fresh.FileActivity.SearchCalls != 0 || fresh.FileActivity.UniquePaths != 1 || len(fresh.Evidence.Items) != 1 {
			t.Fatalf("file clear did not replace old fact: %+v %v", fresh, err)
		}
		b.Session.SourceSessionID = "file-reject-v4"
		b.CanonicalProfileVersion = ingestion.ToolIdentityCanonicalProfileVersion
		// Identity is null so the only v5 fact is the file namespace itself.
		b.Events[0].ToolUpdateJSON = strings.Replace(b.Events[0].ToolUpdateJSON, `{"type":"tool","name":"Read"}`, `null`, 1)
		old := stage(b, publication.ToolIdentityTargetProfile, "")
		if _, err := writer.Validate(ctx, cli, old.ID); err == nil {
			t.Fatal("v4 publication admitted file namespace")
		}
	})
	// V5 ordinary identities travel through the same admitted publication and
	// authorized snapshot Interfaces; display commands never select the group.
	t.Run("stable tool v5", func(t *testing.T) {
		b := batch("stable-tool-publication")
		b.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
		b.Events[0].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"one","title":"ls source-private","kind":"execute","_meta":{"atape.dev/tool-identity":{"type":"tool","name":"exec_command"}},"rawInput":{"private":"source-only"}}`
		b.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"one","title":"final first command","status":"completed"}`
		b.Events[2].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"two","title":"cat source-private","kind":"execute","_meta":{"atape.dev/tool-identity":{"type":"tool","name":"exec_command"}}}`
		unknown := b.Events[0]
		unknown.SourceEventID, unknown.SourceOrder = "legacy-one", 4
		unknown.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"legacy-one","title":"unknown first command","kind":"execute"}`
		other := unknown
		other.SourceEventID, other.SourceOrder = "legacy-two", 5
		other.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"legacy-two","title":"unknown second command","kind":"execute"}`
		b.Events = append(b.Events, unknown, other)
		b.Session.ReportedEventCount = len(b.Events)
		a := stage(b, publication.StableToolTargetProfile, "")
		if _, e := writer.Validate(ctx, cli, a.ID); e != nil {
			t.Fatal(e)
		}
		active, e := writer.Activate(ctx, cli, a.ID)
		if e != nil {
			t.Fatal(e)
		}
		module := sessionanalytics.New(reader)
		q := sessionanalytics.Query{AnalyticsVersion: 4, Limit: 1}
		view, e := module.Open(ctx, web, a.SessionID, q)
		if e != nil || view.Head != active.Head || len(view.Tools) != 2 || view.Tools[0].Identity == nil || view.Tools[0].Name != "exec_command" || view.Tools[0].Completed != 1 || view.Tools[0].Unknown != 1 || *view.Summary.IdentifiedToolCalls != 2 || *view.Summary.UnidentifiedToolCalls != 2 || view.Capabilities.UnclassifiedCalls != 4 || view.Activity.RecordedTimeEvents != 1 || view.Activity.UnknownTimeEvents != 4 {
			t.Fatalf("stable publication facts: %+v %v", view, e)
		}
		wire, _ := json.Marshal(view)
		if strings.Contains(string(wire), "source-only") || strings.Contains(string(wire), "rawInput") {
			t.Fatal("stable analytics exposed payload")
		}
		q.Tool, q.Snapshot = view.Tools[0].Key, view.Snapshot
		page, e := module.Open(ctx, web, a.SessionID, q)
		if e != nil || page.Evidence.NextCursor == "" || len(page.Evidence.Items) != 1 || page.Evidence.Items[0].Label != "final first command" {
			t.Fatalf("stable page: %+v %v", page, e)
		}
		q.Cursor = page.Evidence.NextCursor
		last, e := module.Open(ctx, web, a.SessionID, q)
		if e != nil || len(last.Evidence.Items) != 1 || last.Evidence.Items[0].EventID == page.Evidence.Items[0].EventID || last.Evidence.Items[0].Label != "cat source-private" {
			t.Fatalf("stable continuation: %+v %v", last, e)
		}
		item := page.Evidence.Items[0]
		original, ok, e := reader.ConversationPage(ctx, web, a.SessionID, item.ThreadID, canonical.ConversationPageRequest{Limit: 1, Snapshot: view.Snapshot, AtEventID: item.EventID})
		if e != nil || !ok || len(original.Events) != 1 || original.Events[0].ID != item.EventID || original.Events[0].ToolLabel != item.Label {
			t.Fatalf("stable conditional source: %v %v", ok, e)
		}
		unidentified, e := module.Open(ctx, web, a.SessionID, sessionanalytics.Query{AnalyticsVersion: 4, Tool: view.Tools[1].Key, Snapshot: view.Snapshot})
		if e != nil || len(unidentified.Evidence.Items) != 2 || unidentified.Evidence.Items[0].Label != "unknown first command" || unidentified.Evidence.Items[1].Label != "unknown second command" {
			t.Fatalf("unknown PostgreSQL group lost original titles: %+v %v", unidentified.Evidence, e)
		}
		b.Events[2].Revision++
		b.Events[2].ToolUpdateJSON = strings.Replace(b.Events[2].ToolUpdateJSON, `{"type":"tool","name":"exec_command"}`, `null`, 1)
		replacement := stage(b, publication.StableToolTargetProfile, active.Head)
		if _, e = writer.Validate(ctx, cli, replacement.ID); e != nil {
			t.Fatal(e)
		}
		if _, e = writer.Activate(ctx, cli, replacement.ID); e != nil {
			t.Fatal(e)
		}
		_, e = module.Open(ctx, web, a.SessionID, q)
		var stale *canonical.RefreshRequiredError
		if !errors.As(e, &stale) {
			t.Fatalf("stable cursor survived head replacement: %v", e)
		}
		_, _, e = reader.ConversationPage(ctx, web, a.SessionID, item.ThreadID, canonical.ConversationPageRequest{Limit: 1, Snapshot: view.Snapshot, AtEventID: item.EventID})
		if !errors.As(e, &stale) {
			t.Fatalf("stable Reader survived head replacement: %v", e)
		}
		fresh, e := module.Open(ctx, web, a.SessionID, sessionanalytics.Query{AnalyticsVersion: 4})
		if e != nil || len(fresh.Tools) != 2 || *fresh.Summary.IdentifiedToolCalls != 1 || *fresh.Summary.UnidentifiedToolCalls != 3 {
			t.Fatalf("null identity did not clear: %+v %v", fresh, e)
		}
		outsider := web
		outsider.UserID = "01991b70-4d2b-7c96-a532-5818faba2e72"
		_, e = module.Open(ctx, outsider, a.SessionID, sessionanalytics.Query{AnalyticsVersion: 4, Snapshot: fresh.Snapshot})
		var hidden *sessionanalytics.NotFoundError
		if !errors.As(e, &hidden) {
			t.Fatalf("stable token granted access: %v", e)
		}
	})
	b := batch("identity-publication")
	a := stage(b, publication.ToolIdentityTargetProfile, "")
	if _, e = writer.Validate(ctx, cli, a.ID); e != nil {
		t.Fatal(e)
	}
	if _, visible, e := reader.SessionAnalytics(ctx, web, a.SessionID, ""); e != nil || visible {
		t.Fatalf("pending identity visible: %v %v", visible, e)
	}
	activated, e := writer.Activate(ctx, cli, a.ID)
	if e != nil {
		t.Fatal(e)
	}
	view := assertView(a.SessionID, activated.Head)
	b.Events[0].Revision++
	b.Events[0].ToolUpdateJSON = strings.Replace(b.Events[0].ToolUpdateJSON, `"name":"read"`, `"name":"read_page"`, 1)
	b.Events[2].Revision++
	b.Events[2].ToolUpdateJSON = strings.Replace(b.Events[2].ToolUpdateJSON, `{"type":"skill","name":"review"}`, `null`, 1)
	replacement := stage(b, publication.ToolIdentityTargetProfile, activated.Head)
	if _, e = writer.Validate(ctx, cli, replacement.ID); e != nil {
		t.Fatal(e)
	}
	before, e := sessionanalytics.New(reader).Open(ctx, web, a.SessionID, sessionanalytics.Query{Snapshot: view.Snapshot})
	if e != nil || before.Capabilities.MCP[0].Name != "read" || before.Capabilities.SkillCalls != 1 {
		t.Fatalf("candidate invalidated or leaked active identity: %+v %v", before, e)
	}
	if _, e = writer.Activate(ctx, cli, replacement.ID); e != nil {
		t.Fatal(e)
	}
	_, e = sessionanalytics.New(reader).Open(ctx, web, a.SessionID, sessionanalytics.Query{Snapshot: view.Snapshot, Metric: "mcp_tools"})
	var refresh *canonical.RefreshRequiredError
	if !errors.As(e, &refresh) {
		t.Fatalf("identity replacement kept evidence current: %v", e)
	}
	_, _, e = reader.ConversationPage(ctx, web, a.SessionID, "root", canonical.ConversationPageRequest{Limit: 1, Snapshot: view.Snapshot})
	if !errors.As(e, &refresh) {
		t.Fatalf("identity replacement kept Reader current: %v", e)
	}
	updated, e := sessionanalytics.New(reader).Open(ctx, web, a.SessionID, sessionanalytics.Query{})
	if e != nil || updated.Capabilities.MCP[0].Name != "read_page" || updated.Capabilities.SkillCalls != 0 || updated.Capabilities.UnclassifiedCalls != 1 {
		t.Fatalf("replacement did not select new identity: %+v %v", updated, e)
	}
	outsider := web
	outsider.UserID = "01991b70-4d2b-7c96-a532-5818faba2e72"
	if _, visible, e := reader.SessionAnalytics(ctx, outsider, a.SessionID, updated.Snapshot); e != nil || visible {
		t.Fatalf("identity token granted access: %v %v", visible, e)
	}
	if e := reader.DeleteSession(ctx, web, a.SessionID, ""); e != nil {
		t.Fatal(e)
	}
	if _, visible, e := reader.SessionAnalytics(ctx, web, a.SessionID, updated.Snapshot); e != nil || visible {
		t.Fatalf("deleted identity visible: %v %v", visible, e)
	}
	for _, tc := range []struct{ source, canonical, target string }{
		{"target3-canonical4", ingestion.ToolIdentityCanonicalProfileVersion, publication.UnknownTimeTargetProfile},
		{"target4-canonical3", ingestion.UnknownTimeCanonicalProfileVersion, publication.ToolIdentityTargetProfile},
		{"old-profile-meta", ingestion.UnknownTimeCanonicalProfileVersion, publication.UnknownTimeTargetProfile},
		{"target4-canonical5", ingestion.StableToolCanonicalProfileVersion, publication.ToolIdentityTargetProfile},
		{"target5-canonical4", ingestion.ToolIdentityCanonicalProfileVersion, publication.StableToolTargetProfile},
	} {
		b := batch(tc.source)
		b.CanonicalProfileVersion = tc.canonical
		a := stage(b, tc.target, "")
		_, e := writer.Validate(ctx, cli, a.ID)
		var invalid *publication.Error
		if !errors.As(e, &invalid) || invalid.Code != "invalid" {
			t.Fatalf("invalid profile pair or legacy meta accepted: %+v %v", tc, e)
		}
	}
}
