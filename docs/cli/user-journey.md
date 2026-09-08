# CLI user journey: global tools and connected Projects

Status: Implemented in the v0.4.0 candidate; publication follows the release gates.
This specification supersedes per-Project tool selection in the earlier
experience guide. Command and persistence behavior is documented in
setup-and-adapters.md; ADR-0040 records the configuration decision.

## User model and scope

Users configure which coding tools ATape reads on this machine, then connect
the Projects whose conversations they want to sync. Tool configuration belongs
to the local ATape installation, across its connected Projects and Instances.
It is not an account-wide or Team-wide setting shared with other machines.

The TUI names actual tools, such as Claude Code and Codex. Adapter packages,
versions and acquisition details appear in tool details when needed. Installing
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
   theme-color cassette remains in the shared header on every interactive page,
   adapting its size to the terminal rather than disappearing after first use.
2. `Which tools do you use?` shows Claude Code and Codex with simple selection
   and local detection status. Detection only means local source data exists.
   Saving enables the chosen tools globally and installs their Adapters as
   necessary. With no connected Projects, this does not import conversations.
3. `Connect a project` starts from the current directory and supports browsing
   and pasting another path. Enter browses candidates; an explicit action selects
   the directory. Git subdirectories resolve to the worktree root.
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

`atape` opens the Project list after initial setup. A configured installation
with no Projects shows an empty list with `Add project`, rather than restarting
the welcome or tool configuration. A returning user adding another Project goes
through directory, any missing authentication/destination choice, review, status.
There is no tool-selection step in the Project flow.

The home screen has three global entry points:

| Entry | Responsibility |
| --- | --- |
| Add project | Connect a repository or ordinary folder to a destination |
| Tools | Enable/disable tools, inspect their readiness and manage Adapters |
| Settings | Accounts, server addresses and global background sync controls |

The Project list shows names and sync outcomes. Since tool selection is global,
do not repeat an identical tool list in every row. Show enabled tools once in
the home summary. `/` filters Projects, Enter opens one, and Tab moves to global
actions. Returning preserves filter, selection and scroll position.

Background sync state belongs in the home summary. If stopped, offer a contextual
`Start sync` action there. Stopping is a global setting with an impact confirmation.
Exiting leaves background sync running. After a reboot, the user can open `atape`
and select Start sync, or invoke `atape start`; no automatic reboot recovery is
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

Tools lists the global selection with detected, ready or attention-needed state.
Adapter version and update actions belong inside a tool's details. Normal setup
does not require users to learn install, enable and upgrade as separate commands.

Editing saves through one impact review: tool additions/removals, affected Project
count (with names available), and whether existing conversations will be imported.
Adding a tool includes its history for all connected Projects; disabling it stops
future collection for those Projects and retains captured history. In-flight work
may finish. Saving a change with no Projects requires no capture-impact review.
Disabling every tool is valid and leaves a clear global no-tools-enabled state.

Preserve unfinished selection on errors. Partial package installation must not
silently expand capture to a subset of Projects; retry through the owning Module.
Changing global tools never reassigns Projects, accounts, Teams or checkpoints.

## Recovery follows the scope of the problem

| Problem | Place and action |
| --- | --- |
| Tool missing or incompatible | Global tool status; open that tool's repair/update flow |
| No tools enabled | Home summary; configure tools once |
| Credential expired | Account/Instance alert; sign in, then resume the interrupted action |
| Global sync stopped | Home summary; Start sync |
| Temporary Project job failure | Project status; explain automatic retry and allow inspection |
| Persistent failure or skipped conversations | Project status; show the affected tool, reason and recovery details |

A Project affected by a global problem links directly to the relevant global
action and returns afterward. It does not duplicate the configuration locally.
Preserve the actual Collector semantics: an account failure currently can block
global startup; changing account isolation is outside this UX increment.

## Implementation boundaries

ATape has not launched publicly. Use one current configuration schema, with no
legacy readers, adoption flow or compatibility commands. Project registrations
do not persist tool selections; the effective collection view derives them from
the global list. Development data is not automatically migrated or deleted.

ADR-0040 records the domain change. The application Module owns tool selection,
impact planning, installation, durable application and recovery through Effect.
The presenter renders that Interface and emits intents. The Collector and explicit
commands consume the same global rule. Project setup has no --adapter option;
tools configure provides preview and explicit --apply.

Verify fresh install, second Project, global additions/removals, cancellation,
interrupted installation, checkpoint preservation, no-Team and expired-login
recovery, and installed-package PTY flows. Merge and publication require their
own delivery steps. Additional terminal platform acceptance and reboot persistence
remain outside this increment.
