package team

import (
	"strings"
	"testing"
)

func TestNormalizeSlugMatchesDatabaseContract(t *testing.T) {
	for _, accepted := range []struct{ input, want string }{
		{"ATape", "atape"},
		{" team-platform ", "team-platform"},
		{"a1", "a1"},
	} {
		got, err := normalizeSlug(accepted.input)
		if err != nil || got != accepted.want {
			t.Fatalf("normalizeSlug(%q) = %q, %v; want %q", accepted.input, got, err, accepted.want)
		}
	}
	for _, rejected := range []string{"a", "-team", "team-", "team_name", strings.Repeat("a", 64)} {
		if got, err := normalizeSlug(rejected); err == nil {
			t.Fatalf("normalizeSlug(%q) = %q, want rejection", rejected, got)
		}
	}
}
