package rawarchive_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/SingleMai/ATape/server/internal/adapters/memoryraw"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
)

const rawUserID = "01991b70-4d2b-7c96-a532-5818faba2e71"

func rawCLIPrincipal() authentication.Principal {
	return authentication.Principal{UserID: rawUserID, Method: authentication.CLIAuthentication}
}

func rawWebPrincipal() authentication.Principal {
	return authentication.Principal{UserID: rawUserID, Method: authentication.WebAuthentication}
}

func rawStore() *memoryraw.Store {
	return memoryraw.New(rawAccess{})
}

type rawAccess struct{}

func (rawAccess) CurrentSessionAccess(
	_ context.Context,
	principal authentication.Principal,
	sessionID string,
) (authorization.SessionAccessFacts, bool, error) {
	if sessionID != "checkout" {
		return authorization.SessionAccessFacts{}, false, nil
	}
	return authorization.SessionAccessFacts{
		ProjectID: "payments-api", ProjectState: "active",
		Resource: authorization.ResourceFacts{
			Kind: authorization.ConversationResource, TeamID: "acme-engineering",
			CapturedByUserID: rawUserID,
		},
		Membership: authorization.MembershipFacts{
			TeamID: "acme-engineering", UserID: principal.UserID,
			Role: authorization.MemberRole, Active: true,
		},
	}, true, nil
}

func TestArchiveAppendReplayPagingAndNewGeneration(t *testing.T) {
	store := rawStore()
	archive := rawarchive.NewArchive(store, store)
	first := upload("chunk-1", 1, 0, false, "first\n")
	second := upload("chunk-2", 1, 6, true, "second\n")

	firstCommit, err := archive.Append(t.Context(), rawCLIPrincipal(), first)
	if err != nil {
		t.Fatalf("append first chunk: %v", err)
	}
	objectID := firstCommit.ObjectID
	committed, err := archive.Append(t.Context(), rawCLIPrincipal(), second)
	if err != nil {
		t.Fatalf("append second chunk: %v", err)
	}
	if committed.SizeBytes != 13 || !committed.Finalized {
		t.Fatalf("unexpected commit: %+v", committed)
	}
	replayed, err := archive.Append(t.Context(), rawCLIPrincipal(), second)
	if err != nil || !replayed.Replayed || replayed.SizeBytes != 13 {
		t.Fatalf("unexpected replay: %+v, %v", replayed, err)
	}

	listing, err := archive.OpenSession(t.Context(), rawWebPrincipal(), "checkout")
	if err != nil || len(listing.Objects) != 1 || listing.Objects[0].GenerationCount != 1 {
		t.Fatalf("unexpected listing: %+v, %v", listing, err)
	}
	page, err := archive.Read(t.Context(), rawWebPrincipal(), objectID, 1, "", 1)
	if err != nil || len(page.Chunks) != 1 || page.NextCursor == "" {
		t.Fatalf("unexpected first page: %+v, %v", page, err)
	}
	next, err := archive.Read(t.Context(), rawWebPrincipal(), objectID, 1, page.NextCursor, 1)
	if err != nil || len(next.Chunks) != 1 || next.NextCursor != "" {
		t.Fatalf("unexpected next page: %+v, %v", next, err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(next.Chunks[0].ContentBase64)
	if string(decoded) != "second\n" {
		t.Fatalf("second page content = %q", decoded)
	}

	third := upload("chunk-3", 2, 0, true, "rewritten\n")
	if _, err := archive.Append(t.Context(), rawCLIPrincipal(), third); err != nil {
		t.Fatalf("start new generation: %v", err)
	}
	listing, err = archive.OpenSession(t.Context(), rawWebPrincipal(), "checkout")
	if err != nil || listing.Objects[0].CurrentGeneration != 2 || listing.Objects[0].GenerationCount != 2 {
		t.Fatalf("unexpected generation listing: %+v, %v", listing, err)
	}
	old, err := archive.Read(t.Context(), rawWebPrincipal(), objectID, 1, "", 4)
	if err != nil || len(old.Chunks) != 2 {
		t.Fatalf("historical generation was not retained: %+v, %v", old, err)
	}
}

func TestArchiveRejectsConflictsAndUnredactedContent(t *testing.T) {
	store := rawStore()
	archive := rawarchive.NewArchive(store, store)
	first := upload("chunk-1", 1, 0, false, "first\n")
	if _, err := archive.Append(t.Context(), rawCLIPrincipal(), first); err != nil {
		t.Fatalf("append first chunk: %v", err)
	}
	wrongOffset := upload("chunk-2", 1, 2, false, "second\n")
	if _, err := archive.Append(t.Context(), rawCLIPrincipal(), wrongOffset); err == nil {
		t.Fatal("wrong offset was accepted")
	} else {
		var conflict *rawarchive.ConflictError
		if !errors.As(err, &conflict) {
			t.Fatalf("wrong offset error = %T, want ConflictError", err)
		}
	}
	reused := upload("chunk-1", 1, 0, false, "different\n")
	if _, err := archive.Append(t.Context(), rawCLIPrincipal(), reused); err == nil {
		t.Fatal("conflicting chunk replay was accepted")
	}
	unredacted := upload("chunk-3", 1, 6, true, "secret\n")
	unredacted.ClientRedacted = false
	if _, err := archive.Append(t.Context(), rawCLIPrincipal(), unredacted); err == nil {
		t.Fatal("unredacted declaration was accepted")
	} else {
		var validation *rawarchive.ValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("unredacted error = %T, want ValidationError", err)
		}
	}
}

func TestArchiveRejectsAnotherTeamMemberBeforeStoringBytes(t *testing.T) {
	store := rawStore()
	archive := rawarchive.NewArchive(store, store)
	other := authentication.Principal{
		UserID: "01991b70-4d2b-7c96-a532-5818faba2e72",
		Method: authentication.CLIAuthentication,
	}
	_, err := archive.Append(t.Context(), other, upload("other-user-chunk", 1, 0, true, "private\n"))
	var access *authorization.AccessError
	if !errors.As(err, &access) || access.Decision != authorization.Forbid ||
		access.Denial != authorization.MembershipRoleDenied {
		t.Fatalf("error = %v, want captured-by ownership denial", err)
	}
	sum := sha256.Sum256([]byte("private\n"))
	hexDigest := hex.EncodeToString(sum[:])
	if _, readErr := store.Read(t.Context(), "sha256/"+hexDigest[:2]+"/"+hexDigest); readErr == nil {
		t.Fatal("unauthorized Raw bytes reached the Chunk Store")
	}
}

func upload(chunkID string, generation int64, offset int64, final bool, content string) rawarchive.UploadChunk {
	sum := sha256.Sum256([]byte(content))
	return rawarchive.UploadChunk{
		ProtocolVersion: rawarchive.ProtocolVersion, SourceChunkID: chunkID, SourceObjectID: "raw-checkout",
		SessionID: "checkout", InstallationID: "test-installation", Generation: generation, Offset: offset,
		SourceName: "codex-session.jsonl", MediaType: "application/x-ndjson", AdapterID: "atape-adapter-codex",
		AdapterVersion: "0.1.0", CapturedAt: "2026-09-04T10:52:18+08:00", ClientRedacted: true,
		Final: final, ContentBase64: base64.StdEncoding.EncodeToString([]byte(content)), SHA256: hex.EncodeToString(sum[:]),
	}
}
