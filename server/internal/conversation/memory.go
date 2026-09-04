// Package conversation exposes ATape's shared project memory and conversation
// reader as one deep, read-only Module.
package conversation

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

const rootThreadID = "root"

type Project struct {
	ID     string `json:"id"`
	TeamID string `json:"teamId"`
	Name   string `json:"name"`
	Type   string `json:"type"`
}

type Actor struct {
	Name    string `json:"name"`
	Harness string `json:"harness"`
}

type SessionSummary struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	Summary          string `json:"summary"`
	Insight          string `json:"insight"`
	Actor            Actor  `json:"actor"`
	Branch           string `json:"branch"`
	Status           string `json:"status"`
	UpdatedAt        string `json:"updatedAt"`
	EventCount       int    `json:"eventCount"`
	ChildThreadCount int    `json:"childThreadCount"`
}

type ProjectMemory struct {
	Project         Project          `json:"project"`
	CapturedThrough string           `json:"capturedThrough"`
	Active          []SessionSummary `json:"active"`
	Trail           []SessionSummary `json:"trail"`
}

type Session struct {
	ID            string `json:"id"`
	ProjectID     string `json:"projectId"`
	Title         string `json:"title"`
	Actor         Actor  `json:"actor"`
	Branch        string `json:"branch"`
	Status        string `json:"status"`
	CaptureStatus string `json:"captureStatus"`
	UpdatedAt     string `json:"updatedAt"`
}

type Thread struct {
	ID             string  `json:"id"`
	Label          string  `json:"label"`
	ParentThreadID *string `json:"parentThreadId,omitempty"`
	CaptureStatus  string  `json:"captureStatus"`
}

type ThreadPathItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type ChildThreadRef struct {
	ID            string `json:"id"`
	Label         string `json:"label"`
	Summary       string `json:"summary"`
	CaptureStatus string `json:"captureStatus"`
	EventCount    int    `json:"eventCount"`
}

type Event struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	Author      string          `json:"author"`
	OccurredAt  string          `json:"occurredAt"`
	Text        string          `json:"text"`
	ToolLabel   string          `json:"toolLabel,omitempty"`
	ChildThread *ChildThreadRef `json:"childThread,omitempty"`
}

type Conversation struct {
	Session    Session          `json:"session"`
	Thread     Thread           `json:"thread"`
	ThreadPath []ThreadPathItem `json:"threadPath"`
	Events     []Event          `json:"events"`
}

type NotFoundError struct {
	Resource string
	ID       string
}

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("%s %q was not found", e.Resource, e.ID)
}

// Memory hides project aggregation, Session/Thread reconstruction, ordering,
// and capture-status semantics behind two read operations.
type Memory struct {
	store SnapshotStore
}

func NewMemory(store SnapshotStore) *Memory {
	return &Memory{store: store}
}

func (m *Memory) OpenProject(ctx context.Context, projectID string) (ProjectMemory, error) {
	snapshot, ok, err := m.store.Project(ctx, projectID)
	if err != nil {
		return ProjectMemory{}, err
	}
	if !ok {
		return ProjectMemory{}, &NotFoundError{Resource: "project", ID: projectID}
	}

	memory := ProjectMemory{
		Project: Project{
			ID:     snapshot.Project.ID,
			TeamID: snapshot.Project.TeamID,
			Name:   snapshot.Project.Name,
			Type:   snapshot.Project.Type,
		},
		CapturedThrough: formatTime(snapshot.CapturedThrough),
		Active:          make([]SessionSummary, 0, len(snapshot.Sessions)),
		Trail:           make([]SessionSummary, 0, len(snapshot.Sessions)),
	}
	sort.Slice(snapshot.Sessions, func(left, right int) bool {
		return snapshot.Sessions[left].Session.UpdatedAt.After(snapshot.Sessions[right].Session.UpdatedAt)
	})
	for _, stored := range snapshot.Sessions {
		summary := sessionSummary(stored)
		memory.Trail = append(memory.Trail, summary)
		if summary.Status == "active" {
			memory.Active = append(memory.Active, summary)
		}
	}

	return memory, nil
}

func (m *Memory) OpenConversation(
	ctx context.Context,
	sessionID string,
	threadID string,
) (Conversation, error) {
	if threadID == "" {
		threadID = rootThreadID
	}

	snapshot, ok, err := m.store.Conversation(ctx, sessionID, threadID)
	if err != nil {
		return Conversation{}, err
	}
	if !ok {
		return Conversation{}, &NotFoundError{Resource: "conversation", ID: sessionID + "/" + threadID}
	}

	threadByID := make(map[string]canonical.ThreadRecord, len(snapshot.Threads))
	for _, thread := range snapshot.Threads {
		threadByID[thread.ID] = thread
	}
	sort.Slice(snapshot.Events, func(left, right int) bool {
		if snapshot.Events[left].SourceOrder != snapshot.Events[right].SourceOrder {
			return snapshot.Events[left].SourceOrder < snapshot.Events[right].SourceOrder
		}
		if snapshot.Events[left].EventIndex != snapshot.Events[right].EventIndex {
			return snapshot.Events[left].EventIndex < snapshot.Events[right].EventIndex
		}
		return snapshot.Events[left].ID < snapshot.Events[right].ID
	})
	events := make([]Event, 0, len(snapshot.Events))
	for _, stored := range snapshot.Events {
		event := Event{
			ID:         stored.ID,
			Kind:       stored.Kind,
			Author:     stored.Author,
			OccurredAt: formatTime(stored.OccurredAt),
			Text:       stored.Text,
			ToolLabel:  stored.ToolLabel,
		}
		if stored.ChildThreadID != nil {
			if child, exists := threadByID[*stored.ChildThreadID]; exists {
				summary := child.Summary
				if summary == "" {
					summary = "Captured child-agent conversation"
				}
				event.ChildThread = &ChildThreadRef{
					ID:            child.ID,
					Label:         child.Label,
					Summary:       summary,
					CaptureStatus: child.CaptureStatus,
					EventCount:    snapshot.EventCounts[child.ID],
				}
			}
		}
		events = append(events, event)
	}
	return Conversation{
		Session: Session{
			ID:            snapshot.Session.ID,
			ProjectID:     snapshot.Session.ProjectID,
			Title:         snapshot.Session.Title,
			Actor:         actor(snapshot.Session.Actor),
			Branch:        snapshot.Session.Branch,
			Status:        snapshot.Session.Status,
			CaptureStatus: snapshot.Session.CaptureStatus,
			UpdatedAt:     formatTime(snapshot.Session.UpdatedAt),
		},
		Thread: Thread{
			ID:             snapshot.Thread.ID,
			Label:          snapshot.Thread.Label,
			ParentThreadID: snapshot.Thread.ParentThreadID,
			CaptureStatus:  snapshot.Thread.CaptureStatus,
		},
		ThreadPath: threadPath(snapshot.Thread, threadByID),
		Events:     events,
	}, nil
}

func sessionSummary(stored canonical.ProjectSessionSnapshot) SessionSummary {
	return SessionSummary{
		ID:               stored.Session.ID,
		Title:            stored.Session.Title,
		Summary:          stored.Session.Summary,
		Insight:          stored.Session.Insight,
		Actor:            actor(stored.Session.Actor),
		Branch:           stored.Session.Branch,
		Status:           stored.Session.Status,
		UpdatedAt:        formatTime(stored.Session.UpdatedAt),
		EventCount:       stored.EventCount,
		ChildThreadCount: stored.ChildThreadCount,
	}
}

func actor(stored canonical.Actor) Actor {
	return Actor{Name: stored.Name, Harness: stored.Harness}
}

func threadPath(current canonical.ThreadRecord, byID map[string]canonical.ThreadRecord) []ThreadPathItem {
	reversed := make([]ThreadPathItem, 0, 4)
	seen := make(map[string]struct{}, 4)
	for {
		if _, exists := seen[current.ID]; exists {
			break
		}
		seen[current.ID] = struct{}{}
		reversed = append(reversed, ThreadPathItem{ID: current.ID, Label: current.Label})
		if current.ParentThreadID == nil {
			break
		}
		parent, exists := byID[*current.ParentThreadID]
		if !exists {
			break
		}
		current = parent
	}

	path := make([]ThreadPathItem, len(reversed))
	for index := range reversed {
		path[len(reversed)-1-index] = reversed[index]
	}
	return path
}

func formatTime(value time.Time) string {
	return value.Format(time.RFC3339)
}
