package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/sourceidentity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// Retention is private materialization, never a fabricated client part. Each
// Validate reads at most 50 baseline members and commits one size-bounded unit.
// Its durable cursor and derived storage accounting commit with membership.
type retentionCursor struct {
	Thread int    `json:"thread"`
	Usage  bool   `json:"usage"`
	After  string `json:"after"`
}

var errRetentionReadBudget = errors.New("retention read unit budget reached")

type retentionBaseline struct {
	q                *db.Queries
	source           db.CanonicalPublicationSource
	limit, remaining int64
	units            map[int32]canonical.WriteBatch
}

func (b *retentionBaseline) fixed(ctx context.Context, head pgtype.UUID, ordinal int32) (canonical.WriteBatch, error) {
	if value, ok := b.units[ordinal]; ok {
		return value, nil
	}
	metadata, err := b.q.GetPublicationPartStorage(ctx, db.GetPublicationPartStorageParams{AttemptID: head, Ordinal: ordinal})
	if err != nil {
		return canonical.WriteBatch{}, persist("read retained baseline unit bound", err)
	}
	if metadata.StoredBytes > b.limit {
		return canonical.WriteBatch{}, publicationError("capacity", "baseline unit exceeds current retention read budget")
	}
	if metadata.StoredBytes > b.remaining {
		return canonical.WriteBatch{}, errRetentionReadBudget
	}
	value, err := fixedPublicationPart(ctx, b.q, head, ordinal)
	if err != nil {
		return value, err
	}
	b.remaining -= metadata.StoredBytes
	b.units[ordinal] = value
	return value, nil
}

func (s *PublicationStore) validateRetention(ctx context.Context, q *db.Queries, userID, id pgtype.UUID, source db.CanonicalPublicationSource, row db.GetPublicationAttemptRow, a publication.Attempt) (publication.Attempt, error) {
	if row.TargetJson == nil {
		return a, publicationError("invalid", "validated target declaration is absent")
	}
	var target publication.Target
	if err := json.Unmarshal([]byte(*row.TargetJson), &target); err != nil {
		return a, persist("decode retention declaration", err)
	}
	first, err := fixedPublicationPart(ctx, q, id, 0)
	if err != nil {
		return a, err
	}
	threads, err := retentionThreads(ctx, q, source, target, first.Threads)
	if err != nil {
		return a, err
	}
	cursor := retentionCursor{}
	if row.RetentionCursor != "" {
		if err = json.Unmarshal([]byte(row.RetentionCursor), &cursor); err != nil {
			return a, persist("decode retention progress", err)
		}
	}
	baseline := &retentionBaseline{q: q, source: source, limit: s.limits.PartBytes, remaining: s.limits.PartBytes, units: make(map[int32]canonical.WriteBatch)}
	unit := first
	unit.Events = []canonical.EventRecord{}
	unit.Usage = []canonical.UsageRecord{}
	for n := 0; n < 50 && cursor.Thread < len(threads); {
		previous := cursor
		if !cursor.Usage {
			event, next, e := baselineEvent(ctx, baseline, threads[cursor.Thread].ID, cursor.After)
			if errors.Is(e, errRetentionReadBudget) {
				break
			}
			if e != nil {
				return a, e
			}
			if event == nil {
				cursor.Usage = true
				cursor.After = ""
				continue
			}
			unit.Events = append(unit.Events, *event)
			cursor.After = next
		} else {
			usage, next, e := baselineUsage(ctx, baseline, threads[cursor.Thread].ID, cursor.After)
			if errors.Is(e, errRetentionReadBudget) {
				break
			}
			if e != nil {
				return a, e
			}
			if usage == nil {
				cursor.Thread++
				cursor.Usage = false
				cursor.After = ""
				continue
			}
			unit.Usage = append(unit.Usage, *usage)
			cursor.After = next
		}
		if !cursor.Usage {
			event := unit.Events[len(unit.Events)-1]
			if event.ChildThreadID != nil {
				found := false
				for _, thread := range unit.Threads {
					if thread.ID == *event.ChildThreadID && thread.ParentThreadID != nil && *thread.ParentThreadID == event.ThreadID {
						found = true
						break
					}
				}
				if !found {
					return a, publicationError("invalid", "retained Event references a child outside the target topology")
				}
			}
		}
		encoded, e := json.Marshal(unit)
		if e != nil {
			return a, persist("encode retained unit", e)
		}
		if int64(len(encoded)) > s.limits.PartBytes {
			if !previous.Usage {
				unit.Events = unit.Events[:len(unit.Events)-1]
			} else {
				unit.Usage = unit.Usage[:len(unit.Usage)-1]
			}
			cursor = previous
			if len(unit.Events)+len(unit.Usage) == 0 {
				return a, publicationError("capacity", "retained member exceeds current part budget")
			}
			break
		}
		n++
	}
	done := cursor.Thread == len(threads)
	parts := int32(0)
	bytes := int64(0)
	if len(unit.Events)+len(unit.Usage) > 0 {
		if int(row.DerivedParts)+a.Seal.Parts >= s.limits.Parts {
			return a, publicationError("capacity", "retention exceeds configured storage unit budget")
		}
		encoded, e := json.Marshal(unit)
		if e != nil {
			return a, persist("encode retained Canonical unit", e)
		}
		bytes = int64(len(encoded))
		usage, e := q.PublicationUsage(ctx, userID)
		if e != nil {
			return a, persist("read retention storage budget", e)
		}
		if bytes > s.limits.TargetBytes-a.RetainedBytes || bytes > s.limits.UserPendingBytes-usage.RetainedBytes {
			return a, publicationError("capacity", "retention exceeds pending payload budget")
		}
		ordinal := int32(a.Seal.Parts) + row.DerivedParts
		sum := sha256.Sum256(encoded)
		if err = q.InsertDerivedPublicationPart(ctx, db.InsertDerivedPublicationPartParams{AttemptID: id, Ordinal: ordinal, Digest: hex.EncodeToString(sum[:]), ByteCount: bytes, ValidatedBody: encoded}); err != nil {
			return a, persist("store inherited unit", err)
		}
		if err = materializePublicationContent(ctx, q, id, a.SessionID, ordinal, &unit, true); err != nil {
			return a, err
		}
		if err = prepareOverviewFacts(ctx, q, id, ordinal, unit); err != nil {
			return a, err
		}
		parts = 1
	}
	if done {
		if err = validateRetainedEdges(ctx, q, id, source, threads); err != nil {
			return a, err
		}
	}
	encoded, err := json.Marshal(cursor)
	if err != nil {
		return a, persist("encode retention progress", err)
	}
	state := "validating"
	if done {
		state = "validated"
	}
	if err = q.AdvancePublicationRetention(ctx, db.AdvancePublicationRetentionParams{ID: id, Parts: parts, Bytes: bytes, Cursor: string(encoded), State: state}); err != nil {
		return a, persist("advance retention progress", err)
	}
	current, err := publicationAttempt(ctx, q, id)
	if err != nil {
		return current, err
	}
	if err = liveAttempt(current); err != nil {
		return current, err
	}
	return current, nil
}

func retentionThreads(ctx context.Context, q *db.Queries, source db.CanonicalPublicationSource, target publication.Target, headers []canonical.ThreadRecord) ([]canonical.ThreadRecord, error) {
	bySource := make(map[string]canonical.ThreadRecord, len(headers))
	for _, thread := range headers {
		key, ok := sourceidentity.SourceThreadID(source.SourceKey, thread.SourceKey)
		if !ok {
			return nil, publicationError("conflict", "target Thread source scope changed")
		}
		bySource[key] = thread
	}
	result := make([]canonical.ThreadRecord, 0, len(target.RetainedThreadIDs))
	for _, key := range target.RetainedThreadIDs {
		header, ok := bySource[key]
		if !ok || header.ParentThreadID == nil {
			return nil, publicationError("invalid", "retention requires a declared nonroot Thread")
		}
		base, err := q.GetThreadForRead(ctx, db.GetThreadForReadParams{SessionID: source.SessionID, ID: header.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, publicationError("invalid", "retained Thread is absent from the bound base")
		}
		if err != nil {
			return nil, persist("read retained Thread baseline", err)
		}
		if base.SourceKey != header.SourceKey || !sameOptionalString(base.ParentThreadID, header.ParentThreadID) {
			return nil, publicationError("conflict", "retained Thread identity or parent changed")
		}
		result = append(result, header)
	}
	return result, nil
}

func validateRetainedEdges(ctx context.Context, q *db.Queries, id pgtype.UUID, source db.CanonicalPublicationSource, threads []canonical.ThreadRecord) error {
	for _, thread := range threads {
		edges, err := q.BaselineParentEdges(ctx, db.BaselineParentEdgesParams{SessionID: source.SessionID, ChildThreadID: &thread.ID})
		if err != nil {
			return persist("read baseline parent relationship", err)
		}
		if len(edges) != 1 || edges[0].ThreadID != *thread.ParentThreadID {
			return publicationError("invalid", "retained Thread has no unique baseline parent Event")
		}
		location, err := q.GetPublicationMemberLocation(ctx, db.GetPublicationMemberLocationParams{AttemptID: id, Kind: "event", RecordID: edges[0].ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return publicationError("invalid", "retained Thread parent Event left the target")
		}
		if err != nil {
			return persist("read selected parent relationship", err)
		}
		part, err := fixedPublicationPart(ctx, q, id, location.PartOrdinal)
		if err != nil {
			return err
		}
		if int(location.EntryIndex) >= len(part.Events) {
			return persist("read selected parent Event", errors.New("member position outside unit"))
		}
		event := part.Events[location.EntryIndex]
		if event.ThreadID != *thread.ParentThreadID || event.ChildThreadID == nil || *event.ChildThreadID != thread.ID {
			return publicationError("conflict", "retained Thread parent Event changed its relationship")
		}
	}
	return nil
}

func baselineEvent(ctx context.Context, baseline *retentionBaseline, threadID, after string) (*canonical.EventRecord, string, error) {
	q, source := baseline.q, baseline.source
	if source.CurrentHead == nil {
		row, err := q.BaselineThreadEvent(ctx, db.BaselineThreadEventParams{SessionID: source.SessionID, ThreadID: threadID, AfterID: after})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", nil
		}
		if err != nil {
			return nil, "", persist("read legacy retained Event", err)
		}
		event := canonicalEvent(db.CanonicalEvent(row))
		return &event, event.ID, nil
	}
	head, err := publicationID(*source.CurrentHead)
	if err != nil {
		return nil, "", err
	}
	member, err := q.NextPublicationBaselineMember(ctx, db.NextPublicationBaselineMemberParams{AttemptID: head, Kind: "event", ThreadID: threadID, AfterKey: after})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", persist("read retained Event membership", err)
	}
	unit, err := baseline.fixed(ctx, head, member.PartOrdinal)
	if err != nil {
		return nil, "", err
	}
	if int(member.EntryIndex) >= len(unit.Events) {
		return nil, "", persist("read retained Event position", errors.New("member outside unit"))
	}
	event := unit.Events[member.EntryIndex]
	return &event, member.SourceKey, nil
}
func baselineUsage(ctx context.Context, baseline *retentionBaseline, threadID, after string) (*canonical.UsageRecord, string, error) {
	q, source := baseline.q, baseline.source
	if source.CurrentHead == nil {
		row, err := q.BaselineThreadUsage(ctx, db.BaselineThreadUsageParams{SessionID: source.SessionID, ThreadID: threadID, AfterKey: after})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", nil
		}
		if err != nil {
			return nil, "", persist("read legacy retained usage", err)
		}
		value := canonical.UsageRecord{SourceKey: row.SourceKey, SessionID: row.SessionID, ThreadID: row.ThreadID, Revision: row.Revision, Digest: row.Digest, OccurredAt: row.OccurredAt, Model: row.Model, InputTokens: row.InputTokens, OutputTokens: row.OutputTokens, CacheReadTokens: row.CacheReadTokens, CacheWriteTokens: row.CacheWriteTokens}
		return &value, value.SourceKey, nil
	}
	head, err := publicationID(*source.CurrentHead)
	if err != nil {
		return nil, "", err
	}
	member, err := q.NextPublicationBaselineMember(ctx, db.NextPublicationBaselineMemberParams{AttemptID: head, Kind: "usage", ThreadID: threadID, AfterKey: after})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", persist("read retained usage membership", err)
	}
	unit, err := baseline.fixed(ctx, head, member.PartOrdinal)
	if err != nil {
		return nil, "", err
	}
	if int(member.EntryIndex) >= len(unit.Usage) {
		return nil, "", persist("read retained usage position", errors.New("member outside unit"))
	}
	value := unit.Usage[member.EntryIndex]
	return &value, member.SourceKey, nil
}

func materializePublicationContent(ctx context.Context, q *db.Queries, id pgtype.UUID, sessionID string, ordinal int32, unit *canonical.WriteBatch, retained bool) error {
	paths := publicationThreadPaths(unit.Threads)
	for n := range unit.Events {
		event := &unit.Events[n]
		fingerprint, err := canonical.EventVersionFingerprint(*event)
		if err != nil {
			return persist("fingerprint normalized Event", err)
		}
		descriptor, err := publicationFingerprint(struct {
			Content string
			Title   string
			Harness string
			Path    []canonical.ProjectionThread
		}{fingerprint, unit.Session.Title, unit.Session.Actor.Harness, paths[event.ThreadID]})
		if err != nil {
			return err
		}
		if err = recordPublicationMember(ctx, q, id, sessionID, ordinal, preparedMember{kind: "event", id: event.ID, sourceKey: event.SourceKey, threadID: event.ThreadID, projection: event.ProjectionRevision, revision: event.Revision, fingerprint: fingerprint, index: n, sourceOrder: event.SourceOrder, eventIndex: event.EventIndex, descriptor: descriptor}); err != nil {
			return err
		}
		if !retained {
			metadata, e := q.NextIngestMetadata(ctx)
			if e != nil {
				return persist("allocate prepared Event provenance", e)
			}
			event.ObservedAt = unit.ObservedAt
			event.ReceivedAt = metadata.ReceivedAt
			event.IngestSeq = uint64(metadata.IngestSeq)
		}
		if err = q.InsertPublicationProjectionChange(ctx, db.InsertPublicationProjectionChangeParams{AttemptID: id, EventID: event.ID}); err != nil {
			return persist("prepare invisible Search work", err)
		}
	}
	for n, value := range unit.Usage {
		keyHash := sha256.Sum256([]byte(value.SourceKey))
		recordID := "u_" + hex.EncodeToString(keyHash[:12])
		if err := recordPublicationMember(ctx, q, id, sessionID, ordinal, preparedMember{kind: "usage", id: recordID, sourceKey: value.SourceKey, threadID: value.ThreadID, revision: value.Revision, fingerprint: value.Digest, index: n}); err != nil {
			return err
		}
	}
	return nil
}
