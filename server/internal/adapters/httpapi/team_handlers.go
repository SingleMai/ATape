package httpapi

import (
	"net/http"
	"time"

	"github.com/SingleMai/ATape/server/internal/team"
)

type membershipDTO struct {
	Role string `json:"role"`
}

type teamDTO struct {
	ID          string        `json:"id"`
	Slug        string        `json:"slug"`
	DisplayName string        `json:"displayName"`
	Membership  membershipDTO `json:"membership"`
	CreatedAt   time.Time     `json:"createdAt"`
	UpdatedAt   time.Time     `json:"updatedAt"`
}

type projectDTO struct {
	ID                 string    `json:"id"`
	TeamID             string    `json:"teamId"`
	Type               string    `json:"type"`
	Name               string    `json:"name"`
	State              string    `json:"state"`
	RepositoryIdentity string    `json:"repositoryIdentity,omitempty"`
	CapturedThrough    time.Time `json:"capturedThrough,omitempty"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

type workspaceDTO struct {
	Teams    []teamDTO    `json:"teams"`
	Projects []projectDTO `json:"projects"`
}

func teamDTOFromView(view team.TeamView) teamDTO {
	return teamDTO{
		ID: view.Team.ID, Slug: view.Team.Slug, DisplayName: view.Team.DisplayName,
		Membership: membershipDTO{Role: string(view.Membership.Role)},
		CreatedAt:  view.Team.CreatedAt, UpdatedAt: view.Team.UpdatedAt,
	}
}

func projectDTOFromDomain(project team.Project) projectDTO {
	projectType := string(project.Type)
	if project.Type == team.FolderProject {
		projectType = "folder"
	}
	return projectDTO{
		ID: project.ID, TeamID: project.TeamID, Type: projectType, Name: project.Name,
		State: string(project.State), RepositoryIdentity: project.RepositoryIdentity,
		CapturedThrough: project.CapturedThrough, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt,
	}
}

func workspaceDTOFromTeam(workspace team.Workspace) workspaceDTO {
	result := workspaceDTO{
		Teams:    make([]teamDTO, 0, len(workspace.Teams)),
		Projects: make([]projectDTO, 0, len(workspace.Projects)),
	}
	for _, item := range workspace.Teams {
		result.Teams = append(result.Teams, teamDTOFromView(item))
	}
	for _, project := range workspace.Projects {
		result.Projects = append(result.Projects, projectDTOFromDomain(project))
	}
	return result
}

func (h *Handler) createTeam(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Slug        string `json:"slug"`
		DisplayName string `json:"displayName"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	view, err := h.teams.CreateTeam(request.Context(), team.CreateTeamInput{
		Principal: requestAuthenticationFromContext(request.Context()).principal,
		Slug:      input.Slug, DisplayName: input.DisplayName,
		OperationKey: request.Header.Get("Idempotency-Key"), RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusCreated, teamDTOFromView(view))
}

func (h *Handler) openTeam(response http.ResponseWriter, request *http.Request) {
	if !h.requireTeamModule(response, request) {
		return
	}
	view, err := h.teams.OpenTeam(
		request.Context(), principalFromContext(request.Context()), request.PathValue("teamSlug"),
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, teamDTOFromView(view))
}

func (h *Handler) updateTeam(response http.ResponseWriter, request *http.Request) {
	var input struct {
		DisplayName string `json:"displayName"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	view, err := h.teams.UpdateTeam(request.Context(), team.UpdateTeamInput{
		Principal: principalFromContext(request.Context()), TeamSlug: request.PathValue("teamSlug"),
		DisplayName: input.DisplayName, RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, teamDTOFromView(view))
}

func (h *Handler) teamMembers(response http.ResponseWriter, request *http.Request) {
	if !h.requireTeamModule(response, request) {
		return
	}
	members, err := h.teams.ListMembers(request.Context(), team.TeamActionInput{
		Principal: principalFromContext(request.Context()), TeamSlug: request.PathValue("teamSlug"),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	type memberDTO struct {
		UserID      string    `json:"userId"`
		DisplayName string    `json:"displayName"`
		AvatarURL   string    `json:"avatarUrl"`
		Role        string    `json:"role"`
		JoinedAt    time.Time `json:"joinedAt"`
		UpdatedAt   time.Time `json:"updatedAt"`
	}
	items := make([]memberDTO, 0, len(members))
	for _, member := range members {
		items = append(items, memberDTO{
			UserID: member.UserID, DisplayName: member.DisplayName, AvatarURL: member.AvatarURL,
			Role: string(member.Role), JoinedAt: member.JoinedAt, UpdatedAt: member.UpdatedAt,
		})
	}
	writeJSON(response, request, http.StatusOK, struct {
		Items []memberDTO `json:"items"`
	}{Items: items})
}

func (h *Handler) changeMembershipRole(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Role string `json:"role"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	membership, err := h.teams.ChangeMembershipRole(request.Context(), team.ChangeMembershipRoleInput{
		Principal: principalFromContext(request.Context()), TeamSlug: request.PathValue("teamSlug"),
		UserID: request.PathValue("userId"), Role: team.MembershipRole(input.Role),
		RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, struct {
		TeamID string `json:"teamId"`
		UserID string `json:"userId"`
		Role   string `json:"role"`
		Status string `json:"status"`
	}{TeamID: membership.TeamID, UserID: membership.UserID, Role: string(membership.Role), Status: string(membership.Status)})
}

func (h *Handler) removeMembership(response http.ResponseWriter, request *http.Request) {
	if !h.requireTeamModule(response, request) {
		return
	}
	err := h.teams.RemoveMembership(request.Context(), team.RemoveMembershipInput{
		Principal: principalFromContext(request.Context()), TeamSlug: request.PathValue("teamSlug"),
		UserID: request.PathValue("userId"), RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeNoContent(response, http.StatusNoContent)
}

func (h *Handler) leaveTeam(response http.ResponseWriter, request *http.Request) {
	var empty struct{}
	if !decodeJSON(response, request, &empty) {
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	err := h.teams.LeaveTeam(request.Context(), team.TeamActionInput{
		Principal: principalFromContext(request.Context()), TeamSlug: request.PathValue("teamSlug"),
		RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeNoContent(response, http.StatusNoContent)
}

func (h *Handler) joinCodeStatus(response http.ResponseWriter, request *http.Request) {
	if !h.requireTeamModule(response, request) {
		return
	}
	status, err := h.teams.ReadJoinCodeStatus(request.Context(), team.TeamActionInput{
		Principal: principalFromContext(request.Context()), TeamSlug: request.PathValue("teamSlug"),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, struct {
		Enabled    bool      `json:"enabled"`
		Generation int       `json:"generation"`
		UpdatedAt  time.Time `json:"updatedAt"`
	}{Enabled: status.Enabled, Generation: status.Generation, UpdatedAt: status.UpdatedAt})
}

func (h *Handler) rotateJoinCode(response http.ResponseWriter, request *http.Request) {
	var empty struct{}
	if !decodeJSON(response, request, &empty) {
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	grant, err := h.teams.RotateJoinCode(request.Context(), team.TeamActionInput{
		Principal: principalFromContext(request.Context()), TeamSlug: request.PathValue("teamSlug"),
		RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusCreated, struct {
		Code       string    `json:"code"`
		Generation int       `json:"generation"`
		RotatedAt  time.Time `json:"rotatedAt"`
	}{Code: grant.Code, Generation: grant.Status.Generation, RotatedAt: grant.RotatedAt})
}

func (h *Handler) disableJoinCode(response http.ResponseWriter, request *http.Request) {
	if !h.requireTeamModule(response, request) {
		return
	}
	err := h.teams.DisableJoinCode(request.Context(), team.TeamActionInput{
		Principal: principalFromContext(request.Context()), TeamSlug: request.PathValue("teamSlug"),
		RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeNoContent(response, http.StatusNoContent)
}

func (h *Handler) joinTeam(response http.ResponseWriter, request *http.Request) {
	var input struct {
		JoinCode string `json:"joinCode"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	result, err := h.teams.JoinTeam(request.Context(), team.JoinTeamInput{
		Principal: principalFromContext(request.Context()), JoinCode: input.JoinCode,
		RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	status := http.StatusOK
	if result.MembershipCreated {
		status = http.StatusCreated
	}
	writeJSON(response, request, status, teamDTOFromView(result.TeamView))
}

func (h *Handler) matchProject(response http.ResponseWriter, request *http.Request) {
	var input struct {
		TeamID string `json:"teamId"`
		Type   string `json:"type"`
		Remote string `json:"remote"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if input.Type != "git" {
		writeProblem(response, request, problemInvalidRequest, 0, nil)
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	project, err := h.teams.MatchProject(request.Context(), team.MatchProjectInput{
		Principal: principalFromContext(request.Context()), TeamID: input.TeamID, Remote: input.Remote,
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	if project == nil {
		writeJSON(response, request, http.StatusOK, struct {
			Status string `json:"status"`
		}{Status: "none"})
		return
	}
	writeJSON(response, request, http.StatusOK, struct {
		Status  string     `json:"status"`
		Project projectDTO `json:"project"`
	}{Status: "exact", Project: projectDTOFromDomain(*project)})
}

func (h *Handler) createProject(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Type   string `json:"type"`
		Name   string `json:"name"`
		Remote string `json:"remote"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	var projectType team.ProjectType
	switch input.Type {
	case "git":
		if input.Name != "" || input.Remote == "" {
			writeProblem(response, request, problemInvalidRequest, 0, nil)
			return
		}
		projectType = team.GitProject
	case "folder":
		if input.Remote != "" || input.Name == "" {
			writeProblem(response, request, problemInvalidRequest, 0, nil)
			return
		}
		projectType = team.FolderProject
	default:
		writeProblem(response, request, problemInvalidRequest, 0, nil)
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	project, err := h.teams.CreateProject(request.Context(), team.CreateProjectInput{
		Principal: principalFromContext(request.Context()), TeamSlug: request.PathValue("teamSlug"),
		Spec:         team.ProjectSpec{Type: projectType, Name: input.Name, Remote: input.Remote},
		OperationKey: request.Header.Get("Idempotency-Key"), RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusCreated, projectDTOFromDomain(project))
}

func (h *Handler) openProject(response http.ResponseWriter, request *http.Request) {
	if !h.requireTeamModule(response, request) {
		return
	}
	project, err := h.teams.OpenProject(
		request.Context(), principalFromContext(request.Context()), request.PathValue("projectId"),
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, projectDTOFromDomain(project))
}

func (h *Handler) renameProject(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Name string `json:"name"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	project, err := h.teams.RenameFolderProject(request.Context(), team.RenameFolderProjectInput{
		Principal: principalFromContext(request.Context()), ProjectID: request.PathValue("projectId"),
		Name: input.Name, RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, projectDTOFromDomain(project))
}

func (h *Handler) relinkProject(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Remote string `json:"remote"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	project, err := h.teams.RelinkGitProject(request.Context(), team.RelinkGitProjectInput{
		Principal: principalFromContext(request.Context()), ProjectID: request.PathValue("projectId"),
		Remote: input.Remote, RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, projectDTOFromDomain(project))
}

func (h *Handler) archiveProject(response http.ResponseWriter, request *http.Request) {
	var empty struct{}
	if !decodeJSON(response, request, &empty) {
		return
	}
	if !h.requireTeamModule(response, request) {
		return
	}
	project, err := h.teams.ArchiveProject(request.Context(), team.ProjectActionInput{
		Principal: principalFromContext(request.Context()), ProjectID: request.PathValue("projectId"),
		RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, projectDTOFromDomain(project))
}

func (h *Handler) deleteProject(response http.ResponseWriter, request *http.Request) {
	if !h.requireTeamModule(response, request) {
		return
	}
	err := h.teams.DeleteProject(request.Context(), team.ProjectActionInput{
		Principal: principalFromContext(request.Context()), ProjectID: request.PathValue("projectId"),
		RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeNoContent(response, http.StatusNoContent)
}

func (h *Handler) requireTeamModule(response http.ResponseWriter, request *http.Request) bool {
	if h.teams != nil {
		return true
	}
	writeProblem(response, request, problemServiceUnavailable, 0, nil)
	return false
}
