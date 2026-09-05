package conversation

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

func TestMemoryOpensProjectAndProtectsStoredSlices(t *testing.T) {
	memory := NewMemory(canonical.NewDemoStore())
	memory.now = func() time.Time { return mustTestTime(t, "2026-09-04T10:50:00+08:00") }

	project, err := memory.OpenProject(context.Background(), "payments-api")
	if err != nil {
		t.Fatalf("open project: %v", err)
	}
	if got, want := len(project.Active), 2; got != want {
		t.Fatalf("active conversations = %d, want %d", got, want)
	}

	project.Active[0].Title = "mutated by caller"
	again, err := memory.OpenProject(context.Background(), "payments-api")
	if err != nil {
		t.Fatalf("open project again: %v", err)
	}
	if again.Active[0].Title == "mutated by caller" {
		t.Fatal("OpenProject leaked mutable stored state")
	}
}

func TestMemoryAgesOpenSessionsToIdleAndKeepsEndedSessionsEnded(t *testing.T) {
	memory := NewMemory(canonical.NewDemoStore())
	memory.now = func() time.Time { return mustTestTime(t, "2026-09-04T11:00:00+08:00") }

	project, err := memory.OpenProject(context.Background(), "payments-api")
	if err != nil {
		t.Fatalf("open project: %v", err)
	}
	if len(project.Active) != 0 {
		t.Fatalf("stale open sessions must not remain active: %+v", project.Active)
	}
	statuses := make(map[string]string, len(project.Trail))
	for _, session := range project.Trail {
		statuses[session.ID] = session.Status
	}
	if statuses["checkout"] != "idle" || statuses["webhooks"] != "idle" || statuses["ledger"] != "ended" {
		t.Fatalf("unexpected effective statuses: %+v", statuses)
	}

	conversation, err := memory.OpenConversation(context.Background(), "checkout", "root")
	if err != nil {
		t.Fatalf("open conversation: %v", err)
	}
	if conversation.Session.Status != "idle" {
		t.Fatalf("conversation status = %q, want idle", conversation.Session.Status)
	}
}

func TestMemoryReturnsArraysForAnEmptyProject(t *testing.T) {
	memory := NewMemory(canonical.NewDemoStore())

	project, err := memory.OpenProject(context.Background(), "support-notes")
	if err != nil {
		t.Fatalf("open empty project: %v", err)
	}
	if project.Active == nil || project.Trail == nil {
		t.Fatalf("empty project slices must be non-nil: %+v", project)
	}
	if len(project.Active) != 0 || len(project.Trail) != 0 {
		t.Fatalf("empty project contains conversations: %+v", project)
	}
}

func TestMemoryOpensChildThread(t *testing.T) {
	memory := NewMemory(canonical.NewDemoStore())

	conversation, err := memory.OpenConversation(context.Background(), "checkout", "schema-review")
	if err != nil {
		t.Fatalf("open child conversation: %v", err)
	}
	if got, want := conversation.Thread.ID, "schema-review"; got != want {
		t.Fatalf("thread id = %q, want %q", got, want)
	}
	if got, want := len(conversation.ThreadPath), 2; got != want {
		t.Fatalf("thread path length = %d, want %d", got, want)
	}
}

func TestMemoryReturnsTypedNotFound(t *testing.T) {
	memory := NewMemory(canonical.NewDemoStore())

	_, err := memory.OpenConversation(context.Background(), "unknown", "root")
	var notFound *NotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("error = %v, want *NotFoundError", err)
	}
}

func TestMemoryHonorsCancellation(t *testing.T) {
	memory := NewMemory(canonical.NewDemoStore())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := memory.OpenProject(ctx, "payments-api")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func mustTestTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse test time: %v", err)
	}
	return parsed
}
