package httpapi

import (
	"errors"
	"net"
	"net/url"
	"strings"

	"github.com/SingleMai/ATape/server/internal/authcutover"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"golang.org/x/net/publicsuffix"
)

// Config is the explicit public HTTP topology. Host and Forwarded headers are
// never consulted when producing discovery metadata, redirects, Cookie scope,
// or CORS policy.
type Config struct {
	InstanceOrigin       string
	WebOrigin            string
	APIOrigin            string
	CookieDomain         string
	DevelopmentAllowHTTP bool
	CutoverMode          authcutover.ServingMode

	// DevelopmentPrincipal is an explicit demo-only Adapter for the existing
	// in-memory dataset. Production construction must leave it nil.
	DevelopmentPrincipal *authentication.Principal
}

type preparedConfig struct {
	instanceOrigin string
	webOrigin      string
	apiOrigin      string
	cookieDomain   string
	secureCookies  bool
	sessionCookie  string
	loginCookie    string
	splitOrigin    bool
	development    *authentication.Principal
	cutoverMode    authcutover.ServingMode
}

// NormalizeConfig validates the public topology and returns its canonical
// origin and Cookie-domain spellings. The Composition Root uses this before it
// derives Provider callback URIs, so Provider configuration and runtime HTTP
// metadata cannot disagree over a trailing slash or default port.
func NormalizeConfig(config Config) (Config, error) {
	prepared, err := prepareConfig(config)
	if err != nil {
		return Config{}, err
	}
	config.InstanceOrigin = prepared.instanceOrigin
	config.WebOrigin = prepared.webOrigin
	config.APIOrigin = prepared.apiOrigin
	config.CookieDomain = prepared.cookieDomain
	config.CutoverMode = prepared.cutoverMode
	return config, nil
}

func prepareConfig(config Config) (preparedConfig, error) {
	cutoverMode := config.CutoverMode
	if cutoverMode == "" {
		cutoverMode = authcutover.NormalMode
	}
	if cutoverMode != authcutover.NormalMode && cutoverMode != authcutover.BootstrapMode {
		return preparedConfig{}, errors.New("invalid auth cutover serving mode")
	}
	instanceOrigin, _, err := normalizeOrigin(config.InstanceOrigin, config.DevelopmentAllowHTTP)
	if err != nil {
		return preparedConfig{}, errors.New("invalid Instance Origin")
	}
	webOrigin, webURL, err := normalizeOrigin(config.WebOrigin, config.DevelopmentAllowHTTP)
	if err != nil {
		return preparedConfig{}, errors.New("invalid Web Origin")
	}
	apiOrigin, apiURL, err := normalizeOrigin(config.APIOrigin, config.DevelopmentAllowHTTP)
	if err != nil {
		return preparedConfig{}, errors.New("invalid API Origin")
	}
	if instanceOrigin != webOrigin {
		return preparedConfig{}, errors.New("Instance Origin must equal Web Origin")
	}

	cookieDomain := strings.ToLower(strings.TrimSpace(config.CookieDomain))
	sameCookieHost := strings.EqualFold(webURL.Hostname(), apiURL.Hostname())
	if sameCookieHost && cookieDomain != "" {
		return preparedConfig{}, errors.New("Cookie Domain is forbidden when Web and API share a host")
	}
	if !sameCookieHost {
		if cookieDomain == "" {
			return preparedConfig{}, errors.New("split-host topology requires an explicit Cookie Domain")
		}
		if err := validateCookieDomain(cookieDomain, webURL.Hostname(), apiURL.Hostname()); err != nil {
			return preparedConfig{}, err
		}
	}

	secure := webURL.Scheme == "https" && apiURL.Scheme == "https"
	if !secure && (!config.DevelopmentAllowHTTP || !isLoopbackHost(webURL.Hostname()) || !isLoopbackHost(apiURL.Hostname())) {
		return preparedConfig{}, errors.New("HTTP is restricted to explicit loopback development")
	}
	sessionCookie := "atape_session_dev"
	loginCookie := "atape_login_dev"
	if secure {
		loginCookie = "__Host-atape_login"
		if cookieDomain == "" {
			sessionCookie = "__Host-atape_session"
		} else {
			sessionCookie = "__Secure-atape_session"
		}
	}

	var development *authentication.Principal
	if config.DevelopmentPrincipal != nil {
		copy := *config.DevelopmentPrincipal
		if copy.UserID == "" || (copy.Method != authentication.WebAuthentication &&
			copy.Method != authentication.CLIAuthentication) {
			return preparedConfig{}, errors.New("development Principal is invalid")
		}
		development = &copy
	}
	if development != nil && cutoverMode != authcutover.NormalMode {
		return preparedConfig{}, errors.New("development Principal cannot serve auth cutover bootstrap")
	}
	return preparedConfig{
		instanceOrigin: instanceOrigin, webOrigin: webOrigin, apiOrigin: apiOrigin,
		cookieDomain: cookieDomain, secureCookies: secure,
		sessionCookie: sessionCookie, loginCookie: loginCookie,
		splitOrigin: apiOrigin != webOrigin, development: development,
		cutoverMode: cutoverMode,
	}, nil
}

func normalizeOrigin(value string, allowHTTP bool) (string, *url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil ||
		parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") {
		return "", nil, errors.New("origin must contain only scheme and authority")
	}
	scheme := strings.ToLower(parsed.Scheme)
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" || strings.ContainsAny(hostname, "\x00\r\n") {
		return "", nil, errors.New("origin host is invalid")
	}
	port := parsed.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	if scheme != "https" && !(scheme == "http" && allowHTTP && isLoopbackHost(hostname)) {
		return "", nil, errors.New("origin must use HTTPS")
	}
	host := hostname
	if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	if port != "" {
		host = net.JoinHostPort(hostname, port)
	}
	normalized := scheme + "://" + host
	result, err := url.Parse(normalized)
	if err != nil {
		return "", nil, errors.New("origin is invalid")
	}
	return normalized, result, nil
}

func validateCookieDomain(domain string, hosts ...string) error {
	if domain == "" || strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") ||
		strings.ContainsAny(domain, ":/\\\x00\r\n") || net.ParseIP(domain) != nil ||
		strings.EqualFold(domain, "localhost") {
		return errors.New("Cookie Domain is invalid")
	}
	suffix, _ := publicsuffix.PublicSuffix(domain)
	if strings.EqualFold(suffix, domain) {
		return errors.New("Cookie Domain must not be a public suffix")
	}
	for _, host := range hosts {
		if net.ParseIP(host) != nil || !(strings.EqualFold(host, domain) ||
			strings.HasSuffix(strings.ToLower(host), "."+domain)) {
			return errors.New("Cookie Domain must domain-match Web and API hosts")
		}
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	parsed := net.ParseIP(host)
	return parsed != nil && parsed.IsLoopback()
}
