// Package team owns Team, Team Membership, Team Join Code, and Project
// control-plane lifecycles behind use-case-shaped operations.
package team

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	teamdb "github.com/SingleMai/ATape/server/internal/team/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	joinCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	joinCodeLength   = 6
	joinCodePurpose  = "team-join-code"
)

var (
	slugPattern         = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	operationKeyPattern = regexp.MustCompile(`^(?:[A-Za-z0-9_-]{22,128}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`)
)

type Policy struct {
	JoinCodeAttemptWindow time.Duration
	MaximumCodeFailures   int
	OperationReceiptTTL   time.Duration
	ShortCodeAttempts     int
}

func DefaultPolicy() Policy {
	return Policy{
		JoinCodeAttemptWindow: 10 * time.Minute,
		MaximumCodeFailures:   10,
		OperationReceiptTTL:   24 * time.Hour,
		ShortCodeAttempts:     16,
	}
}

type Config struct {
	PepperKeys authentication.KeyRing
	Policy     Policy
}

type Module struct {
	pool       *pgxpool.Pool
	pepperKeys authentication.KeyRing
	policy     Policy
	random     io.Reader
	authorizer authorization.Policy
}

func New(pool *pgxpool.Pool, config Config) (*Module, error) {
	if pool == nil {
		return nil, errors.New("Team Module requires PostgreSQL")
	}
	policy := config.Policy
	if policy == (Policy{}) {
		policy = DefaultPolicy()
	}
	if _, err := durationSeconds(policy.JoinCodeAttemptWindow); err != nil {
		return nil, err
	}
	if _, err := durationSeconds(policy.OperationReceiptTTL); err != nil {
		return nil, err
	}
	if policy.MaximumCodeFailures < 1 || policy.ShortCodeAttempts < 1 {
		return nil, errors.New("Team Module policy counts must be positive")
	}
	if _, _, err := config.PepperKeys.ActiveShortCodeDigest(joinCodePurpose, "ABC123"); err != nil {
		return nil, errors.New("Team Module requires an active pepper key")
	}
	return &Module{
		pool: pool, pepperKeys: config.PepperKeys, policy: policy,
		random: rand.Reader, authorizer: authorization.Policy{},
	}, nil
}

func normalizeSlug(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) < 2 || len(value) > 63 || !slugPattern.MatchString(value) || !utf8.ValidString(value) {
		return "", domainError(CodeInvalidRequest)
	}
	return value, nil
}

func normalizeDisplayName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || len(value) < 1 || len(value) > 200 ||
		strings.ContainsAny(value, "\x00\r\n") {
		return "", domainError(CodeInvalidRequest)
	}
	return value, nil
}

func validateOperationKey(value string) bool {
	return operationKeyPattern.MatchString(value)
}

func validateRequestID(value string) bool {
	return utf8.ValidString(value) && len(value) <= 200 && !strings.ContainsAny(value, "\x00\r\n")
}

func (m *Module) lockPrincipalUser(
	ctx context.Context,
	queries *teamdb.Queries,
	principal authentication.Principal,
) (pgtype.UUID, error) {
	userID, err := databaseUUID(principal.UserID)
	if err != nil || (principal.Method != authentication.WebAuthentication &&
		principal.Method != authentication.CLIAuthentication) {
		return pgtype.UUID{}, domainError(CodeInvalidRequest)
	}
	user, err := queries.GetPrincipalUserForShare(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return pgtype.UUID{}, domainError(CodeNotFound)
	}
	if err != nil {
		return pgtype.UUID{}, err
	}
	if user.Status != "active" {
		return pgtype.UUID{}, domainError(CodeUserDisabled)
	}
	return userID, nil
}

func membershipFacts(row teamdb.TeamMembership) authorization.MembershipFacts {
	role := authorization.NoMembershipRole
	if row.Status == "active" {
		switch row.Role {
		case "owner":
			role = authorization.OwnerRole
		case "member":
			role = authorization.MemberRole
		}
	}
	return authorization.MembershipFacts{
		TeamID: row.TeamID, UserID: domainUUID(row.UserID), Role: role,
		Active: row.Status == "active",
	}
}

func (m *Module) authorize(
	principal authentication.Principal,
	action authorization.Action,
	resource authorization.ResourceFacts,
	membership authorization.MembershipFacts,
) error {
	outcome := m.authorizer.Evaluate(authorization.Input{
		Principal: principal, Action: action, Resource: resource, Membership: membership,
	})
	if outcome.Decision == authorization.Allow {
		return nil
	}
	switch outcome.Denial {
	case authorization.ResourceConcealed:
		return domainError(CodeNotFound)
	case authorization.CredentialCapabilityDenied:
		return domainError(CodeCredentialCapabilityDenied)
	case authorization.MembershipRoleDenied:
		return domainError(CodeMembershipRoleDenied)
	case authorization.FreshAuthenticationRequired:
		return domainError(CodeFreshAuthenticationRequired)
	default:
		return domainError(CodeMisconfigured)
	}
}

func mapOperationError(operation string, err error) error {
	if err == nil {
		return nil
	}
	var domain *Error
	if errors.As(err, &domain) {
		return err
	}
	var uncertain *uncertainCommitError
	if errors.As(err, &uncertain) {
		return &Error{Code: CodeOutcomeUnknown, cause: uncertain}
	}
	return unavailable(operation, err)
}
