package ingestion

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/sourceidentity"
)

const (
	maxBatchEvents = 500
	maxThreads     = 100
	maxTextBytes   = 1 << 20
)

// Ingestor hides protocol validation, stable identity projection, revision
// semantics, and atomic idempotent application behind ApplyBatch.
type Ingestor struct {
	store BatchStore
}

func NewIngestor(store BatchStore) *Ingestor {
	return &Ingestor{store: store}
}

func (i *Ingestor) ApplyBatch(ctx context.Context, principal authentication.Principal, batch Batch) (canonical.ApplyResult, error) {
	if err := ctx.Err(); err != nil {
		return canonical.ApplyResult{}, err
	}
	writeBatch, err := normalizeBatch(principal, batch)
	if err != nil {
		return canonical.ApplyResult{}, err
	}
	return i.store.ApplyBatch(ctx, principal, writeBatch)
}

func normalizeBatch(principal authentication.Principal, batch Batch) (canonical.WriteBatch, error) {
	if batch.ProtocolVersion != ProtocolVersion {
		return canonical.WriteBatch{}, invalid("protocolVersion", "must be "+ProtocolVersion)
	}
	if batch.CanonicalProfileVersion != CanonicalProfileVersion {
		return canonical.WriteBatch{}, invalid("canonicalProfileVersion", "must be "+CanonicalProfileVersion)
	}
	if err := required("batchId", batch.BatchID, 200); err != nil {
		return canonical.WriteBatch{}, err
	}
	observedAt, err := timestamp("observedAt", batch.ObservedAt)
	if err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := required("source.adapterId", batch.Source.AdapterID, 200); err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := required("source.adapterVersion", batch.Source.AdapterVersion, 100); err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := required("source.installationId", batch.Source.InstallationID, 200); err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := required("projectId", batch.ProjectID, 200); err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := required("principal.userId", principal.UserID, 200); err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := required("session.sourceSessionId", batch.Session.SourceSessionID, 500); err != nil {
		return canonical.WriteBatch{}, err
	}
	if batch.Session.Revision < 1 {
		return canonical.WriteBatch{}, invalid("session.revision", "must be at least 1")
	}
	if err := required("session.actor.name", batch.Session.Actor.Name, 200); err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := required("session.actor.harness", batch.Session.Actor.Harness, 200); err != nil {
		return canonical.WriteBatch{}, err
	}
	if !oneOf(batch.Session.Status, "active", "idle", "ended") {
		return canonical.WriteBatch{}, invalid("session.status", "must be active, idle, or ended")
	}
	if !captureStatus(batch.Session.CaptureStatus) {
		return canonical.WriteBatch{}, invalid("session.captureStatus", "is not supported")
	}
	updatedAt, err := timestamp("session.updatedAt", batch.Session.UpdatedAt)
	if err != nil {
		return canonical.WriteBatch{}, err
	}
	if batch.Session.ReportedEventCount < 0 {
		return canonical.WriteBatch{}, invalid("session.reportedEventCount", "cannot be negative")
	}
	if err := optional("session.title", batch.Session.Title, 2_000); err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := optional("session.summary", batch.Session.Summary, 2_000); err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := optional("session.insight", batch.Session.Insight, 2_000); err != nil {
		return canonical.WriteBatch{}, err
	}
	if err := optional("session.branch", batch.Session.Branch, 2_000); err != nil {
		return canonical.WriteBatch{}, err
	}
	if len(batch.Threads) == 0 || len(batch.Threads) > maxThreads {
		return canonical.WriteBatch{}, invalid("threads", fmt.Sprintf("must contain between 1 and %d records", maxThreads))
	}
	if len(batch.Events) > maxBatchEvents {
		return canonical.WriteBatch{}, invalid("events", fmt.Sprintf("cannot contain more than %d records", maxBatchEvents))
	}

	scope := sourceKey(
		batch.ProjectID,
		principal.UserID,
		batch.Source.InstallationID,
		batch.Source.AdapterID,
		batch.Session.SourceSessionID,
	)
	sessionID := stableID("s_", scope)
	threadIDs, err := normalizeThreadIDs(scope, batch.Threads)
	if err != nil {
		return canonical.WriteBatch{}, err
	}

	threads := make([]canonical.ThreadRecord, 0, len(batch.Threads))
	for index, input := range batch.Threads {
		field := fmt.Sprintf("threads[%d]", index)
		if input.Revision < 1 {
			return canonical.WriteBatch{}, invalid(field+".revision", "must be at least 1")
		}
		if !captureStatus(input.CaptureStatus) {
			return canonical.WriteBatch{}, invalid(field+".captureStatus", "is not supported")
		}
		label := strings.TrimSpace(input.Label)
		if label == "" {
			label = input.SourceThreadID
		}
		if !utf8.ValidString(label) || len(label) > 200 {
			return canonical.WriteBatch{}, invalid(field+".label", "must be valid UTF-8 up to 200 bytes")
		}
		if err := optional(field+".summary", input.Summary, 2_000); err != nil {
			return canonical.WriteBatch{}, err
		}
		var parentID *string
		if input.ParentSourceThreadID != nil {
			mapped := threadIDs[*input.ParentSourceThreadID]
			parentID = &mapped
		}
		record := canonical.ThreadRecord{
			ID:             threadIDs[input.SourceThreadID],
			SessionID:      sessionID,
			SourceKey:      sourceKey(scope, "thread", input.SourceThreadID),
			Revision:       input.Revision,
			Label:          label,
			Summary:        strings.TrimSpace(input.Summary),
			ParentThreadID: parentID,
			CaptureStatus:  input.CaptureStatus,
		}
		record.Digest = digest(record)
		threads = append(threads, record)
	}

	events := make([]canonical.EventRecord, 0, len(batch.Events))
	eventIDs := make(map[string]struct{}, len(batch.Events))
	for index, input := range batch.Events {
		field := fmt.Sprintf("events[%d]", index)
		if err := required(field+".sourceEventId", input.SourceEventID, 500); err != nil {
			return canonical.WriteBatch{}, err
		}
		eventIdentity := sourceKey(input.SourceThreadID, input.SourceEventID)
		if _, duplicate := eventIDs[eventIdentity]; duplicate {
			return canonical.WriteBatch{}, invalid(field+".sourceEventId", "is duplicated in this batch")
		}
		eventIDs[eventIdentity] = struct{}{}
		threadID, ok := threadIDs[input.SourceThreadID]
		if !ok {
			return canonical.WriteBatch{}, invalid(field+".sourceThreadId", "does not reference a thread in this batch")
		}
		if input.Revision < 1 {
			return canonical.WriteBatch{}, invalid(field+".revision", "must be at least 1")
		}
		if input.ProjectionRevision < 1 {
			return canonical.WriteBatch{}, invalid(field+".projectionRevision", "must be at least 1")
		}
		if input.SourceOrder < 0 {
			return canonical.WriteBatch{}, invalid(field+".sourceOrder", "cannot be negative")
		}
		if input.EventIndex < 0 {
			return canonical.WriteBatch{}, invalid(field+".eventIndex", "cannot be negative")
		}
		if !oneOf(input.OrderFidelity, "native", "derived") {
			return canonical.WriteBatch{}, invalid(field+".orderFidelity", "must be native or derived")
		}
		if !oneOf(input.Fidelity, "native", "derived", "partial", "redacted") {
			return canonical.WriteBatch{}, invalid(field+".fidelity", "is not supported")
		}
		rawRef, err := normalizeRawReference(principal, batch, sessionID, field+".rawRef", input.RawRef)
		if err != nil {
			return canonical.WriteBatch{}, err
		}
		if !canonicalKind(input.Kind) {
			return canonical.WriteBatch{}, invalid(field+".kind", "is not supported")
		}
		if err := required(field+".author", input.Author, 200); err != nil {
			return canonical.WriteBatch{}, err
		}
		if err := required(field+".text", input.Text, maxTextBytes); err != nil {
			return canonical.WriteBatch{}, err
		}
		occurredAt, err := timestamp(field+".occurredAt", input.OccurredAt)
		if err != nil {
			return canonical.WriteBatch{}, err
		}
		if !utf8.ValidString(input.ToolLabel) || len(input.ToolLabel) > 500 {
			return canonical.WriteBatch{}, invalid(field+".toolLabel", "must be valid UTF-8 up to 500 bytes")
		}
		var childThreadID *string
		if input.ChildSourceThreadID != nil {
			mapped, exists := threadIDs[*input.ChildSourceThreadID]
			if !exists {
				return canonical.WriteBatch{}, invalid(field+".childSourceThreadId", "does not reference a thread in this batch")
			}
			childThreadID = &mapped
		}
		eventSourceKey := sourceKey(scope, "event", input.SourceThreadID, input.SourceEventID)
		record := canonical.EventRecord{
			ID:                 stableID("e_", eventSourceKey),
			SessionID:          sessionID,
			ThreadID:           threadID,
			SourceKey:          eventSourceKey,
			Revision:           input.Revision,
			ProjectionRevision: input.ProjectionRevision,
			SourceOrder:        input.SourceOrder,
			EventIndex:         input.EventIndex,
			OrderFidelity:      input.OrderFidelity,
			Fidelity:           input.Fidelity,
			RawRef:             rawRef,
			AdapterVersion:     batch.Source.AdapterVersion,
			SchemaVersion:      batch.CanonicalProfileVersion,
			Kind:               input.Kind,
			Author:             strings.TrimSpace(input.Author),
			OccurredAt:         occurredAt,
			Text:               input.Text,
			ToolLabel:          input.ToolLabel,
			ChildThreadID:      childThreadID,
		}
		record.Digest = digest(record)
		events = append(events, record)
	}

	title, summary, insight := memoryCopy(batch.Session, batch.Events)
	sessionSourceKey := sourceKey(scope, "session")
	session := canonical.SessionRecord{
		ID:                 sessionID,
		ProjectID:          batch.ProjectID,
		CapturedByUserID:   principal.UserID,
		SourceKey:          sessionSourceKey,
		Revision:           batch.Session.Revision,
		Title:              title,
		Summary:            summary,
		Insight:            insight,
		Actor:              canonical.Actor{Name: strings.TrimSpace(batch.Session.Actor.Name), Harness: strings.TrimSpace(batch.Session.Actor.Harness)},
		Branch:             strings.TrimSpace(batch.Session.Branch),
		Status:             batch.Session.Status,
		CaptureStatus:      batch.Session.CaptureStatus,
		UpdatedAt:          updatedAt,
		ReportedEventCount: batch.Session.ReportedEventCount,
	}
	session.Digest = digest(session)

	return canonical.WriteBatch{
		Key: sourceKey(
			batch.ProjectID,
			principal.UserID,
			batch.Source.InstallationID,
			batch.Source.AdapterID,
			"batch",
			batch.BatchID,
		),
		Digest:     digest(batch),
		ObservedAt: observedAt,
		ProjectID:  batch.ProjectID,
		Session:    session,
		Threads:    threads,
		Events:     events,
	}, nil
}

func normalizeRawReference(
	principal authentication.Principal,
	batch Batch,
	sessionID string,
	field string,
	reference RawReference,
) (string, error) {
	switch reference.Type {
	case "object":
		if err := required(field+".sourceObjectId", reference.SourceObjectID, 512); err != nil {
			return "", err
		}
		if err := optional(field+".fragment", reference.Fragment, 1_024); err != nil {
			return "", err
		}
		if reference.UnavailableReason != "" {
			return "", invalid(field+".reason", "must be omitted for an object reference")
		}
		return sourceidentity.RawObjectID(
			principal.UserID, sessionID, batch.Source.InstallationID,
			batch.Source.AdapterID, reference.SourceObjectID,
		) + reference.Fragment, nil
	case "unavailable":
		if err := required(field+".reason", reference.UnavailableReason, 1_024); err != nil {
			return "", err
		}
		if reference.SourceObjectID != "" || reference.Fragment != "" {
			return "", invalid(field, "unavailable references cannot identify an object")
		}
		return "unavailable:" + reference.UnavailableReason, nil
	default:
		return "", invalid(field+".type", "must be object or unavailable")
	}
}

func normalizeThreadIDs(scope string, threads []Thread) (map[string]string, error) {
	ids := make(map[string]string, len(threads))
	rootCount := 0
	for index, thread := range threads {
		field := fmt.Sprintf("threads[%d].sourceThreadId", index)
		if err := required(field, thread.SourceThreadID, 500); err != nil {
			return nil, err
		}
		if _, duplicate := ids[thread.SourceThreadID]; duplicate {
			return nil, invalid(field, "is duplicated in this batch")
		}
		if thread.ParentSourceThreadID == nil {
			rootCount++
			ids[thread.SourceThreadID] = "root"
		} else {
			ids[thread.SourceThreadID] = stableID("t_", sourceKey(scope, "thread", thread.SourceThreadID))
		}
	}
	if rootCount != 1 {
		return nil, invalid("threads", "must contain exactly one root thread")
	}
	for index, thread := range threads {
		if thread.ParentSourceThreadID == nil {
			continue
		}
		if *thread.ParentSourceThreadID == thread.SourceThreadID {
			return nil, invalid(fmt.Sprintf("threads[%d].parentSourceThreadId", index), "cannot reference itself")
		}
		if _, exists := ids[*thread.ParentSourceThreadID]; !exists {
			return nil, invalid(fmt.Sprintf("threads[%d].parentSourceThreadId", index), "does not reference a thread in this batch")
		}
	}
	if cycle := threadCycle(threads); cycle != "" {
		return nil, invalid("threads", "contains a parent cycle at "+cycle)
	}
	return ids, nil
}

func threadCycle(threads []Thread) string {
	parents := make(map[string]*string, len(threads))
	for index := range threads {
		parents[threads[index].SourceThreadID] = threads[index].ParentSourceThreadID
	}
	for id := range parents {
		seen := make(map[string]struct{}, len(parents))
		current := id
		for {
			if _, exists := seen[current]; exists {
				return current
			}
			seen[current] = struct{}{}
			parent := parents[current]
			if parent == nil {
				break
			}
			current = *parent
		}
	}
	return ""
}

func memoryCopy(session Session, events []Event) (string, string, string) {
	title := strings.TrimSpace(session.Title)
	summary := strings.TrimSpace(session.Summary)
	insight := strings.TrimSpace(session.Insight)
	if len(events) > 0 {
		if title == "" {
			title = truncate(events[0].Text, 80)
		}
		if summary == "" {
			summary = truncate(events[0].Text, 180)
		}
		if insight == "" {
			insight = truncate(events[len(events)-1].Text, 180)
		}
	}
	if title == "" {
		title = "Untitled conversation"
	}
	return title, summary, insight
}

func truncate(value string, limit int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit-1]) + "…"
}

func required(field string, value string, maxBytes int) error {
	if strings.TrimSpace(value) == "" {
		return invalid(field, "is required")
	}
	if !utf8.ValidString(value) || len(value) > maxBytes {
		return invalid(field, fmt.Sprintf("must be valid UTF-8 up to %d bytes", maxBytes))
	}
	return nil
}

func optional(field string, value string, maxBytes int) error {
	if !utf8.ValidString(value) || len(value) > maxBytes {
		return invalid(field, fmt.Sprintf("must be valid UTF-8 up to %d bytes", maxBytes))
	}
	return nil
}

func timestamp(field string, value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, invalid(field, "must be an RFC3339 timestamp")
	}
	return parsed, nil
}

func captureStatus(value string) bool {
	return oneOf(value, "healthy", "partial", "complete", "degraded")
}

func canonicalKind(value string) bool {
	return oneOf(value, "message", "thought", "tool_call", "tool_result", "artifact", "spawn", "lifecycle")
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func invalid(field string, message string) error {
	return &ValidationError{Field: field, Message: message}
}

func sourceKey(parts ...string) string {
	var key strings.Builder
	for _, part := range parts {
		fmt.Fprintf(&key, "%d:%s", len(part), part)
	}
	return key.String()
}

func stableID(prefix string, value string) string {
	sum := sha256.Sum256([]byte(value))
	return prefix + hex.EncodeToString(sum[:12])
}

func digest(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("marshal validated canonical value: %v", err))
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}
