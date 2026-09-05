// Package authorization contains ATape's pure, closed authorization policy.
// It performs no data access: action-owning Modules supply a Principal plus
// authoritative Resource and current Team Membership facts.
package authorization

import "github.com/SingleMai/ATape/server/internal/authentication"

// Action is a transport-independent capability. Values are closed by the
// catalog below; an unknown value always fails closed.
type Action uint8

const (
	UnknownAction Action = iota
	WorkspaceListVisible
	TeamCreate
	UserReadSelf
	UserUpdateProfile
	ExternalIdentityList
	ExternalIdentityBind
	WebSessionList
	WebSessionRevokeOne
	WebSessionRevokeAll
	CLICredentialList
	CLICredentialRevokeOne
	CLICredentialRevokeAll
	CLICredentialReadCurrent
	CLICredentialRevokeCurrent
	TeamJoinWithCode
	TeamReadMetadata
	ProjectListMetadata
	ProjectReadMetadata
	ProjectMatch
	MembershipList
	TeamUpdateDisplayProfile
	MembershipPromoteToOwner
	MembershipDemoteOwner
	MembershipRemoveMember
	MembershipRemoveOwner
	MembershipLeaveSelf
	TeamJoinCodeReadStatus
	TeamJoinCodeRotate
	TeamJoinCodeDisable
	ProjectCreate
	FolderProjectRename
	GitProjectRelinkRepository
	ProjectArchive
	ProjectDelete
	ProjectMemoryRead
	ConversationRead
	ProjectSearchQuery
	RawSessionList
	RawObjectRead
	CanonicalIngest
	RawIngest
	CapturedSessionDeleteOwn
	CapturedSessionDeleteAny
	actionLimit
)

var actionNames = [...]string{
	WorkspaceListVisible:       "workspace.list_visible",
	TeamCreate:                 "team.create",
	UserReadSelf:               "user.read_self",
	UserUpdateProfile:          "user.update_profile",
	ExternalIdentityList:       "external_identity.list",
	ExternalIdentityBind:       "external_identity.bind",
	WebSessionList:             "web_session.list",
	WebSessionRevokeOne:        "web_session.revoke_one",
	WebSessionRevokeAll:        "web_session.revoke_all",
	CLICredentialList:          "cli_credential.list",
	CLICredentialRevokeOne:     "cli_credential.revoke_one",
	CLICredentialRevokeAll:     "cli_credential.revoke_all",
	CLICredentialReadCurrent:   "cli_credential.read_current",
	CLICredentialRevokeCurrent: "cli_credential.revoke_current",
	TeamJoinWithCode:           "team.join_with_code",
	TeamReadMetadata:           "team.read_metadata",
	ProjectListMetadata:        "project.list_metadata",
	ProjectReadMetadata:        "project.read_metadata",
	ProjectMatch:               "project.match",
	MembershipList:             "membership.list",
	TeamUpdateDisplayProfile:   "team.update_display_profile",
	MembershipPromoteToOwner:   "membership.promote_to_owner",
	MembershipDemoteOwner:      "membership.demote_owner",
	MembershipRemoveMember:     "membership.remove_member",
	MembershipRemoveOwner:      "membership.remove_owner",
	MembershipLeaveSelf:        "membership.leave_self",
	TeamJoinCodeReadStatus:     "team_join_code.read_status",
	TeamJoinCodeRotate:         "team_join_code.rotate",
	TeamJoinCodeDisable:        "team_join_code.disable",
	ProjectCreate:              "project.create",
	FolderProjectRename:        "folder_project.rename",
	GitProjectRelinkRepository: "git_project.relink_repository",
	ProjectArchive:             "project.archive",
	ProjectDelete:              "project.delete",
	ProjectMemoryRead:          "project_memory.read",
	ConversationRead:           "conversation.read",
	ProjectSearchQuery:         "project_search.query",
	RawSessionList:             "raw_session.list",
	RawObjectRead:              "raw_object.read",
	CanonicalIngest:            "canonical.ingest",
	RawIngest:                  "raw.ingest",
	CapturedSessionDeleteOwn:   "captured_session.delete_own",
	CapturedSessionDeleteAny:   "captured_session.delete_any",
}

func (action Action) String() string {
	if action <= UnknownAction || action >= actionLimit || actionNames[action] == "" {
		return "unknown"
	}
	return actionNames[action]
}

// ResourceKind is the trusted semantic kind resolved by the Module that owns
// the Resource. It is deliberately unrelated to routes or client input.
type ResourceKind uint8

const (
	UnknownResource ResourceKind = iota
	InstanceResource
	UserResource
	TeamResource
	MembershipResource
	TeamJoinCodeResource
	ProjectResource
	ConversationResource
	RawObjectResource
	CapturedSessionResource
)

type MembershipRole uint8

const (
	NoMembershipRole MembershipRole = iota
	MemberRole
	OwnerRole
)

// MembershipFacts is a point-in-time projection of the authoritative active
// relationship. Removed or missing Memberships are represented by Active=false.
type MembershipFacts struct {
	TeamID string
	UserID string
	Role   MembershipRole
	Active bool
}

// ResourceFacts contains only ownership facts needed by the policy. Project,
// lifecycle, and persistence details stay inside the action-owning Module.
type ResourceFacts struct {
	Kind             ResourceKind
	OwnerUserID      string
	TeamID           string
	CapturedByUserID string
}

// SessionAccessFacts is the minimal current control-plane projection needed by
// a separate Raw Manifest Adapter. It contains no cached authorization result.
type SessionAccessFacts struct {
	ProjectID    string
	ProjectState string
	Resource     ResourceFacts
	Membership   MembershipFacts
}

type Decision uint8

const (
	Forbid Decision = iota
	Conceal
	Allow
)

type Denial uint8

const (
	NoDenial Denial = iota
	PolicyDenied
	ResourceConcealed
	CredentialCapabilityDenied
	MembershipRoleDenied
	FreshAuthenticationRequired
)

type Outcome struct {
	Decision Decision
	Denial   Denial
}

type Input struct {
	Principal  authentication.Principal
	Action     Action
	Resource   ResourceFacts
	Membership MembershipFacts
}

type roleRequirement uint8

const (
	roleIrrelevant roleRequirement = iota
	activeMember
	activeOwner
)

type mediumMask uint8

const (
	webMedium mediumMask = 1 << iota
	cliMedium
	anyMedium = webMedium | cliMedium
)

type rule struct {
	resource ResourceKind
	media    mediumMask
	role     roleRequirement
	fresh    bool
}

var catalog = [...]rule{
	WorkspaceListVisible:       {resource: InstanceResource, media: anyMedium},
	TeamCreate:                 {resource: InstanceResource, media: webMedium},
	UserReadSelf:               {resource: UserResource, media: anyMedium},
	UserUpdateProfile:          {resource: UserResource, media: webMedium},
	ExternalIdentityList:       {resource: UserResource, media: webMedium},
	ExternalIdentityBind:       {resource: UserResource, media: webMedium, fresh: true},
	WebSessionList:             {resource: UserResource, media: webMedium},
	WebSessionRevokeOne:        {resource: UserResource, media: webMedium},
	WebSessionRevokeAll:        {resource: UserResource, media: webMedium},
	CLICredentialList:          {resource: UserResource, media: webMedium},
	CLICredentialRevokeOne:     {resource: UserResource, media: webMedium},
	CLICredentialRevokeAll:     {resource: UserResource, media: webMedium},
	CLICredentialReadCurrent:   {resource: UserResource, media: cliMedium},
	CLICredentialRevokeCurrent: {resource: UserResource, media: cliMedium},
	TeamJoinWithCode:           {resource: InstanceResource, media: webMedium},
	TeamReadMetadata:           {resource: TeamResource, media: anyMedium, role: activeMember},
	ProjectListMetadata:        {resource: TeamResource, media: anyMedium, role: activeMember},
	ProjectReadMetadata:        {resource: ProjectResource, media: anyMedium, role: activeMember},
	ProjectMatch:               {resource: TeamResource, media: cliMedium, role: activeMember},
	MembershipList:             {resource: TeamResource, media: webMedium, role: activeMember},
	TeamUpdateDisplayProfile:   {resource: TeamResource, media: webMedium, role: activeOwner},
	MembershipPromoteToOwner:   {resource: MembershipResource, media: webMedium, role: activeOwner, fresh: true},
	MembershipDemoteOwner:      {resource: MembershipResource, media: webMedium, role: activeOwner, fresh: true},
	MembershipRemoveMember:     {resource: MembershipResource, media: webMedium, role: activeOwner},
	MembershipRemoveOwner:      {resource: MembershipResource, media: webMedium, role: activeOwner, fresh: true},
	MembershipLeaveSelf:        {resource: MembershipResource, media: webMedium, role: activeMember},
	TeamJoinCodeReadStatus:     {resource: TeamJoinCodeResource, media: webMedium, role: activeOwner},
	TeamJoinCodeRotate:         {resource: TeamJoinCodeResource, media: webMedium, role: activeOwner, fresh: true},
	TeamJoinCodeDisable:        {resource: TeamJoinCodeResource, media: webMedium, role: activeOwner},
	ProjectCreate:              {resource: TeamResource, media: anyMedium, role: activeMember},
	FolderProjectRename:        {resource: ProjectResource, media: webMedium, role: activeOwner},
	GitProjectRelinkRepository: {resource: ProjectResource, media: webMedium, role: activeOwner, fresh: true},
	ProjectArchive:             {resource: ProjectResource, media: webMedium, role: activeOwner},
	ProjectDelete:              {resource: ProjectResource, media: webMedium, role: activeOwner, fresh: true},
	ProjectMemoryRead:          {resource: ProjectResource, media: webMedium, role: activeMember},
	ConversationRead:           {resource: ConversationResource, media: webMedium, role: activeMember},
	ProjectSearchQuery:         {resource: ProjectResource, media: webMedium, role: activeMember},
	RawSessionList:             {resource: ConversationResource, media: webMedium, role: activeMember},
	RawObjectRead:              {resource: RawObjectResource, media: webMedium, role: activeMember},
	CanonicalIngest:            {resource: ProjectResource, media: cliMedium, role: activeMember},
	RawIngest:                  {resource: ConversationResource, media: cliMedium, role: activeMember},
	CapturedSessionDeleteOwn:   {resource: CapturedSessionResource, media: webMedium, role: activeMember},
	CapturedSessionDeleteAny:   {resource: CapturedSessionResource, media: webMedium, role: activeOwner, fresh: true},
}

// Policy is stateless. Its zero value is ready for use.
type Policy struct{}

func (Policy) Evaluate(input Input) Outcome {
	if input.Action <= UnknownAction || input.Action >= actionLimit {
		return denied(PolicyDenied)
	}
	rule := catalog[input.Action]
	if rule.resource == UnknownResource || rule.resource != input.Resource.Kind {
		return denied(PolicyDenied)
	}
	if !visible(input) {
		return Outcome{Decision: Conceal, Denial: ResourceConcealed}
	}
	medium := principalMedium(input.Principal.Method)
	if medium == 0 || rule.media&medium == 0 {
		return denied(CredentialCapabilityDenied)
	}
	if rule.role == activeOwner && input.Membership.Role != OwnerRole {
		return denied(MembershipRoleDenied)
	}
	if rule.fresh && !input.Principal.Fresh {
		return denied(FreshAuthenticationRequired)
	}
	if input.Action == CapturedSessionDeleteOwn &&
		input.Resource.CapturedByUserID != input.Principal.UserID {
		return denied(MembershipRoleDenied)
	}
	if input.Action == RawIngest &&
		input.Resource.CapturedByUserID != input.Principal.UserID {
		return denied(MembershipRoleDenied)
	}
	return Outcome{Decision: Allow}
}

func denied(reason Denial) Outcome {
	return Outcome{Decision: Forbid, Denial: reason}
}

func visible(input Input) bool {
	if input.Principal.UserID == "" {
		return false
	}
	switch input.Resource.Kind {
	case InstanceResource:
		return true
	case UserResource:
		return input.Resource.OwnerUserID != "" && input.Resource.OwnerUserID == input.Principal.UserID
	case TeamResource, MembershipResource, TeamJoinCodeResource, ProjectResource,
		ConversationResource, RawObjectResource, CapturedSessionResource:
		return input.Resource.TeamID != "" && input.Membership.Active &&
			input.Membership.TeamID == input.Resource.TeamID &&
			input.Membership.UserID == input.Principal.UserID &&
			(input.Membership.Role == MemberRole || input.Membership.Role == OwnerRole)
	default:
		return false
	}
}

func principalMedium(method authentication.AuthenticationMethod) mediumMask {
	switch method {
	case authentication.WebAuthentication:
		return webMedium
	case authentication.CLIAuthentication:
		return cliMedium
	default:
		return 0
	}
}

// Actions returns the complete closed catalog in stable declaration order.
func Actions() []Action {
	actions := make([]Action, 0, int(actionLimit)-1)
	for action := Action(1); action < actionLimit; action++ {
		actions = append(actions, action)
	}
	return actions
}

// ActionInventory returns the complete stable names used by policy reviews and
// contract tooling. These names describe server capabilities; they are not
// claims embedded in a Web Session or CLI Credential.
func ActionInventory() []string {
	actions := Actions()
	result := make([]string, 0, len(actions))
	for _, action := range actions {
		result = append(result, action.String())
	}
	return result
}
