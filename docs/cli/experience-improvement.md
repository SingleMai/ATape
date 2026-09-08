# CLI experience improvement

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

- Bare `atape` enters setup when no Projects are configured and opens the Project
  console otherwise. Unsupported interactive terminals receive useful plain-text
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
- One review displays the destination Instance and Team, Project identity, sources,
  historical import and continuing background sync. Only after acceptance does
  setup install needed official Adapters, enable them and start collection.
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
- The Project list and details support adding a Project, managing sources,
  inspecting sync outcomes, removing local capture, opening the Web Project and
  recovering from authentication and collection failures. Local removal does not
  delete server history. Changes affect subsequent cycles; the UI must not imply
  that an in-flight upload was immediately cancelled.
- Conversation reading, Search and Team administration remain in the Web app.
  Third-party package management, migration and detailed diagnostics retain their
  explicit command Interfaces rather than becoming mandatory setup concepts.

## Git Project identity

A directory is the entry point for discovering a Git Project, not its capture
authorization rule. Within a Team, the same authoritative repository identity
means the same Project across linked worktrees and independent clones. Repeating
setup from another checkout must resolve to the configured Project without a new
collection job or checkpoint identity.

All Harness Adapters must use one shared attribution contract. A Git Project has
no "only this folder" mode, including through legacy explicit flags. A genuinely
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
locator disappears. Config v2 and recognized Adapter cursors remain readable.
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
| 4. Project console | List/details, source changes, local removal, Web links and recovery using the same Module Interface | Included in v0.3.0 candidate; publication gated |

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
