package sessionanalytics_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/sessionanalytics"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
)

func identityMeta(kind, server, name string) map[string]any {
	value := map[string]any{"type": kind, "name": name}
	if kind == "mcp" {
		value["server"] = server
	}
	return map[string]any{canonical.ToolIdentityNamespace: value}
}

func capabilitySnapshot() canonical.AnalyticsSnapshot {
	s := emptySnapshot()
	s.Threads = append(s.Threads, canonical.ThreadRecord{ID: "child", SessionID: "session", Label: "Child", ParentThreadID: ptr("root")})
	s.Events = []canonical.EventRecord{
		toolEvent("mcp-start", "root", "same", 1, map[string]any{"title": "mcp__claude_ai_mail__send", "status": "pending", "_meta": identityMeta("mcp", "claude_ai_mail", "send")}),
		toolEvent("mcp-end", "root", "same", 2, map[string]any{"status": "completed"}),
		toolEvent("child-mcp", "child", "same", 1, map[string]any{"title": "mcp__claude_ai_mail__send", "status": "failed", "_meta": identityMeta("mcp", "claude_ai_mail", "send")}),
		toolEvent("skill-unknown", "root", "skill", 3, map[string]any{"title": "Skill", "_meta": identityMeta("skill", "", "commit")}),
		toolEvent("other-server", "root", "other", 4, map[string]any{"title": "MCP tool", "status": "in_progress", "_meta": identityMeta("mcp", "other", "send")}),
		toolEvent("clear-start", "root", "clear", 5, map[string]any{"title": "MCP tool", "_meta": identityMeta("mcp", "claude_ai_mail", "send")}),
		toolEvent("clear-end", "root", "clear", 6, map[string]any{"status": "completed", "_meta": map[string]any{canonical.ToolIdentityNamespace: nil}}),
		toolEvent("ordinary", "root", "ordinary", 7, map[string]any{"title": "mcp__mail__send", "rawInput": map[string]any{"skill": "pretend"}}),
		toolEvent("skill-failed", "root", "skill-failed", 8, map[string]any{"title": "Skill", "status": "failed", "_meta": identityMeta("skill", "", "commit")}),
		toolEvent("replace-start", "root", "replace", 9, map[string]any{"title": "Tool", "status": "pending", "_meta": identityMeta("mcp", "mail", "read")}),
		toolEvent("replace-end", "root", "replace", 10, map[string]any{"_meta": identityMeta("skill", "", "draft")}),
	}
	return s
}

func TestOpenCapabilitiesFoldExplicitIdentityAndCurrentOutcomes(t *testing.T) {
	s := capabilitySnapshot()
	r := open(t, s, sessionanalytics.Query{})
	want := sessionanalytics.Capabilities{MCPCalls: 3, SkillCalls: 3, UnclassifiedCalls: 2,
		MCP:    []sessionanalytics.MCPTool{{Server: "claude_ai_mail", Name: "send", Calls: 2, Completed: 1, Failed: 1}, {Server: "other", Name: "send", Calls: 1, InProgress: 1}},
		Skills: []sessionanalytics.Skill{{Name: "commit", Calls: 2, Failed: 1, Unknown: 1}, {Name: "draft", Calls: 1, Pending: 1}},
	}
	if !reflect.DeepEqual(r.Capabilities, want) || r.Summary.ToolCalls != 8 || r.AnalyticsVersion != 2 {
		t.Fatalf("incorrect capabilities: %+v", r)
	}
	for _, tc := range []struct {
		q   sessionanalytics.Query
		ids []string
	}{
		{sessionanalytics.Query{Metric: "mcp_tools"}, []string{"child-mcp", "mcp-end", "other-server"}},
		{sessionanalytics.Query{Metric: "mcp_tools", Server: "claude_ai_mail"}, []string{"child-mcp", "mcp-end"}},
		{sessionanalytics.Query{Metric: "mcp_tools", Capability: "send", Thread: "root"}, []string{"mcp-end", "other-server"}},
		{sessionanalytics.Query{Metric: "skills", Capability: "commit"}, []string{"skill-unknown", "skill-failed"}},
		{sessionanalytics.Query{Metric: "skills", Capability: "draft", Thread: "child"}, []string{}},
	} {
		view := open(t, s, tc.q)
		ids := []string{}
		for _, item := range view.Evidence.Items {
			ids = append(ids, item.EventID)
		}
		if !reflect.DeepEqual(ids, tc.ids) || !reflect.DeepEqual(view.Capabilities, r.Capabilities) || view.Summary != r.Summary {
			t.Fatalf("filters changed facts or selected wrong evidence: %+v %+v", tc.q, view)
		}
	}
	body, _ := json.Marshal(open(t, emptySnapshot(), sessionanalytics.Query{Metric: "skills"}))
	var wire map[string]any
	if err := json.Unmarshal(body, &wire); err != nil {
		t.Fatal(err)
	}
	caps := wire["capabilities"].(map[string]any)
	if caps["mcp"] == nil || caps["skills"] == nil {
		t.Fatal("empty capability arrays were null")
	}
}

func TestOpenCapabilityFiltersBindEveryCursorField(t *testing.T) {
	s := capabilitySnapshot()
	query := sessionanalytics.Query{Metric: "mcp_tools", Capability: "send", Limit: 1}
	first := open(t, s, query)
	if first.Evidence.NextCursor == "" {
		t.Fatal("missing continuation")
	}
	query.Snapshot, query.Cursor = first.Snapshot, first.Evidence.NextCursor
	second := open(t, s, query)
	if len(second.Evidence.Items) != 1 || second.Evidence.Items[0].EventID == first.Evidence.Items[0].EventID {
		t.Fatal("continuation duplicated evidence")
	}
	for _, changed := range []sessionanalytics.Query{
		{Metric: "skills", Capability: "send", Snapshot: query.Snapshot, Cursor: query.Cursor, Limit: 1},
		{Metric: "mcp_tools", Server: "other", Capability: "send", Snapshot: query.Snapshot, Cursor: query.Cursor, Limit: 1},
		{Metric: "mcp_tools", Capability: "read", Snapshot: query.Snapshot, Cursor: query.Cursor, Limit: 1},
		{Metric: "mcp_tools", Thread: "root", Capability: "send", Snapshot: query.Snapshot, Cursor: query.Cursor, Limit: 1},
	} {
		_, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), canonicalcontract.WebPrincipal(), "session", changed)
		var invalid *sessionanalytics.InvalidQueryError
		if !errors.As(err, &invalid) || invalid.Field != "cursor" {
			t.Fatalf("changed filters reused cursor: %+v %v", changed, err)
		}
	}
	for _, q := range []sessionanalytics.Query{{Capability: "send"}, {Metric: "skills", Server: "mail"}, {Metric: "mcp_tools", Tool: "MCP tool"}, {Metric: "mcp_tools", Capability: "missing"}, {Metric: "mcp_tools", Server: "missing"}} {
		_, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), canonicalcontract.WebPrincipal(), "session", q)
		var invalid *sessionanalytics.InvalidQueryError
		if !errors.As(err, &invalid) {
			t.Fatalf("accepted invalid capability filter: %+v %v", q, err)
		}
	}
}

func TestOpenBoundsCombinedCapabilityGroups(t *testing.T) {
	s := emptySnapshot()
	for n := 0; n <= sessionanalytics.MaxTools; n++ {
		kind := "mcp"
		if n%2 == 1 {
			kind = "skill"
		}
		s.Events = append(s.Events, toolEvent(fmt.Sprint(n), "root", fmt.Sprint(n), int64(n), map[string]any{"title": "Tool", "_meta": identityMeta(kind, "server", fmt.Sprint(n))}))
	}
	_, err := sessionanalytics.New(&snapshotStore{snapshot: s}).Open(t.Context(), canonicalcontract.WebPrincipal(), "session", sessionanalytics.Query{})
	if !errors.Is(err, sessionanalytics.ErrCapacity) {
		t.Fatalf("unbounded capability groups: %v", err)
	}
}

func TestOpenCapabilityUnicodeIdentityIsNotCollapsed(t *testing.T) {
	s := emptySnapshot()
	for n, name := range []string{"😀", `\ud800`, "�"} {
		s.Events = append(s.Events, toolEvent(fmt.Sprint(n), "root", fmt.Sprint(n), int64(n), map[string]any{"title": "Tool", "_meta": identityMeta("skill", "", name)}))
	}
	paired := event("escaped-emoji", "root", "tool_call", 3)
	paired.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"escaped-emoji","title":"Tool","_meta":{"atape.dev/tool-identity":{"type":"skill","name":"\ud83d\ude00"}}}`
	s.Events = append(s.Events, paired)
	r := open(t, s, sessionanalytics.Query{Metric: "skills"})
	if r.Capabilities.SkillCalls != 4 || len(r.Capabilities.Skills) != 3 || r.Capabilities.Skills[0].Name != "😀" || r.Capabilities.Skills[0].Calls != 2 {
		t.Fatalf("distinct Unicode identities collapsed: %+v", r.Capabilities)
	}
	for _, raw := range []string{`"\ud800"`, `"\udc00"`} {
		invalid := emptySnapshot()
		e := event("invalid", "root", "tool_call", 0)
		e.ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Tool","_meta":{"atape.dev/tool-identity":{"type":"skill","name":` + raw + `}}}`
		invalid.Events = []canonical.EventRecord{e}
		if _, err := sessionanalytics.New(&snapshotStore{snapshot: invalid}).Open(t.Context(), canonicalcontract.WebPrincipal(), "session", sessionanalytics.Query{}); err == nil {
			t.Fatal("invalid identity schema reached report")
		}
	}
}
