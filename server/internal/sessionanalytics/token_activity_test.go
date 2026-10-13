package sessionanalytics_test

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
)

func tokenUsage(id, thread, model string, at time.Time, input, output, read, write *int64) canonical.UsageRecord {
	return canonical.UsageRecord{SourceKey: id, SessionID: "session", ThreadID: thread, Model: model, OccurredAt: at,
		InputTokens: input, OutputTokens: output, CacheReadTokens: read, CacheWriteTokens: write}
}

func tokenSnapshot() canonical.AnalyticsSnapshot {
	s := emptySnapshot()
	s.Threads = append(s.Threads, canonical.ThreadRecord{ID: "child", SessionID: "session", Label: "Child", ParentThreadID: ptr("root")})
	at := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	s.Usage = []canonical.UsageRecord{
		tokenUsage("a", "root", "model-a", at, ptr(int64(100)), ptr(int64(20)), ptr(int64(30)), ptr(int64(10))),
		tokenUsage("b", "root", "model-a", at.Add(60*time.Nanosecond), ptr(int64(50)), nil, nil, ptr(int64(0))),
		tokenUsage("c", "child", "model-b", at.Add(30*time.Nanosecond), ptr(int64(200)), ptr(int64(40)), ptr(int64(80)), ptr(int64(20))),
		tokenUsage("untimed", "root", "", time.Time{}, ptr(int64(7)), ptr(int64(3)), ptr(int64(0)), ptr(int64(0))),
	}
	s.Events = []canonical.EventRecord{
		recorded(event("before", "root", "message", 1), at.Add(-time.Nanosecond)),
		recorded(event("root-start", "root", "message", 2), at),
		recorded(event("child-middle", "child", "thought", 1), at.Add(30*time.Nanosecond)),
		recorded(event("root-end", "root", "message", 3), at.Add(60*time.Nanosecond)),
		recorded(event("after", "root", "message", 4), at.Add(61*time.Nanosecond)),
		event("unknown", "root", "message", 5),
	}
	legacy := event("legacy", "root", "message", 6)
	legacy.OccurredAt, legacy.SchemaVersion = at, "atape.acp-centered.v2"
	s.Events = append(s.Events, legacy)
	return s
}

func subtotal(t *testing.T, counter sessionanalytics.TokenCounter, value *int64, reported, missing int, overflowed bool) {
	t.Helper()
	if !reflect.DeepEqual(counter.KnownSubtotal, value) || counter.ReportedSamples != reported || counter.MissingSamples != missing || counter.Overflowed != overflowed {
		t.Fatalf("counter %+v; want subtotal=%v reported=%d missing=%d overflow=%t", counter, value, reported, missing, overflowed)
	}
}

func TestTokenActivityPreservesCompleteTotalsAndReportsKnownCoverage(t *testing.T) {
	s := tokenSnapshot()
	r := open(t, s, sessionanalytics.Query{AnalyticsVersion: 5})
	a := r.TokenActivity
	if a == nil || a.ScopeThreadID != nil || a.ScopeModelKey != nil || a.Samples != 4 || a.TimedSamples != 3 || a.UntimedSamples != 1 {
		t.Fatalf("scope/coverage: %+v", a)
	}
	if r.Usage.Tokens.Total != nil || r.Usage.Tokens.Output != nil || r.Usage.Tokens.CacheRead != nil || *r.Usage.Tokens.Input != 357 {
		t.Fatalf("existing complete-or-null totals changed: %+v", r.Usage.Tokens)
	}
	subtotal(t, a.Tokens.Total, ptr(int64(370)), 3, 1, false)
	subtotal(t, a.Tokens.Input, ptr(int64(357)), 4, 0, false)
	subtotal(t, a.Tokens.Output, ptr(int64(63)), 3, 1, false)
	subtotal(t, a.Tokens.CacheRead, ptr(int64(110)), 3, 1, false)
	subtotal(t, a.UntimedTokens.Total, ptr(int64(10)), 1, 0, false)
	cache := a.Cache
	if cache.EligibleSamples != 3 || cache.MissingSamples != 1 || *cache.InputTokens != 307 || *cache.ReadTokens != 110 || *cache.WriteTokens != 30 || *cache.UncachedTokens != 167 || math.Abs(*cache.ReadShare-110.0/307.0) > 1e-15 || math.Abs(*cache.WriteShare-30.0/307.0) > 1e-15 || math.Abs(*cache.UncachedShare-167.0/307.0) > 1e-15 {
		t.Fatalf("cache did not use one paired cohort: %+v", cache)
	}
	if len(a.Models) != 3 || a.Models[0].Model != nil || a.Models[0].Samples != 1 || len(a.Threads) != 2 {
		t.Fatalf("groups: %+v %+v", a.Models, a.Threads)
	}
	for _, model := range a.Models {
		if !regexp.MustCompile(`^model:[0-9a-f]{64}$`).MatchString(model.Key) {
			t.Fatalf("model key: %+v", model)
		}
	}
	if *a.FirstRecordedAt != "2026-10-13T00:00:00Z" || *a.LastRecordedAt != "2026-10-13T00:00:00.00000006Z" || len(a.Buckets) != 60 {
		t.Fatalf("usage dates/buckets: %+v", a)
	}
	samples, records := 0, 0
	for _, bucket := range a.Buckets {
		samples += bucket.Samples
		records += bucket.Records
	}
	if samples != 3 || records != 3 || a.Buckets[0].Samples != 1 || a.Buckets[30].Samples != 1 || a.Buckets[59].Samples != 1 || a.Buckets[59].Records != 1 {
		t.Fatalf("dated usage/Event coverage: %+v", a.Buckets)
	}
	if !reflect.DeepEqual(open(t, s, sessionanalytics.Query{AnalyticsVersion: 4}).Usage, r.Usage) {
		t.Fatal("v5 changed existing Usage")
	}
}

func TestTokenActivityScopesReportAndOptionsWithoutChangingExistingStatistics(t *testing.T) {
	s := tokenSnapshot()
	all := open(t, s, sessionanalytics.Query{AnalyticsVersion: 5})
	var key string
	for _, model := range all.TokenActivity.Models {
		if model.Model != nil && *model.Model == "model-a" {
			key = model.Key
		}
	}
	root := open(t, s, sessionanalytics.Query{AnalyticsVersion: 5, Thread: "root", Model: key})
	a := root.TokenActivity
	if *a.ScopeThreadID != "root" || *a.ScopeModelKey != key || a.Samples != 2 || a.TimedSamples != 2 || a.UntimedSamples != 0 || len(a.Models) != 2 || len(a.Threads) != 1 || a.Threads[0].ID != "root" {
		t.Fatalf("AND scope or independent options: %+v", a)
	}
	if !reflect.DeepEqual(root.Usage, all.Usage) || !reflect.DeepEqual(root.Summary, all.Summary) || !reflect.DeepEqual(root.Tools, all.Tools) || !reflect.DeepEqual(root.FileActivity, all.FileActivity) {
		t.Fatal("token scope changed Session-wide statistics")
	}
	// A model chooses Usage and its intervals; Events have no model identity.
	// Contemporaneous child context remains navigable in an all-Thread scope.
	modelOnly := open(t, s, sessionanalytics.Query{AnalyticsVersion: 5, Model: key})
	middle := modelOnly.TokenActivity.Buckets[30]
	context := open(t, s, sessionanalytics.Query{AnalyticsVersion: 5, Model: key, Metric: "token_records", Snapshot: modelOnly.Snapshot, TokenRange: middle.Range})
	if middle.Samples != 0 || middle.Records != 1 || len(context.Evidence.Items) != 1 || context.Evidence.Items[0].EventID != "child-middle" {
		t.Fatalf("model membership guessed for Event context: %+v %+v", middle, context.Evidence)
	}
	// A globally present model with no usage in this Thread is an honest empty
	// AND scope, and both selectors retain their independent option lists.
	empty := open(t, s, sessionanalytics.Query{AnalyticsVersion: 5, Thread: "child", Model: key}).TokenActivity
	if empty.Samples != 0 || empty.Tokens.Total.KnownSubtotal != nil || len(empty.Buckets) != 0 || len(empty.Models) != 1 || *empty.Models[0].Model != "model-b" || len(empty.Threads) != 1 || empty.Threads[0].ID != "root" {
		t.Fatalf("empty combination/options: %+v", empty)
	}
	for _, model := range []string{"model-a", "model:" + strings.Repeat("0", 64)} {
		_, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 5, Model: model})
		var invalid *sessionanalytics.InvalidQueryError
		if !errors.As(err, &invalid) || invalid.Field != "model" {
			t.Fatalf("nonmember/raw model accepted: %v", err)
		}
	}
}

func TestTokenRangesReturnOnlyActualContemporaneousRecordedEvents(t *testing.T) {
	s := tokenSnapshot()
	module := sessionanalytics.New(&snapshotStore{snapshot: s})
	r, err := module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 5})
	if err != nil {
		t.Fatal(err)
	}
	for index, bucket := range r.TokenActivity.Buckets {
		selected, e := module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 5, Metric: "token_records", Snapshot: r.Snapshot, TokenRange: bucket.Range, Limit: 100})
		if e != nil || len(selected.Evidence.Items) != bucket.Records || !reflect.DeepEqual(selected.TokenActivity, r.TokenActivity) {
			t.Fatalf("bucket %d count/navigation: %+v %v", index, selected, e)
		}
		for _, item := range selected.Evidence.Items {
			if item.ClockQuality != "recorded" || item.EventID == "before" || item.EventID == "after" || item.EventID == "unknown" || item.EventID == "legacy" {
				t.Fatalf("guessed or unqualified anchor: %+v", item)
			}
		}
	}
	// Usage can exist entirely outside the Event span, and its interval has no
	// nearest-Event fallback. The report still retains its usage.
	s.Usage = s.Usage[:1]
	s.Usage[0].OccurredAt = time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	store := &snapshotStore{snapshot: s}
	module = sessionanalytics.New(store)
	r, err = module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 5})
	if err != nil || r.TokenActivity.Buckets[0].Samples != 1 || r.TokenActivity.Buckets[0].Records != 0 {
		t.Fatalf("out-of-Event-span usage lost: %+v %v", r.TokenActivity, err)
	}
	page, err := module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 5, Metric: "token_records", Snapshot: r.Snapshot, TokenRange: r.TokenActivity.Buckets[0].Range})
	if err != nil || len(page.Evidence.Items) != 0 {
		t.Fatalf("nearest Event invented: %+v %v", page.Evidence, err)
	}
}

func TestTokenRangePageBindingsAndAuthorizationRemainConditional(t *testing.T) {
	s := tokenSnapshot()
	s.Usage = s.Usage[:1]
	s.Events = nil
	for index := 0; index < 25; index++ {
		s.Events = append(s.Events, recorded(event(strings.Repeat("x", index+1), "root", "message", int64(index)), s.Usage[0].OccurredAt))
	}
	store := &snapshotStore{snapshot: s}
	module := sessionanalytics.New(store)
	r, err := module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 5})
	if err != nil {
		t.Fatal(err)
	}
	q := sessionanalytics.Query{AnalyticsVersion: 5, Metric: "token_records", Snapshot: r.Snapshot, TokenRange: r.TokenActivity.Buckets[0].Range, Limit: 5}
	page, err := module.Open(t.Context(), principal, "session", q)
	if err != nil || page.Evidence.NextCursor == "" || len(page.Evidence.Items) != 5 {
		t.Fatalf("first page: %+v %v", page.Evidence, err)
	}
	q.Cursor, q.Limit = page.Evidence.NextCursor, 7
	next, err := module.Open(t.Context(), principal, "session", q)
	if err != nil || len(next.Evidence.Items) != 7 || next.Evidence.Items[0].EventID != strings.Repeat("x", 6) {
		t.Fatalf("continuation: %+v %v", next.Evidence, err)
	}
	for _, mutate := range []func(*sessionanalytics.Query){
		func(q *sessionanalytics.Query) { q.Thread = "root" },
		func(q *sessionanalytics.Query) { q.Model = r.TokenActivity.Models[0].Key },
		func(q *sessionanalytics.Query) { q.TokenRange += "x" },
		func(q *sessionanalytics.Query) { q.Metric, q.TokenRange = "records", "" },
	} {
		changed := q
		mutate(&changed)
		_, e := module.Open(t.Context(), principal, "session", changed)
		var invalid *sessionanalytics.InvalidQueryError
		if !errors.As(e, &invalid) || invalid.Field != "cursor" {
			t.Fatalf("changed cursor binding accepted: %+v %v", changed, e)
		}
		changed.Cursor = ""
		if changed.Metric == "token_records" {
			if _, e = module.Open(t.Context(), principal, "session", changed); e == nil {
				t.Fatalf("changed scope range accepted: %+v", changed)
			}
		}
	}
	store.snapshot.SnapshotToken = "changed"
	if _, err = module.Open(t.Context(), principal, "session", q); err == nil {
		t.Fatal("stale usage snapshot accepted")
	}
	store.snapshot, store.missing = s, true
	if _, err = module.Open(t.Context(), principal, "session", q); err == nil {
		t.Fatal("range granted revoked access")
	}
}

func TestTokenCountersKeepZerosMissingAndOverflowDistinct(t *testing.T) {
	for _, test := range []struct {
		name  string
		usage []canonical.UsageRecord
		check func(*testing.T, *sessionanalytics.TokenActivity)
	}{
		{"empty", nil, func(t *testing.T, a *sessionanalytics.TokenActivity) {
			subtotal(t, a.Tokens.Total, nil, 0, 0, false)
			if a.Cache.InputTokens != nil || a.Cache.ReadShare != nil || a.FirstRecordedAt != nil || len(a.Buckets) != 0 || a.Buckets == nil {
				t.Fatalf("empty became zero: %+v", a)
			}
		}},
		{"missing", []canonical.UsageRecord{tokenUsage("missing", "root", "", time.Time{}, nil, nil, nil, nil)}, func(t *testing.T, a *sessionanalytics.TokenActivity) {
			subtotal(t, a.Tokens.Total, nil, 0, 1, false)
			if a.Cache.EligibleSamples != 0 || a.Cache.MissingSamples != 1 || a.Cache.ReadShare != nil || a.UntimedSamples != 1 {
				t.Fatalf("missing coverage: %+v", a)
			}
		}},
		{"zero", []canonical.UsageRecord{tokenUsage("zero", "root", "", time.Time{}, ptr(int64(0)), ptr(int64(0)), ptr(int64(0)), ptr(int64(0)))}, func(t *testing.T, a *sessionanalytics.TokenActivity) {
			subtotal(t, a.Tokens.Total, ptr(int64(0)), 1, 0, false)
			if a.Cache.EligibleSamples != 1 || a.Cache.InputTokens == nil || *a.Cache.InputTokens != 0 || a.Cache.ReadShare != nil || a.Cache.WriteShare != nil || a.Cache.UncachedShare != nil {
				t.Fatalf("zero denominator became a ratio: %+v", a.Cache)
			}
		}},
		{"aggregate-overflow", []canonical.UsageRecord{
			tokenUsage("max", "root", "", time.Time{}, ptr(int64(9007199254740991)), ptr(int64(0)), ptr(int64(0)), ptr(int64(0))),
			tokenUsage("one", "root", "", time.Time{}, ptr(int64(1)), ptr(int64(1)), ptr(int64(0)), ptr(int64(0))),
		}, func(t *testing.T, a *sessionanalytics.TokenActivity) {
			subtotal(t, a.Tokens.Total, nil, 2, 0, true)
			subtotal(t, a.Tokens.Input, nil, 2, 0, true)
			subtotal(t, a.Tokens.Output, ptr(int64(1)), 2, 0, false)
			if a.Cache.EligibleSamples != 2 || a.Cache.InputTokens != nil || a.Cache.ReadShare != nil || a.Cache.UncachedShare != nil {
				t.Fatalf("overflow created unsafe cache totals/ratios: %+v", a.Cache)
			}
		}},
		{"same-sample-total-overflow", []canonical.UsageRecord{
			tokenUsage("overflow", "root", "", time.Time{}, ptr(int64(9007199254740991)), ptr(int64(1)), ptr(int64(0)), ptr(int64(0))),
			tokenUsage("zero-after-overflow", "root", "", time.Time{}, ptr(int64(0)), ptr(int64(0)), ptr(int64(0)), ptr(int64(0))),
		}, func(t *testing.T, a *sessionanalytics.TokenActivity) {
			subtotal(t, a.Tokens.Total, nil, 2, 0, true)
			subtotal(t, a.Tokens.Input, ptr(int64(9007199254740991)), 2, 0, false)
			subtotal(t, a.Tokens.Output, ptr(int64(1)), 2, 0, false)
		}},
		{"invalid-sample", []canonical.UsageRecord{
			tokenUsage("bad", "root", "", time.Time{}, ptr(int64(-1)), ptr(int64(9007199254740992)), ptr(int64(3)), ptr(int64(4))),
			tokenUsage("bad-cache", "root", "", time.Time{}, ptr(int64(5)), ptr(int64(1)), ptr(int64(3)), ptr(int64(4))),
		}, func(t *testing.T, a *sessionanalytics.TokenActivity) {
			subtotal(t, a.Tokens.Total, ptr(int64(6)), 1, 1, false)
			subtotal(t, a.Tokens.Input, ptr(int64(5)), 1, 1, false)
			if a.Cache.EligibleSamples != 0 || a.Cache.MissingSamples != 2 || a.Cache.ReadShare != nil {
				t.Fatalf("invalid sample entered cache cohort: %+v", a.Cache)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := emptySnapshot()
			s.Usage = test.usage
			test.check(t, open(t, s, sessionanalytics.Query{AnalyticsVersion: 5}).TokenActivity)
		})
	}
}

func TestTokenActivitySupportsFullYearAndNanosecondSpansIndependentlyOfEventProfiles(t *testing.T) {
	for _, dates := range [][2]string{{"0000-01-01T00:00:00.000000001Z", "9999-12-31T23:59:59.999999999Z"}, {"2026-10-13T00:00:00.000000001Z", "2026-10-13T00:00:00.000000003Z"}} {
		t.Run(dates[0], func(t *testing.T) {
			first, _ := time.Parse(time.RFC3339Nano, dates[0])
			last, _ := time.Parse(time.RFC3339Nano, dates[1])
			s := emptySnapshot()
			s.Usage = []canonical.UsageRecord{tokenUsage("first", "root", "", first, nil, nil, nil, nil), tokenUsage("last", "root", "", last, nil, nil, nil, nil)}
			// Stored usage time is not promoted from any Event profile. Legacy
			// Events stay ineligible for contemporaneous-record navigation.
			e := event("legacy", "root", "message", 1)
			e.OccurredAt, e.SchemaVersion = first, "atape.acp-centered.v1"
			s.Events = []canonical.EventRecord{e}
			a := open(t, s, sessionanalytics.Query{AnalyticsVersion: 5}).TokenActivity
			if *a.FirstRecordedAt != dates[0] || *a.LastRecordedAt != dates[1] || a.TimedSamples != 2 {
				t.Fatalf("stored usage times changed: %+v", a)
			}
			count := 60
			if dates[0][:4] != "0000" {
				count = 2
			}
			if len(a.Buckets) != count || a.Buckets[0].Samples != 1 || a.Buckets[count-1].Samples != 1 || !a.Buckets[count-1].IncludesEnd {
				t.Fatalf("buckets: %+v", a.Buckets)
			}
			for index, bucket := range a.Buckets {
				from, _ := time.Parse(time.RFC3339Nano, bucket.From)
				to, _ := time.Parse(time.RFC3339Nano, bucket.To)
				if !from.Before(to) || index > 0 && a.Buckets[index-1].To != bucket.From || bucket.Records != 0 {
					t.Fatalf("saturated/legacy bucket: %+v", bucket)
				}
			}
		})
	}
}

func TestTokenActivityVersionedWireAndQueryValidation(t *testing.T) {
	s := stableSnapshot()
	s.Usage = tokenSnapshot().Usage[:1]
	v4 := open(t, s, sessionanalytics.Query{AnalyticsVersion: 4})
	v5 := open(t, s, sessionanalytics.Query{AnalyticsVersion: 5})
	if v5.TokenActivity == nil || !reflect.DeepEqual(v4.Tools, v5.Tools) || !reflect.DeepEqual(v4.FileActivity, v5.FileActivity) || !reflect.DeepEqual(v4.Summary, v5.Summary) {
		t.Fatal("v5 lost v4 stable-tool/file behavior")
	}
	for _, version := range []int{2, 3, 4} {
		old := open(t, s, sessionanalytics.Query{AnalyticsVersion: version})
		wire, _ := json.Marshal(old)
		if old.TokenActivity != nil || strings.Contains(string(wire), "tokenActivity") {
			t.Fatalf("old representation changed: %s", wire)
		}
	}
	for _, q := range []sessionanalytics.Query{
		{AnalyticsVersion: 4, Model: "model"}, {AnalyticsVersion: 4, Metric: "token_records", Snapshot: s.SnapshotToken, TokenRange: "range"},
		{AnalyticsVersion: 5, Metric: "token_records"}, {AnalyticsVersion: 5, Metric: "token_records", Snapshot: s.SnapshotToken},
		{AnalyticsVersion: 5, TokenRange: "range", Snapshot: s.SnapshotToken}, {AnalyticsVersion: 5, Metric: "token_records", Snapshot: s.SnapshotToken, TokenRange: strings.Repeat("x", 513)},
		{AnalyticsVersion: 5, Metric: "token_records", Snapshot: s.SnapshotToken, TokenRange: "range", Range: "range"},
		{AnalyticsVersion: 5, Metric: "token_records", Snapshot: s.SnapshotToken, TokenRange: "range", Tool: "tool"},
	} {
		if _, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), principal, "session", q); err == nil {
			t.Fatalf("accepted invalid query: %+v", q)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(ctx, principal, "session", sessionanalytics.Query{AnalyticsVersion: 5}); !errors.Is(err, context.Canceled) {
		t.Fatalf("ignored cancellation: %v", err)
	}
}
