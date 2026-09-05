package team

import (
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
)

type MembershipRole string

const (
	OwnerRole  MembershipRole = "owner"
	MemberRole MembershipRole = "member"
)

type MembershipStatus string

const (
	ActiveMembership  MembershipStatus = "active"
	RemovedMembership MembershipStatus = "removed"
)

type Team struct {
	ID          string
	Slug        string
	DisplayName string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type Membership struct {
	TeamID    string
	UserID    string
	Role      MembershipRole
	Status    MembershipStatus
	CreatedAt time.Time
	UpdatedAt time.Time
}

type TeamView struct {
	Team       Team
	Membership Membership
}

type MemberView struct {
	UserID      string
	DisplayName string
	AvatarURL   string
	Role        MembershipRole
	JoinedAt    time.Time
	UpdatedAt   time.Time
}

type JoinCodeStatus struct {
	Enabled    bool
	Generation int
	UpdatedAt  time.Time
}

type JoinCodeGrant struct {
	Code      string
	Status    JoinCodeStatus
	RotatedAt time.Time
}

type ProjectType string

const (
	GitProject    ProjectType = "git"
	FolderProject ProjectType = "directory"
)

type ProjectState string

const (
	ActiveProject   ProjectState = "active"
	ArchivedProject ProjectState = "archived"
	DeletedProject  ProjectState = "deleted"
)

type Project struct {
	ID                 string
	TeamID             string
	Name               string
	Type               ProjectType
	State              ProjectState
	RepositoryIdentity string
	CapturedThrough    time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type Workspace struct {
	Teams    []TeamView
	Projects []Project
}

type CreateTeamInput struct {
	Principal    authentication.Principal
	Slug         string
	DisplayName  string
	OperationKey string
	RequestID    string
}

type UpdateTeamInput struct {
	Principal   authentication.Principal
	TeamSlug    string
	DisplayName string
	RequestID   string
}

type ChangeMembershipRoleInput struct {
	Principal authentication.Principal
	TeamSlug  string
	UserID    string
	Role      MembershipRole
	RequestID string
}

type RemoveMembershipInput struct {
	Principal authentication.Principal
	TeamSlug  string
	UserID    string
	RequestID string
}

type TeamActionInput struct {
	Principal authentication.Principal
	TeamSlug  string
	RequestID string
}

type JoinTeamInput struct {
	Principal authentication.Principal
	JoinCode  string
	RequestID string
}

type ProjectSpec struct {
	Type   ProjectType
	Name   string
	Remote string
}

type CreateProjectInput struct {
	Principal    authentication.Principal
	TeamSlug     string
	Spec         ProjectSpec
	OperationKey string
	RequestID    string
}

type MatchProjectInput struct {
	Principal authentication.Principal
	TeamID    string
	Remote    string
}

type RenameFolderProjectInput struct {
	Principal authentication.Principal
	ProjectID string
	Name      string
	RequestID string
}

type RelinkGitProjectInput struct {
	Principal authentication.Principal
	ProjectID string
	Remote    string
	RequestID string
}

type ProjectActionInput struct {
	Principal authentication.Principal
	ProjectID string
	RequestID string
}
