package ingestion_test

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
)

func TestToolValuesCrossLanguageVectors(t *testing.T) {
	data, err := os.ReadFile("../../../testdata/tool-values.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		JSON string `json:"json"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		t.Run(vector.JSON, func(t *testing.T) {
			store := testStore()
			batch := validBatch()
			batch.Events[1].Kind = "tool_result"
			batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call_update","toolCallId":"call-1","title":"Read","status":"completed","rawOutput":` + vector.JSON + `}`
			result, err := ingestion.NewIngestor(store).ApplyBatch(context.Background(), cliPrincipal(), batch)
			if err != nil {
				t.Fatal(err)
			}
			opened, err := conversation.NewMemory(store).OpenConversation(context.Background(), webPrincipal(), result.SessionID, "root")
			if err != nil {
				t.Fatal(err)
			}
			tool := opened.Events[1].Tool
			if tool == nil || string(tool.RawOutput) != vector.JSON || tool.RawInput != nil {
				t.Fatalf("lost JSON presence/representation: %+v", tool)
			}
			if opened.Events[1].Text != "Read · completed" {
				t.Fatal("did not derive common tool summary")
			}
			replay, err := ingestion.NewIngestor(store).ApplyBatch(context.Background(), cliPrincipal(), batch)
			if err != nil || !replay.Replayed {
				t.Fatalf("replay: %+v, %v", replay, err)
			}
		})
	}
}

func TestRejectsInvalidToolDetailsBeforeWriting(t *testing.T) {
	for _, value := range []string{
		`{"sessionUpdate":"tool_call","toolCallId":"id","title":"Read","rawInput":NaN}`,
		`{"sessionUpdate":"tool_call","toolCallId":"id","title":"Read","rawInput":1e999}`,
		`{"sessionUpdate":"tool_call","toolCallId":"id","title":"Read","rawInput":{"a":1,"a":2}}`,
		`{"sessionUpdate":"tool_call","toolCallId":"id","title":"Read","extra":true}`,
		`{"sessionUpdate":"tool_call","toolCallId":"id","title":null}`,
		`{"sessionUpdate":"tool_call","toolCallId":"id","title":"Read","status":"invented"}`,
		`{"sessionUpdate":"tool_call","toolCallId":"id","title":"Read","rawInput":"` + strings.Repeat("x", 65536) + `"}`,
		`{"sessionUpdate":"tool_call","toolCallId":"id","title":"Read","rawInput":` + strings.Repeat("[", 33) + "0" + strings.Repeat("]", 33) + `}`,
	} {
		store := testStore()
		batch := validBatch()
		batch.Events[1].Kind, batch.Events[1].ToolUpdateJSON = "tool_call", value
		if _, err := ingestion.NewIngestor(store).ApplyBatch(context.Background(), cliPrincipal(), batch); err == nil {
			t.Fatal("accepted invalid tool details")
		}
		project, err := conversation.NewMemory(store).OpenProject(context.Background(), webPrincipal(), "payments-api")
		if err != nil || len(project.Trail) != 0 {
			t.Fatalf("invalid batch wrote history: %+v %v", project, err)
		}
	}
}

func TestLegacyProfileCannotCarryToolDetails(t *testing.T) {
	store := testStore()
	batch := validBatch()
	batch.CanonicalProfileVersion = ingestion.LegacyCanonicalProfileVersion
	batch.Events[1].ToolUpdateJSON = `{"sessionUpdate":"tool_call","toolCallId":"id","title":"Read"}`
	if _, err := ingestion.NewIngestor(store).ApplyBatch(context.Background(), cliPrincipal(), batch); err == nil {
		t.Fatal("accepted v2 tool data in v1")
	}
	batch.Events[1].ToolUpdateJSON = ""
	if _, err := ingestion.NewIngestor(store).ApplyBatch(context.Background(), cliPrincipal(), batch); err != nil {
		t.Fatal(err)
	}
}
