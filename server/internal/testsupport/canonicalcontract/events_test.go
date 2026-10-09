package canonicalcontract

import (
	"reflect"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

func TestEqualEventsPreservesEveryFieldAndTimestampInstant(t *testing.T) {
	at := time.Now()
	child := "child"
	event := canonical.EventRecord{ID: "event", SessionID: "session", ThreadID: "root", SourceKey: "source",
		Revision: 7, ProjectionRevision: 8, Digest: "digest", SourceOrder: 9, EventIndex: 10,
		OrderFidelity: "native", Fidelity: "native", RawRef: "raw#fragment", AdapterVersion: "version",
		SchemaVersion: "schema", ObservedAt: at, ReceivedAt: at, IngestSeq: 11, Kind: "message",
		Author: "assistant", OccurredAt: at, Text: "text", ToolLabel: "tool", ToolUpdateJSON: "{}", ChildThreadID: &child}
	same := event
	same.ObservedAt = at.In(time.FixedZone("UTC alias", 0))
	same.ReceivedAt = at.UTC()
	same.OccurredAt = at.In(time.FixedZone("offset", 8*60*60))
	left, right := []canonical.EventRecord{event}, []canonical.EventRecord{same}
	beforeLeft, beforeRight := append([]canonical.EventRecord(nil), left...), append([]canonical.EventRecord(nil), right...)
	if !EqualEvents(left, right) {
		t.Fatal("equivalent timestamps with different locations/monotonic representations differ")
	}
	for _, field := range []string{"ObservedAt", "ReceivedAt", "OccurredAt"} {
		t.Run(field, func(t *testing.T) {
			changed := same
			switch field {
			case "ObservedAt":
				changed.ObservedAt = changed.ObservedAt.Add(time.Nanosecond)
			case "ReceivedAt":
				changed.ReceivedAt = changed.ReceivedAt.Add(time.Nanosecond)
			case "OccurredAt":
				changed.OccurredAt = changed.OccurredAt.Add(time.Nanosecond)
			}
			if EqualEvents([]canonical.EventRecord{event}, []canonical.EventRecord{changed}) {
				t.Fatal("different timestamp instant was ignored")
			}
		})
	}
	// Exercise every non-time field so new provenance cannot be silently omitted.
	value := reflect.ValueOf(event)
	for i := range value.NumField() {
		name := value.Type().Field(i).Name
		if name == "ObservedAt" || name == "ReceivedAt" || name == "OccurredAt" {
			continue
		}
		t.Run(name, func(t *testing.T) {
			changed := same
			field := reflect.ValueOf(&changed).Elem().Field(i)
			field.Set(reflect.Zero(field.Type()))
			if EqualEvents([]canonical.EventRecord{event}, []canonical.EventRecord{changed}) {
				t.Fatalf("changed %s was ignored", name)
			}
		})
	}
	if EqualEvents(nil, []canonical.EventRecord{}) || EqualEvents([]canonical.EventRecord{event}, nil) {
		t.Fatal("membership distinction was ignored")
	}
	if !reflect.DeepEqual(left, beforeLeft) || !reflect.DeepEqual(right, beforeRight) {
		t.Fatal("comparison mutated its input")
	}
}
