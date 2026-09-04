// Package projectsearch exposes project-scoped keyword retrieval as a deep
// Module over an independently maintained Canonical read model.
package projectsearch

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"

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
	Offset    int
	Limit     int
}

type IndexPage struct {
	Documents      []canonical.EventProjection
	Total          int
	IndexedThrough time.Time
}

// QueryIndex is the production-varying Seam consumed by Searcher.
type QueryIndex interface {
	SearchProjectionDocuments(context.Context, IndexQuery) (IndexPage, error)
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
	offset, err := decodeCursor(cursor)
	if err != nil {
		return Page{}, &InvalidQueryError{Field: "cursor", Reason: "is not valid"}
	}

	indexed, err := s.index.SearchProjectionDocuments(ctx, IndexQuery{
		ProjectID: projectID,
		Term:      term,
		Offset:    offset,
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
	if next := offset + len(indexed.Documents); next < indexed.Total {
		page.NextCursor = encodeCursor(next)
	}
	return page, nil
}

func encodeCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func decodeCursor(cursor string) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, err
	}
	offset, err := strconv.Atoi(string(decoded))
	if err != nil || offset < 0 {
		return 0, fmt.Errorf("invalid offset")
	}
	return offset, nil
}
