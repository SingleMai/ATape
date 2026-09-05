package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/releaseinfo"
)

var serverConfigEnvironment = []string{
	"ATAPE_SERVER_ADDRESS",
	"ATAPE_DATABASE_URL",
	"ATAPE_DATABASE_URL_FILE",
	"ATAPE_RAW_DIRECTORY",
	"ATAPE_DEMO_MODE",
	"ATAPE_PUBLIC_URL",
	"ATAPE_API_PUBLIC_URL",
	"ATAPE_COOKIE_DOMAIN",
	"ATAPE_DEVELOPMENT_ALLOW_HTTP",
	"ATAPE_AUTH_PEPPER_KEY_RING",
	"ATAPE_AUTH_PEPPER_KEY_RING_FILE",
	"ATAPE_AUTH_PRIVATE_STATE_KEY_RING",
	"ATAPE_AUTH_PRIVATE_STATE_KEY_RING_FILE",
	"ATAPE_GITHUB_CLIENT_ID",
	"ATAPE_GITHUB_CLIENT_SECRET",
	"ATAPE_GITHUB_CLIENT_SECRET_FILE",
	"ATAPE_AUTH_CUTOVER_MODE",
}

func TestVersionCommandReportsArtifactIdentity(t *testing.T) {
	var output strings.Builder
	if err := runVersionCommand([]string{"--json"}, &output); err != nil {
		t.Fatalf("run version command: %v", err)
	}
	var got releaseinfo.Info
	if err := json.Unmarshal([]byte(output.String()), &got); err != nil {
		t.Fatalf("decode version output: %v", err)
	}
	if got != releaseinfo.Current() {
		t.Fatalf("version output = %+v, want %+v", got, releaseinfo.Current())
	}

	output.Reset()
	if err := runVersionCommand(nil, &output); err != nil {
		t.Fatalf("run text version command: %v", err)
	}
	if !strings.Contains(output.String(), releaseinfo.Version) || !strings.Contains(output.String(), releaseinfo.AuthEpoch) {
		t.Fatalf("text version output omits artifact identity: %q", output.String())
	}
	if err := runVersionCommand([]string{"--unknown"}, &output); err == nil {
		t.Fatal("version command accepted an unknown argument")
	}
}

func TestLoadConfigRequiresDurableStorageOutsideDemoMode(t *testing.T) {
	clearServerConfigEnvironment(t)
	t.Setenv("ATAPE_SERVER_ADDRESS", "")
	t.Setenv("ATAPE_RAW_DIRECTORY", "")
	t.Setenv("ATAPE_DEMO_MODE", "")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "ATAPE_DATABASE_URL is required") {
		t.Fatalf("loadConfig error = %v, want missing database failure", err)
	}
}

func TestLoadConfigAllowsExplicitDemoMode(t *testing.T) {
	clearServerConfigEnvironment(t)
	t.Setenv("ATAPE_SERVER_ADDRESS", "")
	t.Setenv("ATAPE_RAW_DIRECTORY", "")
	t.Setenv("ATAPE_DEMO_MODE", "true")

	config, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if !config.demoMode || config.address != "127.0.0.1:8080" {
		t.Fatalf("unexpected demo config: %+v", config)
	}
}

func TestLoadConfigRestrictsDemoBypassToEphemeralLoopbackMode(t *testing.T) {
	for name, configure := range map[string]func(*testing.T){
		"durable database": func(t *testing.T) {
			t.Setenv("ATAPE_DATABASE_URL", "postgres://atape@database/atape")
		},
		"wildcard listener": func(t *testing.T) {
			t.Setenv("ATAPE_SERVER_ADDRESS", "0.0.0.0:8080")
		},
		"public listener": func(t *testing.T) {
			t.Setenv("ATAPE_SERVER_ADDRESS", "192.0.2.1:8080")
		},
	} {
		t.Run(name, func(t *testing.T) {
			clearServerConfigEnvironment(t)
			t.Setenv("ATAPE_DEMO_MODE", "true")
			configure(t)
			if _, err := loadConfig(); err == nil {
				t.Fatal("unsafe demo configuration unexpectedly succeeded")
			}
		})
	}

	clearServerConfigEnvironment(t)
	t.Setenv("ATAPE_DEMO_MODE", "true")
	t.Setenv("ATAPE_SERVER_ADDRESS", "[::1]:9090")
	config, err := loadConfig()
	if err != nil {
		t.Fatalf("load IPv6 loopback demo config: %v", err)
	}
	if config.http.APIOrigin != "http://[::1]:9090" {
		t.Fatalf("demo origin did not follow the loopback listener: %+v", config.http)
	}
}

func TestLoadConfigUsesPostgresWithoutDemoMode(t *testing.T) {
	clearServerConfigEnvironment(t)
	t.Setenv("ATAPE_SERVER_ADDRESS", "0.0.0.0:8080")
	t.Setenv("ATAPE_DATABASE_URL", "postgres://atape@database/atape")
	t.Setenv("ATAPE_RAW_DIRECTORY", "/var/lib/atape/raw")
	t.Setenv("ATAPE_DEMO_MODE", "false")
	t.Setenv("ATAPE_PUBLIC_URL", "https://atape.example.com")
	t.Setenv("ATAPE_API_PUBLIC_URL", "")
	t.Setenv("ATAPE_COOKIE_DOMAIN", "")
	t.Setenv("ATAPE_AUTH_PEPPER_KEY_RING", testKeyRing('p'))
	t.Setenv("ATAPE_AUTH_PRIVATE_STATE_KEY_RING", testKeyRing('e'))
	t.Setenv("ATAPE_GITHUB_CLIENT_ID", "github-client-id")
	t.Setenv("ATAPE_GITHUB_CLIENT_SECRET", "github-client-secret")

	config, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.demoMode || config.address != "0.0.0.0:8080" ||
		config.databaseURL != "postgres://atape@database/atape" ||
		config.rawDirectory != "/var/lib/atape/raw" {
		t.Fatalf("unexpected production config: %+v", config)
	}
}

func TestLoadConfigRequiresExplicitCutoverModeAndRawStorage(t *testing.T) {
	base := func(t *testing.T) {
		clearServerConfigEnvironment(t)
		t.Setenv("ATAPE_DATABASE_URL", "postgres://atape@database/atape")
		t.Setenv("ATAPE_PUBLIC_URL", "https://atape.example.com")
		t.Setenv("ATAPE_AUTH_PEPPER_KEY_RING", testKeyRing('p'))
		t.Setenv("ATAPE_AUTH_PRIVATE_STATE_KEY_RING", testKeyRing('e'))
		t.Setenv("ATAPE_GITHUB_CLIENT_ID", "github-client-id")
		t.Setenv("ATAPE_GITHUB_CLIENT_SECRET", "github-client-secret")
	}

	t.Run("bootstrap", func(t *testing.T) {
		base(t)
		t.Setenv("ATAPE_RAW_DIRECTORY", "/var/lib/atape/raw")
		t.Setenv("ATAPE_AUTH_CUTOVER_MODE", "bootstrap")
		config, err := loadConfig()
		if err != nil || config.cutoverMode != "bootstrap" || config.http.CutoverMode != "bootstrap" {
			t.Fatalf("bootstrap config = %+v, %v", config, err)
		}
	})

	t.Run("invalid mode", func(t *testing.T) {
		base(t)
		t.Setenv("ATAPE_AUTH_CUTOVER_MODE", "automatic")
		if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "normal or bootstrap") {
			t.Fatalf("invalid mode error = %v", err)
		}
	})

	t.Run("missing Raw", func(t *testing.T) {
		base(t)
		if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "ATAPE_RAW_DIRECTORY") {
			t.Fatalf("missing Raw error = %v", err)
		}
	})

	t.Run("demo bootstrap", func(t *testing.T) {
		clearServerConfigEnvironment(t)
		t.Setenv("ATAPE_DEMO_MODE", "true")
		t.Setenv("ATAPE_AUTH_CUTOVER_MODE", "bootstrap")
		if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "cannot use auth cutover bootstrap") {
			t.Fatalf("demo bootstrap error = %v", err)
		}
	})
}

func TestReadCutoverDocumentIsStrictAndBounded(t *testing.T) {
	directory := t.TempDir()
	validPath := filepath.Join(directory, "mapping.json")
	if err := os.WriteFile(validPath, []byte(`{"protocol":"atape.auth-cutover.v1","teams":[]}`), 0o600); err != nil {
		t.Fatalf("write valid mapping: %v", err)
	}
	document, err := readCutoverDocument[map[string]any](validPath)
	if err != nil || document["protocol"] != "atape.auth-cutover.v1" {
		t.Fatalf("read valid mapping = %+v, %v", document, err)
	}
	for name, content := range map[string]string{
		"trailing": `{} {}`,
		"unknown":  `{"unknown":true}`,
		"oversize": `{"protocol":"` + strings.Repeat("a", cutoverDocumentLimit) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(directory, name+".json")
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatalf("write document: %v", err)
			}
			if _, err := readCutoverDocument[struct {
				Protocol string `json:"protocol"`
			}](path); err == nil {
				t.Fatal("invalid document was accepted")
			}
		})
	}
}

func TestLoadConfigCanonicalizesOriginsBeforeDerivingProviderCallback(t *testing.T) {
	clearServerConfigEnvironment(t)
	t.Setenv("ATAPE_DATABASE_URL", "postgres://atape@database/atape")
	t.Setenv("ATAPE_RAW_DIRECTORY", "/var/lib/atape/raw")
	t.Setenv("ATAPE_PUBLIC_URL", "https://ATAPE.EXAMPLE.COM:443/")
	t.Setenv("ATAPE_API_PUBLIC_URL", "https://API.ATAPE.EXAMPLE.COM:443/")
	t.Setenv("ATAPE_COOKIE_DOMAIN", "ATAPE.EXAMPLE.COM")
	t.Setenv("ATAPE_AUTH_PEPPER_KEY_RING", testKeyRing('p'))
	t.Setenv("ATAPE_AUTH_PRIVATE_STATE_KEY_RING", testKeyRing('e'))
	t.Setenv("ATAPE_GITHUB_CLIENT_ID", "github-client-id")
	t.Setenv("ATAPE_GITHUB_CLIENT_SECRET", "github-client-secret")

	config, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.http.InstanceOrigin != "https://atape.example.com" ||
		config.http.WebOrigin != "https://atape.example.com" ||
		config.http.APIOrigin != "https://api.atape.example.com" ||
		config.http.CookieDomain != "atape.example.com" {
		t.Fatalf("public HTTP topology was not canonicalized: %+v", config.http)
	}
	if callback := config.http.APIOrigin + "/api/v1/auth/github/callback"; callback != "https://api.atape.example.com/api/v1/auth/github/callback" {
		t.Fatalf("Provider callback URI = %q", callback)
	}
}

func testKeyRing(fill byte) string {
	material := base64.StdEncoding.EncodeToString([]byte(strings.Repeat(string(fill), 32)))
	return `{"active":"v1","keys":{"v1":"` + material + `"}}`
}

func TestLoadConfigRejectsInvalidDemoMode(t *testing.T) {
	clearServerConfigEnvironment(t)
	t.Setenv("ATAPE_DEMO_MODE", "sometimes")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "ATAPE_DEMO_MODE must be a boolean") {
		t.Fatalf("loadConfig error = %v, want invalid boolean failure", err)
	}
}

func TestLoadConfigRequiresExplicitSecureAuthenticationConfiguration(t *testing.T) {
	clearServerConfigEnvironment(t)
	t.Setenv("ATAPE_DATABASE_URL", "postgres://atape@database/atape")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "ATAPE_PUBLIC_URL is required") {
		t.Fatalf("loadConfig error = %v, want missing public URL failure", err)
	}

	t.Setenv("ATAPE_PUBLIC_URL", "https://atape.example.com")
	_, err = loadConfig()
	if err == nil || !strings.Contains(err.Error(), "ATAPE_AUTH_PEPPER_KEY_RING") {
		t.Fatalf("loadConfig error = %v, want missing key ring failure", err)
	}

	t.Setenv("ATAPE_AUTH_PEPPER_KEY_RING", testKeyRing('p'))
	t.Setenv("ATAPE_AUTH_PRIVATE_STATE_KEY_RING", testKeyRing('e'))
	t.Setenv("ATAPE_RAW_DIRECTORY", "/var/lib/atape/raw")
	_, err = loadConfig()
	if err == nil || !strings.Contains(err.Error(), "active Provider registration") {
		t.Fatalf("loadConfig error = %v, want missing Provider failure", err)
	}
}

func TestLoadConfigReadsSecretFilesAndEnablesGitHub(t *testing.T) {
	clearServerConfigEnvironment(t)
	directory := t.TempDir()
	databasePath := filepath.Join(directory, "database-url")
	pepperPath := filepath.Join(directory, "pepper.json")
	privatePath := filepath.Join(directory, "private.json")
	githubPath := filepath.Join(directory, "github-secret")
	for path, value := range map[string]string{
		databasePath: "postgres://atape@database/atape\n",
		pepperPath:   testKeyRing('p') + "\n",
		privatePath:  testKeyRing('e') + "\r\n",
		githubPath:   "github-secret-value\n",
	} {
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatalf("write test secret file: %v", err)
		}
	}
	t.Setenv("ATAPE_DATABASE_URL", "")
	t.Setenv("ATAPE_DATABASE_URL_FILE", databasePath)
	t.Setenv("ATAPE_RAW_DIRECTORY", "/var/lib/atape/raw")
	t.Setenv("ATAPE_PUBLIC_URL", "https://atape.example.com")
	t.Setenv("ATAPE_AUTH_PEPPER_KEY_RING_FILE", pepperPath)
	t.Setenv("ATAPE_AUTH_PRIVATE_STATE_KEY_RING_FILE", privatePath)
	t.Setenv("ATAPE_GITHUB_CLIENT_ID", "github-client-id")
	t.Setenv("ATAPE_GITHUB_CLIENT_SECRET_FILE", githubPath)

	config, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.databaseURL != "postgres://atape@database/atape" || !config.githubEnabled || config.github.ClientID != "github-client-id" ||
		config.github.ClientSecret != "github-secret-value" {
		t.Fatal("GitHub Provider configuration was not loaded from the explicit secret file")
	}
	for _, rendered := range []string{fmt.Sprintf("%v", config), fmt.Sprintf("%#v", config)} {
		if strings.Contains(rendered, "github-secret-value") || strings.Contains(rendered, "github-client-id") {
			t.Fatalf("server configuration rendering leaked Provider credentials: %s", rendered)
		}
	}
}

func TestLoadConfigRejectsPartialOrAmbiguousGitHubConfiguration(t *testing.T) {
	for name, configure := range map[string]func(*testing.T){
		"client id only": func(t *testing.T) {
			t.Setenv("ATAPE_GITHUB_CLIENT_ID", "github-client-id")
		},
		"secret only": func(t *testing.T) {
			t.Setenv("ATAPE_GITHUB_CLIENT_SECRET", "github-secret")
		},
		"direct and file secret": func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "github-secret")
			if err := os.WriteFile(path, []byte("file-secret"), 0o600); err != nil {
				t.Fatalf("write test secret file: %v", err)
			}
			t.Setenv("ATAPE_GITHUB_CLIENT_ID", "github-client-id")
			t.Setenv("ATAPE_GITHUB_CLIENT_SECRET", "direct-secret")
			t.Setenv("ATAPE_GITHUB_CLIENT_SECRET_FILE", path)
		},
	} {
		t.Run(name, func(t *testing.T) {
			clearServerConfigEnvironment(t)
			t.Setenv("ATAPE_DATABASE_URL", "postgres://atape@database/atape")
			t.Setenv("ATAPE_PUBLIC_URL", "https://atape.example.com")
			t.Setenv("ATAPE_AUTH_PEPPER_KEY_RING", testKeyRing('p'))
			t.Setenv("ATAPE_AUTH_PRIVATE_STATE_KEY_RING", testKeyRing('e'))
			configure(t)
			if _, err := loadConfig(); err == nil {
				t.Fatal("partial or ambiguous Provider configuration unexpectedly succeeded")
			}
		})
	}
}

func TestLoadConfigRejectsPublicHTTPEvenWhenDevelopmentHTTPIsEnabled(t *testing.T) {
	clearServerConfigEnvironment(t)
	t.Setenv("ATAPE_DATABASE_URL", "postgres://atape@database/atape")
	t.Setenv("ATAPE_PUBLIC_URL", "http://atape.example.com")
	t.Setenv("ATAPE_DEVELOPMENT_ALLOW_HTTP", "true")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "invalid Instance Origin") {
		t.Fatalf("loadConfig error = %v, want public HTTP rejection", err)
	}
}

func TestNewHTTPServerHasDefensiveNetworkBounds(t *testing.T) {
	server := newHTTPServer(serverConfig{address: "127.0.0.1:9090"}, nil)
	if server.Addr != "127.0.0.1:9090" || server.ReadHeaderTimeout != 5*time.Second ||
		server.ReadTimeout != 30*time.Second || server.WriteTimeout != 30*time.Second ||
		server.IdleTimeout != 2*time.Minute || server.MaxHeaderBytes != 64<<10 {
		t.Fatalf("unexpected HTTP server bounds: %+v", server)
	}
}

func clearServerConfigEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range serverConfigEnvironment {
		value, configured := os.LookupEnv(name)
		if err := os.Unsetenv(name); err != nil {
			t.Fatalf("unset %s: %v", name, err)
		}
		name, value, configured := name, value, configured
		t.Cleanup(func() {
			if configured {
				_ = os.Setenv(name, value)
			} else {
				_ = os.Unsetenv(name)
			}
		})
	}
}
