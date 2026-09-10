// Package publication defines the candidate preparation Interface for atomic
// Canonical publication. Sealed means transport-complete, not validated or visible.
package publication

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"time"

	"github.com/SingleMai/ATape/server/internal/ingestion"
)

type Scope struct {
	ProjectID       string
	InstallationID  string
	AdapterID       string
	SourceSessionID string
	OriginKey       string
}
type Limits struct {
	PartBytes           int64
	TargetBytes         int64
	UserPendingBytes    int64
	Parts               int
	Reservations        int
	ReservationLifetime time.Duration
	LeaseLifetime       time.Duration
}
type Reservation struct {
	ID        string
	SessionID string
	ExpiresAt time.Time
}
type Begin struct {
	ReservationID    string
	CaptureID        string
	BaseHead         string
	TransformVersion string
}
type Attempt struct {
	ID               string
	SessionID        string
	CaptureID        string
	BaseHead         string
	TransformVersion string
	Fence            int64
	LeaseUntil       time.Time
	ExpiresAt        time.Time
	State            string
	Parts            int
	RetainedBytes    int64
	Seal             *Manifest
	ValidatedParts   int
	CandidateEvents  int
	CandidateUsage   int
}

// CanonicalPart repeats the complete bounded Session/Thread header and declares
// the complete target counts in every frozen transport part.
const TargetProfile = "atape.publication-target.v1"

type Target struct {
	Profile string `json:"profile"`
	Events  int    `json:"events"`
	Usage   int    `json:"usage"`
	Threads int    `json:"threads"`
}
type CanonicalPart struct {
	Target Target          `json:"target"`
	Batch  ingestion.Batch `json:"batch"`
}

type Part struct {
	Ordinal int
	SHA256  string
	Bytes   int64
}
type Manifest struct {
	Parts  int
	Bytes  int64
	SHA256 string
}
type Page struct {
	Attempt Attempt
	Parts   []Part
}
type Reclaimed struct {
	Parts        int
	Reservations int
	Bytes        int64
}

// ManifestHasher binds the ordered numbered part set without retaining bodies.
// Add parts in ordinal order, starting at zero. The Server independently verifies it.
type ManifestHasher struct {
	hash  hash.Hash
	parts int
	bytes int64
}

func NewManifestHasher() *ManifestHasher { return &ManifestHasher{hash: sha256.New()} }
func (h *ManifestHasher) Add(part Part) {
	fmt.Fprintf(h.hash, "%d:%d:%s\n", part.Ordinal, part.Bytes, part.SHA256)
	h.parts++
	h.bytes += part.Bytes
}
func (h *ManifestHasher) Manifest() Manifest {
	return Manifest{Parts: h.parts, Bytes: h.bytes, SHA256: hex.EncodeToString(h.hash.Sum(nil))}
}

// Error distinguishes invalid input, immutable identity conflicts, expired or
// superseded authority, quota exhaustion, and unknown reservations. Unknown is
// not a terminal rejection receipt. Permission errors retain the shared policy type.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return "publication " + e.Code + ": " + e.Message }
