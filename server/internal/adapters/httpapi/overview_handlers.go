package httpapi

import (
	"github.com/SingleMai/ATape/server/internal/teamoverview"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (h *Handler) teamOverview(w http.ResponseWriter, r *http.Request) {
	h.readTeamOverview(w, r, false)
}
func (h *Handler) teamOverviewSessions(w http.ResponseWriter, r *http.Request) {
	h.readTeamOverview(w, r, true)
}
func (h *Handler) readTeamOverview(w http.ResponseWriter, r *http.Request, sessionsOnly bool) {
	if h.overview == nil {
		writeProblem(w, r, problemServiceUnavailable, 0, nil)
		return
	}
	values := r.URL.Query()
	compact := values.Get("options") == "compact"
	if values.Get("options") != "" && !compact {
		writeError(w, r, &teamoverview.InvalidQuery{Message: "Invalid option representation."})
		return
	}
	q := teamoverview.Query{From: values.Get("from"), To: values.Get("to"), Project: values.Get("project"), Member: values.Get("member"), Agent: values.Get("agent"), Model: values.Get("model")}
	for key, dst := range map[string]*int{"days": &q.Days, "page": &q.Page, "limit": &q.Limit} {
		if value := values.Get(key); value != "" {
			parsed, err := strconv.Atoi(value)
			if err != nil {
				writeError(w, r, &teamoverview.InvalidQuery{Message: "Invalid numeric filter."})
				return
			}
			*dst = parsed
		}
	}
	if sessionsOnly {
		result, err := h.overview.OpenSessions(r.Context(), principalFromContext(r.Context()), r.PathValue("teamId"), q)
		observeOverview(w, r, result.Diagnostics, err, true)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if compact {
			writeJSON(w, r, http.StatusOK, result)
		} else {
			writeJSON(w, r, http.StatusOK, struct {
				teamoverview.SessionPage
				Options legacyOverviewOptions `json:"options"`
			}{result, legacyOptions(result.Options)})
		}
		return
	}
	result, err := h.overview.Open(r.Context(), principalFromContext(r.Context()), r.PathValue("teamId"), q)
	observeOverview(w, r, result.Diagnostics, err, false)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if compact {
		writeJSON(w, r, http.StatusOK, result)
	} else {
		writeJSON(w, r, http.StatusOK, struct {
			teamoverview.Result
			Options legacyOverviewOptions `json:"options"`
		}{result, legacyOptions(result.Options)})
	}
}

func observeOverview(w http.ResponseWriter, r *http.Request, diagnostics teamoverview.Diagnostics, err error, sessionsOnly bool) {
	stages := make(map[string]float64, len(diagnostics.Stages)+2)
	for stage, duration := range diagnostics.Stages {
		stages[stage] = float64(duration) / float64(time.Millisecond)
	}
	stages["total"] = float64(diagnostics.Total) / float64(time.Millisecond)
	stages["aggregate"] = float64(diagnostics.Aggregate) / float64(time.Millisecond)
	// Stage names are server-owned constants; no filter values or record contents
	// enter logs or headers. Total excludes authentication and JSON serialization.
	fields := make([]string, 0, len(stages))
	for stage, ms := range stages {
		fields = append(fields, stage+";dur="+strconv.FormatFloat(ms, 'f', 3, 64))
	}
	sort.Strings(fields)
	w.Header().Set("Server-Timing", strings.Join(fields, ", "))
	level := slog.LevelInfo
	if err != nil || diagnostics.Total >= time.Second {
		level = slog.LevelWarn
	}
	code := "ok"
	if err != nil {
		problem, _, _ := classifyError(err)
		code = string(problem)
	}
	slog.Log(r.Context(), level, "Team overview completed", "request_id", requestIDFromContext(r.Context()), "sessions_only", sessionsOnly, "outcome", code, "stages_ms", stages)
}

// Keep the established wire representation for clients that require statistic
// fields on filter choices. New clients explicitly select compact options.
type legacyOverviewOptions struct {
	Projects []teamoverview.Detail `json:"projects"`
	Members  []teamoverview.Detail `json:"members"`
	Agents   []string              `json:"agents"`
	Models   []string              `json:"models"`
}

func legacyOptions(options teamoverview.Options) legacyOverviewOptions {
	expand := func(values []teamoverview.Option) []teamoverview.Detail {
		rows := make([]teamoverview.Detail, len(values))
		for i, option := range values {
			rows[i] = teamoverview.Detail{ID: option.ID, Name: option.Name, Current: option.Current}
		}
		return rows
	}
	return legacyOverviewOptions{expand(options.Projects), expand(options.Members), options.Agents, options.Models}
}
