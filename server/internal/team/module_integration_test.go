package team_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/team"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

const (
	aliceID = "00000000-0000-7000-8000-000000000001"
	bobID   = "00000000-0000-7000-8000-000000000002"
	eveID   = "00000000-0000-7000-8000-000000000003"
)

func TestTeamPostgresContract(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1 to run PostgreSQL integration tests")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx,
		"postgres:17-alpine",
		postgrescontainer.WithDatabase("atape_team_test"),
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
	poolA, err := postgresadapter.NewPool(databaseURL)
	if err != nil {
		t.Fatalf("create first pool: %v", err)
	}
	t.Cleanup(poolA.Close)
	if err := postgresadapter.Prepare(ctx, poolA); err != nil {
		t.Fatalf("prepare PostgreSQL: %v", err)
	}
	poolB, err := postgresadapter.NewPool(databaseURL)
	if err != nil {
		t.Fatalf("create second pool: %v", err)
	}
	t.Cleanup(poolB.Close)
	pepper := keyRing(t, "pepper-1", 7)
	moduleA := newTeamModule(t, poolA, pepper, team.DefaultPolicy())
	moduleB := newTeamModule(t, poolB, pepper, team.DefaultPolicy())

	t.Run("Team create is idempotent and Workspace is filtered", func(t *testing.T) {
		resetTeamState(t, poolA)
		insertUsers(t, poolA)
		alice := webPrincipal(aliceID, false)
		key := operationKey(1)
		lockTx, err := poolA.Begin(ctx)
		if err != nil {
			t.Fatalf("begin competing idempotency transaction: %v", err)
		}
		lockKey := "team-operation:" + aliceID + ":team.create:" + key
		if _, err := lockTx.Exec(ctx,
			"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", lockKey); err != nil {
			_ = lockTx.Rollback(context.Background())
			t.Fatalf("hold competing idempotency lock: %v", err)
		}
		_, contendedErr := moduleB.CreateTeam(ctx, team.CreateTeamInput{
			Principal: alice, Slug: "platform", DisplayName: "Platform",
			OperationKey: key, RequestID: "team-create-contended",
		})
		var contended *team.Error
		if !errors.As(contendedErr, &contended) || contended.Code != team.CodeIdempotencyInProgress ||
			contended.RetryAfter != 1 {
			t.Fatalf("contended idempotent create error = %#v", contendedErr)
		}
		if err := lockTx.Rollback(ctx); err != nil {
			t.Fatalf("release competing idempotency lock: %v", err)
		}
		created := createTeam(t, moduleA, alice, "platform", "Platform", key)
		replayed, err := moduleB.CreateTeam(ctx, team.CreateTeamInput{
			Principal: alice, Slug: "PLATFORM", DisplayName: "Platform",
			OperationKey: key, RequestID: "team-create-replay",
		})
		if err != nil || replayed.Team.ID != created.Team.ID || replayed.Membership.Role != team.OwnerRole {
			t.Fatalf("idempotent Team replay = %+v, %v", replayed, err)
		}
		if _, err := moduleB.CreateTeam(ctx, team.CreateTeamInput{
			Principal: alice, Slug: "platform", DisplayName: "Different",
			OperationKey: key, RequestID: "team-create-conflict",
		}); team.ErrorCodeOf(err) != team.CodeIdempotencyConflict {
			t.Fatalf("changed idempotent request error = %v", err)
		}
		if _, err := moduleA.CreateTeam(ctx, team.CreateTeamInput{
			Principal: cliPrincipal(aliceID), Slug: "cli-team", DisplayName: "CLI Team",
			OperationKey: operationKey(2), RequestID: "cli-team-create",
		}); team.ErrorCodeOf(err) != team.CodeCredentialCapabilityDenied {
			t.Fatalf("CLI Team create error = %v", err)
		}
		aliceWorkspace, err := moduleA.OpenWorkspace(ctx, cliPrincipal(aliceID))
		if err != nil || len(aliceWorkspace.Teams) != 1 || aliceWorkspace.Teams[0].Team.ID != created.Team.ID {
			t.Fatalf("Alice Workspace = %+v, %v", aliceWorkspace, err)
		}
		bobWorkspace, err := moduleB.OpenWorkspace(ctx, webPrincipal(bobID, false))
		if err != nil || len(bobWorkspace.Teams) != 0 || len(bobWorkspace.Projects) != 0 {
			t.Fatalf("Bob filtered Workspace = %+v, %v", bobWorkspace, err)
		}
		var auditCount int
		if err := poolA.QueryRow(ctx, "SELECT COUNT(*) FROM security_audit_events WHERE action = 'team.create'").Scan(&auditCount); err != nil || auditCount != 1 {
			t.Fatalf("Team create audit count = %d, %v", auditCount, err)
		}
	})

	t.Run("Join Code and last-Owner transitions are replica safe", func(t *testing.T) {
		resetTeamState(t, poolA)
		insertUsers(t, poolA)
		alice := webPrincipal(aliceID, false)
		aliceFresh := webPrincipal(aliceID, true)
		created := createTeam(t, moduleA, alice, "runtime", "Runtime", operationKey(3))
		if _, err := moduleA.RotateJoinCode(ctx, team.TeamActionInput{
			Principal: alice, TeamSlug: "runtime", RequestID: "rotate-stale",
		}); team.ErrorCodeOf(err) != team.CodeFreshAuthenticationRequired {
			t.Fatalf("non-fresh rotation error = %v", err)
		}
		grant, err := moduleA.RotateJoinCode(ctx, team.TeamActionInput{
			Principal: aliceFresh, TeamSlug: "runtime", RequestID: "rotate-first",
		})
		if err != nil || len(grant.Code) != 6 || grant.Code != strings.ToUpper(grant.Code) {
			t.Fatalf("Join Code grant = %+v, %v", grant, err)
		}
		assertJoinCodeNotPersisted(t, poolA, grant.Code)
		joined, err := moduleB.JoinTeam(ctx, team.JoinTeamInput{
			Principal: webPrincipal(bobID, false), JoinCode: strings.ToLower(grant.Code), RequestID: "bob-join",
		})
		if err != nil || !joined.MembershipCreated || joined.Team.ID != created.Team.ID || joined.Membership.Role != team.MemberRole {
			t.Fatalf("Bob join = %+v, %v", joined, err)
		}
		if _, err := moduleA.ChangeMembershipRole(ctx, team.ChangeMembershipRoleInput{
			Principal: aliceFresh, TeamSlug: "runtime", UserID: bobID,
			Role: team.OwnerRole, RequestID: "promote-bob",
		}); err != nil {
			t.Fatalf("promote Bob: %v", err)
		}

		start := make(chan struct{})
		errorsByUser := make(map[string]error)
		var mutex sync.Mutex
		var workers sync.WaitGroup
		for _, attempt := range []struct {
			userID string
			module *team.Module
		}{{aliceID, moduleA}, {bobID, moduleB}} {
			workers.Add(1)
			go func(attempt struct {
				userID string
				module *team.Module
			}) {
				defer workers.Done()
				<-start
				err := attempt.module.LeaveTeam(context.Background(), team.TeamActionInput{
					Principal: webPrincipal(attempt.userID, false), TeamSlug: "runtime",
					RequestID: "leave-" + attempt.userID,
				})
				mutex.Lock()
				errorsByUser[attempt.userID] = err
				mutex.Unlock()
			}(attempt)
		}
		close(start)
		workers.Wait()
		successes, lastOwnerFailures := 0, 0
		removedUserID, ownerUserID := "", ""
		for userID, err := range errorsByUser {
			if err == nil {
				successes++
				removedUserID = userID
			} else if team.ErrorCodeOf(err) == team.CodeLastOwnerRequired {
				lastOwnerFailures++
				ownerUserID = userID
			} else {
				t.Fatalf("unexpected concurrent leave error for %s: %v", userID, err)
			}
		}
		if successes != 1 || lastOwnerFailures != 1 {
			t.Fatalf("leave race outcomes = %+v", errorsByUser)
		}
		rejoined, err := moduleA.JoinTeam(ctx, team.JoinTeamInput{
			Principal: webPrincipal(removedUserID, false), JoinCode: grant.Code, RequestID: "owner-rejoin",
		})
		if err != nil || rejoined.MembershipCreated || rejoined.Membership.Role != team.MemberRole {
			t.Fatalf("removed Owner rejoin = %+v, %v", rejoined, err)
		}
		if _, err := moduleB.RotateJoinCode(ctx, team.TeamActionInput{
			Principal: webPrincipal(removedUserID, true), TeamSlug: "runtime", RequestID: "member-rotate",
		}); team.ErrorCodeOf(err) != team.CodeMembershipRoleDenied {
			t.Fatalf("Member Join Code rotation error = %v", err)
		}
		if ownerUserID == "" {
			t.Fatal("leave race did not retain an Owner")
		}
	})

	t.Run("Join Code failures persist across replicas", func(t *testing.T) {
		resetTeamState(t, poolA)
		insertUsers(t, poolA)
		policy := team.DefaultPolicy()
		policy.MaximumCodeFailures = 3
		limitedA := newTeamModule(t, poolA, pepper, policy)
		limitedB := newTeamModule(t, poolB, pepper, policy)
		for index, module := range []*team.Module{limitedA, limitedB} {
			_, err := module.JoinTeam(ctx, team.JoinTeamInput{
				Principal: webPrincipal(eveID, false), JoinCode: "ABCDEF",
				RequestID: "invalid-join-" + string(rune('1'+index)),
			})
			if team.ErrorCodeOf(err) != team.CodeInvalidJoinCode {
				t.Fatalf("invalid Join Code attempt %d = %v", index+1, err)
			}
		}
		_, err := limitedA.JoinTeam(ctx, team.JoinTeamInput{
			Principal: webPrincipal(eveID, false), JoinCode: "ABCDEF", RequestID: "invalid-join-3",
		})
		if team.ErrorCodeOf(err) != team.CodeTooManyJoinCodeAttempts {
			t.Fatalf("threshold Join Code attempt = %v", err)
		}
		_, err = limitedB.JoinTeam(ctx, team.JoinTeamInput{
			Principal: webPrincipal(eveID, false), JoinCode: "ZZZZZZ", RequestID: "invalid-join-4",
		})
		if team.ErrorCodeOf(err) != team.CodeTooManyJoinCodeAttempts {
			t.Fatalf("cross-replica blocked attempt = %v", err)
		}
		var failures int
		if err := poolA.QueryRow(ctx, "SELECT failure_count FROM team_join_code_attempt_windows WHERE user_id = $1", eveID).Scan(&failures); err != nil || failures != 3 {
			t.Fatalf("persisted Join Code failures = %d, %v", failures, err)
		}
	})

	t.Run("Join and Join Code rotation linearize across replicas", func(t *testing.T) {
		resetTeamState(t, poolA)
		insertUsers(t, poolA)
		alice := webPrincipal(aliceID, false)
		aliceFresh := webPrincipal(aliceID, true)
		created := createTeam(t, moduleA, alice, "concurrency", "Concurrency", operationKey(8))
		first, err := moduleA.RotateJoinCode(ctx, team.TeamActionInput{
			Principal: aliceFresh, TeamSlug: "concurrency", RequestID: "rotate-before-race",
		})
		if err != nil {
			t.Fatalf("rotate initial Join Code: %v", err)
		}

		start := make(chan struct{})
		var joinResult team.JoinTeamResult
		var joinErr, rotateErr error
		var second team.JoinCodeGrant
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			joinResult, joinErr = moduleB.JoinTeam(context.Background(), team.JoinTeamInput{
				Principal: webPrincipal(bobID, false), JoinCode: first.Code, RequestID: "join-during-rotate",
			})
		}()
		go func() {
			defer workers.Done()
			<-start
			second, rotateErr = moduleA.RotateJoinCode(context.Background(), team.TeamActionInput{
				Principal: aliceFresh, TeamSlug: "concurrency", RequestID: "rotate-during-join",
			})
		}()
		close(start)
		workers.Wait()
		if rotateErr != nil || second.Status.Generation != 2 || second.Code == first.Code {
			t.Fatalf("concurrent rotation = %+v, %v", second, rotateErr)
		}
		if joinErr != nil && team.ErrorCodeOf(joinErr) != team.CodeInvalidJoinCode {
			t.Fatalf("concurrent Join outcome = %+v, %v", joinResult, joinErr)
		}
		joined, err := moduleB.JoinTeam(ctx, team.JoinTeamInput{
			Principal: webPrincipal(bobID, false), JoinCode: strings.ToLower(second.Code),
			RequestID: "join-current-code",
		})
		if err != nil || joined.Team.ID != created.Team.ID || joined.Membership.Role != team.MemberRole {
			t.Fatalf("current Join Code = %+v, %v", joined, err)
		}
		if _, err := moduleB.JoinTeam(ctx, team.JoinTeamInput{
			Principal: webPrincipal(eveID, false), JoinCode: first.Code, RequestID: "retired-code",
		}); team.ErrorCodeOf(err) != team.CodeInvalidJoinCode {
			t.Fatalf("retired Join Code error = %v", err)
		}
		var enabledCodes, latestGeneration int
		if err := poolA.QueryRow(ctx, `
SELECT COUNT(*) FILTER (WHERE status = 'enabled'), MAX(generation)
FROM team_join_codes WHERE team_id = $1`, created.Team.ID).Scan(&enabledCodes, &latestGeneration); err != nil ||
			enabledCodes != 1 || latestGeneration != 2 {
			t.Fatalf("Join Code state: enabled=%d generation=%d error=%v", enabledCodes, latestGeneration, err)
		}
	})

	t.Run("Project identity and management preserve the capability ceiling", func(t *testing.T) {
		resetTeamState(t, poolA)
		insertUsers(t, poolA)
		alice := webPrincipal(aliceID, false)
		aliceFresh := webPrincipal(aliceID, true)
		createTeam(t, moduleA, alice, "agents", "Agents", operationKey(4))
		rotateAndJoin(t, moduleA, moduleB, aliceFresh, bobID, "agents")
		folder, err := moduleB.CreateProject(ctx, team.CreateProjectInput{
			Principal: cliPrincipal(bobID), TeamSlug: "agents",
			Spec:         team.ProjectSpec{Type: team.FolderProject, Name: "Local notes"},
			OperationKey: operationKey(5), RequestID: "folder-create",
		})
		if err != nil || folder.Type != team.FolderProject ||
			folder.RepositoryLinkState != team.RepositoryNotApplicable {
			t.Fatalf("Member Folder Project create = %+v, %v", folder, err)
		}
		if _, err := moduleB.RenameFolderProject(ctx, team.RenameFolderProjectInput{
			Principal: webPrincipal(bobID, true), ProjectID: folder.ID,
			Name: "Private rename", RequestID: "member-rename",
		}); team.ErrorCodeOf(err) != team.CodeMembershipRoleDenied {
			t.Fatalf("Member Folder Project rename error = %v", err)
		}
		renamed, err := moduleA.RenameFolderProject(ctx, team.RenameFolderProjectInput{
			Principal: alice, ProjectID: folder.ID, Name: "Shared notes", RequestID: "owner-rename",
		})
		if err != nil || renamed.Name != "Shared notes" {
			t.Fatalf("Owner Folder Project rename = %+v, %v", renamed, err)
		}
		gitProject, err := moduleB.CreateProject(ctx, team.CreateProjectInput{
			Principal: cliPrincipal(bobID), TeamSlug: "agents",
			Spec:         team.ProjectSpec{Type: team.GitProject, Remote: "git@github.com:SingleMai/ATape.git"},
			OperationKey: operationKey(6), RequestID: "git-create",
		})
		if err != nil || gitProject.RepositoryIdentity != "github.com/singlemai/atape" ||
			gitProject.RepositoryLinkState != team.RepositoryLinked {
			t.Fatalf("Git Project create = %+v, %v", gitProject, err)
		}
		matched, err := moduleA.MatchProject(ctx, team.MatchProjectInput{
			Principal: cliPrincipal(aliceID), TeamID: gitProject.TeamID,
			Remote: "https://github.com/singlemai/atape",
		})
		if err != nil || matched == nil || matched.ID != gitProject.ID {
			t.Fatalf("Git remote exact match = %+v, %v", matched, err)
		}
		if _, err := moduleA.MatchProject(ctx, team.MatchProjectInput{
			Principal: alice, TeamID: gitProject.TeamID, Remote: "https://github.com/singlemai/atape",
		}); team.ErrorCodeOf(err) != team.CodeCredentialCapabilityDenied {
			t.Fatalf("Web Project match error = %v", err)
		}
		if _, err := moduleA.RelinkGitProject(ctx, team.RelinkGitProjectInput{
			Principal: alice, ProjectID: gitProject.ID,
			Remote: "https://github.com/SingleMai/ATape-Next.git", RequestID: "relink-stale",
		}); team.ErrorCodeOf(err) != team.CodeFreshAuthenticationRequired {
			t.Fatalf("stale Git relink error = %v", err)
		}
		relinked, err := moduleA.RelinkGitProject(ctx, team.RelinkGitProjectInput{
			Principal: aliceFresh, ProjectID: gitProject.ID,
			Remote: "https://github.com/SingleMai/ATape-Next.git", RequestID: "relink-fresh",
		})
		if err != nil || relinked.RepositoryIdentity != "github.com/singlemai/atape-next" ||
			relinked.RepositoryLinkState != team.RepositoryLinked {
			t.Fatalf("Git relink = %+v, %v", relinked, err)
		}
		oldAlias, err := moduleB.MatchProject(ctx, team.MatchProjectInput{
			Principal: cliPrincipal(bobID), TeamID: gitProject.TeamID,
			Remote: "ssh://git@github.com/singlemai/atape.git",
		})
		if err != nil || oldAlias == nil || oldAlias.ID != gitProject.ID {
			t.Fatalf("old repository alias = %+v, %v", oldAlias, err)
		}
		if _, err := moduleA.ArchiveProject(ctx, team.ProjectActionInput{
			Principal: alice, ProjectID: gitProject.ID, RequestID: "archive-project",
		}); err != nil {
			t.Fatalf("archive Project: %v", err)
		}
		archivedMatch, err := moduleB.MatchProject(ctx, team.MatchProjectInput{
			Principal: cliPrincipal(bobID), TeamID: gitProject.TeamID,
			Remote: "https://github.com/singlemai/atape-next",
		})
		if err != nil || archivedMatch != nil {
			t.Fatalf("archived Project match = %+v, %v", archivedMatch, err)
		}
		if err := moduleA.DeleteProject(ctx, team.ProjectActionInput{
			Principal: aliceFresh, ProjectID: gitProject.ID, RequestID: "delete-project",
		}); err != nil {
			t.Fatalf("delete Project: %v", err)
		}
		if _, err := moduleB.OpenProject(ctx, webPrincipal(bobID, false), gitProject.ID); team.ErrorCodeOf(err) != team.CodeNotFound {
			t.Fatalf("deleted Project read error = %v", err)
		}
	})

	t.Run("User disable and leave race retains one active Owner", func(t *testing.T) {
		resetTeamState(t, poolA)
		insertUsers(t, poolA)
		aliceFresh := webPrincipal(aliceID, true)
		createTeam(t, moduleA, webPrincipal(aliceID, false), "security", "Security", operationKey(7))
		rotateAndJoin(t, moduleA, moduleB, aliceFresh, bobID, "security")
		if _, err := moduleA.ChangeMembershipRole(ctx, team.ChangeMembershipRoleInput{
			Principal: aliceFresh, TeamSlug: "security", UserID: bobID,
			Role: team.OwnerRole, RequestID: "promote-security-owner",
		}); err != nil {
			t.Fatalf("promote second Owner: %v", err)
		}
		privateKeys := keyRing(t, "private-1", 11)
		authModule, err := authentication.New(poolA, authentication.Config{
			PepperKeys: pepper, PrivateStateKeys: privateKeys,
		})
		if err != nil {
			t.Fatalf("construct Authentication Module: %v", err)
		}
		start := make(chan struct{})
		var disableErr, leaveErr error
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			disableErr = authModule.DisableUser(context.Background(), authentication.DisableUserInput{
				UserID: aliceID, Reason: "operator_test", RequestID: "disable-alice",
			})
		}()
		go func() {
			defer workers.Done()
			<-start
			leaveErr = moduleB.LeaveTeam(context.Background(), team.TeamActionInput{
				Principal: webPrincipal(bobID, false), TeamSlug: "security", RequestID: "leave-bob",
			})
		}()
		close(start)
		workers.Wait()
		validOutcome := (disableErr == nil && team.ErrorCodeOf(leaveErr) == team.CodeLastOwnerRequired) ||
			(leaveErr == nil && authentication.ErrorCodeOf(disableErr) == authentication.CodeLastOwnerRequired)
		if !validOutcome {
			t.Fatalf("disable/leave outcomes: disable=%v leave=%v", disableErr, leaveErr)
		}
		var activeOwners int
		if err := poolA.QueryRow(ctx, `
SELECT COUNT(*)
FROM team_memberships memberships
JOIN auth_users users ON users.id = memberships.user_id
WHERE memberships.team_id = (SELECT id FROM workspace_teams WHERE slug = 'security')
  AND memberships.status = 'active' AND memberships.role = 'owner' AND users.status = 'active'`).Scan(&activeOwners); err != nil || activeOwners != 1 {
			t.Fatalf("active Owner count after race = %d, %v", activeOwners, err)
		}
	})

	t.Run("role remove and User disable race preserves authority invariants", func(t *testing.T) {
		resetTeamState(t, poolA)
		insertUsers(t, poolA)
		aliceFresh := webPrincipal(aliceID, true)
		created := createTeam(t, moduleA, webPrincipal(aliceID, false), "authority", "Authority", operationKey(9))
		rotateAndJoin(t, moduleA, moduleB, aliceFresh, bobID, "authority")
		privateKeys := keyRing(t, "private-2", 12)
		authModule, err := authentication.New(poolA, authentication.Config{
			PepperKeys: pepper, PrivateStateKeys: privateKeys,
		})
		if err != nil {
			t.Fatalf("construct Authentication Module: %v", err)
		}

		start := make(chan struct{})
		var promoteErr, removeErr, disableErr error
		var workers sync.WaitGroup
		workers.Add(3)
		go func() {
			defer workers.Done()
			<-start
			_, promoteErr = moduleA.ChangeMembershipRole(context.Background(), team.ChangeMembershipRoleInput{
				Principal: aliceFresh, TeamSlug: "authority", UserID: bobID,
				Role: team.OwnerRole, RequestID: "promote-race",
			})
		}()
		go func() {
			defer workers.Done()
			<-start
			removeErr = moduleB.RemoveMembership(context.Background(), team.RemoveMembershipInput{
				Principal: aliceFresh, TeamSlug: "authority", UserID: bobID, RequestID: "remove-race",
			})
		}()
		go func() {
			defer workers.Done()
			<-start
			disableErr = authModule.DisableUser(context.Background(), authentication.DisableUserInput{
				UserID: bobID, Reason: "operator_test", RequestID: "disable-bob-race",
			})
		}()
		close(start)
		workers.Wait()
		if removeErr != nil || disableErr != nil {
			t.Fatalf("remove/disable outcomes: remove=%v disable=%v", removeErr, disableErr)
		}
		if promoteErr != nil && team.ErrorCodeOf(promoteErr) != team.CodeNotFound &&
			team.ErrorCodeOf(promoteErr) != team.CodeResourceStateConflict {
			t.Fatalf("promote outcome = %v", promoteErr)
		}
		var membershipStatus, userStatus string
		if err := poolA.QueryRow(ctx, `
SELECT memberships.status, users.status
FROM team_memberships memberships
JOIN auth_users users ON users.id = memberships.user_id
WHERE memberships.team_id = $1 AND memberships.user_id = $2`, created.Team.ID, bobID).
			Scan(&membershipStatus, &userStatus); err != nil || membershipStatus != "removed" || userStatus != "disabled" {
			t.Fatalf("terminal authority state: Membership=%q User=%q error=%v", membershipStatus, userStatus, err)
		}
		var activeOwners, requiredAudits int
		if err := poolA.QueryRow(ctx, `
SELECT COUNT(*)
FROM team_memberships memberships
JOIN auth_users users ON users.id = memberships.user_id
WHERE memberships.team_id = $1 AND memberships.status = 'active'
  AND memberships.role = 'owner' AND users.status = 'active'`, created.Team.ID).Scan(&activeOwners); err != nil || activeOwners != 1 {
			t.Fatalf("active Owner count = %d, %v", activeOwners, err)
		}
		if err := poolA.QueryRow(ctx, `
SELECT COUNT(*) FROM security_audit_events
WHERE action IN ('team_membership.remove', 'user.disable')`).Scan(&requiredAudits); err != nil || requiredAudits != 2 {
			t.Fatalf("required mutation audit count = %d, %v", requiredAudits, err)
		}
	})

	t.Run("User disable and Canonical ingest share an active-User decision point", func(t *testing.T) {
		resetTeamState(t, poolA)
		insertUsers(t, poolA)
		aliceFresh := webPrincipal(aliceID, true)
		createTeam(t, moduleA, webPrincipal(aliceID, false), "capture", "Capture", operationKey(10))
		rotateAndJoin(t, moduleA, moduleB, aliceFresh, bobID, "capture")
		project, err := moduleB.CreateProject(ctx, team.CreateProjectInput{
			Principal: cliPrincipal(bobID), TeamSlug: "capture",
			Spec:         team.ProjectSpec{Type: team.FolderProject, Name: "Bob capture"},
			OperationKey: operationKey(11), RequestID: "create-capture-project",
		})
		if err != nil {
			t.Fatalf("create capture Project: %v", err)
		}
		privateKeys := keyRing(t, "private-3", 13)
		authModule, err := authentication.New(poolA, authentication.Config{
			PepperKeys: pepper, PrivateStateKeys: privateKeys,
		})
		if err != nil {
			t.Fatalf("construct Authentication Module: %v", err)
		}
		ingestor := ingestion.NewIngestor(postgresadapter.NewStore(poolB))
		batch := canonicalcontract.ValidBatch()
		batch.ProjectID = project.ID
		batch.BatchID = "disable-ingest-race"
		bob := cliPrincipal(bobID)

		start := make(chan struct{})
		var ingestErr, disableErr error
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			_, ingestErr = ingestor.ApplyBatch(context.Background(), bob, batch)
		}()
		go func() {
			defer workers.Done()
			<-start
			disableErr = authModule.DisableUser(context.Background(), authentication.DisableUserInput{
				UserID: bobID, Reason: "operator_test", RequestID: "disable-bob-ingest",
			})
		}()
		close(start)
		workers.Wait()
		if disableErr != nil {
			t.Fatalf("disable Bob: %v", disableErr)
		}
		if ingestErr != nil && !isConcealedAuthorization(ingestErr) {
			t.Fatalf("concurrent ingestion error = %v", ingestErr)
		}
		batch.BatchID = "post-disable-ingest"
		if _, err := ingestor.ApplyBatch(ctx, bob, batch); !isConcealedAuthorization(err) {
			t.Fatalf("post-disable ingestion error = %v, want Conceal", err)
		}
	})
}

func isConcealedAuthorization(err error) bool {
	var access *authorization.AccessError
	return errors.As(err, &access) && access.Decision == authorization.Conceal
}

func createTeam(t *testing.T, module *team.Module, principal authentication.Principal, slug, name, key string) team.TeamView {
	t.Helper()
	created, err := module.CreateTeam(context.Background(), team.CreateTeamInput{
		Principal: principal, Slug: slug, DisplayName: name,
		OperationKey: key, RequestID: "create-" + slug,
	})
	if err != nil {
		t.Fatalf("create Team %s: %v", slug, err)
	}
	return created
}

func rotateAndJoin(
	t *testing.T,
	ownerModule *team.Module,
	joinModule *team.Module,
	owner authentication.Principal,
	joiningUserID string,
	slug string,
) team.TeamView {
	t.Helper()
	grant, err := ownerModule.RotateJoinCode(context.Background(), team.TeamActionInput{
		Principal: owner, TeamSlug: slug, RequestID: "rotate-" + slug,
	})
	if err != nil {
		t.Fatalf("rotate Join Code for %s: %v", slug, err)
	}
	joined, err := joinModule.JoinTeam(context.Background(), team.JoinTeamInput{
		Principal: webPrincipal(joiningUserID, false), JoinCode: grant.Code,
		RequestID: "join-" + joiningUserID,
	})
	if err != nil {
		t.Fatalf("join Team %s: %v", slug, err)
	}
	return joined.TeamView
}

func resetTeamState(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
TRUNCATE security_audit_events,
         team_operation_receipts, team_project_repository_aliases,
         team_join_code_attempt_windows, team_join_codes, team_memberships,
         auth_user_code_attempt_windows, auth_cli_credentials, auth_cli_device_authorizations,
         auth_federated_login_transactions, auth_web_session_secrets, auth_web_sessions,
         auth_external_identities, canonical_projection_changes, canonical_batch_receipts,
         canonical_event_versions, canonical_events, canonical_threads, canonical_sessions,
         project_search_documents, project_search_checkpoints,
         raw_chunks, raw_generations, raw_objects,
         canonical_projects, workspace_teams, auth_users`); err != nil {
		t.Fatalf("reset Team state: %v", err)
	}
}

func insertUsers(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	for _, user := range []struct {
		id   string
		name string
	}{{aliceID, "Alice"}, {bobID, "Bob"}, {eveID, "Eve"}} {
		if _, err := pool.Exec(context.Background(), `
INSERT INTO auth_users (id, status, display_name, avatar_url)
VALUES ($1, 'active', $2, '')`, user.id, user.name); err != nil {
			t.Fatalf("insert User %s: %v", user.name, err)
		}
	}
}

func assertJoinCodeNotPersisted(t *testing.T, pool *pgxpool.Pool, code string) {
	t.Helper()
	var leaked bool
	if err := pool.QueryRow(context.Background(), `
SELECT EXISTS (
    SELECT 1 FROM team_join_codes
    WHERE row_to_json(team_join_codes)::text LIKE '%' || $1 || '%'
    UNION ALL
    SELECT 1 FROM security_audit_events
    WHERE row_to_json(security_audit_events)::text LIKE '%' || $1 || '%'
)`, code).Scan(&leaked); err != nil {
		t.Fatalf("scan Join Code persistence canary: %v", err)
	}
	if leaked {
		t.Fatal("plaintext Team Join Code crossed the persistence boundary")
	}
}

func newTeamModule(t *testing.T, pool *pgxpool.Pool, keys authentication.KeyRing, policy team.Policy) *team.Module {
	t.Helper()
	module, err := team.New(pool, team.Config{PepperKeys: keys, Policy: policy})
	if err != nil {
		t.Fatalf("construct Team Module: %v", err)
	}
	return module
}

func keyRing(t *testing.T, id string, fill byte) authentication.KeyRing {
	t.Helper()
	ring, err := authentication.NewKeyRing(id, []authentication.KeyMaterial{{
		ID: id, Material: bytes.Repeat([]byte{fill}, 32),
	}})
	if err != nil {
		t.Fatalf("construct key ring: %v", err)
	}
	return ring
}

func webPrincipal(userID string, fresh bool) authentication.Principal {
	return authentication.Principal{UserID: userID, Method: authentication.WebAuthentication, Fresh: fresh}
}

func cliPrincipal(userID string) authentication.Principal {
	return authentication.Principal{UserID: userID, Method: authentication.CLIAuthentication}
}

func operationKey(value int) string {
	return fmt.Sprintf("11111111-1111-4111-8111-%012d", value)
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
	if host != "" {
		t.Setenv("DOCKER_HOST", host)
	}
}
