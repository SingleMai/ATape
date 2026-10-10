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
| Claude Code | [JSONL capture and compaction continuity](../adapters/claude.md#sources-and-supported-history) |
| OpenCode | [Accepted SQLite version/platforms and Server prerequisite](../adapters/opencode.md#supported-source-and-enablement) |
| CodeBuddy Code CLI | [Supported primary JSONL Sessions and limits](../adapters/codebuddy.md#source-mapping-and-supported-scope) |
| Kimi Code CLI | [Native Session compatibility and limits](../adapters/kimi.md) |
| Grok Build | [Completed root conversations and limits](../adapters/grok.md#supported-native-profile) |
| Cursor | [Experimental controlled new-session capture in local artifacts; native acceptance pending](../adapters/cursor.md) |

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
directory. Project, tool and settings operations are inside the console. The narrow
`atape start --tool cursor` entry hands the terminal to a controlled native
session; see [Cursor creation and limits](../adapters/cursor.md).

First use configures tools globally, then offers directory browsing, browser
sign-in and Team selection when needed. Detection checks known local tool data
directories; it does not scan the disk or guarantee this Project has history.
Saving tools installs their integrations but does not connect any Project.
Review the Instance, account, Team, Project, global tools and historical import
before confirming capture and starting sync. Subsequent Projects reuse the global
tools. No Teams means Web onboarding, then Refresh; the directory remains selected.

The setup review also explains that automatic updates are on by default for
ATape and installed official npm integrations. Settings → Turn off automatic
updates saves a machine-local preference; Turn on automatic updates enables them
again. This does not change which tools or Projects may be captured.
Login startup is also enabled by default and explained during setup. Settings
offers Turn off login startup, Turn on login startup and, when needed, Retry
login startup registration. The saved preference and actual OS registration
status are shown separately.

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
terminal and leaves the independently managed Collector running. With login
startup registered, logging in resumes sync unless you explicitly stopped it.

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

Codex, Claude, OpenCode, CodeBuddy and Grok use the same Host attribution contract. Codex supplies the
original rollout CWD and recorded Git remote when available; Claude supplies the
original root record's CWD; CodeBuddy supplies its first native user record's ID and CWD; OpenCode supplies immutable session-creation evidence; Grok supplies native Session identity, creation time and original CWD from summary metadata. The Host resolves the nearest repository when needed
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
fetches the same HTTPS URL again, or resolves `latest` for custom registry installations.
Official registry installations instead target the exact running CLI version.
Pinned archive/URL sources remain pinned; install a new source to change them.
Concurrent changes to the same installation reject stale activation.

Official release updates appear directly in Tools and updates. Use published …
explicitly switches an official file/URL installation to the running CLI version.
Initialization, adding a tool and Git repair use that same exact version. A
resolved official registry package with another version is rejected before Host
refresh or configuration commit; a newer installed official Adapter is never
downgraded. Development builds require explicit local, URL or custom sources.
Custom packages stay on their original source. Updates preserve capture selection,
Projects and checkpoints, and do not start stopped sync. There is no bulk update
command. Old slots can be reviewed under [cleanup](#adapter-installation-cleanup).

## Upgrade the CLI and Adapters

### Automatic updates

Automatic updates are enabled by default. Settings shows the current preference
and offers Turn off automatic updates or Turn on automatic updates. The setting
applies to this local `ATAPE_HOME`, across its Projects and Instances. Disabling
updates prevents new automatic tasks, and a preparing worker checks the
preference again before activation. An activation already underway completes its
bounded handoff. Installed versions, tools, Projects and collection progress
remain available. Recovery of an already-persisted interrupted handoff still runs
with automatic updates turned off; recovery does not authorize a new upgrade.

The supported automatic path is a macOS/Linux npm-global CLI installation using
the official npm registry. It updates the CLI/Collector and already-installed
official registry Adapters to one stable release version. It never installs or
enables an additional tool, changes a Project's destination, or replaces custom,
local, archive or URL sources. Those sources keep their explicit maintenance
path below. Development builds and other package managers are not adopted.
An eligible official installation with an unknown or prerelease version skips
the whole automatic bundle, as does a CLI or eligible Adapter ahead of the
completed release. Automatic updates never downgrade a package to force alignment.
The worker checks the actual npm bootstrap's stable version during preparation
and again before selection, together with its executable digest. An older copied
worker cannot select a release below a newer installation already on disk.

After tool initialization, automatic updates register an independent user-level
hourly wakeup on supported installations: a macOS calendar LaunchAgent or a Linux
persistent systemd timer. This remains active with login startup off, the console
closed and collection stopped. A wake performs the existing local due check;
it does not issue Start or alter saved collection intent. Missed calendar wakes
are retried after the user manager resumes. Settings reports missing/unavailable
registration and offers a retry. Turning automatic updates off removes future
scheduling without terminating an in-flight handoff; a queued entry rereads the
saved preference before starting new work. If an update owner or pending recovery
exists, the trusted schedule temporarily remains for recovery only; it is removed
after recovery finishes. Already-admitted recovery remains allowed. No sudo, linger or root service is installed.

The retained private coordinator joins update work under the same update ownership
as other triggers, delegates to a capable selected runtime, and has a ten-minute
cancellation budget. Native commands have ten-second limits. Linux uses an inactive
oneshot after each run, so the next timer can activate it. Its KillMode=process
preserves a Collector resumed by maintenance; that daemon remains owned by the
Collector Module and user Stop. npm/probe/update subprocesses are joined. macOS
Collector processes retain their separate owned process groups. The wake does not
supervise collection or run while the machine/user manager is shut down. Node
removal and unavailable native managers remain visible installation limits. See
[ADR-0113](../architecture/adr/0113-independent-update-wakeup.md).

Opening the CLI or a running Collector can also trigger a due background check.
Successful checks schedule the next attempt after 24 hours plus 0–6 hours of
jitter. Failures start with a one-hour exponential backoff, capped at 24 hours
before jitter. Opening the CLI does not force a network request when the
persisted schedule is not due. The
schedule check is local and does not start npm or query release metadata before
the check is due. A transient npm ownership-probe failure is retried on a later
trigger instead of marking a long-running Collector permanently unsupported.

A candidate that fails local startup/readiness and successfully restores the
previous runtime enters a persistent cooldown: 24 hours after its first failure,
72 hours after its second and seven days after subsequent failures. Expiry makes
it eligible again; the actual retry waits for the next due trigger. Only a
completed recovery with the previous runtime actually ready can record this
failure; Stop, uncertain process identity, known filesystem I/O errors,
preparation/transport failures and configuration races do not. A startup failure
can still reflect temporary child-process resource problems, so this is a finite
cooldown rather than a permanent bad-version decision.

The key includes the complete immutable bundle, its contracts and all package
digests. An unrelated catalog revision does not reset it. During cooldown,
ordinary checks still discover new compatible bundles and use the normal
24–30-hour check schedule without accumulating transient-error backoff. They skip
the deferred bundle before installation and recheck before maintenance, so even
an older prepared candidate cannot pause collection. A later complete bundle
remains eligible. An explicit CLI update bypasses the delay for that attempt;
successful activation clears only that bundle's record. The per-home file keeps
at most 64 records, with bounded reads and atomic replacement. Invalid cooldown
metadata prevents new managed updates before preparation, including manual
attempts, while ordinary CLI use and interrupted-update recovery remain
available. See [ADR-0112](../architecture/adr/0112-failed-candidate-cooldown.md).
Already-published older workers do not acquire this behavior retroactively.

The fixed GitHub prerelease tag `atape-update-catalog-v1` advertises the latest
compatible complete bundle for this capture/control pair. Its monotonic revision
and per-family version floor are persisted; regressions, same-version changed
bytes, unknown protocols and corrupt durable state are rejected. A versioned
Release retains the immutable `atape.release-bundle.v1` descriptor, including the
original seven required package names and current additions such as Cursor,
canonical npm tarball URLs and SHA-512 integrity.
The v1 reader accepts up to 32 unique `@atape/*` packages, allowing future official
Adapters without blocking older clients. Added packages remain part of the
immutable descriptor; discovery does not install an unconfigured Adapter.
Automatic and manual discovery share this Module. Individual npm `latest` tags
do not select a managed upgrade.

The worker prepares only eligible already-installed Adapters. Every official
archive is downloaded with bounded size/time and its SHA-512 is checked before
npm receives the local file. An existing version directory must match the newly
verified executable and manifest bytes before reuse. Download leases outlive npm
termination, including cancellation. Incomplete publication, offline checks and
failed preparation leave the current version usable. Cached optional lookups
can use the last valid catalog offline; explicit checks report transport failure.
An exact lookup for the running CLI can derive a bundle from every producer exact npm
manifest while its first version descriptor propagates. This fallback never
advertises another upgrade target.

The prepared CLI package must declare `atapeRuntime.protocol` as
`atape.runtime.v1` and its actual capture-state contract. A v1 release bundle
requires the same contract. A v2 bundle requires an explicit compiled migration
plan and verifies the target contract and capabilities before activation.
The published 0.5.3 worker accepts v1 only, so it keeps its current installation
when offered 0.5.4. This first v2 release requires the explicit manual transition
below; later compatible v2 releases retain automatic updates and rollback.

Capable packages additionally declare `atapeRuntime.updateControlProtocol` as
`atape.update-control.v1`. Catalog candidates also declare
`atapeRuntime.releaseCatalogProtocol` as `atape.update-catalog.v1`; both actual
capabilities and `atapeRuntime.updateWakeProtocol=atape.update-wake.v1` are checked
before preparation and again before activation, preserving the periodic entry
across selected generations. This control protocol is independent of the capture
contract. After a capable bridge is installed, subsequent capable updates select
`updates/runtime.json` and retain durable recovery intent in
`updates/control.json`. The legacy `releases/current.json` remains a genuine v2
bridge for an older bootstrap. A capable npm bootstrap can enter control directly.
An active control selection takes precedence over a copied older worker's legacy
pointer. The CLI and official Adapter slots switch as one generation.

Before a forward-only boundary, interrupted work restores the previous
selection; after one, recovery must use the recorded target and reader floor.
The floor checks the exact capture contract as well as minimum runtime version.
Recovery remains pending until the selected runtime passes local readiness, and
collection cannot begin writing migrated data before a durable migration receipt
exists. Invalid metadata or unavailable recovery code pauses collection.

The running executable carries its own compiled version and capture contract.
Replacing its npm manifest cannot make an already-open old console a new reader.
Normal interactive, login and Collector work checks that identity after bootstrap
delegation or owned recovery. Historical v2 bridge pointers and manual receipts
keep their fixed v2 decoder independently of the current executable identity.

Ordinary configuration transactions and local capture writes share a short
per-home barrier with reader-floor advancement. It covers Collector checkpoint
initialization/commit, capture binding metadata, journal creation/migration and
every write transaction, including handles opened before an upgrade. A write
already holding the barrier finishes before the floor advances; a later old
write fails without committing. Reopen ATape when an old console reports that
its runtime is below the recovery boundary. Journal cleanup still closes its
handle; a WAL checkpoint can change physical bytes without adding logical data.
User Stop and the updater's owned pause/resume handoff keep their stable control
protocol and remain usable after the floor advances. Credentials, privacy policy,
remote effects and control metadata retain their existing separate protocols.
These guards apply to capable executables; already-published older binaries
cannot acquire them retroactively. See
[ADR-0110](../architecture/adr/0110-runtime-writer-admission.md).

One independent, short-lived updater prepares an isolated version directory and
Adapter slots while collection continues. It then obtains exclusive maintenance
ownership, requests Collector cancellation and bounds the entire stop handoff.
The Collector has five seconds to exit after SIGTERM and at most two more seconds
after SIGKILL; process identity and exit checks share the monotonic deadline.
It never waits for all historical
capture to finish. If the old owned process cannot be confirmed stopped, the
version is not switched. Activation atomically selects the prepared CLI/Adapter
generation, then restarts only sync the user still wants running. Stop sync in
Settings also cancels an update's restart intent.

Update ownership, whole-handoff ownership and the short Collector process lock
use OS-held exclusion. Process exit, including SIGKILL, releases ownership;
remaining SQLite coordination files are not evidence of a live owner. A retained
maintenance PID is diagnostic only, so PID reuse cannot block recovery. The short
process lock remains separate from handoff ownership so user Stop can cancel
restart intent during maintenance.

The activation budget is 45 seconds, including ownership, process locks, stop,
local validation and restart; recovery gets a separate 30-second budget. A process
lock wait is at most ten seconds, and stop/readiness limits are shortened by the
remaining budget. These workflow and subprocess deadlines cannot forcibly cancel
an OS filesystem call that stalls; such a call must finish before the deadline is
rechecked.
Preparation is tied to the Adapter installations and selected generation it
inspected. If either changes before activation, the candidate is discarded.
Ordinary settings and Project edits are preserved. Recovery does
not overwrite a later deliberate selection.

The npm-global installation remains the bootstrap entry. The effective legacy or
independent control pointer selects the managed CLI and its prepared official
Adapter slots. The underlying
configuration retains Project/account settings and the original installation
records; a deliberate package/source replacement takes precedence over the
corresponding managed Adapter selection. Adapter slots continue using the
existing current/in-use lease and cleanup rules.
An already-open console keeps its executable until reopened; new CLI launches
and the restarted Collector use the selected version.

The new runtime checks local readiness and resumes from existing checkpoints and
account-bound journals. The local readiness deadline is ten seconds; it validates
selected configuration and enabled Adapter package/entry capabilities without
waiting for network access or a new conversation. A failed startup can restore
the retained version only
when the local-state contract remains compatible. Retained files protect the old
installation from interrupted npm preparation; they cannot reverse incompatible
state changes. Reopen the CLI or allow a later trigger to reconcile interrupted
maintenance. Installing a version is not proof of successful conversation sync.

The independent hourly wakeup and [login coordinator](#login-startup) can recover
an interrupted handoff without opening the console. If native update scheduling
is unavailable and neither CLI nor Collector runs, recovery waits until ATape
next runs. Automatic
release-directory cleanup is outside this increment. Automatic updates do
not upload local logs or introduce remote maintenance commands. See
[ADR-0100](../architecture/adr/0100-managed-automatic-updates.md) for the release,
compatibility and recovery decision, amended by
[ADR-0107](../architecture/adr/0107-independent-update-control.md).

Version-aware discovery is implemented by
[ADR-0108](../architecture/adr/0108-compatible-release-bundle-discovery.md),
extended by [explicit capture migration](#explicit-capture-migration).
Published 0.5.3 and 0.5.4 both use the same GitHub
`latest` and immutable npm package, but require different manifest contracts;
one bridge package cannot serve both. A temporary release window cannot cover
indefinitely offline installations. The 0.5.3 manual boundary below remains.

### Explicit capture migration

Migration-capable clients prefer the fixed `atape-update-catalog-v2` Release.
Its routes bind source capture contract, update-control protocol and known
migration protocol/plan to a complete immutable package bundle. Old plan routes
remain available while newer plans advance. The initial absence of that catalog
permits v1 fallback; once adopted, invalid, regressed or missing v2 metadata cannot
silently strip migration identity. Optional offline checks can reuse a verified
v2 cache. Exact-version receipts retain the package and plan identity.

The first supported plan is `atape.capture-migration.v1 / journal-v7-to-v8`,
from a capable capture-v1 or capture-v2 executable to actual capture v2. It admits
registered journals at format 7 or 8 only. Real v7-to-v8 SQL is transactional;
verified v8 is a retryable no-op. Other formats/plans are rejected before pause.
This is a local storage transformation, not a history import or Server migration.
Project/tool selections, Stop intent, credentials, privacy settings, Canonical
and Raw obligations, receipts and checkpoints are retained.
Manual upgrades use this same migration path when tools have been disconnected;
retained journals cannot bypass the fence through command-entry-only replacement.

The verified target executable performs read-only preflight before pause. Enabled
SourceCapture v2 projects that still request sync require the existing Server
publication/adoption capabilities. All configured accounts are checked; the
active UI Instance does not narrow capture. Preflight reads existing credentials
and package manifests without importing source factories, uploading content or
reporting a device. Stopped sync skips remote prerequisites while permitting
local migration. Raw-off still permits Canonical capture, so it does not suppress
the capability check. Fresh local intent/configuration/inventory checks prevent
Start or account changes from reusing an obsolete preflight.
SourceCapture v2 manifests can declare `publicationTargetProfile`; older packages
default to Profile2. Enabled Profile3 candidates, including Cursor, require a
negotiated Profile3 capability before pause. Other Adapters retain the existing
Profile2 requirement. This static minimum does not replace runtime header checks.

An active controlled-session creation proof defers reader-floor advancement until
it is confirmed or abandoned. The proof holds a separate OS lease, not the global
writer barrier; the native conversation continues and update attempts stay
bounded. Confirmed sessions do not delay updates, and a dead Host cannot leave a
stale ownership marker that blocks recovery.
Coordination resolves the existing home before choosing its fixed private paths,
so OS path aliases such as macOS `/var` remain valid. A redirected `updates`
directory, exposed permissions or foreign ownership still close admission.

After bounded pause, the updater fsyncs a strict requirement and progress ledger
before selecting/fencing the target. The target private apply process has a
20-second budget and holds one home-wide SQLite apply lock through journal close.
Every SQL/progress/receipt commit revalidates its durable attempt token under the
same admission barrier used for floor advancement. A new recovery owner revokes
the prior attempt before waiting for its apply lock. An orphan may finish while
its token remains valid; it cannot commit after revocation. Busy or hung storage
defers recovery rather than allowing concurrent migration.

Shared SQLite coordination files are initialized once under exclusive ownership.
Initialization commits before the caller reacquires its lease; later acquisition
does not rewrite the lock database. Existing empty lock files are initialized by
their next owner without replacement. This lets an already initialized capture
home retain exclusion and inspect pending state even when its disk is full.

After the fence, every retry moves forward to the recorded target, including
after automatic updates are disabled or sync is stopped. Recovery never starts
sync against Stop intent. Missing one metadata peer can be repaired from strict
surviving evidence; corruption closes capture. Do not delete the requirement,
ledger or apply lock as a repair. A completed receipt admits later same-contract
versions at or above its target, subject to the current reader floor, without
pinning an obsolete executable or Adapter slot. Configuration and Stop remain
usable while capture is gated. See
[ADR-0115](../architecture/adr/0115-explicit-capture-migrations.md).

This implementation does not retrofit migration/wake support into immutable
0.5.3. That installation needs separate initial delivery. Existing 0.5.4 devices
enroll independent scheduling only after a capable actual entry runs. Keeping a
real v2 bridge on historical GitHub/npm latest serves indefinitely offline legacy
v2 readers; it cannot make the same package satisfy 0.5.3's incompatible contract.

Migration caller checks execute a real compiled target, real SQLite and a
controlled capable v1 coordinator. They cover fenced interruption with preference
off, exact pre-fence restoration, Stop, unconfigured retained state, and later
same-contract writes. They do not show that immutable 0.5.3 can discover this
target or acquire a timer by itself.
The narrow journal/authority checks additionally preserve genuine 0.5.3
Canonical/Raw obligations across actual SQL commit followed by replay without
progress, exercise a real orphan after parent `SIGKILL`, token revocation and
apply-lock exclusion, and recover missing peers and marker-first successor
authorization. The SQL-commit replay case constructs that crash state through
the caller Interface; it does not claim a power-cut test. Unknown metadata fails
closed, and a completed receipt survives a real same-contract bootstrap rebind.
The dedicated Linux tmpfs contract exhausts real storage and checks a typed
capacity failure, unchanged pending bytes/progress, fresh-process reopen while
full, and write recovery after freeing space, including migration admission's
initialized coordination lock.

The implementation was verified locally on macOS with CLI/Application behavior
tests, Collector/Server E2E, all seven official Adapter tarballs, and the installed
CLI's independent-worker and terminal checks. Release metadata and npm acquisition
in update fault tests use controlled external Adapters. These checks do not establish
publication, an upgrade against the production registry, a real Linux upgrade, or
recovery from a real machine power loss. Periodic wake tests cover application
policy, native descriptor syntax, owned registration/admission and installed
headless entry through controlled OS-command Adapters. An opt-in macOS native
check additionally passed real LaunchAgent RunAtLoad and repeated kickstart with
distinct coordinator PIDs, a separately owned child surviving both runs and
disable, and cleanup of the isolated registration. This proves the native process
lifetime, not real capture, calendar sleep/reboot or power-loss recovery.
A separate isolated Linux systemd 252 user-manager check used the production
Adapter's service/timer descriptors and an accelerated calendar. Two timer
activations completed with distinct coordinator PIDs while one detached helper
remained in the same service cgroup; disabling/stopping only the timer retained
that helper and prevented new activations. Terminating the PAM login session with
Linger=no removed the helper, user manager and cgroup. This verifies the selected
native lifetime with controlled helpers, not a real packed upgrade and Collector
resume, an elapsed hour or sleep/reboot. Temporary containers were removed.

Adapter preflight checks package identity, entry containment and Git capabilities
before executing imports in an isolated child process. The whole import batch has
a ten-second budget and at most one additional second for forced termination.
The child supervisor keeps foreign imports in a terminable thread and also exits
if its owning updater dies. Import success requires a confirmed factory export;
preflight never calls that factory or collects history. Timers left by a successful
import are discarded. Package leases and update ownership remain held until the
child exits on normal completion, timeout or cancellation. A failed preflight
leaves the old Collector running without closing admission or switching versions.
This process boundary contains hangs and process exits; it does not sandbox an
Adapter's filesystem or network access.

### Explicit maintenance and external replacement

**The 0.5.3 → 0.5.4 boundary requires manual installation outside the old
console.** Use the old CLI to Stop sync, finish interrupted update recovery,
close old consoles and keep a consistent local-state backup. Install
`@atape/cli@0.5.4` globally with npm, then open the new console. Its bounded
private migration ledger preserves the selected official Adapter overlay in
configuration and retires known v1 current/retained pointers while holding
update and Collector-process ownership. Interrupted steps replay before the
new console delegates or starts collection; a later deliberate Adapter change
is preserved. Preferences, Projects, accounts, capture files and Stop intent
remain intact. Help and version queries are read-only.
Keep `ATAPE_CONFIG_FILE` and `ATAPE_COLLECTOR_PROCESS_FILE` overrides consistent
for that `ATAPE_HOME`; the upgrade receipt is bound to those local paths.

An active Collector, old pending update/maintenance, unknown metadata or busy
ownership blocks this transition. Restore the old npm CLI to finish recovery
and Stop sync, then reinstall and retry. Update official Adapters in Tools and
confirm the Server supports publication v2 targets and legacy adoption before
Start sync. SourceCapture v2 checks these capabilities before opening an account
journal or replacing a legacy checkpoint. Starting v2 capture can migrate a v7
journal to v8 and adopt legacy Sessions irreversibly on the Server. Recover
through a v2 runtime afterward; an old 0.5.3 reader cannot open v8, and restoring
local files cannot undo Server adoption. See
[ADR-0104](../architecture/adr/0104-capture-v2-state-upgrade.md).

Open ATape → Tools and updates to inspect current/latest versions and apply each
available update. With automatic updates enabled, startup launches due maintenance
without a blocking Upgrade/Skip choice. With automatic updates disabled, startup
retains Upgrade and continue or Skip. Version lookup
is bounded and cached; offline lookup does not block entering the console. Check
again bypasses the successful-result cache. A failed update offers retry.

The built-in CLI update supports the active npm global installation, verifies the
installed version, and restarts the application after terminal teardown. Previously
running sync resumes with its settings; stopped sync stays stopped. Development
builds and other package managers receive guidance instead of an inferred target.
If sync cannot resume, use Resume sync and continue or return with sync stopped.
The explicit CLI operation prepares and activates the complete CLI/official
Adapter bundle through the same coordinator used by automatic updates, with
manual policy. It then refreshes the global npm command entry from the same
verified CLI archive under the same update ownership. Before tool initialization
there are no active Adapters to align, so only the verified entry is installed.
If entry refresh fails after runtime activation, the error identifies the selected
runtime; reopening or retrying checks the actual command-entry version even when
the managed runtime already equals the target. Tools retains an explicit entry
refresh action in that case.
Before replacing the bootstrap, the internal upgrade preserves the effective
Adapter installation records in the underlying configuration. Their currently
selected versions remain selected even if npm fails or the bootstrap digest
changes. Built-in manual and automatic updates share one `ATAPE_HOME` update lock
across saving those records, installing and handing off the Collector. A second
manual operation targeting the same npm installation also takes its OS-held
installation lock and rechecks the actual stable version before replacing it;
a stale update plan cannot install an older version. Busy operations can be retried; an independent Resume sync
retry retains its recovery receipt when ownership is busy. Neither lock relies
on the continued existence of a PID or a removable lock file. Explicit Adapter
maintenance remains separate.

With independent control active, the built-in update verifies the new bootstrap
directly, creates its immutable recovery copy and durably binds that identity.
It preserves the capture contract and reader floor. If the process dies between
npm replacement and binding, a later owned startup detects the changed identity
and completes forward recovery. A reported npm/direct-verification failure restores the original bundled command
entry, manifest and bin link within a separate 15-second budget when the durable
control/pointer has not changed; the selected runtime and Adapter overlay stay
intact. Once rebinding durably advances control, recovery proceeds forward.
npm's in-place replacement itself is not atomic. Power loss or SIGKILL before
restoration can leave an incomplete global entry requiring a valid same-contract
npm replacement; automatic version-directory activation does not replace it.

Managed collection records the executable identity it started with. Opening ATape,
installing or updating an integration, or selecting Start sync refreshes a running
Host when the installed CLI changed, including a same-version reinstall. Legacy
process metadata without an identity triggers one restart. The handoff preserves
interval and concurrency, never starts user-stopped sync, and retains restart
intent if it fails. Integration activation stops on a handoff error so an old Host
cannot receive a new installation layout. An unchanged Host picks up Adapter-only
updates on its next cycle without a restart.

A direct npm/tarball replacement does not itself run ATape lifecycle management.
With independent control active, a changed bootstrap identity requires owned
recovery before ordinary delegation. Reopening ATape or a registered login entry
checks the actual package, exact capture contract, control capability and version,
preserves the selected Adapter overlay, and binds a verified immutable copy.
Recovery refuses a downgrade, incompatible contract or invalid executable.
Help/version stay read-only and may report invalid selection until recovery runs.
Homes sharing a global npm bootstrap recover their own preferences and selections
independently. Legacy-only selections retain their earlier behavior: replacement
invalidates the digest and the new bootstrap/configuration takes precedence,
without preserving the overlay automatically. Reopen ATape to complete the
Collector handoff and inspect Adapter versions in Tools. The next eligible
automatic check can prepare a new aligned generation. Older CLIs without this detection require
Stop sync in Settings before replacement, then Start sync after reopening.
Verify the installed version in Tools, update integrations there as needed, and
inspect Project sync results. Installing a version is not proof of successful
conversation sync.

## Run collection
Connect and sync starts the managed background Collector. Home offers Start sync
when stopped; Settings offers Stop sync for all projects with an impact review.
Exiting ATape leaves this process running. With [login startup](#login-startup)
enabled, the next login resumes collection only when saved intent still requests
it. If login startup is disabled or unavailable, open ATape to resume it.
Public foreground collection, scheduler commands and tuning flags are removed.

The Collector continues bounded catch-up cycles while pages remain and waits
30 seconds by default when caught up or after failures. It runs at most four
Project/Adapter jobs concurrently by default. Project details report each tool’s
last result and bounded counters without conversation bodies. Failed jobs omit
previous backlog estimates instead of presenting stale zero counts as current
progress; their last success time remains available. Status refresh is
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

## Login startup

Initialization defaults to on; `autoStartEnabled: false` disables it for this
`ATAPE_HOME`. A supported npm-global installation registers a user LaunchAgent on
macOS or a systemd user service on Linux. It runs when the user logs in, without
opening a terminal, browser or interactive authentication. Linux requires an
available systemd user manager; ATape does not enable linger or install a root
service. Windows, other package managers and source development builds are
unsupported. Settings reports missing/unavailable registration rather than
claiming the saved on preference is installed. Reopen ATape in a normal login
session or choose Retry login startup registration to repair it.
The console and Collector also reconcile registration at launch and every five
minutes while running. The local automatic-update schedule check keeps its
separate thirty-second trigger; native registration does not delay it.

The short login coordinator validates its private registration and current
preference, recovers pending automatic-update maintenance, and resumes only
locally configured work the user still wants running. Explicit Start records
that intent and its interval/concurrency. Stop clears it durably even after a
process has disappeared; login, manual upgrade and automatic update cannot
revive it. Upgrade pauses preserve it. Older installations inherit intent only
from a confirmed running Collector or retained maintenance resume. An already
stopped legacy installation must use Start sync once to establish intent.
Established intent retains its process record through crashes and pause. Removal
of that record without maintenance resume is treated as Stop, including Stop from
an older console left open during automatic upgrade. After upgrading, reopen
older consoles before Start or settings changes: an old Start cannot override a
newer durable Stop. Preserve process/intent metadata along with capture state;
manually deleting it can conservatively stop future recovery.

Turning startup off takes effect before native unregistering, so an already
queued login entry is inert. It leaves current sync and the user's running intent
unchanged. On Linux, disabling future startup does not stop an active service
cgroup or an independent updater. The service stays active after its successful
short handoff to preserve detached children. This feature does not continuously
supervise crashes: if the Collector later dies, open ATape and choose Start sync,
or the next login can resume it.

The OS entry binds absolute Node and an owned bundled coordinator at
`startup/atape.mjs`; npm installation identity remains checked separately. This
allows later compatible managed releases to reuse a capable bootstrap. The
first v2 release, 0.5.4, requires a manually installed v2 bootstrap; 0.5.3 cannot
decode a v2 runtime pointer. The coordinator delegates to a selected release only when it declares the
login startup capability. A rollback to a release lacking that capability makes
startup inert; its older Stop operation cannot maintain the new intent contract.
Return to a capable release and inspect Settings to repair startup. Private metadata keeps required provider paths, explicit
`ATAPE_REDACT_VALUES` and proxy/CA context. Explicit loopback HTTP development
permission and source-collection limit overrides also survive login; it does not copy the whole shell
environment, account credentials or conversation bodies. Explicit empty values
clear retained context. Removing Node/npm externally can break the absolute
paths; reopen ATape after repairing that installation. Mixed concurrent old/new
CLI writers are outside this protocol; use the active installation for settings.

Application and Node behavior checks cover default-on/explicit-off, durable
Start/Stop, duplicate login, process loss, preserved schedules, paused maintenance,
registration failures and partial-file recovery. Installed-package acceptance
uses the real bundled headless entry and selected runtime with controlled OS
commands and fixture capture data. On 2026-10-09, an isolated macOS native-manager
check registered one unique LaunchAgent, observed its bundled empty headless
helper exit successfully, then disabled and removed that owned registration.
It contained no Projects, credentials or capture sources. This proves native
registration, helper launch and cleanup; it does not prove delivery through a
native-launched Collector. The generated Linux unit also passed real systemd 252
analysis in an isolated Node 24 Linux container, including argv and working
directory round trips for spaces, Unicode, percent signs, dollar signs, quotes,
backslashes and a trailing space. No Linux user manager was started. Actual logout/login, machine reboot, power loss and
Linux Collector cgroup acceptance remain unverified. Descriptor parsing and
controlled commands alone do not establish those behaviors. See
[ADR-0103](../architecture/adr/0103-login-startup.md).

## Local state

All default client data lives below `ATAPE_HOME`, which defaults to `~/.atape`:

- Credentials: `~/.atape/credentials/`
- Configuration: `~/.atape/config/client.json`
- Redaction rules: `~/.atape/config/redaction.json`
- Redaction identity and binding: `<collector-state-file>.redaction-key` and its `.json` binding
- Collector checkpoints, process metadata, and status: `~/.atape/state/`
- Account-bound Source capture journals: below `~/.atape/state/collector.json.captures/`, with `collector.json.capture-installation.json` binding metadata
- Git attribution evidence: beside the Collector state file, in `<state-file>.git-attribution/`
- Background logs: `~/.atape/logs/collector.log`
- Adapter packages: `~/.atape/adapters/`
- Managed CLI version directories: `~/.atape/releases/`
- Managed runtime selection: `~/.atape/releases/current.json`
- Update schedule, preparation and recovery metadata: `~/.atape/updates/`
- Login coordinator and private registration/context: `~/.atape/startup/`
- Durable sync intent and schedule: `<collector-process-file>.desired.json`

Managed update metadata includes `updates/state.json` for the check/retry schedule,
`updates/pending.json` for an interrupted activation and `updates/retained.json`
for the preceding managed selection. `updates/candidate-cooldowns.json` retains
bounded startup-failure cooldowns independently of the check schedule. Independent
control uses `updates/runtime.json` and its recovery ledger `updates/control.json`.
Capture migration uses `updates/capture-migration.required.json`,
`updates/capture-migration.json` and the OS-held
`updates/capture-migration.apply.lock.sqlite`; preserve them with the registered
account journals. Migration discovery has separate v2 cache/receipt metadata.
Keep recovery metadata with `releases/current.json`
and retained CLI/Adapter files during recovery; deleting pointers is not a
supported repair for capture state.

`ATAPE_HOME` relocates the whole layout. Individual `ATAPE_CONFIG_FILE`, `ATAPE_COLLECTOR_STATE_FILE`, `ATAPE_COLLECTOR_PROCESS_FILE`, `ATAPE_COLLECTOR_STATUS_FILE`, `ATAPE_COLLECTOR_LOG_FILE`, and `ATAPE_ADAPTER_DIRECTORY` overrides remain available for development. Credentials use opaque per-Instance filenames, owner-only directories/files, no-follow reads, compare-and-swap updates, and fsynced atomic replacement. Local filesystem paths remain client state and are not part of server Project, Canonical, Raw, or Search payloads.

The JSON checkpoint file stores installation identity, opaque progress and Raw
receipts, never conversation bodies. Legacy paged Adapters replay through an
unadvanced cursor after a failed upload. Source capture retains only bounded, final
masked pending content in the separate account-bound capture journal. Preserve its binding
and files with Collector state; deleting them is not a supported reset. Resolved
payloads are reclaimed while identity and receipt evidence remains.

Git attribution evidence contains source identifiers, original CWD and remote,
never conversation bodies or upload acknowledgements. Preserve it with Collector
state; losing it can make history unattributable when its original checkout is
gone and the provider did not record a remote. Saved remotes are matched against
the server again during collection.

The shared Redaction Module applies built-in credentials, environment literals and
persisted custom RE2 value/field rules to Canonical, Raw and source diagnostics.
Use `atape redaction-test <file>` to inspect a local sample without sign-in or
upload. Preserve the redaction key/binding with Collector state. Rules reload at
each job boundary; uncertain old-policy delivery can pause instead of resending
old bytes. See [client redaction](redaction.md) for configuration, limits and recovery.

The executable package contract is documented in [Adapter package and runtime contract](../adapters/package-manifest.md). Provider-specific behavior is documented in the [Codex](../adapters/codex.md), [Claude](../adapters/claude.md), [OpenCode](../adapters/opencode.md), [CodeBuddy](../adapters/codebuddy.md), [Kimi](../adapters/kimi.md), [Grok](../adapters/grok.md) and [Cursor](../adapters/cursor.md) guides.

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
| Login startup on but needs attention | Inspect Settings and retry registration from a normal login session. Check Node/npm paths and the user service manager. An explicit Stop still requires Start sync. |
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

The parser accepts the application launch, help/version, session options, the
local-only `redaction-test` inspection command and token-bound internal
Collector/updater/login entries. The login entry validates
its owned coordinator or selected executable and private registration; the updater verifies its
owned worker-copy path; it is not a public operation or remote command Interface.
Removed business commands, unknown options,
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
