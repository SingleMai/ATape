package team

import (
	"context"
	"errors"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	teamdb "github.com/SingleMai/ATape/server/internal/team/internal/db"
	"github.com/jackc/pgx/v5"
)

type lockedTeamAccess struct {
	teamID     string
	membership teamdb.TeamMembership
	facts      authorization.MembershipFacts
}

func (m *Module) lockTeamAccess(
	ctx context.Context,
	queries *teamdb.Queries,
	principal authentication.Principal,
	slug string,
) (lockedTeamAccess, error) {
	userID, err := m.lockPrincipalUser(ctx, queries, principal)
	if err != nil {
		return lockedTeamAccess{}, err
	}
	teamRow, err := queries.GetTeamBySlugForUpdate(ctx, &slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedTeamAccess{}, domainError(CodeNotFound)
	}
	if err != nil {
		return lockedTeamAccess{}, err
	}
	membership, membershipErr := queries.GetMembershipForUpdate(ctx, teamdb.GetMembershipForUpdateParams{
		TeamID: teamRow.ID, UserID: userID,
	})
	facts := authorization.MembershipFacts{}
	if membershipErr == nil {
		facts = membershipFacts(membership)
	} else if !errors.Is(membershipErr, pgx.ErrNoRows) {
		return lockedTeamAccess{}, membershipErr
	}
	return lockedTeamAccess{teamID: teamRow.ID, membership: membership, facts: facts}, nil
}

func (m *Module) ChangeMembershipRole(ctx context.Context, input ChangeMembershipRoleInput) (Membership, error) {
	slug, err := normalizeSlug(input.TeamSlug)
	targetUserID, userIDErr := databaseUUID(input.UserID)
	if err != nil || userIDErr != nil ||
		(input.Role != OwnerRole && input.Role != MemberRole) || !validateRequestID(input.RequestID) {
		return Membership{}, domainError(CodeInvalidRequest)
	}
	result, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (Membership, error) {
		queries := teamdb.New(tx)
		access, err := m.lockTeamAccess(ctx, queries, input.Principal, slug)
		if err != nil {
			return Membership{}, err
		}
		action := authorization.MembershipPromoteToOwner
		if input.Role == MemberRole {
			action = authorization.MembershipDemoteOwner
		}
		if err := m.authorize(input.Principal, action,
			authorization.ResourceFacts{Kind: authorization.MembershipResource, TeamID: access.teamID},
			access.facts); err != nil {
			return Membership{}, err
		}
		target, err := queries.GetMembershipForUpdate(ctx, teamdb.GetMembershipForUpdateParams{
			TeamID: access.teamID, UserID: targetUserID,
		})
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && target.Status != "active") {
			return Membership{}, domainError(CodeNotFound)
		}
		if err != nil {
			return Membership{}, err
		}
		targetUser, err := queries.GetPrincipalUserForShare(ctx, targetUserID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && targetUser.Status != "active") {
			return Membership{}, domainError(CodeResourceStateConflict)
		}
		if err != nil {
			return Membership{}, err
		}
		if target.Role == string(input.Role) {
			return membershipFromRow(target), nil
		}
		if target.Role == "owner" && input.Role == MemberRole {
			otherOwners, err := queries.CountOtherActiveOwners(ctx, teamdb.CountOtherActiveOwnersParams{
				TeamID: access.teamID, UserID: targetUserID,
			})
			if err != nil {
				return Membership{}, err
			}
			if otherOwners == 0 {
				return Membership{}, domainError(CodeLastOwnerRequired)
			}
		}
		updated, err := queries.SetMembershipRole(ctx, teamdb.SetMembershipRoleParams{
			TeamID: access.teamID, UserID: targetUserID, Role: string(input.Role),
		})
		if err != nil {
			return Membership{}, err
		}
		if err := appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: membershipRoleAction(input.Role),
			targetKind: "team_membership", targetID: access.teamID + ":" + input.UserID,
			requestID: input.RequestID,
		}); err != nil {
			return Membership{}, err
		}
		return membershipFromRow(updated), nil
	})
	return result, mapOperationError("change Team Membership role", err)
}

func (m *Module) RemoveMembership(ctx context.Context, input RemoveMembershipInput) error {
	slug, err := normalizeSlug(input.TeamSlug)
	targetUserID, userIDErr := databaseUUID(input.UserID)
	if err != nil || userIDErr != nil || !validateRequestID(input.RequestID) {
		return domainError(CodeInvalidRequest)
	}
	_, err = withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		queries := teamdb.New(tx)
		access, err := m.lockTeamAccess(ctx, queries, input.Principal, slug)
		if err != nil {
			return struct{}{}, err
		}
		target, targetErr := queries.GetMembershipForUpdate(ctx, teamdb.GetMembershipForUpdateParams{
			TeamID: access.teamID, UserID: targetUserID,
		})
		action := authorization.MembershipRemoveMember
		if targetErr == nil && target.Role == "owner" {
			action = authorization.MembershipRemoveOwner
		}
		if err := m.authorize(input.Principal, action,
			authorization.ResourceFacts{Kind: authorization.MembershipResource, TeamID: access.teamID},
			access.facts); err != nil {
			return struct{}{}, err
		}
		if errors.Is(targetErr, pgx.ErrNoRows) {
			return struct{}{}, domainError(CodeNotFound)
		}
		if targetErr != nil {
			return struct{}{}, targetErr
		}
		if target.Status == "removed" {
			return struct{}{}, nil
		}
		if target.Role == "owner" {
			otherOwners, err := queries.CountOtherActiveOwners(ctx, teamdb.CountOtherActiveOwnersParams{
				TeamID: access.teamID, UserID: targetUserID,
			})
			if err != nil {
				return struct{}{}, err
			}
			if otherOwners == 0 {
				return struct{}{}, domainError(CodeLastOwnerRequired)
			}
		}
		if _, err := queries.RemoveMembership(ctx, teamdb.RemoveMembershipParams{
			TeamID: access.teamID, UserID: targetUserID,
		}); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "team_membership.remove",
			targetKind: "team_membership", targetID: access.teamID + ":" + input.UserID,
			requestID: input.RequestID,
		})
	})
	return mapOperationError("remove Team Membership", err)
}

func (m *Module) LeaveTeam(ctx context.Context, input TeamActionInput) error {
	slug, err := normalizeSlug(input.TeamSlug)
	if err != nil || !validateRequestID(input.RequestID) {
		return domainError(CodeInvalidRequest)
	}
	_, err = withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		queries := teamdb.New(tx)
		access, err := m.lockTeamAccess(ctx, queries, input.Principal, slug)
		if err != nil {
			return struct{}{}, err
		}
		if err := m.authorize(input.Principal, authorization.MembershipLeaveSelf,
			authorization.ResourceFacts{Kind: authorization.MembershipResource, TeamID: access.teamID},
			access.facts); err != nil {
			return struct{}{}, err
		}
		if access.membership.Role == "owner" {
			otherOwners, err := queries.CountOtherActiveOwners(ctx, teamdb.CountOtherActiveOwnersParams{
				TeamID: access.teamID, UserID: access.membership.UserID,
			})
			if err != nil {
				return struct{}{}, err
			}
			if otherOwners == 0 {
				return struct{}{}, domainError(CodeLastOwnerRequired)
			}
		}
		if _, err := queries.RemoveMembership(ctx, teamdb.RemoveMembershipParams{
			TeamID: access.teamID, UserID: access.membership.UserID,
		}); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "team_membership.leave",
			targetKind: "team_membership",
			targetID:   access.teamID + ":" + input.Principal.UserID,
			requestID:  input.RequestID,
		})
	})
	return mapOperationError("leave Team", err)
}

func membershipFromRow(row teamdb.TeamMembership) Membership {
	return Membership{
		TeamID: row.TeamID, UserID: domainUUID(row.UserID), Role: MembershipRole(row.Role),
		Status: MembershipStatus(row.Status), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func membershipRoleAction(role MembershipRole) string {
	if role == OwnerRole {
		return "team_membership.promote_owner"
	}
	return "team_membership.demote_owner"
}
