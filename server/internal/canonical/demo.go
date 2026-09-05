package canonical

import (
	"time"

	"github.com/SingleMai/ATape/server/internal/authorization"
)

const DemoUserID = "demo-user"

// NewDemoStore seeds the local executable with representative Canonical data.
// It is a development Adapter, not a source-provider fixture or Raw archive.
func NewDemoStore() *MemoryStore {
	store := NewMemoryStore()
	acme := TeamRecord{ID: "acme-engineering", Name: "Acme Engineering"}
	openSource := TeamRecord{ID: "open-source-lab", Name: "Open Source Lab"}
	store.teams[acme.ID] = acme
	store.teams[openSource.ID] = openSource
	store.memberships[membershipKey(acme.ID, DemoUserID)] = authorization.MembershipFacts{
		TeamID: acme.ID, UserID: DemoUserID, Role: authorization.OwnerRole, Active: true,
	}
	store.memberships[membershipKey(openSource.ID, DemoUserID)] = authorization.MembershipFacts{
		TeamID: openSource.ID, UserID: DemoUserID, Role: authorization.MemberRole, Active: true,
	}
	project := ProjectRecord{ID: "payments-api", TeamID: acme.ID, Name: "payments-api", Type: "git", State: "active"}
	store.projects[project.ID] = project
	store.projectCapture[project.ID] = mustTime("2026-09-04T10:52:18+08:00")
	store.projects["support-notes"] = ProjectRecord{ID: "support-notes", TeamID: acme.ID, Name: "support-notes", Type: "directory", State: "active"}
	store.projectCapture["support-notes"] = mustTime("2026-09-03T15:20:00+08:00")
	store.projects["adapter-sdk"] = ProjectRecord{ID: "adapter-sdk", TeamID: openSource.ID, Name: "adapter-sdk", Type: "git", State: "active"}
	store.projectCapture["adapter-sdk"] = mustTime("2026-09-02T09:15:00+08:00")

	checkout := SessionRecord{
		ID: "checkout", ProjectID: project.ID, CapturedByUserID: DemoUserID, SourceKey: "demo/checkout", Revision: 1, Digest: "demo/checkout/1",
		Title: "Fix duplicate checkout charge on retry", Summary: "Retries occasionally charge a customer twice.",
		Insight: "Two retry layers did not share a durable key.", Actor: Actor{Name: "Liying", Harness: "Codex CLI"},
		Branch: "main", Status: "active", CaptureStatus: "healthy", UpdatedAt: mustTime("2026-09-04T10:52:00+08:00"), ReportedEventCount: 23,
	}
	webhooks := SessionRecord{
		ID: "webhooks", ProjectID: project.ID, CapturedByUserID: DemoUserID, SourceKey: "demo/webhooks", Revision: 1, Digest: "demo/webhooks/1",
		Title: "Trace missing webhook deliveries", Summary: "Why did valid webhook events disappear?",
		Insight: "The queue visibility timeout overlaps deploy drain.", Actor: Actor{Name: "Mika", Harness: "Claude Code"},
		Branch: "fix/webhooks", Status: "active", CaptureStatus: "healthy", UpdatedAt: mustTime("2026-09-04T10:46:00+08:00"), ReportedEventCount: 41,
	}
	ledger := SessionRecord{
		ID: "ledger", ProjectID: project.ID, CapturedByUserID: DemoUserID, SourceKey: "demo/ledger", Revision: 1, Digest: "demo/ledger/1",
		Title: "Plan ledger schema migration", Summary: "Compare rollback paths for the ledger-v2 migration.",
		Insight: "Shadow writes keep backfill replay safe.", Actor: Actor{Name: "Qian", Harness: "OpenCode"},
		Branch: "design/ledger-v2", Status: "ended", CaptureStatus: "complete", UpdatedAt: mustTime("2026-09-03T17:24:00+08:00"), ReportedEventCount: 18,
	}
	store.seedSession(checkout)
	store.seedSession(webhooks)
	store.seedSession(ledger)

	parent := "root"
	store.seedThread(ThreadRecord{ID: "root", SessionID: checkout.ID, SourceKey: "demo/checkout/root", Revision: 1, Digest: "demo/checkout/root/1", Label: "Root thread", CaptureStatus: "complete"})
	store.seedThread(ThreadRecord{ID: "schema-review", SessionID: checkout.ID, SourceKey: "demo/checkout/schema-review", Revision: 1, Digest: "demo/checkout/schema-review/1", Label: "schema-review", Summary: "Checked uniqueness constraints and migration safety", ParentThreadID: &parent, CaptureStatus: "partial"})
	store.seedThread(ThreadRecord{ID: "root", SessionID: webhooks.ID, SourceKey: "demo/webhooks/root", Revision: 1, Digest: "demo/webhooks/root/1", Label: "Root thread", CaptureStatus: "complete"})
	store.seedThread(ThreadRecord{ID: "root", SessionID: ledger.ID, SourceKey: "demo/ledger/root", Revision: 1, Digest: "demo/ledger/root/1", Label: "Root thread", CaptureStatus: "complete"})

	child := "schema-review"
	store.seedEvent(EventRecord{ID: "c1", SessionID: checkout.ID, ThreadID: "root", SourceKey: "demo/checkout/c1", Revision: 1, Digest: "demo/checkout/c1/1", Kind: "message", Author: "Liying", OccurredAt: mustTime("2026-09-04T10:42:08+08:00"), Text: "Retries occasionally charge a customer twice. Trace the request path and propose the smallest safe fix."})
	store.seedEvent(EventRecord{ID: "c2", SessionID: checkout.ID, ThreadID: "root", SourceKey: "demo/checkout/c2", Revision: 1, Digest: "demo/checkout/c2/1", Kind: "message", Author: "Codex", OccurredAt: mustTime("2026-09-04T10:42:19+08:00"), Text: "I found two retry layers. The API retries after a timeout, while the provider client also retries network failures. Neither shares a durable key.", ToolLabel: "Read 4 files"})
	store.seedEvent(EventRecord{ID: "c3", SessionID: checkout.ID, ThreadID: "root", SourceKey: "demo/checkout/c3", Revision: 1, Digest: "demo/checkout/c3/1", Kind: "message", Author: "Codex", OccurredAt: mustTime("2026-09-04T10:44:53+08:00"), Text: "Create the idempotency key at the payment-attempt boundary, persist it before the first provider call, and reuse it for every retry.", ChildThreadID: &child})
	store.seedEvent(EventRecord{ID: "c4", SessionID: checkout.ID, ThreadID: "root", SourceKey: "demo/checkout/c4", Revision: 1, Digest: "demo/checkout/c4/1", Kind: "message", Author: "Liying", OccurredAt: mustTime("2026-09-04T10:45:21+08:00"), Text: "Do that, but keep provider-specific details out of the service layer."})
	store.seedEvent(EventRecord{ID: "c5", SessionID: checkout.ID, ThreadID: "schema-review", SourceKey: "demo/checkout/c5", Revision: 1, Digest: "demo/checkout/c5/1", Kind: "context", Author: "Parent context", OccurredAt: mustTime("2026-09-04T10:43:02+08:00"), Text: "Review the payment-attempt schema and propose the safest uniqueness boundary."})
	store.seedEvent(EventRecord{ID: "c6", SessionID: checkout.ID, ThreadID: "schema-review", SourceKey: "demo/checkout/c6", Revision: 1, Digest: "demo/checkout/c6/1", Kind: "message", Author: "schema-review · subagent", OccurredAt: mustTime("2026-09-04T10:43:24+08:00"), Text: "The provider request ID arrives too late. The unique constraint should cover merchant_id plus the idempotency key.", ToolLabel: "Inspected migration"})
	store.seedEvent(EventRecord{ID: "c7", SessionID: checkout.ID, ThreadID: "schema-review", SourceKey: "demo/checkout/c7", Revision: 1, Digest: "demo/checkout/c7/1", Kind: "notice", Author: "Capture boundary", OccurredAt: mustTime("2026-09-04T10:43:31+08:00"), Text: "This child thread is partial because the native harness exposed only a subset of its events."})
	store.seedEvent(EventRecord{ID: "w1", SessionID: webhooks.ID, ThreadID: "root", SourceKey: "demo/webhooks/w1", Revision: 1, Digest: "demo/webhooks/w1/1", Kind: "message", Author: "Mika", OccurredAt: mustTime("2026-09-04T10:39:14+08:00"), Text: "Trace why signed webhook deliveries disappear during deploys."})
	store.seedEvent(EventRecord{ID: "w2", SessionID: webhooks.ID, ThreadID: "root", SourceKey: "demo/webhooks/w2", Revision: 1, Digest: "demo/webhooks/w2/1", Kind: "message", Author: "Claude", OccurredAt: mustTime("2026-09-04T10:46:00+08:00"), Text: "Signature verification succeeds. The visibility timeout expires while the old worker is draining, so another worker receives the event before ownership settles."})
	store.seedEvent(EventRecord{ID: "l1", SessionID: ledger.ID, ThreadID: "root", SourceKey: "demo/ledger/l1", Revision: 1, Digest: "demo/ledger/l1/1", Kind: "message", Author: "Qian", OccurredAt: mustTime("2026-09-03T16:58:00+08:00"), Text: "Compare rollback paths before we start the ledger-v2 backfill."})
	store.seedEvent(EventRecord{ID: "l2", SessionID: ledger.ID, ThreadID: "root", SourceKey: "demo/ledger/l2", Revision: 1, Digest: "demo/ledger/l2/1", Kind: "message", Author: "OpenCode", OccurredAt: mustTime("2026-09-03T17:24:00+08:00"), Text: "Use shadow writes, verify both ledgers, and keep a stable idempotency key so replay cannot duplicate rows."})

	return store
}

func (s *MemoryStore) seedSession(record SessionRecord) {
	s.sessions[record.ID] = record
	addToIndex(s.sessionIDsByProject, record.ProjectID, record.ID)
}

func (s *MemoryStore) seedThread(record ThreadRecord) {
	s.threads[recordKey(record.SessionID, record.ID)] = cloneThread(record)
	addToIndex(s.threadIDsBySession, record.SessionID, record.ID)
	if record.ParentThreadID != nil {
		s.sessionChildThreadCounts[record.SessionID]++
	}
}

func (s *MemoryStore) seedEvent(record EventRecord) {
	if record.ProjectionRevision == 0 {
		record.ProjectionRevision = 1
	}
	s.nextIngestSeq++
	record.IngestSeq = s.nextIngestSeq
	record.ObservedAt = record.OccurredAt
	record.ReceivedAt = record.OccurredAt
	s.events[record.ID] = cloneEvent(record)
	s.eventBySource[record.SourceKey] = record.ID
	s.eventVersions[record.SourceKey] = []EventRecord{cloneEvent(record)}
	s.appendProjectionChange(record.ID)
	addToIndex(s.eventIDsByThread, recordKey(record.SessionID, record.ThreadID), record.ID)
	s.sessionEventCounts[record.SessionID]++
}

func mustTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		panic(err)
	}
	return parsed
}
