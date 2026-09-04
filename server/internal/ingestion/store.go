package ingestion

import (
	"context"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

// BatchStore is the persistence Seam consumed by the ingestion Module.
// Implementations must apply a normalized batch atomically and preserve the
// idempotency and revision semantics represented by canonical.ApplyResult.
type BatchStore interface {
	ApplyBatch(context.Context, canonical.WriteBatch) (canonical.ApplyResult, error)
}
