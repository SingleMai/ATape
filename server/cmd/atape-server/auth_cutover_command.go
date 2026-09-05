package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/authcutover"
)

const cutoverDocumentLimit = 1 << 20

type cutoverUsersDocument struct {
	Protocol string             `json:"protocol"`
	Cutover  authcutover.Status `json:"cutover"`
	Items    []authcutover.User `json:"items"`
}

func runAuthCutoverCommand(ctx context.Context, args []string, output io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: atape-server auth-cutover users|plan|apply")
	}
	databaseURL, configured, err := readSecretSetting("ATAPE_DATABASE_URL")
	if err != nil {
		return err
	}
	if !configured {
		return errors.New("ATAPE_DATABASE_URL is required")
	}
	pool, err := postgresadapter.NewPool(databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := postgresadapter.Prepare(ctx, pool); err != nil {
		return err
	}
	module, err := authcutover.New(pool)
	if err != nil {
		return err
	}

	var document any
	switch args[0] {
	case "users":
		if len(args) != 1 {
			return errors.New("usage: atape-server auth-cutover users")
		}
		status, err := module.Status(ctx)
		if err != nil {
			return err
		}
		users, err := module.Users(ctx)
		if err != nil {
			return err
		}
		document = cutoverUsersDocument{
			Protocol: "atape.auth-cutover-users.v1", Cutover: status, Items: users,
		}
	case "plan":
		flags := flag.NewFlagSet("auth-cutover plan", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		mappingPath := flags.String("mapping", "", "path to an atape.auth-cutover.v1 mapping")
		if err := flags.Parse(args[1:]); err != nil || *mappingPath == "" || flags.NArg() != 0 {
			return errors.New("usage: atape-server auth-cutover plan --mapping <mapping.json>")
		}
		mapping, err := readCutoverDocument[authcutover.Mapping](*mappingPath)
		if err != nil {
			return fmt.Errorf("read mapping: %w", err)
		}
		plan, err := module.Plan(ctx, mapping)
		if err != nil {
			return err
		}
		document = plan
	case "apply":
		flags := flag.NewFlagSet("auth-cutover apply", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		mappingPath := flags.String("mapping", "", "path to an atape.auth-cutover.v1 mapping")
		planPath := flags.String("plan", "", "path to the reviewed atape.auth-cutover-plan.v1 artifact")
		if err := flags.Parse(args[1:]); err != nil || *mappingPath == "" || *planPath == "" || flags.NArg() != 0 {
			return errors.New("usage: atape-server auth-cutover apply --mapping <mapping.json> --plan <plan.json>")
		}
		mapping, err := readCutoverDocument[authcutover.Mapping](*mappingPath)
		if err != nil {
			return fmt.Errorf("read mapping: %w", err)
		}
		plan, err := readCutoverDocument[authcutover.Plan](*planPath)
		if err != nil {
			return fmt.Errorf("read plan: %w", err)
		}
		result, err := module.Apply(ctx, mapping, plan)
		if err != nil {
			return err
		}
		document = result
	default:
		return fmt.Errorf("unknown auth-cutover command %q; use users, plan, or apply", args[0])
	}
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(document); err != nil {
		return fmt.Errorf("write cutover result: %w", err)
	}
	return nil
}

func readCutoverDocument[T any](path string) (T, error) {
	var result T
	file, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer file.Close()
	if info, err := file.Stat(); err != nil {
		return result, err
	} else if info.Mode().IsRegular() && info.Size() > cutoverDocumentLimit {
		return result, errors.New("document exceeds 1 MiB")
	}
	decoder := json.NewDecoder(io.LimitReader(file, cutoverDocumentLimit+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return result, errors.New("document must be one strict JSON object")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return result, errors.New("document must contain exactly one JSON object up to 1 MiB")
	}
	return result, nil
}
