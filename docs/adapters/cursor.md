# Cursor controlled creation and capture

The checkout provides an experimental Cursor Adapter with controlled new-session
creation and sourceCapture v2. It is included in local release artifacts as
`@atape/adapter-cursor`. This does not establish npm publication or live Cursor
support: acceptance uses constructed Confab fixtures and a synthetic native
executable. Authenticated Cursor CLI and IDE verification remain outstanding.

## Evidence and compatibility scope

Fixtures derive from Confab's [Cursor tests at commit
8082a7a](https://github.com/ConfabulousDev/confab/blob/8082a7ab8d3195ae8fb93545508be49bc4c8f5b7/pkg/provider/cursor_test.go).
Their [provenance](../../adapters/cursor/fixtures/confab-derived/provenance.json)
marks them as synthetic. The user authorized this scope on 2026-10-10 and deferred
live Cursor verification.

Static inspection of Cursor CLI `2026.10.01-e373342` informed the selected native
profile. The macOS arm64 archive SHA256 was
`629e51de43a0b7fb3b86f5ebc7e579f7df7df941b39f29e82945cde750145afc`.
Version/help and empty-chat execution supplied no authenticated conversation
fixture. These records establish neither an official stable schema nor CLI/IDE
or platform equivalence. See the [official installation guide](https://cursor.com/docs/cli/installation)
for Cursor itself.

## Start an attributable conversation

Use an updated ATape bootstrap, a macOS/Linux interactive terminal, an installed
Cursor Adapter and an existing connected Project. Enable Cursor under Tools and
background sync in the ATape console. The installed Cursor native executable
must report the selected version. Configure its absolute path explicitly; ATape
does not infer the executable named `agent`.

```sh
export ATAPE_CURSOR_EXECUTABLE=/absolute/path/to/cursor-agent
atape start --tool cursor
```

The optional `--project <id>` disambiguates a Git Project, and `--prompt <literal>`
supplies the initial prompt. A prompt is limited to 64 KiB UTF-8 with no NUL;
empty text is retained. `atape start --help` works without a terminal. An older
npm bootstrap cannot learn the new grammar by delegating to a newer managed
runtime; update that bootstrap first. Public collect, JSON management and
arbitrary native arguments are not added.

ATape resolves the actual canonical launch directory, current account, Team,
permissions and Project before opening the native session. One registered folder
covering that directory uses its own Instance. Multiple covering registrations
fail, including when `--project` is supplied. Git selection uses the active
Instance and remote matching when no folder registration covers the directory.
The Host freezes that choice and rechecks it immediately before recording an
attempt; a concurrent change fails rather than silently choosing another Project.

Native root resolution is explicit:

| Root | Resolution |
| --- | --- |
| Config | Nonblank `CURSOR_CONFIG_DIR`, otherwise nonblank `XDG_CONFIG_HOME` plus `/cursor`, otherwise `~/.cursor` |
| Data | Nonblank `CURSOR_DATA_DIR`, otherwise `~/.cursor` |

This first profile requires absolute roots resolving to the same directory.
Relative and split roots are unsupported. Set both native variables to the same
absolute directory when overriding defaults. Controlled start may initialize a
missing root; discovery is read-only and treats a missing root as empty. ATape
passes the frozen roots only in the child's environment and uses the actual
launch directory. It does not pass `--workspace`, whose native saved mapping may
redirect the directory.

A fresh UUID and bounded absence checks precede native exclusive chat creation.
The fixed launch disables native auto-update and supplies the new session ID.
Resume/continue, workers and arbitrary native options are not accepted. Spawn,
printed UUID, mutable metadata and exit zero alone do not confirm creation.
The Host confirms an immutable local receipt only after the Adapter reads a
stable, valid, nonempty complete transcript at the expected source path while
the owned child is alive, or after its successful normal final exit. Failed or
cancelled attempts without proof are abandoned; a pending crash record cannot
later be adopted from a resumed chat. Once confirmed, a later failed turn does
not revoke the receipt.

Creation evidence assumes a cooperating native executable and local processes.
It does not authenticate against a local process deliberately racing to claim
the fresh UUID and write a matching transcript before the native child reports
failure. The selected CLI has no public creation handshake for that threat.

The terminal state is restored after the complete scoped operation releases its
resources. Cancellation terminates and joins the immediate native child.
Cleanup of arbitrary native tool grandchildren after parent-only cancellation
remains a live acceptance limit. A user can idle before the first message;
individual proof reads and retry delays are bounded, with no total first-message
deadline. Permanent proof failure stops attribution monitoring without killing
an otherwise running chat, and is reported after native exit.

## Capture, project and time facts

Only sources with an exact confirmed Host receipt are admissible. The receipt
binds Adapter, state root, source ID, native profile, expected transcript path and
immutable creation origin. The usual Host membership and permission checks still
apply. Unattributed historical sources are skipped with bounded local diagnostics;
ATape does not assign them to whichever Project is currently open.

| Native fact | Meaning and capture behavior |
| --- | --- |
| Workspace slug | Lossy locator; never original Project evidence |
| Metadata CWD or clocks | Unverified candidates; never creation proof or conversation time |
| Filesystem mtime | Observation only; no Canonical time or identity |
| Missing message/tool IDs | Stable identities derived from physical row and part positions, with partial fidelity |
| Missing event/Session clocks | Canonical v3 explicit null; Reader/Search show unknown time |
| `tool_use` | Name/input and derived call ID; no invented status, result, output or model |
| `turn_ended` | Preserved in Raw; does not prove Session completion |
| Child files | Unsupported relationship diagnostics; no fabricated Thread topology |

Text, including `user_query` wrappers, is preserved. A complete short first user
text may supply the title; longer text uses a fixed fallback rather than cutting
a secret before Host redaction. One root Thread is emitted, with an idle partial
Session and no invented Usage. Raw, when enabled, supplies complete parsed native
row objects including unknown fields for the shared Host's recursive redaction.
It is not a byte-identical original-file archive. The Adapter neither redacts nor
persists plaintext provider drafts before Host preparation.

The Server must advertise `atape.publication-target.v3` and implement the
[unknown-time contract](../architecture/adr/0114-explicit-unknown-conversation-time.md),
including its nullable storage migration. A legacy Server fails capability
negotiation before publication rather than receiving fabricated dates. Merging
code does not deploy that Server or run a production migration.

## Continuity and bounds

The checkpoint is a bounded content-prefix proof, not a list of remembered Event
IDs: source ID, receipt origin key, physical rows, bytes and SHA256. First capture
checks the receipt prefix; subsequent captures check both receipt and acknowledged
prefixes against the same stable source bytes. Any number of append cycles,
touches and byte-identical rewrites preserve identities. Nonprefix rewrite,
truncation or compaction is refused with the previous published head and
checkpoint preserved. There are no numbered compaction special cases.

Constructed fixtures do not prove that Cursor leaves a complete LF row immutable
during streaming. If native Cursor updates an already confirmed assistant row,
this conservative check also refuses that update. `turn_ended` is not treated as
a commit boundary. This compatibility question requires a real native sample.

The reader exposes `discoverCursorSources` and `readCursorSource` as bounded
Effect operations. It hides traversal, no-follow path validation, UTF-8/JSON,
metadata lookup and file lifetime. Discovery isolates individual bad sources and
excludes all duplicate ID claimants while healthy sources continue. Optional
metadata failures do not invalidate an unrelated selected transcript. Global
inventory limits and an untrustworthy root still fail.

Default admission budgets are 1 MiB per row, 64 MiB aggregate source bytes,
100,000 inventory entries/records, discovery pages of 100, 120 seconds per
operation, 32 diagnostics, metadata at most 64 KiB, frames of 500 Events and tool
input at most 64 KiB. JSON depth/value ceilings are 64/100,000. Caller limits can
be smaller. These are admission budgets, not measured peak memory. Completed
rows and tail budgets are checked before an unfinished trailing row is classified
for retry; malformed complete rows remain errors.

## Verification and remaining work

```sh
pnpm --filter @atape/adapter-cursor typecheck
pnpm --filter @atape/adapter-cursor test
pnpm --filter @atape/adapter-cursor verify:package
pnpm test:cursor-contract
```

The contract uses real packed CLI/Adapter artifacts, public `atape start` through
a PTY, an external synthetic native executable and authenticated HTTP/PostgreSQL.
Its required named test is `controlled Cursor start and capture`. The fake writes
native facts only; the installed Host must create the receipt. Coverage includes
unknown history, null Reader/Search time, actual Raw redaction, append/no-op,
nonprefix preservation and frozen recovery after activation response loss and
source deletion. Package and PTY checks do not establish real native acceptance.

Real authenticated Cursor CLI/IDE samples, streaming rewrite semantics, native
version/platform coverage, historical creation evidence, child relationships,
compaction continuity and arbitrary tool-descendant cleanup remain outstanding.
Current decisions are [ADR-0111](../architecture/adr/0111-cursor-native-source-reader.md),
[ADR-0114](../architecture/adr/0114-explicit-unknown-conversation-time.md) and
[ADR-0116](../architecture/adr/0116-controlled-cursor-creation.md).
