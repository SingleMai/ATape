package sessionanalytics_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
)

var principal = canonicalcontract.WebPrincipal()

func recorded(e canonical.EventRecord, at time.Time) canonical.EventRecord {
	e.SchemaVersion, e.OccurredAt = "atape.acp-centered.v3", at
	return e
}

func TestActivityClassifiesSourceClocksWithoutPromotingLegacyDates(t *testing.T) {
	s := emptySnapshot()
	at := time.Date(2026, 10, 12, 0, 0, 0, 123456789, time.UTC)
	for index, profile := range []string{"atape.acp-centered.v1", "atape.acp-centered.v2", "atape.acp-centered.v3", "atape.acp-centered.v4", "", "future.profile"} {
		known, unknown := event(profile+"-known", "root", "message", int64(index*2)), event(profile+"-unknown", "root", "thought", int64(index*2+1))
		known.SchemaVersion, unknown.SchemaVersion, known.OccurredAt = profile, profile, at
		s.Events = append(s.Events, known, unknown)
	}
	module := sessionanalytics.New(&snapshotStore{snapshot: s})
	r, err := module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	a := r.Activity
	if a == nil || a.EventCount != 12 || a.RecordedTimeEvents != 2 || a.UnknownTimeEvents != 6 || a.LegacyTimeEvents != 4 || a.RecordSpanMilliseconds == nil || *a.RecordSpanMilliseconds != 0 || len(a.Buckets) != 1 || a.Buckets[0].Records != 2 || !a.Buckets[0].IncludesEnd {
		t.Fatalf("activity: %+v", a)
	}
	if a.FirstRecordedAt == nil || *a.FirstRecordedAt != "2026-10-12T00:00:00.123456789Z" || *a.LastRecordedAt != *a.FirstRecordedAt {
		t.Fatalf("precision: %+v", a)
	}
	for _, item := range r.Evidence.Items {
		want := "legacy"
		if strings.HasSuffix(item.EventID, "unknown") {
			want = "unknown"
		} else if strings.Contains(item.EventID, ".v3-") || strings.Contains(item.EventID, ".v4-") {
			want = "recorded"
		}
		if item.ClockQuality != want {
			t.Fatalf("quality: %+v", item)
		}
		if want != "unknown" && (item.OccurredAt == nil || *item.OccurredAt != *a.FirstRecordedAt) {
			t.Fatalf("stored evidence clock changed: %+v", item)
		}
	}
	unplaced, err := module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: r.Snapshot, Range: *a.UnplacedRange, Limit: 100})
	if err != nil || len(unplaced.Evidence.Items) != 10 || !reflect.DeepEqual(unplaced.Activity, a) {
		t.Fatalf("unplaced: %+v, %v", unplaced, err)
	}
}

func TestActivityUniformIntervalsAndFinalToolAnchorsKeepWholeSessionStatistics(t *testing.T) {
	s := emptySnapshot()
	s.Threads = append(s.Threads, canonical.ThreadRecord{ID: "child", SessionID: "session", ParentThreadID: ptr("root")})
	at := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	user := recorded(event("user", "root", "message", 1), at.Add(20*time.Nanosecond))
	user.Author = "User"
	legacy := event("legacy", "root", "message", 3)
	legacy.OccurredAt, legacy.SchemaVersion = at.Add(-time.Hour), "atape.acp-centered.v2"
	s.Events = []canonical.EventRecord{user, event("unknown", "root", "thought", 2), legacy,
		recorded(toolEvent("start", "root", "call", 4, map[string]any{"title": "Tool", "status": "pending"}), at.Add(time.Nanosecond)),
		recorded(toolEvent("end", "root", "call", 5, map[string]any{"status": "completed"}), at.Add(60*time.Nanosecond)),
		recorded(event("thought", "root", "thought", 6), at.Add(30*time.Nanosecond)), recorded(event("child-message", "child", "message", 1), at)}
	s.Usage = []canonical.UsageRecord{{SessionID: "session", ThreadID: "child", Model: "model", InputTokens: ptr(int64(10))}}
	module := sessionanalytics.New(&snapshotStore{snapshot: s})
	r, err := module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records"})
	if err != nil {
		t.Fatal(err)
	}
	a := r.Activity
	if a.EventCount != 7 || a.RecordedTimeEvents != 5 || a.BackwardClockTransitions != 2 || len(a.Buckets) != 60 || math.Abs(*a.RecordSpanMilliseconds-0.00006) > 1e-18 {
		t.Fatalf("activity: %+v", a)
	}
	records, messages, thoughts, calls := 0, 0, 0, 0
	for index, bucket := range a.Buckets {
		records += bucket.Records
		messages += bucket.Messages
		thoughts += bucket.Thoughts
		calls += bucket.ToolCalls
		if bucket.IncludesEnd != (index == 59) {
			t.Fatalf("interval endpoint: %+v", bucket)
		}
		selected, e := module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: r.Snapshot, Range: bucket.Range})
		if e != nil || len(selected.Evidence.Items) != bucket.Records {
			t.Fatalf("bucket evidence: %+v, %v", selected.Evidence, e)
		}
	}
	if records != 5 || messages != 2 || thoughts != 1 || calls != 1 || a.Buckets[1].ToolCalls != 0 || a.Buckets[59].ToolCalls != 1 || a.Buckets[59].Records != 1 {
		t.Fatalf("buckets: %+v", a.Buckets)
	}
	root, err := module.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Thread: "root"})
	if err != nil || root.Activity.ScopeThreadID == nil || *root.Activity.ScopeThreadID != "root" || root.Activity.EventCount != 6 || root.Activity.RecordedTimeEvents != 4 || root.Activity.BackwardClockTransitions != 2 {
		t.Fatalf("scope: %+v, %v", root.Activity, err)
	}
	if !reflect.DeepEqual(root.Summary, r.Summary) || !reflect.DeepEqual(root.Tools, r.Tools) || !reflect.DeepEqual(root.Capabilities, r.Capabilities) || !reflect.DeepEqual(root.Usage, r.Usage) {
		t.Fatal("activity scope changed Session-wide facts")
	}
}

func TestActivitySupportsNanosecondAndFullAdmittedYearSpans(t *testing.T) {
	for _, limits := range [][2]string{{"2026-10-12T00:00:00.000000001Z", "2026-10-12T00:00:00.000000002Z"}, {"0000-01-01T00:00:00.000000001Z", "9999-12-31T23:59:59.999999999Z"}} {
		t.Run(limits[0], func(t *testing.T) {
			first, _ := time.Parse(time.RFC3339Nano, limits[0])
			last, _ := time.Parse(time.RFC3339Nano, limits[1])
			s := emptySnapshot()
			s.Events = []canonical.EventRecord{recorded(event("first", "root", "message", 1), first), recorded(event("last", "root", "thought", 2), last)}
			m := sessionanalytics.New(&snapshotStore{snapshot: s})
			r, err := m.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records"})
			if err != nil {
				t.Fatal(err)
			}
			a := r.Activity
			if *a.FirstRecordedAt != limits[0] || *a.LastRecordedAt != limits[1] || r.Evidence.Items[1].OccurredAt == nil || *r.Evidence.Items[1].OccurredAt != limits[1] {
				t.Fatalf("clocks: %+v, %+v", a, r.Evidence)
			}
			if limits[0][:4] == "0000" {
				if len(a.Buckets) != 60 || *a.RecordSpanMilliseconds < 3e14 {
					t.Fatalf("saturated span: %+v", a)
				}
			} else if len(a.Buckets) != 1 || *a.RecordSpanMilliseconds != 0.000001 {
				t.Fatalf("nanosecond span: %+v", a)
			}
			for index, b := range a.Buckets {
				from, _ := time.Parse(time.RFC3339Nano, b.From)
				to, _ := time.Parse(time.RFC3339Nano, b.To)
				if !from.Before(to) || index > 0 && a.Buckets[index-1].To != b.From {
					t.Fatalf("nonuniform representable boundaries: %+v", a.Buckets)
				}
			}
		})
	}
}

func TestActivityEmptyAndWhollyUnplacedHaveNoDatedSpan(t *testing.T) {
	for _, count := range []int{0, 2} {
		s := emptySnapshot()
		if count > 0 {
			e := event("legacy", "root", "message", 1)
			e.OccurredAt = time.Unix(0, 0)
			s.Events = []canonical.EventRecord{e, event("unknown", "root", "thought", 2)}
		}
		r, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records"})
		if err != nil || r.Activity == nil || len(r.Activity.Buckets) != 0 || r.Activity.Buckets == nil || r.Activity.RecordSpanMilliseconds != nil || r.Activity.FirstRecordedAt != nil || r.Activity.LastRecordedAt != nil || (r.Activity.UnplacedRange != nil) != (count > 0) {
			t.Fatalf("empty span: %+v, %v", r.Activity, err)
		}
	}
}

func TestActivityRangeAndPageBindingRejectChangesAndReauthorize(t *testing.T) {
	s := emptySnapshot()
	for i := 0; i < 25; i++ {
		s.Events = append(s.Events, recorded(event(strings.Repeat("x", i+1), "root", "message", int64(i)), time.Unix(10, 0)))
	}
	store := &snapshotStore{snapshot: s}
	m := sessionanalytics.New(store)
	r, err := m.Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	q := sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: r.Snapshot, Range: r.Activity.Buckets[0].Range, Limit: 5}
	page, err := m.Open(t.Context(), principal, "session", q)
	if err != nil || page.Evidence.NextCursor == "" {
		t.Fatalf("page: %+v, %v", page.Evidence, err)
	}
	q.Cursor = page.Evidence.NextCursor
	q.Limit = 7
	next, err := m.Open(t.Context(), principal, "session", q)
	if err != nil || len(next.Evidence.Items) != 7 || next.Evidence.Items[0].EventID == page.Evidence.Items[0].EventID {
		t.Fatalf("continuation: %+v, %v", next.Evidence, err)
	}
	for _, mutate := range []func(*sessionanalytics.Query){func(q *sessionanalytics.Query) { q.Range = "" }, func(q *sessionanalytics.Query) { q.AnalyticsVersion = 2 }, func(q *sessionanalytics.Query) { q.Thread = "root" }, func(q *sessionanalytics.Query) { q.Metric = "tools" }} {
		bad := q
		mutate(&bad)
		_, e := m.Open(t.Context(), principal, "session", bad)
		var invalid *sessionanalytics.InvalidQueryError
		if !errors.As(e, &invalid) {
			t.Fatalf("accepted changed binding: %+v, %v", bad, e)
		}
	}
	bad := q
	bad.Cursor = ""
	bad.Range = q.Range + "x"
	if _, e := m.Open(t.Context(), principal, "session", bad); e == nil {
		t.Fatal("accepted a changed range token")
	}
	bad.Range, bad.Thread = q.Range, "root"
	if _, e := m.Open(t.Context(), principal, "session", bad); e == nil {
		t.Fatal("accepted a range from another Thread scope without a page cursor")
	}
	store.snapshot.SnapshotToken = "legacy:v1:changed"
	if _, e := m.Open(t.Context(), principal, "session", q); e == nil {
		t.Fatal("accepted stale snapshot")
	}
	store.snapshot = s
	store.missing = true
	if _, e := m.Open(t.Context(), principal, "session", q); e == nil {
		t.Fatal("range granted access")
	}
}

func TestActivityV2WireAndCursorRemainCompatible(t *testing.T) {
	s := emptySnapshot()
	for index := 0; index < 3; index++ {
		s.Events = append(s.Events, event(strings.Repeat("x", index+1), "root", "thought", int64(index)))
	}
	m := sessionanalytics.New(&snapshotStore{snapshot: s})
	r, err := m.Open(t.Context(), principal, "session", sessionanalytics.Query{Metric: "thoughts", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := json.Marshal(r)
	if r.AnalyticsVersion != 2 || strings.Contains(string(wire), "clockQuality") || strings.Contains(string(wire), "activity") {
		t.Fatalf("v2 changed: %s", wire)
	}
	encoded, _ := json.Marshal([]any{2, "session", s.SnapshotToken, "thoughts", "", "", "", ""})
	sum := sha256.Sum256(encoded)
	cursor, _ := json.Marshal(struct {
		Binding string `json:"b"`
		Offset  int    `json:"o"`
	}{hex.EncodeToString(sum[:]), 1})
	oldCursor := base64.RawURLEncoding.EncodeToString(cursor)
	next, err := m.Open(t.Context(), principal, "session", sessionanalytics.Query{Snapshot: r.Snapshot, Metric: "thoughts", Cursor: oldCursor, Limit: 1})
	if err != nil || next.Evidence.Items[0].EventID != "xx" {
		t.Fatalf("old cursor: %+v, %v", next, err)
	}
	for _, q := range []sessionanalytics.Query{{AnalyticsVersion: 1}, {Metric: "records"}, {AnalyticsVersion: 3, Metric: "records", Range: "range"}, {AnalyticsVersion: 3, Metric: "records", Snapshot: s.SnapshotToken, Range: strings.Repeat("x", 513)}, {AnalyticsVersion: 3, Metric: "records", Tool: "Tool"}} {
		if _, e := m.Open(context.Background(), principal, "session", q); e == nil {
			t.Fatalf("accepted query: %+v", q)
		}
	}
}

func TestActivityUsesExistingFactAndMetadataCapacityAndCancellation(t *testing.T) {
	s := emptySnapshot()
	s.Events = make([]canonical.EventRecord, sessionanalytics.MaxFacts+1)
	if _, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3}); !errors.Is(err, sessionanalytics.ErrCapacity) {
		t.Fatalf("fact bound: %v", err)
	}
	s = emptySnapshot()
	e := event("oversized", "root", "message", 1)
	e.SchemaVersion = strings.Repeat("x", canonical.AnalyticsMetadataBytes)
	s.Events = []canonical.EventRecord{e}
	if _, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3}); !errors.Is(err, sessionanalytics.ErrCapacity) {
		t.Fatalf("profile metadata bound: %v", err)
	}
	s = emptySnapshot()
	s.Threads = nil
	for index := 0; index < sessionanalytics.MaxThreads; index++ {
		s.Threads = append(s.Threads, canonical.ThreadRecord{ID: strconv.Itoa(index), SessionID: "session", Label: strings.Repeat("l", 500), CaptureStatus: "healthy"})
	}
	if result, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3}); !errors.Is(err, sessionanalytics.ErrCapacity) || result.SessionID != "" {
		t.Fatalf("response capacity returned partial analysis: %+v, %v", result, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := sessionanalytics.New(&snapshotStore{snapshot: emptySnapshot()}).Open(ctx, principal, "session", sessionanalytics.Query{AnalyticsVersion: 3}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}
