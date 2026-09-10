package rawarchive

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
)

const DefaultManifestPageSize = 50
const MaxManifestPageSize = 100

// ObjectPosition is exclusive in immutable first-receipt time / ID descending
// order. Stores return at most limit records (including Archive's lookahead),
// and reauthorize the Session on every page. Zero means the first page.
type ObjectPosition struct {
	CreatedAt time.Time
	ObjectID  string
}

type manifestCursor struct {
	Version   int       `json:"v"`
	SessionID string    `json:"s"`
	CreatedAt time.Time `json:"t"`
	ObjectID  string    `json:"o"`
}

type PaginationRequiredError struct{}

func (*PaginationRequiredError) Error() string { return "Raw archive requires bounded manifest pages" }

// OpenSessionPage loads bounded metadata independently of Canonical's selected
// head. Existing objects never move when appended; refresh discovers new objects.
// Each page is a current authorized read, not a cross-request snapshot.
func (a *Archive) OpenSessionPage(ctx context.Context, principal authentication.Principal, sessionID, cursor string, limit int) (SessionArchive, error) {
	if strings.TrimSpace(sessionID) == "" || len(sessionID) > 512 || strings.ContainsRune(sessionID, 0) {
		return SessionArchive{}, &ValidationError{Field: "sessionId", Reason: "must be a bounded nonempty identity"}
	}
	if limit == 0 {
		limit = DefaultManifestPageSize
	}
	if limit < 1 || limit > MaxManifestPageSize {
		return SessionArchive{}, &ValidationError{Field: "limit", Reason: "must be between 1 and 100"}
	}
	after, err := decodeManifestCursor(cursor, sessionID)
	if err != nil {
		return SessionArchive{}, err
	}
	objects, err := a.manifests.ListSessionObjects(ctx, principal, sessionID, after, limit+1)
	if err != nil {
		return SessionArchive{}, concealedAsNotFound(err, "session", sessionID)
	}
	result := SessionArchive{SessionID: sessionID, Objects: make([]ObjectSummary, 0, min(limit, len(objects)))}
	if len(objects) > limit {
		objects = objects[:limit]
		last := objects[len(objects)-1]
		encoded, err := json.Marshal(manifestCursor{Version: 1, SessionID: sessionID, CreatedAt: last.CreatedAt.UTC(), ObjectID: last.ObjectID})
		if err != nil {
			return SessionArchive{}, err
		}
		result.NextCursor = base64.RawURLEncoding.EncodeToString(encoded)
	}
	for _, object := range objects {
		result.Objects = append(result.Objects, summarize(object))
	}
	return result, nil
}

func decodeManifestCursor(value, sessionID string) (ObjectPosition, error) {
	if value == "" {
		return ObjectPosition{}, nil
	}
	invalid := &ValidationError{Field: "cursor", Reason: "is invalid for this Raw Session"}
	if len(value) > 2048 {
		return ObjectPosition{}, invalid
	}
	encoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil {
		return ObjectPosition{}, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var cursor manifestCursor
	if err := decoder.Decode(&cursor); err != nil {
		return ObjectPosition{}, invalid
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return ObjectPosition{}, invalid
	}
	if strings.TrimSpace(cursor.ObjectID) == "" || len(cursor.ObjectID) > 512 || strings.ContainsRune(cursor.ObjectID, 0) || cursor.Version != 1 || cursor.SessionID != sessionID || cursor.CreatedAt.IsZero() || cursor.CreatedAt.Year() < 1 || cursor.CreatedAt.Year() > 9999 {
		return ObjectPosition{}, invalid
	}
	return ObjectPosition{CreatedAt: cursor.CreatedAt.UTC(), ObjectID: cursor.ObjectID}, nil
}
