package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sort"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// Validate commits at most one bounded Canonical part and its membership index.
// Validated bytes replace the transport body, preserving its immutable receipt.
// The cursor, source-version bindings and byte accounting commit together. No
// ordinary Canonical records, Raw authority, activation or Search work is created.
func (s *PublicationStore) Validate(ctx context.Context, p authentication.Principal, attemptID string) (publication.Attempt, error) {
	id, err := publicationID(attemptID)
	if err != nil {
		return publication.Attempt{}, err
	}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, userID pgtype.UUID) (publication.Attempt, error) {
		_, source, err := s.reservation(ctx, q, p, id)
		if err != nil {
			return publication.Attempt{}, err
		}
		row, err := q.GetPublicationAttempt(ctx, id)
		if err != nil {
			return publication.Attempt{}, persist("read validation progress", err)
		}
		a, err := attemptValue(row)
		if err != nil {
			return a, err
		}
		if err = liveAttempt(a); err != nil {
			return a, err
		}
		if a.State == "validated" {
			return a, nil
		}
		if a.Seal == nil || (a.State != "sealed" && a.State != "validating") {
			return a, publicationError("invalid", "only a sealed candidate can validate")
		}
		if a.ValidatedParts == a.Seal.Parts {
			return s.validateRetention(ctx, q, userID, id, source, row, a)
		}
		ordinal := int32(a.ValidatedParts)
		metadata, err := q.GetPublicationPartStorage(ctx, db.GetPublicationPartStorageParams{AttemptID: id, Ordinal: ordinal})
		if err != nil {
			return a, persist("read validation unit bounds", err)
		}
		if metadata.FormatVersion != nil {
			return a, persist("validate materialization progress", errors.New("unit already materialized past the recorded cursor"))
		}
		if metadata.StoredBytes < 1 || metadata.StoredBytes > s.limits.PartBytes {
			return a, publicationError("capacity", "validation unit exceeds the current read budget")
		}
		receipt, err := q.GetPublicationPart(ctx, db.GetPublicationPartParams{AttemptID: id, Ordinal: ordinal})
		if err != nil {
			return a, persist("read validation unit receipt", err)
		}
		payload, err := q.GetPublicationPartBody(ctx, db.GetPublicationPartBodyParams{AttemptID: id, Ordinal: ordinal})
		if err != nil {
			return a, persist("read validation unit", err)
		}
		sum := sha256.Sum256(payload.Body)
		if int64(len(payload.Body)) != receipt.ByteCount || hex.EncodeToString(sum[:]) != receipt.Digest {
			return a, persist("verify stored publication unit", errors.New("unit length or digest changed"))
		}
		input, normalized, err := preparePublicationPart(p, source, payload.Body, s.limits.Parts)
		if err != nil {
			return a, err
		}
		header, err := publicationFingerprint(struct {
			Target     publication.Target
			Session    canonical.SessionRecord
			Threads    []canonical.ThreadRecord
			ObservedAt string
			Source     ingestion.Source
			Profile    string
		}{
			input.Target, normalized.Session, normalized.Threads, normalized.ObservedAt.Format("2006-01-02T15:04:05.999999999Z07:00"), input.Batch.Source, input.Batch.CanonicalProfileVersion})
		if err != nil {
			return a, err
		}
		if row.HeaderDigest != nil && *row.HeaderDigest != header {
			return a, publicationError("invalid", "Session, topology, target counts or capture provenance changed between parts")
		}
		totalEvents := a.CandidateEvents + len(normalized.Events)
		totalUsage := a.CandidateUsage + len(normalized.Usage)
		if totalEvents > input.Target.Events || totalUsage > input.Target.Usage {
			return a, publicationError("invalid", "target contains more members than declared")
		}
		done := a.ValidatedParts+1 == a.Seal.Parts
		if done && (totalEvents != input.Target.Events || totalUsage != input.Target.Usage) {
			return a, publicationError("invalid", "target membership is incomplete")
		}
		if ordinal == 0 {
			if err = recordPublicationMember(ctx, q, id, a.SessionID, ordinal, preparedMember{kind: "session", id: normalized.Session.ID, sourceKey: normalized.Session.SourceKey, revision: normalized.Session.Revision, fingerprint: normalized.Session.Digest}); err != nil {
				return a, err
			}
			for n, thread := range normalized.Threads {
				legacy, legacyErr := q.GetThreadForUpdate(ctx, db.GetThreadForUpdateParams{SessionID: a.SessionID, ID: thread.ID})
				if legacyErr == nil && !sameOptionalString(legacy.ParentThreadID, thread.ParentThreadID) {
					return a, publicationError("conflict", "legacy Thread parent is immutable")
				}
				if legacyErr != nil && !errors.Is(legacyErr, pgx.ErrNoRows) {
					return a, persist("read legacy Thread parent", legacyErr)
				}
				if err = recordPublicationMember(ctx, q, id, a.SessionID, ordinal, preparedMember{kind: "thread", id: thread.ID, sourceKey: thread.SourceKey, threadID: thread.ID, revision: thread.Revision, fingerprint: thread.Digest, index: n}); err != nil {
					return a, err
				}
			}
		}
		if err = materializePublicationContent(ctx, q, id, a.SessionID, ordinal, &normalized, false); err != nil {
			return a, err
		}
		encoded, err := json.Marshal(normalized)
		if err != nil {
			return a, persist("encode normalized publication unit", err)
		}
		if int64(len(encoded)) > s.limits.PartBytes {
			return a, publicationError("capacity", "normalized unit exceeds the configured part budget")
		}
		delta := int64(len(encoded)) - payload.StoredBytes
		usage, err := q.PublicationUsage(ctx, userID)
		if err != nil {
			return a, persist("read validation storage budget", err)
		}
		if delta > s.limits.TargetBytes-a.RetainedBytes || delta > s.limits.UserPendingBytes-usage.RetainedBytes {
			return a, publicationError("capacity", "normalization exceeds pending payload budget")
		}
		if err = q.StoreValidatedPublicationPart(ctx, db.StoreValidatedPublicationPartParams{AttemptID: id, Ordinal: ordinal, ValidatedBody: encoded}); err != nil {
			return a, persist("store fixed Canonical unit", err)
		}
		if err = prepareOverviewFacts(ctx, q, id, ordinal, normalized); err != nil {
			return a, err
		}
		targetBytes, err := json.Marshal(input.Target)
		if err != nil {
			return a, persist("encode target counts", err)
		}
		target := string(targetBytes)
		state := "validating"
		if done && len(input.Target.RetainedThreadIDs) == 0 {
			state = "validated"
		}
		if err = q.AdvancePublicationValidation(ctx, db.AdvancePublicationValidationParams{ID: id, Events: int32(len(normalized.Events)), Usage: int32(len(normalized.Usage)), ByteDelta: delta, HeaderDigest: &header, TargetJson: &target, State: state}); err != nil {
			return a, persist("commit candidate materialization progress", err)
		}
		current, err := publicationAttempt(ctx, q, id)
		if err != nil {
			return current, err
		}
		if err = liveAttempt(current); err != nil {
			return current, err
		}
		return current, nil
	})
}

func preparePublicationPart(p authentication.Principal, source db.CanonicalPublicationSource, body []byte, maxParts int) (publication.CanonicalPart, canonical.WriteBatch, error) {
	var input publication.CanonicalPart
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, canonical.WriteBatch{}, publicationError("invalid", "candidate part is not the declared Canonical envelope")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return input, canonical.WriteBatch{}, publicationError("invalid", "candidate part contains trailing JSON")
	}
	target := input.Target
	if (target.Profile != publication.TargetProfile && target.Profile != publication.RetentionTargetProfile) || target.Threads < 1 || target.Threads > 100 || target.Events < 0 || target.Events > maxParts*500 || target.Usage < 0 || target.Usage > maxParts*500 {
		return input, canonical.WriteBatch{}, publicationError("invalid", "invalid target profile or member counts")
	}
	if (target.Profile == publication.TargetProfile && target.RetainedThreadIDs != nil) || (target.Profile == publication.RetentionTargetProfile && target.RetainedThreadIDs == nil) || len(target.RetainedThreadIDs) > 100 {
		return input, canonical.WriteBatch{}, publicationError("invalid", "retention requires an explicit v2 target")
	}
	retained := make(map[string]bool, len(target.RetainedThreadIDs))
	for _, value := range target.RetainedThreadIDs {
		if !publicationText(value, 500) || retained[value] {
			return input, canonical.WriteBatch{}, publicationError("invalid", "invalid retained Thread identity")
		}
		retained[value] = true
	}
	for _, thread := range input.Batch.Threads {
		if retained[thread.SourceThreadID] && thread.ParentSourceThreadID == nil {
			return input, canonical.WriteBatch{}, publicationError("invalid", "root Thread cannot be retained")
		}
		delete(retained, thread.SourceThreadID)
	}
	if len(retained) != 0 {
		return input, canonical.WriteBatch{}, publicationError("invalid", "retained Thread header is absent")
	}
	for _, event := range input.Batch.Events {
		for _, thread := range target.RetainedThreadIDs {
			if event.SourceThreadID == thread {
				return input, canonical.WriteBatch{}, publicationError("invalid", "retained Thread contains explicit Events")
			}
		}
	}
	for _, usage := range input.Batch.Usage {
		for _, thread := range target.RetainedThreadIDs {
			if usage.SourceThreadID == thread {
				return input, canonical.WriteBatch{}, publicationError("invalid", "retained Thread contains explicit usage")
			}
		}
	}
	if target.Profile == publication.RetentionTargetProfile && input.Batch.Session.ReportedEventCount != target.Events {
		return input, canonical.WriteBatch{}, publicationError("invalid", "Session count differs from explicit target projection")
	}
	batch := input.Batch
	if batch.ProjectID != source.ProjectID || batch.Source.InstallationID != source.InstallationID || batch.Source.AdapterID != source.AdapterID || batch.Session.SourceSessionID != source.SourceSessionID {
		return input, canonical.WriteBatch{}, publicationError("invalid", "candidate part left its reserved source scope")
	}
	normalized, err := ingestion.PrepareBatch(p, batch)
	if err != nil {
		var invalid *ingestion.ValidationError
		if errors.As(err, &invalid) {
			return input, normalized, publicationError("invalid", invalid.Error())
		}
		return input, normalized, err
	}
	if normalized.Session.ID != source.SessionID || normalized.Session.SourceKey != source.SourceKey || len(normalized.Threads) != target.Threads {
		return input, normalized, publicationError("invalid", "candidate identity or Thread count differs from its reservation")
	}
	if source.LegacyAdopted {
		if normalized.Session.Revision <= source.RevisionFloor {
			return input, normalized, publicationError("conflict", "Session revision does not exceed legacy floor")
		}
		for _, thread := range normalized.Threads {
			if thread.Revision <= source.RevisionFloor {
				return input, normalized, publicationError("conflict", "Thread revision does not exceed legacy floor")
			}
		}
		for _, event := range normalized.Events {
			if event.Revision <= source.RevisionFloor || event.ProjectionRevision <= source.RevisionFloor {
				return input, normalized, publicationError("conflict", "Event version does not exceed legacy floor")
			}
		}
		for _, usage := range normalized.Usage {
			if usage.Revision <= source.RevisionFloor {
				return input, normalized, publicationError("conflict", "usage revision does not exceed legacy floor")
			}
		}
	}
	sort.Slice(normalized.Threads, func(i, j int) bool { return normalized.Threads[i].ID < normalized.Threads[j].ID })
	return input, normalized, nil
}

func publicationFingerprint(value any) (string, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return "", persist("fingerprint normalized candidate", err)
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:]), nil
}
func publicationThreadPaths(threads []canonical.ThreadRecord) map[string][]canonical.ProjectionThread {
	byID := make(map[string]canonical.ThreadRecord, len(threads))
	for _, thread := range threads {
		byID[thread.ID] = thread
	}
	result := make(map[string][]canonical.ProjectionThread, len(threads))
	for _, thread := range threads {
		path := []canonical.ProjectionThread{}
		current := thread
		for {
			path = append(path, canonical.ProjectionThread{ID: current.ID, Label: current.Label})
			if current.ParentThreadID == nil {
				break
			}
			current = byID[*current.ParentThreadID]
		}
		for left, right := 0, len(path)-1; left < right; left, right = left+1, right-1 {
			path[left], path[right] = path[right], path[left]
		}
		result[thread.ID] = path
	}
	return result
}

type preparedMember struct {
	kind, id, sourceKey, threadID, fingerprint, descriptor string
	projection, revision, sourceOrder                      int64
	index, eventIndex                                      int
}

func recordPublicationMember(ctx context.Context, q *db.Queries, attemptID pgtype.UUID, sessionID string, partOrdinal int32, member preparedMember) error {
	_, err := q.GetPublicationMember(ctx, db.GetPublicationMemberParams{AttemptID: attemptID, Kind: member.kind, RecordID: member.id})
	if err == nil {
		return publicationError("invalid", "target contains duplicate "+member.kind+" membership")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return persist("check target membership", err)
	}
	if err := legacyPublicationIdentity(ctx, q, sessionID, member); err != nil {
		return err
	}
	identity, err := q.GetPublicationRecordIdentity(ctx, db.GetPublicationRecordIdentityParams{SessionID: sessionID, Kind: member.kind, RecordID: member.id})
	if err == nil && (identity.SourceKey != member.sourceKey || identity.ThreadID != member.threadID) {
		return publicationError("conflict", "stable "+member.kind+" identity or ownership changed")
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return persist("read source identity", err)
	}
	previous, err := q.GetPublicationRecordVersion(ctx, db.GetPublicationRecordVersionParams{Kind: member.kind, SourceKey: member.sourceKey, ProjectionRevision: member.projection, Revision: member.revision})
	if err == nil && previous != member.fingerprint {
		return publicationError("conflict", "source "+member.kind+" version has different content")
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return persist("read source version", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if err = q.InsertPublicationRecordVersion(ctx, db.InsertPublicationRecordVersionParams{SessionID: sessionID, Kind: member.kind, SourceKey: member.sourceKey, RecordID: member.id, ThreadID: member.threadID, ProjectionRevision: member.projection, Revision: member.revision, Fingerprint: member.fingerprint}); err != nil {
			return persist("bind source version", err)
		}
	}
	if err = q.InsertPublicationMember(ctx, db.InsertPublicationMemberParams{AttemptID: attemptID, Kind: member.kind, RecordID: member.id, SourceKey: member.sourceKey, PartOrdinal: partOrdinal, EntryIndex: int32(member.index), ThreadID: member.threadID, SourceOrder: member.sourceOrder, EventIndex: int64(member.eventIndex), SearchDescriptor: member.descriptor}); err != nil {
		return persist("materialize target membership", err)
	}
	return nil
}

// Adoption never permits a previously used stable identity to move across
// Threads, even when the first sourceCapture version has a fresh version pair.
func legacyPublicationIdentity(ctx context.Context, q *db.Queries, sessionID string, member preparedMember) error {
	switch member.kind {
	case "thread":
		value, err := q.GetThreadForUpdate(ctx, db.GetThreadForUpdateParams{SessionID: sessionID, ID: member.id})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return persist("read legacy Thread identity", err)
		}
		if value.SourceKey != member.sourceKey {
			return publicationError("conflict", "stable Thread source identity changed")
		}
	case "event":
		value, err := q.GetEventByIDForUpdate(ctx, member.id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return persist("read legacy Event identity", err)
		}
		if value.SessionID != sessionID || value.SourceKey != member.sourceKey || value.ThreadID != member.threadID {
			return publicationError("conflict", "stable Event source identity or ownership changed")
		}
	case "usage":
		value, err := q.GetUsageForUpdate(ctx, member.sourceKey)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return persist("read legacy usage identity", err)
		}
		if value.SessionID != sessionID || value.ThreadID != member.threadID {
			return publicationError("conflict", "stable usage ownership changed")
		}
	}
	return nil
}
