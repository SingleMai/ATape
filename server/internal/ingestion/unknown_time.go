package ingestion

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"
)

// The wire requires a present string or explicit null. Keep known Go callers
// source-compatible; Unknown is an explicit Module input, never inferred from
// a missing field or empty string. Unknown JSON fields remain rejected.
func (s *Session) UnmarshalJSON(data []byte) error {
	type plain Session
	var value plain
	// A RawMessage value, rather than pointer, distinguishes null from absence.
	var fields struct {
		*plain
		UpdatedAt json.RawMessage `json:"updatedAt"`
	}
	fields.plain = &value
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fields); err != nil {
		return err
	}
	known, unknown, err := decodeSourceTime(fields.UpdatedAt)
	if err != nil {
		return fmt.Errorf("updatedAt: %w", err)
	}
	value.UpdatedAt, value.UpdatedAtUnknown = known, unknown
	*s = Session(value)
	return nil
}

func (s Session) MarshalJSON() ([]byte, error) {
	type plain Session
	if !s.UpdatedAtUnknown {
		return json.Marshal(plain(s))
	}
	return json.Marshal(struct {
		plain
		UpdatedAt any `json:"updatedAt"`
	}{plain(s), nil})
}

func (e *Event) UnmarshalJSON(data []byte) error {
	type plain Event
	var value plain
	input := struct {
		*plain
		OccurredAt json.RawMessage `json:"occurredAt"`
	}{plain: &value}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return err
	}
	known, unknown, err := decodeSourceTime(input.OccurredAt)
	if err != nil {
		return fmt.Errorf("occurredAt: %w", err)
	}
	value.OccurredAt, value.OccurredAtUnknown = known, unknown
	*e = Event(value)
	return nil
}

func (e Event) MarshalJSON() ([]byte, error) {
	type plain Event
	if !e.OccurredAtUnknown {
		return json.Marshal(plain(e))
	}
	return json.Marshal(struct {
		plain
		OccurredAt any `json:"occurredAt"`
	}{plain(e), nil})
}

func decodeSourceTime(data json.RawMessage) (string, bool, error) {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return "", true, nil
	}
	if len(data) == 0 {
		return "", false, nil // Required-field validation reports the missing time.
	}
	var known string
	if err := json.Unmarshal(data, &known); err != nil {
		return "", false, err
	}
	return known, false, nil
}

func sourceTimestamp(field, value string, unknown bool, profile string) (time.Time, error) {
	if unknown {
		if profile != UnknownTimeCanonicalProfileVersion || value != "" {
			return time.Time{}, invalid(field, "null requires the v3 profile")
		}
		return time.Time{}, nil
	}
	return timestamp(field, value)
}
