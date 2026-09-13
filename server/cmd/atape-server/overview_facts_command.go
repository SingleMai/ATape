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

// An explicit bounded operator command owns backfill pacing and cancellation.
// It never migrates the database or runs automatically during server startup.
func runOverviewFactsCommand(ctx context.Context, args []string, output io.Writer) error {
	const usage = "usage: atape-server overview-facts status | backfill [--max-parts 32] [--interval 100ms]"
	if len(args) == 0 || (args[0] != "status" && args[0] != "backfill") {
		return errors.New(usage)
	}
	maxParts, interval := 0, 100*time.Millisecond
	if args[0] == "status" {
		if len(args) != 1 {
			return errors.New(usage)
		}
	} else {
		flags := flag.NewFlagSet("overview-facts backfill", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		flags.IntVar(&maxParts, "max-parts", 32, "maximum parts in this run (1-32)")
		flags.DurationVar(&interval, "interval", interval, "pause between parts (100ms-5s)")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || maxParts < 1 || maxParts > 32 || interval < 100*time.Millisecond || interval > 5*time.Second {
			return errors.New(usage)
		}
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
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	store := postgresadapter.NewStore(pool)
	completed := 0
	var runErr error
	for completed < maxParts {
		var worked bool
		worked, runErr = store.BackfillOverviewFacts(ctx)
		if runErr != nil || !worked {
			break
		}
		completed++
		if completed < maxParts {
			timer := time.NewTimer(interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				runErr = ctx.Err()
			case <-timer.C:
			}
			if runErr != nil {
				break
			}
		}
	}
	// Report only acknowledged commits. On an uncertain commit response the
	// marker remains authoritative and a repeated command is safe.
	report := struct {
		CompletedParts int                                   `json:"completedParts"`
		Coverage       *postgresadapter.OverviewFactCoverage `json:"coverage,omitempty"`
	}{CompletedParts: completed}
	if runErr == nil {
		var coverage postgresadapter.OverviewFactCoverage
		coverage, runErr = store.OverviewFactsCoverage(ctx)
		if runErr == nil {
			report.Coverage = &coverage
		}
	}
	if err = json.NewEncoder(output).Encode(report); err != nil {
		return err
	}
	return runErr
}
