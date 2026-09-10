package team

import (
	"context"
	"errors"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	teamdb "github.com/SingleMai/ATape/server/internal/team/internal/db"
	"github.com/jackc/pgx/v5"
)

type RawCaptureSettings struct {
	TeamPolicy     string                `json:"teamPolicy"`
	UserPreference string                `json:"userPreference"`
	Enabled        bool                  `json:"enabled"`
	Authority      *rawarchive.Authority `json:"authority,omitempty"`
}

type RawCapturePreference struct {
	Preference string `json:"preference"`
}

func (m *Module) RawCaptureForProject(ctx context.Context, principal authentication.Principal, projectID string) (RawCaptureSettings, error) {
	project, err := m.OpenProject(ctx, principal, projectID)
	if err != nil {
		return RawCaptureSettings{}, err
	}
	return m.rawCaptureForTeamID(ctx, principal, project.TeamID)
}

func (m *Module) RawCaptureForTeam(ctx context.Context, principal authentication.Principal, slug string) (RawCaptureSettings, error) {
	view, err := m.OpenTeam(ctx, principal, slug)
	if err != nil {
		return RawCaptureSettings{}, err
	}
	return m.rawCaptureForTeamID(ctx, principal, view.Team.ID)
}

func (m *Module) rawCaptureForTeamID(ctx context.Context, principal authentication.Principal, teamID string) (RawCaptureSettings, error) {
	result, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (RawCaptureSettings, error) {
		q := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, q, principal)
		if err != nil {
			return RawCaptureSettings{}, err
		}
		row, err := q.GetRawCaptureSettings(ctx, teamdb.GetRawCaptureSettingsParams{ID: teamID, ID_2: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return RawCaptureSettings{}, domainError(CodeNotFound)
		}
		if err != nil {
			return RawCaptureSettings{}, err
		}
		return rawCaptureSettings(row), nil
	})
	return result, mapOperationError("read Raw capture policy", err)
}

func (m *Module) SetTeamRawCapture(ctx context.Context, principal authentication.Principal, slug, policy, requestID string) (RawCaptureSettings, error) {
	if policy != "force" && policy != "personal" && policy != "close" || !validateRequestID(requestID) {
		return RawCaptureSettings{}, domainError(CodeInvalidRequest)
	}
	normalized, err := normalizeSlug(slug)
	if err != nil {
		return RawCaptureSettings{}, domainError(CodeNotFound)
	}
	result, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (RawCaptureSettings, error) {
		q := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, q, principal)
		if err != nil {
			return RawCaptureSettings{}, err
		}
		row, err := q.GetTeamBySlugForUpdate(ctx, &normalized)
		if errors.Is(err, pgx.ErrNoRows) {
			return RawCaptureSettings{}, domainError(CodeNotFound)
		}
		if err != nil {
			return RawCaptureSettings{}, err
		}
		member, err := q.GetRawCaptureMembershipForShare(ctx, teamdb.GetRawCaptureMembershipForShareParams{TeamID: row.ID, UserID: userID})
		facts := authorization.MembershipFacts{}
		if err == nil {
			facts = membershipFacts(member)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return RawCaptureSettings{}, err
		}
		if err = m.authorize(principal, authorization.TeamUpdateRawCapture, authorization.ResourceFacts{Kind: authorization.TeamResource, TeamID: row.ID}, facts); err != nil {
			return RawCaptureSettings{}, err
		}
		if err = q.SetTeamRawCapturePolicy(ctx, teamdb.SetTeamRawCapturePolicyParams{ID: row.ID, RawCapturePolicy: policy}); err != nil {
			return RawCaptureSettings{}, err
		}
		settings, err := q.GetRawCaptureSettings(ctx, teamdb.GetRawCaptureSettingsParams{ID: row.ID, ID_2: userID})
		if err != nil {
			return RawCaptureSettings{}, err
		}
		if err = appendAudit(ctx, q, auditRecord{principal: principal, action: "team.update_raw_capture", targetKind: "team", targetID: row.ID, reason: policy, requestID: requestID}); err != nil {
			return RawCaptureSettings{}, err
		}
		return rawCaptureSettings(settings), nil
	})
	return result, mapOperationError("update Team Raw capture policy", err)
}

func rawCaptureSettings(row teamdb.GetRawCaptureSettingsRow) RawCaptureSettings {
	authority := rawarchive.CaptureAuthority(row.RawCapturePolicy, row.TeamRevision, row.UserRevision)
	return RawCaptureSettings{TeamPolicy: row.RawCapturePolicy, UserPreference: row.RawCapturePreference,
		Enabled: rawarchive.CaptureEnabled(row.RawCapturePolicy, row.RawCapturePreference), Authority: &authority}
}

func (m *Module) UserRawCapture(ctx context.Context, principal authentication.Principal) (RawCapturePreference, error) {
	return m.userRawCapture(ctx, principal, "", "")
}

func (m *Module) SetUserRawCapture(ctx context.Context, principal authentication.Principal, preference, requestID string) (RawCapturePreference, error) {
	if preference != "enable" && preference != "disable" || !validateRequestID(requestID) {
		return RawCapturePreference{}, domainError(CodeInvalidRequest)
	}
	return m.userRawCapture(ctx, principal, preference, requestID)
}

func (m *Module) userRawCapture(ctx context.Context, principal authentication.Principal, preference, requestID string) (RawCapturePreference, error) {
	result, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (RawCapturePreference, error) {
		q := teamdb.New(tx)
		// A preference write locks the User directly, avoiding a SHARE-to-UPDATE
		// upgrade deadlock between concurrent preference changes.
		if preference != "" {
			id, err := databaseUUID(principal.UserID)
			if err != nil {
				return RawCapturePreference{}, domainError(CodeInvalidRequest)
			}
			if err = q.LockRawCaptureUserForUpdate(ctx, id); err != nil {
				return RawCapturePreference{}, err
			}
		}
		userID, err := m.lockPrincipalUser(ctx, q, principal)
		if err != nil {
			return RawCapturePreference{}, err
		}
		action := authorization.UserReadSelf
		if preference != "" {
			action = authorization.UserUpdateRawCapture
		}
		if err = m.authorize(principal, action, authorization.ResourceFacts{Kind: authorization.UserResource, OwnerUserID: principal.UserID}, authorization.MembershipFacts{}); err != nil {
			return RawCapturePreference{}, err
		}
		if preference != "" {
			if err = q.SetUserRawCapturePreference(ctx, teamdb.SetUserRawCapturePreferenceParams{ID: userID, RawCapturePreference: preference}); err != nil {
				return RawCapturePreference{}, err
			}
			if err = appendAudit(ctx, q, auditRecord{principal: principal, action: "user.update_raw_capture", targetKind: "user", targetID: principal.UserID, reason: preference, requestID: requestID}); err != nil {
				return RawCapturePreference{}, err
			}
		}
		value, err := q.GetUserRawCapturePreference(ctx, userID)
		return RawCapturePreference{Preference: value}, err
	})
	return result, mapOperationError("User Raw capture preference", err)
}
