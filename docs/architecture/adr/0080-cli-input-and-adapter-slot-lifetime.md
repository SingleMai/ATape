# ADR-0080: CLI input and Adapter slot lifetime

Status: Accepted

## Decision

Decode CLI arguments into a discriminated command Interface before constructing
the runtime. Each command declares its accepted options and positional arity.
Handlers receive only their own input. The alternative, a shared options bag
validated in every handler, spreads grammar and permits unrelated flags to be
silently ignored. This is Presentation translation; Project and Collector rules
remain in application Modules.

Extend the existing AdapterPackages filesystem/npm Seam with preview/apply
maintenance. Installation holds a scoped lease until configuration activation;
Adapter Host holds one until the foreign runtime closes. Only new, explicitly
tracked UUID slots can be retired. Current selections, including disabled tools,
and live leases are protected. Keep one inactive installation per package by
default. Untracked legacy installations are never reclaimed automatically.

Retirement is permanent admission closure, not a temporary lock. Under the config
transaction, maintenance checks current selections and leases, creates a retirement
marker outside the installation tree, then checks leases again. The small marker
directory remains after removal so recursive deletion cannot reopen admission. New readers create their lease before checking
retirement. This ordering closes the reader/cleanup race without holding a config
lock during package import, npm, runtime execution, or recursive deletion. Deletion
occurs after the transaction and is bounded per invocation. Crashed process leases
may be reclaimed only when the OS reports that their PID is absent; ambiguous or
reused PIDs conservatively retain files. A failed sweep can be resumed.

Alternatives were age-only deletion (cannot protect long-running imports), and
an exclusive global lock held through runtime use (serializes collection and
installation and introduces stale-lock recovery). Scoped leases provide more
Leverage at the existing Seam, while filesystem ordering stays local to its Node
Implementation. Preview is the default and deletion requires `--apply`; there is
no background GC. Cleanup assumes all readers of tracked slots use this protocol;
mixed old CLI processes must be stopped before applying cleanup. Slots created
before this protocol remain untracked and retained.

## Verification and enforcement

Exercise installation, runtime open/close and maintenance through their existing
Module Interfaces on temporary real filesystems. Cover delayed imports across an
upgrade, current/in-use protection, retention, preview, stale leases and unknown
slots. Parser tests assert accepted/rejected invocations; process tests assert
invalid input exits before persistence or network activity.

A compiler-backed repository check enforces inward dependencies and rejects
runtime cycles in the CLI/Application Modules. Type-only dependencies still obey
layer boundaries but do not create runtime cycles. This is a development check,
not a new production Seam. An explicit Adapter acceptance entry reuses the
Codex/Claude CLI E2E and OpenCode Go/PostgreSQL E2E, and fails if its required
OpenCode subtest is skipped. Existing CI already runs both suites.

## Consequences

Callers gain one maintenance operation rather than filesystem policy. Parsing and
resource lifetime errors have one owner, increasing Depth and Locality. Retained
legacy/unrecognized slots and ambiguous PIDs may use disk indefinitely; review or
stop old processes before manual intervention. Canonical, Raw and Search data are
outside installation maintenance. No package publication or Server deployment is
part of this increment.
