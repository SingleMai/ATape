// Package memorysearch implements the local development Search index. It is
// deliberately separate from the in-memory Canonical Store.
package memorysearch

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
)

type Index struct {
	mu          sync.RWMutex
	documents   map[string]canonical.EventProjection
	checkpoints map[string]time.Time
	access      ProjectAccess
}

// ProjectAccess keeps the development Search index free of copied Membership
// state. The current control-plane Adapter remains authoritative.
type ProjectAccess interface {
	AuthorizeProject(context.Context, authentication.Principal, string, authorization.Action) error
	SessionVisible(context.Context, string, string) (bool, error)
}

func New(access ProjectAccess) *Index {
	return &Index{
		documents:   make(map[string]canonical.EventProjection),
		checkpoints: make(map[string]time.Time),
		access:      access,
	}
}

func (i *Index) UpsertProjectionDocuments(ctx context.Context, documents []canonical.EventProjection) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	for _, document := range documents {
		current, exists := i.documents[document.EventID]
		if exists && current.IngestSeq > document.IngestSeq {
			continue
		}
		document.ThreadPath = append([]canonical.ProjectionThread(nil), document.ThreadPath...)
		i.documents[document.EventID] = document
		if document.ObservedAt.After(i.checkpoints[document.ProjectID]) {
			i.checkpoints[document.ProjectID] = document.ObservedAt
		}
	}
	return nil
}

func (i *Index) SearchProjectionDocuments(
	ctx context.Context,
	principal authentication.Principal,
	query projectsearch.IndexQuery,
) (projectsearch.IndexPage, error) {
	if err := ctx.Err(); err != nil {
		return projectsearch.IndexPage{}, err
	}
	if i.access == nil {
		return projectsearch.IndexPage{}, authorization.Enforce(authorization.Outcome{
			Decision: authorization.Conceal, Denial: authorization.ResourceConcealed,
		})
	}
	if err := i.access.AuthorizeProject(ctx, principal, query.ProjectID, authorization.ProjectSearchQuery); err != nil {
		return projectsearch.IndexPage{}, err
	}
	i.mu.RLock()
	term := strings.ToLower(query.Term)
	candidates := make([]canonical.EventProjection, 0)
	for _, document := range i.documents {
		if document.ProjectID != query.ProjectID || !strings.Contains(searchable(document), term) {
			continue
		}
		document.ThreadPath = append([]canonical.ProjectionThread(nil), document.ThreadPath...)
		candidates = append(candidates, document)
	}
	indexedThrough := i.checkpoints[query.ProjectID]
	i.mu.RUnlock()

	documents := make([]canonical.EventProjection, 0, len(candidates))
	for _, document := range candidates {
		visible, err := i.access.SessionVisible(ctx, document.ProjectID, document.SessionID)
		if err != nil {
			return projectsearch.IndexPage{}, err
		}
		if !visible {
			continue
		}
		documents = append(documents, document)
	}
	sort.Slice(documents, func(left, right int) bool {
		if !documents[left].OccurredAt.Equal(documents[right].OccurredAt) {
			return documents[left].OccurredAt.After(documents[right].OccurredAt)
		}
		return documents[left].EventID < documents[right].EventID
	})
	total := len(documents)
	start := min(query.Offset, total)
	end := min(start+query.Limit, total)
	return projectsearch.IndexPage{
		Documents:      documents[start:end],
		Total:          total,
		IndexedThrough: indexedThrough,
	}, nil
}

func searchable(document canonical.EventProjection) string {
	parts := []string{
		document.SessionTitle,
		document.Author,
		document.Harness,
		document.Text,
		document.ToolLabel,
	}
	for _, thread := range document.ThreadPath {
		parts = append(parts, thread.Label)
	}
	return strings.ToLower(strings.Join(parts, " "))
}
