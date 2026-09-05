package postgres

import (
	"context"
	"errors"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func (s *Store) DeleteSession(
	ctx context.Context,
	principal authentication.Principal,
	sessionID string,
	requestID string,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	userID, err := principalUUID(principal)
	if err != nil {
		return concealedAccess(principal, authorization.CapturedSessionDeleteAny, authorization.CapturedSessionResource)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return persist("begin captured Session deletion", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	queries := s.queries.WithTx(tx)
	row, err := queries.ResolveCapturedSessionDeleteForUpdate(ctx, db.ResolveCapturedSessionDeleteForUpdateParams{
		UserID: userID, SessionID: sessionID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return concealedAccess(principal, authorization.CapturedSessionDeleteAny, authorization.CapturedSessionResource)
	}
	if err != nil {
		return persist("resolve captured Session deletion", err)
	}
	action := authorization.CapturedSessionDeleteAny
	if domainUUID(row.CapturedByUserID) == principal.UserID {
		action = authorization.CapturedSessionDeleteOwn
	}
	if err := enforceAccess(principal, action, authorization.ResourceFacts{
		Kind: authorization.CapturedSessionResource, TeamID: row.TeamID,
		CapturedByUserID: domainUUID(row.CapturedByUserID),
	}, membershipFacts(row.TeamID, row.UserID, row.Role, row.Status)); err != nil {
		return err
	}
	if row.RecordState == "deleted" {
		return nil
	}
	if row.RecordState != "active" {
		return persist("validate captured Session lifecycle state", errors.New("unknown record state"))
	}
	affected, err := queries.TombstoneCapturedSession(ctx, db.TombstoneCapturedSessionParams{
		ID: sessionID, DeletedByUserID: userID,
	})
	if err != nil {
		return persist("tombstone captured Session", err)
	}
	if affected != 1 {
		return concealedAccess(principal, action, authorization.CapturedSessionResource)
	}
	if err := queries.DeleteSessionBatchReceipts(ctx, sessionID); err != nil {
		return persist("delete captured Session receipts", err)
	}
	if err := queries.DeleteSessionProjectionChanges(ctx, sessionID); err != nil {
		return persist("delete captured Session projection work", err)
	}
	if err := queries.DeleteSessionSearchDocuments(ctx, sessionID); err != nil {
		return persist("delete captured Session search documents", err)
	}
	auditID, err := uuid.NewV7()
	if err != nil {
		return persist("generate captured Session audit identity", err)
	}
	webSessionID, err := optionalAuditUUID(principal.WebSessionID)
	if err != nil {
		return persist("validate Web Session audit identity", err)
	}
	cliCredentialID, err := optionalAuditUUID(principal.CLICredentialID)
	if err != nil {
		return persist("validate CLI Credential audit identity", err)
	}
	if err := queries.InsertResourceSecurityAuditEvent(ctx, db.InsertResourceSecurityAuditEventParams{
		ID: mustPostgresUUID(auditID.String()), InitiatorID: principal.UserID,
		Action: "captured_session.delete", TargetKind: "canonical_session", TargetID: sessionID,
		Reason: "user_requested", RequestID: requestID,
		WebSessionID: webSessionID, CliCredentialID: cliCredentialID,
	}); err != nil {
		return persist("audit captured Session deletion", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return persist("commit captured Session deletion", err)
	}
	return nil
}

func optionalAuditUUID(value string) (pgtype.UUID, error) {
	if value == "" {
		return pgtype.UUID{}, nil
	}
	return databaseUUID(value)
}

func mustPostgresUUID(value string) pgtype.UUID {
	result, err := databaseUUID(value)
	if err != nil {
		panic("generated UUID is invalid")
	}
	return result
}
