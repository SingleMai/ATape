package authorization

import (
	"fmt"
	"testing"

	"github.com/SingleMai/ATape/server/internal/authentication"
)

func TestCatalogIsClosedAndEveryActionHasARule(t *testing.T) {
	if got, want := len(Actions()), int(actionLimit)-1; got != want {
		t.Fatalf("catalog contains %d actions, want %d", got, want)
	}
	for _, action := range Actions() {
		rule := catalog[action]
		if rule.resource == UnknownResource || rule.media == 0 {
			t.Fatalf("action %d has an incomplete rule: %+v", action, rule)
		}
	}
	unknown := Policy{}.Evaluate(Input{
		Principal: webPrincipal(true), Action: Action(255),
		Resource: ResourceFacts{Kind: InstanceResource},
	})
	assertOutcome(t, unknown, Forbid, PolicyDenied)
}

func TestCompletePermissionMatrix(t *testing.T) {
	type expectation struct {
		resource  ResourceKind
		web       bool
		cli       bool
		onlyOwner bool
		fresh     bool
	}
	matrix := map[Action]expectation{
		WorkspaceListVisible:       {resource: InstanceResource, web: true, cli: true},
		TeamCreate:                 {resource: InstanceResource, web: true},
		UserReadSelf:               {resource: UserResource, web: true, cli: true},
		UserUpdateProfile:          {resource: UserResource, web: true},
		ExternalIdentityList:       {resource: UserResource, web: true},
		ExternalIdentityBind:       {resource: UserResource, web: true, fresh: true},
		WebSessionList:             {resource: UserResource, web: true},
		WebSessionRevokeOne:        {resource: UserResource, web: true},
		WebSessionRevokeAll:        {resource: UserResource, web: true},
		CLICredentialList:          {resource: UserResource, web: true},
		CLICredentialRevokeOne:     {resource: UserResource, web: true},
		CLICredentialRevokeAll:     {resource: UserResource, web: true},
		CLICredentialReadCurrent:   {resource: UserResource, cli: true},
		CLICredentialRevokeCurrent: {resource: UserResource, cli: true},
		TeamJoinWithCode:           {resource: InstanceResource, web: true},
		TeamReadMetadata:           {resource: TeamResource, web: true, cli: true},
		ProjectListMetadata:        {resource: TeamResource, web: true, cli: true},
		ProjectReadMetadata:        {resource: ProjectResource, web: true, cli: true},
		ProjectMatch:               {resource: TeamResource, cli: true},
		MembershipList:             {resource: TeamResource, web: true},
		TeamUpdateDisplayProfile:   {resource: TeamResource, web: true, onlyOwner: true},
		MembershipPromoteToOwner:   {resource: MembershipResource, web: true, onlyOwner: true, fresh: true},
		MembershipDemoteOwner:      {resource: MembershipResource, web: true, onlyOwner: true, fresh: true},
		MembershipRemoveMember:     {resource: MembershipResource, web: true, onlyOwner: true},
		MembershipRemoveOwner:      {resource: MembershipResource, web: true, onlyOwner: true, fresh: true},
		MembershipLeaveSelf:        {resource: MembershipResource, web: true},
		TeamJoinCodeReadStatus:     {resource: TeamJoinCodeResource, web: true, onlyOwner: true},
		TeamJoinCodeRotate:         {resource: TeamJoinCodeResource, web: true, onlyOwner: true, fresh: true},
		TeamJoinCodeDisable:        {resource: TeamJoinCodeResource, web: true, onlyOwner: true},
		ProjectCreate:              {resource: TeamResource, web: true, cli: true},
		FolderProjectRename:        {resource: ProjectResource, web: true, onlyOwner: true},
		GitProjectRelinkRepository: {resource: ProjectResource, web: true, onlyOwner: true, fresh: true},
		ProjectArchive:             {resource: ProjectResource, web: true, onlyOwner: true},
		ProjectDelete:              {resource: ProjectResource, web: true, onlyOwner: true, fresh: true},
		ProjectMemoryRead:          {resource: ProjectResource, web: true},
		ConversationRead:           {resource: ConversationResource, web: true},
		ProjectSearchQuery:         {resource: ProjectResource, web: true},
		RawSessionList:             {resource: ConversationResource, web: true},
		RawObjectRead:              {resource: RawObjectResource, web: true},
		CanonicalIngest:            {resource: ProjectResource, cli: true},
		RawIngest:                  {resource: ConversationResource, cli: true},
		CapturedSessionDeleteOwn:   {resource: CapturedSessionResource, web: true},
		CapturedSessionDeleteAny:   {resource: CapturedSessionResource, web: true, onlyOwner: true, fresh: true},
	}
	if got, want := len(matrix), len(Actions()); got != want {
		t.Fatalf("permission matrix contains %d actions, want %d", got, want)
	}
	for _, action := range Actions() {
		expected, ok := matrix[action]
		if !ok {
			t.Fatalf("action %d is missing from the permission matrix", action)
		}
		for _, medium := range []struct {
			name    string
			method  authentication.AuthenticationMethod
			allowed bool
		}{
			{name: "Web", method: authentication.WebAuthentication, allowed: expected.web},
			{name: "CLI", method: authentication.CLIAuthentication, allowed: expected.cli},
		} {
			for _, role := range []MembershipRole{MemberRole, OwnerRole} {
				principal := authentication.Principal{UserID: "user-a", Method: medium.method, Fresh: true}
				resource, membership := authorizedMatrixFacts(expected.resource, role)
				decision, denial := Allow, NoDenial
				switch {
				case !medium.allowed:
					decision, denial = Forbid, CredentialCapabilityDenied
				case expected.onlyOwner && role != OwnerRole:
					decision, denial = Forbid, MembershipRoleDenied
				}
				t.Run(matrixCaseName(action, medium.name, role), func(t *testing.T) {
					assertOutcome(t, Policy{}.Evaluate(Input{
						Principal: principal, Action: action, Resource: resource, Membership: membership,
					}), decision, denial)
				})
			}
		}
		if expected.fresh {
			resource, membership := authorizedMatrixFacts(expected.resource, OwnerRole)
			assertOutcome(t, Policy{}.Evaluate(Input{
				Principal: authentication.Principal{UserID: "user-a", Method: authentication.WebAuthentication},
				Action:    action, Resource: resource, Membership: membership,
			}), Forbid, FreshAuthenticationRequired)
		}
		if expected.resource >= TeamResource {
			resource, membership := authorizedMatrixFacts(expected.resource, OwnerRole)
			resource.TeamID = "team-b"
			assertOutcome(t, Policy{}.Evaluate(Input{
				Principal: webPrincipal(true), Action: action, Resource: resource, Membership: membership,
			}), Conceal, ResourceConcealed)
			membership.Active = false
			resource.TeamID = "team-a"
			assertOutcome(t, Policy{}.Evaluate(Input{
				Principal: webPrincipal(true), Action: action, Resource: resource, Membership: membership,
			}), Conceal, ResourceConcealed)
		}
	}
}

func authorizedMatrixFacts(kind ResourceKind, role MembershipRole) (ResourceFacts, MembershipFacts) {
	resource := ResourceFacts{Kind: kind}
	membership := MembershipFacts{}
	switch kind {
	case UserResource:
		resource.OwnerUserID = "user-a"
	case TeamResource, MembershipResource, TeamJoinCodeResource, ProjectResource,
		ConversationResource, RawObjectResource, CapturedSessionResource:
		resource.TeamID = "team-a"
		resource.CapturedByUserID = "user-a"
		membership = MembershipFacts{
			TeamID: "team-a", UserID: "user-a", Role: role, Active: true,
		}
	}
	return resource, membership
}

func matrixCaseName(action Action, medium string, role MembershipRole) string {
	return fmt.Sprintf("%s/action-%d/role-%d", medium, action, role)
}

func TestInstanceAndUserResourcePolicy(t *testing.T) {
	tests := []struct {
		name      string
		action    Action
		principal authentication.Principal
		resource  ResourceFacts
		decision  Decision
		denial    Denial
	}{
		{"web lists Workspace", WorkspaceListVisible, webPrincipal(false), instance(), Allow, NoDenial},
		{"CLI lists Workspace", WorkspaceListVisible, cliPrincipal(), instance(), Allow, NoDenial},
		{"CLI cannot create Team", TeamCreate, cliPrincipal(), instance(), Forbid, CredentialCapabilityDenied},
		{"web creates Team", TeamCreate, webPrincipal(false), instance(), Allow, NoDenial},
		{"web joins with code", TeamJoinWithCode, webPrincipal(false), instance(), Allow, NoDenial},
		{"CLI cannot join with code", TeamJoinWithCode, cliPrincipal(), instance(), Forbid, CredentialCapabilityDenied},
		{"self is visible", UserReadSelf, cliPrincipal(), userResource("user-a"), Allow, NoDenial},
		{"other User is concealed", UserReadSelf, webPrincipal(true), userResource("user-b"), Conceal, ResourceConcealed},
		{"CLI profile update denied", UserUpdateProfile, cliPrincipal(), userResource("user-a"), Forbid, CredentialCapabilityDenied},
		{"bind needs fresh", ExternalIdentityBind, webPrincipal(false), userResource("user-a"), Forbid, FreshAuthenticationRequired},
		{"fresh bind allowed", ExternalIdentityBind, webPrincipal(true), userResource("user-a"), Allow, NoDenial},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertOutcome(t, Policy{}.Evaluate(Input{
				Principal: test.principal, Action: test.action, Resource: test.resource,
			}), test.decision, test.denial)
		})
	}
}

func TestTeamMatrixAndDecisionPrecedence(t *testing.T) {
	tests := []struct {
		name       string
		action     Action
		principal  authentication.Principal
		membership MembershipFacts
		resource   ResourceFacts
		decision   Decision
		denial     Denial
	}{
		{"member Web reads Project", ProjectMemoryRead, webPrincipal(false), member(), project(), Allow, NoDenial},
		{"owner Web reads Project", ProjectMemoryRead, webPrincipal(false), owner(), project(), Allow, NoDenial},
		{"CLI content is denied", ProjectMemoryRead, cliPrincipal(), member(), project(), Forbid, CredentialCapabilityDenied},
		{"CLI owner does not bypass ceiling", ProjectMemoryRead, cliPrincipal(), owner(), project(), Forbid, CredentialCapabilityDenied},
		{"CLI member ingests", CanonicalIngest, cliPrincipal(), member(), project(), Allow, NoDenial},
		{"Web owner cannot ingest", CanonicalIngest, webPrincipal(true), owner(), project(), Forbid, CredentialCapabilityDenied},
		{"member creates Project", ProjectCreate, webPrincipal(false), member(), teamResource(), Allow, NoDenial},
		{"CLI member creates Project", ProjectCreate, cliPrincipal(), member(), teamResource(), Allow, NoDenial},
		{"CLI member matches Project", ProjectMatch, cliPrincipal(), member(), teamResource(), Allow, NoDenial},
		{"Web cannot call CLI Project match", ProjectMatch, webPrincipal(true), member(), teamResource(), Forbid, CredentialCapabilityDenied},
		{"CLI member reads Project metadata", ProjectReadMetadata, cliPrincipal(), member(), project(), Allow, NoDenial},
		{"member cannot rename Team", TeamUpdateDisplayProfile, webPrincipal(true), member(), teamResource(), Forbid, MembershipRoleDenied},
		{"owner rename Team", TeamUpdateDisplayProfile, webPrincipal(false), owner(), teamResource(), Allow, NoDenial},
		{"owner relink needs fresh", GitProjectRelinkRepository, webPrincipal(false), owner(), project(), Forbid, FreshAuthenticationRequired},
		{"fresh owner relinks", GitProjectRelinkRepository, webPrincipal(true), owner(), project(), Allow, NoDenial},
		{"cross-Team object concealed before CLI ceiling", ProjectMemoryRead, cliPrincipal(), member(), ResourceFacts{Kind: ProjectResource, TeamID: "team-b"}, Conceal, ResourceConcealed},
		{"removed Membership conceals", ProjectMemoryRead, webPrincipal(true), removed(), project(), Conceal, ResourceConcealed},
		{"missing Membership conceals", ProjectMemoryRead, webPrincipal(true), MembershipFacts{}, project(), Conceal, ResourceConcealed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertOutcome(t, Policy{}.Evaluate(Input{
				Principal: test.principal, Action: test.action,
				Membership: test.membership, Resource: test.resource,
			}), test.decision, test.denial)
		})
	}
}

func TestCapturedSessionDeletionPolicy(t *testing.T) {
	owned := ResourceFacts{
		Kind: CapturedSessionResource, TeamID: "team-a", CapturedByUserID: "user-a",
	}
	other := owned
	other.CapturedByUserID = "user-b"
	assertOutcome(t, Policy{}.Evaluate(Input{
		Principal: webPrincipal(false), Action: CapturedSessionDeleteOwn,
		Membership: member(), Resource: owned,
	}), Allow, NoDenial)
	assertOutcome(t, Policy{}.Evaluate(Input{
		Principal: webPrincipal(false), Action: CapturedSessionDeleteOwn,
		Membership: member(), Resource: other,
	}), Forbid, MembershipRoleDenied)
	assertOutcome(t, Policy{}.Evaluate(Input{
		Principal: webPrincipal(false), Action: CapturedSessionDeleteAny,
		Membership: owner(), Resource: other,
	}), Forbid, FreshAuthenticationRequired)
	assertOutcome(t, Policy{}.Evaluate(Input{
		Principal: webPrincipal(true), Action: CapturedSessionDeleteAny,
		Membership: owner(), Resource: other,
	}), Allow, NoDenial)
}

func TestRawAppendRequiresTheCapturingUser(t *testing.T) {
	resource := ResourceFacts{
		Kind: ConversationResource, TeamID: "team-a", CapturedByUserID: "user-a",
	}
	assertOutcome(t, Policy{}.Evaluate(Input{
		Principal: cliPrincipal(), Action: RawIngest,
		Membership: member(), Resource: resource,
	}), Allow, NoDenial)
	other := cliPrincipal()
	other.UserID = "user-b"
	membership := member()
	membership.UserID = other.UserID
	assertOutcome(t, Policy{}.Evaluate(Input{
		Principal: other, Action: RawIngest,
		Membership: membership, Resource: resource,
	}), Forbid, MembershipRoleDenied)
}

func TestActionResourceMismatchFailsClosed(t *testing.T) {
	assertOutcome(t, Policy{}.Evaluate(Input{
		Principal: webPrincipal(true), Action: ProjectDelete,
		Membership: owner(), Resource: teamResource(),
	}), Forbid, PolicyDenied)
}

func assertOutcome(t *testing.T, outcome Outcome, decision Decision, denial Denial) {
	t.Helper()
	if outcome.Decision != decision || outcome.Denial != denial {
		t.Fatalf("outcome = %+v, want decision=%d denial=%d", outcome, decision, denial)
	}
}

func webPrincipal(fresh bool) authentication.Principal {
	return authentication.Principal{UserID: "user-a", Method: authentication.WebAuthentication, Fresh: fresh}
}

func cliPrincipal() authentication.Principal {
	return authentication.Principal{UserID: "user-a", Method: authentication.CLIAuthentication}
}

func instance() ResourceFacts { return ResourceFacts{Kind: InstanceResource} }

func userResource(userID string) ResourceFacts {
	return ResourceFacts{Kind: UserResource, OwnerUserID: userID}
}

func teamResource() ResourceFacts { return ResourceFacts{Kind: TeamResource, TeamID: "team-a"} }
func project() ResourceFacts      { return ResourceFacts{Kind: ProjectResource, TeamID: "team-a"} }

func member() MembershipFacts {
	return MembershipFacts{TeamID: "team-a", UserID: "user-a", Role: MemberRole, Active: true}
}

func owner() MembershipFacts {
	return MembershipFacts{TeamID: "team-a", UserID: "user-a", Role: OwnerRole, Active: true}
}

func removed() MembershipFacts {
	return MembershipFacts{TeamID: "team-a", UserID: "user-a", Role: MemberRole, Active: false}
}
