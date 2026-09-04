package memoryraw

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"

	"github.com/SingleMai/ATape/server/internal/rawarchive"
)

// NewDemoArchive seeds representative, already-redacted Raw source for the
// local executable. Raw remains absent from Canonical and Search fixtures.
func NewDemoArchive() (*rawarchive.Archive, error) {
	store := New()
	archive := rawarchive.NewArchive(store, store)
	content := []byte(
		`{"type":"user","message":"Retries occasionally charge a customer twice."}` + "\n" +
			`{"type":"assistant","message":"I found two retry layers.","request":{"authorization":"[REDACTED]"}}` + "\n" +
			`{"type":"tool_result","tool":"read_file","path":"internal/payments/retry.go"}` + "\n",
	)
	digest := sha256.Sum256(content)
	_, err := archive.Append(context.Background(), rawarchive.UploadChunk{
		ProtocolVersion: rawarchive.ProtocolVersion,
		ChunkID:         "demo-checkout-raw-g1-c1",
		ObjectID:        "demo-checkout-codex-jsonl",
		ProjectID:       "payments-api",
		SessionID:       "checkout",
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
