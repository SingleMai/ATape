package ingestion

const CapabilitiesProtocolVersion = "atape.canonical-capabilities.v1"

// Capabilities describes modern Canonical profiles independently of publication.
// Historical v1 writes remain a compatibility path, not a discovery target.
type Capabilities struct {
	Protocol          string   `json:"protocol"`
	CanonicalProfiles []string `json:"canonicalProfiles"`
}

var modernCanonicalProfiles = [...]string{
	CanonicalProfileVersion, UnknownTimeCanonicalProfileVersion, ToolIdentityCanonicalProfileVersion,
}

func (i *Ingestor) Capabilities() Capabilities {
	return Capabilities{Protocol: CapabilitiesProtocolVersion,
		CanonicalProfiles: append([]string(nil), modernCanonicalProfiles[:]...)}
}

func supportedCanonicalProfile(profile string) bool {
	if profile == LegacyCanonicalProfileVersion {
		return true
	}
	for _, supported := range modernCanonicalProfiles {
		if profile == supported {
			return true
		}
	}
	return false
}
