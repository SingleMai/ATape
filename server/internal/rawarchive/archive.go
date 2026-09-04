// Package rawarchive preserves bounded, client-redacted source material behind
// a Canonical Session without exposing storage layout to transports or readers.
package rawarchive

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	ProtocolVersion = "atape.raw.v1alpha1"
	MaxChunkBytes   = 256 << 10
	DefaultPageSize = 4
	MaxPageSize     = 8
)

type UploadChunk struct {
	ProtocolVersion string `json:"protocolVersion"`
	ChunkID         string `json:"chunkId"`
	ObjectID        string `json:"objectId"`
	ProjectID       string `json:"projectId"`
	SessionID       string `json:"sessionId"`
	Generation      int64  `json:"generation"`
	Offset          int64  `json:"offset"`
	SourceName      string `json:"sourceName"`
	MediaType       string `json:"mediaType"`
	AdapterID       string `json:"adapterId"`
	AdapterVersion  string `json:"adapterVersion"`
	CapturedAt      string `json:"capturedAt"`
	ClientRedacted  bool   `json:"clientRedacted"`
	Final           bool   `json:"final"`
	ContentBase64   string `json:"contentBase64"`
	SHA256          string `json:"sha256"`
}

type ChunkRecord struct {
	ChunkID        string
	ObjectID       string
	ProjectID      string
	SessionID      string
	Generation     int64
	Ordinal        int64
	Offset         int64
	SizeBytes      int64
	SourceName     string
	MediaType      string
	AdapterID      string
	AdapterVersion string
	CapturedAt     time.Time
	ClientRedacted bool
	Final          bool
	SHA256         string
	StorageKey     string
}

type GenerationRecord struct {
	Generation int64
	SizeBytes  int64
	ChunkCount int64
	Finalized  bool
}

type ObjectRecord struct {
	ObjectID          string
	ProjectID         string
	SessionID         string
	SourceName        string
	MediaType         string
	AdapterID         string
	AdapterVersion    string
	CapturedAt        time.Time
	ClientRedacted    bool
	CurrentGeneration int64
	GenerationCount   int64
	CurrentSizeBytes  int64
	CurrentFinalized  bool
}

type CommitResult struct {
	Object     ObjectRecord
	Generation GenerationRecord
	Replayed   bool
}

type ContentPlan struct {
	Object     ObjectRecord
	Generation GenerationRecord
	Chunks     []ChunkRecord
	HasMore    bool
}

// ManifestStore is the transactional metadata Seam consumed by Archive.
// Implementations own append ordering, generation transitions, and replay
// identity; callers never coordinate these invariants themselves.
type ManifestStore interface {
	CommitChunk(context.Context, ChunkRecord) (CommitResult, error)
	ListSessionObjects(context.Context, string) ([]ObjectRecord, error)
	PlanContent(context.Context, string, int64, int64, int) (ContentPlan, error)
}

// ChunkStore is the immutable byte Seam consumed by Archive. Put must be
// replay-safe for the same key and bytes; Read returns one bounded chunk.
type ChunkStore interface {
	Put(context.Context, string, []byte) error
	Read(context.Context, string) ([]byte, error)
}

type Archive struct {
	manifests ManifestStore
	chunks    ChunkStore
}

func NewArchive(manifests ManifestStore, chunks ChunkStore) *Archive {
	return &Archive{manifests: manifests, chunks: chunks}
}

type AppendResult struct {
	ObjectID   string `json:"objectId"`
	Generation int64  `json:"generation"`
	SizeBytes  int64  `json:"sizeBytes"`
	Finalized  bool   `json:"finalized"`
	Replayed   bool   `json:"replayed"`
}

type ObjectSummary struct {
	ObjectID          string `json:"objectId"`
	ProjectID         string `json:"projectId"`
	SessionID         string `json:"sessionId"`
	SourceName        string `json:"sourceName"`
	MediaType         string `json:"mediaType"`
	AdapterID         string `json:"adapterId"`
	AdapterVersion    string `json:"adapterVersion"`
	CapturedAt        string `json:"capturedAt"`
	ClientRedacted    bool   `json:"clientRedacted"`
	CurrentGeneration int64  `json:"currentGeneration"`
	GenerationCount   int64  `json:"generationCount"`
	CurrentSizeBytes  int64  `json:"currentSizeBytes"`
	CurrentFinalized  bool   `json:"currentFinalized"`
}

type SessionArchive struct {
	SessionID string          `json:"sessionId"`
	Objects   []ObjectSummary `json:"objects"`
}

type ContentChunk struct {
	Offset        int64  `json:"offset"`
	SizeBytes     int64  `json:"sizeBytes"`
	SHA256        string `json:"sha256"`
	ContentBase64 string `json:"contentBase64"`
}

type ContentPage struct {
	ObjectID   string         `json:"objectId"`
	Generation int64          `json:"generation"`
	SizeBytes  int64          `json:"sizeBytes"`
	Finalized  bool           `json:"finalized"`
	Chunks     []ContentChunk `json:"chunks"`
	NextCursor string         `json:"nextCursor,omitempty"`
}

func (a *Archive) Append(ctx context.Context, upload UploadChunk) (AppendResult, error) {
	record, content, err := validateUpload(upload)
	if err != nil {
		return AppendResult{}, err
	}
	if err := a.chunks.Put(ctx, record.StorageKey, content); err != nil {
		return AppendResult{}, err
	}
	committed, err := a.manifests.CommitChunk(ctx, record)
	if err != nil {
		return AppendResult{}, err
	}
	return AppendResult{
		ObjectID:   committed.Object.ObjectID,
		Generation: committed.Generation.Generation,
		SizeBytes:  committed.Generation.SizeBytes,
		Finalized:  committed.Generation.Finalized,
		Replayed:   committed.Replayed,
	}, nil
}

func (a *Archive) OpenSession(ctx context.Context, sessionID string) (SessionArchive, error) {
	if strings.TrimSpace(sessionID) == "" {
		return SessionArchive{}, &ValidationError{Field: "sessionId", Reason: "must not be empty"}
	}
	objects, err := a.manifests.ListSessionObjects(ctx, sessionID)
	if err != nil {
		return SessionArchive{}, err
	}
	result := SessionArchive{SessionID: sessionID, Objects: make([]ObjectSummary, 0, len(objects))}
	for _, object := range objects {
		result.Objects = append(result.Objects, summarize(object))
	}
	return result, nil
}

func (a *Archive) Read(
	ctx context.Context,
	objectID string,
	generation int64,
	cursor string,
	limit int,
) (ContentPage, error) {
	if strings.TrimSpace(objectID) == "" {
		return ContentPage{}, &ValidationError{Field: "objectId", Reason: "must not be empty"}
	}
	if generation < 0 {
		return ContentPage{}, &ValidationError{Field: "generation", Reason: "must be zero or greater"}
	}
	if limit == 0 {
		limit = DefaultPageSize
	}
	if limit < 1 || limit > MaxPageSize {
		return ContentPage{}, &ValidationError{Field: "limit", Reason: fmt.Sprintf("must be between 1 and %d", MaxPageSize)}
	}
	afterOrdinal, cursorGeneration, err := decodeCursor(cursor, objectID, generation)
	if err != nil {
		return ContentPage{}, err
	}
	if generation == 0 && cursorGeneration != 0 {
		generation = cursorGeneration
	}
	plan, err := a.manifests.PlanContent(ctx, objectID, generation, afterOrdinal, limit)
	if err != nil {
		return ContentPage{}, err
	}
	page := ContentPage{
		ObjectID:   plan.Object.ObjectID,
		Generation: plan.Generation.Generation,
		SizeBytes:  plan.Generation.SizeBytes,
		Finalized:  plan.Generation.Finalized,
		Chunks:     make([]ContentChunk, 0, len(plan.Chunks)),
	}
	for _, chunk := range plan.Chunks {
		content, err := a.chunks.Read(ctx, chunk.StorageKey)
		if err != nil {
			return ContentPage{}, err
		}
		if int64(len(content)) != chunk.SizeBytes || digest(content) != chunk.SHA256 {
			return ContentPage{}, &IntegrityError{ObjectID: objectID, ChunkID: chunk.ChunkID}
		}
		page.Chunks = append(page.Chunks, ContentChunk{
			Offset:        chunk.Offset,
			SizeBytes:     chunk.SizeBytes,
			SHA256:        chunk.SHA256,
			ContentBase64: base64.StdEncoding.EncodeToString(content),
		})
	}
	if plan.HasMore && len(plan.Chunks) > 0 {
		last := plan.Chunks[len(plan.Chunks)-1]
		page.NextCursor = encodeCursor(objectID, plan.Generation.Generation, last.Ordinal)
	}
	return page, nil
}

func validateUpload(upload UploadChunk) (ChunkRecord, []byte, error) {
	required := []struct {
		field string
		value string
	}{
		{"chunkId", upload.ChunkID}, {"objectId", upload.ObjectID}, {"projectId", upload.ProjectID},
		{"sessionId", upload.SessionID}, {"sourceName", upload.SourceName}, {"mediaType", upload.MediaType},
		{"adapterId", upload.AdapterID}, {"adapterVersion", upload.AdapterVersion}, {"capturedAt", upload.CapturedAt},
	}
	if upload.ProtocolVersion != ProtocolVersion {
		return ChunkRecord{}, nil, &ValidationError{Field: "protocolVersion", Reason: "must be " + ProtocolVersion}
	}
	for _, item := range required {
		if strings.TrimSpace(item.value) == "" {
			return ChunkRecord{}, nil, &ValidationError{Field: item.field, Reason: "must not be empty"}
		}
		if len(item.value) > 512 {
			return ChunkRecord{}, nil, &ValidationError{Field: item.field, Reason: "is too long"}
		}
	}
	if upload.Generation < 1 {
		return ChunkRecord{}, nil, &ValidationError{Field: "generation", Reason: "must be one or greater"}
	}
	if upload.Offset < 0 {
		return ChunkRecord{}, nil, &ValidationError{Field: "offset", Reason: "must be zero or greater"}
	}
	if !upload.ClientRedacted {
		return ChunkRecord{}, nil, &ValidationError{Field: "clientRedacted", Reason: "must acknowledge client-side secret redaction"}
	}
	if len(upload.ContentBase64) > base64.StdEncoding.EncodedLen(MaxChunkBytes) {
		return ChunkRecord{}, nil, &ValidationError{Field: "contentBase64", Reason: "decoded chunk exceeds 256 KiB"}
	}
	content, err := base64.StdEncoding.Strict().DecodeString(upload.ContentBase64)
	if err != nil {
		return ChunkRecord{}, nil, &ValidationError{Field: "contentBase64", Reason: "must be canonical Base64"}
	}
	if len(content) > MaxChunkBytes {
		return ChunkRecord{}, nil, &ValidationError{Field: "contentBase64", Reason: "decoded chunk exceeds 256 KiB"}
	}
	if len(content) == 0 && !upload.Final {
		return ChunkRecord{}, nil, &ValidationError{Field: "contentBase64", Reason: "must not be empty unless finalizing a generation"}
	}
	providedDigest := strings.ToLower(upload.SHA256)
	if len(providedDigest) != sha256.Size*2 {
		return ChunkRecord{}, nil, &ValidationError{Field: "sha256", Reason: "must be a lowercase SHA-256 digest"}
	}
	if _, err := hex.DecodeString(providedDigest); err != nil || upload.SHA256 != providedDigest {
		return ChunkRecord{}, nil, &ValidationError{Field: "sha256", Reason: "must be a lowercase SHA-256 digest"}
	}
	if digest(content) != providedDigest {
		return ChunkRecord{}, nil, &ValidationError{Field: "sha256", Reason: "does not match decoded content"}
	}
	capturedAt, err := time.Parse(time.RFC3339, upload.CapturedAt)
	if err != nil {
		return ChunkRecord{}, nil, &ValidationError{Field: "capturedAt", Reason: "must be RFC3339"}
	}
	return ChunkRecord{
		ChunkID: upload.ChunkID, ObjectID: upload.ObjectID, ProjectID: upload.ProjectID, SessionID: upload.SessionID,
		Generation: upload.Generation, Offset: upload.Offset, SizeBytes: int64(len(content)), SourceName: upload.SourceName,
		MediaType: upload.MediaType, AdapterID: upload.AdapterID, AdapterVersion: upload.AdapterVersion,
		CapturedAt: capturedAt.UTC(), ClientRedacted: upload.ClientRedacted, Final: upload.Final,
		SHA256: providedDigest, StorageKey: "sha256/" + providedDigest[:2] + "/" + providedDigest,
	}, content, nil
}

func summarize(object ObjectRecord) ObjectSummary {
	return ObjectSummary{
		ObjectID: object.ObjectID, ProjectID: object.ProjectID, SessionID: object.SessionID,
		SourceName: object.SourceName, MediaType: object.MediaType, AdapterID: object.AdapterID,
		AdapterVersion: object.AdapterVersion, CapturedAt: object.CapturedAt.Format(time.RFC3339),
		ClientRedacted: object.ClientRedacted, CurrentGeneration: object.CurrentGeneration,
		GenerationCount: object.GenerationCount, CurrentSizeBytes: object.CurrentSizeBytes,
		CurrentFinalized: object.CurrentFinalized,
	}
}

func digest(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

type pageCursor struct {
	ObjectID   string `json:"o"`
	Generation int64  `json:"g"`
	Ordinal    int64  `json:"n"`
}

func encodeCursor(objectID string, generation int64, ordinal int64) string {
	encoded, _ := json.Marshal(pageCursor{ObjectID: objectID, Generation: generation, Ordinal: ordinal})
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func decodeCursor(value string, objectID string, generation int64) (int64, int64, error) {
	if value == "" {
		return 0, generation, nil
	}
	encoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, 0, &ValidationError{Field: "cursor", Reason: "is invalid"}
	}
	var cursor pageCursor
	if err := json.Unmarshal(encoded, &cursor); err != nil || cursor.Ordinal < 1 || cursor.ObjectID != objectID {
		return 0, 0, &ValidationError{Field: "cursor", Reason: "is invalid for this Raw object"}
	}
	if generation != 0 && cursor.Generation != generation {
		return 0, 0, &ValidationError{Field: "cursor", Reason: "is invalid for this generation"}
	}
	return cursor.Ordinal, cursor.Generation, nil
}

type ValidationError struct {
	Field  string
	Reason string
}

func (e *ValidationError) Error() string { return e.Field + " " + e.Reason }

type ConflictError struct {
	Identity string
	Reason   string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("Raw identity %q conflicts: %s", e.Identity, e.Reason)
}

type NotFoundError struct {
	Resource string
	ID       string
}

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("Raw %s %q was not found", e.Resource, e.ID)
}

type UnavailableError struct{ Operation string }

func (e *UnavailableError) Error() string { return "Raw archive is unavailable for " + e.Operation }

type IntegrityError struct {
	ObjectID string
	ChunkID  string
}

func (e *IntegrityError) Error() string {
	return "Raw chunk integrity check failed for " + strconv.Quote(e.ObjectID+"/"+e.ChunkID)
}
