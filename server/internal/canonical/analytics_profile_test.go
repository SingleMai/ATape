package canonical_test

import (
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

func TestAnalyticsMetadataRetainsClockProfileWithoutSourcePayloads(t *testing.T) {
	original := canonical.EventRecord{ID: "event", SessionID: "session", ThreadID: "root", SchemaVersion: "atape.acp-centered.v3",
		OccurredAt: time.Unix(10, 123), Text: "private message", RawRef: `{"source":"private"}`, AdapterVersion: "transport", Digest: "receipt",
		ToolUpdateJSON: `{"sessionUpdate":"tool_call","toolCallId":"call","title":"Tool","rawInput":"private input","rawOutput":"private output"}`}
	event, err := canonical.AnalyticsEvent(original)
	if err != nil {
		t.Fatal(err)
	}
	if event.SchemaVersion != original.SchemaVersion || !event.OccurredAt.Equal(original.OccurredAt) || event.Text != "" || event.RawRef != "" || event.AdapterVersion != "" || event.Digest != "" || strings.Contains(event.ToolUpdateJSON, "private") {
		t.Fatalf("metadata: %+v", event)
	}
	snapshot := canonical.AnalyticsSnapshot{Session: canonical.SessionRecord{ID: "session"}, Events: []canonical.EventRecord{event}}
	bodies := map[string]canonical.EventBodyDigest{"event": canonical.AnalyticsBodyDigest(original)}
	before := canonical.AnalyticsSnapshotToken(snapshot, bodies)
	snapshot.Events[0].SchemaVersion = "atape.acp-centered.v2"
	if after := canonical.AnalyticsSnapshotToken(snapshot, bodies); after == before {
		t.Fatal("profile-only change did not invalidate current source token")
	}
	snapshot.Head = "head"
	if token := canonical.AnalyticsSnapshotToken(snapshot, bodies); token != "publication:head" {
		t.Fatalf("publication binding: %q", token)
	}
}
