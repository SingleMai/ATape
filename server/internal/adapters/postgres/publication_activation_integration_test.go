package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/teamoverview"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestPublicationActivation(t *testing.T) {
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("activation"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
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
	if err = postgresadapter.Prepare(ctx, pool); err != nil {
		t.Fatal(err)
	}
	seedControlPlane(t, pool)
	limits := publication.Limits{PartBytes: 1 << 20, TargetBytes: 8 << 20, UserPendingBytes: 16 << 20, Parts: 16, Reservations: 64, ReservationLifetime: time.Minute, LeaseLifetime: 30 * time.Second}
	store, err := postgresadapter.NewPublicationStore(pool, limits)
	if err != nil {
		t.Fatal(err)
	}
	reader := postgresadapter.NewStore(pool)
	cli, web := canonicalcontract.CLIPrincipal(), canonicalcontract.WebPrincipal()
	batch := func(source string) ingestion.Batch {
		b := canonicalcontract.ValidBatch()
		b.Session.SourceSessionID = source
		return b
	}
	requireCode := func(err error, code string) {
		t.Helper()
		var failure *publication.Error
		if !errors.As(err, &failure) || failure.Code != code {
			t.Fatalf("wanted %s, got %v", code, err)
		}
	}
	var validationSamples []time.Duration
	stage := func(s *postgresadapter.PublicationStore, b ingestion.Batch, base string, validate bool) publication.Attempt {
		t.Helper()
		r, e := s.Reserve(ctx, cli, publication.Scope{ProjectID: b.ProjectID, InstallationID: b.Source.InstallationID, AdapterID: b.Source.AdapterID, SourceSessionID: b.Session.SourceSessionID, OriginKey: "origin"})
		if e != nil {
			t.Fatal(e)
		}
		a, e := s.Begin(ctx, cli, publication.Begin{ReservationID: r.ID, CaptureID: r.ID, BaseHead: base, TransformVersion: "v1"})
		if e != nil {
			t.Fatal(e)
		}
		body, e := json.Marshal(publication.CanonicalPart{Target: publication.Target{Profile: publication.TargetProfile, Events: len(b.Events), Usage: len(b.Usage), Threads: len(b.Threads)}, Batch: b})
		if e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256(body)
		part, e := s.Put(ctx, cli, a.ID, 0, hex.EncodeToString(sum[:]), body)
		if e != nil {
			t.Fatal(e)
		}
		h := publication.NewManifestHasher()
		h.Add(part)
		a, e = s.Seal(ctx, cli, a.ID, h.Manifest())
		if e != nil {
			t.Fatal(e)
		}
		if validate {
			started := time.Now()
			a, e = s.Validate(ctx, cli, a.ID)
			validationSamples = append(validationSamples, time.Since(started))
			if e != nil {
				t.Fatal(e)
			}
		}
		return a
	}
	activate := func(a publication.Attempt) publication.Activation {
		t.Helper()
		r, e := store.Activate(ctx, cli, a.ID)
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	index := func() {
		t.Helper()
		for {
			changes, e := reader.LeaseProjectionChanges(ctx, "test-indexer", 100, time.Now().Add(time.Minute))
			if e != nil {
				t.Fatal(e)
			}
			if len(changes) == 0 {
				break
			}
			docs := []canonical.EventProjection{}
			ids := []int64{}
			for _, c := range changes {
				docs = append(docs, c.Document)
				ids = append(ids, c.ID)
			}
			if e = reader.UpsertProjectionDocuments(ctx, docs); e != nil {
				t.Fatal(e)
			}
			if e = reader.AckProjectionChanges(ctx, "test-indexer", ids); e != nil {
				t.Fatal(e)
			}
		}
	}
	search := func(term string) projectsearch.IndexPage {
		t.Helper()
		p, e := reader.SearchProjectionDocuments(ctx, web, projectsearch.IndexQuery{ProjectID: canonicalcontract.TestProjectID, Term: term, Limit: 100})
		if e != nil {
			t.Fatal(e)
		}
		return p
	}
	t.Run("overview reads mixed legacy Threads and publication Events within the request budget", func(t *testing.T) {
		legacy, e := ingestion.NewIngestor(reader).ApplyBatch(ctx, cli, batch("overview-legacy"))
		if e != nil {
			t.Fatal(e)
		}
		// Reproduce the production topology: many retained legacy Threads plus
		// a selected publication body. A legacy-only volume fixture misses the
		// repeated JSON decoding caused by joining the two selected-head views.
		_, e = pool.Exec(ctx, `INSERT INTO canonical_threads
(session_id,id,source_key,revision,digest,label,summary,parent_thread_id,capture_status)
SELECT session_id,'overview-child-'||n,'overview-child-'||n,revision,digest,label,summary,id,capture_status
FROM canonical_threads CROSS JOIN generate_series(1,1043) n WHERE session_id=$1 AND id='root'`, legacy.SessionID)
		if e != nil {
			t.Fatal(e)
		}
		b := batch("overview-published")
		root := "provider-root"
		b.Threads = append(b.Threads, ingestion.Thread{SourceThreadID: "child", ParentSourceThreadID: &root, Revision: 1, Label: "Worker", CaptureStatus: "healthy"})
		template := b.Events
		b.Events = nil
		for n := 0; n < 500; n++ {
			event := template[n%2]
			event.SourceEventID = "overview-event-" + strconv.Itoa(n)
			event.SourceOrder = int64(n + 1)
			event.Text = strings.Repeat("Captured conversation. ", 50)
			if n == 0 {
				event.SourceThreadID = "child"
			}
			if n == 498 {
				event.Text = "Latest published request."
			}
			if n == 499 {
				event.Text = "Earlier sentence. Latest published reply."
			}
			b.Events = append(b.Events, event)
		}
		b.Session.ReportedEventCount = len(b.Events)
		publishedIDs := map[string]bool{}
		for n := 0; n < 8; n++ {
			b.Session.SourceSessionID = "overview-published-" + strconv.Itoa(n)
			publishedIDs[activate(stage(store, b, "", true)).SessionID] = true
		}
		t.Cleanup(func() {
			for id := range publishedIDs {
				if err := reader.DeleteSession(ctx, web, id, "cleanup-"+id); err != nil {
					t.Error(err)
				}
			}
			if err := reader.DeleteSession(ctx, web, legacy.SessionID, "cleanup-legacy"); err != nil {
				t.Error(err)
			}
		})
		// Exercise the caller's Interface under a deadline, not an exact plan
		// shape. Keep ample headroom for CI while detecting multiplicative reads.
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		started := time.Now()
		view, e := teamoverview.New(reader).Open(readCtx, web, canonicalcontract.TestTeamID, teamoverview.Query{From: "2026-09-04", To: "2026-09-04"})
		if e != nil {
			t.Fatal(e)
		}
		t.Logf("mixed publication Overview read: %s", time.Since(started))
		if view.Metrics.Sessions != 9 || view.Metrics.Messages != 1993 || view.Previous.Messages != 0 || len(view.Sessions) != 9 {
			t.Fatalf("mixed overview metrics: %+v", view.Metrics)
		}
		// Compare both paths on the identical retained dataset, alternating to
		// reduce cache/order bias. Bodies remain intact for page previews.
		ids := make([]string, 0, len(publishedIDs))
		for id := range publishedIDs {
			ids = append(ids, id)
		}
		var indexed, fallback []time.Duration
		for n := 0; n < 6; n++ {
			covered := n%2 == 0
			var version any
			if covered {
				version = 1
			}
			if _, e := pool.Exec(ctx, `UPDATE canonical_publication_parts p SET overview_version=$2
FROM canonical_publication_sources s WHERE p.attempt_id=s.current_head::uuid AND s.session_id=ANY($1::text[])`, ids, version); e != nil {
				t.Fatal(e)
			}
			started := time.Now()
			comparison, e := teamoverview.New(reader).Open(readCtx, web, canonicalcontract.TestTeamID, teamoverview.Query{From: "2026-09-04", To: "2026-09-04"})
			elapsed := time.Since(started)
			if e != nil || !reflect.DeepEqual(comparison.Metrics, view.Metrics) || !reflect.DeepEqual(comparison.Previous, view.Previous) || len(comparison.Sessions) != len(view.Sessions) {
				t.Fatalf("indexed/fallback comparison: %+v %v", comparison.Metrics, e)
			}
			if covered {
				indexed = append(indexed, elapsed)
			} else {
				fallback = append(fallback, elapsed)
			}
		}
		if _, e := pool.Exec(ctx, `UPDATE canonical_publication_parts p SET overview_version=1
FROM canonical_publication_sources s WHERE p.attempt_id=s.current_head::uuid AND s.session_id=ANY($1::text[])`, ids); e != nil {
			t.Fatal(e)
		}
		slices.Sort(indexed)
		slices.Sort(fallback)
		t.Logf("same-data Overview medians (3 samples each): indexed=%s fallback=%s", indexed[1], fallback[1])
		var payloadBytes, projectionBytes int64
		if e := pool.QueryRow(ctx, `SELECT (SELECT coalesce(sum(stored_bytes),0)::bigint FROM canonical_publication_parts),
pg_total_relation_size('overview_publication_messages')+pg_total_relation_size('overview_publication_usage')`).Scan(&payloadBytes, &projectionBytes); e != nil {
			t.Fatal(e)
		}
		samples := slices.Clone(validationSamples)
		slices.Sort(samples)
		t.Logf("8 x 500-message fixture: normalized payload=%d bytes, facts including indexes=%d bytes; validation median=%s max=%s (no baseline write-cost claim)", payloadBytes, projectionBytes, samples[len(samples)/2], samples[len(samples)-1])

		for _, session := range view.Sessions {
			if publishedIDs[session.ID] && (session.Input != "Latest published request." || session.Output != "Latest published reply.") {
				t.Fatalf("published preview: %+v", session)
			}
		}
	})
	t.Run("complete head selection replaces reads counts and Search without replaying an older receipt", func(t *testing.T) {
		b := batch("replacement")
		b.Events[0].Text = "retained-needle"
		b.Events[1].Text = "withdrawn-needle"
		a := stage(store, b, "", true)
		if _, found, e := reader.Conversation(ctx, web, a.SessionID, "root"); e != nil || found {
			t.Fatalf("candidate visible: %v %v", found, e)
		}
		first := activate(a)
		index()
		if search("withdrawn-needle").Total != 1 {
			t.Fatal("first head not indexed")
		}
		page, found, e := reader.ConversationPage(ctx, web, a.SessionID, "root", canonical.ConversationPageRequest{Limit: 1})
		if e != nil || !found || page.Head != first.Head || page.NextEventID == "" || len(page.Events) != 1 {
			t.Fatalf("first page: %+v %v", page, e)
		}
		tail, found, e := reader.ConversationPage(ctx, web, a.SessionID, "root", canonical.ConversationPageRequest{Head: page.Head, AfterEventID: page.NextEventID, Limit: 1})
		if e != nil || !found || len(tail.Events) != 1 || tail.NextEventID != "" || tail.Events[0].Text != "withdrawn-needle" {
			t.Fatalf("tail: %+v %v", tail, e)
		}
		unchanged := activate(stage(store, b, first.Head, true))
		if search("retained-needle").Total != 1 {
			t.Fatal("unchanged descriptor lost reusable Search eligibility")
		}
		b.Session.Title = "Replacement title"
		b.Session.Revision++
		b.Events = b.Events[:1]
		next := stage(store, b, unchanged.Head, true)
		before, _, e := reader.Conversation(ctx, web, a.SessionID, "root")
		if e != nil || len(before.Events) != 2 {
			t.Fatalf("staging changed selected view: %+v %v", before, e)
		}
		second := activate(next)
		if search("withdrawn-needle").Total != 0 || search("retained-needle").Total != 0 {
			t.Fatal("stale membership or changed descriptor remained searchable")
		}
		_, _, e = reader.ConversationPage(ctx, web, a.SessionID, "root", canonical.ConversationPageRequest{Head: page.Head, AfterEventID: page.NextEventID, Limit: 1})
		var refresh *canonical.RefreshRequiredError
		if !errors.As(e, &refresh) || refresh.Head != second.Head {
			t.Fatalf("wanted refresh, got %v", e)
		}
		current, _, e := reader.Conversation(ctx, web, a.SessionID, "root")
		if e != nil || len(current.Events) != 1 || current.Session.Title != b.Session.Title {
			t.Fatalf("selected target: %+v %v", current, e)
		}
		project, _, e := reader.Project(ctx, web, b.ProjectID)
		if e != nil {
			t.Fatal(e)
		}
		for _, s := range project.Sessions {
			if s.Session.ID == a.SessionID && s.EventCount != 1 {
				t.Fatalf("old visible count: %d", s.EventCount)
			}
		}
		restartedPool, e := postgresadapter.NewPool(url)
		if e != nil {
			t.Fatal(e)
		}
		defer restartedPool.Close()
		restarted, e := postgresadapter.NewPublicationStore(restartedPool, limits)
		if e != nil {
			t.Fatal(e)
		}
		replayed, e := restarted.Activate(ctx, cli, a.ID)
		if e != nil || replayed != first {
			t.Fatalf("old receipt: %+v %v", replayed, e)
		}
		current, _, e = reader.Conversation(ctx, web, a.SessionID, "root")
		if e != nil || current.Head != second.Head {
			t.Fatalf("receipt rewound the head: %+v %v", current, e)
		}
		if _, e = store.Reject(ctx, cli, a.ID); e == nil {
			t.Fatal("activated target rejected")
		}
		if _, e = store.Reclaim(ctx, cli, 32); e != nil {
			t.Fatal(e)
		}
		oldStatus, e := store.Status(ctx, cli, a.ID, -1, 100)
		if e != nil || oldStatus.Attempt.RetainedBytes != 0 || len(oldStatus.Parts) != 0 || oldStatus.Attempt.Activation == nil {
			t.Fatalf("old body was not reclaimed independently of proof: %+v %v", oldStatus, e)
		}
		selectedStatus, e := store.Status(ctx, cli, next.ID, -1, 100)
		if e != nil || selectedStatus.Attempt.RetainedBytes == 0 || len(selectedStatus.Parts) != 1 {
			t.Fatalf("selected head reclaimed: %+v %v", selectedStatus, e)
		}
		replayed, e = store.Activate(ctx, cli, a.ID)
		if e != nil || replayed != first {
			t.Fatalf("cleanup lost proof: %+v %v", replayed, e)
		}
		index()
		if search("retained-needle").Total != 1 {
			t.Fatal("new head not searchable after indexing")
		}
	})
	t.Run("stale index workers cannot make a withdrawn version eligible", func(t *testing.T) {
		b := batch("stale-worker")
		b.Events[0].Text = "stale-worker-text"
		first := activate(stage(store, b, "", true))
		changes, e := reader.LeaseProjectionChanges(ctx, "slow-worker", 100, time.Now().Add(time.Minute))
		if e != nil || len(changes) != 2 {
			t.Fatalf("lease: %+v %v", changes, e)
		}
		b.Events[0].Text = "new-worker-text"
		b.Events[0].Revision++
		activate(stage(store, b, first.Head, true))
		index()
		if _, e = store.Reclaim(ctx, cli, 32); e != nil {
			t.Fatal(e)
		}
		docs := []canonical.EventProjection{}
		ids := []int64{}
		for _, c := range changes {
			docs = append(docs, c.Document)
			ids = append(ids, c.ID)
		}
		if e = reader.UpsertProjectionDocuments(ctx, docs); e != nil {
			t.Fatal(e)
		}
		if e = reader.AckProjectionChanges(ctx, "slow-worker", ids); e != nil {
			t.Fatal(e)
		}
		if search("stale-worker-text").Total != 0 || search("new-worker-text").Total != 1 {
			t.Fatal("late worker changed selected Search eligibility")
		}
	})
	t.Run("unknown-time disclosure follows the selected publication head", func(t *testing.T) {
		b := batch("unknown-time-head")
		for i := range b.Events {
			b.Events[i].OccurredAt = "1970-01-01T00:00:00Z"
		}
		first := activate(stage(store, b, "", true))
		query := teamoverview.Query{From: "2026-09-04", To: "2026-09-04", Agent: "unmatched"}
		module := teamoverview.New(reader)
		page, e := module.OpenSessions(ctx, web, canonicalcontract.TestTeamID, query)
		if e != nil || page.UnknownTimeSessions != 1 || page.Metrics.Sessions != 0 {
			t.Fatalf("unknown published messages: %+v %v", page, e)
		}
		b.Events = nil
		activate(stage(store, b, first.Head, true))
		page, e = module.OpenSessions(ctx, web, canonicalcontract.TestTeamID, query)
		if e != nil || page.UnknownTimeSessions != 0 {
			t.Fatalf("withdrawn unknown messages: %+v %v", page, e)
		}
	})
	t.Run("withdrawn child topology and usage disappear from visible aggregates", func(t *testing.T) {
		b := batch("child-rewind")
		root := "provider-root"
		b.Threads = append(b.Threads, ingestion.Thread{SourceThreadID: "child", ParentSourceThreadID: &root, Revision: 1, Label: "Worker", CaptureStatus: "healthy"})
		b.Events[1].SourceThreadID = "child"
		b.Events[1].Kind = "tool_result"
		b.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"call-1","title":"Read","status":"completed","rawOutput":"done"}`
		tokens := int64(100)
		b.Usage = []ingestion.Usage{{SourceUsageID: "root-usage", SourceThreadID: root, Revision: 1, OccurredAt: b.Events[0].OccurredAt, InputTokens: &tokens}, {SourceUsageID: "child-usage", SourceThreadID: "child", Revision: 1, OccurredAt: b.Events[1].OccurredAt, InputTokens: &tokens}}
		b.Usage[1].Model = "published-child-model"
		first := activate(stage(store, b, "", true))
		rootPage, _, e := reader.ConversationPage(ctx, web, first.SessionID, "root", canonical.ConversationPageRequest{Limit: 1})
		if e != nil {
			t.Fatal(e)
		}
		childID := ""
		for _, thread := range rootPage.Threads {
			if thread.ParentThreadID != nil {
				childID = thread.ID
			}
		}
		child, found, e := reader.ConversationPage(ctx, web, first.SessionID, childID, canonical.ConversationPageRequest{Limit: 1})
		if e != nil || !found || len(child.Events) != 1 || child.Events[0].ToolUpdateJSON == "" {
			t.Fatalf("child tools: %+v %v", child, e)
		}
		from := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		until := from.AddDate(1, 0, 0)
		overview, e := reader.Overview(ctx, web, canonicalcontract.TestTeamID, from, until, canonical.OverviewFilter{}, nil)
		if e != nil {
			t.Fatal(e)
		}
		count := 0
		for _, u := range overview.Usage {
			if u.SessionID == first.SessionID {
				count++
			}
		}
		if count != 2 {
			t.Fatalf("first usage=%d", count)
		}
		query := teamoverview.Query{From: "2026-09-04", To: "2026-09-04", Model: "published-child-model"}
		page, e := teamoverview.New(reader).OpenSessions(ctx, web, canonicalcontract.TestTeamID, query)
		if e != nil || page.Metrics.Sessions != 1 || page.Metrics.Messages != 1 || page.Metrics.Tokens.Input == nil || *page.Metrics.Tokens.Input != tokens || len(page.Sessions) != 1 || page.Sessions[0].ID != first.SessionID || page.Sessions[0].Input == "" {
			t.Fatalf("published child model page: %+v %v", page, e)
		}
		b.Threads = b.Threads[:1]
		b.Events = b.Events[:1]
		b.Usage = b.Usage[:1]
		second := activate(stage(store, b, first.Head, true))
		_, _, e = reader.ConversationPage(ctx, web, first.SessionID, childID, canonical.ConversationPageRequest{Head: first.Head, Limit: 1})
		var refresh *canonical.RefreshRequiredError
		if !errors.As(e, &refresh) || refresh.Head != second.Head {
			t.Fatalf("withdrawn Thread continuation must refresh: %v", e)
		}
		overview, e = reader.Overview(ctx, web, canonicalcontract.TestTeamID, from, until, canonical.OverviewFilter{}, nil)
		if e != nil {
			t.Fatal(e)
		}
		count = 0
		for _, u := range overview.Usage {
			if u.SessionID == first.SessionID {
				count++
				if u.ThreadID != "root" {
					t.Fatal("withdrawn child usage visible")
				}
			}
		}
		if count != 1 {
			t.Fatalf("replacement usage=%d", count)
		}
		page, e = teamoverview.New(reader).OpenSessions(ctx, web, canonicalcontract.TestTeamID, query)
		if e != nil || page.Metrics.Sessions != 0 || len(page.Sessions) != 0 {
			t.Fatalf("withdrawn model must leave filtered page: %+v %v", page, e)
		}
		project, _, e := reader.Project(ctx, web, b.ProjectID)
		if e != nil {
			t.Fatal(e)
		}
		for _, s := range project.Sessions {
			if s.Session.ID == first.SessionID && (s.ChildThreadCount != 0 || s.EventCount != 1) {
				t.Fatalf("old topology aggregate: %+v", s)
			}
		}
	})
	t.Run("older read Interface fails explicitly when a target requires pagination", func(t *testing.T) {
		index()
		b := batch("many-events")
		event := b.Events[0]
		b.Events = nil
		for n := 0; n < 101; n++ {
			value := event
			value.SourceEventID = "event-" + strconv.Itoa(n)
			value.SourceOrder = int64(n)
			b.Events = append(b.Events, value)
		}
		first := activate(stage(store, b, "", true))
		_, _, e := reader.Conversation(ctx, web, first.SessionID, "root")
		var required *canonical.PaginationRequiredError
		if !errors.As(e, &required) {
			t.Fatalf("silent truncation: %v", e)
		}
		page, _, e := reader.ConversationPage(ctx, web, first.SessionID, "root", canonical.ConversationPageRequest{Limit: 100})
		if e != nil || len(page.Events) != 100 || page.NextEventID == "" {
			t.Fatalf("bounded page: %+v %v", page, e)
		}
		tail, _, e := reader.ConversationPage(ctx, web, first.SessionID, "root", canonical.ConversationPageRequest{Head: page.Head, AfterEventID: page.NextEventID, Limit: 100})
		if e != nil || len(tail.Events) != 1 || tail.NextEventID != "" {
			t.Fatalf("bounded tail: %+v %v", tail, e)
		}
		changes, e := reader.LeaseProjectionChanges(ctx, "partial-indexer", 100, time.Now().Add(time.Minute))
		if e != nil || len(changes) != 100 {
			t.Fatalf("first index batch: %d %v", len(changes), e)
		}
		docs := []canonical.EventProjection{}
		ids := []int64{}
		for _, c := range changes {
			docs = append(docs, c.Document)
			ids = append(ids, c.ID)
		}
		if e = reader.UpsertProjectionDocuments(ctx, docs); e != nil {
			t.Fatal(e)
		}
		if e = reader.AckProjectionChanges(ctx, "partial-indexer", ids); e != nil {
			t.Fatal(e)
		}
		if !search("layer").IndexedThrough.IsZero() {
			t.Fatal("partial target falsely reported a complete Search checkpoint")
		}
		index()
		if search("layer").IndexedThrough.IsZero() {
			t.Fatal("complete target did not advance Search progress")
		}
	})
	t.Run("empty replacement has exact zero aggregates and no indexing obligation", func(t *testing.T) {
		b := batch("empty-target")
		b.Events = nil
		first := activate(stage(store, b, "", true))
		project, _, e := reader.Project(ctx, web, b.ProjectID)
		if e != nil {
			t.Fatal(e)
		}
		for _, s := range project.Sessions {
			if s.Session.ID == first.SessionID && s.EventCount != 0 {
				t.Fatalf("empty count: %d", s.EventCount)
			}
		}
		if search("layer").IndexedThrough.IsZero() {
			t.Fatal("empty target left phantom Search work")
		}
	})
	t.Run("unvalidated and superseded targets cannot activate", func(t *testing.T) {
		b := batch("activation-fence")
		a := stage(store, b, "", false)
		_, e := store.Activate(ctx, cli, a.ID)
		requireCode(e, "invalid")
		if _, e = store.Validate(ctx, cli, a.ID); e != nil {
			t.Fatal(e)
		}
		newer := stage(store, b, "", true)
		_, e = store.Activate(ctx, cli, a.ID)
		requireCode(e, "superseded")
		activate(newer)
	})
	t.Run("activation expiry rolls back Session head receipt and Search eligibility", func(t *testing.T) {
		shortLimits := limits
		shortLimits.LeaseLifetime = time.Second
		short, e := postgresadapter.NewPublicationStore(pool, shortLimits)
		if e != nil {
			t.Fatal(e)
		}
		a := stage(short, batch("activation-expiry"), "", true)
		_, e = pool.Exec(ctx, `CREATE FUNCTION delay_activation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$;
CREATE TRIGGER delay_activation_test BEFORE UPDATE ON canonical_publication_sources FOR EACH ROW WHEN (NEW.current_head IS DISTINCT FROM OLD.current_head) EXECUTE FUNCTION delay_activation_test();`)
		if e != nil {
			t.Fatal(e)
		}
		_, activationErr := short.Activate(ctx, cli, a.ID)
		if _, e = pool.Exec(ctx, "DROP TRIGGER delay_activation_test ON canonical_publication_sources; DROP FUNCTION delay_activation_test()"); e != nil {
			t.Fatal(e)
		}
		requireCode(activationErr, "expired")
		status, e := store.Status(ctx, cli, a.ID, -1, 100)
		if e != nil || status.Attempt.Activation != nil {
			t.Fatalf("failed activation left proof: %+v %v", status, e)
		}
		if _, found, e := reader.Conversation(ctx, web, a.SessionID, "root"); e != nil || found {
			t.Fatalf("failed activation visible: %v %v", found, e)
		}
		changes, e := reader.LeaseProjectionChanges(ctx, "after-expiry", 100, time.Now().Add(time.Minute))
		if e != nil {
			t.Fatal(e)
		}
		for _, c := range changes {
			if c.Document.SessionID == a.SessionID {
				t.Fatal("failed activation exposed Search work")
			}
		}
	})
	t.Run("expired successful proof survives cleanup and Session deletion blocks replay", func(t *testing.T) {
		shortLimits := limits
		shortLimits.ReservationLifetime = time.Second
		shortLimits.LeaseLifetime = time.Second
		short, e := postgresadapter.NewPublicationStore(pool, shortLimits)
		if e != nil {
			t.Fatal(e)
		}
		a := stage(short, batch("receipt-expiry"), "", true)
		first, e := short.Activate(ctx, cli, a.ID)
		if e != nil {
			t.Fatal(e)
		}
		time.Sleep(time.Until(a.ExpiresAt) + 20*time.Millisecond)
		if _, e = store.Reclaim(ctx, cli, 32); e != nil {
			t.Fatal(e)
		}
		replay, e := store.Activate(ctx, cli, a.ID)
		if e != nil || replay != first {
			t.Fatalf("expired proof: %+v %v", replay, e)
		}
		if e = reader.DeleteSession(ctx, web, a.SessionID, "delete-publication"); e != nil {
			t.Fatal(e)
		}
		if _, e = store.Activate(ctx, cli, a.ID); e == nil {
			t.Fatal("deleted Session replayed activation")
		}
		if _, found, e := reader.Conversation(ctx, web, a.SessionID, "root"); e != nil || found {
			t.Fatalf("deleted publication visible: %v %v", found, e)
		}
	})
	t.Run("revoked membership cannot replay a successful activation", func(t *testing.T) {
		a := stage(store, batch("activation-permission"), "", true)
		activate(a)
		if _, e := pool.Exec(ctx, "UPDATE team_memberships SET status='removed',removed_at=clock_timestamp() WHERE team_id=$1 AND user_id=$2", canonicalcontract.TestTeamID, cli.UserID); e != nil {
			t.Fatal(e)
		}
		if _, e := store.Activate(ctx, cli, a.ID); e == nil {
			t.Fatal("revoked member received an activation receipt")
		}
	})
}
