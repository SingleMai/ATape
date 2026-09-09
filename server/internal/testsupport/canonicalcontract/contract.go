// Package canonicalcontract verifies the observable guarantees shared by every
// Canonical persistence Adapter.
package canonicalcontract

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/teamoverview"
	"github.com/SingleMai/ATape/server/internal/workspace"
)

type Store interface {
	teamoverview.Store
	ingestion.BatchStore
	conversation.SnapshotStore
	workspace.DirectoryStore
	LeaseProjectionChanges(context.Context, string, int, time.Time) ([]canonical.ProjectionChange, error)
	AckProjectionChanges(context.Context, string, []int64) error
}

type Factory func(*testing.T) Store

const (
	TestUserID    = "01991b70-4d2b-7c96-a532-5818faba2e71"
	TestTeamID    = "acme-engineering"
	TestProjectID = "payments-api"
)

func CLIPrincipal() authentication.Principal {
	return authentication.Principal{UserID: TestUserID, Method: authentication.CLIAuthentication}
}

func WebPrincipal() authentication.Principal {
	return authentication.Principal{UserID: TestUserID, Method: authentication.WebAuthentication}
}

func MemoryControlPlane() canonical.MemoryControlPlane {
	return canonical.MemoryControlPlane{
		Teams: []canonical.TeamRecord{{ID: TestTeamID, Name: "Acme Engineering"}},
		Projects: []canonical.ProjectRecord{{
			ID: TestProjectID, TeamID: TestTeamID, Name: TestProjectID, Type: "git", State: "active",
		}},
		Memberships: []authorization.MembershipFacts{{
			TeamID: TestTeamID, UserID: TestUserID, Role: authorization.OwnerRole, Active: true,
		}},
	}
}

func Run(t *testing.T, factory Factory) {
	t.Helper()
	t.Run("Team overview usage, replay, model filtering, child ownership and deletion", func(t *testing.T) {
		store := factory(t)
		writer := ingestion.NewIngestor(store)
		dashboard := teamoverview.New(store)
		batch := ValidBatch()
		root := "provider-root"
		batch.Threads = append(batch.Threads, ingestion.Thread{SourceThreadID: "child", ParentSourceThreadID: &root, Revision: 1, Label: "Worker", CaptureStatus: "healthy"})
		child := batch.Events[0]
		child.SourceEventID = "delegation"
		child.SourceThreadID = "child"
		child.Text = "Internal delegated prompt"
		batch.Events = append(batch.Events, child)
		count := func(v int64) *int64 { return &v }
		batch.Usage = []ingestion.Usage{
			{SourceUsageID: "response-a", SourceThreadID: root, Revision: 1, OccurredAt: batch.Events[1].OccurredAt, Model: "model-a", InputTokens: count(100), OutputTokens: count(10), CacheReadTokens: count(40), CacheWriteTokens: count(60)},
			{SourceUsageID: "response-b", SourceThreadID: "child", Revision: 1, OccurredAt: batch.Events[1].OccurredAt, Model: "model-b", InputTokens: count(50), OutputTokens: count(5), CacheReadTokens: count(20), CacheWriteTokens: count(0)},
		}
		created, err := writer.ApplyBatch(t.Context(), CLIPrincipal(), batch)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = writer.ApplyBatch(t.Context(), CLIPrincipal(), batch); err != nil {
			t.Fatal(err)
		}
		query := teamoverview.Query{From: "2026-09-04", To: "2026-09-04"}
		view, err := dashboard.Open(t.Context(), WebPrincipal(), TestTeamID, query)
		if err != nil {
			t.Fatal(err)
		}
		if view.Metrics.Sessions != 1 || view.Metrics.Messages != 1 || view.Metrics.ActiveMembers != 1 || view.Metrics.Tokens.Total == nil || *view.Metrics.Tokens.Total != 165 || *view.Metrics.Tokens.CacheRead != 60 || len(view.Sessions) != 1 {
			t.Fatalf("overview: %+v", view)
		}
		if view.Sessions[0].Input != "Which layer should own retries?" || view.Sessions[0].Output != "The retry needs one durable key." {
			t.Fatalf("root preview: %+v", view.Sessions[0])
		}
		query.Model = "model-b"
		filtered, err := dashboard.Open(t.Context(), WebPrincipal(), TestTeamID, query)
		if err != nil || filtered.Metrics.Sessions != 1 || filtered.Metrics.Tokens.Total == nil || *filtered.Metrics.Tokens.Total != 55 {
			t.Fatalf("model filter: %+v %v", filtered, err)
		}
		query.Model = ""
		query.From = "2026-09-05"
		query.To = "2026-09-05"
		historical, err := dashboard.Open(t.Context(), WebPrincipal(), TestTeamID, query)
		if err != nil || historical.Metrics.Sessions != 0 {
			t.Fatalf("historical import must not be current activity: %+v %v", historical, err)
		}
		conflict := batch
		conflict.BatchID = "conflicting-usage"
		conflict.Usage = append([]ingestion.Usage{}, batch.Usage...)
		conflict.Usage[0].OutputTokens = count(99)
		if _, err = writer.ApplyBatch(t.Context(), CLIPrincipal(), conflict); err == nil {
			t.Fatal("accepted conflicting usage revision")
		}
		query.From, query.To = "2026-09-04", "2026-09-04"
		unchanged, err := dashboard.Open(t.Context(), WebPrincipal(), TestTeamID, query)
		if err != nil || unchanged.Metrics.Tokens.Total == nil || *unchanged.Metrics.Tokens.Total != 165 {
			t.Fatalf("conflict changed usage: %+v %v", unchanged, err)
		}
		correction := batch
		correction.BatchID = "usage-correction"
		correction.Usage = append([]ingestion.Usage{}, batch.Usage...)
		correction.Usage[0].Revision = 2
		correction.Usage[0].InputTokens = count(130)
		correction.Usage[1].Revision = 2
		correction.Usage[1].OutputTokens = nil
		correction.Usage[1].Model = ""
		last := batch.Events[1]
		last.SourceEventID = "assistant-final-chunk"
		last.EventIndex = 1
		last.Text = "First sentence. Final response sentence."
		correction.Events = append(append([]ingestion.Event{}, batch.Events...), last)
		if _, err = writer.ApplyBatch(t.Context(), CLIPrincipal(), correction); err != nil {
			t.Fatal(err)
		}
		corrected, err := dashboard.Open(t.Context(), WebPrincipal(), TestTeamID, query)
		if err != nil || corrected.Metrics.Tokens.Total != nil || corrected.Metrics.Tokens.Output != nil || corrected.Metrics.Tokens.Input == nil || *corrected.Metrics.Tokens.Input != 180 || corrected.Metrics.Tokens.Records != 2 || corrected.Sessions[0].Output != "Final response sentence." {
			t.Fatalf("usage correction/unknown/chunk preview: %+v %v", corrected, err)
		}
		query.Model = "__unknown__"
		unknown, err := dashboard.Open(t.Context(), WebPrincipal(), TestTeamID, query)
		if err != nil || unknown.Metrics.Tokens.Input == nil || *unknown.Metrics.Tokens.Input != 50 {
			t.Fatalf("unknown model drilldown: %+v %v", unknown, err)
		}
		query.Model = ""
		if err = store.DeleteSession(t.Context(), WebPrincipal(), created.SessionID, ""); err != nil {
			t.Fatal(err)
		}
		query.From = "2026-09-04"
		query.To = "2026-09-04"
		deleted, err := dashboard.Open(t.Context(), WebPrincipal(), TestTeamID, query)
		if err != nil || deleted.Metrics.Sessions != 0 || deleted.Metrics.Tokens.Total != nil {
			t.Fatalf("deleted data: %+v %v", deleted, err)
		}
		outsider := WebPrincipal()
		outsider.UserID = "01991b70-4d2b-7c96-a532-5818faba2e79"
		if _, err = dashboard.Open(t.Context(), outsider, TestTeamID, query); err == nil {
			t.Fatal("outsider read overview")
		}
	})
	t.Run("accepts package and wire-profile upgrades only when Event content is unchanged", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		batch := ValidBatch()
		batch.Source.AdapterVersion = "0.2.0"
		batch.CanonicalProfileVersion = ingestion.LegacyCanonicalProfileVersion
		created, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), batch)
		if err != nil {
			t.Fatal(err)
		}
		batch.BatchID = "upgraded-package-same-events"
		batch.Source.AdapterVersion = "0.4.6"
		batch.CanonicalProfileVersion = ingestion.CanonicalProfileVersion
		upgraded, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), batch)
		if err != nil || upgraded.UnchangedEvents != len(batch.Events) || upgraded.InsertedEvents != 0 || upgraded.UpdatedEvents != 0 {
			t.Fatalf("unchanged package upgrade: %+v %v", upgraded, err)
		}
		snapshot, ok, err := store.Conversation(context.Background(), WebPrincipal(), created.SessionID, "root")
		if err != nil || !ok || len(snapshot.Events) != len(batch.Events) {
			t.Fatalf("snapshot: %+v %v", snapshot, err)
		}
		for _, event := range snapshot.Events {
			if event.AdapterVersion != "0.2.0" {
				t.Fatal("replay overwrote original provenance")
			}
		}
		for name, change := range map[string]func(*ingestion.Batch){
			"text":     func(b *ingestion.Batch) { b.Events[0].Text += " changed" },
			"order":    func(b *ingestion.Batch) { b.Events[0].SourceOrder++ },
			"fidelity": func(b *ingestion.Batch) { b.Events[0].Fidelity = "partial" },
		} {
			changed := batch
			changed.Events = append([]ingestion.Event(nil), batch.Events...)
			changed.BatchID = "changed-" + name
			change(&changed)
			_, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), changed)
			var conflict *canonical.ConflictError
			if !errors.As(err, &conflict) {
				t.Fatalf("%s did not conflict: %v", name, err)
			}
		}
	})
	t.Run("reprojects legacy tool Events without duplicating identities or losing JSON values", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		batch := ValidBatch()
		batch.CanonicalProfileVersion = ingestion.LegacyCanonicalProfileVersion
		batch.Events[1].Kind = "tool_result"
		created, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), batch)
		if err != nil {
			t.Fatal(err)
		}
		before, err := conversation.NewMemory(store).OpenConversation(context.Background(), WebPrincipal(), created.SessionID, "root")
		if err != nil {
			t.Fatal(err)
		}
		batch.BatchID = "tool-profile-upgrade"
		batch.CanonicalProfileVersion = ingestion.CanonicalProfileVersion
		for index := range batch.Events {
			batch.Events[index].ProjectionRevision++
		}
		const toolJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"same-call","title":"Read","status":"completed","rawInput":null,"rawOutput":{"fraction":0.125,"tiny":1e-7,"false":false,"zero":0,"empty":"","array":[]}}`
		batch.Events[1].ToolUpdateJSON = toolJSON
		upgraded, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), batch)
		if err != nil || upgraded.UpdatedEvents != 2 || upgraded.InsertedEvents != 0 {
			t.Fatalf("upgrade: %+v %v", upgraded, err)
		}
		after, err := conversation.NewMemory(store).OpenConversation(context.Background(), WebPrincipal(), created.SessionID, "root")
		if err != nil {
			t.Fatal(err)
		}
		if len(after.Events) != 2 || before.Events[1].ID != after.Events[1].ID || after.Events[1].Tool == nil || string(after.Events[1].Tool.RawInput) != "null" {
			t.Fatalf("tool projection lost values/identity: %+v", after.Events)
		}
		snapshot, ok, err := store.Conversation(context.Background(), WebPrincipal(), created.SessionID, "root")
		if err != nil || !ok {
			t.Fatalf("snapshot: %v", err)
		}
		found := false
		for _, event := range snapshot.Events {
			if event.ToolUpdateJSON == toolJSON {
				found = true
			}
		}
		if !found {
			t.Fatal("Canonical persistence changed encoded tool JSON")
		}
		replay, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), batch)
		if err != nil || !replay.Replayed {
			t.Fatalf("replay: %+v %v", replay, err)
		}
	})
	t.Run("deletes a captured Session through the ingestion lifecycle", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		created, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), ValidBatch())
		if err != nil {
			t.Fatalf("apply batch: %v", err)
		}
		if err := ingestor.DeleteSession(context.Background(), WebPrincipal(), created.SessionID, "request-delete-session"); err != nil {
			t.Fatalf("delete captured Session: %v", err)
		}
		if err := ingestor.DeleteSession(context.Background(), WebPrincipal(), created.SessionID, "request-delete-session-repeat"); err != nil {
			t.Fatalf("repeat captured Session deletion: %v", err)
		}

		reader := conversation.NewMemory(store)
		_, err = reader.OpenConversation(context.Background(), WebPrincipal(), created.SessionID, "root")
		var notFound *conversation.NotFoundError
		if !errors.As(err, &notFound) {
			t.Fatalf("deleted Conversation error = %v, want not found", err)
		}
		project, err := reader.OpenProject(context.Background(), WebPrincipal(), TestProjectID)
		if err != nil {
			t.Fatalf("open Project after Session deletion: %v", err)
		}
		if len(project.Trail) != 0 {
			t.Fatalf("deleted Session remained in Project memory: %+v", project.Trail)
		}

		_, err = ingestor.ApplyBatch(context.Background(), CLIPrincipal(), ValidBatch())
		var state *canonical.ProjectStateError
		if !errors.As(err, &state) || state.State != "session_deleted" {
			t.Fatalf("re-ingest error = %v, want session_deleted lifecycle conflict", err)
		}
	})

	t.Run("creates readable Canonical snapshots", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		reader := conversation.NewMemory(store)
		result, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), ValidBatch())
		if err != nil {
			t.Fatalf("apply batch: %v", err)
		}
		if !result.SessionCreated || result.InsertedEvents != 2 || result.Replayed {
			t.Fatalf("unexpected apply result: %+v", result)
		}
		project, err := reader.OpenProject(context.Background(), WebPrincipal(), "payments-api")
		if err != nil {
			t.Fatalf("open project: %v", err)
		}
		if got, want := len(project.Trail), 1; got != want {
			t.Fatalf("project trail length = %d, want %d", got, want)
		}
		opened, err := reader.OpenConversation(context.Background(), WebPrincipal(), result.SessionID, "root")
		if err != nil {
			t.Fatalf("open conversation: %v", err)
		}
		if got, want := len(opened.Events), 2; got != want {
			t.Fatalf("event count = %d, want %d", got, want)
		}
		if got, want := opened.Events[1].Text, "The retry needs one durable key."; got != want {
			t.Fatalf("second event = %q, want %q", got, want)
		}
	})

	t.Run("accepts paged Events without mutating Session memory", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		reader := conversation.NewMemory(store)

		first := ValidBatch()
		first.BatchID = "paged-batch-001"
		first.Session.Summary = ""
		first.Session.Insight = ""
		first.Events = []ingestion.Event{first.Events[0]}
		if _, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), first); err != nil {
			t.Fatalf("apply first page: %v", err)
		}

		second := ValidBatch()
		second.BatchID = "paged-batch-002"
		second.ObservedAt = "2026-09-04T11:00:00+08:00"
		second.Session.Summary = ""
		second.Session.Insight = ""
		second.Events = []ingestion.Event{second.Events[1]}
		result, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), second)
		if err != nil {
			t.Fatalf("apply second page: %v", err)
		}
		if got, want := result.InsertedEvents, 1; got != want {
			t.Fatalf("second-page inserted Events = %d, want %d", got, want)
		}

		opened, err := reader.OpenConversation(context.Background(), WebPrincipal(), result.SessionID, "root")
		if err != nil {
			t.Fatalf("open paged conversation: %v", err)
		}
		if got, want := len(opened.Events), 2; got != want {
			t.Fatalf("paged Event count = %d, want %d", got, want)
		}
		project, err := reader.OpenProject(context.Background(), WebPrincipal(), TestProjectID)
		if err != nil {
			t.Fatalf("open paged Project memory: %v", err)
		}
		if got, want := len(project.Trail), 1; got != want {
			t.Fatalf("paged Project trail length = %d, want %d", got, want)
		}
		if project.Trail[0].Summary != "" || project.Trail[0].Insight != "" {
			t.Fatalf("paged Session derived page-local memory: summary=%q insight=%q",
				project.Trail[0].Summary, project.Trail[0].Insight)
		}
	})

	t.Run("publishes typed Team and Project identity", func(t *testing.T) {
		store := factory(t)
		if _, err := ingestion.NewIngestor(store).ApplyBatch(context.Background(), CLIPrincipal(), ValidBatch()); err != nil {
			t.Fatalf("apply batch: %v", err)
		}
		directory, err := workspace.NewDirectory(store).Open(context.Background(), WebPrincipal())
		if err != nil {
			t.Fatalf("open Workspace: %v", err)
		}
		if len(directory.Teams) != 1 || directory.Teams[0].Name != "Acme Engineering" {
			t.Fatalf("unexpected Teams: %+v", directory.Teams)
		}
		projects := directory.Teams[0].Projects
		if len(projects) != 1 || projects[0].Type != "git" || projects[0].SessionCount != 1 {
			t.Fatalf("unexpected Projects: %+v", projects)
		}
	})

	t.Run("never creates a client-selected Project", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		if _, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), ValidBatch()); err != nil {
			t.Fatalf("apply first batch: %v", err)
		}
		changed := ValidBatch()
		changed.BatchID = "unknown-project"
		changed.ProjectID = "client-invented-project"
		_, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), changed)
		var access *authorization.AccessError
		if !errors.As(err, &access) || access.Decision != authorization.Conceal {
			t.Fatalf("error = %v, want concealed Project", err)
		}
	})

	t.Run("serializes concurrent replay", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		batch := ValidBatch()
		const attempts = 8
		results := make(chan canonical.ApplyResult, attempts)
		errorsFound := make(chan error, attempts)
		var group sync.WaitGroup
		for range attempts {
			group.Add(1)
			go func() {
				defer group.Done()
				result, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), batch)
				if err != nil {
					errorsFound <- err
					return
				}
				results <- result
			}()
		}
		group.Wait()
		close(results)
		close(errorsFound)
		for err := range errorsFound {
			t.Errorf("concurrent apply: %v", err)
		}
		firstApplications := 0
		for result := range results {
			if !result.Replayed {
				firstApplications++
			}
		}
		if got, want := firstApplications, 1; got != want {
			t.Fatalf("first applications = %d, want %d", got, want)
		}
	})

	t.Run("updates one active Event record", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		reader := conversation.NewMemory(store)
		first, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), ValidBatch())
		if err != nil {
			t.Fatalf("apply first batch: %v", err)
		}
		updatedBatch := UpdatedBatch()
		updated, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), updatedBatch)
		if err != nil {
			t.Fatalf("apply updated batch: %v", err)
		}
		if updated.SessionID != first.SessionID || updated.UpdatedEvents != 1 || updated.InsertedEvents != 0 {
			t.Fatalf("unexpected update result: %+v", updated)
		}
		opened, err := reader.OpenConversation(context.Background(), WebPrincipal(), first.SessionID, "root")
		if err != nil {
			t.Fatalf("open updated conversation: %v", err)
		}
		if got, want := len(opened.Events), 2; got != want {
			t.Fatalf("active event count = %d, want %d", got, want)
		}
		if got, want := opened.Events[1].Text, updatedBatch.Events[0].Text; got != want {
			t.Fatalf("updated event = %q, want %q", got, want)
		}
	})

	t.Run("reprojects unchanged Events when the Session title changes", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		if _, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), ValidBatch()); err != nil {
			t.Fatalf("apply first batch: %v", err)
		}
		initial, err := store.LeaseProjectionChanges(
			context.Background(), "initial-title", 100, time.Now().UTC().Add(time.Minute),
		)
		if err != nil {
			t.Fatalf("lease initial projections: %v", err)
		}
		initialIDs := make([]int64, 0, len(initial))
		for _, change := range initial {
			initialIDs = append(initialIDs, change.ID)
		}
		if err := store.AckProjectionChanges(context.Background(), "initial-title", initialIDs); err != nil {
			t.Fatalf("ack initial projections: %v", err)
		}

		renamed := ValidBatch()
		renamed.BatchID = "batch-title-renamed"
		renamed.Session.Revision = 2
		renamed.Session.Title = "Checkout accessibility review"
		result, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), renamed)
		if err != nil {
			t.Fatalf("apply renamed Session: %v", err)
		}
		if result.UpdatedEvents != 0 || result.UnchangedEvents != len(renamed.Events) {
			t.Fatalf("title-only update changed Events: %+v", result)
		}

		changes, err := store.LeaseProjectionChanges(
			context.Background(), "renamed-title", 100, time.Now().UTC().Add(time.Minute),
		)
		if err != nil {
			t.Fatalf("lease renamed projections: %v", err)
		}
		if got, want := len(changes), len(renamed.Events); got != want {
			t.Fatalf("renamed projection changes = %d, want %d", got, want)
		}
		for _, change := range changes {
			if got, want := change.Document.SessionTitle, renamed.Session.Title; got != want {
				t.Fatalf("projected Session title = %q, want %q", got, want)
			}
		}
	})

	t.Run("replaces an active projection without duplication", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		reader := conversation.NewMemory(store)
		first, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), ValidBatch())
		if err != nil {
			t.Fatalf("apply first batch: %v", err)
		}
		reprojected := ValidBatch()
		reprojected.BatchID = "batch-reprojected"
		reprojected.Session.Revision = 2
		reprojected.Threads[0].Revision = 2
		reprojected.Events = []ingestion.Event{reprojected.Events[1]}
		reprojected.Events[0].ProjectionRevision = 2
		reprojected.Events[0].Text = "Reprojected with the corrected Adapter mapping."
		result, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), reprojected)
		if err != nil {
			t.Fatalf("apply reprojected batch: %v", err)
		}
		if result.UpdatedEvents != 1 {
			t.Fatalf("updated Events = %d, want 1", result.UpdatedEvents)
		}
		opened, err := reader.OpenConversation(context.Background(), WebPrincipal(), first.SessionID, "root")
		if err != nil {
			t.Fatalf("open reprojected conversation: %v", err)
		}
		if got, want := len(opened.Events), 2; got != want {
			t.Fatalf("active event count = %d, want %d", got, want)
		}
		if got, want := opened.Events[1].Text, reprojected.Events[0].Text; got != want {
			t.Fatalf("active projection = %q, want %q", got, want)
		}
	})

	t.Run("orders Events by source position", func(t *testing.T) {
		store := factory(t)
		batch := ValidBatch()
		batch.Events[0].OccurredAt = "2026-09-04T11:05:00+08:00"
		batch.Events[1].OccurredAt = "2026-09-04T10:55:00+08:00"
		result, err := ingestion.NewIngestor(store).ApplyBatch(context.Background(), CLIPrincipal(), batch)
		if err != nil {
			t.Fatalf("apply batch: %v", err)
		}
		opened, err := conversation.NewMemory(store).OpenConversation(context.Background(), WebPrincipal(), result.SessionID, "root")
		if err != nil {
			t.Fatalf("open conversation: %v", err)
		}
		if got, want := opened.Events[0].Text, batch.Events[0].Text; got != want {
			t.Fatalf("first Event = %q, want source-ordered %q", got, want)
		}
	})

	t.Run("reconstructs a child Thread submitted before its parent", func(t *testing.T) {
		store := factory(t)
		batch := ValidBatch()
		parentSourceID := "provider-root"
		childSourceID := "schema-review"
		batch.Threads = []ingestion.Thread{
			{SourceThreadID: childSourceID, ParentSourceThreadID: &parentSourceID, Revision: 1, Label: "Schema review", CaptureStatus: "partial"},
			batch.Threads[0],
		}
		childRef := childSourceID
		batch.Events = append(batch.Events,
			ingestion.Event{SourceEventID: "spawn-1", SourceThreadID: parentSourceID, Revision: 1, ProjectionRevision: 1, SourceOrder: 3, EventIndex: 0, OrderFidelity: "native", Fidelity: "native", RawRef: objectRef("session-42", "#spawn-1"), Kind: "spawn", Author: "Codex", OccurredAt: "2026-09-04T10:59:20+08:00", Text: "Delegated schema review.", ChildSourceThreadID: &childRef},
			ingestion.Event{SourceEventID: "child-1", SourceThreadID: childSourceID, Revision: 1, ProjectionRevision: 1, SourceOrder: 1, EventIndex: 0, OrderFidelity: "native", Fidelity: "partial", RawRef: objectRef("session-42", "#child-1"), Kind: "message", Author: "schema-review", OccurredAt: "2026-09-04T10:59:21+08:00", Text: "The uniqueness boundary is safe."},
		)
		batch.Session.ReportedEventCount = len(batch.Events)
		result, err := ingestion.NewIngestor(store).ApplyBatch(context.Background(), CLIPrincipal(), batch)
		if err != nil {
			t.Fatalf("apply parent and child Threads: %v", err)
		}
		reader := conversation.NewMemory(store)
		root, err := reader.OpenConversation(context.Background(), WebPrincipal(), result.SessionID, "root")
		if err != nil {
			t.Fatalf("open root Thread: %v", err)
		}
		var childID string
		for _, event := range root.Events {
			if event.ChildThread != nil {
				childID = event.ChildThread.ID
				if got, want := event.ChildThread.EventCount, 1; got != want {
					t.Fatalf("child Event count = %d, want %d", got, want)
				}
			}
		}
		if childID == "" {
			t.Fatal("root conversation has no child Thread reference")
		}
		child, err := reader.OpenConversation(context.Background(), WebPrincipal(), result.SessionID, childID)
		if err != nil {
			t.Fatalf("open child Thread: %v", err)
		}
		if got, want := len(child.ThreadPath), 2; got != want {
			t.Fatalf("child Thread path length = %d, want %d", got, want)
		}
		if got, want := len(child.Events), 1; got != want {
			t.Fatalf("child Event count = %d, want %d", got, want)
		}
	})

	t.Run("rolls back the complete batch on conflict", func(t *testing.T) {
		store := factory(t)
		ingestor := ingestion.NewIngestor(store)
		reader := conversation.NewMemory(store)
		first, err := ingestor.ApplyBatch(context.Background(), CLIPrincipal(), ValidBatch())
		if err != nil {
			t.Fatalf("apply first batch: %v", err)
		}
		conflicting := ValidBatch()
		conflicting.BatchID = "batch-conflict"
		conflicting.Session.Revision = 2
		conflicting.Session.Title = "This session mutation must roll back"
		conflicting.Events[0].Text = "Different content at the same Event revision."
		_, err = ingestor.ApplyBatch(context.Background(), CLIPrincipal(), conflicting)
		var conflict *canonical.ConflictError
		if !errors.As(err, &conflict) {
			t.Fatalf("error = %v, want *canonical.ConflictError", err)
		}
		opened, err := reader.OpenConversation(context.Background(), WebPrincipal(), first.SessionID, "root")
		if err != nil {
			t.Fatalf("open conversation after conflict: %v", err)
		}
		if got, want := opened.Session.Title, ValidBatch().Session.Title; got != want {
			t.Fatalf("session title after rollback = %q, want %q", got, want)
		}
	})

	t.Run("honors canceled operations", func(t *testing.T) {
		store := factory(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := ingestion.NewIngestor(store).ApplyBatch(ctx, CLIPrincipal(), ValidBatch()); !errors.Is(err, context.Canceled) {
			t.Fatalf("ingestion error = %v, want context.Canceled", err)
		}
		if _, err := conversation.NewMemory(store).OpenProject(ctx, WebPrincipal(), "payments-api"); !errors.Is(err, context.Canceled) {
			t.Fatalf("reader error = %v, want context.Canceled", err)
		}
		if _, err := workspace.NewDirectory(store).Open(ctx, WebPrincipal()); !errors.Is(err, context.Canceled) {
			t.Fatalf("Workspace error = %v, want context.Canceled", err)
		}
	})
}

func ValidBatch() ingestion.Batch {
	return ingestion.Batch{
		ProtocolVersion: ingestion.ProtocolVersion, CanonicalProfileVersion: ingestion.CanonicalProfileVersion,
		BatchID: "batch-001", ObservedAt: "2026-09-04T10:59:30+08:00",
		Source: ingestion.Source{
			AdapterID: "atape-adapter-codex", AdapterVersion: "0.1.0", InstallationID: "liying-macbook",
		},
		ProjectID: TestProjectID,
		Session: ingestion.Session{
			SourceSessionID: "provider-session-42", Revision: 1, Title: "Investigate retry ownership",
			Summary: "Which layer should own retries?", Insight: "The retry needs one durable key.",
			Actor: ingestion.Actor{Name: "Liying", Harness: "Codex CLI"}, Branch: "main", Status: "active",
			CaptureStatus: "healthy", UpdatedAt: "2026-09-04T10:59:12+08:00", ReportedEventCount: 2,
		},
		Threads: []ingestion.Thread{{SourceThreadID: "provider-root", Revision: 1, Label: "Root thread", CaptureStatus: "healthy"}},
		Events: []ingestion.Event{
			{SourceEventID: "user-1", SourceThreadID: "provider-root", Revision: 1, ProjectionRevision: 1, SourceOrder: 1, EventIndex: 0, OrderFidelity: "native", Fidelity: "native", RawRef: objectRef("session-42", "#user-1"), Kind: "message", Author: "Liying", OccurredAt: "2026-09-04T10:58:02+08:00", Text: "Which layer should own retries?"},
			{SourceEventID: "assistant-1", SourceThreadID: "provider-root", Revision: 1, ProjectionRevision: 1, SourceOrder: 2, EventIndex: 0, OrderFidelity: "native", Fidelity: "native", RawRef: objectRef("session-42", "#assistant-1"), Kind: "message", Author: "Codex", OccurredAt: "2026-09-04T10:59:12+08:00", Text: "The retry needs one durable key."},
		},
	}
}

func UpdatedBatch() ingestion.Batch {
	batch := ValidBatch()
	batch.BatchID = "batch-002"
	batch.ObservedAt = "2026-09-04T11:00:10+08:00"
	batch.Source.AdapterVersion = "0.2.0"
	batch.Session.Revision = 2
	batch.Session.UpdatedAt = "2026-09-04T11:00:00+08:00"
	batch.Threads[0].Revision = 2
	batch.Events = []ingestion.Event{{
		SourceEventID: "assistant-1", SourceThreadID: "provider-root", Revision: 2,
		ProjectionRevision: 1, SourceOrder: 2, EventIndex: 0,
		OrderFidelity: "native", Fidelity: "native", RawRef: objectRef("session-42", "#assistant-1-v2"),
		Kind: "message", Author: "Codex", OccurredAt: "2026-09-04T11:00:00+08:00",
		Text: "The retry needs one durable key, persisted before the first provider call.",
	}}
	return batch
}

func objectRef(sourceObjectID, fragment string) ingestion.RawReference {
	return ingestion.RawReference{Type: "object", SourceObjectID: sourceObjectID, Fragment: fragment}
}
