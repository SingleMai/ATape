package authentication

import (
	"context"
	"errors"

	authdb "github.com/SingleMai/ATape/server/internal/authentication/internal/db"
	"github.com/jackc/pgx/v5"
)

// DisableUser atomically protects every last-Owner invariant, disables the
// User, and revokes all local authentication authority. It is an operator
// use case; no public Instance administrator role is introduced in auth-v1.
func (m *Module) DisableUser(ctx context.Context, input DisableUserInput) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	userID, err := databaseUUID(input.UserID)
	if err != nil || !validateRequestID(input.RequestID) || !validAuditReason(input.Reason) {
		return domainError(CodeInvalidRequest)
	}
	_, err = withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		queries := authdb.New(tx)
		user, err := queries.GetUserForUpdate(ctx, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, domainError(CodeNotFound)
		}
		if err != nil {
			return struct{}{}, err
		}
		if user.Status == "disabled" {
			return struct{}{}, nil
		}
		if user.Status != "active" {
			return struct{}{}, domainError(CodeMisconfigured)
		}
		ownedTeams, err := queries.ListActiveOwnerTeamIDsForUser(ctx, userID)
		if err != nil {
			return struct{}{}, err
		}
		for _, teamID := range ownedTeams {
			if err := queries.LockTeamForUserDisable(ctx, teamID); err != nil {
				return struct{}{}, err
			}
		}
		for _, teamID := range ownedTeams {
			otherOwners, err := queries.CountOtherActiveOwnersForUserDisable(
				ctx, authdb.CountOtherActiveOwnersForUserDisableParams{TeamID: teamID, UserID: userID},
			)
			if err != nil {
				return struct{}{}, err
			}
			if otherOwners == 0 {
				return struct{}{}, domainError(CodeLastOwnerRequired)
			}
		}
		affected, err := queries.DisableUser(ctx, userID)
		if err != nil {
			return struct{}{}, err
		}
		if affected != 1 {
			return struct{}{}, domainError(CodeMisconfigured)
		}
		if _, err := queries.FailFederatedLoginsForUser(ctx, userID); err != nil {
			return struct{}{}, err
		}
		if _, err := queries.ExpireApprovedCLIAuthorizationsForUser(ctx, userID); err != nil {
			return struct{}{}, err
		}
		if _, err := queries.RevokeAllWebSessionsForUser(ctx, authdb.RevokeAllWebSessionsForUserParams{
			UserID: userID, TerminalReason: "user_disabled",
		}); err != nil {
			return struct{}{}, err
		}
		if _, err := queries.RevokeAllCLICredentialsForUser(ctx, authdb.RevokeAllCLICredentialsForUserParams{
			UserID: userID, RevokeReason: "user_disabled",
		}); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, appendAudit(ctx, queries, auditRecord{
			initiatorKind: "system", action: "user.disable", targetKind: "user",
			targetID: input.UserID, outcome: "succeeded", reason: input.Reason,
			requestID: input.RequestID,
		})
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return err
		}
		return unavailable("disable User", err)
	}
	return nil
}
