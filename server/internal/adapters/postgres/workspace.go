package postgres

import (
	"context"
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/jackc/pgx/v5"
)

func (s *Store) Workspace(
	ctx context.Context,
	principal authentication.Principal,
	activeSince time.Time,
) (canonical.WorkspaceSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return canonical.WorkspaceSnapshot{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return canonical.WorkspaceSnapshot{}, persist("begin Workspace read", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	if err := enforceAccess(principal, authorization.WorkspaceListVisible,
		authorization.ResourceFacts{Kind: authorization.InstanceResource},
		authorization.MembershipFacts{}); err != nil {
		return canonical.WorkspaceSnapshot{}, err
	}
	userID, err := principalUUID(principal)
	if err != nil {
		return canonical.WorkspaceSnapshot{}, concealedAccess(
			principal, authorization.WorkspaceListVisible, authorization.InstanceResource,
		)
	}
	teamRows, err := queries.ListWorkspaceTeams(ctx, userID)
	if err != nil {
		return canonical.WorkspaceSnapshot{}, persist("list Workspace teams", err)
	}
	projectRows, err := queries.ListWorkspaceProjects(ctx, db.ListWorkspaceProjectsParams{
		ActiveSince: activeSince, UserID: userID,
	})
	if err != nil {
		return canonical.WorkspaceSnapshot{}, persist("list Workspace projects", err)
	}
	snapshot := canonical.WorkspaceSnapshot{
		Teams:    make([]canonical.TeamRecord, 0, len(teamRows)),
		Projects: make([]canonical.WorkspaceProjectSnapshot, 0, len(projectRows)),
	}
	for _, row := range teamRows {
		snapshot.Teams = append(snapshot.Teams, canonical.TeamRecord{ID: row.ID, Name: row.Name})
	}
	for _, row := range projectRows {
		snapshot.Projects = append(snapshot.Projects, canonical.WorkspaceProjectSnapshot{
			Project: canonical.ProjectRecord{
				ID: row.ID, TeamID: row.TeamID, Name: row.Name, Type: row.ProjectType, State: row.State,
			},
			CapturedThrough: row.CapturedThrough, SessionCount: int(row.SessionCount),
			ActiveSessionCount: int(row.ActiveSessionCount),
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.WorkspaceSnapshot{}, persist("commit Workspace read", err)
	}
	return snapshot, nil
}
