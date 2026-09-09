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
type OverviewEvent struct {
	SessionID, ThreadID, Author, Text string
	At                                time.Time
	Order                             int64
	Index                             int
	Root                              bool
}
type OverviewSnapshot struct {
	Team                TeamRecord
	Members             []OverviewMember
	Projects            []ProjectRecord
	Sessions            []SessionRecord
	Events              []OverviewEvent
	Usage               []UsageRecord
	UnknownTimeSessions int
}

func (s *MemoryStore) Overview(ctx context.Context, principal authentication.Principal, teamID string, from, until time.Time) (OverviewSnapshot, error) {
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
				result.Sessions = append(result.Sessions, s.sessions[id])
			}
		}
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
		if event.OccurredAt.Before(from) || !event.OccurredAt.Before(until) {
			continue
		}
		thread := s.threads[recordKey(event.SessionID, event.ThreadID)]
		result.Events = append(result.Events, OverviewEvent{SessionID: event.SessionID, ThreadID: event.ThreadID, Author: event.Author, Text: event.Text, At: event.OccurredAt, Order: event.SourceOrder, Index: event.EventIndex, Root: thread.ParentThreadID == nil})
		if len(result.Events) > OverviewFactLimit {
			return OverviewSnapshot{}, ErrOverviewCapacity
		}
	}
	for _, value := range s.usage {
		if ids[value.SessionID] && !value.OccurredAt.Before(from) && value.OccurredAt.Before(until) {
			result.Usage = append(result.Usage, value)
			if len(result.Usage) > OverviewFactLimit {
				return OverviewSnapshot{}, ErrOverviewCapacity
			}
		}
	}
	result.UnknownTimeSessions = len(unknown)
	if len(result.Sessions) > OverviewFactLimit {
		return OverviewSnapshot{}, ErrOverviewCapacity
	}
	return result, nil
}
