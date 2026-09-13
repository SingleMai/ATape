package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestOverviewFactsCommandRejectsUnboundedWork(t *testing.T) {
	for _, args := range [][]string{nil, {"other"}, {"status", "extra"}, {"backfill", "--max-parts", "0"}, {"backfill", "--max-parts", "33"}, {"backfill", "--interval", "0"}, {"backfill", "--interval", "6s"}, {"backfill", "extra"}} {
		var output bytes.Buffer
		err := runOverviewFactsCommand(t.Context(), args, &output)
		if err == nil || !strings.HasPrefix(err.Error(), "usage:") || output.Len() != 0 {
			t.Fatalf("args %q: output=%q err=%v", args, output.String(), err)
		}
	}
}

func TestOverviewFactsCommandPostgres(t *testing.T) {
	if os.Getenv("ATAPE_INTEGRATION_TESTS") != "1" {
		t.Skip("set ATAPE_INTEGRATION_TESTS=1")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	container, err := postgrescontainer.Run(ctx, "postgres:17-alpine", postgrescontainer.WithDatabase("overview_command"), postgrescontainer.WithUsername("atape"), postgrescontainer.WithPassword("atape"), postgrescontainer.BasicWaitStrategies())
	if err != nil {
		t.Fatal(err)
	}
	testcontainers.CleanupContainer(t, container)
	url, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ATAPE_DATABASE_URL", url)
	// Restore a pre-existing secret-file setting after this test.
	oldFile, hadFile := os.LookupEnv("ATAPE_DATABASE_URL_FILE")
	if err := os.Unsetenv("ATAPE_DATABASE_URL_FILE"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if hadFile {
			_ = os.Setenv("ATAPE_DATABASE_URL_FILE", oldFile)
		}
	})
	var output bytes.Buffer
	// Missing schema is an error. Administrative backfill must never implicitly
	// deploy a migration merely because the operator asked for coverage.
	if err := runOverviewFactsCommand(ctx, []string{"status"}, &output); err == nil {
		t.Fatal("status silently migrated an empty database")
	}
	pool, err := postgresadapter.NewPool(url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var exists bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass('atape_schema_migrations') IS NOT NULL").Scan(&exists); err != nil || exists {
		t.Fatalf("status created schema: %t %v", exists, err)
	}
	if err := postgresadapter.Prepare(ctx, pool); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"status"}, {"backfill", "--max-parts", "1"}} {
		output.Reset()
		if err := runOverviewFactsCommand(ctx, args, &output); err != nil {
			t.Fatal(err)
		}
		var report struct {
			CompletedParts int
			Coverage       *postgresadapter.OverviewFactCoverage
		}
		if err := json.Unmarshal(output.Bytes(), &report); err != nil || report.CompletedParts != 0 || report.Coverage == nil || report.Coverage.MissingParts != 0 {
			t.Fatalf("command report %s: %v", output.String(), err)
		}
	}
}
