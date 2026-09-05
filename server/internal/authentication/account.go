package authentication

import (
	"context"
	"errors"
	"sort"
	"strings"
	"unicode/utf8"

	authdb "github.com/SingleMai/ATape/server/internal/authentication/internal/db"
	"github.com/jackc/pgx/v5"
)

// EnabledProviderRegistrations returns only public login-entry metadata in a
// stable order. Provider mechanics and configuration stay behind the Seam.
func (m *Module) EnabledProviderRegistrations() []ProviderRegistrationView {
	views := make([]ProviderRegistrationView, 0, len(m.active))
	for _, registration := range m.active {
		label := registration.Label
		if label == "" {
			label = registration.ID
		}
		views = append(views, ProviderRegistrationView{ID: registration.ID, Label: label})
	}
	sort.Slice(views, func(left, right int) bool { return views[left].ID < views[right].ID })
	return views
}

func (m *Module) UpdateUserProfile(ctx context.Context, input UpdateUserProfileInput) (User, error) {
	displayName := strings.TrimSpace(input.DisplayName)
	if !utf8.ValidString(displayName) || len(displayName) < 1 || len(displayName) > 200 ||
		strings.ContainsAny(displayName, "\x00\r\n") || !validateRequestID(input.RequestID) {
		return User{}, domainError(CodeInvalidRequest)
	}
	user, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (User, error) {
		queries := authdb.New(tx)
		principal, _, err := m.validateWebPrincipalInTransaction(ctx, queries, input.Principal)
		if err != nil {
			return User{}, err
		}
		row, err := queries.UpdateActiveUserProfile(ctx, authdb.UpdateActiveUserProfileParams{
			ID: principal.UserID, DisplayName: displayName,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return User{}, domainError(CodeUserDisabled)
		}
		if err != nil {
			return User{}, err
		}
		if err := appendAudit(ctx, queries, auditRecord{
			initiatorKind: "principal", initiatorID: input.Principal.UserID,
			action: "user.profile.update", targetKind: "user", targetID: input.Principal.UserID,
			outcome: "succeeded", requestID: input.RequestID,
			webSessionID: input.Principal.WebSessionID,
		}); err != nil {
			return User{}, err
		}
		return User{
			ID: input.Principal.UserID, DisplayName: row.DisplayName,
			AvatarURL: row.AvatarUrl, CreatedAt: row.CreatedAt,
		}, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return User{}, err
		}
		return User{}, unavailable("update User profile", err)
	}
	return user, nil
}

func (m *Module) ListExternalIdentities(ctx context.Context, principal Principal) ([]ExternalIdentityView, error) {
	views, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) ([]ExternalIdentityView, error) {
		queries := authdb.New(tx)
		validated, _, err := m.validateWebPrincipalInTransaction(ctx, queries, principal)
		if err != nil {
			return nil, err
		}
		rows, err := queries.ListActiveExternalIdentitiesForUser(ctx, validated.UserID)
		if err != nil {
			return nil, err
		}
		result := make([]ExternalIdentityView, 0, len(rows))
		for _, row := range rows {
			registrationID := m.registrationIDForIssuer(row.Issuer)
			if registrationID == "" {
				return nil, domainError(CodeMisconfigured)
			}
			result = append(result, ExternalIdentityView{
				ID: domainUUID(row.ID), ProviderRegistrationID: registrationID,
				DisplayName: row.DisplayName, AvatarURL: row.AvatarUrl,
				CreatedAt: row.CreatedAt, LastVerifiedAt: row.LastVerifiedAt,
			})
		}
		return result, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return nil, err
		}
		return nil, unavailable("list External Identities", err)
	}
	return views, nil
}

func (m *Module) registrationIDForIssuer(issuer string) string {
	var found string
	for _, registration := range m.registrations {
		if registration.ExpectedIssuer != issuer {
			continue
		}
		if found != "" && found != registration.ID {
			return ""
		}
		found = registration.ID
	}
	return found
}
