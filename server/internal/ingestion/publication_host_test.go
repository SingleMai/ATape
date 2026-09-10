package ingestion_test

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/ingestion"
)

func hostPreparationContract(t *testing.T, input any, output any) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "apps/cli/src/runtime/fixtures/publication-preparation-contract.ts")
	command.Dir = filepath.Join(filepath.Dir(file), "..", "..", "..")
	command.Stdin = bytes.NewReader(encoded)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	result, err := command.Output()
	if err != nil {
		t.Fatalf("Host preparation contract: %v: %s", err, stderr.String())
	}
	if err := json.Unmarshal(result, output); err != nil {
		t.Fatal(err)
	}
}

func normalizedPublicationBytes(t *testing.T, userID string, batch ingestion.Batch) int {
	t.Helper()
	value, err := ingestion.PrepareBatch(authentication.Principal{UserID: userID}, batch)
	if err != nil {
		t.Fatal(err)
	}
	for n := range value.Events {
		value.Events[n].ObservedAt = value.ObservedAt
		value.Events[n].ReceivedAt = time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
		value.Events[n].IngestSeq = math.MaxUint64
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return len(encoded)
}

func TestHostPreparedNativePartsFitMaterializationBudget(t *testing.T) {
	for _, text := range []string{"native text", strings.Repeat("long text ", 300), strings.Repeat("<&>\u2028\u2029", 120)} {
		var result struct {
			Parts []struct {
				Body struct {
					Batch ingestion.Batch `json:"batch"`
				} `json:"body"`
				Bound int `json:"bound"`
			} `json:"parts"`
			UserID string `json:"userId"`
		}
		hostPreparationContract(t, map[string]any{"mode": "prepare", "text": text, "partBytes": 16384}, &result)
		if len(result.Parts) < 2 {
			t.Fatal("fixture must exercise actual Host partitioning")
		}
		for _, part := range result.Parts {
			actual := normalizedPublicationBytes(t, result.UserID, part.Body.Batch)
			if actual > part.Bound || part.Bound > 16384 {
				t.Fatalf("normalized=%d Host bound=%d budget=16384", actual, part.Bound)
			}
		}
	}
}

func TestHostMaterializationBoundCoversMaximumMetadataAndEscaping(t *testing.T) {
	for _, symbol := range []string{"x", "<", "&", "\u2028"} {
		batch := validBatch()
		bounded := func(n int) string { return "x" + strings.Repeat(symbol, (n-1)/len(symbol)) }
		batch.ProjectID = bounded(200)
		batch.Source.AdapterID, batch.Source.InstallationID, batch.Source.AdapterVersion = bounded(200), bounded(200), bounded(100)
		batch.Session.SourceSessionID = bounded(500)
		batch.Session.Title, batch.Session.Summary, batch.Session.Insight, batch.Session.Branch = bounded(2000), bounded(2000), bounded(2000), bounded(2000)
		batch.Session.Actor.Name, batch.Session.Actor.Harness = bounded(200), bounded(200)
		for n := range batch.Events {
			batch.Events[n].Author, batch.Events[n].Text = bounded(200), bounded(10000)
		}
		userID := bounded(200)
		var result struct {
			Bound int `json:"bound"`
		}
		hostPreparationContract(t, map[string]any{"mode": "bound", "batch": batch, "userId": userID}, &result)
		actual := normalizedPublicationBytes(t, userID, batch)
		if actual > result.Bound {
			t.Fatalf("normalized=%d exceeds Host bound=%d", actual, result.Bound)
		}
	}
}
