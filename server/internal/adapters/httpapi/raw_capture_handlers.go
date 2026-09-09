package httpapi

import (
	"github.com/SingleMai/ATape/server/internal/team"
	"net/http"
)

func (h *Handler) rawCaptureProject(w http.ResponseWriter, r *http.Request) {
	// Explicit development fixtures have no persisted Team/User control plane.
	if h.config.development != nil && h.teams == nil {
		writeJSON(w, r, http.StatusOK, team.RawCaptureSettings{TeamPolicy: "force", UserPreference: "disable", Enabled: true})
		return
	}
	if !h.requireTeamModule(w, r) {
		return
	}
	value, err := h.teams.RawCaptureForProject(r.Context(), principalFromContext(r.Context()), r.PathValue("projectId"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, value)
}

func (h *Handler) rawCaptureTeam(w http.ResponseWriter, r *http.Request) {
	if !h.requireTeamModule(w, r) {
		return
	}
	value, err := h.teams.RawCaptureForTeam(r.Context(), principalFromContext(r.Context()), r.PathValue("teamSlug"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, value)
}

func (h *Handler) updateRawCaptureTeam(w http.ResponseWriter, r *http.Request) {
	if !h.requireTeamModule(w, r) {
		return
	}
	var input struct {
		Policy string `json:"policy"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	value, err := h.teams.SetTeamRawCapture(r.Context(), principalFromContext(r.Context()), r.PathValue("teamSlug"), input.Policy, requestIDFromContext(r.Context()))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, value)
}

func (h *Handler) rawCaptureUser(w http.ResponseWriter, r *http.Request) {
	if !h.requireTeamModule(w, r) {
		return
	}
	value, err := h.teams.UserRawCapture(r.Context(), principalFromContext(r.Context()))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, value)
}

func (h *Handler) updateRawCaptureUser(w http.ResponseWriter, r *http.Request) {
	if !h.requireTeamModule(w, r) {
		return
	}
	var input struct {
		Preference string `json:"preference"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	value, err := h.teams.SetUserRawCapture(r.Context(), principalFromContext(r.Context()), input.Preference, requestIDFromContext(r.Context()))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, value)
}
