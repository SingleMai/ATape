package rawarchive

const PublicationProtocol = "atape.raw-publication.v1"

// Authority fences Raw independently of Canonical head changes. A forced Team
// policy ignores personal changes, including their revision.
type Authority struct {
	Protocol     string `json:"protocol"`
	TeamRevision int64  `json:"teamRevision"`
	UserRevision int64  `json:"userRevision"`
}

func CaptureAuthority(teamPolicy string, teamRevision, userRevision int64) Authority {
	if teamPolicy == "force" {
		userRevision = 0
	}
	return Authority{Protocol: PublicationProtocol, TeamRevision: teamRevision, UserRevision: userRevision}
}

type AuthorityChangedError struct{}

func (*AuthorityChangedError) Error() string {
	return "Raw authority changed; the frozen observation cannot be re-authorized"
}

// CaptureEnabled is the effective upload rule. Unknown Team policies fail closed; force ignores the personal preference.
func CaptureEnabled(teamPolicy, userPreference string) bool {
	return teamPolicy == "force" || teamPolicy == "personal" && userPreference == "enable"
}

type CaptureDisabledError struct{}

func (*CaptureDisabledError) Error() string {
	return "Raw capture is disabled by the effective capture policy"
}
