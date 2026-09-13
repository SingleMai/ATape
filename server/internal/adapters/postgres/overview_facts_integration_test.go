package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/teamoverview"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestOverviewPublicationFacts(t *testing.T) {
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("overview_facts"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
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
	writer, err := postgresadapter.NewPublicationStore(pool, limits)
	if err != nil {
		t.Fatal(err)
	}
	reader := postgresadapter.NewStore(pool)
	cli, web := canonicalcontract.CLIPrincipal(), canonicalcontract.WebPrincipal()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	stage := func(source, base string, parts []ingestion.Batch) publication.Attempt {
		t.Helper()
		b := parts[0]
		r, err := writer.Reserve(ctx, cli, publication.Scope{ProjectID: b.ProjectID, InstallationID: b.Source.InstallationID, AdapterID: b.Source.AdapterID, SourceSessionID: source, OriginKey: "origin"})
		if err != nil {
			t.Fatal(err)
		}
		a, err := writer.Begin(ctx, cli, publication.Begin{ReservationID: r.ID, CaptureID: r.ID, BaseHead: base, TransformVersion: "v1"})
		if err != nil {
			t.Fatal(err)
		}
		target := publication.Target{Profile: publication.TargetProfile, Threads: len(b.Threads)}
		for _, part := range parts {
			target.Events += len(part.Events)
			target.Usage += len(part.Usage)
		}
		h := publication.NewManifestHasher()
		for n, part := range parts {
			part.Session.SourceSessionID = source
			body, err := json.Marshal(publication.CanonicalPart{Target: target, Batch: part})
			if err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(body)
			receipt, err := writer.Put(ctx, cli, a.ID, n, hex.EncodeToString(sum[:]), body)
			if err != nil {
				t.Fatal(err)
			}
			h.Add(receipt)
		}
		a, err = writer.Seal(ctx, cli, a.ID, h.Manifest())
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	validate := func(a publication.Attempt, parts int) publication.Attempt {
		t.Helper()
		for range parts {
			var err error
			a, err = writer.Validate(ctx, cli, a.ID)
			if err != nil {
				t.Fatal(err)
			}
		}
		return a
	}
	activate := func(a publication.Attempt) {
		t.Helper()
		if _, err := writer.Activate(ctx, cli, a.ID); err != nil {
			t.Fatal(err)
		}
	}
	coverage := func() postgresadapter.OverviewFactCoverage {
		t.Helper()
		c, err := reader.OverviewFactsCoverage(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	// Fault injection models a validated part produced by a pre-projection binary.
	uncover := func(id string, ordinal int) {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		for _, sql := range []string{
			"DELETE FROM overview_publication_messages WHERE attempt_id=$1 AND part_ordinal=$2",
			"DELETE FROM overview_publication_usage WHERE attempt_id=$1 AND part_ordinal=$2",
			"UPDATE canonical_publication_parts SET overview_version=NULL WHERE attempt_id=$1 AND ordinal=$2",
		} {
			if _, err = tx.Exec(ctx, sql, id, ordinal); err != nil {
				t.Fatal(err)
			}
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	backfill := func() {
		t.Helper()
		ok, err := reader.BackfillOverviewFacts(ctx)
		if err != nil || !ok {
			t.Fatalf("backfill: %t %v", ok, err)
		}
	}
	read := func(q teamoverview.Query) teamoverview.Result {
		t.Helper()
		q.From, q.To = "2026-09-04", "2026-09-04"
		result, err := teamoverview.New(reader).Open(ctx, web, canonicalcontract.TestTeamID, q)
		if err != nil {
			t.Fatal(err)
		}
		result.UpdatedAt = ""
		result.Diagnostics = teamoverview.Diagnostics{}
		return result
	}

	t.Run("all fallback mixed parts and indexed facts return identical dashboard results", func(t *testing.T) {
		b := canonicalcontract.ValidBatch()
		root := "provider-root"
		b.Threads = append(b.Threads, ingestion.Thread{SourceThreadID: "child", ParentSourceThreadID: &root, Revision: 1, Label: "Child", CaptureStatus: "healthy"})
		// Split one root input across parts without changing its counting identity.
		chunk := b.Events[0]
		chunk.SourceEventID = "chunk"
		chunk.EventIndex = 1
		previous := b.Events[0]
		previous.SourceEventID = "previous"
		previous.SourceOrder = 3
		previous.OccurredAt = "2026-09-03T02:00:00Z"
		unknown := b.Events[0]
		unknown.SourceEventID = "unknown"
		unknown.SourceOrder = 4
		unknown.SourceThreadID = "child"
		unknown.OccurredAt = "1970-01-01T00:00:00Z"
		child := b.Events[1]
		child.SourceEventID = "child"
		child.SourceOrder = 5
		child.SourceThreadID = "child"
		n := int64(100)
		second := b
		second.Events = []ingestion.Event{chunk, previous, unknown, child}
		second.Usage = []ingestion.Usage{
			{SourceUsageID: "current", SourceThreadID: "child", Revision: 1, OccurredAt: b.Events[0].OccurredAt, Model: "A", InputTokens: &n},
			{SourceUsageID: "previous", SourceThreadID: root, Revision: 1, OccurredAt: previous.OccurredAt, Model: "B", OutputTokens: &n},
			{SourceUsageID: "unclassified", SourceThreadID: root, Revision: 1, OccurredAt: b.Events[1].OccurredAt, CacheReadTokens: &n},
		}
		empty := b
		empty.Events = nil
		empty.Usage = nil
		a := validate(stage("mixed-facts", "", []ingestion.Batch{b, second, empty}), 3)
		if c := coverage(); c.MissingParts != 0 || c.RetainedParts != 3 {
			t.Fatalf("validation coverage: %+v", c)
		}
		if r := read(teamoverview.Query{}); r.Metrics.Sessions != 0 {
			t.Fatal("candidate visible before activation")
		}
		activate(a)
		queries := []teamoverview.Query{{}, {Model: "A"}, {Model: "B"}, {Model: "__unknown__"}, {Agent: b.Session.Actor.Harness, Member: cli.UserID, Project: b.ProjectID}, {Agent: "absent"}, {Page: 1, Limit: 1}}
		expected := make([]teamoverview.Result, len(queries))
		for i, q := range queries {
			expected[i] = read(q)
		}
		if expected[0].Metrics.Messages != 1 || expected[0].Previous.Messages != 1 || expected[0].UnknownTimeSessions != 1 {
			t.Fatalf("counting contract: %+v", expected[0])
		}
		for ordinal := 0; ordinal < 3; ordinal++ {
			uncover(a.ID, ordinal)
		}
		if c := coverage(); c.MissingParts != 3 || c.CurrentHeadMissingParts != 3 {
			t.Fatalf("old-writer coverage: %+v", c)
		}
		// Part zero is prepared first: uncovered parts must use their own topology.
		for prepared := 0; prepared <= 3; prepared++ {
			for i, q := range queries {
				if got := read(q); !reflect.DeepEqual(got, expected[i]) {
					t.Fatalf("query %d at %d prepared parts differs\ngot=%+v\nwant=%+v", i, prepared, got, expected[i])
				}
			}
			if prepared < 3 {
				backfill()
			}
		}
		if ok, err := reader.BackfillOverviewFacts(ctx); ok || err != nil {
			t.Fatalf("completed backfill replay: %t %v", ok, err)
		}
		status, err := writer.Status(ctx, cli, a.ID, -1, 100)
		if err != nil || status.Attempt.ValidatedParts != a.ValidatedParts || status.Attempt.RetainedBytes != a.RetainedBytes || len(status.Parts) != 3 {
			t.Fatalf("backfill changed publication progress: %+v %v", status, err)
		}
		// An out-of-range page reads every statistic but no preview. Invalid JSON in
		// covered bodies proves statistics never depend on body decoding after cutover.
		var bodies [][]byte
		rows, err := pool.Query(ctx, "SELECT validated_body FROM canonical_publication_parts WHERE attempt_id=$1 ORDER BY ordinal", a.ID)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var body []byte
			if err := rows.Scan(&body); err != nil {
				t.Fatal(err)
			}
			bodies = append(bodies, body)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		q := teamoverview.Query{Agent: b.Session.Actor.Harness, Page: 100}
		want := read(q)
		exec("UPDATE canonical_publication_parts SET validated_body=convert_to('invalid-json','UTF8') WHERE attempt_id=$1", a.ID)
		got := read(q)
		for ordinal, body := range bodies {
			exec("UPDATE canonical_publication_parts SET validated_body=$3 WHERE attempt_id=$1 AND ordinal=$2", a.ID, ordinal, body)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatal("indexed statistics changed with unrelated body bytes")
		}

		// An old already-validated empty replacement can activate before backfill.
		replacement := validate(stage("mixed-facts", a.ID, []ingestion.Batch{empty}), 1)
		uncover(replacement.ID, 0)
		activate(replacement)
		if got := read(teamoverview.Query{}); got.Metrics.Sessions != 0 || got.UnknownTimeSessions != 0 {
			t.Fatal("empty replacement retained old facts")
		}
		backfill()
		if _, err := writer.Reclaim(ctx, cli, 32); err != nil {
			t.Fatal(err)
		}
		var oldRows int
		if err := pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM overview_publication_messages WHERE attempt_id=$1)+(SELECT count(*) FROM overview_publication_usage WHERE attempt_id=$1)", a.ID).Scan(&oldRows); err != nil || oldRows != 0 {
			t.Fatalf("reclaimed facts remain: %d %v", oldRows, err)
		}
	})

	t.Run("failed projection rolls back validation and backfill retries safely", func(t *testing.T) {
		b := canonicalcontract.ValidBatch()
		n := int64(100)
		b.Usage = []ingestion.Usage{{SourceUsageID: "usage", SourceThreadID: "provider-root", Revision: 1, OccurredAt: b.Events[0].OccurredAt, InputTokens: &n}}
		a := stage("failed-facts", "", []ingestion.Batch{b})
		// Fail after messages were copied to prove the part is the atomic boundary.
		exec(`CREATE FUNCTION reject_overview_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected projection failure'; END $$;
CREATE TRIGGER reject_overview_usage BEFORE INSERT ON overview_publication_usage FOR EACH ROW EXECUTE FUNCTION reject_overview_usage();`)
		if _, err := writer.Validate(ctx, cli, a.ID); err == nil {
			t.Fatal("validation fault ignored")
		}
		status, err := writer.Status(ctx, cli, a.ID, -1, 100)
		if err != nil || status.Attempt.ValidatedParts != 0 || status.Attempt.RetainedBytes != a.RetainedBytes {
			t.Fatalf("failed validation advanced: %+v %v", status, err)
		}
		exec("DROP TRIGGER reject_overview_usage ON overview_publication_usage")
		a = validate(a, 1)
		activate(a)
		uncover(a.ID, 0)
		exec("CREATE TRIGGER reject_overview_usage BEFORE INSERT ON overview_publication_usage FOR EACH ROW EXECUTE FUNCTION reject_overview_usage()")
		if ok, err := reader.BackfillOverviewFacts(ctx); ok || err == nil {
			t.Fatalf("backfill fault ignored: %t %v", ok, err)
		}
		if c := coverage(); c.MissingParts != 1 {
			t.Fatalf("failed backfill marked complete: %+v", c)
		}
		var rows int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM overview_publication_messages WHERE attempt_id=$1", a.ID).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("partial projection committed: %d %v", rows, err)
		}
		exec("DROP TRIGGER reject_overview_usage ON overview_publication_usage; DROP FUNCTION reject_overview_usage()")
		// A separate connection after the failed transaction can finish the work.
		reopened, err := pgxpool.New(ctx, url)
		if err != nil {
			t.Fatal(err)
		}
		restarted := postgresadapter.NewStore(reopened)
		ok, err := restarted.BackfillOverviewFacts(ctx)
		reopened.Close()
		if !ok || err != nil {
			t.Fatalf("restart backfill: %t %v", ok, err)
		}
		canceled, stop := context.WithCancel(ctx)
		stop()
		if _, err := reader.BackfillOverviewFacts(canceled); !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled backfill: %v", err)
		}
	})

	t.Run("locked work is skipped without claiming completion and reclamation wins safely", func(t *testing.T) {
		a := validate(stage("locked-facts", "", []ingestion.Batch{canonicalcontract.ValidBatch()}), 1)
		uncover(a.ID, 0)
		lock, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Rollback(ctx)
		if _, err = lock.Exec(ctx, "SELECT 1 FROM canonical_publication_parts WHERE attempt_id=$1 FOR UPDATE", a.ID); err != nil {
			t.Fatal(err)
		}
		if ok, err := reader.BackfillOverviewFacts(ctx); ok || err != nil {
			t.Fatalf("locked work: %t %v", ok, err)
		}
		if c := coverage(); c.MissingParts != 1 {
			t.Fatalf("locked work reported complete: %+v", c)
		}
		if err = lock.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err = writer.Reject(ctx, cli, a.ID); err != nil {
			t.Fatal(err)
		}
		// Reclamation deletes the part while holding its row lock. Backfill skips
		// the uncommitted deletion; after commit no orphan projection can appear.
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, "DELETE FROM canonical_publication_parts WHERE attempt_id=$1", a.ID); err != nil {
			t.Fatal(err)
		}
		if ok, err := reader.BackfillOverviewFacts(ctx); ok || err != nil {
			t.Fatalf("reclaiming work: %t %v", ok, err)
		}
		if err = tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err = writer.Reclaim(ctx, cli, 32); err != nil {
			t.Fatal(err)
		}
		if c := coverage(); c.MissingParts != 0 {
			t.Fatalf("reclaimed work remains: %+v", c)
		}
	})
	t.Run("concurrent backfill workers prepare a part once", func(t *testing.T) {
		a := validate(stage("concurrent-facts", "", []ingestion.Batch{canonicalcontract.ValidBatch()}), 1)
		uncover(a.ID, 0)
		type result struct {
			worked bool
			err    error
		}
		results := make(chan result, 2)
		start := make(chan struct{})
		for range 2 {
			go func() { <-start; ok, err := reader.BackfillOverviewFacts(ctx); results <- result{ok, err} }()
		}
		close(start)
		completed := 0
		for range 2 {
			r := <-results
			if r.err != nil {
				t.Error(r.err)
			}
			if r.worked {
				completed++
			}
		}
		if completed != 1 || coverage().MissingParts != 0 {
			t.Fatalf("concurrent workers completed %d parts", completed)
		}
	})

	t.Run("additive migration leaves retained heads readable and resumably backfillable", func(t *testing.T) {
		before := read(teamoverview.Query{})
		exec(`DROP TABLE overview_publication_messages, overview_publication_usage;
ALTER TABLE canonical_publication_parts DROP COLUMN overview_version;
DELETE FROM atape_schema_migrations WHERE version=20;`)
		if err := postgresadapter.Prepare(ctx, pool); err != nil {
			t.Fatal(err)
		}
		if got := read(teamoverview.Query{}); !reflect.DeepEqual(got, before) {
			t.Fatal("migration changed retained statistics")
		}
		c := coverage()
		if c.MissingParts == 0 || c.CurrentHeadMissingParts == 0 {
			t.Fatalf("migration claimed unprepared data: %+v", c)
		}
		for range c.MissingParts {
			backfill()
		}
		if got := read(teamoverview.Query{}); !reflect.DeepEqual(got, before) {
			t.Fatal("migration backfill changed retained statistics")
		}
		if err := postgresadapter.Prepare(ctx, pool); err != nil {
			t.Fatal(err)
		}
		if c := coverage(); c.MissingParts != 0 {
			t.Fatalf("migration replay reset coverage: %+v", c)
		}
	})

}
