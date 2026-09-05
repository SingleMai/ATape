// Package memoryraw provides the local development Raw Manifest and Chunk
// Adapters. It is intentionally not used as a production durability fallback.
package memoryraw

import (
	"bytes"
	"context"
	"sort"
	"sync"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/authorization"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
)

type generationState struct {
	record rawarchive.GenerationRecord
	chunks []rawarchive.ChunkRecord
}

type objectState struct {
	record      rawarchive.ObjectRecord
	generations map[int64]*generationState
}

type Store struct {
	mu         sync.RWMutex
	objects    map[string]*objectState
	chunks     map[string][]byte
	chunkIDs   map[string]rawarchive.ChunkRecord
	access     SessionAccess
	authorizer authorization.Policy
}

// SessionAccess resolves current Canonical and Membership facts without
// copying either into the Raw Manifest Adapter.
type SessionAccess interface {
	CurrentSessionAccess(
		context.Context,
		authentication.Principal,
		string,
	) (authorization.SessionAccessFacts, bool, error)
}

func New(access SessionAccess) *Store {
	return &Store{
		objects: make(map[string]*objectState), chunks: make(map[string][]byte),
		chunkIDs: make(map[string]rawarchive.ChunkRecord), access: access,
	}
}

func (s *Store) Put(ctx context.Context, key string, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.chunks[key]; ok {
		if !bytes.Equal(existing, content) {
			return &rawarchive.ConflictError{Identity: key, Reason: "immutable storage key has different bytes"}
		}
		return nil
	}
	s.chunks[key] = bytes.Clone(content)
	return nil
}

func (s *Store) Read(ctx context.Context, key string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	content, ok := s.chunks[key]
	if !ok {
		return nil, &rawarchive.NotFoundError{Resource: "chunk", ID: key}
	}
	return bytes.Clone(content), nil
}

func (s *Store) AuthorizeChunk(
	ctx context.Context,
	principal authentication.Principal,
	chunk rawarchive.ChunkRecord,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	access, err := s.authorizeSession(ctx, principal, chunk.SessionID, authorization.RawIngest)
	if err != nil {
		return err
	}
	if access.ProjectState != "active" {
		return &rawarchive.ProjectStateError{State: access.ProjectState}
	}
	return nil
}

func (s *Store) CommitChunk(
	ctx context.Context,
	principal authentication.Principal,
	chunk rawarchive.ChunkRecord,
) (rawarchive.CommitResult, error) {
	if err := ctx.Err(); err != nil {
		return rawarchive.CommitResult{}, err
	}
	access, err := s.authorizeSession(ctx, principal, chunk.SessionID, authorization.RawIngest)
	if err != nil {
		return rawarchive.CommitResult{}, err
	}
	if access.ProjectState != "active" {
		return rawarchive.CommitResult{}, &rawarchive.ProjectStateError{State: access.ProjectState}
	}
	chunk.ProjectID = access.ProjectID
	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.chunkIDs[chunk.ChunkID]; ok {
		if !sameChunk(existing, chunk) {
			return rawarchive.CommitResult{}, &rawarchive.ConflictError{
				Identity: chunk.ChunkID, Reason: "chunkId was reused with different content or metadata",
			}
		}
		state := s.objects[existing.ObjectID]
		return rawarchive.CommitResult{
			Object: state.record, Generation: state.generations[existing.Generation].record, Replayed: true,
		}, nil
	}

	state, exists := s.objects[chunk.ObjectID]
	if !exists {
		if chunk.Generation != 1 || chunk.Offset != 0 {
			return rawarchive.CommitResult{}, &rawarchive.ConflictError{
				Identity: chunk.ObjectID, Reason: "a new Raw object must start at generation 1 offset 0",
			}
		}
		state = &objectState{
			record: rawarchive.ObjectRecord{
				ObjectID: chunk.ObjectID, ProjectID: chunk.ProjectID, SessionID: chunk.SessionID,
				SourceName: chunk.SourceName, MediaType: chunk.MediaType, AdapterID: chunk.AdapterID,
				AdapterVersion: chunk.AdapterVersion, CapturedAt: chunk.CapturedAt,
				ClientRedacted: chunk.ClientRedacted, CurrentGeneration: 1, GenerationCount: 1,
			},
			generations: map[int64]*generationState{1: {record: rawarchive.GenerationRecord{Generation: 1}}},
		}
		s.objects[chunk.ObjectID] = state
	} else {
		if !sameObjectIdentity(state.record, chunk) {
			return rawarchive.CommitResult{}, &rawarchive.ConflictError{
				Identity: chunk.ObjectID, Reason: "Raw object project, session, source, media type, and Adapter are immutable",
			}
		}
		switch {
		case chunk.Generation < state.record.CurrentGeneration:
			return rawarchive.CommitResult{}, &rawarchive.ConflictError{Identity: chunk.ObjectID, Reason: "cannot append to an older generation"}
		case chunk.Generation > state.record.CurrentGeneration+1:
			return rawarchive.CommitResult{}, &rawarchive.ConflictError{Identity: chunk.ObjectID, Reason: "cannot skip a generation"}
		case chunk.Generation == state.record.CurrentGeneration+1:
			if chunk.Offset != 0 {
				return rawarchive.CommitResult{}, &rawarchive.ConflictError{Identity: chunk.ObjectID, Reason: "a new generation must start at offset 0"}
			}
			state.record.CurrentGeneration = chunk.Generation
			state.record.GenerationCount++
			state.record.CurrentSizeBytes = 0
			state.record.CurrentFinalized = false
			state.generations[chunk.Generation] = &generationState{record: rawarchive.GenerationRecord{Generation: chunk.Generation}}
		}
	}

	generation := state.generations[chunk.Generation]
	if generation.record.Finalized {
		return rawarchive.CommitResult{}, &rawarchive.ConflictError{Identity: chunk.ObjectID, Reason: "generation is finalized"}
	}
	if chunk.Offset != generation.record.SizeBytes {
		return rawarchive.CommitResult{}, &rawarchive.ConflictError{
			Identity: chunk.ObjectID, Reason: "append offset does not match the generation size",
		}
	}
	chunk.Ordinal = generation.record.ChunkCount + 1
	generation.chunks = append(generation.chunks, chunk)
	generation.record.ChunkCount++
	generation.record.SizeBytes += chunk.SizeBytes
	generation.record.Finalized = chunk.Final
	s.chunkIDs[chunk.ChunkID] = chunk

	state.record.AdapterVersion = chunk.AdapterVersion
	if chunk.CapturedAt.After(state.record.CapturedAt) {
		state.record.CapturedAt = chunk.CapturedAt
	}
	state.record.CurrentSizeBytes = generation.record.SizeBytes
	state.record.CurrentFinalized = generation.record.Finalized

	return rawarchive.CommitResult{Object: state.record, Generation: generation.record}, nil
}

func (s *Store) ListSessionObjects(
	ctx context.Context,
	principal authentication.Principal,
	sessionID string,
) ([]rawarchive.ObjectRecord, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := s.authorizeSession(ctx, principal, sessionID, authorization.RawSessionList); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	objects := make([]rawarchive.ObjectRecord, 0)
	for _, state := range s.objects {
		if state.record.SessionID == sessionID {
			objects = append(objects, state.record)
		}
	}
	sort.Slice(objects, func(left, right int) bool {
		if !objects[left].CapturedAt.Equal(objects[right].CapturedAt) {
			return objects[left].CapturedAt.After(objects[right].CapturedAt)
		}
		return objects[left].ObjectID < objects[right].ObjectID
	})
	return objects, nil
}

func (s *Store) PlanContent(
	ctx context.Context,
	principal authentication.Principal,
	objectID string,
	generationNumber int64,
	afterOrdinal int64,
	limit int,
) (rawarchive.ContentPlan, error) {
	if err := ctx.Err(); err != nil {
		return rawarchive.ContentPlan{}, err
	}
	s.mu.RLock()
	state, ok := s.objects[objectID]
	if !ok {
		s.mu.RUnlock()
		return rawarchive.ContentPlan{}, &rawarchive.NotFoundError{Resource: "object", ID: objectID}
	}
	sessionID := state.record.SessionID
	s.mu.RUnlock()
	if _, err := s.authorizeSession(ctx, principal, sessionID, authorization.RawObjectRead); err != nil {
		return rawarchive.ContentPlan{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, ok = s.objects[objectID]
	if !ok {
		return rawarchive.ContentPlan{}, &rawarchive.NotFoundError{Resource: "object", ID: objectID}
	}
	if generationNumber == 0 {
		generationNumber = state.record.CurrentGeneration
	}
	generation, ok := state.generations[generationNumber]
	if !ok {
		return rawarchive.ContentPlan{}, &rawarchive.NotFoundError{Resource: "generation", ID: objectID}
	}
	start := sort.Search(len(generation.chunks), func(index int) bool {
		return generation.chunks[index].Ordinal > afterOrdinal
	})
	end := min(start+limit, len(generation.chunks))
	chunks := append([]rawarchive.ChunkRecord(nil), generation.chunks[start:end]...)
	return rawarchive.ContentPlan{
		Object: state.record, Generation: generation.record, Chunks: chunks, HasMore: end < len(generation.chunks),
	}, nil
}

func (s *Store) authorizeSession(
	ctx context.Context,
	principal authentication.Principal,
	sessionID string,
	action authorization.Action,
) (authorization.SessionAccessFacts, error) {
	kind := authorization.ConversationResource
	if action == authorization.RawObjectRead {
		kind = authorization.RawObjectResource
	}
	if s.access == nil {
		return authorization.SessionAccessFacts{}, authorization.Enforce(s.authorizer.Evaluate(authorization.Input{
			Principal: principal, Action: action,
			Resource: authorization.ResourceFacts{Kind: kind},
		}))
	}
	access, ok, err := s.access.CurrentSessionAccess(ctx, principal, sessionID)
	if err != nil {
		return authorization.SessionAccessFacts{}, err
	}
	if !ok || access.ProjectState == "deleted" {
		return authorization.SessionAccessFacts{}, authorization.Enforce(s.authorizer.Evaluate(authorization.Input{
			Principal: principal, Action: action,
			Resource: authorization.ResourceFacts{Kind: kind},
		}))
	}
	resource := access.Resource
	resource.Kind = kind
	return access, authorization.Enforce(s.authorizer.Evaluate(authorization.Input{
		Principal: principal, Action: action,
		Resource: resource, Membership: access.Membership,
	}))
}

func sameObjectIdentity(object rawarchive.ObjectRecord, chunk rawarchive.ChunkRecord) bool {
	return object.ProjectID == chunk.ProjectID && object.SessionID == chunk.SessionID &&
		object.SourceName == chunk.SourceName && object.MediaType == chunk.MediaType && object.AdapterID == chunk.AdapterID &&
		object.ClientRedacted == chunk.ClientRedacted
}

func sameChunk(left rawarchive.ChunkRecord, right rawarchive.ChunkRecord) bool {
	return left.ChunkID == right.ChunkID && left.ObjectID == right.ObjectID && left.ProjectID == right.ProjectID &&
		left.SourceChunkID == right.SourceChunkID && left.SourceObjectID == right.SourceObjectID &&
		left.CapturedByUserID == right.CapturedByUserID && left.InstallationID == right.InstallationID &&
		left.SessionID == right.SessionID && left.Generation == right.Generation && left.Offset == right.Offset &&
		left.SizeBytes == right.SizeBytes && left.SourceName == right.SourceName && left.MediaType == right.MediaType &&
		left.AdapterID == right.AdapterID && left.AdapterVersion == right.AdapterVersion && left.CapturedAt.Equal(right.CapturedAt) &&
		left.ClientRedacted == right.ClientRedacted && left.Final == right.Final && left.SHA256 == right.SHA256 &&
		left.StorageKey == right.StorageKey
}
