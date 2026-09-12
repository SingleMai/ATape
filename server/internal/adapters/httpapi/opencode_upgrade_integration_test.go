package httpapi

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Re-version the current bundle only in isolated staging. This exercises the
// real installed package replacement Interface, not historical format support.
func assertOpenCodeInstalledUpgrade(t *testing.T, root, home, projectID, artifact string,
	command func(any, ...string), runPackage func(string, string, ...string) []byte,
	control func(string) []byte, snapshot func(string) nativeCollectorSnapshot, readRaw func() []byte, contentUploads func() int64,
) {
	t.Helper()
	readFile := func(path string) []byte {
		t.Helper()
		value, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	writeFile := func(path string, value []byte) {
		t.Helper()
		if err := os.WriteFile(path, value, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	staging := filepath.Join(root, "upgrade-staging")
	if err := os.Mkdir(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	runPackage(root, "tar", "-xzf", artifact, "-C", staging)
	manifestPath := filepath.Join(staging, "package", "package.json")
	var manifest map[string]any
	if err := json.Unmarshal(readFile(manifestPath), &manifest); err != nil {
		t.Fatal(err)
	}
	version, ok := manifest["version"].(string)
	if !ok || version == "" {
		t.Fatal("missing package version")
	}
	fixtureVersion := version + "-upgrade-fixture"
	manifest["version"] = fixtureVersion
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(manifestPath, encoded)
	var packed []struct {
		Filename string `json:"filename"`
	}
	if err := json.Unmarshal(runPackage(filepath.Join(staging, "package"), "npm", "pack", "--ignore-scripts", "--json", "--pack-destination", staging), &packed); err != nil || len(packed) != 1 {
		t.Fatalf("pack versioned OpenCode fixture: %v", err)
	}
	upgradeSource := filepath.Join(root, "opencode-upgrade.tgz")
	writeFile(upgradeSource, readFile(filepath.Join(staging, packed[0].Filename)))
	type adapter struct {
		ID      string `json:"adapterId"`
		Version string `json:"version"`
	}
	var installed struct {
		Adapter adapter `json:"adapter"`
	}
	command(&installed, "install", upgradeSource)
	if installed.Adapter.ID != "opencode" || installed.Adapter.Version != fixtureVersion {
		t.Fatal("fixture package was not installed")
	}
	collect := func(expected int, noUploads bool) {
		t.Helper()
		var report struct {
			Failures []json.RawMessage `json:"failures"`
			Jobs     []struct {
				AdapterID        string            `json:"adapterId"`
				Observations     int               `json:"observations"`
				CanonicalBatches int               `json:"canonicalBatches"`
				RawChunks        int               `json:"rawChunks"`
				SourceFailures   []json.RawMessage `json:"sourceFailures"`
			} `json:"jobs"`
		}
		beforeRequests := contentUploads()
		command(&report, "cycle", projectID)
		if noUploads && contentUploads() != beforeRequests {
			t.Fatal("unchanged source sent Canonical or Raw content HTTP requests after upgrade")
		}
		if len(report.Failures) != 0 || len(report.Jobs) != 1 {
			t.Fatalf("installed upgrade collection failed: %+v", report)
		}
		job := report.Jobs[0]
		if job.AdapterID != "opencode" || job.Observations != expected || len(job.SourceFailures) != 0 ||
			(noUploads && (job.CanonicalBatches != 0 || job.RawChunks != 0)) {
			t.Fatalf("installed upgrade replayed or lost content: %+v", job)
		}
	}
	statePath := filepath.Join(home, "state", "collector.json")
	checkVersion := func(expected string) {
		t.Helper()
		// Collector metadata uses adapterVersion rather than package version.
		var persisted struct {
			Checkpoints []struct {
				ID      string `json:"adapterId"`
				Version string `json:"adapterVersion"`
			} `json:"checkpoints"`
		}
		if err := json.Unmarshal(readFile(statePath), &persisted); err != nil {
			t.Fatal(err)
		}
		for _, cp := range persisted.Checkpoints {
			if cp.ID == "opencode" && cp.Version == expected {
				return
			}
		}
		t.Fatalf("Collector did not record installed version %s", expected)
	}
	control("daemon-upgrade-edit")
	collect(1, false)
	checkVersion(fixtureVersion)
	before := readFile(statePath)
	previous := snapshot("daemon-snapshot")
	raw := readRaw()
	if !bytes.Contains(raw, []byte("CollectorDaemonUpgradeNeedle")) || bytes.Contains(raw, []byte("SENSITIVE_TEST_TOKEN")) {
		t.Fatal("versioned fixture did not publish its own masked Raw history")
	}
	writeFile(upgradeSource, readFile(artifact))
	var upgraded struct {
		Adapters []adapter `json:"adapters"`
	}
	command(&upgraded, "upgrade", "opencode")
	if len(upgraded.Adapters) != 1 || upgraded.Adapters[0].ID != "opencode" || upgraded.Adapters[0].Version != version {
		t.Fatalf("actual candidate upgrade failed: %+v", upgraded)
	}
	if !bytes.Equal(readFile(statePath), before) {
		t.Fatal("package replacement rewrote Collector progress")
	}
	// A shorter package version changes Raw envelope admission. Re-observe once
	// to reconsider previous capacity gaps, reusing all actual Raw receipts.
	collect(1, true)
	collect(0, true)
	checkVersion(version)
	resumed := snapshot("daemon-snapshot")
	if resumed.Head != previous.Head || resumed.SessionID != previous.SessionID || resumed.Checkpoint != previous.Checkpoint ||
		resumed.RawCaptureID == "" || !bytes.Equal(resumed.Records, previous.Records) ||
		resumed.Pending != 0 || !resumed.RawComplete || !bytes.Equal(readRaw(), raw) {
		t.Fatal("package upgrade changed retained Canonical/Raw history or capture progress")
	}
}
