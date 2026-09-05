// Package github implements the GitHub OAuth Federated Identity Adapter.
// OAuth tokens, GitHub response shapes, PKCE, and remote retry policy remain
// inside this package and never cross the Authentication Provider Seam.
package github

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/SingleMai/ATape/server/internal/authentication"
)

const (
	Issuer               = "https://github.com"
	RegistrationID       = "github"
	RegistrationRevision = "github-oauth-v1"
	PrivateStateSchema   = "github-pkce-s256-v1"

	maximumTokenResponseBytes = 32 << 10
	maximumUserResponseBytes  = 64 << 10
	remoteRequestTimeout      = 10 * time.Second
	profileAttempts           = 2
	profileRetryDelay         = 25 * time.Millisecond
)

var productionEndpoints = endpointSet{
	authorization: "https://github.com/login/oauth/authorize",
	token:         "https://github.com/login/oauth/access_token",
	user:          "https://api.github.com/user",
}

// Config is deliberately GitHub-specific. ClientSecret is never retained in
// any generic Authentication configuration or Provider state.
type Config struct {
	ClientID     string
	ClientSecret string
	HTTPClient   *http.Client
}

func (Config) String() string          { return "github.Config{ClientSecret:redacted}" }
func (config Config) GoString() string { return config.String() }

type endpointSet struct {
	authorization string
	token         string
	user          string
}

type adapter struct {
	client       *http.Client
	clientID     string
	clientSecret string
	endpoints    endpointSet
	random       io.Reader
}

func (adapter) String() string         { return "github.Adapter{credentials:redacted}" }
func (value adapter) GoString() string { return value.String() }

// New constructs the production github.com Adapter. Alternate endpoints are
// intentionally not part of Config; tests inject them inside this package so
// deployment configuration cannot silently turn credentials into an SSRF
// primitive.
func New(config Config) (authentication.FederatedIdentityAdapter, error) {
	return newAdapter(config, productionEndpoints, rand.Reader, false)
}

func newAdapter(
	config Config,
	endpoints endpointSet,
	random io.Reader,
	allowLoopbackHTTP bool,
) (*adapter, error) {
	if !validCredential(config.ClientID, 200) {
		return nil, errors.New("GitHub OAuth client id is invalid")
	}
	if !validCredential(config.ClientSecret, 4096) {
		return nil, errors.New("GitHub OAuth client secret is invalid")
	}
	if random == nil {
		return nil, errors.New("GitHub OAuth secure random source is required")
	}
	for _, endpoint := range []string{endpoints.authorization, endpoints.token, endpoints.user} {
		if err := validateEndpoint(endpoint, allowLoopbackHTTP); err != nil {
			return nil, err
		}
	}
	client := &http.Client{Transport: http.DefaultTransport}
	if config.HTTPClient != nil {
		copy := *config.HTTPClient
		client = &copy
		if client.Transport == nil {
			client.Transport = http.DefaultTransport
		}
	}
	// Provider redirects are never followed for token or identity requests.
	// In particular, a 307/308 must not replay a credential-bearing body or
	// Authorization header to a different endpoint.
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	client.Jar = nil
	return &adapter{
		client: client, clientID: config.ClientID, clientSecret: config.ClientSecret,
		endpoints: endpoints, random: random,
	}, nil
}

func validCredential(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && utf8.ValidString(value) &&
		strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n")
}

func validateEndpoint(value string, allowLoopbackHTTP bool) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("GitHub OAuth endpoint is invalid")
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if allowLoopbackHTTP && parsed.Scheme == "http" && isLoopback(parsed.Hostname()) {
		return nil
	}
	return errors.New("GitHub OAuth endpoint must use HTTPS")
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	parsed := net.ParseIP(host)
	return parsed != nil && parsed.IsLoopback()
}

func (a *adapter) Begin(
	ctx context.Context,
	request authentication.ProviderBeginRequest,
) (authentication.ProviderBeginResult, error) {
	if ctx.Err() != nil {
		return authentication.ProviderBeginResult{}, providerFailure(authentication.ProviderUnavailable)
	}
	if !validCallbackURI(request.CallbackURI) || !validState(request.State) {
		return authentication.ProviderBeginResult{}, providerFailure(authentication.ProviderProtocolViolation)
	}
	verifierMaterial := make([]byte, 32)
	if _, err := io.ReadFull(a.random, verifierMaterial); err != nil {
		return authentication.ProviderBeginResult{}, providerFailure(authentication.ProviderUnavailable)
	}
	verifier := base64.RawURLEncoding.EncodeToString(verifierMaterial)
	clear(verifierMaterial)
	challengeDigest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeDigest[:])

	authorization, err := url.Parse(a.endpoints.authorization)
	if err != nil {
		return authentication.ProviderBeginResult{}, providerFailure(authentication.ProviderMisconfigured)
	}
	query := authorization.Query()
	query.Set("client_id", a.clientID)
	query.Set("redirect_uri", request.CallbackURI)
	query.Set("state", request.State)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	authorization.RawQuery = query.Encode()
	return authentication.ProviderBeginResult{
		AuthorizationURI: authorization.String(),
		PrivateState:     []byte(verifier),
		StateSchema:      PrivateStateSchema,
	}, nil
}

func (a *adapter) Complete(
	ctx context.Context,
	request authentication.ProviderCompleteRequest,
) (authentication.VerifiedExternalIdentity, error) {
	if ctx.Err() != nil {
		return authentication.VerifiedExternalIdentity{}, providerFailure(authentication.ProviderUnavailable)
	}
	if request.AuthorizationError != "" {
		if request.AuthorizationCode != "" {
			return authentication.VerifiedExternalIdentity{}, providerFailure(authentication.ProviderProtocolViolation)
		}
		if request.AuthorizationError == "access_denied" {
			return authentication.VerifiedExternalIdentity{}, providerFailure(authentication.ProviderAccessDenied)
		}
		return authentication.VerifiedExternalIdentity{}, providerFailure(authentication.ProviderProtocolViolation)
	}
	if !validCallbackURI(request.CallbackURI) || !validAuthorizationCode(request.AuthorizationCode) ||
		request.PrivateStateSchema != PrivateStateSchema || !validVerifier(request.PrivateState) {
		return authentication.VerifiedExternalIdentity{}, providerFailure(authentication.ProviderProtocolViolation)
	}

	token, err := a.exchangeCode(ctx, request.CallbackURI, request.AuthorizationCode, string(request.PrivateState))
	if err != nil {
		return authentication.VerifiedExternalIdentity{}, err
	}
	identity, err := a.fetchIdentity(ctx, token)
	if err != nil {
		return authentication.VerifiedExternalIdentity{}, err
	}
	return identity, nil
}

func validState(value string) bool {
	return len(value) >= 32 && len(value) <= 512 && utf8.ValidString(value) &&
		!strings.ContainsAny(value, "\x00\r\n")
}

func validCallbackURI(value string) bool {
	if len(value) > 2048 || !utf8.ValidString(value) || strings.ContainsAny(value, "\\\x00\r\n") {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	return parsed.Scheme == "http" && isLoopback(parsed.Hostname())
}

func validAuthorizationCode(value string) bool {
	return value != "" && len(value) <= 4096 && utf8.ValidString(value) &&
		!strings.ContainsAny(value, "\x00\r\n")
}

func validVerifier(value []byte) bool {
	if len(value) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(string(value))
	if err != nil || len(decoded) != 32 {
		return false
	}
	canonical := base64.RawURLEncoding.EncodeToString(decoded)
	clear(decoded)
	return canonical == string(value)
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
}

func (a *adapter) exchangeCode(
	ctx context.Context,
	callbackURI string,
	authorizationCode string,
	verifier string,
) (string, error) {
	form := url.Values{
		"client_id":     {a.clientID},
		"client_secret": {a.clientSecret},
		"code":          {authorizationCode},
		"redirect_uri":  {callbackURI},
		"code_verifier": {verifier},
	}
	encoded := []byte(form.Encode())
	defer clear(encoded)
	requestContext, cancel := context.WithTimeout(ctx, remoteRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestContext, http.MethodPost, a.endpoints.token, bytes.NewReader(encoded),
	)
	if err != nil {
		return "", providerFailure(authentication.ProviderMisconfigured)
	}
	request.GetBody = nil
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("User-Agent", "ATape/0.2")
	response, err := a.client.Do(request)
	if err != nil {
		return "", providerFailure(authentication.ProviderUnavailable)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		discardBounded(response.Body)
		return "", tokenStatusFailure(response.StatusCode)
	}
	var payload tokenResponse
	if err := decodeBoundedJSON(response, maximumTokenResponseBytes, &payload); err != nil {
		return "", providerFailure(authentication.ProviderInvalidResponse)
	}
	if !validBearerToken(payload.AccessToken) || !strings.EqualFold(payload.TokenType, "bearer") {
		return "", providerFailure(authentication.ProviderInvalidResponse)
	}
	return payload.AccessToken, nil
}

func tokenStatusFailure(status int) error {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return providerFailure(authentication.ProviderMisconfigured)
	case status == http.StatusTooManyRequests || status >= http.StatusInternalServerError:
		return providerFailure(authentication.ProviderUnavailable)
	default:
		return providerFailure(authentication.ProviderInvalidResponse)
	}
}

func validBearerToken(value string) bool {
	if value == "" || len(value) > 8192 {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < 0x21 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

type userResponse struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

func (a *adapter) fetchIdentity(
	ctx context.Context,
	token string,
) (authentication.VerifiedExternalIdentity, error) {
	for attempt := 0; attempt < profileAttempts; attempt++ {
		profile, retry, err := a.fetchIdentityOnce(ctx, token)
		if err == nil {
			return normalizeIdentity(profile)
		}
		if !retry || attempt+1 == profileAttempts {
			return authentication.VerifiedExternalIdentity{}, err
		}
		if err := waitForRetry(ctx); err != nil {
			return authentication.VerifiedExternalIdentity{}, providerFailure(authentication.ProviderUnavailable)
		}
	}
	return authentication.VerifiedExternalIdentity{}, providerFailure(authentication.ProviderUnavailable)
}

func (a *adapter) fetchIdentityOnce(ctx context.Context, token string) (userResponse, bool, error) {
	requestContext, cancel := context.WithTimeout(ctx, remoteRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, a.endpoints.user, nil)
	if err != nil {
		return userResponse{}, false, providerFailure(authentication.ProviderMisconfigured)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("User-Agent", "ATape/0.2")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := a.client.Do(request)
	if err != nil {
		return userResponse{}, true, providerFailure(authentication.ProviderUnavailable)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		discardBounded(response.Body)
		retry := response.StatusCode == http.StatusTooManyRequests ||
			response.StatusCode == http.StatusBadGateway ||
			response.StatusCode == http.StatusServiceUnavailable ||
			response.StatusCode == http.StatusGatewayTimeout
		if retry || response.StatusCode == http.StatusForbidden || response.StatusCode >= http.StatusInternalServerError {
			return userResponse{}, retry, providerFailure(authentication.ProviderUnavailable)
		}
		return userResponse{}, false, providerFailure(authentication.ProviderInvalidResponse)
	}
	var profile userResponse
	if err := decodeBoundedJSON(response, maximumUserResponseBytes, &profile); err != nil {
		return userResponse{}, false, providerFailure(authentication.ProviderInvalidResponse)
	}
	return profile, false, nil
}

func normalizeIdentity(profile userResponse) (authentication.VerifiedExternalIdentity, error) {
	if profile.ID <= 0 || !validProfileText(profile.Login, 200) {
		return authentication.VerifiedExternalIdentity{}, providerFailure(authentication.ProviderInvalidResponse)
	}
	displayName := strings.TrimSpace(profile.Name)
	if displayName == "" {
		displayName = profile.Login
	}
	if !validProfileText(displayName, 200) || !validAvatarURL(profile.AvatarURL) {
		return authentication.VerifiedExternalIdentity{}, providerFailure(authentication.ProviderInvalidResponse)
	}
	return authentication.VerifiedExternalIdentity{
		Issuer: Issuer, Subject: strconv.FormatInt(profile.ID, 10),
		DisplayName: displayName, AvatarURL: profile.AvatarURL,
	}, nil
}

func validProfileText(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && utf8.ValidString(value) &&
		!strings.ContainsAny(value, "\x00\r\n")
}

func validAvatarURL(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > 2048 || !utf8.ValidString(value) || strings.ContainsAny(value, "\x00\r\n") {
		return false
	}
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" &&
		parsed.User == nil && parsed.Fragment == ""
}

func decodeBoundedJSON(response *http.Response, maximum int64, target any) error {
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || (mediaType != "application/json" && !strings.HasSuffix(mediaType, "+json")) {
		return errors.New("unexpected Provider content type")
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return errors.New("read Provider response")
	}
	defer clear(payload)
	if int64(len(payload)) > maximum {
		return errors.New("Provider response exceeds limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(target); err != nil {
		return errors.New("decode Provider response")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("Provider response contains trailing data")
	}
	return nil
}

func discardBounded(body io.Reader) {
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 4096))
}

func waitForRetry(ctx context.Context) error {
	timer := time.NewTimer(profileRetryDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func providerFailure(code authentication.ProviderFailureCode) error {
	return &authentication.ProviderFailure{Code: code}
}

var _ authentication.FederatedIdentityAdapter = (*adapter)(nil)
var _ fmt.Stringer = Config{}
