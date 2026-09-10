package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// Activate selects a complete fixed target in one transaction with Session
// metadata, capture progress, its durable receipt and eligibility of prepared
// Search work. It never scans or reconverts the complete target.
func (s *PublicationStore) Activate(ctx context.Context, p authentication.Principal, attemptID string) (publication.Activation, error) {
	id, err := publicationID(attemptID)
	if err != nil {
		return publication.Activation{}, err
	}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, _ pgtype.UUID) (publication.Activation, error) {
		zero := publication.Activation{}
		if _, _, err := s.reservation(ctx, q, p, id); err != nil {
			return zero, err
		}
		a, err := publicationAttempt(ctx, q, id)
		if err != nil {
			return zero, err
		}
		if a.Activation != nil {
			return *a.Activation, nil
		}
		if err = liveAttempt(a); err != nil {
			return zero, err
		}
		if a.State != "validated" || a.Seal == nil || a.ValidatedParts != a.Seal.Parts {
			return zero, publicationError("invalid", "only a completely validated target can activate")
		}
		// A single bounded fixed unit contains the already validated header.
		first, err := fixedPublicationPart(ctx, q, id, 0)
		if err != nil {
			return zero, err
		}
		_, err = q.GetSessionForUpdate(ctx, a.SessionID)
		if errors.Is(err, pgx.ErrNoRows) {
			params, e := insertSessionParams(first.Session)
			if e != nil {
				return zero, e
			}
			if e = q.InsertSession(ctx, params); e != nil {
				return zero, persist("publish Session", e)
			}
		} else if err != nil {
			return zero, persist("read publication Session", err)
		} else {
			params := db.SelectPublicationSessionParams(updateSessionParams(first.Session))
			if err = q.SelectPublicationSession(ctx, params); err != nil {
				return zero, persist("select Session metadata", err)
			}
		}
		if err = q.AdvanceProjectCapture(ctx, db.AdvanceProjectCaptureParams{ProjectID: first.ProjectID, ObservedAt: first.ObservedAt}); err != nil {
			return zero, persist("advance publication capture", err)
		}
		receipt := publication.Activation{Head: a.ID, SessionID: a.SessionID, CaptureID: a.CaptureID, BaseHead: a.BaseHead, Fence: a.Fence, TransformVersion: a.TransformVersion, Manifest: *a.Seal, ActivatedAt: time.Now().UTC()}
		body, err := json.Marshal(receipt)
		if err != nil {
			return zero, err
		}
		encoded := string(body)
		if err = q.RecordPublicationActivation(ctx, db.RecordPublicationActivationParams{ID: id, ActivationJson: &encoded, PublishedObservedAt: pgtype.Timestamptz{Time: first.ObservedAt, Valid: true}}); err != nil {
			return zero, persist("record activation proof", err)
		}
		// Select the pointer with a time, fence and base CAS, then confirm the
		// deadline again after any database storage work or triggers complete.
		changed, err := q.ActivatePublicationSource(ctx, db.ActivatePublicationSourceParams{Head: &a.ID, AttemptID: id})
		if err != nil {
			return zero, persist("select Canonical head", err)
		}
		if changed != 1 {
			return zero, publicationError("expired", "activation authority changed before commit")
		}
		valid, err := q.ConfirmPublicationActivationAuthority(ctx, id)
		if err != nil {
			return zero, persist("confirm activation authority", err)
		}
		if valid == nil || !*valid {
			return zero, publicationError("expired", "activation lease expired during storage work")
		}
		return receipt, nil
	})
}

func fixedPublicationPart(ctx context.Context, q *db.Queries, id pgtype.UUID, ordinal int32) (canonical.WriteBatch, error) {
	var value canonical.WriteBatch
	meta, err := q.GetPublicationPartStorage(ctx, db.GetPublicationPartStorageParams{AttemptID: id, Ordinal: ordinal})
	if err != nil {
		return value, persist("read fixed Canonical bounds", err)
	}
	if meta.FormatVersion == nil || *meta.FormatVersion != 1 || meta.StoredBytes < 1 || meta.StoredBytes > 4<<20 {
		return value, persist("read fixed Canonical format", errors.New("unsupported or oversized normalized part"))
	}
	part, err := q.GetPublicationPartBody(ctx, db.GetPublicationPartBodyParams{AttemptID: id, Ordinal: ordinal})
	if err != nil {
		return value, persist("read fixed Canonical unit", err)
	}
	if err = json.Unmarshal(part.ValidatedBody, &value); err != nil {
		return value, persist("decode fixed Canonical unit", err)
	}
	return value, nil
}
