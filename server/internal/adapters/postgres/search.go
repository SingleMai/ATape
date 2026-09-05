package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func (s *Store) LeaseProjectionChanges(
	ctx context.Context,
	owner string,
	limit int,
	leaseUntil time.Time,
) ([]canonical.ProjectionChange, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, persist("begin projection lease", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	ids, err := queries.ClaimProjectionChanges(ctx, db.ClaimProjectionChangesParams{
		LeaseOwner: &owner,
		LeaseUntil: pgtype.Timestamptz{Time: leaseUntil, Valid: true},
		BatchLimit: int32(limit),
	})
	if err != nil {
		return nil, persist("claim projection changes", err)
	}
	if len(ids) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return nil, persist("commit empty projection lease", err)
		}
		return []canonical.ProjectionChange{}, nil
	}
	rows, err := queries.LoadProjectionChanges(ctx, db.LoadProjectionChangesParams{
		ChangeIds:  ids,
		LeaseOwner: &owner,
	})
	if err != nil {
		return nil, persist("load projection changes", err)
	}
	if len(rows) != len(ids) {
		return nil, persist("load projection changes", fmt.Errorf("loaded %d of %d claimed changes", len(rows), len(ids)))
	}
	changes := make([]canonical.ProjectionChange, 0, len(rows))
	for _, row := range rows {
		if len(row.ThreadPathIds) != len(row.ThreadPathLabels) {
			return nil, persist("load projection path", fmt.Errorf("event %q has mismatched path", row.EventID))
		}
		path := make([]canonical.ProjectionThread, 0, len(row.ThreadPathIds))
		for index, id := range row.ThreadPathIds {
			path = append(path, canonical.ProjectionThread{ID: id, Label: row.ThreadPathLabels[index]})
		}
		changes = append(changes, canonical.ProjectionChange{
			ID: row.ChangeID,
			Document: canonical.EventProjection{
				ProjectID: row.ProjectID, SessionID: row.SessionID,
				SessionTitle: row.SessionTitle, ThreadID: row.ThreadID,
				ThreadPath: path, EventID: row.EventID, Author: row.Author,
				Harness: row.Harness, OccurredAt: row.OccurredAt, Text: row.Text,
				ToolLabel: row.ToolLabel, IngestSeq: uint64(row.IngestSeq),
				ObservedAt: row.ObservedAt,
			},
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, persist("commit projection lease", err)
	}
	return changes, nil
}

func (s *Store) AckProjectionChanges(ctx context.Context, owner string, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	if err := s.queries.AckProjectionChanges(ctx, db.AckProjectionChangesParams{
		ChangeIds:  ids,
		LeaseOwner: &owner,
	}); err != nil {
		return persist("ack projection changes", err)
	}
	return nil
}

func (s *Store) UpsertProjectionDocuments(ctx context.Context, documents []canonical.EventProjection) error {
	if len(documents) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return persist("begin Search projection update", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	checkpoints := make(map[string]time.Time)
	for _, document := range documents {
		pathIDs := make([]string, 0, len(document.ThreadPath))
		pathLabels := make([]string, 0, len(document.ThreadPath))
		for _, thread := range document.ThreadPath {
			pathIDs = append(pathIDs, thread.ID)
			pathLabels = append(pathLabels, thread.Label)
		}
		if err := queries.UpsertSearchDocument(ctx, db.UpsertSearchDocumentParams{
			EventID: document.EventID, ProjectID: document.ProjectID,
			SessionID: document.SessionID, SessionTitle: document.SessionTitle,
			ThreadID: document.ThreadID, ThreadPathIds: pathIDs,
			ThreadPathLabels: pathLabels, Author: document.Author,
			Harness: document.Harness, OccurredAt: document.OccurredAt,
			Text: document.Text, ToolLabel: document.ToolLabel,
			IngestSeq: int64(document.IngestSeq), ObservedAt: document.ObservedAt,
		}); err != nil {
			return persist("upsert Search document", err)
		}
		if document.ObservedAt.After(checkpoints[document.ProjectID]) {
			checkpoints[document.ProjectID] = document.ObservedAt
		}
	}
	for projectID, indexedThrough := range checkpoints {
		if err := queries.AdvanceSearchCheckpoint(ctx, db.AdvanceSearchCheckpointParams{
			ProjectID: projectID, IndexedThrough: indexedThrough,
		}); err != nil {
			return persist("advance Search checkpoint", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return persist("commit Search projection update", err)
	}
	return nil
}

func (s *Store) SearchProjectionDocuments(
	ctx context.Context,
	principal authentication.Principal,
	query projectsearch.IndexQuery,
) (projectsearch.IndexPage, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return projectsearch.IndexPage{}, persist("begin Search query", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	if _, err := resolveProjectAccess(
		ctx, queries, principal, query.ProjectID, authorization.ProjectSearchQuery, false,
	); err != nil {
		return projectsearch.IndexPage{}, err
	}
	rows, err := queries.SearchDocuments(ctx, db.SearchDocumentsParams{
		ProjectID:    query.ProjectID,
		Term:         query.Term,
		ResultOffset: int32(query.Offset),
		ResultLimit:  int32(query.Limit),
	})
	if err != nil {
		return projectsearch.IndexPage{}, persist("query Search documents", err)
	}
	documents := make([]canonical.EventProjection, 0, len(rows))
	total := 0
	for _, row := range rows {
		path := make([]canonical.ProjectionThread, 0, len(row.ThreadPathIds))
		for index, id := range row.ThreadPathIds {
			if index < len(row.ThreadPathLabels) {
				path = append(path, canonical.ProjectionThread{ID: id, Label: row.ThreadPathLabels[index]})
			}
		}
		documents = append(documents, canonical.EventProjection{
			ProjectID: row.ProjectID, SessionID: row.SessionID,
			SessionTitle: row.SessionTitle, ThreadID: row.ThreadID,
			ThreadPath: path, EventID: row.EventID, Author: row.Author,
			Harness: row.Harness, OccurredAt: row.OccurredAt, Text: row.Text,
			ToolLabel: row.ToolLabel, IngestSeq: uint64(row.IngestSeq),
			ObservedAt: row.ObservedAt,
		})
		total = int(row.TotalCount)
	}
	checkpoint, err := queries.GetSearchCheckpoint(ctx, query.ProjectID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return projectsearch.IndexPage{}, persist("read Search checkpoint", err)
	}
	page := projectsearch.IndexPage{
		Documents: documents, Total: total, IndexedThrough: checkpoint,
	}
	if err := tx.Commit(ctx); err != nil {
		return projectsearch.IndexPage{}, persist("commit Search query", err)
	}
	return page, nil
}
