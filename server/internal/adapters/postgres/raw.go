package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/sourceidentity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
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
	userID, err := principalUUID(principal)
	if err != nil {
		return err
	}
	policy, err := s.queries.WithTx(tx).ReadRawCapturePolicy(ctx, db.ReadRawCapturePolicyParams{ID: access.teamID, ID_2: userID})
	if err != nil {
		return rawPersist("read Raw capture policy", err)
	}
	if !rawarchive.CaptureEnabled(policy.RawCapturePolicy, policy.RawCapturePreference) {
		return &rawarchive.CaptureDisabledError{}
	}
	if err := publicationChunkAuthority(ctx, s.queries.WithTx(tx), principal, chunk,
		rawarchive.CaptureAuthority(policy.RawCapturePolicy, policy.TeamRevision, policy.UserRevision)); err != nil {
		return err
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
	userID, err := principalUUID(principal)
	if err != nil {
		return rawarchive.CommitResult{}, err
	}
	policy, err := queries.LockRawCapturePolicy(ctx, db.LockRawCapturePolicyParams{ID: access.teamID, ID_2: userID})
	if err != nil {
		return rawarchive.CommitResult{}, rawPersist("lock Raw capture policy", err)
	}
	if !rawarchive.CaptureEnabled(policy.RawCapturePolicy, policy.RawCapturePreference) {
		return rawarchive.CommitResult{}, &rawarchive.CaptureDisabledError{}
	}
	if err := publicationChunkAuthority(ctx, queries, principal, chunk,
		rawarchive.CaptureAuthority(policy.RawCapturePolicy, policy.TeamRevision, policy.UserRevision)); err != nil {
		return rawarchive.CommitResult{}, err
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
		if !sameRawChunk(existingChunk, chunk) || !sameRawPublication(existingChunk.PublicationHead, existingChunk.RawTeamRevision, existingChunk.RawUserRevision, chunk.Publication) {
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
		if proof := chunk.Publication; proof != nil {
			var head pgtype.UUID
			if err := head.Scan(proof.Head); err != nil {
				return rawarchive.CommitResult{}, err
			}
			if err := queries.BindRawPublicationObject(ctx, db.BindRawPublicationObjectParams{ID: chunk.ObjectID, PublicationHead: head,
				RawTeamRevision: &proof.Authority.TeamRevision, RawUserRevision: &proof.Authority.UserRevision}); err != nil {
				return rawarchive.CommitResult{}, rawPersist("bind Raw publication object", err)
			}
		}
		object = rawarchive.ObjectRecord{
			ObjectID: chunk.ObjectID, ProjectID: chunk.ProjectID, SessionID: chunk.SessionID,
			SourceName: chunk.SourceName, MediaType: chunk.MediaType, AdapterID: chunk.AdapterID,
			AdapterVersion: chunk.AdapterVersion, CapturedAt: chunk.CapturedAt,
			ClientRedacted: chunk.ClientRedacted, CurrentGeneration: 1, GenerationCount: 1,
		}
	} else {
		object = rawObjectForUpdate(storedObject)
		if !sameRawObjectIdentity(object, chunk) || !sameRawPublication(storedObject.PublicationHead, storedObject.RawTeamRevision, storedObject.RawUserRevision, chunk.Publication) {
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

func publicationChunkAuthority(ctx context.Context, q *db.Queries, principal authentication.Principal, chunk rawarchive.ChunkRecord, authority rawarchive.Authority) error {
	source, err := q.GetPublicationSource(ctx, chunk.SessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		if chunk.Publication != nil {
			return &rawarchive.ValidationError{Field: "publication", Reason: "requires a publication-mode Session"}
		}
		return nil
	}
	if err != nil {
		return rawPersist("read Raw publication owner", err)
	}
	if domainUUID(source.CapturedByUserID) != principal.UserID || source.InstallationID != chunk.InstallationID || source.AdapterID != chunk.AdapterID {
		return &rawarchive.NotFoundError{Resource: "session", ID: chunk.SessionID}
	}
	proof := chunk.Publication
	if proof == nil {
		return &rawarchive.ValidationError{Field: "publication", Reason: "publication-mode Raw requires activation proof and independent Raw authority"}
	}
	if chunk.Generation != 1 {
		return &rawarchive.ValidationError{Field: "generation", Reason: "publication Raw objects have one immutable generation"}
	}
	if proof.Authority != authority {
		return &rawarchive.AuthorityChangedError{}
	}
	var head pgtype.UUID
	if err := head.Scan(proof.Head); err != nil {
		return &rawarchive.ValidationError{Field: "publication", Reason: "invalid activation identity"}
	}
	activated, err := q.GetRawPublicationProof(ctx, head)
	if errors.Is(err, pgx.ErrNoRows) {
		return &rawarchive.ValidationError{Field: "publication", Reason: "capture has not activated"}
	}
	if err != nil {
		return rawPersist("read Raw activation proof", err)
	}
	if activated.SessionID != chunk.SessionID || activated.InstallationID != chunk.InstallationID || activated.AdapterID != chunk.AdapterID || domainUUID(activated.CapturedByUserID) != principal.UserID {
		return &rawarchive.NotFoundError{Resource: "session", ID: chunk.SessionID}
	}
	return nil
}

func sameRawPublication(head pgtype.UUID, team, user *int64, proof *rawarchive.PublicationProof) bool {
	if proof == nil {
		return !head.Valid && team == nil && user == nil
	}
	return head.Valid && domainUUID(head) == proof.Head && team != nil && user != nil && *team == proof.Authority.TeamRevision && *user == proof.Authority.UserRevision
}

func (s *Store) LookupChunk(ctx context.Context, principal authentication.Principal, identity rawarchive.ChunkIdentity) (*rawarchive.ChunkReceipt, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, rawPersist("begin Raw receipt lookup", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	q := s.queries.WithTx(tx)
	if _, err := resolveSessionAccess(ctx, q, principal, identity.SessionID, authorization.RawIngest, false); err != nil {
		return nil, err
	}
	objectID := sourceidentity.RawObjectID(principal.UserID, identity.SessionID, identity.InstallationID, identity.AdapterID, identity.SourceObjectID)
	chunkID := sourceidentity.RawChunkID(objectID, identity.SourceChunkID)
	row, err := q.GetRawChunkForReplay(ctx, chunkID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, rawPersist("read Raw receipt", err)
	}
	receipt := rawarchive.ChunkReceipt{ChunkIdentity: identity, ObjectID: row.ObjectID, Generation: row.Generation, Offset: row.ByteOffset, SizeBytes: row.SizeBytes, SHA256: row.Sha256, Final: row.Final,
		ProtocolVersion: rawarchive.ProtocolVersion, SourceName: row.SourceName, MediaType: row.MediaType, AdapterVersion: row.ChunkAdapterVersion,
		CapturedAt: row.ChunkCapturedAt.UTC().Format(time.RFC3339Nano), ClientRedacted: row.ClientRedacted}
	if row.PublicationHead.Valid {
		if row.RawTeamRevision == nil || row.RawUserRevision == nil {
			return nil, rawPersist("read Raw publication binding", errors.New("incomplete publication binding"))
		}
		receipt.Publication = &rawarchive.PublicationProof{Head: domainUUID(row.PublicationHead), Authority: rawarchive.Authority{Protocol: rawarchive.PublicationProtocol, TeamRevision: *row.RawTeamRevision, UserRevision: *row.RawUserRevision}}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, rawPersist("commit Raw receipt lookup", err)
	}
	return &receipt, nil
}

func (s *Store) ListSessionObjects(
	ctx context.Context,
	principal authentication.Principal,
	sessionID string,
	after rawarchive.ObjectPosition,
	limit int,
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
	rows, err := queries.ListRawSessionObjects(ctx, db.ListRawSessionObjectsParams{SessionID: sessionID, FirstPage: after.ObjectID == "", AfterCreatedAt: after.CreatedAt, AfterID: after.ObjectID, ResultLimit: int32(limit)})
	if err != nil {
		return nil, rawPersist("list Session objects", err)
	}
	objects := make([]rawarchive.ObjectRecord, 0, len(rows))
	for _, row := range rows {
		objects = append(objects, rawarchive.ObjectRecord{
			ObjectID: row.ID, ProjectID: row.ProjectID, SessionID: row.SessionID,
			SourceName: row.SourceName, MediaType: row.MediaType, AdapterID: row.AdapterID,
			AdapterVersion: row.AdapterVersion, CapturedAt: row.CapturedAt, CreatedAt: row.CreatedAt, ClientRedacted: row.ClientRedacted,
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
