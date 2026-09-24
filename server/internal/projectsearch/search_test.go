package projectsearch_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/memorysearch"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
)

func searchPrincipal() authentication.Principal {
	return authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.WebAuthentication}
}

func TestProjectorBuildsSearchableChildThreadDocuments(t *testing.T) {
	store := canonical.NewDemoStore()
	index := memorysearch.New(store)
	projector := projectsearch.NewProjector(store, index)

	projected, err := projector.ProjectOnce(t.Context())
	if err != nil {
		t.Fatalf("project Canonical changes: %v", err)
	}
	if got, want := projected, 11; got != want {
		t.Fatalf("projected changes = %d, want %d", got, want)
	}
	page, err := projectsearch.NewSearcher(index).Search(
		context.Background(), searchPrincipal(), "payments-api", "merchant_id", "", 20,
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
	index := memorysearch.New(store)
	projector := projectsearch.NewProjector(store, index)
	if _, err := projector.ProjectOnce(t.Context()); err != nil {
		t.Fatalf("project demo changes: %v", err)
	}
	searcher := projectsearch.NewSearcher(index)

	first, err := searcher.Search(t.Context(), searchPrincipal(), "payments-api", "idempotency key", "", 1)
	if err != nil {
		t.Fatalf("search first page: %v", err)
	}
	if len(first.Results) != 1 || first.NextCursor == "" {
		t.Fatalf("first page does not expose one result and cursor: %+v", first)
	}
	second, err := searcher.Search(t.Context(), searchPrincipal(), "payments-api", "idempotency key", first.NextCursor, 1)
	if err != nil {
		t.Fatalf("search second page: %v", err)
	}
	if len(second.Results) != 1 || second.Results[0].EventID == first.Results[0].EventID {
		t.Fatalf("second page did not advance: first=%+v second=%+v", first.Results, second.Results)
	}
	if _, err := searcher.Search(t.Context(), searchPrincipal(), "payments-api", " ", "", 20); err == nil {
		t.Fatal("empty search query was accepted")
	}
	if _, err := searcher.Search(t.Context(), searchPrincipal(), "payments-api", "retry", "not-a-cursor", 20); err == nil {
		t.Fatal("invalid cursor was accepted")
	}
}

func TestBodyOnlySearchAndProjectionReplacement(t *testing.T) {
	store := canonical.NewDemoStore()
	index := memorysearch.New(store)
	base := canonical.EventProjection{Kind: "message", ProjectID: "payments-api", SessionID: "checkout", EventID: "body", ThreadID: "root", SessionTitle: "metadata-only", Author: "metadata-only", Harness: "Codex", Text: strings.Repeat("prefix ", 1000) + "修复 #707 😀", ToolLabel: "label-only", OccurredAt: time.Now(), ObservedAt: time.Now(), IngestSeq: 1}
	if err := index.UpsertProjectionDocuments(t.Context(), []canonical.EventProjection{base}); err != nil {
		t.Fatal(err)
	}
	searcher := projectsearch.NewSearcher(index)
	for term, count := range map[string]int{"#707": 1, "#": 1, "修": 1, "😀": 1, "metadata-only": 0, "label-only": 0} {
		page, err := searcher.Search(t.Context(), searchPrincipal(), "payments-api", term, "", 20)
		if err != nil || len(page.Results) != count {
			t.Fatalf("%q: %+v %v", term, page, err)
		}
		if count > 0 && (!strings.Contains(page.Results[0].Text, term) || len([]rune(page.Results[0].Text)) > 640) {
			t.Fatal("unbounded or missing match excerpt")
		}
	}
	base.Kind = "tool_result"
	base.IngestSeq = 2
	if err := index.UpsertProjectionDocuments(t.Context(), []canonical.EventProjection{base}); err != nil {
		t.Fatal(err)
	}
	base.Kind = "message"
	base.IngestSeq = 1
	if err := index.UpsertProjectionDocuments(t.Context(), []canonical.EventProjection{base}); err != nil {
		t.Fatal(err)
	}
	page, err := searcher.Search(t.Context(), searchPrincipal(), "payments-api", "#707", "", 20)
	if err != nil || len(page.Results) != 0 {
		t.Fatalf("stale worker resurrected a message: %+v %v", page, err)
	}
}
