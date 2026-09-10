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

// SessionID and SessionSourceKey use the same authenticated source scope as
// incremental Canonical ingestion, so both write paths share one mode boundary.
func SessionID(projectID, userID, installationID, adapterID, sourceSessionID string) string {
	return stableID("s_", key(projectID, userID, installationID, adapterID, sourceSessionID))
}
func SessionSourceKey(projectID, userID, installationID, adapterID, sourceSessionID string) string {
	return key(key(projectID, userID, installationID, adapterID, sourceSessionID), "session")
}
