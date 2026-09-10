package httpapi

import (
	"context"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/publication"
)

// Publication is the remote transport Seam into the candidate lifecycle Module.
// Each request invokes one bounded operation; retries remain the caller's workflow.
type Publication interface {
	Capabilities() publication.Capabilities
	Reserve(context.Context, authentication.Principal, publication.Scope) (publication.Reservation, error)
	Begin(context.Context, authentication.Principal, publication.Begin) (publication.Attempt, error)
	Put(context.Context, authentication.Principal, string, int, string, []byte) (publication.Part, error)
	Seal(context.Context, authentication.Principal, string, publication.Manifest) (publication.Attempt, error)
	Validate(context.Context, authentication.Principal, string) (publication.Attempt, error)
	Activate(context.Context, authentication.Principal, string) (publication.Activation, error)
	Status(context.Context, authentication.Principal, string, int, int) (publication.Page, error)
	Renew(context.Context, authentication.Principal, string) (publication.Attempt, error)
	Reject(context.Context, authentication.Principal, string) (publication.Attempt, error)
	Reclaim(context.Context, authentication.Principal, int) (publication.Reclaimed, error)
}

func publicationResult[A any](w http.ResponseWriter, r *http.Request, value A, err error) {
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, value)
}

// Reject ambiguous, malformed and unknown query fields rather than accidentally
// starting a new recovery page or uploading a part with a different identity.
func strictQuery(w http.ResponseWriter, r *http.Request, allowed ...string) (url.Values, bool) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err == nil {
		for key, items := range values {
			known := false
			for _, name := range allowed {
				if key == name {
					known = true
					break
				}
			}
			if !known || len(items) != 1 || items[0] == "" {
				err = &publication.Error{Code: "invalid"}
				break
			}
		}
	}
	if err != nil {
		writeProblem(w, r, problemInvalidRequest, 0, nil)
		return nil, false
	}
	return values, true
}

func queryInteger(w http.ResponseWriter, r *http.Request, values url.Values, key string, fallback int) (int, bool) {
	if !values.Has(key) {
		return fallback, true
	}
	value, err := strconv.Atoi(values.Get(key))
	if err != nil {
		writeProblem(w, r, problemInvalidRequest, 0, nil)
		return 0, false
	}
	return value, true
}

func (h *Handler) publicationAvailable(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.publication == nil {
			writeProblem(w, r, problemServiceUnavailable, 0, nil)
			return
		}
		next(w, r)
	}
}
func (h *Handler) publicationCapabilities(w http.ResponseWriter, r *http.Request) {
	if _, ok := strictQuery(w, r); !ok {
		return
	}
	writeJSON(w, r, http.StatusOK, h.publication.Capabilities())
}
func (h *Handler) publicationReserve(w http.ResponseWriter, r *http.Request) {
	if _, ok := strictQuery(w, r); !ok {
		return
	}
	var input publication.Scope
	if !decodeJSON(w, r, &input) {
		return
	}
	value, err := h.publication.Reserve(r.Context(), principalFromContext(r.Context()), input)
	publicationResult(w, r, value, err)
}
func (h *Handler) publicationBegin(w http.ResponseWriter, r *http.Request) {
	if _, ok := strictQuery(w, r); !ok {
		return
	}
	var input publication.Begin
	if !decodeJSON(w, r, &input) {
		return
	}
	value, err := h.publication.Begin(r.Context(), principalFromContext(r.Context()), input)
	publicationResult(w, r, value, err)
}
func (h *Handler) publicationSeal(w http.ResponseWriter, r *http.Request) {
	if _, ok := strictQuery(w, r); !ok {
		return
	}
	var input publication.Manifest
	if !decodeJSON(w, r, &input) {
		return
	}
	value, err := h.publication.Seal(r.Context(), principalFromContext(r.Context()), r.PathValue("attemptId"), input)
	publicationResult(w, r, value, err)
}
func (h *Handler) publicationValidate(w http.ResponseWriter, r *http.Request) {
	if _, ok := strictQuery(w, r); !ok {
		return
	}
	value, err := h.publication.Validate(r.Context(), principalFromContext(r.Context()), r.PathValue("attemptId"))
	publicationResult(w, r, value, err)
}
func (h *Handler) publicationActivate(w http.ResponseWriter, r *http.Request) {
	if _, ok := strictQuery(w, r); !ok {
		return
	}
	value, err := h.publication.Activate(r.Context(), principalFromContext(r.Context()), r.PathValue("attemptId"))
	publicationResult(w, r, value, err)
}
func (h *Handler) publicationRenew(w http.ResponseWriter, r *http.Request) {
	if _, ok := strictQuery(w, r); !ok {
		return
	}
	value, err := h.publication.Renew(r.Context(), principalFromContext(r.Context()), r.PathValue("attemptId"))
	publicationResult(w, r, value, err)
}
func (h *Handler) publicationReject(w http.ResponseWriter, r *http.Request) {
	if _, ok := strictQuery(w, r); !ok {
		return
	}
	value, err := h.publication.Reject(r.Context(), principalFromContext(r.Context()), r.PathValue("attemptId"))
	publicationResult(w, r, value, err)
}
func (h *Handler) publicationPut(w http.ResponseWriter, r *http.Request) {
	query, ok := strictQuery(w, r, "sha256")
	if !ok {
		return
	}
	ordinal, err := strconv.Atoi(r.PathValue("ordinal"))
	if err != nil || query.Get("sha256") == "" {
		writeProblem(w, r, problemInvalidRequest, 0, nil)
		return
	}
	contentTypes := r.Header.Values("Content-Type")
	if len(contentTypes) != 1 {
		writeProblem(w, r, problemUnsupportedMediaType, 0, nil)
		return
	}
	mediaType, _, err := mime.ParseMediaType(contentTypes[0])
	if err != nil || mediaType != "application/json" {
		writeProblem(w, r, problemUnsupportedMediaType, 0, nil)
		return
	}
	// Preserve the exact frozen transport bytes. Canonical decoding belongs to Validate.
	maximum := min(canonicalBodyLimit, h.publication.Capabilities().Limits.PartBytes)
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maximum))
	if err != nil {
		writeDecodeProblem(w, r, err)
		return
	}
	value, err := h.publication.Put(r.Context(), principalFromContext(r.Context()), r.PathValue("attemptId"), ordinal, query.Get("sha256"), body)
	publicationResult(w, r, value, err)
}
func (h *Handler) publicationStatus(w http.ResponseWriter, r *http.Request) {
	query, ok := strictQuery(w, r, "after", "limit")
	if !ok {
		return
	}
	after, ok := queryInteger(w, r, query, "after", -1)
	if !ok {
		return
	}
	limit, ok := queryInteger(w, r, query, "limit", 100)
	if !ok {
		return
	}
	value, err := h.publication.Status(r.Context(), principalFromContext(r.Context()), r.PathValue("attemptId"), after, limit)
	publicationResult(w, r, value, err)
}
func (h *Handler) publicationReclaim(w http.ResponseWriter, r *http.Request) {
	query, ok := strictQuery(w, r, "limit")
	if !ok {
		return
	}
	limit, ok := queryInteger(w, r, query, "limit", 32)
	if !ok {
		return
	}
	value, err := h.publication.Reclaim(r.Context(), principalFromContext(r.Context()), limit)
	publicationResult(w, r, value, err)
}
