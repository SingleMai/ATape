package ingestion_test

import (
	"context"
	"errors"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
)

func TestApplyBatchCreatesReadableCanonicalConversation(t *testing.T) {
	store := canonical.NewMemoryStore()
	ingestor := ingestion.NewIngestor(store)
	reader := conversation.NewMemory(store)
	batch := validBatch()

	result, err := ingestor.ApplyBatch(context.Background(), batch)
	if err != nil {
		t.Fatalf("apply batch: %v", err)
	}
	if !result.SessionCreated || result.InsertedEvents != 2 || result.Replayed {
		t.Fatalf("unexpected apply result: %+v", result)
	}

	project, err := reader.OpenProject(context.Background(), "payments-api")
	if err != nil {
		t.Fatalf("open project: %v", err)
	}
	if got, want := len(project.Trail), 1; got != want {
		t.Fatalf("project sessions = %d, want %d", got, want)
	}
	if got, want := project.Trail[0].ID, result.SessionID; got != want {
		t.Fatalf("session id = %q, want %q", got, want)
	}

	opened, err := reader.OpenConversation(context.Background(), result.SessionID, "root")
	if err != nil {
		t.Fatalf("open conversation: %v", err)
	}
	if got, want := len(opened.Events), 2; got != want {
		t.Fatalf("events = %d, want %d", got, want)
	}
	if got, want := opened.Events[1].Text, "The retry needs one durable key."; got != want {
		t.Fatalf("second event text = %q, want %q", got, want)
	}
}

func TestApplyBatchReplayHasExactlyOnceEffect(t *testing.T) {
	store := canonical.NewMemoryStore()
	ingestor := ingestion.NewIngestor(store)
	reader := conversation.NewMemory(store)
	batch := validBatch()

	first, err := ingestor.ApplyBatch(context.Background(), batch)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}
	replayed, err := ingestor.ApplyBatch(context.Background(), batch)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replayed.Replayed || replayed.SessionID != first.SessionID {
		t.Fatalf("unexpected replay result: %+v", replayed)
	}

	opened, err := reader.OpenConversation(context.Background(), first.SessionID, "root")
	if err != nil {
		t.Fatalf("open conversation: %v", err)
	}
	if got, want := len(opened.Events), 2; got != want {
		t.Fatalf("events after replay = %d, want %d", got, want)
	}
}

func TestHigherEventRevisionUpdatesOneRecord(t *testing.T) {
	store := canonical.NewMemoryStore()
	ingestor := ingestion.NewIngestor(store)
	reader := conversation.NewMemory(store)
	first := validBatch()
	created, err := ingestor.ApplyBatch(context.Background(), first)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}

	second := validBatch()
	second.BatchID = "batch-002"
	second.ObservedAt = "2026-09-04T11:00:10+08:00"
	second.Source.AdapterVersion = "0.2.0"
	second.Session.Revision = 2
	second.Session.UpdatedAt = "2026-09-04T11:00:00+08:00"
	second.Threads[0].Revision = 2
	second.Events = []ingestion.Event{{
		SourceEventID:      "assistant-1",
		SourceThreadID:     "provider-root",
		Revision:           2,
		ProjectionRevision: 1,
		SourceOrder:        2,
		EventIndex:         0,
		OrderFidelity:      "native",
		Fidelity:           "native",
		RawRef:             "raw://test/session-42#assistant-1",
		Kind:               "message",
		Author:             "Codex",
		OccurredAt:         "2026-09-04T10:59:12+08:00",
		Text:               "The retry needs one durable key, persisted before the first provider call.",
	}}

	updated, err := ingestor.ApplyBatch(context.Background(), second)
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if got, want := updated.UpdatedEvents, 1; got != want {
		t.Fatalf("updated events = %d, want %d", got, want)
	}
	if got, want := updated.SessionID, created.SessionID; got != want {
		t.Fatalf("adapter upgrade changed session id to %q, want %q", got, want)
	}

	opened, err := reader.OpenConversation(context.Background(), created.SessionID, "root")
	if err != nil {
		t.Fatalf("open conversation: %v", err)
	}
	if got, want := len(opened.Events), 2; got != want {
		t.Fatalf("events after append update = %d, want %d", got, want)
	}
	if got, want := opened.Events[1].Text, second.Events[0].Text; got != want {
		t.Fatalf("updated text = %q, want %q", got, want)
	}
}

func TestSameEventRevisionWithDifferentContentConflicts(t *testing.T) {
	store := canonical.NewMemoryStore()
	ingestor := ingestion.NewIngestor(store)
	first := validBatch()
	if _, err := ingestor.ApplyBatch(context.Background(), first); err != nil {
		t.Fatalf("first apply: %v", err)
	}

	conflicting := validBatch()
	conflicting.BatchID = "batch-conflict"
	conflicting.Events[0].Text = "Different content at the same revision."
	_, err := ingestor.ApplyBatch(context.Background(), conflicting)
	var conflict *canonical.ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("error = %v, want *canonical.ConflictError", err)
	}
}

func TestConversationUsesSourceOrderInsteadOfTimestamps(t *testing.T) {
	store := canonical.NewMemoryStore()
	ingestor := ingestion.NewIngestor(store)
	reader := conversation.NewMemory(store)
	batch := validBatch()
	batch.Events[0].OccurredAt = "2026-09-04T11:05:00+08:00"
	batch.Events[1].OccurredAt = "2026-09-04T10:55:00+08:00"

	result, err := ingestor.ApplyBatch(context.Background(), batch)
	if err != nil {
		t.Fatalf("apply batch: %v", err)
	}
	opened, err := reader.OpenConversation(context.Background(), result.SessionID, "root")
	if err != nil {
		t.Fatalf("open conversation: %v", err)
	}
	if got, want := opened.Events[0].Text, batch.Events[0].Text; got != want {
		t.Fatalf("first event = %q, want source-ordered %q", got, want)
	}
}

func TestNewProjectionRevisionReplacesActiveSnapshotWithoutDuplication(t *testing.T) {
	store := canonical.NewMemoryStore()
	ingestor := ingestion.NewIngestor(store)
	reader := conversation.NewMemory(store)
	first := validBatch()
	created, err := ingestor.ApplyBatch(context.Background(), first)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}

	reprojected := validBatch()
	reprojected.BatchID = "batch-reprojected"
	reprojected.Session.Revision = 2
	reprojected.Threads[0].Revision = 2
	reprojected.Events = []ingestion.Event{first.Events[1]}
	reprojected.Events[0].ProjectionRevision = 2
	reprojected.Events[0].Text = "Reprojected with the corrected adapter mapping."
	result, err := ingestor.ApplyBatch(context.Background(), reprojected)
	if err != nil {
		t.Fatalf("apply new projection: %v", err)
	}
	if got, want := result.UpdatedEvents, 1; got != want {
		t.Fatalf("updated events = %d, want %d", got, want)
	}

	opened, err := reader.OpenConversation(context.Background(), created.SessionID, "root")
	if err != nil {
		t.Fatalf("open conversation: %v", err)
	}
	if got, want := len(opened.Events), 2; got != want {
		t.Fatalf("active events = %d, want %d", got, want)
	}
	if got, want := opened.Events[1].Text, reprojected.Events[0].Text; got != want {
		t.Fatalf("active projection text = %q, want %q", got, want)
	}
}

func TestApplyBatchRejectsThreadCycle(t *testing.T) {
	store := canonical.NewMemoryStore()
	ingestor := ingestion.NewIngestor(store)
	batch := validBatch()
	childA := "child-b"
	childB := "child-a"
	batch.Threads = append(batch.Threads,
		ingestion.Thread{SourceThreadID: "child-a", ParentSourceThreadID: &childA, Revision: 1, Label: "child-a", CaptureStatus: "partial"},
		ingestion.Thread{SourceThreadID: "child-b", ParentSourceThreadID: &childB, Revision: 1, Label: "child-b", CaptureStatus: "partial"},
	)

	_, err := ingestor.ApplyBatch(context.Background(), batch)
	var validation *ingestion.ValidationError
	if !errors.As(err, &validation) || validation.Field != "threads" {
		t.Fatalf("error = %v, want thread ValidationError", err)
	}
}

func TestApplyBatchHonorsCancellation(t *testing.T) {
	store := canonical.NewMemoryStore()
	ingestor := ingestion.NewIngestor(store)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := ingestor.ApplyBatch(ctx, validBatch())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func validBatch() ingestion.Batch {
	return ingestion.Batch{
		ProtocolVersion:         ingestion.ProtocolVersion,
		CanonicalProfileVersion: ingestion.CanonicalProfileVersion,
		BatchID:                 "batch-001",
		ObservedAt:              "2026-09-04T10:59:30+08:00",
		Source: ingestion.Source{
			AdapterID:      "atape-adapter-codex",
			AdapterVersion: "0.1.0",
			UserID:         "user-liying",
			InstallationID: "liying-macbook",
		},
		Project: ingestion.Project{ID: "payments-api", TeamID: "acme-engineering", TeamName: "Acme Engineering", Name: "payments-api", Type: "git"},
		Session: ingestion.Session{
			SourceSessionID:    "provider-session-42",
			Revision:           1,
			Title:              "Investigate retry ownership",
			Summary:            "Which layer should own retries?",
			Insight:            "The retry needs one durable key.",
			Actor:              ingestion.Actor{Name: "Liying", Harness: "Codex CLI"},
			Branch:             "main",
			Status:             "active",
			CaptureStatus:      "healthy",
			UpdatedAt:          "2026-09-04T10:59:12+08:00",
			ReportedEventCount: 2,
		},
		Threads: []ingestion.Thread{{
			SourceThreadID: "provider-root",
			Revision:       1,
			Label:          "Root thread",
			CaptureStatus:  "healthy",
		}},
		Events: []ingestion.Event{
			{
				SourceEventID:      "user-1",
				SourceThreadID:     "provider-root",
				Revision:           1,
				ProjectionRevision: 1,
				SourceOrder:        1,
				EventIndex:         0,
				OrderFidelity:      "native",
				Fidelity:           "native",
				RawRef:             "raw://test/session-42#user-1",
				Kind:               "message",
				Author:             "Liying",
				OccurredAt:         "2026-09-04T10:58:02+08:00",
				Text:               "Which layer should own retries?",
			},
			{
				SourceEventID:      "assistant-1",
				SourceThreadID:     "provider-root",
				Revision:           1,
				ProjectionRevision: 1,
				SourceOrder:        2,
				EventIndex:         0,
				OrderFidelity:      "native",
				Fidelity:           "native",
				RawRef:             "raw://test/session-42#assistant-1",
				Kind:               "message",
				Author:             "Codex",
				OccurredAt:         "2026-09-04T10:59:12+08:00",
				Text:               "The retry needs one durable key.",
			},
		},
	}
}
