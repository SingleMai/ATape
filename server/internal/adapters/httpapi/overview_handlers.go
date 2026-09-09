package httpapi

import (
	"github.com/SingleMai/ATape/server/internal/teamoverview"
	"net/http"
	"strconv"
)

func (h *Handler) teamOverview(w http.ResponseWriter, r *http.Request) {
	if h.overview == nil {
		writeProblem(w, r, problemServiceUnavailable, 0, nil)
		return
	}
	values := r.URL.Query()
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
	result, err := h.overview.Open(r.Context(), principalFromContext(r.Context()), r.PathValue("teamId"), q)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}
