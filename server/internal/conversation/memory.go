// Package conversation exposes ATape's shared project memory and conversation
// reader as one deep, read-only Module.
package conversation

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
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

type CapturedUser struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl"`
}

type Session struct {
	CapturedBy    *CapturedUser `json:"capturedBy,omitempty"`
	ID            string        `json:"id"`
	ProjectID     string        `json:"projectId"`
	Title         string        `json:"title"`
	Actor         Actor         `json:"actor"`
	Branch        string        `json:"branch"`
	Status        string        `json:"status"`
	CaptureStatus string        `json:"captureStatus"`
	UpdatedAt     string        `json:"updatedAt"`
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
	ID          string                `json:"id"`
	Kind        string                `json:"kind"`
	Author      string                `json:"author"`
	OccurredAt  string                `json:"occurredAt"`
	Text        string                `json:"text"`
	ToolLabel   string                `json:"toolLabel,omitempty"`
	Tool        *canonical.ToolUpdate `json:"tool,omitempty"`
	ChildThread *ChildThreadRef       `json:"childThread,omitempty"`
}

type Conversation struct {
	Head        string           `json:"head,omitempty"`
	NextEventID string           `json:"nextEventId,omitempty"`
	Session     Session          `json:"session"`
	Thread      Thread           `json:"thread"`
	ThreadPath  []ThreadPathItem `json:"threadPath"`
	Events      []Event          `json:"events"`
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
	now   func() time.Time
}

func NewMemory(store SnapshotStore) *Memory {
	return &Memory{store: store, now: time.Now}
}

func (m *Memory) OpenProject(
	ctx context.Context,
	principal authentication.Principal,
	projectID string,
) (ProjectMemory, error) {
	snapshot, ok, err := m.store.Project(ctx, principal, projectID)
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
	now := m.now()
	for _, stored := range snapshot.Sessions {
		summary := sessionSummary(stored, now)
		memory.Trail = append(memory.Trail, summary)
		if summary.Status == "active" {
			memory.Active = append(memory.Active, summary)
		}
	}

	return memory, nil
}

func (m *Memory) OpenConversation(
	ctx context.Context,
	principal authentication.Principal,
	sessionID string,
	threadID string,
) (Conversation, error) {
	if threadID == "" {
		threadID = rootThreadID
	}

	snapshot, ok, err := m.store.Conversation(ctx, principal, sessionID, threadID)
	if err != nil {
		return Conversation{}, err
	}
	if !ok {
		return Conversation{}, &NotFoundError{Resource: "conversation", ID: sessionID + "/" + threadID}
	}

	return m.renderConversation(snapshot)
}

// OpenConversationPage selects one version before reconstruction and caps the
// complete JSON representation. Legacy Sessions keep their existing full read.
func (m *Memory) OpenConversationPage(ctx context.Context, p authentication.Principal, sessionID, threadID string, page canonical.ConversationPageRequest) (Conversation, error) {
	if threadID == "" {
		threadID = rootThreadID
	}
	snapshot, ok, err := m.store.ConversationPage(ctx, p, sessionID, threadID, page)
	if err != nil {
		return Conversation{}, err
	}
	if !ok {
		return Conversation{}, &NotFoundError{Resource: "conversation", ID: sessionID + "/" + threadID}
	}
	value, err := m.renderConversation(snapshot)
	if err != nil || snapshot.Head == "" {
		return value, err
	}
	events := value.Events
	value.Events = []Event{}
	header, err := json.Marshal(value)
	if err != nil {
		return Conversation{}, err
	}
	// Includes cursor growth, commas and the transport's final newline.
	size := len(header) + 256
	for _, event := range events {
		encoded, err := json.Marshal(event)
		if err != nil {
			return Conversation{}, err
		}
		if size+len(encoded)+1 > MaxPageBytes {
			if len(value.Events) == 0 {
				return Conversation{}, fmt.Errorf("admitted Event exceeds conversation response capacity")
			}
			value.NextEventID = value.Events[len(value.Events)-1].ID
			break
		}
		size += len(encoded) + 1
		value.Events = append(value.Events, event)
	}
	return value, nil
}

// MaxPageBytes includes one maximum-size admitted Event after JSON escaping.
const MaxPageBytes = 8 << 20

func (m *Memory) renderConversation(snapshot canonical.ConversationSnapshot) (Conversation, error) {

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
		if stored.ToolUpdateJSON != "" {
			tool, err := canonical.ParseToolUpdate(stored.ToolUpdateJSON)
			if err != nil {
				return Conversation{}, fmt.Errorf("read canonical tool details: %w", err)
			}
			event.Tool = tool
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
	var capturedBy *CapturedUser
	if user := snapshot.CapturedBy; user != nil {
		capturedBy = &CapturedUser{ID: user.ID, DisplayName: user.DisplayName, AvatarURL: user.AvatarURL}
	}
	return Conversation{
		Head: snapshot.Head, NextEventID: snapshot.NextEventID,
		Session: Session{
			CapturedBy:    capturedBy,
			ID:            snapshot.Session.ID,
			ProjectID:     snapshot.Session.ProjectID,
			Title:         snapshot.Session.Title,
			Actor:         actor(snapshot.Session.Actor),
			Branch:        snapshot.Session.Branch,
			Status:        canonical.EffectiveSessionStatus(snapshot.Session.Status, snapshot.Session.UpdatedAt, m.now()),
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

func sessionSummary(stored canonical.ProjectSessionSnapshot, now time.Time) SessionSummary {
	return SessionSummary{
		ID:               stored.Session.ID,
		Title:            stored.Session.Title,
		Summary:          stored.Session.Summary,
		Insight:          stored.Session.Insight,
		Actor:            actor(stored.Session.Actor),
		Branch:           stored.Session.Branch,
		Status:           canonical.EffectiveSessionStatus(stored.Session.Status, stored.Session.UpdatedAt, now),
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
