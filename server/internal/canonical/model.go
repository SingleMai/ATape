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
	State  string
}

type SessionRecord struct {
	ID                 string
	ProjectID          string
	CapturedByUserID   string
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
	ToolUpdateJSON     string `json:"ToolUpdateJSON,omitempty"`
	ChildThreadID      *string
}

// SameEventContent compares an already normalized Event independently of transport
// provenance. Package/profile upgrades alone must not invalidate an acknowledged
// revision. Real projection changes (including tool details and Raw references)
// still require a higher source or projection revision. Existing digests remain
// readable, so this also handles records written before this comparison existed.
func SameEventContent(left, right EventRecord) bool {
	if !left.OccurredAt.Equal(right.OccurredAt) || !sameOptionalString(left.ChildThreadID, right.ChildThreadID) {
		return false
	}
	left.Digest, right.Digest = "", ""
	left.AdapterVersion, right.AdapterVersion = "", ""
	left.SchemaVersion, right.SchemaVersion = "", ""
	left.ObservedAt, right.ObservedAt = time.Time{}, time.Time{}
	left.ReceivedAt, right.ReceivedAt = time.Time{}, time.Time{}
	left.OccurredAt, right.OccurredAt = time.Time{}, time.Time{}
	left.IngestSeq, right.IngestSeq = 0, 0
	left.ChildThreadID, right.ChildThreadID = nil, nil
	return left == right
}

type WriteBatch struct {
	Key        string
	Digest     string
	ObservedAt time.Time
	ProjectID  string
	Session    SessionRecord
	Threads    []ThreadRecord
	Events     []EventRecord
	Usage      []UsageRecord
}

// Usage is independent of event content and Search. Input includes cache
// subdivisions, output includes reasoning, and nil means not reported.
type UsageRecord struct {
	SourceKey        string
	SessionID        string
	ThreadID         string
	Revision         int64
	Digest           string
	OccurredAt       time.Time
	Model            string
	InputTokens      *int64
	OutputTokens     *int64
	CacheReadTokens  *int64
	CacheWriteTokens *int64
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

type CapturedUser struct {
	ID          string
	DisplayName string
	AvatarURL   string
}

type ConversationSnapshot struct {
	Head        string
	NextEventID string
	CapturedBy  *CapturedUser
	Session     SessionRecord
	Thread      ThreadRecord
	Threads     []ThreadRecord
	Events      []EventRecord
	EventCounts map[string]int
}

type ConversationPageRequest struct {
	Head         string
	AfterEventID string
	AtEventID    string
	Limit        int
}

type RefreshRequiredError struct{ Head string }

func (e *RefreshRequiredError) Error() string {
	return "conversation head changed; refresh from the selected head"
}

// PaginationRequiredError prevents older callers from mistaking a bounded page
// for an entire publication-mode conversation.
type PaginationRequiredError struct{}

func (*PaginationRequiredError) Error() string {
	return "conversation requires the bounded page Interface"
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
	PublicationHead       string
	PublicationDescriptor string
	ProjectID             string
	SessionID             string
	SessionTitle          string
	ThreadID              string
	ThreadPath            []ProjectionThread
	EventID               string
	Author                string
	Harness               string
	OccurredAt            time.Time
	Text                  string
	ToolLabel             string
	IngestSeq             uint64
	ObservedAt            time.Time
}

type ProjectionChange struct {
	ID       int64
	Document EventProjection
}

type ConflictError struct {
	Identity string
	Reason   string
}

type ProjectStateError struct {
	State string
}

func (e *ProjectStateError) Error() string {
	return fmt.Sprintf("canonical ingestion is unavailable while project is %q", e.State)
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("canonical identity %q conflicts: %s", e.Identity, e.Reason)
}
