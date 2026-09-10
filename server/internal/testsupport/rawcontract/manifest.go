// Package rawcontract exercises Raw's caller Interface against concrete stores.
package rawcontract

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
)

func Manifest(t *testing.T, archive *rawarchive.Archive, cli, web authentication.Principal, sessionID string) string {
	t.Helper()
	empty, err := archive.OpenSessionPage(t.Context(), web, sessionID, "", 3)
	if err != nil || len(empty.Objects) != 0 || empty.NextCursor != "" {
		t.Fatalf("empty page: %+v %v", empty, err)
	}
	content := []byte("redacted fixture")
	sum := sha256.Sum256(content)
	makeUpload := func(n int, generation int64) rawarchive.UploadChunk {
		return rawarchive.UploadChunk{ProtocolVersion: rawarchive.ProtocolVersion, SourceChunkID: fmt.Sprintf("page-%d-%d", n, generation), SourceObjectID: fmt.Sprintf("page-%d", n), SessionID: sessionID, InstallationID: "test-installation", Generation: generation,
			SourceName: fmt.Sprintf("source-%d", n), MediaType: "text/plain", AdapterID: "atape-adapter-codex", AdapterVersion: "0.1.0",
			CapturedAt:     time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(-time.Duration(n) * time.Hour).Format(time.RFC3339),
			ClientRedacted: true, Final: true, ContentBase64: base64.StdEncoding.EncodeToString(content), SHA256: hex.EncodeToString(sum[:])}
	}
	ids := make([]string, 101)
	for n := range ids {
		receipt, err := archive.Append(t.Context(), cli, makeUpload(n, 1))
		if err != nil {
			t.Fatal(err)
		}
		ids[n] = receipt.ObjectID
	}
	var required *rawarchive.PaginationRequiredError
	if _, err := archive.OpenSession(t.Context(), web, sessionID); !errors.As(err, &required) {
		t.Fatalf("legacy must reject partial archive: %v", err)
	}
	first, err := archive.OpenSessionPage(t.Context(), web, sessionID, "", 4)
	if err != nil || len(first.Objects) != 4 || first.NextCursor == "" || first.Objects[0].ObjectID != ids[100] {
		t.Fatalf("first page: %+v %v", first, err)
	}
	// Appending changes capture time but must not move an unread old object to
	// the already-visited page. A new object is discovered on refresh instead.
	updated := makeUpload(0, 2)
	updated.CapturedAt = "2027-01-01T00:00:00Z"
	if _, err := archive.Append(t.Context(), cli, updated); err != nil {
		t.Fatal(err)
	}
	added, err := archive.Append(t.Context(), cli, makeUpload(101, 1))
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	page := first
	for {
		if len(page.Objects) > 4 {
			t.Fatal("unbounded manifest page")
		}
		for _, object := range page.Objects {
			if seen[object.ObjectID] || object.ObjectID == added.ObjectID {
				t.Fatal("duplicate or newly inserted object entered old walk")
			}
			seen[object.ObjectID] = true
			if object.ObjectID == ids[0] && object.CurrentGeneration != 2 {
				t.Fatal("page lost current generation metadata")
			}
		}
		if page.NextCursor == "" {
			break
		}
		page, err = archive.OpenSessionPage(t.Context(), web, sessionID, page.NextCursor, 4)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != len(ids) {
		t.Fatalf("manifest lost objects: %d", len(seen))
	}
	refreshed, err := archive.OpenSessionPage(t.Context(), web, sessionID, "", 1)
	if err != nil || len(refreshed.Objects) != 1 || refreshed.Objects[0].ObjectID != added.ObjectID {
		t.Fatalf("refresh: %+v %v", refreshed, err)
	}
	decoded, _ := base64.RawURLEncoding.DecodeString(first.NextCursor)
	invalidCursors := []string{"bad", strings.Repeat("A", 2049), base64.RawURLEncoding.EncodeToString(append(decoded, []byte(" {}")...)), base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(string(decoded), `"v":1`, `"v":2`, 1))), base64.RawURLEncoding.EncodeToString([]byte(strings.TrimSuffix(string(decoded), "}") + `,"extra":1}`))}
	for _, cursor := range invalidCursors {
		var validation *rawarchive.ValidationError
		if _, err := archive.OpenSessionPage(t.Context(), web, sessionID, cursor, 4); !errors.As(err, &validation) {
			t.Fatalf("invalid cursor accepted: %v", err)
		}
	}
	var validation *rawarchive.ValidationError
	if _, err := archive.OpenSessionPage(t.Context(), web, "other-session", first.NextCursor, 4); !errors.As(err, &validation) {
		t.Fatalf("cross-session cursor: %v", err)
	}
	for _, limit := range []int{-1, 101} {
		if _, err := archive.OpenSessionPage(t.Context(), web, sessionID, "", limit); !errors.As(err, &validation) {
			t.Fatalf("invalid limit: %v", err)
		}
	}
	return first.NextCursor
}
