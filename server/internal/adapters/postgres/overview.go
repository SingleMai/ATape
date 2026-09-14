package postgres

import (
	"context"
	"errors"
	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"time"
)

func (s *Store) Overview(ctx context.Context, principal authentication.Principal, teamID string, from, until time.Time, filter canonical.OverviewFilter, selectPreviews canonical.OverviewPreviewSelection) (result canonical.OverviewSnapshot, err error) {
	ctx, span := otel.Tracer("atape/postgres").Start(ctx, "Postgres.Overview")
	defer span.End()
	result.Timings = make(map[string]time.Duration, 9)
	stage, started := "acquire", time.Now()
	next := func(name string) { result.Timings[stage] += time.Since(started); stage, started = name, time.Now() }
	defer func() {
		next("done")
		for name, duration := range result.Timings {
			span.SetAttributes(attribute.Float64("overview."+name+"_ms", float64(duration)/float64(time.Millisecond)))
		}
		if err != nil {
			span.SetStatus(codes.Error, "overview read failed")
		}
	}()
	user, err := principalUUID(principal)
	if err != nil {
		return result, concealedAccess(principal, authorization.TeamReadMetadata, authorization.TeamResource)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	// Team sizes, time windows and model eligibility vary sharply. A generic
	// prepared plan cannot estimate these arrays/branches from their values.
	// Keep value-aware planning local to this read, including reused connections;
	// commit/rollback restores the pool's policy for every other Module.
	if _, err = tx.Exec(ctx, "SET LOCAL plan_cache_mode = force_custom_plan"); err != nil {
		return result, err
	}
	next("directory")
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
		result.Sessions = append(result.Sessions, canonical.OverviewSession{ID: v.ID, ProjectID: v.ProjectID, CapturedByUserID: domainUUID(v.CapturedByUserID), Title: v.Title, Actor: canonical.Actor{Name: v.ActorName, Harness: v.ActorHarness}})
	}
	selectedIDs := make([]string, 0, len(result.Sessions))
	for _, session := range result.Sessions {
		if filter.Matches(session) {
			selectedIDs = append(selectedIDs, session.ID)
		}
	}
	next("usage")
	usage, err := queries.OverviewUsage(ctx, db.OverviewUsageParams{SessionIds: selectedIDs, FromTime: from, UntilTime: until, ModelFiltered: filter.Model != "", ModelName: filter.ModelName()})
	if err != nil {
		return result, err
	}
	if len(usage) > canonical.OverviewFactLimit {
		return result, canonical.ErrOverviewCapacity
	}
	currentModel, previousModel := make(map[string]bool), make(map[string]bool)
	models := make(map[string]bool)
	result.Usage = make([]canonical.OverviewUsage, 0, len(usage))
	for _, u := range usage {
		result.Usage = append(result.Usage, canonical.OverviewUsage{SessionID: u.SessionID, ThreadID: u.ThreadID, OccurredAt: u.OccurredAt, Model: u.Model, InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens})
		models[u.Model] = true
		if filter.Model != "" {
			if u.OccurredAt.Before(filter.PeriodFrom) {
				previousModel[u.SessionID] = true
			} else {
				currentModel[u.SessionID] = true
			}
		}
	}
	currentIDs, previousIDs := make([]string, 0, len(currentModel)), make([]string, 0, len(previousModel))
	for id := range currentModel {
		currentIDs = append(currentIDs, id)
	}
	for id := range previousModel {
		previousIDs = append(previousIDs, id)
	}
	if filter.Model != "" {
		// Parts with no matching usage in either period cannot contribute Events.
		selectedIDs = selectedIDs[:0]
		for _, session := range result.Sessions {
			if currentModel[session.ID] || previousModel[session.ID] {
				selectedIDs = append(selectedIDs, session.ID)
			}
		}
	}
	next("events")
	events, err := queries.OverviewEvents(ctx, db.OverviewEventsParams{SessionIds: selectedIDs, FromTime: from, UntilTime: until, ModelFiltered: filter.Model != "", PeriodFrom: filter.PeriodFrom, CurrentModelSessions: currentIDs, PreviousModelSessions: previousIDs})
	if err != nil {
		return result, err
	}
	if len(events) > canonical.OverviewFactLimit {
		return result, canonical.ErrOverviewCapacity
	}
	result.Events = make([]canonical.OverviewEvent, 0, len(events))
	for _, e := range events {
		result.Events = append(result.Events, canonical.OverviewEvent{ID: e.ID, SessionID: e.SessionID, Author: e.Author, At: e.OccurredAt, Order: e.SourceOrder, Index: int(e.EventIndex), Root: e.Root})
	}
	next("models")
	if filter.HasDimensions() {
		choices, err := queries.OverviewModels(ctx, db.OverviewModelsParams{TeamID: teamID, FromTime: from, UntilTime: until})
		if err != nil {
			return result, err
		}
		if len(choices) > canonical.OverviewFactLimit {
			return result, canonical.ErrOverviewCapacity
		}
		result.Models = choices
	} else {
		for model := range models {
			result.Models = append(result.Models, model)
		}
	}
	next("unknown_time")
	unknown, err := queries.OverviewUnknownTimes(ctx, teamID)
	if err != nil {
		return result, err
	}
	result.UnknownTimeSessions = int(unknown)
	next("selection")
	ids, err := canonical.SelectOverviewPreviews(result, selectPreviews)
	if err != nil {
		return result, err
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	next("previews")
	result.Previews = make(map[string]string, len(ids))
	if len(ids) > 0 {
		selected := make(map[string]bool, len(ids))
		for _, id := range ids {
			selected[id] = true
		}
		sessions := make(map[string]bool)
		for _, event := range result.Events {
			if selected[event.ID] {
				sessions[event.SessionID] = true
			}
		}
		sessionIDs := make([]string, 0, len(sessions))
		for id := range sessions {
			sessionIDs = append(sessionIDs, id)
		}
		previews, err := queries.OverviewPreviews(ctx, db.OverviewPreviewsParams{EventIds: ids, SessionIds: sessionIDs})
		if err != nil {
			return result, err
		}
		for _, item := range previews {
			result.Previews[item.ID] = item.Text
		}
	}
	next("commit")
	return result, tx.Commit(ctx)
}
