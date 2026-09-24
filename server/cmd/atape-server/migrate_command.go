package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"time"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
)

// Large derived-index migrations run explicitly before serving traffic, outside
// the ordinary Fx startup deadline. Prepare retains the migration transaction
// and lock, so a cancelled attempt can be retried safely.
func runMigrateCommand(ctx context.Context, args []string, output io.Writer) error {
	const usage = "usage: atape-server migrate [--timeout 15m] (1s-1h)"
	flags := flag.NewFlagSet("migrate", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	timeout := flags.Duration("timeout", 15*time.Minute, "maximum migration duration")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *timeout < time.Second || *timeout > time.Hour {
		return errors.New(usage)
	}
	databaseURL, configured, err := readSecretSetting("ATAPE_DATABASE_URL")
	if err != nil {
		return err
	}
	if !configured || databaseURL == "" {
		return errors.New("ATAPE_DATABASE_URL is required")
	}
	pool, err := postgresadapter.NewPool(databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	if err := postgresadapter.Prepare(ctx, pool); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(struct {
		Migrated bool `json:"migrated"`
	}{Migrated: true})
}
