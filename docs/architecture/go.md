# Go Server

The Go server follows the same Deep Module doctrine as TypeScript without recreating Effect abstractions. Go packages, exported methods, small interfaces, `context.Context`, explicit errors, and owned goroutines are the primary tools.

## Selected foundation

| Concern | Selection | Constraint |
| --- | --- | --- |
| Dependency graph and process lifecycle | `go.uber.org/fx` | Composition Root only |
| Cancellation and deadlines | `context.Context` | First parameter on blocking Module operations |
| Structured concurrent work | `golang.org/x/sync/errgroup` | Every goroutine belongs to an owner and cancellation tree |
| Errors | Standard `errors` plus typed domain errors | No string matching; no panic for expected failures |
| PostgreSQL access | `pgx` with `sqlc` generated queries | Generated rows do not become domain models automatically |
| Telemetry | OpenTelemetry Go | Trace deep Module operations and external Adapters |

No functional Effect emulation library is part of the server foundation.

## Suggested layout

```text
server/
  cmd/
    atape-server/          # main, Fx graph, lifecycle hooks
  internal/
    ingestion/             # deep Canonical ingestion Module
    rawarchive/            # deep Raw storage Module
    conversation/          # Session and Thread reader
    projectsearch/         # Canonical search read model
    team/                  # membership and project ownership rules
    adapters/
      postgres/
      objectstore/
      searchindex/
      httpapi/
```

Organize primarily around durable product capabilities. Do not create top-level `controllers`, `services`, `repositories`, and `models` directories that scatter one behavior across the repository.

## Module shape

A Module may expose a concrete type when behavior does not vary:

```go
type Ingestor struct {
	// private dependencies and state
}

func (i *Ingestor) ApplyBatch(
	ctx context.Context,
	batch Batch,
) (ApplyResult, error)
```

`ApplyBatch` is the Interface presented to callers even though it is not expressed with Go's `interface` keyword. Internally it may validate source identity, deduplicate Events, commit Canonical records, enqueue search projection, and advance checkpoints.

Introduce a Go interface only at a real Seam. Declare it near the consuming Module and keep it small. Constructors return concrete implementations unless a real Seam requires otherwise.

## Fx rules

Fx provides process assembly and lifecycle management; it does not define the architecture.

- Only code under `cmd/` or a dedicated bootstrap package may import `go.uber.org/fx`.
- Domain and application Modules accept ordinary constructor parameters.
- `fx.In`, `fx.Out`, and `fx.Lifecycle` must not appear in Module Interfaces.
- Lifecycle hooks start and stop HTTP servers, workers, database pools, and telemetry exporters at the outermost layer.
- A Module remains constructible and testable without an Fx container.

If the dependency graph remains small, explicit construction in `main` is acceptable. Fx must earn its place by reducing lifecycle and assembly complexity, not by hiding ordinary constructors.

## Transport separation

HTTP or RPC handlers may:

- authenticate and authorize the request;
- decode and validate transport input;
- invoke one Module operation;
- map typed results and errors to a response.

Handlers must not contain SQL, Canonical projection rules, retry policies, storage layout knowledge, or background-task coordination.

Transport DTOs, generated database rows, and domain types are distinct unless their invariants truly coincide.

## Persistence

- SQL belongs inside the owning deep Module or its private PostgreSQL Adapter.
- `sqlc` provides type-safe query code but does not define Module Interfaces.
- Transaction scope is owned by the Module operation that promises atomic behavior.
- Raw object storage and Canonical relational storage remain separate Implementations.
- Search projection is not part of the synchronous Canonical query path.
- Avoid per-table Repository Interfaces and generic CRUD Modules.

Prefer integration tests against an ephemeral real PostgreSQL instance for local-substitutable persistence. A mock database that reproduces SQL behavior poorly is not a useful Adapter.

## Concurrency and lifetime

- Pass `context.Context` from transport or worker root through every blocking call.
- Use `errgroup.WithContext` for sibling work that should cancel on failure.
- Apply explicit concurrency limits to ingestion, projection, and cleanup loops.
- Never start an unowned goroutine in a constructor.
- Every worker exposes start/stop behavior to the Composition Root and terminates on cancellation.
- Shutdown has a deadline and reports incomplete work without reading unbounded data into memory.

## Errors

Expected failure categories are typed and mapped only at the presentation edge. Examples include invalid source identity, incompatible protocol version, authorization denial, idempotency conflict, and unavailable dependency.

Wrap errors with operation context while preserving `errors.Is` and `errors.As`. Logs supplement returned errors; they do not replace them.

## Testing

- Test behavior through exported Module Interfaces.
- Use real local dependencies for PostgreSQL and filesystem-compatible storage when practical.
- Use in-memory Adapters for owned remote protocols and controlled fakes for true external systems.
- Run the same Adapter contract suite against every implementation of a Seam.
- Do not test private call ordering or generated `sqlc` code independently.
- Verify cancellation, idempotent replay, partial failure, and bounded-memory behavior as Interface guarantees.
