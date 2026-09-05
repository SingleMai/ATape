package team

import (
	"context"
	"crypto/hmac"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	teamdb "github.com/SingleMai/ATape/server/internal/team/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func (m *Module) ReadJoinCodeStatus(ctx context.Context, input TeamActionInput) (JoinCodeStatus, error) {
	slug, err := normalizeSlug(input.TeamSlug)
	if err != nil {
		return JoinCodeStatus{}, domainError(CodeNotFound)
	}
	status, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (JoinCodeStatus, error) {
		queries := teamdb.New(tx)
		access, err := m.lockTeamAccess(ctx, queries, input.Principal, slug)
		if err != nil {
			return JoinCodeStatus{}, err
		}
		if err := m.authorize(input.Principal, authorization.TeamJoinCodeReadStatus,
			authorization.ResourceFacts{Kind: authorization.TeamJoinCodeResource, TeamID: access.teamID},
			access.facts); err != nil {
			return JoinCodeStatus{}, err
		}
		row, err := queries.LatestJoinCodeForTeam(ctx, access.teamID)
		if errors.Is(err, pgx.ErrNoRows) {
			return JoinCodeStatus{}, nil
		}
		if err != nil {
			return JoinCodeStatus{}, err
		}
		return statusFromJoinCode(row.Generation, row.Status, row.CreatedAt, row.RetiredAt, row.DisabledAt), nil
	})
	return status, mapOperationError("read Team Join Code status", err)
}

func (m *Module) RotateJoinCode(ctx context.Context, input TeamActionInput) (JoinCodeGrant, error) {
	slug, err := normalizeSlug(input.TeamSlug)
	if err != nil || !validateRequestID(input.RequestID) {
		return JoinCodeGrant{}, domainError(CodeInvalidRequest)
	}
	grant, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (JoinCodeGrant, error) {
		queries := teamdb.New(tx)
		access, err := m.lockTeamAccess(ctx, queries, input.Principal, slug)
		if err != nil {
			return JoinCodeGrant{}, err
		}
		if err := m.authorize(input.Principal, authorization.TeamJoinCodeRotate,
			authorization.ResourceFacts{Kind: authorization.TeamJoinCodeResource, TeamID: access.teamID},
			access.facts); err != nil {
			return JoinCodeGrant{}, err
		}
		if err := queries.AcquireTeamAdvisoryLock(ctx, "team-join-code-generation"); err != nil {
			return JoinCodeGrant{}, err
		}
		latestGeneration := int32(0)
		latest, latestErr := queries.LatestJoinCodeForTeam(ctx, access.teamID)
		if latestErr == nil {
			latestGeneration = latest.Generation
		} else if !errors.Is(latestErr, pgx.ErrNoRows) {
			return JoinCodeGrant{}, latestErr
		}
		code, keyID, digest, err := m.unusedJoinCode(ctx, queries)
		if err != nil {
			return JoinCodeGrant{}, err
		}
		if _, err := queries.RetireCurrentJoinCode(ctx, access.teamID); err != nil {
			return JoinCodeGrant{}, err
		}
		id, err := newID()
		if err != nil {
			return JoinCodeGrant{}, err
		}
		created, err := queries.InsertJoinCode(ctx, teamdb.InsertJoinCodeParams{
			ID: idToDatabase(id), TeamID: access.teamID, Generation: latestGeneration + 1,
			PepperKeyID: keyID, CodeDigest: digest[:],
		})
		if err != nil {
			return JoinCodeGrant{}, err
		}
		if err := appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "team_join_code.rotate",
			targetKind: "team", targetID: access.teamID, requestID: input.RequestID,
		}); err != nil {
			return JoinCodeGrant{}, err
		}
		return JoinCodeGrant{
			Code: code, RotatedAt: created.CreatedAt,
			Status: JoinCodeStatus{Enabled: true, Generation: int(created.Generation), UpdatedAt: created.CreatedAt},
		}, nil
	})
	return grant, mapOperationError("rotate Team Join Code", err)
}

func (m *Module) DisableJoinCode(ctx context.Context, input TeamActionInput) error {
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
		if err := m.authorize(input.Principal, authorization.TeamJoinCodeDisable,
			authorization.ResourceFacts{Kind: authorization.TeamJoinCodeResource, TeamID: access.teamID},
			access.facts); err != nil {
			return struct{}{}, err
		}
		affected, err := queries.DisableCurrentJoinCode(ctx, access.teamID)
		if err != nil {
			return struct{}{}, err
		}
		if affected == 0 {
			return struct{}{}, nil
		}
		return struct{}{}, appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "team_join_code.disable",
			targetKind: "team", targetID: access.teamID, requestID: input.RequestID,
		})
	})
	return mapOperationError("disable Team Join Code", err)
}

func (m *Module) JoinTeam(ctx context.Context, input JoinTeamInput) (TeamView, error) {
	if err := ctx.Err(); err != nil {
		return TeamView{}, err
	}
	if !validateRequestID(input.RequestID) {
		return TeamView{}, domainError(CodeInvalidRequest)
	}
	view, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (TeamView, error) {
		queries := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, queries, input.Principal)
		if err != nil {
			return TeamView{}, err
		}
		if err := m.authorize(input.Principal, authorization.TeamJoinWithCode,
			authorization.ResourceFacts{Kind: authorization.InstanceResource},
			authorization.MembershipFacts{}); err != nil {
			return TeamView{}, err
		}
		now, err := queries.DatabaseTime(ctx)
		if err != nil {
			return TeamView{}, err
		}
		windowStart := now.Truncate(m.policy.JoinCodeAttemptWindow)
		windowEnd := windowStart.Add(m.policy.JoinCodeAttemptWindow)
		window, windowErr := queries.GetJoinCodeAttemptWindowForUpdate(ctx, teamdb.GetJoinCodeAttemptWindowForUpdateParams{
			UserID: userID, WindowStart: windowStart,
		})
		if windowErr == nil && (window.FailureCount >= int32(m.policy.MaximumCodeFailures) ||
			(window.BlockedUntil.Valid && now.Before(window.BlockedUntil.Time))) {
			return TeamView{}, retryError(CodeTooManyJoinCodeAttempts, positiveCeilingSeconds(windowEnd.Sub(now)))
		}
		if windowErr != nil && !errors.Is(windowErr, pgx.ErrNoRows) {
			return TeamView{}, windowErr
		}
		normalized, valid := normalizeJoinCode(input.JoinCode)
		matches := make([]teamdb.FindEnabledJoinCodeRow, 0, 1)
		if valid {
			for _, keyID := range m.pepperKeys.KeyIDs() {
				digest, found, err := m.pepperKeys.ShortCodeDigest(keyID, joinCodePurpose, normalized)
				if err != nil || !found {
					return TeamView{}, domainError(CodeMisconfigured)
				}
				match, err := queries.FindEnabledJoinCode(ctx, teamdb.FindEnabledJoinCodeParams{
					PepperKeyID: keyID, CodeDigest: digest[:],
				})
				if err == nil {
					matches = append(matches, match)
				} else if !errors.Is(err, pgx.ErrNoRows) {
					return TeamView{}, err
				}
			}
		}
		if len(matches) != 1 {
			if len(matches) > 1 {
				return TeamView{}, domainError(CodeMisconfigured)
			}
			return TeamView{}, m.recordJoinCodeFailure(ctx, queries, input.Principal,
				userID, now, windowStart, windowEnd, input.RequestID)
		}
		match := matches[0]
		teamRow, err := queries.GetTeamByIDForUpdate(ctx, match.TeamID)
		if err != nil {
			return TeamView{}, err
		}
		lockedCode, err := queries.GetJoinCodeByIDForUpdate(ctx, match.ID)
		if err != nil || lockedCode.Status != "enabled" ||
			!hmac.Equal(lockedCode.CodeDigest, match.CodeDigest) {
			if errors.Is(err, pgx.ErrNoRows) || err == nil {
				return TeamView{}, m.recordJoinCodeFailure(ctx, queries, input.Principal,
					userID, now, windowStart, windowEnd, input.RequestID)
			}
			return TeamView{}, err
		}
		membership, membershipErr := queries.GetMembershipForUpdate(ctx, teamdb.GetMembershipForUpdateParams{
			TeamID: match.TeamID, UserID: userID,
		})
		changed := false
		switch {
		case errors.Is(membershipErr, pgx.ErrNoRows):
			membership, err = queries.InsertMemberMembership(ctx, teamdb.InsertMemberMembershipParams{
				TeamID: match.TeamID, UserID: userID,
			})
			changed = true
		case membershipErr != nil:
			return TeamView{}, membershipErr
		case membership.Status == "removed":
			membership, err = queries.ReactivateMemberMembership(ctx, teamdb.ReactivateMemberMembershipParams{
				TeamID: match.TeamID, UserID: userID,
			})
			changed = true
		case membership.Status != "active":
			return TeamView{}, domainError(CodeMisconfigured)
		}
		if err != nil {
			return TeamView{}, err
		}
		if err := queries.ClearJoinCodeAttemptWindow(ctx, teamdb.ClearJoinCodeAttemptWindowParams{
			UserID: userID, WindowStart: windowStart,
		}); err != nil {
			return TeamView{}, err
		}
		if changed {
			if err := appendAudit(ctx, queries, auditRecord{
				principal: input.Principal, action: "team_membership.join",
				targetKind: "team", targetID: match.TeamID, requestID: input.RequestID,
			}); err != nil {
				return TeamView{}, err
			}
		}
		return teamView(teamRow.ID, teamRow.Slug, teamRow.Name, teamRow.CreatedAt,
			teamRow.UpdatedAt, membership), nil
	})
	return view, mapOperationError("join Team", err)
}

func (m *Module) unusedJoinCode(
	ctx context.Context,
	queries *teamdb.Queries,
) (string, string, [32]byte, error) {
	for attempt := 0; attempt < m.policy.ShortCodeAttempts; attempt++ {
		code, err := m.randomJoinCode()
		if err != nil {
			return "", "", [32]byte{}, err
		}
		collision := false
		for _, keyID := range m.pepperKeys.KeyIDs() {
			digest, found, err := m.pepperKeys.ShortCodeDigest(keyID, joinCodePurpose, code)
			if err != nil || !found {
				return "", "", [32]byte{}, domainError(CodeMisconfigured)
			}
			exists, err := queries.JoinCodeDigestExists(ctx, teamdb.JoinCodeDigestExistsParams{
				PepperKeyID: keyID, CodeDigest: digest[:],
			})
			if err != nil {
				return "", "", [32]byte{}, err
			}
			if exists {
				collision = true
				break
			}
		}
		if collision {
			continue
		}
		keyID, digest, err := m.pepperKeys.ActiveShortCodeDigest(joinCodePurpose, code)
		return code, keyID, digest, err
	}
	return "", "", [32]byte{}, domainError(CodeServiceUnavailable)
}

func (m *Module) randomJoinCode() (string, error) {
	random := make([]byte, joinCodeLength)
	if _, err := io.ReadFull(m.random, random); err != nil {
		return "", errors.New("secure random source failed")
	}
	var builder strings.Builder
	builder.Grow(joinCodeLength)
	for _, value := range random {
		builder.WriteByte(joinCodeAlphabet[int(value)&(len(joinCodeAlphabet)-1)])
	}
	return builder.String(), nil
}

func normalizeJoinCode(value string) (string, bool) {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) != joinCodeLength {
		return "", false
	}
	for _, character := range value {
		if character > 127 || !strings.ContainsRune(joinCodeAlphabet, character) {
			return "", false
		}
	}
	return value, true
}

func (m *Module) recordJoinCodeFailure(
	ctx context.Context,
	queries *teamdb.Queries,
	principal authentication.Principal,
	userID pgtype.UUID,
	now time.Time,
	windowStart time.Time,
	windowEnd time.Time,
	requestID string,
) error {
	row, err := queries.RecordJoinCodeFailure(ctx, teamdb.RecordJoinCodeFailureParams{
		UserID: userID, WindowStart: windowStart,
		MaximumFailures: int32(m.policy.MaximumCodeFailures), WindowEnd: windowEnd,
	})
	if err != nil {
		return err
	}
	if row.FailureCount >= int32(m.policy.MaximumCodeFailures) {
		if err := appendAudit(ctx, queries, auditRecord{
			principal: principal, action: "team_join_code.failure_budget",
			targetKind: "team_join_code", reason: "attempt_limit", requestID: requestID,
		}); err != nil {
			return err
		}
		return commitWithError(retryError(
			CodeTooManyJoinCodeAttempts, positiveCeilingSeconds(windowEnd.Sub(now)),
		))
	}
	return commitWithError(domainError(CodeInvalidJoinCode))
}

func positiveCeilingSeconds(value time.Duration) int {
	seconds := int(value / time.Second)
	if value%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		return 1
	}
	return seconds
}

func statusFromJoinCode(
	generation int32,
	status string,
	createdAt time.Time,
	retiredAt pgtype.Timestamptz,
	disabledAt pgtype.Timestamptz,
) JoinCodeStatus {
	updatedAt := createdAt
	if retiredAt.Valid {
		updatedAt = retiredAt.Time
	}
	if disabledAt.Valid {
		updatedAt = disabledAt.Time
	}
	return JoinCodeStatus{Enabled: status == "enabled", Generation: int(generation), UpdatedAt: updatedAt}
}
