// Package memorysearch implements the local development Search index. It is
// deliberately separate from the in-memory Canonical Store.
package memorysearch

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
)

type Index struct {
	mu          sync.RWMutex
	documents   map[string]canonical.EventProjection
	checkpoints map[string]time.Time
}

func New() *Index {
	return &Index{
		documents:   make(map[string]canonical.EventProjection),
		checkpoints: make(map[string]time.Time),
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

func (i *Index) SearchProjectionDocuments(ctx context.Context, query projectsearch.IndexQuery) (projectsearch.IndexPage, error) {
	if err := ctx.Err(); err != nil {
		return projectsearch.IndexPage{}, err
	}
	i.mu.RLock()
	defer i.mu.RUnlock()

	term := strings.ToLower(query.Term)
	documents := make([]canonical.EventProjection, 0)
	for _, document := range i.documents {
		if document.ProjectID != query.ProjectID || !strings.Contains(searchable(document), term) {
			continue
		}
		document.ThreadPath = append([]canonical.ProjectionThread(nil), document.ThreadPath...)
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
		IndexedThrough: i.checkpoints[query.ProjectID],
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
