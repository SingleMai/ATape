package projectsearch

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

const (
	projectionBatchSize = 100
	projectionLease     = 30 * time.Second
	projectionPoll      = time.Second
)

// ChangeSource and ProjectionIndex are separate production-varying Seams so a
// future remote index need not share the Canonical Store's transaction model.
type ChangeSource interface {
	LeaseProjectionChanges(context.Context, string, int, time.Time) ([]canonical.ProjectionChange, error)
	AckProjectionChanges(context.Context, string, []int64) error
}

type ProjectionIndex interface {
	UpsertProjectionDocuments(context.Context, []canonical.EventProjection) error
}

type Projector struct {
	source ChangeSource
	index  ProjectionIndex
	owner  string
}

func NewProjector(source ChangeSource, index ProjectionIndex) *Projector {
	return &Projector{
		source: source,
		index:  index,
		owner:  fmt.Sprintf("atape-%d", time.Now().UnixNano()),
	}
}

func (p *Projector) ProjectOnce(ctx context.Context) (int, error) {
	changes, err := p.source.LeaseProjectionChanges(
		ctx,
		p.owner,
		projectionBatchSize,
		time.Now().UTC().Add(projectionLease),
	)
	if err != nil {
		return 0, fmt.Errorf("lease Canonical projection changes: %w", err)
	}
	if len(changes) == 0 {
		return 0, nil
	}
	documents := make([]canonical.EventProjection, 0, len(changes))
	ids := make([]int64, 0, len(changes))
	for _, change := range changes {
		documents = append(documents, change.Document)
		ids = append(ids, change.ID)
	}
	if err := p.index.UpsertProjectionDocuments(ctx, documents); err != nil {
		return 0, fmt.Errorf("update Search projection: %w", err)
	}
	if err := p.source.AckProjectionChanges(ctx, p.owner, ids); err != nil {
		return 0, fmt.Errorf("ack Canonical projection changes: %w", err)
	}
	return len(changes), nil
}

func (p *Projector) Run(ctx context.Context) {
	ticker := time.NewTicker(projectionPoll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for {
				count, err := p.ProjectOnce(ctx)
				if err != nil {
					if ctx.Err() == nil {
						slog.Error("Search projector pass failed", "error", err)
					}
					break
				}
				if count < projectionBatchSize {
					break
				}
			}
		}
	}
}
