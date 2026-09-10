package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestPublicationCandidateRecovery(t *testing.T) {
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("publication"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
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
	limits := publication.Limits{PartBytes: 128, TargetBytes: 256, UserPendingBytes: 384, Parts: 8, Reservations: 32, ReservationLifetime: time.Minute, LeaseLifetime: 30 * time.Second}
	store, err := postgresadapter.NewPublicationStore(pool, limits)
	if err != nil {
		t.Fatal(err)
	}
	principal := canonicalcontract.CLIPrincipal()
	scope := publication.Scope{ProjectID: canonicalcontract.TestProjectID, InstallationID: "installation", AdapterID: "opencode", SourceSessionID: "root", OriginKey: "origin"}
	requireCode := func(err error, code string) {
		t.Helper()
		var problem *publication.Error
		if !errors.As(err, &problem) || problem.Code != code {
			t.Fatalf("wanted %s, got %v", code, err)
		}
	}
	reserve := func(source string) publication.Reservation {
		t.Helper()
		s := scope
		s.SourceSessionID = source
		r, e := store.Reserve(ctx, principal, s)
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	begin := func(r publication.Reservation) publication.Attempt {
		t.Helper()
		a, e := store.Begin(ctx, principal, publication.Begin{ReservationID: r.ID, CaptureID: "capture", TransformVersion: "v1"})
		if e != nil {
			t.Fatal(e)
		}
		return a
	}
	put := func(a publication.Attempt, n int, body string) publication.Part {
		t.Helper()
		sum := sha256.Sum256([]byte(body))
		p, e := store.Put(ctx, principal, a.ID, n, hex.EncodeToString(sum[:]), []byte(body))
		if e != nil {
			t.Fatal(e)
		}
		return p
	}

	t.Run("sealed content is durable and invisible; identity replay cannot overwrite it", func(t *testing.T) {
		r := reserve("root")
		a := begin(r)
		if replay := begin(r); replay.Fence != a.Fence {
			t.Fatal("Begin replay changed fence")
		}
		_, changed := store.Begin(ctx, principal, publication.Begin{ReservationID: r.ID, CaptureID: "different", TransformVersion: "v1"})
		requireCode(changed, "conflict")
		renewed, renewErr := store.Renew(ctx, principal, a.ID)
		if renewErr != nil || renewed.Fence != a.Fence || renewed.LeaseUntil.After(renewed.ExpiresAt) {
			t.Fatalf("renew: %+v %v", renewed, renewErr)
		}
		p := put(a, 0, "Canonical A")
		h := publication.NewManifestHasher()
		h.Add(p)
		incomplete := h.Manifest()
		incomplete.Parts++
		_, err := store.Seal(ctx, principal, a.ID, incomplete)
		requireCode(err, "conflict")
		if _, err = store.Seal(ctx, principal, a.ID, h.Manifest()); err != nil {
			t.Fatal(err)
		}
		put(a, 0, "Canonical A")
		sum := sha256.Sum256([]byte("B"))
		_, err = store.Put(ctx, principal, a.ID, 0, hex.EncodeToString(sum[:]), []byte("B"))
		requireCode(err, "conflict")
		reopenedPool, e := postgresadapter.NewPool(url)
		if e != nil {
			t.Fatal(e)
		}
		defer reopenedPool.Close()
		reopened, e := postgresadapter.NewPublicationStore(reopenedPool, limits)
		if e != nil {
			t.Fatal(e)
		}
		page, e := reopened.Status(ctx, principal, a.ID, -1, 1)
		if e != nil || page.Attempt.State != "sealed" || len(page.Parts) != 1 || page.Parts[0] != p {
			t.Fatalf("recovery: %+v %v", page, e)
		}
		visible, exists, e := postgresadapter.NewStore(pool).Project(ctx, canonicalcontract.WebPrincipal(), scope.ProjectID)
		if e != nil || !exists || len(visible.Sessions) != 0 {
			t.Fatalf("staging leaked: %+v %v", visible, e)
		}
		if _, e = reopened.Reject(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		cleared, e := reopened.Reclaim(ctx, principal, 1)
		if e != nil || cleared.Parts != 1 || cleared.Bytes != p.Bytes {
			t.Fatalf("reclaim: %+v %v", cleared, e)
		}
		status, e := reopened.Status(ctx, principal, a.ID, -1, 1)
		if e != nil || status.Attempt.State != "rejected" {
			t.Fatalf("missing rejection: %+v %v", status, e)
		}
		_, e = reopened.Renew(ctx, principal, a.ID)
		requireCode(e, "rejected")
	})
	t.Run("new fence supersedes old writes and cannot be renewed by stale Begin replay", func(t *testing.T) {
		old := begin(reserve("fence"))
		put(old, 0, "old")
		newer := begin(reserve("fence"))
		if newer.Fence <= old.Fence {
			t.Fatal("fence did not advance")
		}
		_, e := store.Renew(ctx, principal, old.ID)
		requireCode(e, "superseded")
		sum := sha256.Sum256([]byte("tail"))
		_, e = store.Put(ctx, principal, old.ID, 1, hex.EncodeToString(sum[:]), []byte("tail"))
		requireCode(e, "superseded")
		page, e := store.Status(ctx, principal, old.ID, -1, 1)
		if e != nil || page.Attempt.State != "superseded" {
			t.Fatalf("state %+v %v", page, e)
		}
		if _, e = store.Reclaim(ctx, principal, 32); e != nil {
			t.Fatal(e)
		}
		if _, e = store.Reject(ctx, principal, newer.ID); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("immutable Origin and legacy write mode are enforced both ways", func(t *testing.T) {
		changed := scope
		changed.OriginKey = "moved"
		_, e := store.Reserve(ctx, principal, changed)
		requireCode(e, "conflict")
		batch := canonicalcontract.ValidBatch()
		batch.Source.InstallationID = scope.InstallationID
		batch.Source.AdapterID = scope.AdapterID
		batch.Session.SourceSessionID = scope.SourceSessionID
		_, e = ingestion.NewIngestor(postgresadapter.NewStore(pool)).ApplyBatch(ctx, principal, batch)
		if e == nil {
			t.Fatal("legacy writer entered publication mode")
		}
		batch.Session.SourceSessionID = "legacy"
		batch.BatchID = "legacy"
		if _, e = ingestion.NewIngestor(postgresadapter.NewStore(pool)).ApplyBatch(ctx, principal, batch); e != nil {
			t.Fatal(e)
		}
		legacy := scope
		legacy.SourceSessionID = "legacy"
		_, e = store.Reserve(ctx, principal, legacy)
		requireCode(e, "conflict")
	})
	t.Run("payload quota does not evict live units", func(t *testing.T) {
		a := begin(reserve("quota-a"))
		b := begin(reserve("quota-b"))
		body := string(make([]byte, 128))
		put(a, 0, body)
		put(a, 1, body)
		put(b, 0, body)
		sum := sha256.Sum256([]byte("x"))
		_, e := store.Put(ctx, principal, b.ID, 1, hex.EncodeToString(sum[:]), []byte("x"))
		requireCode(e, "capacity")
		if reclaimed, e := store.Reclaim(ctx, principal, 32); e != nil || reclaimed.Parts != 0 {
			t.Fatalf("evicted live body: %+v %v", reclaimed, e)
		}
		if _, e = store.Reject(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		if _, e = store.Reclaim(ctx, principal, 1); e != nil {
			t.Fatal(e)
		}
		put(b, 1, "x")
		if _, e = store.Reject(ctx, principal, b.ID); e != nil {
			t.Fatal(e)
		}
		if _, e = store.Reclaim(ctx, principal, 32); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("independent connections serialize account quota and roll back rejected writes", func(t *testing.T) {
		secondPool, e := postgresadapter.NewPool(url)
		if e != nil {
			t.Fatal(e)
		}
		defer secondPool.Close()
		second, e := postgresadapter.NewPublicationStore(secondPool, limits)
		if e != nil {
			t.Fatal(e)
		}
		a := begin(reserve("concurrent-a"))
		b := begin(reserve("concurrent-b"))
		results := make(chan error, 4)
		body := make([]byte, 128)
		sum := sha256.Sum256(body)
		for n := 0; n < 4; n++ {
			go func(n int) {
				target := a.ID
				client := store
				if n >= 2 {
					target = b.ID
					client = second
				}
				_, err := client.Put(ctx, principal, target, n%2, hex.EncodeToString(sum[:]), body)
				results <- err
			}(n)
		}
		successes := 0
		for n := 0; n < 4; n++ {
			if e := <-results; e == nil {
				successes++
			} else {
				requireCode(e, "capacity")
			}
		}
		if successes != 3 {
			t.Fatalf("successful writes=%d", successes)
		}
		pa, e := store.Status(ctx, principal, a.ID, -1, 100)
		if e != nil {
			t.Fatal(e)
		}
		pb, e := second.Status(ctx, principal, b.ID, -1, 100)
		if e != nil {
			t.Fatal(e)
		}
		if pa.Attempt.RetainedBytes+pb.Attempt.RetainedBytes != 384 {
			t.Fatal("quota accounting lost a write")
		}
		for _, id := range []string{a.ID, b.ID} {
			if _, e = store.Reject(ctx, principal, id); e != nil {
				t.Fatal(e)
			}
		}
		if _, e = store.Reclaim(ctx, principal, 32); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("expired identities cannot revive after bounded reclamation", func(t *testing.T) {
		shortLimits := limits
		shortLimits.LeaseLifetime = 100 * time.Millisecond
		shortLimits.ReservationLifetime = 300 * time.Millisecond
		short, e := postgresadapter.NewPublicationStore(pool, shortLimits)
		if e != nil {
			t.Fatal(e)
		}
		shortScope := scope
		shortScope.SourceSessionID = "expires"
		unused, e := short.Reserve(ctx, principal, shortScope)
		if e != nil {
			t.Fatal(e)
		}
		r, e := short.Reserve(ctx, principal, shortScope)
		if e != nil {
			t.Fatal(e)
		}
		input := publication.Begin{ReservationID: r.ID, CaptureID: "expires", TransformVersion: "v1"}
		a, e := short.Begin(ctx, principal, input)
		if e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256([]byte("retained"))
		if _, e = short.Put(ctx, principal, a.ID, 0, hex.EncodeToString(sum[:]), []byte("retained")); e != nil {
			t.Fatal(e)
		}
		time.Sleep(time.Until(r.ExpiresAt) + 20*time.Millisecond)
		_, e = short.Renew(ctx, principal, a.ID)
		requireCode(e, "expired")
		replay, e := short.Begin(ctx, principal, input)
		if e != nil || replay.State != "expired" || replay.Fence != a.Fence {
			t.Fatalf("expired replay: %+v %v", replay, e)
		}
		_, e = short.Begin(ctx, principal, publication.Begin{ReservationID: unused.ID, CaptureID: "late", TransformVersion: "v1"})
		requireCode(e, "expired")
		reclaimed, e := short.Reclaim(ctx, principal, 32)
		if e != nil || reclaimed.Bytes != 8 || reclaimed.Reservations != 2 {
			t.Fatalf("expired reclaim: %+v %v", reclaimed, e)
		}
		_, e = short.Begin(ctx, principal, input)
		requireCode(e, "unknown")
		_, e = short.Reject(ctx, principal, a.ID)
		requireCode(e, "unknown")
	})
	t.Run("a gap cannot seal and metadata responses are paginated", func(t *testing.T) {
		a := begin(reserve("gap"))
		p0 := put(a, 0, "zero")
		p2 := put(a, 2, "two")
		h := publication.NewManifestHasher()
		h.Add(p0)
		h.Add(p2)
		_, e := store.Seal(ctx, principal, a.ID, h.Manifest())
		requireCode(e, "conflict")
		p1 := put(a, 1, "one")
		h = publication.NewManifestHasher()
		h.Add(p0)
		h.Add(p1)
		h.Add(p2)
		if _, e = store.Seal(ctx, principal, a.ID, h.Manifest()); e != nil {
			t.Fatal(e)
		}
		first, e := store.Status(ctx, principal, a.ID, -1, 1)
		if e != nil || len(first.Parts) != 1 || first.Parts[0].Ordinal != 0 {
			t.Fatalf("first page: %+v %v", first, e)
		}
		next, e := store.Status(ctx, principal, a.ID, 0, 1)
		if e != nil || len(next.Parts) != 1 || next.Parts[0].Ordinal != 1 {
			t.Fatalf("next page: %+v %v", next, e)
		}
		_, e = store.Status(ctx, principal, a.ID, -1, 101)
		requireCode(e, "invalid")
		limited := limits
		limited.Reservations = 1
		small, e := postgresadapter.NewPublicationStore(pool, limited)
		if e != nil {
			t.Fatal(e)
		}
		_, e = small.Reserve(ctx, principal, scope)
		requireCode(e, "capacity")
	})
	t.Run("storage work crossing the lease deadline rolls back", func(t *testing.T) {
		// Fault injection is at the real database boundary; assertions use only the
		// same publication Interface as callers, not private SQL call sequencing.
		shortLimits := limits
		shortLimits.LeaseLifetime = 100 * time.Millisecond
		short, e := postgresadapter.NewPublicationStore(pool, shortLimits)
		if e != nil {
			t.Fatal(e)
		}
		scoped := scope
		scoped.SourceSessionID = "slow-storage"
		r, e := short.Reserve(ctx, principal, scoped)
		if e != nil {
			t.Fatal(e)
		}
		a, e := short.Begin(ctx, principal, publication.Begin{ReservationID: r.ID, CaptureID: "slow", TransformVersion: "v1"})
		if e != nil {
			t.Fatal(e)
		}
		_, e = pool.Exec(ctx, `CREATE FUNCTION delay_publication_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$;
CREATE TRIGGER delay_publication_test BEFORE INSERT ON canonical_publication_parts FOR EACH ROW EXECUTE FUNCTION delay_publication_test();`)
		if e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256([]byte("delayed"))
		_, writeErr := short.Put(ctx, principal, a.ID, 0, hex.EncodeToString(sum[:]), []byte("delayed"))
		if _, e = pool.Exec(ctx, "DROP TRIGGER delay_publication_test ON canonical_publication_parts"); e != nil {
			t.Fatal(e)
		}
		requireCode(writeErr, "expired")
		page, e := short.Status(ctx, principal, a.ID, -1, 100)
		if e != nil || page.Attempt.Parts != 0 || page.Attempt.RetainedBytes != 0 || len(page.Parts) != 0 {
			t.Fatalf("expired write committed: %+v %v", page, e)
		}
		r, e = short.Reserve(ctx, principal, scoped)
		if e != nil {
			t.Fatal(e)
		}
		a, e = short.Begin(ctx, principal, publication.Begin{ReservationID: r.ID, CaptureID: "slow-seal", TransformVersion: "v1"})
		if e != nil {
			t.Fatal(e)
		}
		part, e := short.Put(ctx, principal, a.ID, 0, hex.EncodeToString(sum[:]), []byte("delayed"))
		if e != nil {
			t.Fatal(e)
		}
		h := publication.NewManifestHasher()
		h.Add(part)
		_, e = pool.Exec(ctx, `CREATE TRIGGER delay_publication_test BEFORE UPDATE ON canonical_publication_attempts FOR EACH ROW WHEN (NEW.state='sealed') EXECUTE FUNCTION delay_publication_test()`)
		if e != nil {
			t.Fatal(e)
		}
		_, sealErr := short.Seal(ctx, principal, a.ID, h.Manifest())
		if _, e = pool.Exec(ctx, "DROP TRIGGER delay_publication_test ON canonical_publication_attempts; DROP FUNCTION delay_publication_test()"); e != nil {
			t.Fatal(e)
		}
		requireCode(sealErr, "expired")
		page, e = short.Status(ctx, principal, a.ID, -1, 100)
		if e != nil || page.Attempt.Seal != nil {
			t.Fatalf("expired seal committed: %+v %v", page, e)
		}
	})
	t.Run("authorization precedes known receipt replay", func(t *testing.T) {
		a := begin(reserve("permission"))
		if _, e := pool.Exec(ctx, "UPDATE team_memberships SET status='removed',removed_at=clock_timestamp() WHERE team_id=$1 AND user_id=$2", canonicalcontract.TestTeamID, principal.UserID); e != nil {
			t.Fatal(e)
		}
		if _, e := store.Begin(ctx, principal, publication.Begin{ReservationID: a.ID, CaptureID: "capture", TransformVersion: "v1"}); e == nil {
			t.Fatal("revoked member read receipt")
		}
		if _, e := store.Status(ctx, principal, a.ID, -1, 1); e == nil {
			t.Fatal("revoked member read candidate")
		}
	})
}
