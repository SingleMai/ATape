package projectsearch_test

import (
	"context"
	"testing"

	"github.com/SingleMai/ATape/server/internal/adapters/memorysearch"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
)

func TestProjectorBuildsSearchableChildThreadDocuments(t *testing.T) {
	store := canonical.NewDemoStore()
	index := memorysearch.New()
	projector := projectsearch.NewProjector(store, index)

	projected, err := projector.ProjectOnce(t.Context())
	if err != nil {
		t.Fatalf("project Canonical changes: %v", err)
	}
	if got, want := projected, 11; got != want {
		t.Fatalf("projected changes = %d, want %d", got, want)
	}
	page, err := projectsearch.NewSearcher(index).Search(
		context.Background(), "payments-api", "merchant_id", "", 20,
	)
	if err != nil {
		t.Fatalf("search child Thread: %v", err)
	}
	if got, want := len(page.Results), 1; got != want {
		t.Fatalf("results = %d, want %d: %+v", got, want, page.Results)
	}
	result := page.Results[0]
	if result.EventID != "c6" || result.ThreadID != "schema-review" {
		t.Fatalf("result does not preserve exact Event anchor: %+v", result)
	}
	if got, want := len(result.ThreadPath), 2; got != want {
		t.Fatalf("thread path length = %d, want %d", got, want)
	}
	if result.ThreadPath[0].ID != "root" || result.ThreadPath[1].ID != "schema-review" {
		t.Fatalf("unexpected Thread path: %+v", result.ThreadPath)
	}

	replayed, err := projector.ProjectOnce(t.Context())
	if err != nil {
		t.Fatalf("repeat projection: %v", err)
	}
	if replayed != 0 {
		t.Fatalf("repeat projection changed %d documents, want 0", replayed)
	}
}

func TestSearcherValidatesAndPaginatesBehindOpaqueCursor(t *testing.T) {
	store := canonical.NewDemoStore()
	index := memorysearch.New()
	projector := projectsearch.NewProjector(store, index)
	if _, err := projector.ProjectOnce(t.Context()); err != nil {
		t.Fatalf("project demo changes: %v", err)
	}
	searcher := projectsearch.NewSearcher(index)

	first, err := searcher.Search(t.Context(), "payments-api", "idempotency key", "", 1)
	if err != nil {
		t.Fatalf("search first page: %v", err)
	}
	if len(first.Results) != 1 || first.NextCursor == "" {
		t.Fatalf("first page does not expose one result and cursor: %+v", first)
	}
	second, err := searcher.Search(t.Context(), "payments-api", "idempotency key", first.NextCursor, 1)
	if err != nil {
		t.Fatalf("search second page: %v", err)
	}
	if len(second.Results) != 1 || second.Results[0].EventID == first.Results[0].EventID {
		t.Fatalf("second page did not advance: first=%+v second=%+v", first.Results, second.Results)
	}
	if _, err := searcher.Search(t.Context(), "payments-api", " ", "", 20); err == nil {
		t.Fatal("empty search query was accepted")
	}
	if _, err := searcher.Search(t.Context(), "payments-api", "retry", "not-a-cursor", 20); err == nil {
		t.Fatal("invalid cursor was accepted")
	}
}
