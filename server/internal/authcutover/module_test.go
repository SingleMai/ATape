package authcutover

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/adapters/rawchunks"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

const (
	ownerOne = "01991b70-4d2b-7c96-a532-5818faba2e71"
	ownerTwo = "01991b70-4d2b-7c96-a532-5818faba2e72"
	disabled = "01991b70-4d2b-7c96-a532-5818faba2e73"
)

func TestMappingDigestIsCanonicalAndRejectsAmbiguity(t *testing.T) {
	left := Mapping{Protocol: MappingProtocol, Teams: []TeamMapping{
		{LegacyTeamID: "team-b", Slug: "team-b", OwnerUserIDs: []string{ownerTwo, ownerOne}},
		{LegacyTeamID: "team-a", Slug: "team-a", OwnerUserIDs: []string{ownerOne}},
	}}
	right := Mapping{Protocol: MappingProtocol, Teams: []TeamMapping{
		{LegacyTeamID: "team-a", Slug: "team-a", OwnerUserIDs: []string{ownerOne}},
		{LegacyTeamID: "team-b", Slug: "team-b", OwnerUserIDs: []string{strings.ToUpper(ownerOne), ownerTwo}},
	}}
	_, leftDigest, err := normalizeMapping(left)
	if err != nil {
		t.Fatalf("normalize left mapping: %v", err)
	}
	_, rightDigest, err := normalizeMapping(right)
	if err != nil {
		t.Fatalf("normalize right mapping: %v", err)
	}
	if leftDigest != rightDigest {
		t.Fatalf("canonical mapping digests differ: %s != %s", leftDigest, rightDigest)
	}

	invalid := []Mapping{
		{},
		{Protocol: MappingProtocol},
		{Protocol: MappingProtocol, Teams: []TeamMapping{{LegacyTeamID: "team-a", Slug: "Team-A", OwnerUserIDs: []string{ownerOne}}}},
		{Protocol: MappingProtocol, Teams: []TeamMapping{{LegacyTeamID: "team-a", Slug: "team-a", OwnerUserIDs: nil}}},
		{Protocol: MappingProtocol, Teams: []TeamMapping{
			{LegacyTeamID: "team-a", Slug: "team-a", OwnerUserIDs: []string{ownerOne}},
			{LegacyTeamID: "team-a", Slug: "other", OwnerUserIDs: []string{ownerTwo}},
		}},
	}
	for index, mapping := range invalid {
		if _, _, err := normalizeMapping(mapping); ErrorCodeOf(err) != CodeInvalidMapping {
			t.Fatalf("invalid mapping %d error = %v", index, err)
		}
	}
}

func TestMappedCutoverWorkflow(t *testing.T) {
	if testing.Short() || os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
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
	defer pool.Close()
	if err := postgresadapter.Prepare(ctx, pool); err != nil {
		t.Fatalf("prepare PostgreSQL: %v", err)
	}
	module, err := New(pool)
	if err != nil {
		t.Fatalf("construct Module: %v", err)
	}

	fresh, err := module.Status(ctx)
	if err != nil {
		t.Fatalf("read fresh status: %v", err)
	}
	if fresh.Installation != FreshInstallation || fresh.Phase != CompletedPhase || fresh.CompletedAt == nil {
		t.Fatalf("fresh migration status = %+v", fresh)
	}
	if _, err := module.Users(ctx); ErrorCodeOf(err) != CodeStateConflict {
		t.Fatalf("fresh User listing error = %v", err)
	}
	if _, err := module.PrepareBootstrap(ctx); ErrorCodeOf(err) != CodeStateConflict {
		t.Fatalf("fresh bootstrap error = %v", err)
	}

	seedMappedFixture(t, pool)
	bootstrap, err := module.PrepareBootstrap(ctx)
	if err != nil {
		t.Fatalf("enter bootstrap: %v", err)
	}
	if !bootstrap.Ready || bootstrap.Status.Phase != BootstrapPhase {
		t.Fatalf("bootstrap readiness = %+v", bootstrap)
	}
	if repeated, err := module.PrepareBootstrap(ctx); err != nil || !repeated.Ready {
		t.Fatalf("repeat bootstrap = %+v, %v", repeated, err)
	}
	seedBootstrapUsers(t, pool)
	users, err := module.Users(ctx)
	if err != nil {
		t.Fatalf("list Users: %v", err)
	}
	if len(users) != 3 || users[0].ID != ownerOne || len(users[0].ExternalIdentities) != 1 {
		t.Fatalf("bootstrap Users = %+v", users)
	}

	partial := Mapping{Protocol: MappingProtocol, Teams: []TeamMapping{
		{LegacyTeamID: "legacy-a", Slug: "alpha", OwnerUserIDs: []string{ownerOne}},
	}}
	partialPlan, err := module.Plan(ctx, partial)
	if err != nil {
		t.Fatalf("plan partial mapping: %v", err)
	}
	assertFinding(t, partialPlan, "missing_team")

	duplicateSlug := Mapping{Protocol: MappingProtocol, Teams: []TeamMapping{
		{LegacyTeamID: "legacy-a", Slug: "shared", OwnerUserIDs: []string{ownerOne}},
		{LegacyTeamID: "legacy-b", Slug: "shared", OwnerUserIDs: []string{ownerTwo}},
	}}
	duplicatePlan, err := module.Plan(ctx, duplicateSlug)
	if err != nil {
		t.Fatalf("plan duplicate slug: %v", err)
	}
	assertFinding(t, duplicatePlan, "duplicate_slug")

	invalidOwners := Mapping{Protocol: MappingProtocol, Teams: []TeamMapping{
		{LegacyTeamID: "legacy-a", Slug: "alpha", OwnerUserIDs: []string{disabled}},
		{LegacyTeamID: "legacy-b", Slug: "bravo", OwnerUserIDs: []string{"01991b70-4d2b-7c96-a532-5818faba2e79"}},
	}}
	invalidOwnerPlan, err := module.Plan(ctx, invalidOwners)
	if err != nil {
		t.Fatalf("plan invalid Owners: %v", err)
	}
	assertFinding(t, invalidOwnerPlan, "inactive_owner")
	assertFinding(t, invalidOwnerPlan, "unknown_owner")

	valid := Mapping{Protocol: MappingProtocol, Teams: []TeamMapping{
		{LegacyTeamID: "legacy-a", Slug: "alpha", OwnerUserIDs: []string{ownerOne}},
		{LegacyTeamID: "legacy-b", Slug: "bravo", OwnerUserIDs: []string{ownerTwo}},
	}}
	approved, err := module.Plan(ctx, valid)
	if err != nil || !approved.Applicable || len(approved.Findings) != 0 {
		t.Fatalf("valid plan = %+v, %v", approved, err)
	}
	if approved.Counts.Teams != 2 || approved.Counts.Projects != 2 ||
		approved.Counts.LegacySessions != 1 || approved.Counts.RawObjects != 1 ||
		approved.Counts.SearchDocuments != 1 {
		t.Fatalf("valid plan counts = %+v", approved.Counts)
	}
	tampered := approved
	tampered.Counts.Teams++
	if _, err := module.Apply(ctx, valid, tampered); ErrorCodeOf(err) != CodeInvalidPlan {
		t.Fatalf("tampered reviewed plan error = %v", err)
	}

	if _, err := pool.Exec(ctx, "UPDATE workspace_teams SET name = 'changed concurrently' WHERE id = 'legacy-a'"); err != nil {
		t.Fatalf("mutate after plan: %v", err)
	}
	if _, err := module.Apply(ctx, valid, approved); ErrorCodeOf(err) != CodePlanStale {
		t.Fatalf("stale apply error = %v", err)
	}
	approved, err = module.Plan(ctx, valid)
	if err != nil || !approved.Applicable {
		t.Fatalf("refresh plan = %+v, %v", approved, err)
	}

	installApplyFailure(t, pool)
	if _, err := module.Apply(ctx, valid, approved); ErrorCodeOf(err) != CodeUnavailable {
		t.Fatalf("injected apply failure = %v", err)
	}
	assertApplyRolledBack(t, pool)
	removeApplyFailure(t, pool)

	type applyOutcome struct {
		result ApplyResult
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan applyOutcome, 2)
	var applies sync.WaitGroup
	for range 2 {
		applies.Add(1)
		go func() {
			defer applies.Done()
			<-start
			result, err := module.Apply(ctx, valid, approved)
			outcomes <- applyOutcome{result: result, err: err}
		}()
	}
	close(start)
	applies.Wait()
	close(outcomes)
	applied, concurrentReplay := 0, 0
	var result ApplyResult
	for outcome := range outcomes {
		if outcome.err != nil {
			t.Fatalf("concurrent apply approved plan: %v", outcome.err)
		}
		result = outcome.result
		if outcome.result.AlreadyCompleted {
			concurrentReplay++
		} else {
			applied++
			if outcome.result.Status.Phase != CompletedPhase || outcome.result.AuditEvents != 3 {
				t.Fatalf("apply result = %+v", outcome.result)
			}
		}
	}
	if applied != 1 || concurrentReplay != 1 {
		t.Fatalf("concurrent apply outcomes: applied=%d replay=%d", applied, concurrentReplay)
	}
	assertMappedState(t, pool, result.MappingDigest)
	assertLegacyContentIsReadableButNotAppendable(t, pool)

	replayed, err := module.Apply(ctx, valid, approved)
	if err != nil || !replayed.AlreadyCompleted {
		t.Fatalf("replay apply = %+v, %v", replayed, err)
	}
	alternate := valid
	alternate.Teams = append([]TeamMapping(nil), valid.Teams...)
	alternate.Teams[0].Slug = "alternate"
	_, alternateDigest, err := normalizeMapping(alternate)
	if err != nil {
		t.Fatalf("normalize alternate mapping: %v", err)
	}
	alternatePlan := approved
	alternatePlan.MappingDigest = alternateDigest
	if _, err := module.Apply(ctx, alternate, alternatePlan); ErrorCodeOf(err) != CodeStateConflict {
		t.Fatalf("different completed mapping error = %v", err)
	}

	ready, err := module.PrepareNormal(ctx)
	if err != nil || !ready.Ready || ready.Status.NormalServingStartedAt == nil {
		t.Fatalf("normal readiness = %+v, %v", ready, err)
	}
	if _, err := module.PrepareBootstrap(ctx); ErrorCodeOf(err) != CodeStateConflict {
		t.Fatalf("completed bootstrap error = %v", err)
	}
}

func assertLegacyContentIsReadableButNotAppendable(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	store := postgresadapter.NewStore(pool)
	web := authentication.Principal{UserID: ownerOne, Method: authentication.WebAuthentication}
	project, err := conversation.NewMemory(store).OpenProject(t.Context(), web, "project-git")
	if err != nil || len(project.Trail) != 1 || project.Trail[0].ID != "legacy-session" {
		t.Fatalf("authorized legacy Project read = %+v, %v", project, err)
	}
	chunks, err := rawchunks.NewFilesystem(t.TempDir())
	if err != nil {
		t.Fatalf("construct legacy Raw test storage: %v", err)
	}
	archive := rawarchive.NewArchive(store, chunks)
	listing, err := archive.OpenSession(t.Context(), web, "legacy-session")
	if err != nil || len(listing.Objects) != 1 || listing.Objects[0].ObjectID != "legacy-raw" {
		t.Fatalf("authorized legacy Raw listing = %+v, %v", listing, err)
	}
	content := []byte("must not append to legacy capture\n")
	digest := sha256.Sum256(content)
	_, err = archive.Append(t.Context(), authentication.Principal{
		UserID: ownerOne, Method: authentication.CLIAuthentication,
	}, rawarchive.UploadChunk{
		ProtocolVersion: rawarchive.ProtocolVersion,
		SourceChunkID:   "legacy-append",
		SourceObjectID:  "legacy-new-object",
		SessionID:       "legacy-session",
		InstallationID:  "post-cutover-client",
		Generation:      1,
		Offset:          0,
		SourceName:      "legacy.jsonl",
		MediaType:       "application/x-ndjson",
		AdapterID:       "atape-adapter-codex",
		AdapterVersion:  "0.2.0",
		CapturedAt:      time.Now().UTC().Format(time.RFC3339),
		ClientRedacted:  true,
		Final:           true,
		ContentBase64:   base64.StdEncoding.EncodeToString(content),
		SHA256:          hex.EncodeToString(digest[:]),
	})
	var access *authorization.AccessError
	if !errors.As(err, &access) || access.Decision != authorization.Forbid ||
		access.Denial != authorization.MembershipRoleDenied {
		t.Fatalf("legacy Raw append error = %v, want ownership denial", err)
	}
	var chunksAfter int
	if err := pool.QueryRow(t.Context(), "SELECT COUNT(*) FROM raw_chunks").Scan(&chunksAfter); err != nil {
		t.Fatalf("count Raw chunks after legacy append: %v", err)
	}
	if chunksAfter != 0 {
		t.Fatalf("legacy append persisted %d Raw chunks", chunksAfter)
	}
}

func seedMappedFixture(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `
UPDATE auth_cutover_ledger
SET installation_kind = 'mapped', status = 'prepared', mapping_protocol = NULL,
    mapping_digest = NULL, snapshot_digest = NULL, snapshot_schema_version = NULL,
    bootstrap_at = NULL, completed_at = NULL, normal_serving_started_at = NULL,
    updated_at = clock_timestamp()
WHERE protocol_version = 'auth-v1';

INSERT INTO workspace_teams (id, slug, name, name_reported)
VALUES ('legacy-a', NULL, 'Legacy A', TRUE), ('legacy-b', NULL, 'Legacy B', TRUE);

INSERT INTO canonical_projects (
    id, team_id, name, project_type, repository_link_state
) VALUES
    ('project-git', 'legacy-a', 'Legacy Git', 'git', 'unknown'),
    ('project-folder', 'legacy-b', 'Legacy Folder', 'directory', 'not_applicable');

INSERT INTO canonical_sessions (
    id, project_id, source_key, revision, digest, title, summary, insight,
    actor_name, actor_harness, branch, status, capture_status, updated_at,
    reported_event_count, captured_by_user_id, record_state, capture_lineage
) VALUES (
    'legacy-session', 'project-git', 'legacy/source/session', 1,
    repeat('a', 64), 'Legacy session', '', '', 'Legacy', 'codex', '',
    'ended', 'complete', clock_timestamp(), 1, NULL, 'active', 'legacy_anonymous'
);

INSERT INTO raw_objects (
    id, project_id, session_id, source_name, media_type, adapter_id,
    adapter_version, captured_at, client_redacted, current_generation,
    generation_count
) VALUES (
    'legacy-raw', 'project-git', 'legacy-session', 'legacy.jsonl',
    'application/x-ndjson', 'legacy-adapter', '0.1.1', clock_timestamp(),
    TRUE, 1, 1
);

INSERT INTO raw_generations (object_id, generation, size_bytes, chunk_count, finalized)
VALUES ('legacy-raw', 1, 0, 0, TRUE);

INSERT INTO project_search_documents (
    event_id, project_id, session_id, session_title, thread_id,
    thread_path_ids, thread_path_labels, author, harness, occurred_at,
    text, tool_label, ingest_seq, observed_at, search_text
) VALUES (
    'legacy-event', 'project-git', 'legacy-session', 'Legacy session', 'root',
    ARRAY['root'], ARRAY['root'], 'Legacy', 'codex', clock_timestamp(),
    'legacy searchable text', '', 1, clock_timestamp(), 'legacy searchable text'
);`); err != nil {
		t.Fatalf("seed mapped fixture: %v", err)
	}
}

func seedBootstrapUsers(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
INSERT INTO auth_users (id, status, display_name, disabled_at)
VALUES
    ($1, 'active', 'Owner One', NULL),
    ($2, 'active', 'Owner Two', NULL),
    ($3, 'disabled', 'Disabled User', clock_timestamp())`, ownerOne, ownerTwo, disabled); err != nil {
		t.Fatalf("seed bootstrap Users: %v", err)
	}
	if _, err := pool.Exec(t.Context(), `
INSERT INTO auth_external_identities (
    id, user_id, issuer, subject, status, display_name
) VALUES (
    '01991b70-4d2b-7c96-a532-5818faba2e81', $1,
    'https://github.com', '1001', 'active', 'Owner One'
);`, ownerOne); err != nil {
		t.Fatalf("seed bootstrap identity: %v", err)
	}
}

func assertFinding(t *testing.T, plan Plan, code string) {
	t.Helper()
	if plan.Applicable {
		t.Fatalf("plan with %s finding is applicable: %+v", code, plan)
	}
	for _, finding := range plan.Findings {
		if finding.Code == code {
			return
		}
	}
	t.Fatalf("plan has no %s finding: %+v", code, plan.Findings)
}

func installApplyFailure(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
CREATE FUNCTION fail_auth_cutover_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'completed' THEN
        RAISE EXCEPTION 'injected cutover failure';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER fail_auth_cutover_completion
BEFORE UPDATE ON auth_cutover_ledger
FOR EACH ROW EXECUTE FUNCTION fail_auth_cutover_completion();`); err != nil {
		t.Fatalf("install apply failure: %v", err)
	}
}

func removeApplyFailure(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
DROP TRIGGER fail_auth_cutover_completion ON auth_cutover_ledger;
DROP FUNCTION fail_auth_cutover_completion();`); err != nil {
		t.Fatalf("remove apply failure: %v", err)
	}
}

func assertApplyRolledBack(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var slugs, memberships int
	var phase string
	if err := pool.QueryRow(t.Context(), `
SELECT
    (SELECT COUNT(*) FROM workspace_teams WHERE slug IS NOT NULL),
    (SELECT COUNT(*) FROM team_memberships),
    (SELECT status FROM auth_cutover_ledger WHERE protocol_version = 'auth-v1')
`).Scan(&slugs, &memberships, &phase); err != nil {
		t.Fatalf("read rollback state: %v", err)
	}
	if slugs != 0 || memberships != 0 || phase != "bootstrap" {
		t.Fatalf("partial apply survived: slugs=%d memberships=%d phase=%s", slugs, memberships, phase)
	}
}

func assertMappedState(t *testing.T, pool *pgxpool.Pool, mappingDigest string) {
	t.Helper()
	var teams, owners, legacySessions, linkedProjects, audits int
	var storedDigest string
	if err := pool.QueryRow(t.Context(), `
SELECT
    (SELECT COUNT(*) FROM workspace_teams WHERE slug IN ('alpha', 'bravo')),
    (SELECT COUNT(*) FROM team_memberships WHERE role = 'owner' AND status = 'active'),
    (SELECT COUNT(*) FROM canonical_sessions WHERE id = 'legacy-session'
        AND source_key = 'legacy/source/session' AND digest = repeat('a', 64)
        AND capture_lineage = 'legacy_anonymous' AND captured_by_user_id IS NULL),
    (SELECT COUNT(*) FROM canonical_projects WHERE repository_link_state = 'linked'),
    (SELECT COUNT(*) FROM security_audit_events WHERE action LIKE 'auth_cutover.%'),
    (SELECT mapping_digest FROM auth_cutover_ledger WHERE protocol_version = 'auth-v1')
`).Scan(&teams, &owners, &legacySessions, &linkedProjects, &audits, &storedDigest); err != nil {
		t.Fatalf("read mapped state: %v", err)
	}
	if teams != 2 || owners != 2 || legacySessions != 1 || linkedProjects != 0 ||
		audits != 4 || storedDigest != mappingDigest {
		t.Fatalf("mapped state: teams=%d owners=%d legacy=%d linked=%d audits=%d digest=%s",
			teams, owners, legacySessions, linkedProjects, audits, storedDigest)
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
	if host := strings.TrimSpace(string(output)); host != "" {
		t.Setenv("DOCKER_HOST", host)
	}
}
