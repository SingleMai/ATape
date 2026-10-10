package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestLegacyZeroSourceClocksMigrateWithoutChangingAuthority(t *testing.T) {
	if testing.Short() || os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureCutoverDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	c, e := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("legacy_zero"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
	if e != nil {
		t.Fatal(e)
	}
	testcontainers.CleanupContainer(t, c)
	url, e := c.ConnectionString(ctx, "sslmode=disable")
	if e != nil {
		t.Fatal(e)
	}
	pool, e := NewPool(url)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	// The real predecessor schema still requires non-null source clocks. Existing
	// migration-fixture setup records only migrations 1..23 before public Prepare.
	applyMigrationsThrough(t, pool, 23)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, e := pool.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	exec(`INSERT INTO auth_users(id,status,display_name) VALUES($1,'active','Migration contract user')`, canonicalcontract.TestUserID)
	exec(`INSERT INTO workspace_teams(id,slug,name,name_reported,raw_capture_policy) VALUES($1,'zero-contract','Zero contract',true,'force')`, canonicalcontract.TestTeamID)
	exec(`INSERT INTO canonical_projects(id,team_id,name,project_type,repository_link_state) VALUES($1,$2,'Zero contract','git','linked')`, canonicalcontract.TestProjectID, canonicalcontract.TestTeamID)
	exec(`INSERT INTO team_memberships(team_id,user_id,role,status) VALUES($1,$2,'owner','active')`, canonicalcontract.TestTeamID, canonicalcontract.TestUserID)
	store := NewStore(pool)
	cli, web := canonicalcontract.CLIPrincipal(), canonicalcontract.WebPrincipal()
	b := canonicalcontract.ValidBatch()
	b.BatchID, b.Session.SourceSessionID = "legacy-zero-native", "legacy-zero-native"
	for n := range b.Events {
		b.Events[n].Text = "legacy-zero-pagination-needle"
	}
	created, e := ingestion.NewIngestor(store).ApplyBatch(ctx, cli, b)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = projectsearch.NewProjector(store, store).ProjectOnce(ctx); e != nil {
		t.Fatal(e)
	}
	// Seed the historical persisted shape: v1/v2 formerly admitted this timestamp,
	// and PostgreSQL also truncated a near-zero sub-microsecond clock to it. This
	// is a migration fixture, not a claim that current ingress accepts the value.
	exec(`UPDATE canonical_sessions SET updated_at='0001-01-01T00:00:00Z' WHERE id=$1`, created.SessionID)
	exec(`UPDATE canonical_events SET occurred_at='0001-01-01T00:00:00Z' WHERE session_id=$1`, created.SessionID)
	exec(`UPDATE canonical_event_versions SET occurred_at='0001-01-01T00:00:00Z' WHERE session_id=$1`, created.SessionID)
	exec(`UPDATE project_search_documents SET occurred_at='0001-01-01T00:00:00Z' WHERE session_id=$1`, created.SessionID)
	// A genuine validated v2 part supplies byte/authority preservation evidence.
	// Its known clocks and every immutable authority field remain untouched.
	pub := canonicalcontract.ValidBatch()
	pub.BatchID, pub.Session.SourceSessionID = "legacy-fixed-control", "legacy-fixed-control"
	pub.Events[0].OccurredAt = "1970-01-01T00:00:00Z"
	tokens := int64(7)
	pub.Usage = []ingestion.Usage{{SourceUsageID: "usage-clock-control", SourceThreadID: pub.Threads[0].SourceThreadID, Revision: 1, OccurredAt: "2026-09-04T10:00:00Z", Model: "control", InputTokens: &tokens}}
	writer, e := NewPublicationStore(pool, publication.Limits{PartBytes: 1 << 20, TargetBytes: 8 << 20, UserPendingBytes: 16 << 20, Parts: 16, Reservations: 64, ReservationLifetime: time.Minute, LeaseLifetime: 30 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	r, e := writer.Reserve(ctx, cli, publication.Scope{ProjectID: pub.ProjectID, InstallationID: pub.Source.InstallationID, AdapterID: pub.Source.AdapterID, SourceSessionID: pub.Session.SourceSessionID, OriginKey: "legacy-fixed-origin"})
	if e != nil {
		t.Fatal(e)
	}
	a, e := writer.Begin(ctx, cli, publication.Begin{ReservationID: r.ID, CaptureID: r.ID, TransformVersion: "legacy-v2-control"})
	if e != nil {
		t.Fatal(e)
	}
	body, e := json.Marshal(publication.CanonicalPart{Target: publication.Target{Profile: publication.RetentionTargetProfile, Events: len(pub.Events), Usage: len(pub.Usage), Threads: len(pub.Threads), RetainedThreadIDs: []string{}}, Batch: pub})
	if e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(body)
	receipt, e := writer.Put(ctx, cli, a.ID, 0, hex.EncodeToString(sum[:]), body)
	if e != nil {
		t.Fatal(e)
	}
	manifest := publication.NewManifestHasher()
	manifest.Add(receipt)
	if _, e = writer.Seal(ctx, cli, a.ID, manifest.Manifest()); e != nil {
		t.Fatal(e)
	}
	if _, e = writer.Validate(ctx, cli, a.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = writer.Activate(ctx, cli, a.ID); e != nil {
		t.Fatal(e)
	}
	// Materialized Overview rows are an independent read model. Include a legacy
	// exact-zero fact to check its normalization, beside an untouched 1970 fact.
	exec(`UPDATE overview_publication_messages SET occurred_at='0001-01-01T00:00:00Z' WHERE attempt_id=$1 AND entry_index=1`, a.ID)
	authority := func() []byte {
		t.Helper()
		var result []byte
		if e := pool.QueryRow(ctx, `SELECT convert_to(jsonb_build_object(
 'part', (SELECT to_jsonb(p) FROM canonical_publication_parts p WHERE attempt_id=$1 AND ordinal=0),
 'native', (SELECT jsonb_agg(jsonb_build_array(id,digest,observed_at,received_at) ORDER BY id) FROM canonical_events WHERE session_id=$2),
 'sessionDigest', (SELECT digest FROM canonical_sessions WHERE id=$2),
 'versions', (SELECT jsonb_agg(to_jsonb(v)-'occurred_at' ORDER BY event_id,projection_revision,revision) FROM canonical_event_versions v WHERE session_id=$2),
 'attempt', (SELECT to_jsonb(a) FROM canonical_publication_attempts a WHERE id=$1),
 'usage',(SELECT jsonb_agg(to_jsonb(u) ORDER BY source_key) FROM overview_publication_usage u WHERE attempt_id=$1)
 )::text,'UTF8')`, a.ID, created.SessionID).Scan(&result); e != nil {
			t.Fatal(e)
		}
		return result
	}
	before := authority()
	var nativeClocks, versionClocks, searchClocks int
	for q, dst := range map[string]*int{
		`SELECT count(*) FROM canonical_events WHERE session_id=$1 AND occurred_at='0001-01-01T00:00:00Z'`:         &nativeClocks,
		`SELECT count(*) FROM canonical_event_versions WHERE session_id=$1 AND occurred_at='0001-01-01T00:00:00Z'`: &versionClocks,
		`SELECT count(*) FROM project_search_documents WHERE session_id=$1 AND occurred_at='0001-01-01T00:00:00Z'`: &searchClocks,
	} {
		if e := pool.QueryRow(ctx, q, created.SessionID).Scan(dst); e != nil {
			t.Fatal(e)
		}
	}
	if nativeClocks != 2 || versionClocks != 2 || searchClocks != 2 {
		t.Fatalf("pre-upgrade fixture clock rows: %d %d %d", nativeClocks, versionClocks, searchClocks)
	}
	if e = Prepare(ctx, pool); e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(before, authority()) {
		t.Fatal("upgrade changed frozen part bytes, source digests or independent Usage/observation clocks")
	}
	var nullSession bool
	if e = pool.QueryRow(ctx, `SELECT updated_at IS NULL FROM canonical_sessions WHERE id=$1`, created.SessionID).Scan(&nullSession); e != nil || !nullSession {
		t.Fatalf("Session clock: %t %v", nullSession, e)
	}
	for _, table := range []string{"canonical_events", "canonical_event_versions", "project_search_documents", "overview_publication_messages"} {
		var count int
		if e = pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE occurred_at='0001-01-01T00:00:00Z'").Scan(&count); e != nil || count != 0 {
			t.Fatalf("remaining legacy zero in %s: %d %v", table, count, e)
		}
	}
	var sentinelCount int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM overview_publication_messages WHERE attempt_id=$1 AND occurred_at='1970-01-01T00:00:00Z'`, a.ID).Scan(&sentinelCount); e != nil || sentinelCount != 1 {
		t.Fatalf("1970 sentinel changed: %d %v", sentinelCount, e)
	}
	opened, e := conversation.NewMemory(store).OpenConversation(ctx, web, created.SessionID, "root")
	if e != nil || opened.Session.UpdatedAt != nil || len(opened.Events) != 2 || opened.Events[0].OccurredAt != nil || opened.Events[1].OccurredAt != nil {
		t.Fatalf("legacy nullable reader: %+v %v", opened, e)
	}
	searcher := projectsearch.NewSearcher(store)
	first, e := searcher.Search(ctx, web, b.ProjectID, "legacy-zero-pagination-needle", "", 1)
	if e != nil {
		t.Fatal(e)
	}
	second, e := searcher.Search(ctx, web, b.ProjectID, "legacy-zero-pagination-needle", first.NextCursor, 1)
	if e != nil {
		t.Fatal(e)
	}
	if len(first.Results) != 1 || len(second.Results) != 1 || first.Results[0].EventID == second.Results[0].EventID || first.Results[0].OccurredAt != nil || second.Results[0].OccurredAt != nil || first.NextCursor == "" || second.NextCursor != "" {
		t.Fatalf("legacy zero keyset skip: first=%+v second=%+v", first, second)
	}
	// Applying Prepare again is idempotent and preserves the exact first result.
	if e = Prepare(ctx, pool); e != nil {
		t.Fatal(e)
	}
	repeated, e := searcher.Search(ctx, web, b.ProjectID, "legacy-zero-pagination-needle", "", 1)
	if e != nil || !reflect.DeepEqual(repeated, first) {
		t.Fatalf("migration replay: %+v %v", repeated, e)
	}
}
