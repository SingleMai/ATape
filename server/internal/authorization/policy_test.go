package authorization

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
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
		if action.String() == "unknown" {
			t.Fatalf("action %d has no stable inventory name", action)
		}
	}
	if got, want := len(ActionInventory()), len(Actions()); got != want {
		t.Fatalf("named action inventory contains %d actions, want %d", got, want)
	}
	unknown := Policy{}.Evaluate(Input{
		Principal: webPrincipal(true), Action: Action(255),
		Resource: ResourceFacts{Kind: InstanceResource},
	})
	assertOutcome(t, unknown, Forbid, PolicyDenied)
}

func TestCompletePermissionMatrix(t *testing.T) {
	matrix := readAuthorizationMatrix(t)
	if matrix.Protocol != "atape.authorization-matrix.v1" || matrix.AuthEpoch != "auth-v1" {
		t.Fatalf("authorization matrix identity = %q/%q", matrix.Protocol, matrix.AuthEpoch)
	}
	expectedPersonas := []string{
		"alice_web_member_stale", "alice_web_member_fresh",
		"alice_web_owner_stale", "alice_web_owner_fresh",
		"alice_cli_member", "alice_cli_owner", "eve_web_fresh",
	}
	assertStringList(t, "personas", matrix.Personas, expectedPersonas)

	actionsByName := make(map[string]Action, len(Actions()))
	for _, action := range Actions() {
		actionsByName[action.String()] = action
	}
	seenActions := make(map[Action]struct{}, len(matrix.Actions))
	usedProfiles := make(map[string]struct{}, len(matrix.Profiles))
	for _, entry := range matrix.Actions {
		action, ok := actionsByName[entry.Action]
		if !ok {
			t.Fatalf("matrix declares unknown action %q", entry.Action)
		}
		if _, duplicate := seenActions[action]; duplicate {
			t.Fatalf("matrix repeats action %q", entry.Action)
		}
		seenActions[action] = struct{}{}
		resource := matrixResourceKind(t, entry.Resource)
		if catalog[action].resource != resource {
			t.Fatalf("matrix resource for %q = %q, policy uses %d", entry.Action, entry.Resource, catalog[action].resource)
		}
		profile, ok := matrix.Profiles[entry.Profile]
		if !ok {
			t.Fatalf("action %q references unknown profile %q", entry.Action, entry.Profile)
		}
		usedProfiles[entry.Profile] = struct{}{}
		assertProfilePersonas(t, entry.Profile, profile, expectedPersonas)
		for _, persona := range expectedPersonas {
			t.Run(entry.Action+"/"+persona, func(t *testing.T) {
				input := matrixPolicyInput(t, persona, resource)
				input.Action = action
				if got, want := matrixOutcome(Policy{}.Evaluate(input)), profile[persona]; got != want {
					t.Fatalf("policy outcome = %q, matrix requires %q", got, want)
				}
			})
		}
	}
	if len(seenActions) != len(actionsByName) {
		t.Fatalf("matrix covers %d actions, closed catalog contains %d", len(seenActions), len(actionsByName))
	}
	if len(usedProfiles) != len(matrix.Profiles) {
		t.Fatalf("matrix uses %d profiles, declares %d", len(usedProfiles), len(matrix.Profiles))
	}
}

type authorizationMatrix struct {
	Protocol  string                       `json:"protocol"`
	AuthEpoch string                       `json:"authEpoch"`
	Personas  []string                     `json:"personas"`
	Profiles  map[string]map[string]string `json:"profiles"`
	Actions   []authorizationMatrixAction  `json:"actions"`
}

type authorizationMatrixAction struct {
	Action   string `json:"action"`
	Resource string `json:"resource"`
	Profile  string `json:"profile"`
}

func readAuthorizationMatrix(t *testing.T) authorizationMatrix {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve authorization matrix test source")
	}
	file, err := os.Open(filepath.Join(filepath.Dir(source), "..", "..", "..", "specs", "auth-v1-authorization-matrix.json"))
	if err != nil {
		t.Fatalf("open authorization matrix: %v", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var matrix authorizationMatrix
	if err := decoder.Decode(&matrix); err != nil {
		t.Fatalf("decode authorization matrix: %v", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("authorization matrix has trailing content: %v", err)
	}
	return matrix
}

func assertStringList(t *testing.T, label string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s length = %d, want %d", label, len(got), len(want))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("%s[%d] = %q, want %q", label, index, got[index], want[index])
		}
	}
}

func assertProfilePersonas(t *testing.T, name string, profile map[string]string, personas []string) {
	t.Helper()
	if len(profile) != len(personas) {
		t.Fatalf("profile %q contains %d personas, want %d", name, len(profile), len(personas))
	}
	for _, persona := range personas {
		outcome, ok := profile[persona]
		if !ok {
			t.Fatalf("profile %q omits persona %q", name, persona)
		}
		switch outcome {
		case "allow", "conceal", "forbid_policy", "forbid_capability", "forbid_role", "forbid_fresh":
		default:
			t.Fatalf("profile %q has unknown outcome %q for %q", name, outcome, persona)
		}
	}
}

func matrixResourceKind(t *testing.T, name string) ResourceKind {
	t.Helper()
	switch name {
	case "instance":
		return InstanceResource
	case "user":
		return UserResource
	case "team":
		return TeamResource
	case "membership":
		return MembershipResource
	case "team_join_code":
		return TeamJoinCodeResource
	case "project":
		return ProjectResource
	case "conversation":
		return ConversationResource
	case "raw_object":
		return RawObjectResource
	case "captured_session":
		return CapturedSessionResource
	default:
		t.Fatalf("matrix declares unknown resource %q", name)
		return UnknownResource
	}
}

func matrixPolicyInput(t *testing.T, persona string, kind ResourceKind) Input {
	t.Helper()
	principal := authentication.Principal{UserID: "user-a", Method: authentication.WebAuthentication}
	role := MemberRole
	switch persona {
	case "alice_web_member_stale":
	case "alice_web_member_fresh":
		principal.Fresh = true
	case "alice_web_owner_stale":
		role = OwnerRole
	case "alice_web_owner_fresh":
		principal.Fresh = true
		role = OwnerRole
	case "alice_cli_member":
		principal.Method = authentication.CLIAuthentication
	case "alice_cli_owner":
		principal.Method = authentication.CLIAuthentication
		role = OwnerRole
	case "eve_web_fresh":
		principal.UserID = "user-eve"
		principal.Fresh = true
	default:
		t.Fatalf("unknown matrix persona %q", persona)
	}
	resource := ResourceFacts{Kind: kind}
	membership := MembershipFacts{}
	switch kind {
	case UserResource:
		resource.OwnerUserID = "user-a"
	case TeamResource, MembershipResource, TeamJoinCodeResource, ProjectResource,
		ConversationResource, RawObjectResource, CapturedSessionResource:
		resource.TeamID = "team-a"
		resource.CapturedByUserID = "user-a"
		if principal.UserID == "user-a" {
			membership = MembershipFacts{TeamID: "team-a", UserID: "user-a", Role: role, Active: true}
		}
	}
	return Input{Principal: principal, Resource: resource, Membership: membership}
}

func matrixOutcome(outcome Outcome) string {
	if outcome.Decision == Allow {
		return "allow"
	}
	if outcome.Decision == Conceal {
		return "conceal"
	}
	switch outcome.Denial {
	case PolicyDenied:
		return "forbid_policy"
	case CredentialCapabilityDenied:
		return "forbid_capability"
	case MembershipRoleDenied:
		return "forbid_role"
	case FreshAuthenticationRequired:
		return "forbid_fresh"
	default:
		return "unknown"
	}
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
