package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

func TestPublicationValidation(t *testing.T) {
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("validation"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
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
	principal := canonicalcontract.CLIPrincipal()
	requireCode := func(err error, code string) {
		t.Helper()
		var failure *publication.Error
		if !errors.As(err, &failure) || failure.Code != code {
			t.Fatalf("wanted %s, got %v", code, err)
		}
	}
	parts := func(source string) []publication.CanonicalPart {
		batch := canonicalcontract.ValidBatch()
		batch.Session.SourceSessionID = source
		first := publication.CanonicalPart{Target: publication.Target{Profile: publication.TargetProfile, Events: 2, Threads: len(batch.Threads)}, Batch: batch}
		second := first
		first.Batch.Events = append(first.Batch.Events[:0:0], batch.Events[0])
		second.Batch.Events = append(second.Batch.Events[:0:0], batch.Events[1])
		second.Batch.BatchID = "part-1"
		return []publication.CanonicalPart{first, second}
	}
	stageWith := func(store *postgresadapter.PublicationStore, values []publication.CanonicalPart) publication.Attempt {
		t.Helper()
		b := values[0].Batch
		r, e := store.Reserve(ctx, principal, publication.Scope{ProjectID: b.ProjectID, InstallationID: b.Source.InstallationID, AdapterID: b.Source.AdapterID, SourceSessionID: b.Session.SourceSessionID, OriginKey: "origin"})
		if e != nil {
			t.Fatal(e)
		}
		a, e := store.Begin(ctx, principal, publication.Begin{ReservationID: r.ID, CaptureID: r.ID, TransformVersion: "v1"})
		if e != nil {
			t.Fatal(e)
		}
		manifest := publication.NewManifestHasher()
		for n, value := range values {
			body, e := json.Marshal(value)
			if e != nil {
				t.Fatal(e)
			}
			sum := sha256.Sum256(body)
			receipt, e := store.Put(ctx, principal, a.ID, n, hex.EncodeToString(sum[:]), body)
			if e != nil {
				t.Fatal(e)
			}
			manifest.Add(receipt)
		}
		a, e = store.Seal(ctx, principal, a.ID, manifest.Manifest())
		if e != nil {
			t.Fatal(e)
		}
		return a
	}
	stage := func(values []publication.CanonicalPart) publication.Attempt { return stageWith(store, values) }
	t.Run("bounded validation resumes after pool restart and never publishes", func(t *testing.T) {
		a := stage(parts("resume"))
		first, e := store.Validate(ctx, principal, a.ID)
		if e != nil || first.State != "validating" || first.ValidatedParts != 1 || first.CandidateEvents != 1 {
			t.Fatalf("first: %+v %v", first, e)
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
		final, e := restarted.Validate(ctx, principal, a.ID)
		if e != nil || final.State != "validated" || final.ValidatedParts != 2 || final.CandidateEvents != 2 {
			t.Fatalf("final: %+v %v", final, e)
		}
		replay, e := restarted.Validate(ctx, principal, a.ID)
		if e != nil || replay.ValidatedParts != 2 || replay.RetainedBytes != final.RetainedBytes {
			t.Fatalf("replay: %+v %v", replay, e)
		}
		project, found, e := postgresadapter.NewStore(pool).Project(ctx, canonicalcontract.WebPrincipal(), canonicalcontract.TestProjectID)
		if e != nil || !found || len(project.Sessions) != 0 {
			t.Fatalf("candidate visible: %+v %v", project, e)
		}
	})
	t.Run("duplicate membership and changed headers cannot become validated", func(t *testing.T) {
		values := parts("duplicate")
		values[1].Batch.Events = values[0].Batch.Events
		a := stage(values)
		if _, e := store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		_, e := store.Validate(ctx, principal, a.ID)
		requireCode(e, "invalid")
		status, e := store.Status(ctx, principal, a.ID, -1, 100)
		if e != nil || status.Attempt.ValidatedParts != 1 || status.Attempt.State != "validating" {
			t.Fatalf("bad progress: %+v %v", status, e)
		}
		values = parts("header")
		values[1].Batch.Session.Title = "different title"
		a = stage(values)
		if _, e = store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		_, e = store.Validate(ctx, principal, a.ID)
		requireCode(e, "invalid")
	})
	t.Run("declared membership must be complete and every part must retain source scope", func(t *testing.T) {
		values := parts("counts")
		values[0].Target.Events = 3
		values[1].Target.Events = 3
		a := stage(values)
		if _, e := store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		_, e := store.Validate(ctx, principal, a.ID)
		requireCode(e, "invalid")
		values = parts("scope")
		values[1].Batch.Source.InstallationID = "other-installation"
		a = stage(values)
		if _, e = store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		_, e = store.Validate(ctx, principal, a.ID)
		requireCode(e, "invalid")
	})
	t.Run("reusing source versions with changed meaning conflicts even after cleanup", func(t *testing.T) {
		values := parts("versions")
		a := stage(values)
		if _, e := store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		if _, e := store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		if _, e := store.Reject(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		if _, e := store.Reclaim(ctx, principal, 32); e != nil {
			t.Fatal(e)
		}
		values[0].Batch.Events[0].Text = "changed without a revision"
		a = stage(values)
		_, e := store.Validate(ctx, principal, a.ID)
		requireCode(e, "conflict")
		values[0].Batch.Events[0].Revision++
		a = stage(values)
		if _, e = store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		if _, e = store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("invalid topology and tool references fail before any progress", func(t *testing.T) {
		values := parts("topology")
		bad := "missing-parent"
		values[0].Batch.Threads = append(values[0].Batch.Threads[:0:0], values[0].Batch.Threads...)
		values[0].Batch.Threads[0].ParentSourceThreadID = &bad
		a := stage(values)
		_, e := store.Validate(ctx, principal, a.ID)
		requireCode(e, "invalid")
		status, e := store.Status(ctx, principal, a.ID, -1, 1)
		if e != nil || status.Attempt.ValidatedParts != 0 {
			t.Fatalf("invalid topology progressed: %+v %v", status, e)
		}
	})
	t.Run("event indices retain the existing 64 bit domain", func(t *testing.T) {
		values := parts("large-index")
		values[0].Batch.Events[0].EventIndex = 2147483648
		values[1].Batch.Events[0].EventIndex = 4294967296
		a := stage(values)
		if _, e := store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		final, e := store.Validate(ctx, principal, a.ID)
		if e != nil || final.State != "validated" {
			t.Fatalf("large indices: %+v %v", final, e)
		}
	})
	t.Run("normalization capacity failure preserves original receipt and recoverable progress", func(t *testing.T) {
		values := parts("normalization-budget")
		a := stage(values)
		body, e := json.Marshal(values[0])
		if e != nil {
			t.Fatal(e)
		}
		narrowLimits := limits
		narrowLimits.PartBytes = int64(len(body))
		narrow, e := postgresadapter.NewPublicationStore(pool, narrowLimits)
		if e != nil {
			t.Fatal(e)
		}
		_, e = narrow.Validate(ctx, principal, a.ID)
		requireCode(e, "capacity")
		status, e := store.Status(ctx, principal, a.ID, -1, 100)
		if e != nil || status.Attempt.ValidatedParts != 0 || status.Attempt.RetainedBytes != a.RetainedBytes {
			t.Fatalf("failed normalization changed candidate: %+v %v", status, e)
		}
		if _, e = store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		final, e := store.Validate(ctx, principal, a.ID)
		if e != nil || final.State != "validated" {
			t.Fatalf("resume: %+v %v", final, e)
		}
		sum := sha256.Sum256(body)
		receipt, e := store.Put(ctx, principal, a.ID, 0, hex.EncodeToString(sum[:]), body)
		if e != nil || receipt != status.Parts[0] {
			t.Fatalf("original receipt replay: %+v %v", receipt, e)
		}
		if _, e = store.Reject(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		if _, e = store.Reclaim(ctx, principal, 32); e != nil {
			t.Fatal(e)
		}
		status, e = store.Status(ctx, principal, a.ID, -1, 100)
		if e != nil || status.Attempt.RetainedBytes != 0 || len(status.Parts) != 0 {
			t.Fatalf("normalized bytes not reclaimed: %+v %v", status, e)
		}
	})
	t.Run("provenance upgrades retain the same semantic source versions", func(t *testing.T) {
		values := parts("provenance")
		a := stage(values)
		for range values {
			if _, e := store.Validate(ctx, principal, a.ID); e != nil {
				t.Fatal(e)
			}
		}
		for n := range values {
			values[n].Batch.Source.AdapterVersion = "0.2.0"
			values[n].Batch.ObservedAt = "2026-09-05T10:59:30+08:00"
		}
		a = stage(values)
		for range values {
			if _, e := store.Validate(ctx, principal, a.ID); e != nil {
				t.Fatal(e)
			}
		}
	})
	t.Run("child tools and usage validate together and changed topology needs a revision", func(t *testing.T) {
		values := parts("child-tools-usage")
		root, child := "provider-root", "child"
		tokens := int64(100)
		for n := range values {
			values[n].Batch.Threads = append(values[n].Batch.Threads[:0:0], values[n].Batch.Threads...)
			values[n].Batch.Threads = append(values[n].Batch.Threads, ingestion.Thread{SourceThreadID: child, ParentSourceThreadID: &root, Revision: 1, Label: "Worker", CaptureStatus: "healthy"})
			values[n].Target.Threads = 2
			values[n].Target.Usage = 1
		}
		values[0].Batch.Events[0].Kind = "spawn"
		values[0].Batch.Events[0].ChildSourceThreadID = &child
		values[1].Batch.Events[0].SourceThreadID = child
		values[1].Batch.Events[0].Kind = "tool_result"
		values[1].Batch.Events[0].ToolUpdateJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"call-1","title":"Read","status":"completed","rawOutput":"done"}`
		values[1].Batch.Usage = []ingestion.Usage{{SourceUsageID: "usage-1", SourceThreadID: child, Revision: 1, OccurredAt: values[1].Batch.Events[0].OccurredAt, Model: "model-a", InputTokens: &tokens}}
		a := stage(values)
		if _, e := store.Validate(ctx, principal, a.ID); e != nil {
			t.Fatal(e)
		}
		final, e := store.Validate(ctx, principal, a.ID)
		if e != nil || final.State != "validated" || final.CandidateUsage != 1 {
			t.Fatalf("child target: %+v %v", final, e)
		}
		for n := range values {
			values[n].Batch.Threads[1].Label = "Renamed worker"
		}
		a = stage(values)
		_, e = store.Validate(ctx, principal, a.ID)
		requireCode(e, "conflict")
		for n := range values {
			values[n].Batch.Threads[1].Revision++
		}
		a = stage(values)
		for range values {
			if _, e = store.Validate(ctx, principal, a.ID); e != nil {
				t.Fatal(e)
			}
		}
	})
	t.Run("lease expiry during normalization rolls back content progress and source bindings", func(t *testing.T) {
		shortLimits := limits
		shortLimits.LeaseLifetime = time.Second
		short, e := postgresadapter.NewPublicationStore(pool, shortLimits)
		if e != nil {
			t.Fatal(e)
		}
		values := parts("validation-expiry")
		a := stageWith(short, values)
		_, e = pool.Exec(ctx, `CREATE FUNCTION delay_validation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$;
CREATE TRIGGER delay_validation_test BEFORE UPDATE ON canonical_publication_parts FOR EACH ROW EXECUTE FUNCTION delay_validation_test();`)
		if e != nil {
			t.Fatal(e)
		}
		_, validationErr := short.Validate(ctx, principal, a.ID)
		if _, e = pool.Exec(ctx, "DROP TRIGGER delay_validation_test ON canonical_publication_parts; DROP FUNCTION delay_validation_test()"); e != nil {
			t.Fatal(e)
		}
		requireCode(validationErr, "expired")
		status, e := store.Status(ctx, principal, a.ID, -1, 100)
		if e != nil || status.Attempt.ValidatedParts != 0 || status.Attempt.RetainedBytes != a.RetainedBytes {
			t.Fatalf("expired normalization committed: %+v %v", status, e)
		}
		values[0].Batch.Events[0].Text = "uncommitted version can still be defined"
		a = stage(values)
		for range values {
			if _, e = store.Validate(ctx, principal, a.ID); e != nil {
				t.Fatal(e)
			}
		}
	})
	t.Run("superseded writers and revoked members cannot continue or replay validation", func(t *testing.T) {
		values := parts("validation-fence")
		old := stage(values)
		if _, e := store.Validate(ctx, principal, old.ID); e != nil {
			t.Fatal(e)
		}
		current := stage(values)
		_, e := store.Validate(ctx, principal, old.ID)
		requireCode(e, "superseded")
		for range values {
			if _, e = store.Validate(ctx, principal, current.ID); e != nil {
				t.Fatal(e)
			}
		}
		partial := stage(parts("validation-permission"))
		if _, e = store.Validate(ctx, principal, partial.ID); e != nil {
			t.Fatal(e)
		}
		if _, e = pool.Exec(ctx, "UPDATE team_memberships SET status='removed',removed_at=clock_timestamp() WHERE team_id=$1 AND user_id=$2", canonicalcontract.TestTeamID, principal.UserID); e != nil {
			t.Fatal(e)
		}
		for _, id := range []string{partial.ID, current.ID} {
			if _, e = store.Validate(ctx, principal, id); e == nil {
				t.Fatal("revoked member validated or read a known validation receipt")
			}
		}
	})
}
