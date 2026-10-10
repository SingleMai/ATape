// Package sessionanalytics derives bounded, provider-independent statistics and
// evidence from one authorized Canonical snapshot. Raw and Search are not inputs.
package sessionanalytics

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
)

const (
	Version                = 1
	MaxFacts               = canonical.AnalyticsRecordLimit
	MaxThreads             = canonical.AnalyticsThreadLimit
	MaxTools               = 2000
	MaxModels              = 1000
	MaxResponseBytes       = 2 << 20
	maxSafeInteger   int64 = 9007199254740991
)

var ErrCapacity = errors.New("session analysis exceeds supported capacity")

// Store is the authorized, consistent Canonical snapshot Seam implemented by
// the production PostgreSQL and demo memory Adapters.
type Store interface {
	SessionAnalytics(context.Context, authentication.Principal, string, string) (canonical.AnalyticsSnapshot, bool, error)
}

type Module struct{ store Store }

func New(store Store) *Module { return &Module{store: store} }

type Query struct {
	Snapshot, Metric, Thread, Tool, Cursor string
	Limit                                  int
}
type InvalidQueryError struct{ Field, Reason string }

func (e *InvalidQueryError) Error() string {
	return fmt.Sprintf("invalid analysis %s: %s", e.Field, e.Reason)
}

type NotFoundError struct{ SessionID string }

func (e *NotFoundError) Error() string { return fmt.Sprintf("session %q was not found", e.SessionID) }

type Tokens struct {
	Total             *int64 `json:"total"`
	Input             *int64 `json:"input"`
	Output            *int64 `json:"output"`
	CacheRead         *int64 `json:"cacheRead"`
	CacheWrite        *int64 `json:"cacheWrite"`
	RecordedSamples   int    `json:"recordedSamples"`
	IncompleteSamples int    `json:"incompleteSamples"`
}
type Summary struct {
	RootUserInputs     int `json:"rootUserInputs"`
	MessageFragments   int `json:"messageFragments"`
	ThoughtFragments   int `json:"thoughtFragments"`
	ToolCalls          int `json:"toolCalls"`
	ChildThreads       int `json:"childThreads"`
	KnownTimeEvents    int `json:"knownTimeEvents"`
	UnknownTimeEvents  int `json:"unknownTimeEvents"`
	UnlinkedToolEvents int `json:"unlinkedToolEvents"`
}
type Tool struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Calls      int    `json:"calls"`
	Completed  int    `json:"completed"`
	Failed     int    `json:"failed"`
	Pending    int    `json:"pending"`
	InProgress int    `json:"inProgress"`
	Unknown    int    `json:"unknown"`
}
type Thread struct {
	ID             string  `json:"id"`
	Label          string  `json:"label"`
	ParentThreadID *string `json:"parentThreadId,omitempty"`
	CaptureStatus  string  `json:"captureStatus"`
	EventCount     int     `json:"eventCount"`
	ToolCalls      int     `json:"toolCalls"`
	Tokens         Tokens  `json:"tokens"`
}
type ModelUsage struct {
	Model   string `json:"model"`
	Samples int    `json:"samples"`
	Tokens  Tokens `json:"tokens"`
}
type Usage struct {
	Samples int          `json:"samples"`
	Tokens  Tokens       `json:"tokens"`
	Models  []ModelUsage `json:"models"`
}
type EvidenceItem struct {
	EventID    string  `json:"eventId"`
	ThreadID   string  `json:"threadId"`
	Kind       string  `json:"kind"`
	Label      string  `json:"label"`
	OccurredAt *string `json:"occurredAt"`
}
type Evidence struct {
	Items      []EvidenceItem `json:"items"`
	NextCursor string         `json:"nextCursor,omitempty"`
}
type Result struct {
	Snapshot         string   `json:"snapshot"`
	Head             string   `json:"head,omitempty"`
	AnalyticsVersion int      `json:"analyticsVersion"`
	SessionID        string   `json:"sessionId"`
	CaptureStatus    string   `json:"captureStatus"`
	Summary          Summary  `json:"summary"`
	Tools            []Tool   `json:"tools"`
	Threads          []Thread `json:"threads"`
	Usage            Usage    `json:"usage"`
	Evidence         Evidence `json:"evidence"`
}

// Open always rechecks authorization at the snapshot Seam. Query filters only
// the evidence page; statistics describe the complete selected snapshot.
func (m *Module) Open(ctx context.Context, principal authentication.Principal, sessionID string, query Query) (result Result, err error) {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	ctx, span := otel.Tracer("atape/sessionanalytics").Start(ctx, "SessionAnalytics.Open")
	defer func() {
		if err != nil {
			span.SetStatus(codes.Error, "session analysis failed")
		}
		span.End()
	}()
	q, offset, err := validateQuery(sessionID, query)
	if err != nil {
		return Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	snapshot, ok, err := m.store.SessionAnalytics(ctx, principal, sessionID, q.Snapshot)
	if errors.Is(err, canonical.ErrAnalyticsCapacity) {
		return Result{}, ErrCapacity
	}
	if err != nil {
		return Result{}, err
	}
	if !ok {
		return Result{}, &NotFoundError{SessionID: sessionID}
	}
	if snapshot.Session.ID != sessionID {
		return Result{}, errors.New("analysis snapshot is outside requested session")
	}
	if q.Snapshot != "" && snapshot.SnapshotToken != q.Snapshot {
		return Result{}, &canonical.RefreshRequiredError{Head: snapshot.Head}
	}
	if snapshot.SnapshotToken == "" {
		return Result{}, errors.New("analysis snapshot has no identity")
	}
	result, err = derive(ctx, snapshot, q, offset)
	if err != nil {
		return Result{}, err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return Result{}, fmt.Errorf("encode session analysis: %w", err)
	}
	if len(encoded) > MaxResponseBytes {
		return Result{}, ErrCapacity
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	return result, nil
}

type pageCursor struct {
	Binding string `json:"b"`
	Offset  int    `json:"o"`
}

func binding(sessionID string, q Query) string {
	encoded, _ := json.Marshal([]any{Version, sessionID, q.Snapshot, q.Metric, q.Thread, q.Tool})
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}
func validateQuery(sessionID string, q Query) (Query, int, error) {
	for field, value := range map[string]string{"sessionId": sessionID, "snapshot": q.Snapshot, "thread": q.Thread, "tool": q.Tool} {
		limit := 500
		if field == "snapshot" {
			limit = 200
		}
		if len(value) > limit || !utf8.ValidString(value) {
			return q, 0, &InvalidQueryError{field, "must be bounded UTF-8"}
		}
	}
	if sessionID == "" {
		return q, 0, &InvalidQueryError{"sessionId", "is required"}
	}
	if q.Metric == "" {
		q.Metric = "tools"
	}
	switch q.Metric {
	case "tools", "failed_tools", "unknown_tools", "user_inputs", "thoughts", "threads":
	default:
		return q, 0, &InvalidQueryError{"metric", "is not supported"}
	}
	if q.Tool != "" && q.Metric != "tools" && q.Metric != "failed_tools" && q.Metric != "unknown_tools" {
		return q, 0, &InvalidQueryError{"tool", "only applies to tool metrics"}
	}
	if q.Limit == 0 {
		q.Limit = 20
	}
	if q.Limit < 1 || q.Limit > 100 {
		return q, 0, &InvalidQueryError{"limit", "must be between 1 and 100"}
	}
	if q.Cursor == "" {
		return q, 0, nil
	}
	bad := &InvalidQueryError{"cursor", "must match this session, snapshot and filters"}
	if q.Snapshot == "" || len(q.Cursor) > 1024 {
		return q, 0, bad
	}
	data, err := base64.RawURLEncoding.DecodeString(q.Cursor)
	if err != nil {
		return q, 0, bad
	}
	var cursor pageCursor
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&cursor) != nil || decoder.Decode(new(any)) != io.EOF || cursor.Binding != binding(sessionID, q) || cursor.Offset < 1 || cursor.Offset > MaxFacts {
		return q, 0, bad
	}
	return q, cursor.Offset, nil
}

type callKey struct{ thread, id string }
type toolCall struct {
	name, kind, status string
	event              canonical.EventRecord
}
type inputKey struct {
	thread string
	order  int64
}

func derive(ctx context.Context, s canonical.AnalyticsSnapshot, q Query, offset int) (Result, error) {
	if len(s.Events) > MaxFacts || len(s.Usage) > MaxFacts || len(s.Threads) > MaxThreads {
		return Result{}, ErrCapacity
	}
	r := Result{Snapshot: s.SnapshotToken, Head: s.Head, AnalyticsVersion: Version, SessionID: s.Session.ID, CaptureStatus: s.Session.CaptureStatus,
		Tools: []Tool{}, Threads: []Thread{}, Usage: Usage{Models: []ModelUsage{}}, Evidence: Evidence{Items: []EvidenceItem{}}}
	threads := make(map[string]*Thread, len(s.Threads))
	threadTokens := make(map[string]*tokenSum, len(s.Threads))
	for _, source := range s.Threads {
		if source.SessionID != s.Session.ID {
			return Result{}, errors.New("analysis thread is outside snapshot")
		}
		if _, exists := threads[source.ID]; exists {
			return Result{}, errors.New("duplicate analysis thread")
		}
		threads[source.ID] = &Thread{ID: source.ID, Label: source.Label, ParentThreadID: source.ParentThreadID, CaptureStatus: source.CaptureStatus}
		threadTokens[source.ID] = &tokenSum{}
		if source.ParentThreadID != nil {
			r.Summary.ChildThreads++
		}
	}
	if q.Thread != "" && threads[q.Thread] == nil {
		return Result{}, &InvalidQueryError{"thread", "is outside this snapshot"}
	}
	// Work on a private slice: neither sorting nor accounting mutates a snapshot.
	events := append([]canonical.EventRecord(nil), s.Events...)
	sort.Slice(events, func(i, j int) bool {
		a, b := events[i], events[j]
		if a.SourceOrder != b.SourceOrder {
			return a.SourceOrder < b.SourceOrder
		}
		if a.EventIndex != b.EventIndex {
			return a.EventIndex < b.EventIndex
		}
		if a.ThreadID != b.ThreadID {
			return a.ThreadID < b.ThreadID
		}
		return a.ID < b.ID
	})
	calls := make(map[callKey]*toolCall)
	inputs := make(map[inputKey]bool)
	candidates := make(map[string]EvidenceItem)
	firstThreadEvent := make(map[string]canonical.EventRecord)
	metadataBytes := 0
	for index, event := range events {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return Result{}, err
			}
		}
		thread := threads[event.ThreadID]
		if thread == nil || event.SessionID != s.Session.ID {
			return Result{}, errors.New("analysis event is outside snapshot")
		}
		metadataBytes += canonical.AnalyticsEventMetadataBytes(event)
		if metadataBytes > canonical.AnalyticsMetadataBytes || len(event.ToolUpdateJSON) > 8192 {
			return Result{}, ErrCapacity
		}
		thread.EventCount++
		if event.OccurredAt.IsZero() {
			r.Summary.UnknownTimeEvents++
		} else {
			r.Summary.KnownTimeEvents++
		}
		if _, exists := firstThreadEvent[event.ThreadID]; !exists {
			firstThreadEvent[event.ThreadID] = event
		}
		if event.Kind == "message" {
			r.Summary.MessageFragments++
			if thread.ParentThreadID == nil && strings.TrimSpace(s.Session.Actor.Name) != "" && strings.EqualFold(strings.TrimSpace(event.Author), strings.TrimSpace(s.Session.Actor.Name)) {
				key := inputKey{event.ThreadID, event.SourceOrder}
				if !inputs[key] {
					inputs[key] = true
					r.Summary.RootUserInputs++
					if q.Metric == "user_inputs" {
						candidates[event.ID] = evidence(event, "User input")
					}
				}
			}
		}
		if event.Kind == "thought" {
			r.Summary.ThoughtFragments++
			if q.Metric == "thoughts" {
				candidates[event.ID] = evidence(event, "Thought fragment")
			}
		}
		if event.ToolUpdateJSON == "" {
			if event.Kind == "tool_call" || event.Kind == "tool_result" {
				r.Summary.UnlinkedToolEvents++
			}
			continue
		}
		update, err := canonical.ParseToolUpdate(event.ToolUpdateJSON)
		if err != nil {
			return Result{}, fmt.Errorf("read analysis tool metadata: %w", err)
		}
		key := callKey{event.ThreadID, update.ToolCallID}
		call := calls[key]
		if call == nil {
			call = &toolCall{name: "unknown", kind: "unknown", event: event}
			calls[key] = call
		}
		// Explicit nullable updates clear a fact; absent fields preserve it.
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(event.ToolUpdateJSON), &fields); err != nil {
			return Result{}, err
		}
		if _, present := fields["title"]; present {
			call.name = "unknown"
			if update.Title != nil && *update.Title != "" {
				call.name = *update.Title
			}
		}
		if _, present := fields["kind"]; present {
			call.kind = "unknown"
			if update.Kind != nil {
				call.kind = *update.Kind
			}
		}
		if _, present := fields["status"]; present {
			call.status = ""
			if update.Status != nil {
				call.status = *update.Status
			}
		}
		call.event = event
	}
	groups := make(map[[2]string]*Tool)
	toolNames := make(map[string]bool)
	for key, call := range calls {
		groupKey := [2]string{call.name, call.kind}
		group := groups[groupKey]
		if group == nil {
			if len(groups) >= MaxTools {
				return Result{}, ErrCapacity
			}
			group = &Tool{Name: call.name, Kind: call.kind}
			groups[groupKey] = group
		}
		toolNames[call.name] = true
		group.Calls++
		r.Summary.ToolCalls++
		threads[key.thread].ToolCalls++
		switch call.status {
		case "completed":
			group.Completed++
		case "failed":
			group.Failed++
		case "pending":
			group.Pending++
		case "in_progress":
			group.InProgress++
		default:
			group.Unknown++
		}
		matches := q.Metric == "tools" || q.Metric == "failed_tools" && call.status == "failed" || q.Metric == "unknown_tools" && call.status == ""
		if matches && (q.Tool == "" || q.Tool == call.name) {
			candidates[call.event.ID] = evidence(call.event, call.name)
		}
	}
	if q.Tool != "" && !toolNames[q.Tool] {
		return Result{}, &InvalidQueryError{"tool", "is outside this snapshot"}
	}
	for _, group := range groups {
		r.Tools = append(r.Tools, *group)
	}
	sort.Slice(r.Tools, func(i, j int) bool {
		a, b := r.Tools[i], r.Tools[j]
		if a.Calls != b.Calls {
			return a.Calls > b.Calls
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.Kind < b.Kind
	})
	if q.Metric == "threads" {
		for id, event := range firstThreadEvent {
			if threads[id].ParentThreadID != nil {
				candidates[event.ID] = evidence(event, threads[id].Label)
			}
		}
	}
	var allTokens tokenSum
	models := make(map[string]*tokenSum)
	modelSamples := make(map[string]int)
	for index, u := range s.Usage {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return Result{}, err
			}
		}
		if u.SessionID != s.Session.ID || threads[u.ThreadID] == nil {
			return Result{}, errors.New("analysis usage is outside snapshot")
		}
		if models[u.Model] == nil {
			if len(models) >= MaxModels {
				return Result{}, ErrCapacity
			}
			models[u.Model] = &tokenSum{}
		}
		allTokens.add(u)
		threadTokens[u.ThreadID].add(u)
		models[u.Model].add(u)
		modelSamples[u.Model]++
	}
	r.Usage.Samples = len(s.Usage)
	r.Usage.Tokens = allTokens.get()
	for model, tokens := range models {
		r.Usage.Models = append(r.Usage.Models, ModelUsage{Model: model, Samples: modelSamples[model], Tokens: tokens.get()})
	}
	sort.Slice(r.Usage.Models, func(i, j int) bool { return r.Usage.Models[i].Model < r.Usage.Models[j].Model })
	for id, thread := range threads {
		thread.Tokens = threadTokens[id].get()
		r.Threads = append(r.Threads, *thread)
	}
	sort.Slice(r.Threads, func(i, j int) bool { return r.Threads[i].ID < r.Threads[j].ID })
	matched := 0
	for _, event := range events {
		item, ok := candidates[event.ID]
		if !ok || q.Thread != "" && q.Thread != event.ThreadID {
			continue
		}
		if matched >= offset && len(r.Evidence.Items) < q.Limit {
			r.Evidence.Items = append(r.Evidence.Items, item)
		}
		matched++
		if matched > offset+q.Limit {
			q.Snapshot = r.Snapshot
			data, _ := json.Marshal(pageCursor{Binding: binding(r.SessionID, q), Offset: offset + q.Limit})
			r.Evidence.NextCursor = base64.RawURLEncoding.EncodeToString(data)
			break
		}
	}
	if offset > matched {
		return Result{}, &InvalidQueryError{"cursor", "is beyond the matching evidence"}
	}
	return r, nil
}

func evidence(e canonical.EventRecord, label string) EvidenceItem {
	var at *string
	if !e.OccurredAt.IsZero() {
		value := e.OccurredAt.UTC().Format(time.RFC3339Nano)
		at = &value
	}
	return EvidenceItem{EventID: e.ID, ThreadID: e.ThreadID, Kind: e.Kind, Label: label, OccurredAt: at}
}

type tokenSum struct {
	count, recorded, incomplete int
	values                      [4]int64
	complete                    [4]bool
}

func (t *tokenSum) add(u canonical.UsageRecord) {
	if t.count == 0 {
		t.complete = [4]bool{true, true, true, true}
	}
	t.count++
	any, incomplete := false, false
	for i, value := range []*int64{u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheWriteTokens} {
		if value == nil {
			t.complete[i] = false
			incomplete = true
			continue
		}
		any = true
		if *value < 0 || *value > maxSafeInteger || t.values[i] > maxSafeInteger-*value {
			t.complete[i] = false
			incomplete = true
			continue
		}
		t.values[i] += *value
	}
	if any {
		t.recorded++
	}
	if incomplete {
		t.incomplete++
	}
}
func (t *tokenSum) get() Tokens {
	r := Tokens{RecordedSamples: t.recorded, IncompleteSamples: t.incomplete}
	columns := []**int64{&r.Input, &r.Output, &r.CacheRead, &r.CacheWrite}
	for i, dst := range columns {
		if t.count > 0 && t.complete[i] {
			value := t.values[i]
			*dst = &value
		}
	}
	if r.Input != nil && r.Output != nil && *r.Input <= maxSafeInteger-*r.Output {
		n := *r.Input + *r.Output
		r.Total = &n
	}
	return r
}
