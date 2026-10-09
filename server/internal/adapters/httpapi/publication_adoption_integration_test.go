package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
)

func assertHTTPLegacyPublicationAdoption(t *testing.T, h *Handler, projectID, credential string, cookie *http.Cookie, csrf string) {
	t.Helper()
	send := func(method, path string, value any, web bool, want int) *httptest.ResponseRecorder {
		t.Helper()
		var body []byte
		if value != nil {
			var err error
			body, err = json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
		}
		request := httptest.NewRequest(method, path, bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if web {
			addWebProof(request, cookie, csrf)
		} else {
			request.Header.Set("Authorization", "Bearer "+credential)
		}
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("%s %s: %d want %d %s", method, path, response.Code, want, response.Body.String())
		}
		return response
	}
	legacy := canonicalcontract.ValidBatch()
	legacy.ProjectID = projectID
	legacy.BatchID = "http-legacy-adoption-seed"
	legacy.Session.SourceSessionID = "http-legacy-adoption"
	legacy.Session.Revision = 7
	legacy.Threads[0].Revision = 9
	legacy.Events[0].ProjectionRevision = 11
	var applied canonical.ApplyResult
	decodeResponse(t, send("POST", "/api/v1/ingestion/canonical/batches", legacy, false, 201), &applied)
	send("PUT", "/api/v1/users/me/raw-capture", map[string]string{"preference": "enable"}, true, 200)
	defer send("PUT", "/api/v1/users/me/raw-capture", map[string]string{"preference": "disable"}, true, 200)
	content := []byte("{\"old\":\"retained native physical history\"}\n")
	sum := sha256.Sum256(content)
	upload := rawarchive.UploadChunk{ProtocolVersion: rawarchive.ProtocolVersion, SessionID: applied.SessionID, InstallationID: legacy.Source.InstallationID, AdapterID: legacy.Source.AdapterID, AdapterVersion: legacy.Source.AdapterVersion, SourceObjectID: "session-42", SourceChunkID: "legacy-final", Generation: 1, SourceName: "legacy.jsonl", MediaType: "application/x-ndjson", CapturedAt: legacy.ObservedAt, ClientRedacted: true, Final: true, ContentBase64: base64.StdEncoding.EncodeToString(content), SHA256: hex.EncodeToString(sum[:])}
	var appended rawarchive.AppendResult
	decodeResponse(t, send("POST", "/api/v1/ingestion/raw/chunks", upload, false, 201), &appended)
	rawPath := "/api/v1/raw-objects/" + appended.ObjectID + "/content"
	oldRaw := send("GET", rawPath, nil, true, 200).Body.String()
	var oldReader conversation.Conversation
	decodeResponse(t, send("GET", "/api/v1/sessions/"+applied.SessionID, nil, true, 200), &oldReader)
	scope := publication.Scope{ProjectID: projectID, InstallationID: legacy.Source.InstallationID, AdapterID: legacy.Source.AdapterID, SourceSessionID: legacy.Session.SourceSessionID, OriginKey: "native-origin"}
	send("POST", "/api/v1/publications/reservations", scope, false, 409)
	send("POST", "/api/v1/publications/adopt-legacy", scope, true, 401)
	send("POST", "/api/v1/publications/adopt-legacy?unexpected=true", scope, false, 400)
	var adopted publication.Adoption
	decodeResponse(t, send("POST", "/api/v1/publications/adopt-legacy", scope, false, 200), &adopted)
	if adopted.SessionID != applied.SessionID || adopted.RevisionFloor != 11 || !reflect.DeepEqual(adopted.BaselineThreads, legacy.Threads) {
		t.Fatalf("HTTP adoption receipt: %+v", adopted)
	}
	var stagedReader conversation.Conversation
	decodeResponse(t, send("GET", "/api/v1/sessions/"+applied.SessionID, nil, true, 200), &stagedReader)
	if !reflect.DeepEqual(stagedReader, oldReader) {
		t.Fatal("HTTP adoption changed selected legacy Reader")
	}
	if send("GET", rawPath, nil, true, 200).Body.String() != oldRaw {
		t.Fatal("adoption changed old usable Raw link")
	}
	var replay canonical.ApplyResult
	decodeResponse(t, send("POST", "/api/v1/ingestion/canonical/batches", legacy, false, 200), &replay)
	if !replay.Replayed {
		t.Fatal("old HTTP receipt replay was lost")
	}
	changed := legacy
	changed.BatchID = "fenced-http-write"
	send("POST", "/api/v1/ingestion/canonical/batches", changed, false, 409)
	identity := rawarchive.ChunkIdentity{SessionID: applied.SessionID, InstallationID: upload.InstallationID, AdapterID: upload.AdapterID, SourceObjectID: upload.SourceObjectID, SourceChunkID: upload.SourceChunkID}
	var receipt rawarchive.ChunkReceipt
	decodeResponse(t, send("POST", "/api/v1/ingestion/raw/receipts/lookup", identity, false, 200), &receipt)
	if receipt.ObjectID != appended.ObjectID || receipt.Generation != 1 || receipt.SizeBytes != int64(len(content)) || receipt.Publication != nil {
		t.Fatalf("old receipt changed: %+v", receipt)
	}
	// A complete empty selected path still has a stable root header and identity.
	fresh := legacy
	fresh.BatchID = "empty-after-rewind"
	fresh.Session.Revision = 12
	fresh.Threads[0].Revision = 12
	fresh.Session.ReportedEventCount = 0
	fresh.Events = []ingestion.Event{}
	var attempt publication.Attempt
	decodeResponse(t, send("POST", "/api/v1/publications/attempts", publication.Begin{ReservationID: adopted.ID, CaptureID: adopted.ID, TransformVersion: "active-path-v2"}, false, 200), &attempt)
	envelope := publication.CanonicalPart{Target: publication.Target{Profile: publication.RetentionTargetProfile, Threads: 1, RetainedThreadIDs: []string{}}, Batch: fresh}
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	partSum := sha256.Sum256(body)
	request := httptest.NewRequest("PUT", "/api/v1/publications/attempts/"+attempt.ID+"/parts/0?sha256="+hex.EncodeToString(partSum[:]), bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+credential)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var part publication.Part
	decodeResponse(t, response, &part)
	manifest := publication.NewManifestHasher()
	manifest.Add(part)
	path := "/api/v1/publications/attempts/" + attempt.ID
	send("POST", path+"/seal", manifest.Manifest(), false, 200)
	send("POST", path+"/validate", nil, false, 200)
	send("POST", path+"/activate", nil, false, 200)
	var selected conversation.Conversation
	decodeResponse(t, send("GET", "/api/v1/sessions/"+applied.SessionID, nil, true, 200), &selected)
	if selected.Session.ID != oldReader.Session.ID || selected.Head != attempt.ID || len(selected.Events) != 0 {
		t.Fatalf("HTTP empty rewind target: %+v", selected)
	}
	if send("GET", rawPath, nil, true, 200).Body.String() != oldRaw {
		t.Fatal("activation invalidated old Raw object content")
	}
	var recovered rawarchive.ChunkReceipt
	decodeResponse(t, send("POST", "/api/v1/ingestion/raw/receipts/lookup", identity, false, 200), &recovered)
	if !reflect.DeepEqual(recovered, receipt) {
		t.Fatal("activation altered old Raw owner/generation/receipt")
	}
}
