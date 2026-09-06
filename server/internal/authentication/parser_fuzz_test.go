package authentication

import (
	"net/url"
	"strings"
	"testing"
)

func TestNormalizeReturnToRejectsOversizedEncodedResult(t *testing.T) {
	candidate := "/" + strings.Repeat("<", 683)
	if len(candidate) > 2048 {
		t.Fatalf("regression candidate must fit the input bound: %d", len(candidate))
	}
	if normalized, err := normalizeReturnTo(candidate); err == nil {
		t.Fatalf("accepted encoded return path with %d bytes: %q", len(normalized), normalized)
	}
}

func FuzzNormalizeReturnTo(f *testing.F) {
	for _, seed := range []string{
		"/", "/teams/acme", "/cli/authorize?user_code=ABC123",
		"//attacker.example", "https://attacker.example", "/\\attacker",
		"/%2f%2fattacker.example", "/path#fragment", "/path\r\nLocation: https://attacker.example",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, candidate string) {
		normalized, err := normalizeReturnTo(candidate)
		if err != nil {
			return
		}
		if len(normalized) > 2048 || !strings.HasPrefix(normalized, "/") ||
			strings.HasPrefix(normalized, "//") || strings.Contains(normalized, "\\") ||
			strings.ContainsAny(normalized, "\x00\r\n") {
			t.Fatalf("accepted unsafe return path %q from %q", normalized, candidate)
		}
		parsed, parseErr := url.Parse(normalized)
		if parseErr != nil || parsed.IsAbs() || parsed.Host != "" || parsed.User != nil || parsed.Fragment != "" {
			t.Fatalf("accepted non-local return path %q: %v", normalized, parseErr)
		}
		repeated, repeatedErr := normalizeReturnTo(normalized)
		if repeatedErr != nil || repeated != normalized {
			t.Fatalf("return path normalization is not idempotent: %q -> %q, %v", normalized, repeated, repeatedErr)
		}
	})
}

func FuzzNormalizeDeviceUserCode(f *testing.F) {
	for _, seed := range []string{
		"ABC123", "abc123", " A B C 1 2 3 ", "ABC12", "ABC1234", "O0I1L2", "ＡＢＣ１２３",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, candidate string) {
		normalized, valid := normalizeDeviceUserCode(candidate)
		if !valid {
			return
		}
		if len(normalized) != deviceUserCodeLength || normalized != strings.ToUpper(normalized) {
			t.Fatalf("accepted non-canonical device code %q from %q", normalized, candidate)
		}
		for _, character := range normalized {
			if !strings.ContainsRune(deviceUserCodeAlphabet, character) {
				t.Fatalf("accepted device-code character %q in %q", character, normalized)
			}
		}
		if displayDeviceUserCode(normalized) != normalized {
			t.Fatalf("display changed normalized device code %q", normalized)
		}
		repeated, repeatedValid := normalizeDeviceUserCode(normalized)
		if !repeatedValid || repeated != normalized {
			t.Fatalf("device-code normalization is not idempotent: %q -> %q", normalized, repeated)
		}
	})
}
