package canonical

import "time"

const ActiveSessionWindow = 5 * time.Minute

// EffectiveSessionStatus keeps durable provider lifecycle separate from the
// time-sensitive presence shown by readers.
func EffectiveSessionStatus(status string, updatedAt, now time.Time) string {
	if status != "active" {
		return status
	}
	if updatedAt.Before(ActiveSessionCutoff(now)) {
		return "idle"
	}
	return "active"
}

func ActiveSessionCutoff(now time.Time) time.Time {
	return now.UTC().Add(-ActiveSessionWindow)
}
