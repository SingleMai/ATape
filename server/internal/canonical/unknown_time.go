package canonical

import "encoding/json"

// Fixed publication bodies preserve unknown time as null for SQL fallback and
// backfill readers. Known records keep their original JSON field order/digests.
func (s SessionRecord) MarshalJSON() ([]byte, error) {
	type plain SessionRecord
	if !s.UpdatedAt.IsZero() {
		return json.Marshal(plain(s))
	}
	return json.Marshal(struct {
		plain
		UpdatedAt any
	}{plain(s), nil})
}

func (e EventRecord) MarshalJSON() ([]byte, error) {
	type plain EventRecord
	if !e.OccurredAt.IsZero() {
		return json.Marshal(plain(e))
	}
	return json.Marshal(struct {
		plain
		OccurredAt any
	}{plain(e), nil})
}
