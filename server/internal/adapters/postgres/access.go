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

type resourceAccess struct {
	projectID        string
	teamID           string
	projectName      string
	projectType      string
	projectState     string
	capturedByUserID string
	membership       authorization.MembershipFacts
}

func principalUUID(principal authentication.Principal) (pgtype.UUID, error) {
	return databaseUUID(principal.UserID)
}

func databaseUUID(value string) (pgtype.UUID, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return pgtype.UUID{}, err
	}
	return pgtype.UUID{Bytes: [16]byte(parsed), Valid: true}, nil
}

func domainUUID(value pgtype.UUID) string {
	if !value.Valid {
		return ""
	}
	return uuid.UUID(value.Bytes).String()
}

func membershipFacts(teamID string, userID pgtype.UUID, role, status string) authorization.MembershipFacts {
	result := authorization.MembershipFacts{
		TeamID: teamID, UserID: domainUUID(userID), Active: status == "active",
	}
	if result.Active {
		switch role {
		case "owner":
			result.Role = authorization.OwnerRole
		case "member":
			result.Role = authorization.MemberRole
		}
	}
	return result
}

func enforceAccess(
	principal authentication.Principal,
	action authorization.Action,
	resource authorization.ResourceFacts,
	membership authorization.MembershipFacts,
) error {
	return authorization.Enforce((authorization.Policy{}).Evaluate(authorization.Input{
		Principal: principal, Action: action, Resource: resource, Membership: membership,
	}))
}

func concealedAccess(principal authentication.Principal, action authorization.Action, kind authorization.ResourceKind) error {
	return enforceAccess(principal, action, authorization.ResourceFacts{Kind: kind}, authorization.MembershipFacts{})
}

func isConcealedAccess(err error) bool {
	var access *authorization.AccessError
	return errors.As(err, &access) && access.Decision == authorization.Conceal
}

func resolveProjectAccess(
	ctx context.Context,
	queries *db.Queries,
	principal authentication.Principal,
	projectID string,
	action authorization.Action,
	lockForIngest bool,
) (resourceAccess, error) {
	userID, err := principalUUID(principal)
	if err != nil {
		return resourceAccess{}, concealedAccess(principal, action, authorization.ProjectResource)
	}
	var access resourceAccess
	if lockForIngest {
		row, queryErr := queries.ResolveProjectAccessForIngest(ctx, db.ResolveProjectAccessForIngestParams{
			UserID: userID, ProjectID: projectID,
		})
		if errors.Is(queryErr, pgx.ErrNoRows) {
			return resourceAccess{}, concealedAccess(principal, action, authorization.ProjectResource)
		}
		if queryErr != nil {
			return resourceAccess{}, queryErr
		}
		access = resourceAccess{
			projectID: row.ID, teamID: row.TeamID, projectName: row.Name,
			projectType: row.ProjectType, projectState: row.State,
			membership: membershipFacts(row.TeamID, row.UserID, row.Role, row.Status),
		}
	} else {
		row, queryErr := queries.ResolveProjectAccess(ctx, db.ResolveProjectAccessParams{
			UserID: userID, ProjectID: projectID,
		})
		if errors.Is(queryErr, pgx.ErrNoRows) {
			return resourceAccess{}, concealedAccess(principal, action, authorization.ProjectResource)
		}
		if queryErr != nil {
			return resourceAccess{}, queryErr
		}
		access = resourceAccess{
			projectID: row.ID, teamID: row.TeamID, projectName: row.Name,
			projectType: row.ProjectType, projectState: row.State,
			membership: membershipFacts(row.TeamID, row.UserID, row.Role, row.Status),
		}
	}
	err = enforceAccess(principal, action, authorization.ResourceFacts{
		Kind: authorization.ProjectResource, TeamID: access.teamID,
	}, access.membership)
	return access, err
}

func resolveSessionAccess(
	ctx context.Context,
	queries *db.Queries,
	principal authentication.Principal,
	sessionID string,
	action authorization.Action,
	forShare bool,
) (resourceAccess, error) {
	userID, err := principalUUID(principal)
	if err != nil {
		return resourceAccess{}, concealedAccess(principal, action, authorization.ConversationResource)
	}
	var access resourceAccess
	if forShare {
		row, queryErr := queries.ResolveSessionAccessForShare(ctx, db.ResolveSessionAccessForShareParams{
			UserID: userID, SessionID: sessionID,
		})
		if errors.Is(queryErr, pgx.ErrNoRows) {
			return resourceAccess{}, concealedAccess(principal, action, authorization.ConversationResource)
		}
		if queryErr != nil {
			return resourceAccess{}, queryErr
		}
		access = resourceAccess{
			projectID: row.ProjectID, teamID: row.TeamID, projectState: row.State,
			capturedByUserID: domainUUID(row.CapturedByUserID),
			membership:       membershipFacts(row.TeamID, row.UserID, row.Role, row.Status),
		}
	} else {
		row, queryErr := queries.ResolveSessionAccess(ctx, db.ResolveSessionAccessParams{
			UserID: userID, SessionID: sessionID,
		})
		if errors.Is(queryErr, pgx.ErrNoRows) {
			return resourceAccess{}, concealedAccess(principal, action, authorization.ConversationResource)
		}
		if queryErr != nil {
			return resourceAccess{}, queryErr
		}
		access = resourceAccess{
			projectID: row.ProjectID, teamID: row.TeamID, projectState: row.State,
			capturedByUserID: domainUUID(row.CapturedByUserID),
			membership:       membershipFacts(row.TeamID, row.UserID, row.Role, row.Status),
		}
	}
	err = enforceAccess(principal, action, authorization.ResourceFacts{
		Kind: authorization.ConversationResource, TeamID: access.teamID,
		CapturedByUserID: access.capturedByUserID,
	}, access.membership)
	return access, err
}

func resolveRawObjectAccess(
	ctx context.Context,
	queries *db.Queries,
	principal authentication.Principal,
	objectID string,
) (resourceAccess, error) {
	userID, err := principalUUID(principal)
	if err != nil {
		return resourceAccess{}, concealedAccess(principal, authorization.RawObjectRead, authorization.RawObjectResource)
	}
	row, err := queries.ResolveRawObjectAccess(ctx, db.ResolveRawObjectAccessParams{
		UserID: userID, ObjectID: objectID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return resourceAccess{}, concealedAccess(principal, authorization.RawObjectRead, authorization.RawObjectResource)
	}
	if err != nil {
		return resourceAccess{}, err
	}
	access := resourceAccess{
		projectID: row.ProjectID, teamID: row.TeamID, projectState: row.State,
		capturedByUserID: domainUUID(row.CapturedByUserID),
		membership:       membershipFacts(row.TeamID, row.UserID, row.Role, row.Status),
	}
	err = enforceAccess(principal, authorization.RawObjectRead, authorization.ResourceFacts{
		Kind: authorization.RawObjectResource, TeamID: row.TeamID,
		CapturedByUserID: access.capturedByUserID,
	}, access.membership)
	return access, err
}
