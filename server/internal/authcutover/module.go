package authcutover

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maintenanceLockID = int64(0x415461704375746f)

var slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// Module is the sole control surface for the one-time auth-v1 data cutover.
// Its public values are review artifacts; persistence state and mutation order
// remain private to this package.
type Module struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) (*Module, error) {
	if pool == nil {
		return nil, errors.New("auth cutover requires PostgreSQL")
	}
	return &Module{pool: pool}, nil
}

func (m *Module) Status(ctx context.Context) (Status, error) {
	status, err := readStatus(ctx, m.pool)
	if err != nil {
		return Status{}, unavailable("read status", err)
	}
	return status, nil
}

// PrepareBootstrap enters the explicit restricted serving phase. Repeating it
// is safe, but a fresh or completed installation cannot be downgraded into
// bootstrap mode.
func (m *Module) PrepareBootstrap(ctx context.Context) (Readiness, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return Readiness{}, unavailable("begin bootstrap transition", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", maintenanceLockID); err != nil {
		return Readiness{}, unavailable("lock bootstrap transition", err)
	}
	status, err := readStatusForUpdate(ctx, tx)
	if err != nil {
		return Readiness{}, unavailable("read bootstrap status", err)
	}
	switch {
	case status.Installation != MappedInstallation:
		return Readiness{}, domainError(CodeStateConflict)
	case status.Phase == PreparedPhase:
		if _, err := tx.Exec(ctx, `
UPDATE auth_cutover_ledger
SET status = 'bootstrap', bootstrap_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE protocol_version = $1 AND status = 'prepared'`, Protocol); err != nil {
			return Readiness{}, unavailable("enter bootstrap phase", err)
		}
		if err := insertAudit(ctx, tx, "auth_cutover.bootstrap", "cutover", Protocol, "bootstrap_started", map[string]any{
			"installation": MappedInstallation,
		}); err != nil {
			return Readiness{}, unavailable("audit bootstrap transition", err)
		}
	case status.Phase != BootstrapPhase:
		return Readiness{}, domainError(CodeStateConflict)
	}
	if err := tx.Commit(ctx); err != nil {
		return Readiness{}, unavailable("commit bootstrap transition", err)
	}
	return m.Readiness(ctx, BootstrapMode)
}

// PrepareNormal proves the durable cutover invariants before a normal listener
// starts. Recording normal serving is deliberately conservative: a rollback to
// an anonymous binary is unsupported once this succeeds, even if no request has
// arrived yet.
func (m *Module) PrepareNormal(ctx context.Context) (Readiness, error) {
	readiness, err := m.Readiness(ctx, NormalMode)
	if err != nil {
		return Readiness{}, err
	}
	if !readiness.Ready {
		return readiness, domainError(CodeNotReady)
	}
	command, err := m.pool.Exec(ctx, `
UPDATE auth_cutover_ledger
SET normal_serving_started_at = COALESCE(normal_serving_started_at, clock_timestamp()),
    updated_at = CASE WHEN normal_serving_started_at IS NULL THEN clock_timestamp() ELSE updated_at END
WHERE protocol_version = $1 AND status = 'completed'`, Protocol)
	if err != nil {
		return Readiness{}, unavailable("record normal serving", err)
	}
	if command.RowsAffected() != 1 {
		return Readiness{}, domainError(CodeStateConflict)
	}
	return m.Readiness(ctx, NormalMode)
}

func (m *Module) Readiness(ctx context.Context, mode ServingMode) (Readiness, error) {
	if mode != NormalMode && mode != BootstrapMode {
		return Readiness{}, domainError(CodeStateConflict)
	}
	tx, err := m.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Readiness{}, unavailable("begin readiness check", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	status, err := readStatus(ctx, tx)
	if err != nil {
		return Readiness{}, unavailable("read readiness status", err)
	}
	checks := make([]Finding, 0)
	if mode == BootstrapMode {
		if status.Installation != MappedInstallation || status.Phase != BootstrapPhase {
			checks = append(checks, Finding{Code: "bootstrap_phase_required", Detail: "the mapped installation is not in bootstrap phase"})
		}
	} else {
		if status.Phase != CompletedPhase {
			checks = append(checks, Finding{Code: "cutover_incomplete", Detail: "auth-v1 cutover is not complete"})
		}
		rows, queryErr := tx.Query(ctx, `
SELECT teams.id
FROM workspace_teams AS teams
WHERE teams.slug IS NULL OR NOT EXISTS (
    SELECT 1
    FROM team_memberships AS memberships
    JOIN auth_users AS users ON users.id = memberships.user_id
    WHERE memberships.team_id = teams.id
      AND memberships.role = 'owner'
      AND memberships.status = 'active'
      AND users.status = 'active'
)
ORDER BY teams.id`)
		if queryErr != nil {
			return Readiness{}, unavailable("check Team ownership", queryErr)
		}
		for rows.Next() {
			var teamID string
			if err := rows.Scan(&teamID); err != nil {
				rows.Close()
				return Readiness{}, unavailable("scan Team ownership", err)
			}
			checks = append(checks, Finding{Code: "team_not_ready", Field: "teams." + teamID, Detail: "Team requires a slug and an active Owner"})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return Readiness{}, unavailable("list Team ownership", err)
		}
		rows.Close()
	}
	if err := tx.Commit(ctx); err != nil {
		return Readiness{}, unavailable("commit readiness check", err)
	}
	return Readiness{Ready: len(checks) == 0, Mode: mode, Status: status, Checks: checks}, nil
}

func (m *Module) Users(ctx context.Context) ([]User, error) {
	tx, err := m.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, unavailable("begin bootstrap User listing", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	status, err := readStatus(ctx, tx)
	if err != nil {
		return nil, unavailable("read bootstrap User listing status", err)
	}
	if status.Installation != MappedInstallation || status.Phase != BootstrapPhase {
		return nil, domainError(CodeStateConflict)
	}
	rows, err := tx.Query(ctx, `
SELECT users.id::text, users.status, users.display_name,
       identities.issuer, identities.subject, identities.status,
       identities.last_verified_at
FROM auth_users AS users
LEFT JOIN auth_external_identities AS identities ON identities.user_id = users.id
ORDER BY users.created_at, users.id, identities.created_at, identities.id`)
	if err != nil {
		return nil, unavailable("list bootstrap Users", err)
	}
	defer rows.Close()
	result := make([]User, 0)
	indexes := make(map[string]int)
	for rows.Next() {
		var id, status, displayName string
		var issuer, subject, identityStatus *string
		var lastVerifiedAt *time.Time
		if err := rows.Scan(&id, &status, &displayName, &issuer, &subject, &identityStatus, &lastVerifiedAt); err != nil {
			return nil, unavailable("scan bootstrap Users", err)
		}
		index, exists := indexes[id]
		if !exists {
			index = len(result)
			indexes[id] = index
			result = append(result, User{ID: id, Status: status, DisplayName: displayName, ExternalIdentities: []ExternalIdentity{}})
		}
		if issuer != nil && subject != nil && identityStatus != nil && lastVerifiedAt != nil {
			result[index].ExternalIdentities = append(result[index].ExternalIdentities, ExternalIdentity{
				Issuer: *issuer, Subject: *subject, Status: *identityStatus, LastVerifiedAt: *lastVerifiedAt,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, unavailable("list bootstrap Users", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, unavailable("commit bootstrap User listing", err)
	}
	return result, nil
}

func (m *Module) Plan(ctx context.Context, mapping Mapping) (Plan, error) {
	canonical, mappingDigest, err := normalizeMapping(mapping)
	if err != nil {
		return Plan{}, err
	}
	tx, err := m.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Plan{}, unavailable("begin cutover plan", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	status, err := readStatus(ctx, tx)
	if err != nil {
		return Plan{}, unavailable("read cutover plan status", err)
	}
	if status.Installation != MappedInstallation || status.Phase != BootstrapPhase {
		return Plan{}, domainError(CodeStateConflict)
	}
	snapshot, err := takeSnapshot(ctx, tx)
	if err != nil {
		return Plan{}, unavailable("take cutover snapshot", err)
	}
	plan, err := buildPlan(ctx, tx, canonical, mappingDigest, snapshot)
	if err != nil {
		return Plan{}, unavailable("evaluate cutover mapping", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Plan{}, unavailable("commit cutover plan read", err)
	}
	return plan, nil
}

func (m *Module) Apply(ctx context.Context, mapping Mapping, approved Plan) (ApplyResult, error) {
	canonical, mappingDigest, err := normalizeMapping(mapping)
	if err != nil {
		return ApplyResult{}, err
	}
	if approved.Protocol != PlanProtocol || approved.MappingDigest != mappingDigest ||
		approved.SnapshotDigest == "" || approved.SnapshotSchemaVersion < 1 || !approved.Applicable ||
		approved.GeneratedAt.IsZero() || len(approved.Findings) != 0 {
		return ApplyResult{}, domainError(CodeInvalidPlan)
	}
	// The advisory lock serializes cutover writers before the status read, and
	// the explicit table locks below freeze the reviewed relations before the
	// snapshot is retaken. Read Committed is deliberate: a concurrent waiter
	// must observe the first committer's completed state and return a safe replay
	// instead of retaining a pre-lock Serializable snapshot.
	tx, err := m.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ApplyResult{}, unavailable("begin cutover apply", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", maintenanceLockID); err != nil {
		return ApplyResult{}, unavailable("lock cutover apply", err)
	}
	status, err := readStatusForUpdate(ctx, tx)
	if err != nil {
		return ApplyResult{}, unavailable("read cutover apply status", err)
	}
	if status.Phase == CompletedPhase {
		if status.Installation == MappedInstallation && status.MappingDigest == mappingDigest {
			return ApplyResult{Status: status, MappingDigest: mappingDigest, AlreadyCompleted: true}, nil
		}
		return ApplyResult{}, domainError(CodeStateConflict)
	}
	if status.Installation != MappedInstallation || status.Phase != BootstrapPhase {
		return ApplyResult{}, domainError(CodeStateConflict)
	}
	if _, err := tx.Exec(ctx, `
LOCK TABLE atape_schema_migrations, auth_cutover_ledger, auth_users,
    auth_external_identities, workspace_teams, team_memberships,
    canonical_projects, team_project_repository_aliases, canonical_sessions,
    canonical_threads, canonical_events, canonical_event_versions,
    canonical_batch_receipts, canonical_projection_changes,
    project_search_documents, project_search_checkpoints,
    raw_objects, raw_generations, raw_chunks
IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return ApplyResult{}, unavailable("lock cutover data", err)
	}
	snapshot, err := takeSnapshot(ctx, tx)
	if err != nil {
		return ApplyResult{}, unavailable("retake cutover snapshot", err)
	}
	if snapshot.digest != approved.SnapshotDigest || snapshot.schemaVersion != approved.SnapshotSchemaVersion {
		return ApplyResult{}, domainError(CodePlanStale)
	}
	plan, err := buildPlan(ctx, tx, canonical, mappingDigest, snapshot)
	if err != nil {
		return ApplyResult{}, unavailable("revalidate cutover mapping", err)
	}
	if !plan.Applicable || len(plan.Findings) != 0 {
		return ApplyResult{}, domainError(CodePlanNotApplicable)
	}
	if !sameReviewedPlan(approved, plan) {
		return ApplyResult{}, domainError(CodeInvalidPlan)
	}
	if _, err := tx.Exec(ctx, "UPDATE workspace_teams SET slug = NULL, updated_at = clock_timestamp()"); err != nil {
		return ApplyResult{}, unavailable("clear legacy Team slugs", err)
	}
	for _, team := range canonical.Teams {
		command, err := tx.Exec(ctx, `
UPDATE workspace_teams
SET slug = $2, updated_at = clock_timestamp()
WHERE id = $1`, team.LegacyTeamID, team.Slug)
		if err != nil {
			return ApplyResult{}, unavailable("assign Team slug", err)
		}
		if command.RowsAffected() != 1 {
			return ApplyResult{}, domainError(CodePlanNotApplicable)
		}
		for _, ownerID := range team.OwnerUserIDs {
			if _, err := tx.Exec(ctx, `
INSERT INTO team_memberships (team_id, user_id, role, status)
VALUES ($1, $2::uuid, 'owner', 'active')
ON CONFLICT (team_id, user_id) DO UPDATE
SET role = 'owner', status = 'active', removed_at = NULL,
    updated_at = clock_timestamp()`, team.LegacyTeamID, ownerID); err != nil {
				return ApplyResult{}, unavailable("assign Team Owner", err)
			}
		}
		if err := insertAudit(ctx, tx, "auth_cutover.assign_owners", "team", team.LegacyTeamID, "mapped_owner_assignment", map[string]any{
			"slug": team.Slug, "ownerCount": len(team.OwnerUserIDs), "mappingDigest": mappingDigest,
		}); err != nil {
			return ApplyResult{}, unavailable("audit Team Owner assignment", err)
		}
	}
	if err := insertAudit(ctx, tx, "auth_cutover.complete", "cutover", Protocol, "mapped_cutover_complete", map[string]any{
		"mappingDigest": mappingDigest, "snapshotDigest": snapshot.digest,
		"teams": snapshot.counts.Teams, "projects": snapshot.counts.Projects,
		"legacySessions": snapshot.counts.LegacySessions,
	}); err != nil {
		return ApplyResult{}, unavailable("audit cutover completion", err)
	}
	command, err := tx.Exec(ctx, `
UPDATE auth_cutover_ledger
SET status = 'completed', mapping_protocol = $2, mapping_digest = $3,
    snapshot_digest = $4, snapshot_schema_version = $5,
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE protocol_version = $1 AND status = 'bootstrap'`,
		Protocol, MappingProtocol, mappingDigest, snapshot.digest, snapshot.schemaVersion)
	if err != nil {
		return ApplyResult{}, unavailable("complete cutover ledger", err)
	}
	if command.RowsAffected() != 1 {
		return ApplyResult{}, domainError(CodeStateConflict)
	}
	if err := tx.Commit(ctx); err != nil {
		return ApplyResult{}, unavailable("commit cutover apply", err)
	}
	completed, err := m.Status(ctx)
	if err != nil {
		return ApplyResult{}, err
	}
	return ApplyResult{
		Status: completed, MappingDigest: mappingDigest,
		AuditEvents: len(canonical.Teams) + 1,
	}, nil
}

func sameReviewedPlan(approved, current Plan) bool {
	if approved.Counts != current.Counts || approved.AuditEvents != current.AuditEvents ||
		len(approved.Changes) != len(current.Changes) {
		return false
	}
	for index, change := range approved.Changes {
		candidate := current.Changes[index]
		if change.LegacyTeamID != candidate.LegacyTeamID ||
			change.CurrentSlug != candidate.CurrentSlug || change.Slug != candidate.Slug ||
			len(change.OwnerUserIDs) != len(candidate.OwnerUserIDs) {
			return false
		}
		for ownerIndex, ownerID := range change.OwnerUserIDs {
			if ownerID != candidate.OwnerUserIDs[ownerIndex] {
				return false
			}
		}
	}
	return true
}

type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readStatus(ctx context.Context, database queryer) (Status, error) {
	return scanStatus(database.QueryRow(ctx, `
SELECT protocol_version, status, installation_kind, mapping_digest,
       snapshot_digest, snapshot_schema_version, prepared_at, bootstrap_at,
       completed_at, normal_serving_started_at
FROM auth_cutover_ledger
WHERE protocol_version = $1`, Protocol))
}

func readStatusForUpdate(ctx context.Context, tx pgx.Tx) (Status, error) {
	return scanStatus(tx.QueryRow(ctx, `
SELECT protocol_version, status, installation_kind, mapping_digest,
       snapshot_digest, snapshot_schema_version, prepared_at, bootstrap_at,
       completed_at, normal_serving_started_at
FROM auth_cutover_ledger
WHERE protocol_version = $1
FOR UPDATE`, Protocol))
}

func scanStatus(row pgx.Row) (Status, error) {
	var result Status
	var phase, installation string
	var mappingDigest, snapshotDigest *string
	var schemaVersion *int64
	if err := row.Scan(
		&result.Protocol, &phase, &installation, &mappingDigest, &snapshotDigest,
		&schemaVersion, &result.PreparedAt, &result.BootstrapAt,
		&result.CompletedAt, &result.NormalServingStartedAt,
	); err != nil {
		return Status{}, err
	}
	result.Phase = Phase(phase)
	result.Installation = InstallationKind(installation)
	if mappingDigest != nil {
		result.MappingDigest = *mappingDigest
	}
	if snapshotDigest != nil {
		result.SnapshotDigest = *snapshotDigest
	}
	if schemaVersion != nil {
		result.SnapshotSchemaVersion = *schemaVersion
	}
	return result, nil
}

func insertAudit(
	ctx context.Context,
	tx pgx.Tx,
	action string,
	targetKind string,
	targetID string,
	reason string,
	metadata map[string]any,
) error {
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO security_audit_events (
    id, initiator_kind, action, target_kind, target_id, outcome, reason, metadata
) VALUES ($1, 'system', $2, $3, $4, 'succeeded', $5, $6::jsonb)`,
		uuid.NewString(), action, targetKind, targetID, reason, string(encoded))
	return err
}

func normalizeMapping(mapping Mapping) (Mapping, string, error) {
	if mapping.Protocol != MappingProtocol || mapping.Teams == nil {
		return Mapping{}, "", domainError(CodeInvalidMapping)
	}
	result := Mapping{Protocol: MappingProtocol, Teams: make([]TeamMapping, len(mapping.Teams))}
	seenTeams := make(map[string]struct{}, len(mapping.Teams))
	for index, team := range mapping.Teams {
		if !validIdentifier(team.LegacyTeamID) || !validSlug(team.Slug) || len(team.OwnerUserIDs) == 0 {
			return Mapping{}, "", domainError(CodeInvalidMapping)
		}
		if _, duplicate := seenTeams[team.LegacyTeamID]; duplicate {
			return Mapping{}, "", domainError(CodeInvalidMapping)
		}
		seenTeams[team.LegacyTeamID] = struct{}{}
		owners := make([]string, len(team.OwnerUserIDs))
		seenOwners := make(map[string]struct{}, len(team.OwnerUserIDs))
		for ownerIndex, owner := range team.OwnerUserIDs {
			parsed, err := uuid.Parse(owner)
			if err != nil {
				return Mapping{}, "", domainError(CodeInvalidMapping)
			}
			canonical := parsed.String()
			if _, duplicate := seenOwners[canonical]; duplicate {
				return Mapping{}, "", domainError(CodeInvalidMapping)
			}
			seenOwners[canonical] = struct{}{}
			owners[ownerIndex] = canonical
		}
		sort.Strings(owners)
		result.Teams[index] = TeamMapping{
			LegacyTeamID: team.LegacyTeamID, Slug: team.Slug, OwnerUserIDs: owners,
		}
	}
	sort.Slice(result.Teams, func(left, right int) bool {
		return result.Teams[left].LegacyTeamID < result.Teams[right].LegacyTeamID
	})
	encoded, err := json.Marshal(result)
	if err != nil {
		return Mapping{}, "", &Error{Code: CodeInvalidMapping, cause: err}
	}
	digest := sha256.Sum256(encoded)
	return result, hex.EncodeToString(digest[:]), nil
}

func validIdentifier(value string) bool {
	return utf8.ValidString(value) && len(value) >= 1 && len(value) <= 200 &&
		strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n")
}

func validSlug(value string) bool {
	return utf8.ValidString(value) && len(value) >= 2 && len(value) <= 63 &&
		slugPattern.MatchString(value)
}

type databaseSnapshot struct {
	digest        string
	schemaVersion int64
	generatedAt   time.Time
	counts        Counts
}

var snapshotSections = []struct {
	name  string
	query string
}{
	{"schema", `SELECT jsonb_build_array(version, name)::text FROM atape_schema_migrations ORDER BY version`},
	{"ledger", `SELECT jsonb_build_array(protocol_version, status, installation_kind, mapping_protocol, mapping_digest, snapshot_digest, snapshot_schema_version)::text FROM auth_cutover_ledger ORDER BY protocol_version`},
	{"users", `SELECT jsonb_build_array(id, status, updated_at)::text FROM auth_users ORDER BY id`},
	{"identities", `SELECT jsonb_build_array(id, user_id, issuer, subject, status, last_verified_at)::text FROM auth_external_identities ORDER BY id`},
	{"teams", `SELECT jsonb_build_array(id, slug, name, name_reported, updated_at)::text FROM workspace_teams ORDER BY id`},
	{"memberships", `SELECT jsonb_build_array(team_id, user_id, role, status, updated_at)::text FROM team_memberships ORDER BY team_id, user_id`},
	{"projects", `SELECT jsonb_build_array(id, team_id, name, project_type, state, repository_link_state, captured_through, updated_at)::text FROM canonical_projects ORDER BY id`},
	{"repository_aliases", `SELECT jsonb_build_array(project_id, team_id, remote_identity, current)::text FROM team_project_repository_aliases ORDER BY project_id, remote_identity`},
	{"sessions", `SELECT jsonb_build_array(id, project_id, source_key, revision, digest, captured_by_user_id, capture_lineage, record_state, updated_at)::text FROM canonical_sessions ORDER BY id`},
	{"threads", `SELECT jsonb_build_array(session_id, id, source_key, revision, digest, parent_thread_id)::text FROM canonical_threads ORDER BY session_id, id`},
	{"events", `SELECT jsonb_build_array(id, session_id, thread_id, source_key, revision, projection_revision, digest, ingest_seq)::text FROM canonical_events ORDER BY id`},
	{"event_versions", `SELECT jsonb_build_array(source_key, projection_revision, revision, event_id, digest, ingest_seq)::text FROM canonical_event_versions ORDER BY source_key, projection_revision, revision`},
	{"batch_receipts", `SELECT jsonb_build_array(batch_key, digest, session_id, session_created, inserted_events, updated_events, unchanged_events, stale_events)::text FROM canonical_batch_receipts ORDER BY batch_key`},
	{"projection_changes", `SELECT jsonb_build_array(id, event_id, event_ingest_seq, processed_at)::text FROM canonical_projection_changes ORDER BY id`},
	{"search_documents", `SELECT jsonb_build_array(event_id, project_id, session_id, thread_id, ingest_seq, search_text)::text FROM project_search_documents ORDER BY event_id`},
	{"search_checkpoints", `SELECT jsonb_build_array(project_id, indexed_through)::text FROM project_search_checkpoints ORDER BY project_id`},
	{"raw_objects", `SELECT jsonb_build_array(id, project_id, session_id, current_generation, generation_count, updated_at)::text FROM raw_objects ORDER BY id`},
	{"raw_generations", `SELECT jsonb_build_array(object_id, generation, size_bytes, chunk_count, finalized, updated_at)::text FROM raw_generations ORDER BY object_id, generation`},
	{"raw_chunks", `SELECT jsonb_build_array(chunk_id, object_id, generation, ordinal, byte_offset, size_bytes, sha256, storage_key)::text FROM raw_chunks ORDER BY object_id, generation, ordinal`},
}

func takeSnapshot(ctx context.Context, database queryer) (databaseSnapshot, error) {
	var result databaseSnapshot
	if err := database.QueryRow(ctx, `
SELECT COALESCE(MAX(version), 0), clock_timestamp(),
       (SELECT COUNT(*) FROM auth_users),
       (SELECT COUNT(*) FROM workspace_teams),
       (SELECT COUNT(*) FROM canonical_projects),
       (SELECT COUNT(*) FROM canonical_sessions WHERE capture_lineage = 'legacy_anonymous'),
       (SELECT COUNT(*) FROM raw_objects),
       (SELECT COUNT(*) FROM project_search_documents)
FROM atape_schema_migrations`).Scan(
		&result.schemaVersion, &result.generatedAt,
		&result.counts.Users, &result.counts.Teams, &result.counts.Projects,
		&result.counts.LegacySessions, &result.counts.RawObjects,
		&result.counts.SearchDocuments,
	); err != nil {
		return databaseSnapshot{}, err
	}
	digest := sha256.New()
	for _, section := range snapshotSections {
		writeDigestPart(digest, section.name)
		rows, err := database.Query(ctx, section.query)
		if err != nil {
			return databaseSnapshot{}, fmt.Errorf("snapshot %s: %w", section.name, err)
		}
		for rows.Next() {
			var payload string
			if err := rows.Scan(&payload); err != nil {
				rows.Close()
				return databaseSnapshot{}, fmt.Errorf("snapshot %s: %w", section.name, err)
			}
			writeDigestPart(digest, payload)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return databaseSnapshot{}, fmt.Errorf("snapshot %s: %w", section.name, err)
		}
		rows.Close()
	}
	result.digest = hex.EncodeToString(digest.Sum(nil))
	return result, nil
}

func writeDigestPart(target hash.Hash, value string) {
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(value)))
	_, _ = target.Write(length[:])
	_, _ = target.Write([]byte(value))
}

type mappedTeam struct {
	id   string
	slug *string
}

func buildPlan(
	ctx context.Context,
	database queryer,
	mapping Mapping,
	mappingDigest string,
	snapshot databaseSnapshot,
) (Plan, error) {
	teamRows, err := database.Query(ctx, "SELECT id, slug FROM workspace_teams ORDER BY id")
	if err != nil {
		return Plan{}, err
	}
	teams := make(map[string]mappedTeam)
	for teamRows.Next() {
		var team mappedTeam
		if err := teamRows.Scan(&team.id, &team.slug); err != nil {
			teamRows.Close()
			return Plan{}, err
		}
		teams[team.id] = team
	}
	if err := teamRows.Err(); err != nil {
		teamRows.Close()
		return Plan{}, err
	}
	teamRows.Close()

	userRows, err := database.Query(ctx, "SELECT id::text, status FROM auth_users ORDER BY id")
	if err != nil {
		return Plan{}, err
	}
	users := make(map[string]string)
	for userRows.Next() {
		var id, status string
		if err := userRows.Scan(&id, &status); err != nil {
			userRows.Close()
			return Plan{}, err
		}
		users[id] = status
	}
	if err := userRows.Err(); err != nil {
		userRows.Close()
		return Plan{}, err
	}
	userRows.Close()

	findings := make([]Finding, 0)
	changes := make([]TeamChange, 0, len(mapping.Teams))
	mappedIDs := make(map[string]struct{}, len(mapping.Teams))
	slugs := make(map[string]string, len(mapping.Teams))
	for index, candidate := range mapping.Teams {
		field := fmt.Sprintf("teams[%d]", index)
		team, exists := teams[candidate.LegacyTeamID]
		if !exists {
			findings = append(findings, Finding{Code: "unknown_team", Field: field + ".legacyTeamId", Detail: "mapping references an unknown legacy Team"})
			continue
		}
		mappedIDs[candidate.LegacyTeamID] = struct{}{}
		if prior, duplicate := slugs[candidate.Slug]; duplicate {
			findings = append(findings, Finding{Code: "duplicate_slug", Field: field + ".slug", Detail: "slug is also assigned to Team " + prior})
		} else {
			slugs[candidate.Slug] = candidate.LegacyTeamID
		}
		for ownerIndex, ownerID := range candidate.OwnerUserIDs {
			ownerStatus, exists := users[ownerID]
			switch {
			case !exists:
				findings = append(findings, Finding{Code: "unknown_owner", Field: fmt.Sprintf("%s.ownerUserIds[%d]", field, ownerIndex), Detail: "Owner User does not exist"})
			case ownerStatus != "active":
				findings = append(findings, Finding{Code: "inactive_owner", Field: fmt.Sprintf("%s.ownerUserIds[%d]", field, ownerIndex), Detail: "Owner User is not active"})
			}
		}
		currentSlug := ""
		if team.slug != nil {
			currentSlug = *team.slug
		}
		changes = append(changes, TeamChange{
			LegacyTeamID: candidate.LegacyTeamID, CurrentSlug: currentSlug,
			Slug: candidate.Slug, OwnerUserIDs: append([]string(nil), candidate.OwnerUserIDs...),
		})
	}
	teamIDs := make([]string, 0, len(teams))
	for teamID := range teams {
		teamIDs = append(teamIDs, teamID)
	}
	sort.Strings(teamIDs)
	for _, teamID := range teamIDs {
		if _, exists := mappedIDs[teamID]; !exists {
			findings = append(findings, Finding{Code: "missing_team", Field: "teams", Detail: "legacy Team is not mapped: " + teamID})
		}
	}
	var authenticatedSessions int64
	if err := database.QueryRow(ctx, "SELECT COUNT(*) FROM canonical_sessions WHERE capture_lineage = 'authenticated'").Scan(&authenticatedSessions); err != nil {
		return Plan{}, err
	}
	if authenticatedSessions != 0 {
		findings = append(findings, Finding{Code: "unexpected_authenticated_capture", Field: "sessions", Detail: "mapped upgrade contains authenticated capture data"})
	}
	sort.Slice(findings, func(left, right int) bool {
		if findings[left].Field == findings[right].Field {
			return findings[left].Code < findings[right].Code
		}
		return findings[left].Field < findings[right].Field
	})
	return Plan{
		Protocol: PlanProtocol, MappingDigest: mappingDigest,
		SnapshotDigest: snapshot.digest, SnapshotSchemaVersion: snapshot.schemaVersion,
		GeneratedAt: snapshot.generatedAt, Counts: snapshot.counts,
		Applicable: len(findings) == 0, Changes: changes, Findings: findings,
		AuditEvents: len(mapping.Teams) + 1,
	}, nil
}
