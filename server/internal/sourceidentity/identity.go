// Package sourceidentity derives server-owned identifiers from authenticated
// capture scope and untrusted source-local identifiers.
package sourceidentity

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

func RawObjectID(userID, sessionID, installationID, adapterID, sourceObjectID string) string {
	return stableID("r_", key(userID, sessionID, installationID, adapterID, sourceObjectID))
}

func RawChunkID(objectID, sourceChunkID string) string {
	return stableID("c_", key(objectID, sourceChunkID))
}

func key(parts ...string) string {
	var result strings.Builder
	for _, part := range parts {
		fmt.Fprintf(&result, "%d:%s", len(part), part)
	}
	return result.String()
}

func stableID(prefix, value string) string {
	sum := sha256.Sum256([]byte(value))
	return prefix + hex.EncodeToString(sum[:12])
}
