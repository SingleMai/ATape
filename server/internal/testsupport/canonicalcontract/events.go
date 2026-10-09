package canonicalcontract

import (
	"reflect"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

// EqualEvents compares every field, including all provenance and timestamp
// instants. PostgreSQL and JSON may represent an identical instant using
// different Location pointers; UTC also strips process-local monotonic clocks.
func EqualEvents(left, right []canonical.EventRecord) bool {
	normalize := func(events []canonical.EventRecord) []canonical.EventRecord {
		if events == nil {
			return nil
		}
		result := make([]canonical.EventRecord, len(events))
		copy(result, events)
		for i := range result {
			result[i].ObservedAt = result[i].ObservedAt.UTC()
			result[i].ReceivedAt = result[i].ReceivedAt.UTC()
			result[i].OccurredAt = result[i].OccurredAt.UTC()
		}
		return result
	}
	return reflect.DeepEqual(normalize(left), normalize(right))
}
