package httpapi

import (
	"net/url"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/team"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Give expanded native contracts their own account and quota through the real
// authentication and Team Interfaces. Unexpired publication reservations belong
// to a User, so independent Providers must not exhaust each other's fixture quota.
func nativeCollectorActor(t *testing.T, modules Modules, pool *pgxpool.Pool, provider string) (team.Project, authentication.WebSessionGrant, string) {
	t.Helper()
	ctx := t.Context()
	challenge, err := modules.Authentication.BeginFederatedLogin(ctx, authentication.BeginFederatedLoginInput{
		Intent: authentication.SignInIntent, ProviderRegistrationID: "github", ReturnTo: "/", RequestID: provider + "-sign-in",
	})
	if err != nil {
		t.Fatal(err)
	}
	authorization, err := url.Parse(challenge.AuthorizationURI)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := modules.Authentication.CompleteFederatedLogin(ctx, authentication.CompleteFederatedLoginInput{
		ProviderRegistrationID: "github", State: authorization.Query().Get("state"), BrowserBinding: challenge.BrowserBinding,
		AuthorizationServerIssuer: "https://identity.example/oauth", AuthorizationCode: provider + "-collector-user", RequestID: provider + "-sign-in-complete",
	})
	if err != nil {
		t.Fatal(err)
	}
	web, err := modules.Authentication.AuthenticateWeb(ctx, grant.SessionSecret)
	if err != nil {
		t.Fatal(err)
	}
	created, err := modules.Teams.CreateTeam(ctx, team.CreateTeamInput{
		Principal: web.Principal, Slug: provider + "-contract", DisplayName: provider + " contract", OperationKey: strings.Repeat("K", 22), RequestID: provider + "-team",
	})
	if err != nil {
		t.Fatal(err)
	}
	project, err := modules.Teams.CreateProject(ctx, team.CreateProjectInput{
		Principal: web.Principal, TeamSlug: created.Team.Slug, Spec: team.ProjectSpec{Type: team.FolderProject, Name: provider + " native history"},
		OperationKey: strings.Repeat("P", 22), RequestID: provider + "-project",
	})
	if err != nil {
		t.Fatal(err)
	}
	device, err := modules.Authentication.CreateCLIDeviceAuthorization(ctx)
	if err != nil {
		t.Fatal(err)
	}
	view, err := modules.Authentication.ResolveCLIDeviceAuthorization(ctx, web.Principal, device.UserCode, provider+"-cli-resolve")
	if err != nil {
		t.Fatal(err)
	}
	if err := modules.Authentication.DecideCLIDeviceAuthorization(ctx, web.Principal, view.ID, authentication.ApproveCLI, provider+"-cli-approve"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_cli_device_authorizations SET next_poll_at=clock_timestamp()-interval '1 second' WHERE id=$1`, device.ID); err != nil {
		t.Fatal(err)
	}
	credential, err := modules.Authentication.PollCLIDeviceAuthorization(ctx, device.DeviceCode, provider+"-cli-poll")
	if err != nil {
		t.Fatal(err)
	}
	return project, grant, credential.CredentialSecret
}
