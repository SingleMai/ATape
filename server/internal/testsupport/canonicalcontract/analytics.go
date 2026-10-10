package canonicalcontract

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/ingestion"
)

func runAnalyticsSnapshot(t *testing.T, store Store) {
	t.Helper()
	ctx := t.Context()
	writer := ingestion.NewIngestor(store)
	batch := ValidBatch()
	batch.Session.SourceSessionID = "analytics-contract"
	count := func(n int64) *int64 { return &n }
	batch.Usage = []ingestion.Usage{{SourceUsageID: "u", SourceThreadID: "provider-root", Revision: 1, OccurredAt: batch.Events[1].OccurredAt, Model: "test-model", InputTokens: count(100), OutputTokens: count(10)}}
	tool := batch.Events[1]
	tool.SourceEventID, tool.SourceOrder = "tool", 3
	tool.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Read","status":"pending","rawInput":{"path":"fixture-input"}}`
	parsed, err := canonical.ParseToolUpdate(tool.ToolUpdateJSON)
	if err != nil {
		t.Fatal(err)
	}
	tool.Kind, tool.Text, tool.ToolLabel = parsed.Summary()
	batch.Events = append(batch.Events, tool)
	created, err := writer.ApplyBatch(ctx, CLIPrincipal(), batch)
	if err != nil {
		t.Fatal(err)
	}
	read := func(expected string) canonical.AnalyticsSnapshot {
		t.Helper()
		facts, ok, err := store.SessionAnalytics(ctx, WebPrincipal(), created.SessionID, expected)
		if err != nil || !ok {
			t.Fatalf("analysis read: visible=%v err=%v", ok, err)
		}
		return facts
	}
	first := read("")
	if first.SnapshotToken == "" || len(first.Events) != 3 || len(first.Usage) != 1 {
		t.Fatalf("unexpected snapshot: %+v", first)
	}
	for _, event := range first.Events {
		if event.Text != "" || strings.Contains(event.ToolUpdateJSON, "rawInput") || strings.Contains(event.ToolUpdateJSON, "fixture-input") {
			t.Fatal("analysis exposed content payload")
		}
	}
	page, ok, err := store.ConversationPage(ctx, WebPrincipal(), created.SessionID, "root", canonical.ConversationPageRequest{Limit: 100, Snapshot: first.SnapshotToken, AtEventID: first.Events[0].ID})
	if err != nil || !ok || page.SnapshotToken != first.SnapshotToken {
		t.Fatalf("conditional Reader: %v %v", ok, err)
	}
	if _, err = writer.ApplyBatch(ctx, CLIPrincipal(), batch); err != nil {
		t.Fatal(err)
	}
	if replay := read(first.SnapshotToken); replay.SnapshotToken != first.SnapshotToken {
		t.Fatal("replay changed snapshot")
	}
	// Returned nullable counters cannot mutate the owning Adapter.
	*first.Usage[0].InputTokens = 999
	if *read("").Usage[0].InputTokens != 100 {
		t.Fatal("analysis aliases stored Usage")
	}
	correction := batch
	correction.BatchID = "analytics-usage-only"
	correction.Events = nil
	correction.Usage = append([]ingestion.Usage(nil), batch.Usage...)
	correction.Usage[0].Revision = 2
	correction.Usage[0].OutputTokens = count(11)
	if _, err = writer.ApplyBatch(ctx, CLIPrincipal(), correction); err != nil {
		t.Fatal(err)
	}
	second := read("")
	if second.SnapshotToken == first.SnapshotToken {
		t.Fatal("usage-only update kept snapshot")
	}
	assertRefresh := func(err error) {
		t.Helper()
		var changed *canonical.RefreshRequiredError
		if !errors.As(err, &changed) {
			t.Fatalf("expected refresh_required, got %v", err)
		}
	}
	_, _, err = store.SessionAnalytics(ctx, WebPrincipal(), created.SessionID, first.SnapshotToken)
	assertRefresh(err)
	_, _, err = store.ConversationPage(ctx, WebPrincipal(), created.SessionID, "root", canonical.ConversationPageRequest{Limit: 100, Snapshot: first.SnapshotToken})
	assertRefresh(err)
	correction.BatchID = "analytics-thread-only"
	correction.Usage = nil
	correction.Threads = append([]ingestion.Thread(nil), batch.Threads...)
	correction.Threads[0].Revision = 2
	correction.Threads[0].Label = "Renamed root"
	if _, err = writer.ApplyBatch(ctx, CLIPrincipal(), correction); err != nil {
		t.Fatal(err)
	}
	third := read("")
	if third.SnapshotToken == second.SnapshotToken {
		t.Fatal("thread-only update kept snapshot")
	}
	correction.BatchID = "analytics-same-count-rewrite"
	correction.Events = append([]ingestion.Event(nil), batch.Events[:1]...)
	correction.Events[0].Revision = 2
	correction.Events[0].Text = "An amended prompt"
	if _, err = writer.ApplyBatch(ctx, CLIPrincipal(), correction); err != nil {
		t.Fatal(err)
	}
	fourth := read("")
	if fourth.SnapshotToken == third.SnapshotToken || len(fourth.Events) != len(third.Events) {
		t.Fatal("same-count rewrite identity is wrong")
	}
	outsider := WebPrincipal()
	outsider.UserID = "01991b70-4d2b-7c96-a532-5818faba2e72"
	if _, visible, err := store.SessionAnalytics(ctx, outsider, created.SessionID, fourth.SnapshotToken); err != nil || visible {
		t.Fatalf("token bypassed authorization: %v %v", visible, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := store.SessionAnalytics(cancelled, WebPrincipal(), created.SessionID, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled read: %v", err)
	}
	if err := store.DeleteSession(ctx, WebPrincipal(), created.SessionID, ""); err != nil {
		t.Fatal(err)
	}
	if _, visible, err := store.SessionAnalytics(ctx, WebPrincipal(), created.SessionID, fourth.SnapshotToken); err != nil || visible {
		t.Fatalf("deleted analysis visible: %v %v", visible, err)
	}
}
