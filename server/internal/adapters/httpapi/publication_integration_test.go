package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/publication"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Runs against the authenticated HTTP fixture's real PostgreSQL, CLI credential
// and Web session. No publication operation is replaced by a mock.
func assertHTTPPublicationContract(t *testing.T, h *Handler, pool *pgxpool.Pool, projectID, userID, credential string, cookie *http.Cookie) {
	t.Helper()
	send := func(method, path string, body []byte, web bool, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		if body != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		if web {
			r.AddCookie(cookie)
		} else {
			r.Header.Set("Authorization", "Bearer "+credential)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s: %d want %d: %s", method, path, w.Code, want, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" && !strings.HasSuffix(path, "/instance") {
			t.Fatalf("publication response cache policy: %s", w.Header().Get("Cache-Control"))
		}
		return w
	}
	encode := func(value any) []byte {
		t.Helper()
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	const prefix = "/api/v1/publications/"
	caps := send("GET", prefix+"capabilities", nil, false, 200)
	if !strings.Contains(caps.Body.String(), `"partBytes":4194304`) || !strings.Contains(caps.Body.String(), `"leaseLifetimeMs":60000`) {
		t.Fatal(caps.Body.String())
	}
	send("GET", prefix+"capabilities", nil, true, 401)
	send("GET", prefix+"capabilities?unexpected=1", nil, false, 400)
	instance := send("GET", "/api/v1/instance", nil, false, 200)
	if !strings.Contains(instance.Body.String(), publication.Protocol) {
		t.Fatal("missing publication discovery")
	}

	batch := canonicalcontract.ValidBatch()
	batch.ProjectID = projectID
	batch.Session.SourceSessionID = "http-publication"
	original := batch.Events[0]
	batch.Events = nil
	for n := 0; n < 101; n++ {
		event := original
		event.SourceEventID = fmt.Sprintf("page-%03d", n)
		event.SourceOrder = int64(n)
		event.Text = fmt.Sprintf("Published event %03d", n)
		batch.Events = append(batch.Events, event)
	}
	// Interleaved part contents are legal; reading must restore source order.
	ordered := batch.Events
	batch.Events = nil
	for n := 0; n < 100; n += 2 {
		batch.Events = append(batch.Events, ordered[n])
	}
	for n := 1; n < 100; n += 2 {
		batch.Events = append(batch.Events, ordered[n])
	}
	batch.Events = append(batch.Events, ordered[100])
	batch.Session.ReportedEventCount = len(batch.Events)
	partSize := 50
	stage := func(b ingestion.Batch, base string) publication.Attempt {
		t.Helper()
		var reservation publication.Reservation
		decodeResponse(t, send("POST", prefix+"reservations", encode(publication.Scope{ProjectID: projectID, InstallationID: b.Source.InstallationID, AdapterID: b.Source.AdapterID, SourceSessionID: b.Session.SourceSessionID, OriginKey: "http-origin"}), false, 200), &reservation)
		var attempt publication.Attempt
		input := encode(publication.Begin{ReservationID: reservation.ID, CaptureID: reservation.ID, BaseHead: base, TransformVersion: "http-v1"})
		decodeResponse(t, send("POST", prefix+"attempts", input, false, 200), &attempt)
		replay := send("POST", prefix+"attempts", input, false, 200)
		var repeated publication.Attempt
		decodeResponse(t, replay, &repeated)
		if repeated.ID != attempt.ID || repeated.LeaseUntil != attempt.LeaseUntil {
			t.Fatal("Begin replay changed authority")
		}
		send("POST", prefix+"attempts/"+attempt.ID+"/activate", nil, false, 400)
		hasher := publication.NewManifestHasher()
		parts := 0
		for offset := 0; offset < len(b.Events) || parts == 0; offset += partSize {
			partBatch := b
			partBatch.Events = b.Events[offset:min(offset+partSize, len(b.Events))]
			body := append([]byte(" \n"), encode(publication.CanonicalPart{Target: publication.Target{Profile: publication.TargetProfile, Events: len(b.Events), Usage: len(b.Usage), Threads: len(b.Threads)}, Batch: partBatch})...)
			body = append(body, '\n')
			sum := sha256.Sum256(body)
			digest := hex.EncodeToString(sum[:])
			path := fmt.Sprintf("%sattempts/%s/parts/%d?sha256=%s", prefix, attempt.ID, parts, digest)
			send("PUT", path, body, true, 401)
			send("PUT", path, bytes.Repeat([]byte("x"), (4<<20)+1), false, 413)
			var part publication.Part
			decodeResponse(t, send("PUT", path, body, false, 200), &part)
			if part.Bytes != int64(len(body)) || part.SHA256 != digest {
				t.Fatal("transport rewrote frozen bytes")
			}
			send("PUT", path, body, false, 200)
			send("PUT", path, append(body, ' '), false, 400)
			hasher.Add(part)
			parts++
		}
		send("GET", prefix+"attempts/"+attempt.ID+"?limit=1&limit=2", nil, false, 400)
		send("GET", prefix+"attempts/"+attempt.ID+"?after=broken", nil, false, 400)
		var status publication.Page
		decodeResponse(t, send("GET", prefix+"attempts/"+attempt.ID+"?limit=1", nil, false, 200), &status)
		if len(status.Parts) != 1 || status.Parts[0].Ordinal != 0 {
			t.Fatal("unbounded recovery page")
		}
		if parts > 1 {
			decodeResponse(t, send("GET", prefix+"attempts/"+attempt.ID+"?after=0&limit=1", nil, false, 200), &status)
			if status.Parts[0].Ordinal != 1 {
				t.Fatal("recovery skipped a part")
			}
		}
		send("POST", prefix+"attempts/"+attempt.ID+"/renew", nil, false, 200)
		send("POST", prefix+"attempts/"+attempt.ID+"/seal", encode(hasher.Manifest()), false, 200)
		for part := 0; part < parts; part++ {
			decodeResponse(t, send("POST", prefix+"attempts/"+attempt.ID+"/validate", nil, false, 200), &attempt)
			if attempt.ValidatedParts != part+1 {
				t.Fatalf("Validate did not bound work to one part: %+v", attempt)
			}
		}
		if attempt.State != "validated" {
			t.Fatal(attempt.State)
		}
		return attempt
	}
	attempt := stage(batch, "")
	activatePath := prefix + "attempts/" + attempt.ID + "/activate"
	firstResponse := send("POST", activatePath, nil, false, 200).Body.String()
	// Model a lost first activation response: recovery can use only a later status.
	var recovered publication.Page
	decodeResponse(t, send("GET", prefix+"attempts/"+attempt.ID, nil, false, 200), &recovered)
	if recovered.Attempt.Activation == nil || recovered.Attempt.Activation.Head != attempt.ID {
		t.Fatal("status omitted activation proof")
	}
	pagePath := "/api/v1/sessions/" + attempt.SessionID
	send("GET", pagePath, nil, true, 409)
	var first, second, anchored conversation.Conversation
	decodeResponse(t, send("GET", pagePath+"?limit=100", nil, true, 200), &first)
	if first.Head != attempt.ID || len(first.Events) != 100 || first.NextEventID != first.Events[99].ID {
		t.Fatalf("first page: head %s count %d", first.Head, len(first.Events))
	}
	send("GET", pagePath+"?limit=100&after="+first.NextEventID, nil, true, 400)
	decodeResponse(t, send("GET", pagePath+"?limit=100&head="+first.Head+"&after="+first.NextEventID, nil, true, 200), &second)
	if len(second.Events) != 1 || second.Events[0].Text != "Published event 100" || second.NextEventID != "" {
		t.Fatalf("last page: %+v", second)
	}
	decodeResponse(t, send("GET", pagePath+"?limit=10&at="+second.Events[0].ID, nil, true, 200), &anchored)
	if len(anchored.Events) != 1 || anchored.Events[0].ID != second.Events[0].ID {
		t.Fatal("search anchor omitted its target")
	}

	// Large tool/message content is bounded by bytes, independently of count.
	large := batch
	large.Session.Revision++
	large.Events = nil
	for n := 0; n < 12; n++ {
		event := original
		event.SourceEventID = fmt.Sprintf("large-%d", n)
		event.SourceOrder = int64(n)
		event.Text = fmt.Sprintf("%d:", n) + strings.Repeat("x", 600000)
		large.Events = append(large.Events, event)
	}
	largeOrdered := large.Events
	large.Events = nil
	for n := 0; n < 12; n += 2 {
		large.Events = append(large.Events, largeOrdered[n])
	}
	for n := 1; n < 12; n += 2 {
		large.Events = append(large.Events, largeOrdered[n])
	}
	partSize = 3
	largeAttempt := stage(large, attempt.ID)
	send("POST", prefix+"attempts/"+largeAttempt.ID+"/activate", nil, false, 200)
	largeResponse := send("GET", pagePath+"?limit=100", nil, true, 200)
	var largePage conversation.Conversation
	decodeResponse(t, largeResponse, &largePage)
	if largeResponse.Body.Len() > conversation.MaxPageBytes || len(largePage.Events) == 0 || len(largePage.Events) >= 12 || largePage.NextEventID == "" {
		t.Fatalf("byte-bounded page: %d bytes, %d events", largeResponse.Body.Len(), len(largePage.Events))
	}
	var largeEnd conversation.Conversation
	decodeResponse(t, send("GET", pagePath+"?limit=100&head="+largePage.Head+"&after="+largePage.NextEventID, nil, true, 200), &largeEnd)
	if len(largePage.Events)+len(largeEnd.Events) != 12 {
		t.Fatal("byte boundary skipped events")
	}
	for n, event := range append(largePage.Events, largeEnd.Events...) {
		if !strings.HasPrefix(event.Text, fmt.Sprintf("%d:", n)) {
			t.Fatal("interleaved parts changed read order")
		}
	}
	partSize = 50
	// A complete empty replacement withdraws every old Event. Old receipt retries
	// survive body GC and must not select the old head again.
	batch.Events = nil
	batch.Session.ReportedEventCount = 0
	batch.Session.Revision += 2
	next := stage(batch, largeAttempt.ID)
	send("POST", prefix+"attempts/"+next.ID+"/activate", nil, false, 200)
	stale := send("GET", pagePath+"?limit=100&head="+first.Head+"&after="+first.NextEventID, nil, true, 409)
	assertProblemEnvelope(t, stale, "refresh_required")
	send("POST", prefix+"reclaim?limit=32", nil, false, 200)
	if replay := send("POST", activatePath, nil, false, 200).Body.String(); replay != firstResponse {
		t.Fatalf("changed activation receipt: %s versus %s", replay, firstResponse)
	}
	var current conversation.Conversation
	decodeResponse(t, send("GET", pagePath+"?limit=100", nil, true, 200), &current)
	if current.Head != next.ID || len(current.Events) != 0 {
		t.Fatal("old receipt changed selected head")
	}
	rejected := stage(batch, next.ID)
	rejectPath := prefix + "attempts/" + rejected.ID
	send("POST", rejectPath+"/reject", nil, false, 200)
	var rejection publication.Page
	decodeResponse(t, send("GET", rejectPath, nil, false, 200), &rejection)
	if rejection.Attempt.State != "rejected" || rejection.Attempt.Activation != nil {
		t.Fatal("explicit rejection fabricated activation proof")
	}
	assertProblemEnvelope(t, send("POST", rejectPath+"/renew", nil, false, 409), "publication_conflict")
	send("POST", prefix+"reclaim?limit=32", nil, false, 200)
	unknown := send("GET", prefix+"attempts/00000000-0000-4000-8000-000000000000", nil, false, 404)
	assertProblemEnvelope(t, unknown, "publication_unknown")

	// Recovery reauthorizes current membership, including historical success proof.
	if _, err := pool.Exec(t.Context(), "UPDATE team_memberships SET status='removed',removed_at=clock_timestamp() WHERE user_id=$1", userID); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(t.Context(), "UPDATE team_memberships SET status='active',removed_at=NULL WHERE user_id=$1", userID); err != nil {
			t.Fatal(err)
		}
	}()
	send("POST", activatePath, nil, false, 404)
	send("GET", pagePath+"?limit=100&head="+first.Head, nil, true, 404)
}
