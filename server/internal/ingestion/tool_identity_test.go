package ingestion_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
)

func TestToolIdentityProfilesAndUnknownClocks(t *testing.T) {
	for _, profile := range []string{ingestion.LegacyCanonicalProfileVersion, ingestion.CanonicalProfileVersion, ingestion.UnknownTimeCanonicalProfileVersion, ingestion.ToolIdentityCanonicalProfileVersion, ingestion.StableToolCanonicalProfileVersion} {
		for _, identity := range []string{`{"type":"mcp","server":"claude_ai_mail","name":"send"}`, `{"type":"skill","name":"commit"}`, `{"type":"tool","name":"exec_command"}`, `null`} {
			t.Run(profile+"/"+identity, func(t *testing.T) {
				store := testStore()
				batch := validBatch()
				batch.CanonicalProfileVersion = profile
				batch.Events[1].Kind = "tool_call"
				batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"identity-call","title":"Recorded tool","_meta":{"atape.dev/tool-identity":` + identity + `},"rawInput":{"secret":"source-only"}}`
				writer := ingestion.NewIngestor(store)
				created, err := writer.ApplyBatch(t.Context(), cliPrincipal(), batch)
				if profile != ingestion.ToolIdentityCanonicalProfileVersion && profile != ingestion.StableToolCanonicalProfileVersion || strings.Contains(identity, `"type":"tool"`) && profile != ingestion.StableToolCanonicalProfileVersion {
					if err == nil {
						t.Fatal("old profile admitted identity metadata")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				opened, err := conversation.NewMemory(store).OpenConversation(t.Context(), webPrincipal(), created.SessionID, "root")
				if err != nil {
					t.Fatal(err)
				}
				meta := opened.Events[1].Tool.Meta
				if meta == nil || (identity == "null") != (meta.Identity == nil) {
					t.Fatalf("reader lost metadata: %+v", meta)
				}
				facts, visible, err := store.SessionAnalytics(t.Context(), webPrincipal(), created.SessionID, "")
				if err != nil || !visible {
					t.Fatalf("analysis snapshot: %v %v", visible, err)
				}
				found := false
				for _, event := range facts.Events {
					if event.ToolUpdateJSON == "" {
						continue
					}
					found = strings.Contains(event.ToolUpdateJSON, `"_meta"`)
					if strings.Contains(event.ToolUpdateJSON, "source-only") || strings.Contains(event.ToolUpdateJSON, "rawInput") {
						t.Fatal("snapshot exposed input")
					}
				}
				if !found {
					t.Fatal("snapshot lost identity")
				}
				batch.BatchID = "identity-unknown-clock"
				batch.Session.Revision++
				batch.Session.UpdatedAt, batch.Session.UpdatedAtUnknown = "", true
				batch.Events[1].Revision++
				batch.Events[1].OccurredAt, batch.Events[1].OccurredAtUnknown = "", true
				if _, err := writer.ApplyBatch(t.Context(), cliPrincipal(), batch); err != nil {
					t.Fatal(err)
				}
				opened, err = conversation.NewMemory(store).OpenConversation(t.Context(), webPrincipal(), created.SessionID, "root")
				if err != nil || opened.Session.UpdatedAt != nil || opened.Events[1].OccurredAt != nil {
					t.Fatalf("v4 manufactured clock: %+v %v", opened, err)
				}
			})
		}
	}
}

func TestToolIdentityClosedEnvelopeAndUTF8ByteBounds(t *testing.T) {
	invalid := []string{`null`, `{}`, `{"other":null}`, `{"atape.dev/tool-identity":null,"other":null}`,
		`{"atape.dev/tool-identity":{}}`, `{"atape.dev/tool-identity":{"type":"unknown","name":"read"}}`,
		`{"atape.dev/tool-identity":{"type":"mcp","name":"read"}}`,
		`{"atape.dev/tool-identity":{"type":"skill","name":"commit","server":"extra"}}`,
		`{"atape.dev/tool-identity":{"type":"skill","name":"commit","extra":true}}`,
		`{"atape.dev/tool-identity":{"type":"skill","name":" commit"}}`,
		`{"atape.dev/tool-identity":{"type":"skill","name":"\ufeffcommit"}}`,
		`{"atape.dev/tool-identity":{"type":"skill","name":"commit\ufeff"}}`,
		`{"atape.dev/tool-identity":{"type":"skill","name":"\u0085commit"}}`,
		`{"atape.dev/tool-identity":{"type":"skill","name":"commit\u0085"}}`,
		`{"atape.dev/tool-identity":{"type":"mcp","server":"mail ","name":"read"}}`,
		`{"atape.dev/tool-identity":{"type":"skill","name":""}}`,
		`{"atape.dev/tool-identity":{"type":"skill","name":"commit","name":"other"}}`,
	}
	for _, field := range []string{"name", "server"} {
		value := map[string]any{"type": "mcp", "name": "read", "server": "mail"}
		value[field] = strings.Repeat("界", 167)
		encoded, _ := json.Marshal(map[string]any{"atape.dev/tool-identity": value})
		invalid = append(invalid, string(encoded))
	}
	for _, meta := range invalid {
		t.Run(meta, func(t *testing.T) {
			batch := validBatch()
			batch.CanonicalProfileVersion = ingestion.ToolIdentityCanonicalProfileVersion
			batch.Events[1].Kind = "tool_call"
			batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Tool","_meta":` + meta + `}`
			if _, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), batch); err == nil {
				t.Fatal("invalid identity was admitted")
			}
		})
	}
	batch := validBatch()
	batch.CanonicalProfileVersion = ingestion.ToolIdentityCanonicalProfileVersion
	batch.Events[1].Kind = "tool_call"
	batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Tool","_meta":{"atape.dev/tool-identity":{"type":"mcp","server":"` + strings.Repeat("界", 166) + `ab","name":"` + strings.Repeat("x", 500) + `"}}}`
	if _, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), batch); err != nil {
		t.Fatal(err)
	}
	batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Tool","_meta":{"atape.dev/tool-identity":{"type":"mcp","server":"a\ufeffb","name":"a\u0085b"}}}`
	if _, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), batch); err != nil {
		t.Fatal("internal whitespace changed the identity contract: ", err)
	}
}

func TestToolIdentityUnicodeEscapesStayExact(t *testing.T) {
	for _, field := range []string{"name", "server"} {
		for _, value := range []string{`"\ud800"`, `"\udc00"`, `"a\ud800b"`, `"\ud800\ud800"`, `"\udc00\ud800"`, `"\ud800\u0041"`} {
			t.Run(field+"/"+value, func(t *testing.T) {
				batch := validBatch()
				batch.CanonicalProfileVersion = ingestion.ToolIdentityCanonicalProfileVersion
				name, server := `"read"`, `"docs"`
				if field == "name" {
					name = value
				} else {
					server = value
				}
				batch.Events[1].Kind = "tool_call"
				batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Tool","_meta":{"atape.dev/tool-identity":{"type":"mcp","server":` + server + `,"name":` + name + `}}}`
				if _, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), batch); err == nil {
					t.Fatal("orphan surrogate identity was admitted")
				}
			})
		}
	}
	for _, value := range []struct{ json, want string }{
		{`"\ud83d\ude00"`, "😀"}, {`"\\ud800"`, `\ud800`}, {`"�"`, "�"},
	} {
		t.Run(value.json, func(t *testing.T) {
			store := testStore()
			batch := validBatch()
			batch.CanonicalProfileVersion = ingestion.ToolIdentityCanonicalProfileVersion
			batch.Events[1].Kind = "tool_call"
			batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Tool","_meta":{"atape.dev/tool-identity":{"type":"mcp","server":` + value.json + `,"name":` + value.json + `}}}`
			created, err := ingestion.NewIngestor(store).ApplyBatch(t.Context(), cliPrincipal(), batch)
			if err != nil {
				t.Fatal(err)
			}
			opened, err := conversation.NewMemory(store).OpenConversation(t.Context(), webPrincipal(), created.SessionID, "root")
			if err != nil || opened.Events[1].Tool.Meta.Identity.Name != value.want || opened.Events[1].Tool.Meta.Identity.Server != value.want {
				t.Fatalf("identity changed: %+v %v", opened, err)
			}
		})
	}
	// Old payload strings retain their pre-v4 decoding contract.
	batch := validBatch()
	batch.Events[1].Kind = "tool_call"
	batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Tool","rawInput":"\ud800"}`
	if _, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), batch); err != nil {
		t.Fatal("historical payload parsing changed: ", err)
	}
}

func TestOrdinaryToolIdentityClosedV5Bounds(t *testing.T) {
	for _, identity := range []string{
		`{"type":"tool","name":"exec_command","server":"extra"}`,
		`{"type":"tool","name":"exec_command","extra":true}`,
		`{"type":"tool","name":" exec_command"}`,
		`{"type":"tool","name":""}`,
		`{"type":"tool","name":"\ud800"}`,
		`{"type":"tool","name":"` + strings.Repeat("界", 167) + `"}`,
	} {
		b := validBatch()
		b.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
		b.Events[1].Kind = "tool_call"
		b.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"one","title":"Display","_meta":{"atape.dev/tool-identity":` + identity + `}}`
		if _, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), b); err == nil {
			t.Fatalf("invalid ordinary tool identity admitted: %s", identity)
		}
	}
	b := validBatch()
	b.CanonicalProfileVersion = ingestion.StableToolCanonicalProfileVersion
	b.Events[1].Kind = "tool_call"
	b.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"one","title":"Display","_meta":{"atape.dev/tool-identity":{"type":"tool","name":"` + strings.Repeat("界", 166) + `ab"}}}`
	if _, err := ingestion.NewIngestor(testStore()).ApplyBatch(t.Context(), cliPrincipal(), b); err != nil {
		t.Fatalf("500-byte ordinary identity rejected: %v", err)
	}
}
