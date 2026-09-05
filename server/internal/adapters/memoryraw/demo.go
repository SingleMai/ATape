package memoryraw

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
)

// NewDemoArchive seeds representative, already-redacted Raw source for the
// local executable. Raw remains absent from Canonical and Search fixtures.
func NewDemoArchive(access SessionAccess) (*rawarchive.Archive, error) {
	store := New(access)
	archive := rawarchive.NewArchive(store, store)
	principal := authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.CLIAuthentication}
	content := []byte(
		`{"type":"user","message":"Retries occasionally charge a customer twice."}` + "\n" +
			`{"type":"assistant","message":"I found two retry layers.","request":{"authorization":"[REDACTED]"}}` + "\n" +
			`{"type":"tool_result","tool":"read_file","path":"internal/payments/retry.go"}` + "\n",
	)
	digest := sha256.Sum256(content)
	_, err := archive.Append(context.Background(), principal, rawarchive.UploadChunk{
		ProtocolVersion: rawarchive.ProtocolVersion,
		SourceChunkID:   "demo-checkout-raw-g1-c1",
		SourceObjectID:  "demo-checkout-codex-jsonl",
		SessionID:       "checkout",
		InstallationID:  "demo-installation",
		Generation:      1,
		Offset:          0,
		SourceName:      "codex-session.jsonl",
		MediaType:       "application/x-ndjson",
		AdapterID:       "atape-adapter-codex",
		AdapterVersion:  "0.1.0",
		CapturedAt:      "2026-09-04T10:52:18+08:00",
		ClientRedacted:  true,
		Final:           true,
		ContentBase64:   base64.StdEncoding.EncodeToString(content),
		SHA256:          hex.EncodeToString(digest[:]),
	})
	if err != nil {
		return nil, err
	}
	return archive, nil
}
