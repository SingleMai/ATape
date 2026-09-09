package ingestion

import (
	"fmt"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"unicode/utf8"
)

func normalizeUsage(batch Batch, sessionID, scope string, threads map[string]string) ([]canonical.UsageRecord, error) {
	if len(batch.Usage) > 500 {
		return nil, invalid("usage", "exceeds 500 records")
	}
	result := make([]canonical.UsageRecord, 0, len(batch.Usage))
	seen := make(map[string]bool)
	for index, input := range batch.Usage {
		field := fmt.Sprintf("usage[%d]", index)
		if err := required(field+".sourceUsageId", input.SourceUsageID, 500); err != nil {
			return nil, err
		}
		thread, ok := threads[input.SourceThreadID]
		if !ok {
			return nil, invalid(field+".sourceThreadId", "does not reference a thread in this batch")
		}
		key := sourceKey(scope, "usage", input.SourceThreadID, input.SourceUsageID)
		if seen[key] {
			return nil, invalid(field, "duplicates a usage identity")
		}
		seen[key] = true
		if input.Revision < 1 || input.Revision > 9007199254740991 {
			return nil, invalid(field+".revision", "must be a positive safe integer")
		}
		if len(input.Model) > 200 || !utf8.ValidString(input.Model) {
			return nil, invalid(field+".model", "must be bounded UTF-8")
		}
		at, err := timestamp(field+".occurredAt", input.OccurredAt)
		if err != nil {
			return nil, err
		}
		provided := false
		for _, count := range []*int64{input.InputTokens, input.OutputTokens, input.CacheReadTokens, input.CacheWriteTokens} {
			if count == nil {
				continue
			}
			provided = true
			if *count < 0 || *count > 9007199254740991 {
				return nil, invalid(field, "counters must be nonnegative safe integers")
			}
		}
		if !provided {
			return nil, invalid(field, "must contain a usage counter")
		}
		cache := int64(0)
		if input.CacheReadTokens != nil {
			cache += *input.CacheReadTokens
		}
		if input.CacheWriteTokens != nil {
			cache += *input.CacheWriteTokens
		}
		if input.InputTokens != nil && cache > *input.InputTokens {
			return nil, invalid(field, "cache subdivisions exceed inclusive input")
		}
		value := canonical.UsageRecord{SourceKey: key, SessionID: sessionID, ThreadID: thread, Revision: input.Revision, OccurredAt: at, Model: input.Model,
			InputTokens: input.InputTokens, OutputTokens: input.OutputTokens, CacheReadTokens: input.CacheReadTokens, CacheWriteTokens: input.CacheWriteTokens}
		value.Digest = digest(value)
		result = append(result, value)
	}
	return result, nil
}
