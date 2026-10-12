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
