package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/teamoverview"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestUnknownConversationTimes(t *testing.T) {
	if testing.Short() || os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("unknown_time"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
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
	store := postgresadapter.NewStore(pool)
	cli, web := canonicalcontract.CLIPrincipal(), canonicalcontract.WebPrincipal()
	ingestor := ingestion.NewIngestor(store)
	reader := conversation.NewMemory(store)
	writer, err := postgresadapter.NewPublicationStore(pool, publication.Limits{PartBytes: 1 << 20, TargetBytes: 8 << 20, UserPendingBytes: 16 << 20, Parts: 16, Reservations: 64, ReservationLifetime: time.Minute, LeaseLifetime: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	makeBatch := func(source string) ingestion.Batch {
		b := canonicalcontract.ValidBatch()
		b.Session.SourceSessionID, b.BatchID = source, source
		b.CanonicalProfileVersion = ingestion.UnknownTimeCanonicalProfileVersion
		b.Session.UpdatedAt, b.Session.UpdatedAtUnknown = "", true
		original := b.Events[0]
		b.Events = nil
		for n := range 5 {
			e := original
			e.SourceEventID, e.SourceOrder = fmt.Sprintf("time-%d", n), int64(n+1)
			e.Text = "unknown-time-contract-needle " + e.SourceEventID
			if n >= 2 {
				e.OccurredAt, e.OccurredAtUnknown = "", true
			}
			b.Events = append(b.Events, e)
		}
		b.Session.ReportedEventCount = len(b.Events)
		return b
	}
	stage := func(parts []publication.CanonicalPart, base string) publication.Attempt {
		t.Helper()
		b := parts[0].Batch
		r, e := writer.Reserve(ctx, cli, publication.Scope{ProjectID: b.ProjectID, InstallationID: b.Source.InstallationID, AdapterID: b.Source.AdapterID, SourceSessionID: b.Session.SourceSessionID, OriginKey: "unknown-time-origin"})
		if e != nil {
			t.Fatal(e)
		}
		a, e := writer.Begin(ctx, cli, publication.Begin{ReservationID: r.ID, CaptureID: r.ID, BaseHead: base, TransformVersion: "unknown-time-v3"})
		if e != nil {
			t.Fatal(e)
		}
		h := publication.NewManifestHasher()
		for n, part := range parts {
			body, e := json.Marshal(part)
			if e != nil {
				t.Fatal(e)
			}
			sum := sha256.Sum256(body)
			receipt, e := writer.Put(ctx, cli, a.ID, n, hex.EncodeToString(sum[:]), body)
			if e != nil {
				t.Fatal(e)
			}
			h.Add(receipt)
		}
		a, e = writer.Seal(ctx, cli, a.ID, h.Manifest())
		if e != nil {
			t.Fatal(e)
		}
		return a
	}
	part := func(b ingestion.Batch) publication.CanonicalPart {
		return publication.CanonicalPart{Target: publication.Target{Profile: publication.UnknownTimeTargetProfile, Events: len(b.Events), Usage: len(b.Usage), Threads: len(b.Threads), RetainedThreadIDs: []string{}}, Batch: b}
	}
	validate := func(a publication.Attempt) publication.Attempt {
		t.Helper()
		for n := 0; n < 10 && a.State != "validated"; n++ {
			var e error
			a, e = writer.Validate(ctx, cli, a.ID)
			if e != nil {
				t.Fatal(e)
			}
		}
		if a.State != "validated" {
			t.Fatalf("validation did not finish: %+v", a)
		}
		return a
	}
	index := func() {
		t.Helper()
		projector := projectsearch.NewProjector(store, store)
		for range 10 {
			n, e := projector.ProjectOnce(ctx)
			if e != nil {
				t.Fatal(e)
			}
			if n == 0 {
				return
			}
		}
		t.Fatal("projection did not finish")
	}
	native := makeBatch("native-null")
	created, err := ingestor.ApplyBatch(ctx, cli, native)
	if err != nil {
		t.Fatal(err)
	}
	if replay, e := ingestor.ApplyBatch(ctx, cli, native); e != nil || !replay.Replayed {
		t.Fatalf("null replay: %+v %v", replay, e)
	}
	var nullHeader bool
	var nullEvents, nullVersions int
	if err = pool.QueryRow(ctx, "SELECT updated_at IS NULL FROM canonical_sessions WHERE id=$1", created.SessionID).Scan(&nullHeader); err != nil || !nullHeader {
		t.Fatalf("nullable header: %t %v", nullHeader, err)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM canonical_events WHERE session_id=$1 AND occurred_at IS NULL", created.SessionID).Scan(&nullEvents); err != nil || nullEvents != 3 {
		t.Fatalf("nullable events: %d %v", nullEvents, err)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM canonical_event_versions WHERE session_id=$1 AND occurred_at IS NULL", created.SessionID).Scan(&nullVersions); err != nil || nullVersions != 3 {
		t.Fatalf("nullable versions: %d %v", nullVersions, err)
	}
	opened, err := reader.OpenConversation(ctx, web, created.SessionID, "root")
	if err != nil {
		t.Fatal(err)
	}
	if opened.Session.UpdatedAt != nil || opened.Events[2].OccurredAt != nil || opened.Events[0].OccurredAt == nil || opened.Session.Status != "idle" {
		t.Fatalf("nullable conversation: %+v", opened)
	}
	index()

	t.Run("search pages cross known to unknown and continue among unknown IDs", func(t *testing.T) {
		fixed, e := ingestion.PrepareBatch(cli, native)
		if e != nil {
			t.Fatal(e)
		}
		expected := append([]canonical.EventRecord(nil), fixed.Events...)
		sort.Slice(expected, func(i, j int) bool {
			a, b := expected[i], expected[j]
			if a.OccurredAt.IsZero() != b.OccurredAt.IsZero() {
				return !a.OccurredAt.IsZero()
			}
			if a.OccurredAt.Equal(b.OccurredAt) {
				return a.ID > b.ID
			}
			return a.OccurredAt.After(b.OccurredAt)
		})
		searcher := projectsearch.NewSearcher(store)
		cursor := ""
		for n, event := range expected {
			page, e := searcher.Search(ctx, web, native.ProjectID, "unknown-time-contract-needle", cursor, 1)
			if e != nil || len(page.Results) != 1 || page.Results[0].EventID != event.ID || (page.Results[0].OccurredAt == nil) != event.OccurredAt.IsZero() {
				t.Fatalf("page %d: %+v %v", n, page, e)
			}
			cursor = page.NextCursor
			if (cursor == "") != (n == len(expected)-1) {
				t.Fatalf("page %d cursor: %q", n, cursor)
			}
		}
		// The former known-time keyset cursor remains valid; offset cursors do not.
		scope := sha256.Sum256([]byte(native.ProjectID + "\x00unknown-time-contract-needle"))
		body, _ := json.Marshal(map[string]any{"v": 1, "s": base64.RawURLEncoding.EncodeToString(scope[:]), "p": map[string]any{"t": expected[1].OccurredAt, "e": expected[1].ID}})
		page, e := searcher.Search(ctx, web, native.ProjectID, "unknown-time-contract-needle", base64.RawURLEncoding.EncodeToString(body), 1)
		if e != nil || len(page.Results) != 1 || page.Results[0].EventID != expected[2].ID {
			t.Fatalf("known v1 cursor: %+v %v", page, e)
		}
		if _, e := searcher.Search(ctx, web, native.ProjectID, "unknown-time-contract-needle", base64.RawURLEncoding.EncodeToString([]byte(`{"offset":2}`)), 1); e == nil {
			t.Fatal("old offset cursor accepted")
		}
	})

	published := makeBatch("published-null")
	root := published.Threads[0].SourceThreadID
	published.Threads = append(published.Threads, ingestion.Thread{SourceThreadID: "child", ParentSourceThreadID: &root, Revision: 1, Label: "child", CaptureStatus: "healthy"})
	for n := 2; n < len(published.Events); n++ {
		published.Events[n].SourceThreadID = "child"
	}
	child := "child"
	parent := published.Events[0]
	parent.Kind, parent.SourceEventID, parent.SourceOrder = "spawn", "spawn-child", 6
	parent.ChildSourceThreadID = &child
	published.Events = append(published.Events, parent)
	published.Session.ReportedEventCount = len(published.Events)
	fixedPublished, err := ingestion.PrepareBatch(cli, published)
	if err != nil {
		t.Fatal(err)
	}
	childID := fixedPublished.Threads[1].ID
	a := validate(stage([]publication.CanonicalPart{part(published)}, ""))
	var fixedBody []byte
	if err = pool.QueryRow(ctx, "SELECT validated_body FROM canonical_publication_parts WHERE attempt_id=$1 AND ordinal=0", a.ID).Scan(&fixedBody); err != nil || !strings.Contains(string(fixedBody), `"OccurredAt":null`) || !strings.Contains(string(fixedBody), `"UpdatedAt":null`) {
		t.Fatalf("fixed null body: %s %v", fixedBody, err)
	}
	if _, err = writer.Activate(ctx, cli, a.ID); err != nil {
		t.Fatal(err)
	}
	index()
	if opened, e := reader.OpenConversationPage(ctx, web, a.SessionID, childID, canonical.ConversationPageRequest{Limit: 1}); e != nil || len(opened.Events) != 1 || opened.Events[0].OccurredAt != nil || opened.NextEventID == "" {
		t.Fatalf("published nullable page: %+v %v", opened, e)
	}
	legacy := canonicalcontract.ValidBatch()
	legacy.Session.SourceSessionID, legacy.BatchID = "old-sentinel", "old-sentinel"
	legacy.Events = legacy.Events[:1]
	legacy.Events[0].OccurredAt = "1970-01-01T00:00:00Z"
	if _, err = ingestor.ApplyBatch(ctx, cli, legacy); err != nil {
		t.Fatal(err)
	}
	readOverview := func() teamoverview.Result {
		t.Helper()
		value, e := teamoverview.New(store).Open(ctx, web, canonicalcontract.TestTeamID, teamoverview.Query{From: "2026-09-04", To: "2026-09-04"})
		if e != nil {
			t.Fatal(e)
		}
		value.UpdatedAt, value.Diagnostics = "", teamoverview.Diagnostics{}
		return value
	}
	expectedOverview := readOverview()
	if expectedOverview.UnknownTimeSessions != 3 || expectedOverview.Metrics.Sessions != 2 || expectedOverview.Metrics.Messages != 4 {
		t.Fatalf("unknown disclosure/calendar attribution: %+v", expectedOverview)
	}
	if _, err = pool.Exec(ctx, "DELETE FROM overview_publication_messages WHERE attempt_id=$1", a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, "UPDATE canonical_publication_parts SET overview_version=NULL WHERE attempt_id=$1", a.ID); err != nil {
		t.Fatal(err)
	}
	if value := readOverview(); !reflect.DeepEqual(value, expectedOverview) {
		t.Fatalf("fallback differs: %+v", value)
	}
	if worked, e := store.BackfillOverviewFacts(ctx); e != nil || !worked {
		t.Fatalf("backfill: %t %v", worked, e)
	}
	if value := readOverview(); !reflect.DeepEqual(value, expectedOverview) {
		t.Fatalf("backfill differs: %+v", value)
	}

	t.Run("v3 retains unknown child facts without manufacturing timestamps", func(t *testing.T) {
		replacement := published
		replacement.Session.Revision++
		replacement.Events = append(append([]ingestion.Event(nil), replacement.Events[:2]...), parent)
		replacement.Session.ReportedEventCount = len(replacement.Events)
		p := part(replacement)
		p.Target.RetainedThreadIDs = []string{"child"}
		next := validate(stage([]publication.CanonicalPart{p}, a.ID))
		if _, e := writer.Activate(ctx, cli, next.ID); e != nil {
			t.Fatal(e)
		}
		opened, e := reader.OpenConversation(ctx, web, next.SessionID, childID)
		if e != nil || len(opened.Events) != 3 || opened.Events[0].OccurredAt != nil {
			t.Fatalf("retained unknown events: %+v %v", opened, e)
		}
		if value := readOverview(); !reflect.DeepEqual(value, expectedOverview) {
			t.Fatalf("retention changed time facts: %+v", value)
		}
	})

	t.Run("target and canonical profiles cannot change between parts", func(t *testing.T) {
		b := canonicalcontract.ValidBatch()
		b.CanonicalProfileVersion = ingestion.UnknownTimeCanonicalProfileVersion
		b.Session.SourceSessionID = "fixed-profile"
		first, second := part(b), part(b)
		first.Batch.Events, second.Batch.Events = b.Events[:1], b.Events[1:]
		second.Target.Profile, second.Batch.CanonicalProfileVersion = publication.RetentionTargetProfile, ingestion.CanonicalProfileVersion
		a := stage([]publication.CanonicalPart{first, second}, "")
		if _, e := writer.Validate(ctx, cli, a.ID); e != nil {
			t.Fatal(e)
		}
		_, e := writer.Validate(ctx, cli, a.ID)
		var failure *publication.Error
		if !errors.As(e, &failure) || failure.Code != "invalid" {
			t.Fatalf("mixed profiles: %v", e)
		}
		status, e := writer.Status(ctx, cli, a.ID, -1, 100)
		if e != nil || status.Attempt.ValidatedParts != 1 {
			t.Fatalf("mixed profile advanced: %+v %v", status, e)
		}
	})
	for n, profiles := range [][2]string{{publication.TargetProfile, ingestion.UnknownTimeCanonicalProfileVersion}, {publication.RetentionTargetProfile, ingestion.UnknownTimeCanonicalProfileVersion}, {publication.UnknownTimeTargetProfile, ingestion.CanonicalProfileVersion}} {
		t.Run(fmt.Sprintf("reject profile pair %d", n), func(t *testing.T) {
			b := canonicalcontract.ValidBatch()
			b.Session.SourceSessionID = fmt.Sprintf("invalid-pair-%d", n)
			b.CanonicalProfileVersion = profiles[1]
			p := part(b)
			p.Target.Profile = profiles[0]
			if p.Target.Profile == publication.TargetProfile {
				p.Target.RetainedThreadIDs = nil
			}
			a := stage([]publication.CanonicalPart{p}, "")
			var failure *publication.Error
			if _, e := writer.Validate(ctx, cli, a.ID); !errors.As(e, &failure) || failure.Code != "invalid" {
				t.Fatalf("profile pair accepted: %v", e)
			}
		})
	}
	t.Run("unknown Session update alone does not expand unknown message disclosure", func(t *testing.T) {
		headerOnly := makeBatch("header-only-null")
		headerOnly.Events = headerOnly.Events[:1]
		headerOnly.Events[0].OccurredAt = "2026-09-05T10:00:00Z"
		headerOnly.Session.ReportedEventCount = 1
		if _, e := ingestor.ApplyBatch(ctx, cli, headerOnly); e != nil {
			t.Fatal(e)
		}
		if value := readOverview(); !reflect.DeepEqual(value, expectedOverview) {
			t.Fatalf("unknown Session clock changed message calendar facts: %+v", value)
		}
		memory, e := reader.OpenProject(ctx, web, native.ProjectID)
		if e != nil || len(memory.Trail) != 4 || memory.Trail[0].UpdatedAt == nil {
			t.Fatalf("known Session update must sort before nulls: %+v %v", memory, e)
		}
		for n := 1; n < len(memory.Trail); n++ {
			if memory.Trail[n].UpdatedAt != nil || memory.Trail[n].Status == "active" || (n > 1 && memory.Trail[n-1].ID >= memory.Trail[n].ID) {
				t.Fatalf("unknown Session recency/order: %+v", memory.Trail)
			}
		}
	})

	t.Run("v3 mixed clock candidate succeeds with an entirely known first part", func(t *testing.T) {
		b := canonicalcontract.ValidBatch()
		b.BatchID, b.Session.SourceSessionID = "multipart-v3", "multipart-v3"
		b.CanonicalProfileVersion = ingestion.UnknownTimeCanonicalProfileVersion
		b.Events[1].OccurredAt, b.Events[1].OccurredAtUnknown = "", true
		first, second := part(b), part(b)
		first.Batch.Events, second.Batch.Events = b.Events[:1], b.Events[1:]
		candidate := validate(stage([]publication.CanonicalPart{first, second}, ""))
		if candidate.ValidatedParts != 2 {
			t.Fatalf("v3 multipart validation: %+v", candidate)
		}
		if _, e := writer.Activate(ctx, cli, candidate.ID); e != nil {
			t.Fatal(e)
		}
		opened, e := reader.OpenConversation(ctx, web, candidate.SessionID, "root")
		if e != nil || opened.Session.UpdatedAt == nil || len(opened.Events) != 2 || opened.Events[0].OccurredAt == nil || opened.Events[1].OccurredAt != nil {
			t.Fatalf("v3 multipart clock projection: %+v %v", opened, e)
		}
	})
	t.Run("known clocks cannot collapse to unknown at PostgreSQL precision", func(t *testing.T) {
		for _, field := range []string{"session", "event"} {
			for _, at := range []string{"0001-01-01T00:00:00.000000001Z", "0001-01-01T01:00:00.000000999+01:00"} {
				b := canonicalcontract.ValidBatch()
				b.BatchID, b.Session.SourceSessionID = "precision-rejection-"+field, "precision-rejection-"+field
				b.CanonicalProfileVersion = ingestion.UnknownTimeCanonicalProfileVersion
				if field == "session" {
					b.Session.UpdatedAt = at
				} else {
					b.Events[0].OccurredAt = at
				}
				var invalid *ingestion.ValidationError
				if _, e := ingestor.ApplyBatch(ctx, cli, b); !errors.As(e, &invalid) {
					t.Fatalf("precision-collapsed clock accepted: %s %s %v", field, at, e)
				}
			}
		}
		b := canonicalcontract.ValidBatch()
		b.BatchID, b.Session.SourceSessionID = "precision-microsecond", "precision-microsecond"
		b.CanonicalProfileVersion = ingestion.UnknownTimeCanonicalProfileVersion
		b.Session.UpdatedAt = "0001-01-01T00:00:00.000001Z"
		b.Events[0].OccurredAt = b.Session.UpdatedAt
		b.Events[0].Text = "microsecond-known-needle"
		created, e := ingestor.ApplyBatch(ctx, cli, b)
		if e != nil {
			t.Fatal(e)
		}
		opened, e := reader.OpenConversation(ctx, web, created.SessionID, "root")
		if e != nil || opened.Session.UpdatedAt == nil || opened.Events[0].OccurredAt == nil {
			t.Fatalf("microsecond boundary became unknown: %+v %v", opened, e)
		}
		index()
		page, e := projectsearch.NewSearcher(store).Search(ctx, web, b.ProjectID, "microsecond-known-needle", "", 1)
		if e != nil || len(page.Results) != 1 || page.Results[0].OccurredAt == nil || *page.Results[0].OccurredAt != "0001-01-01T00:00:00.000001Z" {
			t.Fatalf("microsecond Search clock: %+v %v", page, e)
		}
	})

}
