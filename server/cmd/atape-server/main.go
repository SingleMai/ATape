package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/httpapi"
	"github.com/SingleMai/ATape/server/internal/adapters/memoryraw"
	"github.com/SingleMai/ATape/server/internal/adapters/memorysearch"
	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/adapters/rawchunks"
	"github.com/SingleMai/ATape/server/internal/authcutover"
	"github.com/SingleMai/ATape/server/internal/authentication"
	githubauth "github.com/SingleMai/ATape/server/internal/authentication/github"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/releaseinfo"
	"github.com/SingleMai/ATape/server/internal/team"
	"github.com/SingleMai/ATape/server/internal/workspace"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/fx"
)

type serverConfig struct {
	address       string
	databaseURL   string
	rawDirectory  string
	demoMode      bool
	http          httpapi.Config
	pepperKeys    authentication.KeyRing
	privateKeys   authentication.KeyRing
	github        githubauth.Config
	githubEnabled bool
	cutoverMode   authcutover.ServingMode
}

func (serverConfig) String() string          { return "main.serverConfig{secrets:redacted}" }
func (config serverConfig) GoString() string { return config.String() }

func loadConfig() (serverConfig, error) {
	address := os.Getenv("ATAPE_SERVER_ADDRESS")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	demoMode := false
	if encoded := os.Getenv("ATAPE_DEMO_MODE"); encoded != "" {
		parsed, err := strconv.ParseBool(encoded)
		if err != nil {
			return serverConfig{}, fmt.Errorf("ATAPE_DEMO_MODE must be a boolean: %w", err)
		}
		demoMode = parsed
	}
	databaseURL, _, err := readSecretSetting("ATAPE_DATABASE_URL")
	if err != nil {
		return serverConfig{}, err
	}
	config := serverConfig{
		address: address, databaseURL: databaseURL,
		rawDirectory: os.Getenv("ATAPE_RAW_DIRECTORY"), demoMode: demoMode,
		cutoverMode: authcutover.NormalMode,
	}
	if configuredMode := os.Getenv("ATAPE_AUTH_CUTOVER_MODE"); configuredMode != "" {
		config.cutoverMode = authcutover.ServingMode(configuredMode)
	}
	if config.cutoverMode != authcutover.NormalMode && config.cutoverMode != authcutover.BootstrapMode {
		return serverConfig{}, errors.New("ATAPE_AUTH_CUTOVER_MODE must be normal or bootstrap")
	}
	if config.databaseURL == "" && !config.demoMode {
		return serverConfig{}, errors.New("ATAPE_DATABASE_URL is required unless ATAPE_DEMO_MODE=true")
	}
	if config.demoMode {
		if config.cutoverMode != authcutover.NormalMode {
			return serverConfig{}, errors.New("ATAPE_DEMO_MODE cannot use auth cutover bootstrap")
		}
		if config.databaseURL != "" {
			return serverConfig{}, errors.New("ATAPE_DEMO_MODE cannot be combined with ATAPE_DATABASE_URL")
		}
		demoHTTP, err := demoHTTPConfig(address)
		if err != nil {
			return serverConfig{}, err
		}
		principal := authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.WebAuthentication, Fresh: true}
		demoHTTP.DevelopmentPrincipal = &principal
		config.http = demoHTTP
		return config, nil
	}
	publicURL := os.Getenv("ATAPE_PUBLIC_URL")
	if publicURL == "" {
		return serverConfig{}, errors.New("ATAPE_PUBLIC_URL is required outside demo mode")
	}
	apiPublicURL := os.Getenv("ATAPE_API_PUBLIC_URL")
	if apiPublicURL == "" {
		apiPublicURL = publicURL
	}
	allowHTTP, err := optionalBoolean("ATAPE_DEVELOPMENT_ALLOW_HTTP")
	if err != nil {
		return serverConfig{}, err
	}
	configuredHTTP := httpapi.Config{
		InstanceOrigin: publicURL, WebOrigin: publicURL, APIOrigin: apiPublicURL,
		CookieDomain: os.Getenv("ATAPE_COOKIE_DOMAIN"), DevelopmentAllowHTTP: allowHTTP,
		CutoverMode: config.cutoverMode,
	}
	config.http, err = httpapi.NormalizeConfig(configuredHTTP)
	if err != nil {
		return serverConfig{}, fmt.Errorf("validate public HTTP topology: %w", err)
	}

	config.pepperKeys, err = loadKeyRing("ATAPE_AUTH_PEPPER_KEY_RING")
	if err != nil {
		return serverConfig{}, err
	}
	config.privateKeys, err = loadKeyRing("ATAPE_AUTH_PRIVATE_STATE_KEY_RING")
	if err != nil {
		return serverConfig{}, err
	}
	clientID, clientIDSet := os.LookupEnv("ATAPE_GITHUB_CLIENT_ID")
	clientSecret, clientSecretSet, err := readSecretSetting("ATAPE_GITHUB_CLIENT_SECRET")
	if err != nil {
		return serverConfig{}, err
	}
	if clientIDSet != clientSecretSet {
		return serverConfig{}, errors.New("GitHub Provider requires both client id and client secret")
	}
	if !clientIDSet {
		return serverConfig{}, errors.New("at least one active Provider registration is required; configure the GitHub Provider")
	}
	if clientID == "" || strings.TrimSpace(clientID) != clientID || strings.ContainsAny(clientID, "\x00\r\n") {
		return serverConfig{}, errors.New("ATAPE_GITHUB_CLIENT_ID is invalid")
	}
	config.github = githubauth.Config{ClientID: clientID, ClientSecret: clientSecret}
	config.githubEnabled = true
	if config.rawDirectory == "" {
		return serverConfig{}, errors.New("ATAPE_RAW_DIRECTORY is required outside demo mode")
	}
	return config, nil
}

func demoHTTPConfig(address string) (httpapi.Config, error) {
	host, port, err := net.SplitHostPort(address)
	parsedHost := net.ParseIP(host)
	if err != nil || port == "" || (!strings.EqualFold(host, "localhost") && (parsedHost == nil || !parsedHost.IsLoopback())) {
		return httpapi.Config{}, errors.New("ATAPE_DEMO_MODE requires an explicit loopback listen address")
	}
	origin := "http://" + net.JoinHostPort(host, port)
	config, err := httpapi.NormalizeConfig(httpapi.Config{
		InstanceOrigin: origin, WebOrigin: origin, APIOrigin: origin, DevelopmentAllowHTTP: true,
	})
	if err != nil {
		return httpapi.Config{}, fmt.Errorf("validate demo HTTP topology: %w", err)
	}
	return config, nil
}

func optionalBoolean(name string) (bool, error) {
	value, configured := os.LookupEnv(name)
	if !configured || value == "" {
		return false, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean", name)
	}
	return parsed, nil
}

func readSecretSetting(name string) (string, bool, error) {
	direct, hasDirect := os.LookupEnv(name)
	// An explicitly empty direct value is equivalent to an unset optional
	// setting. This preserves conventional .env and child-process behavior while
	// file paths and configured secret-file contents remain strict.
	if hasDirect && direct == "" {
		hasDirect = false
	}
	path, hasFile := os.LookupEnv(name + "_FILE")
	if hasDirect && hasFile {
		return "", false, fmt.Errorf("%s and %s_FILE are mutually exclusive", name, name)
	}
	if !hasDirect && !hasFile {
		return "", false, nil
	}
	if hasDirect {
		return direct, true, nil
	}
	if path == "" {
		return "", false, fmt.Errorf("%s_FILE must not be empty", name)
	}
	file, err := os.Open(path)
	if err != nil {
		return "", false, fmt.Errorf("read %s_FILE: %w", name, err)
	}
	defer file.Close()
	encoded, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	if err != nil {
		return "", false, fmt.Errorf("read %s_FILE: %w", name, err)
	}
	if len(encoded) > 64<<10 {
		return "", false, fmt.Errorf("%s_FILE exceeds 64 KiB", name)
	}
	value := string(encoded)
	value = strings.TrimSuffix(value, "\n")
	value = strings.TrimSuffix(value, "\r")
	if value == "" {
		return "", false, fmt.Errorf("%s_FILE must not be empty", name)
	}
	return value, true, nil
}

type encodedKeyRing struct {
	Active string            `json:"active"`
	Keys   map[string]string `json:"keys"`
}

func loadKeyRing(name string) (authentication.KeyRing, error) {
	encoded, configured, err := readSecretSetting(name)
	if err != nil {
		return authentication.KeyRing{}, err
	}
	if !configured {
		return authentication.KeyRing{}, fmt.Errorf("%s or %s_FILE is required", name, name)
	}
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var document encodedKeyRing
	if err := decoder.Decode(&document); err != nil {
		return authentication.KeyRing{}, fmt.Errorf("%s is not a valid key ring", name)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return authentication.KeyRing{}, fmt.Errorf("%s must contain exactly one JSON object", name)
	}
	ids := make([]string, 0, len(document.Keys))
	for id := range document.Keys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	entries := make([]authentication.KeyMaterial, 0, len(ids))
	for _, id := range ids {
		entry, err := authentication.DecodeKeyMaterial(id, document.Keys[id])
		if err != nil {
			return authentication.KeyRing{}, fmt.Errorf("validate %s: %w", name, err)
		}
		entries = append(entries, entry)
	}
	ring, err := authentication.NewKeyRing(document.Active, entries)
	if err != nil {
		return authentication.KeyRing{}, fmt.Errorf("validate %s: %w", name, err)
	}
	return ring, nil
}

type persistenceAdapters struct {
	fx.Out

	BatchStore      ingestion.BatchStore
	SnapshotStore   conversation.SnapshotStore
	ChangeSource    projectsearch.ChangeSource
	ProjectionIndex projectsearch.ProjectionIndex
	QueryIndex      projectsearch.QueryIndex
	DirectoryStore  workspace.DirectoryStore
	RawArchive      *rawarchive.Archive
	Pool            *pgxpool.Pool
}

func providePersistenceAdapters(lifecycle fx.Lifecycle, config serverConfig) (persistenceAdapters, error) {
	if config.demoMode {
		store := canonical.NewDemoStore()
		index := memorysearch.New(store)
		raw, err := memoryraw.NewDemoArchive(store)
		if err != nil {
			return persistenceAdapters{}, err
		}
		slog.Info("using in-memory Canonical development Adapter")
		return persistenceAdapters{
			BatchStore: store, SnapshotStore: store, ChangeSource: store,
			ProjectionIndex: index, QueryIndex: index, DirectoryStore: store, RawArchive: raw,
		}, nil
	}
	if config.databaseURL == "" {
		return persistenceAdapters{}, errors.New("PostgreSQL persistence requires ATAPE_DATABASE_URL")
	}

	pool, err := postgresadapter.NewPool(config.databaseURL)
	if err != nil {
		return persistenceAdapters{}, err
	}
	store := postgresadapter.NewStore(pool)
	var chunkStore rawarchive.ChunkStore
	if config.rawDirectory == "" {
		chunkStore = rawchunks.NewUnavailable()
		slog.Warn("Raw Archive bytes are unavailable; configure ATAPE_RAW_DIRECTORY")
	} else {
		filesystem, err := rawchunks.NewFilesystem(config.rawDirectory)
		if err != nil {
			pool.Close()
			return persistenceAdapters{}, err
		}
		chunkStore = filesystem
	}
	lifecycle.Append(fx.Hook{
		OnStart: func(ctx context.Context) error {
			if err := postgresadapter.Prepare(ctx, pool); err != nil {
				pool.Close()
				return err
			}
			slog.Info("using PostgreSQL Canonical Adapter")
			return nil
		},
		OnStop: func(context.Context) error {
			pool.Close()
			return nil
		},
	})
	return persistenceAdapters{
		BatchStore: store, SnapshotStore: store, ChangeSource: store,
		ProjectionIndex: store, QueryIndex: store, DirectoryStore: store,
		RawArchive: rawarchive.NewArchive(store, chunkStore), Pool: pool,
	}, nil
}

type securityModules struct {
	fx.Out

	Authentication *authentication.Module
	Teams          *team.Module
	Cutover        *authcutover.Module
}

func provideSecurityModules(
	lifecycle fx.Lifecycle,
	config serverConfig,
	pool *pgxpool.Pool,
) (securityModules, error) {
	if config.demoMode {
		return securityModules{}, nil
	}
	registrations := make([]authentication.ProviderRegistration, 0, 1)
	if config.githubEnabled {
		adapter, err := githubauth.New(config.github)
		if err != nil {
			return securityModules{}, err
		}
		registrations = append(registrations, authentication.ProviderRegistration{
			ID: githubauth.RegistrationID, Label: "GitHub", Revision: githubauth.RegistrationRevision,
			ExpectedIssuer: githubauth.Issuer,
			CallbackURI:    config.http.APIOrigin + "/api/v1/auth/github/callback",
			Active:         true, Adapter: adapter,
		})
	}
	authenticationModule, err := authentication.New(pool, authentication.Config{
		ProviderRegistrations: registrations, PepperKeys: config.pepperKeys,
		PrivateStateKeys: config.privateKeys, Policy: authentication.DefaultPolicy(),
		RequireCompletedCutover: config.cutoverMode == authcutover.NormalMode,
	})
	if err != nil {
		return securityModules{}, err
	}
	teamModule, err := team.New(pool, team.Config{
		PepperKeys: config.pepperKeys, Policy: team.DefaultPolicy(),
	})
	if err != nil {
		return securityModules{}, err
	}
	cutoverModule, err := authcutover.New(pool)
	if err != nil {
		return securityModules{}, err
	}
	lifecycle.Append(fx.Hook{OnStart: func(ctx context.Context) error {
		switch config.cutoverMode {
		case authcutover.BootstrapMode:
			if _, err := cutoverModule.PrepareBootstrap(ctx); err != nil {
				return err
			}
			return authenticationModule.Prepare(ctx)
		case authcutover.NormalMode:
			if err := authenticationModule.Prepare(ctx); err != nil {
				return err
			}
			_, err := cutoverModule.PrepareNormal(ctx)
			return err
		default:
			return errors.New("unsupported auth cutover serving mode")
		}
	}})
	return securityModules{
		Authentication: authenticationModule, Teams: teamModule, Cutover: cutoverModule,
	}, nil
}

func provideHTTPHandler(
	config serverConfig,
	authenticationModule *authentication.Module,
	teamModule *team.Module,
	cutoverModule *authcutover.Module,
	memory *conversation.Memory,
	ingestor *ingestion.Ingestor,
	searcher *projectsearch.Searcher,
	directory *workspace.Directory,
	raw *rawarchive.Archive,
) (*httpapi.Handler, error) {
	return httpapi.NewHandler(config.http, httpapi.Modules{
		Authentication: authenticationModule, Teams: teamModule, Memory: memory,
		Ingestor: ingestor, Searcher: searcher, Directory: directory, Raw: raw,
		Cutover: cutoverModule,
	})
}

func ownProjectorLifetime(lifecycle fx.Lifecycle, config serverConfig, projector *projectsearch.Projector) {
	var cancel context.CancelFunc
	var workers sync.WaitGroup
	lifecycle.Append(fx.Hook{
		OnStart: func(ctx context.Context) error {
			if config.cutoverMode == authcutover.BootstrapMode {
				slog.Info("Search projector disabled during auth cutover bootstrap")
				return nil
			}
			for {
				count, err := projector.ProjectOnce(ctx)
				if err != nil {
					slog.Error("initial Search projection failed; ingestion remains available", "error", err)
					break
				}
				if count < 100 {
					break
				}
			}
			workerContext, stop := context.WithCancel(context.Background())
			cancel = stop
			workers.Add(1)
			go func() {
				defer workers.Done()
				projector.Run(workerContext)
			}()
			return nil
		},
		OnStop: func(context.Context) error {
			if cancel != nil {
				cancel()
				workers.Wait()
			}
			return nil
		},
	})
}

func newHTTPServer(config serverConfig, handler *httpapi.Handler) *http.Server {
	return &http.Server{
		Addr:              config.address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}
}

func ownServerLifetime(
	lifecycle fx.Lifecycle,
	shutdowner fx.Shutdowner,
	config serverConfig,
	server *http.Server,
) {
	var listener net.Listener

	lifecycle.Append(fx.Hook{
		OnStart: func(context.Context) error {
			opened, err := net.Listen("tcp", config.address)
			if err != nil {
				return err
			}
			listener = opened
			slog.Info("ATape server listening", "address", config.address)

			go func() {
				err := server.Serve(opened)
				if err != nil && !errors.Is(err, http.ErrServerClosed) {
					slog.Error("ATape server stopped unexpectedly", "error", err)
					_ = shutdowner.Shutdown(fx.ExitCode(1))
				}
			}()
			return nil
		},
		OnStop: func(ctx context.Context) error {
			if listener == nil {
				return nil
			}
			return server.Shutdown(ctx)
		},
	})
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "auth-cutover" {
		if err := runAuthCutoverCommand(context.Background(), os.Args[2:], os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "auth cutover failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "version" {
		if err := runVersionCommand(os.Args[2:], os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "version failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	slog.Info("starting ATape server", "version", releaseinfo.Version, "auth_epoch", releaseinfo.AuthEpoch)
	fx.New(
		fx.Provide(
			loadConfig,
			providePersistenceAdapters,
			provideSecurityModules,
			conversation.NewMemory,
			ingestion.NewIngestor,
			projectsearch.NewProjector,
			projectsearch.NewSearcher,
			workspace.NewDirectory,
			provideHTTPHandler,
			newHTTPServer,
		),
		fx.Invoke(ownProjectorLifetime, ownServerLifetime),
	).Run()
}
