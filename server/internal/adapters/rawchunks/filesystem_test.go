package rawchunks_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"testing"

	"github.com/SingleMai/ATape/server/internal/adapters/rawchunks"
)

func TestFilesystemPersistsImmutableChunk(t *testing.T) {
	store, err := rawchunks.NewFilesystem(t.TempDir())
	if err != nil {
		t.Fatalf("create Filesystem: %v", err)
	}
	if err := store.Check(context.Background()); err != nil {
		t.Fatalf("check Filesystem: %v", err)
	}
	content := []byte("redacted source")
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	key := "sha256/" + digest[:2] + "/" + digest
	if err := store.Put(context.Background(), key, content); err != nil {
		t.Fatalf("put chunk: %v", err)
	}
	if err := store.Put(context.Background(), key, content); err != nil {
		t.Fatalf("replay chunk: %v", err)
	}
	read, err := store.Read(context.Background(), key)
	if err != nil || string(read) != string(content) {
		t.Fatalf("read chunk = %q, %v", read, err)
	}
}

func TestFilesystemCheckDetectsUnavailableRootAndCancellation(t *testing.T) {
	root := t.TempDir()
	store, err := rawchunks.NewFilesystem(root)
	if err != nil {
		t.Fatalf("create Filesystem: %v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := store.Check(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled check error = %v", err)
	}
	if err := os.Remove(root); err != nil {
		t.Fatalf("remove temporary root: %v", err)
	}
	if err := store.Check(context.Background()); err == nil {
		t.Fatal("missing Raw root unexpectedly passed readiness")
	}
	if err := rawchunks.NewUnavailable().Check(context.Background()); err == nil {
		t.Fatal("unavailable Adapter unexpectedly passed readiness")
	}
}
