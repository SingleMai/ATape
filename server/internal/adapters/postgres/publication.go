package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/sourceidentity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PublicationStore owns candidate lifetime, immutable retries, source mode and
// authority, validation, atomic activation, quotas and cleanup.
// Callers never receive SQL rows or pending bodies through recovery metadata.
type PublicationStore struct {
	pool   *pgxpool.Pool
	limits publication.Limits
}

func NewPublicationStore(pool *pgxpool.Pool, limits publication.Limits) (*PublicationStore, error) {
	if pool == nil || limits.PartBytes < 1 || limits.PartBytes > 4<<20 || limits.TargetBytes < limits.PartBytes || limits.TargetBytes > 1<<30 ||
		limits.UserPendingBytes < limits.TargetBytes || limits.UserPendingBytes > 16<<30 || limits.Parts < 1 || limits.Parts > 4096 ||
		limits.Reservations < 1 || limits.Reservations > 128 || limits.LeaseLifetime < time.Millisecond || limits.LeaseLifetime > time.Hour ||
		limits.ReservationLifetime < limits.LeaseLifetime || limits.ReservationLifetime > 24*time.Hour {
		return nil, publicationError("invalid", "candidate limits are outside supported bounds")
	}
	return &PublicationStore{pool: pool, limits: limits}, nil
}
func publicationError(code, message string) error {
	return &publication.Error{Code: code, Message: message}
}
func publicationText(value string, max int) bool {
	return strings.TrimSpace(value) != "" && len(value) <= max && utf8.ValidString(value) && !strings.ContainsAny(value, "\x00\r\n")
}
func publicationID(value string) (pgtype.UUID, error) {
	id, err := databaseUUID(value)
	if err != nil {
		return id, publicationError("invalid", "invalid reservation identity")
	}
	return id, nil
}

// One account lock serializes quota changes across independent connections.
// Source locks additionally coordinate with the legacy ingestion path. Every
// operation has a deadline, including lock waits, and owns its transaction.
func publicationTransaction[A any](ctx context.Context, s *PublicationStore, p authentication.Principal, work func(context.Context, *db.Queries, pgtype.UUID) (A, error)) (result A, err error) {
	if p.Method != authentication.CLIAuthentication {
		return result, concealedAccess(p, authorization.CanonicalIngest, authorization.ProjectResource)
	}
	userID, e := principalUUID(p)
	if e != nil {
		return result, concealedAccess(p, authorization.CanonicalIngest, authorization.ProjectResource)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	tx, e := s.pool.Begin(ctx)
	if e != nil {
		return result, persist("begin publication candidate operation", e)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	q := db.New(tx)
	if e = q.AcquireCanonicalLock(ctx, "publication-user:"+p.UserID); e != nil {
		return result, persist("lock publication quota", e)
	}
	result, e = work(ctx, q, userID)
	if e != nil {
		return result, e
	}
	if e = tx.Commit(ctx); e != nil {
		return result, persist("commit publication candidate operation", e)
	}
	return result, nil
}
func (s *PublicationStore) sourceAccess(ctx context.Context, q *db.Queries, p authentication.Principal, source db.CanonicalPublicationSource) error {
	if domainUUID(source.CapturedByUserID) != p.UserID {
		return concealedAccess(p, authorization.CanonicalIngest, authorization.ProjectResource)
	}
	if err := q.AcquireCanonicalLock(ctx, "session:"+source.SourceKey); err != nil {
		return persist("lock publication source", err)
	}
	access, err := resolveProjectAccess(ctx, q, p, source.ProjectID, authorization.CanonicalIngest, true)
	if err != nil {
		return err
	}
	if access.projectState != "active" {
		return &canonical.ProjectStateError{State: access.projectState}
	}
	// A later Session deletion remains authoritative; it cannot be resurrected by
	// a retained reservation. First publication has no ordinary Session row yet.
	session, err := q.GetSessionForUpdate(ctx, source.SessionID)
	if err == nil && session.RecordState != "active" {
		return &canonical.ProjectStateError{State: "session_deleted"}
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return persist("read publication lifecycle", err)
	}
	return nil
}
func (s *PublicationStore) reservation(ctx context.Context, q *db.Queries, p authentication.Principal, id pgtype.UUID) (db.GetPublicationReservationRow, db.CanonicalPublicationSource, error) {
	r, err := q.GetPublicationReservation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, db.CanonicalPublicationSource{}, publicationError("unknown", "reservation is unavailable; this does not prove non-activation")
	}
	if err != nil {
		return r, db.CanonicalPublicationSource{}, persist("read publication reservation", err)
	}
	source, err := q.GetPublicationSource(ctx, r.SessionID)
	if err != nil {
		return r, source, persist("read publication binding", err)
	}
	if err = s.sourceAccess(ctx, q, p, source); err != nil {
		return r, source, err
	}
	// The source may have changed while waiting for its transaction lock.
	source, err = q.GetPublicationSource(ctx, r.SessionID)
	return r, source, err
}
func attemptValue(row db.GetPublicationAttemptRow) (publication.Attempt, error) {
	value := publication.Attempt{ID: domainUUID(row.ID), SessionID: row.SessionID, CaptureID: row.CaptureID, TransformVersion: row.TransformVersion,
		Fence: row.Fence, LeaseUntil: row.LeaseUntil, ExpiresAt: row.ExpiresAt, State: row.EffectiveState, Parts: int(row.PartCount), RetainedBytes: row.RetainedBytes}
	value.ValidatedParts = int(row.ValidatedParts)
	value.CandidateEvents = int(row.CandidateEvents)
	value.CandidateUsage = int(row.CandidateUsage)
	if row.ActivationJson != nil {
		if err := json.Unmarshal([]byte(*row.ActivationJson), &value.Activation); err != nil {
			return value, persist("decode activation receipt", err)
		}
	}
	if row.BaseHead != nil {
		value.BaseHead = *row.BaseHead
	}
	if row.SealJson != nil {
		if err := json.Unmarshal([]byte(*row.SealJson), &value.Seal); err != nil {
			return value, persist("decode publication manifest", err)
		}
	}
	return value, nil
}
func publicationAttempt(ctx context.Context, q *db.Queries, id pgtype.UUID) (publication.Attempt, error) {
	row, err := q.GetPublicationAttempt(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return publication.Attempt{}, publicationError("unknown", "reservation has not begun")
	}
	if err != nil {
		return publication.Attempt{}, persist("read publication attempt", err)
	}
	return attemptValue(row)
}
func liveAttempt(a publication.Attempt) error {
	if a.State != "open" && a.State != "sealed" && a.State != "validating" && a.State != "validated" {
		return publicationError(a.State, "candidate no longer has write authority")
	}
	return nil
}

// Reserve returns a server-generated, finite-validity identity. Its loss can
// consume only the configured reservation quota; it never creates visible data.
func (s *PublicationStore) Reserve(ctx context.Context, p authentication.Principal, scope publication.Scope) (publication.Reservation, error) {
	if !publicationText(scope.ProjectID, 200) || !publicationText(scope.InstallationID, 200) || !publicationText(scope.AdapterID, 200) || !publicationText(scope.SourceSessionID, 500) || !publicationText(scope.OriginKey, 500) {
		return publication.Reservation{}, publicationError("invalid", "invalid publication scope")
	}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, userID pgtype.UUID) (publication.Reservation, error) {
		zero := publication.Reservation{}
		sessionID := sourceidentity.SessionID(scope.ProjectID, p.UserID, scope.InstallationID, scope.AdapterID, scope.SourceSessionID)
		sourceKey := sourceidentity.SessionSourceKey(scope.ProjectID, p.UserID, scope.InstallationID, scope.AdapterID, scope.SourceSessionID)
		source := db.CanonicalPublicationSource{SessionID: sessionID, SourceKey: sourceKey, ProjectID: scope.ProjectID, CapturedByUserID: userID}
		if err := s.sourceAccess(ctx, q, p, source); err != nil {
			return zero, err
		}
		old, err := q.GetPublicationSource(ctx, sessionID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return zero, persist("read publication mode", err)
		}
		if err == nil {
			if old.SourceKey != sourceKey || old.OriginKey != scope.OriginKey {
				return zero, publicationError("conflict", "source binding is immutable")
			}
		} else {
			if _, e := q.GetSessionForUpdate(ctx, sessionID); e == nil {
				return zero, publicationError("conflict", "legacy Session cannot enter publication mode")
			} else if !errors.Is(e, pgx.ErrNoRows) {
				return zero, persist("read legacy Session", e)
			}
			err = q.InsertPublicationSource(ctx, db.InsertPublicationSourceParams{SessionID: sessionID, SourceKey: sourceKey, ProjectID: scope.ProjectID, CapturedByUserID: userID,
				InstallationID: scope.InstallationID, AdapterID: scope.AdapterID, SourceSessionID: scope.SourceSessionID, OriginKey: scope.OriginKey})
			if err != nil {
				return zero, persist("bind publication mode", err)
			}
		}
		usage, err := q.PublicationUsage(ctx, userID)
		if err != nil {
			return zero, persist("read reservation quota", err)
		}
		if usage.Reservations >= int64(s.limits.Reservations) {
			return zero, publicationError("capacity", "reservation quota exhausted")
		}
		token, err := uuid.NewRandom()
		if err != nil {
			return zero, persist("allocate publication reservation", err)
		}
		row, err := q.CreatePublicationReservation(ctx, db.CreatePublicationReservationParams{ID: mustPostgresUUID(token.String()), SessionID: sessionID, LifetimeMs: s.limits.ReservationLifetime.Milliseconds()})
		if err != nil {
			return zero, persist("reserve publication", err)
		}
		return publication.Reservation{ID: domainUUID(row.ID), SessionID: sessionID, ExpiresAt: row.ExpiresAt}, nil
	})
}
func (s *PublicationStore) Begin(ctx context.Context, p authentication.Principal, input publication.Begin) (publication.Attempt, error) {
	id, err := publicationID(input.ReservationID)
	if err != nil {
		return publication.Attempt{}, err
	}
	if !publicationText(input.CaptureID, 200) || !publicationText(input.TransformVersion, 200) || (input.BaseHead != "" && !publicationText(input.BaseHead, 200)) {
		return publication.Attempt{}, publicationError("invalid", "invalid Begin identity")
	}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, _ pgtype.UUID) (publication.Attempt, error) {
		r, source, err := s.reservation(ctx, q, p, id)
		if err != nil {
			return publication.Attempt{}, err
		}
		old, err := q.GetPublicationAttempt(ctx, id)
		if err == nil {
			a, e := attemptValue(old)
			if e != nil {
				return a, e
			}
			if a.CaptureID != input.CaptureID || a.BaseHead != input.BaseHead || a.TransformVersion != input.TransformVersion {
				return a, publicationError("conflict", "Begin identity has different content")
			}
			return a, nil // Replay never renews a lease or allocates a newer fence.
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return publication.Attempt{}, persist("read Begin receipt", err)
		}
		if !r.Valid {
			return publication.Attempt{}, publicationError("expired", "reservation cannot create a new attempt")
		}
		var base *string
		if input.BaseHead != "" {
			base = &input.BaseHead
		}
		if !sameOptionalString(base, source.CurrentHead) {
			return publication.Attempt{}, publicationError("conflict", "base head changed before Begin")
		}
		fence, err := q.NextPublicationFence(ctx, r.SessionID)
		if err != nil {
			return publication.Attempt{}, persist("allocate publication fence", err)
		}
		_, err = q.CreatePublicationAttempt(ctx, db.CreatePublicationAttemptParams{ID: id, SessionID: r.SessionID, CaptureID: input.CaptureID, BaseHead: base, TransformVersion: input.TransformVersion, Fence: fence, ExpiresAt: r.ExpiresAt, LeaseMs: s.limits.LeaseLifetime.Milliseconds()})
		if errors.Is(err, pgx.ErrNoRows) {
			return publication.Attempt{}, publicationError("expired", "reservation expired before Begin")
		}
		if err != nil {
			return publication.Attempt{}, persist("begin publication", err)
		}
		return publicationAttempt(ctx, q, id)
	})
}
func (s *PublicationStore) Put(ctx context.Context, p authentication.Principal, attemptID string, ordinal int, wantedDigest string, body []byte) (publication.Part, error) {
	id, err := publicationID(attemptID)
	if err != nil {
		return publication.Part{}, err
	}
	if ordinal < 0 || ordinal >= s.limits.Parts || len(body) == 0 || int64(len(body)) > s.limits.PartBytes {
		return publication.Part{}, publicationError("invalid", "part exceeds declared bounds")
	}
	sum := sha256.Sum256(body)
	fingerprint := hex.EncodeToString(sum[:])
	if wantedDigest != fingerprint {
		return publication.Part{}, publicationError("invalid", "part digest does not match bytes")
	}
	part := publication.Part{Ordinal: ordinal, SHA256: fingerprint, Bytes: int64(len(body))}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, userID pgtype.UUID) (publication.Part, error) {
		if _, _, err := s.reservation(ctx, q, p, id); err != nil {
			return publication.Part{}, err
		}
		a, err := publicationAttempt(ctx, q, id)
		if err != nil {
			return publication.Part{}, err
		}
		if err = liveAttempt(a); err != nil {
			return publication.Part{}, err
		}
		old, err := q.GetPublicationPart(ctx, db.GetPublicationPartParams{AttemptID: id, Ordinal: int32(ordinal)})
		if err == nil {
			if old.Digest != part.SHA256 || old.ByteCount != part.Bytes {
				return publication.Part{}, publicationError("conflict", "part identity has different bytes")
			}
			return part, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return publication.Part{}, persist("read part receipt", err)
		}
		if a.State != "open" {
			return publication.Part{}, publicationError("conflict", "sealed candidate cannot acquire new parts")
		}
		usage, err := q.PublicationUsage(ctx, userID)
		if err != nil {
			return publication.Part{}, persist("read payload quota", err)
		}
		if a.Parts >= s.limits.Parts || part.Bytes > s.limits.TargetBytes-a.RetainedBytes || part.Bytes > s.limits.UserPendingBytes-usage.RetainedBytes {
			return publication.Part{}, publicationError("capacity", "pending payload quota exhausted; live content was retained")
		}
		if err = q.InsertPublicationPart(ctx, db.InsertPublicationPartParams{AttemptID: id, Ordinal: int32(ordinal), Digest: fingerprint, ByteCount: part.Bytes, Body: body}); err != nil {
			return publication.Part{}, persist("store publication part", err)
		}
		if err = q.AddPublicationBytes(ctx, db.AddPublicationBytesParams{ID: id, RetainedBytes: part.Bytes}); err != nil {
			return publication.Part{}, persist("account publication part", err)
		}
		// Check again after storage work: an operation that crosses its lease
		// deadline must roll back both the body and its quota accounting.
		current, err := publicationAttempt(ctx, q, id)
		if err != nil {
			return publication.Part{}, err
		}
		if err = liveAttempt(current); err != nil {
			return publication.Part{}, err
		}
		return part, nil
	})
}
func (s *PublicationStore) Seal(ctx context.Context, p authentication.Principal, attemptID string, manifest publication.Manifest) (publication.Attempt, error) {
	id, err := publicationID(attemptID)
	if err != nil {
		return publication.Attempt{}, err
	}
	if manifest.Parts < 1 || manifest.Parts > s.limits.Parts || manifest.Bytes < 1 || manifest.Bytes > s.limits.TargetBytes || len(manifest.SHA256) != 64 {
		return publication.Attempt{}, publicationError("invalid", "invalid candidate manifest")
	}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, _ pgtype.UUID) (publication.Attempt, error) {
		if _, _, err := s.reservation(ctx, q, p, id); err != nil {
			return publication.Attempt{}, err
		}
		a, err := publicationAttempt(ctx, q, id)
		if err != nil {
			return a, err
		}
		if err = liveAttempt(a); err != nil {
			return a, err
		}
		if a.Seal != nil {
			if *a.Seal != manifest {
				return a, publicationError("conflict", "sealed manifest changed")
			}
			return a, nil
		}
		if a.Parts != manifest.Parts || a.RetainedBytes != manifest.Bytes {
			return a, publicationError("conflict", "candidate has missing or extra parts")
		}
		h := publication.NewManifestHasher()
		after := -1
		for {
			rows, err := q.ListPublicationParts(ctx, db.ListPublicationPartsParams{AttemptID: id, AfterOrdinal: int32(after), PageLimit: 100})
			if err != nil {
				return a, persist("verify candidate manifest", err)
			}
			for _, row := range rows {
				if int(row.Ordinal) != after+1 {
					return a, publicationError("conflict", "candidate part sequence has a gap")
				}
				h.Add(publication.Part{Ordinal: int(row.Ordinal), SHA256: row.Digest, Bytes: row.ByteCount})
				after = int(row.Ordinal)
			}
			if len(rows) < 100 {
				break
			}
		}
		if h.Manifest() != manifest {
			return a, publicationError("conflict", "candidate manifest digest changed")
		}
		encoded, err := json.Marshal(manifest)
		if err != nil {
			return a, fmt.Errorf("encode publication manifest: %w", err)
		}
		value := string(encoded)
		if err = q.SealPublicationAttempt(ctx, db.SealPublicationAttemptParams{ID: id, SealJson: &value}); err != nil {
			return a, persist("seal publication candidate", err)
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
func (s *PublicationStore) Status(ctx context.Context, p authentication.Principal, attemptID string, after, limit int) (publication.Page, error) {
	id, err := publicationID(attemptID)
	if err != nil {
		return publication.Page{}, err
	}
	if after < -1 || after >= 4096 || limit < 1 || limit > 100 {
		return publication.Page{}, publicationError("invalid", "invalid metadata page bounds")
	}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, _ pgtype.UUID) (publication.Page, error) {
		if _, _, err := s.reservation(ctx, q, p, id); err != nil {
			return publication.Page{}, err
		}
		a, err := publicationAttempt(ctx, q, id)
		if err != nil {
			return publication.Page{}, err
		}
		rows, err := q.ListPublicationParts(ctx, db.ListPublicationPartsParams{AttemptID: id, AfterOrdinal: int32(after), PageLimit: int32(limit)})
		if err != nil {
			return publication.Page{}, persist("read candidate metadata", err)
		}
		page := publication.Page{Attempt: a, Parts: make([]publication.Part, 0, len(rows))}
		for _, row := range rows {
			page.Parts = append(page.Parts, publication.Part{Ordinal: int(row.Ordinal), SHA256: row.Digest, Bytes: row.ByteCount})
		}
		return page, nil
	})
}
func (s *PublicationStore) Renew(ctx context.Context, p authentication.Principal, attemptID string) (publication.Attempt, error) {
	id, err := publicationID(attemptID)
	if err != nil {
		return publication.Attempt{}, err
	}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, _ pgtype.UUID) (publication.Attempt, error) {
		r, _, err := s.reservation(ctx, q, p, id)
		if err != nil {
			return publication.Attempt{}, err
		}
		a, err := publicationAttempt(ctx, q, id)
		if err != nil {
			return a, err
		}
		if err = liveAttempt(a); err != nil {
			return a, err
		}
		if _, err = q.RenewPublicationAttempt(ctx, db.RenewPublicationAttemptParams{ID: id, ExpiresAt: r.ExpiresAt, LeaseMs: s.limits.LeaseLifetime.Milliseconds()}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return a, publicationError("expired", "lease expired before renewal")
			}
			return a, persist("renew publication candidate", err)
		}
		return publicationAttempt(ctx, q, id)
	})
}

// Reject durably resolves an unactivated candidate. Unknown IDs are never
// converted to rejection proof, and no timeout creates an activation receipt.
func (s *PublicationStore) Reject(ctx context.Context, p authentication.Principal, attemptID string) (publication.Attempt, error) {
	id, err := publicationID(attemptID)
	if err != nil {
		return publication.Attempt{}, err
	}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, _ pgtype.UUID) (publication.Attempt, error) {
		if _, _, err := s.reservation(ctx, q, p, id); err != nil {
			return publication.Attempt{}, err
		}
		a, err := publicationAttempt(ctx, q, id)
		if err != nil {
			return a, err
		}
		if a.Activation != nil {
			return a, publicationError("conflict", "activated history cannot be rejected")
		}
		if err = q.RejectPublicationAttempt(ctx, id); err != nil {
			return a, persist("reject publication candidate", err)
		}
		return publicationAttempt(ctx, q, id)
	})
}

// Reclaim is bounded and account-scoped. It removes failed candidates and
// unreachable old-head bodies, never the selected head. Activation receipts
// survive body cleanup; failed-attempt receipts expire with their reservation.
func (s *PublicationStore) Reclaim(ctx context.Context, p authentication.Principal, limit int) (publication.Reclaimed, error) {
	if limit < 1 || limit > 32 {
		return publication.Reclaimed{}, publicationError("invalid", "invalid reclamation limit")
	}
	return publicationTransaction(ctx, s, p, func(ctx context.Context, q *db.Queries, userID pgtype.UUID) (publication.Reclaimed, error) {
		result := publication.Reclaimed{}
		rows, err := q.PublicationReclaimParts(ctx, db.PublicationReclaimPartsParams{CapturedByUserID: userID, PageLimit: int32(limit)})
		if err != nil {
			return result, persist("find reclaimable publication parts", err)
		}
		for _, row := range rows {
			if err = q.DeletePublicationPart(ctx, db.DeletePublicationPartParams{AttemptID: row.AttemptID, Ordinal: row.Ordinal}); err != nil {
				return result, persist("reclaim publication part", err)
			}
			if err = q.SubtractPublicationBytes(ctx, db.SubtractPublicationBytesParams{ID: row.AttemptID, RetainedBytes: row.ByteCount}); err != nil {
				return result, persist("account reclaimed publication part", err)
			}
			result.Parts++
			result.Bytes += row.ByteCount
		}
		deleted, err := q.DeleteExpiredPublicationReservations(ctx, db.DeleteExpiredPublicationReservationsParams{CapturedByUserID: userID, PageLimit: int32(limit)})
		if err != nil {
			return result, persist("reclaim expired reservations", err)
		}
		result.Reservations = len(deleted)
		return result, nil
	})
}
