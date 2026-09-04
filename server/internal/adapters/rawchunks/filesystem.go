// Package rawchunks provides immutable byte-store Adapters for Raw Archive.
package rawchunks

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/SingleMai/ATape/server/internal/rawarchive"
)

type Filesystem struct{ root string }

func NewFilesystem(root string) (*Filesystem, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, fmt.Errorf("Raw chunk directory must not be empty")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve Raw chunk directory: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o750); err != nil {
		return nil, fmt.Errorf("create Raw chunk directory: %w", err)
	}
	return &Filesystem{root: absolute}, nil
}

func (s *Filesystem) Put(ctx context.Context, key string, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := s.path(key)
	if err != nil {
		return err
	}
	if len(content) > rawarchive.MaxChunkBytes {
		return &rawarchive.ValidationError{Field: "content", Reason: "chunk exceeds 256 KiB"}
	}
	if digest(content) != filepath.Base(path) {
		return &rawarchive.ConflictError{Identity: key, Reason: "storage key does not match content"}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("create Raw chunk shard: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".atape-raw-*")
	if err != nil {
		return fmt.Errorf("create Raw chunk staging file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o640); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("set Raw chunk permissions: %w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write Raw chunk: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync Raw chunk: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close Raw chunk: %w", err)
	}
	if err := os.Link(temporaryPath, path); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("commit Raw chunk: %w", err)
		}
		existing, readErr := s.Read(ctx, key)
		if readErr != nil {
			return readErr
		}
		if !bytes.Equal(existing, content) {
			return &rawarchive.ConflictError{Identity: key, Reason: "immutable storage key has different bytes"}
		}
	}
	return nil
}

func (s *Filesystem) Read(ctx context.Context, key string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, err := s.path(key)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, &rawarchive.NotFoundError{Resource: "chunk", ID: key}
	}
	if err != nil {
		return nil, fmt.Errorf("open Raw chunk: %w", err)
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, rawarchive.MaxChunkBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Raw chunk: %w", err)
	}
	if len(content) > rawarchive.MaxChunkBytes {
		return nil, &rawarchive.IntegrityError{ObjectID: key, ChunkID: "oversized"}
	}
	return content, nil
}

func (s *Filesystem) path(key string) (string, error) {
	parts := strings.Split(key, "/")
	if len(parts) != 3 || parts[0] != "sha256" || len(parts[1]) != 2 || len(parts[2]) != sha256.Size*2 ||
		parts[1] != parts[2][:2] {
		return "", &rawarchive.ValidationError{Field: "storageKey", Reason: "is invalid"}
	}
	if _, err := hex.DecodeString(parts[2]); err != nil {
		return "", &rawarchive.ValidationError{Field: "storageKey", Reason: "is invalid"}
	}
	return filepath.Join(s.root, parts[0], parts[1], parts[2]), nil
}

func digest(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

type Unavailable struct{}

func NewUnavailable() *Unavailable { return &Unavailable{} }

func (*Unavailable) Put(context.Context, string, []byte) error {
	return &rawarchive.UnavailableError{Operation: "upload; configure ATAPE_RAW_DIRECTORY"}
}

func (*Unavailable) Read(context.Context, string) ([]byte, error) {
	return nil, &rawarchive.UnavailableError{Operation: "content reads; configure ATAPE_RAW_DIRECTORY"}
}
