package httpapi

import (
	"net/http"
	"strconv"

	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
)

func (h *Handler) rawSession(response http.ResponseWriter, request *http.Request) {
	archive, err := h.raw.OpenSession(
		request.Context(), principalFromContext(request.Context()), request.PathValue("sessionId"),
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, archive)
}

func (h *Handler) rawContent(response http.ResponseWriter, request *http.Request) {
	generation, err := parseOptionalInt64(request.URL.Query().Get("generation"), "generation")
	if err != nil {
		writeError(response, request, err)
		return
	}
	limit, err := parseOptionalInt(request.URL.Query().Get("limit"), "limit")
	if err != nil {
		writeError(response, request, err)
		return
	}
	page, err := h.raw.Read(
		request.Context(), principalFromContext(request.Context()), request.PathValue("objectId"), generation,
		request.URL.Query().Get("cursor"), limit,
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, page)
}

func (h *Handler) rawChunk(response http.ResponseWriter, request *http.Request) {
	var chunk rawarchive.UploadChunk
	if !decodeJSON(response, request, &chunk) {
		return
	}
	result, err := h.raw.Append(request.Context(), principalFromContext(request.Context()), chunk)
	if err != nil {
		writeError(response, request, err)
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	writeJSON(response, request, status, result)
}

func (h *Handler) workspace(response http.ResponseWriter, request *http.Request) {
	principal := principalFromContext(request.Context())
	if h.teams != nil {
		result, err := h.teams.OpenWorkspace(request.Context(), principal)
		if err != nil {
			writeError(response, request, err)
			return
		}
		writeJSON(response, request, http.StatusOK, workspaceDTOFromTeam(result))
		return
	}
	directory, err := h.directory.Open(request.Context(), principal)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, directory)
}

func (h *Handler) projectSearch(response http.ResponseWriter, request *http.Request) {
	limit := 0
	if encoded := request.URL.Query().Get("limit"); encoded != "" {
		parsed, err := strconv.Atoi(encoded)
		if err != nil {
			writeError(response, request, &projectsearch.InvalidQueryError{Field: "limit", Reason: "must be a number"})
			return
		}
		limit = parsed
	}
	page, err := h.searcher.Search(
		request.Context(), principalFromContext(request.Context()), request.PathValue("projectId"),
		request.URL.Query().Get("q"), request.URL.Query().Get("cursor"), limit,
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, page)
}

func (h *Handler) canonicalBatch(response http.ResponseWriter, request *http.Request) {
	var batch ingestion.Batch
	if !decodeJSON(response, request, &batch) {
		return
	}
	result, err := h.ingestor.ApplyBatch(request.Context(), principalFromContext(request.Context()), batch)
	if err != nil {
		writeError(response, request, err)
		return
	}
	status := http.StatusOK
	if result.SessionCreated && !result.Replayed {
		status = http.StatusCreated
	}
	writeJSON(response, request, status, result)
}

func (h *Handler) projectMemory(response http.ResponseWriter, request *http.Request) {
	memory, err := h.memory.OpenProject(
		request.Context(), principalFromContext(request.Context()), request.PathValue("projectId"),
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, memory)
}

func (h *Handler) conversation(response http.ResponseWriter, request *http.Request) {
	result, err := h.memory.OpenConversation(
		request.Context(), principalFromContext(request.Context()), request.PathValue("sessionId"),
		request.URL.Query().Get("thread"),
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, result)
}

func (h *Handler) deleteCapturedSession(response http.ResponseWriter, request *http.Request) {
	err := h.ingestor.DeleteSession(
		request.Context(), principalFromContext(request.Context()), request.PathValue("sessionId"),
		requestIDFromContext(request.Context()),
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func parseOptionalInt(value string, field string) (int, error) {
	if value == "" {
		return 0, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, &rawarchive.ValidationError{Field: field, Reason: "must be a number"}
	}
	return parsed, nil
}

func parseOptionalInt64(value string, field string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, &rawarchive.ValidationError{Field: field, Reason: "must be a number"}
	}
	return parsed, nil
}
