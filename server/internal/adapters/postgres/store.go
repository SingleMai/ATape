// Package postgres implements durable Canonical persistence without exposing
// SQL rows or transaction sequencing to the ingestion and conversation Modules.
package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool    *pgxpool.Pool
	queries *db.Queries
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool, queries: db.New(pool)}
}

func (s *Store) ApplyBatch(
	ctx context.Context,
	principal authentication.Principal,
	batch canonical.WriteBatch,
) (canonical.ApplyResult, error) {
	if err := ctx.Err(); err != nil {
		return canonical.ApplyResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return canonical.ApplyResult{}, persist("begin batch transaction", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	if err := queries.AcquireCanonicalLock(ctx, "batch:"+batch.Key); err != nil {
		return canonical.ApplyResult{}, persist("lock batch", err)
	}
	if err := queries.AcquireCanonicalLock(ctx, "session:"+batch.Session.SourceKey); err != nil {
		return canonical.ApplyResult{}, persist("lock session", err)
	}
	project, err := resolveProjectAccess(
		ctx, queries, principal, batch.ProjectID, authorization.CanonicalIngest, true,
	)
	if err != nil {
		return canonical.ApplyResult{}, err
	}
	if project.projectState != "active" {
		return canonical.ApplyResult{}, &canonical.ProjectStateError{State: project.projectState}
	}
	if batch.Session.ProjectID != batch.ProjectID || batch.Session.CapturedByUserID != principal.UserID {
		return canonical.ApplyResult{}, conflict(batch.Session.ID, "server capture scope is inconsistent")
	}

	if receipt, err := queries.GetBatchReceipt(ctx, batch.Key); err == nil {
		if receipt.Digest != batch.Digest {
			return canonical.ApplyResult{}, conflict(batch.Key, "batchId was reused with different content")
		}
		return canonical.ApplyResult{
			SessionID:       receipt.SessionID,
			SessionCreated:  receipt.SessionCreated,
			InsertedEvents:  int(receipt.InsertedEvents),
			UpdatedEvents:   int(receipt.UpdatedEvents),
			UnchangedEvents: int(receipt.UnchangedEvents),
			StaleEvents:     int(receipt.StaleEvents),
			Replayed:        true,
		}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return canonical.ApplyResult{}, persist("read batch receipt", err)
	}

	result := canonical.ApplyResult{SessionID: batch.Session.ID}
	existingSession, err := queries.GetSessionForUpdate(ctx, batch.Session.ID)
	sessionExists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return canonical.ApplyResult{}, persist("read session", err)
	}
	if sessionExists {
		if existingSession.SourceKey != batch.Session.SourceKey {
			return canonical.ApplyResult{}, conflict(batch.Session.ID, "session id resolved from a different source")
		}
		if existingSession.ProjectID != batch.Session.ProjectID {
			return canonical.ApplyResult{}, conflict(batch.Session.SourceKey, "session project is immutable")
		}
		if domainUUID(existingSession.CapturedByUserID) != principal.UserID {
			return canonical.ApplyResult{}, conflict(batch.Session.SourceKey, "capturing User is immutable")
		}
		if existingSession.Revision == batch.Session.Revision && existingSession.Digest != batch.Session.Digest {
			return canonical.ApplyResult{}, conflict(batch.Session.SourceKey, "session revision has different content")
		}
	} else {
		params, mappingErr := insertSessionParams(batch.Session)
		if mappingErr != nil {
			return canonical.ApplyResult{}, conflict(batch.Session.ID, "capturing User is invalid")
		}
		if err := queries.InsertSession(ctx, params); err != nil {
			return canonical.ApplyResult{}, persist("insert session", err)
		}
	}
	result.SessionCreated = !sessionExists
	if sessionExists && batch.Session.Revision > existingSession.Revision {
		if err := queries.UpdateSession(ctx, updateSessionParams(batch.Session)); err != nil {
			return canonical.ApplyResult{}, persist("update session", err)
		}
	}

	for _, thread := range batch.Threads {
		existing, err := queries.GetThreadForUpdate(ctx, db.GetThreadForUpdateParams{
			SessionID: thread.SessionID,
			ID:        thread.ID,
		})
		exists := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return canonical.ApplyResult{}, persist("read thread", err)
		}
		if exists {
			if existing.SourceKey != thread.SourceKey {
				return canonical.ApplyResult{}, conflict(thread.ID, "thread id resolved from a different source")
			}
			if !sameOptionalString(existing.ParentThreadID, thread.ParentThreadID) {
				return canonical.ApplyResult{}, conflict(thread.SourceKey, "thread parent is immutable")
			}
			if existing.Revision == thread.Revision && existing.Digest != thread.Digest {
				return canonical.ApplyResult{}, conflict(thread.SourceKey, "thread revision has different content")
			}
		} else if err := queries.InsertThread(ctx, insertThreadParams(thread)); err != nil {
			return canonical.ApplyResult{}, persist("insert thread", err)
		}
		if exists && thread.Revision > existing.Revision {
			if err := queries.UpdateThread(ctx, updateThreadParams(thread)); err != nil {
				return canonical.ApplyResult{}, persist("update thread", err)
			}
		}
	}

	type eventMutation struct {
		record canonical.EventRecord
		insert bool
		apply  bool
	}
	mutations := make([]eventMutation, 0, len(batch.Events))
	for _, event := range batch.Events {
		existing, err := queries.GetEventBySourceForUpdate(ctx, event.SourceKey)
		if errors.Is(err, pgx.ErrNoRows) {
			collision, collisionErr := queries.GetEventByIDForUpdate(ctx, event.ID)
			if collisionErr == nil && collision.SourceKey != event.SourceKey {
				return canonical.ApplyResult{}, conflict(event.ID, "event id resolved from a different source")
			}
			if collisionErr != nil && !errors.Is(collisionErr, pgx.ErrNoRows) {
				return canonical.ApplyResult{}, persist("check event identity", collisionErr)
			}
			result.InsertedEvents++
			mutations = append(mutations, eventMutation{record: event, insert: true, apply: true})
			continue
		}
		if err != nil {
			return canonical.ApplyResult{}, persist("read event", err)
		}
		if existing.SessionID != event.SessionID || existing.ThreadID != event.ThreadID {
			return canonical.ApplyResult{}, conflict(event.SourceKey, "event session and thread are immutable")
		}
		switch {
		case event.ProjectionRevision < existing.ProjectionRevision:
			result.StaleEvents++
		case event.ProjectionRevision == existing.ProjectionRevision && event.Revision < existing.Revision:
			result.StaleEvents++
		case event.ProjectionRevision == existing.ProjectionRevision && event.Revision == existing.Revision && event.Digest == existing.Digest:
			result.UnchangedEvents++
		case event.ProjectionRevision == existing.ProjectionRevision && event.Revision == existing.Revision:
			return canonical.ApplyResult{}, conflict(event.SourceKey, "event revision has different content")
		default:
			result.UpdatedEvents++
			mutations = append(mutations, eventMutation{record: event, apply: true})
		}
	}

	for _, mutation := range mutations {
		if !mutation.apply {
			continue
		}
		metadata, err := queries.NextIngestMetadata(ctx)
		if err != nil {
			return canonical.ApplyResult{}, persist("allocate ingest sequence", err)
		}
		mutation.record.ObservedAt = batch.ObservedAt
		mutation.record.ReceivedAt = metadata.ReceivedAt
		mutation.record.IngestSeq = uint64(metadata.IngestSeq)
		if mutation.insert {
			if err := queries.InsertEvent(ctx, insertEventParams(mutation.record)); err != nil {
				return canonical.ApplyResult{}, persist("insert event", err)
			}
		} else if err := queries.UpdateEvent(ctx, updateEventParams(mutation.record)); err != nil {
			return canonical.ApplyResult{}, persist("update event", err)
		}
		if err := queries.InsertEventVersion(ctx, insertEventVersionParams(mutation.record)); err != nil {
			return canonical.ApplyResult{}, persist("append event version", err)
		}
		if err := queries.InsertProjectionChange(ctx, db.InsertProjectionChangeParams{
			EventID: mutation.record.ID, EventIngestSeq: int64(mutation.record.IngestSeq),
			ObservedAt: mutation.record.ObservedAt,
		}); err != nil {
			return canonical.ApplyResult{}, persist("append projection change", err)
		}
	}

	if err := queries.AdvanceProjectCapture(ctx, db.AdvanceProjectCaptureParams{
		ObservedAt: batch.ObservedAt,
		ProjectID:  batch.ProjectID,
	}); err != nil {
		return canonical.ApplyResult{}, persist("advance project capture", err)
	}
	if err := queries.InsertBatchReceipt(ctx, db.InsertBatchReceiptParams{
		BatchKey:        batch.Key,
		Digest:          batch.Digest,
		SessionID:       result.SessionID,
		SessionCreated:  result.SessionCreated,
		InsertedEvents:  int32(result.InsertedEvents),
		UpdatedEvents:   int32(result.UpdatedEvents),
		UnchangedEvents: int32(result.UnchangedEvents),
		StaleEvents:     int32(result.StaleEvents),
	}); err != nil {
		return canonical.ApplyResult{}, persist("record batch receipt", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.ApplyResult{}, persist("commit batch", err)
	}
	return result, nil
}

func (s *Store) Project(
	ctx context.Context,
	principal authentication.Principal,
	projectID string,
) (canonical.ProjectSnapshot, bool, error) {
	if err := ctx.Err(); err != nil {
		return canonical.ProjectSnapshot{}, false, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return canonical.ProjectSnapshot{}, false, persist("begin project read", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	if _, err := resolveProjectAccess(
		ctx, queries, principal, projectID, authorization.ProjectMemoryRead, false,
	); err != nil {
		if isConcealedAccess(err) {
			return canonical.ProjectSnapshot{}, false, nil
		}
		return canonical.ProjectSnapshot{}, false, err
	}
	project, err := queries.GetProjectForRead(ctx, projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return canonical.ProjectSnapshot{}, false, nil
	}
	if err != nil {
		return canonical.ProjectSnapshot{}, false, persist("read project", err)
	}
	rows, err := queries.ListProjectSessions(ctx, projectID)
	if err != nil {
		return canonical.ProjectSnapshot{}, false, persist("list project sessions", err)
	}
	snapshot := canonical.ProjectSnapshot{
		Project:         canonical.ProjectRecord{ID: project.ID, TeamID: project.TeamID, Name: project.Name, Type: project.ProjectType, State: project.State},
		CapturedThrough: project.CapturedThrough,
		Sessions:        make([]canonical.ProjectSessionSnapshot, 0, len(rows)),
	}
	for _, row := range rows {
		snapshot.Sessions = append(snapshot.Sessions, canonical.ProjectSessionSnapshot{
			Session:          sessionRecord(row.ID, row.ProjectID, domainUUID(row.CapturedByUserID), row.SourceKey, row.Revision, row.Digest, row.Title, row.Summary, row.Insight, row.ActorName, row.ActorHarness, row.Branch, row.Status, row.CaptureStatus, row.UpdatedAt, row.ReportedEventCount),
			EventCount:       int(row.EventCount),
			ChildThreadCount: int(row.ChildThreadCount),
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.ProjectSnapshot{}, false, persist("commit project read", err)
	}
	return snapshot, true, nil
}

func (s *Store) Conversation(
	ctx context.Context,
	principal authentication.Principal,
	sessionID string,
	threadID string,
) (canonical.ConversationSnapshot, bool, error) {
	if err := ctx.Err(); err != nil {
		return canonical.ConversationSnapshot{}, false, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return canonical.ConversationSnapshot{}, false, persist("begin conversation read", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	if _, err := resolveSessionAccess(
		ctx, queries, principal, sessionID, authorization.ConversationRead, false,
	); err != nil {
		if isConcealedAccess(err) {
			return canonical.ConversationSnapshot{}, false, nil
		}
		return canonical.ConversationSnapshot{}, false, err
	}
	storedSession, err := queries.GetSessionForRead(ctx, sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return canonical.ConversationSnapshot{}, false, nil
	}
	if err != nil {
		return canonical.ConversationSnapshot{}, false, persist("read conversation session", err)
	}
	storedThread, err := queries.GetThreadForRead(ctx, db.GetThreadForReadParams{SessionID: sessionID, ID: threadID})
	if errors.Is(err, pgx.ErrNoRows) {
		return canonical.ConversationSnapshot{}, false, nil
	}
	if err != nil {
		return canonical.ConversationSnapshot{}, false, persist("read conversation thread", err)
	}
	threadRows, err := queries.ListSessionThreads(ctx, sessionID)
	if err != nil {
		return canonical.ConversationSnapshot{}, false, persist("list conversation threads", err)
	}
	eventRows, err := queries.ListThreadEvents(ctx, db.ListThreadEventsParams{SessionID: sessionID, ThreadID: threadID})
	if err != nil {
		return canonical.ConversationSnapshot{}, false, persist("list conversation events", err)
	}
	snapshot := canonical.ConversationSnapshot{
		Session:     canonicalSession(storedSession),
		Thread:      canonicalThread(storedThread),
		Threads:     make([]canonical.ThreadRecord, 0, len(threadRows)),
		Events:      make([]canonical.EventRecord, 0, len(eventRows)),
		EventCounts: make(map[string]int, len(threadRows)),
	}
	for _, row := range threadRows {
		snapshot.Threads = append(snapshot.Threads, threadRecord(row.SessionID, row.ID, row.SourceKey, row.Revision, row.Digest, row.Label, row.Summary, row.ParentThreadID, row.CaptureStatus))
		snapshot.EventCounts[row.ID] = int(row.EventCount)
	}
	for _, row := range eventRows {
		snapshot.Events = append(snapshot.Events, canonicalEvent(row))
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.ConversationSnapshot{}, false, persist("commit conversation read", err)
	}
	return snapshot, true, nil
}

func persist(operation string, err error) error {
	return fmt.Errorf("postgresql Canonical Store: %s: %w", operation, err)
}

func conflict(identity string, reason string) error {
	return &canonical.ConflictError{Identity: identity, Reason: reason}
}

func sameOptionalString(left *string, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
