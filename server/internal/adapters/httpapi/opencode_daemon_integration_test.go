package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/conversation"
)

// This extends the actual HTTP/PostgreSQL contract using its existing account,
// installed Adapter and frozen journal. Only native source mutations and reads of
// test evidence use the fixture; all collection runs in the installed CLI daemon.
func assertOpenCodeInstalledDaemon(t *testing.T, repository, origin, projectID string, previous nativeCollectorSnapshot,
	control func(string) []byte, snapshot func(string) nativeCollectorSnapshot,
	read func() (string, []conversation.Event), readRaw func() []byte,
) {
	t.Helper()
	var source struct {
		Home   string          `json:"atapeHome"`
		Path   string          `json:"sourcePath"`
		Limits json.RawMessage `json:"sourceLimits"`
	}
	if err := json.Unmarshal(control("daemon-source"), &source); err != nil || source.Home == "" || source.Path == "" || len(source.Limits) == 0 {
		t.Fatalf("prepare installed daemon source: %v", err)
	}
	root := t.TempDir()
	runPackage := func(directory, program string, args ...string) []byte {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, program, args...)
		command.Dir = directory
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Fatalf("installed CLI preparation: %v\n%s", err, stderr.String())
		}
		return output
	}
	var artifacts []struct {
		Filename string `json:"filename"`
	}
	if err := json.Unmarshal(runPackage(filepath.Join(repository, "apps", "cli"), "npm", "pack", "--json", "--pack-destination", root), &artifacts); err != nil || len(artifacts) != 1 {
		t.Fatalf("pack installed daemon CLI: %v", err)
	}
	runPackage(root, "npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", root, filepath.Join(root, artifacts[0].Filename))
	entry := filepath.Join(root, "node_modules", "@atape", "cli", "dist", "atape.js")
	environment := []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + root, "ATAPE_LANG=en",
		"XDG_CONFIG_HOME=" + filepath.Join(root, "xdg-config"), "XDG_DATA_HOME=" + filepath.Join(root, "xdg-data"), "XDG_STATE_HOME=" + filepath.Join(root, "xdg-state"),
		"ATAPE_HOME=" + source.Home, "ATAPE_INSTANCE_URL=" + origin, "ATAPE_DEVELOPMENT_ALLOW_HTTP=true",
		"OPENCODE_DB=" + source.Path, "ATAPE_SOURCE_COLLECTION_LIMITS=" + string(source.Limits),
		`ATAPE_REDACT_VALUES=["SENSITIVE_TEST_TOKEN"]`,
	}
	execute := func(ctx context.Context, args ...string) ([]byte, error) {
		command := exec.CommandContext(ctx, "node", append([]string{entry}, args...)...)
		command.Dir, command.Env = root, environment
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			t.Logf("installed daemon command stderr: %s", stderr.String())
		}
		return output, err
	}
	// Independent cleanup context still stops our owned daemon when the test's
	// deadline expires. The production stop Interface validates its process token.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if _, err := execute(ctx, "stop", "--json"); err != nil {
			t.Errorf("cleanup installed daemon: %v", err)
		}
	})
	command := func(target any, args ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		output, err := execute(ctx, args...)
		if err != nil {
			t.Fatalf("installed daemon %v: %v", args, err)
		}
		if err := json.Unmarshal(output, target); err != nil {
			t.Fatalf("installed daemon output: %v", err)
		}
	}
	type status struct {
		Running          bool            `json:"running"`
		PID              int             `json:"pid"`
		Completed        string          `json:"lastCycleCompletedAt"`
		CollectorFailure json.RawMessage `json:"collectorFailure"`
		Jobs             []struct {
			ProjectID string `json:"projectId"`
			AdapterID string `json:"adapterId"`
			State     string `json:"state"`
			HasMore   bool   `json:"hasMore"`
		} `json:"jobs"`
	}
	start := func() (bool, int) {
		t.Helper()
		var started struct {
			Created bool `json:"created"`
			PID     int  `json:"pid"`
		}
		command(&started, "start", "--interval", "10", "--concurrency", "1", "--json")
		if started.PID <= 0 {
			t.Fatal("installed daemon has no process identity")
		}
		return started.Created, started.PID
	}
	stop := func() {
		t.Helper()
		var stopped struct {
			Stopped bool `json:"stopped"`
		}
		command(&stopped, "stop", "--json")
		var current status
		command(&current, "status", "--json")
		if !stopped.Stopped || current.Running {
			t.Fatal("installed daemon did not stop through its public Interface")
		}
	}
	wait := func(after, oldHead, needle, expectedState string) string {
		t.Helper()
		deadline := time.NewTimer(45 * time.Second)
		defer deadline.Stop()
		var current status
		for {
			command(&current, "status", "--json")
			if !current.Running || len(current.CollectorFailure) != 0 {
				t.Fatalf("installed daemon exited or failed globally: %+v", current)
			}
			for _, job := range current.Jobs {
				if job.ProjectID != projectID || job.AdapterID != "opencode" || job.State != expectedState || job.HasMore || current.Completed == after {
					continue
				}
				if expectedState == "failed" {
					return current.Completed
				}
				head, events := read()
				encoded, _ := json.Marshal(events)
				if head != oldHead && bytes.Contains(encoded, []byte(needle)) && !bytes.Contains(encoded, []byte("SENSITIVE_TEST_TOKEN")) {
					return current.Completed
				}
			}
			select {
			case <-deadline.C:
				t.Fatalf("installed daemon did not reach %s: %+v", expectedState, current)
			case <-t.Context().Done():
				t.Fatal(t.Context().Err())
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
	created, firstPID := start()
	if !created {
		t.Fatal("first installed daemon start reused an unexpected process")
	}
	if created, pid := start(); created || pid != firstPID {
		t.Fatal("repeated start created a second installed daemon")
	}
	completed := wait("", previous.Head, "CollectorDaemonInitialNeedle", "healthy")
	stop()
	initial := snapshot("daemon-snapshot")
	if initial.Pending != 0 || !initial.RawComplete || initial.Head == previous.Head || initial.RawCaptureID == "" || initial.RawCaptureID == previous.RawCaptureID {
		t.Fatal("installed daemon did not finish Canonical and Raw delivery")
	}
	if row := readRaw(); !bytes.Contains(row, []byte("CollectorDaemonInitialNeedle")) || bytes.Contains(row, []byte("SENSITIVE_TEST_TOKEN")) {
		t.Fatal("initial installed daemon Event did not resolve to its own masked Raw source")
	}
	control("daemon-edit")
	created, secondPID := start()
	if !created || secondPID == firstPID {
		t.Fatal("stopped daemon was not replaced by a fresh installed process")
	}
	completed = wait(completed, initial.Head, "CollectorDaemonUpdatedNeedle", "healthy")
	updatedHead, _ := read()
	control("daemon-live-edit")
	completed = wait(completed, updatedHead, "CollectorDaemonLiveNeedle", "healthy")
	stop()
	updated := snapshot("daemon-snapshot")
	if updated.Pending != 0 || !updated.RawComplete || updated.Head == initial.Head || updated.Checkpoint == initial.Checkpoint || updated.RawCaptureID == "" || updated.RawCaptureID == initial.RawCaptureID {
		t.Fatal("installed daemon restart did not publish the source update")
	}
	if row := readRaw(); !bytes.Contains(row, []byte("CollectorDaemonLiveNeedle")) || bytes.Contains(row, []byte("SENSITIVE_TEST_TOKEN")) {
		t.Fatal("updated installed daemon Event did not resolve to its own masked Raw source")
	}
	control("daemon-missing")
	if created, _ := start(); !created {
		t.Fatal("missing-source daemon did not start a fresh owned process")
	}
	wait(completed, "", "", "failed")
	stop()
	missing := snapshot("daemon-snapshot")
	actualHead, _ := read()
	if missing.Head != updated.Head || actualHead != updated.Head || missing.Checkpoint != updated.Checkpoint || !bytes.Equal(missing.Records, updated.Records) || missing.Pending != 0 {
		t.Fatal("source absence reset the installed daemon's durable history")
	}
}
