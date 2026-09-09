package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/adapters/rawchunks"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/teamoverview"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/SingleMai/ATape/server/internal/workspace"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	t.Run("overview supports the deployed Team volume and rejects incomplete totals", func(t *testing.T) {
		seedControlPlane(t, pool)
		created, err := ingestion.NewIngestor(store).ApplyBatch(ctx, canonicalcontract.CLIPrincipal(), canonicalcontract.ValidBatch())
		if err != nil {
			t.Fatal(err)
		}
		// Seed scale in the real persistence Adapter, then exercise the same
		// authorized Module Interface as the HTTP caller. Long bodies also cover
		// the bounded preview payload used by a normal conversation history.
		seedMessages := func(first, last int) {
			t.Helper()
			_, err := pool.Exec(ctx, `
INSERT INTO canonical_events (id,session_id,thread_id,source_key,revision,projection_revision,digest,
source_order,event_index,order_fidelity,fidelity,raw_ref,adapter_version,schema_version,
observed_at,received_at,ingest_seq,kind,author,occurred_at,text,tool_label)
SELECT 'volume-'||n,e.session_id,e.thread_id,'volume-'||n,1,1,e.digest,
n+2,0,e.order_fidelity,e.fidelity,e.raw_ref,e.adapter_version,e.schema_version,
e.observed_at,e.received_at,n+1000000,'message',
CASE WHEN n=60000 THEN 'Codex' ELSE e.author END,e.occurred_at,
CASE WHEN n=60000 THEN 'Intermediate sentence. Latest response.'
     WHEN n=59999 THEN 'Latest request.' ELSE repeat('Earlier conversation. ',100) END,''
FROM canonical_events e CROSS JOIN generate_series($2::integer,$3::integer) n
WHERE e.session_id=$1 AND e.source_order=1`, created.SessionID, first, last)
			if err != nil {
				t.Fatal(err)
			}
		}
		seedMessages(1, 60000)
		dashboard := teamoverview.New(store)
		query := teamoverview.Query{From: "2026-09-04", To: "2026-09-04"}
		started := time.Now()
		view, err := dashboard.Open(ctx, canonicalcontract.WebPrincipal(), canonicalcontract.TestTeamID, query)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("60,002-message Overview read: %s", time.Since(started))
		if view.Metrics.Messages != 60000 || view.Metrics.Sessions != 1 || view.Metrics.ActiveMembers != 1 || view.Previous.Messages != 0 || len(view.Sessions) != 1 {
			t.Fatalf("incomplete volume metrics: %+v", view.Metrics)
		}
		if view.Sessions[0].Input != "Latest request." || view.Sessions[0].Output != "Latest response." {
			t.Fatalf("incorrect latest preview: %+v", view.Sessions[0])
		}
		seedMessages(60001, canonical.OverviewFactLimit)
		if _, err = dashboard.Open(ctx, canonicalcontract.WebPrincipal(), canonicalcontract.TestTeamID, query); !errors.Is(err, canonical.ErrOverviewCapacity) {
			t.Fatalf("over-capacity read must reject partial totals: %v", err)
		}
		query.From, query.To = "2026-09-07", "2026-09-07"
		if empty, err := dashboard.Open(ctx, canonicalcontract.WebPrincipal(), canonicalcontract.TestTeamID, query); err != nil || empty.Metrics.Messages != 0 {
			t.Fatalf("shorter range should recover: %+v, %v", empty.Metrics, err)
		}
	})
	canonicalcontract.Run(t, func(t *testing.T) canonicalcontract.Store {
		if _, err := pool.Exec(context.Background(), `
TRUNCATE project_search_documents, project_search_checkpoints,
         raw_chunks, raw_generations, raw_objects,
         team_operation_receipts, team_project_repository_aliases,
         team_join_code_attempt_windows, team_join_codes, team_memberships,
         canonical_projection_changes, canonical_batch_receipts, canonical_event_versions, canonical_events,
         canonical_usage, canonical_threads, canonical_sessions, canonical_projects, workspace_teams`); err != nil {
			t.Fatalf("reset PostgreSQL contract state: %v", err)
		}
		seedControlPlane(t, pool)
		return store
	})

	t.Run("authoritative resource authorization", func(t *testing.T) {
		if _, err := pool.Exec(context.Background(), `
TRUNCATE project_search_documents, project_search_checkpoints,
         raw_chunks, raw_generations, raw_objects,
         team_operation_receipts, team_project_repository_aliases,
         team_join_code_attempt_windows, team_join_codes, team_memberships,
         canonical_projection_changes, canonical_batch_receipts, canonical_event_versions, canonical_events,
         canonical_usage, canonical_threads, canonical_sessions, canonical_projects, workspace_teams`); err != nil {
			t.Fatalf("reset authorization fixture: %v", err)
		}
		seedControlPlane(t, pool)
		const (
			bobID = "01991b70-4d2b-7c96-a532-5818faba2e72"
			eveID = "01991b70-4d2b-7c96-a532-5818faba2e73"
		)
		for _, user := range []struct{ id, name string }{{bobID, "Bob"}, {eveID, "Eve"}} {
			if _, err := pool.Exec(context.Background(), `
INSERT INTO auth_users (id, status, display_name)
VALUES ($1, 'active', $2)
ON CONFLICT (id) DO UPDATE SET status = 'active', disabled_at = NULL`, user.id, user.name); err != nil {
				t.Fatalf("seed %s: %v", user.name, err)
			}
		}
		if _, err := pool.Exec(context.Background(), `
INSERT INTO team_memberships (team_id, user_id, role, status)
VALUES ($1, $2, 'member', 'active')`, canonicalcontract.TestTeamID, bobID); err != nil {
			t.Fatalf("seed Bob Membership: %v", err)
		}
		if _, err := pool.Exec(context.Background(), `
INSERT INTO workspace_teams (id, slug, name, name_reported)
VALUES ('other-team', 'other-team', 'Other Team', TRUE)`); err != nil {
			t.Fatalf("seed Eve Team: %v", err)
		}
		if _, err := pool.Exec(context.Background(), `
INSERT INTO canonical_projects (id, team_id, name, project_type, repository_link_state)
VALUES ('other-project', 'other-team', 'other-project', 'directory', 'not_applicable')`); err != nil {
			t.Fatalf("seed Eve Project: %v", err)
		}
		if _, err := pool.Exec(context.Background(), `
INSERT INTO team_memberships (team_id, user_id, role, status)
VALUES ('other-team', $1, 'owner', 'active')`, eveID); err != nil {
			t.Fatalf("seed Eve Membership: %v", err)
		}

		aliceCLI := canonicalcontract.CLIPrincipal()
		aliceWeb := canonicalcontract.WebPrincipal()
		bobCLI := authentication.Principal{UserID: bobID, Method: authentication.CLIAuthentication}
		bobWeb := authentication.Principal{UserID: bobID, Method: authentication.WebAuthentication}
		eveWeb := authentication.Principal{UserID: eveID, Method: authentication.WebAuthentication}
		ingestor := ingestion.NewIngestor(store)
		created, err := ingestor.ApplyBatch(context.Background(), aliceCLI, canonicalcontract.ValidBatch())
		if err != nil {
			t.Fatalf("Alice ingest: %v", err)
		}
		projector := projectsearch.NewProjector(store, store)
		if _, err := projector.ProjectOnce(context.Background()); err != nil {
			t.Fatalf("project Search fixture: %v", err)
		}

		reader := conversation.NewMemory(store)
		if _, err := reader.OpenProject(context.Background(), bobWeb, canonicalcontract.TestProjectID); err != nil {
			t.Fatalf("same-Team Project read: %v", err)
		}
		if _, err := reader.OpenConversation(context.Background(), bobWeb, created.SessionID, "root"); err != nil {
			t.Fatalf("same-Team Conversation read: %v", err)
		}
		if _, err := projectsearch.NewSearcher(store).Search(
			context.Background(), bobWeb, canonicalcontract.TestProjectID, "durable key", "", 20,
		); err != nil {
			t.Fatalf("same-Team Search read: %v", err)
		}
		if _, err := reader.OpenProject(context.Background(), bobCLI, canonicalcontract.TestProjectID); !isAccessDenial(
			err, authorization.Forbid, authorization.CredentialCapabilityDenied,
		) {
			t.Fatalf("CLI Project-memory error = %v, want capability denial", err)
		}

		bobBatch := canonicalcontract.ValidBatch()
		bobBatch.BatchID = "bob-batch"
		bobBatch.Source.InstallationID = "bob-machine"
		bobBatch.Session.SourceSessionID = "bob-session"
		bobBatch.Session.Title = "Bob capture"
		bobCapture, err := ingestor.ApplyBatch(context.Background(), bobCLI, bobBatch)
		if err != nil || !bobCapture.SessionCreated {
			t.Fatalf("Member CLI ingest = %+v, %v", bobCapture, err)
		}

		chunks, err := rawchunks.NewFilesystem(t.TempDir())
		if err != nil {
			t.Fatalf("create Raw test storage: %v", err)
		}
		raw := rawarchive.NewArchive(store, chunks)
		aliceRaw, err := raw.Append(
			context.Background(), aliceCLI,
			rawUpload(created.SessionID, "alice-raw", 1, 0, true, "alice raw\n"),
		)
		if err != nil {
			t.Fatalf("Alice Raw ingest: %v", err)
		}
		// Both admission and commit honor a later policy change, while reads remain available.
		for _, policy := range []string{"force", "personal", "close"} {
			for _, preference := range []string{"enable", "disable"} {
				if _, err := pool.Exec(ctx, "UPDATE workspace_teams SET raw_capture_policy=$1 WHERE id=$2", policy, canonicalcontract.TestTeamID); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(ctx, "UPDATE auth_users SET raw_capture_preference=$1 WHERE id=$2", preference, canonicalcontract.TestUserID); err != nil {
					t.Fatal(err)
				}
				probe := rawarchive.ChunkRecord{SessionID: created.SessionID}
				err := store.AuthorizeChunk(ctx, aliceCLI, probe)
				enabled := policy == "force" || policy == "personal" && preference == "enable"
				var disabled *rawarchive.CaptureDisabledError
				if enabled && err != nil || !enabled && !errors.As(err, &disabled) {
					t.Fatalf("%s/%s admission: %v", policy, preference, err)
				}
				if !enabled {
					_, err = store.CommitChunk(ctx, aliceCLI, probe)
					if !errors.As(err, &disabled) {
						t.Fatalf("%s/%s commit: %v", policy, preference, err)
					}
					if _, err := raw.Read(ctx, aliceWeb, aliceRaw.ObjectID, 1, "", 8); err != nil {
						t.Fatalf("disabled Raw still readable: %v", err)
					}
				}
			}
		}
		if _, err := pool.Exec(ctx, "UPDATE workspace_teams SET raw_capture_policy='force' WHERE id=$1", canonicalcontract.TestTeamID); err != nil {
			t.Fatal(err)
		}
		if _, err := raw.OpenSession(context.Background(), bobWeb, created.SessionID); err != nil {
			t.Fatalf("same-Team Raw list: %v", err)
		}
		if _, err := raw.Read(context.Background(), bobWeb, aliceRaw.ObjectID, 1, "", 8); err != nil {
			t.Fatalf("same-Team Raw read: %v", err)
		}
		if _, err := raw.Append(
			context.Background(), bobCLI,
			rawUpload(created.SessionID, "bob-on-alice", 1, 0, true, "must not persist\n"),
		); !isAccessDenial(err, authorization.Forbid, authorization.MembershipRoleDenied) {
			t.Fatalf("other-User Raw append error = %v, want ownership denial", err)
		}

		for _, principal := range []authentication.Principal{eveWeb, authentication.Principal{}} {
			_, crossErr := reader.OpenProject(context.Background(), principal, canonicalcontract.TestProjectID)
			_, missingErr := reader.OpenProject(context.Background(), principal, "missing-project")
			var crossNotFound, missingNotFound *conversation.NotFoundError
			if !errors.As(crossErr, &crossNotFound) || !errors.As(missingErr, &missingNotFound) {
				t.Fatalf("conceal parity failed: cross=%v missing=%v", crossErr, missingErr)
			}
		}
		_, crossSearch := projectsearch.NewSearcher(store).Search(
			context.Background(), eveWeb, canonicalcontract.TestProjectID, "durable", "", 20,
		)
		_, missingSearch := projectsearch.NewSearcher(store).Search(
			context.Background(), eveWeb, "missing-project", "durable", "", 20,
		)
		if !isAccessDenial(crossSearch, authorization.Conceal, authorization.ResourceConcealed) ||
			!isAccessDenial(missingSearch, authorization.Conceal, authorization.ResourceConcealed) {
			t.Fatalf("Search conceal parity failed: cross=%v missing=%v", crossSearch, missingSearch)
		}
		_, crossRaw := raw.Read(context.Background(), eveWeb, aliceRaw.ObjectID, 1, "", 8)
		_, missingRaw := raw.Read(context.Background(), eveWeb, "missing-object", 1, "", 8)
		var crossRawNotFound, missingRawNotFound *rawarchive.NotFoundError
		if !errors.As(crossRaw, &crossRawNotFound) || !errors.As(missingRaw, &missingRawNotFound) {
			t.Fatalf("Raw conceal parity failed: cross=%v missing=%v", crossRaw, missingRaw)
		}

		beforeEvents := canonicalEventCount(t, pool)
		beforeSessionRevision := canonicalSessionRevision(t, pool, created.SessionID)
		mixed := canonicalcontract.ValidBatch()
		mixed.BatchID = "mixed-conflict"
		mixed.Session.Revision = 2
		mixed.Events = append([]ingestion.Event{{
			SourceEventID: "new-before-conflict", SourceThreadID: "provider-root",
			Revision: 1, ProjectionRevision: 1, SourceOrder: 3, EventIndex: 0,
			OrderFidelity: "native", Fidelity: "native",
			RawRef: ingestion.RawReference{Type: "unavailable", UnavailableReason: "test"},
			Kind:   "message", Author: "Alice", OccurredAt: "2026-09-04T11:00:00+08:00", Text: "must roll back",
		}}, mixed.Events...)
		mixed.Events[1].Text = "same revision, conflicting content"
		if _, err := ingestor.ApplyBatch(context.Background(), aliceCLI, mixed); err == nil {
			t.Fatal("mixed conflicting batch was accepted")
		}
		if after := canonicalEventCount(t, pool); after != beforeEvents {
			t.Fatalf("mixed batch changed Event count from %d to %d", beforeEvents, after)
		}
		if after := canonicalSessionRevision(t, pool, created.SessionID); after != beforeSessionRevision {
			t.Fatalf("mixed batch changed Session revision from %d to %d", beforeSessionRevision, after)
		}

		if _, err := pool.Exec(context.Background(), `
UPDATE team_memberships SET status = 'removed', removed_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE team_id = $1 AND user_id = $2`, canonicalcontract.TestTeamID, bobID); err != nil {
			t.Fatalf("remove Bob Membership: %v", err)
		}
		if _, err := ingestor.ApplyBatch(context.Background(), bobCLI, bobBatch); !isAccessDenial(
			err, authorization.Conceal, authorization.ResourceConcealed,
		) {
			t.Fatalf("removed Member replay error = %v, want Conceal", err)
		}
		aliceWorkspace, err := workspace.NewDirectory(store).Open(context.Background(), aliceWeb)
		if err != nil || len(aliceWorkspace.Teams) != 1 || aliceWorkspace.Teams[0].ID != canonicalcontract.TestTeamID {
			t.Fatalf("Alice filtered Workspace = %+v, %v", aliceWorkspace, err)
		}
		eveWorkspace, err := workspace.NewDirectory(store).Open(context.Background(), eveWeb)
		if err != nil || len(eveWorkspace.Teams) != 1 || eveWorkspace.Teams[0].ID != "other-team" {
			t.Fatalf("Eve filtered Workspace = %+v, %v", eveWorkspace, err)
		}

		if _, err := pool.Exec(context.Background(), `
UPDATE canonical_projects
SET state = 'archived', archived_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE id = $1`, canonicalcontract.TestProjectID); err != nil {
			t.Fatalf("archive Project: %v", err)
		}
		if _, err := ingestor.ApplyBatch(context.Background(), aliceCLI, canonicalcontract.ValidBatch()); err == nil {
			t.Fatal("archived Project accepted Canonical ingestion")
		} else {
			var state *canonical.ProjectStateError
			if !errors.As(err, &state) {
				t.Fatalf("archived Canonical error = %v, want ProjectStateError", err)
			}
		}
		if _, err := raw.Append(
			context.Background(), aliceCLI,
			rawUpload(created.SessionID, "archived-raw", 2, 0, true, "archived\n"),
		); err == nil {
			t.Fatal("archived Project accepted Raw ingestion")
		} else {
			var state *rawarchive.ProjectStateError
			if !errors.As(err, &state) {
				t.Fatalf("archived Raw error = %v, want ProjectStateError", err)
			}
		}
		if _, err := reader.OpenProject(context.Background(), aliceWeb, canonicalcontract.TestProjectID); err != nil {
			t.Fatalf("archived Project should remain readable: %v", err)
		}
	})

	if _, err := pool.Exec(context.Background(), `
TRUNCATE project_search_documents, project_search_checkpoints,
         raw_chunks, raw_generations, raw_objects,
         team_operation_receipts, team_project_repository_aliases,
         team_join_code_attempt_windows, team_join_codes, team_memberships,
         canonical_projection_changes, canonical_batch_receipts, canonical_event_versions, canonical_events,
         canonical_usage, canonical_threads, canonical_sessions, canonical_projects, workspace_teams`); err != nil {
		pool.Close()
		t.Fatalf("reset PostgreSQL restart state: %v", err)
	}
	seedControlPlane(t, pool)
	ingestor := ingestion.NewIngestor(store)
	created, err := ingestor.ApplyBatch(context.Background(), canonicalcontract.CLIPrincipal(), canonicalcontract.ValidBatch())
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
	page, err := projectsearch.NewSearcher(store).Search(context.Background(), canonicalcontract.WebPrincipal(), "payments-api", "durable key", "", 20)
	if err != nil {
		pool.Close()
		t.Fatalf("query PostgreSQL Search index: %v", err)
	}
	if len(page.Results) != 1 || page.Results[0].EventID == "" {
		pool.Close()
		t.Fatalf("unexpected PostgreSQL Search page: %+v", page)
	}
	if _, err := ingestor.ApplyBatch(context.Background(), canonicalcontract.CLIPrincipal(), canonicalcontract.UpdatedBatch()); err != nil {
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
	updatedPage, err := projectsearch.NewSearcher(store).Search(context.Background(), canonicalcontract.WebPrincipal(), "payments-api", "persisted before", "", 20)
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
	firstCommit, err := raw.Append(context.Background(), canonicalcontract.CLIPrincipal(), firstRaw)
	if err != nil {
		pool.Close()
		t.Fatalf("append first Raw chunk: %v", err)
	}
	rawObjectID := firstCommit.ObjectID
	// Reproduce an existing installation's 256 KiB constraint, then upgrade it
	// through the same Prepare Interface used by the executable.
	if _, err := pool.Exec(ctx, `ALTER TABLE raw_chunks DROP CONSTRAINT raw_chunks_size_bytes_check;
ALTER TABLE raw_chunks ADD CONSTRAINT raw_chunks_size_bytes_check CHECK (size_bytes >= 0 AND size_bytes <= 262144);
DELETE FROM atape_schema_migrations WHERE version = 12;`); err != nil {
		t.Fatal(err)
	}
	if err := postgresadapter.Prepare(ctx, pool); err != nil {
		t.Fatalf("upgrade existing Raw chunk capacity: %v", err)
	}
	if _, err := raw.Append(context.Background(), canonicalcontract.CLIPrincipal(), secondRaw); err != nil {
		pool.Close()
		t.Fatalf("append second Raw chunk: %v", err)
	}
	if replayed, err := raw.Append(context.Background(), canonicalcontract.CLIPrincipal(), secondRaw); err != nil || !replayed.Replayed {
		pool.Close()
		t.Fatalf("replay Raw chunk: %+v, %v", replayed, err)
	}
	if _, err := raw.Append(context.Background(), canonicalcontract.CLIPrincipal(), rawUpload(created.SessionID, "raw-chunk-3", 2, 0, true, "rewritten\n")); err != nil {
		pool.Close()
		t.Fatalf("start Raw generation: %v", err)
	}
	toolBatch := canonicalcontract.ValidBatch()
	toolBatch.BatchID, toolBatch.Session.SourceSessionID = "durable-tool", "durable-tool-session"
	toolBatch.Events[1].Kind = "tool_result"
	toolBatch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"durable-call","title":"Read","status":"completed","rawInput":null,"rawOutput":0.125}`
	toolCreated, err := ingestor.ApplyBatch(context.Background(), canonicalcontract.CLIPrincipal(), toolBatch)
	if err != nil {
		pool.Close()
		t.Fatal(err)
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
	toolOpened, err := conversation.NewMemory(reopenedStore).OpenConversation(context.Background(), canonicalcontract.WebPrincipal(), toolCreated.SessionID, "root")
	if err != nil || len(toolOpened.Events) != 2 || toolOpened.Events[1].Tool == nil || string(toolOpened.Events[1].Tool.RawOutput) != "0.125" {
		t.Fatalf("tool values after reopening database: %+v %v", toolOpened, err)
	}
	var persistedToolJSON string
	if err := reopenedPool.QueryRow(context.Background(), "SELECT tool_update_json FROM canonical_event_versions WHERE event_id = $1", toolOpened.Events[1].ID).Scan(&persistedToolJSON); err != nil || persistedToolJSON != toolBatch.Events[1].ToolUpdateJSON {
		t.Fatalf("tool version persistence: %q %v", persistedToolJSON, err)
	}
	reopenedChunks, err := rawchunks.NewFilesystem(rawDirectory)
	if err != nil {
		t.Fatalf("reopen Raw filesystem Adapter: %v", err)
	}
	reopenedRaw := rawarchive.NewArchive(reopenedStore, reopenedChunks)
	replayed, err := ingestion.NewIngestor(reopenedStore).ApplyBatch(context.Background(), canonicalcontract.CLIPrincipal(), canonicalcontract.ValidBatch())
	if err != nil {
		t.Fatalf("replay batch after restart: %v", err)
	}
	if !replayed.Replayed || replayed.SessionID != created.SessionID {
		t.Fatalf("unexpected replay after restart: %+v", replayed)
	}
	opened, err := conversation.NewMemory(reopenedStore).OpenConversation(context.Background(), canonicalcontract.WebPrincipal(), created.SessionID, "root")
	if err != nil {
		t.Fatalf("read conversation after restart: %v", err)
	}
	if got, want := len(opened.Events), 2; got != want {
		t.Fatalf("events after restart = %d, want %d", got, want)
	}
	persistedSearch, err := projectsearch.NewSearcher(reopenedStore).Search(context.Background(), canonicalcontract.WebPrincipal(), "payments-api", "persisted before", "", 20)
	if err != nil {
		t.Fatalf("read Search index after restart: %v", err)
	}
	if len(persistedSearch.Results) != 1 {
		t.Fatalf("Search documents after restart = %d, want 1", len(persistedSearch.Results))
	}
	listing, err := reopenedRaw.OpenSession(context.Background(), canonicalcontract.WebPrincipal(), created.SessionID)
	if err != nil {
		t.Fatalf("read Raw manifest after restart: %v", err)
	}
	if len(listing.Objects) != 1 || listing.Objects[0].CurrentGeneration != 2 || listing.Objects[0].GenerationCount != 2 {
		t.Fatalf("unexpected Raw manifest after restart: %+v", listing)
	}
	oldGeneration, err := reopenedRaw.Read(context.Background(), canonicalcontract.WebPrincipal(), rawObjectID, 1, "", 8)
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
	if got, want := migrationCount, 14; got != want {
		t.Fatalf("migration count = %d, want %d", got, want)
	}
	large := rawUpload(created.SessionID, "raw-capacity", 1, 0, true, strings.Repeat("x", rawarchive.MaxChunkBytes))
	large.SourceObjectID = "raw-capacity"
	if receipt, err := reopenedRaw.Append(ctx, canonicalcontract.CLIPrincipal(), large); err != nil || receipt.SizeBytes != rawarchive.MaxChunkBytes {
		t.Fatalf("append maximum Raw chunk after upgrade/restart: %+v %v", receipt, err)
	}
	if receipt, err := reopenedRaw.Append(ctx, canonicalcontract.CLIPrincipal(), large); err != nil || !receipt.Replayed {
		t.Fatalf("replay maximum Raw chunk: %+v %v", receipt, err)
	}
	oversized := rawUpload(created.SessionID, "raw-oversized", 1, 0, true, strings.Repeat("x", rawarchive.MaxChunkBytes+1))
	oversized.SourceObjectID = "raw-oversized"
	var validation *rawarchive.ValidationError
	if _, err := reopenedRaw.Append(ctx, canonicalcontract.CLIPrincipal(), oversized); !errors.As(err, &validation) {
		t.Fatalf("oversized Raw chunk error = %v, want ValidationError", err)
	}
}

func rawUpload(sessionID string, chunkID string, generation int64, offset int64, final bool, content string) rawarchive.UploadChunk {
	sum := sha256.Sum256([]byte(content))
	return rawarchive.UploadChunk{
		ProtocolVersion: rawarchive.ProtocolVersion, SourceChunkID: chunkID, SourceObjectID: "raw-restart",
		SessionID: sessionID, InstallationID: "integration-installation", Generation: generation, Offset: offset,
		SourceName: "session.jsonl", MediaType: "application/x-ndjson", AdapterID: "atape-adapter-test",
		AdapterVersion: "0.1.0", CapturedAt: "2026-09-04T11:31:00+08:00", ClientRedacted: true,
		Final: final, ContentBase64: base64.StdEncoding.EncodeToString([]byte(content)), SHA256: hex.EncodeToString(sum[:]),
	}
}

func seedControlPlane(t *testing.T, pool interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
INSERT INTO auth_users (id, status, display_name)
VALUES ($1, 'active', 'Contract user')
ON CONFLICT (id) DO UPDATE SET status = 'active', disabled_at = NULL
`, canonicalcontract.TestUserID); err != nil {
		t.Fatalf("seed authorization User: %v", err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO workspace_teams (id, slug, name, name_reported, raw_capture_policy)
VALUES ($1, 'acme-engineering', 'Acme Engineering', TRUE, 'force')
`, canonicalcontract.TestTeamID); err != nil {
		t.Fatalf("seed authorization Team: %v", err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO canonical_projects (id, team_id, name, project_type, repository_link_state)
VALUES ($1, $2, 'payments-api', 'git', 'linked')
`, canonicalcontract.TestProjectID, canonicalcontract.TestTeamID); err != nil {
		t.Fatalf("seed authorization Project: %v", err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO team_memberships (team_id, user_id, role, status)
VALUES ($1, $2, 'owner', 'active')
`, canonicalcontract.TestTeamID, canonicalcontract.TestUserID); err != nil {
		t.Fatalf("seed authorization Membership: %v", err)
	}
}

func isAccessDenial(err error, decision authorization.Decision, denial authorization.Denial) bool {
	var access *authorization.AccessError
	return errors.As(err, &access) && access.Decision == decision && access.Denial == denial
}

func canonicalEventCount(t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), "SELECT COUNT(*) FROM canonical_events").Scan(&count); err != nil {
		t.Fatalf("count Canonical Events: %v", err)
	}
	return count
}

func canonicalSessionRevision(t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, sessionID string) int64 {
	t.Helper()
	var revision int64
	if err := pool.QueryRow(
		context.Background(),
		"SELECT revision FROM canonical_sessions WHERE id = $1",
		sessionID,
	).Scan(&revision); err != nil {
		t.Fatalf("read Canonical Session revision: %v", err)
	}
	return revision
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
