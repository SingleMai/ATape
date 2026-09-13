package teamoverview_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/teamoverview"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
)

// Exercise the caller's Interface with 300 Sessions and 60,000 messages split
// across both periods. Allocations include the memory Adapter and JSON encoding;
// production PostgreSQL query latency is covered separately by integration tests.
func BenchmarkOverview(b *testing.B) {
	store := canonical.NewMemoryStoreWithControlPlane(canonicalcontract.MemoryControlPlane())
	writer := ingestion.NewIngestor(store)
	for n := 0; n < 300; n++ {
		batch := canonicalcontract.ValidBatch()
		batch.BatchID = fmt.Sprintf("benchmark-%d", n)
		batch.Session.SourceSessionID = batch.BatchID
		template := batch.Events
		batch.Events = nil
		for i := 0; i < 200; i++ {
			e := template[i%2]
			e.SourceEventID = fmt.Sprintf("event-%d", i)
			e.SourceOrder = int64(i + 1)
			if i < 100 {
				e.OccurredAt = "2026-09-03T10:00:00+08:00"
			}
			batch.Events = append(batch.Events, e)
		}
		if _, err := writer.ApplyBatch(b.Context(), canonicalcontract.CLIPrincipal(), batch); err != nil {
			b.Fatal(err)
		}
	}
	module := teamoverview.New(store)
	for _, sessionsOnly := range []bool{false, true} {
		name := "dashboard"
		if sessionsOnly {
			name = "sessions"
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			q := teamoverview.Query{From: "2026-09-04", To: "2026-09-04", Page: 1}
			for b.Loop() {
				var value any
				var err error
				var metrics, previous teamoverview.Metrics
				if sessionsOnly {
					page, e := module.OpenSessions(b.Context(), canonicalcontract.WebPrincipal(), canonicalcontract.TestTeamID, q)
					value, err, metrics, previous = page, e, page.Metrics, page.Previous
				} else {
					page, e := module.Open(b.Context(), canonicalcontract.WebPrincipal(), canonicalcontract.TestTeamID, q)
					value, err, metrics, previous = page, e, page.Metrics, page.Previous
				}
				if err != nil {
					b.Fatal(err)
				}
				if metrics.Messages != 15000 || previous.Messages != 15000 || metrics.Sessions != 300 {
					b.Fatal("incomplete metrics")
				}
				if _, err = json.Marshal(value); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
