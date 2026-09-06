package authentication

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	authdb "github.com/SingleMai/ATape/server/internal/authentication/internal/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxPrivateStateBytes = 16 * 1024
	maintenanceLockID    = int64(0x4154617041757468)
)

type Policy struct {
	FederatedLoginTTL      time.Duration
	WebSessionIdleTTL      time.Duration
	WebSessionAbsoluteTTL  time.Duration
	FreshAuthenticationTTL time.Duration
	LastUsedWriteInterval  time.Duration
	CLIAuthorizationTTL    time.Duration
	InitialPollInterval    time.Duration
	MaximumPollInterval    time.Duration
	CodeAttemptWindow      time.Duration
	MaximumCodeFailures    int
	TerminalRetention      time.Duration
	CodeWindowRetention    time.Duration
	MaintenanceBatchSize   int
	ShortCodeAttempts      int
}

func DefaultPolicy() Policy {
	return Policy{
		FederatedLoginTTL:      10 * time.Minute,
		WebSessionIdleTTL:      30 * 24 * time.Hour,
		WebSessionAbsoluteTTL:  180 * 24 * time.Hour,
		FreshAuthenticationTTL: 15 * time.Minute,
		LastUsedWriteInterval:  5 * time.Minute,
		CLIAuthorizationTTL:    15 * time.Minute,
		InitialPollInterval:    5 * time.Second,
		MaximumPollInterval:    60 * time.Second,
		CodeAttemptWindow:      10 * time.Minute,
		MaximumCodeFailures:    10,
		TerminalRetention:      30 * 24 * time.Hour,
		CodeWindowRetention:    24 * time.Hour,
		MaintenanceBatchSize:   500,
		ShortCodeAttempts:      16,
	}
}

type Config struct {
	ProviderRegistrations   []ProviderRegistration
	PepperKeys              KeyRing
	PrivateStateKeys        KeyRing
	Policy                  Policy
	RequireCompletedCutover bool
}

type registrationKey struct {
	id       string
	revision string
}

type Module struct {
	pool           *pgxpool.Pool
	registrations  map[registrationKey]ProviderRegistration
	active         map[string]ProviderRegistration
	pepperKeys     KeyRing
	privateKeys    KeyRing
	policy         Policy
	requireCutover bool
	random         io.Reader
}

func New(pool *pgxpool.Pool, config Config) (*Module, error) {
	if pool == nil {
		return nil, errors.New("authentication requires PostgreSQL")
	}
	policy := config.Policy
	if policy == (Policy{}) {
		policy = DefaultPolicy()
	}
	if err := validatePolicy(policy); err != nil {
		return nil, err
	}
	if _, _, err := config.PepperKeys.active(); err != nil {
		return nil, fmt.Errorf("validate authentication pepper ring: %w", err)
	}
	if _, _, err := config.PrivateStateKeys.active(); err != nil {
		return nil, fmt.Errorf("validate authentication encryption ring: %w", err)
	}

	module := &Module{
		pool: pool, registrations: make(map[registrationKey]ProviderRegistration),
		active: make(map[string]ProviderRegistration), pepperKeys: config.PepperKeys,
		privateKeys: config.PrivateStateKeys, policy: policy,
		requireCutover: config.RequireCompletedCutover, random: rand.Reader,
	}
	for _, registration := range config.ProviderRegistrations {
		if err := validateRegistration(registration); err != nil {
			return nil, err
		}
		key := registrationKey{id: registration.ID, revision: registration.Revision}
		if _, duplicate := module.registrations[key]; duplicate {
			return nil, fmt.Errorf("provider registration %q revision is duplicated", registration.ID)
		}
		module.registrations[key] = registration
		if registration.Active {
			if _, duplicate := module.active[registration.ID]; duplicate {
				return nil, fmt.Errorf("provider registration %q has multiple active revisions", registration.ID)
			}
			module.active[registration.ID] = registration
		}
	}
	return module, nil
}

func validatePolicy(policy Policy) error {
	durations := []time.Duration{
		policy.FederatedLoginTTL, policy.WebSessionIdleTTL, policy.WebSessionAbsoluteTTL,
		policy.FreshAuthenticationTTL, policy.LastUsedWriteInterval,
		policy.CLIAuthorizationTTL, policy.InitialPollInterval,
		policy.MaximumPollInterval, policy.CodeAttemptWindow,
		policy.TerminalRetention, policy.CodeWindowRetention,
	}
	for _, duration := range durations {
		if duration <= 0 {
			return errors.New("authentication policy durations must be positive")
		}
		if _, err := durationSeconds(duration); err != nil {
			return err
		}
	}
	if policy.WebSessionAbsoluteTTL <= policy.FreshAuthenticationTTL {
		return errors.New("web session absolute lifetime must exceed the freshness lifetime")
	}
	if policy.MaximumPollInterval < policy.InitialPollInterval {
		return errors.New("maximum poll interval must not be shorter than initial interval")
	}
	if policy.MaximumCodeFailures < 1 || policy.MaintenanceBatchSize < 1 || policy.ShortCodeAttempts < 1 {
		return errors.New("authentication policy counts must be positive")
	}
	return nil
}

func validateRegistration(registration ProviderRegistration) error {
	if !keyIDPattern.MatchString(registration.ID) || registration.Revision == "" ||
		len(registration.Revision) > 200 || strings.ContainsAny(registration.Revision, "\x00\r\n") {
		return errors.New("provider registration identity is invalid")
	}
	if registration.Label != "" && (!utf8.ValidString(registration.Label) ||
		len(registration.Label) > 100 || strings.TrimSpace(registration.Label) != registration.Label ||
		strings.ContainsAny(registration.Label, "\x00\r\n")) {
		return errors.New("provider registration label is invalid")
	}
	if registration.Adapter == nil {
		return fmt.Errorf("provider registration %q has no Adapter", registration.ID)
	}
	issuer, err := url.Parse(registration.ExpectedIssuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil ||
		issuer.Fragment != "" || issuer.RawQuery != "" {
		return fmt.Errorf("provider registration %q has an invalid expected issuer", registration.ID)
	}
	callback, err := url.Parse(registration.CallbackURI)
	if err != nil || callback.Scheme == "" || callback.Host == "" || callback.User != nil ||
		callback.Fragment != "" || callback.RawQuery != "" {
		return fmt.Errorf("provider registration %q has an invalid callback URI", registration.ID)
	}
	if callback.Scheme != "https" && !(callback.Scheme == "http" && isLoopback(callback.Hostname())) {
		return fmt.Errorf("provider registration %q callback must use HTTPS or loopback HTTP", registration.ID)
	}
	return nil
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// Prepare validates persisted key references and the optional cutover gate.
// Migrations must have completed before it is called. A missing key or pending
// required cutover fails startup rather than weakening authentication.
func (m *Module) Prepare(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	queries := authdb.New(m.pool)
	cutoverStatus, err := queries.GetAuthenticationCutoverStatus(ctx)
	if err != nil {
		return unavailable("read authentication cutover", err)
	}
	if m.requireCutover && cutoverStatus != "completed" {
		return domainError(CodeMisconfigured)
	}

	privateIDs, err := queries.ListLivePrivateStateKeyIDs(ctx)
	if err != nil {
		return unavailable("read live private-state keys", err)
	}
	for _, id := range privateIDs {
		if id == nil {
			return domainError(CodeMisconfigured)
		}
		if _, ok := m.privateKeys.get(*id); !ok {
			return domainError(CodeMisconfigured)
		}
	}

	pepperIDs, err := queries.ListLiveUserCodeKeyIDs(ctx)
	if err != nil {
		return unavailable("read live user-code keys", err)
	}
	for _, id := range pepperIDs {
		if _, ok := m.pepperKeys.get(id); !ok {
			return domainError(CodeMisconfigured)
		}
	}

	registrations, err := queries.ListLiveProviderRegistrations(ctx)
	if err != nil {
		return unavailable("read live Provider Registrations", err)
	}
	for _, persisted := range registrations {
		registration, ok := m.registration(persisted.ProviderRegistrationID, persisted.ProviderRegistrationRevision)
		if !ok || registration.ExpectedIssuer != persisted.ExpectedIssuer || registration.CallbackURI != persisted.CallbackUri {
			return domainError(CodeMisconfigured)
		}
	}
	return nil
}

func (m *Module) newSecret(prefix string) (string, error) {
	material := make([]byte, 32)
	if _, err := io.ReadFull(m.random, material); err != nil {
		return "", errors.New("secure random source failed")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(material), nil
}

func newID() (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", errors.New("secure identity generation failed")
	}
	return id.String(), nil
}

func validateOpaqueSecret(secret, prefix string) bool {
	if !strings.HasPrefix(secret, prefix) {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(secret, prefix))
	return err == nil && len(decoded) == 32
}

func normalizeReturnTo(value string) (string, error) {
	if value == "" {
		return "", domainError(CodeInvalidRequest)
	}
	if !utf8.ValidString(value) || len(value) > 2048 || !strings.HasPrefix(value, "/") ||
		strings.HasPrefix(value, "//") || strings.Contains(value, "\\") || strings.ContainsAny(value, "\r\n\x00") {
		return "", domainError(CodeInvalidRequest)
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.User != nil || parsed.Fragment != "" ||
		parsed.Path == "" || strings.HasPrefix(parsed.Path, "//") || strings.Contains(parsed.Path, "\\") ||
		strings.ContainsAny(parsed.Path, "\r\n\x00") {
		return "", domainError(CodeInvalidRequest)
	}
	normalized := parsed.RequestURI()
	if len(normalized) > 2048 {
		return "", domainError(CodeInvalidRequest)
	}
	return normalized, nil
}

func validateRequestID(value string) bool {
	return utf8.ValidString(value) && len(value) <= 200 && !strings.ContainsAny(value, "\x00\r\n")
}

func validateProfile(identity VerifiedExternalIdentity) error {
	issuer, err := url.Parse(identity.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil ||
		issuer.Fragment != "" || issuer.RawQuery != "" || len(identity.Issuer) > 2048 {
		return domainError(CodeProviderInvalidResponse)
	}
	if !utf8.ValidString(identity.Subject) || len(identity.Subject) < 1 || len(identity.Subject) > 512 ||
		strings.ContainsRune(identity.Subject, '\x00') {
		return domainError(CodeProviderInvalidResponse)
	}
	if !utf8.ValidString(identity.DisplayName) || len(strings.TrimSpace(identity.DisplayName)) < 1 ||
		len(identity.DisplayName) > 200 || strings.ContainsAny(identity.DisplayName, "\x00\r\n") {
		return domainError(CodeProviderInvalidResponse)
	}
	if !utf8.ValidString(identity.AvatarURL) || len(identity.AvatarURL) > 2048 ||
		strings.ContainsAny(identity.AvatarURL, "\x00\r\n") {
		return domainError(CodeProviderInvalidResponse)
	}
	if identity.AvatarURL != "" {
		avatar, err := url.Parse(identity.AvatarURL)
		if err != nil || avatar.Scheme != "https" || avatar.Host == "" || avatar.User != nil || avatar.Fragment != "" {
			return domainError(CodeProviderInvalidResponse)
		}
	}
	return nil
}

func (m *Module) registration(id, revision string) (ProviderRegistration, bool) {
	registration, ok := m.registrations[registrationKey{id: id, revision: revision}]
	return registration, ok
}

func (m *Module) acceptedPepperIDs() []string {
	ids := m.pepperKeys.ids()
	sort.Strings(ids)
	return ids
}
