package httpapi

import (
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
)

func (h *Handler) sessionAnalytics(w http.ResponseWriter, r *http.Request) {
	h.readSessionAnalytics(w, r, false)
}

func (h *Handler) sessionAnalyticsEvidence(w http.ResponseWriter, r *http.Request) {
	h.readSessionAnalytics(w, r, true)
}

func (h *Handler) readSessionAnalytics(w http.ResponseWriter, r *http.Request, evidence bool) {
	appendVary(w.Header(), "Accept")
	version, validAccept := analyticsVersion(r.Header.Values("Accept"))
	if !validAccept {
		writeProblem(w, r, problemInvalidRequest, 0, nil)
		return
	}
	queryFields := []string{"snapshot", "metric", "thread", "tool", "capability", "server", "cursor", "limit", "range"}
	if version >= sessionanalytics.StableToolVersion {
		queryFields = append(queryFields, "file", "operation")
	}
	if version >= sessionanalytics.TokenActivityVersion {
		queryFields = append(queryFields, "model", "tokenRange")
	}
	values, ok := strictQuery(w, r, queryFields...)
	if !ok {
		return
	}
	for _, value := range values {
		if !utf8.ValidString(value[0]) {
			writeProblem(w, r, problemInvalidRequest, 0, nil)
			return
		}
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
		Tool: values.Get("tool"), Capability: values.Get("capability"), Server: values.Get("server"), Cursor: values.Get("cursor"), Limit: limit,
		AnalyticsVersion: version, Range: values.Get("range"), File: values.Get("file"), Operation: values.Get("operation"),
		Model: values.Get("model"), TokenRange: values.Get("tokenRange"),
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

// The standard safelisted Accept header allows one request to an older Server:
// it can ignore this vendor range and return its existing JSON representation.
func analyticsVersion(values []string) (int, bool) {
	version, size := sessionanalytics.Version, 0
	for _, field := range values {
		size += len(field)
		if size > 4096 {
			return 0, false
		}
		for _, item := range strings.Split(field, ",") {
			raw := strings.ToLower(strings.TrimSpace(strings.SplitN(item, ";", 2)[0]))
			selected := 0
			switch raw {
			case "application/vnd.atape.session-analytics.v3+json":
				selected = sessionanalytics.ActivityVersion
			case "application/vnd.atape.session-analytics.v4+json":
				selected = sessionanalytics.StableToolVersion
			case "application/vnd.atape.session-analytics.v5+json":
				selected = sessionanalytics.TokenActivityVersion
			}
			media, parameters, err := mime.ParseMediaType(strings.TrimSpace(item))
			if err != nil {
				if selected != 0 {
					return 0, false
				}
				continue
			}
			if selected == 0 || media != raw {
				continue
			}
			// Keep the Browser's v5/v4/v3/JSON negotiation below the 128-byte
			// CORS safelist bound. Older v4 Servers ignore this additive media
			// parameter and still select v4; v3 Servers select the next range.
			if selected == sessionanalytics.StableToolVersion && parameters["v"] == "5" {
				selected = sessionanalytics.TokenActivityVersion
			}
			quality := 1.0
			if value, found := parameters["q"]; found {
				if !validAnalyticsQuality(value) {
					return 0, false
				}
				quality, _ = strconv.ParseFloat(value, 64)
			}
			if quality > 0 && selected > version {
				version = selected
			}
		}
	}
	return version, true
}

func validAnalyticsQuality(value string) bool {
	if value == "0" || value == "1" {
		return true
	}
	if len(value) < 2 || len(value) > 5 || value[1] != '.' || value[0] != '0' && value[0] != '1' {
		return false
	}
	for _, digit := range value[2:] {
		if digit < '0' || digit > '9' || value[0] == '1' && digit != '0' {
			return false
		}
	}
	return true
}
