# CLI experience improvement

The [revised user journey](user-journey.md) records the accepted move to global
tool configuration and implements the resulting first-use, daily-use and recovery
flows. It supersedes the per-Project source-selection direction below; the older
sections describe earlier increments. The global-tools increment is implemented
in the v0.4.0 candidate; publication follows the release gates.

## Outcome and scope

The accepted outcome is that a new user can run `atape`, connect a local Project,
see whether its conversations have synced, and recover from common failures
without learning the command tree. This guide tracks the whole initiative;
unchecked work below is not shipped behavior.

The first release targets macOS and Linux. It uses Ink for both setup and the
Project console. Windows terminal acceptance remains a later increment. Existing
explicit commands and JSON output remain the automation Interface. Runtime
upgrades are allowed when justified by the selected library and package checks.

## Accepted product decisions

- Bare `atape` enters setup before tools have been configured and opens the Project
  console afterward, including when no Projects are connected. Unsupported interactive terminals receive useful plain-text
  guidance; pipes, CI and JSON requests never wait for interactive input.
- Setup defaults to the current directory, resolves a Git subdirectory to its
  worktree root, and supports entering another path with directory completion.
  It does not scan the user's entire disk for Projects.
- Authentication, Project matching and installed integrations are reused. One
  available Team can be selected automatically and is shown before confirmation;
  multiple Teams require a selection. Project creation is included in the final
  explicit confirmation rather than hidden behind a required command-line flag.
- Detection means that a supported source's local data directory exists, not
  that the tool is installed or this Project has conversations. Detected sources
  are preselected; missing sources may be selected manually.
- First choose tools globally; saving installs the selected integrations. One
  Project review then displays the destination Instance and Team, Project identity,
  global tools, historical import and continuing background sync. Confirmation
  connects the Project and starts collection.
  Detecting a new source later never expands authorization automatically.
- Existing conversations are imported and new ones continue syncing. Time-range
  selection is outside the first release. Unknown historical attribution is
  reported as partial coverage, without blocking attributable conversations.
- A user with no Teams opens the existing Web onboarding page, returns to the
  terminal and chooses Refresh to continue. The current directory and progress
  survive this detour. Team creation and joining are not duplicated in the TUI.
- Exiting the TUI leaves the managed Collector running. Restart/login persistence
  is outside this initiative's first release; `atape start` starts it manually.
  The console offers Start when the Collector is stopped. Global Stop clearly
  affects every Project. No separate per-Project pause state is introduced.
- Home provides Add project, Tools and Settings. Project details support
  inspecting sync outcomes, removing local capture and
  recovering from authentication and collection failures. Local removal does not
  delete server history. Changes affect subsequent cycles; the UI must not imply
  that an in-flight upload was immediately cancelled.
- Conversation reading, Search and Team administration remain in the Web app.
  Third-party package management and detailed diagnostics retain their
  explicit command Interfaces rather than becoming mandatory setup concepts.

## Git Project identity

A directory is the entry point for discovering a Git Project, not its capture
authorization rule. Within a Team, the same authoritative repository identity
means the same Project across linked worktrees and independent clones. Repeating
setup from another checkout must resolve to the configured Project without a new
collection job or checkpoint identity.

All Harness Adapters must use one shared attribution contract. A Git Project has
no "only this folder" mode, including through explicit flags. A
non-Git folder remains a directory Project. Missing or unsupported Git remotes
require correction; setup must not suggest converting the Git directory into a
directory Project as a workaround.

Service-side normalization and existing repository aliases remain authoritative.
The client must not invent a second set of equivalent remotes. Nested unrelated
repositories must not be included by lexical path containment, and changing a
checkout's origin must not send the new repository's sessions to the old Project.

Use trustworthy source metadata or established attribution when it exists.
When a historical source has no usable Git identity and its original directory is
gone, show the skipped source and reason rather than guessing from its path.
Existing trustworthy attribution remains stable. Full recovery of unknowable
historical identity is not promised.

### Implementation checkpoint

The shared Host contract now replaces both private Git matchers. Git setup stores
verified repository identity and accepts the same Project from another checkout;
capture can continue from recorded or established evidence when the configured
locator disappears.
The [Git attribution ADR](../architecture/adr/0037-shared-git-source-attribution.md)
records the protocol, compatibility checks and evidence-store semantics.

A managed authentication failure exits the Collector. The console now offers
sign-in and resume, validating the account and Team for every enabled registration
before global startup. Explicit `atape login` retains its existing behavior; use
`atape start` afterwards when working outside the console.

## Interaction and Module boundaries

The initial presentation consists of three screens: setup, Project list and
Project details. Keyboard hints remain visible, Escape goes back or cancels an
unfinished edit, and exiting restores terminal modes. Paths support spaces,
Unicode, paste and directory suggestions. Narrow windows must remain usable.

An Effect-backed application Module owns planning, authorization boundaries,
installation, configuration, progress, failures, cancellation and recovery. Its
Interface exposes explicit ViewModels and intents to both the command and Ink
bindings. Ink owns input, focus, layout and unfinished local edits. It does not
own persistence, retries or collection in React effects.

Terminal input/output and filesystem access are real Adapter Seams. Internal
workflow stages remain private. This concentrates Depth and Locality in the
application Module and gives callers Leverage without exposing the ordering of
several low-level commands. Canonical, Raw and Search remain separate Modules.

Status describes outcomes: waiting for a first conversation, syncing, queued
history, up to date, partial coverage, or a failure with a recovery action.
"Collector started" is not "first sync completed". A bounded initial wait must
hand back control when ingestion is slow or no history exists. PID, concurrency
and Raw chunk counters belong in details rather than the main success message.

## Delivery increments

| Increment | Usable outcome | Status |
| --- | --- | --- |
| 1. Ink and distribution | Verified runtime, bundle, directory input and terminal lifecycle; selected architecture documented | Complete for macOS/Linux arm64; see [validation evidence](ink-validation.md) |
| 2. Git identity | Shared attribution for Codex and Claude, identity-based setup, explicit unknown-source diagnostics | Included in v0.3.0 candidate; publication gated |
| 3. Complete setup | One guided flow through login, Team, Project, sources and observable first sync; matching CLI/Web documentation | Included in v0.3.0 candidate; publication gated |
| 4. Project console | List/details, source changes, local removal and recovery using the same Module Interface | Included in v0.3.0 candidate; publication gated |

Finish and verify each increment before expanding it. Research programs stay
outside implementation commits. When integration is requested, reconcile with
latest main and land each usable increment through repository PR checks. Merging,
publishing packages and deploying an instance remain separate actions.

## Acceptance matrix

The complete initiative is accepted only when the following behavior is verified:

- A clean supported installation reaches a real first sync from bare `atape`;
  returning users reach their Project list without repeating completed setup.
- Login already valid, expired login, zero/one/multiple Teams, existing/new
  Projects and interruption during installation all have a resumable next step.
- Only confirmed sources and repository identities become enabled; later source
  discovery or a changed Git remote does not silently widen capture.
- Both Adapters agree on worktree/clone membership, nested unrelated repositories,
  supported remote equivalence and missing historical identity.
- Adding/changing sources is picked up by the managed Collector, removing local
  capture preserves server history, and authentication recovery resumes only the
  verified account's Projects.
- Empty history, partial capture, a stopped Collector and first-sync success are
  distinguishable. Exiting the console does not stop background work.
- Pipes and JSON retain stable machine output with no prompts or ANSI screen
  control; explicit commands remain usable without the TUI.
- The installed tarball, not only the development source, passes keyboard, paste,
  Unicode, resize, Ctrl+C and terminal-restoration checks on macOS and Linux.

## Current Implementation and delivery checkpoint

The first implementation now includes the Ink setup and Project list/details,
shared Git attribution, identity-based reattachment and bounded unknown-source
diagnostics. Node 24 remains sufficient. The UI uses the existing authentication,
Project setup, package and Collector Modules through Effect-backed workflows;
explicit command/JSON behavior remains available.

The final candidate was installed independently on macOS arm64 (Node 24.18.0) and
Linux arm64 (Node 24.20.0). Permanent PTY checks cover directory completion,
Unicode/space paths, paste, resize, cancellation and terminal restoration, actual
device login against a controlled Instance, the no-Team Web/Refresh detour,
confirmation before capture, source changes and background lifetime. See the
[production validation record](production-terminal-validation.md).

Validation also covers real Git worktrees/clones/nested repositories, immutable
evidence after origin changes/deletion, controlled server aliases, credential and
retry failures, upgrade capability checks and late historical recovery. The
installable release suite and existing CLI/Go Canonical/Raw/Search end-to-end
suite pass. No research probes or private conversation snapshots are shipped.

The v0.3.0 candidate includes these implementations and matching CLI/Adapter
versions. Integration is tracked in [PR #83](https://github.com/SingleMai/ATape/pull/83);
publication follows the repository release gates and is not a Server deployment.
The next experience increment is broader terminal and live-account acceptance:
x64, Windows TUI, SSH/tmux, IME and accessibility remain pending. Reboot
persistence remains deliberately excluded; `atape start` provides manual resume.

## Welcome and navigation increment

The v0.3.1 candidate improves the existing Ink presentation without a new GUI
or changes to capture authorization. Publication follows the repository release
gates; this guide does not attest manual staging acceptance.

- Bare `atape` with no Projects shows a monochrome pixel-cassette welcome and one
  primary connection action. Explicit `atape setup` still opens the path directly.
  The cassette now stays in the shared header on every interactive screen.
  Spacious terminals show the full artwork; ordinary terminals show a three-line
  cassette, and short or narrow terminals keep a single-line cassette mark.
  Header height is included in the available space for details and controls.
- Returning users see Project rows with source and sync state. `/` searches names,
  sources, Teams and status; Enter opens the focused Project. Tab switches to a
  separate global action bar. Search text, focused Project and the visible list
  position survive returning from details. Manual and periodic refreshes update
  the current page in place, preserving navigation; a late refresh cannot pull the
  user back from another page.
- Project actions reflect their state: enable sources, resume global sync, or
  sign in after an authentication failure. Account controls, removal and detailed
  diagnostics live in Project settings. Removal and global Stop retain explicit
  confirmation and do not delete captured server history.
- Directory candidates are visible on entry and while typing. Arrow keys choose,
  Enter browses folders (including the parent directory), and a fixed `Use current
  directory` action connects the chosen location. Tab switches to path editing;
  Enter after editing returns focus to that action without submitting setup. A `[Git]` hint recognizes both `.git` directories and
  worktree files; this is not an identity check. The application Module still
  resolves and validates the actual repository, shown before confirmation.
- Browser login offers a link-opening action and continues automatically after
  approval. The no-Team Web/Refresh detour remains available. Notices and refresh failures
  appear before long details, so they are not hidden by pagination.
- Terminal dimensions are observed live. Narrow Project lists prioritize names
  and status over source columns. Ink controls and the cassette share the terminal
  theme Adapter; normal commands and JSON retain their existing output.

Validation exercises presenter intents against disposable Node Layers, bounded
filesystem browsing, and the installable CLI's real PTY. The PTY scenarios include
visible Unicode/space candidates, bracketed paste without submission, resize,
search containing `q`, retained filtered viewports, in-place refreshes, late refresh
completion after navigation, browsing without connecting, switching action focus,
inline Web results, source changes,
Ctrl+C/SIGTERM, and terminal restoration.

This increment does not add immediate per-Project collection, reboot persistence,
conversation browsing in the terminal, or filesystem-wide discovery. Collection
failures retain their existing retry behavior. The next increment is acceptance
on additional terminal environments (x64, Windows, SSH/tmux, IME and accessibility)
and feedback from everyday use of this navigation.


### Recovery follows the user's next action

The Project snapshot now describes recovery through the application Module
Interface. It distinguishes enabling sources, signing in, resuming a stopped
Collector, awaiting an automatic retry, fixing a persistent issue, and reviewing
partial coverage. This translates the existing Collector behavior; it does not
add a second retry policy or a per-Project restart operation.

Project rows name the actionable state, and Project details place the explanation
and failure before long repository paths. The primary action opens sign-in,
recovery details or skipped-conversation details as appropriate. A credential
failure in another Project offers direct sign-in for that Project's Instance,
then resumes all enabled Projects through the existing account checks.

Only retryable job failures with a running Collector and no global blocker are
shown as awaiting automatic retry. No countdown is invented: a later collection
cycle may also be delayed by other work. Non-retryable and unclassified failures
require inspection even though periodic checks may continue. Partial source
failures explain the affected source and reason without promising recovery of
unknown historical attribution.

`Refresh status` only rereads status. The Project page and diagnostics keep their
context and show that sync timing is unchanged; they never start or restart the
Collector. Diagnostics include source-specific guidance and existing source or
resume actions. Generic operation failures label retry as `Retry this operation`,
with sign-in first when authentication is required.

Validation covers automatic retry versus required repair, stopped/background
state, global authentication blockers, partial recovery, action ordering, error
visibility, and in-place diagnostics refresh without starting collection.

### Project actions after v0.3.1 feedback

Project details no longer offer `Open Project in Web`. A Project with no recovery
action defaults to `Sync details`, with secondary disconnection. Esc returns to the list.
Projects needing attention continue to prioritize their specific recovery action.
Browser sign-in and the no-Team onboarding/Refresh flow remain available.

This increment removes the unused Project URL workflow as well as the menu entry.
Validation uses the existing presenter recovery scenario and installed-package
PTY flow to check action ordering and in-place refresh. It is not yet published;
broader terminal and live-account acceptance remain the next increment.

Ordinary menus use the visible `Esc Back` hint instead of duplicate `Back`,
`Back to Project` or `All Projects` rows. This applies to Project details,
settings, diagnostics, help, onboarding and error recovery. Explicit setup edits
remain named actions. Confirmation dialogs retain a default `Cancel` choice so
Enter cannot accidentally confirm removal or stopping sync.

### Global tools and current configuration

The current increment follows [the revised journey](user-journey.md): choose tools
once, connect Projects using that selection, inspect outcomes, and recover at the
scope of the problem. Tools and accounts belong to global navigation. No Project
settings, Web Project shortcut or duplicate Back rows remain. The cassette stays
visible on all interactive pages.

Project registrations no longer persist tool overrides. The Client Module combines
them with global enabled tools for collection. Changes preview their impact on all
Projects, retain checkpoints, and invalidate stale setup reviews. First-use tool
setup can finish without connecting a Project; the next launch opens an empty list.

ATape has not launched publicly. This increment removes old configuration branches,
the v0.1 migration Module/command and XDG migration interception, with no automatic
conversion or restart. Development files remain untouched. ADR-0040 supersedes the
older CLI configuration and migration decisions; the CLI release gate now checks
current-schema reads and rejection without overwriting unsupported files.

Local validation for this increment: all workspace typechecks; Domain 22,
application 72 and CLI 51 tests; two real CLI/Go end-to-end scenarios; installed
CLI PTY verification; independently packaged Codex/Claude and Claude replacement
with preserved progress. The release gate index passes in CI mode; this does not
claim new staging acceptance. The v0.4.0 candidate is ready for integration; publication follows the release gates.

The next increment is hands-on feedback on this global navigation plus terminal
acceptance beyond the local macOS environment. Automatic reboot recovery remains
excluded.


### Direct conversation selection and recovery after v0.4.0 feedback

Home now opens global tool checkboxes directly. Saving returns to the originating
page, with an impact review only for actual selection changes affecting connected
projects. The extra Tools menu, per-tool details and ambiguous Fix actions are
removed. Rows show names rather than installation/version states.

Project recovery explains the affected conversations and the available action.
Missing readers offer setup; incompatible output offers an ATape reader update.
Ordinary read errors retain their retry classification instead of always prompting
an update. Sign-in blockers take precedence. Raw errors remain in Sync details.

The CLIExperience Module owns reader maintenance and account checks through its
Effect Interface, reusing the existing package and process Seams. Updates preserve
selection, registrations and checkpoints. Running sync is not restarted; the UI
reports that a later cycle will retry and retains the last result until then.
A new reader version does not establish that a conversation failure is resolved.

This increment awaits publication. Application and CLI typechecks pass,
as do 75 application tests, 52 CLI tests and installed-package PTY verification.
Validation covers direct navigation,
cancel/save return paths, recovery classification, reader installation/update,
stale selection and account rejection, installation failure, and installed CLI
terminal controls. Next: hands-on feedback on the shorter flow; broader terminal
and live-account acceptance remain separate.


### Discoverable Add project and local name search

The Project list puts its action bar above the rows and highlights `[n] Add
project`. Pressing n opens setup directly; search input does not trigger it.
Typing in directory browsing starts a fuzzy name search with ranked full-path
results. Paste replaces the path; Esc clears search before returning. Selection
still browses before the explicit connection action and review.

The existing filesystem Adapter Seam accepts a query; bounded directory discovery
and ranking stay out of presentation. Search covers up to three levels below the
current directory and skips hidden/dependency trees, symlinks and Git interiors.
It is local discovery, not a full-disk index or server Project search. Browse a
parent or paste a path for projects outside the current scope.

Validation covers nested and Unicode names, case/gap matching and ranking, skipped
trees, the n shortcut, search clearing, selected-directory browsing, and packaged
CLI terminal operation. This work shipped in v0.4.1.

## CLI upgrade and startup choice — local increment

Users can run `atape upgrade` instead of remembering npm installation commands.
The command checks the latest stable release and upgrades only the active npm
global installation. It verifies the installed version before restarting the
current home's previously running Collector with its original settings. An
installation failure does not stop that Collector. Stopped sync remains stopped;
configuration, credentials and checkpoints are not changed by the workflow.

Startup waits for a bounded update check before entering the welcome, Project
list or explicit setup. A newer release presents `Upgrade and continue` and
`Skip`. Upgrade installs and reopens the new executable automatically; Skip
continues the original flow for this session. Escape exits. Failed upgrades
retain the choice with Retry and Skip. The app never installs without selection.
Metadata is cached for twelve hours; startup network access has a 1.5-second
timeout and failures proceed normally. Explicit upgrade checks bypass the cache.
Noninteractive and JSON commands do not present the startup choice.

ADR-0044 records the Module Interface and npm Adapter ownership checks. This
increment is implemented and awaits publication.
Validation covers numeric version comparisons, offline and malformed responses,
cache expiry, ownership rejection, installation locks and failures, preservation
of sync settings, blocking startup selection, Skip, restart and packaged terminal navigation.
Other package managers, automatic installation, updating all Adapter packages
and managing Collectors across multiple ATAPE_HOME directories remain outside
this increment. Next: hands-on feedback on the published upgrade path.

Review fixes: cancellation now waits for installer termination and lock cleanup;
an unresponsive installer is forcibly terminated after a one-second grace period.
Restart explicitly relinquishes the old process's terminal input. If CLI
installation succeeds but sync cannot resume, the recovery action retries only
sync with its original parameters. Skip opens the installed CLI while leaving
sync stopped. Regression coverage includes real subprocess cancellation, real
PTY input after Ink teardown, and repeated recovery through the Module and
presenter Interfaces. This work awaits publication.
