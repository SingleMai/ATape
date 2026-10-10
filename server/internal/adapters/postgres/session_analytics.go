package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/jackc/pgx/v5"
)

// SessionAnalytics owns one authorized, bounded, consistent Canonical read.
// No provider formats, Raw bodies, Search documents or candidate facts enter it.
func (s *Store) SessionAnalytics(ctx context.Context, p authentication.Principal, sessionID, expected string) (canonical.AnalyticsSnapshot, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return canonical.AnalyticsSnapshot{}, false, persist("begin analysis read", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	result, ok, err := readAnalyticsSnapshot(ctx, s.queries.WithTx(tx), p, sessionID, expected)
	if err != nil || !ok {
		return result, ok, err
	}
	if err = tx.Commit(ctx); err != nil {
		return canonical.AnalyticsSnapshot{}, false, persist("commit analysis read", err)
	}
	return result, true, nil
}

func readAnalyticsSnapshot(ctx context.Context, q *db.Queries, p authentication.Principal, sessionID, expected string) (canonical.AnalyticsSnapshot, bool, error) {
	result := canonical.AnalyticsSnapshot{Threads: []canonical.ThreadRecord{}, Events: []canonical.EventRecord{}, Usage: []canonical.UsageRecord{}}
	if _, err := resolveSessionAccess(ctx, q, p, sessionID, authorization.ConversationRead, false); err != nil {
		if isConcealedAccess(err) {
			return result, false, nil
		}
		return result, false, err
	}
	stored, err := q.GetSessionForRead(ctx, sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, false, nil
	}
	if err != nil {
		return result, false, persist("read analysis session", err)
	}
	result.Session = canonicalSession(stored)
	source, err := q.GetPublicationSource(ctx, sessionID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, false, persist("read analysis head", err)
	}
	if source.CurrentHead != nil {
		result.Head = *source.CurrentHead
		result.SnapshotToken = "publication:" + result.Head
		if expected != "" && expected != result.SnapshotToken {
			return result, false, &canonical.RefreshRequiredError{Head: result.Head}
		}
	}
	if result.Head == "" {
		bytes, err := q.AnalyticsNativeBytes(ctx, sessionID)
		if err != nil {
			return result, false, persist("read native analysis bound", err)
		}
		if bytes > canonical.AnalyticsSourceBytes {
			return result, false, canonical.ErrAnalyticsCapacity
		}
	}
	threads, err := q.ListAnalyticsThreads(ctx, db.ListAnalyticsThreadsParams{SessionID: sessionID, Limit: canonical.AnalyticsThreadLimit + 1})
	if err != nil {
		return result, false, persist("read analysis threads", err)
	}
	if len(threads) > canonical.AnalyticsThreadLimit {
		return result, false, canonical.ErrAnalyticsCapacity
	}
	for _, row := range threads {
		result.Threads = append(result.Threads, canonicalThread(db.CanonicalThread(row)))
	}
	bodies := map[string]canonical.EventBodyDigest{}
	metadataBytes := 0
	appendEvent := func(event canonical.EventRecord, body canonical.EventBodyDigest) error {
		if len(result.Events) >= canonical.AnalyticsRecordLimit {
			return canonical.ErrAnalyticsCapacity
		}
		metadataBytes += canonical.AnalyticsEventMetadataBytes(event)
		if metadataBytes > canonical.AnalyticsMetadataBytes {
			return canonical.ErrAnalyticsCapacity
		}
		result.Events = append(result.Events, event)
		if result.Head == "" {
			bodies[event.ID] = body
		}
		return nil
	}
	if result.Head == "" {
		rows, err := q.ListAnalyticsNativeEvents(ctx, db.ListAnalyticsNativeEventsParams{SessionID: sessionID, Limit: canonical.AnalyticsRecordLimit + 1})
		if err != nil {
			return result, false, persist("read native analysis events", err)
		}
		for _, row := range rows {
			event := canonical.EventRecord{ID: row.ID, SessionID: row.SessionID, ThreadID: row.ThreadID, SourceKey: row.SourceKey,
				Revision: row.Revision, ProjectionRevision: row.ProjectionRevision, SourceOrder: row.SourceOrder, EventIndex: int(row.EventIndex),
				OrderFidelity: row.OrderFidelity, Fidelity: row.Fidelity, Kind: row.Kind, Author: row.Author, OccurredAt: domainTime(row.OccurredAt),
				ToolLabel: row.ToolLabel, ToolUpdateJSON: row.ToolUpdateJson, ChildThreadID: row.ChildThreadID}
			if err := appendEvent(event, canonical.EventBodyDigest{Text: row.TextDigest, Tool: row.ToolDigest}); err != nil {
				return result, false, err
			}
		}
		usage, err := q.ListAnalyticsNativeUsage(ctx, db.ListAnalyticsNativeUsageParams{SessionID: sessionID, Limit: canonical.AnalyticsRecordLimit + 1})
		if err != nil {
			return result, false, persist("read native analysis usage", err)
		}
		if len(usage) > canonical.AnalyticsRecordLimit {
			return result, false, canonical.ErrAnalyticsCapacity
		}
		for _, row := range usage {
			result.Usage = append(result.Usage, canonical.UsageRecord{SourceKey: row.SourceKey, SessionID: row.SessionID, ThreadID: row.ThreadID, Revision: row.Revision,
				OccurredAt: row.OccurredAt, Model: row.Model, InputTokens: row.InputTokens, OutputTokens: row.OutputTokens, CacheReadTokens: row.CacheReadTokens, CacheWriteTokens: row.CacheWriteTokens})
		}
	} else {
		id, err := publicationID(result.Head)
		if err != nil {
			return result, false, err
		}
		storedBytes, err := q.AnalyticsPublicationBytes(ctx, id)
		if err != nil {
			return result, false, persist("read analysis source bound", err)
		}
		if storedBytes > canonical.AnalyticsSourceBytes {
			return result, false, canonical.ErrAnalyticsCapacity
		}
		members, err := q.ListAnalyticsPublicationMembers(ctx, db.ListAnalyticsPublicationMembersParams{AttemptID: id, Limit: 2*canonical.AnalyticsRecordLimit + 1})
		if err != nil {
			return result, false, persist("read analysis membership", err)
		}
		if len(members) > 2*canonical.AnalyticsRecordLimit {
			return result, false, canonical.ErrAnalyticsCapacity
		}
		var part canonical.WriteBatch
		ordinal := int32(-1)
		for _, member := range members {
			if err := ctx.Err(); err != nil {
				return result, false, err
			}
			if member.PartOrdinal != ordinal {
				part, err = fixedPublicationPart(ctx, q, id, member.PartOrdinal)
				if err != nil {
					return result, false, err
				}
				ordinal = member.PartOrdinal
			}
			i := int(member.EntryIndex)
			switch member.Kind {
			case "event":
				if i < 0 || i >= len(part.Events) || part.Events[i].ID != member.RecordID {
					return result, false, persist("read analysis event", errors.New("invalid member coordinate"))
				}
				event, err := canonical.AnalyticsEvent(part.Events[i])
				if err != nil {
					return result, false, err
				}
				if err := appendEvent(event, canonical.EventBodyDigest{}); err != nil {
					return result, false, err
				}
			case "usage":
				if i < 0 || i >= len(part.Usage) || part.Usage[i].SourceKey != member.SourceKey {
					return result, false, persist("read analysis usage", errors.New("invalid member coordinate"))
				}
				if len(result.Usage) >= canonical.AnalyticsRecordLimit {
					return result, false, canonical.ErrAnalyticsCapacity
				}
				result.Usage = append(result.Usage, part.Usage[i])
			}
		}
	}
	result.SnapshotToken = canonical.AnalyticsSnapshotToken(result, bodies)
	if expected != "" && expected != result.SnapshotToken {
		return result, false, &canonical.RefreshRequiredError{Head: result.Head}
	}
	return result, true, nil
}
