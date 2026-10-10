package ingestion_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
)

func TestSourceTimeRequiresExplicitNullAndV3(t *testing.T) {
	for _, profile := range []string{ingestion.LegacyCanonicalProfileVersion, ingestion.CanonicalProfileVersion, ingestion.UnknownTimeCanonicalProfileVersion} {
		for _, field := range []string{"updatedAt", "occurredAt"} {
			for _, value := range []string{"known", "null", "missing", "empty", "invalid", "zero", "zero-fraction", "zero-offset", "microsecond", "epoch-nanosecond", "number"} {
				t.Run(profile+"/"+field+"/"+value, func(t *testing.T) {
					batch := validBatch()
					batch.CanonicalProfileVersion = profile
					body, _ := json.Marshal(batch)
					var wire map[string]any
					if err := json.Unmarshal(body, &wire); err != nil {
						t.Fatal(err)
					}
					object := wire["session"].(map[string]any)
					if field == "occurredAt" {
						object = wire["events"].([]any)[0].(map[string]any)
					}
					switch value {
					case "null":
						object[field] = nil
					case "missing":
						delete(object, field)
					case "empty":
						object[field] = ""
					case "invalid":
						object[field] = "yesterday"
					case "zero":
						object[field] = "0001-01-01T00:00:00Z"
					case "zero-fraction":
						object[field] = "0001-01-01T00:00:00.000000999Z"
					case "zero-offset":
						object[field] = "0001-01-01T01:00:00.000000001+01:00"
					case "microsecond":
						object[field] = "0001-01-01T00:00:00.000001Z"
					case "epoch-nanosecond":
						object[field] = "1970-01-01T00:00:00.000000001Z"
					case "number":
						object[field] = 12
					}
					body, _ = json.Marshal(wire)
					var decoded ingestion.Batch
					err := json.Unmarshal(body, &decoded)
					if err == nil {
						_, err = ingestion.PrepareBatch(cliPrincipal(), decoded)
					}
					accepted := value == "known" || value == "microsecond" || value == "epoch-nanosecond" || (value == "null" && profile == ingestion.UnknownTimeCanonicalProfileVersion)
					if (err == nil) != accepted {
						t.Fatalf("accepted=%t, err=%v", accepted, err)
					}
				})
			}
		}
	}
}

func TestV3UnknownTimePreservesOrderAndReadsAsNull(t *testing.T) {
	batch := validBatch()
	batch.CanonicalProfileVersion = ingestion.UnknownTimeCanonicalProfileVersion
	batch.Session.UpdatedAt, batch.Session.UpdatedAtUnknown = "", true
	batch.Events[0].OccurredAt, batch.Events[0].OccurredAtUnknown = "", true
	store := testStore()
	result, err := ingestion.NewIngestor(store).ApplyBatch(context.Background(), cliPrincipal(), batch)
	if err != nil {
		t.Fatal(err)
	}
	reader := conversation.NewMemory(store)
	opened, err := reader.OpenConversation(context.Background(), webPrincipal(), result.SessionID, "root")
	if err != nil {
		t.Fatal(err)
	}
	if opened.Session.UpdatedAt != nil || opened.Session.Status != "idle" || opened.Events[0].OccurredAt != nil || opened.Events[1].OccurredAt == nil || opened.Events[0].Text != batch.Events[0].Text {
		t.Fatalf("unknown times or source order changed: %+v", opened)
	}
	body, _ := json.Marshal(opened)
	if !bytes.Contains(body, []byte(`"updatedAt":null`)) || !bytes.Contains(body, []byte(`"occurredAt":null`)) || bytes.Contains(body, []byte("0001-")) {
		t.Fatal(string(body))
	}
	project, err := reader.OpenProject(context.Background(), webPrincipal(), batch.ProjectID)
	if err != nil || len(project.Active) != 0 || project.Trail[0].UpdatedAt != nil {
		t.Fatalf("project: %+v %v", project, err)
	}
}

func TestKnownWireAndNormalizedJSONKeepLegacyBytes(t *testing.T) {
	batch := validBatch()
	type oldSession ingestion.Session
	type oldEvent ingestion.Event
	type oldSessionRecord canonical.SessionRecord
	type oldEventRecord canonical.EventRecord
	fixed, err := ingestion.PrepareBatch(cliPrincipal(), batch)
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]any{
		{batch.Session, oldSession(batch.Session)}, {batch.Events[0], oldEvent(batch.Events[0])},
		{fixed.Session, oldSessionRecord(fixed.Session)}, {fixed.Events[0], oldEventRecord(fixed.Events[0])},
	} {
		current, err := json.Marshal(pair[0])
		if err != nil {
			t.Fatal(err)
		}
		previous, err := json.Marshal(pair[1])
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(current, previous) {
			t.Fatalf("known JSON bytes changed:\n%s\n%s", current, previous)
		}
	}
}

func TestUnknownTimeDecodingStillRejectsUnknownFields(t *testing.T) {
	for _, body := range []string{`{"updatedAt":null,"unexpected":true}`, `{"occurredAt":null,"unexpected":true}`} {
		var err error
		if bytes.Contains([]byte(body), []byte("updatedAt")) {
			err = json.Unmarshal([]byte(body), new(ingestion.Session))
		} else {
			err = json.Unmarshal([]byte(body), new(ingestion.Event))
		}
		if err == nil {
			t.Fatal("unknown field accepted")
		}
	}
}
