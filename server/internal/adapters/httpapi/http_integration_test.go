package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/adapters/rawchunks"
	"github.com/SingleMai/ATape/server/internal/authcutover"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/team"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/SingleMai/ATape/server/internal/workspace"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestHTTPAuthenticationAndAuthorizationContract(t *testing.T) {
	if testing.Short() || os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1 to run HTTP PostgreSQL integration tests")
	}
	configureHTTPDockerHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx,
		"postgres:17-alpine",
		postgrescontainer.WithDatabase("atape_http_test"),
		postgrescontainer.WithUsername("atape"),
		postgrescontainer.WithPassword("atape"),
		postgrescontainer.BasicWaitStrategies(),
		testcontainers.WithTmpfs(map[string]string{"/var/lib/postgresql/data": "rw"}),
	)
	if err != nil {
		t.Fatalf("start PostgreSQL container: %v", err)
	}
	testcontainers.CleanupContainer(t, container)
	databaseURL, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("PostgreSQL connection string: %v", err)
	}
	pool, err := postgresadapter.NewPool(databaseURL)
	if err != nil {
		t.Fatalf("construct PostgreSQL pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := postgresadapter.Prepare(ctx, pool); err != nil {
		t.Fatalf("prepare PostgreSQL: %v", err)
	}

	pepper := httpTestKeyRing(t, "pepper", 41)
	private := httpTestKeyRing(t, "private", 51)
	authenticationModule, err := authentication.New(pool, authentication.Config{
		ProviderRegistrations: []authentication.ProviderRegistration{{
			ID: "github", Label: "GitHub", Revision: "test-v1",
			ExpectedIssuer: "https://identity.example",
			CallbackURI:    "https://api.example.test/api/v1/auth/github/callback",
			Active:         true, Adapter: httpIdentityAdapter{},
		}},
		PepperKeys: pepper, PrivateStateKeys: private, Policy: authentication.DefaultPolicy(),
	})
	if err != nil {
		t.Fatalf("construct Authentication Module: %v", err)
	}
	teamModule, err := team.New(pool, team.Config{PepperKeys: pepper, Policy: team.DefaultPolicy()})
	if err != nil {
		t.Fatalf("construct Team Module: %v", err)
	}
	cutoverModule, err := authcutover.New(pool)
	if err != nil {
		t.Fatalf("construct Auth Cutover Module: %v", err)
	}
	store := postgresadapter.NewStore(pool)
	chunkStore, err := rawchunks.NewFilesystem(t.TempDir())
	if err != nil {
		t.Fatalf("construct Raw chunk store: %v", err)
	}
	archive := rawarchive.NewArchive(store, chunkStore)
	handler, err := NewHandler(Config{
		InstanceOrigin: "https://web.example.test", WebOrigin: "https://web.example.test",
		APIOrigin: "https://api.example.test", CookieDomain: "example.test",
	}, Modules{
		Authentication: authenticationModule, Teams: teamModule, Cutover: cutoverModule,
		Memory: conversation.NewMemory(store), Ingestor: ingestion.NewIngestor(store),
		Searcher: projectsearch.NewSearcher(store), Directory: workspace.NewDirectory(store), Raw: archive,
	})
	if err != nil {
		t.Fatalf("construct HTTP Adapter: %v", err)
	}
	readinessRequest := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	readinessResponse := httptest.NewRecorder()
	handler.ServeHTTP(readinessResponse, readinessRequest)
	if readinessResponse.Code != http.StatusOK ||
		!strings.Contains(readinessResponse.Body.String(), `"phase":"completed"`) ||
		!strings.Contains(readinessResponse.Body.String(), `"installation":"fresh"`) ||
		strings.Contains(readinessResponse.Body.String(), "preparedAt") ||
		strings.Contains(readinessResponse.Body.String(), "Digest") {
		t.Fatalf("fresh readiness = %d: %s", readinessResponse.Code, readinessResponse.Body.String())
	}
	registrationsRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/provider-registrations", nil)
	registrationsResponse := httptest.NewRecorder()
	handler.ServeHTTP(registrationsResponse, registrationsRequest)
	if registrationsResponse.Code != http.StatusOK ||
		!strings.Contains(registrationsResponse.Body.String(), `"id":"github","label":"GitHub"`) ||
		strings.Contains(registrationsResponse.Body.String(), "identity.example") ||
		registrationsResponse.Header().Get("Cache-Control") != "public, max-age=300" ||
		registrationsResponse.Header().Get("ETag") == "" {
		t.Fatalf("public Provider registrations = %d %#v: %s",
			registrationsResponse.Code, registrationsResponse.Header(), registrationsResponse.Body.String())
	}
	assertProtectedRouteCredentialMatrix(t, handler, "", "")

	unauthenticatedBatch := httptest.NewRequest(
		http.MethodPost, "/api/v1/ingestion/canonical/batches", strings.NewReader("not-json"),
	)
	unauthenticatedBatchResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticatedBatchResponse, unauthenticatedBatch)
	if unauthenticatedBatchResponse.Code != http.StatusUnauthorized {
		t.Fatalf("authentication-before-body status = %d: %s", unauthenticatedBatchResponse.Code, unauthenticatedBatchResponse.Body.String())
	}
	assertProblemEnvelope(t, unauthenticatedBatchResponse, "unauthenticated")

	unknownProviderRequest := jsonRequest(t, http.MethodPost, "/api/v1/auth/federated/sign-ins", map[string]any{
		"providerRegistrationId": "unknown", "returnTo": "/",
	})
	unknownProviderRequest.Header.Set("Origin", "https://web.example.test")
	unknownProviderResponse := httptest.NewRecorder()
	handler.ServeHTTP(unknownProviderResponse, unknownProviderRequest)
	if unknownProviderResponse.Code != http.StatusBadRequest {
		t.Fatalf("unknown Provider registration = %d: %s",
			unknownProviderResponse.Code, unknownProviderResponse.Body.String())
	}
	assertProblemEnvelope(t, unknownProviderResponse, "invalid_request")
	missingReturnToRequest := jsonRequest(t, http.MethodPost, "/api/v1/auth/federated/sign-ins", map[string]any{
		"providerRegistrationId": "github",
	})
	missingReturnToRequest.Header.Set("Origin", "https://web.example.test")
	missingReturnToResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingReturnToResponse, missingReturnToRequest)
	if missingReturnToResponse.Code != http.StatusBadRequest {
		t.Fatalf("missing federated returnTo = %d: %s",
			missingReturnToResponse.Code, missingReturnToResponse.Body.String())
	}
	assertProblemEnvelope(t, missingReturnToResponse, "invalid_request")

	loginRequest := jsonRequest(t, http.MethodPost, "/api/v1/auth/federated/sign-ins", map[string]any{
		"providerRegistrationId": "github", "returnTo": "/teams/acme",
	})
	loginRequest.Header.Set("Origin", "https://web.example.test")
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, loginRequest)
	if loginResponse.Code != http.StatusCreated {
		t.Fatalf("begin sign-in status = %d: %s", loginResponse.Code, loginResponse.Body.String())
	}
	loginCookie := cookieNamed(t, loginResponse.Result().Cookies(), "__Host-atape_login")
	var challenge beginFederatedResponse
	decodeResponse(t, loginResponse, &challenge)
	authorizationURI, err := url.Parse(challenge.AuthorizationURI)
	if err != nil || authorizationURI.Query().Get("state") == "" {
		t.Fatalf("invalid authorization URI %q: %v", challenge.AuthorizationURI, err)
	}

	callback := httptest.NewRequest(http.MethodGet,
		"/api/v1/auth/github/callback?state="+url.QueryEscape(authorizationURI.Query().Get("state"))+
			"&code=person-a&iss="+url.QueryEscape("https://identity.example/oauth"), nil)
	callback.AddCookie(loginCookie)
	callbackResponse := httptest.NewRecorder()
	handler.ServeHTTP(callbackResponse, callback)
	if callbackResponse.Code != http.StatusSeeOther || callbackResponse.Header().Get("Location") != "https://web.example.test/teams/acme" {
		t.Fatalf("callback = %d %q: %s", callbackResponse.Code, callbackResponse.Header().Get("Location"), callbackResponse.Body.String())
	}
	sessionCookie := cookieNamed(t, callbackResponse.Result().Cookies(), "__Secure-atape_session")
	if sessionCookie.Value == "" || !sessionCookie.Secure || sessionCookie.Domain != "example.test" {
		t.Fatalf("invalid Session Cookie: %+v", sessionCookie)
	}

	sessionRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	sessionRequest.AddCookie(sessionCookie)
	sessionResponse := httptest.NewRecorder()
	handler.ServeHTTP(sessionResponse, sessionRequest)
	if sessionResponse.Code != http.StatusOK {
		t.Fatalf("Session bootstrap status = %d: %s", sessionResponse.Code, sessionResponse.Body.String())
	}
	var session sessionDTO
	decodeResponse(t, sessionResponse, &session)
	if session.User.ID == "" || session.CSRFToken == "" || session.WebSession.ID == "" {
		t.Fatalf("incomplete Session bootstrap: %+v", session)
	}
	if sessionResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Session bootstrap cache policy = %q", sessionResponse.Header().Get("Cache-Control"))
	}

	identitiesRequest := httptest.NewRequest(http.MethodGet, "/api/v1/users/me/external-identities", nil)
	identitiesRequest.AddCookie(sessionCookie)
	identitiesResponse := httptest.NewRecorder()
	handler.ServeHTTP(identitiesResponse, identitiesRequest)
	if identitiesResponse.Code != http.StatusOK ||
		!strings.Contains(identitiesResponse.Body.String(), `"providerRegistrationId":"github"`) ||
		strings.Contains(identitiesResponse.Body.String(), "person-a") {
		t.Fatalf("External Identity projection = %d: %s", identitiesResponse.Code, identitiesResponse.Body.String())
	}

	webSessionsRequest := httptest.NewRequest(http.MethodGet, "/api/v1/users/me/web-sessions", nil)
	webSessionsRequest.AddCookie(sessionCookie)
	webSessionsResponse := httptest.NewRecorder()
	handler.ServeHTTP(webSessionsResponse, webSessionsRequest)
	if webSessionsResponse.Code != http.StatusOK ||
		!strings.Contains(webSessionsResponse.Body.String(), `"id":"`+session.WebSession.ID+`"`) ||
		!strings.Contains(webSessionsResponse.Body.String(), `"current":true`) {
		t.Fatalf("Web Session inventory = %d: %s", webSessionsResponse.Code, webSessionsResponse.Body.String())
	}

	updateProfile := jsonRequest(t, http.MethodPatch, "/api/v1/users/me", map[string]string{
		"displayName": "Updated HTTP User",
	})
	addWebProof(updateProfile, sessionCookie, session.CSRFToken)
	updateProfileResponse := httptest.NewRecorder()
	handler.ServeHTTP(updateProfileResponse, updateProfile)
	if updateProfileResponse.Code != http.StatusOK ||
		!strings.Contains(updateProfileResponse.Body.String(), `"displayName":"Updated HTTP User"`) {
		t.Fatalf("update User profile = %d: %s", updateProfileResponse.Code, updateProfileResponse.Body.String())
	}

	badCSRF := jsonRequest(t, http.MethodPost, "/api/v1/teams", map[string]any{
		"slug": "bad-csrf", "displayName": "Bad CSRF",
	})
	badCSRF.AddCookie(sessionCookie)
	badCSRF.Header.Set("Origin", "https://web.example.test")
	badCSRF.Header.Set("X-ATape-CSRF", "wrong")
	badCSRF.Header.Set("Idempotency-Key", strings.Repeat("A", 22))
	badCSRFResponse := httptest.NewRecorder()
	handler.ServeHTTP(badCSRFResponse, badCSRF)
	if badCSRFResponse.Code != http.StatusForbidden {
		t.Fatalf("wrong CSRF status = %d: %s", badCSRFResponse.Code, badCSRFResponse.Body.String())
	}
	assertProblemEnvelope(t, badCSRFResponse, "csrf_rejected")

	createTeam := jsonRequest(t, http.MethodPost, "/api/v1/teams", map[string]any{
		"slug": "acme", "displayName": "Acme",
	})
	addWebProof(createTeam, sessionCookie, session.CSRFToken)
	createTeam.Header.Set("Idempotency-Key", strings.Repeat("B", 22))
	createTeamResponse := httptest.NewRecorder()
	handler.ServeHTTP(createTeamResponse, createTeam)
	if createTeamResponse.Code != http.StatusCreated || !strings.Contains(createTeamResponse.Body.String(), `"role":"owner"`) {
		t.Fatalf("create Team status = %d: %s", createTeamResponse.Code, createTeamResponse.Body.String())
	}

	deviceRequest := jsonRequest(t, http.MethodPost, "/api/v1/auth/cli/device-grants", struct{}{})
	deviceResponse := httptest.NewRecorder()
	handler.ServeHTTP(deviceResponse, deviceRequest)
	if deviceResponse.Code != http.StatusCreated {
		t.Fatalf("create CLI authorization = %d: %s", deviceResponse.Code, deviceResponse.Body.String())
	}
	var device struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
	}
	decodeResponse(t, deviceResponse, &device)

	resolve := jsonRequest(t, http.MethodPost, "/api/v1/auth/cli/device-grants/resolve", map[string]string{"user_code": device.UserCode})
	addWebProof(resolve, sessionCookie, session.CSRFToken)
	resolveResponse := httptest.NewRecorder()
	handler.ServeHTTP(resolveResponse, resolve)
	if resolveResponse.Code != http.StatusOK {
		t.Fatalf("resolve CLI authorization = %d: %s", resolveResponse.Code, resolveResponse.Body.String())
	}
	var view struct {
		GrantViewID string `json:"grantViewId"`
	}
	decodeResponse(t, resolveResponse, &view)
	approve := jsonRequest(t, http.MethodPost, "/api/v1/auth/cli/device-grants/"+view.GrantViewID+"/approve", struct{}{})
	addWebProof(approve, sessionCookie, session.CSRFToken)
	approveResponse := httptest.NewRecorder()
	handler.ServeHTTP(approveResponse, approve)
	if approveResponse.Code != http.StatusNoContent {
		t.Fatalf("approve CLI authorization = %d: %s", approveResponse.Code, approveResponse.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_cli_device_authorizations SET next_poll_at = clock_timestamp() - interval '1 second'`); err != nil {
		t.Fatalf("advance CLI poll clock: %v", err)
	}
	poll := jsonRequest(t, http.MethodPost, "/api/v1/auth/cli/token", map[string]string{"device_code": device.DeviceCode})
	pollResponse := httptest.NewRecorder()
	handler.ServeHTTP(pollResponse, poll)
	if pollResponse.Code != http.StatusOK {
		t.Fatalf("claim CLI Credential = %d: %s", pollResponse.Code, pollResponse.Body.String())
	}
	var token struct {
		Credential   string `json:"credential"`
		CredentialID string `json:"credential_id"`
	}
	decodeResponse(t, pollResponse, &token)
	if !strings.HasPrefix(token.Credential, "atc_v1_") {
		t.Fatalf("invalid CLI Credential response")
	}

	cliCredentialsRequest := httptest.NewRequest(http.MethodGet, "/api/v1/users/me/cli-credentials", nil)
	cliCredentialsRequest.AddCookie(sessionCookie)
	cliCredentialsResponse := httptest.NewRecorder()
	handler.ServeHTTP(cliCredentialsResponse, cliCredentialsRequest)
	if cliCredentialsResponse.Code != http.StatusOK || token.CredentialID == "" ||
		!strings.Contains(cliCredentialsResponse.Body.String(), `"id":"`+token.CredentialID+`"`) ||
		strings.Contains(cliCredentialsResponse.Body.String(), token.Credential) {
		t.Fatalf("CLI Credential inventory = %d: %s", cliCredentialsResponse.Code, cliCredentialsResponse.Body.String())
	}
	for label, target := range map[string]string{
		"Web Session":    "/api/v1/users/me/web-sessions/not-a-record-id",
		"CLI Credential": "/api/v1/users/me/cli-credentials/not-a-record-id",
	} {
		revokeUnknown := httptest.NewRequest(http.MethodDelete, target, nil)
		addWebProof(revokeUnknown, sessionCookie, session.CSRFToken)
		revokeUnknownResponse := httptest.NewRecorder()
		handler.ServeHTTP(revokeUnknownResponse, revokeUnknown)
		if revokeUnknownResponse.Code != http.StatusNoContent {
			t.Fatalf("idempotent unknown %s revocation = %d: %s", label,
				revokeUnknownResponse.Code, revokeUnknownResponse.Body.String())
		}
	}

	currentUserRequest := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	currentUserRequest.Header.Set("Authorization", "Bearer "+token.Credential)
	currentUserResponse := httptest.NewRecorder()
	handler.ServeHTTP(currentUserResponse, currentUserRequest)
	if currentUserResponse.Code != http.StatusOK ||
		!strings.Contains(currentUserResponse.Body.String(), `"displayName":"Updated HTTP User"`) {
		t.Fatalf("CLI current User = %d: %s", currentUserResponse.Code, currentUserResponse.Body.String())
	}

	workspaceRequest := httptest.NewRequest(http.MethodGet, "/api/v1/workspace", nil)
	workspaceRequest.Header.Set("Authorization", "Bearer "+token.Credential)
	workspaceResponse := httptest.NewRecorder()
	handler.ServeHTTP(workspaceResponse, workspaceRequest)
	if workspaceResponse.Code != http.StatusOK || !strings.Contains(workspaceResponse.Body.String(), `"slug":"acme"`) {
		t.Fatalf("CLI Workspace = %d: %s", workspaceResponse.Code, workspaceResponse.Body.String())
	}

	createProject := jsonRequest(t, http.MethodPost, "/api/v1/teams/acme/projects", map[string]string{
		"type": "folder", "name": "HTTP captures",
	})
	createProject.Header.Set("Authorization", "Bearer "+token.Credential)
	createProject.Header.Set("Idempotency-Key", strings.Repeat("C", 22))
	createProjectResponse := httptest.NewRecorder()
	handler.ServeHTTP(createProjectResponse, createProject)
	if createProjectResponse.Code != http.StatusCreated {
		t.Fatalf("create Project = %d: %s", createProjectResponse.Code, createProjectResponse.Body.String())
	}
	var project projectDTO
	decodeResponse(t, createProjectResponse, &project)

	batch := canonicalcontract.ValidBatch()
	batch.ProjectID = project.ID
	ingest := jsonRequest(t, http.MethodPost, "/api/v1/ingestion/canonical/batches", batch)
	ingest.Header.Set("Authorization", "Bearer "+token.Credential)
	ingestResponse := httptest.NewRecorder()
	handler.ServeHTTP(ingestResponse, ingest)
	if ingestResponse.Code != http.StatusCreated {
		t.Fatalf("ingest captured Session = %d: %s", ingestResponse.Code, ingestResponse.Body.String())
	}
	var applied struct {
		SessionID string `json:"sessionId"`
	}
	decodeResponse(t, ingestResponse, &applied)
	if applied.SessionID == "" {
		t.Fatal("ingestion response omitted Session identity")
	}
	if projected, err := projectsearch.NewProjector(store, store).ProjectOnce(ctx); err != nil || projected != 2 {
		t.Fatalf("project captured Session for Search = %d, %v", projected, err)
	}

	conversationRequest := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/"+applied.SessionID, nil)
	conversationRequest.AddCookie(sessionCookie)
	conversationResponse := httptest.NewRecorder()
	handler.ServeHTTP(conversationResponse, conversationRequest)
	if conversationResponse.Code != http.StatusOK {
		t.Fatalf("read captured Session = %d: %s", conversationResponse.Code, conversationResponse.Body.String())
	}
	searchRequest := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+project.ID+"/search?q=durable", nil)
	searchRequest.AddCookie(sessionCookie)
	searchResponse := httptest.NewRecorder()
	handler.ServeHTTP(searchResponse, searchRequest)
	var searchPage projectsearch.Page
	decodeResponse(t, searchResponse, &searchPage)
	if searchResponse.Code != http.StatusOK || len(searchPage.Results) == 0 {
		t.Fatalf("Search before deletion = %d: %s", searchResponse.Code, searchResponse.Body.String())
	}
	rawSessionRequest := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/"+applied.SessionID+"/raw", nil)
	rawSessionRequest.AddCookie(sessionCookie)
	rawSessionResponse := httptest.NewRecorder()
	handler.ServeHTTP(rawSessionResponse, rawSessionRequest)
	if rawSessionResponse.Code != http.StatusOK {
		t.Fatalf("Raw manifest before deletion = %d: %s", rawSessionResponse.Code, rawSessionResponse.Body.String())
	}

	deleteSession := httptest.NewRequest(http.MethodDelete, "/api/v1/sessions/"+applied.SessionID, nil)
	addWebProof(deleteSession, sessionCookie, session.CSRFToken)
	deleteSessionResponse := httptest.NewRecorder()
	handler.ServeHTTP(deleteSessionResponse, deleteSession)
	if deleteSessionResponse.Code != http.StatusNoContent {
		t.Fatalf("delete captured Session = %d: %s", deleteSessionResponse.Code, deleteSessionResponse.Body.String())
	}
	repeatDeleteSession := httptest.NewRequest(http.MethodDelete, "/api/v1/sessions/"+applied.SessionID, nil)
	addWebProof(repeatDeleteSession, sessionCookie, session.CSRFToken)
	repeatDeleteSessionResponse := httptest.NewRecorder()
	handler.ServeHTTP(repeatDeleteSessionResponse, repeatDeleteSession)
	if repeatDeleteSessionResponse.Code != http.StatusNoContent {
		t.Fatalf("repeat captured Session deletion = %d: %s",
			repeatDeleteSessionResponse.Code, repeatDeleteSessionResponse.Body.String())
	}
	var recordState string
	var deletedAtPresent bool
	var deletedByUserID string
	if err := pool.QueryRow(ctx, `
SELECT record_state, deleted_at IS NOT NULL, deleted_by_user_id::text
FROM canonical_sessions
WHERE id = $1`, applied.SessionID).Scan(&recordState, &deletedAtPresent, &deletedByUserID); err != nil {
		t.Fatalf("read captured Session tombstone: %v", err)
	}
	if recordState != "deleted" || !deletedAtPresent || deletedByUserID != session.User.ID {
		t.Fatalf("captured Session tombstone = state %q, deletedAt %t, deletedBy %q",
			recordState, deletedAtPresent, deletedByUserID)
	}
	var deleteAuditCount int
	if err := pool.QueryRow(ctx, `
SELECT count(*)
FROM security_audit_events
WHERE action = 'captured_session.delete'
  AND target_kind = 'canonical_session'
  AND target_id = $1
  AND initiator_id = $2`, applied.SessionID, session.User.ID).Scan(&deleteAuditCount); err != nil {
		t.Fatalf("read captured Session deletion audit: %v", err)
	}
	if deleteAuditCount != 1 {
		t.Fatalf("captured Session deletion audit count = %d, want 1", deleteAuditCount)
	}
	for label, target := range map[string]string{
		"Canonical": "/api/v1/sessions/" + applied.SessionID,
		"Raw":       "/api/v1/sessions/" + applied.SessionID + "/raw",
	} {
		request := httptest.NewRequest(http.MethodGet, target, nil)
		request.AddCookie(sessionCookie)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s after deletion = %d: %s", label, response.Code, response.Body.String())
		}
		assertProblemEnvelope(t, response, "not_found")
	}
	searchAfterDelete := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+project.ID+"/search?q=durable", nil)
	searchAfterDelete.AddCookie(sessionCookie)
	searchAfterDeleteResponse := httptest.NewRecorder()
	handler.ServeHTTP(searchAfterDeleteResponse, searchAfterDelete)
	decodeResponse(t, searchAfterDeleteResponse, &searchPage)
	if searchAfterDeleteResponse.Code != http.StatusOK || len(searchPage.Results) != 0 {
		t.Fatalf("Search after deletion = %d: %s", searchAfterDeleteResponse.Code, searchAfterDeleteResponse.Body.String())
	}
	reingest := jsonRequest(t, http.MethodPost, "/api/v1/ingestion/canonical/batches", batch)
	reingest.Header.Set("Authorization", "Bearer "+token.Credential)
	reingestResponse := httptest.NewRecorder()
	handler.ServeHTTP(reingestResponse, reingest)
	if reingestResponse.Code != http.StatusConflict {
		t.Fatalf("re-ingest deleted Session = %d: %s", reingestResponse.Code, reingestResponse.Body.String())
	}
	assertProblemEnvelope(t, reingestResponse, "resource_state_conflict")

	ambiguous := httptest.NewRequest(http.MethodGet, "/api/v1/workspace", nil)
	ambiguous.AddCookie(sessionCookie)
	ambiguous.Header.Set("Authorization", "Bearer "+token.Credential)
	ambiguousResponse := httptest.NewRecorder()
	handler.ServeHTTP(ambiguousResponse, ambiguous)
	if ambiguousResponse.Code != http.StatusBadRequest {
		t.Fatalf("ambiguous credentials = %d: %s", ambiguousResponse.Code, ambiguousResponse.Body.String())
	}
	assertProblemEnvelope(t, ambiguousResponse, "ambiguous_credentials")
	if strings.Contains(ambiguousResponse.Body.String(), token.Credential) || strings.Contains(ambiguousResponse.Body.String(), sessionCookie.Value) {
		t.Fatal("Problem response reflected a credential")
	}

	webOnly := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	webOnly.Header.Set("Authorization", "Bearer "+token.Credential)
	webOnlyResponse := httptest.NewRecorder()
	handler.ServeHTTP(webOnlyResponse, webOnly)
	if webOnlyResponse.Code != http.StatusUnauthorized ||
		!strings.HasPrefix(webOnlyResponse.Header().Get("WWW-Authenticate"), "ATapeSession") {
		t.Fatalf("WebOnly medium rejection = %d %#v", webOnlyResponse.Code, webOnlyResponse.Header())
	}

	for attempt := 1; attempt <= 2; attempt++ {
		cliLogout := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/cli/credentials/current", nil)
		cliLogout.Header.Set("Authorization", "Bearer "+token.Credential)
		cliLogoutResponse := httptest.NewRecorder()
		handler.ServeHTTP(cliLogoutResponse, cliLogout)
		if cliLogoutResponse.Code != http.StatusNoContent {
			t.Fatalf("CLI logout attempt %d = %d: %s", attempt, cliLogoutResponse.Code, cliLogoutResponse.Body.String())
		}
	}
	revokedCLI := httptest.NewRequest(http.MethodGet, "/api/v1/workspace", nil)
	revokedCLI.Header.Set("Authorization", "Bearer "+token.Credential)
	revokedCLIResponse := httptest.NewRecorder()
	handler.ServeHTTP(revokedCLIResponse, revokedCLI)
	if revokedCLIResponse.Code != http.StatusUnauthorized {
		t.Fatalf("revoked CLI Credential = %d: %s", revokedCLIResponse.Code, revokedCLIResponse.Body.String())
	}
	assertProtectedRouteCredentialMatrix(t, handler, "", token.Credential)

	logout := jsonRequest(t, http.MethodPost, "/api/v1/auth/logout", struct{}{})
	addWebProof(logout, sessionCookie, session.CSRFToken)
	logoutResponse := httptest.NewRecorder()
	handler.ServeHTTP(logoutResponse, logout)
	if logoutResponse.Code != http.StatusNoContent {
		t.Fatalf("Web logout = %d: %s", logoutResponse.Code, logoutResponse.Body.String())
	}
	assertProtectedRouteCredentialMatrix(t, handler, sessionCookie.Value, "")
	repeatedLogout := jsonRequest(t, http.MethodPost, "/api/v1/auth/logout", struct{}{})
	repeatedLogout.Header.Set("Origin", "https://web.example.test")
	repeatedLogoutResponse := httptest.NewRecorder()
	handler.ServeHTTP(repeatedLogoutResponse, repeatedLogout)
	if repeatedLogoutResponse.Code != http.StatusNoContent {
		t.Fatalf("idempotent Web logout = %d: %s", repeatedLogoutResponse.Code, repeatedLogoutResponse.Body.String())
	}
}

var routeParameter = regexp.MustCompile(`\{[^/{}]+\}`)

func assertProtectedRouteCredentialMatrix(
	t *testing.T,
	handler *Handler,
	revokedWebSecret string,
	revokedCLISecret string,
) {
	t.Helper()
	for _, registered := range handler.routes {
		if registered.Class == PublicProtocol {
			continue
		}
		label := registered.Method + " " + registered.Pattern
		t.Run("route credentials/"+label, func(t *testing.T) {
			if revokedWebSecret == "" && revokedCLISecret == "" {
				assertRouteCredentialOutcome(t, handler, registered, "anonymous", "", "", expectedCredentialStatus(registered, "", ""))
				if registered.Class == WebOnly || registered.Class == AnyPrincipal {
					assertRouteCredentialOutcome(t, handler, registered, "invalid web", "ats_v1_invalid", "", expectedCredentialStatus(registered, "ats_v1_invalid", ""))
				}
				if registered.Class == CLIOnly || registered.Class == AnyPrincipal {
					assertRouteCredentialOutcome(t, handler, registered, "invalid CLI", "", "atc_v1_invalid", expectedCredentialStatus(registered, "", "atc_v1_invalid"))
				}
				assertRouteCredentialOutcome(t, handler, registered, "ambiguous", "ats_v1_invalid", "atc_v1_invalid", http.StatusBadRequest)
				return
			}
			if revokedWebSecret != "" && (registered.Class == WebOnly || registered.Class == AnyPrincipal) {
				assertRouteCredentialOutcome(t, handler, registered, "revoked web", revokedWebSecret, "", expectedCredentialStatus(registered, revokedWebSecret, ""))
			}
			if revokedCLISecret != "" && (registered.Class == CLIOnly || registered.Class == AnyPrincipal) {
				assertRouteCredentialOutcome(t, handler, registered, "revoked CLI", "", revokedCLISecret, expectedCredentialStatus(registered, "", revokedCLISecret))
			}
		})
	}
}

func assertRouteCredentialOutcome(
	t *testing.T,
	handler *Handler,
	registered route,
	caseName string,
	webSecret string,
	cliSecret string,
	want int,
) {
	t.Helper()
	var body *strings.Reader
	if registered.body == noRequestBody {
		body = strings.NewReader("")
	} else {
		body = strings.NewReader("{}")
	}
	target := routeParameter.ReplaceAllString(registered.Pattern, "fixture")
	request := httptest.NewRequest(registered.Method, target, body)
	if registered.body != noRequestBody {
		request.Header.Set("Content-Type", "application/json")
	}
	if isUnsafeMethod(registered.Method) && (registered.Class == WebOnly || registered.Class == AnyPrincipal) {
		request.Header.Set("Origin", "https://web.example.test")
	}
	if webSecret != "" {
		request.AddCookie(&http.Cookie{Name: handler.config.sessionCookie, Value: webSecret})
	}
	if cliSecret != "" {
		request.Header.Set("Authorization", "Bearer "+cliSecret)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != want {
		t.Fatalf("%s status = %d, want %d: %s", caseName, response.Code, want, response.Body.String())
	}
	if want == http.StatusUnauthorized {
		problem := "unauthenticated"
		if strings.HasPrefix(caseName, "revoked ") {
			problem = "session_revoked"
		}
		assertProblemEnvelope(t, response, problem)
	}
	if want == http.StatusBadRequest {
		assertProblemEnvelope(t, response, "ambiguous_credentials")
	}
}

func expectedCredentialStatus(registered route, webSecret string, cliSecret string) int {
	if registered.idempotentWebLogout && cliSecret == "" {
		return http.StatusNoContent
	}
	if registered.cliProofOnly && cliSecret != "" && webSecret == "" {
		return http.StatusNoContent
	}
	return http.StatusUnauthorized
}

type httpIdentityAdapter struct{}

func (httpIdentityAdapter) Begin(
	_ context.Context,
	request authentication.ProviderBeginRequest,
) (authentication.ProviderBeginResult, error) {
	authorization, _ := url.Parse("https://identity.example/authorize")
	query := authorization.Query()
	query.Set("state", request.State)
	authorization.RawQuery = query.Encode()
	return authentication.ProviderBeginResult{
		AuthorizationURI: authorization.String(), PrivateState: []byte("opaque-test-state"),
		StateSchema: "http-test-v1",
	}, nil
}

func (httpIdentityAdapter) Complete(
	_ context.Context,
	request authentication.ProviderCompleteRequest,
) (authentication.VerifiedExternalIdentity, error) {
	if request.AuthorizationServerIssuer != "https://identity.example/oauth" {
		return authentication.VerifiedExternalIdentity{}, &authentication.ProviderFailure{Code: authentication.ProviderProtocolViolation}
	}
	if request.AuthorizationError != "" {
		return authentication.VerifiedExternalIdentity{}, &authentication.ProviderFailure{Code: authentication.ProviderAccessDenied}
	}
	return authentication.VerifiedExternalIdentity{
		Issuer: "https://identity.example", Subject: request.AuthorizationCode,
		DisplayName: "HTTP Test User", AvatarURL: "https://identity.example/avatar.png",
	}, nil
}

func httpTestKeyRing(t *testing.T, id string, fill byte) authentication.KeyRing {
	t.Helper()
	ring, err := authentication.NewKeyRing(id, []authentication.KeyMaterial{{
		ID: id, Material: bytes.Repeat([]byte{fill}, 32),
	}})
	if err != nil {
		t.Fatalf("construct test Key Ring: %v", err)
	}
	return ring
}

func jsonRequest(t *testing.T, method string, target string, value any) *http.Request {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response: %v: %s", err, response.Body.String())
	}
}

func cookieNamed(t *testing.T, cookies []*http.Cookie, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range cookies {
		if cookie.Name == name && cookie.Value != "" {
			return cookie
		}
	}
	t.Fatalf("Cookie %q not found in %+v", name, cookies)
	return nil
}

func addWebProof(request *http.Request, cookie *http.Cookie, csrf string) {
	request.AddCookie(cookie)
	request.Header.Set("Origin", "https://web.example.test")
	request.Header.Set("X-ATape-CSRF", csrf)
}

func configureHTTPDockerHost(t *testing.T) {
	t.Helper()
	if os.Getenv("DOCKER_HOST") != "" {
		return
	}
	output, err := exec.Command("docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}").Output()
	if err == nil {
		if host := strings.TrimSpace(string(output)); host != "" {
			t.Setenv("DOCKER_HOST", host)
		}
	}
}
