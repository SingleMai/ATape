# Cursor native source reader

Cursor conversation sync is not enabled in ATape. The private
`adapters/cursor` package provides a native-source reader for the next capture
increment; it has no installed Adapter factory or CLI tool selection.

## Evidence and compatibility scope

The compatibility fixtures are constructed from the message and metadata shapes
in Confab's [Cursor tests at commit
8082a7a](https://github.com/ConfabulousDev/confab/blob/8082a7ab8d3195ae8fb93545508be49bc4c8f5b7/pkg/provider/cursor_test.go).
Their [provenance](../../adapters/cursor/fixtures/confab-derived/provenance.json)
marks them as synthetic. The user authorized this scope on 2026-10-10 and deferred
live Cursor verification.

Static inspection of the official Cursor CLI `2026.10.01-e373342` bundle informed
the limits below. The macOS arm64 archive SHA256 was
`629e51de43a0b7fb3b86f5ebc7e579f7df7df941b39f29e82945cde750145afc`.
Running its version/help and empty-chat command established no real conversation
fixture. No authenticated Cursor conversation or IDE acceptance was performed.
See the [official installation guide](https://cursor.com/docs/cli/installation)
for the tool itself. Static inspection and Confab-derived tests do not establish
CLI/IDE equivalence or a supported native version/platform matrix.

## Reader Interface

`discoverCursorSources` and `readCursorSource` return Effect programs with typed
failures. Callers provide an absolute state directory and explicit inventory,
page, row, source-byte, record, child-file and duration bounds. The native layout
is `projects/<workspace-slug>/agent-transcripts/<id>/<id>.jsonl`; subagent files
are excluded from root discovery. Returned source paths use the real
state-directory path.

The `sourceBytes` budget covers the transcript and all metadata files read for
one snapshot. Each metadata file is also bounded by `rowBytes` and 64 KiB. JSON
has fixed ceilings of 64 nesting levels and 100,000 structural values per row.
These are admission bounds, not a measured process-memory ceiling. Normal Effect
interruption cancels work and releases acquired filesystem handles.

Reading returns validated user/assistant message rows and `turn_ended` rows.
Message content supports text and `tool_use` name/input. Raw JSON rows, text and
tool arguments remain available for future Host preparation. The reader does
not redact or upload them. Missing native event IDs, tool call IDs and event
times remain explicitly unknown. No tool result, thinking distinction, model
or usage is inferred from absent fields.

Incomplete lines, invalid UTF-8/JSON, unsupported shapes, changed files,
duplicate root IDs, symlinks and exceeded bounds fail with typed errors. This is
a bounded snapshot Interface, with no capture checkpoint or recovery behavior.
Child paths are candidates only; they do not establish Canonical Threads.

## Project and time facts

| Native fact | Reader meaning | Capture limit |
| --- | --- | --- |
| Workspace slug | Source locator | Lossy; cannot recover the original project path |
| `meta.json` CWD | Unverified metadata candidate | Missing sidecars may be recreated from the current workspace; cannot prove original creation |
| Metadata creation/update clocks | Unverified metadata candidate | Cannot substitute for per-event occurrence or trustworthy Session time |
| Filesystem mtime | Explicit filesystem observation | Content digest does not change for mtime alone; never an event timestamp |
| Missing message/tool IDs and time | Unknown | Needs stable projection identity and unknown-time semantics before capture enablement |
| Child file location | Child candidate | Needs proven relationship before attachment to the root |

All sources keep unknown original project attribution. A configured Project,
current workspace, first Hook observation or sidecar CWD cannot be substituted
for creation evidence. No GitSource is emitted by this Module.

## Verification and next increment

The package tests exercise discovery and reads through the public Module
Interface using constructed native layouts and temporary files. They verify
content fidelity, explicit missing facts, limits, partial/unsupported input and
path safety. They do not establish installed CLI, authenticated HTTP/PostgreSQL,
Reader/Search or live Cursor capture acceptance.

```sh
pnpm --filter @atape/adapter-cursor typecheck
pnpm --filter @atape/adapter-cursor test
```

Shared unknown-time semantics now have an explicit canonical v3/publication v3
contract, nullable Reader/Search clocks and undated Overview disclosure; see
[ADR-0114](../architecture/adr/0114-explicit-unknown-conversation-time.md).
The Cursor reader still has no installed capture Interface. Next, identify a
trustworthy creation-evidence entry point, then implement
sourceCapture v2 projection/checkpoints, Host loading and the installed
Canonical/Raw/Search/redaction contract. Live Cursor CLI and IDE verification
remain outstanding before claiming native support.

The decision rationale is in [ADR-0111](../architecture/adr/0111-cursor-native-source-reader.md).
