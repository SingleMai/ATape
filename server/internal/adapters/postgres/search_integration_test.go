package postgres_test

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	containerconfig "github.com/docker/docker/api/types/container"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestMessageBodySearch(t *testing.T) {
	if testing.Short() || os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	configureDockerHost(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("search"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies(), testcontainers.WithHostConfigModifier(func(c *containerconfig.HostConfig) {
		c.Resources.NanoCPUs = 2_000_000_000
		c.Resources.Memory = 2 << 30
	}))
	if err != nil {
		t.Fatal(err)
	}
	testcontainers.CleanupContainer(t, container)
	url, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := postgresadapter.NewPool(url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = postgresadapter.Prepare(ctx, pool); err != nil {
		t.Fatal(err)
	}
	seedControlPlane(t, pool)
	store := postgresadapter.NewStore(pool)
	batch := canonicalcontract.ValidBatch()
	batch.Session.Title = "metadata-only-needle"
	batch.Events[0].Text = "用户正文：修复 #707，path/foo_bar 100% \\ abcdef 😀 中文。 lineA\nlineB"
	batch.Events[1].OccurredAt = batch.Events[0].OccurredAt
	batch.Events[1].Text = strings.Repeat("prefix 正文 ", 60000) + "TAIL-NEEDLE xyzabc abc---bcd---cde---def"
	created, err := ingestion.NewIngestor(store).ApplyBatch(ctx, canonicalcontract.CLIPrincipal(), batch)
	if err != nil {
		t.Fatal(err)
	}
	projector := projectsearch.NewProjector(store, store)
	if _, err = projector.ProjectOnce(ctx); err != nil {
		t.Fatal(err)
	}
	searcher := projectsearch.NewSearcher(store)
	search := func(term, cursor string, limit int) projectsearch.Page {
		t.Helper()
		page, e := searcher.Search(ctx, canonicalcontract.WebPrincipal(), canonicalcontract.TestProjectID, term, cursor, limit)
		if e != nil {
			t.Fatalf("search %q: %v", term, e)
		}
		return page
	}
	t.Run("arbitrary literal bodies and bounded match excerpts", func(t *testing.T) {
		for _, term := range []string{"用户正文", "中文", "中", "#", "#707", "/foo_", "100%", "\\", "😀", "abcdef", "TAIL-NEEDLE", "tail-needle", "lineA\nlineB"} {
			page := search(term, "", 20)
			if len(page.Results) != 1 || !strings.Contains(strings.ToLower(page.Results[0].Text), strings.ToLower(term)) {
				t.Fatalf("%q: %+v", term, page)
			}
			if len([]rune(page.Results[0].Text)) > 640 {
				t.Fatal("unbounded result body")
			}
			if page.Results[0].SessionID != created.SessionID {
				t.Fatal("lost exact Session anchor")
			}
		}
		for _, term := range []string{"metadata-only-needle", "totally absent", "abc---def"} {
			if len(search(term, "", 20).Results) != 0 {
				t.Fatalf("false positive: %q", term)
			}
		}
	})
	t.Run("keyset cursor scope and deterministic ties", func(t *testing.T) {
		first := search("正文", "", 1)
		if len(first.Results) != 1 || first.NextCursor == "" {
			t.Fatal(first)
		}
		second := search("正文", first.NextCursor, 1)
		if len(second.Results) != 1 || second.NextCursor != "" || second.Results[0].EventID == first.Results[0].EventID {
			t.Fatal(second)
		}
		if _, err := searcher.Search(ctx, canonicalcontract.WebPrincipal(), canonicalcontract.TestProjectID, "different", first.NextCursor, 1); err == nil {
			t.Fatal("cross-query cursor accepted")
		}
		if _, err := searcher.Search(ctx, canonicalcontract.WebPrincipal(), canonicalcontract.TestProjectID, "正文", "MQ", 1); err == nil {
			t.Fatal("old offset cursor accepted")
		}
	})
	t.Run("non-message projection is a versioned tombstone", func(t *testing.T) {
		page := search("#707", "", 20)
		id := page.Results[0].EventID
		document := canonical.EventProjection{Kind: "tool_call", ProjectID: canonicalcontract.TestProjectID, SessionID: created.SessionID, ThreadID: page.Results[0].ThreadID, ThreadPath: []canonical.ProjectionThread{{ID: page.Results[0].ThreadID, Label: "Root"}}, EventID: id, Text: "tool-only-secret", ToolLabel: "tool-label-secret", IngestSeq: 1000000, ObservedAt: time.Now(), OccurredAt: time.Now()}
		if err := store.UpsertProjectionDocuments(ctx, []canonical.EventProjection{document}); err != nil {
			t.Fatal(err)
		}
		for _, term := range []string{"#707", "tool-only-secret", "tool-label-secret"} {
			if len(search(term, "", 20).Results) != 0 {
				t.Fatalf("non-message leaked: %s", term)
			}
		}
		document.Kind = "message"
		document.IngestSeq--
		document.Text = "stale-worker-needle"
		if err := store.UpsertProjectionDocuments(ctx, []canonical.EventProjection{document}); err != nil {
			t.Fatal(err)
		}
		if len(search("stale-worker-needle", "", 20).Results) != 0 {
			t.Fatal("stale message resurrected")
		}
		document.IngestSeq += 2
		document.Text = "restored-message"
		if err := store.UpsertProjectionDocuments(ctx, []canonical.EventProjection{document}); err != nil {
			t.Fatal(err)
		}
		if len(search("restored-message", "", 20).Results) != 1 {
			t.Fatal("new message not restored")
		}
	})
	if os.Getenv("ATAPE_SEARCH_SCALE") != "1" {
		return
	}
	// Synthetic independent Search read model. Real ingestion/projection and
	// publication/authorization semantics are exercised above and in their contracts.
	started := time.Now()
	_, err = pool.Exec(ctx, `INSERT INTO project_search_documents(event_id,project_id,session_id,session_title,thread_id,thread_path_ids,thread_path_labels,author,harness,occurred_at,text,tool_label,ingest_seq,observed_at,event_kind,search_text)
 SELECT 'scale-'||n,$1,$2,'Scale','root',ARRAY['root'],ARRAY['Root'],'Agent','Codex',
 '2026-09-01'::timestamptz+n*interval '1 second',body,'',n,clock_timestamp(),kind,lower(body)
 FROM generate_series(1,400000) AS g(n)
 CROSS JOIN LATERAL (SELECT CASE WHEN n%5=0 THEN 'message' ELSE 'tool_result' END AS kind,
 CASE WHEN n%5=0 THEN repeat('Common 正文 shared context and source code. ',12)||md5(n::text)||
 CASE WHEN n%101=0 THEN ' #707 path/foo_bar rare-needle 中文 😀 100%' ELSE '' END||
 CASE WHEN n%103=0 THEN ' αβγ---βγδ---γδε---δεζ' ELSE '' END ELSE '' END AS body) AS b`, canonicalcontract.TestProjectID, created.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, "VACUUM ANALYZE project_search_documents"); err != nil {
		t.Fatal(err)
	}
	var bytes int64
	if err = pool.QueryRow(ctx, "SELECT pg_total_relation_size('project_search_documents')").Scan(&bytes); err != nil {
		t.Fatal(err)
	}
	t.Logf("scale: 400000 Events, 80000 bodies (~500 characters), build=%s, relation+indexes=%d MiB", time.Since(started), bytes>>20)
	terms := []string{"Common", "e", ".", "正", "正文", "#", "#707", "中文", "😀", "rare-needle", "path/foo_bar", "100%", "no-such-needle-9876", "source context", "αβγδεζ"}
	var mu sync.Mutex
	samples := map[string][]time.Duration{}
	var wg sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for repeat := 0; repeat < 10; repeat++ {
				for _, term := range terms {
					before := time.Now()
					page, e := searcher.Search(ctx, canonicalcontract.WebPrincipal(), canonicalcontract.TestProjectID, term, "", 20)
					elapsed := time.Since(before)
					if e != nil {
						t.Errorf("scale %q: %v", term, e)
						continue
					}
					if term == "source context" || term == "αβγδεζ" || strings.HasPrefix(term, "no-such") {
						if len(page.Results) != 0 {
							t.Errorf("scale false positive %q", term)
						}
					} else if len(page.Results) != 20 {
						t.Errorf("scale missing %q: %d", term, len(page.Results))
					}
					mu.Lock()
					samples[term] = append(samples[term], elapsed)
					mu.Unlock()
					if page.NextCursor != "" {
						before = time.Now()
						next, e := searcher.Search(ctx, canonicalcontract.WebPrincipal(), canonicalcontract.TestProjectID, term, page.NextCursor, 20)
						if e != nil {
							t.Errorf("scale page 2 %q: %v", term, e)
							continue
						}
						if len(next.Results) != 20 {
							t.Errorf("scale page 2 count %q: %d", term, len(next.Results))
						}
						mu.Lock()
						samples[term+" page2"] = append(samples[term+" page2"], time.Since(before))
						mu.Unlock()
					}
				}
			}
		}()
	}
	wg.Wait()
	// Later pages use the same keyset access path; no growing OFFSET work.
	cursor := ""
	seen := map[string]bool{}
	for n := 0; n < 50; n++ {
		started := time.Now()
		page := search("Common", cursor, 20)
		samples["Common deep pages"] = append(samples["Common deep pages"], time.Since(started))
		for _, hit := range page.Results {
			if seen[hit.EventID] {
				t.Fatal("duplicate across keyset pages")
			}
			seen[hit.EventID] = true
		}
		if len(page.Results) != 20 || page.NextCursor == "" {
			t.Fatalf("missing deep page %d", n)
		}
		cursor = page.NextCursor
	}
	keys := make([]string, 0, len(samples))
	for term := range samples {
		keys = append(keys, term)
	}
	sort.Strings(keys)
	for _, term := range keys {
		values := samples[term]
		sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
		p95 := values[(len(values)*95-1)/100]
		t.Logf("%s: n=%d p95=%s max=%s", fmt.Sprintf("%q", term), len(values), p95, values[len(values)-1])
		if p95 > time.Second {
			t.Errorf("Search p95 exceeds 1s for %q: %s", term, p95)
		}
	}
}
