package sourceidentity

import (
	"fmt"
	"regexp"
	"testing"
)

func TestRawObjectIdentityIsStableAndCaptureScoped(t *testing.T) {
	parts := []string{"user-a", "session-a", "installation-a", "adapter-a", "source-a"}
	want := RawObjectID(parts[0], parts[1], parts[2], parts[3], parts[4])
	if got := RawObjectID(parts[0], parts[1], parts[2], parts[3], parts[4]); got != want {
		t.Fatalf("same capture identity = %q, want %q", got, want)
	}
	if !regexp.MustCompile(`^r_[0-9a-f]{24}$`).MatchString(want) {
		t.Fatalf("Raw object identity %q has an unstable wire shape", want)
	}
	for index := range parts {
		changed := append([]string(nil), parts...)
		changed[index] += "-different"
		if got := RawObjectID(changed[0], changed[1], changed[2], changed[3], changed[4]); got == want {
			t.Fatalf("identity field %d did not scope the Raw object", index)
		}
	}
	if got := RawObjectID("ab", "c", "", "", ""); got == RawObjectID("a", "bc", "", "", "") {
		t.Fatal("length framing permitted a concatenation collision")
	}
}

func TestRawChunkIdentityIsObjectScoped(t *testing.T) {
	want := RawChunkID("r_object-a", "source-chunk-a")
	if got := RawChunkID("r_object-a", "source-chunk-a"); got != want {
		t.Fatalf("same chunk identity = %q, want %q", got, want)
	}
	if got := RawChunkID("r_object-b", "source-chunk-a"); got == want {
		t.Fatal("same source chunk identifier collided across Raw objects")
	}
	if got := RawChunkID("r_object-a", "source-chunk-b"); got == want {
		t.Fatal("different source chunk identifiers collided within a Raw object")
	}
}

func TestSourceThreadIDRequiresExactAuthenticatedScope(t *testing.T) {
	encode := func(parts ...string) string {
		value := ""
		for _, part := range parts {
			value += fmt.Sprintf("%d:%s", len(part), part)
		}
		return value
	}
	scope := encode("project", "user", "installation", "adapter", "source-session")
	session := SessionSourceKey("project", "user", "installation", "adapter", "source-session")
	thread := encode(scope, "thread", "子线程:123")
	if got, ok := SourceThreadID(session, thread); !ok || got != "子线程:123" {
		t.Fatalf("source identity lost: %q %t", got, ok)
	}
	for _, invalid := range []string{encode(encode("project", "other-user", "installation", "adapter", "source-session"), "thread", "child"), encode(scope, "event", "child"), encode(scope, "thread", ""), thread + "junk", "9999999999999999999999999999:x", "1:x-1:"} {
		if value, ok := SourceThreadID(session, invalid); ok {
			t.Fatalf("accepted %q as %q", invalid, value)
		}
	}
}
