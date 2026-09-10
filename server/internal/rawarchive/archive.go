// Package rawarchive preserves bounded, client-redacted source material behind
// a Canonical Session without exposing storage layout to transports or readers.
package rawarchive

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/sourceidentity"
	"github.com/google/uuid"
)

const (
	ProtocolVersion = "atape.raw.v1"
	MaxChunkBytes   = 3 << 20
	DefaultPageSize = 4
	MaxPageSize     = 8
)

type UploadChunk struct {
	ProtocolVersion string            `json:"protocolVersion"`
	SourceChunkID   string            `json:"sourceChunkId"`
	SourceObjectID  string            `json:"sourceObjectId"`
	SessionID       string            `json:"sessionId"`
	InstallationID  string            `json:"installationId"`
	Generation      int64             `json:"generation"`
	Offset          int64             `json:"offset"`
	SourceName      string            `json:"sourceName"`
	MediaType       string            `json:"mediaType"`
	AdapterID       string            `json:"adapterId"`
	AdapterVersion  string            `json:"adapterVersion"`
	CapturedAt      string            `json:"capturedAt"`
	ClientRedacted  bool              `json:"clientRedacted"`
	Final           bool              `json:"final"`
	ContentBase64   string            `json:"contentBase64"`
	SHA256          string            `json:"sha256"`
	Publication     *PublicationProof `json:"publication,omitempty"`
}

type ChunkRecord struct {
	ChunkID          string
	ObjectID         string
	SourceChunkID    string
	SourceObjectID   string
	ProjectID        string
	SessionID        string
	CapturedByUserID string
	InstallationID   string
	Generation       int64
	Ordinal          int64
	Offset           int64
	SizeBytes        int64
	SourceName       string
	MediaType        string
	AdapterID        string
	AdapterVersion   string
	CapturedAt       time.Time
	ClientRedacted   bool
	Final            bool
	SHA256           string
	StorageKey       string
	Publication      *PublicationProof
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
	CreatedAt         time.Time // Immutable first receipt time; used only for manifest ordering.
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
	AuthorizeChunk(context.Context, authentication.Principal, ChunkRecord) error
	CommitChunk(context.Context, authentication.Principal, ChunkRecord) (CommitResult, error)
	ListSessionObjects(context.Context, authentication.Principal, string, ObjectPosition, int) ([]ObjectRecord, error)
	PlanContent(context.Context, authentication.Principal, string, int64, int64, int) (ContentPlan, error)
	LookupChunk(context.Context, authentication.Principal, ChunkIdentity) (*ChunkReceipt, error)
}

// ChunkStore is the immutable byte Seam consumed by Archive. Put must be
// replay-safe for the same key and bytes; Read returns one bounded chunk.
// Check proves that the configured Adapter can currently accept durable
// writes without exposing its storage layout to the application or transport.
type ChunkStore interface {
	Check(context.Context) error
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

// CheckStorage is the narrow operational health surface of Raw Archive. The
// concrete Adapter owns the probe because only it can prove its durability
// preconditions without leaking implementation details through this Module.
func (a *Archive) CheckStorage(ctx context.Context) error {
	return a.chunks.Check(ctx)
}

type AppendResult struct {
	ObjectID   string        `json:"objectId"`
	Generation int64         `json:"generation"`
	SizeBytes  int64         `json:"sizeBytes"`
	Finalized  bool          `json:"finalized"`
	Replayed   bool          `json:"replayed"`
	Receipt    *ChunkReceipt `json:"receipt,omitempty"`
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
	SessionID  string          `json:"sessionId"`
	Objects    []ObjectSummary `json:"objects"`
	NextCursor string          `json:"nextCursor,omitempty"`
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

func (a *Archive) Append(
	ctx context.Context,
	principal authentication.Principal,
	upload UploadChunk,
) (AppendResult, error) {
	record, content, err := validateUpload(principal, upload)
	if err != nil {
		return AppendResult{}, err
	}
	if err := a.manifests.AuthorizeChunk(ctx, principal, record); err != nil {
		return AppendResult{}, concealedAsNotFound(err, "session", upload.SessionID)
	}
	if err := a.chunks.Put(ctx, record.StorageKey, content); err != nil {
		return AppendResult{}, err
	}
	committed, err := a.manifests.CommitChunk(ctx, principal, record)
	if err != nil {
		return AppendResult{}, concealedAsNotFound(err, "session", upload.SessionID)
	}
	result := AppendResult{
		ObjectID:   committed.Object.ObjectID,
		Generation: committed.Generation.Generation,
		SizeBytes:  committed.Generation.SizeBytes,
		Finalized:  committed.Generation.Finalized,
		Replayed:   committed.Replayed,
	}
	if record.Publication != nil {
		receipt := ReceiptForChunk(record)
		result.Receipt = &receipt
	}
	return result, nil
}

type PublicationProof struct {
	Head      string    `json:"head"`
	Authority Authority `json:"authority"`
}

type ChunkIdentity struct {
	SessionID      string `json:"sessionId"`
	InstallationID string `json:"installationId"`
	AdapterID      string `json:"adapterId"`
	SourceObjectID string `json:"sourceObjectId"`
	SourceChunkID  string `json:"sourceChunkId"`
}

// ChunkReceipt describes one immutable accepted write, never the current size
// of a generation that other chunks may have advanced since the original ACK.
type ChunkReceipt struct {
	ChunkIdentity
	ProtocolVersion string            `json:"protocolVersion"`
	SourceName      string            `json:"sourceName"`
	MediaType       string            `json:"mediaType"`
	AdapterVersion  string            `json:"adapterVersion"`
	CapturedAt      string            `json:"capturedAt"`
	ClientRedacted  bool              `json:"clientRedacted"`
	ObjectID        string            `json:"objectId"`
	Generation      int64             `json:"generation"`
	Offset          int64             `json:"offset"`
	SizeBytes       int64             `json:"sizeBytes"`
	SHA256          string            `json:"sha256"`
	Final           bool              `json:"final"`
	Publication     *PublicationProof `json:"publication,omitempty"`
}

func ReceiptForChunk(record ChunkRecord) ChunkReceipt {
	return ChunkReceipt{ChunkIdentity: ChunkIdentity{SessionID: record.SessionID, InstallationID: record.InstallationID,
		AdapterID: record.AdapterID, SourceObjectID: record.SourceObjectID, SourceChunkID: record.SourceChunkID},
		ProtocolVersion: ProtocolVersion, SourceName: record.SourceName, MediaType: record.MediaType, AdapterVersion: record.AdapterVersion,
		CapturedAt: record.CapturedAt.UTC().Format(time.RFC3339Nano), ClientRedacted: record.ClientRedacted,
		ObjectID: record.ObjectID, Generation: record.Generation, Offset: record.Offset, SizeBytes: record.SizeBytes,
		SHA256: record.SHA256, Final: record.Final, Publication: record.Publication}
}

// Receipt recovers accepted metadata without a blob read or new upload grant.
// A nil receipt with no error means authorized absence; concealed access is an error.
// Current source ownership/access is still checked by the manifest transaction.
func (a *Archive) Receipt(ctx context.Context, principal authentication.Principal, identity ChunkIdentity) (*ChunkReceipt, error) {
	for _, value := range []string{identity.SessionID, identity.InstallationID, identity.AdapterID, identity.SourceObjectID, identity.SourceChunkID} {
		if strings.TrimSpace(value) == "" || len(value) > 512 || strings.ContainsRune(value, 0) {
			return nil, &ValidationError{Field: "chunkIdentity", Reason: "requires bounded nonempty source identity"}
		}
	}
	receipt, err := a.manifests.LookupChunk(ctx, principal, identity)
	return receipt, concealedAsNotFound(err, "chunk", identity.SourceChunkID)
}

func (a *Archive) OpenSession(
	ctx context.Context,
	principal authentication.Principal,
	sessionID string,
) (SessionArchive, error) {
	page, err := a.OpenSessionPage(ctx, principal, sessionID, "", MaxManifestPageSize)
	if err == nil && page.NextCursor != "" {
		return SessionArchive{}, &PaginationRequiredError{}
	}
	return page, err
}

func (a *Archive) Read(
	ctx context.Context,
	principal authentication.Principal,
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
	plan, err := a.manifests.PlanContent(ctx, principal, objectID, generation, afterOrdinal, limit)
	if err != nil {
		return ContentPage{}, concealedAsNotFound(err, "object", objectID)
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

func concealedAsNotFound(err error, resource, id string) error {
	var access *authorization.AccessError
	if errors.As(err, &access) && access.Decision == authorization.Conceal {
		return &NotFoundError{Resource: resource, ID: id}
	}
	return err
}

func validateUpload(principal authentication.Principal, upload UploadChunk) (ChunkRecord, []byte, error) {
	if proof := upload.Publication; proof != nil {
		id, err := uuid.Parse(proof.Head)
		if err != nil || id.String() != proof.Head || id == uuid.Nil || proof.Authority.Protocol != PublicationProtocol ||
			proof.Authority.TeamRevision < 1 || proof.Authority.UserRevision < 0 || upload.Generation != 1 {
			return ChunkRecord{}, nil, &ValidationError{Field: "publication", Reason: "requires a canonical activation identity, Raw authority and one immutable generation"}
		}
	}
	required := []struct {
		field string
		value string
	}{
		{"sourceChunkId", upload.SourceChunkID}, {"sourceObjectId", upload.SourceObjectID},
		{"sessionId", upload.SessionID}, {"installationId", upload.InstallationID},
		{"sourceName", upload.SourceName}, {"mediaType", upload.MediaType},
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
		return ChunkRecord{}, nil, &ValidationError{Field: "contentBase64", Reason: "decoded chunk exceeds 3 MiB"}
	}
	content, err := base64.StdEncoding.Strict().DecodeString(upload.ContentBase64)
	if err != nil {
		return ChunkRecord{}, nil, &ValidationError{Field: "contentBase64", Reason: "must be canonical Base64"}
	}
	if len(content) > MaxChunkBytes {
		return ChunkRecord{}, nil, &ValidationError{Field: "contentBase64", Reason: "decoded chunk exceeds 3 MiB"}
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
	if upload.Publication != nil && capturedAt.Nanosecond()%1000 != 0 {
		return ChunkRecord{}, nil, &ValidationError{Field: "capturedAt", Reason: "publication receipt timestamps require microsecond precision or coarser"}
	}
	objectID := sourceidentity.RawObjectID(
		principal.UserID, upload.SessionID, upload.InstallationID,
		upload.AdapterID, upload.SourceObjectID,
	)
	return ChunkRecord{
		ChunkID: sourceidentity.RawChunkID(objectID, upload.SourceChunkID), ObjectID: objectID,
		SourceChunkID: upload.SourceChunkID, SourceObjectID: upload.SourceObjectID,
		SessionID: upload.SessionID, CapturedByUserID: principal.UserID, InstallationID: upload.InstallationID,
		Generation: upload.Generation, Offset: upload.Offset, SizeBytes: int64(len(content)), SourceName: upload.SourceName,
		MediaType: upload.MediaType, AdapterID: upload.AdapterID, AdapterVersion: upload.AdapterVersion,
		CapturedAt: capturedAt.UTC(), ClientRedacted: upload.ClientRedacted, Final: upload.Final,
		SHA256: providedDigest, StorageKey: "sha256/" + providedDigest[:2] + "/" + providedDigest, Publication: upload.Publication,
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

type ProjectStateError struct{ State string }

func (e *ProjectStateError) Error() string {
	return "Raw ingestion is unavailable while the Project is " + strconv.Quote(e.State)
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
