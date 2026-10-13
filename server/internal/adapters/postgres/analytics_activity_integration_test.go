package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
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

// Exercise the same Open, ingestion, publication and conditional Reader
// Interfaces used by HTTP callers against actual PostgreSQL persistence.
func TestRecordedActivityPostgresContract(t *testing.T) {
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("recorded_activity"),
		postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
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
	store := postgresadapter.NewStore(pool)
	module, ingestor := sessionanalytics.New(store), ingestion.NewIngestor(store)
	cli, web := canonicalcontract.CLIPrincipal(), canonicalcontract.WebPrincipal()
	open := func(session string, query sessionanalytics.Query) sessionanalytics.Result {
		t.Helper()
		view, e := module.Open(ctx, web, session, query)
		if e != nil {
			t.Fatal(e)
		}
		return view
	}
	requireStale := func(e error) {
		t.Helper()
		var stale *canonical.RefreshRequiredError
		if !errors.As(e, &stale) {
			t.Fatalf("wanted refresh_required, got %v", e)
		}
	}
	clockBatch := func(source string) ingestion.Batch {
		b := canonicalcontract.ValidBatch()
		b.BatchID, b.Session.SourceSessionID = "clock-"+source, source
		b.CanonicalProfileVersion = ingestion.UnknownTimeCanonicalProfileVersion
		first, last := b.Events[0], b.Events[1]
		first.SourceEventID, first.SourceOrder, first.OccurredAt = "first", 2, "2026-10-12T00:00:00Z"
		last.SourceEventID, last.SourceOrder, last.OccurredAt = "last", 3, "2026-10-12T00:01:00.000001Z"
		first.Text, last.Text = "private-record-body-first", "private-record-body-last"
		b.Session.UpdatedAt = last.OccurredAt
		unknown := last
		unknown.SourceEventID, unknown.SourceOrder, unknown.Kind = "unknown", 4, "thought"
		unknown.OccurredAt, unknown.OccurredAtUnknown, unknown.Text = "", true, "private-record-body-unknown"
		b.Events = []ingestion.Event{first, last, unknown}
		b.Session.ReportedEventCount = len(b.Events)
		return b
	}
	t.Run("Token Usage scope, same-interval Reader and independent Usage freshness", func(t *testing.T) {
		b := clockBatch("token-activity-native")
		counter := func(n int64) *int64 { return &n }
		b.Usage = []ingestion.Usage{
			{SourceUsageID: "one", SourceThreadID: "provider-root", Revision: 1, OccurredAt: b.Events[0].OccurredAt, Model: "alpha", InputTokens: counter(100), OutputTokens: counter(20), CacheReadTokens: counter(60), CacheWriteTokens: counter(10)},
			{SourceUsageID: "partial", SourceThreadID: "provider-root", Revision: 1, OccurredAt: b.Events[0].OccurredAt, Model: "alpha", InputTokens: counter(50), CacheReadTokens: counter(10), CacheWriteTokens: counter(0)},
			{SourceUsageID: "outside", SourceThreadID: "provider-root", Revision: 1, OccurredAt: "2026-10-12T00:02:00Z", Model: "beta", InputTokens: counter(300), OutputTokens: counter(50), CacheReadTokens: counter(0), CacheWriteTokens: counter(0)},
		}
		created, e := ingestor.ApplyBatch(ctx, cli, b)
		if e != nil {
			t.Fatal(e)
		}
		view := open(created.SessionID, sessionanalytics.Query{AnalyticsVersion: 5})
		a := view.TokenActivity
		if a == nil || a.Samples != 3 || a.TimedSamples != 3 || a.Tokens.Total.KnownSubtotal == nil || *a.Tokens.Total.KnownSubtotal != 470 || a.Tokens.Total.MissingSamples != 1 || view.Usage.Tokens.Total != nil || len(a.Buckets) != 60 || a.Buckets[59].Records != 0 || a.Buckets[59].Samples != 1 {
			t.Fatalf("PostgreSQL Token accounting: %+v", a)
		}
		if a.Cache.EligibleSamples != 3 || a.Cache.ReadShare == nil || math.Abs(*a.Cache.ReadShare-70.0/450.0) > 1e-12 {
			t.Fatalf("cache cohort: %+v", a.Cache)
		}
		q := sessionanalytics.Query{AnalyticsVersion: 5, Metric: "token_records", Snapshot: view.Snapshot, TokenRange: a.Buckets[0].Range}
		page := open(created.SessionID, q)
		if len(page.Evidence.Items) != 1 || page.Evidence.Items[0].ClockQuality != "recorded" {
			t.Fatalf("Token interval evidence: %+v", page.Evidence)
		}
		item := page.Evidence.Items[0]
		if _, ok, e := store.ConversationPage(ctx, web, created.SessionID, item.ThreadID, canonical.ConversationPageRequest{Snapshot: view.Snapshot, AtEventID: item.EventID, Limit: 1}); e != nil || !ok {
			t.Fatalf("Token interval conditional Reader: %v %v", ok, e)
		}
		b.BatchID = "token-usage-only-change"
		b.Usage[0].Revision++
		b.Usage[0].InputTokens = counter(101)
		if _, e := ingestor.ApplyBatch(ctx, cli, b); e != nil {
			t.Fatal(e)
		}
		_, e = module.Open(ctx, web, created.SessionID, q)
		requireStale(e)
		_, _, e = store.ConversationPage(ctx, web, created.SessionID, item.ThreadID, canonical.ConversationPageRequest{Snapshot: view.Snapshot, AtEventID: item.EventID, Limit: 1})
		requireStale(e)
		fresh := open(created.SessionID, sessionanalytics.Query{AnalyticsVersion: 5})
		if fresh.Snapshot == view.Snapshot || *fresh.TokenActivity.Tokens.Input.KnownSubtotal != 451 {
			t.Fatal("Usage-only change did not refresh Token activity")
		}
		outsider := web
		outsider.UserID = "01991b70-4d2b-7c96-a532-5818faba2e72"
		_, e = module.Open(ctx, outsider, created.SessionID, sessionanalytics.Query{AnalyticsVersion: 5, Metric: "token_records", Snapshot: fresh.Snapshot, TokenRange: fresh.TokenActivity.Buckets[0].Range})
		var concealed *sessionanalytics.NotFoundError
		if !errors.As(e, &concealed) {
			t.Fatalf("Token range granted access: %v", e)
		}
	})

	t.Run("native profiles, range paging, conditional Reader and metadata freshness", func(t *testing.T) {
		legacy := canonicalcontract.ValidBatch()
		legacy.BatchID, legacy.Session.SourceSessionID = "legacy-clock", "activity-native"
		legacy.Events = legacy.Events[:1]
		legacy.Events[0].SourceEventID, legacy.Events[0].OccurredAt = "legacy", "1970-01-01T00:00:00Z"
		legacy.Session.ReportedEventCount = 1
		created, e := ingestor.ApplyBatch(ctx, cli, legacy)
		if e != nil {
			t.Fatal(e)
		}
		b := clockBatch(legacy.Session.SourceSessionID)
		b.Session.Revision, b.Session.ReportedEventCount = 2, 4
		if _, e = ingestor.ApplyBatch(ctx, cli, b); e != nil {
			t.Fatal(e)
		}
		view := open(created.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records"})
		a := view.Activity
		if a == nil || a.EventCount != 4 || a.RecordedTimeEvents != 2 || a.UnknownTimeEvents != 1 || a.LegacyTimeEvents != 1 ||
			a.RecordSpanMilliseconds == nil || math.Abs(*a.RecordSpanMilliseconds-60000.001) > 0.000001 || len(a.Buckets) != 60 || a.UnplacedRange == nil {
			t.Fatalf("native clock report: %+v", a)
		}
		if view.Summary.KnownTimeEvents != 3 || view.Summary.UnknownTimeEvents != 1 || view.Summary.RootUserInputs != 2 {
			t.Fatalf("v2 summary semantics changed: %+v", view.Summary)
		}
		encoded, _ := json.Marshal(view)
		if strings.Contains(string(encoded), "private-record-body") {
			t.Fatal("analysis exposed source text")
		}
		if a.Buckets[0].Records != 1 || a.Buckets[len(a.Buckets)-1].Records != 1 || !a.Buckets[len(a.Buckets)-1].IncludesEnd {
			t.Fatalf("endpoint records were not included exactly once: %+v", a.Buckets)
		}
		dated := open(created.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: view.Snapshot, Range: a.Buckets[0].Range})
		if len(dated.Evidence.Items) != 1 || dated.Evidence.Items[0].ClockQuality != "recorded" {
			t.Fatalf("dated evidence: %+v", dated.Evidence)
		}
		q := sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: view.Snapshot, Range: *a.UnplacedRange, Limit: 1}
		first := open(created.SessionID, q)
		if len(first.Evidence.Items) != 1 || first.Evidence.Items[0].ClockQuality != "legacy" || first.Evidence.NextCursor == "" {
			t.Fatalf("unplaced page: %+v", first.Evidence)
		}
		q.Cursor, q.Limit = first.Evidence.NextCursor, 2
		last := open(created.SessionID, q)
		if len(last.Evidence.Items) != 1 || last.Evidence.Items[0].ClockQuality != "unknown" || last.Evidence.Items[0].OccurredAt != nil || last.Evidence.NextCursor != "" {
			t.Fatalf("unplaced continuation: %+v", last.Evidence)
		}
		item := last.Evidence.Items[0]
		page, ok, e := store.ConversationPage(ctx, web, created.SessionID, item.ThreadID, canonical.ConversationPageRequest{Snapshot: view.Snapshot, AtEventID: item.EventID, Limit: 1})
		if e != nil || !ok || page.SnapshotToken != view.Snapshot {
			t.Fatalf("conditional Reader: %v %v", ok, e)
		}
		found := false
		for _, event := range page.Events {
			if event.ID == item.EventID {
				found = event.OccurredAt.IsZero()
			}
		}
		if !found {
			t.Fatal("Reader lost the selected unknown-time record")
		}
		// Model a compatible stored-metadata change without changing revision,
		// body or Session recency: its contract category is still source identity.
		if _, e = pool.Exec(ctx, "UPDATE canonical_events SET schema_version=$1 WHERE id=$2", ingestion.CanonicalProfileVersion, dated.Evidence.Items[0].EventID); e != nil {
			t.Fatal(e)
		}
		_, e = module.Open(ctx, web, created.SessionID, q)
		requireStale(e)
		_, _, e = store.ConversationPage(ctx, web, created.SessionID, item.ThreadID, canonical.ConversationPageRequest{Snapshot: view.Snapshot, AtEventID: item.EventID, Limit: 1})
		requireStale(e)
		fresh := open(created.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records"})
		if fresh.Snapshot == view.Snapshot || fresh.Activity.RecordedTimeEvents != 1 || fresh.Activity.LegacyTimeEvents != 2 || len(fresh.Activity.Buckets) != 1 || *fresh.Activity.RecordSpanMilliseconds != 0 {
			t.Fatalf("metadata change did not select fresh clock facts: %+v", fresh.Activity)
		}
		outsider := web
		outsider.UserID = "01991b70-4d2b-7c96-a532-5818faba2e72"
		_, e = module.Open(ctx, outsider, created.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: fresh.Snapshot, Range: *fresh.Activity.UnplacedRange})
		var concealed *sessionanalytics.NotFoundError
		if !errors.As(e, &concealed) {
			t.Fatalf("range token granted access: %v", e)
		}
		if e = store.DeleteSession(ctx, web, created.SessionID, ""); e != nil {
			t.Fatal(e)
		}
		_, e = module.Open(ctx, web, created.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: fresh.Snapshot, Range: *fresh.Activity.UnplacedRange})
		if !errors.As(e, &concealed) {
			t.Fatalf("deleted Session remained readable: %v", e)
		}
	})

	t.Run("normalized publication clock profiles and replacement invalidate ranges", func(t *testing.T) {
		writer, e := postgresadapter.NewPublicationStore(pool, publication.Limits{PartBytes: 1 << 20, TargetBytes: 8 << 20, UserPendingBytes: 16 << 20, Parts: 16, Reservations: 64, ReservationLifetime: time.Minute, LeaseLifetime: 30 * time.Second})
		if e != nil {
			t.Fatal(e)
		}
		stage := func(b ingestion.Batch, base string) publication.Attempt {
			t.Helper()
			r, e := writer.Reserve(ctx, cli, publication.Scope{ProjectID: b.ProjectID, InstallationID: b.Source.InstallationID, AdapterID: b.Source.AdapterID, SourceSessionID: b.Session.SourceSessionID, OriginKey: "activity"})
			if e != nil {
				t.Fatal(e)
			}
			a, e := writer.Begin(ctx, cli, publication.Begin{ReservationID: r.ID, CaptureID: r.ID, BaseHead: base, TransformVersion: "activity-v3"})
			if e != nil {
				t.Fatal(e)
			}
			target := publication.UnknownTimeTargetProfile
			if b.CanonicalProfileVersion == ingestion.ToolIdentityCanonicalProfileVersion {
				target = publication.ToolIdentityTargetProfile
			}
			body, e := json.Marshal(publication.CanonicalPart{Target: publication.Target{Profile: target, Events: len(b.Events), Usage: len(b.Usage), Threads: len(b.Threads), RetainedThreadIDs: []string{}}, Batch: b})
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
			if _, e = writer.Validate(ctx, cli, a.ID); e != nil {
				t.Fatal(e)
			}
			return a
		}
		for _, profile := range []string{ingestion.UnknownTimeCanonicalProfileVersion, ingestion.ToolIdentityCanonicalProfileVersion} {
			b := clockBatch("activity-publication-" + profile)
			b.CanonicalProfileVersion = profile
			input, output, read, write := int64(100), int64(20), int64(60), int64(10)
			b.Usage = []ingestion.Usage{{SourceUsageID: "published-usage", SourceThreadID: "provider-root", Revision: 1,
				OccurredAt: b.Events[1].OccurredAt, Model: "published-model", InputTokens: &input, OutputTokens: &output, CacheReadTokens: &read, CacheWriteTokens: &write}}
			attempt := stage(b, "")
			if _, ok, e := store.SessionAnalytics(ctx, web, attempt.SessionID, ""); e != nil || ok {
				t.Fatalf("pending candidate visible: %v %v", ok, e)
			}
			head, e := writer.Activate(ctx, cli, attempt.ID)
			if e != nil {
				t.Fatal(e)
			}
			view := open(attempt.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records"})
			if view.Head != head.Head || view.Activity.RecordedTimeEvents != 2 || view.Activity.UnknownTimeEvents != 1 || view.Activity.LegacyTimeEvents != 0 {
				t.Fatalf("publication lost clock profile: %+v", view.Activity)
			}
			tokens := open(attempt.SessionID, sessionanalytics.Query{AnalyticsVersion: 5})
			if tokens.Head != head.Head || tokens.TokenActivity.Samples != 1 || *tokens.TokenActivity.Tokens.Total.KnownSubtotal != 120 || len(tokens.TokenActivity.Buckets) != 1 || tokens.TokenActivity.Buckets[0].Records != 1 {
				t.Fatalf("publication Token facts: %+v", tokens.TokenActivity)
			}
			tokenQuery := sessionanalytics.Query{AnalyticsVersion: 5, Metric: "token_records", Snapshot: tokens.Snapshot, TokenRange: tokens.TokenActivity.Buckets[0].Range}
			tokenPage := open(attempt.SessionID, tokenQuery)
			if len(tokenPage.Evidence.Items) != 1 {
				t.Fatalf("publication Token interval: %+v", tokenPage.Evidence)
			}
			selected := open(attempt.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: view.Snapshot, Range: view.Activity.Buckets[len(view.Activity.Buckets)-1].Range})
			item := selected.Evidence.Items[0]
			if item.OccurredAt == nil || *item.OccurredAt != "2026-10-12T00:01:00.000001Z" {
				t.Fatalf("evidence lost the stored microsecond clock: %+v", item)
			}
			if _, ok, e := store.ConversationPage(ctx, web, attempt.SessionID, item.ThreadID, canonical.ConversationPageRequest{Snapshot: view.Snapshot, AtEventID: item.EventID, Limit: 1}); e != nil || !ok {
				t.Fatalf("published conditional Reader: %v %v", ok, e)
			}
			b.Session.Revision++
			for i := range b.Events {
				b.Events[i].Revision++
			}
			b.Events[1].OccurredAt = "2026-10-12T00:02:00.000001Z"
			replacement := stage(b, head.Head)
			before := open(attempt.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: view.Snapshot})
			if *before.Activity.RecordSpanMilliseconds != *view.Activity.RecordSpanMilliseconds {
				t.Fatal("pending replacement changed activity")
			}
			if _, e = writer.Activate(ctx, cli, replacement.ID); e != nil {
				t.Fatal(e)
			}
			_, e = module.Open(ctx, web, attempt.SessionID, tokenQuery)
			requireStale(e)
			_, e = module.Open(ctx, web, attempt.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records", Snapshot: view.Snapshot, Range: view.Activity.Buckets[0].Range})
			requireStale(e)
			_, _, e = store.ConversationPage(ctx, web, attempt.SessionID, item.ThreadID, canonical.ConversationPageRequest{Snapshot: view.Snapshot, AtEventID: item.EventID, Limit: 1})
			requireStale(e)
			fresh := open(attempt.SessionID, sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records"})
			if math.Abs(*fresh.Activity.RecordSpanMilliseconds-120000.001) > 0.000001 {
				t.Fatalf("replacement span: %+v", fresh.Activity)
			}
		}
	})
}
