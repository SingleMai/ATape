package authentication

import (
	"context"
	"errors"

	authdb "github.com/SingleMai/ATape/server/internal/authentication/internal/db"
	"github.com/jackc/pgx/v5"
)

// Maintain performs one bounded, idempotent convergence pass. Every replica
// may call it; a PostgreSQL advisory lock elects at most one worker per pass.
// Authentication correctness never depends on this cleanup running on time.
func (m *Module) Maintain(ctx context.Context) (MaintenanceResult, error) {
	if err := ctx.Err(); err != nil {
		return MaintenanceResult{}, err
	}
	result, err := withTransaction(ctx, m.pool, func(tx pgx.Tx) (MaintenanceResult, error) {
		queries := authdb.New(tx)
		acquired, err := queries.TryMaintenanceLock(ctx, maintenanceLockID)
		if err != nil {
			return MaintenanceResult{}, err
		}
		if !acquired {
			return MaintenanceResult{}, nil
		}
		result := MaintenanceResult{Acquired: true}
		batchSize := int32(m.policy.MaintenanceBatchSize)
		retentionSeconds := mustDurationSeconds(m.policy.TerminalRetention)
		windowRetentionSeconds := mustDurationSeconds(m.policy.CodeWindowRetention)
		if result.ExpiredFederatedLogins, err = queries.ExpireFederatedLoginBatch(ctx, batchSize); err != nil {
			return MaintenanceResult{}, err
		}
		if result.ExpiredCLIAuthorizations, err = queries.ExpireCLIAuthorizationBatch(ctx, batchSize); err != nil {
			return MaintenanceResult{}, err
		}
		if result.DeletedCodeAttemptWindows, err = queries.DeleteCodeAttemptWindowBatch(
			ctx, authdb.DeleteCodeAttemptWindowBatchParams{
				RetentionSeconds: windowRetentionSeconds, BatchSize: batchSize,
			},
		); err != nil {
			return MaintenanceResult{}, err
		}
		if result.DeletedFederatedLogins, err = queries.DeleteFederatedLoginBatch(
			ctx, authdb.DeleteFederatedLoginBatchParams{
				RetentionSeconds: retentionSeconds, BatchSize: batchSize,
			},
		); err != nil {
			return MaintenanceResult{}, err
		}
		if result.DeletedCLIAuthorizations, err = queries.DeleteCLIAuthorizationBatch(
			ctx, authdb.DeleteCLIAuthorizationBatchParams{
				RetentionSeconds: retentionSeconds, BatchSize: batchSize,
			},
		); err != nil {
			return MaintenanceResult{}, err
		}
		if result.DeletedWebSessionSecrets, err = queries.DeleteWebSessionSecretBatch(
			ctx, authdb.DeleteWebSessionSecretBatchParams{
				RetentionSeconds: retentionSeconds, BatchSize: batchSize,
			},
		); err != nil {
			return MaintenanceResult{}, err
		}
		if result.DeletedCLICredentials, err = queries.DeleteCLICredentialBatch(
			ctx, authdb.DeleteCLICredentialBatchParams{
				RetentionSeconds: retentionSeconds, BatchSize: batchSize,
			},
		); err != nil {
			return MaintenanceResult{}, err
		}
		if result.DeletedWebSessions, err = queries.DeleteWebSessionBatch(
			ctx, authdb.DeleteWebSessionBatchParams{
				RetentionSeconds: retentionSeconds, BatchSize: batchSize,
			},
		); err != nil {
			return MaintenanceResult{}, err
		}
		return result, nil
	})
	if err != nil {
		var domain *Error
		if errors.As(err, &domain) {
			return MaintenanceResult{}, err
		}
		return MaintenanceResult{}, unavailable("maintain Authentication state", err)
	}
	return result, nil
}
