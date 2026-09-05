package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/adapters/rawchunks"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestPostgresStoreContractAndRestartDurability(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1 to run PostgreSQL integration tests")
	}
	configureDockerHost(t)
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

	pool, err := postgresadapter.NewPool(databaseURL)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	if err := postgresadapter.Prepare(ctx, pool); err != nil {
		pool.Close()
		t.Fatalf("prepare PostgreSQL: %v", err)
	}
	store := postgresadapter.NewStore(pool)
	canonicalcontract.Run(t, func(t *testing.T) canonicalcontract.Store {
		if _, err := pool.Exec(context.Background(), `
TRUNCATE project_search_documents, project_search_checkpoints,
         raw_chunks, raw_generations, raw_objects,
         canonical_projection_changes, canonical_batch_receipts, canonical_event_versions, canonical_events,
         canonical_threads, canonical_sessions, canonical_projects, workspace_teams`); err != nil {
			t.Fatalf("reset PostgreSQL contract state: %v", err)
		}
		return store
	})

	if _, err := pool.Exec(context.Background(), `
TRUNCATE project_search_documents, project_search_checkpoints,
         raw_chunks, raw_generations, raw_objects,
         canonical_projection_changes, canonical_batch_receipts, canonical_event_versions, canonical_events,
         canonical_threads, canonical_sessions, canonical_projects, workspace_teams`); err != nil {
		pool.Close()
		t.Fatalf("reset PostgreSQL restart state: %v", err)
	}
	ingestor := ingestion.NewIngestor(store)
	created, err := ingestor.ApplyBatch(context.Background(), canonicalcontract.ValidBatch())
	if err != nil {
		pool.Close()
		t.Fatalf("apply batch before restart: %v", err)
	}
	projector := projectsearch.NewProjector(store, store)
	if count, err := projector.ProjectOnce(context.Background()); err != nil {
		pool.Close()
		t.Fatalf("project PostgreSQL Search documents: %v", err)
	} else if count != 2 {
		pool.Close()
		t.Fatalf("projected changes = %d, want 2", count)
	}
	page, err := projectsearch.NewSearcher(store).Search(context.Background(), "payments-api", "durable key", "", 20)
	if err != nil {
		pool.Close()
		t.Fatalf("query PostgreSQL Search index: %v", err)
	}
	if len(page.Results) != 1 || page.Results[0].EventID == "" {
		pool.Close()
		t.Fatalf("unexpected PostgreSQL Search page: %+v", page)
	}
	if _, err := ingestor.ApplyBatch(context.Background(), canonicalcontract.UpdatedBatch()); err != nil {
		pool.Close()
		t.Fatalf("apply Event update before restart: %v", err)
	}
	if count, err := projector.ProjectOnce(context.Background()); err != nil {
		pool.Close()
		t.Fatalf("project updated PostgreSQL Search document: %v", err)
	} else if count != 1 {
		pool.Close()
		t.Fatalf("updated projection changes = %d, want 1", count)
	}
	updatedPage, err := projectsearch.NewSearcher(store).Search(context.Background(), "payments-api", "persisted before", "", 20)
	if err != nil {
		pool.Close()
		t.Fatalf("query updated PostgreSQL Search index: %v", err)
	}
	if len(updatedPage.Results) != 1 {
		pool.Close()
		t.Fatalf("updated Event was not searchable exactly once: %+v", updatedPage)
	}
	rawDirectory := t.TempDir()
	chunkStore, err := rawchunks.NewFilesystem(rawDirectory)
	if err != nil {
		pool.Close()
		t.Fatalf("create Raw filesystem Adapter: %v", err)
	}
	raw := rawarchive.NewArchive(store, chunkStore)
	firstRaw := rawUpload(created.SessionID, "raw-chunk-1", 1, 0, false, "first\n")
	secondRaw := rawUpload(created.SessionID, "raw-chunk-2", 1, 6, true, "second\n")
	if _, err := raw.Append(context.Background(), firstRaw); err != nil {
		pool.Close()
		t.Fatalf("append first Raw chunk: %v", err)
	}
	if _, err := raw.Append(context.Background(), secondRaw); err != nil {
		pool.Close()
		t.Fatalf("append second Raw chunk: %v", err)
	}
	if replayed, err := raw.Append(context.Background(), secondRaw); err != nil || !replayed.Replayed {
		pool.Close()
		t.Fatalf("replay Raw chunk: %+v, %v", replayed, err)
	}
	if _, err := raw.Append(context.Background(), rawUpload(created.SessionID, "raw-chunk-3", 2, 0, true, "rewritten\n")); err != nil {
		pool.Close()
		t.Fatalf("start Raw generation: %v", err)
	}
	pool.Close()

	reopenedPool, err := postgresadapter.NewPool(databaseURL)
	if err != nil {
		t.Fatalf("reopen pool: %v", err)
	}
	t.Cleanup(reopenedPool.Close)
	if err := postgresadapter.Prepare(ctx, reopenedPool); err != nil {
		t.Fatalf("prepare reopened PostgreSQL: %v", err)
	}
	reopenedStore := postgresadapter.NewStore(reopenedPool)
	reopenedChunks, err := rawchunks.NewFilesystem(rawDirectory)
	if err != nil {
		t.Fatalf("reopen Raw filesystem Adapter: %v", err)
	}
	reopenedRaw := rawarchive.NewArchive(reopenedStore, reopenedChunks)
	replayed, err := ingestion.NewIngestor(reopenedStore).ApplyBatch(context.Background(), canonicalcontract.ValidBatch())
	if err != nil {
		t.Fatalf("replay batch after restart: %v", err)
	}
	if !replayed.Replayed || replayed.SessionID != created.SessionID {
		t.Fatalf("unexpected replay after restart: %+v", replayed)
	}
	opened, err := conversation.NewMemory(reopenedStore).OpenConversation(context.Background(), created.SessionID, "root")
	if err != nil {
		t.Fatalf("read conversation after restart: %v", err)
	}
	if got, want := len(opened.Events), 2; got != want {
		t.Fatalf("events after restart = %d, want %d", got, want)
	}
	persistedSearch, err := projectsearch.NewSearcher(reopenedStore).Search(context.Background(), "payments-api", "persisted before", "", 20)
	if err != nil {
		t.Fatalf("read Search index after restart: %v", err)
	}
	if len(persistedSearch.Results) != 1 {
		t.Fatalf("Search documents after restart = %d, want 1", len(persistedSearch.Results))
	}
	listing, err := reopenedRaw.OpenSession(context.Background(), created.SessionID)
	if err != nil {
		t.Fatalf("read Raw manifest after restart: %v", err)
	}
	if len(listing.Objects) != 1 || listing.Objects[0].CurrentGeneration != 2 || listing.Objects[0].GenerationCount != 2 {
		t.Fatalf("unexpected Raw manifest after restart: %+v", listing)
	}
	oldGeneration, err := reopenedRaw.Read(context.Background(), "raw-restart", 1, "", 8)
	if err != nil {
		t.Fatalf("read historical Raw generation after restart: %v", err)
	}
	var oldContent []byte
	for _, chunk := range oldGeneration.Chunks {
		decoded, decodeErr := base64.StdEncoding.DecodeString(chunk.ContentBase64)
		if decodeErr != nil {
			t.Fatalf("decode persisted Raw content: %v", decodeErr)
		}
		oldContent = append(oldContent, decoded...)
	}
	if got, want := string(oldContent), "first\nsecond\n"; got != want {
		t.Fatalf("historical Raw content = %q, want %q", got, want)
	}
	var rawChunkCount int
	if err := reopenedPool.QueryRow(context.Background(), "SELECT COUNT(*) FROM raw_chunks").Scan(&rawChunkCount); err != nil {
		t.Fatalf("count Raw chunks: %v", err)
	}
	if got, want := rawChunkCount, 3; got != want {
		t.Fatalf("Raw chunk records = %d, want %d", got, want)
	}
	var migrationCount int
	if err := reopenedPool.QueryRow(context.Background(), "SELECT COUNT(*) FROM atape_schema_migrations").Scan(&migrationCount); err != nil {
		t.Fatalf("read migration ledger: %v", err)
	}
	if got, want := migrationCount, 5; got != want {
		t.Fatalf("migration count = %d, want %d", got, want)
	}
}

func rawUpload(sessionID string, chunkID string, generation int64, offset int64, final bool, content string) rawarchive.UploadChunk {
	sum := sha256.Sum256([]byte(content))
	return rawarchive.UploadChunk{
		ProtocolVersion: rawarchive.ProtocolVersion, ChunkID: chunkID, ObjectID: "raw-restart",
		ProjectID: "payments-api", SessionID: sessionID, Generation: generation, Offset: offset,
		SourceName: "session.jsonl", MediaType: "application/x-ndjson", AdapterID: "atape-adapter-test",
		AdapterVersion: "0.1.0", CapturedAt: "2026-09-04T11:31:00+08:00", ClientRedacted: true,
		Final: final, ContentBase64: base64.StdEncoding.EncodeToString([]byte(content)), SHA256: hex.EncodeToString(sum[:]),
	}
}

func configureDockerHost(t *testing.T) {
	t.Helper()
	if os.Getenv("DOCKER_HOST") != "" {
		return
	}
	output, err := exec.Command("docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}").Output()
	if err != nil {
		return
	}
	host := strings.TrimSpace(string(output))
	if host == "" {
		return
	}
	t.Setenv("DOCKER_HOST", host)
}
