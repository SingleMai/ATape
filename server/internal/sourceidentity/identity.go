// Package sourceidentity derives server-owned identifiers from authenticated
// capture scope and untrusted source-local identifiers.
package sourceidentity

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
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

// SourceThreadID recovers only the source-local Thread identity from a key
// proven to belong to this exact authenticated Session scope.
func SourceThreadID(sessionSourceKey, threadSourceKey string) (string, bool) {
	session, ok := keyParts(sessionSourceKey)
	if !ok || len(session) != 2 || session[1] != "session" {
		return "", false
	}
	thread, ok := keyParts(threadSourceKey)
	if !ok || len(thread) != 3 || thread[0] != session[0] || thread[1] != "thread" || thread[2] == "" {
		return "", false
	}
	return thread[2], true
}

func keyParts(value string) ([]string, bool) {
	var parts []string
	for value != "" {
		colon := strings.IndexByte(value, ':')
		if colon < 1 {
			return nil, false
		}
		size, err := strconv.Atoi(value[:colon])
		if err != nil || size < 0 || size > len(value)-colon-1 {
			return nil, false
		}
		parts = append(parts, value[colon+1:colon+1+size])
		value = value[colon+1+size:]
	}
	return parts, true
}
