// Package projectsearch exposes project-scoped keyword retrieval as a deep
// Module over an independently maintained Canonical read model.
package projectsearch

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
)

const (
	defaultLimit = 20
	maxLimit     = 50
	maxQuerySize = 200
)

type IndexQuery struct {
	ProjectID string
	Term      string
	After     *Position
	Limit     int
}

type Position struct {
	Time    time.Time `json:"t"`
	EventID string    `json:"e"`
}

type IndexPage struct {
	Documents      []canonical.EventProjection
	HasMore        bool
	IndexedThrough time.Time
}

// QueryIndex is the production-varying Seam consumed by Searcher.
type QueryIndex interface {
	SearchProjectionDocuments(context.Context, authentication.Principal, IndexQuery) (IndexPage, error)
}

type ThreadPathItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type Result struct {
	EventID      string           `json:"eventId"`
	SessionID    string           `json:"sessionId"`
	SessionTitle string           `json:"sessionTitle"`
	ThreadID     string           `json:"threadId"`
	ThreadPath   []ThreadPathItem `json:"threadPath"`
	Author       string           `json:"author"`
	Harness      string           `json:"harness"`
	OccurredAt   string           `json:"occurredAt"`
	Text         string           `json:"text"`
	ToolLabel    string           `json:"toolLabel,omitempty"`
}

type Page struct {
	ProjectID      string   `json:"projectId"`
	Query          string   `json:"query"`
	IndexedThrough string   `json:"indexedThrough,omitempty"`
	Results        []Result `json:"results"`
	NextCursor     string   `json:"nextCursor,omitempty"`
}

type InvalidQueryError struct {
	Field  string
	Reason string
}

func (e *InvalidQueryError) Error() string {
	return fmt.Sprintf("invalid search %s: %s", e.Field, e.Reason)
}

type Searcher struct {
	index QueryIndex
}

func NewSearcher(index QueryIndex) *Searcher {
	return &Searcher{index: index}
}

func (s *Searcher) Search(
	ctx context.Context,
	principal authentication.Principal,
	projectID string,
	term string,
	cursor string,
	limit int,
) (Page, error) {
	term = strings.TrimSpace(term)
	if term == "" {
		return Page{}, &InvalidQueryError{Field: "q", Reason: "must not be empty"}
	}
	if len([]byte(term)) > maxQuerySize {
		return Page{}, &InvalidQueryError{Field: "q", Reason: "must be at most 200 UTF-8 bytes"}
	}
	if limit == 0 {
		limit = defaultLimit
	}
	if limit < 1 || limit > maxLimit {
		return Page{}, &InvalidQueryError{Field: "limit", Reason: "must be between 1 and 50"}
	}
	after, err := decodeCursor(cursor, projectID, term)
	if err != nil {
		return Page{}, &InvalidQueryError{Field: "cursor", Reason: "is not valid"}
	}

	indexed, err := s.index.SearchProjectionDocuments(ctx, principal, IndexQuery{
		ProjectID: projectID,
		Term:      term,
		After:     after,
		Limit:     limit,
	})
	if err != nil {
		return Page{}, err
	}
	page := Page{
		ProjectID: projectID,
		Query:     term,
		Results:   make([]Result, 0, len(indexed.Documents)),
	}
	if !indexed.IndexedThrough.IsZero() {
		page.IndexedThrough = indexed.IndexedThrough.UTC().Format(time.RFC3339Nano)
	}
	for _, document := range indexed.Documents {
		path := make([]ThreadPathItem, 0, len(document.ThreadPath))
		for _, thread := range document.ThreadPath {
			path = append(path, ThreadPathItem{ID: thread.ID, Label: thread.Label})
		}
		page.Results = append(page.Results, Result{
			EventID: document.EventID, SessionID: document.SessionID,
			SessionTitle: document.SessionTitle, ThreadID: document.ThreadID,
			ThreadPath: path, Author: document.Author, Harness: document.Harness,
			OccurredAt: document.OccurredAt.UTC().Format(time.RFC3339Nano),
			Text:       document.Text, ToolLabel: document.ToolLabel,
		})
	}
	if indexed.HasMore && len(indexed.Documents) > 0 {
		last := indexed.Documents[len(indexed.Documents)-1]
		page.NextCursor = encodeCursor(Position{Time: last.OccurredAt, EventID: last.EventID}, projectID, term)
	}
	return page, nil
}

type pageCursor struct {
	Version  int      `json:"v"`
	Scope    string   `json:"s"`
	Position Position `json:"p"`
}

func cursorScope(projectID, term string) string {
	sum := sha256.Sum256([]byte(projectID + "\x00" + term))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func encodeCursor(position Position, projectID, term string) string {
	body, _ := json.Marshal(pageCursor{Version: 1, Scope: cursorScope(projectID, term), Position: position})
	return base64.RawURLEncoding.EncodeToString(body)
}

func decodeCursor(cursor, projectID, term string) (*Position, error) {
	if cursor == "" {
		return nil, nil
	}
	if len(cursor) > 1024 {
		return nil, fmt.Errorf("cursor too large")
	}
	body, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, err
	}
	var decoded pageCursor
	if err = json.Unmarshal(body, &decoded); err != nil {
		return nil, err
	}
	if decoded.Version != 1 || decoded.Scope != cursorScope(projectID, term) || decoded.Position.Time.IsZero() || decoded.Position.EventID == "" || len(decoded.Position.EventID) > 200 {
		return nil, fmt.Errorf("cursor does not match query")
	}
	return &decoded.Position, nil
}
