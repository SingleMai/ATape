package sessionanalytics

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

type Activity struct {
	ScopeThreadID            *string          `json:"scopeThreadId"`
	EventCount               int              `json:"eventCount"`
	RecordedTimeEvents       int              `json:"recordedTimeEvents"`
	UnknownTimeEvents        int              `json:"unknownTimeEvents"`
	LegacyTimeEvents         int              `json:"legacyTimeEvents"`
	FirstRecordedAt          *string          `json:"firstRecordedAt"`
	LastRecordedAt           *string          `json:"lastRecordedAt"`
	RecordSpanMilliseconds   *float64         `json:"recordSpanMilliseconds"`
	BackwardClockTransitions int              `json:"backwardClockTransitions"`
	Buckets                  []ActivityBucket `json:"buckets"`
	UnplacedRange            *string          `json:"unplacedRange"`
}

type ActivityBucket struct {
	From        string `json:"from"`
	To          string `json:"to"`
	IncludesEnd bool   `json:"includesEnd"`
	Records     int    `json:"records"`
	Messages    int    `json:"messages"`
	Thoughts    int    `json:"thoughts"`
	ToolCalls   int    `json:"toolCalls"`
	Range       string `json:"range"`
}

// All state is private to one Open operation. Range strings select these actual
// intervals; no caller-provided time boundary becomes an analytics rule.
type activitySelection struct {
	report     *Activity
	boundaries []time.Time
	selected   int
	unplaced   bool
}

func clockQuality(event canonical.EventRecord) string {
	if event.OccurredAt.IsZero() {
		return "unknown"
	}
	if event.SchemaVersion == "atape.acp-centered.v3" || event.SchemaVersion == "atape.acp-centered.v4" {
		return "recorded"
	}
	return "legacy"
}

func deriveActivity(ctx context.Context, snapshot canonical.AnalyticsSnapshot, events []canonical.EventRecord, calls map[callKey]*toolCall, q Query) (*activitySelection, error) {
	a := &Activity{Buckets: []ActivityBucket{}}
	if q.Thread != "" {
		thread := q.Thread
		a.ScopeThreadID = &thread
	}
	selection := &activitySelection{report: a, selected: -1}
	var first, last time.Time
	previous := make(map[string]time.Time)
	for index, event := range events {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		if q.Thread != "" && event.ThreadID != q.Thread {
			continue
		}
		a.EventCount++
		switch clockQuality(event) {
		case "unknown":
			a.UnknownTimeEvents++
		case "legacy":
			a.LegacyTimeEvents++
		case "recorded":
			if a.RecordedTimeEvents == 0 || event.OccurredAt.Before(first) {
				first = event.OccurredAt
			}
			if a.RecordedTimeEvents == 0 || event.OccurredAt.After(last) {
				last = event.OccurredAt
			}
			if old, found := previous[event.ThreadID]; found && old.After(event.OccurredAt) {
				a.BackwardClockTransitions++
			}
			previous[event.ThreadID] = event.OccurredAt
			a.RecordedTimeEvents++
		}
	}
	if a.UnknownTimeEvents+a.LegacyTimeEvents > 0 {
		token := activityRange(snapshot, q, "unplaced", 0)
		a.UnplacedRange = &token
	}
	if a.RecordedTimeEvents > 0 {
		from, to := first.UTC().Format(time.RFC3339Nano), last.UTC().Format(time.RFC3339Nano)
		a.FirstRecordedAt, a.LastRecordedAt = &from, &to
		firstNanos, lastNanos := epochNanos(first), epochNanos(last)
		span := new(big.Int).Sub(lastNanos, firstNanos)
		milliseconds, _ := new(big.Rat).SetFrac(span, big.NewInt(1_000_000)).Float64()
		a.RecordSpanMilliseconds = &milliseconds
		count := 1
		if span.Sign() > 0 {
			count = 60
			if span.Cmp(big.NewInt(60)) < 0 {
				count = int(span.Int64())
			}
		}
		for index := 0; index <= count; index++ {
			offset := new(big.Int).Quo(new(big.Int).Mul(span, big.NewInt(int64(index))), big.NewInt(int64(count)))
			selection.boundaries = append(selection.boundaries, nanosTime(new(big.Int).Add(firstNanos, offset)))
		}
		for index := 0; index < count; index++ {
			a.Buckets = append(a.Buckets, ActivityBucket{From: selection.boundaries[index].UTC().Format(time.RFC3339Nano),
				To: selection.boundaries[index+1].UTC().Format(time.RFC3339Nano), IncludesEnd: index == count-1,
				Range: activityRange(snapshot, q, "bucket", index)})
		}
		for index, event := range events {
			if index%256 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			if q.Thread != "" && event.ThreadID != q.Thread || clockQuality(event) != "recorded" {
				continue
			}
			bucket := &a.Buckets[selection.bucket(event.OccurredAt)]
			bucket.Records++
			if event.Kind == "message" {
				bucket.Messages++
			}
			if event.Kind == "thought" {
				bucket.Thoughts++
			}
		}
		callIndex := 0
		for _, call := range calls {
			if callIndex%256 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			callIndex++
			if q.Thread != "" && call.event.ThreadID != q.Thread || clockQuality(call.event) != "recorded" {
				continue
			}
			a.Buckets[selection.bucket(call.event.OccurredAt)].ToolCalls++
		}
	}
	if q.Range != "" {
		if a.UnplacedRange != nil && q.Range == *a.UnplacedRange {
			selection.unplaced = true
			return selection, nil
		}
		for index, bucket := range a.Buckets {
			if q.Range == bucket.Range {
				selection.selected = index
				return selection, nil
			}
		}
		return nil, &InvalidQueryError{"range", "must select a range from this session, snapshot, version and thread"}
	}
	return selection, nil
}

func (s *activitySelection) bucket(at time.Time) int {
	// At most sixty comparisons; full time.Time ordering avoids duration overflow
	// and agrees exactly with the serialized rounded nanosecond boundaries.
	for index := range s.report.Buckets {
		if at.Before(s.boundaries[index+1]) {
			return index
		}
	}
	return len(s.report.Buckets) - 1
}

func (s *activitySelection) matches(event canonical.EventRecord) bool {
	if s.unplaced {
		return clockQuality(event) != "recorded"
	}
	if s.selected >= 0 {
		return clockQuality(event) == "recorded" && s.bucket(event.OccurredAt) == s.selected
	}
	return true
}

func activityRange(snapshot canonical.AnalyticsSnapshot, q Query, mode string, index int) string {
	encoded, _ := json.Marshal([]any{ActivityVersion, snapshot.Session.ID, snapshot.SnapshotToken, q.Thread, mode, index})
	sum := sha256.Sum256(encoded)
	token, _ := json.Marshal(struct {
		Binding string `json:"b"`
		Mode    string `json:"m"`
		Index   int    `json:"i"`
	}{hex.EncodeToString(sum[:]), mode, index})
	return base64.RawURLEncoding.EncodeToString(token)
}

func epochNanos(at time.Time) *big.Int {
	return new(big.Int).Add(new(big.Int).Mul(big.NewInt(at.Unix()), big.NewInt(1_000_000_000)), big.NewInt(int64(at.Nanosecond())))
}

func nanosTime(value *big.Int) time.Time {
	seconds, nanos := new(big.Int), new(big.Int)
	seconds.QuoRem(value, big.NewInt(1_000_000_000), nanos)
	return time.Unix(seconds.Int64(), nanos.Int64()).UTC()
}
