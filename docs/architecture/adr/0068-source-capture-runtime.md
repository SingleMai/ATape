# ADR-0068: Explicit source capture runtime capability

- Status: Accepted implementation detail of ADR-0059
- Date: 2026-09-10

The scoped OpenCode reader and Host preparation Modules need a real package
boundary. Treating their draft frames as legacy observation pages would transfer
revision assignment and upload policy back to the Adapter, and could silently
change the write mode of installed Codex or Claude history.

## Interface and ownership

An Adapter manifest explicitly declares `sourceCapture: atape.source-capture.v1`.
Its factory returns the matching `sourceCapture` runtime and a required `close`.
A legacy runtime returns `collect`; declaring both, omitting the matching manifest
capability, or returning an invalid runtime is a typed contract failure. Existing
legacy Adapters retain their behavior and use the more precise legacy return type.

The source Interface has two operations: bounded discovery and opening a scoped
source view. Discovery returns proven root Origin metadata, an opaque cursor and
bounded source diagnostics. A view returns Session/Thread headers, complete target
counts and bounded draft-frame pages, plus a close operation. The shared domain
frame schema omits Host-owned revisions and Raw references. It is also used by
Host preparation, keeping this boundary aligned with the actual caller.

The foreign package Interface uses promises and AbortSignals. The Node Adapter
translates these into the application's Effect Interface, owns deadline and Scope
handling, validates headers/pages and bounds, and closes views after failure or
Scope exit. If a foreign open finishes after cancellation, the late view is closed.
Failed cleanup emits a diagnostic. View reads are single-consumer; failed, expired,
exhausted or closed views cannot supply another page. The source view's overall
read deadline uses monotonic time. Cleanup is attempted independently of an aborted
runtime signal, with a bounded wait. No retry, upload or persistence policy enters
the foreign source package.

This is a real Seam between independently installed Adapter packages and Host
orchestration. It does not add a callback solely for mocking. Presentation still
does not own collection workflows. The Collector currently rejects this capability
with an explicit scheduling-unavailable error; the private package is not enabled
by this increment. The next workflow will perform attribution and source-free
recovery before new capture work.

## OpenCode Implementation

Discovery scans at most 100 native Session IDs through the primary-key order, then
uses indexed bounded metadata reads to validate parent chains. Only roots in that
ID page are emitted. Child-only pages still advance the cursor; missing parents,
cycles and unproven creation evidence produce bounded diagnostics. This avoids a
root filter plus unbounded sort and avoids capturing an entire family once for
every child. The SQLite transaction closes before discovery returns.

Creation Origin extraction is shared by discovery and capture. The current mutable
directory never substitutes for native creation evidence. Opening a view rechecks
identity, relationships, format and bounds in a fresh read-only snapshot. The
OpenCode SDK runtime permits one open capture view, ties it to its parent lifetime,
and closes failed acquisitions. Limits remain explicit inputs.

The projection byte limit covers the complete `{frames, done}` response and view
headers. Planning reserves the worst-case page envelope before admitting each
frame; an exact-boundary frame cannot become oversized merely through SDK wrapping.
No semantic projection version changes because this alters paging, not content.

The native stable-channel location is the XDG data directory plus
`opencode/opencode.db`. `OPENCODE_DB` selects an absolute path or a name relative to
that data directory; non-stable channel databases require an explicit override.
Relative/unsupported paths and missing databases fail without creating storage.
No native executable, migration, credential lookup or network operation is used.
The location follows the fixed native
[database implementation](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/database.ts),
[global paths](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/global.ts)
and its pinned [xdg-basedir 5.1.0](https://github.com/sindresorhus/xdg-basedir/blob/v5.1.0/index.js).
This selects no supported-platform release matrix.

## Verification and remaining work

Tests use the actual native root/child/fork fixture through the OpenCode SDK and
through `AdapterRuntimes.open` loading an installed package entry, including an
independent native Node process without a test transform. They verify
bounded discovery, original Origin across moves, orphan diagnostics, frame bytes
at the exact envelope boundary, Raw-off frames, resource closure, cancellation,
late completion, invalid factory values and explicit capability selection. Existing
legacy Adapter and Collector tests continue through their original Interfaces.

Automatic scheduling, no-change detection before persistent per-record preparation,
physical metadata retention/admission, bounded Raw archive browsing and full native
mutation/Search/policy acceptance remain prerequisites for enabling OpenCode.
Simply skipping activation after preparation is insufficient: preparation has
already sealed durable membership, and reclaim currently removes payload bodies,
not all historical metadata. No package publication or deployment occurs here.
