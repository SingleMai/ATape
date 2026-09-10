# ADR-0063: OpenCode scoped source views

- Status: Accepted implementation detail of ADR-0058 and ADR-0059
- Date: 2026-09-10

The Collector needs a complete source comparison before freezing a replacement
target. Provider state may change between pages, and complete source JSON must
not enter the Raw-off preparation path as a future archive cache.

## Decision

Keep SQLite compatibility and read consistency in the OpenCode Adapter Module.
Its initial source Interface consists of `discoverOpenCodeSessions` and scoped
`openOpenCodeSource`. Discovery pages native Session IDs, including children;
opening any ID follows its proven parent chain to the root and discovers that
root's bounded family. A fork with no parent remains its own root. Missing
parents, cycles, unresolved revert boundaries and inconsistent part ownership
fail explicitly. No title, path similarity or task reference grants ownership.

The Implementation opens an existing explicit database path read-only, disables
extensions and trusted schema execution, and sets query-only mode. It never
creates or migrates a source, changes its journal mode, invokes a provider CLI,
opens a model or reads credentials. One scoped transaction covers schema probing,
family resolution, admission and all record pages. Closing or failing a view
requires a fresh capture; there is no persistent source-page cursor for stitching
newer data into old preparation. The Host must close the scope before content
delivery and must abandon unsealed staging if preparation fails.

Probe actual table columns, primary identities and usable indexes, rather than
assuming compatibility from a database path or version string. The selected
profile reads v1 `session`, `message` and `part`. Nonempty `session_message` in
the chosen family means v2 or mixed history and fails as unsupported. Missing
history, unknown schema and an empty supported family remain distinct outcomes.
The initial evidence is OpenCode 1.18.30; this does not declare support for every
earlier/later version or silently fall back to exports or legacy JSON files.

Record traversal visits each Session, then messages ordered by native
`(time_created,id)`, then each message's parts ordered by native ID. Session
family order is deterministic parent-before-child. Revert boundaries are
validated and returned; source reads preserve stored rows including withdrawn
suffixes and compacted tool content. Active Path and Canonical projection belong
to the subsequent Adapter projection increment, not the source cursor.

## Bounds and Raw policy

Every source view requires explicit row bytes, encoded page bytes, page rows,
total records, Threads and duration limits. Metadata/index probes are bounded;
indexed preflight admission counts at most the remaining record budget plus one.
Source text byte lengths are checked in SQLite before returning values to
JavaScript. One row is loaded at a time; pages include array encoding overhead,
and at most one bounded row is held for the next page. Completion checks consumed
records against the admitted count, so malformed ordering keys cannot silently
produce complete absence. Session metadata has a separate 16 KiB per-row ceiling,
bounded identifier/title/path fields and a maximum 1,000-Thread family.

Raw-off queries return only selected projection fields. They exclude full source
JSON, unrelated Session metadata and open part metadata. Raw-on additionally
returns complete actual row columns, retaining JSON TEXT as original text for
the Host's versioned observation envelope. Unknown legal text columns/JSON fields
are preserved; unsupported SQLite value types fail. Neither mode writes source
content to disk. Host validation, redaction and final wire encoding remain required
before journal append; source output is not a prevalidated upload.

An oversized row fails the whole source view in this increment, preserving any
previous published coverage. It is never truncated into a successful replacement
or mistaken for an archived record. Fine-grained Raw gap projection and release
capacity defaults remain later Host/acceptance work. Logical read limits and a
2 MiB SQLite page cache are not a total process-memory or physical-I/O guarantee.
The deadline is checked around synchronous queries/page work; it does not interrupt
a single SQLite system call. Scoped release handles cancellation and closes the
snapshot. Production WAL pressure and capacity/deadline measurements remain gates.

## Interface alternatives and validation

A whole-session export/hydration Interface would put unbounded history in memory
and require extra output/encoding recovery. Reopening SQLite for each persistent
cursor page would combine observations across source changes. A scoped bounded
record reader hides provider indexes, consistency and relationship checks in one
Implementation and gives the Host Leverage without another mock-only Seam.
The source is local-substitutable; tests use actual temporary SQLite through the
public Interface. No storage repository abstraction or test callback is introduced.

Tests cover family/fork identity, metadata filtering, exact Raw text, concurrent
updates/deletion, malformed order/relationships, unsupported/mixed storage, bounds
and scope closure. A selected native fixture reproduces official export parity;
a direct run on the retained official database independently matched 3 Sessions,
9 messages and 11 parts. This private workspace package is not installable through
the CLI and has no release artifact, runtime capability or scheduler registration.
