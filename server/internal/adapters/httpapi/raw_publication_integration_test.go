package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/adapters/rawchunks"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/team"
	"github.com/jackc/pgx/v5/pgxpool"
)

func assertHTTPPublicationRaw(t *testing.T, h *Handler, modules Modules, pool *pgxpool.Pool, projectID, credential string, cookie *http.Cookie, csrf, oldHead, currentHead, unactivated string, batch ingestion.Batch) rawarchive.ChunkIdentity {
	t.Helper()
	send := func(handler *Handler, method, path string, value any, web bool, want int) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if web {
			addWebProof(r, cookie, csrf)
		} else {
			r.Header.Set("Authorization", "Bearer "+credential)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s: %d want %d: %s", method, path, w.Code, want, w.Body.String())
		}
		return w
	}
	setUser := func(value string) {
		send(h, "PUT", "/api/v1/users/me/raw-capture", map[string]string{"preference": value}, true, 200)
	}
	setTeam := func(value string) {
		send(h, "PUT", "/api/v1/teams/acme/raw-capture", map[string]string{"policy": value}, true, 200)
	}
	settings := func() team.RawCaptureSettings {
		t.Helper()
		r := httptest.NewRequest("GET", "/api/v1/projects/"+projectID+"/raw-capture", nil)
		r.Header.Set("Authorization", "Bearer "+credential)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var value team.RawCaptureSettings
		decodeResponse(t, w, &value)
		if value.Authority == nil {
			t.Fatal("missing Raw publication authority")
		}
		return value
	}
	setUser("enable")
	defer setUser("disable")
	defer setTeam("personal")
	initial := settings()
	if !initial.Enabled {
		t.Fatal("personal enable did not allow capture")
	}
	setUser("enable")
	if *settings().Authority != *initial.Authority {
		t.Fatal("identical preference changed authority")
	}
	upload := func(object, chunk, content string, offset int64, final bool, proof *rawarchive.PublicationProof) rawarchive.UploadChunk {
		sum := sha256.Sum256([]byte(content))
		return rawarchive.UploadChunk{ProtocolVersion: rawarchive.ProtocolVersion, SourceChunkID: chunk, SourceObjectID: object,
			SessionID: proofSession(t, pool, oldHead), InstallationID: batch.Source.InstallationID, AdapterID: batch.Source.AdapterID, AdapterVersion: batch.Source.AdapterVersion,
			Generation: 1, Offset: offset, SourceName: "observed-rows.jsonl", MediaType: "application/x-ndjson", CapturedAt: batch.ObservedAt,
			ClientRedacted: true, Final: final, ContentBase64: base64.StdEncoding.EncodeToString([]byte(content)), SHA256: hex.EncodeToString(sum[:]), Publication: proof}
	}
	proof := &rawarchive.PublicationProof{Head: oldHead, Authority: *initial.Authority}
	first := upload("publication-rows", "first", "A\n", 0, false, proof)
	first.CapturedAt = "2026-09-10T00:00:00.123456Z"
	identity := rawarchive.ChunkIdentity{SessionID: first.SessionID, InstallationID: first.InstallationID, AdapterID: first.AdapterID, SourceObjectID: first.SourceObjectID, SourceChunkID: first.SourceChunkID}
	const appendPath = "/api/v1/ingestion/raw/chunks"
	const lookupPath = "/api/v1/ingestion/raw/receipts/lookup"

	missingProof := first
	missingProof.Publication = nil
	send(h, "POST", appendPath, missingProof, false, 422)
	notActivated := first
	notActivated.Publication = &rawarchive.PublicationProof{Head: unactivated, Authority: *initial.Authority}
	send(h, "POST", appendPath, notActivated, false, 422)
	foreign := first
	foreign.InstallationID = "foreign-installation"
	send(h, "POST", appendPath, foreign, false, 404)
	foreign = first
	foreign.AdapterID = "foreign-adapter"
	send(h, "POST", appendPath, foreign, false, 404)
	stale := first
	stale.Publication = &rawarchive.PublicationProof{Head: oldHead, Authority: *initial.Authority}
	stale.Publication.Authority.TeamRevision++
	assertProblemEnvelope(t, send(h, "POST", appendPath, stale, false, 409), "raw_authority_changed")
	wrongGeneration := first
	wrongGeneration.Generation = 2
	send(h, "POST", appendPath, wrongGeneration, false, 422)
	tooPrecise := first
	tooPrecise.CapturedAt = "2026-09-10T00:00:00.123456789Z"
	send(h, "POST", appendPath, tooPrecise, false, 422)
	send(h, "POST", lookupPath, identity, false, 404)
	send(h, "POST", lookupPath, identity, true, 401)

	var accepted rawarchive.AppendResult
	decodeResponse(t, send(h, "POST", appendPath, first, false, 201), &accepted)
	if accepted.Receipt == nil || accepted.Receipt.SizeBytes != 2 || accepted.Receipt.Publication.Head != oldHead {
		t.Fatal("missing immutable chunk proof")
	}
	second := upload(first.SourceObjectID, "second", "B\n", 2, true, proof)
	send(h, "POST", appendPath, second, false, 201)
	var replay rawarchive.AppendResult
	decodeResponse(t, send(h, "POST", appendPath, first, false, 200), &replay)
	if replay.SizeBytes != 4 || !reflect.DeepEqual(replay.Receipt, accepted.Receipt) {
		t.Fatal("replay receipt changed with generation size")
	}
	var recovered rawarchive.ChunkReceipt
	decodeResponse(t, send(h, "POST", lookupPath, identity, false, 200), &recovered)
	if !reflect.DeepEqual(recovered, *accepted.Receipt) {
		t.Fatal("lookup did not recover actual immutable receipt")
	}
	rebound := first
	rebound.Publication = &rawarchive.PublicationProof{Head: currentHead, Authority: *initial.Authority}
	send(h, "POST", appendPath, rebound, false, 409)

	setUser("disable")
	decodeResponse(t, send(h, "POST", lookupPath, identity, false, 200), &recovered)
	if !reflect.DeepEqual(recovered, *accepted.Receipt) {
		t.Fatal("policy hid accepted proof")
	}
	send(h, "POST", appendPath, upload("disabled", "disabled", "C\n", 0, true, proof), false, 403)
	setUser("enable")
	assertProblemEnvelope(t, send(h, "POST", appendPath, upload("stale", "stale", "C\n", 0, true, proof), false, 409), "raw_authority_changed")
	freshProof := &rawarchive.PublicationProof{Head: oldHead, Authority: *settings().Authority}
	send(h, "POST", appendPath, upload("fresh-observation", "fresh", "fresh C\n", 0, true, freshProof), false, 201)
	rebound.Publication = freshProof
	send(h, "POST", appendPath, rebound, false, 409)

	// Receipt-only recovery also works with the real unavailable blob Adapter.
	metadataModules := modules
	metadataModules.Raw = rawarchive.NewArchive(postgresadapter.NewStore(pool), rawchunks.NewUnavailable())
	metadataHandler, err := NewHandler(Config{InstanceOrigin: "https://web.example.test", WebOrigin: "https://web.example.test", APIOrigin: "https://api.example.test", CookieDomain: "example.test"}, metadataModules)
	if err != nil {
		t.Fatal(err)
	}
	send(metadataHandler, "POST", lookupPath, identity, false, 200)

	// Off/on between the byte write and commit must be caught even when the
	// effective policy is enabled again by the time the transaction starts.
	chunks, err := rawchunks.NewFilesystem(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	raceModules := modules
	raceModules.Raw = rawarchive.NewArchive(postgresadapter.NewStore(pool), rawPolicyChangeChunks{ChunkStore: chunks, change: func() { setUser("disable"); setUser("enable") }})
	raceHandler, err := NewHandler(Config{InstanceOrigin: "https://web.example.test", WebOrigin: "https://web.example.test", APIOrigin: "https://api.example.test", CookieDomain: "example.test"}, raceModules)
	if err != nil {
		t.Fatal(err)
	}
	raceUpload := upload("policy-race", "policy-race", "race\n", 0, true, freshProof)
	assertProblemEnvelope(t, send(raceHandler, "POST", appendPath, raceUpload, false, 409), "raw_authority_changed")
	raceIdentity := identity
	raceIdentity.SourceObjectID = raceUpload.SourceObjectID
	raceIdentity.SourceChunkID = raceUpload.SourceChunkID
	send(h, "POST", lookupPath, raceIdentity, false, 404)

	setTeam("force")
	forced := settings()
	if forced.Authority.UserRevision != 0 {
		t.Fatal("forced capture used personal authority")
	}
	setUser("disable")
	setUser("enable")
	setTeam("force")
	if *settings().Authority != *forced.Authority {
		t.Fatal("ignored personal preference or identical Team policy changed forced authority")
	}
	forceProof := &rawarchive.PublicationProof{Head: oldHead, Authority: *forced.Authority}
	send(h, "POST", appendPath, upload("forced", "forced", "forced\n", 0, true, forceProof), false, 201)
	setTeam("close")
	setTeam("force")
	assertProblemEnvelope(t, send(h, "POST", appendPath, upload("old-force", "old-force", "old force\n", 0, true, forceProof), false, 409), "raw_authority_changed")
	return identity
}

func proofSession(t *testing.T, pool *pgxpool.Pool, head string) string {
	t.Helper()
	var sessionID string
	if err := pool.QueryRow(t.Context(), "SELECT session_id FROM canonical_publication_attempts WHERE id=$1", head).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	return sessionID
}

type rawPolicyChangeChunks struct {
	rawarchive.ChunkStore
	change func()
}

func (s rawPolicyChangeChunks) Put(ctx context.Context, key string, bytes []byte) error {
	if err := s.ChunkStore.Put(ctx, key, bytes); err != nil {
		return err
	}
	s.change()
	return nil
}
