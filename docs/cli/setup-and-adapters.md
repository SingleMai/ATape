# Local setup and Adapter management

Run `atape` to manage Projects, tools and settings in one terminal application.
The [CLI user journey](user-journey.md) describes navigation; this guide owns
configuration, supported operations and recovery.

## Before you start

Use Node.js 24 or newer and a macOS or Linux terminal for guided setup and
managed background sync. Windows, CI and non-interactive terminals are unsupported.
Broader terminal
acceptance limits are recorded in the [terminal validation record](production-terminal-validation.md).

You need access to an ATape Instance and a Team on that Instance. New users can
create or join a Team in Web onboarding during guided setup. Have a local Project
directory and history from at least one supported coding tool; installing a tool
or its Adapter alone does not create conversations.

| Tool | Source compatibility and limits |
| --- | --- |
| Codex | [Experimental rollout compatibility](../adapters/codex.md#supported-source-and-limits) |
| Claude Code | [Supported linear JSONL history](../adapters/claude.md#sources-and-supported-history) |
| OpenCode | [Accepted SQLite version/platforms and Server prerequisite](../adapters/opencode.md#supported-source-and-enablement) |

Launch the installed `atape` executable from your Project
directory. Source contributors can use `pnpm atape` from the ATape repository
instead; build/install local Adapters as shown in [Tools and Adapter packages](#tools-and-adapter-packages).

## Install the CLI

ATape's CLI is a public npm package containing one bundled `atape` executable with no workspace runtime dependencies.

```sh
npm install --global @atape/cli
atape --version
```

Checksummed GitHub Release tarballs provide an offline package source. Install a
downloaded CLI tarball with `npm install --global "./atape-cli-<version>.tgz"`,
replacing `<version>` with its release version. Offline setup also needs the
selected Adapter tarballs installed locally; browser authentication and sync
still require access to the Instance. Maintainers build and verify release
artifacts using the [release guide](../releasing.md).

## Guided setup and Project console

From the directory you want to connect, run:

```sh
atape
```

The default Instance is `https://atape.net`. For a self-hosted Instance, use
Settings → Change server with its Web origin. For the local
[authenticated Compose deployment](../operations/self-hosting.md#first-installation):

```sh
export ATAPE_DEVELOPMENT_ALLOW_HTTP=true
export ATAPE_INSTANCE_URL=http://127.0.0.1:8080
atape
```

Keep that environment setting for later sessions using this loopback Instance.
The seeded `pnpm dev:server` demo does not provide browser/CLI authentication;
use an authenticated Instance for this walkthrough.

On first use the console opens setup; after tools have been configured it opens
your Project list, even when empty. Press `n` for Add project to connect another
directory. Business subcommands are removed; every operation is inside the console.

First use configures tools globally, then offers directory browsing, browser
sign-in and Team selection when needed. Detection checks known local tool data
directories; it does not scan the disk or guarantee this Project has history.
Saving tools installs their integrations but does not connect any Project.
Review the Instance, account, Team, Project, global tools and historical import
before confirming capture and starting sync. Subsequent Projects reuse the global
tools. No Teams means Web onboarding, then Refresh; the directory remains selected.

The initial wait is bounded to 15 seconds. Waiting for a first conversation,
syncing, queued history, up to date, partial coverage and failure are distinct
outcomes. Use `r` or leave the console open for updates. Project details provide
sync details, relevant recovery and disconnection. Tools and accounts are global
flows. Tool changes preview their impact on every Project before saving and affect
subsequent cycles; an in-flight upload may finish. Stop in Settings requires a
review because it affects all local Projects. Esc returns without a duplicate
Back menu row. The cassette remains in the shared responsive header.

Use arrows and Enter to navigate, Space to select sources, Escape to go back or
cancel, and Ctrl+C to exit. Path input supports paste, Unicode, Home/End and
Ctrl+A/E/U/K. PgUp/PgDn pages long details on narrow screens. Exiting restores the
terminal and leaves the independently managed Collector running. After reboot,
open ATape and select Start sync.

Pipes, CI, Windows and `TERM=dumb` fail with exit status 2 and plain guidance.
There is no public JSON, one-shot collection or automation Interface. `--help` and
`--version` remain available without a terminal. `--lang` selects a session language;
Settings → Language saves the preference for later launches. `ATAPE_LANG` or an
explicit language flag takes precedence over the saved preference. Configuration completed before cancellation is retained.
An interrupted source installation can be retried, and confirmed directory-Project
creation retains a request key under `config/setup-requests/` to reuse the server's
idempotency contract. Existing local directory registrations are reused. These
files contain request keys, not conversation data.

## Confirm the first sync

After confirming the Project, open its details in the console. A running Collector
only confirms that a process started. Wait for acknowledged conversation capture,
then open the same Instance and Team in the Web app and inspect a Session from
that Project. Check its source and recent messages, then verify that Search opens
the expected conversation. Search uses a separate read model.

Projects shows the connected Project and destination; Tools and updates shows the
global tool selection. Project → Sync details reports each tool’s latest cycle. A healthy cycle with zero observations may simply mean no attributable
history. **Waiting** asks for a conversation in the connected repository;
**queued history** means collection is continuing; **partial** means some sources
were skipped and need inspection. See [Troubleshooting](#troubleshooting).

Raw capture is disabled by default under the default Team policy, so an absent
Raw archive does not by itself mean conversation sync failed. The
[Raw capture guide](raw-capture.md) owns the policy, settings and backfill behavior.

## Sign in
Project connection prompts for browser sign-in when needed. Settings → Accounts
also offers sign-in and sign-out for each server. The approval screen includes a
short-lived link and code; `atape --no-browser` shows them without automatically
opening a browser, including on a remote interactive terminal.

Credentials are isolated by Instance. Sign-out removes the selected local
credential even when remote revocation cannot be confirmed. Re-login durably
stores the replacement before revoking the old credential. Existing Project
bindings still require their original account.

## Configure a Project
Open ATape and choose Add project. Browse or paste a directory, resolve any missing
sign-in or Team choice, then review and confirm Connect and sync. The guide
recognizes Git repositories and ordinary folders; a Git subdirectory resolves to
its worktree root. Creating a server Project requires the connection review.

Existing repository/Team matches reuse the server Project. Reconnecting the same
Project from a different checkout updates its local locator while retaining
collection progress. Project details provide Disconnect project with default Cancel;
this affects future collection on this machine and retains server history.

## Git conversation attribution

Codex, Claude and OpenCode use the same Host attribution contract. Codex supplies the
original rollout CWD and recorded Git remote when available; Claude supplies the
original root record's CWD; OpenCode supplies immutable session-creation evidence. The Host resolves the nearest repository when needed
and asks the configured Instance to match its remote in the selected Team. The
server owns remote equivalence and repository aliases. A nested unrelated
repository is excluded even when its path is under the configured checkout.

Confirmed source evidence stays in local metadata so an established conversation
can continue after `/cd`, a changed origin or deletion of its original directory.
New conversations must establish their own attribution. Unknown historical
identity is skipped and reported as `attribution` in partial collection diagnostics;
paths alone never guess it. A known different repository is simply excluded.
Network or authentication failures fail the job without acknowledging its page.

The Collector validates source diagnostics against the shared Adapter protocol,
including `attribution`. All three First-party Adapters can therefore capture healthy
Sessions and advance their checkpoints while skipping unknown or foreign sources.
Regression coverage includes mixed-source discovery, separate Canonical and Raw
publication, and resumption without duplicate uploads. Unknown-source diagnostics
remain local partial coverage; resolving missing historical identity is separate
from this validation fix and does not require resetting captured progress.

Git collection requires a Host and Adapter declaring
`atape.git-attribution.v1`; upgrade the CLI and enabled Git Adapters together.
Incompatible packages are
rejected for Git capture before import, with upgrade guidance. Directory capture
keeps its existing contract, but a previously configured directory that is now
inside Git must be reconnected as a Git Project.

## Tools and Adapter packages
Tools and updates → Choose tools to sync manages one selection for all connected
Projects on this machine. Review additions/removals before saving. Deselecting
every tool is valid and stops future collection without removing captured history.

Added tools import attributable history and continue syncing for connected
Projects. Disabled tools retain server history and checkpoints. A plan becomes
invalid if Projects or global selection change before it is saved. Failed or
cancelled installation never partially enables tools; inert installed packages
may be reused on retry. Project setup cannot install or update tools.

ATape is still in development. One current schema stores global tool selection
and Project registrations separately. There is no configuration migration or
compatibility path for earlier development versions. The console and Collector
derive effective Project tools from the same global selection.

Tools and updates → Integration maintenance supports an npm package, local package
directory, npm tarball or HTTPS archive URL. Enter the source and confirm installation;
then Choose tools to sync controls capture. Installation alone does not enable it.
For local development, build the Adapter first, then enter its directory in this page:

```sh
pnpm --filter @atape/adapter-codex build
pnpm atape
```

Enter `./adapters/codex` from the repository root. For a release artifact, enter
its full `.tgz` path. Archives have compressed, expanded and manifest size limits;
ATape validates TAR metadata before npm installation. Lifecycle scripts remain
disabled and the installed entry is validated without import. Enabled integrations
execute inside the Collector Host; only install packages you trust.

Each installation prepares an independent package slot and activates it atomically.
Failed validation or cancellation keeps the current version usable. Running jobs
retain their existing files; later cycles load the selected version. Directories
are copied at installation. Refresh from original source picks up local edits,
fetches the same HTTPS URL again, or resolves `latest` for registry installations.
Pinned archive/URL sources remain pinned; install a new source to change them.
Concurrent changes to the same installation reject stale activation.

Official release updates appear directly in Tools and updates. Use published …
explicitly switches an official file/URL installation to the reviewed npm release.
Custom packages stay on their original source. Updates preserve capture selection,
Projects and checkpoints, and do not start stopped sync. There is no bulk update
command. Old slots can be reviewed under [cleanup](#adapter-installation-cleanup).

## Upgrade the CLI and Adapters
Open ATape → Tools and updates to inspect current/latest versions and apply each
available update. Startup also offers Upgrade and continue or Skip. Version lookup
is bounded and cached; offline lookup does not block entering the console. Check
again bypasses the successful-result cache. A failed update offers retry.

The built-in CLI update supports the active npm global installation, verifies the
installed version, and restarts the application after terminal teardown. Previously
running sync resumes with its settings; stopped sync stays stopped. Development
builds and other package managers receive guidance instead of an inferred target.
If sync cannot resume, use Resume sync and continue or return with sync stopped.

For direct npm/tarball replacement, stop sync in Settings, exit ATape, install the
replacement using npm, then reopen ATape and select Start sync if it was previously
running. Restart older Collectors before using newer Adapter package slots. Verify
the CLI version in Tools, update integrations there as needed, and inspect Project
sync results. Installing a new version is not proof of successful conversation sync.

## Run collection
Connect and sync starts the managed background Collector. Home offers Start sync
when stopped; Settings offers Stop sync for all projects with an impact review.
Exiting ATape leaves this process running. After reboot, open ATape to resume it.
Public foreground collection, scheduler commands and tuning flags are removed.

The Collector continues bounded catch-up cycles while pages remain and waits
30 seconds by default when caught up or after failures. It runs at most four
Project/Adapter jobs concurrently by default. Project details report each tool’s
last result and bounded counters without conversation bodies. Status refresh is
read-only and does not force a collection cycle.

Git Project matching and ingestion each allow at most three attempts for transient
failures. Matching retries network failures, HTTP 429 and 5xx responses; it never
turns an unavailable authority into an unknown/excluded source. Delays use
exponential backoff with jitter (0.5–1 seconds, then 1–2 seconds), respect a longer
`Retry-After`, and cap each wait at 60 seconds. Authentication, permission and
invalid response failures are not retried by matching. Cancellation interrupts
requests and retry waits. After attempts are exhausted, the ordinary cycle delay
applies and unacknowledged data remains eligible for replay.

The authenticated HTTP Adapter writes bounded operation diagnostics to the
background log: operation, failure category, known network error code and elapsed
time, or HTTP status and retry delay. It omits request bodies, destinations,
credentials and raw exception messages. These log entries remain after a later
successful cycle replaces the current status. Git attribution network failures
are reported as `transport`, rather than as Adapter parsing failures. Unknown
network causes remain explicit; the next diagnostic increment is correlating
client failures with server traces before tuning deadlines or upload concurrency.

Every Canonical and Raw upload verifies the Project's bound account against the
current credential. Switching accounts during a cycle stops further delivery;
sign back in with the original account to resume unacknowledged work. Confirmed
Canonical history remains visible after idle cycles even when Raw capture is off.
The interactive console reads captured scope metadata once per refresh for all
enabled Project/Adapter pairs; it does not read conversation bodies or journals.
Older Raw-off checkpoints without a confirmed-history flag gain it after their
next acknowledged Canonical upload. The CLI does not infer publication from an
opaque cursor or reset collection progress to manufacture that evidence.

For the Codex/Claude paged observation runtime, each page follows this commit order:

1. Validate the Adapter output and apply client-side secret redaction.
2. Commit each Canonical Session observation and receive its stable server Session ID.
3. Redact each complete Adapter Raw segment, divide it into bounded 3 MiB transport chunks, and append them through the separate Raw endpoint.
4. Persist the source/server offset after every complete Adapter segment while leaving the Adapter cursor unchanged.
5. Atomically advance the opaque Adapter cursor only after the complete page succeeds.

If Raw fails after Canonical succeeds, the cursor remains unchanged. The next cycle replays the Canonical batch, skips Raw source bytes already recorded in the local progress checkpoint, and resumes at the first unacknowledged segment. If the server accepted a segment immediately before the client lost power, its deterministic identity makes that final replay safe. Source deletion never sends a delete to ATape.

OpenCode uses the bounded source-capture capability. The Host prepares and freezes
one complete Canonical target, then activates it atomically. Raw acknowledgements
and recovery are independent; unresolved delivery reads the frozen journal without
reopening the source. Source deletion cannot reset the selected history. See the
[OpenCode guide](../adapters/opencode.md) for the exact supported source matrix,
source paths, default admission and required Server publication capability.

## Local state

All default client data lives below `ATAPE_HOME`, which defaults to `~/.atape`:

- Credentials: `~/.atape/credentials/`
- Configuration: `~/.atape/config/client.json`
- Collector checkpoints, process metadata, and status: `~/.atape/state/`
- Account-bound Source capture journals: below `~/.atape/state/collector.json.captures/`, with `collector.json.capture-installation.json` binding metadata
- Git attribution evidence: beside the Collector state file, in `<state-file>.git-attribution/`
- Background logs: `~/.atape/logs/collector.log`
- Adapter packages: `~/.atape/adapters/`

`ATAPE_HOME` relocates the whole layout. Individual `ATAPE_CONFIG_FILE`, `ATAPE_COLLECTOR_STATE_FILE`, `ATAPE_COLLECTOR_PROCESS_FILE`, `ATAPE_COLLECTOR_STATUS_FILE`, `ATAPE_COLLECTOR_LOG_FILE`, and `ATAPE_ADAPTER_DIRECTORY` overrides remain available for development. Credentials use opaque per-Instance filenames, owner-only directories/files, no-follow reads, compare-and-swap updates, and fsynced atomic replacement. Local filesystem paths remain client state and are not part of server Project, Canonical, Raw, or Search payloads.

The JSON checkpoint file stores installation identity, opaque progress and Raw
receipts, never conversation bodies. Codex/Claude replay through an unadvanced
cursor after a failed upload. OpenCode instead retains only bounded, final masked
pending content in the separate account-bound capture journal. Preserve its binding
and files with Collector state; deleting them is not a supported reset. Resolved
payloads are reclaimed while identity and receipt evidence remains.

Git attribution evidence contains source identifiers, original CWD and remote,
never conversation bodies or upload acknowledgements. Preserve it with Collector
state; losing it can make history unattributable when its original checkout is
gone and the provider did not record a remote. Saved remotes are matched against
the server again during collection.

The redactor covers common credentials and environment values whose names end in `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `DATABASE_URL`, or `DSN`. Add exact values with a JSON array in `ATAPE_REDACT_VALUES`. Identity fields are stable and are not rewritten, so Adapter authors must never place secrets in IDs.

The executable package contract is documented in [Adapter package and runtime contract](../adapters/package-manifest.md). Provider-specific behavior is documented in the [Codex](../adapters/codex.md), [Claude](../adapters/claude.md) and [OpenCode](../adapters/opencode.md) guides.

## Troubleshooting
Start with Project → Sync details. PgUp/PgDn pages all diagnostics retained in the
local report; when source failures were truncated by collection, the page says so.
Background operation history remains in `~/.atape/logs/collector.log` (or the
configured log path). The page does not force a new collection cycle.

| Symptom | Next action |
| --- | --- |
| No Team or wrong destination | Open Web onboarding, create/join a Team, then Refresh in ATape. Review the Instance, account and Team before connecting. |
| No jobs or waiting for history | Check Projects and Choose tools to sync. Create a supported conversation inside the connected repository. Detection alone is not proof of readable history. |
| Partial capture / attribution | Review skipped sources and the [Git rules](#git-conversation-attribution). Restore trustworthy source evidence when possible; resetting progress cannot infer identity. |
| Authentication failure | Use Sign in again and resume on the affected Project. Another account cannot adopt its existing binding. |
| Transport failure | Check Instance reachability and Sync details or the background log. Managed sync retries automatically. |
| Unsupported source or capability | Follow the Adapter guide and update CLI/integrations in Tools. Missing Server capabilities require the operator’s [OpenCode rollout](../operations/opencode-rollout.md). |
| CLI updated but sync stopped | Use Resume sync and continue, or open ATape with the same state directory and select Start sync. |
| Missing/corrupt state or full disk | Preserve [local state](#local-state), bindings and journals. Free unrelated disk space or restore a consistent backup; do not reset checkpoints. |
| Raw archive absent | Check [Raw policy](raw-capture.md); Canonical and Raw acknowledgements are separate. |

## Implementation boundaries

Interactive setup uses the `decideProjectSetup` Interface
for Team defaults, exact matching and creation consent. Applying a selection still
revalidates account, local directory and remote Project state. Tool configuration
and reader maintenance live in `toolManagement`; `projectAccess` owns registration
and account checks. Interactive navigation stays in the Presenter, whose screen
union requires options, input values and tool selections for the appropriate kind.
Typed recovery actions replace inspection of arbitrary failure fields.

The Collector scheduler owns job concurrency, continuation and report aggregation.
`collectionJob` owns the scoped Adapter runtime and dispatches to `legacyCollector`
or `SourceCaptureCollector`. Shared contracts and preparation no longer import the
scheduler. Source collection is an explicit Effect requirement supplied with
validated admission by the Node Composition Root. Both protocols retain their
checkpoint, account binding, redaction and independent Raw delivery behavior.

Node configuration, package installation, project location, Adapter hosting,
checkpoint persistence and legacy transport each have a cohesive Implementation;
`clientLayers` and `collectorLayers` assemble these existing Seams. No additional
plugin registry, runtime or package boundary was introduced. See
[ADR-0079](../architecture/adr/0079-cli-module-boundaries.md).

The parser accepts only the application launch, help/version, session options and
the token-bound internal Collector entry. Removed business commands, unknown options,
duplicate flags and extra positionals fail with exit status 2. There are no aliases
or hidden compatibility handlers. See [ADR-0081](../architecture/adr/0081-single-interactive-cli-entry.md).

`pnpm check:architecture` enforces Application/Domain/UI boundaries, prevents CLI
imports of private provider code, and checks runtime cycles across the governed
production Modules. It parses source with the pinned TypeScript compiler, including
type imports, re-exports and dynamic imports. Type-only edges obey layer rules but
do not form runtime cycles. `pnpm check` runs it in CI.

## Adapter installation cleanup
Tools and updates → Integration maintenance → Clean up old integration versions
previews eligible slots. Removal requires confirmation with default Cancel and
rechecks eligibility through the same application Module. The UI retains one
inactive installation per package in addition to current/in-use versions. Each
pass removes at most 32 slots; review another pass if more remain.

A retired
slot can no longer admit new runtimes, and interrupted removal can resume. Small
retirement markers outside the deleted trees remain to keep admission closed.

Preparation holds a lease until configuration activation. Runtime leases remain
until the Adapter closes, so delayed imports continue using their original files
across upgrades. A process lease is considered stale only when its PID no longer
exists. Ambiguous ownership conservatively retains files. Current configuration
protects installed tools even if capture is disabled. No Canonical, Raw, Search,
credentials or Collector state is removed.

Only slots created with the new tracking protocol are eligible. Legacy shared npm
trees, older untracked slots, malformed metadata and symlinks are retained. There
is no automatic background cleanup. Stop CLI/Collector processes from older builds
that do not implement leases before applying cleanup against tracked slots.

## Adapter acceptance

Run `pnpm test:adapter-contracts` to exercise all three installed provider paths.
It requires Docker, Go, Node and the installed workspace dependencies.

| Adapter | Real integration boundary | Main coverage |
| --- | --- | --- |
| Codex | CLI/daemon → real Go HTTP APIs with demo storage | Native history, child Threads, finalized history, Raw, Search, daemon start/stop |
| Claude | CLI → real Go HTTP APIs with demo storage | Native discovery, incremental changes, conversation, Raw, Search |
| OpenCode | Installed package/daemon → real Go HTTP APIs and PostgreSQL | Native SQLite, edits/reverts/forks, Raw policy, lost receipts and recovery, provenance/Search, installed upgrade/restart |

OpenCode's existing test lives under Server HTTP integration tests. The new
`pnpm test:opencode-contract` entry runs that same named subtest and fails if it is
missing or skipped. `pnpm test:go:integration` runs the complete existing PostgreSQL
suites with the same mandatory OpenCode assertion. CI retains Codex/Claude coverage
in `pnpm check` and OpenCode in its PostgreSQL step; it does not run duplicate suites.

Remaining work: the Presenter still owns navigation for all interactive flows;
extract flows when they develop independent state. Old untracked installation
slots require deliberate manual review, and mixed old/new CLI readers are outside
the lease protocol. See [ADR-0080](../architecture/adr/0080-cli-input-and-adapter-slot-lifetime.md).
