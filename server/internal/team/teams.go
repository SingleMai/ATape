package team

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"strings"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	teamdb "github.com/SingleMai/ATape/server/internal/team/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (m *Module) CreateTeam(ctx context.Context, input CreateTeamInput) (TeamView, error) {
	if err := ctx.Err(); err != nil {
		return TeamView{}, err
	}
	slug, err := normalizeSlug(input.Slug)
	if err != nil {
		return TeamView{}, err
	}
	displayName, err := normalizeDisplayName(input.DisplayName)
	if err != nil || !validateOperationKey(input.OperationKey) || !validateRequestID(input.RequestID) {
		return TeamView{}, domainError(CodeInvalidRequest)
	}
	requestDigest := sha256.Sum256([]byte("atape/team.create/v1\x00" + slug + "\x00" + displayName))
	view, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (TeamView, error) {
		queries := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, queries, input.Principal)
		if err != nil {
			return TeamView{}, err
		}
		if err := m.authorize(input.Principal, authorization.TeamCreate,
			authorization.ResourceFacts{Kind: authorization.InstanceResource},
			authorization.MembershipFacts{}); err != nil {
			return TeamView{}, err
		}
		lockKey := "team-operation:" + input.Principal.UserID + ":team.create:" + input.OperationKey
		if err := queries.AcquireTeamAdvisoryLock(ctx, lockKey); err != nil {
			return TeamView{}, err
		}
		receipt, receiptErr := queries.GetOperationReceiptForUpdate(ctx, teamdb.GetOperationReceiptForUpdateParams{
			UserID: userID, Action: "team.create", OperationKey: input.OperationKey,
		})
		if receiptErr == nil {
			if !hmac.Equal(receipt.RequestDigest, requestDigest[:]) {
				return TeamView{}, domainError(CodeIdempotencyConflict)
			}
			teamRow, err := queries.GetTeamByID(ctx, receipt.ResourceID)
			if err != nil {
				return TeamView{}, err
			}
			membership, err := queries.GetMembership(ctx, teamdb.GetMembershipParams{
				TeamID: teamRow.ID, UserID: userID,
			})
			if err != nil {
				return TeamView{}, err
			}
			if err := m.authorize(input.Principal, authorization.TeamReadMetadata,
				authorization.ResourceFacts{Kind: authorization.TeamResource, TeamID: teamRow.ID},
				membershipFacts(membership)); err != nil {
				return TeamView{}, err
			}
			return teamView(teamRow.ID, teamRow.Slug, teamRow.Name, teamRow.CreatedAt,
				teamRow.UpdatedAt, membership), nil
		}
		if !errors.Is(receiptErr, pgx.ErrNoRows) {
			return TeamView{}, receiptErr
		}
		id, err := newID()
		if err != nil {
			return TeamView{}, err
		}
		teamRow, err := queries.InsertTeam(ctx, teamdb.InsertTeamParams{ID: id, Slug: &slug, Name: displayName})
		if err != nil {
			if uniqueViolation(err) {
				return TeamView{}, domainError(CodeResourceStateConflict)
			}
			return TeamView{}, err
		}
		membership, err := queries.InsertOwnerMembership(ctx, teamdb.InsertOwnerMembershipParams{
			TeamID: id, UserID: userID,
		})
		if err != nil {
			return TeamView{}, err
		}
		ttl, _ := durationSeconds(m.policy.OperationReceiptTTL)
		if err := queries.InsertOperationReceipt(ctx, teamdb.InsertOperationReceiptParams{
			UserID: userID, Action: "team.create", OperationKey: input.OperationKey,
			RequestDigest: requestDigest[:], ResourceID: id, TtlSeconds: ttl,
		}); err != nil {
			return TeamView{}, err
		}
		if err := appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "team.create", targetKind: "team",
			targetID: id, reason: "initial_owner", requestID: input.RequestID,
		}); err != nil {
			return TeamView{}, err
		}
		return teamView(teamRow.ID, teamRow.Slug, teamRow.Name, teamRow.CreatedAt,
			teamRow.UpdatedAt, membership), nil
	})
	return view, mapOperationError("create Team", err)
}

// OpenTeam returns Team metadata only after current Membership authorization.
func (m *Module) OpenTeam(ctx context.Context, principal authentication.Principal, slug string) (TeamView, error) {
	if err := ctx.Err(); err != nil {
		return TeamView{}, err
	}
	normalized, err := normalizeSlug(slug)
	if err != nil {
		return TeamView{}, domainError(CodeNotFound)
	}
	view, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (TeamView, error) {
		queries := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, queries, principal)
		if err != nil {
			return TeamView{}, err
		}
		row, err := queries.GetTeamBySlug(ctx, &normalized)
		if errors.Is(err, pgx.ErrNoRows) {
			return TeamView{}, domainError(CodeNotFound)
		}
		if err != nil {
			return TeamView{}, err
		}
		membership, membershipErr := queries.GetMembership(ctx, teamdb.GetMembershipParams{
			TeamID: row.ID, UserID: userID,
		})
		facts := authorization.MembershipFacts{}
		if membershipErr == nil {
			facts = membershipFacts(membership)
		} else if !errors.Is(membershipErr, pgx.ErrNoRows) {
			return TeamView{}, membershipErr
		}
		if err := m.authorize(principal, authorization.TeamReadMetadata,
			authorization.ResourceFacts{Kind: authorization.TeamResource, TeamID: row.ID}, facts); err != nil {
			return TeamView{}, err
		}
		return teamView(row.ID, row.Slug, row.Name, row.CreatedAt, row.UpdatedAt, membership), nil
	})
	return view, mapOperationError("open Team", err)
}

func (m *Module) OpenWorkspace(ctx context.Context, principal authentication.Principal) (Workspace, error) {
	if err := ctx.Err(); err != nil {
		return Workspace{}, err
	}
	workspace, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (Workspace, error) {
		queries := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, queries, principal)
		if err != nil {
			return Workspace{}, err
		}
		if err := m.authorize(principal, authorization.WorkspaceListVisible,
			authorization.ResourceFacts{Kind: authorization.InstanceResource},
			authorization.MembershipFacts{}); err != nil {
			return Workspace{}, err
		}
		teamRows, err := queries.ListVisibleTeams(ctx, userID)
		if err != nil {
			return Workspace{}, err
		}
		projectRows, err := queries.ListVisibleProjects(ctx, userID)
		if err != nil {
			return Workspace{}, err
		}
		result := Workspace{
			Teams: make([]TeamView, 0, len(teamRows)), Projects: make([]Project, 0, len(projectRows)),
		}
		for _, row := range teamRows {
			if row.Slug == nil {
				return Workspace{}, domainError(CodeMisconfigured)
			}
			result.Teams = append(result.Teams, TeamView{
				Team: Team{ID: row.ID, Slug: *row.Slug, DisplayName: row.Name,
					CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt},
				Membership: Membership{TeamID: row.ID, UserID: principal.UserID,
					Role: MembershipRole(row.Role), Status: ActiveMembership,
					CreatedAt: row.MembershipCreatedAt, UpdatedAt: row.MembershipUpdatedAt},
			})
		}
		for _, row := range projectRows {
			result.Projects = append(result.Projects, projectFromFields(
				row.ID, row.TeamID, row.Name, row.ProjectType, row.State,
				row.RemoteIdentity, row.CapturedThrough, row.CreatedAt, row.UpdatedAt,
			))
		}
		return result, nil
	})
	return workspace, mapOperationError("open Workspace", err)
}

func (m *Module) UpdateTeam(ctx context.Context, input UpdateTeamInput) (TeamView, error) {
	displayName, err := normalizeDisplayName(input.DisplayName)
	if err != nil || !validateRequestID(input.RequestID) {
		return TeamView{}, domainError(CodeInvalidRequest)
	}
	slug, err := normalizeSlug(input.TeamSlug)
	if err != nil {
		return TeamView{}, domainError(CodeNotFound)
	}
	view, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (TeamView, error) {
		queries := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, queries, input.Principal)
		if err != nil {
			return TeamView{}, err
		}
		row, err := queries.GetTeamBySlugForUpdate(ctx, &slug)
		if errors.Is(err, pgx.ErrNoRows) {
			return TeamView{}, domainError(CodeNotFound)
		}
		if err != nil {
			return TeamView{}, err
		}
		membership, membershipErr := queries.GetMembershipForUpdate(ctx, teamdb.GetMembershipForUpdateParams{
			TeamID: row.ID, UserID: userID,
		})
		facts := authorization.MembershipFacts{}
		if membershipErr == nil {
			facts = membershipFacts(membership)
		} else if !errors.Is(membershipErr, pgx.ErrNoRows) {
			return TeamView{}, membershipErr
		}
		if err := m.authorize(input.Principal, authorization.TeamUpdateDisplayProfile,
			authorization.ResourceFacts{Kind: authorization.TeamResource, TeamID: row.ID}, facts); err != nil {
			return TeamView{}, err
		}
		updated, err := queries.UpdateTeamDisplayName(ctx, teamdb.UpdateTeamDisplayNameParams{
			ID: row.ID, Name: displayName,
		})
		if err != nil {
			return TeamView{}, err
		}
		if err := appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "team.update_display_profile", targetKind: "team",
			targetID: row.ID, requestID: input.RequestID,
		}); err != nil {
			return TeamView{}, err
		}
		return teamView(updated.ID, updated.Slug, updated.Name, updated.CreatedAt,
			updated.UpdatedAt, membership), nil
	})
	return view, mapOperationError("update Team", err)
}

func (m *Module) ListMembers(ctx context.Context, input TeamActionInput) ([]MemberView, error) {
	slug, err := normalizeSlug(input.TeamSlug)
	if err != nil {
		return nil, domainError(CodeNotFound)
	}
	views, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) ([]MemberView, error) {
		queries := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, queries, input.Principal)
		if err != nil {
			return nil, err
		}
		row, err := queries.GetTeamBySlug(ctx, &slug)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domainError(CodeNotFound)
		}
		if err != nil {
			return nil, err
		}
		membership, membershipErr := queries.GetMembership(ctx, teamdb.GetMembershipParams{
			TeamID: row.ID, UserID: userID,
		})
		facts := authorization.MembershipFacts{}
		if membershipErr == nil {
			facts = membershipFacts(membership)
		} else if !errors.Is(membershipErr, pgx.ErrNoRows) {
			return nil, membershipErr
		}
		if err := m.authorize(input.Principal, authorization.MembershipList,
			authorization.ResourceFacts{Kind: authorization.TeamResource, TeamID: row.ID}, facts); err != nil {
			return nil, err
		}
		rows, err := queries.ListTeamMembers(ctx, row.ID)
		if err != nil {
			return nil, err
		}
		result := make([]MemberView, 0, len(rows))
		for _, member := range rows {
			result = append(result, MemberView{
				UserID: domainUUID(member.UserID), DisplayName: member.DisplayName,
				AvatarURL: member.AvatarUrl, Role: MembershipRole(member.Role),
				JoinedAt: member.CreatedAt, UpdatedAt: member.UpdatedAt,
			})
		}
		return result, nil
	})
	return views, mapOperationError("list Team Memberships", err)
}

func teamView(
	id string,
	slug *string,
	name string,
	createdAt time.Time,
	updatedAt time.Time,
	membership teamdb.TeamMembership,
) TeamView {
	normalizedSlug := ""
	if slug != nil {
		normalizedSlug = *slug
	}
	return TeamView{
		Team: Team{ID: id, Slug: normalizedSlug, DisplayName: name, CreatedAt: createdAt, UpdatedAt: updatedAt},
		Membership: Membership{
			TeamID: membership.TeamID, UserID: domainUUID(membership.UserID),
			Role: MembershipRole(membership.Role), Status: MembershipStatus(membership.Status),
			CreatedAt: membership.CreatedAt, UpdatedAt: membership.UpdatedAt,
		},
	}
}

func uniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

// Kept local to make request digests unambiguous without JSON map ordering.
func digestFields(domain string, fields ...string) [sha256.Size]byte {
	var builder strings.Builder
	builder.WriteString("atape/")
	builder.WriteString(domain)
	builder.WriteString("/v1\x00")
	for _, field := range fields {
		builder.WriteString(field)
		builder.WriteByte(0)
	}
	return sha256.Sum256([]byte(builder.String()))
}
