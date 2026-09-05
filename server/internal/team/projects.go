package team

import (
	"context"
	"crypto/hmac"
	"errors"
	"net"
	"net/url"
	pathpkg "path"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	teamdb "github.com/SingleMai/ATape/server/internal/team/internal/db"
	"github.com/jackc/pgx/v5"
)

var scpRemotePattern = regexp.MustCompile(`^(?:[^@/:]+@)?([^/:]+):(.+)$`)

func (m *Module) CreateProject(ctx context.Context, input CreateProjectInput) (Project, error) {
	slug, err := normalizeSlug(input.TeamSlug)
	if err != nil || !validateOperationKey(input.OperationKey) || !validateRequestID(input.RequestID) {
		return Project{}, domainError(CodeInvalidRequest)
	}
	projectType, name, remoteIdentity, err := normalizeProjectSpec(input.Spec)
	if err != nil {
		return Project{}, err
	}
	requestDigest := digestFields("project.create", slug, string(projectType), name, remoteIdentity)
	project, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (Project, error) {
		queries := teamdb.New(tx)
		access, err := m.lockTeamAccess(ctx, queries, input.Principal, slug)
		if err != nil {
			return Project{}, err
		}
		if err := m.authorize(input.Principal, authorization.ProjectCreate,
			authorization.ResourceFacts{Kind: authorization.TeamResource, TeamID: access.teamID},
			access.facts); err != nil {
			return Project{}, err
		}
		userID, err := databaseUUID(input.Principal.UserID)
		if err != nil {
			return Project{}, domainError(CodeInvalidRequest)
		}
		lockKey := "team-operation:" + input.Principal.UserID + ":project.create:" + input.OperationKey
		if err := queries.AcquireTeamAdvisoryLock(ctx, lockKey); err != nil {
			return Project{}, err
		}
		receipt, receiptErr := queries.GetOperationReceiptForUpdate(ctx, teamdb.GetOperationReceiptForUpdateParams{
			UserID: userID, Action: "project.create", OperationKey: input.OperationKey,
		})
		if receiptErr == nil {
			if !hmac.Equal(receipt.RequestDigest, requestDigest[:]) {
				return Project{}, domainError(CodeIdempotencyConflict)
			}
			row, err := queries.GetProject(ctx, receipt.ResourceID)
			if err != nil {
				return Project{}, err
			}
			if row.State == "deleted" {
				return Project{}, domainError(CodeNotFound)
			}
			return projectFromFields(row.ID, row.TeamID, row.Name, row.ProjectType, row.State,
				row.RemoteIdentity, row.CapturedThrough, row.CreatedAt, row.UpdatedAt), nil
		}
		if !errors.Is(receiptErr, pgx.ErrNoRows) {
			return Project{}, receiptErr
		}
		id, err := newID()
		if err != nil {
			return Project{}, err
		}
		row, err := queries.InsertProject(ctx, teamdb.InsertProjectParams{
			ID: id, TeamID: access.teamID, Name: name, ProjectType: string(projectType),
		})
		if err != nil {
			return Project{}, err
		}
		if projectType == GitProject {
			if err := queries.InsertRepositoryAlias(ctx, teamdb.InsertRepositoryAliasParams{
				ProjectID: id, TeamID: access.teamID, RemoteIdentity: remoteIdentity, Current: true,
			}); err != nil {
				if uniqueViolation(err) {
					return Project{}, domainError(CodeResourceStateConflict)
				}
				return Project{}, err
			}
		}
		ttl, _ := durationSeconds(m.policy.OperationReceiptTTL)
		if err := queries.InsertOperationReceipt(ctx, teamdb.InsertOperationReceiptParams{
			UserID: userID, Action: "project.create", OperationKey: input.OperationKey,
			RequestDigest: requestDigest[:], ResourceID: id, TtlSeconds: ttl,
		}); err != nil {
			return Project{}, err
		}
		if err := appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "project.create", targetKind: "project",
			targetID: id, requestID: input.RequestID,
		}); err != nil {
			return Project{}, err
		}
		remote := (*string)(nil)
		if remoteIdentity != "" {
			remote = &remoteIdentity
		}
		return projectFromFields(row.ID, row.TeamID, row.Name, row.ProjectType, row.State,
			remote, row.CapturedThrough, row.CreatedAt, row.UpdatedAt), nil
	})
	return project, mapOperationError("create Project", err)
}

func (m *Module) MatchProject(ctx context.Context, input MatchProjectInput) (*Project, error) {
	remoteIdentity, _, err := normalizeRepositoryRemote(input.Remote)
	if err != nil || input.TeamID == "" || len(input.TeamID) > 200 {
		return nil, domainError(CodeInvalidRequest)
	}
	matched, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (*Project, error) {
		queries := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, queries, input.Principal)
		if err != nil {
			return nil, err
		}
		teamRow, err := queries.GetTeamByID(ctx, input.TeamID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && teamRow.Slug == nil) {
			return nil, domainError(CodeNotFound)
		}
		if err != nil {
			return nil, err
		}
		membership, membershipErr := queries.GetMembership(ctx, teamdb.GetMembershipParams{
			TeamID: teamRow.ID, UserID: userID,
		})
		facts := authorization.MembershipFacts{}
		if membershipErr == nil {
			facts = membershipFacts(membership)
		} else if !errors.Is(membershipErr, pgx.ErrNoRows) {
			return nil, membershipErr
		}
		if err := m.authorize(input.Principal, authorization.ProjectMatch,
			authorization.ResourceFacts{Kind: authorization.TeamResource, TeamID: teamRow.ID}, facts); err != nil {
			return nil, err
		}
		row, err := queries.FindProjectByRepositoryIdentity(ctx, teamdb.FindProjectByRepositoryIdentityParams{
			TeamID: teamRow.ID, RemoteIdentity: remoteIdentity,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		project := projectFromFields(row.ID, row.TeamID, row.Name, row.ProjectType, row.State,
			row.RemoteIdentity, row.CapturedThrough, row.CreatedAt, row.UpdatedAt)
		return &project, nil
	})
	return matched, mapOperationError("match Project repository", err)
}

func (m *Module) OpenProject(ctx context.Context, principal authentication.Principal, projectID string) (Project, error) {
	if projectID == "" || len(projectID) > 200 {
		return Project{}, domainError(CodeNotFound)
	}
	project, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (Project, error) {
		queries := teamdb.New(tx)
		userID, err := m.lockPrincipalUser(ctx, queries, principal)
		if err != nil {
			return Project{}, err
		}
		row, err := queries.GetProject(ctx, projectID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && row.State == "deleted") {
			return Project{}, domainError(CodeNotFound)
		}
		if err != nil {
			return Project{}, err
		}
		membership, membershipErr := queries.GetMembership(ctx, teamdb.GetMembershipParams{
			TeamID: row.TeamID, UserID: userID,
		})
		facts := authorization.MembershipFacts{}
		if membershipErr == nil {
			facts = membershipFacts(membership)
		} else if !errors.Is(membershipErr, pgx.ErrNoRows) {
			return Project{}, membershipErr
		}
		if err := m.authorize(principal, authorization.ProjectReadMetadata,
			authorization.ResourceFacts{Kind: authorization.ProjectResource, TeamID: row.TeamID}, facts); err != nil {
			return Project{}, err
		}
		return projectFromFields(row.ID, row.TeamID, row.Name, row.ProjectType, row.State,
			row.RemoteIdentity, row.CapturedThrough, row.CreatedAt, row.UpdatedAt), nil
	})
	return project, mapOperationError("open Project", err)
}

func (m *Module) ListProjects(ctx context.Context, input TeamActionInput) ([]Project, error) {
	slug, err := normalizeSlug(input.TeamSlug)
	if err != nil {
		return nil, domainError(CodeNotFound)
	}
	projects, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) ([]Project, error) {
		queries := teamdb.New(tx)
		access, err := m.lockTeamAccess(ctx, queries, input.Principal, slug)
		if err != nil {
			return nil, err
		}
		if err := m.authorize(input.Principal, authorization.ProjectListMetadata,
			authorization.ResourceFacts{Kind: authorization.TeamResource, TeamID: access.teamID},
			access.facts); err != nil {
			return nil, err
		}
		rows, err := queries.ListProjectsForTeam(ctx, access.teamID)
		if err != nil {
			return nil, err
		}
		result := make([]Project, 0, len(rows))
		for _, row := range rows {
			result = append(result, projectFromFields(row.ID, row.TeamID, row.Name, row.ProjectType,
				row.State, row.RemoteIdentity, row.CapturedThrough, row.CreatedAt, row.UpdatedAt))
		}
		return result, nil
	})
	return projects, mapOperationError("list Projects", err)
}

func (m *Module) RenameFolderProject(ctx context.Context, input RenameFolderProjectInput) (Project, error) {
	name, err := normalizeDisplayName(input.Name)
	if err != nil || !validateRequestID(input.RequestID) {
		return Project{}, domainError(CodeInvalidRequest)
	}
	project, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (Project, error) {
		queries := teamdb.New(tx)
		access, err := m.lockProjectAccess(ctx, queries, input.Principal, input.ProjectID)
		if err != nil {
			return Project{}, err
		}
		if err := m.authorize(input.Principal, authorization.FolderProjectRename,
			authorization.ResourceFacts{Kind: authorization.ProjectResource, TeamID: access.project.TeamID},
			access.facts); err != nil {
			return Project{}, err
		}
		if access.project.State == "deleted" {
			return Project{}, domainError(CodeNotFound)
		}
		if ProjectType(access.project.ProjectType) != FolderProject {
			return Project{}, domainError(CodeResourceStateConflict)
		}
		if access.project.Name == name {
			return projectFromGetProjectForUpdate(access.project), nil
		}
		updated, err := queries.RenameFolderProject(ctx, teamdb.RenameFolderProjectParams{ID: input.ProjectID, Name: name})
		if err != nil {
			return Project{}, err
		}
		if err := appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "folder_project.rename", targetKind: "project",
			targetID: input.ProjectID, requestID: input.RequestID,
		}); err != nil {
			return Project{}, err
		}
		return projectFromFields(updated.ID, updated.TeamID, updated.Name, updated.ProjectType,
			updated.State, nil, updated.CapturedThrough, updated.CreatedAt, updated.UpdatedAt), nil
	})
	return project, mapOperationError("rename Folder Project", err)
}

func (m *Module) RelinkGitProject(ctx context.Context, input RelinkGitProjectInput) (Project, error) {
	remoteIdentity, name, err := normalizeRepositoryRemote(input.Remote)
	if err != nil || !validateRequestID(input.RequestID) {
		return Project{}, domainError(CodeInvalidRequest)
	}
	project, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (Project, error) {
		queries := teamdb.New(tx)
		access, err := m.lockProjectAccess(ctx, queries, input.Principal, input.ProjectID)
		if err != nil {
			return Project{}, err
		}
		if err := m.authorize(input.Principal, authorization.GitProjectRelinkRepository,
			authorization.ResourceFacts{Kind: authorization.ProjectResource, TeamID: access.project.TeamID},
			access.facts); err != nil {
			return Project{}, err
		}
		if access.project.State == "deleted" {
			return Project{}, domainError(CodeNotFound)
		}
		if access.project.ProjectType != "git" {
			return Project{}, domainError(CodeResourceStateConflict)
		}
		if access.project.RemoteIdentity != nil && *access.project.RemoteIdentity == remoteIdentity {
			return projectFromGetProjectForUpdate(access.project), nil
		}
		if err := queries.MarkRepositoryAliasesNonCurrent(ctx, input.ProjectID); err != nil {
			return Project{}, err
		}
		affected, err := queries.MakeRepositoryAliasCurrent(ctx, teamdb.MakeRepositoryAliasCurrentParams{
			ProjectID: input.ProjectID, RemoteIdentity: remoteIdentity,
		})
		if err != nil {
			return Project{}, err
		}
		if affected == 0 {
			if err := queries.InsertRepositoryAlias(ctx, teamdb.InsertRepositoryAliasParams{
				ProjectID: input.ProjectID, TeamID: access.project.TeamID,
				RemoteIdentity: remoteIdentity, Current: true,
			}); err != nil {
				if uniqueViolation(err) {
					return Project{}, domainError(CodeResourceStateConflict)
				}
				return Project{}, err
			}
		}
		if err := queries.RenameGitProject(ctx, teamdb.RenameGitProjectParams{ID: input.ProjectID, Name: name}); err != nil {
			return Project{}, err
		}
		if err := appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "git_project.relink_repository", targetKind: "project",
			targetID: input.ProjectID, requestID: input.RequestID,
		}); err != nil {
			return Project{}, err
		}
		row, err := queries.GetProjectForUpdate(ctx, input.ProjectID)
		if err != nil {
			return Project{}, err
		}
		return projectFromGetProjectForUpdate(row), nil
	})
	return project, mapOperationError("relink Git Project repository", err)
}

func (m *Module) ArchiveProject(ctx context.Context, input ProjectActionInput) (Project, error) {
	if !validateRequestID(input.RequestID) {
		return Project{}, domainError(CodeInvalidRequest)
	}
	project, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (Project, error) {
		queries := teamdb.New(tx)
		access, err := m.lockProjectAccess(ctx, queries, input.Principal, input.ProjectID)
		if err != nil {
			return Project{}, err
		}
		if err := m.authorize(input.Principal, authorization.ProjectArchive,
			authorization.ResourceFacts{Kind: authorization.ProjectResource, TeamID: access.project.TeamID},
			access.facts); err != nil {
			return Project{}, err
		}
		if access.project.State == "deleted" {
			return Project{}, domainError(CodeNotFound)
		}
		wasActive := access.project.State == "active"
		row, err := queries.ArchiveProject(ctx, input.ProjectID)
		if err != nil {
			return Project{}, err
		}
		if wasActive {
			if err := appendAudit(ctx, queries, auditRecord{
				principal: input.Principal, action: "project.archive", targetKind: "project",
				targetID: input.ProjectID, requestID: input.RequestID,
			}); err != nil {
				return Project{}, err
			}
		}
		return projectFromFields(row.ID, row.TeamID, row.Name, row.ProjectType, row.State,
			access.project.RemoteIdentity, row.CapturedThrough, row.CreatedAt, row.UpdatedAt), nil
	})
	return project, mapOperationError("archive Project", err)
}

// DeleteProject establishes the deletion authority boundary atomically. The
// retained rows support audit/restore, while every public read and write path
// treats the deleted state as nonexistent and derived bytes remain unreachable.
func (m *Module) DeleteProject(ctx context.Context, input ProjectActionInput) error {
	if !validateRequestID(input.RequestID) {
		return domainError(CodeInvalidRequest)
	}
	_, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (struct{}, error) {
		queries := teamdb.New(tx)
		access, err := m.lockProjectAccess(ctx, queries, input.Principal, input.ProjectID)
		if err != nil {
			return struct{}{}, err
		}
		if err := m.authorize(input.Principal, authorization.ProjectDelete,
			authorization.ResourceFacts{Kind: authorization.ProjectResource, TeamID: access.project.TeamID},
			access.facts); err != nil {
			return struct{}{}, err
		}
		if access.project.State == "deleted" {
			return struct{}{}, nil
		}
		if err := queries.DeleteRepositoryAliases(ctx, input.ProjectID); err != nil {
			return struct{}{}, err
		}
		if _, err := queries.SoftDeleteProject(ctx, input.ProjectID); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, appendAudit(ctx, queries, auditRecord{
			principal: input.Principal, action: "project.delete", targetKind: "project",
			targetID: input.ProjectID, requestID: input.RequestID,
		})
	})
	return mapOperationError("delete Project", err)
}

type lockedProjectAccess struct {
	project teamdb.GetProjectForUpdateRow
	facts   authorization.MembershipFacts
}

func (m *Module) lockProjectAccess(
	ctx context.Context,
	queries *teamdb.Queries,
	principal authentication.Principal,
	projectID string,
) (lockedProjectAccess, error) {
	if projectID == "" || len(projectID) > 200 {
		return lockedProjectAccess{}, domainError(CodeNotFound)
	}
	userID, err := m.lockPrincipalUser(ctx, queries, principal)
	if err != nil {
		return lockedProjectAccess{}, err
	}
	initial, err := queries.GetProject(ctx, projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedProjectAccess{}, domainError(CodeNotFound)
	}
	if err != nil {
		return lockedProjectAccess{}, err
	}
	if _, err := queries.GetTeamByIDForUpdate(ctx, initial.TeamID); err != nil {
		return lockedProjectAccess{}, err
	}
	project, err := queries.GetProjectForUpdate(ctx, projectID)
	if err != nil {
		return lockedProjectAccess{}, err
	}
	membership, membershipErr := queries.GetMembershipForUpdate(ctx, teamdb.GetMembershipForUpdateParams{
		TeamID: project.TeamID, UserID: userID,
	})
	facts := authorization.MembershipFacts{}
	if membershipErr == nil {
		facts = membershipFacts(membership)
	} else if !errors.Is(membershipErr, pgx.ErrNoRows) {
		return lockedProjectAccess{}, membershipErr
	}
	return lockedProjectAccess{project: project, facts: facts}, nil
}

func normalizeProjectSpec(spec ProjectSpec) (ProjectType, string, string, error) {
	switch spec.Type {
	case FolderProject:
		if strings.TrimSpace(spec.Remote) != "" {
			return "", "", "", domainError(CodeInvalidRequest)
		}
		name, err := normalizeDisplayName(spec.Name)
		return FolderProject, name, "", err
	case GitProject:
		if strings.TrimSpace(spec.Name) != "" {
			return "", "", "", domainError(CodeInvalidRequest)
		}
		identity, name, err := normalizeRepositoryRemote(spec.Remote)
		return GitProject, name, identity, err
	default:
		return "", "", "", domainError(CodeInvalidRequest)
	}
}

func normalizeRepositoryRemote(value string) (string, string, error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || len(value) < 3 || len(value) > 2048 ||
		strings.ContainsAny(value, "\x00\r\n") {
		return "", "", domainError(CodeInvalidRequest)
	}
	if match := scpRemotePattern.FindStringSubmatch(value); match != nil && !strings.Contains(value, "://") {
		value = "ssh://" + match[1] + "/" + match[2]
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", domainError(CodeInvalidRequest)
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https", "http", "ssh", "git":
	default:
		return "", "", domainError(CodeInvalidRequest)
	}
	if parsed.User != nil {
		if _, hasPassword := parsed.User.Password(); hasPassword {
			return "", "", domainError(CodeInvalidRequest)
		}
	}
	host := strings.ToLower(parsed.Hostname())
	if port := parsed.Port(); port != "" {
		host = net.JoinHostPort(host, port)
	}
	rawPath, err := url.PathUnescape(parsed.EscapedPath())
	if err != nil || strings.Contains(rawPath, "\\") {
		return "", "", domainError(CodeInvalidRequest)
	}
	for _, segment := range strings.Split(rawPath, "/") {
		if segment == ".." {
			return "", "", domainError(CodeInvalidRequest)
		}
	}
	repositoryPath := strings.Trim(pathpkg.Clean("/"+rawPath), "/")
	repositoryPath = strings.TrimSuffix(repositoryPath, ".git")
	if host == "github.com" || host == "gitlab.com" || host == "bitbucket.org" {
		repositoryPath = strings.ToLower(repositoryPath)
	}
	parts := strings.Split(repositoryPath, "/")
	if len(parts) < 2 || parts[len(parts)-1] == "" || len(repositoryPath) > 1800 {
		return "", "", domainError(CodeInvalidRequest)
	}
	return host + "/" + repositoryPath, repositoryPath, nil
}

func projectFromFields(
	id string,
	teamID string,
	name string,
	projectType string,
	state string,
	remoteIdentity *string,
	capturedThrough time.Time,
	createdAt time.Time,
	updatedAt time.Time,
) Project {
	remote := ""
	if remoteIdentity != nil {
		remote = *remoteIdentity
	}
	normalizedType := ProjectType(projectType)
	if projectType == "directory" {
		normalizedType = FolderProject
	}
	return Project{
		ID: id, TeamID: teamID, Name: name, Type: normalizedType, State: ProjectState(state),
		RepositoryIdentity: remote, CapturedThrough: capturedThrough,
		CreatedAt: createdAt, UpdatedAt: updatedAt,
	}
}

func projectFromGetProjectForUpdate(row teamdb.GetProjectForUpdateRow) Project {
	return projectFromFields(row.ID, row.TeamID, row.Name, row.ProjectType, row.State,
		row.RemoteIdentity, row.CapturedThrough, row.CreatedAt, row.UpdatedAt)
}
