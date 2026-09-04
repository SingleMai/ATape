package rawarchive_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/SingleMai/ATape/server/internal/adapters/memoryraw"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
)

func TestArchiveAppendReplayPagingAndNewGeneration(t *testing.T) {
	store := memoryraw.New()
	archive := rawarchive.NewArchive(store, store)
	first := upload("chunk-1", 1, 0, false, "first\n")
	second := upload("chunk-2", 1, 6, true, "second\n")

	if _, err := archive.Append(t.Context(), first); err != nil {
		t.Fatalf("append first chunk: %v", err)
	}
	committed, err := archive.Append(t.Context(), second)
	if err != nil {
		t.Fatalf("append second chunk: %v", err)
	}
	if committed.SizeBytes != 13 || !committed.Finalized {
		t.Fatalf("unexpected commit: %+v", committed)
	}
	replayed, err := archive.Append(t.Context(), second)
	if err != nil || !replayed.Replayed || replayed.SizeBytes != 13 {
		t.Fatalf("unexpected replay: %+v, %v", replayed, err)
	}

	listing, err := archive.OpenSession(t.Context(), "checkout")
	if err != nil || len(listing.Objects) != 1 || listing.Objects[0].GenerationCount != 1 {
		t.Fatalf("unexpected listing: %+v, %v", listing, err)
	}
	page, err := archive.Read(t.Context(), "raw-checkout", 1, "", 1)
	if err != nil || len(page.Chunks) != 1 || page.NextCursor == "" {
		t.Fatalf("unexpected first page: %+v, %v", page, err)
	}
	next, err := archive.Read(t.Context(), "raw-checkout", 1, page.NextCursor, 1)
	if err != nil || len(next.Chunks) != 1 || next.NextCursor != "" {
		t.Fatalf("unexpected next page: %+v, %v", next, err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(next.Chunks[0].ContentBase64)
	if string(decoded) != "second\n" {
		t.Fatalf("second page content = %q", decoded)
	}

	third := upload("chunk-3", 2, 0, true, "rewritten\n")
	if _, err := archive.Append(t.Context(), third); err != nil {
		t.Fatalf("start new generation: %v", err)
	}
	listing, err = archive.OpenSession(t.Context(), "checkout")
	if err != nil || listing.Objects[0].CurrentGeneration != 2 || listing.Objects[0].GenerationCount != 2 {
		t.Fatalf("unexpected generation listing: %+v, %v", listing, err)
	}
	old, err := archive.Read(t.Context(), "raw-checkout", 1, "", 4)
	if err != nil || len(old.Chunks) != 2 {
		t.Fatalf("historical generation was not retained: %+v, %v", old, err)
	}
}

func TestArchiveRejectsConflictsAndUnredactedContent(t *testing.T) {
	store := memoryraw.New()
	archive := rawarchive.NewArchive(store, store)
	first := upload("chunk-1", 1, 0, false, "first\n")
	if _, err := archive.Append(t.Context(), first); err != nil {
		t.Fatalf("append first chunk: %v", err)
	}
	wrongOffset := upload("chunk-2", 1, 2, false, "second\n")
	if _, err := archive.Append(t.Context(), wrongOffset); err == nil {
		t.Fatal("wrong offset was accepted")
	} else {
		var conflict *rawarchive.ConflictError
		if !errors.As(err, &conflict) {
			t.Fatalf("wrong offset error = %T, want ConflictError", err)
		}
	}
	reused := upload("chunk-1", 1, 0, false, "different\n")
	if _, err := archive.Append(t.Context(), reused); err == nil {
		t.Fatal("conflicting chunk replay was accepted")
	}
	unredacted := upload("chunk-3", 1, 6, true, "secret\n")
	unredacted.ClientRedacted = false
	if _, err := archive.Append(t.Context(), unredacted); err == nil {
		t.Fatal("unredacted declaration was accepted")
	} else {
		var validation *rawarchive.ValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("unredacted error = %T, want ValidationError", err)
		}
	}
}

func upload(chunkID string, generation int64, offset int64, final bool, content string) rawarchive.UploadChunk {
	sum := sha256.Sum256([]byte(content))
	return rawarchive.UploadChunk{
		ProtocolVersion: rawarchive.ProtocolVersion, ChunkID: chunkID, ObjectID: "raw-checkout",
		ProjectID: "payments-api", SessionID: "checkout", Generation: generation, Offset: offset,
		SourceName: "codex-session.jsonl", MediaType: "application/x-ndjson", AdapterID: "atape-adapter-codex",
		AdapterVersion: "0.1.0", CapturedAt: "2026-09-04T10:52:18+08:00", ClientRedacted: true,
		Final: final, ContentBase64: base64.StdEncoding.EncodeToString([]byte(content)), SHA256: hex.EncodeToString(sum[:]),
	}
}
