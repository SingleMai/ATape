package sessionanalytics_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
)

func fileEntry(operation, path string) map[string]any {
	return map[string]any{"operation": operation, "path": path}
}
func fileMeta(activity any) map[string]any {
	return map[string]any{canonical.ToolIdentityNamespace: nil, canonical.FileActivityNamespace: activity}
}
func fileSnapshot() canonical.AnalyticsSnapshot {
	s := emptySnapshot()
	parent := "root"
	s.Threads = append(s.Threads, canonical.ThreadRecord{ID: "child", SessionID: "session", ParentThreadID: &parent, CaptureStatus: "complete"})
	s.Events = []canonical.EventRecord{
		toolEvent("a-start", "root", "a", 1, map[string]any{"title": "Read display", "_meta": fileMeta([]any{fileEntry("read", "x.go"), fileEntry("read", "x.go"), fileEntry("edit", "x.go"), fileEntry("search", "src")})}),
		toolEvent("a-final", "root", "a", 2, map[string]any{"title": "Last original title", "status": "completed"}),
		toolEvent("b", "root", "b", 3, map[string]any{"title": "Another title", "_meta": fileMeta([]any{fileEntry("read", "x.go"), fileEntry("read", "./x.go"), fileEntry("search", "other")})}),
		toolEvent("child", "child", "a", 4, map[string]any{"title": "Child read", "_meta": fileMeta([]any{fileEntry("read", "x.go")})}),
		toolEvent("clear-start", "root", "clear", 5, map[string]any{"_meta": fileMeta([]any{fileEntry("read", "cleared")})}),
		toolEvent("clear-final", "root", "clear", 6, map[string]any{"_meta": fileMeta(nil)}),
		toolEvent("empty-start", "root", "empty", 7, map[string]any{"_meta": fileMeta([]any{fileEntry("read", "emptied")})}),
		toolEvent("empty-final", "root", "empty", 8, map[string]any{"_meta": fileMeta([]any{})}),
		toolEvent("replace-start", "root", "replace", 9, map[string]any{"_meta": fileMeta([]any{fileEntry("read", "replaced")})}),
		toolEvent("replace-final", "root", "replace", 10, map[string]any{"title": "Edit new path", "_meta": fileMeta([]any{fileEntry("edit", "new.go")})}),
		toolEvent("unknown", "root", "unknown", 11, map[string]any{"title": "Read x.go", "kind": "read"}),
	}
	// An identity-only envelope must inherit file facts independently.
	s.Events[1].ToolUpdateJSON = strings.TrimSuffix(s.Events[1].ToolUpdateJSON, "}") + `,"_meta":{"atape.dev/tool-identity":null}}`
	s.Events[1].OccurredAt = time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	for index := range s.Events {
		s.Events[index].SchemaVersion = "atape.acp-centered.v5"
	}
	return s
}

func TestFileActivityFoldsExplicitFactsAndOriginalAnchors(t *testing.T) {
	s := fileSnapshot()
	r := open(t, s, sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files"})
	f := r.FileActivity
	if f == nil || f.CallsWithActivity != 4 || f.CallsWithoutActivity != 3 || f.ReadCalls != 3 || f.EditCalls != 2 || f.SearchCalls != 2 || f.UniquePaths != 5 || len(f.Paths) != 5 {
		t.Fatalf("file coverage and operation accounting: %+v", f)
	}
	if f.CallsWithActivity+f.CallsWithoutActivity != r.Summary.ToolCalls || f.Paths[0].Path != "x.go" || f.Paths[0].Calls != 3 || f.Paths[0].ReadCalls != 3 || f.Paths[0].EditCalls != 1 {
		t.Fatalf("distinct call/path accounting: %+v", f)
	}
	for _, path := range f.Paths {
		if !regexp.MustCompile(`^file:[0-9a-f]{64}$`).MatchString(path.Key) {
			t.Fatalf("opaque key: %+v", path)
		}
	}
	if len(r.Evidence.Items) != 4 || r.Evidence.Items[0].EventID != "a-final" || r.Evidence.Items[0].Label != "Last original title" || r.Evidence.Items[0].Kind != "tool_result" || r.Evidence.Items[0].ClockQuality != "recorded" {
		t.Fatalf("file evidence lost final original update: %+v", r.Evidence)
	}
	wire, _ := json.Marshal(r)
	for _, forbidden := range []string{"cleared", "emptied", "replaced", "rawInput", "rawOutput"} {
		if strings.Contains(string(wire), forbidden) {
			t.Fatalf("cleared or payload fact escaped: %s", forbidden)
		}
	}
	for _, version := range []int{2, 3} {
		old := open(t, s, sessionanalytics.Query{AnalyticsVersion: version})
		body, _ := json.Marshal(old)
		if old.FileActivity != nil || strings.Contains(string(body), `"fileActivity"`) {
			t.Fatalf("old version shape changed: %s", body)
		}
	}
	empty := open(t, emptySnapshot(), sessionanalytics.Query{AnalyticsVersion: 4})
	if empty.FileActivity == nil || empty.FileActivity.Paths == nil || empty.FileActivity.UniquePaths != 0 {
		t.Fatalf("empty required report: %+v", empty.FileActivity)
	}
}

func TestFileActivityFiltersPaginationAndSnapshotBinding(t *testing.T) {
	store := &snapshotStore{snapshot: fileSnapshot()}
	m := sessionanalytics.New(store)
	initial := open(t, store.snapshot, sessionanalytics.Query{AnalyticsVersion: 4})
	xKey := initial.FileActivity.Paths[0].Key
	q := sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files", File: xKey, Operation: "read", Limit: 1, Snapshot: initial.Snapshot}
	first, err := m.Open(t.Context(), principal, "session", q)
	if err != nil || len(first.Evidence.Items) != 1 || first.Evidence.Items[0].EventID != "a-final" || first.Evidence.NextCursor == "" {
		t.Fatalf("file first page: %+v %v", first.Evidence, err)
	}
	q.Cursor = first.Evidence.NextCursor
	next, err := m.Open(t.Context(), principal, "session", q)
	if err != nil || len(next.Evidence.Items) != 1 || next.Evidence.Items[0].EventID != "b" {
		t.Fatalf("file next page: %+v %v", next.Evidence, err)
	}
	for _, change := range []func(*sessionanalytics.Query){
		func(q *sessionanalytics.Query) { q.Operation = "edit" }, func(q *sessionanalytics.Query) { q.File = "" }, func(q *sessionanalytics.Query) { q.Thread = "child" }, func(q *sessionanalytics.Query) { q.Metric, q.File, q.Operation = "tools", "", "" },
	} {
		changed := q
		change(&changed)
		if _, err := m.Open(t.Context(), principal, "session", changed); err == nil {
			t.Fatal("file cursor escaped its filters")
		}
	}
	edit := open(t, store.snapshot, sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files", File: xKey, Operation: "edit"})
	if len(edit.Evidence.Items) != 1 || edit.Evidence.Items[0].EventID != "a-final" {
		t.Fatalf("AND file/operation selection: %+v", edit.Evidence)
	}
	child := open(t, store.snapshot, sessionanalytics.Query{AnalyticsVersion: 4, Metric: "files", File: xKey, Thread: "child"})
	if len(child.Evidence.Items) != 1 || child.Evidence.Items[0].EventID != "child" || child.FileActivity.CallsWithActivity != 4 {
		t.Fatalf("scope affected Session-wide report: %+v", child)
	}
	for _, invalid := range []sessionanalytics.Query{
		{AnalyticsVersion: 3, Metric: "files"}, {AnalyticsVersion: 4, File: xKey}, {AnalyticsVersion: 4, Operation: "read"}, {AnalyticsVersion: 4, Metric: "files", Operation: "delete"}, {AnalyticsVersion: 4, Metric: "files", File: "x.go"}, {AnalyticsVersion: 4, Metric: "files", File: "file:" + strings.Repeat("0", 64)}, {AnalyticsVersion: 4, Metric: "files", Tool: "other"}, {AnalyticsVersion: 4, Metric: "files", Range: "other"},
	} {
		_, err := m.Open(t.Context(), principal, "session", invalid)
		var typed *sessionanalytics.InvalidQueryError
		if !errors.As(err, &typed) {
			t.Fatalf("invalid file query did not return typed failure: %+v %v", invalid, err)
		}
	}
	store.snapshot.SnapshotToken = "legacy:v1:changed-path"
	_, err = m.Open(t.Context(), principal, "session", q)
	var stale *canonical.RefreshRequiredError
	if !errors.As(err, &stale) {
		t.Fatalf("changed source retained file cursor: %v", err)
	}
}

func TestFileActivityExactPathIdentityAndCapacity(t *testing.T) {
	s := emptySnapshot()
	for index, path := range []string{"A.go", "a.go", "./a.go", " a.go ", "C:\\Work\\a.go", "é", "e\u0301"} {
		s.Events = append(s.Events, toolEvent(fmt.Sprint(index), "root", fmt.Sprint(index), int64(index), map[string]any{"_meta": fileMeta([]any{fileEntry("read", path)})}))
	}
	r := open(t, s, sessionanalytics.Query{AnalyticsVersion: 4})
	if r.FileActivity.UniquePaths != 7 {
		t.Fatalf("paths were normalized: %+v", r.FileActivity)
	}
	keys := make(map[string]bool)
	for _, path := range r.FileActivity.Paths {
		if keys[path.Key] {
			t.Fatal("different exact paths share a selector")
		}
		keys[path.Key] = true
	}
	s = emptySnapshot()
	for index := 0; index <= sessionanalytics.MaxFilePaths; index++ {
		s.Events = append(s.Events, toolEvent(fmt.Sprint(index), "root", fmt.Sprint(index), int64(index), map[string]any{"_meta": fileMeta([]any{fileEntry("search", fmt.Sprintf("scope/%d", index))})}))
	}
	if _, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 4}); !errors.Is(err, sessionanalytics.ErrCapacity) {
		t.Fatalf("unbounded paths: %v", err)
	}
	// The additional path budget cannot change old analytics semantics.
	if _, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), principal, "session", sessionanalytics.Query{AnalyticsVersion: 3}); err != nil {
		t.Fatalf("new file bound changed v3: %v", err)
	}
}
