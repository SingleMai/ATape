package httpapi

import (
	"net/http"

	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
)

func (h *Handler) sessionAnalytics(w http.ResponseWriter, r *http.Request) {
	h.readSessionAnalytics(w, r, false)
}

func (h *Handler) sessionAnalyticsEvidence(w http.ResponseWriter, r *http.Request) {
	h.readSessionAnalytics(w, r, true)
}

func (h *Handler) readSessionAnalytics(w http.ResponseWriter, r *http.Request, evidence bool) {
	values, ok := strictQuery(w, r, "snapshot", "metric", "thread", "tool", "cursor", "limit")
	if !ok {
		return
	}
	if evidence && !values.Has("snapshot") {
		writeProblem(w, r, problemInvalidRequest, 0, nil)
		return
	}
	limit, ok := queryInteger(w, r, values, "limit", 0)
	if !ok {
		return
	}
	if values.Has("limit") && limit == 0 {
		writeError(w, r, &sessionanalytics.InvalidQueryError{Field: "limit", Reason: "must be between 1 and 100"})
		return
	}
	if h.analytics == nil {
		writeProblem(w, r, problemServiceUnavailable, 0, nil)
		return
	}
	result, err := h.analytics.Open(r.Context(), principalFromContext(r.Context()), r.PathValue("sessionId"), sessionanalytics.Query{
		Snapshot: values.Get("snapshot"), Metric: values.Get("metric"), Thread: values.Get("thread"),
		Tool: values.Get("tool"), Cursor: values.Get("cursor"), Limit: limit,
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}
