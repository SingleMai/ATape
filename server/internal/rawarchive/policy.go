package rawarchive

// CaptureEnabled is the effective upload rule. Unknown Team policies fail closed; force ignores the personal preference.
func CaptureEnabled(teamPolicy, userPreference string) bool {
	return teamPolicy == "force" || teamPolicy == "personal" && userPreference == "enable"
}

type CaptureDisabledError struct{}

func (*CaptureDisabledError) Error() string {
	return "Raw capture is disabled by the effective capture policy"
}
