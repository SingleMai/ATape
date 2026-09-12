# Local setup and Adapter management

The [CLI user journey](user-journey.md) describes interactive setup and the
Project console. This guide documents configuration and the explicit command Interface.

The ATape CLI keeps capture authorization explicit and local. `setup` records which Git repositories or ordinary directories may be observed, Adapter commands manage independently installed Harness integrations, and `collect` runs the bounded upload workflow.

## Before you start

Use Node.js 24 or newer and a macOS or Linux terminal for guided setup and
managed background sync. Windows supports explicit foreground collection; the
interactive console and managed process are unavailable there. Broader terminal
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

Commands below use the installed `atape` executable and can run from your Project
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
`atape --instance https://atape.example` with its Web origin. For the local
[authenticated Compose deployment](../operations/self-hosting.md#first-installation):

```sh
export ATAPE_DEVELOPMENT_ALLOW_HTTP=true
atape --instance http://127.0.0.1:8080
```

Keep that environment setting for later commands using this loopback Instance.
The seeded `pnpm dev:server` demo does not provide browser/CLI authentication;
use an authenticated Instance for this walkthrough.

On first use the console opens setup; after tools have been configured it opens
your Project list, even when empty. `atape setup [directory]` opens the same guide
to add another Project. Explicit command flags such as `--team`,
`--create` and `--json` retain the command workflow below.

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
`atape start` resumes collection manually.

Pipes, CI, Windows and `TERM=dumb` get plain guidance; use explicit commands and
JSON for automation. Configuration completed before cancellation is retained.
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

```sh
atape projects list --json
atape tools list --json
atape status --json
```

The first command identifies the connected Project and destination; the second
shows the global tool selection. Status reports each Project/Adapter's latest
cycle. A healthy cycle with zero observations may simply mean no attributable
history. **Waiting** asks for a conversation in the connected repository;
**queued history** means collection is continuing; **partial** means some sources
were skipped and need inspection. See [Troubleshooting](#troubleshooting).

Raw capture is disabled by default under the default Team policy, so an absent
Raw archive does not by itself mean conversation sync failed. The
[Raw capture guide](raw-capture.md) owns the policy, settings and backfill behavior.

## Sign in

The CLI uses the Instance's browser login. It opens a short-lived approval page and also prints a six-character code so a headless terminal can finish the same flow:

```sh
atape login
atape login --instance https://atape.example
atape login --no-browser
```

Instance selection is `--instance`, then `ATAPE_INSTANCE_URL`, then the last successfully selected Instance, then `https://atape.net`. Production credentials are sent only to a freshly rediscovered, exactly pinned HTTPS API origin; redirects and discovery drift fail closed. Plain HTTP requires `ATAPE_DEVELOPMENT_ALLOW_HTTP=true` and an all-loopback topology.

Credentials are isolated by Instance. `atape logout [--instance ...]` removes the selected local credential even when remote revocation cannot be confirmed. Re-login durably stores the replacement before revoking the old credential.

## Configure a Project

After sign-in and global tool configuration, run setup from a Project directory:

```sh
atape setup --team acme-engineering --create
```

Configure global tools, then provide a directory and Instance explicitly:

```sh
atape tools configure --adapter codex
atape tools configure --adapter codex --apply
atape setup ../payments-api \
  --instance https://atape.example \
  --team acme-engineering \
  --create
```

The User, Team, and Project authority always comes from the authenticated server; the CLI has no flags that let callers assert those identities. The default `--type auto` behavior promotes a path inside a Git worktree to the repository root, reads its `origin`, and searches every visible Team for an exact repository match. One exact match is attached automatically. With no match, unattended setup requires `--create`; a single available Team can be selected automatically, while multiple possible Teams require `--team`. Git repositories always use repository identity, including worktrees and independent clones. `--type directory` is accepted only outside Git. `--type git` rejects paths outside a Git worktree or without an origin remote; fix the remote before continuing.

The examples create a new Project. If the repository already has an exact match,
omit `--create` to attach it; explicit creation rejects an existing match. Replace
`acme-engineering` and `../payments-api` with your Team slug and directory. Explicit
setup records the Project; run `atape start` afterwards to begin managed sync.

Each local Project stores its verified Instance, User, Team, server Project, type, and resolved path; Git setup also stores the server repository identity. The path never crosses the HTTP boundary as identity. Repeating an identical setup is idempotent. Repeating Git setup from another checkout of the same Project updates the local path and verified display metadata while preserving enabled sources and collection progress. Tools are derived from the global selection; Project setup has no tool override. To change Project identity, remove the local Project and set it up again:

```sh
atape projects list
atape projects remove "<project-id>"
```

Replace `<project-id>` with the `id` returned by `projects list`, not the display name or directory basename. Removal only changes this machine's configuration. It never deletes conversation history already captured by the ATape server.

## Git conversation attribution

Codex, Claude, OpenCode and CodeBuddy use the same Host attribution contract. Codex supplies the
original rollout CWD and recorded Git remote when available; Claude supplies the
original root record's CWD; CodeBuddy supplies its first native user record's ID and CWD; OpenCode supplies immutable session-creation evidence. The Host resolves the nearest repository when needed
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

The Tools screen manages one selection for all connected Projects on this
machine. The equivalent commands preview changes unless `--apply` is explicit:

```sh
atape tools list --json
atape tools configure --adapter codex --adapter claude --json
atape tools configure --adapter codex --adapter claude --apply --json
atape tools configure --none --apply
```

The `--adapter` list is the complete desired selection, not an append operation.
Check `tools list` first and include any enabled tools you intend to keep.
`--none --apply` disables all tools for every connected Project.

Added tools import attributable history and continue syncing for connected
Projects. Disabled tools retain server history and checkpoints. A plan becomes
invalid if Projects or global selection change before it is saved. Failed or
cancelled installation never partially enables tools; inert installed packages
may be reused on retry. Project setup cannot install or update tools.

ATape is still in development. One current schema stores global tool selection
and Project registrations separately. There is no configuration migration or
compatibility path for earlier development versions. Commands and the Collector
derive effective Project tools from the same global selection.

An Adapter may come from the npm registry, a local package directory, an npm `.tgz` archive, or an HTTPS archive URL such as a GitHub Release asset:

```sh
atape adapters install @atape/adapter-codex
atape adapters install ../atape-adapter-custom
atape adapters install "./release/atape-adapter-codex-<version>.tgz"
atape adapters install "https://github.com/SingleMai/ATape/releases/download/v<version>/atape-adapter-codex-<version>.tgz"
```

Replace `<version>` with the coordinated release version. While developing this
repository, build and install its first-party Codex Adapter directly from the repository root:

```sh
pnpm --filter @atape/adapter-codex build
pnpm atape adapters install ./adapters/codex
```

Local and remote archives are read with explicit compressed, expanded, and manifest size limits. ATape streams their TAR structure and validates `package/package.json` before asking npm to install them; it never extracts the archive itself. Every installation disables npm lifecycle scripts and validates the installed entry without importing it. A package must therefore contain ready-to-run output. Installing an Adapter does not start a process, though enabling it means its code will execute later inside the Collector Host.

The Collector Host loads globally enabled Adapters for each connected Project.
There is no persistent sidecar per installed Adapter.

Upgrade one Adapter or all installed Adapters:

```sh
atape adapters upgrade codex
atape adapters upgrade --all
```

The interactive `Tools and updates` page shows current/latest versions and updates
official integrations without requiring these commands. For an official package
installed from a local file or URL, `Use published …` explicitly switches to the
reviewed npm release; custom publisher packages stay on their original source.
This does not enable additional tools or start stopped sync.

Each installation prepares an independent package slot, validates it, then selects
it with an atomic configuration update. Failed validation or cancellation keeps
the current version usable. Running collection retains its existing package files;
later cycles load the selected version. Local directories are copied at install
time; run install or upgrade again to pick up source edits. Downloading and npm
work do not hold the configuration lock, and a concurrent change to the same
Adapter causes the stale update to fail instead of overwriting it.

Bulk upgrades remain sequential to bound package work and stop at the first
failure. Registry packages resolve `latest`; local directories and archives keep
their canonical local source path; HTTPS installations fetch the same URL again.
Release URLs should therefore either be stable update endpoints or be replaced
by explicitly installing a newer asset.

Previous slots and validated candidates that lose a concurrent update are retained
under `~/.atape/adapters/slots/`. Use `atape adapters prune` to preview eligible
tracked installations, then add `--apply` to clean them using runtime leases;
see [Adapter installation cleanup](#adapter-installation-cleanup). Records from
the earlier shared layout remain readable until their next explicit upgrade.
When updating from a CLI that uses the shared installation tree, restart background
sync with the updated CLI before upgrading Adapters. The built-in `atape upgrade`
flow already restarts previously running sync; a direct package-manager update
requires `atape stop` followed by `atape start` so the Host understands package slots.

## Upgrade the CLI and Adapters

Before opening the interactive console, ATape checks for a newer release using
a twelve-hour cache and a short network timeout. If one is available, choose
`Upgrade and continue` or `Skip`. Skip enters the original flow for this session;
upgrading reopens the newly installed CLI with the same arguments and ATAPE_HOME.
The choice appears again on later launches while an update remains available.
An offline or failed check proceeds normally. Upgrade failures offer Retry and
Skip; Escape exits instead of bypassing the choice.
If installation succeeds but background sync cannot resume, choose
`Resume sync and continue` to retry sync without reinstalling, or `Skip` to open
the new CLI with sync stopped.

```sh
atape upgrade
```

This checks npm for the latest stable CLI and updates the active npm global
installation. Already current versions need no action. After a successful
upgrade, previously running background sync resumes with the same settings;
stopped sync stays stopped. Use the same `ATAPE_HOME` as usual. Projects, login
and sync checkpoints are retained. Adapter packages have their own
`atape adapters upgrade --all` command.

For an installation owned by another package manager, use that manager's update
command. Repository development builds cannot upgrade themselves. Startup
update choices do not appear in scripts or JSON output; `atape upgrade --json` returns
the version and whether the CLI was updated and sync resumed.

After updating the CLI, review official Adapter updates in **Tools and updates**
or use `atape adapters upgrade --all`. The latter preserves each package's source;
a versioned local tarball or URL will not automatically switch to a newer release.
See [Tools and Adapter packages](#tools-and-adapter-packages) for source switching.
Check `atape --version`, `atape adapters list --json` and `atape status` afterwards.

For a direct npm or other package-manager replacement, stop running sync before
updating, then restart with the same local state and prior scheduling options:

```sh
atape stop
npm install --global @atape/cli
atape start
atape status
```

Run the start step only if sync was previously running or you intend to enable it.
Keep `ATAPE_HOME` and any individual path overrides unchanged; the
[local-state section](#local-state) lists the files to preserve. This procedure
preserves supported current state; it does not add migration support for earlier
development configuration schemas. Follow the target release's compatibility
notes and the relevant Adapter guide. Updating client packages does not update
the Server or supply a missing Server capability.

## Run collection

Start one managed background Collector after setup:

```sh
atape start
atape status
atape stop
```

On macOS and Linux, the process immediately continues successful cycles with remaining pages and stays alive after the starting terminal closes. When caught up or after a job failure, it waits 30 seconds by default before retrying. `status` reports whether the process is running plus each configured Project/Adapter's last success time, current failure reason, and latest bounded counters. It does not expose conversation bodies. The managed process does not promise restart after logout or reboot; an external supervisor may still invoke `collect --once` when boot persistence is required. Windows retains foreground `collect` until ATape can verify managed process ownership without relying on a reusable PID alone.

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

Run one bounded cycle for diagnosis or an external scheduler:

```sh
atape collect --once
atape collect --once --project "<project-id>" --json
```

Use the Project `id` from `atape projects list --json` for `--project`. A one-shot
cycle can upload confirmed sources and update progress; it is not a read-only
diagnostic. Stop managed sync before foreground diagnosis to avoid two Collectors
using the same state, then run `atape start` afterwards if it was running.

Run continuously in the foreground for debugging, or configure the same interval and concurrency on the managed process:

```sh
atape collect
atape start --interval 10 --concurrency 4
```

The Collector runs at most four Project/Adapter jobs concurrently by default and caps the value at eight. Within each job it pulls bounded pages sequentially. `Ctrl+C` and `SIGTERM` interrupt Adapter work and release loaded runtimes.

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

Every listing command supports `--json` for scripts.

The executable package contract is documented in [Adapter package and runtime contract](../adapters/package-manifest.md). Provider-specific behavior is documented in the [Codex](../adapters/codex.md), [Claude](../adapters/claude.md), [OpenCode](../adapters/opencode.md) and [CodeBuddy](../adapters/codebuddy.md) guides.

## Troubleshooting

Start with Project details and `atape status --json`. The latter is read-only and
includes bounded job diagnostics; its `logFile` points to the managed Collector
log when available. Use [Run collection](#run-collection) for a foreground cycle.

| Symptom | Next action |
| --- | --- |
| No Team or wrong destination | Open Web onboarding on the intended Instance, create/join a Team, then Refresh. Check the Instance, account and Team in the connection review before confirming. |
| No jobs or waiting for history | Check `atape projects list --json` and `atape tools list --json`. Enable the intended tools and create a supported conversation inside the connected repository. Source detection alone is not proof of readable history. |
| Partial capture / `attribution` | Inspect the reported source and the [Git attribution rules](#git-conversation-attribution). Restore trustworthy original-repository evidence when possible; resetting progress cannot infer a missing identity. Healthy sources may continue. |
| Authentication failure | Sign in to the affected Instance with the Project's bound account. The console offers sign-in and resume; after explicit `atape login --instance https://atape.example`, run `atape start` if sync stopped. Another account cannot adopt the existing binding. |
| Retryable transport failure | Check Instance reachability and the latest job/log diagnostic. Managed sync retries; after an exhausted foreground cycle, rerun it once the Instance is reachable. |
| Unsupported source, capability or limit | Follow the relevant Adapter guide. Upgrade the required CLI/Adapter together; missing Server publication support needs the operator's [OpenCode rollout procedure](../operations/opencode-rollout.md). A cursor reset does not add format support or capacity. |
| CLI updated but sync stopped | Use **Resume sync and continue**, or `atape start` with the same state directory. If an older Collector remains running after direct package replacement, stop it and start the updated CLI. Check status afterwards. |
| Missing/corrupt state or full disk | Preserve the entire [local state](#local-state), including capture bindings and journals. Free unrelated disk space or restore a consistent backup; do not delete checkpoints or journals to manufacture a fresh capture. |
| Conversation visible but Raw absent | Check the [Raw policy](raw-capture.md) and the Adapter's recovery limits. Canonical and Raw acknowledgements are separate. |

## Implementation boundaries

CLI flags and interactive setup now use the same `decideProjectSetup` Interface
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

Commands now decode into individual input types before runtime construction.
Unknown or unrelated options, duplicate scalar flags and extra positional arguments
fail with exit status 2. Repeated `--adapter` options remain supported by global
`tools configure`. Domain choices and Collector limits remain in their owning
application Modules.

`pnpm check:architecture` enforces Application/Domain/UI boundaries, prevents CLI
imports of private provider code, and checks runtime cycles across the governed
production Modules. It parses source with the pinned TypeScript compiler, including
type imports, re-exports and dynamic imports. Type-only edges obey layer rules but
do not form runtime cycles. `pnpm check` runs it in CI.

## Adapter installation cleanup

```sh
atape adapters prune --json
atape adapters prune --apply --keep 1 --json
```

The first command previews; `--apply` removes eligible installations. `--keep`
(default 1, range 0–20) retains that many inactive installations per package in
addition to all currently selected and in-use versions. Each invocation removes
at most 32 slots; `more: true` means another invocation can continue. A retired
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
