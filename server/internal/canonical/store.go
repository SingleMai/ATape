package canonical

import (
	"context"
	"sync"
	"time"
)

type batchReceipt struct {
	digest string
	result ApplyResult
}

type projectionChangeState struct {
	id         int64
	eventID    string
	leaseOwner string
	leaseUntil time.Time
	processed  bool
}

// MemoryStore is the current Canonical persistence Adapter. It protects all
// state with one bounded critical section so ApplyBatch has exactly-once effect
// and readers never observe a partially applied batch.
type MemoryStore struct {
	mu sync.RWMutex

	teams                    map[string]TeamRecord
	projects                 map[string]ProjectRecord
	projectCapture           map[string]time.Time
	sessions                 map[string]SessionRecord
	sessionIDsByProject      map[string]map[string]struct{}
	threads                  map[string]ThreadRecord
	threadIDsBySession       map[string]map[string]struct{}
	events                   map[string]EventRecord
	eventBySource            map[string]string
	eventVersions            map[string][]EventRecord
	eventIDsByThread         map[string]map[string]struct{}
	sessionEventCounts       map[string]int
	sessionChildThreadCounts map[string]int
	batchReceipts            map[string]batchReceipt
	nextIngestSeq            uint64
	projectionChanges        []projectionChangeState
	nextProjectionChangeID   int64
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		teams:                    make(map[string]TeamRecord),
		projects:                 make(map[string]ProjectRecord),
		projectCapture:           make(map[string]time.Time),
		sessions:                 make(map[string]SessionRecord),
		sessionIDsByProject:      make(map[string]map[string]struct{}),
		threads:                  make(map[string]ThreadRecord),
		threadIDsBySession:       make(map[string]map[string]struct{}),
		events:                   make(map[string]EventRecord),
		eventBySource:            make(map[string]string),
		eventVersions:            make(map[string][]EventRecord),
		eventIDsByThread:         make(map[string]map[string]struct{}),
		sessionEventCounts:       make(map[string]int),
		sessionChildThreadCounts: make(map[string]int),
		batchReceipts:            make(map[string]batchReceipt),
		projectionChanges:        make([]projectionChangeState, 0),
	}
}

func (s *MemoryStore) ApplyBatch(ctx context.Context, batch WriteBatch) (ApplyResult, error) {
	if err := ctx.Err(); err != nil {
		return ApplyResult{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if receipt, ok := s.batchReceipts[batch.Key]; ok {
		if receipt.digest != batch.Digest {
			return ApplyResult{}, &ConflictError{Identity: batch.Key, Reason: "batchId was reused with different content"}
		}
		result := receipt.result
		result.Replayed = true
		return result, nil
	}

	if team, ok := s.teams[batch.Team.ID]; ok && team != batch.Team {
		return ApplyResult{}, &ConflictError{Identity: batch.Team.ID, Reason: "team identity is immutable"}
	}
	if project, ok := s.projects[batch.Project.ID]; ok && project != batch.Project {
		return ApplyResult{}, &ConflictError{Identity: batch.Project.ID, Reason: "project identity is immutable"}
	}

	result := ApplyResult{SessionID: batch.Session.ID}
	existingSession, sessionExists := s.sessions[batch.Session.ID]
	if sessionExists && existingSession.SourceKey != batch.Session.SourceKey {
		return ApplyResult{}, &ConflictError{Identity: batch.Session.ID, Reason: "session id resolved from a different source"}
	}
	if sessionExists && existingSession.ProjectID != batch.Session.ProjectID {
		return ApplyResult{}, &ConflictError{Identity: batch.Session.SourceKey, Reason: "session project is immutable"}
	}
	if sessionExists && existingSession.Revision == batch.Session.Revision && existingSession.Digest != batch.Session.Digest {
		return ApplyResult{}, &ConflictError{Identity: batch.Session.SourceKey, Reason: "session revision has different content"}
	}
	result.SessionCreated = !sessionExists

	for _, thread := range batch.Threads {
		existing, ok := s.threads[recordKey(thread.SessionID, thread.ID)]
		if ok && existing.SourceKey != thread.SourceKey {
			return ApplyResult{}, &ConflictError{Identity: thread.ID, Reason: "thread id resolved from a different source"}
		}
		if ok && !sameOptionalString(existing.ParentThreadID, thread.ParentThreadID) {
			return ApplyResult{}, &ConflictError{Identity: thread.SourceKey, Reason: "thread parent is immutable"}
		}
		if ok && existing.Revision == thread.Revision && existing.Digest != thread.Digest {
			return ApplyResult{}, &ConflictError{Identity: thread.SourceKey, Reason: "thread revision has different content"}
		}
	}

	type eventMutation struct {
		record EventRecord
		apply  bool
	}
	mutations := make([]eventMutation, 0, len(batch.Events))
	for _, event := range batch.Events {
		existingID, ok := s.eventBySource[event.SourceKey]
		if !ok {
			if existing, collision := s.events[event.ID]; collision && existing.SourceKey != event.SourceKey {
				return ApplyResult{}, &ConflictError{Identity: event.ID, Reason: "event id resolved from a different source"}
			}
			result.InsertedEvents++
			mutations = append(mutations, eventMutation{record: event, apply: true})
			continue
		}

		existing := s.events[existingID]
		if existing.SessionID != event.SessionID || existing.ThreadID != event.ThreadID {
			return ApplyResult{}, &ConflictError{Identity: event.SourceKey, Reason: "event session and thread are immutable"}
		}
		switch {
		case event.ProjectionRevision < existing.ProjectionRevision:
			result.StaleEvents++
			mutations = append(mutations, eventMutation{record: event})
		case event.ProjectionRevision == existing.ProjectionRevision && event.Revision < existing.Revision:
			result.StaleEvents++
			mutations = append(mutations, eventMutation{record: event})
		case event.ProjectionRevision == existing.ProjectionRevision && event.Revision == existing.Revision && event.Digest == existing.Digest:
			result.UnchangedEvents++
			mutations = append(mutations, eventMutation{record: event})
		case event.ProjectionRevision == existing.ProjectionRevision && event.Revision == existing.Revision:
			return ApplyResult{}, &ConflictError{Identity: event.SourceKey, Reason: "event revision has different content"}
		default:
			result.UpdatedEvents++
			mutations = append(mutations, eventMutation{record: event, apply: true})
		}
	}

	s.teams[batch.Team.ID] = batch.Team
	s.projects[batch.Project.ID] = batch.Project
	if !sessionExists || batch.Session.Revision > existingSession.Revision {
		s.sessions[batch.Session.ID] = batch.Session
	}
	if !sessionExists {
		addToIndex(s.sessionIDsByProject, batch.Project.ID, batch.Session.ID)
	}
	for _, thread := range batch.Threads {
		key := recordKey(thread.SessionID, thread.ID)
		existing, ok := s.threads[key]
		if !ok || thread.Revision > existing.Revision {
			s.threads[key] = cloneThread(thread)
		}
		if !ok {
			addToIndex(s.threadIDsBySession, thread.SessionID, thread.ID)
			if thread.ParentThreadID != nil {
				s.sessionChildThreadCounts[thread.SessionID]++
			}
		}
	}
	for _, mutation := range mutations {
		if !mutation.apply {
			continue
		}
		_, existed := s.events[mutation.record.ID]
		s.nextIngestSeq++
		mutation.record.IngestSeq = s.nextIngestSeq
		mutation.record.ObservedAt = batch.ObservedAt
		mutation.record.ReceivedAt = time.Now().UTC()
		s.events[mutation.record.ID] = cloneEvent(mutation.record)
		s.eventBySource[mutation.record.SourceKey] = mutation.record.ID
		s.eventVersions[mutation.record.SourceKey] = append(
			s.eventVersions[mutation.record.SourceKey],
			cloneEvent(mutation.record),
		)
		s.appendProjectionChange(mutation.record.ID)
		if !existed {
			addToIndex(s.eventIDsByThread, recordKey(mutation.record.SessionID, mutation.record.ThreadID), mutation.record.ID)
			s.sessionEventCounts[mutation.record.SessionID]++
		}
	}

	if current, ok := s.projectCapture[batch.Project.ID]; !ok || batch.ObservedAt.After(current) {
		s.projectCapture[batch.Project.ID] = batch.ObservedAt
	}
	s.batchReceipts[batch.Key] = batchReceipt{digest: batch.Digest, result: result}

	return result, nil
}

func (s *MemoryStore) Workspace(ctx context.Context) (WorkspaceSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	snapshot := WorkspaceSnapshot{
		Teams:    make([]TeamRecord, 0, len(s.teams)),
		Projects: make([]WorkspaceProjectSnapshot, 0, len(s.projects)),
	}
	for _, team := range s.teams {
		snapshot.Teams = append(snapshot.Teams, team)
	}
	for projectID, project := range s.projects {
		entry := WorkspaceProjectSnapshot{
			Project:         project,
			CapturedThrough: s.projectCapture[projectID],
			SessionCount:    len(s.sessionIDsByProject[projectID]),
		}
		for sessionID := range s.sessionIDsByProject[projectID] {
			if s.sessions[sessionID].Status == "active" {
				entry.ActiveSessionCount++
			}
		}
		snapshot.Projects = append(snapshot.Projects, entry)
	}
	return snapshot, nil
}

// LeaseProjectionChanges exposes a bounded Canonical change feed without
// leaking the Store's internal maps to derived read models.
func (s *MemoryStore) LeaseProjectionChanges(
	ctx context.Context,
	owner string,
	limit int,
	leaseUntil time.Time,
) ([]ProjectionChange, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit <= 0 {
		return []ProjectionChange{}, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	changes := make([]ProjectionChange, 0, limit)
	for index := range s.projectionChanges {
		state := &s.projectionChanges[index]
		if state.processed || (state.leaseOwner != "" && state.leaseUntil.After(now)) {
			continue
		}
		document, ok := s.eventProjection(state.eventID)
		if !ok {
			state.processed = true
			continue
		}
		state.leaseOwner = owner
		state.leaseUntil = leaseUntil
		changes = append(changes, ProjectionChange{ID: state.id, Document: document})
		if len(changes) == limit {
			break
		}
	}
	return changes, nil
}

func (s *MemoryStore) AckProjectionChanges(ctx context.Context, owner string, ids []int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	wanted := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		wanted[id] = struct{}{}
	}
	for index := range s.projectionChanges {
		state := &s.projectionChanges[index]
		if _, ok := wanted[state.id]; ok && state.leaseOwner == owner {
			state.processed = true
			state.leaseOwner = ""
			state.leaseUntil = time.Time{}
		}
	}
	return nil
}

func (s *MemoryStore) appendProjectionChange(eventID string) {
	s.nextProjectionChangeID++
	s.projectionChanges = append(s.projectionChanges, projectionChangeState{
		id:      s.nextProjectionChangeID,
		eventID: eventID,
	})
}

func (s *MemoryStore) eventProjection(eventID string) (EventProjection, bool) {
	event, ok := s.events[eventID]
	if !ok {
		return EventProjection{}, false
	}
	session, ok := s.sessions[event.SessionID]
	if !ok {
		return EventProjection{}, false
	}
	path := make([]ProjectionThread, 0, 2)
	thread, ok := s.threads[recordKey(event.SessionID, event.ThreadID)]
	if !ok {
		return EventProjection{}, false
	}
	for {
		path = append(path, ProjectionThread{ID: thread.ID, Label: thread.Label})
		if thread.ParentThreadID == nil {
			break
		}
		parent, exists := s.threads[recordKey(event.SessionID, *thread.ParentThreadID)]
		if !exists {
			break
		}
		thread = parent
	}
	for left, right := 0, len(path)-1; left < right; left, right = left+1, right-1 {
		path[left], path[right] = path[right], path[left]
	}
	return EventProjection{
		ProjectID: session.ProjectID, SessionID: session.ID, SessionTitle: session.Title,
		ThreadID: event.ThreadID, ThreadPath: path, EventID: event.ID,
		Author: event.Author, Harness: session.Actor.Harness, OccurredAt: event.OccurredAt,
		Text: event.Text, ToolLabel: event.ToolLabel, IngestSeq: event.IngestSeq,
		ObservedAt: event.ObservedAt,
	}, true
}

func (s *MemoryStore) Project(ctx context.Context, projectID string) (ProjectSnapshot, bool, error) {
	if err := ctx.Err(); err != nil {
		return ProjectSnapshot{}, false, err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	project, ok := s.projects[projectID]
	if !ok {
		return ProjectSnapshot{}, false, nil
	}

	snapshot := ProjectSnapshot{Project: project}
	if capture, ok := s.projectCapture[projectID]; ok {
		snapshot.CapturedThrough = capture
	}
	for sessionID := range s.sessionIDsByProject[projectID] {
		session := s.sessions[sessionID]
		eventCount := session.ReportedEventCount
		actualEventCount := s.sessionEventCounts[session.ID]
		if actualEventCount > eventCount {
			eventCount = actualEventCount
		}
		snapshot.Sessions = append(snapshot.Sessions, ProjectSessionSnapshot{
			Session:          session,
			EventCount:       eventCount,
			ChildThreadCount: s.sessionChildThreadCounts[session.ID],
		})
	}
	return snapshot, true, nil
}

func (s *MemoryStore) Conversation(
	ctx context.Context,
	sessionID string,
	threadID string,
) (ConversationSnapshot, bool, error) {
	if err := ctx.Err(); err != nil {
		return ConversationSnapshot{}, false, err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	session, ok := s.sessions[sessionID]
	if !ok {
		return ConversationSnapshot{}, false, nil
	}
	thread, ok := s.threads[recordKey(sessionID, threadID)]
	if !ok {
		return ConversationSnapshot{}, false, nil
	}

	snapshot := ConversationSnapshot{
		Session:     session,
		Thread:      cloneThread(thread),
		EventCounts: make(map[string]int),
	}
	for candidateID := range s.threadIDsBySession[sessionID] {
		candidate := s.threads[recordKey(sessionID, candidateID)]
		snapshot.Threads = append(snapshot.Threads, cloneThread(candidate))
		snapshot.EventCounts[candidateID] = len(s.eventIDsByThread[recordKey(sessionID, candidateID)])
	}
	for eventID := range s.eventIDsByThread[recordKey(sessionID, threadID)] {
		snapshot.Events = append(snapshot.Events, cloneEvent(s.events[eventID]))
	}
	return snapshot, true, nil
}

func recordKey(sessionID string, recordID string) string {
	return sessionID + "\x00" + recordID
}

func addToIndex(index map[string]map[string]struct{}, key string, value string) {
	values := index[key]
	if values == nil {
		values = make(map[string]struct{})
		index[key] = values
	}
	values[value] = struct{}{}
}

func sameOptionalString(left *string, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func cloneThread(thread ThreadRecord) ThreadRecord {
	if thread.ParentThreadID != nil {
		parent := *thread.ParentThreadID
		thread.ParentThreadID = &parent
	}
	return thread
}

func cloneEvent(event EventRecord) EventRecord {
	if event.ChildThreadID != nil {
		child := *event.ChildThreadID
		event.ChildThreadID = &child
	}
	return event
}
