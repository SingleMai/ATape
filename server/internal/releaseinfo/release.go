// Package releaseinfo owns the immutable identity shared by ATape v0.2
// artifacts. The variables remain overrideable at link time so a container
// label and the executable can be proven to describe the same build.
package releaseinfo

var (
	Version           = "0.2.0"
	AuthEpoch         = "auth-v1"
	MinimumCLIVersion = "0.2.0"
)

// Info is the small, presentation-safe view exposed by diagnostics and
// Instance discovery. It contains no deployment or credential state.
type Info struct {
	Version           string `json:"version"`
	AuthEpoch         string `json:"authEpoch"`
	MinimumCLIVersion string `json:"minimumCliVersion"`
}

// Current returns the linked artifact identity.
func Current() Info {
	return Info{
		Version:           Version,
		AuthEpoch:         AuthEpoch,
		MinimumCLIVersion: MinimumCLIVersion,
	}
}
