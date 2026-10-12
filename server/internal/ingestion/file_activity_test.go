package ingestion_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
)

func TestFileActivityAdmissionAndSnapshot(t *testing.T) {
	for _, profile := range []string{ingestion.LegacyCanonicalProfileVersion, ingestion.CanonicalProfileVersion, ingestion.UnknownTimeCanonicalProfileVersion, ingestion.ToolIdentityCanonicalProfileVersion, ingestion.StableToolCanonicalProfileVersion} {
		for _, activity := range []string{`null`, `[]`, `[{"operation":"read","path":" ./src/../a.go "},{"operation":"edit","path":"C:\\Work\\A.go"},{"operation":"search","path":"src"}]`} {
			t.Run(profile+"/"+activity, func(t *testing.T) {
				store := testStore()
				b := validBatch()
				b.CanonicalProfileVersion = profile
				b.Events[1].Kind = "tool_call"
				b.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Explicit files","_meta":{"atape.dev/tool-identity":null,"atape.dev/file-activity":` + activity + `},"rawInput":{"private":"input-only"},"rawOutput":"output-only"}`
				created, err := ingestion.NewIngestor(store).ApplyBatch(t.Context(), cliPrincipal(), b)
				if profile != ingestion.StableToolCanonicalProfileVersion {
					if err == nil {
						t.Fatal("old profile admitted file namespace")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				opened, err := conversation.NewMemory(store).OpenConversation(t.Context(), webPrincipal(), created.SessionID, "root")
				if err != nil || string(opened.Events[1].Tool.Meta.FileActivity) != activity {
					t.Fatalf("Reader changed explicit path facts: %+v %v", opened, err)
				}
				facts, ok, err := store.SessionAnalytics(t.Context(), webPrincipal(), created.SessionID, "")
				if err != nil || !ok {
					t.Fatalf("snapshot: %v %v", ok, err)
				}
				for _, event := range facts.Events {
					if event.ToolUpdateJSON == "" {
						continue
					}
					tool, err := canonical.ParseToolUpdate(event.ToolUpdateJSON)
					if err != nil || tool.Meta.FileActivity == nil || strings.Contains(event.ToolUpdateJSON, "input-only") || strings.Contains(event.ToolUpdateJSON, "output-only") || strings.Contains(event.ToolUpdateJSON, "rawInput") || strings.Contains(event.ToolUpdateJSON, "rawOutput") {
						t.Fatalf("snapshot lost facts or exposed payload: %+v %v", tool, err)
					}
				}
			})
		}
	}
}

func TestFileActivityClosedBoundsAndUnicode(t *testing.T) {
	encode := func(value any) string { data, _ := json.Marshal(value); return string(data) }
	entry := func(path string) map[string]string { return map[string]string{"operation": "read", "path": path} }
	invalid := []string{
		`{}`, `false`, `[null]`, `[{"operation":"read","path":null}]`, `[{"operation":"read","path":""}]`,
		`[{"operation":"delete","path":"a"}]`, `[{"operation":"READ","path":"a"}]`, `[{"path":"a"}]`,
		`[{"operation":"read","path":"a","extra":true}]`, `[{"operation":"read","path":"a","path":"b"}]`,
		`[{"operation":"read","path":"\ud800"}]`, `[{"operation":"read","path":"\udc00"}]`,
	}
	for _, path := range []string{"a\x00b", "a\nb", "a\tb", "a\u007fb", "a\u0085b", strings.Repeat("界", 683)} {
		invalid = append(invalid, encode([]any{entry(path)}))
	}
	tooMany := make([]any, canonical.MaxFileActivityEntries+1)
	for i := range tooMany {
		tooMany[i] = entry("a")
	}
	invalid = append(invalid, encode(tooMany), encode([]any{entry(strings.Repeat("a", 2048)), entry(strings.Repeat("b", 2048))}))
	for _, value := range invalid {
		t.Run(value, func(t *testing.T) {
			b := validBatch()
			b.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
			b.Events[1].Kind = "tool_call"
			b.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Files","_meta":{"atape.dev/tool-identity":null,"atape.dev/file-activity":` + value + `}}`
			if _, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), b); err == nil {
				t.Fatal("invalid file activity admitted")
			}
		})
	}
	valid := []string{`[]`, `null`, `[{"operation":"read","path":" "}]`, `[{"operation":"read","path":"\ud83d\ude00"}]`, `[{"operation":"read","path":"\\ud800"}]`, encode([]any{entry(strings.Repeat("a", 2048))})}
	exactEntries := make([]any, canonical.MaxFileActivityEntries)
	for i := range exactEntries {
		exactEntries[i] = entry("a")
	}
	valid = append(valid, encode(exactEntries))
	valid = append(valid, `[{"operation":"read","path":"<>&\u2028\u2029\\\""}]`)
	// The decoded JSON.stringify budget does not count unicode wire escapes.
	valid = append(valid, `[{"operation":"read","path":"`+strings.Repeat(`\u754c`, 682)+`"}]`)
	// 2 brackets + 2 entry overheads + comma + these path bytes = 4096.
	overhead := 2 + 2*(len(`{"operation":"","path":""}`)+len("read")) + 1
	valid = append(valid, encode([]any{entry(strings.Repeat("a", 2048)), entry(strings.Repeat("b", 4096-overhead-2048))}))
	invalidBudget := encode([]any{entry(strings.Repeat("a", 2048)), entry(strings.Repeat("b", 4097-overhead-2048))})
	for _, value := range append(valid, invalidBudget) {
		b := validBatch()
		b.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
		b.Events[1].Kind = "tool_call"
		b.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Files","_meta":{"atape.dev/tool-identity":null,"atape.dev/file-activity":` + value + `}}`
		_, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), b)
		if (err == nil) != (value != invalidBudget) {
			t.Fatalf("file byte budget disagreement: %d bytes, %v", len(value), err)
		}
	}
	// The identity key remains required in the closed envelope.
	b := validBatch()
	b.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
	b.Events[1].Kind = "tool_call"
	b.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Files","_meta":{"atape.dev/file-activity":[]}}`
	if _, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), b); err == nil {
		t.Fatal("missing identity key admitted")
	}
}
