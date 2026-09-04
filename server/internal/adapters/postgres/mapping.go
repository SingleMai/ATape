package postgres

import (
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/canonical"
)

func insertSessionParams(record canonical.SessionRecord) db.InsertSessionParams {
	return db.InsertSessionParams{
		ID: record.ID, ProjectID: record.ProjectID, SourceKey: record.SourceKey,
		Revision: record.Revision, Digest: record.Digest, Title: record.Title,
		Summary: record.Summary, Insight: record.Insight, ActorName: record.Actor.Name,
		ActorHarness: record.Actor.Harness, Branch: record.Branch, Status: record.Status,
		CaptureStatus: record.CaptureStatus, UpdatedAt: record.UpdatedAt,
		ReportedEventCount: int64(record.ReportedEventCount),
	}
}

func updateSessionParams(record canonical.SessionRecord) db.UpdateSessionParams {
	return db.UpdateSessionParams{
		ID: record.ID, Revision: record.Revision, Digest: record.Digest,
		Title: record.Title, Summary: record.Summary, Insight: record.Insight,
		ActorName: record.Actor.Name, ActorHarness: record.Actor.Harness,
		Branch: record.Branch, Status: record.Status,
		CaptureStatus: record.CaptureStatus, UpdatedAt: record.UpdatedAt,
		ReportedEventCount: int64(record.ReportedEventCount),
	}
}

func insertThreadParams(record canonical.ThreadRecord) db.InsertThreadParams {
	return db.InsertThreadParams{
		SessionID: record.SessionID, ID: record.ID, SourceKey: record.SourceKey,
		Revision: record.Revision, Digest: record.Digest, Label: record.Label,
		Summary: record.Summary, ParentThreadID: record.ParentThreadID,
		CaptureStatus: record.CaptureStatus,
	}
}

func updateThreadParams(record canonical.ThreadRecord) db.UpdateThreadParams {
	return db.UpdateThreadParams{
		SessionID: record.SessionID, ID: record.ID, Revision: record.Revision,
		Digest: record.Digest, Label: record.Label, Summary: record.Summary,
		CaptureStatus: record.CaptureStatus,
	}
}

func insertEventParams(record canonical.EventRecord) db.InsertEventParams {
	return db.InsertEventParams{
		ID: record.ID, SessionID: record.SessionID, ThreadID: record.ThreadID,
		SourceKey: record.SourceKey, Revision: record.Revision,
		ProjectionRevision: record.ProjectionRevision, Digest: record.Digest,
		SourceOrder: record.SourceOrder, EventIndex: int64(record.EventIndex),
		OrderFidelity: record.OrderFidelity, Fidelity: record.Fidelity,
		RawRef: record.RawRef, AdapterVersion: record.AdapterVersion,
		SchemaVersion: record.SchemaVersion, ObservedAt: record.ObservedAt,
		ReceivedAt: record.ReceivedAt, IngestSeq: int64(record.IngestSeq),
		Kind: record.Kind, Author: record.Author, OccurredAt: record.OccurredAt,
		Text: record.Text, ToolLabel: record.ToolLabel,
		ChildThreadID: record.ChildThreadID,
	}
}

func updateEventParams(record canonical.EventRecord) db.UpdateEventParams {
	params := insertEventParams(record)
	return db.UpdateEventParams{
		ID: params.ID, Revision: params.Revision,
		ProjectionRevision: params.ProjectionRevision, Digest: params.Digest,
		SourceOrder: params.SourceOrder, EventIndex: params.EventIndex,
		OrderFidelity: params.OrderFidelity, Fidelity: params.Fidelity,
		RawRef: params.RawRef, AdapterVersion: params.AdapterVersion,
		SchemaVersion: params.SchemaVersion, ObservedAt: params.ObservedAt,
		ReceivedAt: params.ReceivedAt, IngestSeq: params.IngestSeq,
		Kind: params.Kind, Author: params.Author, OccurredAt: params.OccurredAt,
		Text: params.Text, ToolLabel: params.ToolLabel,
		ChildThreadID: params.ChildThreadID,
	}
}

func insertEventVersionParams(record canonical.EventRecord) db.InsertEventVersionParams {
	params := insertEventParams(record)
	return db.InsertEventVersionParams{
		SourceKey: params.SourceKey, ProjectionRevision: params.ProjectionRevision,
		Revision: params.Revision, EventID: params.ID, SessionID: params.SessionID,
		ThreadID: params.ThreadID, Digest: params.Digest,
		SourceOrder: params.SourceOrder, EventIndex: params.EventIndex,
		OrderFidelity: params.OrderFidelity, Fidelity: params.Fidelity,
		RawRef: params.RawRef, AdapterVersion: params.AdapterVersion,
		SchemaVersion: params.SchemaVersion, ObservedAt: params.ObservedAt,
		ReceivedAt: params.ReceivedAt, IngestSeq: params.IngestSeq,
		Kind: params.Kind, Author: params.Author, OccurredAt: params.OccurredAt,
		Text: params.Text, ToolLabel: params.ToolLabel,
		ChildThreadID: params.ChildThreadID,
	}
}

func canonicalSession(row db.CanonicalSession) canonical.SessionRecord {
	return sessionRecord(row.ID, row.ProjectID, row.SourceKey, row.Revision, row.Digest, row.Title, row.Summary, row.Insight, row.ActorName, row.ActorHarness, row.Branch, row.Status, row.CaptureStatus, row.UpdatedAt, row.ReportedEventCount)
}

func sessionRecord(id, projectID, sourceKey string, revision int64, digest, title, summary, insight, actorName, actorHarness, branch, status, captureStatus string, updatedAt time.Time, reportedEventCount int64) canonical.SessionRecord {
	return canonical.SessionRecord{
		ID: id, ProjectID: projectID, SourceKey: sourceKey, Revision: revision,
		Digest: digest, Title: title, Summary: summary, Insight: insight,
		Actor: canonical.Actor{Name: actorName, Harness: actorHarness}, Branch: branch,
		Status: status, CaptureStatus: captureStatus, UpdatedAt: updatedAt,
		ReportedEventCount: int(reportedEventCount),
	}
}

func canonicalThread(row db.CanonicalThread) canonical.ThreadRecord {
	return threadRecord(row.SessionID, row.ID, row.SourceKey, row.Revision, row.Digest, row.Label, row.Summary, row.ParentThreadID, row.CaptureStatus)
}

func threadRecord(sessionID, id, sourceKey string, revision int64, digest, label, summary string, parentThreadID *string, captureStatus string) canonical.ThreadRecord {
	return canonical.ThreadRecord{
		SessionID: sessionID, ID: id, SourceKey: sourceKey, Revision: revision,
		Digest: digest, Label: label, Summary: summary,
		ParentThreadID: parentThreadID, CaptureStatus: captureStatus,
	}
}

func canonicalEvent(row db.CanonicalEvent) canonical.EventRecord {
	return canonical.EventRecord{
		ID: row.ID, SessionID: row.SessionID, ThreadID: row.ThreadID,
		SourceKey: row.SourceKey, Revision: row.Revision,
		ProjectionRevision: row.ProjectionRevision, Digest: row.Digest,
		SourceOrder: row.SourceOrder, EventIndex: int(row.EventIndex),
		OrderFidelity: row.OrderFidelity, Fidelity: row.Fidelity,
		RawRef: row.RawRef, AdapterVersion: row.AdapterVersion,
		SchemaVersion: row.SchemaVersion, ObservedAt: row.ObservedAt,
		ReceivedAt: row.ReceivedAt, IngestSeq: uint64(row.IngestSeq), Kind: row.Kind,
		Author: row.Author, OccurredAt: row.OccurredAt, Text: row.Text,
		ToolLabel: row.ToolLabel, ChildThreadID: row.ChildThreadID,
	}
}
