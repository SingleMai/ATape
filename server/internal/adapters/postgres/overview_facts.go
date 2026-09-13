package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// prepareOverviewFacts consumes fixed normalized Canonical data, not provider
// input. Validation and backfill share this projection and commit its marker
// with all rows. The caller owns the part and the surrounding transaction.
func prepareOverviewFacts(ctx context.Context, q *db.Queries, attempt pgtype.UUID, ordinal int32, batch canonical.WriteBatch) error {
	roots := make(map[string]bool, len(batch.Threads))
	for _, thread := range batch.Threads {
		roots[thread.ID] = thread.ParentThreadID == nil
	}
	messages := make([]db.CopyOverviewMessagesParams, 0, len(batch.Events))
	for n, event := range batch.Events {
		if event.Kind != "message" {
			continue
		}
		root, ok := roots[event.ThreadID]
		if !ok {
			return persist("prepare Overview topology", errors.New("fixed Event has no Thread"))
		}
		messages = append(messages, db.CopyOverviewMessagesParams{AttemptID: attempt, PartOrdinal: ordinal, EntryIndex: int32(n),
			EventID: event.ID, ThreadID: event.ThreadID, OccurredAt: event.OccurredAt, Author: event.Author, Root: root,
			SourceOrder: event.SourceOrder, EventIndex: int64(event.EventIndex)})
	}
	usage := make([]db.CopyOverviewUsageParams, len(batch.Usage))
	for n, value := range batch.Usage {
		usage[n] = db.CopyOverviewUsageParams{AttemptID: attempt, PartOrdinal: ordinal, EntryIndex: int32(n), SourceKey: value.SourceKey,
			ThreadID: value.ThreadID, OccurredAt: value.OccurredAt, Model: value.Model, InputTokens: value.InputTokens,
			OutputTokens: value.OutputTokens, CacheReadTokens: value.CacheReadTokens, CacheWriteTokens: value.CacheWriteTokens}
	}
	if _, err := q.CopyOverviewMessages(ctx, messages); err != nil {
		return persist("prepare Overview messages", err)
	}
	if _, err := q.CopyOverviewUsage(ctx, usage); err != nil {
		return persist("prepare Overview usage", err)
	}
	changed, err := q.CompleteOverviewPart(ctx, db.CompleteOverviewPartParams{AttemptID: attempt, Ordinal: ordinal})
	if err != nil {
		return persist("complete Overview part", err)
	}
	if changed != 1 {
		return persist("complete Overview part", errors.New("part is not awaiting preparation"))
	}
	return nil
}

// OverviewFactCoverage describes all retained normalized parts, including
// inactive candidates that an older writer may still activate. It is an
// operator snapshot, not a durable promise that future writers are upgraded.
type OverviewFactCoverage struct {
	RetainedParts           int64 `json:"retainedParts"`
	MissingParts            int64 `json:"missingParts"`
	CurrentHeadMissingParts int64 `json:"currentHeadMissingParts"`
}

// OverviewFactsCoverage is an administrative read using the database credential;
// it is not exposed through the authenticated dashboard HTTP Interface.
func (s *Store) OverviewFactsCoverage(ctx context.Context) (OverviewFactCoverage, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	row, err := s.queries.OverviewFactCoverage(ctx)
	if err != nil {
		return OverviewFactCoverage{}, persist("read Overview fact coverage", err)
	}
	return OverviewFactCoverage{row.RetainedParts, row.MissingParts, row.CurrentHeadMissingParts}, nil
}

// BackfillOverviewFacts prepares at most one retained part (at most 4 MiB).
// Its durable checkpoint is the part's version marker. false means no unlocked
// work was found; callers must consult coverage before claiming completion.
// This administrative operation needs only the part lock, and never changes
// publication authority, receipts, validation progress or payload accounting.
func (s *Store) BackfillOverviewFacts(ctx context.Context) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, persist("begin Overview backfill", err)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	q := s.queries.WithTx(tx)
	part, err := q.ClaimOverviewBackfillPart(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, persist("claim Overview backfill part", err)
	}
	if part.StoredBytes < 1 || part.StoredBytes > 4<<20 {
		return false, persist("read Overview backfill bounds", errors.New("normalized part exceeds 4 MiB"))
	}
	body, err := q.GetPublicationPartBody(ctx, db.GetPublicationPartBodyParams{AttemptID: part.AttemptID, Ordinal: part.Ordinal})
	if err != nil {
		return false, persist("read Overview backfill part", err)
	}
	var batch canonical.WriteBatch
	if err = json.Unmarshal(body.ValidatedBody, &batch); err != nil {
		return false, persist("decode Overview backfill part", err)
	}
	if err = prepareOverviewFacts(ctx, q, part.AttemptID, part.Ordinal, batch); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, persist("commit Overview backfill part", err)
	}
	return true, nil
}
