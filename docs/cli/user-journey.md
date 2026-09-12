# CLI user journey: global tools and connected Projects

This is the current interaction specification for global tool selection,
connected Projects, reader recovery, local name search, CLI upgrade and Tools
and updates. Command and persistence behavior
is documented in [setup and Adapters](setup-and-adapters.md);
[ADR-0040](../architecture/adr/0040-global-cli-tools.md) records the configuration
decision. Versioned release notes record delivery scope separately.

## User model and scope

Users configure which coding tools ATape reads on this machine, then connect
the Projects whose conversations they want to sync. Tool configuration belongs
to the local ATape installation, across its connected Projects and Instances.
It is not an account-wide or Team-wide setting shared with other machines.

The TUI names actual tools, such as Claude Code and Codex. The global Tools and
updates page shows CLI and installed integration versions, installation source,
latest releases and direct update actions. All operations use this console. Installing
a package and authorizing capture remain distinct operations: an installed
Adapter is not implicitly enabled, and enabling a tool does not discover or
connect additional repositories.

There is one global tool selection. New Projects use that selection, and changes
apply to all connected Projects after the user confirms the displayed impact.
There are no per-Project overrides. Git membership continues to use
authoritative repository identity across worktrees and clones; ordinary folder
identity applies only outside Git.

## First use

1. `atape` opens the cassette welcome with one primary `Get started` action.
   Settings remain accessible for a self-hosted server. The welcome is not a
   mandatory stop on subsequent launches once initial setup is complete. The
   spacious welcome uses the large theme-color cassette; daily pages retain an
   inline cassette mark in the shared header.
2. `Which conversations should ATape sync?` shows Claude Code and Codex with simple selection
   checkboxes. Detection may preselect tools on first use.
   Saving enables the chosen tools globally and installs their Adapters as
   necessary. With no connected Projects, this does not import conversations.
3. `Connect a project` starts from the current directory. Typing a project name
   fuzzy-searches directory names below it, ignoring case and allowing gaps.
   Results show full paths to distinguish namesakes. Enter browses a result;
   `Use current directory` proceeds to setup. Esc clears a name search first.
   Paste a complete path to replace the input, or Tab to edit the path. Git
   subdirectories still resolve to the worktree root. Search is bounded to three
   levels, 200 directories, 4,000 entries and a one-second traversal budget,
   returns up to 30 ranked results, and skips hidden/dependency folders, symlinks
   and repository interiors. For projects outside that scope, browse upward or
   paste a path. This searches local directories, not server Project names.
4. Sign in only if the chosen Instance requires it. Browser approval resumes
   the same flow. Reuse valid authentication. Resolve the repository against the
   server and select a Team only when the destination is ambiguous; a single
   valid destination is shown in review without a separate selection screen.
   With no Teams, retain progress across Web onboarding and Refresh.
5. One review shows repository, account/Instance, Team, global tools and the
   import of existing history plus continuing sync. `Connect and sync` performs
   the confirmed connection. Editing a value returns to the same review.
6. Open the Project status immediately after connection, with bounded waiting
   for first sync. Do not add a success page requiring another Continue action.

If tools are already configured, skip step 2. If the user cancels before Project
confirmation, keep completed tool setup but do not authorize that Project. If
the repository is already connected to the same destination, open its status
without repeating setup or resetting progress.

## Daily use

Before opening the welcome or Project list, ATape checks for a
newer stable CLI. Results are cached for twelve hours; startup network access
has a 1.5-second timeout. Offline failures proceed normally. When an update is
available, the user must choose `Upgrade and continue` or `Skip` before entering.
Skip applies only to this session. Escape exits. Successful upgrades restore the
terminal and reopen the installed CLI with the original arguments, directory and
ATAPE_HOME. Failures offer Retry and Skip. Help and version do not show this choice. Non-interactive application launches fail
with plain guidance.

Updating ATape from Tools and updates checks fresh metadata and updates the active npm global CLI
installation. After installation is verified, it resumes the current home's
previously running sync with its existing settings. Stopped sync stays stopped;
Projects, sign-in and checkpoints remain intact. Equal/newer installed versions
are a no-op. Other package managers and development builds receive guidance
instead of an inferred installation target. Adapter upgrades remain separate.

`atape` opens the Project list after initial setup. A configured installation
with no Projects shows an empty list with `Add project`, rather than restarting
the welcome or tool configuration. A returning user adding another Project goes
through directory, any missing authentication/destination choice, review, status.
There is no tool-selection step in the Project flow.

The home screen exposes these global actions:

| Entry | Responsibility |
| --- | --- |
| Add project | Connect a repository or ordinary folder to a destination |
| Tools and updates | Choose conversations to sync, inspect versions and update ATape or its integrations |
| Settings | Accounts, server addresses and global background sync controls |

The Project list shows names and sync outcomes. Since tool selection is global,
do not repeat an identical tool list in every row. Show enabled tools once in
the home summary. Top navigation contains Projects, Tools and Settings;
`Add project` appears as `n Add project` in the contextual footer. Pressing `n`
opens a directory-picker modal over a muted, non-interactive Project workspace.
The modal owns path input, suggestions and controls until it closes. If tools
are not configured, this returning-user flow opens the picker first and proceeds
to global tool selection after directory choice. `/` filters Projects, Enter
opens one, and Tab moves to global actions. Shortcuts remain ordinary text while
searching. Returning preserves filter, selection and scroll position.

Interactive pages fill the terminal with a stable brand header, one framed
workspace and a fixed contextual footer. The active Projects destination has a
persistent highlight; keyboard focus on a Project uses an accent rail, bold text
and a low-contrast background. Navigation focus remains visually distinct.
Wide terminals show full action labels; narrow terminals use shorter localized
labels and retain the frame and selected action in the footer. Shortcut notation
belongs in the footer. All business operations are console destinations.

Ink owns the shell, modal, terminal measurement, focus styling and responsive
labels as Presentation concerns; presenter intents and workflow ownership remain
unchanged. Rendering coverage verifies terminal-height layout, navigation, frame,
selected row, footer and the 42-column fallback. Conversation reading and other
new destinations are outside this scope; broader terminal acceptance remains
separate release work.

Background sync state belongs in the home summary. If stopped, offer a contextual
`Start sync` action there. Stopping is a global setting with an impact confirmation.
Exiting leaves background sync running. After a reboot, the user can open `atape`
and select Start sync; no automatic reboot recovery is
introduced.

## Project details

Show overall status, latest sync outcome and per-tool progress or problems.
Enabled tools with no conversations in this repository are an ordinary empty
state, not a request to install or enable that tool again.

A healthy Project offers Sync details, with `r` to refresh. When attention is
required, its specific recovery action comes first. There is no Web Project
shortcut, tool configuration menu or account configuration menu here. Remove the
generic Project settings page;
`Disconnect project` remains a secondary action with default Cancel confirmation.
Disconnection affects this machine and retains server history.

Use Esc for ordinary return navigation and q/Ctrl+C to exit. Do not repeat Back,
All Projects or Exit as ordinary menu rows. Keep default Cancel in consequential
confirmation dialogs. Status refresh remains read-only and in place; automatic
updates do not move selection or switch screens.

## Changing tools

`Tools and updates` opens version information and available update actions.
Its `Choose tools to sync` action opens the global checkboxes. Rows contain tool
names; package versions, detection and installation status are not selection
choices. Save sets up the selected readers and returns to the page that opened
the selection. Esc returns without saving. Initial setup and a Project with no
enabled tools still open the checkboxes directly.

Editing saves through one impact review: tool additions/removals, affected Project
count (with names available), and whether existing conversations will be imported.
Adding a tool includes its history for all connected Projects; disabling it stops
future collection for those Projects and retains captured history. In-flight work
may finish. Saving with no Projects or no selection changes requires no capture-impact review.
Disabling every tool is valid and leaves a clear global no-tools-enabled state.

Preserve unfinished selection on errors. Partial package installation must not
silently expand capture to a subset of Projects; retry through the owning Module.
Changing global tools never reassigns Projects, accounts, Teams or checkpoints.

## Recovery follows the scope of the problem

| Problem | Place and action |
| --- | --- |
| Reader missing | Project explains that ATape needs its reader; Set up conversation sync installs it directly |
| Reader output incompatible | Project offers Check for tool updates; review current/latest versions and select the published integration. If sync is stopped, Start sync is also available |
| Local read failure | Preserve automatic retry when retryable; otherwise show the file/error and guidance in Sync details |
| No tools enabled | Home summary; configure tools once |
| Credential expired | Account/Instance alert; sign in, then resume the interrupted action |
| Global sync stopped | Home summary; Start sync |
| Temporary Project job failure | Project status; explain automatic retry and allow inspection |
| Persistent failure or skipped conversations | Project status; show the affected tool, reason and recovery details |

A Project affected by a global problem links directly to the relevant global
action and returns afterward. It does not duplicate the configuration locally.
Reader installation/update preserves the global selection, registrations and
checkpoints. It validates connected accounts and resumes a stopped Collector; a
running Collector uses the replacement in a later cycle without restarting. The
Project retains its last observed result until that cycle finishes and says that
retry is pending. Updating a package is not evidence of successful conversation
sync. Technical failure messages remain in Sync details.

Preserve the actual Collector semantics: an account failure currently can block
global startup; changing account isolation is outside this UX increment.

## Single entry and maintenance

Run `atape` for every user operation. Only help/version and session language/no-browser
flags remain public. Removed subcommands are rejected without compatibility aliases.
Settings → Language persists the choice for future launches; a launch flag or
ATAPE_LANG takes precedence. Tools → Integration maintenance installs trusted
package/path sources with confirmation, refreshes an installed source and previews
old-version cleanup. Cleanup defaults to Cancel and retains one inactive version
per package plus all current/in-use versions.

Project Sync details pages every retained source diagnostic; bounded report
truncation is explicitly described. There is no public JSON or one-shot collection
mode, Windows support or automation fallback. See [ADR-0081](../architecture/adr/0081-single-interactive-cli-entry.md).

## Implementation boundaries

ATape has not launched publicly. Use one current configuration schema, with no
legacy readers, adoption flow or compatibility commands. Project registrations
do not persist tool selections; the effective collection view derives them from
the global list. Development data is not automatically migrated or deleted.

ADR-0040 records the domain change. The application Module owns tool selection,
impact planning, installation, durable application and recovery through Effect.
The presenter renders that Interface and emits intents. The Collector consumes the same global rule. Capture changes require a review in
the console. Public business subcommands and their flags have been removed.

Verify fresh install, second Project, global additions/removals, cancellation,
interrupted installation, checkpoint preservation, no-Team and expired-login
recovery, and installed-package PTY flows. Merge and publication require their
own delivery steps. Additional terminal platform acceptance and reboot persistence
remain outside this increment.

## Updating without memorizing package commands

Tools and updates checks the CLI and installed official Codex/Claude integrations
in parallel. Each package has its own twelve-hour successful-result cache.
Check again bypasses those caches. Offline checks retain current versions and
show latest unavailable, without blocking tool configuration or navigation.
Uninstalled integrations are set up through Choose tools to sync.

An official integration installed from a file or URL is marked explicitly.
Use published <tool> integration <version> replaces that source with the exact
reviewed npm version and records the registry source for subsequent updates.
A newer installed release is never downgraded. Custom publisher packages use Integration maintenance; matching an official adapter ID alone does not permit replacement.

Package maintenance preserves global selection, Projects and checkpoints and
does not start stopped sync. A running Collector loads replacements on later
attempts; installing a package does not prove that a previous sync error cleared.
The Project offers Start sync when needed. CLI upgrades reuse the existing
verified installation/restart and sync recovery workflow, including after the
startup update prompt was skipped. Stale update selections require another check.

The ToolUpdates Module hides release comparison and source/installation checks.
AdapterReleases is the npm metadata Seam; its Node Adapter shares bounded fetch
and cache behavior with CLI upgrades. A unified page was chosen over per-tool
settings pages to keep version maintenance in one global location. Integration maintenance provides original-source refresh for custom packages,
trusted package/path installation and preview/confirmed cleanup.

Limits: no unattended or bulk integration updates; npm installation is not an
atomic rollback transaction. Cancellation waits for npm termination before the
configuration lock is released. Next increment: validate the published journey
on actual existing installations before considering broader update automation.

Local verification for the single-entry change (2026-09-13): CLI/Application/Web
unit suites and typechecks, installed CLI PTY/package acceptance, Codex/Claude Go
HTTP E2E, the required OpenCode/PostgreSQL/installed-daemon contract, and selected
Web CLI authorization/device browser checks passed. The PTY verifies trusted
package installation, confirmed cleanup, saved language, confirmed stop and
terminal restoration as well as setup and background lifetime. Release Adapter
checks use the source Node Host and exact artifacts; installed CLI collection is
verified separately. Documentation and architecture checks passed. This is local
verification, not CI, package publication or deployment evidence.
