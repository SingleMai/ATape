package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestMigrateCommandBounds(t *testing.T) {
	for _, args := range [][]string{{"extra"}, {"--timeout", "0"}, {"--timeout", "2h"}, {"--timeout", "invalid"}} {
		var output bytes.Buffer
		if err := runMigrateCommand(t.Context(), args, &output); err == nil || !strings.HasPrefix(err.Error(), "usage:") || output.Len() != 0 {
			t.Fatalf("args %q: output=%q err=%v", args, output.String(), err)
		}
	}
}

func TestMigrateCommandPostgres(t *testing.T) {
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("migrate_command"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
	if err != nil {
		t.Fatal(err)
	}
	testcontainers.CleanupContainer(t, container)
	url, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	secretFile := filepath.Join(t.TempDir(), "database-url")
	if err := os.WriteFile(secretFile, []byte(url), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ATAPE_DATABASE_URL", "")
	t.Setenv("ATAPE_DATABASE_URL_FILE", secretFile)
	pool, err := postgresadapter.NewPool(url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for n := 0; n < 2; n++ {
		var output bytes.Buffer
		if err := runMigrateCommand(ctx, nil, &output); err != nil || output.String() != "{\"migrated\":true}\n" {
			t.Fatalf("migration attempt %d: output=%q err=%v", n, output.String(), err)
		}
	}
	var version int
	if err := pool.QueryRow(ctx, "SELECT max(version) FROM atape_schema_migrations").Scan(&version); err != nil || version != 22 {
		t.Fatalf("migration version %d: %v", version, err)
	}
	// A blocked database operation must respect the operator's deadline and
	// leave no successful report. Releasing the lock permits a safe retry.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "LOCK TABLE atape_schema_migrations IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	started := time.Now()
	if err := runMigrateCommand(ctx, []string{"--timeout", "1s"}, &output); err == nil || output.Len() != 0 || time.Since(started) > 5*time.Second {
		t.Fatalf("deadline not enforced: elapsed=%s output=%q err=%v", time.Since(started), output.String(), err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := runMigrateCommand(ctx, nil, &output); err != nil {
		t.Fatalf("retry after cancellation: %v", err)
	}
}
