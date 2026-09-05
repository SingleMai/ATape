package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/jackc/pgx/v5"
)

func (s *Store) AuthorizeChunk(
	ctx context.Context,
	principal authentication.Principal,
	chunk rawarchive.ChunkRecord,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return rawPersist("begin chunk authorization", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	access, err := resolveSessionAccess(
		ctx, s.queries.WithTx(tx), principal, chunk.SessionID, authorization.RawIngest, false,
	)
	if err != nil {
		return err
	}
	if access.projectState != "active" {
		return &rawarchive.ProjectStateError{State: access.projectState}
	}
	if err := tx.Commit(ctx); err != nil {
		return rawPersist("commit chunk authorization", err)
	}
	return nil
}

func (s *Store) CommitChunk(
	ctx context.Context,
	principal authentication.Principal,
	chunk rawarchive.ChunkRecord,
) (rawarchive.CommitResult, error) {
	if err := ctx.Err(); err != nil {
		return rawarchive.CommitResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return rawarchive.CommitResult{}, rawPersist("begin chunk transaction", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	access, err := resolveSessionAccess(
		ctx, queries, principal, chunk.SessionID, authorization.RawIngest, true,
	)
	if err != nil {
		return rawarchive.CommitResult{}, err
	}
	if access.projectState != "active" {
		return rawarchive.CommitResult{}, &rawarchive.ProjectStateError{State: access.projectState}
	}
	chunk.ProjectID = access.projectID

	if err := queries.AcquireRawLock(ctx, "chunk:"+chunk.ChunkID); err != nil {
		return rawarchive.CommitResult{}, rawPersist("lock chunk", err)
	}
	if err := queries.AcquireRawLock(ctx, "object:"+chunk.ObjectID); err != nil {
		return rawarchive.CommitResult{}, rawPersist("lock object", err)
	}

	existingChunk, err := queries.GetRawChunkForReplay(ctx, chunk.ChunkID)
	if err == nil {
		if !sameRawChunk(existingChunk, chunk) {
			return rawarchive.CommitResult{}, rawConflict(chunk.ChunkID, "chunkId was reused with different content or metadata")
		}
		object, generation, err := readRawCommit(ctx, queries, existingChunk.ObjectID, existingChunk.Generation)
		if err != nil {
			return rawarchive.CommitResult{}, err
		}
		return rawarchive.CommitResult{Object: object, Generation: generation, Replayed: true}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return rawarchive.CommitResult{}, rawPersist("check chunk replay", err)
	}

	storedObject, err := queries.GetRawObjectForUpdate(ctx, chunk.ObjectID)
	objectExists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return rawarchive.CommitResult{}, rawPersist("read object", err)
	}
	var object rawarchive.ObjectRecord
	if !objectExists {
		if chunk.Generation != 1 || chunk.Offset != 0 {
			return rawarchive.CommitResult{}, rawConflict(chunk.ObjectID, "a new Raw object must start at generation 1 offset 0")
		}
		if err := queries.InsertRawObject(ctx, db.InsertRawObjectParams{
			ID: chunk.ObjectID, ProjectID: chunk.ProjectID, SessionID: chunk.SessionID,
			SourceName: chunk.SourceName, MediaType: chunk.MediaType, AdapterID: chunk.AdapterID,
			AdapterVersion: chunk.AdapterVersion, CapturedAt: chunk.CapturedAt, ClientRedacted: chunk.ClientRedacted,
		}); err != nil {
			return rawarchive.CommitResult{}, rawPersist("insert object", err)
		}
		if err := queries.InsertRawGeneration(ctx, db.InsertRawGenerationParams{ObjectID: chunk.ObjectID, Generation: 1}); err != nil {
			return rawarchive.CommitResult{}, rawPersist("insert first generation", err)
		}
		object = rawarchive.ObjectRecord{
			ObjectID: chunk.ObjectID, ProjectID: chunk.ProjectID, SessionID: chunk.SessionID,
			SourceName: chunk.SourceName, MediaType: chunk.MediaType, AdapterID: chunk.AdapterID,
			AdapterVersion: chunk.AdapterVersion, CapturedAt: chunk.CapturedAt,
			ClientRedacted: chunk.ClientRedacted, CurrentGeneration: 1, GenerationCount: 1,
		}
	} else {
		object = rawObjectForUpdate(storedObject)
		if !sameRawObjectIdentity(object, chunk) {
			return rawarchive.CommitResult{}, rawConflict(chunk.ObjectID, "Raw object project, session, source, media type, and Adapter are immutable")
		}
		switch {
		case chunk.Generation < object.CurrentGeneration:
			return rawarchive.CommitResult{}, rawConflict(chunk.ObjectID, "cannot append to an older generation")
		case chunk.Generation > object.CurrentGeneration+1:
			return rawarchive.CommitResult{}, rawConflict(chunk.ObjectID, "cannot skip a generation")
		case chunk.Generation == object.CurrentGeneration+1:
			if chunk.Offset != 0 {
				return rawarchive.CommitResult{}, rawConflict(chunk.ObjectID, "a new generation must start at offset 0")
			}
			if err := queries.InsertRawGeneration(ctx, db.InsertRawGenerationParams{
				ObjectID: chunk.ObjectID, Generation: chunk.Generation,
			}); err != nil {
				return rawarchive.CommitResult{}, rawPersist("insert generation", err)
			}
			object.CurrentGeneration = chunk.Generation
			object.GenerationCount++
		}
	}

	storedGeneration, err := queries.GetRawGenerationForUpdate(ctx, db.GetRawGenerationForUpdateParams{
		ObjectID: chunk.ObjectID, Generation: chunk.Generation,
	})
	if err != nil {
		return rawarchive.CommitResult{}, rawPersist("read generation", err)
	}
	generation := rawarchive.GenerationRecord{
		Generation: storedGeneration.Generation, SizeBytes: storedGeneration.SizeBytes,
		ChunkCount: storedGeneration.ChunkCount, Finalized: storedGeneration.Finalized,
	}
	if generation.Finalized {
		return rawarchive.CommitResult{}, rawConflict(chunk.ObjectID, "generation is finalized")
	}
	if chunk.Offset != generation.SizeBytes {
		return rawarchive.CommitResult{}, rawConflict(chunk.ObjectID, "append offset does not match the generation size")
	}
	chunk.Ordinal = generation.ChunkCount + 1
	if err := queries.InsertRawChunk(ctx, db.InsertRawChunkParams{
		ChunkID: chunk.ChunkID, ObjectID: chunk.ObjectID, Generation: chunk.Generation,
		Ordinal: chunk.Ordinal, ByteOffset: chunk.Offset, SizeBytes: chunk.SizeBytes,
		AdapterVersion: chunk.AdapterVersion, CapturedAt: chunk.CapturedAt, Final: chunk.Final,
		Sha256: chunk.SHA256, StorageKey: chunk.StorageKey,
	}); err != nil {
		return rawarchive.CommitResult{}, rawPersist("insert chunk", err)
	}
	generation.SizeBytes += chunk.SizeBytes
	generation.ChunkCount++
	generation.Finalized = chunk.Final
	if err := queries.CommitRawGeneration(ctx, db.CommitRawGenerationParams{
		SizeBytes: generation.SizeBytes, ChunkCount: generation.ChunkCount, Finalized: generation.Finalized,
		ObjectID: chunk.ObjectID, Generation: chunk.Generation,
	}); err != nil {
		return rawarchive.CommitResult{}, rawPersist("commit generation", err)
	}
	object.AdapterVersion = chunk.AdapterVersion
	if chunk.CapturedAt.After(object.CapturedAt) {
		object.CapturedAt = chunk.CapturedAt
	}
	object.CurrentSizeBytes = generation.SizeBytes
	object.CurrentFinalized = generation.Finalized
	if err := queries.CommitRawObject(ctx, db.CommitRawObjectParams{
		AdapterVersion: object.AdapterVersion, CapturedAt: object.CapturedAt,
		CurrentGeneration: object.CurrentGeneration, GenerationCount: object.GenerationCount, ID: object.ObjectID,
	}); err != nil {
		return rawarchive.CommitResult{}, rawPersist("commit object", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return rawarchive.CommitResult{}, rawPersist("commit chunk transaction", err)
	}
	return rawarchive.CommitResult{Object: object, Generation: generation}, nil
}

func (s *Store) ListSessionObjects(
	ctx context.Context,
	principal authentication.Principal,
	sessionID string,
) ([]rawarchive.ObjectRecord, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, rawPersist("begin Session object read", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	if _, err := resolveSessionAccess(
		ctx, queries, principal, sessionID, authorization.RawSessionList, false,
	); err != nil {
		return nil, err
	}
	rows, err := queries.ListRawSessionObjects(ctx, sessionID)
	if err != nil {
		return nil, rawPersist("list Session objects", err)
	}
	objects := make([]rawarchive.ObjectRecord, 0, len(rows))
	for _, row := range rows {
		objects = append(objects, rawarchive.ObjectRecord{
			ObjectID: row.ID, ProjectID: row.ProjectID, SessionID: row.SessionID,
			SourceName: row.SourceName, MediaType: row.MediaType, AdapterID: row.AdapterID,
			AdapterVersion: row.AdapterVersion, CapturedAt: row.CapturedAt, ClientRedacted: row.ClientRedacted,
			CurrentGeneration: row.CurrentGeneration, GenerationCount: row.GenerationCount,
			CurrentSizeBytes: row.CurrentSizeBytes, CurrentFinalized: row.CurrentFinalized,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, rawPersist("commit Session object read", err)
	}
	return objects, nil
}

func (s *Store) PlanContent(
	ctx context.Context,
	principal authentication.Principal,
	objectID string,
	generationNumber int64,
	afterOrdinal int64,
	limit int,
) (rawarchive.ContentPlan, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return rawarchive.ContentPlan{}, rawPersist("begin content read", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	if _, err := resolveRawObjectAccess(ctx, queries, principal, objectID); err != nil {
		return rawarchive.ContentPlan{}, err
	}
	storedObject, err := queries.GetRawObjectForRead(ctx, objectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return rawarchive.ContentPlan{}, &rawarchive.NotFoundError{Resource: "object", ID: objectID}
	}
	if err != nil {
		return rawarchive.ContentPlan{}, rawPersist("read object", err)
	}
	object := rawObjectForRead(storedObject)
	if generationNumber == 0 {
		generationNumber = object.CurrentGeneration
	}
	storedGeneration, err := queries.GetRawGenerationForRead(ctx, db.GetRawGenerationForReadParams{
		ObjectID: objectID, Generation: generationNumber,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return rawarchive.ContentPlan{}, &rawarchive.NotFoundError{Resource: "generation", ID: fmt.Sprintf("%s/%d", objectID, generationNumber)}
	}
	if err != nil {
		return rawarchive.ContentPlan{}, rawPersist("read generation", err)
	}
	rows, err := queries.ListRawChunksAfter(ctx, db.ListRawChunksAfterParams{
		ObjectID: objectID, Generation: generationNumber, AfterOrdinal: afterOrdinal, ResultLimit: int32(limit + 1),
	})
	if err != nil {
		return rawarchive.ContentPlan{}, rawPersist("list chunks", err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	chunks := make([]rawarchive.ChunkRecord, 0, len(rows))
	for _, row := range rows {
		chunks = append(chunks, rawarchive.ChunkRecord{
			ChunkID: row.ChunkID, ObjectID: row.ObjectID, ProjectID: object.ProjectID, SessionID: object.SessionID,
			Generation: row.Generation, Ordinal: row.Ordinal, Offset: row.ByteOffset, SizeBytes: row.SizeBytes,
			SourceName: object.SourceName, MediaType: object.MediaType, AdapterID: object.AdapterID,
			AdapterVersion: row.AdapterVersion, CapturedAt: row.CapturedAt, ClientRedacted: object.ClientRedacted,
			Final: row.Final, SHA256: row.Sha256, StorageKey: row.StorageKey,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return rawarchive.ContentPlan{}, rawPersist("commit content read", err)
	}
	return rawarchive.ContentPlan{
		Object: object,
		Generation: rawarchive.GenerationRecord{
			Generation: storedGeneration.Generation, SizeBytes: storedGeneration.SizeBytes,
			ChunkCount: storedGeneration.ChunkCount, Finalized: storedGeneration.Finalized,
		},
		Chunks: chunks, HasMore: hasMore,
	}, nil
}

func readRawCommit(ctx context.Context, queries *db.Queries, objectID string, generationNumber int64) (rawarchive.ObjectRecord, rawarchive.GenerationRecord, error) {
	storedObject, err := queries.GetRawObjectForRead(ctx, objectID)
	if err != nil {
		return rawarchive.ObjectRecord{}, rawarchive.GenerationRecord{}, rawPersist("read replay object", err)
	}
	storedGeneration, err := queries.GetRawGenerationForRead(ctx, db.GetRawGenerationForReadParams{
		ObjectID: objectID, Generation: generationNumber,
	})
	if err != nil {
		return rawarchive.ObjectRecord{}, rawarchive.GenerationRecord{}, rawPersist("read replay generation", err)
	}
	return rawObjectForRead(storedObject), rawarchive.GenerationRecord{
		Generation: storedGeneration.Generation, SizeBytes: storedGeneration.SizeBytes,
		ChunkCount: storedGeneration.ChunkCount, Finalized: storedGeneration.Finalized,
	}, nil
}

func rawObjectForUpdate(row db.GetRawObjectForUpdateRow) rawarchive.ObjectRecord {
	return rawarchive.ObjectRecord{
		ObjectID: row.ID, ProjectID: row.ProjectID, SessionID: row.SessionID,
		SourceName: row.SourceName, MediaType: row.MediaType, AdapterID: row.AdapterID,
		AdapterVersion: row.AdapterVersion, CapturedAt: row.CapturedAt, ClientRedacted: row.ClientRedacted,
		CurrentGeneration: row.CurrentGeneration, GenerationCount: row.GenerationCount,
	}
}

func rawObjectForRead(row db.GetRawObjectForReadRow) rawarchive.ObjectRecord {
	return rawarchive.ObjectRecord{
		ObjectID: row.ID, ProjectID: row.ProjectID, SessionID: row.SessionID,
		SourceName: row.SourceName, MediaType: row.MediaType, AdapterID: row.AdapterID,
		AdapterVersion: row.AdapterVersion, CapturedAt: row.CapturedAt, ClientRedacted: row.ClientRedacted,
		CurrentGeneration: row.CurrentGeneration, GenerationCount: row.GenerationCount,
		CurrentSizeBytes: row.CurrentSizeBytes, CurrentFinalized: row.CurrentFinalized,
	}
}

func sameRawObjectIdentity(object rawarchive.ObjectRecord, chunk rawarchive.ChunkRecord) bool {
	return object.ProjectID == chunk.ProjectID && object.SessionID == chunk.SessionID &&
		object.SourceName == chunk.SourceName && object.MediaType == chunk.MediaType &&
		object.AdapterID == chunk.AdapterID && object.ClientRedacted == chunk.ClientRedacted
}

func sameRawChunk(row db.GetRawChunkForReplayRow, chunk rawarchive.ChunkRecord) bool {
	return row.ChunkID == chunk.ChunkID && row.ObjectID == chunk.ObjectID && row.ProjectID == chunk.ProjectID &&
		row.SessionID == chunk.SessionID && row.Generation == chunk.Generation && row.ByteOffset == chunk.Offset &&
		row.SizeBytes == chunk.SizeBytes && row.SourceName == chunk.SourceName && row.MediaType == chunk.MediaType &&
		row.AdapterID == chunk.AdapterID && row.ChunkAdapterVersion == chunk.AdapterVersion &&
		row.ChunkCapturedAt.Equal(chunk.CapturedAt) && row.ClientRedacted == chunk.ClientRedacted &&
		row.Final == chunk.Final && row.Sha256 == chunk.SHA256 && row.StorageKey == chunk.StorageKey
}

func rawPersist(operation string, err error) error {
	return fmt.Errorf("postgresql Raw Manifest Store: %s: %w", operation, err)
}

func rawConflict(identity string, reason string) error {
	return &rawarchive.ConflictError{Identity: identity, Reason: reason}
}
