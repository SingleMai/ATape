package httpapi

import (
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/SingleMai/ATape/server/internal/authorization"
)

type RouteClass string

const (
	PublicProtocol RouteClass = "public_protocol"
	AnyPrincipal   RouteClass = "any_principal"
	WebOnly        RouteClass = "web_only"
	CLIOnly        RouteClass = "cli_only"
)

type RouteSpec struct {
	Method  string     `json:"method"`
	Pattern string     `json:"pattern"`
	Class   RouteClass `json:"class"`
}

type RouteContract struct {
	RouteSpec
	RequestBodyPolicy      string   `json:"requestBodyPolicy"`
	RequestBodyLimit       int64    `json:"requestBodyLimit"`
	CachePolicy            string   `json:"cachePolicy"`
	OriginPolicy           string   `json:"originPolicy"`
	FreshAuthentication    bool     `json:"freshAuthentication"`
	RequiresIdempotencyKey bool     `json:"requiresIdempotencyKey"`
	AuthorizationActions   []string `json:"authorizationActions"`
}

type requestBodyPolicy string

const (
	noRequestBody           requestBodyPolicy = "none"
	authJSONRequest         requestBodyPolicy = "json-auth"
	controlPlaneJSONRequest requestBodyPolicy = "json-control-plane"
	canonicalJSONRequest    requestBodyPolicy = "json-canonical"
	rawJSONRequest          requestBodyPolicy = "json-raw"
)

func (policy requestBodyPolicy) limit() int64 {
	switch policy {
	case noRequestBody:
		return 0
	case authJSONRequest:
		return authBodyLimit
	case controlPlaneJSONRequest:
		return controlPlaneBodyLimit
	case canonicalJSONRequest:
		return canonicalBodyLimit
	case rawJSONRequest:
		return rawBodyLimit
	default:
		return -1
	}
}

type cachePolicy uint8

const (
	noStore cachePolicy = iota + 1
	publicMetadata
)

type route struct {
	RouteSpec
	handler             http.HandlerFunc
	fresh               bool
	requireOrigin       bool
	pragmaNoCache       bool
	idempotentWebLogout bool
	cliProofOnly        bool
	body                requestBodyPolicy
	requiresIdempotency bool
	bootstrapAllowed    bool
	cache               cachePolicy
	actions             []authorization.Action
}

func (h *Handler) register(candidate route) error {
	if candidate.Method == "" || candidate.Pattern == "" || candidate.handler == nil {
		return errors.New("HTTP route is incomplete")
	}
	switch candidate.Class {
	case PublicProtocol, AnyPrincipal, WebOnly, CLIOnly:
	default:
		return errors.New("HTTP route must declare exactly one access class")
	}
	if candidate.cache == 0 {
		return errors.New("HTTP route must declare a cache policy")
	}
	if candidate.body.limit() < 0 {
		return errors.New("HTTP route must declare a request body policy")
	}
	if candidate.idempotentWebLogout && (candidate.Class != WebOnly || candidate.Method != http.MethodPost) {
		return errors.New("idempotent Web logout must be a WebOnly POST route")
	}
	if candidate.cliProofOnly && (candidate.Class != CLIOnly || candidate.Method != http.MethodDelete) {
		return errors.New("CLI proof-only operation must be a CLIOnly DELETE route")
	}
	seenActions := make(map[authorization.Action]struct{}, len(candidate.actions))
	for _, action := range candidate.actions {
		if action.String() == "unknown" {
			return errors.New("HTTP route declares an unknown authorization action")
		}
		if _, duplicate := seenActions[action]; duplicate {
			return errors.New("HTTP route duplicates an authorization action")
		}
		seenActions[action] = struct{}{}
	}
	if candidate.Class == PublicProtocol && len(candidate.actions) != 0 {
		return errors.New("public HTTP route cannot declare authorization actions")
	}
	key := candidate.Method + " " + candidate.Pattern
	if _, duplicate := h.routeKeys[key]; duplicate {
		return errors.New("HTTP route is duplicated")
	}
	h.routeKeys[key] = struct{}{}
	h.routes = append(h.routes, candidate)
	h.mux.Handle(key, h.dispatch(candidate))
	return nil
}

func (h *Handler) registerRoutes() error {
	routes := []route{
		{RouteSpec: RouteSpec{http.MethodGet, "/healthz", PublicProtocol}, handler: h.health, bootstrapAllowed: true, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/readyz", PublicProtocol}, handler: h.ready, bootstrapAllowed: true, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/instance", PublicProtocol}, handler: h.instance, bootstrapAllowed: true, body: noRequestBody, cache: publicMetadata},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/auth/provider-registrations", PublicProtocol}, handler: h.providerRegistrations, bootstrapAllowed: true, body: noRequestBody, cache: publicMetadata},

		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/federated/sign-ins", PublicProtocol}, handler: h.federatedSignIn, bootstrapAllowed: true, requireOrigin: true, pragmaNoCache: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/federated/identity-bindings", WebOnly}, handler: h.federatedIdentityBinding, bootstrapAllowed: true, fresh: true, pragmaNoCache: true, body: authJSONRequest, cache: noStore, actions: []authorization.Action{authorization.ExternalIdentityBind}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/federated/reauthentications", WebOnly}, handler: h.federatedReauthentication, bootstrapAllowed: true, pragmaNoCache: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/auth/github/callback", PublicProtocol}, handler: h.federatedCallback("github"), bootstrapAllowed: true, pragmaNoCache: true, body: noRequestBody, cache: noStore},

		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/auth/session", WebOnly}, handler: h.session, bootstrapAllowed: true, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.UserReadSelf}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/logout", WebOnly}, handler: h.logout, bootstrapAllowed: true, idempotentWebLogout: true, body: authJSONRequest, cache: noStore, actions: []authorization.Action{authorization.WebSessionRevokeOne}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/users/me", AnyPrincipal}, handler: h.currentUser, bootstrapAllowed: true, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.UserReadSelf}},
		{RouteSpec: RouteSpec{http.MethodPatch, "/api/v1/users/me", WebOnly}, handler: h.updateCurrentUser, bootstrapAllowed: true, body: authJSONRequest, cache: noStore, actions: []authorization.Action{authorization.UserUpdateProfile}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/users/me/external-identities", WebOnly}, handler: h.externalIdentities, bootstrapAllowed: true, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.ExternalIdentityList}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/users/me/web-sessions", WebOnly}, handler: h.webSessions, bootstrapAllowed: true, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.WebSessionList}},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/users/me/web-sessions/{sessionId}", WebOnly}, handler: h.revokeWebSession, bootstrapAllowed: true, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.WebSessionRevokeOne}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/users/me/web-sessions/revoke-all", WebOnly}, handler: h.revokeAllWebSessions, bootstrapAllowed: true, body: authJSONRequest, cache: noStore, actions: []authorization.Action{authorization.WebSessionRevokeAll}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/users/me/cli-credentials", WebOnly}, handler: h.cliCredentials, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.CLICredentialList}},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/users/me/cli-credentials/{credentialId}", WebOnly}, handler: h.revokeCLICredential, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.CLICredentialRevokeOne}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/users/me/cli-credentials/revoke-all", WebOnly}, handler: h.revokeAllCLICredentials, body: authJSONRequest, cache: noStore, actions: []authorization.Action{authorization.CLICredentialRevokeAll}},

		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/device-grants", PublicProtocol}, handler: h.createCLIDeviceGrant, pragmaNoCache: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/token", PublicProtocol}, handler: h.pollCLIDeviceGrant, pragmaNoCache: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/device-grants/resolve", WebOnly}, handler: h.resolveCLIDeviceGrant, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/device-grants/{grantViewId}/approve", WebOnly}, handler: h.approveCLIDeviceGrant, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/device-grants/{grantViewId}/deny", WebOnly}, handler: h.denyCLIDeviceGrant, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/auth/cli/credentials/current", CLIOnly}, handler: h.revokeCurrentCLICredential, cliProofOnly: true, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.CLICredentialReadCurrent, authorization.CLICredentialRevokeCurrent}},

		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/workspace", AnyPrincipal}, handler: h.workspace, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.WorkspaceListVisible, authorization.TeamReadMetadata, authorization.ProjectListMetadata}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/teams", WebOnly}, handler: h.createTeam, body: controlPlaneJSONRequest, requiresIdempotency: true, cache: noStore, actions: []authorization.Action{authorization.TeamCreate}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/teams/{teamSlug}", AnyPrincipal}, handler: h.openTeam, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.TeamReadMetadata}},
		{RouteSpec: RouteSpec{http.MethodPatch, "/api/v1/teams/{teamSlug}", WebOnly}, handler: h.updateTeam, body: controlPlaneJSONRequest, cache: noStore, actions: []authorization.Action{authorization.TeamUpdateDisplayProfile}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/teams/{teamSlug}/members", WebOnly}, handler: h.teamMembers, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.MembershipList}},
		{RouteSpec: RouteSpec{http.MethodPut, "/api/v1/teams/{teamSlug}/members/{userId}/role", WebOnly}, handler: h.changeMembershipRole, body: controlPlaneJSONRequest, cache: noStore, actions: []authorization.Action{authorization.MembershipPromoteToOwner, authorization.MembershipDemoteOwner}},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/teams/{teamSlug}/members/{userId}", WebOnly}, handler: h.removeMembership, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.MembershipRemoveMember, authorization.MembershipRemoveOwner}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/teams/{teamSlug}/leave", WebOnly}, handler: h.leaveTeam, body: controlPlaneJSONRequest, cache: noStore, actions: []authorization.Action{authorization.MembershipLeaveSelf}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/teams/{teamSlug}/join-code", WebOnly}, handler: h.joinCodeStatus, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.TeamJoinCodeReadStatus}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/teams/{teamSlug}/join-code/rotations", WebOnly}, handler: h.rotateJoinCode, fresh: true, body: controlPlaneJSONRequest, cache: noStore, actions: []authorization.Action{authorization.TeamJoinCodeRotate}},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/teams/{teamSlug}/join-code", WebOnly}, handler: h.disableJoinCode, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.TeamJoinCodeDisable}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/team-memberships", WebOnly}, handler: h.joinTeam, body: controlPlaneJSONRequest, cache: noStore, actions: []authorization.Action{authorization.TeamJoinWithCode}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/project-matches", CLIOnly}, handler: h.matchProject, body: controlPlaneJSONRequest, cache: noStore, actions: []authorization.Action{authorization.ProjectMatch}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/teams/{teamSlug}/projects", AnyPrincipal}, handler: h.createProject, body: controlPlaneJSONRequest, requiresIdempotency: true, cache: noStore, actions: []authorization.Action{authorization.ProjectCreate}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/projects/{projectId}", AnyPrincipal}, handler: h.openProject, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.ProjectReadMetadata}},
		{RouteSpec: RouteSpec{http.MethodPatch, "/api/v1/projects/{projectId}", WebOnly}, handler: h.renameProject, body: controlPlaneJSONRequest, cache: noStore, actions: []authorization.Action{authorization.FolderProjectRename}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/projects/{projectId}/repository-relinks", WebOnly}, handler: h.relinkProject, fresh: true, body: controlPlaneJSONRequest, cache: noStore, actions: []authorization.Action{authorization.GitProjectRelinkRepository}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/projects/{projectId}/archive", WebOnly}, handler: h.archiveProject, body: controlPlaneJSONRequest, cache: noStore, actions: []authorization.Action{authorization.ProjectArchive}},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/projects/{projectId}", WebOnly}, handler: h.deleteProject, fresh: true, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.ProjectDelete}},

		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/projects/{projectId}/memory", WebOnly}, handler: h.projectMemory, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.ProjectMemoryRead}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/projects/{projectId}/search", WebOnly}, handler: h.projectSearch, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.ProjectSearchQuery}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/sessions/{sessionId}", WebOnly}, handler: h.conversation, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.ConversationRead}},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/sessions/{sessionId}", WebOnly}, handler: h.deleteCapturedSession, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.CapturedSessionDeleteOwn, authorization.CapturedSessionDeleteAny}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/sessions/{sessionId}/raw", WebOnly}, handler: h.rawSession, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.RawSessionList}},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/raw-objects/{objectId}/content", WebOnly}, handler: h.rawContent, body: noRequestBody, cache: noStore, actions: []authorization.Action{authorization.RawObjectRead}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/ingestion/canonical/batches", CLIOnly}, handler: h.canonicalBatch, body: canonicalJSONRequest, cache: noStore, actions: []authorization.Action{authorization.CanonicalIngest}},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/ingestion/raw/chunks", CLIOnly}, handler: h.rawChunk, body: rawJSONRequest, cache: noStore, actions: []authorization.Action{authorization.RawIngest}},
	}
	for _, candidate := range routes {
		if err := h.register(candidate); err != nil {
			return err
		}
	}
	h.mux.HandleFunc("/", h.unmatchedRoute)
	sort.Slice(h.routes, func(left, right int) bool {
		if h.routes[left].Pattern == h.routes[right].Pattern {
			return h.routes[left].Method < h.routes[right].Method
		}
		return h.routes[left].Pattern < h.routes[right].Pattern
	})
	return nil
}

func (h *Handler) unmatchedRoute(response http.ResponseWriter, request *http.Request) {
	allowed := make(map[string]struct{})
	for _, registered := range h.routes {
		probe := request.Clone(request.Context())
		probe.Method = registered.Method
		_, pattern := h.mux.Handler(probe)
		if pattern == "" || pattern == "/" {
			continue
		}
		allowed[registered.Method] = struct{}{}
		if registered.Method == http.MethodGet {
			allowed[http.MethodHead] = struct{}{}
		}
	}
	if len(allowed) == 0 {
		writeProblem(response, request, problemNotFound, 0, nil)
		return
	}
	methods := make([]string, 0, len(allowed))
	for method := range allowed {
		methods = append(methods, method)
	}
	sort.Strings(methods)
	response.Header().Set("Allow", strings.Join(methods, ", "))
	writeProblem(response, request, problemMethodNotAllowed, 0, nil)
}

func (h *Handler) RouteInventory() []RouteContract {
	result := make([]RouteContract, len(h.routes))
	for index, registered := range h.routes {
		cache := "no-store"
		if registered.cache == publicMetadata {
			cache = "public-300"
		}
		origin := "none"
		switch {
		case registered.requireOrigin || (isUnsafeMethod(registered.Method) && registered.Class == WebOnly):
			origin = "exact-web"
		case isUnsafeMethod(registered.Method) && registered.Class == AnyPrincipal:
			origin = "exact-web-when-cookie"
		}
		actions := make([]string, len(registered.actions))
		for actionIndex, action := range registered.actions {
			actions[actionIndex] = action.String()
		}
		result[index] = RouteContract{
			RouteSpec:         registered.RouteSpec,
			RequestBodyPolicy: string(registered.body), RequestBodyLimit: registered.body.limit(),
			CachePolicy: cache, OriginPolicy: origin,
			FreshAuthentication: registered.fresh, RequiresIdempotencyKey: registered.requiresIdempotency,
			AuthorizationActions: actions,
		}
	}
	return result
}
