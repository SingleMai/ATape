package sessionanalytics

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"sort"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

// TokenCounter is the subtotal of reported classifications, not a replacement
// for the complete-or-null Tokens contract. A reported zero remains a zero.
type TokenCounter struct {
	KnownSubtotal   *int64 `json:"knownSubtotal"`
	ReportedSamples int    `json:"reportedSamples"`
	MissingSamples  int    `json:"missingSamples"`
	Overflowed      bool   `json:"overflowed"`
}

type TokenAccounting struct {
	Total      TokenCounter `json:"total"`
	Input      TokenCounter `json:"input"`
	Output     TokenCounter `json:"output"`
	CacheRead  TokenCounter `json:"cacheRead"`
	CacheWrite TokenCounter `json:"cacheWrite"`
}

// Cache shares use one shared cohort: all three classifications must be
// reported on the same sample. Inclusive input is the denominator.
type TokenCache struct {
	EligibleSamples int      `json:"eligibleSamples"`
	MissingSamples  int      `json:"missingSamples"`
	InputTokens     *int64   `json:"inputTokens"`
	ReadTokens      *int64   `json:"readTokens"`
	WriteTokens     *int64   `json:"writeTokens"`
	UncachedTokens  *int64   `json:"uncachedTokens"`
	ReadShare       *float64 `json:"readShare"`
	WriteShare      *float64 `json:"writeShare"`
	UncachedShare   *float64 `json:"uncachedShare"`
}

type TokenModel struct {
	Key     string          `json:"key"`
	Model   *string         `json:"model"`
	Samples int             `json:"samples"`
	Tokens  TokenAccounting `json:"tokens"`
	Cache   TokenCache      `json:"cache"`
}

type TokenThread struct {
	ID      string          `json:"id"`
	Samples int             `json:"samples"`
	Tokens  TokenAccounting `json:"tokens"`
	Cache   TokenCache      `json:"cache"`
}

type TokenActivityBucket struct {
	From        string          `json:"from"`
	To          string          `json:"to"`
	IncludesEnd bool            `json:"includesEnd"`
	Samples     int             `json:"samples"`
	Tokens      TokenAccounting `json:"tokens"`
	Records     int             `json:"records"`
	Range       string          `json:"range"`
}

type TokenActivity struct {
	ScopeThreadID   *string               `json:"scopeThreadId"`
	ScopeModelKey   *string               `json:"scopeModelKey"`
	Samples         int                   `json:"samples"`
	TimedSamples    int                   `json:"timedSamples"`
	UntimedSamples  int                   `json:"untimedSamples"`
	FirstRecordedAt *string               `json:"firstRecordedAt"`
	LastRecordedAt  *string               `json:"lastRecordedAt"`
	Tokens          TokenAccounting       `json:"tokens"`
	UntimedTokens   TokenAccounting       `json:"untimedTokens"`
	Cache           TokenCache            `json:"cache"`
	Models          []TokenModel          `json:"models"`
	Threads         []TokenThread         `json:"threads"`
	Buckets         []TokenActivityBucket `json:"buckets"`
}

type tokenCounterSum struct {
	value             int64
	reported, missing int
	overflowed        bool
}

func validToken(value *int64) bool {
	return value != nil && *value >= 0 && *value <= maxSafeInteger
}

func (s *tokenCounterSum) add(value *int64) {
	if !validToken(value) {
		s.missing++
		return
	}
	s.reported++
	if s.overflowed || s.value > maxSafeInteger-*value {
		s.overflowed = true
		return
	}
	s.value += *value
}

func (s *tokenCounterSum) get() TokenCounter {
	result := TokenCounter{ReportedSamples: s.reported, MissingSamples: s.missing, Overflowed: s.overflowed}
	if s.reported > 0 && !s.overflowed {
		value := s.value
		result.KnownSubtotal = &value
	}
	return result
}

type tokenAccountingSum struct{ columns [5]tokenCounterSum }

func (s *tokenAccountingSum) add(usage canonical.UsageRecord) {
	switch {
	case !validToken(usage.InputTokens) || !validToken(usage.OutputTokens):
		s.columns[0].add(nil)
	case *usage.InputTokens > maxSafeInteger-*usage.OutputTokens:
		// Both classifications are reported. The sum cannot be serialized
		// safely, which is arithmetic overflow rather than missing usage.
		s.columns[0].reported++
		s.columns[0].overflowed = true
	default:
		total := *usage.InputTokens + *usage.OutputTokens
		s.columns[0].add(&total)
	}
	for index, value := range []*int64{usage.InputTokens, usage.OutputTokens, usage.CacheReadTokens, usage.CacheWriteTokens} {
		s.columns[index+1].add(value)
	}
}

func (s *tokenAccountingSum) get() TokenAccounting {
	return TokenAccounting{Total: s.columns[0].get(), Input: s.columns[1].get(), Output: s.columns[2].get(),
		CacheRead: s.columns[3].get(), CacheWrite: s.columns[4].get()}
}

type tokenCacheSum struct {
	eligible, missing int
	columns           [4]tokenCounterSum
}

func (s *tokenCacheSum) add(usage canonical.UsageRecord) {
	if !validToken(usage.InputTokens) || !validToken(usage.CacheReadTokens) || !validToken(usage.CacheWriteTokens) ||
		*usage.CacheReadTokens > *usage.InputTokens || *usage.CacheWriteTokens > *usage.InputTokens-*usage.CacheReadTokens {
		s.missing++
		return
	}
	s.eligible++
	uncached := *usage.InputTokens - *usage.CacheReadTokens - *usage.CacheWriteTokens
	for index, value := range []*int64{usage.InputTokens, usage.CacheReadTokens, usage.CacheWriteTokens, &uncached} {
		s.columns[index].add(value)
	}
}

func (s *tokenCacheSum) get() TokenCache {
	result := TokenCache{EligibleSamples: s.eligible, MissingSamples: s.missing, InputTokens: s.columns[0].get().KnownSubtotal,
		ReadTokens: s.columns[1].get().KnownSubtotal, WriteTokens: s.columns[2].get().KnownSubtotal, UncachedTokens: s.columns[3].get().KnownSubtotal}
	if result.InputTokens != nil && *result.InputTokens > 0 && result.ReadTokens != nil && result.WriteTokens != nil && result.UncachedTokens != nil {
		read, write, uncached := float64(*result.ReadTokens)/float64(*result.InputTokens), float64(*result.WriteTokens)/float64(*result.InputTokens), float64(*result.UncachedTokens)/float64(*result.InputTokens)
		result.ReadShare, result.WriteShare, result.UncachedShare = &read, &write, &uncached
	}
	return result
}

type tokenGroup struct {
	samples int
	tokens  tokenAccountingSum
	cache   tokenCacheSum
}

func (g *tokenGroup) add(usage canonical.UsageRecord) {
	g.samples++
	g.tokens.add(usage)
	g.cache.add(usage)
}

type tokenActivitySelection struct {
	report     *TokenActivity
	boundaries []time.Time
	selected   int
}

func modelKey(model string) string {
	encoded, _ := json.Marshal([]string{"usage-model.v1", model})
	sum := sha256.Sum256(encoded)
	return "model:" + hex.EncodeToString(sum[:])
}

func deriveTokenActivity(ctx context.Context, snapshot canonical.AnalyticsSnapshot, events []canonical.EventRecord, q Query) (*tokenActivitySelection, error) {
	report := &TokenActivity{Models: []TokenModel{}, Threads: []TokenThread{}, Buckets: []TokenActivityBucket{}}
	if q.Thread != "" {
		thread := q.Thread
		report.ScopeThreadID = &thread
	}
	if q.Model != "" {
		model := q.Model
		report.ScopeModelKey = &model
	}
	selection := &tokenActivitySelection{report: report, selected: -1}
	var total tokenGroup
	var untimed tokenAccountingSum
	models, threads := make(map[string]*tokenGroup), make(map[string]*tokenGroup)
	modelFound := q.Model == ""
	var first, last time.Time
	for index, usage := range snapshot.Usage {
		if index%256 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		key := modelKey(usage.Model)
		matchesThread, matchesModel := q.Thread == "" || usage.ThreadID == q.Thread, q.Model == "" || q.Model == key
		if q.Model == key {
			modelFound = true
		}
		if matchesThread {
			if models[usage.Model] == nil {
				models[usage.Model] = &tokenGroup{}
			}
			models[usage.Model].add(usage)
		}
		if matchesModel {
			if threads[usage.ThreadID] == nil {
				threads[usage.ThreadID] = &tokenGroup{}
			}
			threads[usage.ThreadID].add(usage)
		}
		if !matchesThread || !matchesModel {
			continue
		}
		total.add(usage)
		if usage.OccurredAt.IsZero() {
			report.UntimedSamples++
			untimed.add(usage)
			continue
		}
		if report.TimedSamples == 0 || usage.OccurredAt.Before(first) {
			first = usage.OccurredAt
		}
		if report.TimedSamples == 0 || usage.OccurredAt.After(last) {
			last = usage.OccurredAt
		}
		report.TimedSamples++
	}
	if !modelFound {
		return nil, &InvalidQueryError{"model", "is outside this snapshot"}
	}
	report.Samples, report.Tokens, report.UntimedTokens, report.Cache = total.samples, total.tokens.get(), untimed.get(), total.cache.get()
	for model, group := range models {
		var label *string
		if model != "" {
			value := model
			label = &value
		}
		report.Models = append(report.Models, TokenModel{Key: modelKey(model), Model: label, Samples: group.samples, Tokens: group.tokens.get(), Cache: group.cache.get()})
	}
	sort.Slice(report.Models, func(i, j int) bool {
		a, b := report.Models[i], report.Models[j]
		if a.Model == nil || b.Model == nil {
			return a.Model == nil && b.Model != nil
		}
		return *a.Model < *b.Model
	})
	for thread, group := range threads {
		report.Threads = append(report.Threads, TokenThread{ID: thread, Samples: group.samples, Tokens: group.tokens.get(), Cache: group.cache.get()})
	}
	sort.Slice(report.Threads, func(i, j int) bool { return report.Threads[i].ID < report.Threads[j].ID })
	if report.TimedSamples > 0 {
		from, to := first.UTC().Format(time.RFC3339Nano), last.UTC().Format(time.RFC3339Nano)
		report.FirstRecordedAt, report.LastRecordedAt = &from, &to
		firstNanos := epochNanos(first)
		span := new(big.Int).Sub(epochNanos(last), firstNanos)
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
			report.Buckets = append(report.Buckets, TokenActivityBucket{From: selection.boundaries[index].Format(time.RFC3339Nano),
				To: selection.boundaries[index+1].Format(time.RFC3339Nano), IncludesEnd: index == count-1,
				Range: tokenRange(snapshot, q, index)})
		}
		bucketTokens := make([]tokenAccountingSum, count)
		for index, usage := range snapshot.Usage {
			if index%256 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			if q.Thread != "" && usage.ThreadID != q.Thread || q.Model != "" && modelKey(usage.Model) != q.Model || usage.OccurredAt.IsZero() {
				continue
			}
			bucket := selection.bucket(usage.OccurredAt)
			report.Buckets[bucket].Samples++
			bucketTokens[bucket].add(usage)
		}
		for index := range report.Buckets {
			report.Buckets[index].Tokens = bucketTokens[index].get()
		}
		for index, event := range events {
			if index%256 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			if q.Thread != "" && event.ThreadID != q.Thread || clockQuality(event) != "recorded" || event.OccurredAt.Before(first) || event.OccurredAt.After(last) {
				continue
			}
			report.Buckets[selection.bucket(event.OccurredAt)].Records++
		}
	}
	if q.TokenRange != "" {
		for index, bucket := range report.Buckets {
			if q.TokenRange == bucket.Range {
				selection.selected = index
				return selection, nil
			}
		}
		return nil, &InvalidQueryError{"tokenRange", "must select a token interval from this session, snapshot, version, model and thread"}
	}
	return selection, nil
}

func tokenRange(snapshot canonical.AnalyticsSnapshot, q Query, index int) string {
	encoded, _ := json.Marshal([]any{"token-range.v1", q.AnalyticsVersion, snapshot.Session.ID, snapshot.SnapshotToken, q.Thread, q.Model, index})
	sum := sha256.Sum256(encoded)
	return "tokens:" + hex.EncodeToString(sum[:])
}

func (s *tokenActivitySelection) bucket(at time.Time) int {
	for index := range s.report.Buckets {
		if at.Before(s.boundaries[index+1]) {
			return index
		}
	}
	return len(s.report.Buckets) - 1
}

func (s *tokenActivitySelection) matches(event canonical.EventRecord) bool {
	if s.selected < 0 || clockQuality(event) != "recorded" {
		return false
	}
	from, to := s.boundaries[s.selected], s.boundaries[s.selected+1]
	return !event.OccurredAt.Before(from) && (event.OccurredAt.Before(to) || s.report.Buckets[s.selected].IncludesEnd && event.OccurredAt.Equal(to))
}
