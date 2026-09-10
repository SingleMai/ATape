package canonical

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

// EventVersionFingerprint has the same content boundary as SameEventContent.
// It permits provenance-only upgrades while binding all semantic fields of a
// source revision. UTC encoding makes equivalent occurrence instants identical.
func EventVersionFingerprint(event EventRecord) (string, error) {
	event.Digest = ""
	event.AdapterVersion = ""
	event.SchemaVersion = ""
	event.ObservedAt = time.Time{}
	event.ReceivedAt = time.Time{}
	event.IngestSeq = 0
	event.OccurredAt = event.OccurredAt.UTC()
	body, err := json.Marshal(event)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:]), nil
}
