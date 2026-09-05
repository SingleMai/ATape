// Package httpapi translates the stable /api/v1 wire contract into calls on
// the Authentication, Team, and business Modules. It owns transport security
// and representation only; resource policy and workflows remain inside those
// Modules.
package httpapi

import (
	"errors"
	"net/http"
	"path"
	"strings"

	"github.com/SingleMai/ATape/server/internal/authcutover"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/team"
	"github.com/SingleMai/ATape/server/internal/workspace"
)

type Modules struct {
	Authentication *authentication.Module
	Teams          *team.Module
	Memory         *conversation.Memory
	Ingestor       *ingestion.Ingestor
	Searcher       *projectsearch.Searcher
	Directory      *workspace.Directory
	Raw            *rawarchive.Archive
	Cutover        *authcutover.Module
}

type Handler struct {
	auth      *authentication.Module
	teams     *team.Module
	memory    *conversation.Memory
	ingestor  *ingestion.Ingestor
	searcher  *projectsearch.Searcher
	directory *workspace.Directory
	raw       *rawarchive.Archive
	cutover   *authcutover.Module
	config    preparedConfig
	mux       *http.ServeMux
	routes    []route
	routeKeys map[string]struct{}
}

func NewHandler(config Config, modules Modules) (*Handler, error) {
	prepared, err := prepareConfig(config)
	if err != nil {
		return nil, err
	}
	if modules.Memory == nil || modules.Ingestor == nil || modules.Searcher == nil ||
		modules.Directory == nil || modules.Raw == nil {
		return nil, errors.New("HTTP Adapter requires every business Module")
	}
	if prepared.development == nil && (modules.Authentication == nil || modules.Teams == nil) {
		return nil, errors.New("HTTP Adapter requires Authentication and Team Modules")
	}
	if prepared.development == nil && modules.Cutover == nil {
		return nil, errors.New("HTTP Adapter requires the Auth Cutover Module")
	}
	handler := &Handler{
		auth: modules.Authentication, teams: modules.Teams,
		memory: modules.Memory, ingestor: modules.Ingestor, searcher: modules.Searcher,
		directory: modules.Directory, raw: modules.Raw, cutover: modules.Cutover, config: prepared,
		mux: http.NewServeMux(), routeKeys: make(map[string]struct{}),
	}
	if err := handler.registerRoutes(); err != nil {
		return nil, err
	}
	return handler, nil
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	requestID := newRequestID()
	response.Header().Set("X-Request-ID", requestID)
	response.Header().Set("X-Content-Type-Options", "nosniff")
	request = request.WithContext(withRequestID(request.Context(), requestID))
	h.applyActualCORS(response.Header(), request)
	if !canonicalRequestPath(request) {
		writeProblem(response, request, problemNotFound, 0, nil)
		return
	}

	if request.Method == http.MethodOptions && request.Header.Get("Access-Control-Request-Method") != "" {
		h.preflight(response, request)
		return
	}
	h.mux.ServeHTTP(response, request)
}

func canonicalRequestPath(request *http.Request) bool {
	if request.URL == nil || request.URL.Path == "" || request.URL.Path[0] != '/' ||
		request.URL.RawPath != "" || strings.ContainsAny(request.URL.Path, "\\\x00\r\n") {
		return false
	}
	return path.Clean(request.URL.Path) == request.URL.Path
}

func (h *Handler) health(response http.ResponseWriter, request *http.Request) {
	writeJSON(response, request, http.StatusOK, map[string]string{"status": "ok"})
}

type readinessDTO struct {
	Ready   bool                    `json:"ready"`
	Mode    authcutover.ServingMode `json:"mode"`
	Cutover *cutoverReadinessDTO    `json:"cutover,omitempty"`
}

type cutoverReadinessDTO struct {
	Protocol     string                       `json:"protocol"`
	Phase        authcutover.Phase            `json:"phase"`
	Installation authcutover.InstallationKind `json:"installation"`
}

func (h *Handler) ready(response http.ResponseWriter, request *http.Request) {
	if err := h.raw.CheckStorage(request.Context()); err != nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	if h.cutover == nil {
		writeJSON(response, request, http.StatusOK, readinessDTO{Ready: true, Mode: authcutover.NormalMode})
		return
	}
	readiness, err := h.cutover.Readiness(request.Context(), h.config.cutoverMode)
	if err != nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	if !readiness.Ready {
		writeProblem(response, request, problemCutoverIncomplete, 0, nil)
		return
	}
	writeJSON(response, request, http.StatusOK, readinessDTO{
		Ready: readiness.Ready, Mode: readiness.Mode,
		Cutover: &cutoverReadinessDTO{
			Protocol: readiness.Status.Protocol, Phase: readiness.Status.Phase,
			Installation: readiness.Status.Installation,
		},
	})
}

type instanceDocument struct {
	Protocol       string   `json:"protocol"`
	InstanceOrigin string   `json:"instance_origin"`
	WebOrigin      string   `json:"web_origin"`
	APIOrigin      string   `json:"api_origin"`
	Protocols      []string `json:"protocols"`
}

func (h *Handler) instance(response http.ResponseWriter, request *http.Request) {
	writePublicMetadata(response, request, instanceDocument{
		Protocol: "atape.instance.v1", InstanceOrigin: h.config.instanceOrigin,
		WebOrigin: h.config.webOrigin, APIOrigin: h.config.apiOrigin,
		Protocols: []string{"atape.canonical.v1", "atape.raw.v1", "atape.cli-authorization.v1"},
	})
}

func (h *Handler) providerRegistrations(response http.ResponseWriter, request *http.Request) {
	type registrationDTO struct {
		ID    string `json:"id"`
		Label string `json:"label"`
	}
	items := make([]registrationDTO, 0)
	if h.auth != nil {
		for _, registration := range h.auth.EnabledProviderRegistrations() {
			items = append(items, registrationDTO{ID: registration.ID, Label: registration.Label})
		}
	}
	writePublicMetadata(response, request, struct {
		Items []registrationDTO `json:"items"`
	}{Items: items})
}
