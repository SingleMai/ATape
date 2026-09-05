package team

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func databaseUUID(value string) (pgtype.UUID, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return pgtype.UUID{}, domainError(CodeInvalidRequest)
	}
	return pgtype.UUID{Bytes: [16]byte(parsed), Valid: true}, nil
}

func domainUUID(value pgtype.UUID) string {
	if !value.Valid {
		return ""
	}
	return uuid.UUID(value.Bytes).String()
}

func newID() (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", errors.New("secure identity generation failed")
	}
	return id.String(), nil
}

func durationSeconds(value time.Duration) (int32, error) {
	seconds := int64(value / time.Second)
	if value%time.Second != 0 {
		seconds++
	}
	if seconds < 1 || seconds > math.MaxInt32 {
		return 0, errors.New("team duration is outside PostgreSQL interval bounds")
	}
	return int32(seconds), nil
}

type uncertainCommitError struct{ err error }

func (e *uncertainCommitError) Error() string { return "database commit outcome is unknown" }
func (e *uncertainCommitError) Unwrap() error { return e.err }

type commitError struct{ err error }

func (e *commitError) Error() string { return e.err.Error() }
func (e *commitError) Unwrap() error { return e.err }

func commitWithError(err error) error { return &commitError{err: err} }

func retryableTransactionError(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) &&
		(postgresError.Code == "40001" || postgresError.Code == "40P01")
}

func withTransaction[T any](
	ctx context.Context,
	pool *pgxpool.Pool,
	operation func(pgx.Tx) (T, error),
) (T, error) {
	var zero T
	for attempt := 0; attempt < 3; attempt++ {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return zero, err
		}
		value, operationErr := operation(tx)
		if operationErr != nil {
			var committed *commitError
			if errors.As(operationErr, &committed) {
				if err := tx.Commit(ctx); err != nil {
					return zero, &uncertainCommitError{err: err}
				}
				return zero, committed.err
			}
			_ = tx.Rollback(context.Background())
			if retryableTransactionError(operationErr) && attempt < 2 {
				if err := waitForRetry(ctx, attempt); err != nil {
					return zero, err
				}
				continue
			}
			return zero, operationErr
		}
		if err := tx.Commit(ctx); err != nil {
			if retryableTransactionError(err) && attempt < 2 {
				if err := waitForRetry(ctx, attempt); err != nil {
					return zero, err
				}
				continue
			}
			return zero, &uncertainCommitError{err: err}
		}
		return value, nil
	}
	return zero, errors.New("team transaction retry limit reached")
}

func waitForRetry(ctx context.Context, attempt int) error {
	timer := time.NewTimer(time.Duration(5*(attempt+1)) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
