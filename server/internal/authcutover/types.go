// Package authcutover owns the one-time transition from an anonymous ATape
// installation to the authenticated auth-v1 epoch. PostgreSQL rows, locks, and
// transaction sequencing stay behind this use-case-shaped Module.
package authcutover

import "time"

const (
	Protocol        = "auth-v1"
	MappingProtocol = "atape.auth-cutover.v1"
	PlanProtocol    = "atape.auth-cutover-plan.v1"
)

type Phase string

const (
	PreparedPhase  Phase = "prepared"
	BootstrapPhase Phase = "bootstrap"
	CompletedPhase Phase = "completed"
)

type InstallationKind string

const (
	FreshInstallation  InstallationKind = "fresh"
	MappedInstallation InstallationKind = "mapped"
)

type ServingMode string

const (
	NormalMode    ServingMode = "normal"
	BootstrapMode ServingMode = "bootstrap"
)

type Status struct {
	Protocol               string           `json:"protocol"`
	Phase                  Phase            `json:"phase"`
	Installation           InstallationKind `json:"installation"`
	MappingDigest          string           `json:"mappingDigest,omitempty"`
	SnapshotDigest         string           `json:"snapshotDigest,omitempty"`
	SnapshotSchemaVersion  int64            `json:"snapshotSchemaVersion,omitempty"`
	PreparedAt             time.Time        `json:"preparedAt"`
	BootstrapAt            *time.Time       `json:"bootstrapAt,omitempty"`
	CompletedAt            *time.Time       `json:"completedAt,omitempty"`
	NormalServingStartedAt *time.Time       `json:"normalServingStartedAt,omitempty"`
}

type ExternalIdentity struct {
	Issuer         string    `json:"issuer"`
	Subject        string    `json:"subject"`
	Status         string    `json:"status"`
	LastVerifiedAt time.Time `json:"lastVerifiedAt"`
}

type User struct {
	ID                 string             `json:"id"`
	Status             string             `json:"status"`
	DisplayName        string             `json:"displayName"`
	ExternalIdentities []ExternalIdentity `json:"externalIdentities"`
}

type Mapping struct {
	Protocol string        `json:"protocol"`
	Teams    []TeamMapping `json:"teams"`
}

type TeamMapping struct {
	LegacyTeamID string   `json:"legacyTeamId"`
	Slug         string   `json:"slug"`
	OwnerUserIDs []string `json:"ownerUserIds"`
}

type Counts struct {
	Users           int64 `json:"users"`
	Teams           int64 `json:"teams"`
	Projects        int64 `json:"projects"`
	LegacySessions  int64 `json:"legacySessions"`
	RawObjects      int64 `json:"rawObjects"`
	SearchDocuments int64 `json:"searchDocuments"`
}

type Finding struct {
	Code   string `json:"code"`
	Field  string `json:"field,omitempty"`
	Detail string `json:"detail"`
}

type TeamChange struct {
	LegacyTeamID string   `json:"legacyTeamId"`
	CurrentSlug  string   `json:"currentSlug,omitempty"`
	Slug         string   `json:"slug"`
	OwnerUserIDs []string `json:"ownerUserIds"`
}

// Plan is a portable, non-secret approval artifact. Apply requires the exact
// mapping and database snapshot represented here; it never treats a stale plan
// as operator approval for different state.
type Plan struct {
	Protocol              string       `json:"protocol"`
	MappingDigest         string       `json:"mappingDigest"`
	SnapshotDigest        string       `json:"snapshotDigest"`
	SnapshotSchemaVersion int64        `json:"snapshotSchemaVersion"`
	GeneratedAt           time.Time    `json:"generatedAt"`
	Counts                Counts       `json:"counts"`
	Applicable            bool         `json:"applicable"`
	Changes               []TeamChange `json:"changes"`
	Findings              []Finding    `json:"findings"`
	AuditEvents           int          `json:"auditEvents"`
}

type ApplyResult struct {
	Status           Status `json:"status"`
	MappingDigest    string `json:"mappingDigest"`
	AlreadyCompleted bool   `json:"alreadyCompleted"`
	AuditEvents      int    `json:"auditEvents"`
}

type Readiness struct {
	Ready  bool        `json:"ready"`
	Mode   ServingMode `json:"mode"`
	Status Status      `json:"cutover"`
	Checks []Finding   `json:"checks,omitempty"`
}
