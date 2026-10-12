package sessionanalytics_test

import (
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
)

func stableSnapshot() canonical.AnalyticsSnapshot {
	s := emptySnapshot()
	s.Events = []canonical.EventRecord{
		toolEvent("first", "root", "one", 1, map[string]any{"title": "ls /secret-one", "kind": "execute", "_meta": identityMeta("tool", "", "exec_command"), "rawInput": "payload-secret"}),
		toolEvent("first-final", "root", "one", 2, map[string]any{"title": "new command title", "status": "completed"}),
		toolEvent("second", "root", "two", 3, map[string]any{"title": "cat /secret-two", "kind": "execute", "_meta": identityMeta("tool", "", "exec_command")}),
		toolEvent("other-kind", "root", "three", 4, map[string]any{"title": "ls", "kind": "read", "_meta": identityMeta("tool", "", "exec_command"), "status": "failed"}),
		toolEvent("legacy", "root", "legacy", 5, map[string]any{"title": "exec_command", "kind": "execute", "rawInput": map[string]any{"tool": "exec_command"}}),
		toolEvent("clear", "root", "clear", 6, map[string]any{"title": "secret title", "kind": "execute", "_meta": identityMeta("tool", "", "exec_command")}),
		toolEvent("clear-final", "root", "clear", 7, map[string]any{"_meta": map[string]any{canonical.ToolIdentityNamespace: nil}}),
		toolEvent("mcp", "root", "mcp", 8, map[string]any{"title": "display", "kind": "read", "_meta": identityMeta("mcp", "docs", "read")}),
		toolEvent("skill", "root", "skill", 9, map[string]any{"title": "display", "kind": "other", "_meta": identityMeta("skill", "", "review")}),
		toolEvent("same-name", "root", "same-name", 10, map[string]any{"title": "display", "kind": "read", "_meta": identityMeta("tool", "", "docs/read")}),
	}
	for n := range s.Events {
		s.Events[n].SchemaVersion = "atape.acp-centered.v5"
		s.Events[n].OccurredAt = time.Date(2026, 10, 12, 0, 0, n, 0, time.UTC)
	}
	return s
}

func TestStableToolsGroupExplicitFactsAndPreserveUnknowns(t *testing.T) {
	s := stableSnapshot()
	r := open(t, s, sessionanalytics.Query{AnalyticsVersion: 4})
	if r.Summary.ToolCalls != 8 || *r.Summary.IdentifiedToolCalls != 6 || *r.Summary.UnidentifiedToolCalls != 2 || len(r.Tools) != 6 {
		t.Fatalf("coverage: %+v %+v", r.Summary, r.Tools)
	}
	var command, unknown sessionanalytics.Tool
	keys := map[string]bool{}
	for _, group := range r.Tools {
		if !regexp.MustCompile(`^tool:[0-9a-f]{64}$`).MatchString(group.Key) || keys[group.Key] {
			t.Fatalf("invalid/distinct group key: %+v", group)
		}
		keys[group.Key] = true
		if group.Identity != nil && group.Identity.Type == "tool" && group.Identity.Name == "exec_command" && group.Kind == "execute" {
			command = group
		}
		if group.Identity == nil {
			unknown = group
		}
	}
	if command.Calls != 2 || command.Completed != 1 || command.Unknown != 1 || command.Name != "exec_command" || unknown.Name != "unknown" || unknown.Calls != 2 || unknown.Unknown != 2 {
		t.Fatalf("invented facts or title-based grouping: %+v %+v", command, unknown)
	}
	if r.Capabilities.MCPCalls != 1 || r.Capabilities.SkillCalls != 1 || r.Capabilities.UnclassifiedCalls != 6 || r.Activity.RecordedTimeEvents != len(s.Events) {
		t.Fatalf("capability/clock semantics: %+v %+v", r.Capabilities, r.Activity)
	}
	filtered := open(t, s, sessionanalytics.Query{AnalyticsVersion: 4, Tool: command.Key})
	if len(filtered.Evidence.Items) != 2 || filtered.Evidence.Items[0].EventID != "first-final" || filtered.Evidence.Items[1].EventID != "second" || filtered.Evidence.Items[0].Label != "new command title" || filtered.Evidence.Items[1].Label != "cat /secret-two" || !reflect.DeepEqual(filtered.Tools, r.Tools) {
		t.Fatalf("wrong final anchors or aggregate changed: %+v", filtered)
	}
	unidentified := open(t, s, sessionanalytics.Query{AnalyticsVersion: 4, Tool: unknown.Key})
	if len(unidentified.Evidence.Items) != 2 || unidentified.Evidence.Items[0].EventID != "legacy" || unidentified.Evidence.Items[0].Label != "exec_command" || unidentified.Evidence.Items[1].EventID != "clear-final" || unidentified.Evidence.Items[1].Label != "secret title" {
		t.Fatalf("unknown group lost distinct call titles: %+v", unidentified.Evidence)
	}
	wire, _ := json.Marshal(r)
	for _, secret := range []string{"payload-secret", "rawInput", "rawOutput"} {
		if strings.Contains(string(wire), secret) {
			t.Fatalf("analytics leaked payload %q", secret)
		}
	}
	groups, _ := json.Marshal(r.Tools)
	if strings.Contains(string(groups), "secret title") || strings.Contains(string(groups), "new command title") || strings.Contains(string(groups), "cat /secret-two") {
		t.Fatal("display titles entered stable groups")
	}
	if !strings.Contains(string(wire), `"identity":null`) {
		t.Fatal("unknown identity was omitted")
	}
	for _, version := range []int{2, 3} {
		old := open(t, s, sessionanalytics.Query{AnalyticsVersion: version})
		wire, _ := json.Marshal(old)
		if strings.Contains(string(wire), `"identity"`) || strings.Contains(string(wire), `"key"`) || strings.Contains(string(wire), "identifiedToolCalls") || len(old.Tools) == len(r.Tools) {
			t.Fatalf("changed old representation: %s", wire)
		}
	}
	// Neither event ordering nor display titles enter the stable key.
	s.Events[0].ToolUpdateJSON = strings.ReplaceAll(s.Events[0].ToolUpdateJSON, "ls /secret-one", "unrelated title")
	s.Events[1].ToolUpdateJSON = strings.ReplaceAll(s.Events[1].ToolUpdateJSON, "new command title", "another title")
	if !reflect.DeepEqual(open(t, s, sessionanalytics.Query{AnalyticsVersion: 4}).Tools, r.Tools) {
		t.Fatal("titles changed stable groups")
	}
}

func TestStableToolSelectorsBindVersionSnapshotAndCursor(t *testing.T) {
	s := stableSnapshot()
	first := open(t, s, sessionanalytics.Query{AnalyticsVersion: 4, Limit: 1})
	var key string
	for _, tool := range first.Tools {
		if tool.Identity != nil && tool.Identity.Name == "exec_command" && tool.Kind == "execute" {
			key = tool.Key
		}
	}
	q := sessionanalytics.Query{AnalyticsVersion: 4, Tool: key, Limit: 1}
	page := open(t, s, q)
	q.Snapshot, q.Cursor = page.Snapshot, page.Evidence.NextCursor
	if page.Evidence.NextCursor == "" || open(t, s, q).Evidence.Items[0].EventID != "second" {
		t.Fatal("missing/incorrect continuation")
	}
	for _, mutate := range []func(*sessionanalytics.Query){
		func(q *sessionanalytics.Query) { q.AnalyticsVersion = 3 },
		func(q *sessionanalytics.Query) { q.Tool = "" },
		func(q *sessionanalytics.Query) { q.Thread = "root" },
		func(q *sessionanalytics.Query) { q.Metric = "unknown_tools" },
	} {
		changed := q
		mutate(&changed)
		_, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), canonicalcontract.WebPrincipal(), "session", changed)
		var invalid *sessionanalytics.InvalidQueryError
		if !errors.As(err, &invalid) || invalid.Field != "cursor" {
			t.Fatalf("cursor binding accepted change: %+v %v", changed, err)
		}
	}
	for _, selector := range []string{"exec_command", "tool:" + strings.Repeat("0", 64)} {
		_, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), canonicalcontract.WebPrincipal(), "session", sessionanalytics.Query{AnalyticsVersion: 4, Tool: selector})
		var invalid *sessionanalytics.InvalidQueryError
		if !errors.As(err, &invalid) || invalid.Field != "tool" {
			t.Fatalf("nonmember tool selector accepted: %v", err)
		}
	}
	// An otherwise valid group selector does not grant current content or access.
	s.SnapshotToken = "new-head"
	_, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), canonicalcontract.WebPrincipal(), "session", q)
	var stale *canonical.RefreshRequiredError
	if !errors.As(err, &stale) {
		t.Fatalf("source changed: %v", err)
	}
	_, err = sessionanalytics.New(&snapshotStore{missing: true}).Open(t.Context(), canonicalcontract.WebPrincipal(), "session", q)
	var concealed *sessionanalytics.NotFoundError
	if !errors.As(err, &concealed) {
		t.Fatalf("revoked access: %v", err)
	}
	r3 := open(t, stableSnapshot(), sessionanalytics.Query{AnalyticsVersion: 3, Metric: "records"})
	_, err = sessionanalytics.New(&snapshotStore{snapshot: stableSnapshot()}).Open(t.Context(), canonicalcontract.WebPrincipal(), "session", sessionanalytics.Query{AnalyticsVersion: 4, Metric: "records", Snapshot: r3.Snapshot, Range: r3.Activity.Buckets[0].Range})
	var invalid *sessionanalytics.InvalidQueryError
	if !errors.As(err, &invalid) || invalid.Field != "range" {
		t.Fatalf("range reused between versions: %v", err)
	}
}
