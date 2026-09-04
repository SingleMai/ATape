// Package httpapi translates HTTP requests into Canonical ingestion and
// conversation Module calls.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/workspace"
)

type Handler struct {
	memory    *conversation.Memory
	ingestor  *ingestion.Ingestor
	searcher  *projectsearch.Searcher
	directory *workspace.Directory
	raw       *rawarchive.Archive
	mux       *http.ServeMux
}

func NewHandler(
	memory *conversation.Memory,
	ingestor *ingestion.Ingestor,
	searcher *projectsearch.Searcher,
	directory *workspace.Directory,
	raw *rawarchive.Archive,
) *Handler {
	handler := &Handler{
		memory:    memory,
		ingestor:  ingestor,
		searcher:  searcher,
		directory: directory,
		raw:       raw,
		mux:       http.NewServeMux(),
	}
	handler.mux.HandleFunc("GET /healthz", handler.health)
	handler.mux.HandleFunc("GET /api/v1/workspace", handler.workspace)
	handler.mux.HandleFunc("GET /api/v1/projects/{projectID}/memory", handler.projectMemory)
	handler.mux.HandleFunc("GET /api/v1/projects/{projectID}/search", handler.projectSearch)
	handler.mux.HandleFunc("GET /api/v1/sessions/{sessionID}", handler.conversation)
	handler.mux.HandleFunc("GET /api/v1/sessions/{sessionID}/raw", handler.rawSession)
	handler.mux.HandleFunc("GET /api/v1/raw-objects/{objectID}/content", handler.rawContent)
	handler.mux.HandleFunc("POST /api/v1/ingestion/canonical/batches", handler.canonicalBatch)
	handler.mux.HandleFunc("POST /api/v1/ingestion/raw/chunks", handler.rawChunk)
	return handler
}

func (h *Handler) rawSession(response http.ResponseWriter, request *http.Request) {
	archive, err := h.raw.OpenSession(request.Context(), request.PathValue("sessionID"))
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, archive)
}

func (h *Handler) rawContent(response http.ResponseWriter, request *http.Request) {
	generation, err := parseOptionalInt64(request.URL.Query().Get("generation"), "generation")
	if err != nil {
		writeError(response, err)
		return
	}
	limit, err := parseOptionalInt(request.URL.Query().Get("limit"), "limit")
	if err != nil {
		writeError(response, err)
		return
	}
	page, err := h.raw.Read(
		request.Context(), request.PathValue("objectID"), generation,
		request.URL.Query().Get("cursor"), limit,
	)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, page)
}

func (h *Handler) rawChunk(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, 512<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var chunk rawarchive.UploadChunk
	if err := decoder.Decode(&chunk); err != nil {
		writeRawDecodeError(response, err)
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(response, http.StatusBadRequest, map[string]string{
			"code": "invalid_request", "message": "The request body must contain exactly one JSON object.",
		})
		return
	}
	result, err := h.raw.Append(request.Context(), chunk)
	if err != nil {
		writeError(response, err)
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	writeJSON(response, status, result)
}

func (h *Handler) workspace(response http.ResponseWriter, request *http.Request) {
	directory, err := h.directory.Open(request.Context())
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, directory)
}

func (h *Handler) projectSearch(response http.ResponseWriter, request *http.Request) {
	limit := 0
	if encoded := request.URL.Query().Get("limit"); encoded != "" {
		parsed, err := strconv.Atoi(encoded)
		if err != nil {
			writeError(response, &projectsearch.InvalidQueryError{Field: "limit", Reason: "must be a number"})
			return
		}
		limit = parsed
	}
	page, err := h.searcher.Search(
		request.Context(),
		request.PathValue("projectID"),
		request.URL.Query().Get("q"),
		request.URL.Query().Get("cursor"),
		limit,
	)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, page)
}

func (h *Handler) canonicalBatch(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, 4<<20)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()

	var batch ingestion.Batch
	if err := decoder.Decode(&batch); err != nil {
		writeDecodeError(response, err)
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(response, http.StatusBadRequest, map[string]string{
			"code":    "invalid_request",
			"message": "The request body must contain exactly one JSON object.",
		})
		return
	}

	result, err := h.ingestor.ApplyBatch(request.Context(), batch)
	if err != nil {
		writeError(response, err)
		return
	}
	status := http.StatusOK
	if result.SessionCreated && !result.Replayed {
		status = http.StatusCreated
	}
	writeJSON(response, status, result)
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	h.mux.ServeHTTP(response, request)
}

func (h *Handler) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) projectMemory(response http.ResponseWriter, request *http.Request) {
	memory, err := h.memory.OpenProject(request.Context(), request.PathValue("projectID"))
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, memory)
}

func (h *Handler) conversation(response http.ResponseWriter, request *http.Request) {
	result, err := h.memory.OpenConversation(
		request.Context(),
		request.PathValue("sessionID"),
		request.URL.Query().Get("thread"),
	)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func writeError(response http.ResponseWriter, err error) {
	var rawValidation *rawarchive.ValidationError
	if errors.As(err, &rawValidation) {
		writeJSON(response, http.StatusBadRequest, map[string]string{
			"code": "invalid_raw_request", "field": rawValidation.Field, "message": rawValidation.Error(),
		})
		return
	}
	var invalidSearch *projectsearch.InvalidQueryError
	if errors.As(err, &invalidSearch) {
		writeJSON(response, http.StatusBadRequest, map[string]string{
			"code": "invalid_search", "field": invalidSearch.Field, "message": invalidSearch.Error(),
		})
		return
	}
	var validation *ingestion.ValidationError
	if errors.As(err, &validation) {
		writeJSON(response, http.StatusBadRequest, map[string]string{
			"code":    "invalid_canonical_batch",
			"field":   validation.Field,
			"message": validation.Error(),
		})
		return
	}
	var conflict *canonical.ConflictError
	if errors.As(err, &conflict) {
		writeJSON(response, http.StatusConflict, map[string]string{
			"code":    "idempotency_conflict",
			"message": conflict.Error(),
		})
		return
	}
	var rawConflict *rawarchive.ConflictError
	if errors.As(err, &rawConflict) {
		writeJSON(response, http.StatusConflict, map[string]string{
			"code": "raw_idempotency_conflict", "message": rawConflict.Error(),
		})
		return
	}
	var notFound *conversation.NotFoundError
	if errors.As(err, &notFound) {
		writeJSON(response, http.StatusNotFound, map[string]string{
			"code":    "not_found",
			"message": notFound.Error(),
		})
		return
	}
	var rawNotFound *rawarchive.NotFoundError
	if errors.As(err, &rawNotFound) {
		writeJSON(response, http.StatusNotFound, map[string]string{
			"code": "raw_not_found", "message": rawNotFound.Error(),
		})
		return
	}
	var unavailable *rawarchive.UnavailableError
	if errors.As(err, &unavailable) {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{
			"code": "raw_unavailable", "message": unavailable.Error(),
		})
		return
	}
	writeJSON(response, http.StatusInternalServerError, map[string]string{
		"code":    "internal_error",
		"message": "The request could not be completed.",
	})
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

func writeDecodeError(response http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeJSON(response, http.StatusRequestEntityTooLarge, map[string]string{
			"code":    "request_too_large",
			"message": "The Canonical batch exceeds the 4 MiB request limit.",
		})
		return
	}
	writeJSON(response, http.StatusBadRequest, map[string]string{
		"code":    "invalid_request",
		"message": "The request body is not a valid Canonical batch.",
	})
}

func writeRawDecodeError(response http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeJSON(response, http.StatusRequestEntityTooLarge, map[string]string{
			"code": "request_too_large", "message": "The Raw chunk request exceeds the 512 KiB request limit.",
		})
		return
	}
	writeJSON(response, http.StatusBadRequest, map[string]string{
		"code": "invalid_request", "message": "The request body is not a valid Raw chunk.",
	})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
