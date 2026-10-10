package canonical

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
)

const AnalyticsRecordLimit = 100000
const AnalyticsThreadLimit = 5000
const AnalyticsMetadataBytes = 32 << 20
const AnalyticsSourceBytes = 128 << 20

var ErrAnalyticsCapacity = errors.New("conversation analysis exceeds read capacity")

// AnalyticsSnapshot is one authorized current Canonical view, not a historical
// archive. Events contain only analysis metadata: no text or tool input/output.
type AnalyticsSnapshot struct {
	SnapshotToken string
	Head          string
	Session       SessionRecord
	Threads       []ThreadRecord
	Events        []EventRecord
	Usage         []UsageRecord
}

// EventBodyDigest keeps large content out of analysis reads while including its
// actual value in legacy conditional identity. A token is never authorization.
type EventBodyDigest struct{ Text, Tool string }

func AnalyticsBodyDigest(event EventRecord) EventBodyDigest {
	digest := func(value string) string { sum := sha256.Sum256([]byte(value)); return hex.EncodeToString(sum[:]) }
	return EventBodyDigest{Text: digest(event.Text), Tool: digest(event.ToolUpdateJSON)}
}

// AnalyticsEvent removes payloads without changing tool identity or state.
func AnalyticsEvent(event EventRecord) (EventRecord, error) {
	event.Text, event.RawRef = "", ""
	if event.ToolUpdateJSON != "" {
		_, err := ParseToolUpdate(event.ToolUpdateJSON)
		if err != nil {
			return EventRecord{}, err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(event.ToolUpdateJSON), &fields); err != nil {
			return EventRecord{}, err
		}
		delete(fields, "rawInput")
		delete(fields, "rawOutput")
		body, err := json.Marshal(fields)
		if err != nil {
			return EventRecord{}, err
		}
		event.ToolUpdateJSON = string(body)
	}
	return event, nil
}

// AnalyticsSnapshotToken is a versioned conditional read identity. Transport
// receipts and observation clocks cannot invalidate identical Canonical input.
// Callers supply digests of actual bodies, not stored revision digests, because
// compatible data migrations can change semantic values without rewriting them.
func AnalyticsSnapshotToken(snapshot AnalyticsSnapshot, bodies map[string]EventBodyDigest) string {
	if snapshot.Head != "" {
		return "publication:" + snapshot.Head
	}
	hash := sha256.New()
	encoder := json.NewEncoder(hash)
	_ = encoder.Encode("atape.canonical-snapshot.v1")
	session := snapshot.Session
	session.Digest = ""
	_ = encoder.Encode(session)
	threads := append([]ThreadRecord(nil), snapshot.Threads...)
	sort.Slice(threads, func(i, j int) bool { return threads[i].ID < threads[j].ID })
	for _, thread := range threads {
		thread.Digest = ""
		_ = encoder.Encode(thread)
	}
	events := append([]EventRecord(nil), snapshot.Events...)
	sort.Slice(events, func(i, j int) bool { return events[i].ID < events[j].ID })
	for _, event := range events {
		_ = encoder.Encode(struct {
			ID, Session, Thread, Source                        string
			Revision, Projection, Order                        int64
			Index                                              int
			OrderFidelity, Fidelity, Kind, Author, Time, Label string
			Child                                              *string
			Body                                               EventBodyDigest
		}{event.ID, event.SessionID, event.ThreadID, event.SourceKey, event.Revision, event.ProjectionRevision, event.SourceOrder, event.EventIndex, event.OrderFidelity, event.Fidelity, event.Kind, event.Author, event.OccurredAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00"), event.ToolLabel, event.ChildThreadID, bodies[event.ID]})
	}
	usage := append([]UsageRecord(nil), snapshot.Usage...)
	sort.Slice(usage, func(i, j int) bool { return usage[i].SourceKey < usage[j].SourceKey })
	for _, item := range usage {
		item.Digest = ""
		_ = encoder.Encode(item)
	}
	return "legacy:v1:" + hex.EncodeToString(hash.Sum(nil))
}

func (s *MemoryStore) SessionAnalytics(ctx context.Context, p authentication.Principal, sessionID, expected string) (AnalyticsSnapshot, bool, error) {
	if err := ctx.Err(); err != nil {
		return AnalyticsSnapshot{}, false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.analyticsLocked(ctx, p, sessionID, expected)
}

func (s *MemoryStore) analyticsLocked(ctx context.Context, p authentication.Principal, sessionID, expected string) (AnalyticsSnapshot, bool, error) {
	session, ok := s.sessions[sessionID]
	if !ok {
		return AnalyticsSnapshot{}, false, nil
	}
	project, ok := s.projects[session.ProjectID]
	if !ok || project.State == "deleted" {
		return AnalyticsSnapshot{}, false, nil
	}
	err := authorization.Enforce(s.authorizer.Evaluate(authorization.Input{Principal: p, Action: authorization.ConversationRead,
		Resource:   authorization.ResourceFacts{Kind: authorization.ConversationResource, TeamID: project.TeamID, CapturedByUserID: session.CapturedByUserID},
		Membership: s.memberships[membershipKey(project.TeamID, p.UserID)]}))
	if err != nil {
		if concealed(err) {
			return AnalyticsSnapshot{}, false, nil
		}
		return AnalyticsSnapshot{}, false, err
	}
	result := AnalyticsSnapshot{Session: session, Threads: []ThreadRecord{}, Events: []EventRecord{}, Usage: []UsageRecord{}}
	bodies := map[string]EventBodyDigest{}
	bytes := 0
	sourceBytes := 0
	for id := range s.threadIDsBySession[sessionID] {
		if len(result.Threads) >= AnalyticsThreadLimit {
			return result, false, ErrAnalyticsCapacity
		}
		result.Threads = append(result.Threads, cloneThread(s.threads[recordKey(sessionID, id)]))
		for eventID := range s.eventIDsByThread[recordKey(sessionID, id)] {
			if err := ctx.Err(); err != nil {
				return result, false, err
			}
			if len(result.Events) >= AnalyticsRecordLimit {
				return result, false, ErrAnalyticsCapacity
			}
			original := s.events[eventID]
			sourceBytes += len(original.Text) + len(original.ToolUpdateJSON) + len(original.ToolLabel) + 256
			if sourceBytes > AnalyticsSourceBytes {
				return result, false, ErrAnalyticsCapacity
			}
			bodies[eventID] = AnalyticsBodyDigest(original)
			event, err := AnalyticsEvent(cloneEvent(original))
			if err != nil {
				return result, false, err
			}
			bytes += len(event.ToolUpdateJSON) + len(event.ToolLabel) + len(event.ID) + len(event.ThreadID) + 256
			if bytes > AnalyticsMetadataBytes {
				return result, false, ErrAnalyticsCapacity
			}
			result.Events = append(result.Events, event)
		}
	}
	for _, item := range s.usage {
		if item.SessionID != sessionID {
			continue
		}
		if len(result.Usage) >= AnalyticsRecordLimit {
			return result, false, ErrAnalyticsCapacity
		}
		item.InputTokens, item.OutputTokens = cloneCounter(item.InputTokens), cloneCounter(item.OutputTokens)
		item.CacheReadTokens, item.CacheWriteTokens = cloneCounter(item.CacheReadTokens), cloneCounter(item.CacheWriteTokens)
		result.Usage = append(result.Usage, item)
	}
	result.SnapshotToken = AnalyticsSnapshotToken(result, bodies)
	if expected != "" && expected != result.SnapshotToken {
		return AnalyticsSnapshot{}, false, &RefreshRequiredError{}
	}
	return result, true, nil
}

func cloneCounter(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
