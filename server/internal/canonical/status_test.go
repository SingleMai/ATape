package canonical

import (
	"testing"
	"time"
)

func TestEffectiveSessionStatus(t *testing.T) {
	now := time.Date(2026, 9, 5, 10, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		status    string
		updatedAt time.Time
		want      string
	}{
		{name: "recent open Session", status: "active", updatedAt: now.Add(-4 * time.Minute), want: "active"},
		{name: "stale open Session", status: "active", updatedAt: now.Add(-6 * time.Minute), want: "idle"},
		{name: "explicit idle Session", status: "idle", updatedAt: now, want: "idle"},
		{name: "ended Session", status: "ended", updatedAt: now, want: "ended"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := EffectiveSessionStatus(test.status, test.updatedAt, now); got != test.want {
				t.Fatalf("status = %q, want %q", got, test.want)
			}
		})
	}
}
