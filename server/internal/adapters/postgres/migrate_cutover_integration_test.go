package postgres

import (
	"context"
	"os"
	"os/exec"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestV011FixtureMigrationIsMappedAndPreservesIdentity(t *testing.T) {
	if testing.Short() || os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1 to run PostgreSQL integration tests")
	}
	configureCutoverDockerHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx,
		"postgres:17-alpine",
		postgrescontainer.WithDatabase("atape_test"),
		postgrescontainer.WithUsername("atape"),
		postgrescontainer.WithPassword("atape"),
		postgrescontainer.BasicWaitStrategies(),
		testcontainers.WithTmpfs(map[string]string{"/var/lib/postgresql/data": "rw"}),
	)
	if err != nil {
		t.Fatalf("start PostgreSQL container: %v", err)
	}
	testcontainers.CleanupContainer(t, container)
	databaseURL, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("PostgreSQL connection string: %v", err)
	}
	pool, err := NewPool(databaseURL)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	defer pool.Close()
	applyMigrationsThrough(t, pool, 4)
	seedV011Fixture(t, pool)

	if err := Prepare(ctx, pool); err != nil {
		t.Fatalf("upgrade v0.1.1 fixture: %v", err)
	}
	var migrationCount int
	var phase, installation string
	if err := pool.QueryRow(ctx, `
SELECT
    (SELECT COUNT(*) FROM atape_schema_migrations),
    (SELECT status FROM auth_cutover_ledger WHERE protocol_version = 'auth-v1'),
    (SELECT installation_kind FROM auth_cutover_ledger WHERE protocol_version = 'auth-v1')
`).Scan(&migrationCount, &phase, &installation); err != nil {
		t.Fatalf("read migration status: %v", err)
	}
	if migrationCount != 8 || phase != "prepared" || installation != "mapped" {
		t.Fatalf("upgraded ledger: migrations=%d phase=%s installation=%s", migrationCount, phase, installation)
	}

	var projectID, teamID, projectType, linkState string
	if err := pool.QueryRow(ctx, `
SELECT id, team_id, project_type, repository_link_state
FROM canonical_projects WHERE id = 'legacy-project'
`).Scan(&projectID, &teamID, &projectType, &linkState); err != nil {
		t.Fatalf("read migrated Project: %v", err)
	}
	if projectID != "legacy-project" || teamID != "legacy-team" || projectType != "git" || linkState != "unknown" {
		t.Fatalf("migrated Project = %q %q %q %q", projectID, teamID, projectType, linkState)
	}

	var sourceKey, digest, lineage string
	var capturedBy *string
	if err := pool.QueryRow(ctx, `
SELECT source_key, digest, capture_lineage, captured_by_user_id::text
FROM canonical_sessions WHERE id = 'legacy-session'
`).Scan(&sourceKey, &digest, &lineage, &capturedBy); err != nil {
		t.Fatalf("read migrated Session: %v", err)
	}
	if sourceKey != "v0.1/source/session" || digest != strings.Repeat("b", 64) ||
		lineage != "legacy_anonymous" || capturedBy != nil {
		t.Fatalf("migrated Session = source=%q digest=%q lineage=%q captured=%v", sourceKey, digest, lineage, capturedBy)
	}

	var rawObjects, searchDocuments int
	if err := pool.QueryRow(ctx, `
SELECT (SELECT COUNT(*) FROM raw_objects WHERE id = 'legacy-raw'),
       (SELECT COUNT(*) FROM project_search_documents WHERE event_id = 'legacy-event')
`).Scan(&rawObjects, &searchDocuments); err != nil {
		t.Fatalf("read migrated Raw/Search links: %v", err)
	}
	if rawObjects != 1 || searchDocuments != 1 {
		t.Fatalf("migrated Raw/Search counts = %d/%d", rawObjects, searchDocuments)
	}
}

func applyMigrationsThrough(t *testing.T, pool *pgxpool.Pool, maximum int64) {
	t.Helper()
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin legacy schema: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `
CREATE TABLE atape_schema_migrations (
    version BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
)`); err != nil {
		t.Fatalf("create legacy migration ledger: %v", err)
	}
	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	for _, entry := range entries {
		version, err := migrationVersion(entry.Name())
		if err != nil {
			t.Fatalf("parse migration: %v", err)
		}
		if version > maximum {
			continue
		}
		contents, err := migrationFiles.ReadFile("migrations/" + entry.Name())
		if err != nil {
			t.Fatalf("read migration %s: %v", entry.Name(), err)
		}
		if _, err := tx.Exec(ctx, string(contents), pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("apply migration %s: %v", entry.Name(), err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO atape_schema_migrations (version, name) VALUES ($1, $2)", version, entry.Name()); err != nil {
			t.Fatalf("record migration %s: %v", entry.Name(), err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy schema: %v", err)
	}
}

func seedV011Fixture(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
INSERT INTO workspace_teams (id, name, name_reported)
VALUES ('legacy-team', 'Legacy Team', TRUE);
INSERT INTO canonical_projects (id, team_id, name, project_type)
VALUES ('legacy-project', 'legacy-team', 'Legacy Project', 'git');
INSERT INTO canonical_sessions (
    id, project_id, source_key, revision, digest, title, summary, insight,
    actor_name, actor_harness, branch, status, capture_status, updated_at,
    reported_event_count
) VALUES (
    'legacy-session', 'legacy-project', 'v0.1/source/session', 1,
    repeat('b', 64), 'Legacy Session', '', '', 'Legacy', 'codex', '',
    'ended', 'complete', clock_timestamp(), 1
);
INSERT INTO raw_objects (
    id, project_id, session_id, source_name, media_type, adapter_id,
    adapter_version, captured_at, client_redacted, current_generation,
    generation_count
) VALUES (
    'legacy-raw', 'legacy-project', 'legacy-session', 'legacy.jsonl',
    'application/x-ndjson', 'legacy-adapter', '0.1.1', clock_timestamp(),
    TRUE, 1, 1
);
INSERT INTO project_search_documents (
    event_id, project_id, session_id, session_title, thread_id,
    thread_path_ids, thread_path_labels, author, harness, occurred_at,
    text, tool_label, ingest_seq, observed_at, search_text
) VALUES (
    'legacy-event', 'legacy-project', 'legacy-session', 'Legacy Session', 'root',
    ARRAY['root'], ARRAY['root'], 'Legacy', 'codex', clock_timestamp(),
    'legacy text', '', 1, clock_timestamp(), 'legacy text'
);`); err != nil {
		t.Fatalf("seed v0.1.1 fixture: %v", err)
	}
}

func configureCutoverDockerHost(t *testing.T) {
	t.Helper()
	if os.Getenv("DOCKER_HOST") != "" {
		return
	}
	output, err := exec.Command("docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}").Output()
	if err != nil {
		return
	}
	if host := strings.TrimSpace(string(output)); host != "" {
		t.Setenv("DOCKER_HOST", host)
	}
}
