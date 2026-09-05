package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/SingleMai/ATape/server/internal/releaseinfo"
)

func runVersionCommand(args []string, output io.Writer) error {
	info := releaseinfo.Current()
	switch {
	case len(args) == 0:
		_, err := fmt.Fprintf(output, "ATape Server %s (%s; minimum CLI %s)\n", info.Version, info.AuthEpoch, info.MinimumCLIVersion)
		return err
	case len(args) == 1 && args[0] == "--json":
		return json.NewEncoder(output).Encode(info)
	default:
		return errors.New("usage: atape-server version [--json]")
	}
}
