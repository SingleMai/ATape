// Package canonical contains the server's transport-neutral Canonical records
// shared at the persistence Seams of ingestion and conversation reads.
package canonical

import (
	"fmt"
	"time"
)

type Actor struct {
	Name    string
	Harness string
}

type TeamRecord struct {
	ID   string
	Name string
}

type ProjectRecord struct {
	ID     string
	TeamID string
	Name   string
	Type   string
}

type SessionRecord struct {
	ID                 string
	ProjectID          string
	SourceKey          string
	Revision           int64
	Digest             string
	Title              string
	Summary            string
	Insight            string
	Actor              Actor
	Branch             string
	Status             string
	CaptureStatus      string
	UpdatedAt          time.Time
	ReportedEventCount int
}

type ThreadRecord struct {
	ID             string
	SessionID      string
	SourceKey      string
	Revision       int64
	Digest         string
	Label          string
	Summary        string
	ParentThreadID *string
	CaptureStatus  string
}

type EventRecord struct {
	ID                 string
	SessionID          string
	ThreadID           string
	SourceKey          string
	Revision           int64
	ProjectionRevision int64
	Digest             string
	SourceOrder        int64
	EventIndex         int
	OrderFidelity      string
	Fidelity           string
	RawRef             string
	AdapterVersion     string
	SchemaVersion      string
	ObservedAt         time.Time
	ReceivedAt         time.Time
	IngestSeq          uint64
	Kind               string
	Author             string
	OccurredAt         time.Time
	Text               string
	ToolLabel          string
	ChildThreadID      *string
}

type WriteBatch struct {
	Key        string
	Digest     string
	ObservedAt time.Time
	Team       TeamRecord
	Project    ProjectRecord
	Session    SessionRecord
	Threads    []ThreadRecord
	Events     []EventRecord
}

type ApplyResult struct {
	SessionID       string `json:"sessionId"`
	SessionCreated  bool   `json:"sessionCreated"`
	InsertedEvents  int    `json:"insertedEvents"`
	UpdatedEvents   int    `json:"updatedEvents"`
	UnchangedEvents int    `json:"unchangedEvents"`
	StaleEvents     int    `json:"staleEvents"`
	Replayed        bool   `json:"replayed"`
}

type ProjectSessionSnapshot struct {
	Session          SessionRecord
	EventCount       int
	ChildThreadCount int
}

type ProjectSnapshot struct {
	Project         ProjectRecord
	CapturedThrough time.Time
	Sessions        []ProjectSessionSnapshot
}

type WorkspaceProjectSnapshot struct {
	Project            ProjectRecord
	CapturedThrough    time.Time
	SessionCount       int
	ActiveSessionCount int
}

type WorkspaceSnapshot struct {
	Teams    []TeamRecord
	Projects []WorkspaceProjectSnapshot
}

type ConversationSnapshot struct {
	Session     SessionRecord
	Thread      ThreadRecord
	Threads     []ThreadRecord
	Events      []EventRecord
	EventCounts map[string]int
}

// ProjectionThread is the minimal Thread identity copied into a derived read
// model. It intentionally contains no Raw source data.
type ProjectionThread struct {
	ID    string
	Label string
}

// EventProjection is the current Canonical document made available to derived
// read models. Search owns how this document is indexed and queried.
type EventProjection struct {
	ProjectID    string
	SessionID    string
	SessionTitle string
	ThreadID     string
	ThreadPath   []ProjectionThread
	EventID      string
	Author       string
	Harness      string
	OccurredAt   time.Time
	Text         string
	ToolLabel    string
	IngestSeq    uint64
	ObservedAt   time.Time
}

type ProjectionChange struct {
	ID       int64
	Document EventProjection
}

type ConflictError struct {
	Identity string
	Reason   string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("canonical identity %q conflicts: %s", e.Identity, e.Reason)
}
