package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
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

func TestPublicationLegacyAdoption(t *testing.T) {
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("adoption"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
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
	limits := publication.Limits{PartBytes: 1 << 20, TargetBytes: 8 << 20, UserPendingBytes: 16 << 20, Parts: 64, Reservations: 64, ReservationLifetime: 2 * time.Minute, LeaseLifetime: time.Minute}
	store, err := postgresadapter.NewPublicationStore(pool, limits)
	if err != nil {
		t.Fatal(err)
	}
	reader := postgresadapter.NewStore(pool)
	cli, web := canonicalcontract.CLIPrincipal(), canonicalcontract.WebPrincipal()
	legacy := canonicalcontract.ValidBatch()
	legacy.Session.SourceSessionID = "legacy-adoption"
	legacy.Session.Revision = 17
	root, child := "provider-root", "child"
	legacy.Threads[0].Revision = 19
	legacy.Threads = append(legacy.Threads, ingestion.Thread{SourceThreadID: child, ParentSourceThreadID: &root, Revision: 19, Label: "Retained worker", CaptureStatus: "healthy"})
	parent := legacy.Events[1]
	parent.SourceEventID = "delegate"
	parent.Kind = "spawn"
	parent.ToolLabel = "Agent"
	parent.ChildSourceThreadID = &child
	parent.Text = "Run worker"
	parent.SourceOrder = 3
	parent.ProjectionRevision = 23
	delegated := legacy.Events[1]
	delegated.SourceThreadID = child
	delegated.SourceEventID = "child-reply"
	delegated.Text = "retained-child-needle"
	delegated.SourceOrder = 1
	legacy.Events[1].Text = "abandoned-root-needle"
	legacy.Events = append(legacy.Events, parent, delegated)
	for n := 2; n <= 61; n++ {
		event := delegated
		event.SourceEventID = fmt.Sprintf("generated-child-reply-%03d", n)
		event.SourceOrder = int64(n)
		legacy.Events = append(legacy.Events, event)
	}
	legacy.Session.ReportedEventCount = len(legacy.Events)
	tokens := int64(7)
	legacy.Usage = []ingestion.Usage{{SourceUsageID: "child-api", SourceThreadID: child, Revision: 29, OccurredAt: delegated.OccurredAt, Model: "worker-model", InputTokens: &tokens}}
	writer := ingestion.NewIngestor(reader)
	initial, err := writer.ApplyBatch(ctx, cli, legacy)
	if err != nil {
		t.Fatal(err)
	}
	scope := publication.Scope{ProjectID: legacy.ProjectID, InstallationID: legacy.Source.InstallationID, AdapterID: legacy.Source.AdapterID, SourceSessionID: legacy.Session.SourceSessionID, OriginKey: "original-root"}
	requireCode := func(err error, code string) {
		t.Helper()
		var problem *publication.Error
		if !errors.As(err, &problem) || problem.Code != code {
			t.Fatalf("wanted %s: %v", code, err)
		}
	}
	index := func() {
		t.Helper()
		for {
			changes, e := reader.LeaseProjectionChanges(ctx, "adoption-indexer", 100, time.Now().Add(time.Minute))
			if e != nil {
				t.Fatal(e)
			}
			if len(changes) == 0 {
				return
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
			if e = reader.AckProjectionChanges(ctx, "adoption-indexer", ids); e != nil {
				t.Fatal(e)
			}
		}
	}
	search := func(term string) int {
		t.Helper()
		page, e := reader.SearchProjectionDocuments(ctx, web, projectsearch.IndexQuery{ProjectID: legacy.ProjectID, Term: term, Limit: 100})
		if e != nil {
			t.Fatal(e)
		}
		return len(page.Documents)
	}
	index()
	if _, err = store.Reserve(ctx, cli, scope); err == nil {
		t.Fatal("ordinary reservation adopted legacy")
	}
	if _, err = store.AdoptLegacy(ctx, web, scope); err == nil {
		t.Fatal("web principal adopted legacy")
	}
	adoption, err := store.AdoptLegacy(ctx, cli, scope)
	if err != nil {
		t.Fatal(err)
	}
	if adoption.SessionID != initial.SessionID || adoption.RevisionFloor != 29 || len(adoption.BaselineThreads) != 2 {
		t.Fatalf("adoption: %+v", adoption)
	}
	if !reflect.DeepEqual(adoption.BaselineThreads, legacy.Threads) {
		t.Fatalf("source-local baseline changed: %+v", adoption.BaselineThreads)
	}
	repeated, err := store.AdoptLegacy(ctx, cli, scope)
	if err != nil || repeated.RevisionFloor != 29 || !reflect.DeepEqual(repeated.BaselineThreads, adoption.BaselineThreads) {
		t.Fatalf("durable adoption retry: %+v %v", repeated, err)
	}
	wrong := scope
	wrong.OriginKey = "another-origin"
	_, err = store.AdoptLegacy(ctx, cli, wrong)
	requireCode(err, "conflict")
	if replay, e := writer.ApplyBatch(ctx, cli, legacy); e != nil || !replay.Replayed {
		t.Fatalf("legacy receipt replay: %+v %v", replay, e)
	}
	changed := legacy
	changed.BatchID = "fenced-new-write"
	changed.Session.Revision = 30
	if _, err = writer.ApplyBatch(ctx, cli, changed); err == nil {
		t.Fatal("new legacy write bypassed adoption fence")
	}
	baseline, found, err := reader.Conversation(ctx, web, initial.SessionID, "root")
	if err != nil || !found || len(baseline.Events) != 3 || baseline.Head != "" {
		t.Fatalf("staging changed legacy visibility: %+v %v", baseline, err)
	}
	var childID string
	for _, thread := range baseline.Threads {
		if thread.ParentThreadID != nil {
			childID = thread.ID
		}
	}
	oldChild, found, err := reader.Conversation(ctx, web, initial.SessionID, childID)
	if err != nil || !found || len(oldChild.Events) != 61 {
		t.Fatalf("old child: %+v %v", oldChild, err)
	}
	if search("abandoned-root-needle") != 1 || search("retained-child-needle") != 61 {
		t.Fatal("adoption hid legacy Search before activation")
	}
	fresh := legacy
	fresh.BatchID = "fresh-target"
	fresh.Session.Revision = 30
	fresh.Session.ReportedEventCount = 2
	fresh.Threads = append([]ingestion.Thread(nil), legacy.Threads...)
	for n := range fresh.Threads {
		fresh.Threads[n].Revision = 30
	}
	fresh.Events = []ingestion.Event{legacy.Events[0], parent}
	for n := range fresh.Events {
		fresh.Events[n].Revision = 30
		fresh.Events[n].ProjectionRevision = 30
		fresh.Events[n].RawRef = ingestion.RawReference{Type: "unavailable", UnavailableReason: "raw_disabled"}
	}
	fresh.Usage = []ingestion.Usage{}
	target := publication.Target{Profile: publication.RetentionTargetProfile, Events: 2, Usage: 0, Threads: 2, RetainedThreadIDs: []string{child}}
	stage := func(b ingestion.Batch, decl publication.Target, base string) publication.Attempt {
		t.Helper()
		r, e := store.Reserve(ctx, cli, scope)
		if e != nil {
			t.Fatal(e)
		}
		a, e := store.Begin(ctx, cli, publication.Begin{ReservationID: r.ID, CaptureID: r.ID, BaseHead: base, TransformVersion: "rewind-v2"})
		if e != nil {
			t.Fatal(e)
		}
		body, e := json.Marshal(publication.CanonicalPart{Target: decl, Batch: b})
		if e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256(body)
		part, e := store.Put(ctx, cli, a.ID, 0, hex.EncodeToString(sum[:]), body)
		if e != nil {
			t.Fatal(e)
		}
		manifest := publication.NewManifestHasher()
		manifest.Add(part)
		a, e = store.Seal(ctx, cli, a.ID, manifest.Manifest())
		if e != nil {
			t.Fatal(e)
		}
		return a
	}
	validate := func(a publication.Attempt) publication.Attempt {
		t.Helper()
		for n := 0; n < 20; n++ {
			var e error
			a, e = store.Validate(ctx, cli, a.ID)
			if e != nil {
				t.Fatal(e)
			}
			if a.State == "validated" {
				return a
			}
		}
		t.Fatal("retention did not complete")
		return a
	}
	a := stage(fresh, target, "")
	a, err = store.Validate(ctx, cli, a.ID)
	if err != nil || a.State != "validating" || a.CandidateEvents != 2 {
		t.Fatalf("explicit counts: %+v %v", a, err)
	}
	if search("abandoned-root-needle") != 1 {
		t.Fatal("preparation hid legacy Search")
	}
	a, err = store.Validate(ctx, cli, a.ID)
	if err != nil || a.State != "validating" || a.RetainedParts != 1 {
		t.Fatalf("bounded retention first unit: %+v %v", a, err)
	}
	reopenedPool, e := postgresadapter.NewPool(url)
	if e != nil {
		t.Fatal(e)
	}
	defer reopenedPool.Close()
	store, err = postgresadapter.NewPublicationStore(reopenedPool, limits)
	if err != nil {
		t.Fatal(err)
	}
	a = validate(a)
	page, err := store.Status(ctx, cli, a.ID, -1, 100)
	if err != nil || len(page.Parts) != 1 || page.Attempt.Parts != 1 || page.Attempt.ValidatedParts != 1 || page.Attempt.CandidateEvents != 2 || page.Attempt.CandidateUsage != 0 || page.Attempt.RetainedParts != 2 {
		t.Fatalf("derived units leaked into wire receipt: %+v %v", page, err)
	}
	head, err := store.Activate(ctx, cli, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	current, found, err := reader.Conversation(ctx, web, initial.SessionID, "root")
	if err != nil || !found || current.Head != head.Head || len(current.Events) != 2 || current.EventCounts[childID] != 61 {
		t.Fatalf("selected target: %+v %v", current, err)
	}
	inherited, found, err := reader.Conversation(ctx, web, initial.SessionID, childID)
	if err != nil || !found || !reflect.DeepEqual(inherited.Events, oldChild.Events) {
		t.Fatalf("retained Event versions/Raw/provenance changed: %+v %v", inherited, err)
	}
	project, found, err := reader.Project(ctx, web, legacy.ProjectID)
	if err != nil || !found || project.Sessions[0].EventCount != 63 || project.Sessions[0].Session.ReportedEventCount != 2 {
		t.Fatalf("selected honest counts: %+v %v", project, err)
	}
	if search("abandoned-root-needle") != 0 {
		t.Fatal("abandoned legacy Search survived activation")
	}
	index()
	if search("retained-child-needle") != 61 {
		t.Fatal("retained child Search not rebuilt")
	}
	overview, err := teamoverview.New(reader).Open(ctx, web, canonicalcontract.TestTeamID, teamoverview.Query{From: "2026-09-04", To: "2026-09-04"})
	if err != nil {
		t.Fatal(err)
	}
	if overview.Metrics.Messages != 1 || overview.Metrics.Tokens.Records != 1 || overview.Metrics.Tokens.Input == nil || *overview.Metrics.Tokens.Input != 7 || len(overview.Sessions) != 1 || overview.Sessions[0].Output != "" {
		t.Fatalf("selected Overview counted abandoned legacy membership: %+v", overview)
	}
	// A later snapshot retains from the immutable selected base after legacy data
	// has stopped being selected, and old candidate bodies may then be reclaimed.
	fresh.BatchID = "next-target"
	fresh.Session.Revision = 31
	for n := range fresh.Threads {
		fresh.Threads[n].Revision = 31
	}
	for n := range fresh.Events {
		fresh.Events[n].Revision = 31
		fresh.Events[n].ProjectionRevision = 31
	}
	next := validate(stage(fresh, target, head.Head))
	nextHead, err := store.Activate(ctx, cli, next.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Reclaim(ctx, cli, 32); err != nil {
		t.Fatal(err)
	}
	inherited, found, err = reader.Conversation(ctx, web, initial.SessionID, childID)
	if err != nil || !found || inherited.Head != nextHead.Head || !reflect.DeepEqual(inherited.Events, oldChild.Events) {
		t.Fatalf("retention after selected base reclamation: %+v %v", inherited, err)
	}
	// Removing the selected parent edge must reject retention rather than silently
	// keeping a child on an abandoned branch.
	fresh.BatchID = "removed-parent"
	fresh.Session.Revision = 32
	for n := range fresh.Threads {
		fresh.Threads[n].Revision = 32
	}
	fresh.Events = append([]ingestion.Event(nil), fresh.Events[:1]...)
	fresh.Session.ReportedEventCount = 1
	badTarget := target
	badTarget.Events = 1
	bad := stage(fresh, badTarget, nextHead.Head)
	_, err = store.Validate(ctx, cli, bad.ID)
	if err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 20; n++ {
		var step publication.Attempt
		step, err = store.Validate(ctx, cli, bad.ID)
		if err != nil {
			break
		}
		if step.State == "validated" {
			t.Fatal("missing parent edge activated retention")
		}
	}
	requireCode(err, "invalid")
	rootRetention := target
	rootRetention.RetainedThreadIDs = []string{root}
	bad = stage(fresh, rootRetention, nextHead.Head)
	_, err = store.Validate(ctx, cli, bad.ID)
	requireCode(err, "invalid")
	// Every declaration is checked through the caller's Validate operation.
	for _, test := range []struct {
		name   string
		mutate func(*ingestion.Batch, *publication.Target)
		code   string
	}{
		{"missing-v2-retention", func(b *ingestion.Batch, target *publication.Target) { target.RetainedThreadIDs = nil }, "invalid"},
		{"v1-cannot-retain", func(b *ingestion.Batch, target *publication.Target) { target.Profile = publication.TargetProfile }, "invalid"},
		{"duplicate-retention", func(b *ingestion.Batch, target *publication.Target) {
			target.RetainedThreadIDs = []string{child, child}
		}, "invalid"},
		{"unproved-child", func(b *ingestion.Batch, target *publication.Target) {
			target.RetainedThreadIDs = []string{"missing-child"}
		}, "invalid"},
		{"dishonest-explicit-count", func(b *ingestion.Batch, target *publication.Target) { b.Session.ReportedEventCount = 0 }, "invalid"},
		{"legacy-version-reuse", func(b *ingestion.Batch, target *publication.Target) { b.Session.Revision = adoption.RevisionFloor }, "conflict"},
		{"legacy-projection-reuse", func(b *ingestion.Batch, target *publication.Target) {
			b.Events[0].Revision = 100
			b.Events[0].ProjectionRevision = 1
		}, "conflict"},
		{"fresh-retained-member", func(b *ingestion.Batch, target *publication.Target) {
			event := delegated
			event.Revision = 100
			event.ProjectionRevision = 100
			b.Events = append(b.Events, event)
			b.Session.ReportedEventCount++
			target.Events++
		}, "invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			b := fresh
			b.Threads = append([]ingestion.Thread(nil), fresh.Threads...)
			b.Events = append([]ingestion.Event(nil), fresh.Events...)
			decl := badTarget
			decl.RetainedThreadIDs = append([]string(nil), badTarget.RetainedThreadIDs...)
			test.mutate(&b, &decl)
			candidate := stage(b, decl, nextHead.Head)
			_, e := store.Validate(ctx, cli, candidate.ID)
			requireCode(e, test.code)
		})
	}

}
