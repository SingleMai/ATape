package postgres

import (
	"context"
	"errors"
	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Store) Overview(ctx context.Context, principal authentication.Principal, teamID string, from, until time.Time) (canonical.OverviewSnapshot, error) {
	var result canonical.OverviewSnapshot
	user, err := principalUUID(principal)
	if err != nil {
		return result, concealedAccess(principal, authorization.TeamReadMetadata, authorization.TeamResource)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	team, err := queries.OverviewTeam(ctx, db.OverviewTeamParams{TeamID: teamID, UserID: user})
	if errors.Is(err, pgx.ErrNoRows) {
		return result, concealedAccess(principal, authorization.TeamReadMetadata, authorization.TeamResource)
	}
	if err != nil {
		return result, err
	}
	if err = enforceAccess(principal, authorization.TeamReadMetadata, authorization.ResourceFacts{Kind: authorization.TeamResource, TeamID: teamID}, membershipFacts(teamID, user, team.Role, team.MembershipStatus)); err != nil {
		return result, err
	}
	result.Team = canonical.TeamRecord{ID: team.ID, Name: team.Name}
	members, err := queries.OverviewMembers(ctx, teamID)
	if err != nil {
		return result, err
	}
	if len(members) > canonical.OverviewFactLimit {
		return result, canonical.ErrOverviewCapacity
	}
	for _, m := range members {
		result.Members = append(result.Members, canonical.OverviewMember{ID: m.ID, Name: m.Name, Current: m.Current})
	}
	projects, err := queries.OverviewProjects(ctx, teamID)
	if err != nil {
		return result, err
	}
	if len(projects) > canonical.OverviewFactLimit {
		return result, canonical.ErrOverviewCapacity
	}
	for _, p := range projects {
		result.Projects = append(result.Projects, canonical.ProjectRecord{ID: p.ID, TeamID: p.TeamID, Name: p.Name, Type: p.ProjectType, State: p.State})
	}
	sessions, err := queries.OverviewSessions(ctx, teamID)
	if err != nil {
		return result, err
	}
	if len(sessions) > canonical.OverviewFactLimit {
		return result, canonical.ErrOverviewCapacity
	}
	for _, v := range sessions {
		result.Sessions = append(result.Sessions, sessionRecord(v.ID, v.ProjectID, domainUUID(v.CapturedByUserID), v.SourceKey, v.Revision, v.Digest, v.Title, v.Summary, v.Insight, v.ActorName, v.ActorHarness, v.Branch, v.Status, v.CaptureStatus, v.UpdatedAt, v.ReportedEventCount))
	}
	events, err := queries.OverviewEvents(ctx, db.OverviewEventsParams{TeamID: teamID, FromTime: from, UntilTime: until})
	if err != nil {
		return result, err
	}
	if len(events) > canonical.OverviewFactLimit {
		return result, canonical.ErrOverviewCapacity
	}
	for _, e := range events {
		result.Events = append(result.Events, canonical.OverviewEvent{SessionID: e.SessionID, ThreadID: e.ThreadID, Author: e.Author, Text: e.Text, At: e.OccurredAt, Order: e.SourceOrder, Index: int(e.EventIndex), Root: e.Root})
	}
	usage, err := queries.OverviewUsage(ctx, db.OverviewUsageParams{TeamID: teamID, FromTime: from, UntilTime: until})
	if err != nil {
		return result, err
	}
	if len(usage) > canonical.OverviewFactLimit {
		return result, canonical.ErrOverviewCapacity
	}
	for _, u := range usage {
		result.Usage = append(result.Usage, canonical.UsageRecord{SourceKey: u.SourceKey, SessionID: u.SessionID, ThreadID: u.ThreadID, Revision: u.Revision, Digest: u.Digest, OccurredAt: u.OccurredAt, Model: u.Model, InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens})
	}
	unknown, err := queries.OverviewUnknownTimes(ctx, teamID)
	if err != nil {
		return result, err
	}
	result.UnknownTimeSessions = int(unknown)
	return result, tx.Commit(ctx)
}
