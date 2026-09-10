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
	ProjectID       string `json:"projectId"`
	InstallationID  string `json:"installationId"`
	AdapterID       string `json:"adapterId"`
	SourceSessionID string `json:"sourceSessionId"`
	OriginKey       string `json:"originKey"`
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
	ID        string    `json:"id"`
	SessionID string    `json:"sessionId"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type Begin struct {
	ReservationID    string `json:"reservationId"`
	CaptureID        string `json:"captureId"`
	BaseHead         string `json:"baseHead"`
	TransformVersion string `json:"transformVersion"`
}
type Attempt struct {
	ID               string      `json:"id"`
	SessionID        string      `json:"sessionId"`
	CaptureID        string      `json:"captureId"`
	BaseHead         string      `json:"baseHead"`
	TransformVersion string      `json:"transformVersion"`
	Fence            int64       `json:"fence"`
	LeaseUntil       time.Time   `json:"leaseUntil"`
	ExpiresAt        time.Time   `json:"expiresAt"`
	State            string      `json:"state"`
	Parts            int         `json:"parts"`
	RetainedBytes    int64       `json:"retainedBytes"`
	Seal             *Manifest   `json:"seal"`
	ValidatedParts   int         `json:"validatedParts"`
	CandidateEvents  int         `json:"candidateEvents"`
	CandidateUsage   int         `json:"candidateUsage"`
	Activation       *Activation `json:"activation"`
}

// Activation is durable proof of the first successful head selection. Replays
// return this exact receipt even after another head or an expired writer lease.
type Activation struct {
	Head             string    `json:"head"`
	SessionID        string    `json:"sessionId"`
	CaptureID        string    `json:"captureId"`
	BaseHead         string    `json:"baseHead"`
	Fence            int64     `json:"fence"`
	TransformVersion string    `json:"transformVersion"`
	Manifest         Manifest  `json:"manifest"`
	ActivatedAt      time.Time `json:"activatedAt"`
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
	Ordinal int    `json:"ordinal"`
	SHA256  string `json:"sha256"`
	Bytes   int64  `json:"bytes"`
}
type Manifest struct {
	Parts  int    `json:"parts"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type Page struct {
	Attempt Attempt `json:"attempt"`
	Parts   []Part  `json:"parts"`
}
type Reclaimed struct {
	Parts        int   `json:"parts"`
	Reservations int   `json:"reservations"`
	Bytes        int64 `json:"bytes"`
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

// Protocol is advertised only by instances configured with explicit candidate bounds.
const Protocol = "atape.publication.v1"

// Capacity uses milliseconds on the wire, avoiding Go duration encoding.
type Capacity struct {
	PartBytes             int64 `json:"partBytes"`
	TargetBytes           int64 `json:"targetBytes"`
	UserPendingBytes      int64 `json:"userPendingBytes"`
	Parts                 int   `json:"parts"`
	Reservations          int   `json:"reservations"`
	ReservationLifetimeMS int64 `json:"reservationLifetimeMs"`
	LeaseLifetimeMS       int64 `json:"leaseLifetimeMs"`
}
type Capabilities struct {
	Protocol        string   `json:"protocol"`
	TargetProfile   string   `json:"targetProfile"`
	Limits          Capacity `json:"limits"`
	StatusPageSize  int      `json:"statusPageSize"`
	ReclaimPageSize int      `json:"reclaimPageSize"`
}
