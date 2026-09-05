package httpapi

import (
	"errors"
	"net/http"
	"sort"
	"strings"
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
	RequestBodyPolicy      string `json:"requestBodyPolicy"`
	RequestBodyLimit       int64  `json:"requestBodyLimit"`
	CachePolicy            string `json:"cachePolicy"`
	OriginPolicy           string `json:"originPolicy"`
	FreshAuthentication    bool   `json:"freshAuthentication"`
	RequiresIdempotencyKey bool   `json:"requiresIdempotencyKey"`
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
	cache               cachePolicy
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
		{RouteSpec: RouteSpec{http.MethodGet, "/healthz", PublicProtocol}, handler: h.health, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/instance", PublicProtocol}, handler: h.instance, body: noRequestBody, cache: publicMetadata},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/auth/provider-registrations", PublicProtocol}, handler: h.providerRegistrations, body: noRequestBody, cache: publicMetadata},

		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/federated/sign-ins", PublicProtocol}, handler: h.federatedSignIn, requireOrigin: true, pragmaNoCache: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/federated/identity-bindings", WebOnly}, handler: h.federatedIdentityBinding, fresh: true, pragmaNoCache: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/federated/reauthentications", WebOnly}, handler: h.federatedReauthentication, pragmaNoCache: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/auth/github/callback", PublicProtocol}, handler: h.federatedCallback("github"), pragmaNoCache: true, body: noRequestBody, cache: noStore},

		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/auth/session", WebOnly}, handler: h.session, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/logout", WebOnly}, handler: h.logout, idempotentWebLogout: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/users/me", AnyPrincipal}, handler: h.currentUser, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPatch, "/api/v1/users/me", WebOnly}, handler: h.updateCurrentUser, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/users/me/external-identities", WebOnly}, handler: h.externalIdentities, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/users/me/web-sessions", WebOnly}, handler: h.webSessions, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/users/me/web-sessions/{sessionId}", WebOnly}, handler: h.revokeWebSession, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/users/me/web-sessions/revoke-all", WebOnly}, handler: h.revokeAllWebSessions, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/users/me/cli-credentials", WebOnly}, handler: h.cliCredentials, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/users/me/cli-credentials/{credentialId}", WebOnly}, handler: h.revokeCLICredential, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/users/me/cli-credentials/revoke-all", WebOnly}, handler: h.revokeAllCLICredentials, body: authJSONRequest, cache: noStore},

		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/device-grants", PublicProtocol}, handler: h.createCLIDeviceGrant, pragmaNoCache: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/token", PublicProtocol}, handler: h.pollCLIDeviceGrant, pragmaNoCache: true, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/device-grants/resolve", WebOnly}, handler: h.resolveCLIDeviceGrant, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/device-grants/{grantViewId}/approve", WebOnly}, handler: h.approveCLIDeviceGrant, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/auth/cli/device-grants/{grantViewId}/deny", WebOnly}, handler: h.denyCLIDeviceGrant, body: authJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/auth/cli/credentials/current", CLIOnly}, handler: h.revokeCurrentCLICredential, cliProofOnly: true, body: noRequestBody, cache: noStore},

		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/workspace", AnyPrincipal}, handler: h.workspace, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/teams", WebOnly}, handler: h.createTeam, body: controlPlaneJSONRequest, requiresIdempotency: true, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/teams/{teamSlug}", AnyPrincipal}, handler: h.openTeam, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPatch, "/api/v1/teams/{teamSlug}", WebOnly}, handler: h.updateTeam, body: controlPlaneJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/teams/{teamSlug}/members", WebOnly}, handler: h.teamMembers, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPut, "/api/v1/teams/{teamSlug}/members/{userId}/role", WebOnly}, handler: h.changeMembershipRole, body: controlPlaneJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/teams/{teamSlug}/members/{userId}", WebOnly}, handler: h.removeMembership, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/teams/{teamSlug}/leave", WebOnly}, handler: h.leaveTeam, body: controlPlaneJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/teams/{teamSlug}/join-code", WebOnly}, handler: h.joinCodeStatus, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/teams/{teamSlug}/join-code/rotations", WebOnly}, handler: h.rotateJoinCode, fresh: true, body: controlPlaneJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/teams/{teamSlug}/join-code", WebOnly}, handler: h.disableJoinCode, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/team-memberships", WebOnly}, handler: h.joinTeam, body: controlPlaneJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/project-matches", CLIOnly}, handler: h.matchProject, body: controlPlaneJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/teams/{teamSlug}/projects", AnyPrincipal}, handler: h.createProject, body: controlPlaneJSONRequest, requiresIdempotency: true, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/projects/{projectId}", AnyPrincipal}, handler: h.openProject, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPatch, "/api/v1/projects/{projectId}", WebOnly}, handler: h.renameProject, body: controlPlaneJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/projects/{projectId}/repository-relinks", WebOnly}, handler: h.relinkProject, fresh: true, body: controlPlaneJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/projects/{projectId}/archive", WebOnly}, handler: h.archiveProject, body: controlPlaneJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/projects/{projectId}", WebOnly}, handler: h.deleteProject, fresh: true, body: noRequestBody, cache: noStore},

		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/projects/{projectId}/memory", WebOnly}, handler: h.projectMemory, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/projects/{projectId}/search", WebOnly}, handler: h.projectSearch, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/sessions/{sessionId}", WebOnly}, handler: h.conversation, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodDelete, "/api/v1/sessions/{sessionId}", WebOnly}, handler: h.deleteCapturedSession, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/sessions/{sessionId}/raw", WebOnly}, handler: h.rawSession, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodGet, "/api/v1/raw-objects/{objectId}/content", WebOnly}, handler: h.rawContent, body: noRequestBody, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/ingestion/canonical/batches", CLIOnly}, handler: h.canonicalBatch, body: canonicalJSONRequest, cache: noStore},
		{RouteSpec: RouteSpec{http.MethodPost, "/api/v1/ingestion/raw/chunks", CLIOnly}, handler: h.rawChunk, body: rawJSONRequest, cache: noStore},
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
		result[index] = RouteContract{
			RouteSpec:         registered.RouteSpec,
			RequestBodyPolicy: string(registered.body), RequestBodyLimit: registered.body.limit(),
			CachePolicy: cache, OriginPolicy: origin,
			FreshAuthentication: registered.fresh, RequiresIdempotencyKey: registered.requiresIdempotency,
		}
	}
	return result
}
