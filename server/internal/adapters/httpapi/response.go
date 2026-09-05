package httpapi

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
)

const (
	authBodyLimit         int64 = 16 << 10
	controlPlaneBodyLimit int64 = 64 << 10
	canonicalBodyLimit    int64 = 4 << 20
	rawBodyLimit          int64 = 512 << 10
)

func writeJSON(response http.ResponseWriter, request *http.Request, status int, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		writeProblem(response, request, problemInternal, 0, nil)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(append(encoded, '\n'))
}

func writeNoContent(response http.ResponseWriter, status int) {
	response.WriteHeader(status)
}

func writePublicMetadata(response http.ResponseWriter, request *http.Request, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		writeProblem(response, request, problemInternal, 0, nil)
		return
	}
	digest := sha256.Sum256(encoded)
	etag := `"sha256-` + base64.RawURLEncoding.EncodeToString(digest[:]) + `"`
	response.Header().Set("ETag", etag)
	if matchesIfNoneMatch(request.Header.Values("If-None-Match"), etag) {
		response.WriteHeader(http.StatusNotModified)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(append(encoded, '\n'))
}

func matchesIfNoneMatch(values []string, etag string) bool {
	for _, value := range values {
		for _, candidate := range strings.Split(value, ",") {
			candidate = strings.TrimSpace(candidate)
			if candidate == "*" || candidate == etag || strings.TrimPrefix(candidate, "W/") == etag {
				return true
			}
		}
	}
	return false
}

func decodeJSON(response http.ResponseWriter, request *http.Request, target any) bool {
	maximum := requestBodyPolicyFromContext(request.Context()).limit()
	if maximum <= 0 {
		writeProblem(response, request, problemInternal, 0, nil)
		return false
	}
	contentTypes := request.Header.Values("Content-Type")
	if len(contentTypes) != 1 {
		writeProblem(response, request, problemUnsupportedMediaType, 0, nil)
		return false
	}
	mediaType, _, err := mime.ParseMediaType(contentTypes[0])
	if err != nil || mediaType != "application/json" {
		writeProblem(response, request, problemUnsupportedMediaType, 0, nil)
		return false
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximum)
	reader := bufio.NewReader(request.Body)
	object, err := startsWithJSONObject(reader)
	if err != nil {
		writeDecodeProblem(response, request, err)
		return false
	}
	if !object {
		writeProblem(response, request, problemInvalidRequest, 0, nil)
		return false
	}
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeDecodeProblem(response, request, err)
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeDecodeProblem(response, request, err)
		return false
	}
	return true
}

func startsWithJSONObject(reader *bufio.Reader) (bool, error) {
	for {
		value, err := reader.ReadByte()
		if err != nil {
			return false, err
		}
		switch value {
		case ' ', '\t', '\r', '\n':
			continue
		case '{':
			if err := reader.UnreadByte(); err != nil {
				return false, err
			}
			return true, nil
		default:
			return false, nil
		}
	}
}

func writeDecodeProblem(response http.ResponseWriter, request *http.Request, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeProblem(response, request, problemRequestTooLarge, 0, nil)
		return
	}
	writeProblem(response, request, problemInvalidRequest, 0, nil)
}

func setNoStore(header http.Header) {
	header.Set("Cache-Control", "no-store")
}

func appendVary(header http.Header, value string) {
	for _, existing := range header.Values("Vary") {
		for _, field := range strings.Split(existing, ",") {
			if strings.EqualFold(strings.TrimSpace(field), value) || strings.TrimSpace(field) == "*" {
				return
			}
		}
	}
	header.Add("Vary", value)
}
