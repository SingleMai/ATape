package sessionanalytics_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
)

// This test Adapter supplies the same atomic, authorized snapshot Interface as
// production persistence. Tests exercise only Module.Open, including its query
// and conditional-read behavior; they do not call private derivation helpers.
type snapshotStore struct {
	snapshot  canonical.AnalyticsSnapshot
	err       error
	missing   bool
	calls     int
	principal authentication.Principal
	expected  string
}

func (s *snapshotStore) SessionAnalytics(ctx context.Context, principal authentication.Principal, id, expected string) (canonical.AnalyticsSnapshot, bool, error) {
	s.calls++
	s.principal, s.expected = principal, expected
	if err := ctx.Err(); err != nil {
		return canonical.AnalyticsSnapshot{}, false, err
	}
	if s.err != nil {
		return canonical.AnalyticsSnapshot{}, false, s.err
	}
	if s.missing {
		return canonical.AnalyticsSnapshot{}, false, nil
	}
	return s.snapshot, true, nil
}

func ptr[T any](value T) *T { return &value }

func emptySnapshot() canonical.AnalyticsSnapshot {
	return canonical.AnalyticsSnapshot{
		SnapshotToken: "legacy:v1:fixture",
		Session:       canonical.SessionRecord{ID: "session", Actor: canonical.Actor{Name: "User", Harness: "Claude Code"}, CaptureStatus: "partial"},
		Threads:       []canonical.ThreadRecord{{ID: "root", SessionID: "session", Label: "Root", CaptureStatus: "partial"}},
	}
}

func event(id, thread, kind string, order int64) canonical.EventRecord {
	return canonical.EventRecord{ID: id, SessionID: "session", ThreadID: thread, SourceOrder: order, Kind: kind, Author: "Claude Code"}
}

func toolEvent(id, thread, callID string, order int64, fields map[string]any) canonical.EventRecord {
	update := map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": callID}
	for key, value := range fields {
		update[key] = value
	}
	encoded, err := json.Marshal(update)
	if err != nil {
		panic(err)
	}
	e := event(id, thread, "tool_call", order)
	e.ToolUpdateJSON = string(encoded)
	if update["status"] == "completed" || update["status"] == "failed" {
		e.Kind = "tool_result"
	}
	return e
}

func fullSnapshot() canonical.AnalyticsSnapshot {
	s := emptySnapshot()
	s.Threads = append(s.Threads, canonical.ThreadRecord{ID: "child", SessionID: "session", Label: "Child", ParentThreadID: ptr("root"), CaptureStatus: "complete"})
	u1, u2 := event("u1", "root", "message", 1), event("u2", "root", "message", 1)
	u1.Author, u2.Author, u2.EventIndex = " user ", "User", 1
	u1.OccurredAt = time.Date(2026, 10, 10, 9, 0, 0, 0, time.FixedZone("fixture", 8*60*60))
	a, child := event("answer", "root", "message", 2), event("child-user", "child", "message", 1)
	a.OccurredAt, child.OccurredAt, child.Author = u1.OccurredAt, u1.OccurredAt, "User"
	legacy := event("legacy", "root", "tool_result", 9)
	legacy.ToolLabel, legacy.Text = "Legacy label", "secret conversation and raw payload"
	s.Events = []canonical.EventRecord{
		u1, u2, a, child, event("thought", "root", "thought", 3),
		toolEvent("a-start", "root", "a", 4, map[string]any{"sessionUpdate": "tool_call", "title": "Read", "kind": "read", "status": "pending"}),
		toolEvent("a-end", "root", "a", 5, map[string]any{"status": "completed"}),
		toolEvent("child-a", "child", "a", 2, map[string]any{"sessionUpdate": "tool_call", "title": "Read", "kind": "read", "status": "failed"}),
		toolEvent("b", "root", "b", 6, map[string]any{"sessionUpdate": "tool_call", "title": "Bash", "kind": "execute"}),
		toolEvent("c", "root", "c", 7, map[string]any{"sessionUpdate": "tool_call", "title": "Read", "kind": "read", "status": "pending"}),
		toolEvent("d", "root", "d", 8, map[string]any{"sessionUpdate": "tool_call", "title": "Read", "kind": "read", "status": "in_progress"}),
		legacy,
		toolEvent("clear-start", "root", "clear", 10, map[string]any{"sessionUpdate": "tool_call", "title": "Write", "kind": "edit", "status": "failed"}),
		toolEvent("clear-end", "root", "clear", 11, map[string]any{"title": nil, "kind": nil, "status": nil}),
	}
	s.Usage = []canonical.UsageRecord{
		{SourceKey: "usage-a", SessionID: "session", ThreadID: "root", Model: "model-a", InputTokens: ptr(int64(100)), OutputTokens: ptr(int64(20)), CacheReadTokens: ptr(int64(30)), CacheWriteTokens: ptr(int64(10))},
		{SourceKey: "usage-b", SessionID: "session", ThreadID: "root", Model: "model-a", InputTokens: ptr(int64(50)), CacheWriteTokens: ptr(int64(0))},
		{SourceKey: "usage-c", SessionID: "session", ThreadID: "child", Model: "model-b", InputTokens: ptr(int64(0)), OutputTokens: ptr(int64(0)), CacheReadTokens: ptr(int64(0)), CacheWriteTokens: ptr(int64(0))},
	}
	return s
}

func open(t *testing.T, snapshot canonical.AnalyticsSnapshot, query sessionanalytics.Query) sessionanalytics.Result {
	t.Helper()
	r, err := sessionanalytics.New(&snapshotStore{snapshot: snapshot}).Open(context.Background(), authentication.Principal{UserID: "reader"}, snapshot.Session.ID, query)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestOpenFoldsStructuredCallsWithoutInventingLegacySuccess(t *testing.T) {
	s := fullSnapshot()
	r := open(t, s, sessionanalytics.Query{})
	wantSummary := sessionanalytics.Summary{RootUserInputs: 1, MessageFragments: 4, ThoughtFragments: 1, ToolCalls: 6, ChildThreads: 1, KnownTimeEvents: 3, UnknownTimeEvents: 11, UnlinkedToolEvents: 1}
	if r.Summary != wantSummary {
		t.Fatalf("summary = %+v, want %+v", r.Summary, wantSummary)
	}
	wantTools := []sessionanalytics.Tool{
		{Name: "Read", Kind: "read", Calls: 4, Completed: 1, Failed: 1, Pending: 1, InProgress: 1},
		{Name: "Bash", Kind: "execute", Calls: 1, Unknown: 1},
		{Name: "unknown", Kind: "unknown", Calls: 1, Unknown: 1},
	}
	if !reflect.DeepEqual(r.Tools, wantTools) {
		t.Fatalf("tools = %+v, want %+v", r.Tools, wantTools)
	}
	if len(r.Evidence.Items) != 6 {
		t.Fatalf("evidence = %+v", r.Evidence)
	}
	for _, item := range r.Evidence.Items {
		if item.EventID == "a-start" || item.EventID == "clear-start" || item.EventID == "legacy" {
			t.Fatalf("evidence selected superseded or unlinked update: %+v", item)
		}
	}
	if r.Threads[0].ID != "child" || r.Threads[0].ToolCalls != 1 || r.Threads[1].ID != "root" || r.Threads[1].ToolCalls != 5 {
		t.Fatalf("threads = %+v", r.Threads)
	}
	if r.CaptureStatus != "partial" || r.Snapshot != s.SnapshotToken || r.AnalyticsVersion != 1 {
		t.Fatalf("metadata = %+v", r)
	}
	body, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "secret") || strings.Contains(string(body), "rawInput") || strings.Contains(string(body), "Legacy label") {
		t.Fatalf("analysis leaked source content: %s", body)
	}
}

func TestOpenEvidenceFiltersLeaveWholeSnapshotStatisticsUnchanged(t *testing.T) {
	s := fullSnapshot()
	baseline := open(t, s, sessionanalytics.Query{})
	cases := []struct {
		name  string
		query sessionanalytics.Query
		ids   []string
	}{
		{"failed", sessionanalytics.Query{Metric: "failed_tools"}, []string{"child-a"}},
		{"unknown", sessionanalytics.Query{Metric: "unknown_tools"}, []string{"b", "clear-end"}},
		{"thread and label", sessionanalytics.Query{Thread: "root", Tool: "Read"}, []string{"a-end", "c", "d"}},
		{"user inputs", sessionanalytics.Query{Metric: "user_inputs"}, []string{"u1"}},
		{"thought fragments", sessionanalytics.Query{Metric: "thoughts"}, []string{"thought"}},
		{"child threads", sessionanalytics.Query{Metric: "threads"}, []string{"child-user"}},
		{"empty selection", sessionanalytics.Query{Metric: "user_inputs", Thread: "child"}, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := open(t, s, tc.query)
			ids := []string{}
			for _, item := range r.Evidence.Items {
				ids = append(ids, item.EventID)
			}
			if !reflect.DeepEqual(ids, tc.ids) {
				t.Fatalf("ids = %v, want %v", ids, tc.ids)
			}
			if r.Summary != baseline.Summary || !reflect.DeepEqual(r.Tools, baseline.Tools) || !reflect.DeepEqual(r.Usage, baseline.Usage) || !reflect.DeepEqual(r.Threads, baseline.Threads) {
				t.Fatal("evidence filter changed whole-session statistics")
			}
		})
	}
	inputs := open(t, s, sessionanalytics.Query{Metric: "user_inputs"})
	if at := inputs.Evidence.Items[0].OccurredAt; at == nil || *at != "2026-10-10T01:00:00Z" {
		t.Fatalf("time = %v", at)
	}
	thoughts := open(t, s, sessionanalytics.Query{Metric: "thoughts"})
	if thoughts.Evidence.Items[0].OccurredAt != nil {
		t.Fatal("unknown time was fabricated")
	}
}

func TestOpenTokenClassificationsPreserveMissingAndZero(t *testing.T) {
	r := open(t, fullSnapshot(), sessionanalytics.Query{})
	want := sessionanalytics.Tokens{Input: ptr(int64(150)), CacheWrite: ptr(int64(10)), RecordedSamples: 3, IncompleteSamples: 1}
	if !reflect.DeepEqual(r.Usage.Tokens, want) {
		t.Fatalf("tokens = %+v, want %+v", r.Usage.Tokens, want)
	}
	if r.Usage.Samples != 3 || len(r.Usage.Models) != 2 || r.Usage.Models[0].Samples != 2 {
		t.Fatalf("usage = %+v", r.Usage)
	}
	child := r.Threads[0].Tokens
	if child.Total == nil || *child.Total != 0 || child.RecordedSamples != 1 || child.IncompleteSamples != 0 {
		t.Fatalf("recorded zero = %+v", child)
	}
	s := emptySnapshot()
	s.Usage = fullSnapshot().Usage[:1]
	complete := open(t, s, sessionanalytics.Query{}).Usage.Tokens
	if complete.Total == nil || *complete.Total != 120 {
		t.Fatalf("cache was added to inclusive input: %+v", complete)
	}
	missing := open(t, emptySnapshot(), sessionanalytics.Query{}).Usage.Tokens
	if missing.Total != nil || missing.Input != nil || missing.Output != nil || missing.CacheRead != nil || missing.CacheWrite != nil || missing.RecordedSamples != 0 || missing.IncompleteSamples != 0 {
		t.Fatalf("unrecorded usage = %+v", missing)
	}
	s.Usage = []canonical.UsageRecord{{SessionID: "session", ThreadID: "root", Model: "unrecorded"}}
	missing = open(t, s, sessionanalytics.Query{}).Usage.Tokens
	if missing.Total != nil || missing.RecordedSamples != 0 || missing.IncompleteSamples != 1 {
		t.Fatalf("empty usage sample = %+v", missing)
	}
}

func TestOpenTokenArithmeticNeverExportsUnsafeIntegers(t *testing.T) {
	const safe int64 = 9007199254740991
	s := emptySnapshot()
	s.Usage = []canonical.UsageRecord{{SessionID: "session", ThreadID: "root", InputTokens: ptr(safe), OutputTokens: ptr(int64(1)), CacheReadTokens: ptr(int64(0)), CacheWriteTokens: ptr(int64(0))}}
	r := open(t, s, sessionanalytics.Query{})
	if r.Usage.Tokens.Total != nil || r.Usage.Tokens.Input == nil || *r.Usage.Tokens.Input != safe {
		t.Fatalf("unsafe total = %+v", r.Usage.Tokens)
	}
	s.Usage = append(s.Usage, canonical.UsageRecord{SessionID: "session", ThreadID: "root", InputTokens: ptr(int64(1)), OutputTokens: ptr(int64(1)), CacheReadTokens: ptr(int64(0)), CacheWriteTokens: ptr(int64(0))})
	r = open(t, s, sessionanalytics.Query{})
	if r.Usage.Tokens.Input != nil || r.Usage.Tokens.Total != nil || r.Usage.Tokens.Output == nil || *r.Usage.Tokens.Output != 2 || r.Usage.Tokens.IncompleteSamples != 1 {
		t.Fatalf("unsafe category = %+v", r.Usage.Tokens)
	}
}

func pagedSnapshot(count int) canonical.AnalyticsSnapshot {
	s := emptySnapshot()
	for index := 0; index < count; index++ {
		s.Events = append(s.Events, toolEvent(fmt.Sprintf("event-%03d", index), "root", fmt.Sprint(index), int64(index), map[string]any{"sessionUpdate": "tool_call", "title": "Read", "kind": "read", "status": "completed"}))
	}
	// Stores do not promise slice order. Caller-visible order must be stable.
	for left, right := 0, len(s.Events)-1; left < right; left, right = left+1, right-1 {
		s.Events[left], s.Events[right] = s.Events[right], s.Events[left]
	}
	return s
}

func TestOpenPaginatesStableEvidenceAndBindsCursorToQuery(t *testing.T) {
	s := pagedSnapshot(43)
	before := append([]canonical.EventRecord(nil), s.Events...)
	store := &snapshotStore{snapshot: s}
	module := sessionanalytics.New(store)
	principal := authentication.Principal{UserID: "reader", WebSessionID: "web-session"}
	first, err := module.Open(context.Background(), principal, "session", sessionanalytics.Query{})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Evidence.Items) != 20 || first.Evidence.NextCursor == "" {
		t.Fatalf("first page = %+v", first.Evidence)
	}
	if store.principal != principal || store.expected != "" {
		t.Fatal("principal or conditional identity not forwarded")
	}
	query := sessionanalytics.Query{Snapshot: first.Snapshot, Cursor: first.Evidence.NextCursor}
	second, err := module.Open(context.Background(), principal, "session", query)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Evidence.Items) != 20 || second.Evidence.NextCursor == "" || store.expected != first.Snapshot {
		t.Fatalf("second page = %+v", second.Evidence)
	}
	query.Cursor = second.Evidence.NextCursor
	third, err := module.Open(context.Background(), principal, "session", query)
	if err != nil {
		t.Fatal(err)
	}
	if len(third.Evidence.Items) != 3 || third.Evidence.NextCursor != "" {
		t.Fatalf("last page = %+v", third.Evidence)
	}
	all := append(append(first.Evidence.Items, second.Evidence.Items...), third.Evidence.Items...)
	for index, item := range all {
		if item.EventID != fmt.Sprintf("event-%03d", index) {
			t.Fatalf("evidence[%d] = %+v", index, item)
		}
	}
	if !reflect.DeepEqual(before, s.Events) {
		t.Fatal("Module mutated the Store snapshot")
	}
	for name, mutate := range map[string]func(*sessionanalytics.Query){
		"snapshot": func(q *sessionanalytics.Query) { q.Snapshot = "other" },
		"metric":   func(q *sessionanalytics.Query) { q.Metric = "failed_tools" },
		"thread":   func(q *sessionanalytics.Query) { q.Thread = "root" },
		"tool":     func(q *sessionanalytics.Query) { q.Tool = "Read" },
	} {
		t.Run(name, func(t *testing.T) {
			q := sessionanalytics.Query{Snapshot: first.Snapshot, Cursor: first.Evidence.NextCursor}
			mutate(&q)
			_, err := module.Open(context.Background(), principal, "session", q)
			var bad *sessionanalytics.InvalidQueryError
			if !errors.As(err, &bad) || bad.Field != "cursor" {
				t.Fatalf("cursor rebinding error = %v", err)
			}
		})
	}
	_, err = module.Open(context.Background(), principal, "another-session", sessionanalytics.Query{Snapshot: first.Snapshot, Cursor: first.Evidence.NextCursor})
	var bad *sessionanalytics.InvalidQueryError
	if !errors.As(err, &bad) || bad.Field != "cursor" {
		t.Fatalf("cross-session cursor = %v", err)
	}
	// Page size can change without changing the selected facts or cursor scope.
	query = sessionanalytics.Query{Snapshot: first.Snapshot, Cursor: first.Evidence.NextCursor, Limit: 3}
	short, err := module.Open(context.Background(), principal, "session", query)
	if err != nil || len(short.Evidence.Items) != 3 || short.Evidence.Items[0].EventID != "event-020" {
		t.Fatalf("changed page size = %+v, %v", short.Evidence, err)
	}
}

func TestOpenRejectsInvalidQueriesBeforePersistence(t *testing.T) {
	cases := []struct {
		name, field string
		q           sessionanalytics.Query
	}{
		{"metric", "metric", sessionanalytics.Query{Metric: "cost"}},
		{"negative limit", "limit", sessionanalytics.Query{Limit: -1}},
		{"large limit", "limit", sessionanalytics.Query{Limit: 101}},
		{"snapshot bound", "snapshot", sessionanalytics.Query{Snapshot: strings.Repeat("s", 201)}},
		{"thread bound", "thread", sessionanalytics.Query{Thread: strings.Repeat("t", 501)}},
		{"invalid UTF-8", "tool", sessionanalytics.Query{Tool: string([]byte{0xff})}},
		{"non-tool filter", "tool", sessionanalytics.Query{Metric: "thoughts", Tool: "Read"}},
		{"cursor missing snapshot", "cursor", sessionanalytics.Query{Cursor: "anything"}},
		{"cursor malformed", "cursor", sessionanalytics.Query{Snapshot: "snapshot", Cursor: "!!"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &snapshotStore{snapshot: emptySnapshot()}
			_, err := sessionanalytics.New(store).Open(context.Background(), authentication.Principal{}, "session", tc.q)
			var bad *sessionanalytics.InvalidQueryError
			if !errors.As(err, &bad) || bad.Field != tc.field || store.calls != 0 {
				t.Fatalf("err = %v, persistence calls = %d", err, store.calls)
			}
		})
	}
	for name, q := range map[string]sessionanalytics.Query{"thread": {Thread: "missing"}, "tool": {Tool: "missing"}} {
		t.Run("outside snapshot "+name, func(t *testing.T) {
			_, err := sessionanalytics.New(&snapshotStore{snapshot: emptySnapshot()}).Open(context.Background(), authentication.Principal{}, "session", q)
			var bad *sessionanalytics.InvalidQueryError
			if !errors.As(err, &bad) || bad.Field != name {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestOpenRechecksPersistenceAndDoesNotReturnStaleData(t *testing.T) {
	store := &snapshotStore{snapshot: fullSnapshot()}
	module := sessionanalytics.New(store)
	first, err := module.Open(context.Background(), authentication.Principal{}, "session", sessionanalytics.Query{})
	if err != nil {
		t.Fatal(err)
	}
	store.snapshot.SnapshotToken, store.snapshot.Head = "publication:new", "new"
	result, err := module.Open(context.Background(), authentication.Principal{}, "session", sessionanalytics.Query{Snapshot: first.Snapshot})
	var refresh *canonical.RefreshRequiredError
	if !errors.As(err, &refresh) || refresh.Head != "new" || result.SessionID != "" || store.calls != 2 {
		t.Fatalf("stale result = %+v, %v", result, err)
	}
	denied := errors.New("permission revoked")
	store.err = denied
	result, err = module.Open(context.Background(), authentication.Principal{}, "session", sessionanalytics.Query{})
	if !errors.Is(err, denied) || result.SessionID != "" || store.calls != 3 {
		t.Fatalf("revoked result = %+v, %v", result, err)
	}
	store.err, store.missing = nil, true
	_, err = module.Open(context.Background(), authentication.Principal{}, "session", sessionanalytics.Query{})
	var notFound *sessionanalytics.NotFoundError
	if !errors.As(err, &notFound) || notFound.SessionID != "session" {
		t.Fatalf("missing result = %v", err)
	}
	store.err, store.missing = canonical.ErrAnalyticsCapacity, false
	_, err = module.Open(context.Background(), authentication.Principal{}, "session", sessionanalytics.Query{})
	if !errors.Is(err, sessionanalytics.ErrCapacity) {
		t.Fatalf("persistence capacity = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := store.calls
	_, err = module.Open(ctx, authentication.Principal{}, "session", sessionanalytics.Query{})
	if !errors.Is(err, context.Canceled) || store.calls != calls {
		t.Fatalf("cancel = %v, persistence calls = %d", err, store.calls)
	}
}

func TestOpenBoundsEveryUnpaginatedDimensionAndResponse(t *testing.T) {
	cases := []struct {
		name     string
		snapshot func() canonical.AnalyticsSnapshot
	}{
		{"events", func() canonical.AnalyticsSnapshot {
			s := emptySnapshot()
			s.Events = make([]canonical.EventRecord, sessionanalytics.MaxFacts+1)
			return s
		}},
		{"usage", func() canonical.AnalyticsSnapshot {
			s := emptySnapshot()
			s.Usage = make([]canonical.UsageRecord, sessionanalytics.MaxFacts+1)
			return s
		}},
		{"threads", func() canonical.AnalyticsSnapshot {
			s := emptySnapshot()
			s.Threads = make([]canonical.ThreadRecord, sessionanalytics.MaxThreads+1)
			return s
		}},
		{"tools", func() canonical.AnalyticsSnapshot {
			s := emptySnapshot()
			for i := 0; i <= sessionanalytics.MaxTools; i++ {
				s.Events = append(s.Events, toolEvent(fmt.Sprint(i), "root", fmt.Sprint(i), int64(i), map[string]any{"title": fmt.Sprintf("tool-%d", i)}))
			}
			return s
		}},
		{"models", func() canonical.AnalyticsSnapshot {
			s := emptySnapshot()
			for i := 0; i <= sessionanalytics.MaxModels; i++ {
				s.Usage = append(s.Usage, canonical.UsageRecord{SessionID: "session", ThreadID: "root", Model: fmt.Sprint(i)})
			}
			return s
		}},
		{"metadata row", func() canonical.AnalyticsSnapshot {
			s := emptySnapshot()
			e := event("large", "root", "tool_call", 0)
			e.ToolUpdateJSON = strings.Repeat("x", 8193)
			s.Events = []canonical.EventRecord{e}
			return s
		}},
		{"response", func() canonical.AnalyticsSnapshot {
			s := emptySnapshot()
			s.Threads = nil
			for i := 0; i < sessionanalytics.MaxThreads; i++ {
				s.Threads = append(s.Threads, canonical.ThreadRecord{ID: fmt.Sprint(i), SessionID: "session", Label: strings.Repeat("l", 500)})
			}
			return s
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := sessionanalytics.New(&snapshotStore{snapshot: tc.snapshot()}).Open(context.Background(), authentication.Principal{}, "session", sessionanalytics.Query{})
			if !errors.Is(err, sessionanalytics.ErrCapacity) {
				t.Fatalf("capacity result = %v", err)
			}
		})
	}
}

func TestOpenRejectsCorruptSnapshotInsteadOfProducingPartialStatistics(t *testing.T) {
	for name, modify := range map[string]func(*canonical.AnalyticsSnapshot){
		"session": func(s *canonical.AnalyticsSnapshot) { s.Session.ID = "another-session" },
		"thread":  func(s *canonical.AnalyticsSnapshot) { s.Threads[0].SessionID = "another-session" },
		"event": func(s *canonical.AnalyticsSnapshot) {
			s.Events = []canonical.EventRecord{event("outside", "missing", "message", 0)}
		},
		"usage": func(s *canonical.AnalyticsSnapshot) {
			s.Usage = []canonical.UsageRecord{{SessionID: "session", ThreadID: "missing"}}
		},
		"tool": func(s *canonical.AnalyticsSnapshot) {
			e := event("invalid-tool", "root", "tool_call", 0)
			e.ToolUpdateJSON = `{"toolCallId":"x"}`
			s.Events = []canonical.EventRecord{e}
		},
		"missing identity": func(s *canonical.AnalyticsSnapshot) { s.SnapshotToken = "" },
	} {
		t.Run(name, func(t *testing.T) {
			s := emptySnapshot()
			modify(&s)
			r, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(context.Background(), authentication.Principal{}, "session", sessionanalytics.Query{})
			if err == nil || r.SessionID != "" {
				t.Fatalf("corrupt snapshot = %+v, %v", r, err)
			}
		})
	}
}

func TestOpenEmptySnapshotHasExplicitUnknownsAndEmptyArrays(t *testing.T) {
	s := emptySnapshot()
	s.Head = "publication-head"
	r := open(t, s, sessionanalytics.Query{})
	if r.Head != s.Head || r.Tools == nil || r.Usage.Models == nil || r.Evidence.Items == nil {
		t.Fatalf("empty DTO = %+v", r)
	}
	body, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"tools":[]`) || !strings.Contains(string(body), `"items":[]`) || !strings.Contains(string(body), `"total":null`) {
		t.Fatalf("empty JSON = %s", body)
	}
}

func BenchmarkOpenMaximumFacts(b *testing.B) {
	for _, profile := range []string{"messages", "tool_updates"} {
		b.Run(profile, func(b *testing.B) {
			s := emptySnapshot()
			s.Events = make([]canonical.EventRecord, sessionanalytics.MaxFacts)
			for index := range s.Events {
				if profile == "messages" {
					s.Events[index] = event(fmt.Sprintf("event-%06d", index), "root", "message", int64(index))
					s.Events[index].Author = "User"
				} else {
					fields := map[string]any{"status": "completed"}
					if index%2 == 0 {
						fields = map[string]any{"sessionUpdate": "tool_call", "title": fmt.Sprintf("tool-%d", index/2%100), "kind": "read", "status": "pending"}
					}
					s.Events[index] = toolEvent(fmt.Sprintf("event-%06d", index), "root", fmt.Sprintf("call-%d", index/2), int64(index), fields)
				}
			}
			module := sessionanalytics.New(&snapshotStore{snapshot: s})
			query := sessionanalytics.Query{}
			if profile == "messages" {
				query.Metric = "user_inputs"
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				result, err := module.Open(context.Background(), authentication.Principal{UserID: "reader"}, "session", query)
				if err != nil || len(result.Evidence.Items) != 20 {
					b.Fatalf("analysis = %d evidence, %v", len(result.Evidence.Items), err)
				}
			}
		})
	}
}
