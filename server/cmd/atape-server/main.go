package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/SingleMai/ATape/server/internal/adapters/httpapi"
	"github.com/SingleMai/ATape/server/internal/adapters/memoryraw"
	"github.com/SingleMai/ATape/server/internal/adapters/memorysearch"
	postgresadapter "github.com/SingleMai/ATape/server/internal/adapters/postgres"
	"github.com/SingleMai/ATape/server/internal/adapters/rawchunks"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/ingestion"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"github.com/SingleMai/ATape/server/internal/rawarchive"
	"github.com/SingleMai/ATape/server/internal/workspace"
	"go.uber.org/fx"
)

type serverConfig struct {
	address      string
	databaseURL  string
	rawDirectory string
	demoMode     bool
}

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
	config := serverConfig{
		address: address, databaseURL: os.Getenv("ATAPE_DATABASE_URL"),
		rawDirectory: os.Getenv("ATAPE_RAW_DIRECTORY"), demoMode: demoMode,
	}
	if config.databaseURL == "" && !config.demoMode {
		return serverConfig{}, errors.New("ATAPE_DATABASE_URL is required unless ATAPE_DEMO_MODE=true")
	}
	return config, nil
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
}

func providePersistenceAdapters(lifecycle fx.Lifecycle, config serverConfig) (persistenceAdapters, error) {
	if config.databaseURL == "" {
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
		RawArchive: rawarchive.NewArchive(store, chunkStore),
	}, nil
}

func ownProjectorLifetime(lifecycle fx.Lifecycle, projector *projectsearch.Projector) {
	var cancel context.CancelFunc
	var workers sync.WaitGroup
	lifecycle.Append(fx.Hook{
		OnStart: func(ctx context.Context) error {
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
	var root http.Handler = handler
	if config.demoMode {
		root = http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			method := authentication.WebAuthentication
			if request.Method == http.MethodPost {
				method = authentication.CLIAuthentication
			}
			principal := authentication.Principal{UserID: canonical.DemoUserID, Method: method}
			handler.ServeHTTP(response, request.WithContext(httpapi.WithPrincipal(request.Context(), principal)))
		})
	}
	return &http.Server{
		Addr:              config.address,
		Handler:           root,
		ReadHeaderTimeout: 5 * time.Second,
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
	fx.New(
		fx.Provide(
			loadConfig,
			providePersistenceAdapters,
			conversation.NewMemory,
			ingestion.NewIngestor,
			projectsearch.NewProjector,
			projectsearch.NewSearcher,
			workspace.NewDirectory,
			httpapi.NewHandler,
			newHTTPServer,
		),
		fx.Invoke(ownProjectorLifetime, ownServerLifetime),
	).Run()
}
