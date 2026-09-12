# ADR-0036: Ink CLI Experience and Shared Capture Workflows

- Status: Accepted; implemented and verified locally, integration/publication pending
- Date: 2026-09-08
- Current feature guide: [CLI user journey](../../cli/user-journey.md)

Public business commands are superseded by [ADR-0081](0081-single-interactive-cli-entry.md).

## Context

Users currently assemble authentication, Project registration, Adapter installation,
source assignment and background collection through several commands. The user
approved a single interactive entry, a complete setup workflow, and a Project
console while retaining the explicit command Interface for scripts. The first
release targets macOS and Linux. Reboot persistence is deferred; `atape start`
remains the manual start operation.

The CLI currently distributes one Node 24 ESM executable with independently
installed Harness Adapters and a compressed npm artifact below 1 MiB. A runtime
upgrade is permitted, but is not itself a product requirement. Existing Effect
Modules own authentication, persistence and collection.

## Considered designs

### Linear prompts over the existing commands

Clack provides useful input, multiselect and path-completion controls. A one-off
setup could call existing commands in sequence, but callers would still own
resumption, ordering and the switch into day-to-day Project management. Embedding
that workflow in prompt callbacks would reduce Locality and leave little Depth
behind the application Interface. Using Clack for setup and another renderer for
management also introduces two input/lifecycle systems.

### Ink presentation over an Effect workflow

One React terminal presentation renders explicit ViewModels and emits intents.
An Effect application Module owns the workflow and its durable consequences;
the same Interface serves explicit commands. This has higher Leverage for
callers because they no longer need to understand installation, Project setup,
collection and recovery ordering. Terminal I/O and browser/filesystem operations
remain real Adapter Seams. Internal stages are private Implementation rather
than a public collection of one-method wrappers.

### OpenTUI presentation over the same Effect workflow

OpenTUI is a viable alternative, especially for a complex fullscreen application
with multiple scrolling regions and rich keyboard/mouse interaction. Its current
runtime and platform-specific native packages require broader distribution work.
That is an acceptable tradeoff if those interactions are required. ATape's
accepted first release instead concentrates on forms, Project selection and
low-frequency status, with no measured need for a different rendering core.
Allowing a Node upgrade does not remove the native-distribution tradeoff.

## Decision

Use Ink as the first-release TUI renderer and use the same renderer for setup
and management. Validate and pin a concrete version before wiring it into the
production executable. Ink 7.1.1 with React 19.2.8 is the initial validated
combination. Node 24 remains sufficient for that combination.

- Bare `atape` selects setup or Project management from local state. Entering an
  interactive session requires appropriate stdin and stdout capabilities. Pipes,
  CI, `TERM=dumb`, explicit help and JSON commands do not start a TUI.
- The presentation may own focus, path text, selection and other unfinished edits.
  It may not install packages, mutate configuration, retry network calls or start
  collection in component effects. Those operations are Effect programs behind
  an application Module Interface.
- Terminal acquisition, signal handling, pending input, subscriptions and renderer
  cleanup have a scoped owner at the binding/Composition Root. Exiting the TUI
  cancels its foreground workflow and releases the terminal; it does not stop the
  independently owned managed Collector.
- Prefer common controls such as `@inkjs/ui` for selection when their behavior
  fits. Ink is not an out-of-the-box directory browser. Path suggestions and
  validation use a small terminal control backed by filesystem Effects; directory
  scanning is bounded and never becomes a recursive disk-wide discovery workflow.
- Keep the complete artifact as one ESM file, without mandatory external React,
  Ink or WASM assets. Preserve legal notices and the existing package allowlist,
  Node shebang and size gate. Adapters remain independently installed.
- Release bundling must account for Ink's optional developer-tools import and
  CommonJS transitive dependencies. The validation uses a narrowly scoped build
  replacement for Ink's developer-tools entry and Node `createRequire` for
  bundled CommonJS calls to built-ins. Merely marking `react-devtools-core`
  external is insufficient: esbuild can hoist its static import and break even
  noninteractive commands in a clean installation. Do not patch installed package
  files or rely on repository dependencies being available at runtime.
- Optional renderer dependencies are loaded only on the interactive branch;
  explicit commands and the managed Collector must retain deterministic startup
  and machine-readable output.

The shared Git attribution contract is a prerequisite to the new setup release,
not logic owned by Ink. Git Projects use repository identity across worktrees and
clones, and all Adapters must agree. The feature guide records the accepted
product rules; the consequential persistence/Adapter Interface change needs its
own contract and ADR before implementation. This ADR does not silently redefine
existing checkpoint or source-origin semantics.

## Verification and delivery

### Production workflow Interface

`CLIExperience` composes existing authentication, Project setup, package and
managed Collector Modules. Planning is read-only; applying an explicit review
installs only selected integrations, revalidates account/repository/Team, persists
the Project and starts the Collector. A bounded first-sync observation returns
control without equating process startup with successful ingestion. Console
mutations validate the current registration and verified account; re-login never
silently adopts another user's configured Projects.

The Node setup Adapter owns bounded directory suggestions, known source-directory
detection, installed-package capability inspection and a metadata-only creation
key journal. A confirmed directory-Project creation reuses its server idempotency
key after interrupted local setup. Existing configured directory Projects are
reused. Keys are scoped by Instance, User, Team, path and name and never send paths
to the server. Completed local registration is the resumption boundary; the
wizard's unfinished edits remain ephemeral.

An executable presenter binds Effects to immutable screen ViewModels; React only
subscribes, renders and emits input. Pending work has a cancellation owner and
stale results cannot replace a newer screen. TS views use `createElement` so the
existing Node TypeScript development runner remains usable. Terminal controls
restore raw mode, paste mode and cursor visibility on cancellation and signals.
Project status refresh is an Effect loop owned by this binding, not a React
network/persistence effect. Explicit commands continue to use the same underlying
application Modules and remain independent of the renderer.

First validate a disposable probe bundled with the real CLI, install its tarball
outside the workspace, and exercise both terminal interaction and the existing
packaged Collector cycle. The probe does not authenticate a real user, enable
capture or ship as a new public command. Research code stays outside implementation
commits. Record exact versions, artifact size/hash, platforms and limitations in
the feature guide's linked evidence.

Production acceptance requires both Module behavior tests and installed-terminal
tests. Verify setup cancellation/resumption, source authorization, identity-safe
re-login, partial coverage and configuration changes through the same Interface
used by callers. Use terminal tests for input, Unicode, paste, resize and cleanup;
do not couple application tests to component internals or private workflow order.

The guided setup and Project console are implemented in the working tree. The
production tarball passed the installed-terminal and package checks on macOS
arm64 and Linux arm64; see [production evidence](../../cli/production-terminal-validation.md).
Publication and deployment remain separate from this local verification.

## Sources

- [Ink 7.1.1 documentation](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md)
- [Ink UI controls](https://github.com/vadimdemedes/ink-ui)
- [Ink testing library](https://github.com/vadimdemedes/ink-testing-library)
- [Clack controls](https://github.com/bombshell-dev/clack/tree/main/packages/prompts)
- [OpenTUI runtime and platform support](https://opentui.com/docs/getting-started/runtime-support)
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
  contains evidence of Ink use, but does not establish the latest private UI's
  precise upstream version or fork.
- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
  exposes agent capabilities rather than a terminal UI framework.
- [Gemini CLI manifest](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/package.json)
  demonstrates an Ink fork; [OpenCode manifest](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/package.json)
  demonstrates OpenTUI use. Neither is a benchmark of ATape's workloads.
