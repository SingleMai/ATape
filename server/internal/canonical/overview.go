package canonical

import (
	"context"
	"errors"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"time"
)

// This bounded snapshot Seam is shared by the production and demo Adapters.
// It contains Canonical facts only; never Raw bytes or Search documents.
const OverviewFactLimit = 100000

var ErrOverviewCapacity = errors.New("overview range exceeds the supported fact limit; choose a shorter range")

type OverviewMember struct {
	ID, Name string
	Current  bool
}

// OverviewSession and OverviewUsage expose only facts consumed by aggregation.
// They are not partially populated Canonical records.
type OverviewSession struct {
	ID, ProjectID, CapturedByUserID, Title string
	Actor                                  Actor
}
type OverviewUsage struct {
	SessionID, ThreadID, Model                                   string
	OccurredAt                                                   time.Time
	InputTokens, OutputTokens, CacheReadTokens, CacheWriteTokens *int64
}
type OverviewEvent struct {
	ID, SessionID, Author string
	At                    time.Time
	Order                 int64
	Index                 int
	Root                  bool
}

// OverviewFilter scopes facts without narrowing the filter-option directory.
// PeriodFrom separates current and comparison model eligibility.
type OverviewFilter struct {
	Project, Member, Agent, Model string
	PeriodFrom                    time.Time
}

func (f OverviewFilter) Matches(s OverviewSession) bool {
	return (f.Project == "" || f.Project == s.ProjectID) && (f.Member == "" || f.Member == s.CapturedByUserID) && (f.Agent == "" || f.Agent == s.Actor.Harness)
}
func (f OverviewFilter) ModelName() string {
	if f.Model == "__unknown__" {
		return ""
	}
	return f.Model
}
func (f OverviewFilter) HasDimensions() bool {
	return f.Project != "" || f.Member != "" || f.Agent != "" || f.Model != ""
}

type OverviewSnapshot struct {
	// Adapter diagnostics are internal and never part of Canonical facts.
	Timings             map[string]time.Duration
	Team                TeamRecord
	Members             []OverviewMember
	Projects            []ProjectRecord
	Sessions            []OverviewSession
	Events              []OverviewEvent
	Usage               []OverviewUsage
	UnknownTimeSessions int
	Previews            map[string]string
	Models              []string
}

func (s *MemoryStore) Overview(ctx context.Context, principal authentication.Principal, teamID string, from, until time.Time, filter OverviewFilter, selectPreviews OverviewPreviewSelection) (OverviewSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return OverviewSnapshot{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	resource := authorization.ResourceFacts{Kind: authorization.TeamResource}
	if _, ok := s.teams[teamID]; ok {
		resource.TeamID = teamID
	}
	if err := authorization.Enforce(s.authorizer.Evaluate(authorization.Input{Principal: principal, Action: authorization.TeamReadMetadata,
		Resource: resource, Membership: s.memberships[membershipKey(teamID, principal.UserID)]})); err != nil {
		return OverviewSnapshot{}, err
	}
	result := OverviewSnapshot{Team: s.teams[teamID]}
	for _, member := range s.memberships {
		if member.TeamID == teamID {
			result.Members = append(result.Members, OverviewMember{ID: member.UserID, Name: member.UserID, Current: member.Active})
		}
	}
	ids := make(map[string]bool)
	for _, project := range s.projects {
		if project.TeamID == teamID && project.State != "deleted" {
			result.Projects = append(result.Projects, project)
			for id := range s.sessionIDsByProject[project.ID] {
				ids[id] = true
				session := s.sessions[id]
				result.Sessions = append(result.Sessions, OverviewSession{ID: session.ID, ProjectID: session.ProjectID, CapturedByUserID: session.CapturedByUserID, Title: session.Title, Actor: session.Actor})
			}
		}
	}
	selectedIDs := make(map[string]bool)
	for _, session := range result.Sessions {
		if filter.Matches(session) {
			selectedIDs[session.ID] = true
		}
	}
	models := make(map[string]bool)
	currentModel, previousModel := make(map[string]bool), make(map[string]bool)
	for _, value := range s.usage {
		if !ids[value.SessionID] || value.OccurredAt.Before(from) || !value.OccurredAt.Before(until) {
			continue
		}
		models[value.Model] = true
		if !selectedIDs[value.SessionID] || filter.Model != "" && value.Model != filter.ModelName() {
			continue
		}
		result.Usage = append(result.Usage, OverviewUsage{SessionID: value.SessionID, ThreadID: value.ThreadID, Model: value.Model, OccurredAt: value.OccurredAt, InputTokens: value.InputTokens, OutputTokens: value.OutputTokens, CacheReadTokens: value.CacheReadTokens, CacheWriteTokens: value.CacheWriteTokens})
		if len(result.Usage) > OverviewFactLimit {
			return OverviewSnapshot{}, ErrOverviewCapacity
		}
		if filter.Model != "" {
			if value.OccurredAt.Before(filter.PeriodFrom) {
				previousModel[value.SessionID] = true
			} else {
				currentModel[value.SessionID] = true
			}
		}
	}
	for model := range models {
		result.Models = append(result.Models, model)
	}
	unknown := make(map[string]bool)
	for _, event := range s.events {
		if !ids[event.SessionID] || event.Kind != "message" {
			continue
		}
		if event.OccurredAt.Year() < 2000 {
			unknown[event.SessionID] = true
			continue
		}
		if !selectedIDs[event.SessionID] || event.OccurredAt.Before(from) || !event.OccurredAt.Before(until) {
			continue
		}
		if filter.Model != "" {
			eligible := currentModel[event.SessionID]
			if event.OccurredAt.Before(filter.PeriodFrom) {
				eligible = previousModel[event.SessionID]
			}
			if !eligible {
				continue
			}
		}
		thread := s.threads[recordKey(event.SessionID, event.ThreadID)]
		result.Events = append(result.Events, OverviewEvent{ID: event.ID, SessionID: event.SessionID, Author: event.Author, At: event.OccurredAt, Order: event.SourceOrder, Index: event.EventIndex, Root: thread.ParentThreadID == nil})
		if len(result.Events) > OverviewFactLimit {
			return OverviewSnapshot{}, ErrOverviewCapacity
		}
	}
	result.UnknownTimeSessions = len(unknown)
	if len(result.Sessions) > OverviewFactLimit || len(result.Members) > OverviewFactLimit || len(result.Projects) > OverviewFactLimit || len(result.Models) > OverviewFactLimit {
		return OverviewSnapshot{}, ErrOverviewCapacity
	}
	previewIDs, err := SelectOverviewPreviews(result, selectPreviews)
	if err != nil {
		return OverviewSnapshot{}, err
	}
	if err := ctx.Err(); err != nil {
		return OverviewSnapshot{}, err
	}
	result.Previews = make(map[string]string, len(previewIDs))
	for _, id := range previewIDs {
		event := s.events[id]
		text := []rune(event.Text)
		if len(text) > 1500 {
			if event.Author == s.sessions[event.SessionID].Actor.Name {
				text = text[:1500]
			} else {
				text = text[len(text)-1500:]
			}
		}
		result.Previews[id] = string(text)
	}
	return result, nil
}

// OverviewPreviewSelection is a pure, synchronous selection over body-free facts.
// It must not mutate the snapshot or perform I/O. A nil selector reads facts only.
type OverviewPreviewSelection func(OverviewSnapshot) []string

// SelectOverviewPreviews bounds and validates identities before any body lookup.
// Both persistence Adapters enforce the same authorized-snapshot boundary.
func SelectOverviewPreviews(snapshot OverviewSnapshot, selectPreviews OverviewPreviewSelection) ([]string, error) {
	if selectPreviews == nil {
		return nil, nil
	}
	requested := selectPreviews(snapshot)
	if len(requested) > 100 {
		return nil, errors.New("overview preview selection exceeds 100 Events")
	}
	// Bound validation memory to the requested page rather than duplicating
	// the complete fact directory (up to 100,000 Event identities).
	missing := make(map[string]bool, len(requested))
	ids := make([]string, 0, len(requested))
	for _, id := range requested {
		if !missing[id] {
			ids = append(ids, id)
			missing[id] = true
		}
	}
	for _, event := range snapshot.Events {
		if len(missing) == 0 {
			break
		}
		delete(missing, event.ID)
	}
	if len(missing) != 0 {
		return nil, errors.New("overview preview selection is outside the authorized snapshot")
	}
	return ids, nil
}
